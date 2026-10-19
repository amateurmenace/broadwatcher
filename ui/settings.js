/* Settings screen: AI (local server or Claude, with the keys), UniFi gateway, SNMP, Companion, server, thresholds.
   Reads /api/settings, tests a section with /api/settings/test, saves with POST /api/settings (only the sections
   that changed; an empty secret field keeps the stored secret, "Remove" sends null). */
window.Settings = (function () {
	const $ = (id) => document.getElementById(id)
	const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
	let data = null // what the server gave us
	let onSaved = null

	async function open(section, opts = {}) {
		onSaved = opts.onSaved || null
		try {
			const r = await fetch('/api/settings')
			data = await r.json()
		} catch (e) {
			data = { error: e.message }
		}
		$('settingsOverlay').hidden = false
		render(opts.welcome ? 'welcome' : '')
		if (section) setTimeout(() => $('set-' + section)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50)
	}
	function close() {
		$('settingsOverlay').hidden = true
	}

	const secret = (id, k, placeholder) => `<div class="secret"><input id="${id}" type="password" autocomplete="off" placeholder="${k?.set ? 'saved ' + esc(k.hint) + ' · type to replace' : esc(placeholder)}"><button class="btn quiet eye" type="button" data-eye="${id}" title="show">◉</button>${k?.set ? `<button class="btn quiet" type="button" data-clear="${id}" title="forget the saved key">Remove</button>` : ''}</div>`
	const field = (label, html, help) => `<label class="field"><span>${esc(label)}</span><div>${html}${help ? `<small>${help}</small>` : ''}</div></label>`
	const num = (id, v, min, max, step) => `<input id="${id}" type="number" value="${esc(v)}" min="${min}" max="${max}" step="${step || 1}" class="short">`

	function render(msg = '') {
		const d = data
		if (!d || d.error) return ($('settingsEditor').innerHTML = `<header><h2>Settings</h2></header><div class="body"><p class="error">${esc(d?.error || 'could not load the settings')}</p></div><footer><button class="btn" id="setClose">Close</button></footer>`)
		const ai = d.ai
		const pv = ai.providers || {}
		const prov = ai.provider === 'anthropic' ? 'anthropic' : 'local'
		const welcome = msg === 'welcome'
		$('settingsEditor').innerHTML = `<header><h2>Settings</h2><small>${d.flavor === 'public' ? 'Broadwatcher Community' : 'Broadwatcher'} · saved to ${esc(d.configPath || 'the user config')}</small><nav class="jump">${['ai', 'gateway', 'snmp', 'companion', 'capture', 'server', 'thresholds'].map((s) => `<a href="#set-${s}" data-jump="${s}">${{ ai: 'AI', gateway: 'UniFi gateway', snmp: 'SNMP', companion: 'Companion', capture: 'Capture', server: 'Server', thresholds: 'Thresholds' }[s]}</a>`).join('')}</nav></header>
		<div class="body settings">
			${welcome ? `<div class="welcome"><h3>Welcome</h3><p>Broadwatcher needs three things to start watching a network: the address and an Integrations API key of your UniFi gateway, the SNMP community if you want live port counters, and an AI provider for the readiness verdict (a local OpenAI-compatible server such as LM Studio, or Claude with your own Anthropic key). Everything else can wait.</p></div>` : ''}
			<section id="set-ai"><h3>AI</h3>
				<div class="seg" role="radiogroup"><button type="button" class="${prov === 'local' ? 'on' : ''}" data-prov="local">Local AI server</button><button type="button" class="${prov === 'anthropic' ? 'on' : ''}" data-prov="anthropic">Claude (Anthropic)</button></div>
				<p class="hint">The readiness verdict, alert diagnoses and the Ask box use whichever is selected. Local keeps everything on your network and costs nothing but GPU time; Claude is stronger and leaves the PC free (a verdict is a few thousand tokens; about ${ai.anthropic_model === 'claude-opus-5-5' ? '$0.50' : ai.anthropic_model === 'claude-sonnet-5-5' ? '$0.25' : '$0.02'} an hour at the default cadence).</p>
				<div class="prov local ${prov === 'local' ? '' : 'dim'}">
					${field('Server URL', `<input id="ai_base_url" value="${esc(ai.base_url)}" placeholder="http://127.0.0.1:1234/v1">`, 'any OpenAI-compatible chat endpoint: LM Studio, Ollama (…/v1), vLLM')}
					${field('Model', `<input id="ai_model" value="${esc(ai.model)}" placeholder="server default">`)}
					${field('API key', secret('ai_api_key', ai.keys.local, 'optional'), 'only if the server asks for one')}
					<div class="row"><button class="btn" type="button" data-test="ai" data-prov-test="local">Test local AI</button><span class="msg" id="test-ai-local"></span></div>
				</div>
				<div class="prov anthropic ${prov === 'anthropic' ? '' : 'dim'}">
					${field('Anthropic API key', secret('ai_anthropic_api_key', ai.keys.anthropic, 'sk-ant-…'), ai.keys.env ? 'an ANTHROPIC_API_KEY environment variable is also set on this machine' : 'stored only in your local config file; never sent anywhere but api.anthropic.com')}
					${field('Model', `<select id="ai_anthropic_model">${ai.models.map((m) => `<option value="${esc(m.id)}" ${m.id === ai.anthropic_model ? 'selected' : ''}>${esc(m.label)} · ${esc(m.price)}</option>`).join('')}</select>`)}
					${field('Effort', `<select id="ai_anthropic_effort">${['low', 'medium', 'high'].map((e) => `<option ${e === ai.anthropic_effort ? 'selected' : ''}>${e}</option>`).join('')}</select>`, 'how long Claude thinks before answering; medium is plenty for a verdict')}
					<div class="row"><button class="btn" type="button" data-test="ai" data-prov-test="anthropic">Test Claude</button><span class="msg" id="test-ai-anthropic"></span></div>
				</div>
				<div class="row"><label class="chk"><input type="checkbox" id="ai_enabled" ${ai.enabled ? 'checked' : ''}> AI assessments on</label><label class="chk">reassess every ${num('ai_assess_every_s', ai.assess_every_s, 60, 3600, 30)} s</label></div>
			</section>
			<section id="set-gateway"><h3>UniFi gateway</h3>
				${field('Name', `<input id="gw_name" value="${esc(d.gateway.name)}" placeholder="BIG WAN (UDM Pro Max)">`)}
				${field('URL', `<input id="gw_url" value="${esc(d.gateway.url)}" placeholder="https://192.168.1.1">`, 'the console itself (UDM / UCG / Cloud Key), not the cloud')}
				${field('Integrations API key', secret('gw_api_key', d.gateway.key, 'from UniFi Network > Settings > Control Plane > Integrations'))}
				${field('Site', `<input id="gw_site" value="${esc(d.gateway.site)}" class="short">`)}
				${field('Dashboard link', `<input id="gw_ui_url" value="${esc(d.gateway.ui_url)}" placeholder="https://192.168.1.1/network/default/dashboard">`)}
				${field('VLANs in the top bar', `<input id="gw_networks" value="${esc((d.networks || []).join(', '))}" placeholder="Default, BIG_NDI, BIG_MOBILE_DANTE">`, `network names as UniFi spells them, in the order shown; known: ${esc((d.knownNetworks || []).map((n) => n.name + (n.vlan ? ' (' + n.vlan + ')' : '')).join(', ') || 'none yet')}. Three or four fit; the bar sheds them on narrow windows.`)}
				<div class="row"><button class="btn" type="button" data-test="gateway">Test gateway</button><span class="msg" id="test-gateway"></span></div>
			</section>
			<section id="set-snmp"><h3>SNMP (live port counters)</h3>
				${field('Community', secret('snmp_community', { set: !!d.snmp.community, hint: d.snmp.community ? d.snmp.community.slice(-2) : '' }, 'netwatch'), 'UniFi Network > Settings > System > Advanced > SNMP, v1/v2c; empty = counters from the controller only (30-90 s old)')}
				${field('Read every', `${num('snmp_every_s', d.snmp.every_s, 2, 60)} s`)}
				<div class="row"><button class="btn" type="button" data-test="snmp">Test SNMP</button><span class="msg" id="test-snmp"></span></div>
			</section>
			<section id="set-companion"><h3>Companion</h3>
				${field('HTTP API', `<input id="cmp_url" value="${esc(d.companion.url)}" placeholder="http://127.0.0.1:8000">`, 'Bitfocus Companion on this machine; its ATEM connection hands over the switcher state so Broadwatcher takes no control slot')}
				${field('ATEM connection label', `<input id="cmp_atem_label" value="${esc(d.companion.atem_label)}" class="short" placeholder="atem">`)}
				<div class="row"><label class="chk"><input type="checkbox" id="cmp_autostart" ${d.companion.autostart ? 'checked' : ''}> start Companion with Broadwatcher</label><button class="btn" type="button" data-test="companion">Test Companion</button><span class="msg" id="test-companion"></span></div>
			</section>
			<section id="set-capture"><h3>Capture (mirror port)</h3>
				<p class="hint">A switch port mirrored from the switcher's port, plugged into a spare network adapter of this computer, lets Broadwatcher read every stream and control session as the switcher sees them (needs Wireshark with Npcap, or tshark). Leave the interface empty to turn it off.</p>
				${field('Capture interface', `<input id="cap_interface" value="${esc(d.capture?.interface || '')}" placeholder="the adapter's name in Windows / macOS, e.g. Port 15 MIRROR">`, d.capture?.running ? `running · ${esc(d.capture.error || '')}` : d.capture?.error ? esc(d.capture.error) : 'as listed by tshark -D')}
				${field('tshark', `<input id="cap_tshark" value="${esc(d.capture?.tshark || '')}" placeholder="${esc(d.capture?.tsharkDefault || 'C:\\\\Program Files\\\\Wireshark\\\\tshark.exe')}">`, 'empty = the default path for this operating system')}
				<div class="row"><label class="chk"><input type="checkbox" id="cap_enabled" ${d.capture?.enabled !== false ? 'checked' : ''}> capture on</label><button class="btn" type="button" data-test="capture">List interfaces</button><span class="msg" id="test-capture"></span></div>
			</section>
			<section id="set-server"><h3>Server</h3>
				${field('Listen on', `<select id="srv_host"><option value="127.0.0.1" ${d.server.host === '127.0.0.1' ? 'selected' : ''}>this computer only (127.0.0.1)</option><option value="0.0.0.0" ${d.server.host === '0.0.0.0' ? 'selected' : ''}>the whole LAN (0.0.0.0) · phones and other computers</option></select>`, 'takes effect after Broadwatcher restarts')}
				${field('Port', num('srv_port', d.server.port, 1024, 65535))}
			</section>
			<section id="set-thresholds"><h3>Thresholds</h3>
				<div class="grid4">
					${field('WAN latency', `${num('th_wan_latency_ms', d.thresholds.wan_latency_ms, 1, 2000)} ms`)}
					${field('CPU', `${num('th_cpu_pct', d.thresholds.cpu_pct, 1, 100)} %`)}
					${field('Memory', `${num('th_mem_pct', d.thresholds.mem_pct, 1, 100)} %`)}
					${field('Temperature', `${num('th_temp_c', d.thresholds.temp_c, 1, 120)} °C`)}
					${field('Stream rise', `${num('th_stream_min_mbps', d.thresholds.stream_min_mbps, 0.1, 100, 0.1)} Mb/s`, 'how much the switcher intake must rise above its quiet level to count as an arriving stream')}
				</div>
			</section>
		</div>
		<footer><button class="btn primary" id="setSave">Save</button><button class="btn quiet" id="setClose">Close</button><span class="msg" id="setMsg">${welcome ? '' : esc(msg)}</span></footer>`
	}

	const val = (id) => $(id)?.value ?? undefined
	const secretVal = (id) => {
		const el = $(id)
		if (!el) return undefined
		if (el.dataset.clear === '1') return null
		return el.value || ''
	}
	function collect() {
		const prov = $('settingsEditor').querySelector('.seg button.on')?.getAttribute('data-prov') || 'local'
		return {
			ai: { enabled: $('ai_enabled').checked, provider: prov === 'anthropic' ? 'anthropic' : 'openai', base_url: val('ai_base_url').trim(), model: val('ai_model').trim(), api_key: secretVal('ai_api_key'), anthropic_api_key: secretVal('ai_anthropic_api_key'), anthropic_model: val('ai_anthropic_model'), anthropic_effort: val('ai_anthropic_effort'), assess_every_s: Number(val('ai_assess_every_s')) || 180 },
			gateway: { name: val('gw_name').trim(), url: val('gw_url').trim(), api_key: secretVal('gw_api_key'), site: val('gw_site').trim() || 'default', ui_url: val('gw_ui_url').trim() },
			networks: val('gw_networks').split(',').map((s) => s.trim()).filter(Boolean),
			snmp: { community: secretVal('snmp_community'), every_s: Number(val('snmp_every_s')) || 3 },
			companion: { url: val('cmp_url').trim(), atem_label: val('cmp_atem_label').trim() || 'atem', autostart: $('cmp_autostart').checked },
			server: { host: val('srv_host'), port: Number(val('srv_port')) || 8766 },
			capture: { interface: val('cap_interface').trim(), tshark: val('cap_tshark').trim(), enabled: $('cap_enabled').checked },
			thresholds: { wan_latency_ms: Number(val('th_wan_latency_ms')), cpu_pct: Number(val('th_cpu_pct')), mem_pct: Number(val('th_mem_pct')), temp_c: Number(val('th_temp_c')), stream_min_mbps: Number(val('th_stream_min_mbps')) },
		}
	}

	async function test(section, provTest, btn) {
		const out = $('test-' + section + (provTest ? '-' + provTest : ''))
		btn.disabled = true
		out.textContent = 'testing…'
		out.className = 'msg'
		try {
			const all = collect()
			let values = all[section]
			if (section === 'ai') values = { ...values, provider: provTest === 'anthropic' ? 'anthropic' : 'openai' }
			// an untouched secret field means "use the saved one": send nothing for it
			for (const k of Object.keys(values)) if (values[k] === '') delete values[k]
			const r = await fetch('/api/settings/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ section, values }) })
			const j = await r.json()
			if (!j.ok) throw new Error(j.error || 'failed')
			out.textContent = section === 'ai' ? `OK · ${j.model} answered "${j.reply}" in ${(j.ms / 1000).toFixed(1)} s` : section === 'gateway' ? `OK · ${j.gateway} · ${j.devices} devices, ${j.switches} switches` : section === 'companion' ? `OK · ${j.connections} connections · ATEM: ${j.atem}` : section === 'snmp' ? `OK · ${j.switch} answered for ${j.ports} ports` : section === 'capture' ? `tshark sees: ${j.interfaces.join(' · ')}${j.found === false ? ' · the configured interface is not among them' : j.found ? ' · configured interface found' : ''}` : 'OK'
			out.className = 'msg ok'
		} catch (e) {
			out.textContent = 'failed: ' + e.message
			out.className = 'msg error'
		}
		btn.disabled = false
	}

	async function save() {
		const btn = $('setSave')
		btn.disabled = true
		btn.textContent = 'Saving…'
		try {
			const r = await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(collect()) })
			const j = await r.json()
			if (j.error) throw new Error(j.error)
			const parts = []
			if (j.applied?.length) parts.push('applied: ' + j.applied.join(', '))
			if (j.needsRestart?.length) parts.push('after a restart: ' + j.needsRestart.join(', '))
			if (!j.sections?.length) parts.push('nothing changed')
			else if (!j.saved) parts.push('could not write the config file')
			$('setMsg').textContent = 'Saved · ' + parts.join(' · ')
			$('setMsg').className = 'msg ok'
			if (onSaved) onSaved(j)
			// reload the masked view so the key fields show "saved"
			const r2 = await fetch('/api/settings')
			data = await r2.json()
			render('Saved · ' + parts.join(' · '))
		} catch (e) {
			$('setMsg').textContent = 'could not save: ' + e.message
			$('setMsg').className = 'msg error'
		}
		btn.disabled = false
		btn.textContent = 'Save'
	}

	document.addEventListener('click', (e) => {
		const t = e.target
		if (!t.closest?.('#settingsEditor')) {
			if (t.id === 'settingsOverlay') close()
			return
		}
		if (t.id === 'setClose') return close()
		if (t.id === 'setSave') return save()
		const prov = t.closest('[data-prov]')
		if (prov) {
			for (const b of $('settingsEditor').querySelectorAll('.seg button')) b.classList.toggle('on', b === prov)
			$('settingsEditor').querySelector('.prov.local').classList.toggle('dim', prov.getAttribute('data-prov') !== 'local')
			$('settingsEditor').querySelector('.prov.anthropic').classList.toggle('dim', prov.getAttribute('data-prov') !== 'anthropic')
			return
		}
		const tb = t.closest('[data-test]')
		if (tb) return test(tb.getAttribute('data-test'), tb.getAttribute('data-prov-test'), tb)
		const eye = t.closest('[data-eye]')
		if (eye) {
			const inp = $(eye.getAttribute('data-eye'))
			inp.type = inp.type === 'password' ? 'text' : 'password'
			return
		}
		const clr = t.closest('[data-clear]')
		if (clr) {
			const inp = $(clr.getAttribute('data-clear'))
			inp.value = ''
			inp.dataset.clear = '1'
			inp.placeholder = 'will be removed on Save'
			clr.remove()
			return
		}
		const j = t.closest('[data-jump]')
		if (j) {
			e.preventDefault()
			$('set-' + j.getAttribute('data-jump'))?.scrollIntoView({ block: 'start', behavior: 'smooth' })
		}
	})
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && !$('settingsOverlay').hidden) close()
	})

	return { open, close }
})()
