/* Broadwatcher phone page: health verdict, the eight tiles, open items, streams into the switcher, stream paths,
   the Ask box and the event tape, fed by the same server-sent events as the desk. The access key arrives in the
   link once (?key=…) and lives in a cookie from then on. */
'use strict'
const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const fmtRate = (v) => ((v = Number(v) || 0), v >= 1000 ? (v / 1000).toFixed(2) + ' Gb/s' : v >= 100 ? v.toFixed(0) + ' Mb/s' : v >= 1 ? v.toFixed(1) + ' Mb/s' : v > 0 ? (v * 1000).toFixed(0) + ' kb/s' : '0')
const fmtBytes = (b) => ((b = Number(b) || 0), b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : b >= 1e3 ? (b / 1e3).toFixed(0) + ' kB' : b + ' B')
const fmtAgo = (ms) => {
	if (!ms) return '–'
	const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
	return s < 60 ? s + ' s' : s < 3600 ? Math.floor(s / 60) + ' min' : s < 86400 ? Math.floor(s / 3600) + ' h' : Math.floor(s / 86400) + ' d'
}
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '–')
const nice = (v) => String(v || '').charAt(0).toUpperCase() + String(v || '').slice(1).toLowerCase()
const verdictClass = (v) => ({ READY: 'ready', DEGRADED: 'degraded', 'AT RISK': 'risk', DOWN: 'down' }[String(v || '').toUpperCase()] || '')
let aiInfo = null
let state = null
const qa = []

function render(s) {
	state = s
	$('when').textContent = `updated ${fmtTime(s.ts)}`
	const h = s.health
	const aiFresh = aiInfo && Date.now() - aiInfo.t < 900000
	if (h) {
		const why = h.factors.filter((f) => f.value !== null && f.value < 1).sort((a, b) => b.weight * (1 - b.value) - a.weight * (1 - a.value)).slice(0, 3)
		$('verdict').innerHTML = `<span class="lamp ${verdictClass(h.verdict)}"></span><div><b>${esc(nice(h.verdict))}</b><div class="score">${h.score}/100 · ${esc(h.profile?.name || '')}</div><p>${esc(aiFresh ? aiInfo.headline : h.headline)}</p>${why.length ? `<small>${why.map((f) => `${esc(f.label)}: ${esc(f.reason)}`).join(' · ')}</small>` : ''}${aiFresh && aiInfo.actions?.length ? `<small>Do now: ${aiInfo.actions.slice(0, 2).map(esc).join(' · ')}</small>` : ''}</div>`
	}
	$('tiles').innerHTML = (s.tiles || []).map((t) => `<div class="tile ${esc(t.level)}"><div class="th"><span class="lamp sm ${esc(t.level)}"></span>${esc(t.label)}</div><div class="tv">${esc(t.value)}${t.unit ? `<small>${esc(t.unit)}</small>` : ''}</div><div class="tl">${esc(t.line)}</div></div>`).join('')
	$('alerts').innerHTML = s.alerts.length ? s.alerts.map((a) => `<div class="${esc(a.level)}"><span class="k">${esc(a.scope)}</span> ${esc(a.text)}<small>${fmtAgo(a.since)} ago</small></div>`).join('') : '<div class="info">nothing open</div>'
	const at = s.atem
	const st = at?.stream || {}
	const eq = at?.equipment
	$('streams').innerHTML = at ? `<div class="intake"><div class="big ${st.state === 'arriving' ? 'stream' : ''}">${eq ? fmtRate(eq.down) : '–'}</div><div class="state ${esc(st.state || 'idle')}">${st.state === 'arriving' ? `stream arriving · ${fmtRate(st.rate)} above the quiet level · for ${fmtAgo(st.since)}` : `quiet · usual level ${fmtRate(st.baseline || 0)}${st.until ? ' · last stream ended ' + fmtAgo(st.until) + ' ago' : ''}`}</div>${(st.sources || []).length ? `<div class="src">${st.sources.slice(0, 3).map((x) => `<b>${esc(x.name)}</b> (${esc(x.confidence)}) ${esc(x.detail || '')}`).join('<br>')}</div>` : ''}<div class="src">${esc(at.name)}${eq?.switch ? ` · ${esc(eq.switch.name)} port ${eq.switch.port}` : ''}${eq?.telemetry?.programName ? ` · program ${esc(eq.telemetry.programName)}` : ''}</div></div>` : '<div class="empty">no switcher configured</div>'
	$('paths').innerHTML = (s.streamPaths || []).length ? s.streamPaths.map((p) => `<div class="${esc(p.status)}">${esc(p.name)} <span class="k">WAN ${esc(p.wanPorts)} → ${esc(p.target.name)}</span><small>${esc(p.verdict)}</small></div>`).join('') : '<div class="idle">no port forwards to broadcast gear</div>'
	renderMics(s)
	$('events').innerHTML = s.events.slice(0, 25).map((ev) => `<div class="${esc(ev.level || 'info')}">${esc(ev.text)}<small>${fmtTime(ev.t)}</small></div>`).join('') || '<div class="info">nothing yet</div>'
}

