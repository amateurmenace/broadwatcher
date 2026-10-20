/* Broadwatcher — paper console. State arrives over server-sent events; every section re-renders from it.
   The inspector (right rail) shows the AI readiness view by default and the details of whatever is clicked. */
'use strict'

const $ = (id) => document.getElementById(id)
let state = null
let lastStateAt = 0
let aiInfo = null // last assessment (from /api/ai/status or the "ai" SSE event)
let aiStatus = null
let selection = null // {type, id} shown in the inspector; null = readiness view
let details = null
let hover = null
let mapAll = false
const tips = new Map()
const qa = [] // ask history [{q, a, ms}]
const diagnoses = new Map()
let roster = null // working copy in the editor

// ------------------------------------------------------------------ formatting
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
function fmtRate(mbps) {
	const v = Number(mbps) || 0
	if (v >= 1000) return (v / 1000).toFixed(2) + ' Gb/s'
	if (v >= 100) return v.toFixed(0) + ' Mb/s'
	if (v >= 1) return v.toFixed(1) + ' Mb/s'
	if (v > 0) return (v * 1000).toFixed(0) + ' kb/s'
	return '0'
}
function fmtBytes(b) {
	const v = Number(b) || 0
	if (v >= 1e12) return (v / 1e12).toFixed(2) + ' TB'
	if (v >= 1e9) return (v / 1e9).toFixed(2) + ' GB'
	if (v >= 1e6) return (v / 1e6).toFixed(1) + ' MB'
	if (v >= 1e3) return (v / 1e3).toFixed(0) + ' kB'
	return v + ' B'
}
function fmtUptime(s) {
	s = Number(s) || 0
	if (!s) return '–'
	const d = Math.floor(s / 86400)
	const h = Math.floor((s % 86400) / 3600)
	const m = Math.floor((s % 3600) / 60)
	return d ? `${d}d ${h}h` : h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}
