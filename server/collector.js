// Collector: polls the UniFi gateway (devices/ports, clients, traffic flows, system log), probes and reads the
// broadcast equipment (TCP/UDP probes, Blackmagic REST, ATEM protocol), and turns everything into one `state`
// object that is emitted after every device poll. It also keeps an event tape (what changed, when), detects
// streams arriving at the ATEM from the switch-port counters, builds the live topology and explains alerts.
//
// Rates: UniFi's own "-r" fields are slow moving averages. Switches report their cumulative port counters
// to the controller every 5-30 s (varies per switch), so a port's rate is computed from the counter delta
// at the moment the counter changes, and the time since that last change is exposed as `age`.
import { EventEmitter } from 'node:events'
import { UniFi } from './unifi.js'
import { probeAll } from './probe.js'
import { telemetry as restTelemetry } from './rest.js'
import { AtemClient } from './atem.js'
import { SnmpSwitch } from './snmp.js'
import { Companion } from './companion.js'
import { X32Meters } from './x32.js'
import { SscMonitor } from './ssc.js'
import { computeHealth, tiles, PROFILE_DEFAULTS, isMic } from './health.js'
import { execFile } from 'node:child_process'

const num = (x) => {
	const n = Number(x)
	return Number.isFinite(n) ? n : 0
}
const MODEL_NAMES = {
	UDMPROMAX: 'UDM Pro Max',
	UDMPRO: 'UDM Pro',
	UDMPROSE: 'UDM SE',
	USAGGPRO: 'USW Aggregation Pro',
	USL8A: 'USW Aggregation',
	US48PRO: 'USW Pro 48 PoE',
	US24PRO: 'USW Pro 24 PoE',
	US648P: 'USW Pro 48 PoE (Gen2)',
	USL48P: 'USW Lite 48 PoE',
	USL24P: 'USW Lite 24 PoE',
	USL16P: 'USW Lite 16 PoE',
	USL8LP: 'USW Lite 8 PoE',
	USPM16P: 'USW Pro Max 16 PoE',
	USM25G8P: 'USW Flex 2.5G 8 PoE',
	USM25G8: 'USW Flex 2.5G 8',
	US68P: 'USW Enterprise 8 PoE',
	USMINI: 'USW Flex Mini',
	USF5P: 'USW Flex',
	USPPDUP: 'SmartPower PDU Pro',
	UAP6MP: 'U6 Pro',
	U6M: 'U6 Mesh',
	U6LR: 'U6 Long Range',
	U7PRO: 'U7 Pro',
}
const modelName = (d) => MODEL_NAMES[d.model] || d.model_display || d.shortname || d.model
// ATEM sessions live as long as the process: a server restart (menu > Restart server) keeps them instead of
// leaving a dead session on the switcher for two minutes and opening a second one
const ATEM_POOL = new Map() // ip -> AtemClient
const isPdu = (d) => /^USPPDU|PDU/i.test(d.model || '') || d.type === 'usp'
const STREAM_HIT_BYTES = 50000 // a forwarded flow below this is a port scan or a handshake that went nowhere, not a stream
const mbps = (bytesPerS) => Math.round((num(bytesPerS) * 8) / 1e5) / 10 // Mb/s with one decimal
const lower = (s) => String(s || '').toLowerCase()

class Ring {
	constructor(n) {
		this.n = n
		this.a = []
	}
	push(v) {
		this.a.push(v)
		if (this.a.length > this.n) this.a.shift()
	}
}

export class Collector extends EventEmitter {
	constructor(config, log = console.log) {
		super()
		this.cfg = config
		this.log = log
		this.api = new UniFi(config.gateway)
		this.poll = { devices_s: 5, clients_s: 10, flows_s: 10, log_s: 30, probe_s: 15, telemetry_s: 10, history_points: 120, ...(config.poll || {}) }
		this.th = { wan_latency_ms: 80, cpu_pct: 85, mem_pct: 90, temp_c: 70, stream_min_mbps: 1.5, mic_battery_pct: 20, mic_rf_pct: 30, ...(config.thresholds || {}) }
		this.state = {
			ts: 0,
			started: Date.now(),
			ok: false,
			errors: {},
			gateway: null,
			switches: [],
			aps: [],
			others: [],
			networks: [],
			equipment: [],
			atem: null,
			topology: { nodes: [], links: [] },
			clients: { total: 0, wired: 0, wireless: 0, byNetwork: {} },
			flows: { recent: [], top: [], window_s: 0, total: 0, blocked: 0 },
			alerts: [],
			events: [],
			log: [],
			updated: {},
			streamPaths: [],
			companion: null,
			audio: null,
		}
		this.portLabels = config.port_labels || {} // "switchmac:port" -> {name, ip, note}: what is really on a port when UniFi cannot tell
		this.profiles = Array.isArray(config.profiles) && config.profiles.length ? config.profiles : PROFILE_DEFAULTS.map((p) => ({ ...p, expect: { ...p.expect } }))
		this.activeProfile = config.active_profile || this.profiles[this.profiles.length - 1].id
		this.state.health = null
		this.state.tiles = []
		this.state.profiles = { list: this.profiles.map((p) => ({ id: p.id, name: p.name, expect: p.expect, roster: p.roster || null })), active: this.activeProfile }
		this.companion = new Companion(config.companion || {}, log)
		this.companionState = new Map() // atem ip -> {lastOk, okSince} for the companion/auto hysteresis
		this.x32 = new X32Meters({ log }) // live meters from the X32 consoles (roster probe "x32")
		this.ssc = new SscMonitor({ log }) // Sennheiser EW-DX receivers over SSC (roster role "audio" with a mic-like name or vendor)
		this.metersSent = { x32: -1, ssc: -1, atem: 0 } // what the last "meters" event carried
		this.forwardHits = new Map() // port-forward name -> [{t, src, srcName, region, bytes, action, wanPort}] last hour
		this.processes = { t: 0, names: new Set() } // process census for the switcher slot list (refreshed every minute)
		this.counters = new Map() // "mac:port" -> {rx, tx, t, down, up, tRate, errors}
		this.hist = new Map() // key -> {down: Ring, up: Ring}
		this.aliases = new Map() // mac -> name from rest/user
		this.lastSeen = new Map() // mac -> last_seen (s) from rest/user
		this.ipToMac = new Map()
		this.netconf = []
		this.rawDevices = []
		this.rawClients = []
		this.probes = new Map() // ip -> probe result
		this.telemetry = new Map() // ip -> {kind, ...}
		this.flowIds = new Set()
		this.flowCursor = Date.now() - 60000
		this.incoming = new Map() // ATEM incoming streams from flows: "src>dport/proto" -> record
		this.peers = new Map() // equipment ip -> Map(peerKey -> record)
		this.alertSince = new Map() // alert id -> first seen
		this.prev = { ports: new Map(), eq: new Map(), wan: null, switches: new Map() } // for change events
		this.stream = { state: 'idle', baseline: 0, rate: 0, since: 0, until: 0, samples: [], peak: 0 }
		this.snmp = { cfg: { community: '', every_s: 3, ...(config.snmp || {}) }, switches: new Map(), rates: new Map(), status: {} } // mac -> SnmpSwitch; "mac:port" -> {rx, tx, t}
		this.atems = ATEM_POOL // ip -> AtemClient (one persistent session per switcher, shared process-wide)
		this.timers = []
		this.busy = new Set()
	}

	// ---------------------------------------------------------------- scheduling
	start() {
		const holdOff = new Map() // poll name -> time before which it is not retried (the controller said 5xx / timed out)
		const streak = new Map() // poll name -> consecutive failures
		const every = (name, s, fn) => {
			const run = async () => {
				if (this.busy.has(name)) return
				if (Date.now() < (holdOff.get(name) || 0)) return
				this.busy.add(name)
				try {
					await fn()
					if (streak.get(name)) this.event('device', `UniFi ${name} poll answering again`, { level: 'info' })
					streak.delete(name)
					delete this.state.errors[name]
				} catch (e) {
					const n = (streak.get(name) || 0) + 1
					streak.set(name, n)
					// a controller that answers 5xx or times out is overloaded: leave it alone for a minute, and one such
					// failure is a note, not an alert (the Network application hiccups and recovers); the second one is
					const transient = /HTTP 5\d\d|timeout|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND/i.test(e.message)
					if (!transient || n >= 2) this.state.errors[name] = `${new Date().toLocaleTimeString()} ${e.message}`
					else this.event('device', `UniFi ${name} poll: ${e.message} (asking again in a minute)`, { level: 'info' })
					this.log(`[${name}] ${e.message}`)
					if (transient) holdOff.set(name, Date.now() + 60000)
				} finally {
					this.busy.delete(name)
				}
			}
			run()
			this.timers.push(setInterval(run, Math.max(2, s) * 1000))
		}
		every('users', 300, () => this.pollUsers())
		every('clients', this.poll.clients_s, () => this.pollClients())
		every('devices', this.poll.devices_s, () => this.pollDevices())
		every('flows', this.poll.flows_s, () => this.pollFlows())
		every('log', this.poll.log_s, () => this.pollLog())
		every('probe', this.poll.probe_s, () => this.pollProbes())
		every('telemetry', this.poll.telemetry_s, () => this.pollTelemetry())
		if (this.snmp.cfg.community) every('snmp', this.snmp.cfg.every_s, () => this.pollSnmp())
		this.syncAudioTargets()
		this.x32.start()
		this.ssc.start()
		// live levels travel on their own event, at most five times a second and only when something moved
		this.timers.push(setInterval(() => this.emitMeters(), 200))
	}

	// which audio devices are read live: X32 consoles = roster probe "x32"; EW-DX receivers = role "audio" with a
	// mic-like name or vendor (isMic); only while active (standby devices are never polled). Cheap to call often.
	syncAudioTargets() {
		const eq = this.cfg.equipment.filter((e) => e.active !== false && e.ip)
		const isX32 = (e) => /^x32/.test(String(e.probe || ''))
		this.x32.setConsoles(eq.filter(isX32).map((e) => ({ ip: e.ip, name: e.name, port: Number(String(e.probe).split(':')[1]) || undefined })))
		this.ssc.setReceivers(eq.filter((e) => e.role === 'audio' && !isX32(e) && isMic({ name: e.name, oui: this.rawClients.find((c) => c.ip === e.ip)?.oui })).map((e) => ({ ip: e.ip, name: e.name })))
	}

	// the "meters" event: X32 levels, EW-DX AF/RF, Fairlight levels (own session only), compact, when they moved
	emitMeters() {
		const hero = this.cfg.atem?.ip ? this.atems.get(this.cfg.atem.ip) : null
		const atem = hero && !hero.closed && hero.wantsLevels ? hero.levelsSnapshot() : null
		if (this.x32.version === this.metersSent.x32 && this.ssc.version === this.metersSent.ssc && (atem?.t || 0) === this.metersSent.atem) return
		this.metersSent = { x32: this.x32.version, ssc: this.ssc.version, atem: atem?.t || 0 }
		this.emit('meters', { t: Date.now(), x32: this.x32.compact(), mic: this.ssc.compact(), atem })
	}

	// real-time port counters straight from the switches (needs SNMP v2c enabled in UniFi); only the ports that
	// are up are read, every few seconds; a switch that does not answer is retried every 5 minutes
	async pollSnmp() {
		const now = Date.now()
		const jobs = []
		for (const sw of this.state.switches) {
			if (!sw.online || !sw.ip) continue
			let s = this.snmp.switches.get(sw.mac)
			if (!s) {
				s = new SnmpSwitch(sw.ip, this.snmp.cfg.community)
				this.snmp.switches.set(sw.mac, s)
			}
			if (s.failedAt && now - s.failedAt < 300000) continue
			const ports = sw.ports.filter((p) => p.up).map((p) => p.idx)
			jobs.push(
				s
					.poll(ports)
					.then((m) => {
						for (const [idx, r] of m) this.snmp.rates.set(`${sw.mac}:${idx}`, r)
						s.failedAt = 0
						this.snmp.status[sw.name] = `ok · ${m.size} ports`
					})
					.catch((e) => {
						s.failedAt = now
						s.ifIndexByPort = null
						this.snmp.status[sw.name] = e.message
					}),
			)
		}
		await Promise.all(jobs)
		this.state.snmp = { enabled: true, status: this.snmp.status }
	}

	stop() {
		for (const t of this.timers) clearInterval(t)
		this.timers = []
		this.x32.stop()
		this.ssc.stop()
		for (const c of this.atems.values()) c.removeAllListeners() // the sessions themselves stay open (see ATEM_POOL)
	}

