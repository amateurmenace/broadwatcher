// Live meters from Behringer X32 / Midas M32 consoles over OSC (UDP 10023), the open protocol every X32 app uses.
//
// The console streams meter blobs to whoever asks: "/batchsubscribe ,ssiii <alias> <path> 0 0 <timefactor>"
// makes it send "<alias> ,b <blob>" every 50 ms × timefactor for ten seconds; "/renew ,s <alias>" keeps it going.
// The blob is an int32 count followed by that many float32 values, both LITTLE-endian (the one place the X32
// breaks OSC's big-endian rule). A value is linear amplitude: 1.0 = 0 dBFS, dB = 20·log10(v).
//
// Verified on BIG's consoles (X32 Compact 4.09, X32 Rack 4.06) on 2026-10-19:
//   /meters/1 → 96 floats: 32 input channels (pre-fader), then 32 gate keys and 32 dynamics gain reductions
//   /meters/2 → 49 floats: 16 mix buses, 6 matrices, main L, main R, mono/centre, then 24 gain reductions
//   the console answers at the alias given, /renew works per alias, ten updates a second with timefactor 2.
// Names come from /ch/NN/config/name, /bus/NN/config/name, /mtx/NN/config/name, /main/st|m/config/name; mute
// state from /ch/NN/mix/on and /bus/NN/mix/on (1 = on, 0 = muted). One UDP socket serves every console; the
// replies are told apart by the sender's address. Levels are peak-held for 1.5 s and then fall 12 dB/s.
import dgram from 'node:dgram'
import { EventEmitter } from 'node:events'

export const X32_PORT = 10023
const TIMEFACTOR = 2 // 50 ms × 2 = ten meter blobs a second
const RENEW_MS = 8000 // the console forgets a subscription after 10 s
const NAMES_MS = 60000
const META_MS = 60000
const DEAD_MS = 3000 // no blob for this long = the subscription is gone, ask again
const HOLD_MS = 1500
const DECAY_DB_S = 12
const FLOOR_DB = -90 // below this a channel is "silent" (the console's own floor is -128)
const CLIP_DB = -0.5
const CLIP_HOLD_MS = 2000
const SIGNAL_DB = -60 // above this a channel counts as carrying signal (the console floor and mic noise sit near -80)

const LAYOUT = {
	'/meters/1': [{ key: 'channels', at: 0, n: 32 }],
	'/meters/2': [
		{ key: 'buses', at: 0, n: 16 },
		{ key: 'matrix', at: 16, n: 6 },
		{ key: 'main', at: 22, n: 3 },
	],
}
const GROUP_LABEL = { channels: 'Ch', buses: 'Bus', matrix: 'Mtx', main: 'Main' }
const MAIN_NAMES = ['Main L', 'Main R', 'Mono']

// ---------------------------------------------------------------- OSC encoding (big-endian, 4-byte padded)
const pad4 = (b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)])
export const oscString = (s) => pad4(Buffer.from(String(s) + '\0', 'utf8'))
export const oscInt = (n) => {
	const b = Buffer.alloc(4)
	b.writeInt32BE(n | 0)
	return b
}
export const oscMessage = (addr, tags = '', ...args) => Buffer.concat([oscString(addr), oscString(',' + tags), ...args])

// one OSC message → { addr, tags, args } with s / i / f / b decoded (anything else stops the walk)
export function parseOsc(buf) {
	const readStr = (i) => {
		const z = buf.indexOf(0, i)
		if (z < 0) return null
		const s = buf.toString('utf8', i, z)
		let next = z + 1
		next += (4 - (next % 4)) % 4
		return { s, next }
	}
	const a = readStr(0)
	if (!a) return null
	const addr = a.s
	let i = a.next
	let tags = ''
	if (i < buf.length && buf[i] === 0x2c) {
		const t = readStr(i)
		if (!t) return { addr, tags: '', args: [] }
		tags = t.s.slice(1)
		i = t.next
	}
	const args = []
	for (const tag of tags) {
		if (tag === 's') {
			const r = readStr(i)
			if (!r) break
			args.push(r.s)
			i = r.next
		} else if (tag === 'i') {
			if (i + 4 > buf.length) break
			args.push(buf.readInt32BE(i))
			i += 4
		} else if (tag === 'f') {
			if (i + 4 > buf.length) break
			args.push(buf.readFloatBE(i))
			i += 4
		} else if (tag === 'b') {
			if (i + 4 > buf.length) break
			const n = buf.readInt32BE(i)
			args.push(buf.subarray(i + 4, i + 4 + n))
			i += 4 + n
			i += (4 - (i % 4)) % 4
		} else break
	}
	return { addr, tags, args }
}

