// Sennheiser EW-DX receivers over SSC (Sennheiser Sound Control): JSON over UDP port 45, the open protocol
// of the EW-DX / EW-D / Digital 6000 range. A request is a JSON tree with null leaves; the receiver answers
// with the same tree filled in, or {"osc":{"error":[...]}} with an HTTP-like code per address (404 = no such
// address, 424 = "failed dependency": the transmitter the value belongs to is not linked right now).
//
// Verified on BIG's three EW-DX EM 2 Dante receivers (product EWDX2CHD, firmware 2.0.1) on 2026-10-19:
//   {"device":{"name":null,"identity":{"product":null,"version":null,"serial":null}}}
//   {"rx1":{"name":null,"frequency":null,"gain":null,"mute":null,"warnings":null}}   frequency in kHz,
//        warnings e.g. ["NoLink"] when the transmitter is off; rx2 likewise (rx3/rx4 on an EM 4)
//   {"mates":{"tx1":{"name":null,"type":null,"mute":null,"warnings":null,"battery":{"gauge":null,"lifetime":null,"type":null}}}}
//        the linked transmitter: battery gauge in %, lifetime in minutes; 424 for every field while unlinked
//   {"m":{"rx1":{"af":null,"rsqi":null,"rssi":null,"divi":null}}}   af in dBFS (-138.5 = nothing), rsqi =
//        receive signal quality 0-100 %, rssi in dBm, divi = antenna in use (0 none, 1 A, 2 B)
//   {"osc":{"state":{"subscribe":[{"#":{"min":..,"max":..,"count":..,"lifetime":..},"m":{"rx1":{"af":null}}}]}}}
//        a subscription: the receiver echoes it, then pushes {"m":{"rx1":{"af":-20.5}}} messages (one value per
//        message) at its own pace (it clamps the interval to ~480 ms) until the lifetime runs out.
// Everything slow (names, frequency, mute, warnings, battery) is polled every 5 s; the meters are subscribed
// and renewed every 10 s, with the 5 s poll as the fallback for firmware that does not push.
import dgram from 'node:dgram'
import { EventEmitter } from 'node:events'

export const SSC_PORT = 45
const POLL_MS = 5000
const META_MS = 60000
const SUB_RENEW_MS = 10000
const SUB_LIFETIME_S = 12
const DEAD_MS = 15000 // no answer for this long = not answering
const METER_PROPS = { af: null, rsqi: null, rssi: null, divi: null }
const RX_PROPS = { name: null, frequency: null, gain: null, mute: null, warnings: null }
const TX_PROPS = { name: null, type: null, mute: null, warnings: null, battery: { gauge: null, lifetime: null, type: null } }

// "NoLink" -> "no link", "LowBattery" -> "low battery", "AFPeak" -> "AF peak"
export const prettyWarning = (w) =>
	String(w || '')
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.split(' ')
		.map((p) => (/^(AF|RF|LD|RSQI|RSSI)$/i.test(p) ? p.toUpperCase() : p.toLowerCase()))
		.join(' ')

function newChannel(id) {
	return { id, n: Number(id.replace(/\D/g, '')) || 1, name: '', frequency: null, gain: null, mute: null, warnings: null, af: null, rsqi: null, rssi: null, divi: null, lastMeter: 0, lastInfo: 0, tx: null, txAt: 0, txMissingAt: 0 }
}

export class SscMonitor extends EventEmitter {
	constructor({ log = () => {} } = {}) {
		super()
		this.log = log
		this.sock = null
		this.receivers = new Map() // ip -> record
		this.timer = null
		this.version = 0 // bumps on every meter value (the collector sends updates only when this moved)
		this.stopped = true
	}

	// the roster says which receivers to read: [{ip, name, port}]
	setReceivers(list) {
		const keep = new Set()
		for (const d of list || []) {
			if (!d?.ip) continue
			keep.add(d.ip)
			let r = this.receivers.get(d.ip)
			if (!r) {
				r = { ip: d.ip, port: Number(d.port) || SSC_PORT, name: d.name || d.ip, device: null, rxCount: 2, channels: new Map(), lastRx: 0, lastPoll: 0, lastMeta: 0, lastSub: 0, subscribed: false, msgs: 0, errors: 0 }
				for (let i = 1; i <= r.rxCount; i++) r.channels.set('rx' + i, newChannel('rx' + i))
				this.receivers.set(d.ip, r)
				if (!this.stopped) this.poll(r, true)
			} else {
				r.name = d.name || r.name
				r.port = Number(d.port) || r.port
			}
		}
		for (const ip of [...this.receivers.keys()]) if (!keep.has(ip)) this.receivers.delete(ip)
	}

	start() {
		if (!this.stopped) return
		this.stopped = false
		const sock = (this.sock = dgram.createSocket('udp4'))
		sock.on('error', (e) => this.log('[ssc] socket ' + (e.code || e.message)))
		sock.on('message', (msg, rinfo) => this.onMessage(msg, rinfo))
		sock.bind(0, () => {
			for (const r of this.receivers.values()) this.poll(r, true)
		})
		this.timer = setInterval(() => this.tick(), 1000)
	}