	history(key) {
		let h = this.hist.get(key)
		if (!h) {
			h = { down: new Ring(this.poll.history_points), up: new Ring(this.poll.history_points) }
			this.hist.set(key, h)
		}
		return h
	}

	event(kind, text, extra = {}) {
		const ev = { t: Date.now(), kind, text, ...extra }
		this.state.events.unshift(ev)
		if (this.state.events.length > 150) this.state.events.length = 150
		this.emit('event', ev)
		return ev
	}

	// delta rate on a cumulative counter pair; falls back to UniFi's averages when the counter is stale
	rate(key, rx, tx, t, fallbackRx, fallbackTx) {
		let c = this.counters.get(key)
		if (!c) {
			c = { rx, tx, t, down: num(fallbackRx), up: num(fallbackTx), tRate: t }
			this.counters.set(key, c)
		} else if (rx !== c.rx || tx !== c.tx) {
			const dt = (t - c.t) / 1000
			if (dt > 0.5) {
				c.down = Math.max(0, (rx - c.rx) / dt)
				c.up = Math.max(0, (tx - c.tx) / dt)
				c.tRate = t
				c.rx = rx
				c.tx = tx
				c.t = t
			}
		} else if (t - c.tRate > 60000) {
			c.down = num(fallbackRx)
			c.up = num(fallbackTx)
		}
		return { down: c.down, up: c.up, age: Math.round((t - c.tRate) / 1000) }
	}

	// ---------------------------------------------------------------- polls
	async pollUsers() {
		const users = await this.api.users()
		for (const u of users || []) {
			const mac = lower(u.mac)
			if (!mac) continue
			if (u.name) this.aliases.set(mac, u.name)
			if (u.last_seen) this.lastSeen.set(mac, u.last_seen)
		}
		this.netconf = (await this.api.networks()) || []
		// port forwards: an inbound flow is logged against the WAN address and WAN port, so a forwarded stream
		// (e.g. WAN 1937 -> ATEM 1935) is only recognised once the forward table is known
		try {
			const pf = (await this.api.portForwards()) || []
			this.portForwards = pf
				.filter((f) => f.enabled !== false)
				.map((f) => ({ name: f.name, proto: f.proto || 'tcp_udp', wanPorts: String(f.dst_port || ''), to: f.fwd, toPorts: String(f.fwd_port || ''), src: f.src || 'any' }))
			this.state.portForwards = this.portForwards
		} catch (e) {
			this.log('[portforward] ' + e.message)
		}
		this.state.updated.users = Date.now()
	}

	async pollClients() {
		this.rawClients = (await this.api.clients()) || []
		this.state.updated.clients = Date.now()
	}

	async pollLog() {
		const r = await this.api.systemLog({ pageSize: 100, hours: 72 })
		const recs = Array.isArray(r) ? r : r?.data || []
		this.state.log = recs.map(normaliseLog).filter(Boolean).slice(0, 100)
		this.state.updated.log = Date.now()
	}

	async pollProbes() {
		// an ATEM that is read over its protocol (telemetry) is not also pinged with hellos: every hello opens a
		// session the switcher has to time out, and the Minis only have a handful of session slots
		// never send bare hellos to an ATEM: the switcher keeps every half-open session for about two minutes and runs out of slots
		const items = this.cfg.equipment.filter((e) => e.active !== false && e.probe && e.ip && !String(e.probe).startsWith('atem'))
		const res = await probeAll(items)
		for (const [ip, r] of res) this.probes.set(ip, this.settle(ip, { ...r, t: Date.now() }))
		this.state.updated.probe = Date.now()
	}

	async pollTelemetry() {
		const now = Date.now()
		const items = this.cfg.equipment.filter((e) => e.active !== false && e.ip && (e.telemetry || String(e.probe || '').startsWith('atem'))).map((e) => (e.telemetry || !String(e.probe || '').startsWith('atem') ? e : { ...e, telemetry: 'atem' }))
		const companionStatus = await this.companion.status()
		this.state.companion = { ...companionStatus, lastOk: this.companion.lastOk, connections: companionStatus.connections.filter((c) => /^bmd-|behringer|sennheiser|ndi|unifi|obs/i.test(c.module) || c.module === 'generic-http') }
		await Promise.all(
			items.map(async (e) => {
				try {
					let t = null
					if (e.telemetry === 'atem') t = await this.atemTelemetry(e, now)
					else t = await restTelemetry(e.telemetry, e.ip)
					if (t) this.telemetry.set(e.ip, { ...t, t: Date.now() })
					else this.telemetry.delete(e.ip)
				} catch (err) {
					this.telemetry.set(e.ip, { kind: e.telemetry, error: err.message, t: Date.now() })
				}
			}),
		)
		this.state.updated.telemetry = Date.now()
	}

	// How a switcher is read. Every app that talks to an ATEM takes one of its few control slots (the HD8 was full
	// with Companion, ATEM Software Control and the NDI Machine bridge), so by default the switcher is read through
	// Companion's HTTP API, which costs the switcher nothing. Modes (config atem.session):
	//   companion  read through Companion; never open our own session (default)
	//   auto       Companion when it answers; our own session only after Companion has been away for 3 minutes,
	//              released again a minute after Companion is back
	//   own        always hold our own session (one slot; needed for the raw protocol capture)
	//   none       no switcher telemetry at all
	// A switcher with no Companion label (the field Mini) is read with its own session unless the mode is "none".
	atemMode(e) {
		const mode = this.cfg.atem?.session || 'companion'
		const label = e.companion || (e.ip === this.cfg.atem?.ip ? this.cfg.companion?.atem_label : null) || null
		if (mode === 'none') return { mode, label }
		if (mode === 'own' || !label) return { mode: 'own', label }
		return { mode, label }
	}

	async atemTelemetry(e, now) {
		const { mode, label } = this.atemMode(e)
		const cs = this.companionState.get(e.ip) || { lastOk: this.state.started, okSince: 0 }
		this.companionState.set(e.ip, cs)
		let viaCompanion = null
		if (mode === 'companion' || mode === 'auto') {
			try {
				viaCompanion = await this.companion.atem(label)
				if (!viaCompanion) viaCompanion = { kind: 'atem', via: 'companion', label, error: `Companion has no connection labelled "${label}"` }
			} catch (err) {
				viaCompanion = { kind: 'atem', via: 'companion', label, error: `Companion not reachable at ${this.companion.url}` }
			}
		}
		const companionLive = !!viaCompanion && !viaCompanion.error
		if (companionLive) {
			if (!cs.okSince) cs.okSince = now
			cs.lastOk = now
		} else cs.okSince = 0
		const pooled = this.atems.get(e.ip)
		const wantOwn = mode === 'own' || (mode === 'auto' && !companionLive && now - cs.lastOk > 180000)
		const releaseOwn = mode === 'none' || mode === 'companion' || (mode === 'auto' && companionLive && now - cs.okSince > 60000)
		if (wantOwn) {
			let c = pooled
			if (!c || c.closed) {
				c = new AtemClient(e.ip, { log: this.log })
				this.atems.set(e.ip, c)
			}
			if (!c.listenerCount('connected')) {
				c.on('connected', () => this.event('device', `${e.name}: Broadwatch holds a control connection (${c.data.product || 'ATEM'})`, { entity: { type: 'equipment', id: e.ip } }))
				c.on('disconnected', (err) => this.event('device', `${e.name}: switcher session lost (${err}); next attempt in 2 min`, { entity: { type: 'equipment', id: e.ip }, level: 'warn' }))
				c.on('refused', () => c.refusals === 1 && this.event('device', `${e.name} refused a control connection (too many clients): its slots are held by other controllers; Broadwatch backs off (2, 4, 8, then 15 min)`, { entity: { type: 'equipment', id: e.ip }, level: 'warn' }))
				c.on('released', () => this.event('device', `${e.name}: Broadwatch released its control connection (the switcher frees the slot in ~2 min)`, { entity: { type: 'equipment', id: e.ip } }))
			}
			c.ensure()
			// Fairlight levels only on an own session (the switcher streams them on request; Companion passes none)
			c.wantLevels(mode === 'own')
			const snap = c.snapshot()
			const full = c.state === 'refused' && c.error === 'too many clients'
			const reachable = c.state === 'connected' || full
			this.probes.set(e.ip, this.settle(e.ip, { ok: reachable, ms: c.state === 'connected' ? 1 : 0, error: reachable ? undefined : c.error || 'connecting', info: { state: full ? 'too many clients' : c.state === 'connected' ? `connected · ${c.commands} updates` : c.state }, t: now }))
			return { ...snap, mode, companion: viaCompanion ? { ok: companionLive, error: viaCompanion.error || null, label } : null }
		}
		if (pooled && !pooled.closed && releaseOwn) pooled.close()
		const session = pooled ? pooled.snapshot() : null
		if (mode === 'none') {
			this.probes.delete(e.ip)
			return null
		}
		if (!companionLive) {
			// Companion itself is away: we cannot tell whether the switcher answers, so no probe verdict at all
			this.probes.delete(e.ip)
			return { ...viaCompanion, mode, session }
		}
		this.probes.set(e.ip, this.settle(e.ip, { ok: viaCompanion.connected, ms: 0, error: viaCompanion.connected ? undefined : viaCompanion.error || 'Companion is not connected to it', info: { state: viaCompanion.connected ? `via Companion "${label}"` : viaCompanion.companionStatus }, t: now }))
		return { ...viaCompanion, mode, session }
	}

