// AI assistant: turns the live state into a short engineer's digest and asks a model for
//  - an overall broadcast-readiness verdict (cached, refreshed on demand or when alerts change)
//  - a diagnosis of one alert
//  - answers to free questions about the network
// Works with any OpenAI-compatible server (LM Studio on the Broadcast Pix PC by default) or Anthropic's API
// through the official SDK (set ai.provider = "anthropic" and ai.anthropic_api_key, or the ANTHROPIC_API_KEY
// environment variable; the model defaults to Claude Opus 5.5).
import Anthropic from '@anthropic-ai/sdk'

const SYSTEM = `You are the network engineer on duty at Brookline Interactive Group (BIG), a community TV station.
You watch a UniFi network (UDM Pro Max gateway, USW switches, fiber link to Town Hall) that carries live broadcast
signals: the ATEM Television Studio HD8 ISO switcher in Studio A (remote video streams arrive at it over the network),
Blackmagic Web Presenters that push the programme to the internet, HyperDeck recorders, a Smart Videohub router,
Dante audio (VLANs BIG_DANTE, BIG_MOBILE_DANTE) with X32 consoles and Sennheiser EW-DX mics, an NDI VLAN (BIG_NDI),
Zoom running on a Mac, Tightrope playout servers, and a field kit (ATEM Mini Extreme ISO G2, Web Presenter 4K).
Remote streams reach the HD8 from the internet through UDM port forwards (WAN 1937 -> HD8 1935; WAN 1935 goes to the
field Mini instead); Broadwatch reads the HD8's state through Bitfocus Companion, which holds the control session.
Town Meeting nights are the critical events. Be concrete, terse and practical, like a senior broadcast engineer
talking to a colleague: name devices, ports and numbers, say what is fine, what is risky and what to check first.

Rules of judgement:
- Quote numbers exactly as they appear in the data. Never invent devices, ports or numbers. If data is missing, say so.
- The ALERTS list is Broadwatch's own threshold check and is authoritative for what is wrong. With no alerts, the network is
  normally READY; only call out something else if the data itself shows it clearly.
- Low traffic is normal, not a problem: a 1 Gb/s link carrying 1 Mb/s is healthy. Only utilisation near the link speed matters.
- UniFi switches idle at 40-70 % CPU; only CPU above 85 %, temperature above 70 °C, or memory above 90 % is a concern.
- Laptops, phones and watches connecting or disconnecting from Wi-Fi are normal; wired broadcast gear dropping is not.
- Portable kit (Flex Minis, field switches) and spares being offline is normal; unidentified devices are low priority.
- Devices listed as STANDBY are deliberately not part of this broadcast: never mention them as a problem.
- A stream "arriving" at the ATEM is good news during a show, not a problem; "stopped" during a show is a problem.
- An ATEM has only a handful of control slots (Companion, ATEM Software Control, hardware panels, the NDI Machine bridge
  each hold one). "too many clients" means the slots are full, not that the switcher is down; Broadwatch holds none by default.
- STREAM PATHS show the internet -> port forward -> device route of remote streams. A sender on WAN port 1935 lands on the
  field Mini (usually on standby), not on the HD8, which listens on WAN 1937: say so plainly when a RED path shows it.`

