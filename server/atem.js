// Read-only clients for the Blackmagic ATEM protocol (UDP 9910).
//  - readAtem(): one-shot: says hello, acknowledges the initial state dump, returns product, firmware,
//    program/preview, input names and the streaming state (StRS/SRSS/SRSU), then lets the session time out.
//  - AtemClient: a persistent session that keeps acknowledging the switcher's packets, so it uses exactly
//    ONE of the switcher's control-connection slots for as long as Broadwatcher runs (a new hello every few
//    seconds would leave abandoned sessions behind until the switcher expires them, and the HD8 / Minis
//    only have a handful of slots that Companion and ATEM Software Control need).
import dgram from 'node:dgram'
import { EventEmitter } from 'node:events'

const FLAG_ACKREQ = 0x08
const FLAG_HELLO = 0x10
const FLAG_ACK = 0x80
const HELLO = Buffer.from([0x10, 0x14, 0x53, 0xab, 0, 0, 0, 0, 0, 0x3a, 0, 0, 0x01, 0, 0, 0, 0, 0, 0, 0])
const STREAM_STATE = { 1: 'idle', 2: 'connecting', 4: 'streaming', 32: 'stopping' }

const cstr = (b, off, len) => {
	const s = b.subarray(off, Math.min(b.length, off + len))
	const z = s.indexOf(0)
	return s.toString('utf8', 0, z < 0 ? s.length : z)
}

export function readAtem(ip, { port = 9910, timeoutMs = 6000, capture = [] } = {}) {
	return new Promise((resolve) => {
		const sock = dgram.createSocket('udp4')
		const t0 = Date.now()
		let done = false
		const result = { ok: false, ms: 0, product: null, version: null, streaming: null, inputs: {}, program: null, preview: null, commands: 0, unknown: [], raw: {} }
		const finish = (ok, error) => {
			if (done) return
			done = true
			clearTimeout(timer)
			try {
				sock.close()
			} catch {}
			result.ok = ok
			result.ms = Date.now() - t0
			if (error) result.error = error
			if (result.streaming?.url) {
				try {
					const u = new URL(result.streaming.url)
					result.streaming.host = u.hostname
					result.streaming.port = Number(u.port) || (u.protocol === 'rtmps:' ? 443 : u.protocol === 'srt:' ? 0 : 1935)
					result.streaming.protocol = u.protocol.replace(':', '')
				} catch {}
			}
			resolve(result)
		}
		const timer = setTimeout(() => finish(result.commands > 0, result.commands ? undefined : 'timeout'), timeoutMs)
		const send = (buf) => sock.send(buf, port, ip, (e) => e && finish(false, e.code || e.message))
		const ack = (sid, pid) => {
			const b = Buffer.alloc(12)
			b.writeUInt16BE((FLAG_ACK << 8) | 12, 0)
			b.writeUInt16BE(sid, 2)
			b.writeUInt16BE(pid, 4)
			send(b)
		}
		sock.on('error', (e) => finish(false, e.code || e.message))
		sock.on('message', (msg) => {
			if (msg.length < 12) return
			const flags = msg[0] & 0xf8
			const len = msg.readUInt16BE(0) & 0x07ff
			const sid = msg.readUInt16BE(2)
			const pid = msg.readUInt16BE(10)
			if (flags & FLAG_HELLO) {
				const code = msg[12]
				if (code === 3) return finish(false, 'too many clients')
				if (code !== 2) return finish(false, `hello reply ${code}`)
				ack(sid, 0)
				return
			}
			if (flags & FLAG_ACKREQ) ack(sid, pid)
			let i = 12
			while (i + 8 <= len && i + 8 <= msg.length) {
				const clen = msg.readUInt16BE(i)
				if (clen < 8) break
				handle(msg.toString('latin1', i + 4, i + 8), msg.subarray(i + 8, i + clen))
				i += clen
			}
		})
		function handle(name, body) {
			result.commands++
			if (capture.includes(name)) (result.raw[name] = result.raw[name] || []).push(Buffer.from(body))
			try {
				switch (name) {
					case '_pin':
						result.product = cstr(body, 0, 44)
						break
					case '_ver':
						result.version = `${body.readUInt16BE(0)}.${body.readUInt16BE(2)}`
						break
					case 'StRS':
						result.streaming = { ...(result.streaming || {}), state: STREAM_STATE[body.readUInt16BE(0)] || `state ${body.readUInt16BE(0)}`, error: body.readUInt16BE(2) }
						break
					case 'SRSS':
						result.streaming = { ...(result.streaming || {}), bitrate: body.readUInt32BE(0), cache: body.readUInt16BE(4) }
						break
					case 'SRSU':
						result.streaming = { ...(result.streaming || {}), service: cstr(body, 0, 64), url: cstr(body, 64, 512), keySet: !!cstr(body, 576, 512), bitrateLow: body.length >= 1092 ? body.readUInt32BE(1088) : null, bitrateHigh: body.length >= 1096 ? body.readUInt32BE(1092) : null }
						break
					case 'InPr': {
						const id = body.readUInt16BE(0)
						result.inputs[id] = { long: cstr(body, 2, 20), short: cstr(body, 22, 4) }
						break
					}
					case 'PrgI':
						if (body[0] === 0) result.program = body.readUInt16BE(2)
						break
					case 'PrvI':
						if (body[0] === 0) result.preview = body.readUInt16BE(2)
						break
					case 'InCm':
						finish(true)
						break
					default:
						if (result.unknown.length < 300 && !result.unknown.includes(name)) result.unknown.push(name)
				}
			} catch {}
		}
		send(HELLO)
	})
}