	// a hand-written label for a switch port (device name, IP, note) for what UniFi cannot see: SDI gear behind a
	// dumb switch, static devices on isolated VLANs, patch-panel notes; empty fields remove the label
	setPortLabel(key, label) {
		if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}:\d{1,3}$/i.test(String(key || ''))) return { error: 'bad port key' }
		const clean = { name: String(label?.name || '').trim().slice(0, 60), ip: String(label?.ip || '').trim().slice(0, 45), note: String(label?.note || '').trim().slice(0, 120) }
		if (!clean.name && !clean.ip && !clean.note) delete this.portLabels[key]
		else this.portLabels[key] = clean
		this.cfg.port_labels = this.portLabels
		if (this.rawDevices.length) {
			this.rebuild()
			this.emit('state', this.state)
		}
		return { ok: true, labels: this.portLabels }
	}

	// manual control of our own switcher session (inspector buttons)
	atemSession(ip, action) {
		const e = this.cfg.equipment.find((x) => x.ip === ip)
		if (!e) return { error: 'unknown switcher' }
		let c = this.atems.get(ip)
		if (action === 'release') {
			if (!c) return { ok: true, state: 'idle' }
			c.close()
			return { ok: true, state: c.state }
		}
		if (action === 'connect') {
			if (!c || c.closed) {
				c = new AtemClient(ip, { log: this.log })
				this.atems.set(ip, c)
			}
			const note = c.connectNow()
			return { ok: true, state: c.state, note }
		}
		return { error: 'unknown action' }
	}

	// the other programs that may hold one of the switcher's control slots: Companion (asked over its API), listed
	// processes on this machine (tasklist / ps once a minute) and anything the roster says runs elsewhere
	refreshProcesses(now) {
		if (now - this.processes.t < 60000) return
		this.processes.t = now
		// tasklist takes 6-7 s on a busy PC; PowerShell answers in about a second
		const win = process.platform === 'win32'
		execFile(win ? 'powershell' : 'ps', win ? ['-NoProfile', '-NonInteractive', '-Command', '(Get-Process).ProcessName'] : ['-axo', 'comm'], { windowsHide: true, timeout: 20000, maxBuffer: 8 << 20 }, (err, out) => {
			if (err) return
			const names = new Set()
			for (const line of String(out).split(/\r?\n/)) {
				const n = line.trim().split('/').pop()
				if (n) names.add(lower(n).replace(/\.exe$/, ''))
			}
			this.processes.names = names
		})
	}

	knownControllers(now) {
		this.refreshProcesses(now)
		const list = Array.isArray(this.cfg.atem?.controllers) ? this.cfg.atem.controllers : []
		const comp = this.state.companion
		return list.map((k) => {
			let held = null
			let how = ''
			if (k.detect === 'companion') {
				const c = (comp?.connections || []).find((x) => x.module === 'bmd-atem' && (!k.label || x.label === k.label))
				held = comp?.ok ? !!c && c.status === 'good' : null
				how = comp?.ok ? (c ? `Companion connection "${c.label}" is ${c.status}` : 'Companion has no ATEM connection') : 'Companion not reachable'
			} else if (String(k.detect || '').startsWith('process:')) {
				const name = lower(k.detect.slice(8)).replace(/\.exe$/, '')
				held = this.processes.names.size ? this.processes.names.has(name) : null
				how = held === null ? 'process list not read yet' : held ? `${name} is running on this machine` : `${name} is not running`
			} else how = 'cannot be seen from here'
			return { name: k.name, where: k.where || '', held, how }
		})
	}

	// one missed answer is not a failure (UDP, busy devices): the previous good result stands until two misses in a row
	settle(ip, r) {
		this.misses = this.misses || new Map()
		if (r.ok) {
			this.misses.set(ip, 0)
			return r
		}
		const n = (this.misses.get(ip) || 0) + 1
		this.misses.set(ip, n)
		const prev = this.probes.get(ip)
		if (n < 2 && prev && prev.ok) return { ...prev, retrying: true, t: r.t }
		return r
	}

	async pollFlows() {
		const end = Date.now()
		const start = this.flowCursor - 5000
		const all = []
		// the gateway logs thousands of flows a minute; incoming ones (internet -> LAN, the remote streams)
		// are fetched completely, local (between VLANs) and outgoing ones only the newest pages
		const fetchDir = async (dir, maxPages) => {
			for (let page = 0; page < maxPages; page++) {
				const r = await this.api.flows({ start, end, pageSize: 200, pageNumber: page, direction: [dir] })
				const recs = r?.data || []
				all.push(...recs)
				if (!r?.has_next || recs.length < 200) break
				const oldest = recs[recs.length - 1]?.time
				if (oldest && oldest < this.flowCursor) break
			}
		}
		// the flow query is the heaviest call the controller gets from us: keep the paging modest
		await fetchDir('incoming', 3)
		await fetchDir('local', 2)
		await fetchDir('outgoing', 1)
		this.flowCursor = end
		const fresh = all.filter((f) => f?.id && !this.flowIds.has(f.id))
		for (const f of fresh) this.flowIds.add(f.id)
		if (this.flowIds.size > 5000) this.flowIds = new Set([...this.flowIds].slice(-2500))
		this.ingestFlows(fresh, end)
		this.state.flows.window_s = Math.round((end - start) / 1000)
		this.state.updated.flows = end
	}

	async pollDevices() {
		const [devices, health] = await Promise.all([this.api.devices(), this.api.health().catch(() => [])])
		this.rawDevices = devices || []
		this.health = Object.fromEntries((health || []).map((h) => [h.subsystem, h]))
		this.rebuild()
		this.state.updated.devices = Date.now()
		this.emit('state', this.state)
	}

	// ---------------------------------------------------------------- flows -> ATEM incoming + peers
	// WAN port -> {ip, port} of the LAN target, from the UDM's port-forward table ("1937", "5200-5299" or "a,b")
	forwardTarget(dport, proto) {
		for (const f of this.portForwards || []) {
			if (f.proto !== 'tcp_udp' && f.proto && proto && f.proto.toLowerCase() !== String(proto).toLowerCase()) continue
			const wan = f.wanPorts.split(',').map((x) => x.trim())
			const lan = f.toPorts.split(',').map((x) => x.trim())
			for (let i = 0; i < wan.length; i++) {
				const [a, b] = wan[i].split('-').map(Number)
				if (dport === a || (b && dport >= a && dport <= b)) {
					const [la] = (lan[i] || lan[0] || wan[i]).split('-').map(Number)
					return { ip: f.to, port: b ? la + (dport - a) : la || dport, name: f.name, wanPort: dport }
				}
			}
		}
		return null
	}

	ingestFlows(recs, now) {
		const atemIp = this.cfg.atem?.ip
		const eqIps = new Set(this.cfg.equipment.map((e) => e.ip))
		const wanIp = this.state.gateway?.wan?.ip || null
		const recent = this.state.flows.recent
		const bytesTop = []
		let blocked = 0
		for (const f of recs) {
			const src = f.source || {}
			const dst = f.destination || {}
			const td = f.traffic_data || {}
			const bytes = num(td.bytes_total)
			if (f.action === 'blocked') blocked++
			const rec = {
				id: f.id,
				t: f.time || now,
				src: src.ip,
				sport: src.port,
				srcName: src.device_name || this.aliases.get(lower(src.mac)) || null,
				srcRegion: src.region || null,
				srcZone: src.zone_name || null,
				dst: dst.ip,
				dport: dst.port,
				dstName: dst.device_name || this.aliases.get(lower(dst.mac)) || null,
				dstRegion: dst.region || null,
				dstZone: dst.zone_name || null,
				proto: f.protocol,
				service: f.service,
				app: f.application?.app || null,
				cat: f.application?.cat || null,
				dir: f.direction,
				action: f.action,
				network: f.in?.network_name || null,
				bytes,
				bytesRx: num(td.bytes_rx),
				bytesTx: num(td.bytes_tx),
				packets: num(td.packets_total),
				risk: f.risk,
			}
			if (wanIp && rec.dst === wanIp && rec.dir === 'incoming') {
				const t = this.forwardTarget(rec.dport, rec.proto)
				if (t) {
					rec.viaForward = { name: t.name, wanPort: t.wanPort }
					rec.dst = t.ip
					rec.dport = t.port
					rec.dstName = this.cfg.equipment.find((e) => e.ip === t.ip)?.name || rec.dstName
					// remembered per forward for the stream path check (who hit which WAN port, when, how much)
					const hl = this.forwardHits.get(t.name) || []
					hl.push({ t: rec.t, src: rec.src, srcName: rec.srcName, region: rec.srcRegion, bytes, packets: rec.packets, action: rec.action, wanPort: t.wanPort, proto: rec.proto })
					if (hl.length > 400) hl.splice(0, hl.length - 400)
					this.forwardHits.set(t.name, hl)
				}
			}
			bytesTop.push(rec)
			if (eqIps.has(rec.src) || eqIps.has(rec.dst)) recent.unshift(rec)
			if (atemIp && rec.dst === atemIp) this.noteIncoming(rec, now)
			for (const ip of [rec.src, rec.dst]) {
				if (!eqIps.has(ip)) continue
				const other = ip === rec.src ? rec.dst : rec.src
				const m = this.peers.get(ip) || new Map()
				const k = `${other}/${ip === rec.src ? 'out' : 'in'}/${rec.proto}`
				const p = m.get(k) || { ip: other, name: ip === rec.src ? rec.dstName : rec.srcName, dir: ip === rec.src ? 'out' : 'in', proto: rec.proto, service: rec.service, bytes: 0, count: 0, first: rec.t, last: 0, region: ip === rec.src ? rec.dstRegion : rec.srcRegion }
				p.bytes += bytes
				p.count++
				p.last = Math.max(p.last, rec.t)
				p.service = rec.service || p.service
				m.set(k, p)
				this.peers.set(ip, m)
			}
		}
		this.state.flows.recent = recent.slice(0, 150)
		this.state.flows.total = recs.length
		this.state.flows.blocked = blocked
		if (recs.length) {
			bytesTop.sort((a, b) => b.bytes - a.bytes)
			this.state.flows.top = bytesTop.slice(0, 15)
		}
		for (const [, m] of this.peers) for (const [k, p] of m) if (now - p.last > 1800000) m.delete(k)
	}

	noteIncoming(rec, now) {
		const key = `${rec.src}>${rec.dport}/${rec.proto}`
		let s = this.incoming.get(key)
		if (!s) {
			s = { key, src: rec.src, sport: rec.sport, srcName: rec.srcName, region: rec.srcRegion, zone: rec.srcZone, dport: rec.dport, proto: rec.proto, service: rec.service, app: rec.app, network: rec.network, action: rec.action, viaForward: rec.viaForward || null, first: rec.t, last: 0, bytes: 0, packets: 0, flows: 0 }
			this.incoming.set(key, s)
			if (rec.action !== 'blocked') this.event('flow', `Flow into the ATEM from ${rec.srcName || rec.src}${rec.srcRegion ? ' (' + rec.srcRegion + ')' : ''} → ${rec.proto} port ${rec.dport}`, { entity: { type: 'atem' } })
			else this.event('flow', `Blocked connection to the ATEM from ${rec.src}${rec.srcRegion ? ' (' + rec.srcRegion + ')' : ''} → ${rec.proto} port ${rec.dport}`, { entity: { type: 'atem' }, level: 'warn' })
		}
		s.last = Math.max(s.last, rec.t)
		s.bytes += rec.bytes
		s.packets += rec.packets
		s.flows++
		s.service = rec.service || s.service
		s.app = rec.app || s.app
		s.action = rec.action
		s.srcName = rec.srcName || s.srcName
		for (const [k, v] of this.incoming) if (now - v.last > 3600000) this.incoming.delete(k)
	}

	// ---------------------------------------------------------------- state assembly
	rebuild() {
		const now = Date.now()
		const devices = this.rawDevices
		const clients = this.rawClients
		const devByMac = new Map(devices.map((d) => [lower(d.mac), d]))
		const clientByIp = new Map()
		const clientsByPort = new Map() // "swmac:port" -> [client]
		const clientsByAp = new Map()
		const netCounts = {}
		let wired = 0
		let wireless = 0
		for (const c of clients) {
			const mac = lower(c.mac)
			c._name = this.aliases.get(mac) || c.name || c.hostname || null
			if (c.ip) {
				clientByIp.set(c.ip, c)
				this.ipToMac.set(c.ip, mac)
			}
			if (c.is_wired) {
				wired++
				const k = `${lower(c.sw_mac)}:${c.sw_port}`
				if (!clientsByPort.has(k)) clientsByPort.set(k, [])
				clientsByPort.get(k).push(c)
			} else {
				wireless++
				const k = lower(c.ap_mac)
				if (!clientsByAp.has(k)) clientsByAp.set(k, [])
				clientsByAp.get(k).push(c)
			}
			const n = c.network || '?'
			netCounts[n] = (netCounts[n] || 0) + 1
		}
		this.state.clients = { total: clients.length, wired, wireless, byNetwork: netCounts }

		// downstream devices hanging off a port (uplink_remote_port on the child)
		const devicesByPort = new Map()
		for (const d of devices) {
			const up = d.uplink || {}
			const parent = lower(up.uplink_mac)
			if (parent && up.uplink_remote_port) {
				const k = `${parent}:${up.uplink_remote_port}`
				if (!devicesByPort.has(k)) devicesByPort.set(k, [])
				devicesByPort.get(k).push(d)
			}
		}

		const switches = []
		const aps = []
		const others = []
		let gateway = null
		for (const d of devices) {
			const mac = lower(d.mac)
			const online = d.state === 1
			const ss = d['system-stats'] || {}
			// counters are timed by our poll clock: a switch's last_seen lags its counter updates by up to a minute
			const t = now
			const temps = Array.isArray(d.temperatures) ? d.temperatures.map((x) => ({ name: x.name, value: Math.round(num(x.value) * 10) / 10 })) : []
			const temp = d.general_temperature ?? temps.find((x) => /cpu/i.test(x.name))?.value ?? temps[0]?.value ?? null
			const ports = []
			let rxAll = 0
			let txAll = 0
			let poeAll = 0
			let portsUp = 0
			for (const p of d.port_table || []) {
				const idx = p.port_idx
				const key = `${mac}:${idx}`
				let r = this.rate(key, num(p.rx_bytes), num(p.tx_bytes), t, p['rx_bytes-r'], p['tx_bytes-r'])
				const sr = this.snmp.rates.get(key)
				if (sr && now - sr.t < 20000) r = { down: sr.rx, up: sr.tx, age: Math.round((now - sr.t) / 1000), snmp: true }
				const errs = num(p.rx_errors) + num(p.tx_errors) + num(p.rx_dropped) + num(p.tx_dropped)
				const c = this.counters.get(key)
				const errDelta = c.errors === undefined ? 0 : Math.max(0, errs - c.errors)
				c.errors = errs
				c.errSeen = errDelta > 0 ? now : c.errSeen || 0
				const cl = clientsByPort.get(key) || []
				const dd = devicesByPort.get(key) || []
				const up = !!p.up
				if (up) portsUp++
				rxAll += r.down
				txAll += r.up
				poeAll += num(p.poe_power)
				// link change events (only once the switch has been seen before)
				const pk = this.prev.ports.get(key)
				if (pk !== undefined && pk !== up && online) {
					const who = dd[0]?.name || cl[0]?._name || cl[0]?.ip || null
					this.event('link', `${d.name} port ${idx} link ${up ? 'UP' : 'DOWN'}${who ? ` (${who})` : ''}${up && p.speed ? ` at ${p.speed >= 1000 ? p.speed / 1000 + 'G' : p.speed + 'M'}` : ''}`, { entity: { type: 'port', id: key }, level: up ? 'info' : 'warn' })
				}
				this.prev.ports.set(key, up)
				ports.push({
					idx,
					key,
					name: p.name || `Port ${idx}`,
					up,
					enabled: p.enable !== false && p.forward !== 'disabled',
					speed: num(p.speed),
					fullDuplex: p.full_duplex !== false,
					media: p.media || (p.sfp_found ? 'SFP' : 'GE'),
					sfp: p.media === 'SFP' || p.media === 'SFP+' || !!p.sfp_found,
					poe: !!p.port_poe,
					poeW: Math.round(num(p.poe_power) * 10) / 10,
					poeMode: p.poe_mode || null,
					uplink: !!p.is_uplink || dd.length > 0,
					lag: p.aggregated_by || null,
					rx: mbps(r.down), // from the attached device into the switch
					tx: mbps(r.up), // from the switch to the attached device
					age: r.age,
					live: !!r.snmp,
					util: p.speed ? Math.min(1, (Math.max(r.down, r.up) * 8) / (num(p.speed) * 1e6)) : 0,
					errors: errs,
					errorsRecent: now - (c.errSeen || 0) < 600000,
					clients: cl.slice(0, 6).map((x) => ({ name: x._name, ip: x.ip, mac: x.mac })),
					clientCount: cl.length,
					devices: dd.map((x) => ({ name: x.name, ip: x.ip, type: x.type, mac: lower(x.mac) })),
					label: this.portLabels[key] || null,
				})
			}
			ports.sort((a, b) => a.idx - b.idx)
			const h = this.history(mac)
			h.down.push(mbps(rxAll))
			h.up.push(mbps(txAll))
			const upl = d.uplink || {}
			const entry = {
				mac,
				name: d.name || d.model,
				model: d.model,
				modelName: modelName(d),
				ip: d.lan_ip || d.ip,
				type: d.type,
				online,
				state: d.state,
				uptime: online ? num(d.uptime) : 0,
				lastSeen: d.last_seen ? d.last_seen * 1000 : null,
				version: d.version,
				upgradable: !!d.upgradable,
				cpu: ss.cpu !== undefined ? Math.round(num(ss.cpu)) : null,
				mem: ss.mem !== undefined ? Math.round(num(ss.mem)) : null,
				temp: temp !== null ? Math.round(num(temp)) : null,
				temps,
				overheating: !!d.overheating,
				fan: d.fan_level ?? null,
				satisfaction: d.satisfaction ?? null,
				uplink: {
					device: upl.uplink_device_name || null,
					mac: lower(upl.uplink_mac) || null,
					port: upl.uplink_remote_port || null,
					localPort: upl.port_idx || null,
					speed: num(upl.speed),
					media: upl.media || upl.type || null,
					down: mbps(upl['rx_bytes-r']),
					up: mbps(upl['tx_bytes-r']),
				},
				depth: d.uplink_depth ?? null,
				ports,
				portsUp,
				portsTotal: ports.length,
				totals: { down: mbps(rxAll), up: mbps(txAll) },
				poeW: Math.round(poeAll * 10) / 10,
				poeMax: num(d.total_max_power) || null,
				clients: (d.type === 'uap' ? clientsByAp.get(mac) || [] : []).length,
				history: { down: h.down.a, up: h.up.a },
				age: online ? Math.min(...ports.map((p) => p.age), d.last_seen ? Math.round((now - d.last_seen * 1000) / 1000) : 999) : null,
			}
			const pOnline = this.prev.switches.get(mac)
			if (pOnline !== undefined && pOnline !== online) this.event('device', `${entry.name} is ${online ? 'back online' : 'OFFLINE'}`, { entity: { type: d.type === 'uap' ? 'ap' : 'switch', id: mac }, level: online ? 'info' : 'error' })
			this.prev.switches.set(mac, online)
			if (isPdu(d)) {
				const outlets = d.outlet_table || []
				others.push({ ...entry, kind: 'pdu', ports: [], outlets: outlets.length, outletsOn: outlets.filter((o) => o.relay_state).length, powerW: Math.round(outlets.reduce((s, o) => s + num(o.outlet_power), 0) * 10) / 10, voltage: outlets.find((o) => num(o.outlet_voltage))?.outlet_voltage ?? null })
				continue
			}
			if (d.type === 'udm' || d.type === 'uxg' || d.type === 'ugw') {
				const wan = this.health?.wan || {}
				const www = this.health?.www || {}
				const w1 = d.wan1 || {}
				gateway = {
					...entry,
					ip: d.lan_ip || safeHost(this.cfg.gateway.url) || d.ip,
					wanIp: d.ip,
					storage: (d.storage || []).map((s) => ({ name: s.name, used: num(s.used), size: num(s.size) })),
					wan: {
						status: wan.status || (w1.up ? 'ok' : 'unknown'),
						name: wan.gw_name || w1.name || 'WAN',
						ip: wan.wan_ip || w1.ip || null,
						down: mbps(wan['rx_bytes-r'] ?? upl['rx_bytes-r']),
						up: mbps(wan['tx_bytes-r'] ?? upl['tx_bytes-r']),
						latency: www.latency ?? null,
						uptime: www.uptime ?? null,
						speed: num(w1.speed) || num(upl.speed),
						isp: w1.isp_name || null,
					},
					speedtest: d['speedtest-status'] ? { down: d['speedtest-status'].xput_download, up: d['speedtest-status'].xput_upload, ping: d['speedtest-status'].latency, t: d['speedtest-status'].rundate } : null,
					networks: [],
				}
				if (this.prev.wan && this.prev.wan !== gateway.wan.status) this.event('wan', `WAN ${gateway.wan.status === 'ok' ? 'is back' : gateway.wan.status}`, { entity: { type: 'wan' }, level: gateway.wan.status === 'ok' ? 'info' : 'error' })
				this.prev.wan = gateway.wan.status
				const wh = this.history('wan')
				wh.down.push(gateway.wan.down)
				wh.up.push(gateway.wan.up)
				gateway.wan.history = { down: wh.down.a, up: wh.up.a }
				const conf = new Map(this.netconf.map((n) => [n.name, n]))
				for (const n of d.network_table || []) {
					const cfgN = conf.get(n.name) || {}
					const nh = this.history(`net:${n.name}`)
					const down = mbps(n['rx_bytes-r'])
					const up = mbps(n['tx_bytes-r'])
					nh.down.push(down)
					nh.up.push(up)
					gateway.networks.push({ name: n.name, vlan: n.vlan ?? cfgN.vlan ?? null, subnet: n.ip_subnet || cfgN.ip_subnet || null, purpose: cfgN.purpose || null, clients: n.num_sta ?? netCounts[n.name] ?? 0, down, up, watched: (this.cfg.networks || []).includes(n.name), order: (this.cfg.networks || []).indexOf(n.name), history: { down: nh.down.a, up: nh.up.a } })
				}
				// the watched VLANs first, in the order the config lists them (the top bar shows them in that order), then the rest by size
				gateway.networks.sort((a, b) => (a.watched ? a.order : 1e6) - (b.watched ? b.order : 1e6) || b.clients - a.clients)
			} else if (d.type === 'usw') switches.push(entry)
			else if (d.type === 'uap') aps.push(entry)
			else others.push({ ...entry, kind: d.type, ports: [] })
		}
		switches.sort((a, b) => Number(b.online) - Number(a.online) || (a.depth ?? 9) - (b.depth ?? 9) || a.name.localeCompare(b.name))
		this.state.gateway = gateway
		this.state.switches = switches
		this.state.aps = aps
		this.state.others = others
		this.state.networks = gateway?.networks || []

		// equipment: config entries + auto-discovered broadcast vendors
		const known = new Set(this.cfg.equipment.map((e) => e.ip))
		const discovered = []
		const ouis = (this.cfg.auto_discover_ouis || []).map(lower)
		for (const c of clients) {
			if (!c.ip || known.has(c.ip)) continue
			const oui = lower(c.oui)
			if (ouis.some((o) => oui.includes(o))) discovered.push({ name: c._name || `${String(c.oui).split(/\s+/)[0]} device`, ip: c.ip, group: 'Discovered (by vendor)', role: 'unknown', discovered: true })
		}
		const allDevs = [...switches, gateway, ...aps].filter(Boolean)
		const equipment = []
		for (const e of [...this.cfg.equipment, ...discovered]) {
			const c = clientByIp.get(e.ip)
			const sw = c ? devByMac.get(lower(c.sw_mac || c.ap_mac)) : null
			const swEntry = sw ? allDevs.find((s) => s.mac === lower(sw.mac)) : null
			const port = swEntry && c?.is_wired ? swEntry.ports.find((p) => p.idx === c.sw_port) : null
			const active = e.active !== false
			const pr = active ? this.probes.get(e.ip) || null : null
			const tl = active ? this.telemetry.get(e.ip) || null : null
			const h = this.history(`eq:${e.ip}`)
			const down = port ? port.tx : mbps(c?.['rx_bytes-r'])
			const up = port ? port.rx : mbps(c?.['tx_bytes-r'])
			h.down.push(down)
			h.up.push(up)
			const peers = [...(this.peers.get(e.ip) || new Map()).values()].sort((a, b) => b.last - a.last).slice(0, 8)
			const status = !c ? 'offline' : pr && !pr.ok ? 'unresponsive' : 'online'
			const pStatus = this.prev.eq.get(e.ip)
			if (pStatus !== undefined && pStatus !== status && !e.discovered && active) this.event('equipment', `${e.name} ${status === 'online' ? 'is OK again' : status === 'offline' ? 'left the network' : 'stopped answering (' + (pr?.error || e.probe) + ')'}`, { entity: { type: 'equipment', id: e.ip }, level: status === 'online' ? 'info' : e.hero ? 'error' : 'warn' })
			this.prev.eq.set(e.ip, status)
			// telemetry change events
			if (tl && !tl.error) {
				const sig = tl.kind === 'webpresenter' ? `wp:${tl.status}` : tl.kind === 'hyperdeck' ? `hd:${tl.recording ? 'rec' : tl.mode}` : tl.kind === 'atem' ? `atem:${tl.streaming?.state || '-'}` : ''
				const pk = `tele:${e.ip}`
				const ps = this.prev.eq.get(pk)
				if (ps !== undefined && ps !== sig) {
					if (tl.kind === 'webpresenter') this.event('stream', `${e.name}: stream ${tl.status}${tl.streaming && tl.bitrate ? ` at ${(tl.bitrate / 1e6).toFixed(1)} Mb/s` : ''}`, { entity: { type: 'equipment', id: e.ip }, level: /interrupt|error|fail/i.test(tl.status) ? 'error' : 'info' })
					else if (tl.kind === 'hyperdeck') this.event('record', `${e.name}: ${tl.recording ? 'RECORDING' : tl.mode}`, { entity: { type: 'equipment', id: e.ip } })
					else if (tl.kind === 'atem') this.event('stream', `${e.name}: stream ${tl.streaming?.state || 'unknown'}${tl.streaming?.url ? ' → ' + tl.streaming.url : ''}`, { entity: { type: 'equipment', id: e.ip } })
				}
				this.prev.eq.set(pk, sig)
			}
			equipment.push({
				...e,
				active,
				probeSpec: e.probe || null,
				unifiName: c?._name || null,
				online: !!c,
				wired: c ? !!c.is_wired : null,
				mac: c?.mac || null,
				oui: c?.oui || null,
				network: c?.network || null,
				uptime: c ? num(c.uptime) : 0,
				lastSeen: c ? now : this.lastSeenByIp(e.ip),
				switch: swEntry ? { name: swEntry.name, mac: swEntry.mac, port: c.sw_port, key: port?.key || null, speed: port?.speed || null, poeW: port?.poeW || 0 } : null,
				down,
				up,
				age: port?.age ?? null,
				probe: pr,
				telemetry: tl,
				reachable: pr ? pr.ok : null,
				status,
				peers,
				history: { down: h.down.a, up: h.up.a },
			})
		}
		this.state.equipment = equipment

		// the mirror-port view of the switcher's traffic (when tshark runs on this machine)
		this.state.forensics = this.forensics ? this.forensics.snapshot({ flows: 30, events: 40 }) : null

		// live audio: X32 meters, EW-DX receivers, the switcher's Fairlight levels (own session only)
		this.syncAudioTargets()
		this.state.audio = this.audioState(now, equipment)

		// ATEM hero + stream detection
		const atemCfg = this.cfg.atem
		if (atemCfg?.ip) {
			const eq = equipment.find((e) => e.ip === atemCfg.ip)
			const incoming = [...this.incoming.values()].sort((a, b) => b.last - a.last)
			const pooled = this.atems.get(atemCfg.ip)
			const { mode, label } = this.atemMode(eq || atemCfg)
			this.state.atem = {
				...atemCfg,
				equipment: eq || null,
				incoming: incoming.map((s) => ({ ...s, live: now - s.last < 45000, ageS: Math.round((now - s.last) / 1000) })),
				liveCount: incoming.filter((s) => now - s.last < 45000).length,
				stream: this.detectStream(eq, equipment, incoming, now),
				session: { mode, label, own: pooled ? pooled.snapshot() : null, companion: eq?.telemetry?.via === 'companion' ? { ok: !eq.telemetry.error, error: eq.telemetry.error || null, connected: !!eq.telemetry.connected } : null, controllers: this.knownControllers(now), holdMs: AtemClient.SLOT_HOLD_MS },
			}
		}
		this.state.streamPaths = this.streamPaths(now, equipment, clientByIp)

		this.state.topology = this.buildTopology(gateway, switches, aps, others, equipment)
		this.state.alerts = this.computeAlerts(now)
		const profile = this.profiles.find((p) => p.id === this.activeProfile) || this.profiles[0]
		const prevVerdict = this.state.health?.verdict
		this.state.health = computeHealth(this.state, profile, this.th)
		this.state.tiles = tiles(this.state, this.state.health)
		this.state.profiles = { list: this.profiles.map((p) => ({ id: p.id, name: p.name, expect: p.expect, roster: p.roster || null })), active: this.activeProfile }
		if (prevVerdict && prevVerdict !== this.state.health.verdict) this.event('health', `Broadcast health ${this.state.health.verdict} (${this.state.health.score}): ${this.state.health.headline}`, { level: this.state.health.verdict === 'READY' ? 'info' : this.state.health.verdict === 'DEGRADED' ? 'warn' : 'error' })
		this.state.ts = now
		this.state.ok = Object.keys(this.state.errors).length === 0
	}

	// everything audio for the state: the consoles (meters, names, mute), the receivers (per channel: link, battery,
	// RF, AF, warnings), the roster's other audio devices that have nothing to read, and the switcher's Fairlight
	// levels when Broadwatch holds its own session. Also attaches a summary to each roster entry (`audio`).
	audioState(now, equipment) {
		const byIp = new Map(equipment.map((e) => [e.ip, e]))
		const consoles = this.x32.snapshot().map((c) => {
			const e = byIp.get(c.ip)
			return { ...c, name: e?.name || c.name, online: e ? e.online : null }
		})
		const mics = this.ssc.snapshot().map((m) => {
			const e = byIp.get(m.ip)
			return { ...m, name: e?.name || m.name, online: e ? e.online : null }
		})
		const known = new Set([...consoles.map((c) => c.ip), ...mics.map((m) => m.ip)])
		const others = equipment.filter((e) => e.active && !e.discovered && e.role === 'audio' && !known.has(e.ip)).map((e) => ({ ip: e.ip, name: e.name, online: e.online, note: e.probeSpec ? `reachability only (probe ${e.probeSpec}): no meter protocol for this device` : 'nothing to read: no probe (an X32 needs probe "x32"; a Sennheiser receiver is recognised by its name or vendor)' }))
		const atemIp = this.cfg.atem?.ip || null
		const hero = atemIp ? this.atems.get(atemIp) : null
		const mode = atemIp ? this.atemMode(byIp.get(atemIp) || this.cfg.atem).mode : 'none'
		const switcher = atemIp ? { ip: atemIp, name: this.cfg.atem.name, mode, held: !!hero && !hero.closed && hero.state === 'connected', levels: mode === 'own' && hero && !hero.closed ? hero.levelsSnapshot() : null, note: mode === 'own' ? null : 'Fairlight levels need Broadwatch’s own switcher session (Settings › Switcher: own session); read through Companion, the switcher sends no levels' } : null
		for (const c of consoles) {
			const e = byIp.get(c.ip)
			if (e) e.audio = { kind: 'x32', ok: c.ok, error: c.error, active: c.active, mainLevel: c.mainLevel, console: c.console, rate: c.rate }
			const key = `audio:${c.ip}`
			const sig = c.ok ? 'live' : c.answered ? 'silent' : 'gone'
			const prev = this.prev.eq.get(key)
			if (prev !== undefined && prev !== sig && e?.active) this.event('audio', `${c.name}: ${sig === 'live' ? `meters live (${c.console?.model || 'X32'}, ${c.rate}/s)` : sig === 'silent' ? 'answers but sends no meters' : 'meters stopped (no answer)'}`, { entity: { type: 'equipment', id: c.ip }, level: sig === 'live' ? 'info' : 'warn' })
			this.prev.eq.set(key, sig)
		}
		for (const m of mics) {
			const e = byIp.get(m.ip)
			if (e) e.audio = { kind: 'ewdx', ok: m.ok, error: m.error, product: m.product, channels: m.channels }
			for (const ch of m.channels) {
				const key = `mic:${m.ip}:${ch.id}`
				const sig = !m.ok ? 'away' : ch.link ? 'on' : 'off'
				const prev = this.prev.eq.get(key)
				if (prev !== undefined && prev !== sig && e?.active) this.event('audio', `${ch.name || ch.id} (${m.name}): ${sig === 'on' ? `transmitter on${ch.battery !== null ? ' · battery ' + ch.battery + ' %' : ''}${ch.rsqi !== null ? ' · RF ' + ch.rsqi + ' %' : ''}` : sig === 'off' ? 'transmitter off' : 'receiver stopped answering SSC'}`, { entity: { type: 'equipment', id: m.ip }, level: sig === 'away' ? 'warn' : 'info' })
				this.prev.eq.set(key, sig)
			}
		}
		const channels = mics.filter((m) => m.ok).flatMap((m) => m.channels)
		return { t: now, consoles, mics, others, switcher, summary: { consoles: consoles.length, consolesLive: consoles.filter((c) => c.ok).length, receivers: mics.length, receiversAnswering: mics.filter((m) => m.ok).length, channels: channels.length, onAir: channels.filter((c) => c.link).length } }
	}

	// show profiles: what a broadcast is expected to have running; the active one drives the health score
	setProfiles(list, activeId) {
		const clean = []
		const seen = new Set()
		for (const raw of Array.isArray(list) ? list : []) {
			const id = String(raw.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30) || `p${clean.length + 1}`
			if (seen.has(id)) continue
			seen.add(id)
			const name = String(raw.name || id).trim().slice(0, 50) || id
			const e = raw.expect || {}
			const p = { id, name, expect: { stream_out: !!e.stream_out, stream_in: !!e.stream_in, recording: !!e.recording, mics: !!e.mics, dante: !!e.dante, ndi: !!e.ndi } }
			if (Array.isArray(raw.roster)) p.roster = raw.roster.filter((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip))).slice(0, 200)
			clean.push(p)
		}
		if (!clean.length) clean.push(...PROFILE_DEFAULTS.map((p) => ({ ...p, expect: { ...p.expect } })))
		this.profiles = clean
		this.cfg.profiles = clean
		if (activeId && clean.some((p) => p.id === activeId)) this.activeProfile = activeId
		else if (!clean.some((p) => p.id === this.activeProfile)) this.activeProfile = clean[0].id
		this.cfg.active_profile = this.activeProfile
		if (this.rawDevices.length) {
			this.rebuild()
			this.emit('state', this.state)
		}
		return { profiles: this.profiles, active: this.activeProfile }
	}

	activateProfile(id, { applyRoster = false } = {}) {
		const p = this.profiles.find((x) => x.id === id)
		if (!p) return { error: 'unknown profile' }
		this.activeProfile = p.id
		this.cfg.active_profile = p.id
		this.event('health', `Show profile "${p.name}" is active`, { level: 'info' })
		let roster = null
		if (applyRoster && Array.isArray(p.roster)) {
			const set = new Set(p.roster)
			roster = this.setEquipment(this.cfg.equipment.map((e) => ({ ...e, active: set.has(e.ip) })))
		} else if (this.rawDevices.length) {
			this.rebuild()
			this.emit('state', this.state)
		}
		return { ok: true, active: p.id, roster }
	}

	// "test every probe" from the Prepare dialog: one round of TCP/OSC probes and REST reads for the active
	// roster, never a switcher hello (the switcher state comes from Companion or the held session)
	async testProbes() {
		await Promise.all([this.pollProbes().catch(() => {}), this.pollTelemetry().catch(() => {})])
		if (this.rawDevices.length) this.rebuild()
		return this.state.equipment
			.filter((e) => e.active && !e.discovered)
			.map((e) => ({ ip: e.ip, name: e.name, group: e.group, online: e.online, probe: e.probe ? { ok: e.probe.ok, ms: e.probe.ms, error: e.probe.error || null, state: e.probe.info?.state || null } : null, telemetry: e.telemetry ? { kind: e.telemetry.kind, error: e.telemetry.error || null, summary: e.telemetry.summary || e.telemetry.streaming?.state || null } : null, link: e.switch ? `${e.switch.name} p${e.switch.port} ${e.switch.speed}M` : e.online ? 'wifi' : null }))
	}

	// Stream intake detector: the ATEM's switch port counters say how much is flowing INTO the switcher.
	// A sustained rise above the quiet baseline = a stream is arriving. Sources are attributed from
	// (1) flows through the gateway, (2) encoder telemetry (ATEM Mini streaming URL, Web Presenter status),
	// (3) encoders whose outgoing rate rose by about the same amount at the same time.
	detectStream(eq, equipment, incoming, now) {
		const s = this.stream
		if (!eq || !eq.online) {
			s.state = 'idle'
			s.rate = 0
			return { ...s, intake: 0, sources: [], samples: undefined }
		}
		const intake = num(eq.down)
		const minRise = num(this.th.stream_min_mbps) || 1.5
		if (s.state === 'idle') {
			// baseline = slow average of quiet intake (control traffic, multiview previews, discovery)
			s.baseline = s.baseline ? s.baseline * 0.9 + Math.min(intake, s.baseline * 3 + 0.5) * 0.1 : intake
		}
		s.samples.push({ t: now, v: intake })
		if (s.samples.length > 12) s.samples.shift()
		const recent = s.samples.slice(-3).map((x) => x.v)
		// an encoder that says it is streaming to this ATEM is proof on its own (and beats the counters, which the
		// controller refreshes only when the switch informs it, every 30-90 s)
		const confirmed = equipment.find((e) => e.active && e.ip !== eq.ip && e.telemetry?.kind === 'atem' && e.telemetry.streaming?.state === 'streaming' && e.telemetry.streaming.host === eq.ip)
		const elevated = (recent.length >= 2 && recent.slice(-2).every((v) => v > s.baseline + minRise)) || !!confirmed
		const quiet = recent.length >= 3 && recent.every((v) => v <= s.baseline + minRise * 0.6) && !confirmed
		if (s.state === 'idle' && elevated) {
			s.state = 'arriving'
			s.since = now - 5000
			s.peak = intake
			s.rate = Math.max(0, intake - s.baseline) || (confirmed?.telemetry.streaming.bitrate ? confirmed.telemetry.streaming.bitrate / 1e6 : 0)
			this.event('stream', confirmed ? `${confirmed.name} started streaming to the ATEM (${confirmed.telemetry.streaming.url})` : `Stream arriving at the ATEM: ~${(intake - s.baseline).toFixed(1)} Mb/s`, { entity: { type: 'atem' }, level: 'info' })
		} else if (s.state === 'arriving' && quiet) {
			const mins = Math.round((now - s.since) / 60000)
			this.event('stream', `Stream into the ATEM stopped after ${mins < 1 ? '< 1 min' : mins + ' min'} (peak ${s.peak.toFixed(1)} Mb/s)`, { entity: { type: 'atem' }, level: 'warn' })
			s.state = 'idle'
			s.until = now
			s.rate = 0
		} else if (s.state === 'arriving') {
			s.rate = Math.max(0, intake - s.baseline) || (confirmed?.telemetry.streaming.bitrate ? confirmed.telemetry.streaming.bitrate / 1e6 : s.rate)
			s.peak = Math.max(s.peak, intake)
		}
		// attribute sources
		const sources = []
		// (a gateway flow counts as a source only when it carried real data: scanners knock on the forwarded ports all day)
		for (const f of incoming) if (now - f.last < 45000 && f.action !== 'blocked' && (f.bytes >= STREAM_HIT_BYTES || f.packets >= 200)) sources.push({ name: f.srcName || f.src, ip: f.src, confidence: 'confirmed', how: 'flow through the gateway', detail: `${f.proto} port ${f.dport}${f.service && f.service !== 'OTHER' ? ' ' + f.service : ''}${f.region ? ' from ' + f.region : ''}`, port: f.dport, proto: f.proto })
		for (const e of equipment) {
			if (!e.active || e.ip === eq.ip || !e.telemetry || e.telemetry.error) continue
			const tl = e.telemetry
			if (tl.kind === 'atem' && tl.streaming?.state === 'streaming') {
				const toUs = tl.streaming.host === eq.ip
				sources.push({ name: e.name, ip: e.ip, confidence: toUs ? 'confirmed' : 'possible', how: toUs ? 'its stream URL points at this ATEM' : 'it is streaming (destination ' + (tl.streaming.host || '?') + ')', detail: `${tl.streaming.protocol || 'rtmp'}${tl.streaming.port ? ' port ' + tl.streaming.port : ''}${tl.streaming.bitrate ? ' · ' + (tl.streaming.bitrate / 1e6).toFixed(1) + ' Mb/s' : ''}${tl.streaming.service ? ' · ' + tl.streaming.service : ''}`, rate: tl.streaming.bitrate ? tl.streaming.bitrate / 1e6 : null, port: tl.streaming.port, proto: (tl.streaming.protocol || 'rtmp').toUpperCase() })
			}
			if (tl.kind === 'webpresenter' && tl.streaming) {
				const br = tl.bitrate ? tl.bitrate / 1e6 : null
				const match = s.state === 'arriving' && br && Math.abs(br - s.rate) / br < 0.35
				sources.push({ name: e.name, ip: e.ip, confidence: match ? 'likely' : 'possible', how: match ? 'streaming at the same rate that is arriving' : 'it is streaming (destination unknown: the Web Presenter API does not tell)', detail: `${tl.status}${br ? ' · ' + br.toFixed(1) + ' Mb/s' : ''}${tl.format ? ' · ' + tl.format : ''}`, rate: br })
			}
		}
		// the mirror port sees the stream itself: RTMP publish or SRT data from a sender is proof
		for (const fl of this.state.forensics?.flows || []) {
			if (!fl.live || sources.some((x) => x.ip === fl.peer && x.confidence === 'confirmed')) continue
			if ((fl.app === 'RTMP' && (fl.state === 'streaming' || fl.state === 'publishing')) || (fl.app === 'SRT' && fl.state === 'streaming')) sources.push({ name: fl.name || fl.peer, ip: fl.peer, confidence: 'confirmed', how: 'seen on the mirror port', detail: `${fl.app} to port ${fl.targetPort}${fl.rtmp?.app ? ` · app '${fl.rtmp.app}'` : ''}${fl.rtmp?.publish ? ' · stream ' + fl.rtmp.publish : ''}${fl.srt?.latency ? ' · ' + fl.srt.latency + ' ms latency' : ''} · ${fl.inMbps} Mb/s`, rate: fl.inMbps, port: fl.targetPort, proto: fl.app })
		}
		if (s.state === 'arriving') {
			// correlation: an encoder whose outgoing rate is about the arriving rate
			for (const e of equipment) {
				if (!e.active || e.ip === eq.ip || sources.some((x) => x.ip === e.ip) || !e.online) continue
				if (!['encoder', 'switcher', 'computer'].includes(e.role)) continue
				const out = num(e.up)
				if (out >= 1 && Math.abs(out - s.rate) / Math.max(out, s.rate) < 0.3) sources.push({ name: e.name, ip: e.ip, confidence: 'possible', how: 'sending about the same rate at the same time', detail: `${out.toFixed(1)} Mb/s out via ${e.switch ? e.switch.name + ' port ' + e.switch.port : 'wifi'}`, rate: out })
			}
		}
		const rank = { confirmed: 0, likely: 1, possible: 2 }
		sources.sort((a, b) => rank[a.confidence] - rank[b.confidence])
		return { state: s.state, intake, baseline: Math.round(s.baseline * 10) / 10, rate: Math.round(s.rate * 10) / 10, peak: Math.round(s.peak * 10) / 10, since: s.since, until: s.until, sources, port: eq.switch ? { switch: eq.switch.name, port: eq.switch.port, speed: eq.switch.speed, age: eq.age } : null }
	}

	// Stream path check: one row per UDM port forward that points at broadcast gear. Did anything from the internet
	// hit that WAN port in the last hour (who, how much), is the target on the network, and for the switcher: did
	// its intake rise while packets were being forwarded? The classic failure on this network is a sender using
	// the HD8's default port 1935, which the UDM forwards to the field Mini (usually on standby) instead of WAN 1937.
	streamPaths(now, equipment, clientByIp) {
		const wanIp = this.state.gateway?.wan?.ip || null
		const atemIp = this.cfg.atem?.ip || null
		const forwards = this.portForwards || []
		const heroFwd = atemIp ? forwards.find((x) => x.to === atemIp) : null
		const paths = []
		for (const f of forwards) {
			const eq = equipment.find((e) => e.ip === f.to) || null
			if (!eq && !/atem|rtmp|srt|ndi|stream|hyperdeck|presenter|bridge|patchbay/i.test(f.name)) continue
			const hits = (this.forwardHits.get(f.name) || []).filter((h) => now - h.t < 3600000)
			const allowed = hits.filter((h) => h.action !== 'blocked')
			const blocked = hits.length - allowed.length
			// internet scanners knock on every open port all day (a few hundred bytes per flow); only flows that carry
			// data count as a stream attempt, the knocks are listed as probes
			const srcs = new Map()
			for (const h of allowed) {
				const s = srcs.get(h.src) || { ip: h.src, name: h.srcName || null, region: h.region || null, bytes: 0, flows: 0, last: 0, first: h.t, ports: new Set() }
				s.bytes += h.bytes
				s.flows++
				s.last = Math.max(s.last, h.t)
				s.first = Math.min(s.first, h.t)
				s.name = h.srcName || s.name
				s.ports.add(`${h.proto} ${h.wanPort}`)
				srcs.set(h.src, s)
			}
			const sources = [...srcs.values()].sort((a, b) => b.last - a.last).map((s) => ({ ...s, ports: [...s.ports], probe: s.bytes < STREAM_HIT_BYTES }))
			const senders = sources.filter((s) => !s.probe)
			const probes = sources.filter((s) => s.probe)
			const data = allowed.filter((h) => srcs.get(h.src)?.bytes >= STREAM_HIT_BYTES)
			const live = data.filter((h) => now - h.t < 120000)
			const c = clientByIp.get(f.to)
			const target = { ip: f.to, port: f.toPorts, name: eq?.name || c?._name || f.to, online: eq ? eq.online : !!c, standby: !!eq && !eq.active, isAtem: f.to === atemIp, equipment: !!eq, switch: eq?.switch ? `${eq.switch.name} port ${eq.switch.port}` : null }
			const st = this.stream
			const intake = target.isAtem ? { state: st.state, rate: Math.round(st.rate * 10) / 10, since: st.since, until: st.until } : null
			const srcTxt = senders[0] ? `${senders[0].name || senders[0].ip}${senders[0].region ? ' (' + senders[0].region + ')' : ''}` : 'an unknown sender'
			const last = data.reduce((n, h) => Math.max(n, h.t), 0)
			const probeTxt = probes.length ? `; ${probes.length} connection probe${probes.length === 1 ? '' : 's'} (${probes.reduce((n, s) => n + s.flows, 0)} tiny flows from ${probes.slice(0, 2).map((s) => s.ip).join(', ')}${probes.length > 2 ? '…' : ''}) ignored` : ''
			let status
			let verdict
			if (!data.length && !blocked) {
				status = 'idle'
				verdict = `no stream data from the internet on WAN port ${f.wanPorts} in the last hour${probeTxt}`
			} else if (!data.length) {
				status = blocked >= 3 ? 'red' : 'idle'
				verdict = `${blocked} connection${blocked === 1 ? '' : 's'} to WAN port ${f.wanPorts} blocked by the firewall in the last hour${probeTxt}`
			} else if (target.standby) {
				status = 'red'
				verdict = `${srcTxt} is sending to WAN port ${f.wanPorts}, which the gateway forwards to ${target.name} (on standby, not part of this broadcast)${heroFwd && heroFwd !== f ? `; the ${this.cfg.atem.name} listens on WAN port ${heroFwd.wanPorts}` : ''}`
			} else if (!target.online) {
				status = 'red'
				verdict = `${srcTxt} reached WAN port ${f.wanPorts} but UniFi does not list ${target.name} on the network`
			} else if (target.isAtem && live.length && st.state !== 'arriving') {
				status = 'amber'
				verdict = `packets from ${srcTxt} are being forwarded to the switcher but its intake has not risen: check the remote-source setup on the switcher (source enabled, stream key, format) and that the sender is really transmitting`
			} else if (live.length) {
				status = 'green'
				verdict = `live: ${srcTxt} → ${target.name}${intake?.state === 'arriving' ? ` · intake up ${intake.rate} Mb/s` : ''}`
			} else {
				status = 'ok'
				verdict = `last used ${Math.max(1, Math.round((now - last) / 60000))} min ago by ${srcTxt}`
			}
			const firstPort = String(f.wanPorts).split(/[,-]/)[0]
			paths.push({ id: f.name, name: f.name, proto: f.proto, wanIp, wanPorts: f.wanPorts, target, hits: { count: data.length, probes: probes.reduce((n, s) => n + s.flows, 0), blocked, live: live.length, bytes: data.reduce((n, h) => n + h.bytes, 0), last, sources: [...senders, ...probes].slice(0, 6) }, intake, status, verdict, url: wanIp ? `${/srt/i.test(f.name) ? 'srt' : 'rtmp'}://${wanIp}:${firstPort}` : null })
		}
		const order = { red: 0, amber: 1, green: 2, ok: 3, idle: 4 }
		paths.sort((a, b) => order[a.status] - order[b.status] || Number(b.target.isAtem) - Number(a.target.isAtem))
		return paths
	}

	buildTopology(gateway, switches, aps, others, equipment) {
		const nodes = []
		const links = []
		const seen = new Set()
		const add = (n) => {
			if (seen.has(n.id)) return
			seen.add(n.id)
			nodes.push(n)
		}
		add({ id: 'internet', kind: 'internet', name: gateway?.wan?.isp || 'Internet', status: gateway?.wan?.status === 'ok' ? 'online' : 'offline', depth: -1 })
		if (gateway) {
			add({ id: gateway.mac, kind: 'gateway', name: gateway.name, ip: gateway.ip, model: gateway.modelName, status: gateway.online ? 'online' : 'offline', depth: 0, cpu: gateway.cpu, temp: gateway.temp, rate: { in: gateway.wan.down, out: gateway.wan.up } })
			links.push({ from: 'internet', to: gateway.mac, speed: gateway.wan.speed, up: gateway.wan.status === 'ok', rate: { in: gateway.wan.down, out: gateway.wan.up }, kind: 'wan' })
		}
		const devs = [...switches, ...aps, ...others.filter((o) => o.kind === 'pdu')]
		for (const d of devs) {
			if (!d.online) continue
			add({ id: d.mac, kind: d.type === 'uap' ? 'ap' : d.kind === 'pdu' ? 'pdu' : 'switch', name: d.name, ip: d.ip, model: d.modelName, status: 'online', depth: d.depth ?? 1, cpu: d.cpu, temp: d.temp, portsUp: d.portsUp, portsTotal: d.portsTotal, rate: { in: d.totals.down, out: d.totals.up }, clients: d.clients, alerts: 0 })
			const parent = d.uplink.mac && seen.has(d.uplink.mac) ? d.uplink.mac : gateway?.mac
			if (parent) {
				// rate on the child's uplink port counters when we have them
				const upPort = d.ports.find((p) => p.idx === d.uplink.localPort)
				links.push({ from: parent, to: d.mac, fromPort: d.uplink.port, toPort: d.uplink.localPort, speed: d.uplink.speed, up: true, media: d.uplink.media, rate: upPort ? { in: upPort.tx, out: upPort.rx } : { in: d.uplink.down, out: d.uplink.up }, kind: d.uplink.media === 'wireless' ? 'mesh' : d.uplink.speed >= 10000 ? 'fiber' : 'copper' })
			}
		}
		for (const e of equipment) {
			if ((e.discovered && !e.online) || !e.active) continue
			add({ id: 'eq:' + e.ip, kind: 'equipment', name: e.name, ip: e.ip, role: e.role, group: e.group, status: e.status, hero: !!e.hero, depth: 9, rate: { in: e.down, out: e.up }, telemetry: e.telemetry ? { kind: e.telemetry.kind, summary: e.telemetry.summary || e.telemetry.streaming?.state || null, streaming: !!(e.telemetry.streaming === true || e.telemetry.streaming?.state === 'streaming'), recording: !!e.telemetry.recording } : null })
			if (e.switch && seen.has(e.switch.mac)) links.push({ from: e.switch.mac, to: 'eq:' + e.ip, fromPort: e.switch.port, speed: e.switch.speed, up: true, rate: { in: e.up, out: e.down }, kind: 'edge' })
		}
		return { nodes, links }
	}

	// replace the equipment roster at runtime (from the in-app editor); returns the cleaned list
	setEquipment(list) {
		const roles = ['switcher', 'router', 'recorder', 'encoder', 'computer', 'audio', 'unknown']
		const clean = []
		const seen = new Set()
		for (const raw of Array.isArray(list) ? list : []) {
			const ip = String(raw.ip || '').trim()
			const name = String(raw.name || '').trim()
			if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || !name || seen.has(ip)) continue
			seen.add(ip)
			const e = { active: raw.active !== false, name: name.slice(0, 60), ip, group: String(raw.group || 'Studio A').trim().slice(0, 40) || 'Studio A', role: roles.includes(raw.role) ? raw.role : 'unknown' }
			if (raw.probe && /^(tcp:\d{1,5}|atem(:\d{1,5})?|x32(:\d{1,5})?)$/.test(String(raw.probe))) e.probe = String(raw.probe)
			if (['webpresenter', 'hyperdeck', 'atem'].includes(raw.telemetry)) e.telemetry = raw.telemetry
			if (raw.min_speed !== undefined && raw.min_speed !== null && raw.min_speed !== '') e.min_speed = Number(raw.min_speed) || 0
			if (raw.hero) e.hero = true
			if (raw.companion && /^[\w-]{1,40}$/.test(String(raw.companion))) e.companion = String(raw.companion) // Companion connection label (read the switcher through Companion)
			clean.push(e)
		}
		if (!clean.some((e) => e.hero) && this.cfg.atem?.ip) {
			const hero = clean.find((e) => e.ip === this.cfg.atem.ip)
			if (hero) hero.hero = true
		}
		this.cfg.equipment = clean
		for (const ip of [...this.probes.keys()]) if (!clean.some((e) => e.ip === ip && e.active)) this.probes.delete(ip)
		for (const ip of [...this.telemetry.keys()]) if (!clean.some((e) => e.ip === ip && e.active)) this.telemetry.delete(ip)
		for (const [ip, c] of this.atems) if (!clean.some((e) => e.ip === ip && e.active && (e.telemetry === 'atem' || String(e.probe || '').startsWith('atem')))) {
			c.close()
			this.atems.delete(ip)
		}
		for (const e of clean) if (!e.active) this.prev.eq.delete(e.ip)
		this.syncAudioTargets()
		if (this.rawDevices.length) {
			this.rebuild()
			this.emit('state', this.state)
		}
		this.pollProbes().catch(() => {})
		this.pollTelemetry().catch(() => {})
		return clean
	}

	lastSeenByIp(ip) {
		const mac = this.ipToMac.get(ip)
		const ls = mac ? this.lastSeen.get(mac) : null
		return ls ? ls * 1000 : null
	}

	// a name for an address: the roster first, then what UniFi calls the client
	nameFor(ip) {
		if (!ip) return null
		const e = this.cfg.equipment.find((x) => x.ip === ip)
		if (e) return e.name
		const c = this.rawClients.find((x) => x.ip === ip)
		if (c) return this.aliases.get(lower(c.mac)) || c.name || c.hostname || null
		const mac = this.ipToMac.get(ip)
		return mac ? this.aliases.get(mac) || null : null
	}

	computeAlerts(now) {
		const a = []
		const st = this.state
		const push = (level, scope, kind, entity, text, explain) => {
			const id = `${scope}:${kind}:${entity?.id || entity?.type || scope}`
			if (!this.alertSince.has(id)) {
				this.alertSince.set(id, now)
				if (st.ts) this.event('alert', `${level === 'error' ? 'PROBLEM' : level === 'warn' ? 'Warning' : 'Note'}: ${text}`, { entity, level, alertId: id, scope, kind, explain })
			}
			a.push({ id, level, scope, kind, entity, text, explain, since: this.alertSince.get(id) })
		}
		for (const [k, v] of Object.entries(st.errors)) {
			const why = /HTTP 5\d\d/.test(v)
				? `The UniFi Network application on the gateway answers the ${k} request with an internal error. That is the controller software, not the network: switching and routing carry on, Broadwatch just cannot refresh ${k} and asks again every minute. It usually clears by itself within a few minutes. If it stays, restart the Network application (UniFi OS > Applications > Network) or the gateway at a quiet moment, and look at UniFi OS > System Log for the cause.`
				: /HTTP 40[13]/.test(v)
					? 'The gateway refused the API key. Make a new local API key under UniFi Network > Settings > Control Plane > Integrations and paste it into Settings > UniFi gateway.'
					: /timeout|ECONN|ENOTFOUND|EAI_AGAIN/i.test(v)
						? `The gateway did not answer in time. Check that this computer can reach ${this.cfg.gateway?.url || 'the gateway'} (the management VLAN, no firewall in between) and that the controller is not overloaded.`
						: 'Broadwatch cannot read this part of the UniFi API. Check that the gateway is reachable from this computer and that the API key is still valid (UniFi Network > Settings > Control Plane > Integrations).'
			push('error', 'api', 'poll', { type: 'api', id: k }, `UniFi ${k} poll failing: ${v}`, why)
		}
		const gw = st.gateway
		if (gw) {
			if (gw.wan.status !== 'ok') push('error', 'wan', 'status', { type: 'wan' }, `WAN ${gw.wan.status}`, 'The internet link on the gateway is not healthy. Outgoing streams (Web Presenters) and incoming remote streams from outside the building depend on it.')
			if (gw.wan.latency !== null && gw.wan.latency > this.th.wan_latency_ms) push('warn', 'wan', 'latency', { type: 'wan' }, `WAN latency ${gw.wan.latency} ms`, `The gateway's internet latency check is above ${this.th.wan_latency_ms} ms. Streams out of the building may buffer; remote contributors may see delay.`)
			if (gw.cpu !== null && gw.cpu > this.th.cpu_pct) push('warn', 'gateway', 'cpu', { type: 'gateway', id: gw.mac }, `${gw.name} CPU ${gw.cpu}%`, 'The gateway is busy. Deep packet inspection, IDS/IPS or a traffic burst can do this; routing between VLANs (Dante/NDI to the studio) slows down when it saturates.')
			if (gw.mem !== null && gw.mem > this.th.mem_pct) push('warn', 'gateway', 'mem', { type: 'gateway', id: gw.mac }, `${gw.name} memory ${gw.mem}%`, 'Gateway memory is nearly full; services may restart.')
			if (gw.temp !== null && gw.temp > this.th.temp_c) push('warn', 'gateway', 'temp', { type: 'gateway', id: gw.mac }, `${gw.name} ${gw.temp} °C`, 'The gateway is running hot. Check rack airflow and fans.')
		} else if (!st.errors.devices && st.updated.devices) push('error', 'gateway', 'missing', { type: 'gateway' }, 'Gateway not in the device list', 'The UniFi API answered but no gateway device was listed.')
		for (const s of st.switches) {
			if (!s.online) {
				if (s.lastSeen && now - s.lastSeen < 86400000) push('error', 'switch', 'offline', { type: 'switch', id: s.mac }, `${s.name} OFFLINE (last seen ${Math.round((now - s.lastSeen) / 60000)} min ago)`, `${s.name} (${s.modelName}) stopped talking to the controller. Everything plugged into it has lost its network path unless it only lost management. Check its power, its uplink${s.uplink.device ? ` (${s.uplink.device} port ${s.uplink.port})` : ''} and the fiber/copper link.`)
			} else {
				if (s.cpu !== null && s.cpu > this.th.cpu_pct) push('warn', 'switch', 'cpu', { type: 'switch', id: s.mac }, `${s.name} CPU ${s.cpu}%`, 'Switch CPU is high; usually a broadcast/multicast storm (Dante, NDI or mDNS flooding) or STP churn. Look for a port with runaway traffic.')
				if (s.overheating || (s.temp !== null && s.temp > this.th.temp_c)) push('warn', 'switch', 'temp', { type: 'switch', id: s.mac }, `${s.name} ${s.temp} °C`, 'The switch is hot. Check airflow, dust filters and that the fans run.')
				for (const p of s.ports) if (p.errorsRecent) push('warn', 'port', 'errors', { type: 'port', id: p.key }, `${s.name} port ${p.idx} errors/drops`, `Port ${p.idx} on ${s.name} has counted new errors or dropped packets in the last 10 minutes. On a video or Dante link that means glitches: suspect the cable, the SFP, a duplex mismatch or a device sending more than the link can carry.`)
				if (s.uplink.speed && s.uplink.speed < 1000 && s.uplink.media !== 'wireless') push('warn', 'switch', 'uplink', { type: 'switch', id: s.mac }, `${s.name} uplink at ${s.uplink.speed} Mb/s`, 'The uplink negotiated below gigabit; a bad cable or port. Everything behind this switch shares that slow link.')
			}
		}
		for (const e of st.equipment) {
			if (e.discovered || !e.active) continue
			const minSpeed = e.min_speed ?? (['switcher', 'encoder', 'recorder', 'computer'].includes(e.role) ? 1000 : 0)
			const ent = { type: 'equipment', id: e.ip }
			if (!e.online) push(e.hero ? 'error' : 'warn', 'equipment', 'offline', ent, `${e.name} not on the network`, `UniFi does not see ${e.name} (${e.ip}) on any switch port or access point${e.lastSeen ? `; it was last seen ${Math.round((now - e.lastSeen) / 60000)} min ago` : ''}. Powered off, unplugged, or its link is down.`)
			else if (e.reachable === false) push(e.hero ? 'error' : 'warn', 'equipment', 'unresponsive', ent, `${e.name} not answering (${e.probeSpec}: ${e.probe?.error || 'no reply'})`, `${e.name} is on the network but its control port does not answer. The device may be booting, frozen, or a firewall/VLAN rule is in the way. Control from Companion and ATEM/HyperDeck software will fail until it answers.`)
			else if (e.probe?.info?.state === 'too many clients') push('warn', 'equipment', 'clients', ent, `${e.name} refused Broadwatch's control connection (all slots taken)`, `The switcher answered "too many clients": every one of its few control slots is held by another program (Companion, ATEM Software Control, hardware panels, the NDI Machine ATEM bridge, another Broadwatch). Broadwatch holds none and backs off (2, 4, 8, then 15 min between attempts). A program that was closed keeps its slot for about two minutes. To stop knocking altogether, read the switcher through Companion (switcher inspector > Control connection > Companion).`)
			else if (e.switch?.speed && minSpeed && e.switch.speed < minSpeed) push('warn', 'equipment', 'speed', ent, `${e.name} linked at ${e.switch.speed} Mb/s`, `${e.name} negotiated ${e.switch.speed} Mb/s on ${e.switch.name} port ${e.switch.port}. Video streams and NDI need gigabit: check the cable and the port.`)
			if (e.telemetry && !e.telemetry.error) {
				const tl = e.telemetry
				if (tl.kind === 'webpresenter' && /interrupt|error|fail/i.test(tl.status)) push('error', 'stream', 'out', ent, `${e.name}: stream ${tl.status}`, 'The Web Presenter lost its connection to the streaming platform. Check the WAN, the stream key and the platform status.')
				if (tl.kind === 'atem' && tl.streaming?.state && tl.streaming.state !== 'idle' && tl.streaming.state !== 'streaming') push('warn', 'stream', 'state', ent, `${e.name}: stream ${tl.streaming.state}`, 'The ATEM Mini is between states (connecting/stopping); if this persists its stream destination is not reachable.')
			}
		}
		// audio: the consoles' meters and the wireless mics (battery, RF, mute, link) against what the show expects
		const expectMics = !!this.profiles.find((p) => p.id === this.activeProfile)?.expect?.mics
		const au = st.audio
		for (const c of au?.consoles || []) {
			const ent = { type: 'equipment', id: c.ip }
			if (c.online && !c.ok && c.answered) push('warn', 'audio', 'meters', ent, `${c.name} answers OSC but sends no meters`, 'The console replies to /xinfo but the meter subscription (/batchsubscribe to /meters/1 and /meters/2, renewed every 8 s) brings nothing back. A firewall between this computer and the console may drop the console’s replies, or the console’s subscription table is full of other apps. Restarting Broadwatch subscribes afresh.')
		}
		for (const m of au?.mics || []) {
			const ent = { type: 'equipment', id: m.ip }
			if (m.online && !m.ok) {
				if (m.seen) push('warn', 'audio', 'ssc', ent, `${m.name} stopped answering SSC (UDP 45)`, 'The receiver is on the network but no longer answers Sennheiser Sound Control requests. It may be rebooting, or its control port is blocked between this computer and the Dante VLAN.')
				continue
			}
			if (!m.ok) continue
			for (const ch of m.channels) {
				const who = `${ch.name || ch.id} (${m.name})`
				if (!ch.link) {
					if (expectMics) push('warn', 'audio', `link-${ch.id}`, ent, `${who}: transmitter off or out of range`, 'The receiver reports no link with its transmitter (SSC warning NoLink): the handheld or bodypack is switched off, its battery is flat, or it is out of range. The show profile expects the mics on air; fine if this one is a spare.')
					continue
				}
				if (ch.battery !== null && ch.battery < this.th.mic_battery_pct) push(ch.battery < 10 ? 'error' : 'warn', 'audio', `battery-${ch.id}`, ent, `${who}: battery ${ch.battery} %${ch.batteryMinutes ? ' · about ' + ch.batteryMinutes + ' min left' : ''}`, 'Change the battery at the next break. Below 10 % the transmitter can switch off mid-sentence.')
				if (ch.rsqi !== null && ch.rsqi < this.th.mic_rf_pct) push('warn', 'audio', `rf-${ch.id}`, ent, `${who}: RF weak (${ch.rsqi} %${ch.rssi !== null ? ', ' + ch.rssi + ' dBm' : ''})`, 'The receive signal quality is low: the transmitter is far from the antennas, something blocks the path, or another transmitter sits on a nearby frequency. Expect dropouts. Check the antennas and run a scan on the receiver.')
				if (expectMics && (ch.mute || ch.tx?.mute)) push('info', 'audio', `mute-${ch.id}`, ent, `${who} is muted${ch.tx?.mute ? ' at the transmitter' : ' at the receiver'}`, 'The show profile expects this mic on air but it is muted. Fine during a break; a problem once the talent speaks.')
				for (const w of ch.warningText || []) push('warn', 'audio', `warn-${ch.id}-${w.replace(/\W+/g, '')}`, ent, `${who}: ${w}`, `The receiver raises the warning "${w}" for this channel.`)
			}
		}
		const at = st.atem
		if (at?.equipment?.online && at.stream?.state === 'arriving' && at.stream.port?.speed && at.stream.port.speed < 1000) push('warn', 'stream', 'port', { type: 'atem' }, `Stream arriving over a ${at.stream.port.speed} Mb/s link`, 'The ATEM port is below gigabit while a stream is arriving.')
		for (const p of st.streamPaths || []) {
			const ent = { type: 'path', id: p.id }
			const recent = p.hits.last && now - p.hits.last < 600000 && p.hits.bytes >= 500000
			const heroFwd = (this.portForwards || []).find((x) => x.to === this.cfg.atem?.ip)
			if (p.status === 'red' && recent && p.target.standby) push('warn', 'stream', 'path', ent, `Remote stream sent to WAN port ${p.wanPorts}, which goes to ${p.target.name} (standby)`, `${p.verdict}. ${heroFwd ? `Senders for the ${this.cfg.atem.name} must use ${/srt/i.test(heroFwd.name) ? 'srt' : 'rtmp'}://${p.wanIp}:${String(heroFwd.wanPorts).split(/[,-]/)[0]}/…, or swap the two port forwards in UniFi (Settings > Routing > Port Forwarding).` : ''}`)
			else if (p.status === 'red' && recent && !p.target.online) push('warn', 'stream', 'path', ent, `Stream arriving for ${p.target.name}, which is not on the network`, `${p.verdict}. The gateway forwards the packets to ${p.target.ip} but nothing answers there: power, cable or the wrong forward target.`)
			else if (p.status === 'amber') push('warn', 'stream', 'path', ent, `Stream reaches the gateway on WAN port ${p.wanPorts} but the switcher's intake did not rise`, `${p.verdict}. If the switcher rejects the stream (wrong key, wrong format, source disabled) the bytes still land on its switch port but no picture appears; the remote source must also be switched to an input (Streaming 1/2 macros).`)
		}
		for (const o of st.others) if (o.kind === 'pdu' && o.online && o.outlets && o.outletsOn < o.outlets) push('info', 'power', 'outlets', { type: 'pdu', id: o.mac }, `${o.name}: ${o.outlets - o.outletsOn} outlet(s) switched off`, 'Some outlets on this PDU are off. Fine if intended.')
		// what the mirror port saw in the last ten minutes
		const fx = st.forensics
		if (fx?.running) {
			const recent = (fx.events || []).filter((e) => now - e.t < 600000)
			const rej = recent.find((e) => e.kind === 'reject')
			if (rej) push('warn', 'stream', 'rejected', { type: 'forensics', id: rej.peer || 'mirror' }, `The switcher turned a stream away: ${rej.text}`, 'Seen on the mirror port: the sender reached the switcher, and the switcher ended the connection or answered with an error. Usual causes: wrong stream key or application name, a video format the switcher does not accept, the remote source disabled on the switcher, or a second sender on the same key. The sender saw the same thing as a failed or dropped connection.')
			const ref = recent.find((e) => e.kind === 'refused')
			if (ref) push('warn', 'equipment', 'refused', { type: 'forensics', id: ref.peer || 'mirror' }, `Control connection refused: ${ref.text}`, `The switcher answered "too many clients". Sessions held right now: ${fx.sessions.filter((s) => s.state === 'held').map((s) => s.name || s.ip).join(', ') || 'none seen'}. Close one of those programs to make room; a closed one keeps its slot for about two minutes.`)
		} else if (fx && fx.enabled && !fx.running && fx.error && fx.available) push('info', 'capture', 'down', { type: 'forensics', id: 'mirror' }, `Mirror capture is not running: ${fx.error}`, 'tshark on the mirror interface stopped. Start it again from the Stream forensics section or check that the adapter is still plugged into the mirror port.')
		// clear memory of alerts that are gone
		const ids = new Set(a.map((x) => x.id))
		for (const [id, since] of this.alertSince) if (!ids.has(id)) {
			this.alertSince.delete(id)
			if (st.ts) this.event('clear', `Cleared: ${id.split(':').slice(0, 2).join(' ')} ${this.describeEntity(id)} (after ${Math.round((now - since) / 60000)} min)`, { level: 'info', alertId: id, scope: id.split(':')[0], kind: id.split(':')[1], duration: now - since })
		}
		const order = { error: 0, warn: 1, info: 2 }
		a.sort((x, y) => order[x.level] - order[y.level] || x.since - y.since)
		return a
	}

	describeEntity(alertId) {
		const id = alertId.split(':').slice(2).join(':')
		const e = this.state.equipment.find((x) => x.ip === id)
		if (e) return e.name
		const s = [...this.state.switches, this.state.gateway, ...this.state.aps].find((x) => x && x.mac === id)
		if (s) return s.name
		return id
	}

	// everything the inspector needs about one thing: the entity, related UniFi events, flows and Broadwatch events
	details(type, id) {
		const st = this.state
		let entity = null
		let names = []
		if (type === 'alert') {
			const alert = st.alerts.find((x) => x.id === id)
			if (!alert) return { error: 'alert not found (it may have cleared)' }
			const d = this.details(alert.entity?.type || alert.scope, alert.entity?.id)
			return { alert, ...d }
		}
		if (type === 'equipment') {
			entity = st.equipment.find((e) => e.ip === id) || null
			if (entity) names = [entity.name, entity.unifiName, entity.ip, entity.mac].filter(Boolean)
		} else if (type === 'switch' || type === 'ap' || type === 'gateway' || type === 'pdu') {
			entity = [...st.switches, ...st.aps, ...st.others, st.gateway].find((x) => x && x.mac === id) || (type === 'gateway' ? st.gateway : null)
			if (entity) names = [entity.name, entity.ip, entity.mac].filter(Boolean)
		} else if (type === 'port') {
			const cut = String(id).lastIndexOf(':') // "aa:bb:cc:dd:ee:ff:15" -> mac + port
			const mac = String(id).slice(0, cut)
			const idx = String(id).slice(cut + 1)
			const sw = [...st.switches, st.gateway].find((x) => x && x.mac === mac)
			const port = sw?.ports.find((p) => p.idx === Number(idx))
			entity = port ? { ...port, switch: { name: sw.name, mac: sw.mac, ip: sw.ip } } : null
			if (entity) names = [sw.name, ...port.clients.map((c) => c.name).filter(Boolean), ...port.clients.map((c) => c.ip).filter(Boolean), ...port.devices.map((d) => d.name)]
		} else if (type === 'atem') {
			entity = st.atem
			names = [st.atem?.name, st.atem?.ip, st.atem?.equipment?.unifiName].filter(Boolean)
		} else if (type === 'wan') {
			entity = st.gateway ? { ...st.gateway.wan, gateway: st.gateway.name } : null
			names = ['WAN', 'Internet', st.gateway?.name].filter(Boolean)
		} else if (type === 'path') {
			entity = (st.streamPaths || []).find((p) => p.id === id) || null
			if (entity) names = [entity.target.name, entity.target.ip, ...entity.hits.sources.map((s) => s.ip)].filter(Boolean)
		} else if (type === 'vlan') {
			const n = (st.networks || []).find((x) => x.name === id) || null
			entity = n ? { ...n, equipment: st.equipment.filter((e) => n.subnet && e.ip && sameNet(e.ip, n.subnet)).map((e) => ({ name: e.name, ip: e.ip, online: e.online, status: e.status, active: e.active })) } : null
			names = [id]
		} else if (type === 'health') {
			entity = st.health
			names = []
		} else if (type === 'forensics') {
			const fx = this.forensics ? this.forensics.snapshot({ flows: 80, events: 120 }) : null
			const peer = id && id !== 'mirror' ? id : null
			entity = fx ? { ...fx, peer, name: peer ? this.nameFor(peer) : null, flows: fx.flows.filter((f) => !peer || f.peer === peer), events: fx.events.filter((e) => !peer || e.peer === peer), session: peer ? fx.sessions.find((s) => s.ip === peer) || null : null } : null
			names = peer ? [peer, this.nameFor(peer)].filter(Boolean) : []
		} else if (type === 'api') {
			entity = { errors: st.errors, updated: st.updated }
		}
		const lc = names.map(lower).filter((n) => n.length > 2)
		const matches = (text) => {
			const t = lower(text)
			return lc.some((n) => t.includes(n))
		}
		const log = st.log.filter((l) => matches(l.title + ' ' + l.message + ' ' + (l.device || ''))).slice(0, 25)
		const ips = names.filter((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n))
		const flows = st.flows.recent.filter((f) => ips.includes(f.src) || ips.includes(f.dst)).slice(0, 25)
		const events = st.events.filter((ev) => (ev.entity && ev.entity.id === id) || matches(ev.text)).slice(0, 25)
		return { type, id, entity, log, flows, events, names }
	}
}

