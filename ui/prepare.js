/* "Prepare a broadcast": pick or create a show profile, say what the show expects to be running, tick the roster,
   test every probe, save and activate. Profiles live in the user config; the active one drives the health score. */
window.Prepare = (function () {
	const $ = (id) => document.getElementById(id)
	const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
	const EXPECT = [
		['stream_out', 'Streaming out', 'a Web Presenter or the switcher pushes the programme to the internet'],
		['stream_in', 'Remote sources in', 'a stream from outside arrives at the switcher'],
		['recording', 'Recorders rolling', 'HyperDecks and the switcher ISO record'],
		['mics', 'Wireless mics', 'the EW-DX receivers are on'],
		['dante', 'Dante in use', 'the Dante consoles and interfaces are up'],
		['ndi', 'NDI in use', 'NDI sources are on the NDI VLAN'],
	]
	// the cards of the health board a show can switch on or off
	const TILES = [
		['switcher', 'ATEM switcher'],
		['encoders', 'Stream out'],
		['recorders', 'Recorders'],
		['audio', 'Audio consoles'],
		['mics', 'Wireless mics'],
		['dante', 'Dante'],
		['ndi', 'NDI'],
		['network', 'Network'],
		['power', 'Power (PDUs)'],
		['pc', 'This PC'],
	]
	const DEFAULT_TILES = ['switcher', 'encoders', 'recorders', 'audio', 'mics', 'dante', 'ndi'] // the board without Network and This PC
	let data = null // {profiles, active, equipment}
	let cur = null // the profile being edited (working copy)

	async function open() {
		try {
			const r = await fetch('/api/profiles')
			data = await r.json()
		} catch (e) {
			data = { error: e.message }
		}
		if (!data.error) {
			cur = JSON.parse(JSON.stringify(data.profiles.find((p) => p.id === data.active) || data.profiles[0]))
			if (!cur.roster) cur.roster = data.equipment.filter((e) => e.active !== false).map((e) => e.ip)
		}
		$('prepareOverlay').hidden = false
		render()
	}
	function close() {
		$('prepareOverlay').hidden = true
	}

	function render(msg = '') {
		if (!data || data.error) return ($('prepareEditor').innerHTML = `<header><h2>Prepare a broadcast</h2></header><div class="body"><p class="error">${esc(data?.error || 'could not load')}</p></div><footer><button class="btn" id="prepClose">Close</button></footer>`)
		const groups = new Map()
		for (const e of data.equipment) {
			if (!groups.has(e.group)) groups.set(e.group, [])
			groups.get(e.group).push(e)
		}
		const set = new Set(cur.roster || [])
		$('prepareEditor').innerHTML = `<header><h2>Prepare a broadcast</h2><small>what this show expects to be running, and which devices are part of it; the health score and the alerts follow the active profile</small></header>
		<div class="body prep">
			<div class="head"><span>Show profile</span><div><select id="prepProfile">${data.profiles.map((p) => `<option value="${esc(p.id)}" ${p.id === cur.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}<option value="__new">New profile…</option></select> <input id="prepName" value="${esc(cur.name)}" placeholder="profile name" style="width:240px;margin-left:8px"></div></div>
			<h3>Expected during this show</h3>
			<div class="exp">${EXPECT.map(([k, l, help]) => `<label class="chk" title="${esc(help)}"><input type="checkbox" data-exp="${k}" ${cur.expect?.[k] ? 'checked' : ''}> ${l}</label>`).join('')}</div>
			<h3>Cards on the health board <small>· untick what this show does not need; the score still weighs everything</small></h3>
			<div class="exp">${TILES.map(([id, l]) => `<label class="chk"><input type="checkbox" data-tile="${id}" ${(cur.tiles && cur.tiles.length ? cur.tiles : DEFAULT_TILES).includes(id) ? 'checked' : ''}> ${l}</label>`).join('')}</div>
			<h3>Devices in this broadcast <small>· ${set.size} of ${data.equipment.length} ticked · unticked devices go on standby (no probes, no alerts)</small></h3>
			<div class="roster">${[...groups]
				.map(([g, list]) => `<h4>${esc(g)}</h4>${list.map((e) => `<label><input type="checkbox" data-ip="${esc(e.ip)}" ${set.has(e.ip) ? 'checked' : ''}><span>${esc(e.name)}</span><small>${esc(e.ip)}</small></label>`).join('')}`)
				.join('')}</div>
			<div class="row" style="margin-top:14px;display:flex;gap:10px;align-items:center"><button class="btn" id="prepTest">Test every probe</button><span class="msg" id="prepTestMsg"></span></div>
			<div class="testout" id="prepTestOut" hidden></div>
		</div>
		<footer><button class="btn primary" id="prepSave">Save and make active</button><button class="btn quiet" id="prepSaveOnly">Save only</button><button class="btn quiet" id="prepDelete" ${data.profiles.length <= 1 ? 'disabled' : ''}>Delete profile</button><button class="btn quiet" id="prepClose">Close</button><span class="msg" id="prepMsg">${esc(msg)}</span></footer>`
	}

	function collect() {
		cur.name = $('prepName').value.trim() || cur.name
		cur.expect = Object.fromEntries(EXPECT.map(([k]) => [k, !!$('prepareEditor').querySelector(`[data-exp="${k}"]`)?.checked]))
		cur.roster = [...$('prepareEditor').querySelectorAll('[data-ip]')].filter((c) => c.checked).map((c) => c.getAttribute('data-ip'))
		cur.tiles = [...$('prepareEditor').querySelectorAll('[data-tile]')].filter((c) => c.checked).map((c) => c.getAttribute('data-tile'))
		return cur
	}
	function switchProfile(id) {
		collect()
		const i = data.profiles.findIndex((p) => p.id === cur.id)
		if (i >= 0) data.profiles[i] = cur
		else data.profiles.push(cur)
		if (id === '__new') {
			const n = data.profiles.length + 1
			cur = { id: `profile${n}`, name: `Profile ${n}`, expect: { ...cur.expect }, roster: [...cur.roster] }
		} else {
			cur = JSON.parse(JSON.stringify(data.profiles.find((p) => p.id === id) || data.profiles[0]))
			if (!cur.roster) cur.roster = data.equipment.filter((e) => e.active !== false).map((e) => e.ip)
		}
		render()
	}
	async function save(activate) {
		collect()
		const i = data.profiles.findIndex((p) => p.id === cur.id)
		if (i >= 0) data.profiles[i] = cur
		else data.profiles.push(cur)
		const btn = $('prepSave')
		btn.disabled = true
		try {
			const r = await fetch('/api/profiles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profiles: data.profiles, active: activate ? cur.id : data.active, applyRoster: activate }) })
			const j = await r.json()
			if (j.error) throw new Error(j.error)
			data.active = j.active
			$('prepMsg').textContent = activate ? `"${cur.name}" is the active profile${j.saved ? '' : ' (could not write the config file)'}` : 'saved'
			$('prepMsg').className = 'msg ok'
			if (activate) setTimeout(close, 600)
		} catch (e) {
			$('prepMsg').textContent = 'could not save: ' + e.message
			$('prepMsg').className = 'msg error'
		}
		btn.disabled = false
	}
	async function test() {
		const out = $('prepTestOut')
		$('prepTestMsg').textContent = 'probing every device in the roster…'
		out.hidden = true
		try {
			const r = await fetch('/api/probe/test', { method: 'POST' })
			const j = await r.json()
			const rows = (j.results || []).map((x) => `<div><span>${esc(x.name)}<br><small class="mono">${esc(x.ip)}</small></span><span>${x.online ? `<span class="ok">on the network</span>${x.link ? ' · ' + esc(x.link) : ''}` : '<span class="error">not on the network</span>'}</span><span>${x.probe ? (x.probe.ok ? `<span class="ok">probe ok</span> ${esc(x.probe.state || '')} ${x.probe.ms ? Math.round(x.probe.ms) + ' ms' : ''}` : `<span class="error">probe failed</span> ${esc(x.probe.error || '')}`) : '<small>no probe</small>'}${x.telemetry ? `<br>${x.telemetry.error ? `<span class="warn">${esc(x.telemetry.error)}</span>` : esc(x.telemetry.kind + ': ' + (x.telemetry.summary || 'ok'))}` : ''}</span></div>`)
			out.innerHTML = rows.join('') || '<div>no active devices</div>'
			out.hidden = false
			const bad = (j.results || []).filter((x) => !x.online || (x.probe && !x.probe.ok)).length
			$('prepTestMsg').textContent = bad ? `${bad} device${bad === 1 ? '' : 's'} with a problem` : 'everything answers'
			$('prepTestMsg').className = bad ? 'msg warn' : 'msg ok'
		} catch (e) {
			$('prepTestMsg').textContent = 'test failed: ' + e.message
		}
	}

	document.addEventListener('click', (e) => {
		const t = e.target
		if (!t.closest?.('#prepareEditor')) {
			if (t.id === 'prepareOverlay') close()
			return
		}
		if (t.id === 'prepClose') return close()
		if (t.id === 'prepSave') return save(true)
		if (t.id === 'prepSaveOnly') return save(false)
		if (t.id === 'prepTest') return test()
		if (t.id === 'prepDelete') {
			if (data.profiles.length <= 1) return
			data.profiles = data.profiles.filter((p) => p.id !== cur.id)
			cur = JSON.parse(JSON.stringify(data.profiles[0]))
			if (!cur.roster) cur.roster = data.equipment.filter((e) => e.active !== false).map((e) => e.ip)
			render('profile removed (save to keep)')
		}
	})
	document.addEventListener('change', (e) => {
		if (e.target.id === 'prepProfile') switchProfile(e.target.value)
		if (e.target.id === 'prepName' && cur) cur.name = e.target.value
	})
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && !$('prepareOverlay').hidden) close()
	})
	return { open, close }
})()
