// Stream forensics: tshark on a mirror of the switcher's switch port. The mirror carries every packet to and
// from the switcher, including same-VLAN streams the gateway never sees and the handshakes themselves, so
// "the stream arrives but the switcher rejects it" becomes visible: RTMP connect/publish and the switcher's
// answer (onStatus, TCP reset), SRT handshakes with version and latency, plus who holds ATEM control
// sessions (the switcher sends a "Time" keepalive to every held session about once a second) and whose
// hellos it refuses ("too many clients").
//
// Two tshark processes: the main one prints one line per packet (no payload) with the RTMP/SRT dissector
// fields and the Info column; a second, tiny one prints the payload of hello-sized ATEM packets only, so
// the hello reply codes can be read without dumping stream payloads. Both restart after a crash, never more
// than once per 30 s, and give up after five failures in a row.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { EventEmitter } from 'node:events'

// the whole session is kept, within these bounds (the oldest go first)
const MAX_FLOWS = 4000
const MAX_SESSIONS = 1000
const MAX_EVENTS = 4000
const KEEP_MS = 24 * 3600000

const FIELDS = ['frame.time_epoch', 'frame.len', 'ip.src', 'ip.dst', 'ip.proto', 'tcp.srcport', 'tcp.dstport', 'udp.srcport', 'udp.dstport', 'tcp.flags.syn', 'tcp.flags.reset', 'tcp.flags.fin', 'tcp.len', '_ws.col.Protocol', '_ws.col.Info', 'amf.string', 'srt.iscontrol', 'srt.type', 'srt.hs.reqtype', 'srt.hs.version', 'srt.hs.agent_latency', 'srt.hs.sid', 'srt.hs.failtype']
const HELLO_FIELDS = ['frame.time_epoch', 'ip.src', 'ip.dst', 'udp.srcport', 'udp.dstport', 'data.data']
const ATEM_PORT = 9910
const SRT_REQ = { 1: 'induction', '-1': 'conclusion', 0: 'waveahand', '-2': 'agreement', '-3': 'done' }
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0)
const isMulticast = (ip) => /^(22[4-9]|23\d)\./.test(ip || '') || /\.255$/.test(ip || '')
const maskKey = (s) => (s && s.length > 6 ? '…' + s.slice(-4) : s ? '…' + s.slice(-2) : '')

function defaultTshark() {
	if (process.platform === 'win32') return 'C:\\Program Files\\Wireshark\\tshark.exe'
	if (process.platform === 'darwin') return '/Applications/Wireshark.app/Contents/MacOS/tshark'
	return 'tshark'
}

export class Forensics extends EventEmitter {
	constructor(cfg = {}, { targetIp = null, log = () => {}, nameFor = () => null } = {}) {
		super()
		this.cfg = { interface: '', tshark: '', enabled: true, ...cfg }
		this.tshark = this.cfg.tshark || defaultTshark()
		this.targetIp = targetIp
		this.log = log
		this.nameFor = nameFor
		this.flows = new Map() // "peer|proto|targetPort|peerPort" -> flow
		this.sessions = new Map() // peer ip -> ATEM control session record
		this.events = [] // newest first, the whole session (MAX_EVENTS)
		this.stats = { running: false, since: 0, packets: 0, pps: 0, lastPacket: 0, restarts: 0, failures: 0, error: null }
		this.procs = {}
		this.timers = []
		this.secondBucket = { t: 0, n: 0 }
		this.stopped = false
		this.rawWanted = false // a third tshark writing raw packets to a ring of pcapng files (Wireshark opens them)
		this.rawDir = this.cfg.raw_dir || null
		this.rawSince = 0
		this.seq = 0
	}