export class AtemClient extends EventEmitter {
	constructor(ip, { port = 9910, log = () => {} } = {}) {
		super()
		this.ip = ip
		this.port = port
		this.log = log
		this.sock = null
		this.state = 'idle' // idle | connecting | syncing | connected | refused | disconnected
		this.error = null
		this.data = { product: null, version: null, streaming: null, inputs: {}, program: null, preview: null }
		this.lastPacket = 0
		this.connectedAt = 0
		this.commands = 0
		this.timer = null
		this.retryAt = 0
		this.closed = false
		this.attempts = [] // timestamps of hellos we sent; never more than one per SLOT_HOLD_MS
	}

	static get SLOT_HOLD_MS() {
		return 120000 // measured on the HD8: a dead or half-open session is kept for up to ~2 minutes
	}

	// (re)connect when idle/disconnected and the backoff has passed; cheap to call every poll
	ensure() {
		if (this.closed) return
		if (this.state === 'connected' || this.state === 'syncing' || this.state === 'connecting') return
		if (Date.now() < this.retryAt) return
		this.connect()
	}

	connect() {
		// one hello per two minutes, whatever happens: a flapping link can then hold at most two slots (one live,
		// one expiring) instead of filling the switcher
		const now = Date.now()
		this.attempts = this.attempts.filter((t) => now - t < AtemClient.SLOT_HOLD_MS)
		if (this.attempts.length) {
			this.retryAt = this.attempts[0] + AtemClient.SLOT_HOLD_MS + 1000
			return
		}
		this.attempts.push(now)
		this.teardown()
		this.state = 'connecting'
		this.error = null
		this.commands = 0
		const sock = (this.sock = dgram.createSocket('udp4'))
		sock.on('error', (e) => this.fail(e.code || e.message, AtemClient.SLOT_HOLD_MS))
		sock.on('message', (msg) => this.onPacket(msg))
		sock.send(HELLO, this.port, this.ip, (e) => e && this.fail(e.code || e.message, AtemClient.SLOT_HOLD_MS))
		this.lastPacket = Date.now()
		this.timer = setInterval(() => {
			// the switcher sends a packet about every second; silence means the session is gone
			if (Date.now() - this.lastPacket > 8000) this.fail(this.state === 'connecting' ? 'timeout' : 'lost', AtemClient.SLOT_HOLD_MS)
		}, 2000)
	}

