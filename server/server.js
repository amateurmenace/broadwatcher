// Broadwatcher server: runs the collector, serves the dashboard (ui/) and a live feed.
//   GET  /api/state                 full current state (JSON)
//   GET  /api/events                server-sent events: "state" after every device poll, "event" for the tape
//   GET  /api/details?type=&id=     inspector data for an alert / switch / port / equipment / atem / wan
//   GET  /api/ai/status             AI availability + the cached assessment
//   GET  /api/ai/assess[?refresh=1] broadcast-readiness verdict (cached)
//   GET  /api/ai/diagnose?id=       explanation of one alert
//   POST /api/ai/ask {question}     free question about the live network
//   GET  /api/config                the active configuration (API keys redacted)
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Collector } from './collector.js'
import { AI } from './ai.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UI_DIR = path.join(__dirname, '..', 'ui')
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }

// The bundled config is the source of truth for the equipment list, the ATEM, SNMP and AI defaults; the user's
// copy may override any of it. When the bundled config is newer (config_version) than the user's copy, the
// device lists come from the bundle again (the user's gateway/poll/threshold/ai/snmp edits are kept) and the
// merged result is written back so the file on disk shows the current schema.
export function loadConfig(bundledPath, userPath) {
	const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
	const base = read(bundledPath)
	if (!userPath || !fs.existsSync(userPath)) return base
	try {
		const user = read(userPath)
		const deep = (k) => ({ ...(base[k] || {}), ...(user[k] || {}) })
		const outdated = (user.config_version || 0) < (base.config_version || 0)
		const merged = outdated
			? { ...base, gateway: deep('gateway'), poll: deep('poll'), thresholds: deep('thresholds'), ai: deep('ai'), snmp: deep('snmp'), server: deep('server') }
			: { ...base, ...user, gateway: deep('gateway'), poll: deep('poll'), thresholds: deep('thresholds'), ai: deep('ai'), snmp: deep('snmp'), server: deep('server') }
		// a roster edited in the app survives upgrades: the user's entries win, new bundled devices are appended
		if (user.equipment_edited && Array.isArray(user.equipment)) {
			const byIp = new Map(user.equipment.map((e) => [e.ip, e]))
			merged.equipment = [...user.equipment, ...base.equipment.filter((e) => !byIp.has(e.ip)).map((e) => ({ ...e, active: false }))]
			merged.equipment_edited = true
		}
		if (outdated) {
			try {
				fs.writeFileSync(userPath, JSON.stringify(merged, null, 2) + '\n')
				console.log(`config ${userPath} upgraded to version ${base.config_version}`)
			} catch {}
		}
		return merged
	} catch (e) {
		console.error(`config ${userPath} ignored: ${e.message}`)
		return base
	}
}

function sendJson(res, obj, status = 200) {
	const body = JSON.stringify(obj)
	res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) })
	res.end(body)
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = []
		req.on('data', (c) => {
			chunks.push(c)
			if (chunks.reduce((n, b) => n + b.length, 0) > 65536) reject(new Error('body too large'))
		})
		req.on('end', () => {
			try {
				resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
			} catch (e) {
				reject(e)
			}
		})
		req.on('error', reject)
	})
}

export function saveUserConfig(configPath, patch) {
	if (!configPath) return false
	let cur = {}
	try {
		cur = JSON.parse(fs.readFileSync(configPath, 'utf8'))
	} catch {}
	fs.mkdirSync(path.dirname(configPath), { recursive: true })
	fs.writeFileSync(configPath, JSON.stringify({ ...cur, ...patch }, null, 2) + '\n')
	return true
}