	// ------------------------------------------------------------------ raw packets to disk (pcapng ring)
	startRaw(dir) {
		if (dir) this.rawDir = dir
		if (!this.available || !this.rawDir) return { error: !this.rawDir ? 'no capture folder' : 'capture not available' }
		try {
			fs.mkdirSync(this.rawDir, { recursive: true })
		} catch (e) {
			return { error: e.message }
		}
		this.rawWanted = true
		this.rawSince = this.rawSince || Date.now()
		const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
		this.spawn('raw', ['-i', this.cfg.interface, '-n', '-f', `host ${this.targetIp}`, '-w', path.join(this.rawDir, `switcher-${stamp}.pcapng`), '-b', 'filesize:102400', '-b', 'files:5'], () => {})
		this.event('capture', `raw packet recording started (${this.rawDir}, a ring of five 100 MB files)`, { level: 'info' })
		return { ok: true }
	}
	stopRaw() {
		this.rawWanted = false
		this.rawSince = 0
		const p = this.procs.raw
		if (p) {
			try {
				p.kill()
			} catch {}
			this.procs.raw = null
			this.event('capture', 'raw packet recording stopped', { level: 'info' })
		}
		return { ok: true }
	}
	rawFiles() {
		if (!this.rawDir) return []
		try {
			return fs
				.readdirSync(this.rawDir)
				.filter((f) => /\.pcapng?$/.test(f))
				.map((f) => {
					const st = fs.statSync(path.join(this.rawDir, f))
					return { name: f, size: st.size, mtime: st.mtimeMs }
				})
				.sort((a, b) => b.mtime - a.mtime)
				.slice(0, 40)
		} catch {
			return []
		}
	}

	get available() {
		return !!this.cfg.interface && !!this.targetIp && fs.existsSync(this.tshark)
	}
	get enabled() {
		return this.cfg.enabled !== false && this.available
	}

	// ------------------------------------------------------------------ process control
	start() {
		this.stopped = false
		if (!this.available) {
			this.stats.error = !this.cfg.interface ? 'no capture interface configured' : !this.targetIp ? 'no switcher IP' : `tshark not found at ${this.tshark}`
			return false
		}
		this.stats.error = null
		if (!this.exitHook) {
			// never leave tshark running when the server goes away
			this.exitHook = () => this.stop()
			process.once('exit', this.exitHook)
		}
		this.spawn('main', ['-i', this.cfg.interface, '-l', '-n', '-f', `host ${this.targetIp}`, '-T', 'fields', '-E', 'separator=/t', '-E', 'occurrence=a', '-E', 'aggregator=,', ...FIELDS.flatMap((f) => ['-e', f])], (line) => this.onPacket(line))
		this.spawn('hello', ['-i', this.cfg.interface, '-l', '-n', '-f', `udp port ${ATEM_PORT} and host ${this.targetIp} and less 100`, '-T', 'fields', '-E', 'separator=/t', ...HELLO_FIELDS.flatMap((f) => ['-e', f])], (line) => this.onHello(line))
		if (!this.timers.length) this.timers.push(setInterval(() => this.tick(), 1000))
		return true
	}