// the wireless mics: one row per receiver channel with battery and RF bars (EW-DX over SSC)
const fmtDb = (db) => (db === null || db === undefined || db < -89 ? '–' : db.toFixed(1))
const battClass = (b) => (b === null ? '' : b < 10 ? 'error' : b < 20 ? 'warn' : 'ok')
function renderMics(s) {
	const mics = s.audio?.mics || []
	if (!mics.length) return ($('mics').innerHTML = '<div class="idle">no wireless receivers in the roster</div>')
	$('mics').innerHTML = mics
		.map((m) => {
			if (!m.ok) return `<div class="warn"><b>${esc(m.name)}</b><small>${esc(m.error || 'not answering')}${m.online === false ? ' · not on the network' : ''}</small></div>`
			return m.channels
				.map((ch) => `<div class="${ch.link ? (ch.battery !== null && ch.battery < 20) || (ch.rsqi !== null && ch.rsqi < 30) ? 'warn' : 'ok' : 'idle'}" data-mic="${esc(m.ip)}:${esc(ch.id)}"><b>${esc(ch.name || ch.id.toUpperCase())}</b> <span class="k">${esc(m.name)}${ch.frequency ? ' · ' + ch.frequency.toFixed(3) + ' MHz' : ''}</span>${ch.link ? `<div class="mbars"><span><label>battery</label><span class="hb"><i class="${battClass(ch.battery)}" style="width:${ch.battery ?? 0}%"></i></span><em>${ch.battery !== null ? ch.battery + ' %' : '–'}</em></span><span><label>RF</label><span class="hb"><i class="${ch.rsqi !== null && ch.rsqi < 30 ? 'warn' : 'ok'}" data-f="rf" style="width:${ch.rsqi ?? 0}%"></i></span><em data-f="rfTxt">${ch.rsqi !== null ? ch.rsqi + ' %' : '–'}</em></span><span><label>audio</label><span class="hb"><i class="ok" data-f="af" style="width:${ch.af === null ? 0 : Math.max(0, Math.min(100, ((ch.af + 60) / 60) * 100)).toFixed(0)}%"></i></span><em data-f="afTxt">${fmtDb(ch.af)}</em></span></div><small>${[ch.tx?.name, ch.tx?.type, ch.mute || ch.tx?.mute ? 'MUTED' : '', ch.batteryMinutes ? 'about ' + ch.batteryMinutes + ' min left' : '', ...ch.warningText].filter(Boolean).join(' · ') || 'on air'}</small>` : '<small>transmitter off</small>'}</div>`)
				.join('')
		})
		.join('')
}
function applyMeters(m) {
	for (const [ip, rx] of Object.entries(m?.mic || {})) {
		for (const [id, v] of Object.entries(rx)) {
			const row = document.querySelector(`[data-mic="${CSS.escape(ip + ':' + id)}"]`)
			if (!row) continue
			const [af, rsqi] = v
			const afEl = row.querySelector('[data-f="af"]')
			if (afEl) afEl.style.width = (af === null ? 0 : Math.max(0, Math.min(100, ((af + 60) / 60) * 100))).toFixed(0) + '%'
			const afTxt = row.querySelector('[data-f="afTxt"]')
			if (afTxt) afTxt.textContent = fmtDb(af)
			const rf = row.querySelector('[data-f="rf"]')
			if (rf) rf.style.width = (rsqi ?? 0) + '%'
			const rfTxt = row.querySelector('[data-f="rfTxt"]')
			if (rfTxt) rfTxt.textContent = rsqi !== null ? rsqi + ' %' : '–'
		}
	}
}

async function ask(q) {
	if (!q.trim()) return
	const entry = { q, a: '' }
	qa.unshift(entry)
	renderQa()
	try {
		const r = await fetch('/api/ai/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: q }) })
		const j = await r.json()
		entry.a = j.text || j.error || 'no answer'
	} catch (e) {
		entry.a = 'error: ' + e.message
	}
	renderQa()
}
function renderQa() {
	$('askOut').innerHTML = qa.map((x) => `<div class="qa"><div class="q">${esc(x.q)}</div><div class="a">${esc(x.a || 'thinking…')}</div></div>`).join('')
}
$('askBtn').addEventListener('click', () => {
	ask($('askInput').value)
	$('askInput').value = ''
})
$('askInput').addEventListener('keydown', (e) => {
	if (e.key === 'Enter') {
		ask(e.target.value)
		e.target.value = ''
	}
})

function connect() {
	const es = new EventSource('/api/events')
	es.addEventListener('state', (e) => render(JSON.parse(e.data)))
	es.addEventListener('meters', (e) => applyMeters(JSON.parse(e.data)))
	es.addEventListener('ai', (e) => {
		const j = JSON.parse(e.data)
		if (j && !j.error) aiInfo = j
		if (state) render(state)
	})
	es.onerror = () => ($('when').textContent = 'reconnecting…')
}
fetch('/api/ai/status').then((r) => r.json()).then((st) => {
	if (st.assessment) aiInfo = st.assessment
}).catch(() => {})
fetch('/api/state').then((r) => r.json()).then((s) => s.ts && render(s)).catch(() => {})
connect()
// strip the key from the address bar once the cookie is set
if (location.search.includes('key=')) history.replaceState(null, '', location.pathname)
