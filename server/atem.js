// Minimal read-only client for the Blackmagic ATEM protocol (UDP 9910): says hello, acknowledges the
// switcher's initial state dump, pulls out the product name, firmware, program/preview, input names and
// the switcher's *streaming* state (StRS/SRSS/SRSU: state, encoder bitrate, service and destination URL),
// then lets the session time out. Used to tell when an ATEM Mini is streaming INTO the studio switcher.
import dgram from 'node:dgram'

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
