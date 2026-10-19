// Broadwatcher server: runs the collector, serves the dashboard (ui/) and a live feed.
//   GET  /api/state                 full current state (JSON)
//   GET  /api/events                server-sent events: "state" after every device poll, "event" for the tape
//   GET  /api/details?type=&id=     inspector data for an alert / switch / port / equipment / atem / wan / path
//   GET  /api/ai/status             AI availability + the cached assessment
//   GET  /api/ai/assess[?refresh=1] broadcast-readiness verdict (cached)
//   GET  /api/ai/diagnose?id=       explanation of one alert
//   POST /api/ai/ask {question}     free question about the live network
//   GET  /api/config                the active configuration (API keys redacted)
//   GET  /api/settings              the editable settings (secrets masked) for the Settings screen
//   POST /api/settings {section: {...}} save + apply settings (keys: undefined = keep, null = clear)
//   POST /api/settings/test {section, values}  try a provider / the gateway / SNMP / Companion without saving
//   GET  /api/companion             Companion reachability and its connection list
//   GET  /api/atem/capture?ip=      raw remote-source commands seen on our own switcher session (if any)
//   POST /api/atem/session          {ip, action: connect|release} or {action: 'mode', mode: companion|auto|own|none}
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Collector } from './collector.js'
import { AI, ANTHROPIC_MODELS } from './ai.js'
import { UniFi } from './unifi.js'
import { SnmpSwitch } from './snmp.js'
import { Companion } from './companion.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UI_DIR = path.join(__dirname, '..', 'ui')
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }
const DEEP_KEYS = ['gateway', 'poll', 'thresholds', 'ai', 'snmp', 'server', 'atem', 'companion']

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
		const deepKeys = Object.fromEntries(DEEP_KEYS.map((k) => [k, deep(k)]))
		const merged = outdated ? { ...base, ...deepKeys } : { ...base, ...user, ...deepKeys }
		// a roster edited in the app survives upgrades: the user's entries win, new bundled devices are appended;
		// fields that a newer bundle adds to a known device (e.g. its Companion label) are filled in when missing
		if (user.equipment_edited && Array.isArray(user.equipment)) {
			const byIp = new Map(user.equipment.map((e) => [e.ip, e]))
			const baseByIp = new Map((base.equipment || []).map((e) => [e.ip, e]))
			merged.equipment = [...user.equipment.map((e) => (baseByIp.get(e.ip)?.companion && e.companion === undefined ? { ...e, companion: baseByIp.get(e.ip).companion } : e)), ...(base.equipment || []).filter((e) => !byIp.has(e.ip)).map((e) => ({ ...e, active: false }))]
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

// what the Settings screen sees: every editable section, secrets replaced by "is set" + the last characters
const mask = (v) => (v ? { set: true, hint: '…' + String(v).slice(-4) } : { set: false, hint: '' })
function settingsView(config, ai, configPath) {
	const g = config.gateway || {}
	const a = config.ai || {}
	return {
		flavor: config.flavor || 'private',
		firstRun: !g.api_key,
		configPath,
		ai: { enabled: a.enabled !== false, provider: ai.provider, base_url: a.base_url || '', model: a.model || '', anthropic_model: a.anthropic_model || 'claude-opus-5-5', anthropic_effort: a.anthropic_effort || 'medium', assess_every_s: a.assess_every_s || 180, keys: { local: mask(a.api_key), anthropic: mask(a.anthropic_api_key), env: !!process.env.ANTHROPIC_API_KEY }, models: ANTHROPIC_MODELS, providers: ai.providers() },
		gateway: { name: g.name || '', url: g.url || '', site: g.site || 'default', ui_url: g.ui_url || '', key: mask(g.api_key) },
		snmp: { community: config.snmp?.community || '', every_s: config.snmp?.every_s || 3 },
		companion: { url: config.companion?.url || 'http://127.0.0.1:8000', atem_label: config.companion?.atem_label || 'atem', autostart: config.companion?.autostart !== false },
		server: { host: config.server?.host || '127.0.0.1', port: config.server?.port || 8766 },
		thresholds: { wan_latency_ms: 80, cpu_pct: 85, mem_pct: 90, temp_c: 70, stream_min_mbps: 1.5, ...Object.fromEntries(Object.entries(config.thresholds || {}).filter(([k]) => !k.startsWith('_'))) },
		poll: { devices_s: 5, clients_s: 10, flows_s: 10, log_s: 30, probe_s: 15, telemetry_s: 10, ...(config.poll || {}) },
		atem: { name: config.atem?.name || '', ip: config.atem?.ip || '', session: config.atem?.session || 'companion' },
	}
}

// apply a settings patch to the live config: strings replace, null clears a secret, undefined keeps
const SECRET_FIELDS = { ai: ['api_key', 'anthropic_api_key'], gateway: ['api_key'], snmp: ['community'] }
function mergeSection(config, section, patch) {
	const cur = { ...(config[section] || {}) }
	for (const [k, v] of Object.entries(patch || {})) {
		if (k.startsWith('_')) continue
		if (v === undefined) continue
		if (v === null) {
			cur[k] = ''
			continue
		}
		if ((SECRET_FIELDS[section] || []).includes(k) && v === '') continue // an empty secret field means "keep"
		cur[k] = typeof cur[k] === 'number' && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v
	}
	config[section] = cur
	return cur
}

// LAN access (phones, other computers) needs a key: generated once per install and kept in the user config
function ensureToken(config, configPath) {
	if (config.server?.token) return config.server.token
	const token = crypto.randomBytes(12).toString('base64url')
	config.server = { ...(config.server || {}), token }
	try {
		saveUserConfig(configPath, { server: config.server, config_version: config.config_version || 0 })
	} catch {}
	return token
}
const lanAddresses = () =>
	Object.values(os.networkInterfaces())
		.flat()
		.filter((a) => a && a.family === 'IPv4' && !a.internal)
		.map((a) => a.address)
const isLoopback = (req) => /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '')
const PUBLIC_FILES = /^\/(manifest\.webmanifest|icon\.svg|icon-512\.png)$/
const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((kv) => kv[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]))