export function startServer({ config, configPath = null, host = '127.0.0.1', port = 8766, log = console.log }) {
	const collector = new Collector(config, log)
	const ai = new AI(config.ai || {}, log, config.thresholds || {})
	const sseClients = new Set()
	const broadcast = (event, data) => {
		if (!sseClients.size) return
		const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
		for (const res of sseClients) res.write(chunk)
	}
	collector.on('state', (state) => broadcast('state', state))
	collector.on('event', (ev) => broadcast('event', ev))
	collector.start()

	// automatic re-assessment: every assess_every_s, and soon after the set of alerts changes
	let lastAlertKey = null
	const autoAssess = async () => {
		if (!ai.enabled || !collector.state.ts) return
		const key = collector.state.alerts.map((a) => a.id).join('|')
		const changed = key !== lastAlertKey
		lastAlertKey = key
		try {
			const r = await ai.assess(collector.state, { force: changed && !!ai.assessment })
			if (r) broadcast('ai', r)
		} catch (e) {
			log('[ai] ' + e.message)
			broadcast('ai', { error: e.message, t: Date.now() })
		}
	}
	setTimeout(autoAssess, 20000)
	const aiTimer = setInterval(autoAssess, 30000)

	const redacted = () => ({ ...config, gateway: { ...config.gateway, api_key: '***' }, site_manager_api_key: config.site_manager_api_key ? '***' : undefined, ai: { ...(config.ai || {}), api_key: config.ai?.api_key ? '***' : '', anthropic_api_key: config.ai?.anthropic_api_key ? '***' : '' } })

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
		const p = url.pathname
		const q = url.searchParams
		try {
			if (p === '/api/state') return sendJson(res, collector.state)
			if (p === '/api/health') return sendJson(res, { ok: collector.state.ok, ts: collector.state.ts, errors: collector.state.errors })
			if (p === '/api/config') return sendJson(res, redacted())
			if (p === '/api/details') return sendJson(res, collector.details(q.get('type'), q.get('id')))
			if (p === '/api/equipment' && req.method === 'GET') return sendJson(res, { equipment: config.equipment, groups: [...new Set(config.equipment.map((e) => e.group))], configPath })
			if (p === '/api/equipment' && req.method === 'POST') {
				const body = await readBody(req)
				const clean = collector.setEquipment(body.equipment)
				let saved = false
				try {
					saved = saveUserConfig(configPath, { equipment: clean, equipment_edited: true, config_version: config.config_version || 0 })
				} catch (e) {
					log('[config] could not save: ' + e.message)
				}
				return sendJson(res, { equipment: clean, saved, configPath })
			}
			if (p === '/api/ai/status') return sendJson(res, ai.status())
			if (p === '/api/ai/digest') {
				res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
				return res.end(ai.digest(collector.state))
			}
			if (p === '/api/ai/assess') {
				if (!ai.enabled) return sendJson(res, { error: 'AI is not configured (config.json → ai)' }, 503)
				const r = await ai.assess(collector.state, { force: q.get('refresh') === '1' })
				if (r) broadcast('ai', r)
				return sendJson(res, r || { error: 'busy' })
			}
			if (p === '/api/ai/diagnose') {
				if (!ai.enabled) return sendJson(res, { error: 'AI is not configured' }, 503)
				const d = collector.details('alert', q.get('id'))
				if (d.error) return sendJson(res, d, 404)
				return sendJson(res, await ai.diagnose(collector.state, d.alert, d, { force: q.get('refresh') === '1' }))
			}
			if (p === '/api/ai/ask' && req.method === 'POST') {
				if (!ai.enabled) return sendJson(res, { error: 'AI is not configured' }, 503)
				const body = await readBody(req)
				if (!body.question) return sendJson(res, { error: 'question missing' }, 400)
				return sendJson(res, await ai.ask(collector.state, String(body.question).slice(0, 2000), Array.isArray(body.history) ? body.history : []))
			}
			if (p === '/api/events') {
				res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
				res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(collector.state)}\n\n`)
				if (ai.assessment) res.write(`event: ai\ndata: ${JSON.stringify(ai.assessment)}\n\n`)
				sseClients.add(res)
				const ping = setInterval(() => res.write(': ping\n\n'), 20000)
				req.on('close', () => {
					clearInterval(ping)
					sseClients.delete(res)
				})
				return
			}
			// static UI
			let rel = p === '/' ? '/index.html' : p
			rel = path.posix.normalize(rel)
			if (rel.includes('..')) return sendJson(res, { error: 'bad path' }, 400)
			const file = path.join(UI_DIR, rel)
			if (!file.startsWith(UI_DIR)) return sendJson(res, { error: 'bad path' }, 400)
			fs.readFile(file, (err, data) => {
				if (err) return sendJson(res, { error: 'not found' }, 404)
				res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' })
				res.end(data)
			})
		} catch (e) {
			sendJson(res, { error: e.message }, 500)
		}
	})

	return new Promise((resolve, reject) => {
		server.once('error', reject)
		server.listen(port, host, () => {
			const addr = server.address()
			const url = `http://${host}:${addr.port}/`
			log(`Broadwatcher listening on ${url}`)
			resolve({
				server,
				collector,
				ai,
				url,
				port: addr.port,
				close: () => {
					collector.stop()
					clearInterval(aiTimer)
					for (const r of sseClients) r.end()
					server.close()
				},
			})
		})
	})
}

// `node server/server.js [config.json]` runs it standalone (no Electron)
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
	const bundled = path.join(__dirname, '..', 'config.json')
	const configPath = process.argv[2] || process.env.NETWATCH_CONFIG || path.join(__dirname, '..', 'config.local.json')
	const config = loadConfig(bundled, configPath)
	const host = process.env.NETWATCH_HOST || config.server?.host || '127.0.0.1'
	const port = Number(process.env.NETWATCH_PORT || config.server?.port || 8766)
	startServer({ config, configPath, host, port }).catch((e) => {
		console.error(e.message)
		process.exit(1)
	})
}
