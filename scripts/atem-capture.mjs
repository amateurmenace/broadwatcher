// One-shot capture of the HD8's remote-source commands (RSDs RSis RSpr RSca and anything else starting with RS)
// for working out their layout. Opens ONE short session with the switcher and lets it expire: the switcher
// keeps that dead session for about two minutes, so run this only when no show is on and no controller is
// waiting for a slot. Run it once while a remote stream is live and once while idle, then diff the two files.
//
//   node scripts/atem-capture.mjs [ip] [outfile]
//
// The running app captures the same commands continuously without any extra session (switcher inspector >
// Protocol capture) whenever it holds its own session (atem.session = "own" in config.json).
import fs from 'node:fs'
import { readAtem, decodeBody } from '../server/atem.js'

const ip = process.argv[2] || '192.168.20.79'
const out = process.argv[3] || `atem-capture-${ip.replace(/\./g, '-')}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
console.log(`hello ${ip} (one session, abandoned afterwards; the switcher frees the slot in ~2 min)`)
const r = await readAtem(ip, { capture: /^RS/, timeoutMs: 8000 })
if (!r.ok) {
	console.error(`no session: ${r.error}`)
	process.exit(1)
}
const report = {
	ip,
	t: new Date().toISOString(),
	product: r.product,
	version: r.version,
	program: r.program,
	preview: r.preview,
	streaming: r.streaming,
	recording: r.recording,
	commandsSeen: r.seen,
	captured: Object.fromEntries(Object.entries(r.raw).map(([name, bodies]) => [name, bodies.map(decodeBody)])),
}
fs.writeFileSync(out, JSON.stringify(report, null, 2))
console.log(`${r.product} v${r.version}: ${r.commands} commands, ${Object.keys(r.raw).length} captured command types -> ${out}`)
for (const [name, bodies] of Object.entries(r.raw)) {
	console.log(`\n${name} × ${bodies.length}`)
	for (const b of bodies.slice(0, 6)) {
		const d = decodeBody(b)
		console.log(`  ${d.len} B  ${d.hex}`)
		console.log(`        ${d.ascii}`)
		if (d.strings.length) console.log(`        strings: ${d.strings.map((s) => `@${s.at} "${s.text}"`).join('  ')}`)
		if (d.ipv4.length) console.log(`        ipv4: ${d.ipv4.map((s) => `@${s.at} ${s.ip}`).join('  ')}`)
	}
}