function fmtAgo(ms) {
	if (!ms) return '–'
	const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
	if (s < 60) return s + ' s'
	if (s < 3600) return Math.floor(s / 60) + ' min'
	if (s < 86400) return Math.floor(s / 3600) + ' h'
	return Math.floor(s / 86400) + ' d'
}
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '–')
function fmtDateTime(ms) {
	if (!ms) return '–'
	const d = new Date(ms)
	const today = new Date().toDateString() === d.toDateString()
	return (today ? '' : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ') + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
const speedTxt = (s) => (!s ? '–' : s >= 1000 ? s / 1000 + 'G' : s + 'M')
const speedClass = (s) => (s >= 10000 ? 'sp10000' : s >= 2500 ? 'sp2500' : s >= 1000 ? 'sp1000' : s >= 10 ? 'sp100' : '')
const pct = (v) => (v === null || v === undefined ? '–' : Math.round(v) + '%')
const lvl = (v, warn, err) => (v === null || v === undefined ? '' : v >= err ? 'error' : v >= warn ? 'warn' : '')
const mdLite = (t) =>
	esc(t)
		.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
		.replace(/^#+\s*(.+)$/gm, '<strong>$1</strong>')
		.replace(/^\s*[-•]\s+/gm, '· ')
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

// ------------------------------------------------------------------ theme
function applyTheme(t) {
	if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark')
	else document.documentElement.removeAttribute('data-theme')
	try {
		localStorage.setItem('bw-theme', t)
	} catch {}
	if (state) render(state)
}

// ------------------------------------------------------------------ scope (sparkline with graticule)
const scopes = []
function scope(key, series, cls = 'scope', extra = {}) {
	scopes.push({ key, series, extra })
	return `<canvas class="${cls}" data-scope="${esc(key)}"></canvas>`
}
function drawScopes() {
	const dpr = window.devicePixelRatio || 1
	const colors = { in: cssVar('--in'), out: cssVar('--out'), stream: cssVar('--stream'), ink3: cssVar('--ink3'), line: cssVar('--line') }
	for (const { key, series, extra } of scopes) {
		const c = document.querySelector(`canvas[data-scope="${CSS.escape(key)}"]`)
		if (!c) continue
		const w = c.clientWidth
		const h = c.clientHeight
		if (!w || !h) continue
		c.width = w * dpr
		c.height = h * dpr
		const ctx = c.getContext('2d')
		ctx.scale(dpr, dpr)
		const n = Math.max(2, ...series.map((s) => (s.data || []).length))
		const max = Math.max(extra.min || 1, ...series.flatMap((s) => s.data || [])) * 1.08
		const bare = !!extra.bare // tiny sparkline: no graticule, no labels, full height
		const x = (i) => (bare ? 0 : 4) + (i / (n - 1)) * (w - (bare ? 0 : 8))
		const y = (v) => h - (bare ? 1 : 4) - (v / max) * (h - (bare ? 2 : 16))
		if (bare) {
			for (const s of series) {
				const arr = s.data || []
				if (arr.length < 2) continue
				const off = n - arr.length
				ctx.beginPath()
				arr.forEach((v, i) => (i ? ctx.lineTo(x(i + off), y(v)) : ctx.moveTo(x(i + off), y(v))))
				ctx.strokeStyle = colors[s.color] || s.color
				ctx.lineWidth = 1.2
				ctx.lineJoin = 'round'
				ctx.stroke()
			}
			continue
		}
		ctx.strokeStyle = colors.line
		ctx.lineWidth = 1
		for (let g = 1; g < 4; g++) {
			ctx.beginPath()
			ctx.moveTo(0, y((max / 4) * g))
			ctx.lineTo(w, y((max / 4) * g))
			ctx.stroke()
		}
		if (extra.baseline) {
			ctx.strokeStyle = colors.ink3
			ctx.setLineDash([3, 3])
			ctx.beginPath()
			ctx.moveTo(0, y(extra.baseline))
			ctx.lineTo(w, y(extra.baseline))
			ctx.stroke()
			ctx.setLineDash([])
		}
		for (const s of series) {
			const arr = s.data || []
			if (arr.length < 2) continue
			const off = n - arr.length
			ctx.beginPath()
			arr.forEach((v, i) => (i ? ctx.lineTo(x(i + off), y(v)) : ctx.moveTo(x(i + off), y(v))))
			ctx.strokeStyle = colors[s.color] || s.color
			ctx.lineWidth = s.width || 1.5
			ctx.lineJoin = 'round'
			ctx.stroke()
		}
		ctx.fillStyle = colors.ink3
		ctx.font = '10px ' + cssVar('--sans')
		ctx.textAlign = 'right'
		ctx.fillText(fmtRate(max / 1.08), w - 5, 11)
		ctx.textAlign = 'left'
		ctx.fillText(`${Math.round((n * 5) / 60)} min`, 5, 11)
	}
	scopes.length = 0
}

// ------------------------------------------------------------------ tooltips
function tipAttr(key, html) {
	tips.set(key, html)
	return `data-tip="${esc(key)}"`
}
function showTip(key, x, y) {
	const html = tips.get(key)
	const t = $('tip')
	if (!html) return (t.hidden = true)
	t.innerHTML = html
	t.hidden = false
	const r = t.getBoundingClientRect()
	let left = x + 14
	let top = y + 14
	if (left + r.width > innerWidth - 8) left = x - r.width - 10
	if (top + r.height > innerHeight - 8) top = y - r.height - 10
	t.style.left = left + 'px'
	t.style.top = top + 'px'
}
document.addEventListener('mousemove', (e) => {
	const el = e.target.closest?.('[data-tip]')
	if (el) {
		hover = { key: el.getAttribute('data-tip'), x: e.clientX, y: e.clientY }
		showTip(hover.key, e.clientX, e.clientY)
	} else if (hover) {
		hover = null
		$('tip').hidden = true
	}
})

// ------------------------------------------------------------------ HUD
function verdictClass(v) {
	v = String(v || '').toUpperCase()
	return v === 'READY' ? 'ready' : v === 'DEGRADED' ? 'degraded' : v === 'AT RISK' ? 'risk' : v === 'DOWN' ? 'down' : ''
}
const nice = (v) => String(v || '').charAt(0).toUpperCase() + String(v || '').slice(1).toLowerCase()
function renderHud(s) {
	const gw = s.gateway
	const st = s.atem?.stream
	const eq = s.atem?.equipment
	const lamp = $('readyLamp')
	const errors = s.alerts.filter((a) => a.level === 'error').length
	const warns = s.alerts.filter((a) => a.level === 'warn').length
	const h = s.health
	const aiFresh = aiInfo && Date.now() - aiInfo.t < 900000
	if (h) {
		lamp.className = 'lamp ' + verdictClass(h.verdict)
		$('readyVerdict').textContent = nice(h.verdict)
		$('readyHeadline').textContent = `${h.score}/100 · ${aiFresh ? aiInfo.headline : h.headline}`
	} else {
		if (aiStatus?.busy && !aiInfo) lamp.className = 'lamp thinking'
		else lamp.className = 'lamp ' + (aiInfo ? verdictClass(aiInfo.verdict) : errors ? 'down' : warns ? 'degraded' : 'ready')
		$('readyVerdict').textContent = aiInfo ? nice(aiInfo.verdict) : errors ? 'Problems' : warns ? 'Warnings' : 'Nominal'
		$('readyHeadline').textContent = aiInfo ? aiInfo.headline : `${s.alerts.length} open item${s.alerts.length === 1 ? '' : 's'}`
	}
	const intake = eq ? eq.down : 0
	const full = Math.max(20, (st?.peak || 0) * 1.2, intake * 1.2)
	const bar = $('intakeBar')
	bar.style.width = Math.min(100, (intake / full) * 100) + '%'
	bar.className = st?.state === 'arriving' ? 'stream' : ''
	$('intakeBase').style.left = Math.min(100, ((st?.baseline || 0) / full) * 100) + '%'
	$('intakeVal').textContent = eq ? fmtRate(intake) : 'ATEM not seen'
	$('intakeVal').className = st?.state === 'arriving' ? 'cyan' : ''
	$('intakeSrc').textContent = st?.state === 'arriving' ? `stream ${fmtRate(st.rate)} · ${st.sources[0] ? st.sources[0].name : 'source unknown'} · ${fmtAgo(st.since)}` : eq?.switch ? `quiet · ${eq.switch.name} port ${eq.switch.port} · ${speedTxt(eq.switch.speed)}` : 'no stream'
	$('wanDown').textContent = gw ? fmtRate(gw.wan.down) : '–'
	$('wanUp').textContent = gw ? fmtRate(gw.wan.up) : '–'
	$('wanSub').textContent = gw ? `${gw.wan.status} · ${gw.wan.latency ?? '–'} ms · ${speedTxt(gw.wan.speed)}` : 'gateway?'
	$('wanSub').className = gw && gw.wan.status !== 'ok' ? 'error' : ''
	$('consoleVal').textContent = gw ? `${pct(gw.cpu)} · ${gw.temp ?? '–'}°` : '–'
	$('consoleSub').textContent = gw ? `${gw.modelName} · ${s.clients.total} clients · up ${fmtUptime(gw.uptime)}` : '–'
	const nets = (s.networks || []).filter((n) => n.watched).slice(0, 4)
	$('hudVlans').innerHTML = nets
		.map((n) => `<div class="vl" title="${esc(n.name)}${n.vlan ? ' · VLAN ' + n.vlan : ''}${n.subnet ? ' · ' + esc(n.subnet) : ''} · ${n.clients} clients · orange = into the VLAN, teal = out of it, last 10 minutes"><label>${esc(vlanLabel(n.name))}${n.vlan ? `<i>vlan ${n.vlan}</i>` : ''}</label><div class="nums"><span class="dn">↓${fmtRate(n.down)}</span><span class="up">↑${fmtRate(n.up)}</span></div>${scope('vl:' + n.name, [{ data: (n.history?.down || []).slice(-60), color: 'in' }, { data: (n.history?.up || []).slice(-60), color: 'out' }], 'vspark', { bare: true })}<small>${n.clients} client${n.clients === 1 ? '' : 's'}</small></div>`)
		.join('')
	$('hudIssues').innerHTML = (errors ? `<span class="error" title="open problems (error-level alerts)">${errors} <i>error${errors === 1 ? '' : 's'}</i></span>` : '') + (warns ? `<span class="warn" title="open warnings">${warns} <i>warning${warns === 1 ? '' : 's'}</i></span>` : '') + (!errors && !warns ? '<span class="ok" title="no open alerts">all clear</span>' : '')
	document.title = (errors ? '✕ ' : warns ? '! ' : '') + 'Broadwatcher'
	drawScopes()
}
// VLAN names as people say them: "BIG_MOBILE_DANTE" -> "Mobile Dante"
function vlanLabel(name) {
	const n = String(name || '').replace(/^BIG_/, '').replace(/_/g, ' ').toLowerCase()
	return n.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bNdi\b/, 'NDI')
}

// ------------------------------------------------------------------ broadcast health: the glance board
function renderHome(s) {
	const h = s.health
	const sel = $('profileSelect')
	if (sel && document.activeElement !== sel && s.profiles) sel.innerHTML = s.profiles.list.map((p) => `<option value="${esc(p.id)}" ${p.id === s.profiles.active ? 'selected' : ''}>${esc(p.name)}</option>`).join('')
	if (!h) return ($('home').innerHTML = '<div class="empty">waiting for the first poll</div>')
	$('homeNote').textContent = `score ${h.score}/100 · ${h.factors.filter((f) => f.value !== null).length} factors weighed`
	const aiFresh = aiInfo && Date.now() - aiInfo.t < 900000
	const why = h.factors
		.filter((f) => f.value !== null && f.value < 1)
		.sort((a, b) => b.weight * (1 - b.value) - a.weight * (1 - a.value))
		.slice(0, 4)
	const tileHtml = (s.tiles || [])
		.map((t) => `<div class="tile ${esc(t.level)}" data-tile="${esc(t.id)}" title="${esc(t.line)}"><div class="th"><span class="lamp sm ${esc(t.level)}"></span>${esc(t.label)}</div><div class="tv">${esc(t.value)}${t.unit ? `<small>${esc(t.unit)}</small>` : ''}</div><div class="tl">${esc(t.line)}</div>${t.series && t.series.length > 1 ? scope('tile:' + t.id, [{ data: t.series, color: t.id === 'stream_out' ? 'out' : 'in' }], 'tspark', { bare: true }) : t.strip ? stripHtml(s, t.strip) : `<div class="nosp" title="${esc(t.note || 'no series yet')}"></div>`}</div>`)
		.join('')
	$('home').innerHTML = `<div class="verdict-big" data-sel="health:now"><span class="lamp ${verdictClass(h.verdict)}"></span><div><b>${esc(nice(h.verdict))}</b><div class="score">${h.score}<small> / 100 · ${esc(h.profile?.name || '')}</small></div><p>${esc(aiFresh ? aiInfo.headline : h.headline)}</p><ul class="why">${why.map((f) => `<li class="${esc(f.level)}"><b>${esc(f.label)}</b> · ${esc(f.reason)}</li>`).join('') || '<li class="ok"><b>All factors</b> at full marks</li>'}</ul><div class="ai-meta">${aiFresh ? `AI: ${esc(aiInfo.model)} · ${fmtAgo(aiInfo.t)} ago${aiInfo.aiVerdict && aiInfo.aiVerdict !== h.verdict ? ` · the model would have said ${esc(nice(aiInfo.aiVerdict))}` : ''}` : aiStatus?.enabled ? 'AI narrative pending' : 'AI off · score only'} · click for every factor</div></div></div><div class="tiles">${tileHtml}</div>`
	indexMeters()
}

// ------------------------------------------------------------------ audio: X32 meters, EW-DX receivers, Fairlight
// levels are dBFS; a bar runs from -60 to 0; green below -18, amber to -6, red above; peak = a 1.5 s hold
const dbPct = (db) => (db === null || db === undefined ? 0 : Math.max(0, Math.min(100, ((db + 60) / 60) * 100)))
const dbClass = (db) => (db === null || db === undefined || db < -89 ? '' : db >= -6 ? 'hot' : db >= -18 ? 'warm' : '')
const fmtDb = (db) => (db === null || db === undefined || db < -89 ? '–' : db > -0.05 ? '0.0' : db.toFixed(1))
const fmtMinutes = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`)
const meterEls = new Map() // data-m key -> {el, fill, peak, db} for the 5-Hz updates without re-rendering
const stripEls = new Map() // data-vstrip key -> [bars]
const SCALE = `<div class="mscale">${[-60, -40, -20, -12, -6, 0].map((d) => `<span style="left:${dbPct(d).toFixed(1)}%">${d === 0 ? '0' : d}</span>`).join('')}</div>`
function meterRow(key, n, name, mt, { muted = false, hint = '' } = {}) {
	const silent = mt.level === null || mt.level < -89
	return `<div class="mrow${muted ? ' muted' : ''}${silent && !muted ? ' silent' : ''}${mt.clip ? ' clip' : ''}" data-m="${esc(key)}" title="${esc(hint || name || n)}"><span class="mn">${esc(n)}</span><span class="mname">${esc(name) || '<small>–</small>'}</span><span class="mbar"><i class="mfill ${dbClass(mt.level)}" style="width:${dbPct(mt.level).toFixed(1)}%"></i><b class="mpeak" style="left:${dbPct(mt.peak).toFixed(1)}%"></b></span><span class="mdb">${fmtDb(mt.level)}</span></div>`
}
// the tile strips: thin vertical bars, one per X32 channel plus the main pair; one per receiver channel (battery)
function stripHtml(s, kind) {
	const au = s.audio
	if (kind === 'x32') {
		const live = (au?.consoles || []).filter((c) => c.ok)
		if (!live.length) return `<div class="nosp" title="${esc((au?.consoles || []).map((c) => `${c.name}: ${c.error || 'no meters'}`).join(' · ') || 'no console')}"></div>`
		return `<div class="vstrips">${live
			.map((c) => `<div class="vstrip" data-vstrip="x32:${esc(c.ip)}" title="${esc(c.console?.name || c.name)} · channels 1–32, then main L/R"><span class="vgrp">${c.channels.map((m) => `<i data-v="ch" class="${dbClass(m.level)}" style="height:${dbPct(m.level).toFixed(0)}%"></i>`).join('')}</span><span class="vgrp main">${c.main.slice(0, 2).map((m) => `<i data-v="main" class="${dbClass(m.level)}" style="height:${dbPct(m.level).toFixed(0)}%"></i>`).join('')}</span></div>`)
			.join('')}</div>`
	}
	if (kind === 'mics') {
		const rx = (au?.mics || []).filter((m) => m.ok)
		if (!rx.length) return `<div class="nosp" title="${esc((au?.mics || []).map((m) => `${m.name}: ${m.error || ''}`).join(' · ') || 'no receiver')}"></div>`
		return `<div class="vstrips mics">${rx
			.map((m) => `<div class="vstrip" title="${esc(m.name)} · battery per channel">${m.channels.map((ch) => `<span class="vmic${ch.link ? '' : ' off'}" title="${esc(ch.name || ch.id)}: ${ch.link ? `battery ${ch.battery ?? '?'} % · RF ${ch.rsqi ?? '?'} %` : 'transmitter off'}"><i class="${ch.battery === null ? '' : ch.battery < 10 ? 'hot' : ch.battery < 20 ? 'warm' : ''}" style="height:${ch.link ? ch.battery ?? 0 : 0}%"></i><em>${esc((ch.name || ch.id).slice(0, 5))}</em></span>`).join('')}</div>`)
			.join('')}</div>`
	}
	return ''
}
function consolePanel(c) {
	const lamp = c.ok ? 'online' : c.online === false ? 'offline' : 'unresponsive'
	const head = `<h4 class="click" data-sel="equipment:${esc(c.ip)}"><span class="tally ${lamp}"></span>${esc(c.name)} <small>${c.console ? `${esc(c.console.name)} · ${esc(c.console.model)} · fw ${esc(c.console.firmware)} · ` : ''}${esc(c.ip)} · ${c.ok ? `meters live · ${c.rate} updates/s · since ${fmtTime(c.since)} · ${c.active} channel${c.active === 1 ? '' : 's'} with signal` : `<span class="warn">${esc(c.error || 'no meters')}</span>`}</small></h4>`
	if (!c.ok) return `<div class="x32p">${head}<div class="empty">${c.online === false ? 'the console is not on the network' : c.answered ? 'the console answers OSC but no meter data arrives (the subscription is renewed every 8 s)' : 'no answer on UDP 10023 (OSC): is the console on, and reachable from this computer?'}</div></div>`
	const col = (title, rows) => `<div class="mcol"><div class="mhead">${title}</div>${SCALE}${rows.join('')}</div>`
	const ch = (from, to) => c.channels.slice(from, to).map((m) => meterRow(`x32:${c.ip}:ch:${m.n - 1}`, m.n, m.name, m, { muted: m.on === false, hint: `channel ${m.n}${m.name ? ' ' + m.name : ''}${m.on === false ? ' · muted' : ''}` }))
	const buses = c.buses.map((m) => meterRow(`x32:${c.ip}:bus:${m.n - 1}`, 'B' + m.n, m.name, m, { muted: m.on === false, hint: `mix bus ${m.n}${m.name ? ' ' + m.name : ''}` }))
	const mtx = c.matrix.map((m) => meterRow(`x32:${c.ip}:mtx:${m.n - 1}`, 'M' + m.n, m.name, m, { hint: `matrix ${m.n}${m.name ? ' ' + m.name : ''}` }))
	const main = c.main.map((m, i) => meterRow(`x32:${c.ip}:main:${i}`, ['L', 'R', 'M'][i], m.name, m, { hint: m.name }))
	return `<div class="x32p">${head}<div class="mcols">${col('Channels 1–16', ch(0, 16))}${col('Channels 17–32', ch(16, 32))}${col('Mix buses · matrix · main', [...buses, ...mtx, '<div class="msep"></div>', ...main])}</div></div>`
}
function micRows(m) {
	if (!m.ok) return `<tr class="click off" data-sel="equipment:${esc(m.ip)}"><td><span class="tally ${m.online === false ? 'offline' : 'unresponsive'}"></span></td><td><b>${esc(m.name)}</b><small class="mono">${esc(m.ip)}</small></td><td colspan="6"><span class="warn">${esc(m.error || 'not answering')}</span><small>${m.online === false ? 'not on the network' : 'on the network, but Sennheiser Sound Control (JSON over UDP 45) gets no answer: is this really an EW-DX receiver, and can this computer reach the Dante VLAN?'}</small></td></tr>`
	return m.channels
		.map((ch) => {
			const key = `mic:${m.ip}:${ch.id}`
			const batt = ch.battery
			const bcls = batt === null ? '' : batt < 10 ? 'hot' : batt < 20 ? 'warm' : ''
			const rf = ch.rsqi
			const rcls = rf === null ? '' : rf < 30 ? 'warm' : ''
			return `<tr class="click${ch.link ? '' : ' off'}" data-sel="equipment:${esc(m.ip)}" data-mic="${esc(key)}">
			<td><span class="tally ${ch.link ? 'online' : ''}"></span></td>
			<td><b>${esc(ch.name || ch.id.toUpperCase())}</b><small>${esc(m.name)} · ${esc(ch.id.toUpperCase())}${m.product ? ' · ' + esc(m.product) : ''}</small></td>
			<td class="num">${ch.frequency ? ch.frequency.toFixed(3) + ' MHz' : '–'}<small>${ch.gain !== null ? 'gain ' + ch.gain + ' dB' : ''}</small></td>
			<td>${ch.link ? `<span class="ok">on air</span><small>${esc(ch.tx?.name || '')}${ch.tx?.type ? (ch.tx?.name ? ' · ' : '') + esc(ch.tx.type) : ''}${ch.tx?.mute ? ' · <span class="warn">muted at the transmitter</span>' : ''}</small>` : `transmitter off<small>no link with the receiver</small>`}</td>
			<td class="mcell"><span class="hbar"><i class="${bcls}" data-f="batt" style="width:${batt ?? 0}%"></i></span><em data-f="battTxt">${batt !== null ? batt + ' %' : '–'}</em><small>${ch.batteryMinutes ? 'about ' + fmtMinutes(ch.batteryMinutes) + ' left' : ch.batteryType ? esc(ch.batteryType) : ''}</small></td>
			<td class="mcell"><span class="hbar"><i class="${rcls}" data-f="rf" style="width:${rf ?? 0}%"></i></span><em data-f="rfTxt">${rf !== null ? rf + ' %' : '–'}</em><small data-f="rssi">${ch.rssi !== null ? ch.rssi + ' dBm' : ''}${ch.antenna ? ' · antenna ' + ch.antenna : ''}</small></td>
			<td class="mcell"><span class="hbar af"><i class="${dbClass(ch.af)}" data-f="af" style="width:${dbPct(ch.af).toFixed(1)}%"></i></span><em data-f="afTxt">${fmtDb(ch.af)}</em>${ch.mute ? '<small class="warn">muted at the receiver</small>' : '<small>dBFS</small>'}</td>
			<td>${ch.warningText.length ? ch.warningText.map((w) => `<span class="tag blocked">${esc(w)}</span>`).join(' ') : ch.link ? '<small>none</small>' : ''}</td></tr>`
		})
		.join('')
}
function switcherPanel(sw) {
	if (!sw) return ''
	const head = `<h4 class="click" data-sel="equipment:${esc(sw.ip)}"><span class="tally ${sw.levels ? 'online' : sw.mode === 'own' && sw.held ? 'unresponsive' : ''}"></span>${esc(sw.name)} · Fairlight <small>${sw.mode === 'own' ? (sw.held ? (sw.levels ? `levels live · ${sw.levels.sources.length} inputs` : 'own session held · waiting for the first levels') : 'own session not held right now') : `read through ${esc(sw.mode)}`}</small></h4>`
	if (!sw.levels) return `<div class="x32p">${head}<div class="empty">${esc(sw.note || 'no levels yet')}</div></div>`
	const L = sw.levels
	const rows = L.sources.map((x) => meterRow(`atem:${x.id}`, x.id < 1000 ? x.id : '', x.label, { level: x.level, peak: x.peak }, { hint: `${x.label} · input ${fmtDb(x.input)} dBFS` }))
	const master = L.master ? [meterRow('atem:master', 'Σ', 'Master', { level: L.master.level, peak: L.master.peak }, { hint: 'master out' })] : []
	const half = Math.ceil(rows.length / 2)
	return `<div class="x32p">${head}<div class="mcols">${[rows.slice(0, half), rows.slice(half), master].filter((r) => r.length).map((r, i) => `<div class="mcol"><div class="mhead">${i === 2 || (i === 1 && !rows.slice(half).length) ? 'Master' : 'Inputs'}</div>${SCALE}${r.join('')}</div>`).join('')}</div><p class="mnote">Levels are decoded from the switcher's FDLv / FMLv commands as the official SDK lays them out; they have not been checked against a live switcher yet (an own session is needed and the HD8's slots are taken on show days).</p></div>`
}
function renderAudio(s) {
	const au = s.audio
	const panel = $('audioPanel')
	if (!au) {
		$('audioNote').textContent = ''
		panel.innerHTML = '<div class="empty">waiting for the first poll</div>'
		return
	}
	const sm = au.summary
	$('audioNote').textContent = [`${sm.consolesLive}/${sm.consoles} console${sm.consoles === 1 ? '' : 's'} sending meters`, sm.receivers ? `${sm.receiversAnswering}/${sm.receivers} receivers answering · ${sm.onAir}/${sm.channels} mics on air` : '', 'X32 over OSC · EW-DX over SSC · levels in dBFS, peak held 1.5 s'].filter(Boolean).join(' · ')
	const consoles = au.consoles.map(consolePanel).join('')
	const mics = au.mics.length ? `<div class="micp"><h4>Wireless mics <small>Sennheiser EW-DX over SSC · battery and RF per receiver channel · ${sm.onAir}/${sm.channels} on air</small></h4><table class="mics"><thead><tr><th></th><th>Channel</th><th class="num">Frequency</th><th>Transmitter</th><th>Battery</th><th>RF quality</th><th>Audio</th><th>Warnings</th></tr></thead><tbody>${au.mics.map(micRows).join('')}</tbody></table></div>` : ''
	const others = au.others.length ? `<div class="micp"><h4>Other audio devices in the roster <small>nothing to read from them</small></h4>${au.others.map((o) => `<div class="orow click" data-sel="equipment:${esc(o.ip)}"><span class="tally ${o.online ? 'online' : 'offline'}"></span><b>${esc(o.name)}</b><span class="mono">${esc(o.ip)}</span><small>${esc(o.note)}</small></div>`).join('')}</div>` : ''
	const empty = !au.consoles.length && !au.mics.length && !au.others.length && !au.switcher ? '<div class="empty">no audio devices in the roster: give an X32 the probe "x32", name a Sennheiser receiver so it says so (EW-DX, receiver), role "audio"</div>' : ''
	panel.innerHTML = consoles + mics + switcherPanel(au.switcher) + others + empty
	indexMeters()
}
// re-index the live meter elements after any render that may have replaced them
function indexMeters() {
	meterEls.clear()
	for (const el of document.querySelectorAll('[data-m]')) meterEls.set(el.getAttribute('data-m'), { el, fill: el.querySelector('.mfill'), peak: el.querySelector('.mpeak'), db: el.querySelector('.mdb') })
	stripEls.clear()
	for (const el of document.querySelectorAll('[data-vstrip]')) stripEls.set(el.getAttribute('data-vstrip'), { ch: [...el.querySelectorAll('[data-v="ch"]')], main: [...el.querySelectorAll('[data-v="main"]')] })
	for (const tr of document.querySelectorAll('[data-mic]')) meterEls.set(tr.getAttribute('data-mic'), { el: tr, af: tr.querySelector('[data-f="af"]'), afTxt: tr.querySelector('[data-f="afTxt"]'), rf: tr.querySelector('[data-f="rf"]'), rfTxt: tr.querySelector('[data-f="rfTxt"]'), rssi: tr.querySelector('[data-f="rssi"]') })
}
function setMeter(m, level, peak, flags = 0) {
	if (!m || !m.fill) return
	m.fill.style.width = dbPct(level).toFixed(1) + '%'
	m.fill.className = 'mfill ' + dbClass(level)
	if (m.peak) m.peak.style.left = dbPct(peak).toFixed(1) + '%'
	if (m.db) m.db.textContent = fmtDb(level)
	m.el.classList.toggle('muted', !!(flags & 1))
	m.el.classList.toggle('clip', !!(flags & 2))
	m.el.classList.toggle('silent', level < -89 && !(flags & 1))
}
// the "meters" event, up to five times a second: move the bars that exist, never re-render
function applyMeters(m) {
	if (!m || !meterEls.size) return
	for (const [ip, c] of Object.entries(m.x32 || {})) {
		for (const [g, list] of Object.entries({ ch: c.ch, bus: c.bus, mtx: c.mtx, main: c.main })) list.forEach((v, i) => setMeter(meterEls.get(`x32:${ip}:${g}:${i}`), v[0], v[1], v[2]))
		const st = stripEls.get(`x32:${ip}`)
		if (st) {
			c.ch.forEach((v, i) => st.ch[i] && ((st.ch[i].style.height = dbPct(v[0]).toFixed(0) + '%'), (st.ch[i].className = dbClass(v[0]))))
			c.main.forEach((v, i) => st.main[i] && ((st.main[i].style.height = dbPct(v[0]).toFixed(0) + '%'), (st.main[i].className = dbClass(v[0]))))
		}
	}
	for (const [ip, rx] of Object.entries(m.mic || {})) {
		for (const [id, v] of Object.entries(rx)) {
			const r = meterEls.get(`mic:${ip}:${id}`)
			if (!r || !r.af) continue
			const [af, rsqi, rssi, link] = v
			r.af.style.width = dbPct(af).toFixed(1) + '%'
			r.af.className = dbClass(af)
			if (r.afTxt) r.afTxt.textContent = fmtDb(af)
			if (r.rf) {
				r.rf.style.width = (rsqi ?? 0) + '%'
				r.rf.className = rsqi === null ? '' : rsqi < 30 ? 'warm' : ''
			}
			if (r.rfTxt) r.rfTxt.textContent = rsqi !== null ? rsqi + ' %' : '–'
			if (r.rssi && rssi !== null) r.rssi.textContent = rssi + ' dBm'
			r.el.classList.toggle('off', !link)
		}
	}
	if (m.atem) {
		for (const x of m.atem.sources || []) setMeter(meterEls.get(`atem:${x.id}`), x.level, x.peak)
		if (m.atem.master) setMeter(meterEls.get('atem:master'), m.atem.master.level, m.atem.master.peak)
	}
}
// the inspector's audio lines for an X32 or a receiver
function audioSection(e) {
	const a = e.audio
	if (!a) return ''
	if (a.kind === 'x32') return `<h3>Meters</h3><div class="kv"><span>Console</span><b>${a.console ? `${esc(a.console.name)} · ${esc(a.console.model)} · fw ${esc(a.console.firmware)}` : '–'}</b><span>Meters</span><b class="${a.ok ? 'ok' : 'bad'}">${a.ok ? `live · ${a.rate}/s · ${a.active} channel${a.active === 1 ? '' : 's'} with signal` : esc(a.error || 'none')}</b>${a.ok ? `<span>Main</span><b>${a.mainLevel !== null && a.mainLevel > -60 ? a.mainLevel.toFixed(1) + ' dBFS' : 'quiet'}</b>` : ''}</div><p>The full meters are in the Audio section.</p>`
	if (a.kind === 'ewdx') return `<h3>Receiver channels</h3>${a.ok ? `<div class="kv">${a.channels.map((ch) => `<span>${esc(ch.name || ch.id)}</span><b>${ch.link ? `<span class="ok">on air</span> · battery ${ch.battery ?? '?'} % · RF ${ch.rsqi ?? '?'} %${ch.rssi !== null ? ' (' + ch.rssi + ' dBm)' : ''} · AF ${fmtDb(ch.af)} dBFS${ch.mute || ch.tx?.mute ? ' · <span class="warn">muted</span>' : ''}${ch.warningText.length ? ' · ' + esc(ch.warningText.join(', ')) : ''}` : 'transmitter off'}${ch.frequency ? ` · ${ch.frequency.toFixed(3)} MHz` : ''}</b>`).join('')}</div>` : `<p class="warn">${esc(a.error || 'not answering')}</p>`}<p>${a.product ? esc(a.product) + ' · ' : ''}Sennheiser Sound Control over UDP 45.</p>`
	return ''
}
function tileClick(id) {
	const t = (state?.tiles || []).find((x) => x.id === id)
	const tg = t?.target
	if (!tg) return
	if (tg.type === 'section') return $(tg.id)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
	if (tg.type === 'atem') return select('atem', 'atem')
	if (tg.type === 'wan') return select('wan', 'wan')
	select(tg.type, tg.id)
}

// ------------------------------------------------------------------ gateway at a glance
function renderGateway(s) {
	const gw = s.gateway
	$('gwNote').textContent = gw ? `${gw.modelName} · WAN ${gw.wan.status}${gw.wan.isp ? ' · ' + gw.wan.isp : ''} · ${s.flows.total} flows in the last ${s.flows.window_s} s` : 'gateway not found'
	if (!gw) return ($('gw').innerHTML = '<div class="empty">the gateway is not in the UniFi device list</div>')
	const wan = `<div class="gwp"><h3>WAN <small>${esc(gw.wan.ip || '')}</small></h3><div class="big"><span class="dn">↓ ${fmtRate(gw.wan.down)}<i>into the building</i></span><span class="up">↑ ${fmtRate(gw.wan.up)}<i>out to the internet</i></span></div><div class="sub">${esc(gw.wan.status)} · ${gw.wan.latency ?? '–'} ms · link ${speedTxt(gw.wan.speed)} · up ${fmtUptime(gw.wan.uptime)}${gw.speedtest ? ` · speedtest ↓${gw.speedtest.down} ↑${gw.speedtest.up} Mb/s` : ''}</div>${scope('gw-wan', [{ data: gw.wan.history.down, color: 'in' }, { data: gw.wan.history.up, color: 'out' }], 'scope')}</div>`
	const nets = (s.networks || []).filter((n) => n.watched || n.clients > 0).slice(0, 9)
	const vlans = `<div class="gwp"><h3>VLANs through the gateway <small>${s.clients.total} clients · ${s.clients.wired} wired</small></h3><table><thead><tr><th>Network</th><th class="num">Clients</th><th class="num">In</th><th class="num">Out</th><th>10 min</th></tr></thead><tbody>${nets
		.map((n) => `<tr><td>${esc(vlanLabel(n.name))}<small class="mono">${n.vlan ? 'vlan ' + n.vlan : ''}${n.subnet ? ' · ' + esc(n.subnet) : ''}</small></td><td class="num">${n.clients}</td><td class="num dn">${fmtRate(n.down)}</td><td class="num up">${fmtRate(n.up)}</td><td>${scope('gw-vl:' + n.name, [{ data: n.history?.down || [], color: 'in' }, { data: n.history?.up || [], color: 'out' }], 'vspark', { bare: true })}</td></tr>`)
		.join('')}</tbody></table></div>`
	const g = (label, v, max, warn, err) => `<div class="gauge"><span>${label}</span><div class="bar"><i class="${lvl(v, warn, err)}" style="width:${Math.min(100, ((v ?? 0) / max) * 100)}%"></i></div><em class="${lvl(v, warn, err)}">${v ?? '–'}${label === 'Temp' ? '°' : '%'}</em></div>`
	const online = (list) => `${list.filter((x) => x.online).length}/${list.length}`
	const console_ = `<div class="gwp"><h3>Console <small>v${esc(gw.version || '')}</small></h3>${g('CPU', gw.cpu, 100, 70, 85)}${g('Memory', gw.mem, 100, 80, 90)}${g('Temp', gw.temp, 90, 60, 70)}<div class="kv"><span>Uptime</span><b>${fmtUptime(gw.uptime)}</b><span>Switches</span><b>${online(s.switches)} online${s.aps.length ? ` · APs ${online(s.aps)}` : ''}</b>${gw.storage?.length ? `<span>Storage</span><b>${gw.storage.map((x) => `${esc(x.name)} ${Math.round((x.used / Math.max(1, x.size)) * 100)}%`).join(' · ')}</b>` : ''}${s.snmp?.enabled ? `<span>SNMP</span><b>${Object.values(s.snmp.status || {}).filter((v) => /^ok/.test(v)).length} switches live</b>` : ''}</div></div>`
	const top = (s.flows.top || []).slice(0, 7)
	const flows = `<div class="gwp"><h3>Biggest flows <small>last ${s.flows.window_s} s · ${s.flows.blocked} blocked</small></h3><div class="flowlist">${top.length ? top.map((f) => `<div><div class="f"><b>${esc(f.srcName || f.src)}</b> → ${esc(f.dstName || f.dst)}:${esc(f.dport)}<small>${esc([f.proto, f.service !== 'OTHER' ? f.service : '', f.app, f.viaForward ? 'via WAN ' + f.viaForward.wanPort : '', f.srcRegion].filter(Boolean).join(' · '))}${f.action === 'blocked' ? ' · <span class="error">blocked</span>' : ''}</small></div><div class="n">${fmtBytes(f.bytes)}</div></div>`).join('') : '<div class="empty">waiting for flows</div>'}</div></div>`
	$('gw').innerHTML = wan + vlans + console_ + flows
}

// ------------------------------------------------------------------ collapsible sections + the readiness rail
const FOLD_KEY = 'bw-fold'
function loadFolds() {
	let folds = {}
	try {
		folds = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}')
	} catch {}
	for (const [id, v] of Object.entries(folds)) $(id)?.classList.toggle('folded', !!v)
	let rail = 'on'
	try {
		rail = localStorage.getItem('bw-rail') || 'on'
	} catch {}
	setRail(rail === 'on')
}
function toggleFold(id) {
	const el = $(id)
	if (!el) return
	el.classList.toggle('folded')
	let folds = {}
	try {
		folds = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}')
	} catch {}
	folds[id] = el.classList.contains('folded')
	try {
		localStorage.setItem(FOLD_KEY, JSON.stringify(folds))
	} catch {}
	if (!folds[id] && state) render(state)
}
function setRail(on) {
	$('shell').classList.toggle('rail-hidden', !on)
	$('railToggle').classList.toggle('on', on)
	$('railToggle').textContent = on ? '▸' : '◂'
	try {
		localStorage.setItem('bw-rail', on ? 'on' : 'off')
	} catch {}
	if (state) renderMap(state)
}

// ------------------------------------------------------------------ issues
function renderIssues(s) {
	$('issues').innerHTML = s.alerts
		.map((a) => `<div class="issue ${a.level}${selection?.type === 'alert' && selection.id === a.id ? ' sel' : ''}" data-alert="${esc(a.id)}"><span class="k">${esc(a.scope)}</span><span>${esc(a.text)}</span><span class="since">${fmtAgo(a.since)}</span></div>`)
		.join('')
}

// ------------------------------------------------------------------ map
function renderMap(s) {
	const topo = s.topology || { nodes: [], links: [] }
	for (const n of topo.nodes) {
		const t = n.telemetry
		tips.set('node:' + n.id, `<b>${esc(n.name)}</b><div class="kv">${n.model ? `<span>Model</span><b>${esc(n.model)}</b>` : ''}${n.ip ? `<span>IP</span><b>${esc(n.ip)}</b>` : ''}<span>Status</span><b>${esc(n.status)}</b>${n.rate ? `<span>In / out</span><b>${fmtRate(n.rate.in)} / ${fmtRate(n.rate.out)}</b>` : ''}${n.portsTotal ? `<span>Ports</span><b>${n.portsUp}/${n.portsTotal} up</b>` : ''}${n.cpu !== undefined && n.cpu !== null ? `<span>CPU / temp</span><b>${n.cpu}% / ${n.temp ?? '–'}°</b>` : ''}${t?.summary ? `<span>Device</span><b>${esc(t.summary)}</b>` : ''}</div><small>click for details</small>`)
	}
	if ($('mapBlock').classList.contains('folded')) return
	const q = rackFilter
	const r = NetMap.render($('map'), topo, { showAll: mapAll, selected: selection && selection.type !== 'alert' ? nodeIdFor(selection) : null, stream: s.atem?.stream, match: q ? (n) => (n.name + ' ' + (n.ip || '')).toLowerCase().includes(q) : null })
	$('mapNote').textContent = `${r.count} nodes · orange into the device, teal out of it · brighter and faster = more traffic`
}
function nodeIdFor(sel) {
	if (!sel) return null
	if (sel.type === 'equipment') return 'eq:' + sel.id
	if (sel.type === 'atem') return 'eq:' + (state?.atem?.ip || '')
	if (sel.type === 'switch' || sel.type === 'ap' || sel.type === 'gateway' || sel.type === 'pdu') return sel.id
	if (sel.type === 'port') return String(sel.id).slice(0, String(sel.id).lastIndexOf(':'))
	return null
}

// ------------------------------------------------------------------ ATEM panel
function renderAtem(s) {
	const at = s.atem
	if (!at) return ($('atemPanel').innerHTML = '<div class="empty">no ATEM configured</div>')
	const eq = at.equipment
	const st = at.stream || {}
	const tl = eq?.telemetry
	$('atemNote').textContent = `${at.name} · ${at.ip}${eq?.switch ? ` · ${eq.switch.name} port ${eq.switch.port} · ${speedTxt(eq.switch.speed)}` : ''}`
	const srcRows = (st.sources || []).map((x) => `<tr class="click" data-sel="equipment:${esc(x.ip)}"><td><span class="tag ${esc(x.confidence)}">${esc(x.confidence)}</span></td><td><b>${esc(x.name)}</b><small class="mono">${esc(x.ip)}</small></td><td>${esc(x.detail || '')}<small>${esc(x.how)}</small></td></tr>`)
	const flowRows = (at.incoming || []).slice(0, 10).map((x) => `<tr><td><span class="tally ${x.live ? 'live' : ''}"></span></td><td>${esc(x.srcName || x.src)}<small class="mono">${esc(x.src)}${x.region ? ' · ' + esc(x.region) : ''}${x.network ? ' · ' + esc(x.network) : ''}</small></td><td><span class="tag">${esc(x.proto)} ${esc(x.dport)}</span><small>${x.viaForward ? `via WAN port ${esc(x.viaForward.wanPort)} (${esc(x.viaForward.name)}) · ` : ''}${esc([x.service, x.app].filter((v) => v && v !== 'OTHER').join(' · '))}${x.action === 'blocked' ? ' <span class="tag blocked">blocked</span>' : ''}</small></td><td class="num">${fmtBytes(x.bytes)}<small>${x.flows} flow${x.flows === 1 ? '' : 's'}</small></td><td class="num">${fmtTime(x.first)}<small>last ${x.ageS < 60 ? x.ageS + ' s' : fmtAgo(x.last)} ago</small></td></tr>`)
	$('atemPanel').innerHTML = `<div class="atem">
		<div class="readout">
			<div class="lbl">Traffic into the switcher</div>
			<div class="big ${st.state === 'arriving' ? 'stream' : ''}">${eq ? fmtRate(eq.down) : '–'}</div>
			<div class="state ${esc(st.state || 'idle')}">${st.state === 'arriving' ? `stream arriving · ${fmtRate(st.rate)} above the quiet level · for ${fmtAgo(st.since)}` : `quiet · usual level ${fmtRate(st.baseline || 0)}${st.until ? ' · last stream ended ' + fmtAgo(st.until) + ' ago' : ''}`}</div>
			${scope('atem', [{ data: eq?.history.down || [], color: st.state === 'arriving' ? 'stream' : 'in', width: 1.6 }, { data: eq?.history.up || [], color: 'out' }], 'scope', { baseline: st.baseline })}
			<div class="kv">
				<span>Out of it</span><b>${eq ? fmtRate(eq.up) : '–'}</b>
				<span>Port</span><b>${eq?.switch ? `${esc(eq.switch.name)} · ${eq.switch.port} · ${speedTxt(eq.switch.speed)} · ${eq.age ?? '?'} s old` : 'not on a switch port'}</b>
				<span>Control</span><b>${eq?.probe ? (eq.probe.ok ? `${esc(eq.probe.info?.state || 'answers')}${eq.probe.ms ? ' · ' + eq.probe.ms.toFixed(0) + ' ms' : ''}` : `<span class="error">no answer (${esc(eq.probe.error || '')})</span>`) : tl?.mode === 'companion' ? 'via Companion' : 'not probed'}</b>
				${tl && !tl.error ? `<span>Switcher</span><b>${tl.via === 'companion' ? `read through Companion "${esc(tl.label || '')}"` : `${esc(tl.product || '')} v${esc(tl.version || '')}`}${tl.programName ? ` · program <span class="error">${esc(tl.programName)}</span> · preview ${esc(tl.previewName || '')}` : ''}</b><span>Own stream</span><b>${esc(tl.streaming?.state || 'unknown')}${tl.streaming?.bitrate ? ' · ' + (tl.streaming.bitrate / 1e6).toFixed(1) + ' Mb/s' : ''}${tl.streaming?.duration && tl.streaming.duration !== '00:00:00' ? ' · ' + esc(tl.streaming.duration) : ''}${tl.streaming?.service ? ' · ' + esc(tl.streaming.service) : ''}${tl.streaming?.url ? ' · ' + esc(tl.streaming.url) : ''}</b>${tl.recording ? `<span>ISO record</span><b>${tl.recording.active ? `<span class="error">RECORDING</span> ${esc(tl.recording.duration || '')}` : 'idle'}${tl.recording.remaining ? ' · ' + esc(tl.recording.remaining) + ' left' : ''}${tl.recording.disk ? ' · ' + esc(tl.recording.disk) : ''}</b>` : ''}` : tl?.error ? `<span>Switcher</span><b class="warn">${esc(tl.error)}</b>` : ''}
			</div>
		</div>
		<div>
			<div class="lbl" style="margin:0 0 6px">Where it comes from</div>
			${srcRows.length ? `<table><thead><tr><th>Confidence</th><th>Source</th><th>How we know</th></tr></thead><tbody>${srcRows.join('')}</tbody></table>` : `<div class="empty">${st.state === 'arriving' ? 'no source identified yet — looking at encoder telemetry and matching rates' : 'nothing is streaming into the switcher right now'}</div>`}
			<div class="lbl" style="margin:16px 0 6px">Connections to the switcher seen by the gateway · last hour</div>
			${flowRows.length ? `<table><thead><tr><th></th><th>From</th><th>To port</th><th class="num">Data</th><th class="num">Since</th></tr></thead><tbody>${flowRows.join('')}</tbody></table>` : '<div class="empty">none — only traffic that crosses the gateway (internet or another VLAN) shows up here; a stream from the same VLAN is detected from the port counters on the left instead</div>'}
		</div>
	</div>`
}

// ------------------------------------------------------------------ stream path check
const PATH_WORD = { red: 'problem', amber: 'check', green: 'live', ok: 'used', idle: 'idle' }
function renderPaths(s) {
	const paths = s.streamPaths || []
	const wan = s.gateway?.wan?.ip
	$('pathNote').textContent = paths.length ? `${paths.length} port forward${paths.length === 1 ? '' : 's'} to broadcast gear on ${wan || 'the WAN address'} · internet → gateway → device · last hour` : 'no port forwards to broadcast gear found on the gateway'
	if (!paths.length) return ($('pathPanel').innerHTML = '<div class="empty">the gateway has no port forwards that point at the roster (UniFi Network > Settings > Routing > Port Forwarding)</div>')
	const rows = paths.map((p) => {
		const src = p.hits.sources[0]
		const who = src ? `${esc(src.name || src.ip)}${src.region ? ' · ' + esc(src.region) : ''}${src.name ? `<small class="mono">${esc(src.ip)}</small>` : ''}` : '<small>nobody</small>'
		const hits = p.hits.count ? `${p.hits.count} flow${p.hits.count === 1 ? '' : 's'} · ${fmtBytes(p.hits.bytes)}${p.hits.blocked ? ` · <span class="error">${p.hits.blocked} blocked</span>` : ''}<small>last ${fmtAgo(p.hits.last)} ago${p.hits.live ? ' · <span class="ok">live now</span>' : ''}</small>` : `<small>nothing in the last hour</small>${p.hits.blocked ? `<span class="error">${p.hits.blocked} blocked</span>` : ''}`
		const target = `${esc(p.target.name)}<small>${p.target.standby ? '<span class="warn">on standby</span>' : p.target.online ? `<span class="ok">on the network</span>${p.target.switch ? ' · ' + esc(p.target.switch) : ''}` : '<span class="error">not on the network</span>'}</small>`
		const intake = p.intake ? (p.intake.state === 'arriving' ? `<span class="cyan">rose ${p.intake.rate} Mb/s</span><small>since ${fmtTime(p.intake.since)}</small>` : `quiet${p.intake.until ? `<small>last stream ended ${fmtAgo(p.intake.until)} ago</small>` : ''}`) : '<small>not the switcher</small>'
		return `<tr class="click ${esc(p.status)}" data-sel="path:${esc(p.id)}"><td><span class="pl ${esc(p.status)}" title="${esc(PATH_WORD[p.status] || p.status)}"></span></td><td class="path-name"><b>${esc(p.name)}</b><span class="url">${esc(p.proto.replace('_', '+'))} ${esc(p.wanPorts)} → ${esc(p.target.ip)}:${esc(p.target.port || p.wanPorts)}</span></td><td>${who}</td><td>${hits}</td><td>${target}</td><td>${intake}</td><td class="verdict">${esc(p.verdict)}</td></tr>`
	})
	$('pathPanel').innerHTML = `<table class="paths"><thead><tr><th></th><th>Path</th><th>Sender (last hour)</th><th>Traffic</th><th>Target</th><th>Switcher intake</th><th>Verdict</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
}