export const AI_DEFAULTS = { enabled: true, provider: 'openai', base_url: '', model: '', api_key: '', anthropic_api_key: '', anthropic_workspace_id: '', anthropic_model: 'claude-opus-5-5', anthropic_effort: 'medium', timeout_ms: 90000, assess_every_s: 180 }
export const ANTHROPIC_MODELS = [
	{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (best judgement)', price: '$4 / $20 per M tokens' },
	{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (fast)', price: '$2 / $10 per M tokens' },
	{ id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (cheapest)', price: '$0.10 / $0.50 per M tokens' },
]

export class AI {
	constructor(cfg = {}, log = console.log, thresholds = {}) {
		this.cfg = { ...AI_DEFAULTS, ...cfg }
		this.thresholds = thresholds
		this.log = log
		this.assessment = null // {verdict, headline, reasons, actions, model, t, ms}
		this.diagnoses = new Map() // alert id -> {text, t}
		this.busy = false
		this.lastError = null
	}

	get hasAnthropicKey() {
		return !!(this.cfg.anthropic_api_key || process.env.ANTHROPIC_API_KEY)
	}
	get provider() {
		if (this.cfg.provider === 'anthropic' || (!this.cfg.base_url && this.hasAnthropicKey)) return 'anthropic'
		return 'openai'
	}
	get enabled() {
		return this.cfg.enabled !== false && (this.provider === 'anthropic' ? this.hasAnthropicKey : !!this.cfg.base_url)
	}
	get modelName() {
		return this.provider === 'anthropic' ? this.cfg.anthropic_model : this.cfg.model || '(server default)'
	}

	status() {
		return { enabled: this.enabled, provider: this.provider, model: this.modelName, endpoint: this.provider === 'anthropic' ? 'api.anthropic.com' : this.cfg.base_url, busy: this.busy, lastError: this.lastError, configError: !!this.configError, assessment: this.assessment, providers: this.providers() }
	}

	// which providers are set up (the local/cloud toggle in the UI switches between the usable ones)
	providers() {
		return { local: !!this.cfg.base_url, anthropic: this.hasAnthropicKey, active: this.provider, enabled: this.enabled, localModel: this.cfg.model || '(server default)', anthropicModel: this.cfg.anthropic_model, localUrl: this.cfg.base_url }
	}

	// new settings from the Settings screen: forget the cached verdicts and the SDK client
	configure(cfg = {}, thresholds) {
		this.cfg = { ...AI_DEFAULTS, ...cfg }
		if (thresholds) this.thresholds = thresholds
		this.anthropic = null
		this.assessment = null
		this.diagnoses.clear()
		this.lastError = null
		this.configError = false // a key or workspace problem: the timer stops knocking until the settings change
	}

	// try a provider with the given (unsaved) settings: one tiny request
	async test(cfg = {}) {
		const probe = new AI({ ...this.cfg, ...cfg }, this.log, this.thresholds)
		if (!probe.enabled) throw new Error(probe.provider === 'anthropic' ? 'no Anthropic API key' : 'no server URL for the local AI')
		const r = await probe.chat([{ role: 'system', content: 'You are a connectivity test. Reply with the single word OK.' }, { role: 'user', content: 'Say OK.' }], { maxTokens: 20, temperature: 0 })
		return { ok: true, provider: probe.provider, model: probe.modelName, endpoint: probe.provider === 'anthropic' ? 'api.anthropic.com' : probe.cfg.base_url, ms: r.ms, reply: r.text.slice(0, 60) }
	}

	// the model a provider would answer with (the active one by default)
	modelFor(provider) {
		return (provider || this.provider) === 'anthropic' ? this.cfg.anthropic_model : this.cfg.model || '(server default)'
	}

	// provider: "anthropic" | "openai" overrides the active choice for this one request (the diagnose buttons)
	async chat(messages, { maxTokens = 900, temperature = 0.2, provider = null } = {}) {
		const t0 = Date.now()
		this.busy = true
		try {
			let text
			const prov = provider || this.provider
			if (prov === 'anthropic' && !this.hasAnthropicKey) throw new Error('no Anthropic API key yet: Settings > AI > Claude')
			if (prov !== 'anthropic' && !this.cfg.base_url) throw new Error('no local AI server set up yet: Settings > AI > Local AI server')
			if (prov === 'anthropic') {
				// official SDK; adaptive thinking is on by default on Claude Opus 5.5 (depth via output_config.effort),
				// sampling parameters are not sent, and a safety decline is re-run on a fallback model server-side
				// a key that is not scoped to a workspace must name one on every request (anthropic-workspace-id)
				const workspace = String(this.cfg.anthropic_workspace_id || process.env.ANTHROPIC_WORKSPACE_ID || '').trim()
				const client = this.anthropic || (this.anthropic = new Anthropic({ apiKey: this.cfg.anthropic_api_key || undefined, timeout: this.cfg.timeout_ms, maxRetries: 2, ...(workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {}) }))
				const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
				let r
				try {
					r = await client.beta.messages.create({
						model: this.cfg.anthropic_model,
						max_tokens: Math.max(maxTokens, 4000),
						betas: ['server-side-fallback-2026-07-01'],
						fallbacks: 'default',
						output_config: { effort: this.cfg.anthropic_effort || 'medium' },
						system: sys,
						messages: messages.filter((m) => m.role !== 'system'),
					})
				} catch (e) {
					const msg = String(e?.message || e)
					if (e instanceof Anthropic.BadRequestError && /workspace/i.test(msg)) {
						// "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header"
						this.configError = true
						throw new Error('Anthropic: this API key is not scoped to a workspace, so every request must name one. Paste the workspace id (console.anthropic.com > Settings > Workspaces, it starts with wrkspc_) into Settings > AI > Claude > Workspace id, or make a key inside a workspace.')
					}
					if (e instanceof Anthropic.BadRequestError && /fallback|beta|output_config|effort/i.test(msg)) {
						// an account or model that does not take the fallback / effort parameters: plain request
						r = await client.messages.create({ model: this.cfg.anthropic_model, max_tokens: Math.max(maxTokens, 4000), system: sys, messages: messages.filter((m) => m.role !== 'system') })
					} else if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
						this.configError = true
						throw new Error(`Anthropic rejected the API key (HTTP ${e.status}): check it under Settings > AI > Claude${process.env.ANTHROPIC_API_KEY ? ' (the ANTHROPIC_API_KEY environment variable is set on this machine too)' : ''}`)
					} else if (e instanceof Anthropic.RateLimitError) throw new Error('Anthropic rate limit, try again in a minute')
					else if (e instanceof Anthropic.APIError) throw new Error(`Anthropic API error ${e.status}: ${msg.slice(0, 300)}`)
					else throw e
				}
				if (r.stop_reason === 'refusal') throw new Error('the model declined this request' + (r.stop_details?.explanation ? ': ' + r.stop_details.explanation : ''))
				text = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
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
			this.configError = false
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
		const h = state.health
		if (h) {
			const ex = h.profile?.expect || {}
			L.push(`HEALTH SCORE ${h.score}/100 = ${h.verdict} (show profile "${h.profile?.name || '?'}" expects: ${Object.entries(ex).filter(([, v]) => v).map(([k]) => k.replace('_', ' ')).join(', ') || 'nothing in particular'}). This verdict is authoritative. Factors: ${h.factors.map((f) => `${f.label} ${f.value === null ? 'n/a' : Math.round(f.value * 100) + '%'}${f.critical && f.value === 0 ? ' CRITICAL' : ''}: ${f.reason}`).join(' | ')}`)
		}
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
			const ses = at.session
			if (ses) L.push(`  switcher data source: ${ses.mode === 'companion' ? 'Companion (Broadwatch holds no control slot)' : ses.mode}; Broadwatch's own session: ${ses.own ? ses.own.state + (ses.own.error ? ' (' + ses.own.error + ')' : '') : 'none'}; Companion: ${ses.companion ? (ses.companion.ok ? (ses.companion.connected ? 'connected to the switcher' : 'NOT connected to the switcher') : ses.companion.error) : 'not used'}; slot holders: ${(ses.controllers || []).map((c) => `${c.name} ${c.held === null ? 'unknown' : c.held ? 'YES' : 'no'}`).join(', ') || 'unknown'}`)
		}
		const au = state.audio
		if (au && (au.consoles.length || au.mics.length || au.others.length)) {
			const parts = [
				...au.consoles.map((c) => `${c.name}${c.console ? ' (' + c.console.model + ' "' + c.console.name + '")' : ''}: ${c.ok ? `meters live, ${c.active} channels with signal, main ${c.mainLevel !== null && c.mainLevel > -60 ? c.mainLevel.toFixed(0) + ' dBFS' : 'quiet'}` : c.error}`),
				...au.mics.map((m) => `${m.name}${m.product ? ' (' + m.product + ')' : ''}: ${m.ok ? m.channels.map((ch) => `${ch.name || ch.id}${ch.frequency ? ' ' + ch.frequency.toFixed(3) + ' MHz' : ''} ${ch.link ? `ON AIR battery ${ch.battery ?? '?'}% RF ${ch.rsqi ?? '?'}% AF ${ch.af ?? '?'} dBFS${ch.mute || ch.tx?.mute ? ' MUTED' : ''}${ch.warningText.length ? ' warnings: ' + ch.warningText.join('/') : ''}` : 'transmitter off (no link)'}`).join('; ') : m.error}`),
				...au.others.map((o) => `${o.name}: ${o.note}`),
			]
			if (au.switcher) parts.push(`switcher Fairlight levels: ${au.switcher.levels ? `master ${au.switcher.levels.master?.level ?? '?'} dBFS, ${au.switcher.levels.sources.length} inputs` : au.switcher.note || 'none'}`)
			L.push('AUDIO (a transmitter that is off is normal outside a show; low battery or weak RF on one that is on matters): ' + parts.join(' | '))
		}
		const fx = state.forensics
		if (fx?.running) L.push(`MIRROR PORT (every packet at the switcher's port, ${fx.pps} pkt/s): control sessions held by ${fx.sessions.filter((s) => s.state === 'held').map((s) => `${s.name || s.ip} (${s.pps} pkt/s)`).join(', ') || 'nobody'}; refused recently: ${fx.sessions.filter((s) => s.state === 'refused').map((s) => s.name || s.ip).join(', ') || 'none'}; live flows: ${fx.flows.filter((f) => f.live).slice(0, 6).map((f) => `${f.name || f.peer} ${f.app}->port ${f.targetPort} ${f.state} ${f.inMbps} Mb/s ${f.detail || ''}`).join('; ') || 'none'}; last events: ${fx.events.slice(0, 5).map((e) => `${new Date(e.t).toLocaleTimeString()} ${e.text}`).join(' | ') || 'none'}`)
		const sp = state.streamPaths || []
		if (sp.length) L.push('STREAM PATHS (internet -> gateway port forward -> device, last hour): ' + sp.map((p) => `[${p.status.toUpperCase()}] ${p.name}: WAN ${p.wanPorts} -> ${p.target.name} ${p.target.ip}:${p.target.port} (${p.target.standby ? 'STANDBY' : p.target.online ? 'online' : 'OFFLINE'}) ${p.hits.count} flows ${(p.hits.bytes / 1e6).toFixed(1)}MB${p.hits.blocked ? ' ' + p.hits.blocked + ' blocked' : ''}${p.hits.sources[0] ? ' from ' + (p.hits.sources[0].name || p.hits.sources[0].ip) + (p.hits.sources[0].region ? '/' + p.hits.sources[0].region : '') : ''}: ${p.verdict}`).join(' | '))
		const standby = state.equipment.filter((e) => e.active === false)
		if (standby.length) L.push('STANDBY (not part of this broadcast; ignore them, they are expected to be off or away): ' + standby.map((e) => e.name).join(', '))
		L.push('EQUIPMENT IN THIS BROADCAST:')
		for (const e of state.equipment) {
			if (e.discovered || e.active === false) continue
			const tl = e.telemetry
			const tele = tl ? (tl.kind === 'webpresenter' ? `stream ${tl.status}${tl.bitrate ? ' ' + (tl.bitrate / 1e6).toFixed(1) + 'Mb/s' : ''}` : tl.kind === 'hyperdeck' ? `deck ${tl.summary}` : tl.kind === 'atem' ? `${tl.via === 'companion' ? 'via Companion' : tl.product || 'ATEM'}${tl.programName ? ' program ' + tl.programName + (tl.previewName ? ' preview ' + tl.previewName : '') : ''} ${tl.streaming ? `own stream ${tl.streaming.state}${tl.streaming.url ? ' -> ' + tl.streaming.url : ''}${tl.streaming.bitrate ? ' ' + (tl.streaming.bitrate / 1e6).toFixed(1) + 'Mb/s' : ''}` : ''}${tl.recording?.active ? ' RECORDING ' + (tl.recording.duration || '') : ''}${tl.error ? ' (' + tl.error + ')' : ''}` : '') : ''
			L.push(`  [${e.group}] ${e.name} ${e.ip} ${e.status.toUpperCase()}${e.switch ? ` on ${e.switch.name} p${e.switch.port} ${e.switch.speed}M` : e.online ? ' (wifi)' : e.lastSeen ? ' last seen ' + Math.round((state.ts - e.lastSeen) / 60000) + ' min ago' : ''} in ${rate(e.down)} out ${rate(e.up)}${e.probe ? (e.probe.ok ? ` probe ok ${Math.round(e.probe.ms)}ms${e.probe.info?.state ? ' (' + e.probe.info.state + ')' : ''}` : ` probe FAILED ${e.probe.error || ''}`) : ''}${tele ? ' ' + tele : ''}`)
		}
		const aps = state.aps || []
		if (aps.length) L.push(`ACCESS POINTS: ${aps.filter((a) => a.online).length}/${aps.length} online` + (aps.filter((a) => !a.online).length ? ', offline: ' + aps.filter((a) => !a.online).map((a) => a.name).join(', ') : ''))
		L.push('ALERTS:' + (state.alerts.length ? '' : ' none'))
		for (const a of state.alerts) L.push(`  [${a.level}] (${a.id}) ${a.text}${a.since ? ` since ${new Date(a.since).toLocaleTimeString()}` : ''}`)
		const ev = (state.events || []).slice(0, 12)
		if (ev.length) L.push('BROADWATCHER EVENTS (newest first): ' + ev.map((x) => `${new Date(x.t).toLocaleTimeString()} ${x.text}`).join(' | '))
		if (this.journal) L.push(this.journal.summaryText(state.ts || Date.now()))
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
		const h = state.health
		const prompt = `Here is the live state of the network:\n\n${this.digest(state)}\n\n${h ? `Broadwatch's health score has already set the verdict: ${h.verdict} (${h.score}/100). Keep that verdict and explain it: ` : 'Assess broadcast readiness right now. '}Reply with ONE JSON object and nothing else, in this shape:
{"verdict":"READY"|"DEGRADED"|"AT RISK"|"DOWN","headline":"one sentence, max 18 words","reasons":["3 to 6 short bullets: what matters most, each naming the device/port/number"],"actions":["0 to 4 concrete things to check or do now, most urgent first"],"confidence":"high"|"medium"|"low"}
Rules: READY = every broadcast path is healthy; DEGRADED = something is wrong but a show can run; AT RISK = a failure is likely to hit a show; DOWN = a broadcast path is broken now. Offline portable kit and spares are normal, not a problem. Unnamed or unidentified devices are low priority.`
		const { text, ms } = await this.chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], { maxTokens: 700, temperature: 0.1 })
		const j = extractJson(text) || { verdict: 'UNKNOWN', headline: text.slice(0, 160), reasons: [], actions: [] }
		const aiVerdict = String(j.verdict || 'UNKNOWN').toUpperCase()
		// the score is the verdict; the model narrates (its own call is kept for the record)
		this.assessment = { ...j, verdict: h ? h.verdict : aiVerdict, aiVerdict, score: h ? h.score : null, reasons: arr(j.reasons), actions: arr(j.actions), model: this.modelName, t: Date.now(), ms, alertKey: state.alerts.map((a) => a.id).join('|') }
		return this.assessment
	}

	async diagnose(state, alert, details, { force = false, provider = null } = {}) {
		if (!this.enabled && !provider) return null
		const c = this.diagnoses.get(alert.id)
		if (c && !force && Date.now() - c.t < 300000 && (!provider || c.provider === provider)) return c
		const prompt = `Network state:\n\n${this.digest(state)}\n\nALERT TO DIAGNOSE: [${alert.level}] ${alert.text}\nscope ${alert.scope}, kind ${alert.kind}, since ${alert.since ? new Date(alert.since).toLocaleTimeString() : '?'}
Entity details: ${JSON.stringify(details.entity || {}).slice(0, 3000)}
Related UniFi events: ${(details.log || []).slice(0, 10).map((l) => `${new Date(l.t).toLocaleTimeString()} ${l.title}`).join(' | ') || 'none'}
Related flows: ${(details.flows || []).slice(0, 8).map((f) => `${f.srcName || f.src} -> ${f.dstName || f.dst}:${f.dport} ${f.proto} ${(f.bytes / 1e6).toFixed(1)}MB`).join('; ') || 'none'}
Related Broadwatch events: ${(details.events || []).slice(0, 8).map((x) => `${new Date(x.t).toLocaleTimeString()} ${x.text}`).join(' | ') || 'none'}

Explain in plain language, as 3 short sections with these exact headings: "What this means", "Likely causes" (most likely first, say how you know), "What to check now" (numbered, concrete: which device, port, cable, setting). Max 170 words. Mention how it affects a live broadcast.`
		const { text, ms } = await this.chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], { maxTokens: 600, temperature: 0.2, provider })
		const d = { id: alert.id, text, model: this.modelFor(provider), provider: provider || this.provider, t: Date.now(), ms }
		this.diagnoses.set(alert.id, d)
		return d
	}

	async ask(state, question, history = [], { provider = null } = {}) {
		if (!this.enabled && !provider) return null
		const messages = [
			{ role: 'system', content: SYSTEM },
			{ role: 'user', content: `Network state right now:\n\n${this.digest(state)}` },
			{ role: 'assistant', content: 'Understood. I have the live state. Ask me anything about it.' },
			...history.slice(-6),
			{ role: 'user', content: question },
		]
		const { text, ms } = await this.chat(messages, { maxTokens: 700, temperature: 0.3, provider })
		return { text, model: this.modelFor(provider), provider: provider || this.provider, t: Date.now(), ms }
	}

	// the mirror-port capture read like a Wireshark session: control sessions, flows with their RTMP/SRT detail,
	// the event tape; optionally one peer in focus, and a free question about it
	async explainForensics(state, fx, { focus = null, question = '', provider = null } = {}) {
		if (!this.enabled && !provider) return null
		const time = (t) => (t ? new Date(t).toLocaleTimeString() : '?')
		const mb = (b) => (b / 1e6).toFixed(1) + 'MB'
		const sessions = (fx.sessions || [])
			.filter((s) => !focus || s.ip === focus)
			.slice(0, 40)
			.map((s) => `${s.name || s.ip}:${s.port} ${s.state}${s.hello ? ' · last hello ' + s.hello.text + ' at ' + time(s.hello.t) : ''}${s.refusals ? ' · refused ' + s.refusals + 'x' : ''} · since ${time(s.since)} last ${time(s.last)} · ${s.pps} pkt/s · in ${s.pktsIn} out ${s.pktsOut} packets`)
		const flows = (fx.flows || [])
			.filter((f) => !focus || f.peer === focus)
			.slice(0, 70)
			.map((f) => `${time(f.first)}→${time(f.endedAt || f.last)} ${f.app} ${f.outbound ? 'switcher → ' : ''}${f.name || f.peer}:${f.peerPort}${f.outbound ? '' : ' → switcher port ' + f.targetPort} · ${f.state}${f.detail ? ' · ' + f.detail : ''} · in ${mb(f.bytesIn)}/${f.pktsIn} pk, out ${mb(f.bytesOut)}/${f.pktsOut} pk${f.live ? ' · LIVE ' + f.inMbps + ' Mb/s' : ''}${f.rtmp ? ' · rtmp ' + JSON.stringify(f.rtmp) : ''}${f.srt ? ' · srt ' + JSON.stringify(f.srt) : ''}`)
		const events = (fx.events || [])
			.filter((e) => !focus || e.peer === focus)
			.slice(0, 90)
			.map((e) => `${time(e.t)} [${e.kind}${e.level === 'warn' ? '!' : ''}] ${e.text}`)
		const prompt = `A packet capture summary from a mirror of the ATEM switcher's switch port (tshark, read by Broadwatch). The switcher is ${fx.target}. Capture ${fx.running ? 'running' : 'stopped'} since ${time(fx.since)}, ${fx.packets} packets so far, ${fx.pps} packets/s now; the session holds ${fx.totals?.sessions ?? '?'} control sockets, ${fx.totals?.flows ?? '?'} flows, ${fx.totals?.events ?? '?'} events in all.

CONTROL SESSIONS (UDP 9910; "held" = the switcher sends its once-a-second keepalive to that socket; the HD8 has only a handful of slots):
${sessions.join('\n') || 'none'}

FLOWS (newest first; a stream is RTMP to port 1935 or SRT; the switcher itself talks to Blackmagic's cloud on 443):
${flows.join('\n') || 'none'}

EVENTS (newest first):
${events.join('\n') || 'none'}

${focus ? `Focus on ${focus}. ` : ''}${question ? `The engineer asks: ${question}\n\n` : ''}Answer as a broadcast network engineer reading a Wireshark session, in at most 230 words, with these exact headings: "What the capture shows", "Anything wrong" (rejected or reset streams, refused control connections, odd rates or retries; say how you know, with times), "Who is talking to the switcher", "What to do next" (numbered, concrete). Stream keys stay masked.`
		const { text, ms } = await this.chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], { maxTokens: 800, temperature: 0.2, provider })
		return { text, model: this.modelFor(provider), provider: provider || this.provider, t: Date.now(), ms, focus, question: question || null }
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