export function startServer({ config, configPath = null, host = '127.0.0.1', port = 8766, log = console.log }) {
	let collector = null
	const token = ensureToken(config, configPath)
	const ai = new AI(config.ai || {}, log, config.thresholds || {})
	const sseClients = new Set()
	const broadcast = (event, data) => {
		if (!sseClients.size) return
		const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
		for (const res of sseClients) res.write(chunk)
	}
	let lastAlertKey = null
	const startCollector = () => {
		collector = new Collector(config, log)
		collector.on('state', (state) => broadcast('state', state))
		collector.on('event', (ev) => broadcast('event', ev))
		collector.start()
		lastAlertKey = null
	}
	const restartCollector = (why) => {
		const events = collector ? collector.state.events : []
		collector.stop()
		startCollector()
		collector.state.events = events
		collector.event('device', `Settings changed (${why}): polling restarted`)
	}
	startCollector()

	// automatic re-assessment: every assess_every_s, and soon after the set of alerts changes
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

	// Settings screen: save every section that was sent, apply what can be applied live, say what needs a restart
	const applySettings = (body) => {
		const applied = []
		const restart = []
		const saved = {}
		for (const section of ['ai', 'gateway', 'snmp', 'companion', 'server', 'thresholds', 'poll', 'atem']) {
			if (!body[section] || typeof body[section] !== 'object') continue
			const before = JSON.stringify(config[section] || {})
			mergeSection(config, section, body[section])
			if (JSON.stringify(config[section]) === before) continue
			saved[section] = config[section]
			if (section === 'ai') {
				ai.configure(config.ai, config.thresholds)
				applied.push('AI')
			} else if (section === 'thresholds') {
				ai.thresholds = config.thresholds
				collector.th = { ...collector.th, ...config.thresholds }
				applied.push('thresholds')
			} else if (section === 'atem') {
				collector.cfg.atem = config.atem
				applied.push('switcher')
			} else if (section === 'companion') {
				collector.companion = new Companion(config.companion, log)
				applied.push('Companion')
			} else if (section === 'server') restart.push('server host/port (restart Broadwatcher)')
			else restart.push(section)
		}
		if (restart.some((r) => ['gateway', 'snmp', 'poll'].includes(r))) {
			restartCollector(restart.filter((r) => ['gateway', 'snmp', 'poll'].includes(r)).join(', '))
			applied.push(...restart.filter((r) => ['gateway', 'snmp', 'poll'].includes(r)))
		}
		let written = false
		if (Object.keys(saved).length) {
			try {
				written = saveUserConfig(configPath, { ...saved, config_version: config.config_version || 0 })
			} catch (e) {
				log('[config] could not save: ' + e.message)
			}
		}
		if (applied.includes('AI')) setTimeout(autoAssess, 2000)
		return { ok: true, applied, needsRestart: restart.filter((r) => !['gateway', 'snmp', 'poll'].includes(r)), saved: written, sections: Object.keys(saved) }
	}

	const testSettings = async (section, values = {}) => {
		if (section === 'ai') return ai.test(values)
		if (section === 'gateway') {
			const g = { ...config.gateway, ...Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== undefined && !(k === 'api_key' && v === ''))) }
			if (!g.url || !g.api_key) throw new Error('gateway URL and API key are needed')
			const api = new UniFi(g)
			const devices = (await api.devices()) || []
			const gw = devices.find((d) => ['udm', 'uxg', 'ugw'].includes(d.type))
			return { ok: true, devices: devices.length, gateway: gw ? `${gw.name || gw.model} (${gw.model})` : 'no gateway in the list', switches: devices.filter((d) => d.type === 'usw').length }
		}
		if (section === 'companion') {
			const c = new Companion({ ...config.companion, ...values }, log)
			const st = await c.status()
			if (!st.ok) throw new Error(st.error)
			const atem = st.connections.filter((x) => x.module === 'bmd-atem')
			return { ok: true, connections: st.connections.length, atem: atem.map((x) => `${x.label}: ${x.status}`).join(', ') || 'no ATEM connection' }
		}
		if (section === 'snmp') {
			const community = values.community || config.snmp?.community
			if (!community) throw new Error('community string is empty')
			const sw = collector.state.switches.find((s) => s.online && s.ip)
			if (!sw) throw new Error('no online switch known yet to test against')
			const s = new SnmpSwitch(sw.ip, community)
			const m = await s.poll(sw.ports.filter((p) => p.up).map((p) => p.idx))
			return { ok: true, switch: sw.name, ports: m.size }
		}
		throw new Error('nothing to test in this section')
	}

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
		const p = url.pathname
		const q = url.searchParams
		try {
			// anyone on the LAN needs the key (in the link once, then a cookie); the manifest and icons are public
			if (!isLoopback(req) && !PUBLIC_FILES.test(p)) {
				const key = q.get('key') || cookies(req).bw_key || req.headers['x-key']
				if (key !== token) {
					if (p === '/m' || p === '/') {
						res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
						return res.end('<!doctype html><meta name="viewport" content="width=device-width"><body style="font:16px system-ui;padding:24px;background:#f3f0e9;color:#1f1d1a"><h2 style="font-family:Georgia,serif;font-weight:400">Broadwatcher</h2><p>This link needs the access key. Open it from the app: <b>Broadwatcher &gt; Open on a phone…</b></p>')
					}
					return sendJson(res, { error: 'access key required' }, 401)
				}
				if (q.get('key')) res.setHeader('Set-Cookie', `bw_key=${encodeURIComponent(token)}; Path=/; Max-Age=31536000; SameSite=Lax`)
			}
			if (p === '/api/state') return sendJson(res, collector.state)
			if (p === '/api/phone') {
				const lan = host === '0.0.0.0'
				const addrs = lanAddresses()
				return sendJson(res, { lan, host, port: server.address()?.port || port, addresses: addrs, urls: lan ? addrs.map((a) => `http://${a}:${server.address()?.port || port}/m?key=${token}`) : [], key: token })
			}
			if (p === '/api/profiles' && req.method === 'GET') return sendJson(res, { profiles: collector.profiles, active: collector.activeProfile, equipment: config.equipment })
			if (p === '/api/profiles' && req.method === 'POST') {
				const body = await readBody(req)
				const r = collector.setProfiles(body.profiles, body.active)
				const patch = { profiles: r.profiles, active_profile: r.active, config_version: config.config_version || 0 }
				if (body.applyRoster && body.active) {
					const a = collector.activateProfile(body.active, { applyRoster: true })
					if (a.roster) patch.equipment = a.roster
					if (a.roster) patch.equipment_edited = true
				}
				let saved = false
				try {
					saved = saveUserConfig(configPath, patch)
				} catch (e) {
					log('[config] could not save: ' + e.message)
				}
				return sendJson(res, { ...r, saved })
			}
			if (p === '/api/profiles/activate' && req.method === 'POST') {
				const body = await readBody(req)
				const a = collector.activateProfile(String(body.id || ''), { applyRoster: !!body.applyRoster })
				if (a.error) return sendJson(res, a, 400)
				const patch = { active_profile: a.active, config_version: config.config_version || 0 }
				if (a.roster) {
					patch.equipment = a.roster
					patch.equipment_edited = true
				}
				let saved = false
				try {
					saved = saveUserConfig(configPath, patch)
				} catch (e) {
					log('[config] could not save: ' + e.message)
				}
				return sendJson(res, { ...a, saved })
			}
			if (p === '/api/probe/test' && req.method === 'POST') return sendJson(res, { results: await collector.testProbes(), t: Date.now() })
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
			if (p === '/api/portlabel' && req.method === 'POST') {
				const body = await readBody(req)
				const r = collector.setPortLabel(String(body.key || ''), body)
				if (r.error) return sendJson(res, r, 400)
				config.port_labels = collector.portLabels
				let saved = false
				try {
					saved = saveUserConfig(configPath, { port_labels: config.port_labels, config_version: config.config_version || 0 })
				} catch (e) {
					log('[config] could not save: ' + e.message)
				}
				return sendJson(res, { ...r, saved })
			}
			if (p === '/api/settings' && req.method === 'GET') return sendJson(res, settingsView(config, ai, configPath))
			if (p === '/api/settings' && req.method === 'POST') return sendJson(res, applySettings(await readBody(req)))
			if (p === '/api/settings/test' && req.method === 'POST') {
				const body = await readBody(req)
				try {
					return sendJson(res, await testSettings(String(body.section || ''), body.values || {}))
				} catch (e) {
					return sendJson(res, { ok: false, error: e.message })
				}
			}
			if (p === '/api/companion') return sendJson(res, await collector.companion.status())
			if (p === '/api/atem/capture') {
				const c = collector.atems.get(q.get('ip') || config.atem?.ip)
				return sendJson(res, c ? c.captureReport() : { error: 'Broadwatcher holds no session with this switcher (Control connection > own session, or node scripts/atem-capture.mjs when no show is on)' })
			}
			if (p === '/api/atem/session' && req.method === 'POST') {
				const body = await readBody(req)
				const ip = String(body.ip || config.atem?.ip || '')
				if (body.action === 'mode') {
					const mode = String(body.mode || '')
					if (!['companion', 'auto', 'own', 'none'].includes(mode)) return sendJson(res, { error: 'mode must be companion, auto, own or none' }, 400)
					config.atem = { ...(config.atem || {}), session: mode }
					collector.cfg.atem = config.atem
					let saved = false
					try {
						saved = saveUserConfig(configPath, { atem: config.atem, config_version: config.config_version || 0 })
					} catch (e) {
						log('[config] could not save: ' + e.message)
					}
					collector.event('device', `Switcher data source set to "${mode}"${mode === 'companion' ? ' (through Companion; Broadwatcher holds no control slot)' : mode === 'own' ? ' (Broadwatcher holds its own control slot)' : ''}`, { entity: { type: 'equipment', id: ip } })
					collector.pollTelemetry().catch(() => {})
					return sendJson(res, { ok: true, mode, saved })
				}
				const r = collector.atemSession(ip, body.action)
				collector.pollTelemetry().catch(() => {})
				return sendJson(res, r, r.error ? 400 : 200)
			}
			if (p === '/api/ai/status') return sendJson(res, ai.status())
			if (p === '/api/ai/digest') {
				res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
				return res.end(ai.digest(collector.state))
			}
			if (p === '/api/ai/assess') {
				if (!ai.enabled) return sendJson(res, { error: 'AI is not configured (Settings > AI)' }, 503)
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
			// static UI ("/m" is the phone page)
			let rel = p === '/' ? '/index.html' : p === '/m' ? '/m.html' : p
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
			const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${addr.port}/`
			log(`Broadwatcher listening on ${url}${host === '0.0.0.0' ? ' (and on the LAN)' : ''}`)
			resolve({
				server,
				get collector() {
					return collector
				},
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
	const bundled = path.join(__dirname, '..', process.env.BW_FLAVOR === 'public' ? 'config.public.json' : 'config.json')
	const configPath = process.argv[2] || process.env.NETWATCH_CONFIG || path.join(__dirname, '..', 'config.local.json')
	const config = loadConfig(bundled, configPath)
	const host = process.env.NETWATCH_HOST || config.server?.host || '127.0.0.1'
	const port = Number(process.env.NETWATCH_PORT || config.server?.port || 8766)
	startServer({ config, configPath, host, port }).catch((e) => {
		console.error(e.message)
		process.exit(1)
	})
}