// an X32 meter blob → array of floats (little-endian count + little-endian floats)
export function meterFloats(blob) {
	if (!blob || blob.length < 4) return []
	const n = Math.min(blob.readInt32LE(0), (blob.length - 4) / 4)
	const out = new Array(Math.max(0, n))
	for (let k = 0; k < n; k++) out[k] = blob.readFloatLE(4 + k * 4)
	return out
}
const toDb = (v) => (v > 0 ? Math.max(-128, 20 * Math.log10(v)) : -128)
const r1 = (x) => Math.round(x * 10) / 10

function newMeter() {
	return { level: -128, peak: -128, peakAt: 0, clipAt: 0 }
}
function newGroup(n, names) {
	return { meters: Array.from({ length: n }, newMeter), names: Array.from({ length: n }, (_, i) => names?.[i] ?? ''), on: Array.from({ length: n }, () => null) }
}

export class X32Meters extends EventEmitter {
	constructor({ log = () => {} } = {}) {
		super()
		this.log = log
		this.sock = null
		this.consoles = new Map() // ip -> record
		this.timer = null
		this.version = 0 // bumps on every decoded meter blob (the collector sends updates only when this moved)
		this.stopped = true
	}

	// the roster says which consoles to watch: [{ip, name, port}]
	setConsoles(list) {
		const keep = new Set()
		for (const c of list || []) {
			if (!c?.ip) continue
			keep.add(c.ip)
			let r = this.consoles.get(c.ip)
			if (!r) {
				r = {
					ip: c.ip,
					port: Number(c.port) || X32_PORT,
					name: c.name || c.ip,
					info: null,
					lastMeter: 0,
					lastBlob: { '/meters/1': 0, '/meters/2': 0 },
					lastSubscribe: 0,
					lastRenew: 0,
					lastNames: 0,
					lastInfo: 0,
					lastAnswer: 0,
					blobs: 0,
					since: 0,
					groups: { channels: newGroup(32), buses: newGroup(16), matrix: newGroup(6), main: newGroup(3, MAIN_NAMES) },
					rate: { n: 0, t: 0, value: 0 },
				}
				this.consoles.set(c.ip, r)
				if (!this.stopped) this.subscribe(r, true)
			} else {
				r.name = c.name || r.name
				r.port = Number(c.port) || r.port
			}
		}
		for (const ip of [...this.consoles.keys()]) if (!keep.has(ip)) this.consoles.delete(ip)
	}

	start() {
		if (!this.stopped) return
		this.stopped = false
		const sock = (this.sock = dgram.createSocket('udp4'))
		sock.on('error', (e) => this.log('[x32] socket ' + (e.code || e.message)))
		sock.on('message', (msg, rinfo) => this.onMessage(msg, rinfo))
		sock.bind(0, () => {
			for (const r of this.consoles.values()) this.subscribe(r, true)
		})
		this.timer = setInterval(() => this.tick(), 1000)
	}

	// unsubscribing is not needed: the console forgets us after ten seconds of silence
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

	send(r, buf) {
		if (!this.sock) return
		this.sock.send(buf, r.port, r.ip, () => {})
	}

