// BIG NetWatch server: runs the collector, serves the dashboard (ui/) and a live feed.
//   GET /api/state      full current state (JSON)
//   GET /api/events     server-sent events: "state" after every device poll
//   GET /api/config     the active configuration (API keys redacted)
//   GET /api/health     {ok, ts, errors}
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Collector } from './collector.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UI_DIR = path.join(__dirname, '..', 'ui')
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }

export function loadConfig(bundledPath, userPath) {
	const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
	const base = read(bundledPath)
	if (!userPath || !fs.existsSync(userPath)) return base
	try {
		const user = read(userPath)
		return { ...base, ...user, gateway: { ...base.gateway, ...(user.gateway || {}) }, poll: { ...base.poll, ...(user.poll || {}) }, thresholds: { ...base.thresholds, ...(user.thresholds || {}) } }
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

export function startServer({ config, host = '127.0.0.1', port = 8766, log = console.log }) {
	const collector = new Collector(config, log)
	const sseClients = new Set()
	collector.on('state', (state) => {
		if (!sseClients.size) return
		const chunk = `event: state\ndata: ${JSON.stringify(state)}\n\n`
		for (const res of sseClients) res.write(chunk)
	})
	collector.start()

	const redacted = () => ({ ...config, gateway: { ...config.gateway, api_key: '***' }, site_manager_api_key: config.site_manager_api_key ? '***' : undefined })

	const server = http.createServer((req, res) => {
		const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
		const p = url.pathname
		try {
			if (p === '/api/state') return sendJson(res, collector.state)
			if (p === '/api/health') return sendJson(res, { ok: collector.state.ok, ts: collector.state.ts, errors: collector.state.errors })
			if (p === '/api/config') return sendJson(res, redacted())
			if (p === '/api/events') {
				res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
				res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(collector.state)}\n\n`)
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
			log(`BIG NetWatch listening on ${url}`)
			resolve({
				server,
				collector,
				url,
				port: addr.port,
				close: () => {
					collector.stop()
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
	const config = loadConfig(bundled, process.argv[2] || process.env.NETWATCH_CONFIG)
	const host = process.env.NETWATCH_HOST || config.server?.host || '127.0.0.1'
	const port = Number(process.env.NETWATCH_PORT || config.server?.port || 8766)
	startServer({ config, host, port }).catch((e) => {
		console.error(e.message)
		process.exit(1)
	})
}