	stop() {
		this.stopped = true
		if (this.timer) clearInterval(this.timer)
		this.timer = null
		if (this.sock) {
			try {
				this.sock.close()
			} catch {}
		}
		this.sock = null
	}

	send(r, obj) {
		if (!this.sock) return
		this.sock.send(Buffer.from(JSON.stringify(obj)), r.port, r.ip, () => {})
	}

	rxIds(r) {
		return [...r.channels.keys()]
	}

	poll(r, withMeta = false) {
		const now = Date.now()
		r.lastPoll = now
		if (withMeta || now - r.lastMeta >= META_MS) {
			r.lastMeta = now
			this.send(r, { device: { name: null, identity: { product: null, version: null, serial: null } } })
		}
		const ids = this.rxIds(r)
		this.send(r, Object.fromEntries(ids.map((id) => [id, { ...RX_PROPS }])))
		this.send(r, { mates: Object.fromEntries(ids.map((id) => ['tx' + id.slice(2), JSON.parse(JSON.stringify(TX_PROPS))])) })
		this.send(r, { m: Object.fromEntries(ids.map((id) => [id, { ...METER_PROPS }])) })
	}

	subscribe(r) {
		r.lastSub = Date.now()
		const ids = this.rxIds(r)
		this.send(r, { osc: { state: { subscribe: [{ '#': { min: 250, max: 1000, count: 100, lifetime: SUB_LIFETIME_S }, m: Object.fromEntries(ids.map((id) => [id, { af: null, rsqi: null, rssi: null }])) }] } } })
	}

	tick() {
		const now = Date.now()
		for (const r of this.receivers.values()) {
			if (now - r.lastPoll >= POLL_MS) this.poll(r)
			// only a receiver that answers gets subscriptions (a silent address would just be spammed)
			if (now - r.lastRx < DEAD_MS && now - r.lastSub >= SUB_RENEW_MS) this.subscribe(r)
		}
	}

	onMessage(msg, rinfo) {
		const r = this.receivers.get(rinfo.address)
		if (!r) return
		let j
		try {
			j = JSON.parse(msg.toString('utf8'))
		} catch {
			return
		}
		if (!j || typeof j !== 'object') return
		const now = Date.now()
		r.lastRx = now
		r.msgs++
		if (j.osc) {
			if (Array.isArray(j.osc.error)) for (const e of j.osc.error) this.applyError(r, e, now)
			if (j.osc.state?.subscribe) r.subscribed = true
			return
		}
		if (j.device && typeof j.device === 'object') {
			const d = j.device
			r.device = { ...(r.device || {}), ...(d.name !== undefined ? { name: d.name } : {}), ...(d.identity?.product !== undefined ? { product: d.identity.product } : {}), ...(d.identity?.version !== undefined ? { version: d.identity.version } : {}), ...(d.identity?.serial !== undefined ? { serial: d.identity.serial } : {}) }
			// an EM 4 has rx1..rx4; the product name says so ("EWDX4CH…")
			const want = /4CH/i.test(String(r.device.product || '')) ? 4 : 2
			if (want !== r.rxCount) {
				r.rxCount = want
				for (let i = 1; i <= want; i++) if (!r.channels.has('rx' + i)) r.channels.set('rx' + i, newChannel('rx' + i))
				for (const id of [...r.channels.keys()]) if (Number(id.slice(2)) > want) r.channels.delete(id)
			}
		}
		for (const [k, v] of Object.entries(j)) {
			if (!/^rx\d$/.test(k) || !v || typeof v !== 'object') continue
			const ch = r.channels.get(k) || newChannel(k)
			r.channels.set(k, ch)
			if (v.name !== undefined) ch.name = String(v.name ?? '').trim()
			if (v.frequency !== undefined) ch.frequency = Number.isFinite(Number(v.frequency)) ? Number(v.frequency) : null
			if (v.gain !== undefined) ch.gain = Number.isFinite(Number(v.gain)) ? Number(v.gain) : null
			if (v.mute !== undefined) ch.mute = v.mute === true
			if (v.warnings !== undefined) ch.warnings = Array.isArray(v.warnings) ? v.warnings.map(String) : []
			ch.lastInfo = now
		}
		if (j.mates && typeof j.mates === 'object') {
			for (const [k, v] of Object.entries(j.mates)) {
				const m = k.match(/^tx(\d)$/)
				if (!m || !v || typeof v !== 'object') continue
				const ch = r.channels.get('rx' + m[1])
				if (!ch) continue
				const tx = ch.tx || { name: '', type: null, mute: null, warnings: null, battery: { gauge: null, lifetime: null, type: null } }
				if (v.name !== undefined) tx.name = String(v.name ?? '').trim()
				if (v.type !== undefined) tx.type = v.type
				if (v.mute !== undefined) tx.mute = v.mute === true
				if (v.warnings !== undefined) tx.warnings = Array.isArray(v.warnings) ? v.warnings.map(String) : []
				if (v.battery && typeof v.battery === 'object') {
					if (v.battery.gauge !== undefined) tx.battery.gauge = Number.isFinite(Number(v.battery.gauge)) ? Number(v.battery.gauge) : null
					if (v.battery.lifetime !== undefined) tx.battery.lifetime = Number.isFinite(Number(v.battery.lifetime)) ? Number(v.battery.lifetime) : null
					if (v.battery.type !== undefined) tx.battery.type = v.battery.type
				}
				ch.tx = tx
				ch.txAt = now
			}
		}
		if (j.m && typeof j.m === 'object') {
			let moved = false
			for (const [k, v] of Object.entries(j.m)) {
				const ch = r.channels.get(k)
				if (!ch || !v || typeof v !== 'object') continue
				for (const p of ['af', 'rsqi', 'rssi', 'divi']) {
					if (v[p] === undefined) continue
					const n = Number(v[p])
					ch[p] = Number.isFinite(n) ? n : null
					moved = true
				}
				ch.lastMeter = now
			}
			if (moved) this.version++
		}
	}

