// What the broadcast VLANs say about themselves, read passively from this machine's own interfaces:
//  - NDI sources: an mDNS query for _ndi._tcp.local every 30 s on every IPv4 interface (NDI sources answer
//    with their name, host and port; the NDI NIC on the NDI VLAN hears them, the others usually not).
//  - Dante clocks: Dante devices run PTP version 1 on UDP 319 to 224.0.1.129 (default domain) and the
//    neighbouring groups; the leader sends Sync about four times a second, every follower sends Delay_Req.
//    Listening on 319 gives, per domain (told apart by the senders' subnet, since a socket cannot say which
//    group a packet came to), the leader, its grandmaster id, the sync rate and the followers. Nothing is
//    ever sent on 319.
//  - Dante devices: an mDNS query for _netaudio-arc._udp.local (the Dante control service) every 30 s.
// Nothing here opens a session with anything; the queries are the same ones NDI Studio Monitor and Dante
// Controller send.
import dgram from 'node:dgram'
import os from 'node:os'
import { EventEmitter } from 'node:events'

const MDNS_ADDR = '224.0.0.251'
const MDNS_PORT = 5353
const PTP_PORT = 319
const PTP_GROUPS = ['224.0.1.129', '224.0.1.130', '224.0.1.131', '224.0.1.132']
const NDI_SVC = '_ndi._tcp.local'
const DANTE_SVC = '_netaudio-arc._udp.local'
const STALE_MS = 120000

function ifaces() {
	return Object.values(os.networkInterfaces())
		.flat()
		.filter((a) => a && a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address))
		.map((a) => a.address)
}

// ------------------------------------------------------------------ mDNS wire format (queries out, answers in)
function query(name) {
	const parts = name.split('.').filter(Boolean)
	const b = [Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0])]
	for (const p of parts) {
		b.push(Buffer.from([p.length]))
		b.push(Buffer.from(p))
	}
	b.push(Buffer.from([0, 0, 12, 0, 1])) // PTR, IN
	return Buffer.concat(b)
}
function readName(buf, off, depth = 0) {
	const out = []
	let i = off
	let end = off
	let jumped = false
	while (i < buf.length) {
		const len = buf[i]
		if (len === 0) {
			i++
			if (!jumped) end = i
			break
		}
		if ((len & 0xc0) === 0xc0) {
			const ptr = ((len & 0x3f) << 8) | buf[i + 1]
			if (!jumped) end = i + 2
			if (depth > 6) break
			out.push(readName(buf, ptr, depth + 1).name)
			jumped = true
			break
		}
		out.push(buf.toString('utf8', i + 1, i + 1 + len))
		i += 1 + len
		if (!jumped) end = i
	}
	return { name: out.join('.'), end }
}
function parse(buf) {
	if (buf.length < 12) return []
	const qd = buf.readUInt16BE(4)
	const an = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10)
	let i = 12
	for (let k = 0; k < qd; k++) i = readName(buf, i).end + 4
	const out = []
	for (let k = 0; k < an && i + 10 <= buf.length; k++) {
		const n = readName(buf, i)
		i = n.end
		const type = buf.readUInt16BE(i)
		const rdlen = buf.readUInt16BE(i + 8)
		const rd = i + 10
		if (rd + rdlen > buf.length) break
		let val = null
		if (type === 12) val = readName(buf, rd).name
		else if (type === 1) val = [...buf.subarray(rd, rd + 4)].join('.')
		else if (type === 33) val = { port: buf.readUInt16BE(rd + 4), host: readName(buf, rd + 6).name }
		else if (type === 16) {
			const t = []
			let j = rd
			while (j < rd + rdlen) {
				const l = buf[j]
				t.push(buf.toString('utf8', j + 1, j + 1 + l))
				j += 1 + l
			}
			val = t
		}
		out.push({ name: n.name, type, val })
		i = rd + rdlen
	}
	return out
}

export class Discover extends EventEmitter {
	constructor({ log = () => {}, nameFor = () => null, subnetName = () => null } = {}) {
		super()
		this.log = log
		this.nameFor = nameFor
		this.subnetName = subnetName
		this.ndi = new Map() // instance name -> {name, host, port, ip, groups, t}
		this.dante = new Map() // instance name -> {name, host, ip, t}
		this.ptp = new Map() // sender ip -> {ip, role, syncs, reqs, last, uuid, domain}
		this.hosts = new Map() // host name -> ip (A records)
		this.socks = []
		this.timers = []
		this.error = null
	}

	start() {
		try {
			this.startMdns()
		} catch (e) {
			this.error = 'mDNS: ' + e.message
			this.log('[discover] ' + this.error)
		}
		try {
			this.startPtp()
		} catch (e) {
			this.error = (this.error ? this.error + '; ' : '') + 'PTP: ' + e.message
			this.log('[discover] PTP: ' + e.message)
		}
	}
	stop() {
		for (const t of this.timers) clearInterval(t)
		this.timers = []
		for (const s of this.socks) {
			try {
				s.close()
			} catch {}
		}
		this.socks = []
	}