// ------------------------------------------------------------------ stream forensics (the mirror port)
const SESSION_LAMP = { held: 'online', refused: 'offline', connecting: 'unresponsive', new: 'unresponsive', gone: '' }
function renderForensics(s) {
	const fx = s.forensics
	const note = $('forNote')
	const btn = $('forToggle')
	if (!fx) {
		btn.hidden = true
		note.textContent = 'no mirror capture on this machine'
		return ($('forPanel').innerHTML = '<div class="empty">a mirror of the switcher\'s switch port, read with tshark, shows every stream and every control session as the switcher sees them: set the capture interface in Settings &gt; Capture</div>')
	}
	btn.hidden = !fx.available
	btn.textContent = fx.running ? 'Stop capture' : 'Start capture'
	btn.setAttribute('data-for-action', fx.running ? 'stop' : 'start')
	note.textContent = fx.running ? `tshark on "${fx.interface}" · ${fx.pps} packets/s · since ${fmtTime(fx.since)}${fx.restarts ? ` · ${fx.restarts} restarts` : ''}` : fx.available ? `stopped${fx.error ? ' · ' + fx.error : ''}` : `not available · ${fx.error || 'tshark or the interface is missing'}`
	const held = fx.sessions.filter((x) => x.state === 'held')
	const perHost = new Map()
	for (const x of fx.sessions) perHost.set(x.ip, (perHost.get(x.ip) || 0) + (x.state === 'held' ? 1 : 0))
	const sess = fx.sessions
		.map((x) => `<tr class="click" data-sel="forensics:${esc(x.ip)}"><td><span class="tally ${SESSION_LAMP[x.state] || ''}"></span></td><td>${esc(x.name || x.ip)}<small class="mono">${esc(x.ip)}:${x.port}${perHost.get(x.ip) > 1 ? ` · ${perHost.get(x.ip)} sessions from this host` : ''}</small></td><td>${x.state === 'held' ? `<span class="ok">holds a session</span><small>since ${fmtTime(x.since)} · ${x.pps} pkt/s</small>` : x.state === 'refused' ? `<span class="error">refused</span><small>too many clients · ${x.refusals}× · last ${fmtAgo(x.hello?.t)} ago</small>` : x.state === 'gone' ? `gone<small>last ${fmtAgo(x.last)} ago</small>` : `${esc(x.state)}<small>${x.hello ? esc(x.hello.text) + ' · ' : ''}last ${fmtAgo(x.last)} ago</small>`}</td></tr>`)
		.join('')
	const flows = fx.flows
		.map((f) => `<tr class="click ${f.live ? 'live' : ''}" data-sel="forensics:${esc(f.peer)}"><td><span class="tally ${f.live ? 'online' : /reset|rejected|no answer/.test(f.state) ? 'offline' : ''}"></span></td><td>${esc(f.name || f.peer)}${f.name ? `<small class="mono">${esc(f.peer)}</small>` : ''}</td><td><span class="tag">${esc(f.app)}</span><small>${f.outbound ? `from the switcher → ${esc(f.peer)}:${f.peerPort}` : `${esc(f.proto)} → switcher port ${f.targetPort}`}</small></td><td class="${/reset|rejected|no answer/.test(f.state) ? 'error' : f.state === 'streaming' || f.state === 'publishing' ? 'cyan' : ''}">${esc(f.state)}<small>${esc(f.detail || '')}</small></td><td class="num"><span class="dn">${fmtRate(f.inMbps)}</span><small class="up">${fmtRate(f.outMbps)} back</small></td><td class="num">${fmtTime(f.first)}<small>${f.live ? 'live' : 'last ' + fmtAgo(f.last) + ' ago'}</small></td></tr>`)
		.join('')
	const evs = fx.events.map((e) => `<div class="tl ${e.level === 'warn' ? 'warn' : 'info'}"><span class="t">${fmtTime(e.t)}</span><span class="m">${esc(e.text)}</span></div>`).join('')
	$('forPanel').innerHTML = `<div><h4>Control sessions on the switcher <small>· ${held.length} held${fx.target ? ' · ' + esc(fx.target) : ''}</small></h4>${sess ? `<table><thead><tr><th></th><th>Program / host</th><th>State</th></tr></thead><tbody>${sess}</tbody></table>` : '<div class="empty">no ATEM protocol traffic seen yet</div>'}</div>
	<div><h4>Flows at the switcher's port <small>· ${fx.flows.filter((f) => f.live).length} live · last 30 min</small></h4>${flows ? `<table><thead><tr><th></th><th>Peer</th><th>What</th><th>State</th><th class="num">In</th><th class="num">Since</th></tr></thead><tbody>${flows}</tbody></table>` : '<div class="empty">no unicast flow with the switcher yet</div>'}</div>
	<div class="tape">${evs || '<div class="empty" style="padding:12px">nothing happened yet</div>'}</div>`
}
async function forensicsAction(action) {
	try {
		const r = await fetch('/api/forensics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })
		const j = await r.json()
		if (j.error) alert(j.error)
	} catch (e) {
		alert('could not change the capture: ' + e.message)
	}
}

// ------------------------------------------------------------------ rack
function portTip(sw, p) {
	const who = [...p.devices.map((d) => `${d.name} (${d.type})`), ...p.clients.map((c) => `${c.name || c.ip || c.mac}${c.ip && c.name ? ' · ' + c.ip : ''}`)]
	return `<b>${esc(sw.name)} · port ${p.idx}${p.name && p.name !== 'Port ' + p.idx ? ' · ' + esc(p.name) : ''}</b><div class="kv">${p.label ? `<span>Label</span><b>${esc([p.label.name, p.label.ip, p.label.note].filter(Boolean).join(' · '))}</b>` : ''}<span>Link</span><b>${p.up ? `${speedTxt(p.speed)} ${p.fullDuplex ? 'full duplex' : 'half duplex'} ${esc(p.media || '')}` : p.enabled ? 'down' : 'disabled'}</b><span>To device</span><b>${fmtRate(p.tx)}</b><span>From device</span><b>${fmtRate(p.rx)}</b><span>Use</span><b>${Math.round(p.util * 100)}%</b>${p.poe ? `<span>PoE</span><b>${p.poeW} W ${esc(p.poeMode || '')}</b>` : ''}${p.lag ? `<span>LAG</span><b>${esc(p.lag)}</b>` : ''}<span>Errors</span><b>${p.errors}${p.errorsRecent ? ' <span class="error">new</span>' : ''}</b><span>Counters</span><b>${p.live ? 'live (SNMP) · ' : ''}${p.age} s ago</b>${who.length ? `<span>Attached</span><b>${who.map(esc).join('<br>')}${p.clientCount > p.clients.length ? `<br>+${p.clientCount - p.clients.length} more` : ''}</b>` : ''}</div>`
}
// what is on a port, as text: UniFi devices and clients on it plus the hand-written label
function portWho(p) {
	const names = [...(p.devices || []).map((d) => d.name), ...(p.clients || []).map((c) => c.name || c.ip || c.mac)]
	if (p.label?.name) names.unshift(p.label.name)
	return names.filter(Boolean)
}
function portIps(p) {
	const ips = [...(p.devices || []).map((d) => d.ip), ...(p.clients || []).map((c) => c.ip)]
	if (p.label?.ip) ips.unshift(p.label.ip)
	return [...new Set(ips.filter(Boolean))]
}
function portMatches(p, q) {
	if (!q) return false
	return [...portWho(p), ...portIps(p), p.label?.note || '', p.name || ''].join(' ').toLowerCase().includes(q)
}
let rackFilter = ''
const openPorts = new Set() // switch macs whose port list is expanded
let labelEdit = null // "mac:idx" of the port whose label is being edited inline
function renderRack(s) {
	const heroPort = s.atem?.equipment?.switch
	const online = s.switches.filter((x) => x.online)
	const offline = s.switches.filter((x) => !x.online)
	const q = rackFilter
	let hits = 0
	$('rack').classList.toggle('filtering', !!q)
	const units = online.map((sw) => {
		const rj = sw.ports.filter((p) => !p.sfp)
		const sfp = sw.ports.filter((p) => p.sfp)
		const port = (p) => {
			const key = `port:${sw.mac}:${p.idx}`
			const m = portMatches(p, q)
			if (m) hits++
			const cls = ['port', p.up ? 'up ' + speedClass(p.speed) : '', p.uplink ? 'uplink' : '', p.poe && p.poeW > 0 ? 'poe' : '', p.errorsRecent ? 'err' : '', !p.enabled ? 'disabled' : '', p.label ? 'labelled' : '', m ? 'match' : '', heroPort && heroPort.mac === sw.mac && heroPort.port === p.idx ? 'hero' : '', selection?.type === 'port' && selection.id === p.key ? 'sel' : ''].join(' ')
			return `<div class="${cls}" data-sel="port:${esc(p.key)}" ${tipAttr(key, portTip(sw, p))}>${p.idx}${p.up && p.util > 0.005 ? `<i class="act" style="transform:scaleX(${Math.max(0.08, p.util).toFixed(2)})"></i>` : ''}</div>`
		}
		const grid = (list, label) => (list.length ? `<div class="pgrp">${label ? `<label>${label}</label>` : ''}<div class="pgrid${list.length < 3 ? ' single' : ''}">${list.map(port).join('')}</div></div>` : '')
		const upl = sw.uplink
		const max = Math.max(sw.totals.down, sw.totals.up, 1)
		const sel = selection?.type === 'switch' && selection.id === sw.mac ? ' sel' : ''
		const live = sw.ports.some((p) => p.live)
		const open = openPorts.has(sw.mac) || (q && sw.ports.some((p) => portMatches(p, q)))
		const used = sw.ports.filter((p) => p.up || p.label)
		const list = open
			? `<div class="ru-list"><table><thead><tr><th>Port</th><th>Link</th><th>Device</th><th>IP</th><th class="num">To device</th><th class="num">From device</th><th>Note</th><th></th></tr></thead><tbody>${used
					.map((p) => {
						const m = portMatches(p, q)
						const editing = labelEdit === p.key
						const who = portWho(p)
						const ips = portIps(p)
						return `<tr class="${m ? 'match' : q ? 'dim' : ''}"><td class="mono">${p.idx}${p.sfp ? ' <small>SFP</small>' : ''}</td><td>${p.up ? `${speedTxt(p.speed)}${p.poe && p.poeW ? ' · ' + p.poeW + ' W' : ''}${p.uplink ? ' · uplink' : ''}` : '<span class="warn">down</span>'}</td><td>${editing ? `<div class="lbl-edit"><input class="lbl-name" value="${esc(p.label?.name || '')}" placeholder="device name"></div>` : `${who.length ? who.slice(0, 3).map(esc).join('<br>') : '<small>nothing seen</small>'}${p.clientCount > 3 ? `<br><small>+${p.clientCount - 3} more</small>` : ''}${p.label ? ' <span class="tag hand" title="hand-written label">label</span>' : ''}`}</td><td class="mono">${editing ? `<div class="lbl-edit"><input class="lbl-ip" value="${esc(p.label?.ip || '')}" placeholder="IP address"></div>` : ips.slice(0, 3).map(esc).join('<br>')}</td><td class="num dn">${fmtRate(p.tx)}</td><td class="num up">${fmtRate(p.rx)}</td><td>${editing ? `<div class="lbl-edit"><input class="lbl-note" value="${esc(p.label?.note || '')}" placeholder="note (patch panel, room…)"></div>` : esc(p.label?.note || '')}</td><td>${editing ? `<button class="btn mini primary" data-label-save="${esc(p.key)}">Save</button> <button class="btn mini quiet" data-label-cancel="1">Cancel</button>` : `<button class="btn mini quiet" data-label-edit="${esc(p.key)}" title="write what is on this port">${p.label ? 'edit' : 'label'}</button>`}</td></tr>`
					})
					.join('')}</tbody></table>${used.length ? '' : '<div class="empty">no port is up</div>'}</div>`
			: ''
		return `<div class="ru${sel}">
			<div class="ru-id" data-sel="switch:${esc(sw.mac)}">
				<b><span class="tally online"></span>${esc(sw.name)}</b>
				<small>${esc(sw.modelName)} · ${esc(sw.ip || '')} · v${esc(sw.version || '')}</small>
				<div class="stats"><div><span>up </span>${fmtUptime(sw.uptime)}</div><div><span>cpu </span><em class="${lvl(sw.cpu, 70, 85)}">${pct(sw.cpu)}</em></div><div><span>temp </span><em class="${lvl(sw.temp, 60, 70)}">${sw.temp !== null ? sw.temp + '°' : '–'}</em></div>${sw.poeMax ? `<div><span>PoE </span>${sw.poeW}/${sw.poeMax} W</div>` : ''}<div><span>uplink </span><em class="${upl.speed && upl.speed < 1000 ? 'warn' : ''}">${upl.device ? `${esc(upl.device)} p${upl.port} ${speedTxt(upl.speed)}` : speedTxt(upl.speed)}</em></div></div>
			</div>
			<div class="ru-ports">${grid(rj, '')}${grid(sfp, 'SFP')}</div>
			<div class="ru-meter">
				<div class="r"><span>in</span><em class="dn">${fmtRate(sw.totals.down)}</em></div><div class="bar"><i style="width:${(sw.totals.down / max) * 100}%"></i></div>
				<div class="r"><span>out</span><em class="up">${fmtRate(sw.totals.up)}</em></div><div class="bar"><i class="up" style="width:${(sw.totals.up / max) * 100}%"></i></div>
				<small><span>${sw.portsUp}/${sw.portsTotal} ports · ${live ? `live · ${sw.age} s` : `${sw.age} s old`}</span><button class="btn mini quiet" data-ports="${esc(sw.mac)}">${open ? 'hide ports' : 'ports ▸'}</button></small>
			</div>
			${list}
		</div>`
	})
	$('rackNote').textContent = q ? `${hits} port${hits === 1 ? '' : 's'} match "${q}"` : `${online.length} online · ${offline.length} not connected · top bar = link speed, line = activity, violet corner = labelled by hand`
	const off = offline.length ? `<div class="rack-off">${offline.map((sw) => `<span class="chip${sw.lastSeen && Date.now() - sw.lastSeen < 86400000 ? ' recent' : ''}" data-sel="switch:${esc(sw.mac)}">${esc(sw.name)} · ${esc(sw.modelName)} · ${sw.lastSeen ? 'last seen ' + fmtAgo(sw.lastSeen) + ' ago' : 'never seen'}</span>`).join('')}</div>` : ''
	$('rack').innerHTML = units.join('') + off
}
async function savePortLabel(key) {
	const row = document.querySelector(`[data-label-save="${CSS.escape(key)}"]`)?.closest('tr')
	if (!row) return
	const body = { key, name: row.querySelector('.lbl-name')?.value || '', ip: row.querySelector('.lbl-ip')?.value || '', note: row.querySelector('.lbl-note')?.value || '' }
	try {
		const r = await fetch('/api/portlabel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
		const j = await r.json()
		if (j.error) throw new Error(j.error)
	} catch (e) {
		alert('could not save the label: ' + e.message)
	}
	labelEdit = null
}

// ------------------------------------------------------------------ patchbay
function teleText(e) {
	const t = e.telemetry
	if (!t) return ''
	if (t.error) return `<span class="warn">${esc(t.error)}</span>`
	if (t.kind === 'webpresenter') return `${t.streaming ? '<span class="tag stream">stream</span> ' : ''}${esc(t.status)}${t.bitrate ? ' · ' + (t.bitrate / 1e6).toFixed(1) + ' Mb/s' : ''}${t.format ? ' · ' + esc(t.format) : ''}`
	if (t.kind === 'hyperdeck') return `${t.recording ? '<span class="tag rec">rec</span> ' : ''}${esc(t.mode)}${t.timecode ? ' · ' + esc(t.timecode) : ''}`
	if (t.kind === 'atem') return `${t.streaming?.state === 'streaming' ? '<span class="tag stream">stream</span> ' : ''}${esc(t.product || 'ATEM')}${t.programName ? ' · program ' + esc(t.programName) : ''}${t.streaming?.state ? ' · stream ' + esc(t.streaming.state) : ''}`
	return ''
}
function pbRow(e) {
	const link = e.switch ? `${esc(e.switch.name)} · p${e.switch.port} · ${speedTxt(e.switch.speed)}${e.switch.poeW ? ' · ' + e.switch.poeW + ' W' : ''}` : e.online && e.wired === false ? 'wifi' : e.lastSeen ? 'last seen ' + fmtAgo(e.lastSeen) + ' ago' : 'not seen by UniFi'
	const probe = e.probe ? (e.probe.ok ? `<span class="probe ok">${esc(e.probe.info?.name || '')} ${e.probe.ms.toFixed(0)} ms</span>` : `<span class="probe bad">no answer</span>`) : '<span class="probe"></span>'
	const max = Math.max(e.down, e.up, 1)
	const standby = !e.active
	return `<div class="pb ${standby ? 'standby' : e.status}${e.hero ? ' hero' : ''}${selection?.type === 'equipment' && selection.id === e.ip ? ' sel' : ''}" data-sel="equipment:${esc(e.ip)}">
		<span class="tally ${standby ? 'standby' : e.status}"></span>
		<div class="name">${esc(e.name)}<small>${esc(e.role)}${e.unifiName && e.unifiName !== e.name ? ' · UniFi: ' + esc(e.unifiName) : ''}${standby ? ' · ' + (e.online ? 'on the network' : 'not on the network') : ''}</small></div>
		<div class="ip">${esc(e.ip)}</div>
		<div class="link">${link}</div>
		<div class="tele">${standby ? '<span class="tag standby">standby</span>' : teleText(e)}</div>
		<div class="m"><div class="r"><span>in</span><em class="dn">${fmtRate(e.down)}</em></div><div class="bar"><i style="width:${(e.down / max) * 100}%"></i></div></div>
		<div class="m"><div class="r"><span>out</span><em class="up">${fmtRate(e.up)}</em></div><div class="bar"><i class="up" style="width:${(e.up / max) * 100}%"></i></div></div>
		${standby ? '<span class="probe"></span>' : probe}
	</div>`
}
function renderPatch(s) {
	const active = s.equipment.filter((e) => e.active)
	const standby = s.equipment.filter((e) => !e.active)
	const groups = new Map()
	for (const e of active) {
		if (!groups.has(e.group)) groups.set(e.group, [])
		groups.get(e.group).push(e)
	}
	const ok = active.filter((e) => e.status === 'online').length
	$('patchNote').textContent = `${ok} of ${active.length} in this broadcast online · ${standby.length} on standby · click a row for details`
	const head = `<div class="pb-head"><span></span><span>Device</span><span>IP</span><span>Link</span><span>Device status</span><span>In</span><span>Out</span><span>Probe</span></div>`
	const html = []
	for (const [g, list] of groups) html.push(`<div class="pb-group"><h4>${esc(g)} <small>${list.filter((e) => e.status === 'online').length}/${list.length} online</small></h4>${head}${list.map(pbRow).join('')}</div>`)
	if (standby.length) html.push(`<details class="standby"><summary>On standby, not part of this broadcast <small>· ${standby.length} device${standby.length === 1 ? '' : 's'} · no alerts, no probes · enable them in Edit roster</small></summary>${standby.map(pbRow).join('')}</details>`)
	$('patch').innerHTML = html.join('') || '<div class="empty">no equipment in the roster — click Edit roster</div>'
}

// ------------------------------------------------------------------ roster editor
const ROLES = ['switcher', 'router', 'recorder', 'encoder', 'computer', 'audio', 'unknown']
async function openRoster() {
	try {
		const r = await fetch('/api/equipment')
		const j = await r.json()
		roster = (j.equipment || []).map((e) => ({ ...e }))
	} catch (e) {
		roster = []
	}
	$('rosterOverlay').hidden = false
	renderRoster()
}
function renderRoster(msg = '') {
	const groups = [...new Set([...(roster || []).map((e) => e.group), 'Studio A', 'Field', 'Town Hall', 'Video rack', 'Audio rack'])]
	const rows = (roster || [])
		.map(
			(e, i) => `<tr class="${e.active === false ? 'off' : ''}" data-i="${i}">
			<td class="chk"><input type="checkbox" data-f="active" ${e.active !== false ? 'checked' : ''} title="part of this broadcast"></td>
			<td><input data-f="name" value="${esc(e.name)}"></td>
			<td><input data-f="ip" value="${esc(e.ip)}" class="mono"></td>
			<td><input data-f="group" value="${esc(e.group)}" list="groupList"></td>
			<td><select data-f="role">${ROLES.map((r) => `<option ${e.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
			<td><input data-f="probe" value="${esc(e.probe || '')}" placeholder="tcp:9993 · atem · x32"></td>
			<td><select data-f="telemetry"><option value="">none</option>${['webpresenter', 'hyperdeck', 'atem'].map((t) => `<option ${e.telemetry === t ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
			<td><input data-f="companion" class="short" value="${esc(e.companion || '')}" placeholder="atem" title="Companion connection label: the switcher is then read through Companion instead of a session of its own"></td>
			<td><input data-f="min_speed" class="short" value="${e.min_speed ?? ''}" placeholder="1000"></td>
			<td class="chk"><input type="checkbox" data-f="hero" ${e.hero ? 'checked' : ''} title="the main switcher (intake meter, stream detector)"></td>
			<td><button class="btn quiet" data-del="${i}" title="remove">✕</button></td>
		</tr>`,
		)
		.join('')
	$('rosterEditor').innerHTML = `<header><h2>Broadcast equipment roster</h2><small>tick what is part of this broadcast; unticked devices stay on standby (no alerts, no probes) and can be switched on later</small></header>
		<div class="body">
			<div class="help">Probe: <b>tcp:&lt;port&gt;</b> (HyperDeck 9993, Videohub 9990, Web Presenter 9977), <b>atem</b> (ATEM protocol), <b>x32</b> (OSC). Telemetry reads the device itself: Web Presenter stream status, HyperDeck transport, ATEM program/stream. Min speed in Mb/s raises a warning when the link is slower (video gear defaults to 1000).</div>
			<table><thead><tr><th>In</th><th>Name</th><th>IP</th><th>Group</th><th>Role</th><th>Probe</th><th>Telemetry</th><th>Companion</th><th>Min speed</th><th>Main</th><th></th></tr></thead><tbody>${rows}</tbody></table>
			<datalist id="groupList">${groups.map((g) => `<option value="${esc(g)}">`).join('')}</datalist>
		</div>
		<footer><button class="btn" id="rosterAdd">+ Add device</button><button class="btn primary" id="rosterSave">Save roster</button><button class="btn quiet" id="rosterCancel">Cancel</button><span class="msg" id="rosterMsg">${esc(msg)}</span></footer>`
}
function readRoster() {
	const rows = [...$('rosterEditor').querySelectorAll('tbody tr')]
	return rows.map((tr) => {
		const get = (f) => tr.querySelector(`[data-f="${f}"]`)
		return { active: get('active').checked, name: get('name').value, ip: get('ip').value.trim(), group: get('group').value, role: get('role').value, probe: get('probe').value.trim() || undefined, telemetry: get('telemetry').value || undefined, companion: get('companion').value.trim() || undefined, min_speed: get('min_speed').value.trim() || undefined, hero: get('hero').checked || undefined }
	})
}
async function saveRoster() {
	const list = readRoster()
	const btn = $('rosterSave')
	btn.disabled = true
	btn.textContent = 'Saving…'
	try {
		const r = await fetch('/api/equipment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ equipment: list }) })
		const j = await r.json()
		if (j.error) throw new Error(j.error)
		$('rosterOverlay').hidden = true
		roster = null
		if (!j.saved) alert('Roster applied, but it could not be written to the config file (' + (j.configPath || 'no path') + '); it will reset when the app restarts.')
	} catch (e) {
		btn.disabled = false
		btn.textContent = 'Save roster'
		$('rosterMsg').textContent = 'could not save: ' + e.message
	}
}
async function setActive(ip, active) {
	try {
		const r = await fetch('/api/equipment')
		const j = await r.json()
		const list = (j.equipment || []).map((e) => (e.ip === ip ? { ...e, active } : e))
		await fetch('/api/equipment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ equipment: list }) })
		setTimeout(refreshInspector, 400)
	} catch (e) {
		alert('could not update the roster: ' + e.message)
	}
}

// ------------------------------------------------------------------ tapes
function renderTape(s) {
	$('tape').innerHTML = s.events.length
		? s.events.slice(0, 80).map((ev) => `<div class="tl ${esc(ev.level || 'info')}${ev.alertId || ev.entity ? ' click' : ''}" ${ev.alertId ? `data-sel="alert:${esc(ev.alertId)}"` : ev.entity?.id ? `data-sel="${esc(ev.entity.type)}:${esc(ev.entity.id)}"` : ''}><span class="t">${fmtTime(ev.t)}</span><span class="m">${esc(ev.text)}</span></div>`).join('')
		: '<div class="empty" style="padding:12px">nothing has changed since Broadwatcher started</div>'
	$('logNote').textContent = `${s.log.length} entries · ${s.log.filter((l) => l.severity !== 'info').length} notable`
	$('unifiLog').innerHTML = s.log.length ? s.log.map((l) => `<div class="tl ${esc(l.severity)}"><span class="t">${fmtDateTime(l.t)}</span><span class="m">${esc(l.title)}${l.message && l.message !== l.title ? `<small>${esc(l.message)}</small>` : ''}</span></div>`).join('') : '<div class="empty" style="padding:12px">no events</div>'
}

// ------------------------------------------------------------------ inspector
async function select(type, id) {
	selection = { type, id }
	$('inspClose').hidden = false
	await refreshInspector()
	if (state) {
		renderIssues(state)
		renderMap(state)
		renderRack(state)
		renderPatch(state)
	}
}
function closeInspector() {
	selection = null
	details = null
	$('inspClose').hidden = true
	renderInspector()
	if (state) {
		renderIssues(state)
		renderMap(state)
		renderRack(state)
		renderPatch(state)
	}
}
async function refreshInspector() {
	if (!selection) return renderInspector()
	try {
		const r = await fetch(`/api/details?type=${encodeURIComponent(selection.type)}&id=${encodeURIComponent(selection.id)}`)
		details = await r.json()
	} catch (e) {
		details = { error: e.message }
	}
	renderInspector()
}
const tapeRows = (list, fmt) => (list.length ? `<div class="tape">${list.map(fmt).join('')}</div>` : '<div class="empty">none</div>')
function renderInspector() {
	const body = $('inspBody')
	if (!selection) {
		$('inspKind').textContent = 'AI · ' + (aiStatus?.model || 'readiness')
		$('inspTitle').textContent = 'Broadcast readiness'
		const typed = $('askInput')?.value || ''
		body.innerHTML = renderAiView()
		if (typed && $('askInput')) $('askInput').value = typed
		drawScopes()
		return
	}
	const d = details
	if (!d || d.error) {
		$('inspKind').textContent = selection.type
		$('inspTitle').textContent = selection.id
		body.innerHTML = `<div class="empty">${esc(d?.error || 'loading…')}</div>`
		return
	}
	const a = d.alert
	const ent = d.entity
	const type = a ? a.entity?.type || a.scope : d.type
	$('inspKind').textContent = a ? `${a.level} · ${a.scope}` : type
	$('inspTitle').textContent = a ? a.text : ent?.name || (type === 'port' ? `${ent?.switch?.name} port ${ent?.idx}` : type === 'atem' ? ent?.name : type === 'wan' ? 'WAN' : selection.id)
	const parts = []
	if (a) {
		parts.push(`<h3>What this means</h3><p class="explain">${esc(a.explain || '')}</p><div class="ai-meta">since ${fmtDateTime(a.since)} (${fmtAgo(a.since)})</div>`)
		const diag = diagnoses.get(a.id)
		parts.push(`<h3>AI diagnosis</h3>${diag ? diag.error ? `<p class="error">${esc(diag.error)}</p>` : `<div class="ai-text">${mdLite(diag.text)}</div><div class="ai-meta">${esc(diag.model)} · ${Math.round(diag.ms / 1000)} s · ${fmtAgo(diag.t)} ago</div>` : '<p>Ask the AI to explain this alert from the live data, related events and flows.</p>'}<div class="insp-actions"><button class="btn" data-diagnose="${esc(a.id)}" ${!aiStatus?.enabled ? 'disabled title="AI not configured"' : ''}>${diag ? 'Diagnose again' : 'Diagnose with AI'}</button></div>`)
	}
	if (ent) parts.push(entitySection(type, ent))
	if (type === 'equipment' && ent && ent.active && (ent.telemetry?.kind === 'atem' || ent.role === 'switcher')) parts.push(sessionSection(ent))
	if (type === 'equipment' && ent?.audio) parts.push(audioSection(ent))
	if (type === 'equipment' && ent) parts.push(`<div class="insp-actions">${ent.active ? `<button class="btn quiet" data-standby="${esc(ent.ip)}">Put on standby (not part of this broadcast)</button>` : `<button class="btn" data-activate="${esc(ent.ip)}">Add to this broadcast</button>`}<button class="btn quiet" id="editRosterInsp">Edit roster</button></div>`)
	if (type === 'equipment' && ent?.history) parts.push(`<h3>Traffic · last ${Math.round((ent.history.down.length * 5) / 60)} min</h3>${scope('insp', [{ data: ent.history.down, color: 'in' }, { data: ent.history.up, color: 'out' }], 'spark')}`)
	if (type === 'switch' && ent?.history) parts.push(`<h3>Traffic · all ports</h3>${scope('insp', [{ data: ent.history.down, color: 'in' }, { data: ent.history.up, color: 'out' }], 'spark')}`)
	if (type === 'wan' && ent?.history) parts.push(`<h3>WAN traffic</h3>${scope('insp', [{ data: ent.history.down, color: 'in' }, { data: ent.history.up, color: 'out' }], 'spark')}`)
	parts.push(`<h3>Broadwatcher events</h3>${tapeRows(d.events || [], (ev) => `<div class="tl ${esc(ev.level || 'info')}"><span class="t">${fmtTime(ev.t)}</span><span class="m">${esc(ev.text)}</span></div>`)}`)
	parts.push(`<h3>UniFi events</h3>${tapeRows(d.log || [], (l) => `<div class="tl ${esc(l.severity)}"><span class="t">${fmtDateTime(l.t)}</span><span class="m">${esc(l.title)}${l.message && l.message !== l.title ? `<small>${esc(l.message)}</small>` : ''}</span></div>`)}`)
	if (d.flows?.length) parts.push(`<h3>Flows through the gateway</h3>${tapeRows(d.flows, (f) => `<div class="tl info"><span class="t">${fmtTime(f.t)}</span><span class="m">${esc(f.srcName || f.src)} → ${esc(f.dstName || f.dst)}:${esc(f.dport)} ${esc(f.proto)}${f.service && f.service !== 'OTHER' ? ' ' + esc(f.service) : ''} · ${fmtBytes(f.bytes)}${f.action === 'blocked' ? ' · BLOCKED' : ''}</span></div>`)}`)
	body.innerHTML = parts.join('')
	drawScopes()
}
function entitySection(type, e) {
	const kv = (rows) => `<div class="kv">${rows.filter((r) => r && r[1] !== undefined && r[1] !== null && r[1] !== '').map(([k, v, cls]) => `<span>${esc(k)}</span><b class="${cls || ''}">${v}</b>`).join('')}</div>`
	if (type === 'equipment') {
		const t = e.telemetry
		return `<h3>${esc(e.name)}${e.active ? '' : ' <span class="tag standby">standby</span>'}</h3>${kv([
			['Status', e.active ? esc(e.status) : e.online ? 'on standby · on the network' : 'on standby · not on the network', e.active ? (e.status === 'online' ? 'ok' : 'bad') : ''],
			['IP · MAC', `${esc(e.ip)}${e.mac ? ' · ' + esc(e.mac) : ''}`],
			['Vendor', esc(e.oui || '')],
			['UniFi name', esc(e.unifiName || '')],
			['Network', esc(e.network || '')],
			['Link', e.switch ? `${esc(e.switch.name)} port ${e.switch.port} · ${speedTxt(e.switch.speed)}${e.switch.poeW ? ' · ' + e.switch.poeW + ' W PoE' : ''}` : e.online ? 'wifi' : e.lastSeen ? 'last seen ' + fmtDateTime(e.lastSeen) : 'never seen'],
			['Uptime', e.online ? fmtUptime(e.uptime) : ''],
			['Traffic', `in ${fmtRate(e.down)} · out ${fmtRate(e.up)}${e.age !== null && e.age !== undefined ? ` · counters ${e.age} s old` : ''}`],
			['Probe', e.probe ? (e.probe.ok ? `${esc(e.probeSpec)} answers · ${e.probe.ms.toFixed(0)} ms${e.probe.info?.state ? ' · ' + esc(e.probe.info.state) : ''}${e.probe.info?.name ? ' · ' + esc(e.probe.info.name) + ' ' + esc(e.probe.info.model || '') + ' fw ' + esc(e.probe.info.firmware || '') : ''}` : `${esc(e.probeSpec)}: ${esc(e.probe.error || 'no answer')}`) : e.probeSpec && e.active ? 'not yet' : ''],
			t && !t.error ? ['Device', t.kind === 'webpresenter' ? `${esc(t.product || '')} ${esc(t.deviceName || '')} v${esc(t.version || '')} · stream ${esc(t.status)}${t.bitrate ? ' · ' + (t.bitrate / 1e6).toFixed(1) + ' Mb/s' : ''}${t.format ? ' · ' + esc(t.format) : ''}` : t.kind === 'hyperdeck' ? `${esc(t.product || '')} ${esc(t.deviceName || '')} v${esc(t.version || '')} · ${esc(t.summary)}` : t.kind === 'atem' ? `${t.via === 'companion' ? 'read through Companion' : `${esc(t.product || 'ATEM')}${t.version ? ' v' + esc(t.version) : ''}`}${t.programName ? ' · program ' + esc(t.programName) + ' · preview ' + esc(t.previewName || '') : ''}${t.streaming ? ` · stream ${esc(t.streaming.state)}${t.streaming.service ? ' (' + esc(t.streaming.service) + ')' : ''}${t.streaming.url ? ' → ' + esc(t.streaming.url) : ''}${t.streaming.bitrate ? ' ' + (t.streaming.bitrate / 1e6).toFixed(1) + ' Mb/s' : ''}` : ''}${t.recording?.active ? ' · RECORDING ' + esc(t.recording.duration || '') : ''}` : ''] : t?.error ? ['Device', esc(t.error), 'bad'] : null,
			['Talks to', (e.peers || []).map((p) => `${p.dir === 'in' ? '←' : '→'} ${esc(p.name || p.ip)}${p.service && p.service !== 'OTHER' ? ' ' + esc(p.service) : ''} · ${fmtBytes(p.bytes)}`).join('<br>')],
		])}`
	}
	if (type === 'port') {
		return `<h3>${esc(e.switch?.name)} · port ${e.idx}</h3>${kv([
			['Name', esc(e.name)],
			['Link', e.up ? `${speedTxt(e.speed)} ${e.fullDuplex ? 'full duplex' : 'HALF duplex'} ${esc(e.media || '')}` : e.enabled ? 'down' : 'disabled', e.up ? 'ok' : 'bad'],
			['To device', fmtRate(e.tx)],
			['From device', fmtRate(e.rx)],
			['Utilisation', Math.round(e.util * 100) + '%'],
			e.poe ? ['PoE', `${e.poeW} W ${esc(e.poeMode || '')}`] : null,
			e.lag ? ['LAG', esc(e.lag)] : null,
			['Errors + drops', `${e.errors}${e.errorsRecent ? ' <span class="error">new in the last 10 min</span>' : ''}`],
			['Counters', `${e.live ? 'live (SNMP) · ' : ''}${e.age} s old`],
			['Attached', [...(e.devices || []).map((d) => `${esc(d.name)} (${esc(d.type)})`), ...(e.clients || []).map((c) => `${esc(c.name || c.ip || c.mac)}${c.ip && c.name ? ' · ' + esc(c.ip) : ''}`)].join('<br>') + (e.clientCount > (e.clients || []).length ? `<br>+${e.clientCount - e.clients.length} more` : '')],
			e.label ? ['Label', esc([e.label.name, e.label.ip, e.label.note].filter(Boolean).join(' · '))] : null,
		])}<h3>Label this port</h3><p>Write what is really plugged in when UniFi cannot tell (SDI gear behind a small switch, a static device, a patch-panel position). Empty fields remove the label.</p><div class="lblform" data-label-form="${esc(e.key)}"><input class="lbl-name" value="${esc(e.label?.name || '')}" placeholder="device name"><input class="lbl-ip" value="${esc(e.label?.ip || '')}" placeholder="IP address"><input class="lbl-note" value="${esc(e.label?.note || '')}" placeholder="note"></div><div class="insp-actions"><button class="btn" data-label-save-insp="${esc(e.key)}">Save label</button></div>`
	}
	if (type === 'switch' || type === 'ap' || type === 'gateway' || type === 'pdu') {
		return `<h3>${esc(e.name)}</h3>${kv([
			['Status', e.online ? 'online' : 'offline', e.online ? 'ok' : 'bad'],
			['Model', `${esc(e.modelName)} · v${esc(e.version || '')}${e.upgradable ? ' · <span class="warn">update available</span>' : ''}`],
			['IP · MAC', `${esc(e.ip || '')} · ${esc(e.mac)}`],
			['Uptime', e.online ? fmtUptime(e.uptime) : e.lastSeen ? 'last seen ' + fmtDateTime(e.lastSeen) : ''],
			['CPU · memory', `${pct(e.cpu)} · ${pct(e.mem)}`],
			['Temperature', e.temps?.length ? e.temps.map((t) => `${esc(t.name)} ${t.value}°`).join(' · ') : e.temp !== null && e.temp !== undefined ? e.temp + '°' : ''],
			e.fan !== null && e.fan !== undefined ? ['Fan', String(e.fan)] : null,
			e.uplink?.device ? ['Uplink', `${esc(e.uplink.device)} port ${e.uplink.port} ← local port ${e.uplink.localPort} · ${speedTxt(e.uplink.speed)} ${esc(e.uplink.media || '')}`] : null,
			e.portsTotal ? ['Ports', `${e.portsUp}/${e.portsTotal} up`] : null,
			e.poeMax ? ['PoE budget', `${e.poeW} / ${e.poeMax} W`] : null,
			e.totals ? ['Traffic', `in ${fmtRate(e.totals.down)} · out ${fmtRate(e.totals.up)} · counters ${e.age ?? '?'} s old`] : null,
			e.wan ? ['WAN', `${esc(e.wan.name)} ${esc(e.wan.status)} · ${esc(e.wan.ip || '')} · ${e.wan.latency ?? '–'} ms`] : null,
			e.outlets ? ['Outlets', `${e.outletsOn}/${e.outlets} on${e.powerW ? ' · ' + e.powerW + ' W' : ''}`] : null,
		])}`
	}
	if (type === 'atem') {
		const st = e.stream || {}
		return `<h3>${esc(e.name)}</h3>${kv([['Intake', `${fmtRate(e.equipment?.down || 0)} · ${esc(st.state || '')}`], ['Usual level', fmtRate(st.baseline || 0)], st.state === 'arriving' ? ['Stream', `${fmtRate(st.rate)} since ${fmtTime(st.since)} · peak ${fmtRate(st.peak)}`] : null, ['Sources', (st.sources || []).map((x) => `${esc(x.name)} [${esc(x.confidence)}] ${esc(x.detail || '')}`).join('<br>')]])}`
	}
	if (type === 'wan') return `<h3>WAN · ${esc(e.gateway || '')}</h3>${kv([['Status', esc(e.status), e.status === 'ok' ? 'ok' : 'bad'], ['Address', `${esc(e.ip || '')}${e.isp ? ' · ' + esc(e.isp) : ''}`], ['Link', speedTxt(e.speed)], ['Latency', `${e.latency ?? '–'} ms`], ['Traffic', `↓ ${fmtRate(e.down)} ↑ ${fmtRate(e.up)}`], ['Internet uptime', fmtUptime(e.uptime)]])}`
	if (type === 'api') return `<h3>UniFi API</h3><pre class="ai-text">${esc(JSON.stringify(e, null, 1))}</pre>`
	if (type === 'health') {
		return `<h3><span class="lamp sm ${esc(verdictClass(e.verdict) === 'ready' ? 'ok' : verdictClass(e.verdict) === 'degraded' ? 'warn' : 'bad')}"></span> ${esc(nice(e.verdict))} · ${e.score}/100</h3><p class="explain">${esc(e.headline)}</p><p>Profile "${esc(e.profile?.name || '')}" expects: ${esc(Object.entries(e.profile?.expect || {}).filter(([, v]) => v).map(([k]) => k.replace('_', ' ')).join(', ') || 'nothing in particular')}. Each factor is weighed; critical ones (internet, switches, the switcher, an interrupted stream) pull the verdict to at least "At risk" when they fail.</p><ul class="factors">${e.factors.map((f) => `<li class="${esc(f.level)}"><b>${esc(f.label)}</b><em>${f.value === null ? 'n/a' : Math.round(f.value * 100) + '%'}</em><span>${esc(f.reason)}${f.critical ? ' <small>(critical)</small>' : ''} <small>· weight ${f.weight}</small></span></li>`).join('')}</ul>`
	}
	if (type === 'forensics') {
		const ses = e.session
		return `<h3>${esc(e.name || e.peer || 'Mirror port')}</h3>${kv([
			['Capture', e.running ? `tshark on "${esc(e.interface)}" · ${e.pps} packets/s` : 'not running'],
			ses ? ['Control session', ses.state === 'held' ? `held since ${fmtTime(ses.since)} · ${ses.pps} pkt/s` : `${esc(ses.state)}${ses.hello ? ' · last hello ' + esc(ses.hello.text) + ' at ' + fmtTime(ses.hello.t) : ''}${ses.refusals ? ' · refused ' + ses.refusals + '×' : ''}`, ses.state === 'held' ? 'ok' : ses.state === 'refused' ? 'bad' : ''] : null,
			['Flows', (e.flows || []).slice(0, 12).map((f) => `${esc(f.app)} → port ${f.targetPort} · ${esc(f.state)}${f.detail ? ' · ' + esc(f.detail) : ''} · ${fmtBytes(f.bytesIn)} in · ${fmtTime(f.first)}${f.live ? ' · live' : ''}`).join('<br>') || 'none'],
		])}<h3>What the mirror saw</h3>${tapeRows((e.events || []).slice(0, 40), (ev) => `<div class="tl ${ev.level === 'warn' ? 'warn' : 'info'}"><span class="t">${fmtTime(ev.t)}</span><span class="m">${esc(ev.text)}</span></div>`)}`
	}
	if (type === 'vlan') {
		return `<h3>${esc(vlanLabel(e.name))}${e.vlan ? ` · VLAN ${e.vlan}` : ''}</h3>${kv([
			['Subnet', esc(e.subnet || '')],
			['Purpose', esc(e.purpose || '')],
			['Clients', String(e.clients)],
			['Traffic', `↓ ${fmtRate(e.down)} ↑ ${fmtRate(e.up)} through the gateway`],
			['Roster devices', (e.equipment || []).map((d) => `<span class="tally ${d.active ? d.status : 'standby'}"></span> ${esc(d.name)} · ${esc(d.ip)}${d.active ? '' : ' (standby)'}`).join('<br>') || 'none'],
		])}<h3>Traffic · last ${Math.round(((e.history?.down || []).length * 5) / 60)} min</h3>${scope('insp', [{ data: e.history?.down || [], color: 'in' }, { data: e.history?.up || [], color: 'out' }], 'spark')}<p>Only traffic that crosses the gateway is counted here; same-VLAN traffic (Dante audio, NDI between two sources on the NDI VLAN) stays on the switches and shows in their port counters.</p>`
	}
	if (type === 'path') {
		return `<h3><span class="pl ${esc(e.status)}"></span> ${esc(e.name)}</h3><p class="explain">${esc(e.verdict)}</p>${kv([
			['Path', `${esc(e.proto.replace('_', '+'))} WAN ${esc(e.wanPorts)} → ${esc(e.target.name)} ${esc(e.target.ip)}:${esc(e.target.port || e.wanPorts)}`],
			['Sender URL', e.url ? `<span class="mono">${esc(e.url)}/…</span>` : ''],
			['Target', e.target.standby ? 'on standby (not part of this broadcast)' : e.target.online ? `on the network${e.target.switch ? ' · ' + esc(e.target.switch) : ''}` : 'not on the network', e.target.standby ? 'bad' : e.target.online ? 'ok' : 'bad'],
			['Last hour', `${e.hits.count} flow${e.hits.count === 1 ? '' : 's'} · ${fmtBytes(e.hits.bytes)}${e.hits.blocked ? ' · ' + e.hits.blocked + ' blocked' : ''}${e.hits.last ? ' · last ' + fmtAgo(e.hits.last) + ' ago' : ''}`],
			['Senders', e.hits.sources.map((x) => `${esc(x.name || x.ip)}${x.name ? ' · ' + esc(x.ip) : ''}${x.region ? ' · ' + esc(x.region) : ''} · ${fmtBytes(x.bytes)} in ${x.flows} flow${x.flows === 1 ? '' : 's'} · ${esc(x.ports.join(', '))} · last ${fmtAgo(x.last)} ago`).join('<br>')],
			e.intake ? ['Switcher intake', e.intake.state === 'arriving' ? `rose ${e.intake.rate} Mb/s since ${fmtTime(e.intake.since)}` : `quiet${e.intake.until ? ' · last stream ended ' + fmtAgo(e.intake.until) + ' ago' : ''}`] : null,
		])}<p>Green = packets are arriving on this WAN port and reaching the target now; amber = they reach the gateway but the switcher's intake did not rise; red = wrong target (standby or off the network) or blocked. Only traffic that crosses the gateway shows here.</p>`
	}
	return ''
}

// the switcher's control connection: how it is read (Companion / own session / auto / none), what Broadwatcher
// holds right now, and which other programs are believed to hold one of the few slots
function sessionSection(e) {
	const at = state?.atem
	const ses = at && at.ip === e.ip ? at.session : null
	const tl = e.telemetry || {}
	const mode = ses?.mode || tl.mode || 'companion'
	const own = ses?.own || tl.session || (tl.via === 'session' ? tl : null)
	const comp = ses?.companion || (tl.via === 'companion' ? { ok: !tl.error, error: tl.error, connected: tl.connected } : null)
	const ownTxt = !own ? 'none' : own.state === 'connected' ? `<span class="ok">held since ${fmtTime(own.connectedAt)}</span> · ${own.commands} updates${own.captured ? ` · ${own.captured} remote-source commands captured` : ''}` : own.state === 'refused' ? `<span class="warn">refused (${esc(own.error)})</span> at ${fmtTime(own.lastHello)} · ${own.refusals} in a row · next hello ${own.retryAt ? fmtTime(own.retryAt) : '–'}` : own.closed || own.error === 'released' ? 'released' : `${esc(own.state)}${own.error ? ' · ' + esc(own.error) : ''}${own.retryAt ? ' · next hello ' + fmtTime(own.retryAt) : ''}`
	const compTxt = comp ? (comp.ok ? (comp.connected ? `<span class="ok">Companion is connected to the switcher</span>` : `<span class="warn">Companion is not connected to the switcher</span>`) : `<span class="warn">${esc(comp.error || 'Companion not reachable')}</span>`) : state?.companion ? (state.companion.ok ? 'Companion reachable' : `<span class="warn">Companion not reachable at ${esc(state.companion.url)}</span>`) : ''
	const ctl = (ses?.controllers || []).map((c) => `<li><b>${esc(c.name)}</b>${c.where ? ' · ' + esc(c.where) : ''}: ${c.held === null ? 'unknown' : c.held ? '<span class="warn">holds a slot</span>' : 'not connected'} <small>${esc(c.how)}</small></li>`).join('')
	const levelsTxt = mode === 'own' ? (own?.levels ? `<span class="ok">live · ${own.levels.sources.length} inputs</span>` : own?.state === 'connected' ? 'asked for, waiting' : 'with the session') : 'only with an own session (Companion passes no levels)'
	return `<h3>Control connection</h3><div class="ctl">
		<div class="row"><span>Read the switcher</span><select id="atemMode" data-ip="${esc(e.ip)}">${[['companion', 'through Companion (no slot)'], ['auto', 'Companion, own session only if Companion is away'], ['own', 'with Broadwatcher’s own session (one slot, Fairlight levels)'], ['none', 'not at all']].map(([v, l]) => `<option value="${v}" ${mode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
		<div class="kv" style="margin-top:4px"><span>Companion</span><b>${compTxt || '–'}</b><span>Own session</span><b>${ownTxt}</b><span>Fairlight levels</span><b>${levelsTxt}</b></div>
		<div class="row" style="margin-top:8px">${own && own.state === 'connected' ? `<button class="btn quiet" data-atem-session="release" data-ip="${esc(e.ip)}">Release the slot</button>` : mode === 'own' || mode === 'auto' ? `<button class="btn quiet" data-atem-session="connect" data-ip="${esc(e.ip)}">Try to connect now</button>` : ''}${own && own.captured ? `<button class="btn quiet" data-capture="${esc(e.ip)}">Show protocol capture</button>` : ''}</div>
		<p style="margin:8px 0 2px">An ATEM keeps only a handful of control slots, and a program that was closed keeps its slot for ~${Math.round((ses?.holdMs || 120000) / 60000)} min. Known slot holders:</p><ul>${ctl || '<li>none listed (config.json → atem.controllers)</li>'}</ul></div><div id="captureOut"></div>`
}
async function showCapture(ip) {
	const out = $('captureOut')
	if (!out) return
	out.innerHTML = '<div class="empty">reading…</div>'
	try {
		const r = await fetch(`/api/atem/capture?ip=${encodeURIComponent(ip)}`)
		const j = await r.json()
		if (j.error) return (out.innerHTML = `<p class="warn">${esc(j.error)}</p>`)
		const cmds = (j.commands || []).map((c) => `<div><b>${esc(c.name)}</b> <small>${c.total} received · ${c.samples.length} distinct bodies</small>${c.samples.slice(-4).map((s) => `<div class="cap"><b>${fmtTime(s.t)}</b> ${s.len} B${s.repeats > 1 ? ' ×' + s.repeats : ''}\n${esc(s.hex)}\n${esc(s.ascii)}${s.strings.length ? '\nstrings: ' + s.strings.map((x) => `@${x.at} "${esc(x.text)}"`).join('  ') : ''}${s.ipv4.length ? '\nipv4: ' + s.ipv4.map((x) => `@${x.at} ${esc(x.ip)}`).join('  ') : ''}\nu16: ${s.u16.join(' ')}</div>`).join('')}</div>`).join('')
		out.innerHTML = `<h3>Protocol capture · ${esc(j.product || 'ATEM')} ${esc(j.version || '')}</h3>${cmds || '<p>no remote-source commands captured yet</p>'}<p><small>Command census this session: ${(j.seen || []).slice(0, 40).map((s) => `${esc(s.name)}×${s.n}`).join(' · ')}</small></p>`
	} catch (e) {
		out.innerHTML = `<p class="warn">${esc(e.message)}</p>`
	}
}
async function atemSession(ip, action, mode) {
	try {
		const r = await fetch('/api/atem/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ip, action, mode }) })
		const j = await r.json()
		if (j.error) alert(j.error)
	} catch (e) {
		alert('could not change the switcher connection: ' + e.message)
	}
	setTimeout(refreshInspector, 600)
}

async function diagnose(id) {
	const btn = document.querySelector(`[data-diagnose="${CSS.escape(id)}"]`)
	if (btn) {
		btn.disabled = true
		btn.textContent = 'Thinking…'
	}
	try {
		const r = await fetch(`/api/ai/diagnose?id=${encodeURIComponent(id)}&refresh=${diagnoses.has(id) ? 1 : 0}`)
		diagnoses.set(id, await r.json())
	} catch (e) {
		diagnoses.set(id, { error: e.message })
	}
	renderInspector()
}

function openItemsHtml(s) {
	if (!s) return ''
	return s.alerts.length ? s.alerts.map((a) => `<div class="issue ${a.level}" data-alert="${esc(a.id)}" style="display:flex;margin-bottom:4px"><span class="k">${esc(a.scope)}</span><span>${esc(a.text)}</span></div>`).join('') : '<p class="ok">nothing open</p>'
}
// the readiness view holds the Ask box, so state ticks only refresh its open-items list (typing survives)
function renderOpenItems(s) {
	const el = $('aiOpen')
	if (el) el.innerHTML = openItemsHtml(s)
	else renderInspector()
}
function renderAiView() {
	const ai = aiInfo
	const parts = []
	if (aiStatus && !aiStatus.enabled) parts.push(`<p>AI is not configured. Add an OpenAI-compatible server (LM Studio) or an Anthropic key under <b>ai</b> in config.json, then Broadwatcher &gt; Restart server.</p>`)
	const h = state?.health
	parts.push(`<div class="verdict" data-sel="health:now" style="cursor:pointer"><span class="lamp ${h ? verdictClass(h.verdict) : ai ? verdictClass(ai.verdict) : aiStatus?.busy ? 'thinking' : ''}"></span><div><b>${esc(h ? nice(h.verdict) : ai ? nice(ai.verdict) : aiStatus?.busy ? 'Assessing' : 'Standby')}${h ? ` <small>${h.score}/100</small>` : ''}</b><small>${esc(h ? h.headline : ai ? ai.headline : aiStatus?.busy ? 'the model is reading the live state…' : 'the first assessment runs shortly after start')}</small></div></div>`)
	if (h) parts.push(`<ul class="factors">${h.factors.filter((f) => f.value !== null && f.value < 1).sort((a, b) => b.weight * (1 - b.value) - a.weight * (1 - a.value)).slice(0, 6).map((f) => `<li class="${esc(f.level)}"><b>${esc(f.label)}</b><em>${Math.round(f.value * 100)}%</em><span>${esc(f.reason)}</span></li>`).join('') || '<li class="ok"><b>All factors</b><em>100%</em><span>everything the profile expects is up</span></li>'}</ul>`)
	if (ai) {
		parts.push(`<h3>What the AI says</h3><p>${esc(ai.headline)}</p><ul>${ai.reasons.map((r) => `<li>${esc(r)}</li>`).join('') || '<li>no reasons given</li>'}</ul>`)
		if (ai.actions?.length) parts.push(`<h3>Do now</h3><ol>${ai.actions.map((r) => `<li>${esc(r)}</li>`).join('')}</ol>`)
		parts.push(`<div class="ai-meta">${esc(ai.model)} · ${Math.round(ai.ms / 1000)} s · ${fmtAgo(ai.t)} ago · confidence ${esc(ai.confidence || '?')}${ai.aiVerdict && h && ai.aiVerdict !== h.verdict ? ` · the model alone would say ${esc(nice(ai.aiVerdict))}` : ''}</div>`)
	}
	if (aiStatus?.lastError) parts.push(`<p class="error">AI error: ${esc(aiStatus.lastError)}</p>`)
	const pv = aiStatus?.providers
	const seg = pv ? `<span class="seg mini" title="which AI judges readiness"><button type="button" class="${pv.active === 'openai' ? 'on' : ''}" data-ai-provider="openai" title="${esc(pv.local ? 'local server: ' + pv.localUrl : 'no local server set up (Settings)')}">Local</button><button type="button" class="${pv.active === 'anthropic' ? 'on' : ''}" data-ai-provider="anthropic" title="${esc(pv.anthropic ? pv.anthropicModel : 'no Anthropic key yet (Settings)')}">Claude</button></span>` : ''
	parts.push(`<div class="insp-actions"><button class="btn" id="reassess" ${!aiStatus?.enabled || aiStatus?.busy ? 'disabled' : ''}>Reassess now</button>${seg}<button class="btn quiet" id="aiSettings" title="AI settings">Settings</button></div>`)
	parts.push(`<h3>Ask the engineer</h3><p>Questions are answered from the live state: "is the field kit ready?", "why is the NDI VLAN busy?", "what changed in the last hour?"</p><div class="ask"><input id="askInput" placeholder="ask about the network…" ${!aiStatus?.enabled ? 'disabled' : ''}><button class="btn" id="askBtn" ${!aiStatus?.enabled ? 'disabled' : ''}>Ask</button></div><div id="askOut">${qa
		.slice()
		.reverse()
		.map((x) => `<div class="qa"><div class="q">${esc(x.q)}</div><div class="ai-text">${x.a ? mdLite(x.a) : '<em>thinking…</em>'}</div>${x.ms ? `<div class="ai-meta">${Math.round(x.ms / 1000)} s</div>` : ''}</div>`)
		.join('')}</div>`)
	parts.push(`<h3>Open items</h3><div id="aiOpen">${openItemsHtml(state)}</div>`)
	return parts.join('')
}
async function ask(q) {
	if (!q.trim()) return
	const entry = { q, a: '', ms: 0 }
	qa.push(entry)
	renderInspector()
	try {
		const history = qa.slice(0, -1).flatMap((x) => [{ role: 'user', content: x.q }, { role: 'assistant', content: x.a }]).filter((m) => m.content)
		const r = await fetch('/api/ai/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: q, history }) })
		const j = await r.json()
		entry.a = j.text || j.error || 'no answer'
		entry.ms = j.ms || 0
	} catch (e) {
		entry.a = 'error: ' + e.message
	}
	renderInspector()
}

// ------------------------------------------------------------------ main loop
function render(s) {
	state = s
	lastStateAt = Date.now()
	renderHud(s)
	renderIssues(s)
	const folded = (id) => $(id).classList.contains('folded')
	if (!folded('homeBlock')) renderHome(s)
	if (!folded('gwBlock')) renderGateway(s)
	renderMap(s)
	if (!folded('atemBlock')) renderAtem(s)
	if (!folded('pathBlock')) renderPaths(s)
	if (!folded('audioBlock')) renderAudio(s)
	if (!folded('forBlock')) renderForensics(s)
	if (!folded('rackBlock') && !labelEdit) renderRack(s)
	if (!folded('patchBlock')) renderPatch(s)
	if (!folded('tapeBlock')) renderTape(s)
	if (!selection) renderOpenItems(s)
	drawScopes()
	if (hover) showTip(hover.key, hover.x, hover.y)
	$('freshness').textContent = `updated ${fmtTime(s.ts)}${s.snmp?.enabled ? ' · counters live via SNMP' : ''}`
}

function connect() {
	const es = new EventSource('/api/events')
	es.addEventListener('state', (e) => render(JSON.parse(e.data)))
	es.addEventListener('ai', (e) => {
		const j = JSON.parse(e.data)
		if (j && !j.error) aiInfo = j
		fetch('/api/ai/status').then((r) => r.json()).then((st) => {
			aiStatus = st
			if (state) renderHud(state)
			if (!selection) renderInspector()
		})
	})
	es.addEventListener('event', () => {
		if (selection) refreshInspector()
	})
	es.addEventListener('meters', (e) => applyMeters(JSON.parse(e.data)))
	es.onerror = () => {
		$('readyVerdict').textContent = 'Reconnecting'
		$('readyLamp').className = 'lamp down'
	}
}

// clicks: everything with data-sel / data-alert / data-node opens the inspector
document.addEventListener('click', (e) => {
	const t = e.target
	if (t.closest?.('#rosterEditor')) {
		if (t.id === 'rosterSave') return saveRoster()
		if (t.id === 'rosterCancel') {
			$('rosterOverlay').hidden = true
			roster = null
			return
		}
		if (t.id === 'rosterAdd') {
			roster = readRoster()
			roster.push({ active: true, name: '', ip: '', group: 'Studio A', role: 'unknown' })
			renderRoster()
			return
		}
		const del = t.closest('[data-del]')
		if (del) {
			roster = readRoster()
			roster.splice(Number(del.getAttribute('data-del')), 1)
			renderRoster()
			return
		}
		return
	}
	if (t.id === 'rosterOverlay') return
	if (t.id === 'editRoster' || t.id === 'editRosterInsp') return openRoster()
	if (t.closest?.('[data-standby]')) return setActive(t.closest('[data-standby]').getAttribute('data-standby'), false)
	if (t.closest?.('[data-activate]')) return setActive(t.closest('[data-activate]').getAttribute('data-activate'), true)
	const alertEl = t.closest?.('[data-alert]')
	if (alertEl) return select('alert', alertEl.getAttribute('data-alert'))
	const selEl = t.closest?.('[data-sel]')
	if (selEl) {
		const v = selEl.getAttribute('data-sel')
		const i = v.indexOf(':')
		return select(v.slice(0, i), v.slice(i + 1))
	}
	const node = t.closest?.('[data-node]')
	if (node) {
		const id = node.getAttribute('data-node')
		if (id.startsWith('eq:')) return select('equipment', id.slice(3))
		if (id === 'internet') return select('wan', 'wan')
		const n = state?.topology.nodes.find((x) => x.id === id)
		return select(n?.kind === 'ap' ? 'ap' : n?.kind === 'pdu' ? 'pdu' : n?.kind === 'gateway' ? 'gateway' : 'switch', id)
	}
	if (t.closest?.('[data-diagnose]')) return diagnose(t.closest('[data-diagnose]').getAttribute('data-diagnose'))
	if (t.closest?.('[data-atem-session]')) return atemSession(t.closest('[data-atem-session]').getAttribute('data-ip'), t.closest('[data-atem-session]').getAttribute('data-atem-session'))
	if (t.closest?.('[data-capture]')) return showCapture(t.closest('[data-capture]').getAttribute('data-capture'))
	if (t.id === 'reassess') {
		t.disabled = true
		t.textContent = 'Assessing…'
		fetch('/api/ai/assess?refresh=1').catch(() => {})
		return
	}
	if (t.id === 'askBtn') return ask($('askInput').value)
	if (t.id === 'inspClose') return closeInspector()
	if (t.closest?.('#hudReady')) {
		setRail(true)
		return closeInspector()
	}
	if (t.closest?.('#railToggle')) return setRail(!$('railToggle').classList.contains('on'))
	const fold = t.closest?.('[data-fold]')
	if (fold) return toggleFold(fold.getAttribute('data-fold'))
	if (t.id === 'prepareBtn') return Prepare.open()
	if (t.id === 'forToggle') return forensicsAction(t.getAttribute('data-for-action'))
	const tile = t.closest?.('[data-tile]')
	if (tile) return tileClick(tile.getAttribute('data-tile'))
	if (t.id === 'mapIn') return NetMap.zoom(1.25)
	if (t.id === 'mapOut') return NetMap.zoom(1 / 1.25)
	if (t.id === 'mapFit') return NetMap.fit()
	const pl = t.closest?.('[data-ports]')
	if (pl) {
		const mac = pl.getAttribute('data-ports')
		if (openPorts.has(mac)) openPorts.delete(mac)
		else openPorts.add(mac)
		if (state) renderRack(state)
		return
	}
	if (t.closest?.('[data-label-edit]')) {
		labelEdit = t.closest('[data-label-edit]').getAttribute('data-label-edit')
		if (state) renderRack(state)
		return
	}
	if (t.closest?.('[data-label-cancel]')) {
		labelEdit = null
		if (state) renderRack(state)
		return
	}
	if (t.closest?.('[data-label-save]')) return savePortLabel(t.closest('[data-label-save]').getAttribute('data-label-save'))
	if (t.closest?.('[data-label-save-insp]')) {
		const key = t.closest('[data-label-save-insp]').getAttribute('data-label-save-insp')
		const form = document.querySelector(`[data-label-form="${CSS.escape(key)}"]`)
		const body = { key, name: form?.querySelector('.lbl-name')?.value || '', ip: form?.querySelector('.lbl-ip')?.value || '', note: form?.querySelector('.lbl-note')?.value || '' }
		fetch('/api/portlabel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(() => setTimeout(refreshInspector, 400)).catch((e) => alert('could not save the label: ' + e.message))
		return
	}
	if (t.closest?.('#themeToggle')) return applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark')
	if (t.closest?.('#settingsBtn')) return Settings.open('', { onSaved: refreshAiStatus })
	if (t.id === 'aiSettings') return Settings.open('ai', { onSaved: refreshAiStatus })
	const prov = t.closest?.('[data-ai-provider]')
	if (prov) return switchAiProvider(prov.getAttribute('data-ai-provider'))
})
// the one-click local/cloud switch: only between providers that are set up; otherwise open Settings
async function switchAiProvider(provider) {
	const pv = aiStatus?.providers || {}
	if ((provider === 'anthropic' && !pv.anthropic) || (provider === 'openai' && !pv.local)) return Settings.open('ai', { onSaved: refreshAiStatus })
	if (pv.active === provider) return
	try {
		await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ai: { provider } }) })
	} catch (e) {
		alert('could not switch the AI: ' + e.message)
	}
	aiInfo = null
	refreshAiStatus()
}
function refreshAiStatus() {
	fetch('/api/ai/status').then((r) => r.json()).then((st) => {
		aiStatus = st
		if (st.assessment) aiInfo = st.assessment
		if (state) renderHud(state)
		if (!selection) renderInspector()
	}).catch(() => {})
}
document.addEventListener('change', (e) => {
	if (e.target.id === 'atemMode') atemSession(e.target.getAttribute('data-ip'), 'mode', e.target.value)
	if (e.target.id === 'profileSelect') fetch('/api/profiles/activate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: e.target.value, applyRoster: false }) }).catch((err) => alert('could not switch the profile: ' + err.message))
})
document.addEventListener('keydown', (e) => {
	if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') {
		if (e.key === 'Enter' && e.target.id === 'askInput') ask(e.target.value)
		if (e.key === 'Enter' && e.target.closest('.lbl-edit')) savePortLabel(e.target.closest('tr')?.querySelector('[data-label-save]')?.getAttribute('data-label-save'))
		if (e.key === 'Escape' && e.target.id === 'portFind') {
			e.target.value = ''
			rackFilter = ''
			if (state) {
				renderRack(state)
				renderMap(state)
			}
		}
		return
	}
	if (e.key === 'r' || e.key === 'R') setRail(!$('railToggle').classList.contains('on'))
	if (e.key === 'Escape') {
		if (!$('rosterOverlay').hidden) $('rosterOverlay').hidden = true
		else closeInspector()
	}
})
$('mapAll').addEventListener('change', (e) => {
	mapAll = e.target.checked
	if (state) renderMap(state)
})
$('portFind').addEventListener('input', (e) => {
	rackFilter = e.target.value.trim().toLowerCase()
	if (state) {
		renderRack(state)
		renderMap(state)
	}
})
loadFolds()
setInterval(() => {
	$('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
	if (lastStateAt && Date.now() - lastStateAt > 30000) {
		$('readyVerdict').textContent = 'No data'
		$('readyHeadline').textContent = `nothing from the server for ${Math.round((Date.now() - lastStateAt) / 1000)} s`
		$('readyLamp').className = 'lamp down'
	}
}, 1000)
setInterval(() => {
	if (selection) refreshInspector()
}, 10000)
window.addEventListener('resize', () => state && render(state))

$('inspClose').hidden = true
fetch('/api/ai/status').then((r) => r.json()).then((st) => {
	aiStatus = st
	if (st.assessment) aiInfo = st.assessment
	if (!selection) renderInspector()
}).catch(() => {})
// first run of a fresh install (no gateway key yet): open the settings with the welcome note
fetch('/api/settings').then((r) => r.json()).then((s) => {
	if (s && s.firstRun) Settings.open('gateway', { welcome: true, onSaved: refreshAiStatus })
}).catch(() => {})
fetch('/api/state').then((r) => r.json()).then((s) => s.ts && render(s)).catch(() => {})
connect()
