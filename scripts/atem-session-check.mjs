// AtemClient against a fake switcher on localhost: no packet goes to a real ATEM. The fake treats commands the way the
// HD8 was measured to on 2026-11-03: strictly in order from id 1 of each session, and for anything else it asks for the
// id it is waiting for and acts on nothing. About a minute, because the client's real timers run.
//   node scripts/atem-session-check.mjs [path to another atem.js, to see an older client fail]
import dgram from 'node:dgram'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { AtemClient } = await import(pathToFileURL(process.argv[2] ? path.resolve(process.argv[2]) : path.join(here, '..', 'server', 'atem.js')).href)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (f, ms = 4000) => {
	const t0 = Date.now()
	while (Date.now() - t0 < ms) {
		if (f()) return true
		await sleep(20)
	}
	return !!f()
}
const FLAG = { ackReq: 0x08, hello: 0x10, resend: 0x40, ack: 0x80 }

function packet(flags, sid, { ack = 0, resend = 0, pid = 0, body = Buffer.alloc(0) } = {}) {
	const b = Buffer.alloc(12 + body.length)
	b.writeUInt16BE((flags << 8) | b.length, 0)
	b.writeUInt16BE(sid, 2)
	b.writeUInt16BE(ack, 4)
	b.writeUInt16BE(resend, 6)
	b.writeUInt16BE(pid, 10)
	body.copy(b, 12)
	return b
}
function command(name, body = Buffer.alloc(0)) {
	const b = Buffer.alloc(8 + body.length)
	b.writeUInt16BE(b.length, 0)
	b.write(name, 4, 4, 'latin1')
	body.copy(b, 8)
	return b
}

class FakeSwitcher {
	constructor() {
		this.sock = dgram.createSocket('udp4')
		this.sessions = 0
		this.client = null // {address, port}
		this.sid = 0
		this.pid = 0
		this.expected = 1 // the command id it is waiting for
		this.acted = [] // commands it acted on, this session: {id, name}
		this.seen = [] // every command packet that reached it, this session: {id, name}
		this.asked = [] // ids it asked for again, this session
		this.levelsOn = false
		this.levelMsgs = 0
		this.dropNext = 0 // lose the next commands on the way in
		this.deaf = false // takes no commands at all and acknowledges nothing
		this.silent = false // sends nothing: the session looks dead from the client
		this.sock.on('message', (m, r) => this.receive(m, r))
		this.tick = setInterval(() => this.keepAlive(), 100)
	}
	listen() {
		return new Promise((resolve) => this.sock.bind(0, '127.0.0.1', () => resolve(this.sock.address().port)))
	}
	send(b) {
		if (this.client && !this.silent) this.sock.send(b, this.client.port, this.client.address)
	}
	keepAlive() {
		if (!this.sid) return
		this.pid = (this.pid + 1) & 0x7fff
		const body = this.levelsOn ? Buffer.concat([command('Time', Buffer.alloc(8)), command('FDLv', Buffer.alloc(28))]) : command('Time', Buffer.alloc(8))
		if (this.levelsOn) this.levelMsgs++
		this.send(packet(FLAG.ackReq, this.sid, { pid: this.pid, body }))
	}
	receive(m, r) {
		const flags = m[0] & 0xf8
		if (flags & FLAG.hello) {
			this.client = { address: r.address, port: r.port }
			this.sessions++
			Object.assign(this, { sid: 0, pid: 0, expected: 1, acted: [], seen: [], asked: [], levelsOn: false, levelMsgs: 0, silent: false })
			const b = packet(FLAG.hello, 0x53ab, { body: Buffer.from([2, 0, 0, 0, 0, 0, 0, 0]) })
			return this.sock.send(b, r.port, r.address)
		}
		if (!this.sid && flags & FLAG.ack) {
			this.sid = 0x8000 + this.sessions
			this.pid = 1
			return this.send(packet(FLAG.ackReq, this.sid, { pid: 1, body: Buffer.concat([command('_ver', Buffer.alloc(4)), command('InCm', Buffer.alloc(4))]) }))
		}
		if (!(flags & FLAG.ackReq) || m.length <= 12) return
		const id = m.readUInt16BE(10)
		const name = m.toString('latin1', 16, 20)
		if (this.dropNext > 0) return void this.dropNext--
		this.seen.push({ id, name })
		if (this.deaf) return
		if (id === this.expected) {
			this.expected = (id + 1) & 0x7fff
			this.acted.push({ id, name })
			if (name === 'SFLN') this.levelsOn = m[20] === 1
			return this.send(packet(FLAG.ack, this.sid, { ack: id }))
		}
		if (((id - this.expected) & 0x7fff) < 0x4000) {
			// ahead of what it is waiting for: the answer measured on the HD8
			this.asked.push(this.expected)
			return this.send(packet(FLAG.resend, this.sid, { resend: this.expected }))
		}
		this.send(packet(FLAG.ack, this.sid, { ack: (this.expected - 1) & 0x7fff })) // a copy of something it has
	}
	close() {
		clearInterval(this.tick)
		this.sock.close()
	}
}

