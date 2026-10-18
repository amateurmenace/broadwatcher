// UniFi Network local API client (UDM Pro Max). Uses the X-API-KEY of a local "Integrations" key
// (UniFi Network > Settings > Control Plane > Integrations). The gateway has a self-signed certificate,
// so certificate verification is off for this one host; everything stays on the LAN.
import https from 'node:https'

export class UniFi {
	constructor({ url, api_key, site = 'default', timeout_ms = 15000 }) {
		this.base = url.replace(/\/+$/, '') + '/proxy/network/'
		this.apiKey = api_key
		this.site = site
		this.timeoutMs = timeout_ms
		this.agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 4 })
	}

	request(path, { method = 'GET', body } = {}) {
		const url = new URL(this.base + path)
		const payload = body === undefined ? undefined : JSON.stringify(body)
		return new Promise((resolve, reject) => {
			const req = https.request(
				url,
				{
					method,
					agent: this.agent,
					timeout: this.timeoutMs,
					headers: {
						'X-API-KEY': this.apiKey,
						Accept: 'application/json',
						...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
					},
				},
				(res) => {
					const chunks = []
					res.on('data', (c) => chunks.push(c))
					res.on('end', () => {
						const text = Buffer.concat(chunks).toString('utf8')
						if (res.statusCode < 200 || res.statusCode >= 300) {
							return reject(new Error(`UniFi ${method} ${path} -> HTTP ${res.statusCode} ${text.slice(0, 160)}`))
						}
						try {
							resolve(text ? JSON.parse(text) : null)
						} catch (e) {
							reject(new Error(`UniFi ${path}: bad JSON (${e.message})`))
						}
					})
				},
			)
			req.on('timeout', () => req.destroy(new Error(`UniFi ${path}: timeout after ${this.timeoutMs} ms`)))
			req.on('error', reject)
			if (payload) req.write(payload)
			req.end()
		})
	}

	// classic endpoints ("api/s/<site>/...") answer {meta, data}
	async classic(path, opts) {
		const j = await this.request(`api/s/${this.site}/${path}`, opts)
		return j?.data ?? j
	}

	health() { return this.classic('stat/health') }
	devices() { return this.classic('stat/device') }
	clients() { return this.classic('stat/sta') }
	users() { return this.classic('rest/user') } // every known client incl. the names given in UniFi
	networks() { return this.classic('rest/networkconf') }
	portProfiles() { return this.classic('rest/portconf') }
	sysinfo() { return this.classic('stat/sysinfo') }

	// v2 endpoints
	activeClients() { return this.request(`v2/api/site/${this.site}/clients/active?includeTrafficUsage=true`) }

	// direction: ['incoming'|'outgoing'|'local'] (also accepts action/protocol/service/risk sets); newest first, 200 per page max
	flows({ start, end, pageSize = 200, pageNumber = 0, direction } = {}) {
		const now = Date.now()
		return this.request(`v2/api/site/${this.site}/traffic-flows`, {
			method: 'POST',
			body: { start: start ?? now - 120000, end: end ?? now, pageSize, pageNumber, ...(direction ? { direction } : {}) },
		})
	}

	systemLog({ pageSize = 60, hours = 48 } = {}) {
		const now = Date.now()
		return this.request(`v2/api/site/${this.site}/system-log/all`, {
			method: 'POST',
			body: { pageNumber: 0, pageSize, timestampFrom: now - hours * 3600000, timestampTo: now },
		})
	}
}