function safeHost(url) {
	try {
		return new URL(url).hostname
	} catch {
		return null
	}
}

function sameNet(ip, cidr) {
	const [net, bitsStr] = String(cidr).split('/')
	const bits = Number(bitsStr || 24)
	const toN = (s) => s.split('.').reduce((n, o) => ((n << 8) | (Number(o) & 255)) >>> 0, 0)
	if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip || '') || !/^\d+\.\d+\.\d+\.\d+$/.test(net || '')) return false
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
	return (toN(ip) & mask) === (toN(net) & mask)
}

// system-log records carry title_raw / message_raw with {PLACEHOLDERS} resolved from `parameters`
function normaliseLog(r) {
	if (!r || typeof r !== 'object') return null
	const params = r.parameters || {}
	const fill = (s) =>
		String(s || '').replace(/\{([A-Z_0-9]+)\}/g, (m, k) => {
			const p = params[k]
			if (p === undefined || p === null) return m
			if (typeof p !== 'object') return String(p)
			return p.name || p.hostname || p.ip || p.id || m
		})
	const t = r.timestamp || r.time
	const ts = typeof t === 'number' ? (t > 1e12 ? t : t * 1000) : t ? Date.parse(t) : Date.now()
	const ev = String(r.event || r.key || '')
	const sev = lower(r.severity)
	const bad = /DISCONNECT|LOST|DOWN|FAIL|OFFLINE|RESTART|ERROR|BLOCK|ROGUE|STP|LOOP|UPGRADE|ALERT|ISOLAT|OVERHEAT|POE/.test(ev)
	return {
		t: ts,
		category: r.category || r.type || '',
		event: ev,
		severity: /crit|high/.test(sev) ? 'error' : bad ? 'warn' : 'info',
		title: fill(r.title_raw || r.title).slice(0, 200),
		message: fill(r.message_raw || r.message).slice(0, 400),
		device: params.DEVICE?.name || params.CLIENT?.name || params.CLIENT?.hostname || null,
	}
}