	spawn(name, args, onLine) {
		if (this.procs[name]) return
		let child
		try {
			child = spawn(this.tshark, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
		} catch (e) {
			this.stats.error = e.message
			return
		}
		this.procs[name] = child
		if (name === 'main') {
			this.stats.running = true
			this.stats.since = this.stats.since || Date.now()
		}
		const rl = readline.createInterface({ input: child.stdout })
		rl.on('line', (line) => {
			try {
				onLine(line)
			} catch (e) {
				this.log(`[forensics] ${e.message}`)
			}
		})
		let err = ''
		child.stderr.on('data', (d) => {
			err = (err + d.toString()).slice(-400)
			if (/could not|denied|no such|invalid|error|failed/i.test(d.toString()) && !/Capturing on/.test(d.toString())) this.stats.error = d.toString().trim().split('\n').pop()
		})
		child.on('exit', (code) => {
			this.procs[name] = null
			if (name === 'main') this.stats.running = false
			if (this.stopped || (name === 'raw' && !this.rawWanted)) return
			this.stats.failures = Date.now() - (this.lastStart || 0) < 20000 ? this.stats.failures + 1 : 0
			this.stats.error = this.stats.error || `tshark (${name}) exited with code ${code}`
			if (this.stats.failures >= 5) {
				this.log(`[forensics] giving up after ${this.stats.failures} failures: ${this.stats.error}`)
				return
			}
			this.stats.restarts++
			setTimeout(() => !this.stopped && this.spawn(name, args, onLine), 30000)
		})
		this.lastStart = Date.now()
	}

	stop() {
		this.stopped = true
		for (const [k, p] of Object.entries(this.procs)) {
			if (p) {
				try {
					p.kill()
				} catch {}
			}
			this.procs[k] = null
		}
		for (const t of this.timers) clearInterval(t)
		this.timers = []
		this.stats.running = false
		this.stats.since = 0
	}

	event(kind, text, extra = {}) {
		const ev = { id: ++this.seq, t: Date.now(), kind, text, ...extra }
		this.events.unshift(ev)
		if (this.events.length > MAX_EVENTS) this.events.length = MAX_EVENTS
		this.emit('event', ev)
	}

	// ------------------------------------------------------------------ packets
	onPacket(line) {
		const f = line.split('\t')
		if (f.length < FIELDS.length) return
		const [tsS, lenS, src, dst, protoS, tsp, tdp, usp, udp, syn, rst, fin, tcplen, protocol, info, amf, srtCtl, srtType, srtReq, srtVer, srtLat, srtSid, srtFail] = f
		if (!src || !dst) return
		const now = Math.round(parseFloat(tsS) * 1000) || Date.now()
		this.stats.packets++
		this.stats.lastPacket = now
		const b = this.secondBucket
		const sec = Math.floor(now / 1000)
		if (b.t !== sec) {
			this.stats.pps = b.t ? b.n : 0
			b.t = sec
			b.n = 0
		}
		b.n++
		const out = src === this.targetIp // out of the switcher
		const peer = out ? dst : src
		if (isMulticast(dst) || isMulticast(peer)) return // flooded multicast is not a flow into the switcher
		const proto = protoS === '6' ? 'TCP' : protoS === '17' ? 'UDP' : 'IP' + protoS
		const targetPort = num(out ? tsp || usp : tdp || udp)
		const peerPort = num(out ? tdp || udp : tsp || usp)
		const len = num(lenS)
		if (proto === 'UDP' && (targetPort === ATEM_PORT || peerPort === ATEM_PORT)) return this.onSessionPacket(peer, peerPort, out, len, now)
		const key = `${peer}|${proto}|${targetPort}|${peerPort}`
		let fl = this.flows.get(key)
		if (!fl) {
			// who opened it: the first packet's direction, or a well-known port on the peer's side (the switcher
			// itself talks to the cloud on 443)
			const outbound = out && (peerPort < 1024 || peerPort === 1935 || peerPort === 9710 || targetPort >= 1024)
			fl = { key, peer, name: this.nameFor(peer) || null, proto, targetPort, peerPort, outbound, app: appName(protocol, targetPort, peerPort, proto), first: now, last: now, pktsIn: 0, pktsOut: 0, bytesIn: 0, bytesOut: 0, win: [], state: proto === 'TCP' ? 'opening' : 'active', rtmp: null, srt: null, detail: '' }
			this.flows.set(key, fl)
			if (this.flows.size > MAX_FLOWS) this.flows.delete(this.flows.keys().next().value)
			if (!outbound && (proto === 'TCP' ? syn === '1' || syn === 'True' : true)) this.event('flow', `${proto} ${fl.app} from ${fl.name || peer} to the switcher's port ${targetPort}`, { peer, key })
		}
		fl.last = now
		if (out) {
			fl.pktsOut++
			fl.bytesOut += len
		} else {
			fl.pktsIn++
			fl.bytesIn += len
		}
		bucket(fl, now, out, len)
		if (fl.app === 'other' && protocol && protocol !== 'TCP' && protocol !== 'UDP') fl.app = appName(protocol, targetPort, peerPort)
		if (proto === 'TCP') {
			const isSyn = syn === '1' || syn === 'True'
			const isRst = rst === '1' || rst === 'True'
			const isFin = fin === '1' || fin === 'True'
			if (isSyn && !out) fl.synAt = fl.synAt || now
			if (isSyn && out) fl.state = 'established'
			else if (!isSyn && fl.state === 'opening' && (num(tcplen) > 0 || fl.pktsOut > 2)) fl.state = 'established'
			if (isRst || (isFin && fl.state !== 'closed' && !/reset|rejected/.test(fl.state))) {
				const secs = Math.round((now - fl.first) / 1000)
				const stage = fl.rtmp?.publish ? `after publish ${maskKey(fl.rtmp.publish)}` : fl.rtmp?.app ? `after connect('${fl.rtmp.app}')` : fl.rtmp ? 'after the handshake' : ''
				// an RTMP sender that the switcher cuts off before NetStream.Publish.Start was turned away: wrong key,
				// wrong app, a format it does not take, or the remote source is off (the sender just sees "I/O error")
				const turnedAway = out && fl.app === 'RTMP' && !fl.outbound && fl.state !== 'streaming'
				fl.endedAt = now
				if (turnedAway) {
					fl.state = 'rejected'
					fl.detail = [fl.detail, isRst ? 'reset by the switcher' : 'closed by the switcher before any publish was accepted'].filter(Boolean).join(' · ')
					this.event('reject', `the switcher ${isRst ? 'reset' : 'closed'} the RTMP connection from ${fl.name || peer} ${stage} without accepting a publish (${secs} s in): wrong stream key or app, an unsupported format, or the remote source is off`, { peer, key, level: 'warn' })
				} else if (isRst) {
					fl.state = out ? 'reset by the switcher' : 'reset by the sender'
					if (!fl.outbound) this.event(out ? 'reject' : 'end', out ? `the switcher reset the ${fl.app} connection from ${fl.name || peer} ${stage} (${secs} s in)` : `${fl.name || peer} reset its ${fl.app} connection to the switcher`, { peer, key, level: out ? 'warn' : 'info' })
				} else {
					fl.state = 'closed'
					if (!fl.outbound && (fl.app === 'RTMP' || fl.app === 'SRT' || fl.pktsIn > 50)) this.event('end', `${fl.app} connection from ${fl.name || peer} closed${out ? ' by the switcher' : ''} after ${secs} s${fl.state === 'streaming' ? ' of streaming' : ''}`, { peer, key })
				}
			}
		}
		// RTMP: the Info column carries the commands (several per packet, "|"-separated) and the AMF strings carry
		// the connect object
		if (info && /(^|\| ?)(connect|publish|play|createStream|deleteStream|onStatus|_result|_error|FCPublish|releaseStream)\(/.test(info)) for (const part of info.split('|')) this.onRtmp(fl, part.trim(), amf, out, now)
		else if (info && /Handshake C0/.test(info) && !fl.rtmp) {
			fl.rtmp = { handshakeAt: now }
			fl.app = 'RTMP'
		}
		// SRT: control packets carry the handshake
		if (srtCtl === '1' || srtCtl === 'True') this.onSrt(fl, { type: srtType, req: srtReq, ver: srtVer, lat: srtLat, sid: srtSid, fail: srtFail }, out, now)
		else if (srtCtl === '0' || srtCtl === 'False') {
			fl.app = 'SRT'
			if (!out && fl.state !== 'streaming') fl.state = 'streaming'
		}
	}

	onRtmp(fl, info, amf, out, now) {
		fl.app = 'RTMP'
		const r = (fl.rtmp = fl.rtmp || {})
		let m
		if ((m = info.match(/^connect\('([^']*)'\)/))) {
			r.app = m[1]
			const strings = String(amf || '').split(',')
			const i = strings.indexOf('tcUrl')
			if (i >= 0 && strings[i + 1]) r.tcUrl = strings[i + 1]
			const fv = strings.indexOf('flashVer')
			if (fv >= 0 && strings[fv + 1]) r.encoder = strings[fv + 1]
			r.connectAt = now
			this.event('rtmp', `RTMP connect from ${fl.name || fl.peer}: app '${r.app}'${r.tcUrl ? ' · ' + r.tcUrl : ''}${r.encoder ? ' · ' + r.encoder : ''}`, { peer: fl.peer, key: fl.key })
		} else if ((m = info.match(/^publish\('([^']*)'\)/))) {
			r.publish = m[1]
			r.publishAt = now
			fl.state = 'publishing'
			this.event('rtmp', `RTMP publish from ${fl.name || fl.peer}: stream key ${maskKey(r.publish)} (app '${r.app || '?'}')`, { peer: fl.peer, key: fl.key })
		} else if ((m = info.match(/^play\('([^']*)'\)/))) {
			r.play = m[1]
			this.event('rtmp', `RTMP play from ${fl.name || fl.peer}: ${maskKey(r.play)}`, { peer: fl.peer, key: fl.key })
		} else if ((m = info.match(/^onStatus\('([^']*)'\)/))) {
			r.status = m[1]
			r.statusAt = now
			const bad = /Fail|Reject|BadName|Denied|Error/i.test(m[1])
			if (bad) fl.state = 'rejected'
			else if (/Publish\.Start/.test(m[1])) fl.state = 'streaming'
			this.event(bad ? 'reject' : 'rtmp', `the switcher answered ${fl.name || fl.peer}: ${m[1]}${r.publish ? ' for stream ' + maskKey(r.publish) : ''}`, { peer: fl.peer, key: fl.key, level: bad ? 'warn' : 'info' })
		} else if ((m = info.match(/^_result\('([^']*)'\)/))) {
			if (/Connect/.test(m[1])) r.connectResult = m[1]
		} else if ((m = info.match(/^_error\('([^']*)'\)/))) {
			r.status = m[1]
			fl.state = 'rejected'
			this.event('reject', `the switcher refused ${fl.name || fl.peer}: ${m[1]}`, { peer: fl.peer, key: fl.key, level: 'warn' })
		}
		fl.detail = [r.app ? `app '${r.app}'` : '', r.publish ? `publish ${maskKey(r.publish)}` : '', r.status || r.connectResult || '', r.encoder || ''].filter(Boolean).join(' · ')
	}

	onSrt(fl, s, out, now) {
		fl.app = 'SRT'
		const r = (fl.srt = fl.srt || {})
		if (num(s.type) === 0) {
			r.version = s.ver || r.version
			r.reqtype = SRT_REQ[s.req] || s.req || r.reqtype
			if (s.lat) r.latency = num(s.lat)
			if (s.sid) r.streamId = s.sid
			if (s.fail && num(s.fail)) {
				r.fail = s.fail
				fl.state = 'rejected'
				this.event('reject', `SRT handshake with ${fl.name || fl.peer} failed (code ${s.fail})`, { peer: fl.peer, key: fl.key, level: 'warn' })
			} else if (!r.announced || r.reqtype === 'conclusion') {
				r.announced = true
				this.event('srt', `SRT handshake ${r.reqtype || ''} ${out ? 'from the switcher to' : 'from'} ${fl.name || fl.peer}${r.version ? ' · v' + r.version : ''}${r.latency ? ' · latency ' + r.latency + ' ms' : ''}${r.streamId ? ' · stream id ' + maskKey(r.streamId) : ''}`, { peer: fl.peer, key: fl.key })
			}
			if (fl.state === 'active' || fl.state === 'opening') fl.state = 'handshake'
		} else if (num(s.type) === 5) {
			fl.state = 'closed'
			fl.endedAt = now
			this.event('end', `SRT shutdown ${out ? 'by the switcher' : 'by ' + (fl.name || fl.peer)}`, { peer: fl.peer, key: fl.key })
		}
		fl.detail = ['SRT', r.version ? 'v' + r.version : '', r.latency ? r.latency + ' ms latency' : '', r.streamId ? 'id ' + maskKey(r.streamId) : '', r.fail ? 'failed ' + r.fail : ''].filter(Boolean).join(' · ')
	}

	// ATEM control traffic (UDP 9910): one record per client socket (a host running two controllers holds two)
	onSessionPacket(peer, peerPort, out, len, now) {
		const id = `${peer}:${peerPort}`
		let s = this.sessions.get(id)
		if (!s) {
			s = { id, ip: peer, port: peerPort, name: this.nameFor(peer) || null, first: now, last: now, pktsIn: 0, pktsOut: 0, win: [], hello: null, state: 'new', heldSince: 0, lastHeld: 0 }
			this.sessions.set(id, s)
		}
		s.last = now
		if (out) {
			s.pktsOut++
			s.lastHeld = now // the switcher only talks to peers whose session it holds (or to answer a hello)
		} else s.pktsIn++
		bucket(s, now, out, len)
	}

	onHello(line) {
		const [tsS, src, dst, sport, dport, hex] = line.split('\t')
		if (!hex || hex.length < 26) return
		const now = Math.round(parseFloat(tsS) * 1000) || Date.now()
		const flags = parseInt(hex.slice(0, 2), 16) & 0xf8
		if (!(flags & 0x10)) return // only hellos and hello replies
		const fromSwitcher = src === this.targetIp
		const peer = fromSwitcher ? dst : src
		const peerPort = num(fromSwitcher ? dport : sport)
		const id = `${peer}:${peerPort}`
		let s = this.sessions.get(id)
		if (!s) {
			s = { id, ip: peer, port: peerPort, name: this.nameFor(peer) || null, first: now, last: now, pktsIn: 0, pktsOut: 0, win: [], hello: null, state: 'new', heldSince: 0, lastHeld: 0 }
			this.sessions.set(id, s)
		}
		s.last = now
		if (!fromSwitcher) {
			s.hello = { t: now, code: null, text: 'hello sent' }
			s.hellos = (s.hellos || 0) + 1
			return
		}
		const code = parseInt(hex.slice(24, 26), 16)
		const text = code === 2 ? 'accepted' : code === 3 ? 'refused: too many clients' : `reply ${code}`
		s.hello = { t: now, code, text }
		if (code === 3) {
			s.refusedAt = now
			s.refusals = (s.refusals || 0) + 1
			this.event('refused', `the switcher refused a control connection from ${s.name || peer} (too many clients)`, { peer, level: 'warn' })
		} else if (code === 2) {
			s.acceptedAt = now
			this.event('session', `the switcher accepted a control connection from ${s.name || peer}`, { peer })
		}
	}

	// ------------------------------------------------------------------ housekeeping + snapshot
	tick() {
		const now = Date.now()
		for (const [k, fl] of this.flows) if (now - fl.last > KEEP_MS) this.flows.delete(k)
		for (const [k, s] of this.sessions) if (now - s.last > KEEP_MS) this.sessions.delete(k)
		if (this.sessions.size > MAX_SESSIONS) for (const k of [...this.sessions.keys()].slice(0, this.sessions.size - MAX_SESSIONS)) this.sessions.delete(k)
		for (const [, s] of this.sessions) {
			const held = now - s.lastHeld < 4000 && rate(s, now).out >= 0.5
			const prev = s.state
			if (held) {
				if (!s.heldSince || prev !== 'held') s.heldSince = s.heldSince && prev === 'held' ? s.heldSince : now
				s.state = 'held'
			} else if (s.refusedAt && now - s.refusedAt < 180000 && !s.acceptedAt) s.state = 'refused'
			else if (now - s.last > 20000) s.state = 'gone'
			else if (prev === 'held') s.state = 'gone'
			else s.state = s.state === 'new' ? 'connecting' : s.state
			if (prev === 'held' && s.state !== 'held') this.event('session', `${s.name || s.ip} no longer holds a control connection (held ${Math.round((now - s.heldSince) / 60000)} min)`, { peer: s.ip })
			else if (prev !== 'held' && s.state === 'held' && prev !== 'new') this.event('session', `${s.name || s.ip} holds a control connection with the switcher`, { peer: s.ip })
			if (!s.name) s.name = this.nameFor(s.ip) || null
		}
		for (const fl of this.flows.values()) {
			if (fl.state === 'opening' && fl.synAt && now - fl.synAt > 3000 && fl.pktsOut === 0) {
				fl.state = 'no answer'
				this.event('reject', `no answer from the switcher's port ${fl.targetPort} for ${fl.name || fl.peer} (${fl.app})`, { peer: fl.peer, key: fl.key, level: 'warn' })
				fl.synAt = 0
			}
			if (!fl.name) fl.name = this.nameFor(fl.peer) || null
		}
	}

	sessionView(s, now) {
		const r = rate(s, now)
		return { id: s.id, ip: s.ip, port: s.port, name: s.name, state: s.state, since: s.heldSince || s.first, first: s.first, last: s.last, pps: Math.round((r.in + r.out) * 10) / 10, pktsIn: s.pktsIn, pktsOut: s.pktsOut, hello: s.hello, refusals: s.refusals || 0, hellos: s.hellos || 0, acceptedAt: s.acceptedAt || null, refusedAt: s.refusedAt || null }
	}
	flowView(fl, now) {
		const r = rate(fl, now)
		return { key: fl.key, peer: fl.peer, name: fl.name, proto: fl.proto, app: fl.app, outbound: !!fl.outbound, targetPort: fl.targetPort, peerPort: fl.peerPort, first: fl.first, last: fl.last, endedAt: fl.endedAt || null, state: fl.state, bytesIn: fl.bytesIn, bytesOut: fl.bytesOut, pktsIn: fl.pktsIn, pktsOut: fl.pktsOut, inMbps: Math.round((r.bin * 8) / 1e5) / 10, outMbps: Math.round((r.bout * 8) / 1e5) / 10, detail: fl.detail, rtmp: fl.rtmp ? { app: fl.rtmp.app, publish: maskKey(fl.rtmp.publish), status: fl.rtmp.status || fl.rtmp.connectResult, tcUrl: fl.rtmp.tcUrl, encoder: fl.rtmp.encoder, connectAt: fl.rtmp.connectAt || null, publishAt: fl.rtmp.publishAt || null } : null, srt: fl.srt ? { version: fl.srt.version, latency: fl.srt.latency, streamId: maskKey(fl.srt.streamId), reqtype: fl.srt.reqtype, fail: fl.srt.fail } : null, live: now - fl.last < 10000 && !/reset|closed|rejected|no answer/.test(fl.state) }
	}
	header() {
		return { enabled: this.enabled, available: this.available, running: this.stats.running, interface: this.cfg.interface, tshark: this.tshark, since: this.stats.since, pps: this.stats.pps, packets: this.stats.packets, lastPacket: this.stats.lastPacket, error: this.stats.error, restarts: this.stats.restarts, target: this.targetIp, raw: { running: !!this.procs.raw, wanted: this.rawWanted, since: this.rawSince, dir: this.rawDir, files: this.rawFiles() }, totals: { sessions: this.sessions.size, flows: this.flows.size, events: this.events.length } }
	}

	// the light view for the state (recent sessions, the most telling flows, the latest events)
	snapshot({ flows: nFlows = 40, events: nEvents = 60 } = {}) {
		const now = Date.now()
		const sessions = [...this.sessions.values()]
			.filter((s) => now - s.last < 3600000)
			.map((s) => this.sessionView(s, now))
			.sort((a, b) => (a.state === 'held' ? 0 : 1) - (b.state === 'held' ? 0 : 1) || a.ip.localeCompare(b.ip) || b.last - a.last)
		const flows = [...this.flows.values()]
			.filter((fl) => now - fl.last < 1800000)
			.sort((a, b) => Number(!!b.rtmp || !!b.srt) - Number(!!a.rtmp || !!a.srt) || b.last - a.last)
			.slice(0, nFlows)
			.map((fl) => this.flowView(fl, now))
		return { ...this.header(), sessions, held: sessions.filter((s) => s.state === 'held').length, flows, events: this.events.slice(0, nEvents) }
	}

	// everything the session holds, newest first, optionally narrowed: q = text in any field, kind = sessions|flows|events,
	// since = ms, state = part of a flow/session state ("rejected", "held", "streaming"…)
	full({ q = '', kind = null, since = 0, state = '' } = {}) {
		const now = Date.now()
		const needle = String(q || '').trim().toLowerCase()
		const hit = (o) => !needle || JSON.stringify(o).toLowerCase().includes(needle)
		const st = String(state || '').toLowerCase()
		const sessions = !kind || kind === 'sessions' ? [...this.sessions.values()].filter((s) => s.last >= since).map((s) => this.sessionView(s, now)).filter((s) => hit(s) && (!st || String(s.state).includes(st))).sort((a, b) => b.last - a.last) : []
		const flows = !kind || kind === 'flows' ? [...this.flows.values()].filter((f) => f.last >= since).map((f) => this.flowView(f, now)).filter((f) => hit(f) && (!st || String(f.state).includes(st))).sort((a, b) => b.last - a.last) : []
		const events = !kind || kind === 'events' ? this.events.filter((e) => e.t >= since && hit(e) && (!st || String(e.kind).includes(st) || String(e.level || '').includes(st))) : []
		return { ...this.header(), sessions, flows, events, filtered: { q: needle, kind, since, state: st } }
	}
}

// what the dissector calls it, or the port
function appName(protocol, targetPort, peerPort, proto) {
	const p = String(protocol || '').toUpperCase()
	if (/RTMP/.test(p)) return 'RTMP'
	if (/SRT/.test(p)) return 'SRT'
	if (/TLS|SSL/.test(p) || targetPort === 443 || peerPort === 443) return 'HTTPS'
	if (/HTTP/.test(p) || targetPort === 80) return 'HTTP'
	if (targetPort === 1935 || peerPort === 1935) return proto === 'UDP' ? 'UDP 1935' : 'RTMP'
	if (/DNS|NTP|MDNS|SSDP/.test(p)) return p
	return p && p !== 'TCP' && p !== 'UDP' ? p : `${proto || 'IP'} ${targetPort}`
}

// per-second buckets (last 8 s) for rates
function bucket(rec, now, out, len) {
	const sec = Math.floor(now / 1000)
	let b = rec.win[rec.win.length - 1]
	if (!b || b.t !== sec) {
		b = { t: sec, in: 0, out: 0, bin: 0, bout: 0 }
		rec.win.push(b)
		if (rec.win.length > 8) rec.win.shift()
	}
	if (out) {
		b.out++
		b.bout += len
	} else {
		b.in++
		b.bin += len
	}
}
function rate(rec, now) {
	const sec = Math.floor(now / 1000)
	const recent = rec.win.filter((b) => sec - b.t <= 3 && b.t < sec) // the last three complete seconds
	const n = Math.max(1, recent.length)
	return { in: recent.reduce((s, b) => s + b.in, 0) / n, out: recent.reduce((s, b) => s + b.out, 0) / n, bin: recent.reduce((s, b) => s + b.bin, 0) / n, bout: recent.reduce((s, b) => s + b.bout, 0) / n }
}
