// Tiny SNMP v2c client (GET / GETBULK walk) with no dependencies. Used to read switch port counters straight
// from the switches every few seconds: the UniFi controller only refreshes its copy when a switch "informs"
// (every 30-90 s), SNMP answers in milliseconds. Enable it in UniFi Network > Settings > System > SNMP.
import dgram from 'node:dgram'

// ---------------------------------------------------------------- BER
function encLen(n) {
	if (n < 128) return Buffer.from([n])
	if (n < 256) return Buffer.from([0x81, n])
	if (n < 65536) return Buffer.from([0x82, n >> 8, n & 0xff])
	return Buffer.from([0x83, n >> 16, (n >> 8) & 0xff, n & 0xff])
}
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), encLen(body.length), body])
function encInt(v) {
	let n = BigInt(v)
	const bytes = []
	do {
		bytes.unshift(Number(n & 0xffn))
		n >>= 8n
	} while (n > 0n && n !== -1n)
	if (bytes[0] & 0x80 && v >= 0) bytes.unshift(0)
	return tlv(0x02, Buffer.from(bytes))
}
function encOid(oid) {
	const parts = String(oid).replace(/^\./, '').split('.').map(Number)
	const out = [40 * parts[0] + parts[1]]
	for (const p of parts.slice(2)) {
		if (p < 128) out.push(p)
		else {
			const tmp = []
			let v = p
			do {
				tmp.unshift(v & 0x7f)
				v >>= 7
			} while (v > 0)
			for (let i = 0; i < tmp.length - 1; i++) tmp[i] |= 0x80
			out.push(...tmp)
		}
	}
	return tlv(0x06, Buffer.from(out))
}
function decLen(buf, i) {
	let l = buf[i++]
	if (l & 0x80) {
		const n = l & 0x7f
		l = 0
		for (let k = 0; k < n; k++) l = (l << 8) | buf[i++]
	}
	return [l, i]
}
function decTlv(buf, i) {
	const tag = buf[i]
	const [len, start] = decLen(buf, i + 1)
	return { tag, start, end: start + len, body: buf.subarray(start, start + len) }
}
function decOid(body) {
	const out = []
	let v = 0
	for (let i = 0; i < body.length; i++) {
		v = (v << 7) | (body[i] & 0x7f)
		if (!(body[i] & 0x80)) {
			if (!out.length) out.push(Math.floor(v / 40), v % 40)
			else out.push(v)
			v = 0
		}
	}
	return out.join('.')
}
function decValue(t) {
	const b = t.body
	switch (t.tag) {
		case 0x02:
		case 0x41:
		case 0x42:
		case 0x43:
		case 0x46: {
			let v = 0n
			for (const x of b) v = (v << 8n) | BigInt(x)
			if (t.tag === 0x02 && b.length && b[0] & 0x80) v -= 1n << BigInt(8 * b.length)
			return Number(v)
		}
		case 0x04:
			return b.toString('utf8')
		case 0x06:
			return decOid(b)
		case 0x05:
		case 0x80:
		case 0x81:
		case 0x82:
			return null
		default:
			return b.toString('hex')
	}
}
function decVarbinds(buf) {
	const msg = decTlv(buf, 0)
	let i = msg.start
	const ver = decTlv(buf, i)
	i = ver.end
	const comm = decTlv(buf, i)
	i = comm.end
	const pdu = decTlv(buf, i)
	i = pdu.start
	const reqId = decTlv(buf, i)
	i = reqId.end
	const errStatus = decTlv(buf, i)
	i = errStatus.end
	const errIndex = decTlv(buf, i)
	i = errIndex.end
	const vbl = decTlv(buf, i)
	i = vbl.start
	const out = []
	while (i < vbl.end) {
		const vb = decTlv(buf, i)
		const oidT = decTlv(buf, vb.start)
		const valT = decTlv(buf, oidT.end)
		out.push({ oid: decOid(oidT.body), value: decValue(valT), tag: valT.tag })
		i = vb.end
	}
	return { requestId: decValue(reqId), error: decValue(errStatus), varbinds: out }
}

