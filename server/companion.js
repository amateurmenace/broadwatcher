// Bitfocus Companion as a data source. Companion already holds one control session with each ATEM it drives
// (and with the HyperDecks, Web Presenters, X32s and EW-DX receivers), and its HTTP API hands the module
// variables out to anyone on the same machine:
//   GET /api/connections                      every connection with label, module and status
//   GET /api/variable/<label>/<name>/value    one module variable as text (404 when it does not exist)
// Reading the switcher through Companion costs the switcher nothing: the HD8 keeps only a handful of control
// slots (Companion, ATEM Software Control, hardware panels and the NDI Machine bridge already take three) and a
// second session from Broadwatch was the fourth knock that was refused with "too many clients".
const ATEM_VARS = ['pgm1_input', 'pvw1_input', 'pgm1_input_id', 'pvw1_input_id', 'stream_active', 'stream_bitrate', 'stream_cache_used', 'stream_duration_hms', 'record_active', 'record_duration_hms', 'record_remaining_hms', 'record_remaining_seconds', 'record_filename', 'record_disk_volume', 'aux1_input']
// the names of inputs 1-8 (long_N / short_N), for the tally row on the switcher card
const INPUT_IDS = [1, 2, 3, 4, 5, 6, 7, 8]
const INPUT_VARS = INPUT_IDS.flatMap((n) => [`long_${n}`, `short_${n}`])

export class Companion {
	constructor({ url = 'http://127.0.0.1:8000', timeout_ms = 2500 } = {}, log = () => {}) {
		this.url = String(url || 'http://127.0.0.1:8000').replace(/\/+$/, '')
		this.timeoutMs = timeout_ms
		this.log = log
		this.lastOk = 0
		this.lastError = null
		this.connections = []
		this.connectionsAt = 0
	}

	async text(path) {
		const r = await fetch(this.url + path, { signal: AbortSignal.timeout(this.timeoutMs), headers: { Accept: 'text/plain, application/json' } })
		const body = await r.text()
		if (r.status === 404) return null
		if (!r.ok) throw new Error(`Companion HTTP ${r.status} for ${path}`)
		return body
	}

	// the connection list is cached for a few seconds: every telemetry round asks for it
	async list() {
		if (Date.now() - this.connectionsAt < 4000) return this.connections
		const body = await this.text('/api/connections')
		this.connections = body ? JSON.parse(body) : []
		this.connectionsAt = Date.now()
		return this.connections
	}

	async variable(label, name) {
		return this.text(`/api/variable/${encodeURIComponent(label)}/${encodeURIComponent(name)}/value`)
	}

	// reachability + the list, for the status line in the UI
	async status() {
		try {
			const list = await this.list()
			this.lastOk = Date.now()
			this.lastError = null
			return { url: this.url, ok: true, connections: list.map((c) => ({ label: c.label, module: c.moduleId, enabled: c.enabled !== false, status: c.status?.category || (c.enabled === false ? 'disabled' : 'unknown'), message: c.status?.message || null })) }
		} catch (e) {
			this.lastError = e.message
			return { url: this.url, ok: false, error: e.message, connections: [] }
		}
	}

	// the switcher as Companion's bmd-atem module sees it; null when Companion has no such connection
	async atem(label) {
		const list = await this.list()
		const c = list.find((x) => x.label === label && x.moduleId === 'bmd-atem')
		this.lastOk = Date.now()
		this.lastError = null
		if (!c) return null
		const good = c.enabled !== false && c.status?.category === 'good'
		const base = { kind: 'atem', via: 'companion', label, connected: good, companionStatus: c.enabled === false ? 'disabled' : c.status?.category || 'unknown', companionMessage: c.status?.message || null }
		if (!good) return { ...base, error: c.enabled === false ? `Companion connection "${label}" is disabled` : `Companion: ${c.status?.message || c.status?.category || 'not connected'}` }
		const vals = {}
		await Promise.all([...ATEM_VARS, ...INPUT_VARS].map(async (v) => (vals[v] = await this.variable(label, v).catch(() => null))))
		for (const k of Object.keys(vals)) if (vals[k] !== null && /^(not found|undefined|\$NA)$/i.test(String(vals[k]).trim())) vals[k] = null
		const inputs = {}
		for (const n of INPUT_IDS) if (vals[`long_${n}`] || vals[`short_${n}`]) inputs[n] = { long: vals[`long_${n}`] || vals[`short_${n}`], short: vals[`short_${n}`] || String(n) }
		const num = (x) => {
			const n = parseFloat(String(x ?? '').replace(/[^0-9.\-]/g, ''))
			return Number.isFinite(n) ? n : null
		}
		const bool = (x) => /^(true|1|yes|on)$/i.test(String(x ?? '').trim())
		const streaming = bool(vals.stream_active)
		const recording = bool(vals.record_active)
		const bitrateMb = num(vals.stream_bitrate) // the module reports Mb/s with two decimals
		return {
			...base,
			product: null,
			program: num(vals.pgm1_input_id),
			preview: num(vals.pvw1_input_id),
			programName: vals.pgm1_input || null,
			previewName: vals.pvw1_input || null,
			inputs,
			aux: vals.aux1_input ? { 1: vals.aux1_input } : null,
			streaming: { state: streaming ? 'streaming' : 'idle', bitrate: bitrateMb !== null ? Math.round(bitrateMb * 1e6) : null, cache: num(vals.stream_cache_used), duration: vals.stream_duration_hms || null },
			recording: { state: recording ? 'recording' : 'idle', active: recording, duration: vals.record_duration_hms || null, remaining: vals.record_remaining_hms || null, remainingS: num(vals.record_remaining_seconds), filename: vals.record_filename || null, disk: vals.record_disk_volume || null },
			summary: `${streaming ? 'STREAMING' + (bitrateMb ? ' ' + bitrateMb.toFixed(1) + ' Mb/s' : '') : 'stream idle'} · ${recording ? 'RECORDING ' + (vals.record_duration_hms || '') : 'not recording'}`,
		}
	}
}