	subscribe(r, withNames = false) {
		const now = Date.now()
		r.lastSubscribe = now
		r.lastRenew = now
		for (const path of Object.keys(LAYOUT)) this.send(r, oscMessage('/batchsubscribe', 'ssiii', oscString(path), oscString(path), oscInt(0), oscInt(0), oscInt(TIMEFACTOR)))
		if (withNames) {
			this.askInfo(r)
			this.askNames(r)
		}
	}

	askInfo(r) {
		r.lastInfo = Date.now()
		this.send(r, oscMessage('/xinfo'))
	}

	askNames(r) {
		r.lastNames = Date.now()
		const two = (i) => String(i + 1).padStart(2, '0')
		for (let i = 0; i < 32; i++) {
			this.send(r, oscMessage(`/ch/${two(i)}/config/name`))
			this.send(r, oscMessage(`/ch/${two(i)}/mix/on`))
		}
		for (let i = 0; i < 16; i++) {
			this.send(r, oscMessage(`/bus/${two(i)}/config/name`))
			this.send(r, oscMessage(`/bus/${two(i)}/mix/on`))
		}
		for (let i = 0; i < 6; i++) this.send(r, oscMessage(`/mtx/${two(i)}/config/name`))
		this.send(r, oscMessage('/main/st/config/name'))
		this.send(r, oscMessage('/main/m/config/name'))
	}

	tick() {
		const now = Date.now()
		for (const r of this.consoles.values()) {
			const alive = now - r.lastMeter < DEAD_MS
			if (alive && now - r.lastRenew >= RENEW_MS) {
				r.lastRenew = now
				for (const path of Object.keys(LAYOUT)) this.send(r, oscMessage('/renew', 's', oscString(path)))
			} else if (!alive && now - r.lastSubscribe >= 5000) {
				// nothing has arrived for a while: ask again (a console that is off simply stays silent)
				this.subscribe(r, now - r.lastNames > 15000)
			}
			if (alive && now - r.lastNames >= NAMES_MS) this.askNames(r)
			if (alive && now - r.lastInfo >= META_MS) this.askInfo(r)
			// peak hold decay runs on the clock too, so a console that stops sending still shows falling peaks
			if (!alive) {
				for (const g of Object.values(r.groups)) for (const m of g.meters) this.decay(m, now, 1)
				if (r.since && now - r.lastMeter > 30000) r.since = 0
			}
		}
	}

	decay(m, now, dt) {
		if (now - m.peakAt > HOLD_MS && m.peak > m.level) m.peak = Math.max(m.level, m.peak - DECAY_DB_S * dt)
	}

	onMessage(msg, rinfo) {
		const r = this.consoles.get(rinfo.address)
		if (!r) return
		let o
		try {
			o = parseOsc(msg)
		} catch {
			return
		}
		if (!o) return
		const now = Date.now()
		r.lastAnswer = now
		const layout = LAYOUT[o.addr]
		if (layout && Buffer.isBuffer(o.args[0])) {
			const f = meterFloats(o.args[0])
			if (!f.length) return
			if (!r.since) r.since = now
			const dt = r.lastMeter ? Math.min(1, (now - r.lastMeter) / 1000) : 0.1
			r.lastMeter = now
			r.lastBlob[o.addr] = now
			r.blobs++
			r.rate.n++
			if (now - r.rate.t >= 2000) {
				r.rate.value = Math.round((r.rate.n * 1000) / Math.max(1, now - r.rate.t))
				r.rate.n = 0
				r.rate.t = now
			}
			for (const g of layout) {
				const grp = r.groups[g.key]
				for (let i = 0; i < g.n && g.at + i < f.length; i++) {
					const m = grp.meters[i]
					const db = toDb(f[g.at + i])
					m.level = db
					if (db >= m.peak || now - m.peakAt > HOLD_MS) {
						if (db >= m.peak) {
							m.peak = db
							m.peakAt = now
						} else this.decay(m, now, dt)
					}
					if (db >= CLIP_DB) m.clipAt = now
				}
			}
			this.version++
			return
		}
		if (o.addr === '/xinfo' && o.args.length >= 4) {
			r.info = { ip: o.args[0], name: o.args[1], model: o.args[2], firmware: o.args[3] }
			return
		}
		let m
		if ((m = o.addr.match(/^\/ch\/(\d\d)\/config\/name$/))) r.groups.channels.names[Number(m[1]) - 1] = String(o.args[0] ?? '')
		else if ((m = o.addr.match(/^\/ch\/(\d\d)\/mix\/on$/))) r.groups.channels.on[Number(m[1]) - 1] = o.args[0] === 1
		else if ((m = o.addr.match(/^\/bus\/(\d\d)\/config\/name$/))) r.groups.buses.names[Number(m[1]) - 1] = String(o.args[0] ?? '')
		else if ((m = o.addr.match(/^\/bus\/(\d\d)\/mix\/on$/))) r.groups.buses.on[Number(m[1]) - 1] = o.args[0] === 1
		else if ((m = o.addr.match(/^\/mtx\/(\d\d)\/config\/name$/))) r.groups.matrix.names[Number(m[1]) - 1] = String(o.args[0] ?? '')
		else if (o.addr === '/main/st/config/name') {
			const n = String(o.args[0] ?? '').trim()
			r.groups.main.names[0] = n ? n + ' L' : 'Main L'
			r.groups.main.names[1] = n ? n + ' R' : 'Main R'
		} else if (o.addr === '/main/m/config/name') r.groups.main.names[2] = String(o.args[0] ?? '').trim() || 'Mono'
	}