let failed = 0
const check = (ok, text) => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${text}`)
	if (!ok) failed++
}

/** a client on its own fake switcher, connected; levels asked for when `levels` */
async function connected({ levels = false } = {}) {
	const fake = new FakeSwitcher()
	const port = await fake.listen()
	const client = new AtemClient('127.0.0.1', { port })
	client.wantLevels(levels)
	client.ensure()
	await until(() => client.state === 'connected')
	return { fake, client }
}
// the two-minute rule between hellos is the client's own; the check has no two minutes to wait
const reconnectNow = (client) => {
	client.attempts = []
	client.retryAt = 0
	client.ensure()
}

{
	const { fake, client } = await connected({ levels: true })
	check(client.state === 'connected', 'a session opens')
	await until(() => fake.acted.length > 0)
	check(fake.acted[0]?.id === 1 && fake.acted[0]?.name === 'SFLN', 'its first command is SFLN with id 1, and the switcher acts on it')
	await until(() => fake.levelMsgs > 5)
	check(client.levels.t > 0, 'levels arrive')
	await sleep(13000)
	check(fake.seen.length === 1, `levels keep coming, so the request is not repeated (${fake.seen.length} sent in 13 s)`)

	// the bug: the switcher goes away and comes back while the client stays open
	const before = fake.seen.length
	fake.silent = true
	await until(() => client.state === 'disconnected', 12000)
	check(client.state === 'disconnected' && client.error === 'lost', 'silence for 8 s ends the session')
	reconnectNow(client)
	await until(() => fake.sessions === 2 && client.state === 'connected')
	check(fake.sessions === 2 && client.state === 'connected', 'it reconnects')
	await until(() => fake.seen.length > 0)
	check(fake.seen[0]?.id === 1, `the new session's first command has id 1 again (it had ${fake.seen[0]?.id}, ${before} sent before)`)
	await sleep(300)
	check(fake.asked.length === 0 && fake.acted.length === 1, 'the switcher acts on it and asks for nothing')
	await until(() => fake.levelMsgs > 5)
	check(fake.levelsOn && client.levels.t > 0, 'levels arrive on the new session')
	client.close()
	fake.close()
}
{
	const { fake, client } = await connected()
	fake.dropNext = 1
	client.sendCommand('TEST', Buffer.alloc(4))
	await until(() => fake.acted.length === 1, 6000)
	check(fake.acted.length === 1 && fake.acted[0].id === 1, 'a command lost on the way goes out again by itself and is acted on')
	await sleep(200)
	check(client.inFlight?.length === 0, 'and nothing is left waiting')
	client.close()
	fake.close()
}
{
	const { fake, client } = await connected()
	fake.dropNext = 1
	client.sendCommand('AAAA', Buffer.alloc(4)) // lost
	await sleep(50)
	client.sendCommand('BBBB', Buffer.alloc(4)) // the switcher sees a gap and asks for id 1
	await until(() => fake.acted.length === 2, 1000)
	check(fake.asked[0] === 1, 'a gap: the switcher asks for the missing id')
	check(fake.acted.map((c) => c.name).join() === 'AAAA,BBBB', 'the client answers at once, and the switcher acts on both, in order')
	client.close()
	fake.close()
}
{
	const { fake, client } = await connected()
	fake.send(packet(FLAG.resend, fake.sid, { resend: 77 }))
	await until(() => client.state !== 'connected', 1000)
	check(client.state === 'disconnected' && !client.sock, 'the switcher waits for a command the client does not hold: the session ends at once')
	client.close()
	fake.close()
}
{
	const { fake, client } = await connected()
	fake.deaf = true
	client.sendCommand('TEST', Buffer.alloc(4))
	await until(() => client.state !== 'connected', 16000)
	check(client.state === 'disconnected', 'a switcher that never acknowledges: the session ends')
	check(fake.seen.length <= 5, `after a few tries, not for ever (${fake.seen.length} copies)`)
	client.close()
	fake.close()
}
{
	const { fake, client } = await connected()
	fake.deaf = true
	let sent = 0
	for (let i = 0; i < 40; i++) if (client.sendCommand('TEST', Buffer.alloc(4))) sent++
	await sleep(100)
	check(sent <= 8, `commands waiting for an acknowledgement are capped (${sent} of 40 accepted)`)
	client.close()
	fake.close()
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
