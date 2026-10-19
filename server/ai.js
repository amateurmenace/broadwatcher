// AI assistant: turns the live state into a short engineer's digest and asks a model for
//  - an overall broadcast-readiness verdict (cached, refreshed on demand or when alerts change)
//  - a diagnosis of one alert
//  - answers to free questions about the network
// Works with any OpenAI-compatible server (LM Studio on the Broadcast Pix PC by default) or Anthropic.

const SYSTEM = `You are the network engineer on duty at Brookline Interactive Group (BIG), a community TV station.
You watch a UniFi network (UDM Pro Max gateway, USW switches, fiber link to Town Hall) that carries live broadcast
signals: the ATEM Television Studio HD8 ISO switcher in Studio A (remote video streams arrive at it over the network),
Blackmagic Web Presenters that push the programme to the internet, HyperDeck recorders, a Smart Videohub router,
Dante audio (VLANs BIG_DANTE, BIG_MOBILE_DANTE) with X32 consoles and Sennheiser EW-DX mics, an NDI VLAN (BIG_NDI),
Zoom running on a Mac, Tightrope playout servers, and a field kit (ATEM Mini Pro G2, Web Presenter 4K).
Town Meeting nights are the critical events. Be concrete, terse and practical, like a senior broadcast engineer
talking to a colleague: name devices, ports and numbers, say what is fine, what is risky and what to check first.

Rules of judgement:
- Quote numbers exactly as they appear in the data. Never invent devices, ports or numbers. If data is missing, say so.
- The ALERTS list is Broadwatcher's own threshold check and is authoritative for what is wrong. With no alerts, the network is
  normally READY; only call out something else if the data itself shows it clearly.
- Low traffic is normal, not a problem: a 1 Gb/s link carrying 1 Mb/s is healthy. Only utilisation near the link speed matters.
- UniFi switches idle at 40-70 % CPU; only CPU above 85 %, temperature above 70 °C, or memory above 90 % is a concern.
- Laptops, phones and watches connecting or disconnecting from Wi-Fi are normal; wired broadcast gear dropping is not.
- Portable kit (Flex Minis, field switches) and spares being offline is normal; unidentified devices are low priority.
- Devices listed as STANDBY are deliberately not part of this broadcast: never mention them as a problem.
- A stream "arriving" at the ATEM is good news during a show, not a problem; "stopped" during a show is a problem.`

export class AI {
	constructor(cfg = {}, log = console.log, thresholds = {}) {
		this.cfg = { enabled: true, provider: 'openai', base_url: '', model: '', api_key: '', anthropic_api_key: '', anthropic_model: 'claude-sonnet-5-5', timeout_ms: 90000, assess_every_s: 180, ...cfg }
		this.thresholds = thresholds
		this.log = log
		this.assessment = null // {verdict, headline, reasons, actions, model, t, ms}
		this.diagnoses = new Map() // alert id -> {text, t}
		this.busy = false
		this.lastError = null
	}

	get provider() {
		if (this.cfg.provider === 'anthropic' || (!this.cfg.base_url && this.cfg.anthropic_api_key)) return 'anthropic'
		return 'openai'
	}
	get enabled() {
		return this.cfg.enabled !== false && (this.provider === 'anthropic' ? !!this.cfg.anthropic_api_key : !!this.cfg.base_url)
	}
	get modelName() {
		return this.provider === 'anthropic' ? this.cfg.anthropic_model : this.cfg.model || '(server default)'
	}

	status() {
		return { enabled: this.enabled, provider: this.provider, model: this.modelName, endpoint: this.provider === 'anthropic' ? 'api.anthropic.com' : this.cfg.base_url, busy: this.busy, lastError: this.lastError, assessment: this.assessment }
	}