	onPacket(msg) {
		if (msg.length < 12) return
		this.lastPacket = Date.now()
		const flags = msg[0] & 0xf8
		const len = msg.readUInt16BE(0) & 0x07ff
		const sid = msg.readUInt16BE(2)
		const pid = msg.readUInt16BE(10)
		if (flags & FLAG_HELLO) {
			const code = msg[12]
			if (code === 3) return this.fail('too many clients', AtemClient.SLOT_HOLD_MS, 'refused')
			if (code !== 2) return this.fail(`hello reply ${code}`, AtemClient.SLOT_HOLD_MS, 'refused')
			this.state = 'syncing'
			this.ack(sid, 0)
			return
		}
		if (flags & FLAG_ACKREQ) this.ack(sid, pid)
		let i = 12
		while (i + 8 <= len && i + 8 <= msg.length) {
			const clen = msg.readUInt16BE(i)
			if (clen < 8) break
			this.handle(msg.toString('latin1', i + 4, i + 8), msg.subarray(i + 8, i + clen))
			i += clen
		}
	}

	ack(sid, pid) {
		if (!this.sock) return
		const b = Buffer.alloc(12)
		b.writeUInt16BE((FLAG_ACK << 8) | 12, 0)
		b.writeUInt16BE(sid, 2)
		b.writeUInt16BE(pid, 4)
		this.sock.send(b, this.port, this.ip, () => {})
	}

	handle(name, body) {
		this.commands++
		const d = this.data
		try {
			switch (name) {
				case '_pin':
					d.product = cstr(body, 0, 44)
					break
				case '_ver':
					d.version = `${body.readUInt16BE(0)}.${body.readUInt16BE(2)}`
					break
				case 'StRS':
					d.streaming = { ...(d.streaming || {}), state: STREAM_STATE[body.readUInt16BE(0)] || `state ${body.readUInt16BE(0)}`, error: body.readUInt16BE(2) }
					break
				case 'SRSS':
					d.streaming = { ...(d.streaming || {}), bitrate: body.readUInt32BE(0), cache: body.readUInt16BE(4) }
					break
				case 'SRSU': {
					const url = cstr(body, 64, 512)
					let host = null
					let port = null
					let protocol = null
					try {
						const u = new URL(url)
						host = u.hostname
						port = Number(u.port) || (u.protocol === 'rtmps:' ? 443 : 1935)
						protocol = u.protocol.replace(':', '')
					} catch {}
					d.streaming = { ...(d.streaming || {}), service: cstr(body, 0, 64), url, host, port, protocol, keySet: !!cstr(body, 576, 512) }
					break
				}
				case 'InPr': {
					const id = body.readUInt16BE(0)
					d.inputs[id] = { long: cstr(body, 2, 20), short: cstr(body, 22, 4) }
					break
				}
				case 'PrgI':
					if (body[0] === 0) d.program = body.readUInt16BE(2)
					break
				case 'PrvI':
					if (body[0] === 0) d.preview = body.readUInt16BE(2)
					break
				case 'InCm':
					if (this.state !== 'connected') {
						this.state = 'connected'
						this.connectedAt = Date.now()
						this.emit('connected')
					}
					break
			}
		} catch {}
		if (this.state === 'connected') this.emit('update', name)
	}

	fail(error, retryMs, state = 'disconnected') {
		const was = this.state
		this.teardown()
		this.state = state
		this.error = error
		this.retryAt = Date.now() + retryMs
		if (was === 'connected') this.emit('disconnected', error)
	}

	teardown() {
		if (this.timer) clearInterval(this.timer)
		this.timer = null
		if (this.sock) {
			try {
				this.sock.close()
			} catch {}
		}
		this.sock = null
	}

	close() {
		this.closed = true
		this.teardown()
		this.state = 'idle'
	}

	snapshot() {
		const d = this.data
		const live = this.state === 'connected'
		return {
			kind: 'atem',
			state: this.state,
			error: live ? null : this.error || (this.state === 'connecting' || this.state === 'syncing' ? 'connecting' : 'not connected'),
			product: d.product,
			version: d.version,
			streaming: d.streaming,
			program: d.program,
			preview: d.preview,
			inputs: d.inputs,
			programName: d.inputs[d.program]?.long || null,
			previewName: d.inputs[d.preview]?.long || null,
			connectedAt: this.connectedAt,
			lastPacket: this.lastPacket,
			commands: this.commands,
			retryAt: this.state === 'connected' ? null : this.retryAt,
		}
	}
}
