// Read-only clients for the Blackmagic ATEM protocol (UDP 9910).
//  - readAtem(): one-shot: says hello, acknowledges the initial state dump, returns product, firmware,
//    program/preview, input names and the streaming state (StRS/SRSS/SRSU), then lets the session time out.
//    Test scripts only: the switcher keeps the abandoned session for ~2 minutes.
//  - AtemClient: a persistent session that keeps acknowledging the switcher's packets, so it uses exactly
//    ONE of the switcher's control-connection slots for as long as Broadwatch runs (a new hello every few
//    seconds would leave abandoned sessions behind until the switcher expires them, and the HD8 / Minis
//    only have a handful of slots that Companion and ATEM Software Control need).
//
// Slot rules (measured on the HD8, 2026-10-19): a dead or half-open session is kept for ~2 minutes; the HD8
// was full with three held sessions (Companion, ATEM Software Control, the NDI Machine bridge). So:
//  * never more than one hello per two minutes per switcher, whatever happens;
//  * when the switcher answers "too many clients", back off further (2, 4, 8, 15 min) instead of knocking
//    every two minutes and snatching the slot a human controller is waiting for;
//  * the app reads the switcher through Companion by default and only opens its own session on request.
import dgram from 'node:dgram'
import { EventEmitter } from 'node:events'

const FLAG_ACKREQ = 0x08
const FLAG_HELLO = 0x10
const FLAG_ACK = 0x80
const HELLO = Buffer.from([0x10, 0x14, 0x53, 0xab, 0, 0, 0, 0, 0, 0x3a, 0, 0, 0x01, 0, 0, 0, 0, 0, 0, 0])
const STREAM_STATE = { 1: 'idle', 2: 'connecting', 4: 'streaming', 32: 'stopping' }
// Recording, laid out as atem-connection reads it (protocol 8.1.1+; the HD8 ISO on 2.32 sends the same lengths):
//  RTMS 8 B: status word u16 @0 (bit 0 = recording, bit 7 = stopping; the HD8 shows 2 while idle), error word u16 @2
//            (no media 2, media full 4, media error 8, unformatted 16, dropping frames 32, unknown 0x8000; the HD8
//            puts other values there while idle, so only a word made of those bits is read as an error), seconds of
//            recording time left on the working set u32 @4;
//  RTMD 76 B: one per disk: id u32 @0, status u32 @4 (idle 1, unformatted 2, active 4, recording 8, removed 32),
//            seconds left on that disk u32 @8, volume name @12 (64);
//  RMSu 140 B: file name @0 (128), working-set disk ids u32 @128 and @132, record in all cameras (ISO) u8 @136;
//  RTMR 8 B: duration hh:mm:ss:ff + drop-frame flag (RMRD has the same length and is kept raw until its meaning is known).
// Until 0.14.0 the status word 2 was read as "recording" and the duration stood in for the time left.
const RECORD_ERRORS = [[2, 'no media'], [4, 'media full'], [8, 'media error'], [16, 'media unformatted'], [32, 'dropping frames'], [0x8000, 'unknown error']]
const DISK_STATUS = [[1, 'idle'], [2, 'unformatted'], [4, 'active'], [8, 'recording'], [32, 'removed']]
const bits = (table, word) => table.filter(([bit]) => word & bit).map(([, name]) => name)
const hms = (s) => (s === null || s === undefined || !Number.isFinite(s) ? null : `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`)
const recState = (d) => d.rec || (d.rec = { status: null, disks: new Map(), settings: null, duration: null, rmrd: null })
// the recording object the rest of the app reads (telemetry.recording): the state, the disk being written and every disk
export function recordingView(d) {
	const r = d.rec
	if (!r || (!r.status && !r.disks.size)) return null
	const st = r.status || { raw: null, active: false, stopping: false, errorRaw: 0, errors: [], remainingS: null, t: null }
	const set = r.settings?.workingSet || []
	const disks = [...r.disks.values()].filter((x) => !x.removed).map((x) => ({ ...x, inWorkingSet: set.length ? set.includes(x.id) : null, remaining: hms(x.remainingS) }))
	const working = set.length ? disks.filter((x) => x.inWorkingSet) : disks
	const target = working.find((x) => x.recording) || working.find((x) => x.active) || working[0] || disks.find((x) => x.recording) || null
	const active = st.active || disks.some((x) => x.recording)
	const remainingS = target ? target.remainingS : st.remainingS
	return {
		state: st.stopping ? 'stopping' : active ? 'recording' : 'idle',
		active,
		stopping: st.stopping,
		raw: st.raw,
		error: st.errors.length ? st.errors.join(', ') : null,
		errorRaw: st.errorRaw,
		remainingS,
		remaining: hms(remainingS),
		disk: target?.name || null,
		disks,
		filename: r.settings?.filename || null,
		allCameras: r.settings ? r.settings.recordInAllCameras : null,
		duration: r.duration?.text || null,
		dropFrame: r.duration ? r.duration.dropFrame : null,
		durationRaw: r.duration?.raw || null,
		rmrd: r.rmrd,
		t: st.t,
	}
}
const REFUSED_BACKOFF_MS = [120000, 240000, 480000, 900000]
const LEVELS_RESEND_MS = 10000 // the switcher stops streaming levels after a while unless asked again
const LEVELS_STALE_MS = 3000
// Fairlight audio input ids that are not video inputs (best effort: the official SDK numbers; the names of the
// SDI/HDMI inputs come from InPr). Only used when Broadwatch holds its own session (atem.session = "own").
const AUDIO_INPUT_NAMES = { 1001: 'XLR 1', 1002: 'XLR 2', 1101: 'AES/EBU', 1201: 'RCA', 1301: 'Mic 1', 1302: 'Mic 2', 1401: 'MADI', 1501: 'TRS', 2001: 'Media Player 1', 2002: 'Media Player 2', 2003: 'Media Player 3', 2004: 'Media Player 4', 3001: 'Talkback' }
// Fairlight level values are int16 hundredths of a dB; -10000 and below mean silence
const lvlDb = (b, off) => (b.length >= off + 2 ? Math.max(-100, b.readInt16BE(off) / 100) : null)

