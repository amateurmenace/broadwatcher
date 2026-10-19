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
		this.th = { wan_latency_ms: 80, cpu_pct: 85, mem_pct: 90, temp_c: 70, stream_min_mbps: 1.5, ...(config.thresholds || {}) }
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
		}
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
		const every = (name, s, fn) => {
			const run = async () => {
				if (this.busy.has(name)) return
				this.busy.add(name)
				try {
					await fn()
					delete this.state.errors[name]
				} catch (e) {
					this.state.errors[name] = `${new Date().toLocaleTimeString()} ${e.message}`
					this.log(`[${name}] ${e.message}`)
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
		await Promise.all(
			items.map(async (e) => {
				try {
					let t = null
					if (e.telemetry === 'atem') {
						// one persistent session per switcher (one control slot), which doubles as the reachability probe
						let c = this.atems.get(e.ip)
						if (!c) {
							c = new AtemClient(e.ip, { log: this.log })
							this.atems.set(e.ip, c)
						}
						if (!c.listenerCount('connected')) {
							c.on('connected', () => this.event('device', `${e.name}: connected to the switcher (${c.data.product || 'ATEM'})`, { entity: { type: 'equipment', id: e.ip } }))
							c.on('disconnected', (err) => this.event('device', `${e.name}: switcher session lost (${err}); next attempt in 2 min`, { entity: { type: 'equipment', id: e.ip }, level: 'warn' }))
						}
						c.ensure()
						t = c.snapshot()
						const full = c.state === 'refused' && c.error === 'too many clients'
						const reachable = c.state === 'connected' || full
						this.probes.set(e.ip, this.settle(e.ip, { ok: reachable, ms: c.state === 'connected' ? 1 : 0, error: reachable ? undefined : c.error || 'connecting', info: { state: full ? 'too many clients' : c.state === 'connected' ? `connected · ${c.commands} updates` : c.state }, t: now }))
					} else t = await restTelemetry(e.telemetry, e.ip)
					if (t) this.telemetry.set(e.ip, { ...t, t: Date.now() })
					else this.telemetry.delete(e.ip)
				} catch (err) {
					this.telemetry.set(e.ip, { kind: e.telemetry, error: err.message, t: Date.now() })
				}
			}),
		)
		this.state.updated.telemetry = Date.now()
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
		await fetchDir('incoming', 4)
		await fetchDir('local', 3)
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
	ingestFlows(recs, now) {
		const atemIp = this.cfg.atem?.ip
		const eqIps = new Set(this.cfg.equipment.map((e) => e.ip))
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
			s = { key, src: rec.src, sport: rec.sport, srcName: rec.srcName, region: rec.srcRegion, zone: rec.srcZone, dport: rec.dport, proto: rec.proto, service: rec.service, app: rec.app, network: rec.network, action: rec.action, first: rec.t, last: 0, bytes: 0, packets: 0, flows: 0 }
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
					gateway.networks.push({ name: n.name, vlan: n.vlan ?? cfgN.vlan ?? null, subnet: n.ip_subnet || cfgN.ip_subnet || null, purpose: cfgN.purpose || null, clients: n.num_sta ?? netCounts[n.name] ?? 0, down, up, watched: (this.cfg.networks || []).includes(n.name), history: { down: nh.down.a, up: nh.up.a } })
				}
				gateway.networks.sort((a, b) => Number(b.watched) - Number(a.watched) || b.clients - a.clients)
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

		// ATEM hero + stream detection
		const atemCfg = this.cfg.atem
		if (atemCfg?.ip) {
			const eq = equipment.find((e) => e.ip === atemCfg.ip)
			const incoming = [...this.incoming.values()].sort((a, b) => b.last - a.last)
			this.state.atem = {
				...atemCfg,
				equipment: eq || null,
				incoming: incoming.map((s) => ({ ...s, live: now - s.last < 45000, ageS: Math.round((now - s.last) / 1000) })),
				liveCount: incoming.filter((s) => now - s.last < 45000).length,
				stream: this.detectStream(eq, equipment, incoming, now),
			}
		}

		this.state.topology = this.buildTopology(gateway, switches, aps, others, equipment)
		this.state.alerts = this.computeAlerts(now)
		this.state.ts = now
		this.state.ok = Object.keys(this.state.errors).length === 0
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
		for (const f of incoming) if (now - f.last < 45000 && f.action !== 'blocked') sources.push({ name: f.srcName || f.src, ip: f.src, confidence: 'confirmed', how: 'flow through the gateway', detail: `${f.proto} port ${f.dport}${f.service && f.service !== 'OTHER' ? ' ' + f.service : ''}${f.region ? ' from ' + f.region : ''}`, port: f.dport, proto: f.proto })
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

	computeAlerts(now) {
		const a = []
		const st = this.state
		const push = (level, scope, kind, entity, text, explain) => {
			const id = `${scope}:${kind}:${entity?.id || entity?.type || scope}`
			if (!this.alertSince.has(id)) {
				this.alertSince.set(id, now)
				if (st.ts) this.event('alert', `${level === 'error' ? 'PROBLEM' : level === 'warn' ? 'Warning' : 'Note'}: ${text}`, { entity, level, alertId: id })
			}
			a.push({ id, level, scope, kind, entity, text, explain, since: this.alertSince.get(id) })
		}
		for (const [k, v] of Object.entries(st.errors)) push('error', 'api', 'poll', { type: 'api', id: k }, `UniFi ${k} poll failing: ${v}`, 'Broadwatcher cannot read this part of the UniFi API. Check that the gateway is reachable from this computer and that the API key is still valid (UniFi Network > Settings > Control Plane > Integrations).')
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
			else if (e.probe?.info?.state === 'too many clients') push('warn', 'equipment', 'clients', ent, `${e.name} has no free control connection (too many clients)`, 'Every control-connection slot of the ATEM is taken (ATEM Software Control, Companion, panels, Broadwatcher probes). Another controller will fail to connect until one disconnects. Close unused ATEM Software Control windows.')
			else if (e.switch?.speed && minSpeed && e.switch.speed < minSpeed) push('warn', 'equipment', 'speed', ent, `${e.name} linked at ${e.switch.speed} Mb/s`, `${e.name} negotiated ${e.switch.speed} Mb/s on ${e.switch.name} port ${e.switch.port}. Video streams and NDI need gigabit: check the cable and the port.`)
			if (e.telemetry && !e.telemetry.error) {
				const tl = e.telemetry
				if (tl.kind === 'webpresenter' && /interrupt|error|fail/i.test(tl.status)) push('error', 'stream', 'out', ent, `${e.name}: stream ${tl.status}`, 'The Web Presenter lost its connection to the streaming platform. Check the WAN, the stream key and the platform status.')
				if (tl.kind === 'atem' && tl.streaming?.state && tl.streaming.state !== 'idle' && tl.streaming.state !== 'streaming') push('warn', 'stream', 'state', ent, `${e.name}: stream ${tl.streaming.state}`, 'The ATEM Mini is between states (connecting/stopping); if this persists its stream destination is not reachable.')
			}
		}
		const at = st.atem
		if (at?.equipment?.online && at.stream?.state === 'arriving' && at.stream.port?.speed && at.stream.port.speed < 1000) push('warn', 'stream', 'port', { type: 'atem' }, `Stream arriving over a ${at.stream.port.speed} Mb/s link`, 'The ATEM port is below gigabit while a stream is arriving.')
		for (const o of st.others) if (o.kind === 'pdu' && o.online && o.outlets && o.outletsOn < o.outlets) push('info', 'power', 'outlets', { type: 'pdu', id: o.mac }, `${o.name}: ${o.outlets - o.outletsOn} outlet(s) switched off`, 'Some outlets on this PDU are off. Fine if intended.')
		// clear memory of alerts that are gone
		const ids = new Set(a.map((x) => x.id))
		for (const [id, since] of this.alertSince) if (!ids.has(id)) {
			this.alertSince.delete(id)
			if (st.ts) this.event('clear', `Cleared: ${id.split(':').slice(0, 2).join(' ')} ${this.describeEntity(id)} (after ${Math.round((now - since) / 60000)} min)`, { level: 'info', alertId: id })
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

	// everything the inspector needs about one thing: the entity, related UniFi events, flows and Broadwatcher events
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