// ---------------------------------------------------------------- transport
let reqCounter = Math.floor(Math.random() * 100000)
function request(ip, community, pduTag, oids, { timeoutMs = 1500, port = 161, nonRepeaters = 0, maxRepetitions = 40 } = {}) {
	return new Promise((resolve, reject) => {
		const id = (reqCounter = (reqCounter + 1) % 2147483647)
		const vbs = tlv(0x30, Buffer.concat(oids.map((o) => tlv(0x30, Buffer.concat([encOid(o), tlv(0x05, Buffer.alloc(0))])))))
		const pdu = tlv(pduTag, Buffer.concat([encInt(id), encInt(pduTag === 0xa5 ? nonRepeaters : 0), encInt(pduTag === 0xa5 ? maxRepetitions : 0), vbs]))
		const msg = tlv(0x30, Buffer.concat([encInt(1), tlv(0x04, Buffer.from(community)), pdu]))
		const sock = dgram.createSocket('udp4')
		let done = false
		const finish = (err, val) => {
			if (done) return
			done = true
			clearTimeout(timer)
			try {
				sock.close()
			} catch {}
			err ? reject(err) : resolve(val)
		}
		const timer = setTimeout(() => finish(new Error('snmp timeout')), timeoutMs)
		sock.on('error', (e) => finish(e))
		sock.on('message', (buf) => {
			try {
				const r = decVarbinds(buf)
				if (r.requestId !== id) return
				if (r.error) return finish(new Error(`snmp error ${r.error}`))
				finish(null, r.varbinds)
			} catch (e) {
				finish(e)
			}
		})
		sock.send(msg, port, ip, (e) => e && finish(e))
	})
}

export const snmpGet = (ip, community, oids, opts) => request(ip, community, 0xa0, oids, opts)

export async function snmpWalk(ip, community, base, opts = {}) {
	const out = []
	let cur = base
	const prefix = base + '.'
	for (let i = 0; i < 200; i++) {
		const vbs = await request(ip, community, 0xa5, [cur], { ...opts, maxRepetitions: 50 })
		let stop = false
		for (const vb of vbs) {
			if (!vb.oid.startsWith(prefix) || vb.tag === 0x82) {
				stop = true
				break
			}
			out.push(vb)
			cur = vb.oid
		}
		if (stop || !vbs.length) break
	}
	return out
}

// ---------------------------------------------------------------- port counters
const OID = { sysDescr: '1.3.6.1.2.1.1.1.0', sysName: '1.3.6.1.2.1.1.5.0', ifName: '1.3.6.1.2.1.31.1.1.1.1', ifDescr: '1.3.6.1.2.1.2.2.1.2', ifHCIn: '1.3.6.1.2.1.31.1.1.1.6', ifHCOut: '1.3.6.1.2.1.31.1.1.1.10', ifOperStatus: '1.3.6.1.2.1.2.2.1.8', ifHighSpeed: '1.3.6.1.2.1.31.1.1.1.15' }

export class SnmpSwitch {
	constructor(ip, community) {
		this.ip = ip
		this.community = community
		this.ifIndexByPort = null // port idx -> ifIndex
		this.ok = false
		this.error = null
		this.last = new Map() // port -> {in, out, t}
		this.rates = new Map() // port -> {rx, tx, t}
	}

	// map "Port 15" / "eth14" style interface names to UniFi port numbers
	async discover() {
		const names = await snmpWalk(this.ip, this.community, OID.ifName)
		const map = new Map()
		for (const vb of names) {
			const ifIndex = Number(vb.oid.split('.').pop())
			const m = /(?:port|eth|ge|xe|swp)[^\d]*(\d+)/i.exec(String(vb.value))
			if (!m) continue
			let n = Number(m[1])
			if (/^eth/i.test(String(vb.value))) n += 1 // eth0 = port 1 on UniFi switches
			if (!map.has(n)) map.set(n, ifIndex)
		}
		this.ifIndexByPort = map
		return map
	}

	// returns Map(port -> {rx: bytes/s from the device, tx: bytes/s to the device, in, out, t})
	async poll(ports) {
		if (!this.ifIndexByPort) await this.discover()
		const want = ports.filter((p) => this.ifIndexByPort.has(p))
		if (!want.length) return new Map()
		const oids = want.flatMap((p) => [`${OID.ifHCIn}.${this.ifIndexByPort.get(p)}`, `${OID.ifHCOut}.${this.ifIndexByPort.get(p)}`])
		const t = Date.now()
		const out = new Map()
		for (let i = 0; i < oids.length; i += 40) {
			const vbs = await snmpGet(this.ip, this.community, oids.slice(i, i + 40))
			for (let k = 0; k < vbs.length; k += 2) {
				const p = want[(i + k) / 2]
				const inB = Number(vbs[k]?.value) || 0
				const outB = Number(vbs[k + 1]?.value) || 0
				const prev = this.last.get(p)
				if (prev && t > prev.t) {
					const dt = (t - prev.t) / 1000
					const r = { rx: Math.max(0, (inB - prev.in) / dt), tx: Math.max(0, (outB - prev.out) / dt), t }
					this.rates.set(p, r)
					out.set(p, { ...r, in: inB, out: outB })
				}
				this.last.set(p, { in: inB, out: outB, t })
			}
		}
		this.ok = true
		this.error = null
		return out
	}
}

export async function snmpProbe(ip, community, timeoutMs = 1500) {
	const vbs = await snmpGet(ip, community, [OID.sysDescr, OID.sysName], { timeoutMs })
	return { descr: vbs[0]?.value, name: vbs[1]?.value }
}