const cstr = (b, off, len) => {
	const s = b.subarray(off, Math.min(b.length, off + len))
	const z = s.indexOf(0)
	return s.toString('utf8', 0, z < 0 ? s.length : z)
}
const tc = (h, m, s, f) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${f !== undefined ? ':' + String(f).padStart(2, '0') : ''}`

// a human-readable breakdown of an undocumented command body: hex, printable text, the small integers at the
// usual alignments, IPv4-looking byte runs and C strings. Used for the remote-source commands (RSDs RSis RSpr RSca)
// whose layout is not public; the capture view shows these so the layout can be worked out from live changes.
export function decodeBody(body) {
	const b = Buffer.from(body)
	const u16 = []
	for (let i = 0; i + 2 <= b.length && u16.length < 24; i += 2) u16.push(b.readUInt16BE(i))
	const u32 = []
	for (let i = 0; i + 4 <= b.length && u32.length < 12; i += 4) u32.push(b.readUInt32BE(i))
	const strings = []
	let run = ''
	let runAt = 0
	for (let i = 0; i <= b.length; i++) {
		const c = i < b.length ? b[i] : 0
		if (c >= 0x20 && c < 0x7f) {
			if (!run) runAt = i
			run += String.fromCharCode(c)
		} else {
			if (run.length >= 3) strings.push({ at: runAt, text: run })
			run = ''
		}
	}
	const ipv4 = []
	for (let i = 0; i + 4 <= b.length; i++) {
		const a = b[i]
		if ((a === 10 || a === 192 || a === 172 || (a >= 100 && a <= 223)) && b[i + 1] !== 0 && (b[i + 3] !== 0 || b[i + 2] !== 0)) {
			const s = `${b[i]}.${b[i + 1]}.${b[i + 2]}.${b[i + 3]}`
			if (/^(10|192\.168|172\.(1[6-9]|2\d|3[01])|207\.180)\./.test(s)) ipv4.push({ at: i, ip: s })
		}
	}
	return { len: b.length, hex: b.toString('hex').replace(/(..)/g, '$1 ').trim(), ascii: b.toString('latin1').replace(/[^\x20-\x7e]/g, '.'), u16, u32, strings, ipv4 }
}

export function decodeKnown(name, body, d) {
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
		case 'SRST': // streaming duration hh:mm:ss:ff (+ drop-frame flag)
			d.streaming = { ...(d.streaming || {}), duration: tc(body[0], body[1], body[2], body[3]), durationRaw: body.subarray(0, 8).toString('hex') }
			break
		case 'STAB': // audio bitrates (low / high quality)
			d.streaming = { ...(d.streaming || {}), audioBitrateLow: body.readUInt32BE(0), audioBitrateHigh: body.length >= 8 ? body.readUInt32BE(4) : null }
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
		case 'RTMS': {
			if (body.length < 4) return false
			const raw = body.readUInt16BE(0)
			const errorRaw = body.readUInt16BE(2)
			recState(d).status = { raw, active: !!(raw & 1), stopping: !!(raw & 0x80), errorRaw, errors: (errorRaw & ~0x803e) === 0 ? bits(RECORD_ERRORS, errorRaw) : [], remainingS: body.length >= 8 ? body.readUInt32BE(4) : null, t: Date.now() }
			d.recording = recordingView(d)
			break
		}
		case 'RTMD': {
			if (body.length < 12) return false
			const id = body.readUInt32BE(0)
			const status = body.readUInt32BE(4)
			recState(d).disks.set(id, { id, statusRaw: status, status: bits(DISK_STATUS, status).join(' ') || `status ${status}`, active: !!(status & 4), recording: !!(status & 8), unformatted: !!(status & 2), removed: !!(status & 32), remainingS: body.readUInt32BE(8), name: cstr(body, 12, 64) || `disk ${id}` })
			d.recording = recordingView(d)
			break
		}
		case 'RMSu':
			if (body.length < 136) return false
			recState(d).settings = { filename: cstr(body, 0, 128), workingSet: [body.readUInt32BE(128), body.readUInt32BE(132)].filter((x) => x !== 0 && x !== 0xffffffff), recordInAllCameras: body.length > 136 ? body[136] !== 0 : null }
			d.recording = recordingView(d)
			break
		case 'RTMR': // record duration hh:mm:ss:ff (+ drop-frame flag)
			if (body.length < 5) return false
			recState(d).duration = { text: tc(body[0], body[1], body[2], body[3]), dropFrame: !!body[4], raw: body.subarray(0, 8).toString('hex') }
			d.recording = recordingView(d)
			break
		case 'RMRD': // same length as RTMR; kept raw until a live recording shows what it carries
			recState(d).rmrd = body.subarray(0, 8).toString('hex')
			d.recording = recordingView(d)
			break
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
		default:
			return false
	}
	return true
}

export function readAtem(ip, { port = 9910, timeoutMs = 6000, capture = [] } = {}) {
	const want = capture instanceof RegExp ? (n) => capture.test(n) : (n) => capture.includes(n)
	return new Promise((resolve) => {
		const sock = dgram.createSocket('udp4')
		const t0 = Date.now()
		let done = false
		const result = { ok: false, ms: 0, product: null, version: null, streaming: null, recording: null, inputs: {}, program: null, preview: null, commands: 0, unknown: [], seen: {}, raw: {} }
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
			result.seen[name] = (result.seen[name] || 0) + 1
			if (want(name)) (result.raw[name] = result.raw[name] || []).push(Buffer.from(body))
			try {
				if (name === 'InCm') return finish(true)
				if (!decodeKnown(name, body, result) && result.unknown.length < 300 && !result.unknown.includes(name)) result.unknown.push(name)
			} catch {}
		}
		send(HELLO)
	})
}

export class AtemClient extends EventEmitter {
	constructor(ip, { port = 9910, log = () => {}, capture = /^RS/ } = {}) {
		super()
		this.ip = ip
		this.port = port
		this.log = log
		this.sock = null
		this.state = 'idle' // idle | connecting | syncing | connected | refused | disconnected
		this.error = null
		this.data = { product: null, version: null, streaming: null, recording: null, inputs: {}, program: null, preview: null }
		this.lastPacket = 0
		this.lastHello = 0
		this.connectedAt = 0
		this.commands = 0
		this.timer = null
		this.retryAt = 0
		this.refusals = 0
		this.closed = false
		this.attempts = [] // timestamps of hellos we sent; never more than one per SLOT_HOLD_MS
		this.capture = capture instanceof RegExp ? (n) => capture.test(n) : Array.isArray(capture) ? (n) => capture.includes(n) : () => false
		this.raw = new Map() // command name -> [{t, body(Buffer), n}] the last distinct bodies (n = repeats of the same body)
		this.seen = new Map() // command name -> {n, last, len}
		// Fairlight levels: the switcher streams FMLv (one per input) and FDLv (master) at ~10 Hz once asked with SFLN.
		// Off by default: only an own session can ask, and only atem.session = "own" turns it on (never Companion).
		this.wantsLevels = false
		this.levelsSentAt = 0
		this.sid = 0 // the session id the switcher assigned (needed to send it a command)
		this.pid = 0 // our packet counter
		this.levels = { t: 0, master: null, sources: new Map(), inputs: new Map() }
	}

	// ask the switcher for Fairlight levels (or stop asking); needs a held session, re-sent every 10 s
	wantLevels(on) {
		on = !!on
		if (on === this.wantsLevels) return
		this.wantsLevels = on
		if (this.state === 'connected') this.sendLevelsRequest(on)
		if (!on) this.levels = { t: 0, master: null, sources: new Map(), inputs: this.levels.inputs }
	}

	sendLevelsRequest(on) {
		this.levelsSentAt = Date.now()
		this.sendCommand('SFLN', Buffer.from([on ? 1 : 0, 0, 0, 0]))
	}

	// one command to the switcher in an AckRequest packet (the switcher acknowledges it; we do not retransmit,
	// the levels request is simply repeated every ten seconds)
	sendCommand(name, body) {
		if (!this.sock || this.state !== 'connected') return false
		const len = 12 + 8 + body.length
		const b = Buffer.alloc(len)
		b.writeUInt16BE((FLAG_ACKREQ << 8) | len, 0)
		b.writeUInt16BE(this.sid, 2)
		this.pid = (this.pid + 1) & 0x7fff
		b.writeUInt16BE(this.pid, 10)
		b.writeUInt16BE(8 + body.length, 12)
		b.write(name, 16, 4, 'latin1')
		body.copy(b, 20)
		this.sock.send(b, this.port, this.ip, () => {})
		return true
	}

	handleLevels(name, body, now) {
		const L = this.levels
		if (name === 'FAIP' && body.length >= 8) {
			// Fairlight audio input properties: index, type (0 embedded with video, 1 media player, 2 external)
			L.inputs.set(body.readUInt16BE(0), { type: body[2], port: body.readUInt16BE(6) })
			return
		}
		// Read off the mirror port on the HD8 (protocol 2.32, 2026-10-20): FDLv is the MASTER, once per tick, 28 bytes;
		// FMLv is one message PER INPUT per tick, 40 bytes. Values are hundredths of dB, -10000 = nothing / no held peak.
		if (name === 'FDLv' && body.length >= 28) {
			// in L/R (the mix bus), in peaks, compressor, limiter, out L/R (after dynamics), out peaks, mix L/R (to program), mix peaks
			L.master = { t: now, inL: lvlDb(body, 0), inR: lvlDb(body, 2), peakL: lvlDb(body, 4), peakR: lvlDb(body, 6), compressor: lvlDb(body, 8), limiter: lvlDb(body, 10), outL: lvlDb(body, 12), outR: lvlDb(body, 14), outPeakL: lvlDb(body, 16), outPeakR: lvlDb(body, 18), left: lvlDb(body, 20), right: lvlDb(body, 22), mixPeakL: lvlDb(body, 24), mixPeakR: lvlDb(body, 26) }
			L.t = now
			return
		}
		if (name === 'FMLv' && body.length >= 40) {
			// 40 bytes: source id int64 at 0 (-65280 = the input's default source), input index u16 at 8, then from 10:
			// in L/R (pre-fader: what the input carries), in peaks, compressor, limiter, expander, out L/R (after dynamics),
			// out peaks, mix L/R (what reaches the program: -100 when the input is off), mix peaks.
			// The 46-byte layout of newer protocol versions keeps the index at 0 and starts the levels at 16.
			const wide = body.length >= 46
			const id = wide ? body.readUInt16BE(0) : body.readUInt16BE(8)
			const o = wide ? 16 : 10
			L.sources.set(id, { t: now, id, inL: lvlDb(body, o), inR: lvlDb(body, o + 2), peakL: lvlDb(body, o + 4), peakR: lvlDb(body, o + 6), compressor: lvlDb(body, o + 8), limiter: lvlDb(body, o + 10), expander: lvlDb(body, o + 12), outL: lvlDb(body, o + 14), outR: lvlDb(body, o + 16), outPeakL: lvlDb(body, o + 18), outPeakR: lvlDb(body, o + 20), left: lvlDb(body, o + 22), right: lvlDb(body, o + 24), mixPeakL: lvlDb(body, o + 26), mixPeakR: lvlDb(body, o + 28) })
			L.t = now
		}
	}

	// the levels as the state shows them: null until the switcher has sent any in the last three seconds
	levelsSnapshot() {
		const L = this.levels
		const now = Date.now()
		if (!this.wantsLevels || !L.t || now - L.t > LEVELS_STALE_MS) return null
		const label = (id) => this.data.inputs[id]?.long || AUDIO_INPUT_NAMES[id] || (id >= 1 && id < 1000 ? `Input ${id}` : `Audio input ${id}`)
		// the bar shows what the input carries (pre-fader), the held peak is the input's; "mix" is what reaches the
		// program (-100 when the input is off or the fader is down), "out" the level after the dynamics
		const pack = (s) => ({ level: Math.max(s.inL ?? -100, s.inR ?? -100), peak: Math.max(s.peakL ?? -100, s.peakR ?? -100), left: s.inL, right: s.inR, mix: Math.max(s.left ?? -100, s.right ?? -100), out: Math.max(s.outL ?? -100, s.outR ?? -100), compressor: s.compressor, limiter: s.limiter })
		const sources = [...L.sources.values()].filter((s) => now - s.t <= LEVELS_STALE_MS).sort((a, b) => a.id - b.id).map((s) => ({ id: s.id, label: label(s.id), type: L.inputs.get(s.id)?.type ?? null, ...pack(s) }))
		return { t: L.t, master: L.master && now - L.master.t <= LEVELS_STALE_MS ? pack(L.master) : null, sources }
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

	// a human asked for a connection: drop the long backoff, but never break the one-hello-per-two-minutes rule
	connectNow() {
		this.closed = false
		this.refusals = 0
		this.retryAt = 0
		this.ensure()
		return this.state === 'connecting' ? 'hello sent' : this.state === 'connected' ? 'already connected' : `next hello at ${new Date(this.retryAt).toLocaleTimeString()}`
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
		this.lastHello = now
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
			if (Date.now() - this.lastPacket > 8000) return this.fail(this.state === 'connecting' ? 'timeout' : 'lost', AtemClient.SLOT_HOLD_MS)
			if (this.wantsLevels && this.state === 'connected' && Date.now() - this.levelsSentAt > LEVELS_RESEND_MS) this.sendLevelsRequest(true)
		}, 2000)
	}

	onPacket(msg) {
		if (msg.length < 12) return
		this.lastPacket = Date.now()
		const flags = msg[0] & 0xf8
		const len = msg.readUInt16BE(0) & 0x07ff
		const sid = msg.readUInt16BE(2)
		const pid = msg.readUInt16BE(10)
		this.sid = sid
		if (flags & FLAG_HELLO) {
			const code = msg[12]
			if (code === 3) return this.fail('too many clients', 0, 'refused')
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
		const now = Date.now()
		const s = this.seen.get(name) || { n: 0, last: 0, len: body.length }
		s.n++
		s.last = now
		s.len = body.length
		this.seen.set(name, s)
		if (this.capture(name)) {
			const list = this.raw.get(name) || []
			const last = list[list.length - 1]
			if (last && last.body.equals(body)) last.n++
			else {
				list.push({ t: now, body: Buffer.from(body), n: 1 })
				if (list.length > 16) list.shift()
			}
			this.raw.set(name, list)
		}
		try {
			if (name === 'InCm') {
				if (this.state !== 'connected') {
					this.state = 'connected'
					this.connectedAt = now
					this.refusals = 0
					this.emit('connected')
					if (this.wantsLevels) this.sendLevelsRequest(true)
				}
			} else if (name === 'FDLv' || name === 'FMLv' || name === 'FAIP') this.handleLevels(name, body, now)
			else decodeKnown(name, body, this.data)
		} catch {}
		if (this.state === 'connected') this.emit('update', name)
	}

	fail(error, retryMs, state = 'disconnected') {
		const was = this.state
		this.teardown()
		this.state = state
		this.error = error
		this.levels = { t: 0, master: null, sources: new Map(), inputs: new Map() }
		if (error === 'too many clients') {
			// every refused hello is a knock on a full switcher: back off further each time so a human controller
			// that is waiting for a slot gets it before we do
			this.refusals++
			retryMs = REFUSED_BACKOFF_MS[Math.min(this.refusals, REFUSED_BACKOFF_MS.length) - 1]
		} else this.refusals = 0
		this.retryAt = Date.now() + Math.max(retryMs, 0)
		if (was === 'connected') this.emit('disconnected', error)
		else if (state === 'refused') this.emit('refused', error)
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

	// close our session on purpose; the switcher frees the slot about two minutes later
	close() {
		this.closed = true
		const was = this.state
		this.teardown()
		this.state = 'idle'
		if (was === 'connected') this.emit('released')
	}

	snapshot() {
		const d = this.data
		const live = this.state === 'connected'
		return {
			kind: 'atem',
			via: 'session',
			state: this.state,
			error: live ? null : this.error || (this.state === 'connecting' || this.state === 'syncing' ? 'connecting' : this.closed ? 'released' : 'not connected'),
			product: d.product,
			version: d.version,
			streaming: d.streaming,
			recording: d.recording,
			program: d.program,
			preview: d.preview,
			inputs: d.inputs,
			programName: d.inputs[d.program]?.long || null,
			previewName: d.inputs[d.preview]?.long || null,
			connectedAt: this.connectedAt,
			lastPacket: this.lastPacket,
			lastHello: this.lastHello,
			commands: this.commands,
			refusals: this.refusals,
			retryAt: this.state === 'connected' || this.closed ? null : this.retryAt,
			captured: [...this.raw.values()].reduce((n, l) => n + l.length, 0),
			wantsLevels: this.wantsLevels,
			levels: live ? this.levelsSnapshot() : null,
			summary: live ? `${d.product || 'ATEM'}${d.streaming?.state ? ' · stream ' + d.streaming.state : ''}${d.recording?.active ? ' · RECORDING' : ''}` : null,
		}
	}

	// the raw bodies of the captured (undocumented) commands, decoded as far as we can, plus the census of
	// every command name the switcher sent in this session
	captureReport() {
		return {
			ip: this.ip,
			state: this.state,
			product: this.data.product,
			version: this.data.version,
			connectedAt: this.connectedAt,
			commands: [...this.raw.entries()].map(([name, list]) => ({ name, total: this.seen.get(name)?.n || 0, samples: list.map((x) => ({ t: x.t, repeats: x.n, ...decodeBody(x.body) })) })),
			seen: [...this.seen.entries()].map(([name, s]) => ({ name, ...s })).sort((a, b) => b.n - a.n),
		}
	}
}
