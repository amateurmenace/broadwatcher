// Reachability probes for broadcast equipment: a TCP connect to the device's control port
// (ATEM 9910, HyperDeck 9993, Videohub 9990, Web Presenter 9977 ...) or an OSC /xinfo to a Behringer X32.
import net from 'node:net'
import dgram from 'node:dgram'

export function tcpProbe(ip, port, timeoutMs = 1500) {
	return new Promise((resolve) => {
		const t0 = process.hrtime.bigint()
		const sock = new net.Socket()
		let done = false
		const finish = (ok, error) => {
			if (done) return
			done = true
			sock.destroy()
			resolve({ ok, ms: Number(process.hrtime.bigint() - t0) / 1e6, error })
		}
		sock.setTimeout(timeoutMs, () => finish(false, 'timeout'))
		sock.once('connect', () => finish(true))
		sock.once('error', (e) => finish(false, e.code || e.message))
		sock.connect(port, ip)
	})
}

function oscString(s) {
	const len = Buffer.byteLength(s) + 1
	const pad = (4 - (len % 4)) % 4
	return Buffer.concat([Buffer.from(s + '\0'), Buffer.alloc(pad)])
}

function oscStrings(buf) {
	const out = []
	let i = 0
	while (i < buf.length) {
		const end = buf.indexOf(0, i)
		if (end < 0) break
		out.push(buf.toString('utf8', i, end))
		i = end + 1
		i += (4 - (i % 4)) % 4
	}
	return out
}

// Behringer X32 / M32: "/xinfo" answers with [ip, name, model, firmware]
export function x32Probe(ip, port = 10023, timeoutMs = 1500) {
	return new Promise((resolve) => {
		const t0 = process.hrtime.bigint()
		const sock = dgram.createSocket('udp4')
		let done = false
		const finish = (ok, extra = {}) => {
			if (done) return
			done = true
			try { sock.close() } catch {}
			resolve({ ok, ms: Number(process.hrtime.bigint() - t0) / 1e6, ...extra })
		}
		const timer = setTimeout(() => finish(false, { error: 'timeout' }), timeoutMs)
		sock.once('error', (e) => { clearTimeout(timer); finish(false, { error: e.code || e.message }) })
		sock.on('message', (msg) => {
			clearTimeout(timer)
			const parts = oscStrings(msg)
			// parts: ['/xinfo', ',ssss', ip, name, model, firmware]
			const info = parts.length >= 6 ? { name: parts[3], model: parts[4], firmware: parts[5] } : {}
			finish(true, { info })
		})
		sock.send(Buffer.concat([oscString('/xinfo'), oscString(',')]), port, ip, (err) => {
			if (err) { clearTimeout(timer); finish(false, { error: err.code || err.message }) }
		})
	})
}

// Blackmagic ATEM switchers speak UDP on 9910. A "hello" packet is answered with a hello-ack whose
// byte 12 is 2 (accepted) or 3 (too many clients). We never ack, so the switcher drops the session.
const ATEM_HELLO = Buffer.from([0x10, 0x14, 0x53, 0xab, 0, 0, 0, 0, 0, 0x3a, 0, 0, 0x01, 0, 0, 0, 0, 0, 0, 0])
export function atemProbe(ip, port = 9910, timeoutMs = 1500) {
	return new Promise((resolve) => {
		const t0 = process.hrtime.bigint()
		const sock = dgram.createSocket('udp4')
		let done = false
		const finish = (ok, extra = {}) => {
			if (done) return
			done = true
			try { sock.close() } catch {}
			resolve({ ok, ms: Number(process.hrtime.bigint() - t0) / 1e6, ...extra })
		}
		const timer = setTimeout(() => finish(false, { error: 'timeout' }), timeoutMs)
		sock.once('error', (e) => { clearTimeout(timer); finish(false, { error: e.code || e.message }) })
		sock.on('message', (msg) => {
			clearTimeout(timer)
			const code = msg.length > 12 ? msg[12] : -1
			finish(true, { info: { state: code === 2 ? 'accepting connections' : code === 3 ? 'too many clients' : `reply ${code}` } })
		})
		sock.send(ATEM_HELLO, port, ip, (err) => {
			if (err) { clearTimeout(timer); finish(false, { error: err.code || err.message }) }
		})
	})
}

// spec: "tcp:9993" | "atem" | "atem:9910" | "x32" | "x32:10023" | undefined (no probe)
export async function probe(ip, spec) {
	if (!spec || !ip) return null
	const [kind, portStr] = String(spec).split(':')
	if (kind === 'tcp') return tcpProbe(ip, Number(portStr) || 80)
	if (kind === 'atem') return atemProbe(ip, Number(portStr) || 9910)
	if (kind === 'x32') return x32Probe(ip, Number(portStr) || 10023)
	return null
}

export async function probeAll(items, concurrency = 8) {
	const out = new Map()
	const queue = items.slice()
	async function worker() {
		while (queue.length) {
			const it = queue.shift()
			try {
				out.set(it.ip, await probe(it.ip, it.probe))
			} catch (e) {
				out.set(it.ip, { ok: false, error: e.message })
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
	return out
}