	// the full picture for the state object (names, mute, levels, peaks)
	snapshot() {
		const now = Date.now()
		return [...this.consoles.values()].map((r) => {
			const live = now - r.lastMeter < DEAD_MS
			const answered = now - r.lastAnswer < 15000
			const group = (key) => {
				const g = r.groups[key]
				return g.meters.map((m, i) => ({ n: i + 1, label: `${GROUP_LABEL[key]} ${i + 1}`, name: g.names[i] || (key === 'main' ? MAIN_NAMES[i] : ''), level: r1(Math.max(FLOOR_DB, m.level)), peak: r1(Math.max(FLOOR_DB, m.peak)), on: g.on[i], clip: now - m.clipAt < CLIP_HOLD_MS, silent: m.level < FLOOR_DB }))
			}
			const channels = group('channels')
			const active = channels.filter((c) => c.level > SIGNAL_DB && c.on !== false).length
			const main = group('main')
			return {
				ip: r.ip,
				name: r.name,
				console: r.info ? { name: r.info.name, model: r.info.model, firmware: r.info.firmware } : null,
				ok: live,
				answered,
				error: live ? null : answered ? 'answers OSC but sends no meters' : r.lastAnswer ? `no answer for ${Math.round((now - r.lastAnswer) / 1000)} s` : 'no answer on UDP 10023',
				since: live ? r.since : 0,
				age: r.lastMeter ? Math.round((now - r.lastMeter) / 1000) : null,
				rate: live ? r.rate.value : 0,
				blobs: r.blobs,
				active,
				mainLevel: live ? Math.max(main[0].level, main[1].level) : null,
				channels,
				buses: group('buses'),
				matrix: group('matrix'),
				main,
			}
		})
	}

	// the compact 5-Hz form for the "meters" event: [level, peak, flags] per meter (flags: 1 muted, 2 clip)
	compact() {
		const now = Date.now()
		const out = {}
		for (const r of this.consoles.values()) {
			if (now - r.lastMeter >= DEAD_MS) continue
			const pack = (key) => r.groups[key].meters.map((m, i) => [r1(Math.max(FLOOR_DB, m.level)), r1(Math.max(FLOOR_DB, m.peak)), (r.groups[key].on[i] === false ? 1 : 0) | (now - m.clipAt < CLIP_HOLD_MS ? 2 : 0)])
			out[r.ip] = { ch: pack('channels'), bus: pack('buses'), mtx: pack('matrix'), main: pack('main') }
		}
		return out
	}
}
