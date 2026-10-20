// Blackmagic Videohub Ethernet protocol (TCP 9990), read-only: on connect the router sends its whole state as
// text blocks ("VIDEOHUB DEVICE:", "INPUT LABELS:", "OUTPUT LABELS:", "VIDEO OUTPUT ROUTING:", "VIDEO OUTPUT
// LOCKS:"); we read for a moment and hang up. Videohubs take many clients, so this costs nothing; the result
// is cached for 30 s per router.
import net from 'node:net'

const cache = new Map()

function parseBlocks(text) {
	const blocks = {}
	let cur = null
	for (const raw of text.split('\n')) {
		const line = raw.replace(/\r$/, '')
		if (/^[A-Z][A-Z /]+:$/.test(line)) {
			cur = line.slice(0, -1)
			blocks[cur] = []
		} else if (line.trim() === '') cur = null
		else if (cur) blocks[cur].push(line)
	}
	return blocks
}

export function readVideohub(ip, port = 9990, timeoutMs = 2500) {
	const c = cache.get(ip)
	if (c && Date.now() - c.t < 30000) return Promise.resolve(c.v)
	return new Promise((resolve) => {
		const sock = new net.Socket()
		let text = ''
		let done = false
		const finish = (v) => {
			if (done) return
			done = true
			try {
				sock.destroy()
			} catch {}
			if (v) cache.set(ip, { t: Date.now(), v })
			resolve(v)
		}
		const timer = setTimeout(() => finish(build(text)), timeoutMs)
		sock.setTimeout(timeoutMs, () => finish(build(text)))
		sock.on('data', (d) => {
			text += d.toString('latin1')
			// the dump ends with the locks block (or the routing block on old firmware): a blank line after it means done
			if (/VIDEO OUTPUT LOCKS:[\s\S]*?\n\n/.test(text) || text.length > 200000) {
				clearTimeout(timer)
				finish(build(text))
			}
		})
		sock.on('error', () => {
			clearTimeout(timer)
			finish(null)
		})
		sock.on('close', () => {
			clearTimeout(timer)
			finish(build(text))
		})
		sock.connect(port, ip)
	})
	function build(t) {
		if (!t || !/VIDEOHUB DEVICE:/.test(t)) return null
		const b = parseBlocks(t)
		const kv = Object.fromEntries((b['VIDEOHUB DEVICE'] || []).map((l) => l.split(/:\s*/, 2)).map(([k, v]) => [k.trim(), (v || '').trim()]))
		const labels = (list) => Object.fromEntries((list || []).map((l) => [Number(l.split(' ')[0]), l.slice(l.indexOf(' ') + 1)]))
		const inputs = labels(b['INPUT LABELS'])
		const outputs = labels(b['OUTPUT LABELS'])
		const routing = (b['VIDEO OUTPUT ROUTING'] || []).map((l) => l.split(' ').map(Number)).filter((p) => p.length === 2).map(([out, inp]) => ({ out, in: inp, outName: outputs[out] || `Output ${out + 1}`, inName: inputs[inp] || `Input ${inp + 1}` }))
		const locks = (b['VIDEO OUTPUT LOCKS'] || []).filter((l) => /\s[LO]$/.test(l)).length
		return {
			kind: 'videohub',
			model: kv['Model name'] || null,
			name: kv['Friendly name'] || null,
			version: kv['Version'] || null,
			inputs: Number(kv['Video inputs']) || Object.keys(inputs).length,
			outputs: Number(kv['Video outputs']) || Object.keys(outputs).length,
			inputLabels: inputs,
			outputLabels: outputs,
			routing,
			locks,
			summary: `${kv['Model name'] || 'Videohub'} · ${routing.length} routes${locks ? ' · ' + locks + ' locked' : ''}`,
		}
	}
}