	startMdns() {
		const s = dgram.createSocket({ type: 'udp4', reuseAddr: true })
		s.on('error', (e) => (this.error = 'mDNS: ' + e.message))
		s.on('message', (m) => this.onMdns(m))
		s.bind(MDNS_PORT, '0.0.0.0', () => {
			for (const ip of ifaces()) {
				try {
					s.addMembership(MDNS_ADDR, ip)
				} catch {}
			}
			const ask = () => {
				for (const ip of ifaces()) {
					try {
						s.setMulticastInterface(ip)
						s.send(query(NDI_SVC), MDNS_PORT, MDNS_ADDR)
						s.send(query(DANTE_SVC), MDNS_PORT, MDNS_ADDR)
					} catch {}
				}
			}
			ask()
			setTimeout(ask, 2000)
			this.timers.push(setInterval(ask, 30000))
		})
		this.socks.push(s)
	}
	onMdns(buf) {
		let recs
		try {
			recs = parse(buf)
		} catch {
			return
		}
		const now = Date.now()
		for (const r of recs) if (r.type === 1 && r.val) this.hosts.set(r.name.toLowerCase(), r.val)
		for (const r of recs) {
			if (r.type === 12 && r.name === NDI_SVC && r.val) this.ndi.set(r.val, { ...(this.ndi.get(r.val) || {}), name: r.val.replace(/\._ndi\._tcp\.local$/i, ''), t: now })
			if (r.type === 12 && r.name === DANTE_SVC && r.val) this.dante.set(r.val, { ...(this.dante.get(r.val) || {}), name: r.val.replace(/\._netaudio-arc\._udp\.local$/i, ''), t: now })
		}
		for (const r of recs) {
			const list = /_ndi\._tcp/i.test(r.name) ? this.ndi : /_netaudio-arc\._udp/i.test(r.name) ? this.dante : null
			if (!list) continue
			const e = list.get(r.name) || { name: r.name.replace(/\._(ndi|netaudio-arc)\._(tcp|udp)\.local$/i, ''), t: now }
			if (r.type === 33) {
				e.host = r.val.host
				e.port = r.val.port
			} else if (r.type === 16) e.txt = r.val
			e.t = now
			list.set(r.name, e)
		}
		for (const list of [this.ndi, this.dante]) for (const e of list.values()) if (e.host && !e.ip) e.ip = this.hosts.get(e.host.toLowerCase()) || null
	}

	startPtp() {
		const s = dgram.createSocket({ type: 'udp4', reuseAddr: true })
		s.on('error', (e) => (this.error = 'PTP: ' + e.message))
		s.on('message', (m, rinfo) => this.onPtp(m, rinfo))
		s.bind(PTP_PORT, '0.0.0.0', () => {
			for (const ip of ifaces()) for (const g of PTP_GROUPS) {
				try {
					s.addMembership(g, ip)
				} catch {}
			}
		})
		this.socks.push(s)
		this.timers.push(setInterval(() => this.sweep(), 10000))
	}
	// PTPv1 (IEEE 1588-2002), the flavour Dante speaks: header 40 bytes, control byte at 32 (0 sync, 1 delay_req,
	// 2 follow_up, 3 delay_resp); the sync body carries the grandmaster uuid at 40+21 and the stratum at 40+36
	onPtp(m, rinfo) {
		if (m.length < 40) return
		const now = Date.now()
		const control = m[32]
		const ip = rinfo.address
		const e = this.ptp.get(ip) || { ip, syncs: 0, reqs: 0, first: now, last: now, uuid: null, stratum: null, name: null, subnet: ip.split('.').slice(0, 3).join('.') + '.0', win: [] }
		e.last = now
		if (control === 0 || control === 2) {
			e.syncs++
			e.win.push(now)
			while (e.win.length && now - e.win[0] > 10000) e.win.shift()
			if (m.length >= 40 + 44) {
				e.uuid = [...m.subarray(40 + 21, 40 + 27)].map((b) => b.toString(16).padStart(2, '0')).join(':')
				e.stratum = m[40 + 36]
			}
		} else if (control === 1) e.reqs++
		if (!e.name) e.name = this.nameFor(ip) || null
		this.ptp.set(ip, e)
	}
	sweep() {
		const now = Date.now()
		for (const [k, e] of this.ptp) if (now - e.last > STALE_MS) this.ptp.delete(k)
		for (const list of [this.ndi, this.dante]) for (const [k, e] of list) if (now - e.t > STALE_MS * 2) list.delete(k)
	}

	snapshot() {
		const now = Date.now()
		const ndi = [...this.ndi.values()].filter((e) => now - e.t < STALE_MS * 2).map((e) => ({ name: e.name, host: e.host || null, port: e.port || null, ip: e.ip || null, device: e.ip ? this.nameFor(e.ip) : null, groups: (e.txt || []).find((t) => /^groups=/i.test(t))?.slice(7) || null, seen: e.t })).sort((a, b) => a.name.localeCompare(b.name))
		const dante = [...this.dante.values()].filter((e) => now - e.t < STALE_MS * 2).map((e) => ({ name: e.name, host: e.host || null, ip: e.ip || null, device: e.ip ? this.nameFor(e.ip) : null, seen: e.t })).sort((a, b) => a.name.localeCompare(b.name))
		// clock domains: one per subnet that has a leader (the sender of Sync); followers are the Delay_Req senders of that subnet
		const bySubnet = new Map()
		for (const e of this.ptp.values()) {
			if (!bySubnet.has(e.subnet)) bySubnet.set(e.subnet, { subnet: e.subnet, network: this.subnetName(e.subnet), leaders: [], followers: [] })
			const d = bySubnet.get(e.subnet)
			const rec = { ip: e.ip, name: e.name || this.nameFor(e.ip) || null, last: e.last, uuid: e.uuid, stratum: e.stratum, syncPerS: Math.round((e.win.length / 10) * 10) / 10, reqs: e.reqs }
			if (e.syncs > 0 && now - (e.win[e.win.length - 1] || 0) < 15000) d.leaders.push(rec)
			else d.followers.push(rec)
		}
		const clocks = [...bySubnet.values()].map((d) => ({ ...d, status: d.leaders.length === 1 ? 'ok' : d.leaders.length > 1 ? 'two leaders' : 'no leader seen', followers: d.followers.sort((a, b) => a.ip.localeCompare(b.ip)) }))
		return { ndi, dante, clocks, interfaces: ifaces(), error: this.error, t: now }
	}
}