	async chat(messages, { maxTokens = 900, temperature = 0.2 } = {}) {
		const t0 = Date.now()
		this.busy = true
		try {
			let text
			if (this.provider === 'anthropic') {
				const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
				const r = await fetch('https://api.anthropic.com/v1/messages', {
					method: 'POST',
					headers: { 'content-type': 'application/json', 'x-api-key': this.cfg.anthropic_api_key, 'anthropic-version': '2023-06-01' },
					body: JSON.stringify({ model: this.cfg.anthropic_model, max_tokens: maxTokens, temperature, system: sys, messages: messages.filter((m) => m.role !== 'system') }),
					signal: AbortSignal.timeout(this.cfg.timeout_ms),
				})
				if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
				const j = await r.json()
				text = (j.content || []).map((c) => c.text || '').join('')
			} else {
				const r = await fetch(`${this.cfg.base_url.replace(/\/+$/, '')}/chat/completions`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', ...(this.cfg.api_key ? { authorization: `Bearer ${this.cfg.api_key}` } : {}) },
					body: JSON.stringify({ model: this.cfg.model || undefined, messages, temperature, max_tokens: maxTokens, stream: false }),
					signal: AbortSignal.timeout(this.cfg.timeout_ms),
				})
				if (!r.ok) throw new Error(`AI server HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
				const j = await r.json()
				text = j.choices?.[0]?.message?.content || ''
			}
			this.lastError = null
			return { text: String(text).trim(), ms: Date.now() - t0 }
		} catch (e) {
			this.lastError = `${new Date().toLocaleTimeString()} ${e.message}`
			throw e
		} finally {
			this.busy = false
		}
	}

	// ---------------------------------------------------------------- state -> digest
	digest(state) {
		const L = []
		const rate = (v) => (v >= 1000 ? (v / 1000).toFixed(2) + ' Gb/s' : v >= 1 ? v.toFixed(1) + ' Mb/s' : v > 0 ? Math.round(v * 1000) + ' kb/s' : '0')
		const gw = state.gateway
		L.push(`TIME ${new Date(state.ts).toLocaleString()}`)
		L.push(`THRESHOLDS: cpu > ${this.thresholds?.cpu_pct ?? 85}%, memory > ${this.thresholds?.mem_pct ?? 90}%, temperature > ${this.thresholds?.temp_c ?? 70} C, WAN latency > ${this.thresholds?.wan_latency_ms ?? 80} ms, broadcast links must be 1000M`)
		if (gw) L.push(`GATEWAY ${gw.name} (${gw.modelName}) ${gw.online ? 'online' : 'OFFLINE'} cpu ${gw.cpu}% mem ${gw.mem}% temp ${gw.temp}C uptime ${Math.round(gw.uptime / 3600)}h | WAN ${gw.wan.status} ${gw.wan.ip || ''} ${gw.wan.isp || ''} link ${gw.wan.speed}M latency ${gw.wan.latency}ms down ${rate(gw.wan.down)} up ${rate(gw.wan.up)}`)
		else L.push('GATEWAY: not found in UniFi device list')
		L.push(`CLIENTS ${state.clients.total} (${state.clients.wired} wired, ${state.clients.wireless} wifi)`)
		L.push('VLANS: ' + (state.networks || []).filter((n) => n.watched || n.clients > 0).map((n) => `${n.name}(vlan ${n.vlan ?? '-'}) ${n.clients} clients in ${rate(n.down)} out ${rate(n.up)}`).join('; '))
		L.push('SWITCHES:')
		for (const s of state.switches) {
			if (!s.online) {
				L.push(`  ${s.name} (${s.modelName}) OFFLINE${s.lastSeen ? ', last seen ' + Math.round((state.ts - s.lastSeen) / 60000) + ' min ago' : ''}`)
				continue
			}
			const errPorts = s.ports.filter((p) => p.errorsRecent).map((p) => p.idx)
			L.push(`  ${s.name} (${s.modelName}, ${s.ip}) up ${Math.round(s.uptime / 3600)}h cpu ${s.cpu}% temp ${s.temp ?? '-'}C ports ${s.portsUp}/${s.portsTotal} up, traffic in ${rate(s.totals.down)} out ${rate(s.totals.up)}, uplink ${s.uplink.device || '?'} p${s.uplink.port || '?'} ${s.uplink.speed}M${s.poeMax ? `, PoE ${s.poeW}/${s.poeMax}W` : ''}${errPorts.length ? `, NEW ERRORS on ports ${errPorts.join(',')}` : ''}, counters ${s.age}s old`)
		}
		const at = state.atem
		if (at) {
			const st = at.stream || {}
			L.push(`ATEM ${at.name} ${at.ip}: ${at.equipment?.status || 'not seen'}${at.equipment?.switch ? ` on ${at.equipment.switch.name} port ${at.equipment.switch.port} ${at.equipment.switch.speed}M` : ''}; intake ${rate(at.equipment?.down || 0)} outflow ${rate(at.equipment?.up || 0)}; control port: ${at.equipment?.probe ? (at.equipment.probe.ok ? at.equipment.probe.info?.state || 'ok' : 'NO ANSWER ' + (at.equipment.probe.error || '')) : 'unprobed'}`)
			L.push(`  STREAM INTAKE: ${st.state || 'unknown'}${st.state === 'arriving' ? ` ~${rate(st.rate || 0)} above baseline ${rate(st.baseline || 0)} since ${new Date(st.since).toLocaleTimeString()}` : ` (baseline ${rate(st.baseline || 0)})`}; sources: ${(st.sources || []).map((x) => `${x.name} [${x.confidence}] ${x.detail || ''}`).join('; ') || 'none identified'}`)
			if (at.incoming?.length) L.push('  flows into ATEM (last hour): ' + at.incoming.slice(0, 6).map((x) => `${x.srcName || x.src}${x.region ? '/' + x.region : ''} -> ${x.proto}:${x.dport} ${x.service || ''} ${(x.bytes / 1e6).toFixed(1)}MB ${x.live ? 'LIVE' : x.ageS + 's ago'}${x.action === 'blocked' ? ' BLOCKED' : ''}`).join('; '))
		}
		const standby = state.equipment.filter((e) => e.active === false)
		if (standby.length) L.push('STANDBY (not part of this broadcast; ignore them, they are expected to be off or away): ' + standby.map((e) => e.name).join(', '))
		L.push('EQUIPMENT IN THIS BROADCAST:')
		for (const e of state.equipment) {
			if (e.discovered || e.active === false) continue
			const tl = e.telemetry
			const tele = tl ? (tl.kind === 'webpresenter' ? `stream ${tl.status}${tl.bitrate ? ' ' + (tl.bitrate / 1e6).toFixed(1) + 'Mb/s' : ''}` : tl.kind === 'hyperdeck' ? `deck ${tl.summary}` : tl.kind === 'atem' ? `${tl.product || 'ATEM'} ${tl.streaming ? `streaming ${tl.streaming.state}${tl.streaming.url ? ' -> ' + tl.streaming.url : ''}${tl.streaming.bitrate ? ' ' + (tl.streaming.bitrate / 1e6).toFixed(1) + 'Mb/s' : ''}` : ''}${tl.error ? ' (' + tl.error + ')' : ''}` : '') : ''
			L.push(`  [${e.group}] ${e.name} ${e.ip} ${e.status.toUpperCase()}${e.switch ? ` on ${e.switch.name} p${e.switch.port} ${e.switch.speed}M` : e.online ? ' (wifi)' : e.lastSeen ? ' last seen ' + Math.round((state.ts - e.lastSeen) / 60000) + ' min ago' : ''} in ${rate(e.down)} out ${rate(e.up)}${e.probe ? (e.probe.ok ? ` probe ok ${Math.round(e.probe.ms)}ms${e.probe.info?.state ? ' (' + e.probe.info.state + ')' : ''}` : ` probe FAILED ${e.probe.error || ''}`) : ''}${tele ? ' ' + tele : ''}`)
		}
		const aps = state.aps || []
		if (aps.length) L.push(`ACCESS POINTS: ${aps.filter((a) => a.online).length}/${aps.length} online` + (aps.filter((a) => !a.online).length ? ', offline: ' + aps.filter((a) => !a.online).map((a) => a.name).join(', ') : ''))
		L.push('ALERTS:' + (state.alerts.length ? '' : ' none'))
		for (const a of state.alerts) L.push(`  [${a.level}] (${a.id}) ${a.text}${a.since ? ` since ${new Date(a.since).toLocaleTimeString()}` : ''}`)
		const ev = (state.events || []).slice(0, 12)
		if (ev.length) L.push('BROADWATCHER EVENTS (newest first): ' + ev.map((x) => `${new Date(x.t).toLocaleTimeString()} ${x.text}`).join(' | '))
		const log = (state.log || []).filter((l) => l.severity !== 'info').slice(0, 12)
		if (log.length) L.push('UNIFI EVENTS (notable, newest first): ' + log.map((l) => `${new Date(l.t).toLocaleTimeString()} ${l.title}`).join(' | '))
		const pfs = (state.portForwards || []).filter((f) => state.equipment.some((e) => e.ip === f.to) || /atem|ndi|rtmp|srt|stream/i.test(f.name))
		if (pfs.length) L.push('PORT FORWARDS to broadcast gear (WAN port -> LAN): ' + pfs.map((f) => `${f.name}: ${f.proto} ${f.wanPorts} -> ${f.to}:${f.toPorts}`).join('; '))
		const top = (state.flows?.top || []).slice(0, 6)
		if (top.length) L.push('BIGGEST FLOWS last poll: ' + top.map((f) => `${f.srcName || f.src} -> ${f.dstName || f.dst}:${f.dport} ${f.proto} ${f.service || ''} ${(f.bytes / 1e6).toFixed(1)}MB ${f.dir}`).join('; '))
		return L.join('\n').slice(0, 14000)
	}

	// ---------------------------------------------------------------- tasks
	async assess(state, { force = false } = {}) {
		if (!this.enabled) return null
		const fresh = this.assessment && Date.now() - this.assessment.t < this.cfg.assess_every_s * 1000
		if (fresh && !force) return this.assessment
		if (this.busy) return this.assessment
		const prompt = `Here is the live state of the network:\n\n${this.digest(state)}\n\nAssess broadcast readiness right now. Reply with ONE JSON object and nothing else, in this shape:
{"verdict":"READY"|"DEGRADED"|"AT RISK"|"DOWN","headline":"one sentence, max 18 words","reasons":["3 to 6 short bullets: what matters most, each naming the device/port/number"],"actions":["0 to 4 concrete things to check or do now, most urgent first"],"confidence":"high"|"medium"|"low"}
Rules: READY = every broadcast path is healthy; DEGRADED = something is wrong but a show can run; AT RISK = a failure is likely to hit a show; DOWN = a broadcast path is broken now. Offline portable kit and spares are normal, not a problem. Unnamed or unidentified devices are low priority.`
		const { text, ms } = await this.chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], { maxTokens: 700, temperature: 0.1 })
		const j = extractJson(text) || { verdict: 'UNKNOWN', headline: text.slice(0, 160), reasons: [], actions: [] }
		this.assessment = { ...j, verdict: String(j.verdict || 'UNKNOWN').toUpperCase(), reasons: arr(j.reasons), actions: arr(j.actions), model: this.modelName, t: Date.now(), ms, alertKey: state.alerts.map((a) => a.id).join('|') }
		return this.assessment
	}

	async diagnose(state, alert, details, { force = false } = {}) {
		if (!this.enabled) return null
		const c = this.diagnoses.get(alert.id)
		if (c && !force && Date.now() - c.t < 300000) return c
		const prompt = `Network state:\n\n${this.digest(state)}\n\nALERT TO DIAGNOSE: [${alert.level}] ${alert.text}\nscope ${alert.scope}, kind ${alert.kind}, since ${alert.since ? new Date(alert.since).toLocaleTimeString() : '?'}
Entity details: ${JSON.stringify(details.entity || {}).slice(0, 3000)}
Related UniFi events: ${(details.log || []).slice(0, 10).map((l) => `${new Date(l.t).toLocaleTimeString()} ${l.title}`).join(' | ') || 'none'}
Related flows: ${(details.flows || []).slice(0, 8).map((f) => `${f.srcName || f.src} -> ${f.dstName || f.dst}:${f.dport} ${f.proto} ${(f.bytes / 1e6).toFixed(1)}MB`).join('; ') || 'none'}
Related Broadwatcher events: ${(details.events || []).slice(0, 8).map((x) => `${new Date(x.t).toLocaleTimeString()} ${x.text}`).join(' | ') || 'none'}

Explain in plain language, as 3 short sections with these exact headings: "What this means", "Likely causes" (most likely first, say how you know), "What to check now" (numbered, concrete: which device, port, cable, setting). Max 170 words. Mention how it affects a live broadcast.`
		const { text, ms } = await this.chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], { maxTokens: 600, temperature: 0.2 })
		const d = { id: alert.id, text, model: this.modelName, t: Date.now(), ms }
		this.diagnoses.set(alert.id, d)
		return d
	}

	async ask(state, question, history = []) {
		if (!this.enabled) return null
		const messages = [
			{ role: 'system', content: SYSTEM },
			{ role: 'user', content: `Network state right now:\n\n${this.digest(state)}` },
			{ role: 'assistant', content: 'Understood. I have the live state. Ask me anything about it.' },
			...history.slice(-6),
			{ role: 'user', content: question },
		]
		const { text, ms } = await this.chat(messages, { maxTokens: 700, temperature: 0.3 })
		return { text, model: this.modelName, t: Date.now(), ms }
	}
}

const arr = (x) => (Array.isArray(x) ? x.map((v) => String(v)) : x ? [String(x)] : [])

function extractJson(text) {
	const s = String(text)
	const start = s.indexOf('{')
	const end = s.lastIndexOf('}')
	if (start < 0 || end <= start) return null
	try {
		return JSON.parse(s.slice(start, end + 1))
	} catch {
		try {
			return JSON.parse(s.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1'))
		} catch {
			return null
		}
	}
}