	// {"rx1":{"battery":[404,{...}]}} / {"mates":{"tx1":{"mute":[424,{...}]}}}: walk to the leaves
	applyError(r, tree, now, path = []) {
		if (Array.isArray(tree)) {
			const code = Number(tree[0])
			if (path[0] === 'mates' && /^tx\d$/.test(path[1] || '') && code === 424) {
				const ch = r.channels.get('rx' + path[1].slice(2))
				if (ch) {
					ch.tx = null
					ch.txMissingAt = now
				}
			} else if (/^rx\d$/.test(path[0] || '') && path.length === 1 && code === 404) r.channels.delete(path[0])
			else if (!(path[0] === 'm' && code === 404)) r.errors++
			return
		}
		if (tree && typeof tree === 'object') for (const [k, v] of Object.entries(tree)) this.applyError(r, v, now, [...path, k])
	}

	snapshot() {
		const now = Date.now()
		return [...this.receivers.values()].map((r) => {
			const ok = now - r.lastRx < DEAD_MS
			const channels = [...r.channels.values()]
				.sort((a, b) => a.n - b.n)
				.map((ch) => {
					const warnings = ch.warnings || []
					const link = ch.warnings ? !warnings.includes('NoLink') : !!ch.tx
					const tx = ch.tx
					return {
						id: ch.id,
						n: ch.n,
						name: ch.name,
						frequency: ch.frequency !== null ? Math.round(ch.frequency) / 1000 : null, // MHz
						gain: ch.gain,
						mute: ch.mute,
						warnings,
						warningText: warnings.filter((w) => w !== 'NoLink').map(prettyWarning),
						link,
						af: link && ch.af !== null ? Math.round(ch.af * 10) / 10 : null,
						rsqi: link ? ch.rsqi : null,
						rssi: link && ch.rssi !== null ? Math.round(ch.rssi) : null,
						antenna: ch.divi === 1 ? 'A' : ch.divi === 2 ? 'B' : null,
						battery: link && tx?.battery?.gauge !== null && tx?.battery?.gauge !== undefined ? tx.battery.gauge : null,
						batteryMinutes: link && tx?.battery?.lifetime ? tx.battery.lifetime : null,
						batteryType: link ? tx?.battery?.type || null : null,
						tx: link && tx ? { name: tx.name, type: tx.type, mute: tx.mute, warnings: (tx.warnings || []).map(prettyWarning) } : null,
						meterAge: ch.lastMeter ? Math.round((now - ch.lastMeter) / 1000) : null,
					}
				})
			return {
				ip: r.ip,
				name: r.name,
				product: r.device?.product || null,
				device: r.device,
				ok,
				seen: r.lastRx > 0,
				subscribed: ok && r.subscribed,
				age: r.lastRx ? Math.round((now - r.lastRx) / 1000) : null,
				error: ok ? null : r.lastRx ? `no answer for ${Math.round((now - r.lastRx) / 1000)} s` : 'no answer on UDP 45 (SSC)',
				channels,
			}
		})
	}

	// the compact form for the "meters" event: per receiver channel [af, rsqi, rssi, link]
	compact() {
		const now = Date.now()
		const out = {}
		for (const r of this.receivers.values()) {
			if (now - r.lastRx >= DEAD_MS) continue
			const o = {}
			for (const ch of r.channels.values()) {
				const link = ch.warnings ? !ch.warnings.includes('NoLink') : !!ch.tx
				o[ch.id] = [link && ch.af !== null ? Math.round(ch.af * 10) / 10 : null, link ? ch.rsqi : null, link && ch.rssi !== null ? Math.round(ch.rssi) : null, link ? 1 : 0]
			}
			out[r.ip] = o
		}
		return out
	}
}
