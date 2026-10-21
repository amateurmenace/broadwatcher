/* Broadwatch — paper console. State arrives over server-sent events; every section re-renders from it.
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
	// the cells between the lamp and the clock: the modules the config lists (Settings > Top bar), in order
	const mods = Array.isArray(s.hudModules) && s.hudModules.length ? s.hudModules : HUD_DEFAULT
	$('hudCells').innerHTML = mods.map((m) => hudCell(m, s)).join('')
	$('hudIssues').innerHTML = (errors ? `<span class="error" title="open problems (error-level alerts)">${errors} <i>error${errors === 1 ? '' : 's'}</i></span>` : '') + (warns ? `<span class="warn" title="open warnings">${warns} <i>warning${warns === 1 ? '' : 's'}</i></span>` : '') + (!errors && !warns ? '<span class="ok" title="no open alerts">all clear</span>' : '')
	document.title = (errors ? '✕ ' : warns ? '! ' : '') + 'Broadwatch'
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
	// the cards this show wants (Prepare a broadcast); every card ends with a labelled gauge, meter or graph
	const wanted = s.profiles?.list?.find((p) => p.id === s.profiles.active)?.tiles
	const shown = (s.tiles || []).filter((t) => !wanted || !wanted.length || wanted.includes(t.id))
	const tileHtml = shown.map((t) => `<div class="tile ${esc(t.level)}" data-tile="${esc(t.id)}" title="${esc(t.line)}"><div class="th"><span class="lamp sm ${esc(t.level)}"></span>${esc(t.label)}</div><div class="tv">${esc(t.value)}${t.unit ? `<small>${esc(t.unit)}</small>` : ''}</div><div class="tl">${esc(t.line)}</div><div class="tg">${tileGraphic(t, s)}</div></div>`).join('')
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
	const rows = L.sources.map((x) => meterRow(`atem:${x.id}`, x.id < 1000 ? x.id : '', x.label, { level: x.level, peak: x.peak }, { muted: x.mix !== null && x.mix !== undefined && x.mix <= -99 && x.level > -60, hint: `${x.label} · carries ${fmtDb(x.level)} dBFS · into the program ${x.mix <= -99 ? 'nothing (off or fader down)' : fmtDb(x.mix) + ' dBFS'}` }))
	const master = L.master ? [meterRow('atem:master', 'Σ', 'Master', { level: L.master.level, peak: L.master.peak }, { hint: `mix bus ${fmtDb(L.master.level)} dBFS · to program ${fmtDb(L.master.mix)} dBFS` })] : []
	const half = Math.ceil(rows.length / 2)
	return `<div class="x32p">${head}<div class="mcols">${[rows.slice(0, half), rows.slice(half), master].filter((r) => r.length).map((r, i) => `<div class="mcol"><div class="mhead">${i === 2 || (i === 1 && !rows.slice(half).length) ? 'Master' : 'Inputs'}</div>${SCALE}${r.join('')}</div>`).join('')}</div><p class="mnote">The bar is what each input carries (pre-fader), with its held peak; an input that carries signal but sends nothing to the program (off, or fader down) is shown struck through. Decoded from the switcher's FMLv / FDLv messages as the HD8 sends them, checked against the mirror port.</p></div>`
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
	$('railToggle').textContent = (on ? '▸' : '◂') + ' Panel'
	try {
		localStorage.setItem('bw-rail', on ? 'on' : 'off')
	} catch {}
	if (state) renderMap(state)
}

// ------------------------------------------------------------------ issues
function renderIssues(s) {
	const block = $('issuesBlock')
	if (block) block.hidden = !s.alerts.length
	const row = (a) => `<div class="issue ${a.level}${selection?.type === 'alert' && selection.id === a.id ? ' sel' : ''}" data-alert="${esc(a.id)}"><i class="mark"></i><span class="k">${esc(a.scope)}</span><span>${esc(a.text)}</span><span class="since">${fmtAgo(a.since)}</span><span class="go">what it means · diagnose ▸</span></div>`
	$('issues').innerHTML = [['error', 'Problems'], ['warn', 'Warnings'], ['info', 'Notes']]
		.map(([lv, title]) => {
			const items = s.alerts.filter((a) => a.level === lv)
			return items.length ? `<h4 class="${lv}">${title} · ${items.length}</h4>${items.map(row).join('')}` : ''
		})
		.join('')
}

// ------------------------------------------------------------------ map
function renderMap(s) {
	const topo = s.topology || { nodes: [], links: [] }
	for (const n of topo.nodes) {
		const t = n.telemetry
		tips.set('node:' + n.id, `<b>${esc(n.label || n.name)}</b><div class="kv">${n.label ? `<span>UniFi name</span><b>${esc(n.name)}</b>` : ''}${n.model ? `<span>Model</span><b>${esc(n.model)}</b>` : ''}${n.ip ? `<span>IP</span><b>${esc(n.ip)}</b>` : ''}<span>Status</span><b>${esc(n.status)}</b>${n.rate ? `<span>In / out</span><b>${fmtRate(n.rate.in)} / ${fmtRate(n.rate.out)}</b>` : ''}${n.portsTotal ? `<span>Ports</span><b>${n.portsUp}/${n.portsTotal} up</b>` : ''}${n.cpu !== undefined && n.cpu !== null ? `<span>CPU / temp</span><b>${n.cpu}% / ${n.temp ?? '–'}°</b>` : ''}${t?.summary ? `<span>Device</span><b>${esc(t.summary)}</b>` : ''}</div><small>click for details</small>`)
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
// the forensics view: the state's light snapshot (recent), or the whole session fetched with the filters
const forView = { window: 'recent', kind: '', q: '', state: '', data: null, timer: null, loading: false, ai: null, aiBusy: false }
const forFiltering = () => forView.window === 'all' || !!forView.q || !!forView.kind || !!forView.state
function forParams() {
	const p = new URLSearchParams()
	if (forView.q) p.set('q', forView.q)
	if (forView.kind) p.set('kind', forView.kind)
	if (forView.state) p.set('state', forView.state)
	if (forView.window !== 'all') p.set('since', String(Date.now() - 1800000))
	return p
}
async function loadForensicsAll() {
	if (forView.loading) return
	forView.loading = true
	try {
		forView.data = await (await fetch('/api/forensics/all?' + forParams())).json()
	} catch (e) {
		forView.data = { error: e.message }
	}
	forView.loading = false
	if (state) renderForensics(state)
}
function scheduleForensics(ms = 400) {
	clearTimeout(forView.timer)
	forView.timer = setTimeout(loadForensicsAll, ms)
}
function renderForensics(s) {
	const live = s.forensics
	const note = $('forNote')
	const btn = $('forToggle')
	if (!live) {
		btn.hidden = true
		$('forBar').hidden = true
		note.textContent = 'no mirror capture on this machine'
		return ($('forPanel').innerHTML = '<div class="empty">a mirror of the switcher\'s switch port, read with tshark, shows every stream and every control session as the switcher sees them: set the capture interface in Settings &gt; Capture</div>')
	}
	$('forBar').hidden = false
	const filtering = forFiltering()
	const fx = filtering && forView.data && !forView.data.error ? forView.data : live
	btn.hidden = !live.available
	btn.textContent = live.running ? 'Stop capture' : 'Start capture'
	btn.setAttribute('data-for-action', live.running ? 'stop' : 'start')
	const tot = live.totals || {}
	note.textContent = live.running ? `tshark on "${live.interface}" · ${live.pps} packets/s · since ${fmtTime(live.since)} · ${tot.sessions ?? '?'} sockets, ${tot.flows ?? '?'} flows, ${tot.events ?? '?'} events kept${live.restarts ? ` · ${live.restarts} restarts` : ''}` : live.available ? `stopped${live.error ? ' · ' + live.error : ''}` : `not available · ${live.error || 'tshark or the interface is missing'}`
	const raw = $('forRaw')
	raw.textContent = live.raw?.running ? 'Stop raw packets' : 'Raw packets'
	raw.classList.toggle('primary', !!live.raw?.running)
	raw.setAttribute('data-for-action', live.raw?.running ? 'raw-stop' : 'raw-start')
	$('forJson').href = '/api/forensics/export?' + forParams()
	$('forCsv').href = '/api/forensics/export?format=csv&' + forParams()
	const files = live.raw?.files || []
	$('forFiles').hidden = !files.length && !live.raw?.running
	$('forFiles').innerHTML = `<b>Raw packet files</b> <small>${live.raw?.running ? `recording since ${fmtTime(live.raw.since)} · ` : ''}${files.length ? 'open them in Wireshark: ' : 'none yet'}</small><br>${files.map((f) => `<a href="/api/forensics/pcap/${encodeURIComponent(f.name)}" download>${esc(f.name)} · ${fmtBytes(f.size)}</a>`).join('')}`
	const held = fx.sessions.filter((x) => x.state === 'held')
	const perHost = new Map()
	for (const x of fx.sessions) perHost.set(x.ip, (perHost.get(x.ip) || 0) + (x.state === 'held' ? 1 : 0))
	const sessRow = (x) => `<tr class="click" data-sel="forensics:${esc(x.ip)}"><td><span class="tally ${SESSION_LAMP[x.state] || ''}"></span></td><td>${esc(x.name || x.ip)}<small class="mono">${esc(x.ip)}:${x.port}${perHost.get(x.ip) > 1 ? ` · ${perHost.get(x.ip)} sessions from this host` : ''}</small></td><td>${x.state === 'held' ? `<span class="ok">holds a session</span><small>since ${fmtTime(x.since)} · ${x.pps} pkt/s</small>` : x.state === 'refused' ? `<span class="error">refused</span><small>too many clients · ${x.refusals}× · last ${fmtAgo(x.hello?.t)} ago</small>` : x.state === 'gone' ? `gone<small>${fmtDateTime(x.first)} → ${fmtDateTime(x.last)}</small>` : `${esc(x.state)}<small>${x.hello ? esc(x.hello.text) + ' · ' : ''}last ${fmtAgo(x.last)} ago</small>`}</td></tr>`
	const flowRow = (f) => `<tr class="click ${f.live ? 'live' : ''}" data-sel="forensics:${esc(f.peer)}"><td><span class="tally ${f.live ? 'online' : /reset|rejected|no answer/.test(f.state) ? 'offline' : ''}"></span></td><td>${esc(f.name || f.peer)}${f.name ? `<small class="mono">${esc(f.peer)}</small>` : ''}</td><td><span class="tag">${esc(f.app)}</span><small>${f.outbound ? `from the switcher → ${esc(f.peer)}:${f.peerPort}` : `${esc(f.proto)} → switcher port ${f.targetPort}`}</small></td><td class="${/reset|rejected|no answer/.test(f.state) ? 'error' : f.state === 'streaming' || f.state === 'publishing' ? 'cyan' : ''}">${esc(f.state)}<small>${esc(f.detail || '')}</small></td><td class="num"><span class="dn">${f.live ? fmtRate(f.inMbps) : fmtBytes(f.bytesIn)}</span><small class="up">${f.live ? fmtRate(f.outMbps) + ' back' : fmtBytes(f.bytesOut) + ' back'}</small></td><td class="num">${filtering ? fmtDateTime(f.first) : fmtTime(f.first)}<small>${f.live ? 'live' : (f.endedAt ? 'ended ' : 'last ') + fmtAgo(f.endedAt || f.last) + ' ago'}</small></td></tr>`
	const sess = fx.sessions.map(sessRow).join('')
	const flows = fx.flows.map(flowRow).join('')
	const evs = fx.events.map((e) => `<div class="tl ${e.level === 'warn' ? 'warn' : 'info'}${e.peer ? ' click' : ''}" ${e.peer ? `data-sel="forensics:${esc(e.peer)}"` : ''}><span class="t">${filtering ? fmtDateTime(e.t) : fmtTime(e.t)}</span><span class="m">${esc(e.text)}</span></div>`).join('')
	const ai = forView.ai
	const reading = forView.aiBusy ? '<div class="ai-reading"><h4>Reading the capture…</h4><p class="ai-meta">the model is going through the sessions, flows and events</p></div>' : ai ? `<div class="ai-reading"><h4>What the AI makes of the capture <small>· ${esc(ai.model)} · ${ai.provider === 'anthropic' ? 'Claude' : 'local model'} · ${Math.round(ai.ms / 1000)} s · ${fmtAgo(ai.t)} ago${ai.focus ? ' · about ' + esc(ai.focus) : ''}</small></h4>${ai.error ? `<p class="error">${esc(ai.error)}</p>` : `<div class="ai-text">${mdLite(ai.text)}</div>`}<div class="ask" style="margin-top:8px"><input id="forAsk" placeholder="ask about the capture… (why was 10.0.0.5 refused? what is the SRT latency?)"><button class="btn mini" data-for-ai="${esc(ai.provider || 'anthropic')}" data-for-ask="1">Ask</button></div></div>` : ''
	const scopeNote = filtering ? `<small>${forView.window === 'all' ? 'whole session' : 'last 30 min'}${forView.q ? ` · "${esc(forView.q)}"` : ''}${forView.state ? ' · ' + esc(forView.state) : ''}${forView.data?.error ? ' · <span class="error">' + esc(forView.data.error) + '</span>' : ''}</small>` : ''
	const showS = !forView.kind || forView.kind === 'sessions'
	const showF = !forView.kind || forView.kind === 'flows'
	const showE = !forView.kind || forView.kind === 'events'
	$('forPanel').innerHTML = `${reading}${showS ? `<div class="${filtering ? 'whole' : ''}"><h4>Control sessions on the switcher <small>· ${held.length} held · ${fx.sessions.length} socket${fx.sessions.length === 1 ? '' : 's'}${fx.target ? ' · ' + esc(fx.target) : ''}</small> ${scopeNote}</h4>${sess ? `<table><thead><tr><th></th><th>Program / host</th><th>State</th></tr></thead><tbody>${sess}</tbody></table>` : '<div class="empty">no ATEM protocol traffic matches</div>'}</div>` : ''}
	${showF ? `<div class="${filtering ? 'whole' : ''}"><h4>Flows at the switcher's port <small>· ${fx.flows.filter((f) => f.live).length} live · ${fx.flows.length} listed${filtering ? '' : ' · last 30 min'}</small></h4>${flows ? `<table><thead><tr><th></th><th>Peer</th><th>What</th><th>State</th><th class="num">In</th><th class="num">Since</th></tr></thead><tbody>${flows}</tbody></table>` : '<div class="empty">no flow matches</div>'}</div>` : ''}
	${showE ? `<div class="tape ${filtering ? 'whole' : ''}">${evs || '<div class="empty" style="padding:12px">no event matches</div>'}</div>` : ''}`
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
// the AI reads the capture (the whole session, or one peer in the inspector), with Claude or the local model
async function explainForensics(provider, { peer = null, question = '' } = {}) {
	const pv = aiStatus?.providers || {}
	if (provider === 'anthropic' && !pv.anthropic) return Settings.open('ai', { onSaved: refreshAiStatus })
	if (provider === 'openai' && !pv.local) return LocalAI.open({ onDone: () => setTimeout(refreshAiStatus, 300) })
	forView.aiBusy = true
	if (peer) diagnoses.set('fx:' + peer, { busy: true })
	if (state) renderForensics(state)
	if (peer) renderInspector()
	let out
	try {
		const r = await fetch('/api/ai/forensics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider, peer, question }) })
		out = await r.json()
		if (!out || out.error || !out.text) out = { error: out?.error || 'no answer from the model', provider, t: Date.now(), ms: 0, model: '' }
	} catch (e) {
		out = { error: e.message, provider, t: Date.now(), ms: 0, model: '' }
	}
	forView.aiBusy = false
	if (peer) diagnoses.set('fx:' + peer, out)
	else forView.ai = out
	if (state) renderForensics(state)
	if (peer) renderInspector()
}
function fxAiSection(peer) {
	const d = peer ? diagnoses.get('fx:' + peer) : null
	return `<h3>Ask the AI about this peer</h3>${d?.busy ? '<p class="ai-meta">reading the capture…</p>' : d ? d.error ? `<p class="error">${esc(d.error)}</p>` : `<div class="ai-text">${mdLite(d.text)}</div><div class="ai-meta">${esc(d.model)} · ${d.provider === 'anthropic' ? 'Claude' : 'local model'} · ${Math.round(d.ms / 1000)} s · ${fmtAgo(d.t)} ago</div>` : '<p>The model reads every session, flow and event the mirror holds for this peer and says what happened and what to check.</p>'}<div class="insp-actions"><button class="btn diagnose" data-for-ai="anthropic" data-for-peer="${esc(peer || '')}">✦ Explain with Claude</button><button class="btn diagnose local" data-for-ai="openai" data-for-peer="${esc(peer || '')}">✦ Explain with local AI</button></div>`
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
// ------------------------------------------------------------------ equipment: one card per device, designed for what it is
const gaugeHtml = (label, v, max, txt, cls = '') => `<div class="gauge"><span>${label}</span><div class="bar"><i class="${cls}" style="width:${Math.min(100, ((Number(v) || 0) / Math.max(1e-9, max)) * 100).toFixed(0)}%"></i></div><em class="${cls}">${txt}</em></div>`
const kvCell = (label, val, cls = '') => `<span><label>${label}</label><b class="${cls}" title="${esc(String(val).replace(/<[^>]+>/g, ''))}">${val}</b></span>`
const sparkRow = (key, e, label) => `<div class="eqg"><label><span>${label}</span><i><span class="dn">↓${fmtRate(e.down)}</span> <span class="up">↑${fmtRate(e.up)}</span></i></label>${scope(key, [{ data: e.history?.down || [], color: 'in' }, { data: e.history?.up || [], color: 'out' }], 'espark', { bare: true })}</div>`
const linkTxt = (e) => (e.switch ? `${esc(e.switch.name)} · p${e.switch.port} · ${speedTxt(e.switch.speed)}${e.switch.poeW ? ' · ' + e.switch.poeW + ' W' : ''}` : e.online && e.wired === false ? 'wifi' : e.lastSeen ? 'last seen ' + fmtAgo(e.lastSeen) + ' ago' : 'not seen by UniFi')
function eqCard(e, s) {
	const t = e.telemetry && !e.telemetry.error ? e.telemetry : null
	const standby = !e.active
	const cls = ['eqc', standby ? 'standby' : e.status, e.hero ? 'hero' : '', selection?.type === 'equipment' && selection.id === e.ip ? 'sel' : ''].join(' ')
	const probe = e.probe ? (e.probe.ok ? `<span class="ok">${esc(e.probeSpec)} answers · ${e.probe.ms.toFixed(0)} ms</span>` : `<span class="warn">${esc(e.probeSpec)}: ${esc(e.probe.error || 'no answer')}</span>`) : e.probeSpec ? esc(e.probeSpec) + ' · not yet' : 'no probe'
	const age = e.telemetry?.t ? `read ${fmtAgo(e.telemetry.t)} ago` : e.age !== null && e.age !== undefined ? `counters ${e.age} s old` : ''
	const head = `<div class="eqh"><span class="tally ${standby ? 'standby' : e.status}"></span><div class="eqn"><b>${esc(e.name)}</b><small>${esc(e.role)}${e.auto ? ' · from ' + esc(e.group) : ''} · ${esc(e.ip)}${e.unifiName && e.unifiName !== e.name ? ' · ' + esc(e.unifiName) : ''}</small></div><span class="eqlink">${linkTxt(e)}</span></div>`
	const foot = `<div class="eqf"><span>${probe}</span><span>${age}</span></div>`
	let body = ''
	const k = t?.kind || e.audio?.kind || null
	if (e.telemetry?.error) body = `<p class="warn" style="margin:0;font-size:11.5px">${esc(e.telemetry.error)}</p>${sparkRow('eq:' + e.ip, e, 'traffic · 10 min')}`
	else if (k === 'atem') {
		const st = s.atem?.ip === e.ip ? s.atem.stream : null
		const held = s.atem?.ip === e.ip ? (s.forensics?.sessions || []).filter((x) => x.state === 'held').length : null
		const rec = t.recording
		body = `<div class="eqkv">${kvCell('program', t.programName ? esc(t.programName) : '–', 'big rec')}${kvCell('preview', esc(t.previewName || '–'), 'big')}${kvCell('control', t.via === 'companion' ? 'via Companion' : 'own session')}</div>
		<div class="eqkv">${kvCell('stream out', t.streaming ? `${t.streaming.state === 'streaming' ? '<span class="tag stream">live</span> ' : ''}${esc(t.streaming.state)}${t.streaming.bitrate ? ' · ' + (t.streaming.bitrate / 1e6).toFixed(1) + ' Mb/s' : ''}` : '–', t.streaming?.state === 'streaming' ? 'live' : '')}${kvCell('ISO record', rec ? `${rec.active ? '<span class="tag rec">REC</span> ' + esc(rec.duration || '') : 'idle'}${rec.remaining ? ' · ' + esc(rec.remaining) + ' left' : ''}` : '–', rec?.active ? 'rec' : '')}${kvCell('sessions held', held === null ? '–' : String(held))}</div>
		${t.streaming?.cache !== null && t.streaming?.cache !== undefined ? gaugeHtml('cache', t.streaming.cache, 100, t.streaming.cache + ' %', t.streaming.cache > 50 ? 'warn' : '') : ''}
		<div class="eqg"><label><span>intake · 10 min${st?.state === 'arriving' ? ' · <b class="cyan">stream arriving</b>' : ''}</span><i><span class="dn">↓${fmtRate(e.down)}</span> <span class="up">↑${fmtRate(e.up)}</span></i></label>${scope('eq:' + e.ip, [{ data: e.history?.down || [], color: st?.state === 'arriving' ? 'stream' : 'in' }, { data: e.history?.up || [], color: 'out' }], 'espark', { bare: true })}</div>`
	} else if (k === 'hyperdeck') {
		const d = t.activeDisk
		const used = d && d.size ? (d.size - d.free) / d.size : 0
		body = `<div class="eqkv">${kvCell('transport', `${t.recording ? '<span class="tag rec">REC</span> ' : ''}${esc(t.mode)}`, t.recording ? 'rec' : '')}${kvCell('timecode', esc(t.timecode || '–'), 'tc')}</div>
		<div class="eqkv">${kvCell('format', esc(t.format || '–'))}${kvCell('codec', esc(t.codec || '–'))}${kvCell('disk', d ? esc(d.name) + (d.volume ? ' · ' + esc(d.volume) : '') : 'none')}</div>
		${d ? gaugeHtml('disk used', used, 1, d.remainingS !== null && d.remainingS !== undefined ? fmtMinutes(Math.round(d.remainingS / 60)) + ' left' : fmtBytes(d.free) + ' free', used > 0.9 ? 'warn' : '') : ''}
		${sparkRow('eq:' + e.ip, e, 'network · 10 min')}`
	} else if (k === 'webpresenter') {
		const set = (t.bitrate || 0) / 1e6
		body = `<div class="eqkv">${kvCell('stream', `${t.streaming ? '<span class="tag stream">live</span> ' : ''}${esc(t.status)}`, t.streaming ? 'live' : '')}${kvCell('format', esc(t.format || '–'))}${kvCell('input', esc(t.inputFormat || '–'))}</div>
		${gaugeHtml('bitrate', t.streaming ? e.up : 0, set || 1, t.streaming ? fmtRate(e.up) + ' of ' + set.toFixed(1) : set ? set.toFixed(1) + ' Mb/s set' : '–', t.streaming && set && e.up < set * 0.7 ? 'warn' : '')}
		${t.cache !== null && t.cache !== undefined ? gaugeHtml('cache', Number(t.cache), 100, t.cache + ' %', Number(t.cache) > 50 ? 'warn' : '') : ''}
		${sparkRow('eq:' + e.ip, e, 'uplink · 10 min')}`
	} else if (k === 'videohub') {
		body = `<div class="eqkv">${kvCell('router', esc(t.model || 'Videohub'))}${kvCell('size', `${t.inputs} in × ${t.outputs} out`)}${kvCell('routes', `${(t.routing || []).length}${t.locks ? ' · ' + t.locks + ' locked' : ''}`)}</div>
		<div class="routes">${(t.routing || []).slice(0, 4).map((r) => `<div><span>${esc(r.outName)}</span><i>←</i><span>${esc(r.inName)}</span></div>`).join('')}${(t.routing || []).length > 4 ? `<small>+${t.routing.length - 4} more in the inspector</small>` : ''}</div>
		${gaugeHtml('outputs fed', (t.routing || []).length, t.outputs || 1, `${(t.routing || []).length}/${t.outputs}`)}`
	} else if (k === 'host') {
		body = `<div class="eqkv">${kvCell('host', esc(t.hostname))}${kvCell('up', fmtUptime(t.uptime))}${t.gpu ? kvCell('gpu', esc(String(t.gpu.name).replace('NVIDIA GeForce ', ''))) : ''}</div>
		${gaugeHtml('cpu', t.cpu || 0, 100, (t.cpu ?? '–') + ' %', t.cpu > 85 ? 'error' : t.cpu > 70 ? 'warn' : '')}${gaugeHtml('ram', t.mem.pct, 100, fmtBytes(t.mem.used), t.mem.pct > 90 ? 'error' : '')}${t.gpu ? gaugeHtml('gpu', t.gpu.util, 100, `${t.gpu.util} % · ${t.gpu.temp}°`, t.gpu.util > 95 ? 'warn' : '') : ''}${(t.disks || []).slice(0, 3).map((d) => gaugeHtml(esc(d.name.split(' ')[0]), d.size - d.free, d.size, fmtBytes(d.free) + ' free', d.free / d.size < 0.1 ? 'warn' : '')).join('')}
		${sparkRow('eq:' + e.ip, e, 'network · 10 min')}`
	} else if (k === 'x32') {
		const a = e.audio
		const c = (s.audio?.consoles || []).find((x) => x.ip === e.ip)
		body = `<div class="eqkv">${kvCell('console', a.console ? `${esc(a.console.model)} · fw ${esc(a.console.firmware)}` : 'X32')}${kvCell('meters', a.ok ? `live · ${a.rate}/s` : esc(a.error || 'none'), a.ok ? 'live' : '')}${kvCell('with signal', a.ok ? `${a.active} channel${a.active === 1 ? '' : 's'}` : '–')}</div>
		${c?.ok ? `<div class="eqg"><label><span>main out · dBFS</span></label>${SCALE}${c.main.slice(0, 2).map((m, i) => meterRow(`x32:${e.ip}:main:${i}`, ['L', 'R'][i], m.name || 'Main', m, { hint: 'main ' + ['L', 'R'][i] })).join('')}</div>` : `<p class="warn" style="margin:0;font-size:11.5px">${esc(a.error || 'no meters')}</p>`}
		${sparkRow('eq:' + e.ip, e, 'network · 10 min')}`
	} else if (k === 'ewdx') {
		const a = e.audio
		body = a.ok
			? `<table class="compact"><tbody>${a.channels
					.map((ch) => {
						const key = `mic:${e.ip}:${ch.id}`
						const batt = ch.battery
						return `<tr data-mic="${esc(key)}" class="${ch.link ? '' : 'off'}"><td><b>${esc(ch.name || ch.id.toUpperCase())}</b><small>${ch.frequency ? ch.frequency.toFixed(3) + ' MHz' : ''}${ch.link ? '' : ' · off'}</small></td><td><span class="hbar"><i class="${batt === null ? '' : batt < 10 ? 'hot' : batt < 20 ? 'warm' : ''}" style="width:${batt ?? 0}%"></i></span><em data-f="battTxt">${batt !== null && batt !== undefined ? batt + ' %' : '–'}</em><small>battery</small></td><td><span class="hbar"><i class="${ch.rsqi !== null && ch.rsqi < 30 ? 'warm' : ''}" data-f="rf" style="width:${ch.rsqi ?? 0}%"></i></span><em data-f="rfTxt">${ch.rsqi !== null && ch.rsqi !== undefined ? ch.rsqi + ' %' : '–'}</em><small>RF</small></td><td><span class="hbar af"><i class="${dbClass(ch.af)}" data-f="af" style="width:${dbPct(ch.af).toFixed(1)}%"></i></span><em data-f="afTxt">${fmtDb(ch.af)}</em><small>audio</small></td></tr>`
					})
					.join('')}</tbody></table>`
			: `<p class="warn" style="margin:0;font-size:11.5px">${esc(a.error || 'not answering')}</p>${sparkRow('eq:' + e.ip, e, 'network · 10 min')}`
	} else if (e.role === 'playback' || e.role === 'encoder') {
		body = `<div class="eqkv">${kvCell('status', e.online ? (e.reachable === false ? '<span class="warn">on the network, not answering</span>' : 'on the network') : '<span class="error">not on the network</span>')}${kvCell('vendor', esc(e.oui || '–'))}${kvCell('web', e.online ? `<a href="http://${esc(e.ip)}/" target="_blank" rel="noopener">open ↗</a>` : '–')}</div>
		${gaugeHtml('out', e.up, Math.max(1, e.up * 1.5, (e.history?.up || []).reduce((m, v) => Math.max(m, v), 0)), fmtRate(e.up))}
		${sparkRow('eq:' + e.ip, e, 'traffic · 10 min')}`
	} else {
		body = `<div class="eqkv">${kvCell('status', e.online ? (e.reachable === false ? '<span class="warn">not answering</span>' : 'on the network') : '<span class="error">not on the network</span>')}${kvCell('vendor', esc(e.oui || '–'))}${kvCell('network', esc(e.network || '–'))}${e.uptime ? kvCell('up', fmtUptime(e.uptime)) : ''}</div>
		${sparkRow('eq:' + e.ip, e, 'traffic · 10 min')}`
	}
	return `<div class="${cls}" data-sel="equipment:${esc(e.ip)}">${head}${body}${foot}</div>`
}
function pduCard(p) {
	const draw = p.acPower || p.powerW || 0
	return `<div class="eqc ${p.online ? 'online' : 'offline'}" data-sel="pdu:${esc(p.mac)}"><div class="eqh"><span class="tally ${p.online ? 'online' : 'offline'}"></span><div class="eqn"><b>${esc(p.name)}</b><small>${esc(p.modelName || 'PDU')} · ${esc(p.ip || '')}</small></div><span class="eqlink">${p.uplink?.device ? `${esc(p.uplink.device)} · p${p.uplink.port}` : ''}</span></div>
	<div class="eqkv">${kvCell('draw', p.online ? `${Math.round(draw)} W` : '–', 'big')}${kvCell('budget', p.acBudget ? Math.round(p.acBudget) + ' W' : '–')}${kvCell('outlets on', `${p.outletsOn}/${p.outlets}`)}${p.voltage ? kvCell('mains', p.voltage + ' V') : ''}</div>
	${gaugeHtml('load', draw, p.acBudget || 1, p.acBudget ? Math.round((draw / p.acBudget) * 100) + ' %' : '–', p.acBudget && draw / p.acBudget > 0.8 ? 'warn' : '')}
	<div class="outlets">${(p.outletList || []).map((o) => `<span title="${esc(o.name)}${o.power ? ' · ' + o.power + ' W' : ''}"><span class="tally ${o.on ? 'online' : ''}"></span>${esc(o.name.replace(/^(USB )?Outlet /i, '$1'))}${o.power ? ` <b>${o.power} W</b>` : ''}</span>`).join('')}</div>
	<div class="eqf"><span>${p.online ? 'online' : 'offline'}</span><span>${p.age !== null && p.age !== undefined ? `counters ${p.age} s old` : ''}</span></div></div>`
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
	$('patchNote').textContent = `${ok} of ${active.length} in this broadcast online · ${standby.length} on standby · click a card for details`
	const html = []
	for (const [g, list] of groups) html.push(`<div class="pb-group"><h4>${esc(g)} <small>${list.filter((e) => e.status === 'online').length}/${list.length} online</small></h4><div class="eqgrid">${list.map((e) => eqCard(e, s)).join('')}</div></div>`)
	const pdus = (s.others || []).filter((o) => o.kind === 'pdu')
	if (pdus.length) html.push(`<div class="pb-group"><h4>Power <small>${pdus.filter((p) => p.online).length}/${pdus.length} PDUs online · ${Math.round(pdus.reduce((n, p) => n + (p.acPower || p.powerW || 0), 0))} W drawn</small></h4><div class="eqgrid">${pdus.map(pduCard).join('')}</div></div>`)
	if (standby.length) html.push(`<details class="standby"><summary>On standby, not part of this broadcast <small>· ${standby.length} device${standby.length === 1 ? '' : 's'} · no alerts, no probes · enable them in Edit roster</small></summary>${standby.map(pbRow).join('')}</details>`)
	$('patch').innerHTML = html.join('') || '<div class="empty">no equipment in the roster — click Edit roster</div>'
	indexMeters()
}

// ------------------------------------------------------------------ the health cards' graphics: one labelled gauge, meter or graph each
function tileGraphic(t, s) {
	const glabel = (txt, right = '') => `<div class="glabel"><span>${txt}</span>${right ? `<i>${right}</i>` : ''}</div>`
	const spark = (key, series, color = 'in') => scope('tile:' + key, [{ data: series || [], color }], 'tspark', { bare: true })
	const eq = (s.equipment || []).filter((e) => e.active)
	if (t.id === 'switcher') {
		const hero = s.atem?.equipment
		const tl = hero?.telemetry
		const st = s.atem?.stream
		const held = (s.forensics?.sessions || []).filter((x) => x.state === 'held').length
		return `${glabel('intake · 10 min', hero ? `↓${fmtRate(hero.down)}` : '')}${spark('switcher', hero?.history?.down, st?.state === 'arriving' ? 'stream' : 'in')}<div class="tmini"><span><label>stream out</label><b>${tl?.streaming ? esc(tl.streaming.state) + (tl.streaming.bitrate ? ' ' + (tl.streaming.bitrate / 1e6).toFixed(1) + ' Mb/s' : '') : '–'}</b></span><span><label>ISO record</label><b>${tl?.recording ? (tl.recording.active ? 'REC ' + esc(tl.recording.duration || '') : 'idle') + (tl.recording.remaining ? ' · ' + esc(tl.recording.remaining) + ' left' : '') : '–'}</b></span><span><label>sessions</label><b>${s.forensics ? held : '–'}</b></span></div>`
	}
	if (t.id === 'encoders') {
		const enc = eq.find((e) => e.telemetry?.kind === 'webpresenter' && !e.telemetry.error)
		const set = enc ? (enc.telemetry.bitrate || 0) / 1e6 : 0
		return enc ? `${gaugeHtml('bitrate', enc.telemetry.streaming ? enc.up : 0, set || 1, enc.telemetry.streaming ? fmtRate(enc.up) : set ? set.toFixed(1) + ' set' : '–', enc.telemetry.streaming && set && enc.up < set * 0.7 ? 'warn' : '')}${enc.telemetry.cache !== null && enc.telemetry.cache !== undefined ? gaugeHtml('cache', Number(enc.telemetry.cache), 100, enc.telemetry.cache + ' %', Number(enc.telemetry.cache) > 50 ? 'warn' : '') : ''}${glabel(esc(enc.name) + ' uplink · 10 min')}${spark('encoders', enc.history?.up, 'out')}` : `${glabel('no Web Presenter with telemetry')}<div class="nosp"></div>`
	}
	if (t.id === 'recorders') {
		const decks = eq.filter((e) => e.telemetry?.kind === 'hyperdeck' && !e.telemetry.error)
		const tl = s.atem?.equipment?.telemetry
		const rows = decks.map((e) => {
			const h = e.telemetry
			const d = h.activeDisk
			const used = d && d.size ? (d.size - d.free) / d.size : 0
			return `<div class="trow"><span class="n">${h.recording ? '<span class="tag rec">REC</span> ' : ''}${esc(e.name)}<small>${esc([h.format, h.codec].filter(Boolean).join(' · ') || h.mode)}</small></span><span class="bar"><i class="${used > 0.9 ? 'warn' : ''}" style="width:${(used * 100).toFixed(0)}%"></i></span><span class="v">${h.remainingS !== null && h.remainingS !== undefined ? fmtMinutes(Math.round(h.remainingS / 60)) : d ? fmtBytes(d.free) : '–'}</span></div>`
		})
		if (tl?.recording) rows.push(`<div class="trow"><span class="n">${tl.recording.active ? '<span class="tag rec">REC</span> ' : ''}${esc(s.atem.name.replace(/^ATEM Television Studio\s*/i, 'ATEM '))}<small>ISO record${tl.recording.disk ? ' · ' + esc(tl.recording.disk) : ''}</small></span><span class="bar"><i style="width:${tl.recording.active ? 100 : 0}%"></i></span><span class="v">${esc(tl.recording.remaining || (tl.recording.active ? tl.recording.duration : 'idle'))}</span></div>`)
		return `${glabel('format · disk used · time left')}${rows.join('') || '<div class="nosp"></div>'}`
	}
	if (t.id === 'audio') {
		const c = (s.audio?.consoles || []).find((x) => x.ok)
		return `${glabel('channels 1–32 · main L/R', c ? (c.mainLevel !== null && c.mainLevel > -60 ? 'main ' + c.mainLevel.toFixed(1) + ' dBFS' : 'main quiet') : '')}${stripHtml(s, 'x32')}`
	}
	if (t.id === 'mics') {
		const ch = (s.audio?.mics || []).filter((m) => m.ok).flatMap((m) => m.channels)
		const low = ch.filter((c) => c.link && c.battery !== null).sort((a, b) => a.battery - b.battery)[0]
		return `${glabel('battery per channel', low ? `lowest ${esc(low.name || low.id)} ${low.battery} %` : '')}${stripHtml(s, 'mics')}`
	}
	if (t.id === 'dante') {
		const clocks = s.discovery?.clocks || []
		const d = clocks.find((c) => /mobile/i.test(c.network || '')) || clocks[0]
		const nets = (s.networks || []).filter((n) => /dante/i.test(n.name))
		const series = nets.length ? nets[0].history?.down : []
		return `<div class="tmini"><span><label>clock</label><b class="${d ? (d.status === 'ok' ? 'ok' : 'warn') : ''}">${d ? (d.status === 'ok' ? 'locked' : esc(d.status)) : 'not heard'}</b></span><span><label>leader</label><b>${d?.leaders[0] ? esc(d.leaders[0].name || d.leaders[0].ip) : '–'}</b></span><span><label>followers</label><b>${d ? d.followers.length + (d.leaders[0] ? ' · ' + d.leaders[0].syncPerS + ' sync/s' : '') : '–'}</b></span></div>${glabel((nets[0] ? esc(vlanLabel(nets[0].name)) : 'Dante VLAN') + ' · 10 min', nets[0] ? `↓${fmtRate(nets[0].down)}` : '')}${spark('dante', series)}`
	}
	if (t.id === 'ndi') {
		const nets = (s.networks || []).filter((n) => /ndi/i.test(n.name))
		const src = s.discovery?.ndi || []
		return `<div class="tmini"><span><label>sources on air</label><b>${src.length}</b></span><span><label>on the VLAN</label><b>${nets[0] ? nets[0].clients + ' devices' : '–'}</b></span><span><label>busiest</label><b>${esc(src[0]?.name || '–')}</b></span></div>${glabel((nets[0] ? esc(vlanLabel(nets[0].name)) : 'NDI VLAN') + ' · 10 min', nets[0] ? `↓${fmtRate(nets[0].down)} ↑${fmtRate(nets[0].up)}` : '')}${spark('ndi', nets[0]?.history?.down)}`
	}
	if (t.id === 'network') {
		const gw = s.gateway
		const sw = s.switches || []
		const errs = sw.filter((x) => x.online).reduce((n, x) => n + x.ports.filter((p) => p.errorsRecent).length, 0)
		return `<div class="tmini"><span><label>latency</label><b>${gw ? (gw.wan.latency ?? '–') + ' ms' : '–'}</b></span><span><label>switches</label><b>${sw.filter((x) => x.online).length}/${sw.length}</b></span><span><label>port errors</label><b class="${errs ? 'warn' : ''}">${errs}</b></span></div>${glabel('WAN · 10 min', gw ? `↓${fmtRate(gw.wan.down)} ↑${fmtRate(gw.wan.up)}` : '')}${spark('network', gw?.wan?.history?.down)}`
	}
	if (t.id === 'power') {
		const pdus = (s.others || []).filter((o) => o.kind === 'pdu' && o.online)
		const draw = pdus.reduce((n, p) => n + (p.acPower || p.powerW || 0), 0)
		const budget = pdus.reduce((n, p) => n + (p.acBudget || 0), 0)
		return `${gaugeHtml('draw', draw, budget || 1, budget ? Math.round((draw / budget) * 100) + ' %' : '–', budget && draw / budget > 0.8 ? 'warn' : '')}${glabel('per PDU')}${pdus
			.slice(0, 4)
			.map((p) => `<div class="trow"><span class="n">${esc(p.name)}</span><span class="bar"><i style="width:${p.acBudget ? Math.min(100, ((p.acPower || p.powerW || 0) / p.acBudget) * 100) : 0}%"></i></span><span class="v">${Math.round(p.acPower || p.powerW || 0)} W</span></div>`)
			.join('')}`
	}
	if (t.id === 'pc') {
		const h = eq.find((e) => e.telemetry?.kind === 'host' && !e.telemetry.error)?.telemetry
		return h ? `${gaugeHtml('cpu', h.cpu || 0, 100, (h.cpu ?? '–') + ' %', h.cpu > 85 ? 'error' : h.cpu > 70 ? 'warn' : '')}${gaugeHtml('ram', h.mem.pct, 100, h.mem.pct + ' %', h.mem.pct > 90 ? 'error' : '')}${h.gpu ? gaugeHtml('gpu', h.gpu.util, 100, h.gpu.util + ' %', h.gpu.util > 95 ? 'warn' : '') : ''}${(h.disks || []).slice(0, 1).map((d) => gaugeHtml(esc(d.name.split(' ')[0]), d.size - d.free, d.size, fmtBytes(d.free) + ' free', d.free / d.size < 0.1 ? 'warn' : '')).join('')}` : `${glabel('no host telemetry')}<div class="nosp"></div>`
	}
	return t.series && t.series.length > 1 ? `${glabel('10 min')}${spark(t.id, t.series)}` : '<div class="nosp"></div>'
}

// ------------------------------------------------------------------ roster editor
const ROLES = ['switcher', 'router', 'recorder', 'encoder', 'playback', 'computer', 'audio', 'unknown']
let rosterSwitches = [] // names/macs of the switches whose wired clients are in the roster
let rosterSwitchList = [] // every switch UniFi knows, for the tick list
let rosterAuto = [] // devices that come from those switches right now
async function openRoster() {
	try {
		const r = await fetch('/api/equipment')
		const j = await r.json()
		roster = (j.equipment || []).map((e) => ({ ...e }))
		rosterSwitches = j.roster_switches || []
		rosterSwitchList = (j.switches || []).slice().sort((a, b) => Number(b.online) - Number(a.online) || b.clients - a.clients || a.name.localeCompare(b.name))
		rosterAuto = j.auto || []
	} catch (e) {
		roster = []
	}
	$('rosterOverlay').hidden = false
	renderRoster()
}
function rosterSwitchesHtml() {
	const on = (s) => rosterSwitches.some((x) => String(x).toLowerCase() === s.name.toLowerCase() || String(x).toLowerCase() === s.mac)
	return `<h3 class="rh">Whole switches <small>every wired device on a ticked switch is in the broadcast, listed under the switch's name, with no row of its own to keep</small></h3>
		<div class="roster-sw">${rosterSwitchList.map((s) => `<label><input type="checkbox" data-sw="${esc(s.name)}" ${on(s) ? 'checked' : ''}><span>${esc(s.name)}</span><small>${esc(s.model)} · ${s.clients} wired${s.online ? '' : ' · offline'}</small></label>`).join('') || '<small>no switches seen yet</small>'}</div>
		${rosterAuto.length ? `<div class="roster-auto">${rosterAuto.length} device${rosterAuto.length === 1 ? '' : 's'} come from those switches right now: ${rosterAuto.slice(0, 14).map((a) => esc(a.name)).join(', ')}${rosterAuto.length > 14 ? '…' : ''}. To give one a probe, telemetry or a role, open it in the inspector and choose "Give it a roster row".</div>` : ''}`
}
function renderRoster(msg = '') {
	const groups = [...new Set([...(roster || []).map((e) => e.group), 'Studio A', 'Field', 'Town Hall', 'Video rack', 'Audio rack', 'Master control'])]
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
			${rosterSwitchesHtml()}
			<h3 class="rh">Devices <small>one row each; the probe says how reachability is checked, the telemetry what is read from the device. Any port or device in the inspector has an "add to the roster" button too.</small></h3>
			<div class="help">Probe: <b>tcp:&lt;port&gt;</b> (HyperDeck 9993, Videohub 9990, Web Presenter 9977, a web UI 80), <b>atem</b> (ATEM protocol), <b>x32</b> (OSC). Telemetry reads the device itself: Web Presenter stream status, HyperDeck transport, ATEM program/stream. Min speed in Mb/s raises a warning when the link is slower (video gear defaults to 1000).</div>
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
	const sws = [...$('rosterEditor').querySelectorAll('[data-sw]')].filter((c) => c.checked).map((c) => c.getAttribute('data-sw'))
	const btn = $('rosterSave')
	btn.disabled = true
	btn.textContent = 'Saving…'
	try {
		const r = await fetch('/api/equipment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ equipment: list, roster_switches: sws }) })
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
	if (LOCAL_TYPES.has(selection.type)) {
		// the health tiles' panels are drawn from the live state; nothing to fetch
		details = { type: selection.type, local: true }
		return renderInspector()
	}
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
	if (d.local) {
		$('inspKind').textContent = 'live · ' + PANEL_KIND[d.type]
		$('inspTitle').textContent = PANEL_TITLE[d.type](state)
		body.innerHTML = state ? localPanel(d.type, state) : '<div class="empty">waiting for the first poll</div>'
		indexMeters()
		drawScopes()
		return
	}
	const a = d.alert
	const ent = d.entity
	const je = d.type === 'journal' ? d.entry : null // a row of the log: the entry first, then whatever it is about
	const type = a ? a.entity?.type || a.scope : je ? je.entity?.type || 'journal' : d.type
	$('inspKind').textContent = a ? `${a.level} · ${a.scope}` : je ? `log · ${je.cat}` : type
	$('inspTitle').textContent = a ? a.text : je ? je.text.replace(/^(PROBLEM|Warning|Note): /, '') : ent?.name || (type === 'port' ? `${ent?.switch?.name} port ${ent?.idx}` : type === 'atem' ? ent?.name : type === 'wan' ? 'WAN' : selection.id)
	const parts = []
	if (je) parts.push(journalSection(je, d.alertOpen))
	if (a) {
		parts.push(`<h3>What this means</h3><p class="explain">${esc(a.explain || '')}</p><div class="ai-meta">since ${fmtDateTime(a.since)} (${fmtAgo(a.since)})</div>`)
		const diag = diagnoses.get(a.id)
		const pv = aiStatus?.providers || {}
		parts.push(`<h3>AI diagnosis</h3>${diag ? diag.error ? `<p class="error">${esc(diag.error)}</p>` : `<div class="ai-text">${mdLite(diag.text)}</div><div class="ai-meta">${esc(diag.model)}${diag.provider ? ' · ' + (diag.provider === 'anthropic' ? 'Claude' : 'local model') : ''} · ${Math.round(diag.ms / 1000)} s · ${fmtAgo(diag.t)} ago</div>` : '<p>Have the AI read the live data, the related events and the flows, and explain this item: what it means, the likely causes, what to check now. Claude answers from the cloud; a local model runs on this computer and needs a one-time setup.</p>'}<div class="insp-actions"><button class="btn diagnose" data-diagnose="${esc(a.id)}" data-provider="anthropic" title="${esc(pv.anthropic ? 'Claude · ' + (pv.anthropicModel || '') : 'no Anthropic key yet: opens Settings')}">✦ ${diag?.provider === 'anthropic' ? 'Again with Claude' : 'Diagnose with Claude'}</button><button class="btn diagnose local" data-diagnose="${esc(a.id)}" data-provider="openai" title="${esc(pv.local ? 'local server · ' + (pv.localUrl || '') : 'no local AI yet: opens the setup guide')}">✦ ${diag?.provider === 'openai' ? 'Again with local AI' : 'Diagnose with local AI'}</button></div>`)
	}
	if (ent && type !== 'journal') parts.push(entitySection(type, ent))
	if (type === 'equipment' && ent && ent.active && (ent.telemetry?.kind === 'atem' || ent.role === 'switcher')) parts.push(sessionSection(ent))
	if (type === 'equipment' && ent?.audio) parts.push(audioSection(ent))
	if (type === 'equipment' && ent) parts.push(ent.auto ? `<div class="insp-actions"><button class="btn" data-add-roster="${esc(ent.ip)}" data-add-name="${esc(ent.name)}" data-add-group="${esc(ent.group)}" data-add-role="${esc(ent.role)}">Give it a roster row</button><small>in the broadcast through its switch (${esc(ent.group)}); a row of its own lets you set a probe, telemetry and a role</small></div>` : `<div class="insp-actions">${ent.active ? `<button class="btn quiet" data-standby="${esc(ent.ip)}">Put on standby (not part of this broadcast)</button>` : `<button class="btn" data-activate="${esc(ent.ip)}">Add to this broadcast</button>`}<button class="btn quiet" id="editRosterInsp">Edit roster</button></div>`)
	if (['equipment', 'switch', 'ap', 'gateway', 'pdu'].includes(type) && ent) parts.push(mapLabelForm(type === 'equipment' ? 'eq:' + ent.ip : ent.mac))
	if (type === 'equipment' && ent?.history) parts.push(`<h3>Traffic · last ${Math.round((ent.history.down.length * 5) / 60)} min</h3>${scope('insp', [{ data: ent.history.down, color: 'in' }, { data: ent.history.up, color: 'out' }], 'spark')}`)
	if (type === 'switch' && ent?.history) parts.push(`<h3>Traffic · all ports</h3>${scope('insp', [{ data: ent.history.down, color: 'in' }, { data: ent.history.up, color: 'out' }], 'spark')}`)
	if (type === 'wan' && ent?.history) parts.push(`<h3>WAN traffic</h3>${scope('insp', [{ data: ent.history.down, color: 'in' }, { data: ent.history.up, color: 'out' }], 'spark')}`)
	parts.push(`<h3>Broadwatch events</h3>${tapeRows(d.events || [], (ev) => `<div class="tl ${esc(ev.level || 'info')}"><span class="t">${fmtTime(ev.t)}</span><span class="m">${esc(ev.text)}</span></div>`)}`)
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
		])}${equipmentExtra(e)}`
	}
	if (type === 'port') {
		const er = e.err || {}
		const tot = e.errTotals || {}
		const mins = Math.max(1, Math.round((er.window_s || 600) / 60))
		const errTab = `<h3>Errors and drops</h3><table class="errtab"><thead><tr><th>Counter</th><th class="num">last ${mins} min</th><th class="num">since boot</th><th>what it points at</th></tr></thead><tbody>${[
			['Damaged frames in', er.rxErr, tot.rxErr, 'cable, connector, SFP, duplex, the far end'],
			['Transmit errors', er.txErr, tot.txErr, 'rare: collisions or the switch itself'],
			['Received, then refused', er.rxDrop, tot.rxDrop, 'VLAN not carried, storm control, ingress buffer'],
			['Dropped on the way out', er.txDrop, tot.txDrop, 'congestion behind this port'],
			['Link went down', er.flaps, tot.flaps, 'loose cable, SFP, a reboot, PoE budget'],
		]
			.map(([k, a, b, why]) => `<tr class="${a > 0 ? 'hot' : ''}"><td>${k}</td><td class="num">${a ?? '–'}</td><td class="num">${b ?? '–'}</td><td><small>${why}</small></td></tr>`)
			.join('')}</tbody></table>`
		const dd = e.errDetail
		const kinds = dd ? [['CRC', dd.fcs ?? dd.crcAlign], ['alignment', dd.align], ['symbol', dd.symbol], ['fragments', dd.fragments], ['jabbers', dd.jabbers], ['oversize', dd.oversize], ['undersize', dd.undersize], ['collisions', dd.collisions], ['late collisions', dd.lateColl]].filter(([, v]) => v !== null && v !== undefined) : []
		const detail = dd ? `<p><small>The switch's own error tables over SNMP${kinds.length ? ' (since boot): ' + kinds.map(([k, v]) => `${k} ${v}`).join(' · ') : ': this switch keeps no per-kind error counters'}</small></p>` : ''
		const sfp = e.sfp ? `<p><small>Optics: ${esc([e.sfp.compliance, e.sfp.vendor, e.sfp.part].filter(Boolean).join(' · '))} · rx ${e.sfp.rxPower ?? '?'} dBm · tx ${e.sfp.txPower ?? '?'} dBm · ${e.sfp.temp ?? '?'} °C${e.sfp.rxFault || e.sfp.txFault ? ' · <span class="error">fault flagged</span>' : ' · no fault'}${e.sfp.rxPower !== null && e.sfp.rxPower !== undefined && e.sfp.rxPower < -14 ? ' · <span class="warn">receive power is low</span>' : ''}</small></p>` : ''
		const linkLine = `<p><small>${e.fullDuplex ? 'full duplex' : '<span class="warn">HALF duplex</span>'} · auto-negotiation ${e.autoneg === false ? '<span class="warn">off</span>' : 'on'} · flow control ${e.flowctrl ? 'on' : 'off'}${e.storm ? ` · broadcast and multicast in: about ${e.storm} packets/s` : ''}</small></p>`
		const rosterIps = new Set((state?.equipment || []).filter((x) => !x.auto && !x.discovered).map((x) => x.ip))
		const cands = [...(e.clients || []).map((c) => ({ ip: c.ip, name: c.name || c.ip })), ...(e.label?.ip && !(e.clients || []).some((c) => c.ip === e.label.ip) ? [{ ip: e.label.ip, name: e.label.name || e.label.ip }] : [])].filter((c) => c.ip && !rosterIps.has(c.ip))
		const addBtns = cands.length ? `<h3>Add to the broadcast roster</h3><p>One click puts the device on this port into the roster, under "${esc(e.switch?.name || 'Studio A')}"; the roster editor can then give it a probe and a role.</p><div class="insp-actions">${cands.map((c) => `<button class="btn" data-add-roster="${esc(c.ip)}" data-add-name="${esc(c.name)}" data-add-group="${esc(e.switch?.name || 'Studio A')}">+ ${esc(c.name)}</button>`).join('')}</div>` : ''
		return `<h3>${esc(e.switch?.name)} · port ${e.idx}</h3>${kv([
			['Name', esc(e.name)],
			['Link', e.up ? `${speedTxt(e.speed)} ${e.fullDuplex ? 'full duplex' : 'HALF duplex'} ${esc(e.media || '')}` : e.enabled ? 'down' : 'disabled', e.up ? 'ok' : 'bad'],
			['To device', fmtRate(e.tx)],
			['From device', fmtRate(e.rx)],
			['Utilisation', Math.round(e.util * 100) + '%'],
			e.poe ? ['PoE', `${e.poeW} W ${esc(e.poeMode || '')}`] : null,
			e.lag ? ['LAG', esc(e.lag)] : null,
			['Errors + drops', `${e.errors}${e.errorsRecent ? ` <span class="error">new in the last ${mins} min${er.cause ? ' · ' + { errors: 'damaged frames', drops: 'congestion', rxdrops: 'refused frames', flaps: 'link flapping' }[er.cause] : ''}</span>` : ' · none new'}`],
			['Counters', `${e.live ? 'live (SNMP) · ' : ''}${e.age} s old`],
			['Attached', [...(e.devices || []).map((d) => `${esc(d.name)} (${esc(d.type)})`), ...(e.clients || []).map((c) => `${esc(c.name || c.ip || c.mac)}${c.ip && c.name ? ' · ' + esc(c.ip) : ''}`)].join('<br>') + (e.clientCount > (e.clients || []).length ? `<br>+${e.clientCount - e.clients.length} more` : '')],
			e.label ? ['Label', esc([e.label.name, e.label.ip, e.label.note].filter(Boolean).join(' · '))] : null,
		])}${linkLine}${errTab}${detail}${sfp}${addBtns}<h3>Label this port</h3><p>Write what is really plugged in when UniFi cannot tell (SDI gear behind a small switch, a static device, a patch-panel position). Empty fields remove the label.</p><div class="lblform" data-label-form="${esc(e.key)}"><input class="lbl-name" value="${esc(e.label?.name || '')}" placeholder="device name"><input class="lbl-ip" value="${esc(e.label?.ip || '')}" placeholder="IP address"><input class="lbl-note" value="${esc(e.label?.note || '')}" placeholder="note"></div><div class="insp-actions"><button class="btn" data-label-save-insp="${esc(e.key)}">Save label</button></div>`
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
		])}${fxAiSection(e.peer || null)}<h3>What the mirror saw</h3>${tapeRows((e.events || []).slice(0, 40), (ev) => `<div class="tl ${ev.level === 'warn' ? 'warn' : 'info'}"><span class="t">${fmtTime(ev.t)}</span><span class="m">${esc(ev.text)}</span></div>`)}`
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

// the switcher's control connection: how it is read (Companion / own session / auto / none), what Broadwatch
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
		<div class="row"><span>Read the switcher</span><select id="atemMode" data-ip="${esc(e.ip)}">${[['companion', 'through Companion (no slot)'], ['auto', 'Companion, own session only if Companion is away'], ['own', 'with Broadwatch’s own session (one slot, Fairlight levels)'], ['none', 'not at all']].map(([v, l]) => `<option value="${v}" ${mode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
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

// the diagnosis with the provider the user picked; a provider that is not set up opens Settings (Claude) or the
// local AI guide, and the diagnosis runs by itself once that is done
async function diagnose(id, provider) {
	const pv = aiStatus?.providers || {}
	if (provider === 'anthropic' && !pv.anthropic) return Settings.open('ai', { onSaved: () => refreshAiStatus() })
	if (provider === 'openai' && !pv.local) return LocalAI.open({ onDone: () => setTimeout(() => refreshAiStatus() || diagnose(id, 'openai'), 300) })
	const btn = document.querySelector(`[data-diagnose="${CSS.escape(id)}"][data-provider="${provider}"]`)
	if (btn) {
		btn.disabled = true
		btn.textContent = 'Thinking…'
	}
	try {
		const r = await fetch(`/api/ai/diagnose?id=${encodeURIComponent(id)}&refresh=1&provider=${encodeURIComponent(provider)}`)
		const j = await r.json()
		diagnoses.set(id, j && !j.error && j.text ? j : { error: j?.error || 'no answer from the model' })
	} catch (e) {
		diagnoses.set(id, { error: e.message })
	}
	renderInspector()
}
// a hand-written name for a node of the signal map, saved in the config (map_labels)
function mapLabelForm(nodeId) {
	const n = state?.topology?.nodes.find((x) => x.id === nodeId)
	return `<h3>Name on the signal map</h3><p>A name of your own shown on the map instead of the UniFi name; it stays after a restart. Empty removes it. Double-clicking a node on the map opens this field.</p><div class="lblform one"><input class="map-label" id="mapLabelInput" data-node-id="${esc(nodeId)}" value="${esc(n?.label || '')}" placeholder="${esc(n?.name || 'name on the map')}"><button class="btn" data-maplabel-save="${esc(nodeId)}">Save</button></div>`
}
async function saveMapLabel(nodeId) {
	const inp = document.querySelector(`input.map-label[data-node-id="${CSS.escape(nodeId)}"]`)
	try {
		const r = await fetch('/api/maplabel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: nodeId, label: inp?.value || '' }) })
		const j = await r.json()
		if (j.error) throw new Error(j.error)
	} catch (e) {
		alert('could not save the name: ' + e.message)
	}
	setTimeout(refreshInspector, 400)
}
async function addToRoster(el) {
	const body = { ip: el.getAttribute('data-add-ip') || el.getAttribute('data-add-roster'), name: el.getAttribute('data-add-name') || '', group: el.getAttribute('data-add-group') || 'Studio A', role: el.getAttribute('data-add-role') || 'unknown' }
	el.disabled = true
	el.textContent = 'Adding…'
	try {
		const r = await fetch('/api/roster/add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
		const j = await r.json()
		if (j.error) throw new Error(j.error)
	} catch (e) {
		alert('could not add the device: ' + e.message)
	}
	setTimeout(refreshInspector, 500)
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
	if (aiStatus && !aiStatus.enabled) parts.push(`<p>No AI is set up yet. Claude needs an Anthropic key (Settings &gt; AI); a local model runs on this computer for free after a short setup.</p><div class="insp-actions"><button class="btn" id="aiSettings">Set up Claude</button><button class="btn" id="localAiGuide">Set up a local AI</button></div>`)
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
	if (!folded('unifiBlock')) renderTape(s)
	if (!folded('logBlock') && !logView.loaded) loadLog()
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
		scheduleLog(1500)
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
	const askEl = t.closest?.('[data-ask]')
	if (askEl) {
		// a question prepared by a log row or an alert: back to the readiness view and ask it there
		const q = askEl.getAttribute('data-ask')
		closeInspector()
		if ($('askInput')) $('askInput').value = q
		return ask(q)
	}
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
	if (t.closest?.('[data-diagnose]')) {
		const el = t.closest('[data-diagnose]')
		return diagnose(el.getAttribute('data-diagnose'), el.getAttribute('data-provider') || aiStatus?.provider || 'anthropic')
	}
	if (t.closest?.('[data-add-roster]')) return addToRoster(t.closest('[data-add-roster]'))
	if (t.closest?.('[data-maplabel-save]')) return saveMapLabel(t.closest('[data-maplabel-save]').getAttribute('data-maplabel-save'))
	const zoomBtn = t.closest?.('[data-zoom]')
	if (zoomBtn) {
		const z = zoomBtn.getAttribute('data-zoom')
		return z === 'in' ? NetMap.zoom(1.25) : z === 'out' ? NetMap.zoom(1 / 1.25) : NetMap.fit()
	}
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
	if (t.id === 'forToggle' || t.id === 'forRaw') return forensicsAction(t.getAttribute('data-for-action'))
	const fxAi = t.closest?.('[data-for-ai]')
	if (fxAi) {
		const peer = fxAi.getAttribute('data-for-peer') || null
		const question = fxAi.hasAttribute('data-for-ask') ? $('forAsk')?.value || '' : ''
		return explainForensics(fxAi.getAttribute('data-for-ai'), { peer, question })
	}
	const goto = t.closest?.('[data-goto]')
	if (goto) return $(goto.getAttribute('data-goto'))?.scrollIntoView({ block: 'start', behavior: 'smooth' })
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
	if (t.id === 'localAiGuide') return LocalAI.open({ onDone: refreshAiStatus })
	const prov = t.closest?.('[data-ai-provider]')
	if (prov) return switchAiProvider(prov.getAttribute('data-ai-provider'))
})
// the one-click local/cloud switch: only between providers that are set up; otherwise open Settings
async function switchAiProvider(provider) {
	const pv = aiStatus?.providers || {}
	if (provider === 'openai' && !pv.local) return LocalAI.open({ onDone: refreshAiStatus })
	if (provider === 'anthropic' && !pv.anthropic) return Settings.open('ai', { onSaved: refreshAiStatus })
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
		if (e.key === 'Enter' && e.target.id === 'mapLabelInput') saveMapLabel(e.target.getAttribute('data-node-id'))
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
// double-click a node on the map: open it in the inspector with the map-name field ready to type into
document.addEventListener('dblclick', (e) => {
	const node = e.target.closest?.('[data-node]')
	if (!node) return
	const id = node.getAttribute('data-node')
	if (id === 'internet') return
	const n = state?.topology.nodes.find((x) => x.id === id)
	const type = id.startsWith('eq:') ? 'equipment' : n?.kind === 'ap' ? 'ap' : n?.kind === 'pdu' ? 'pdu' : n?.kind === 'gateway' ? 'gateway' : 'switch'
	setRail(true)
	select(type, id.startsWith('eq:') ? id.slice(3) : id).then(() => {
		const i = $('mapLabelInput')
		if (i) {
			i.focus()
			i.select()
		}
	})
})
$('portFind').addEventListener('input', (e) => {
	rackFilter = e.target.value.trim().toLowerCase()
	if (state) {
		renderRack(state)
		renderMap(state)
	}
})
// the forensics toolbar: window, kind, text and state filters refetch the whole session when they narrow it
$('forFind').addEventListener('input', (e) => {
	forView.q = e.target.value.trim()
	forFiltering() ? scheduleForensics(300) : state && renderForensics(state)
})
document.addEventListener('change', (e) => {
	if (e.target.id === 'forWindow') forView.window = e.target.value
	else if (e.target.id === 'forKind') forView.kind = e.target.value
	else if (e.target.id === 'forState') forView.state = e.target.value
	else return
	forFiltering() ? scheduleForensics(0) : state && renderForensics(state)
})
document.addEventListener('keydown', (e) => {
	if (e.key === 'Enter' && e.target.id === 'forAsk') explainForensics(forView.ai?.provider || aiStatus?.provider || 'anthropic', { question: e.target.value })
})
setInterval(() => {
	if (forFiltering() && !$('forBlock').classList.contains('folded')) scheduleForensics(0)
}, 15000)
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
// ------------------------------------------------------------------ the log: the journal with filters, a table and export
const logView = { levels: new Set(['error', 'warn']), range: 86400000, cat: '', q: '', open: false, entries: [], facets: null, summary: null, timer: null, loading: false, again: false, loaded: false }
const LOG_WORD = { error: 'errors', warn: 'warnings', info: 'notes', clear: 'cleared' }
const LOG_MARK = { error: 'error', warn: 'warning', info: 'note', clear: 'cleared' }
const plainText = (t) => String(t || '').replace(/^(PROBLEM|Warning|Note): /, '')
function fmtDur(ms) {
	if (ms === null || ms === undefined) return ''
	const m = Math.round(ms / 60000)
	if (m < 1) return '< 1 min'
	if (m < 60) return `${m} min`
	const h = Math.floor(m / 60)
	if (h < 24) return `${h} h ${String(m % 60).padStart(2, '0')} min`
	return `${Math.floor(h / 24)} d ${h % 24} h`
}
function dayLabel(d) {
	const today = new Date()
	const yesterday = new Date(today)
	yesterday.setDate(today.getDate() - 1)
	return d.toDateString() === today.toDateString() ? 'Today' : d.toDateString() === yesterday.toDateString() ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}
function logParams(limit) {
	const p = new URLSearchParams()
	p.set('since', String(Date.now() - logView.range))
	const lv = [...logView.levels].filter((l) => l !== 'clear')
	p.set('levels', lv.length ? lv.join(',') : 'none')
	if (logView.levels.has('clear')) p.set('clears', '1')
	if (logView.cat) p.set('cat', logView.cat)
	if (logView.q) p.set('q', logView.q)
	if (logView.open) p.set('open', '1')
	if (limit) p.set('limit', String(limit))
	return p
}
async function loadLog() {
	const block = $('logBlock')
	if (!block || block.classList.contains('folded')) return
	if (logView.loading) {
		logView.again = true
		return
	}
	logView.loading = true
	try {
		const r = await fetch('/api/journal?' + logParams(600))
		const j = await r.json()
		logView.entries = j.entries || []
		logView.facets = j.facets || null
		logView.summary = j.summary || null
		logView.loaded = true
		renderLog()
	} catch (e) {
		$('logNote').textContent = 'log unavailable: ' + e.message
	} finally {
		logView.loading = false
		if (logView.again) {
			logView.again = false
			scheduleLog(500)
		}
	}
}
function scheduleLog(ms = 800) {
	clearTimeout(logView.timer)
	logView.timer = setTimeout(loadLog, ms)
}
function renderLog() {
	const body = $('logBody')
	if (!body) return
	const f = logView.facets
	// the category list follows what the window holds; the level buttons carry their counts
	const sel = $('logCat')
	const cats = f ? Object.entries(f.cats).sort((a, b) => b[1] - a[1]) : []
	sel.innerHTML = '<option value="">every category</option>' + cats.map(([c, n]) => `<option value="${esc(c)}" ${c === logView.cat ? 'selected' : ''}>${esc(c)} · ${n}</option>`).join('')
	if (logView.cat && !cats.some(([c]) => c === logView.cat)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(logView.cat)}" selected>${esc(logView.cat)} · 0</option>`)
	for (const b of $('logLevels').querySelectorAll('button')) {
		const l = b.getAttribute('data-level')
		const n = l === 'clear' ? f?.clears : f?.levels?.[l]
		b.textContent = `${LOG_WORD[l]}${n ? ' · ' + n : ''}`
		b.classList.toggle('on', logView.levels.has(l))
	}
	const es = logView.entries
	$('logEmpty').hidden = es.length > 0
	const s = logView.summary
	$('logNote').textContent = `${es.length} row${es.length === 1 ? '' : 's'}${s ? ` · last 24 h: ${s.levels.error} errors, ${s.levels.warn} warnings · ${s.open} open now` : ''}${f?.oldest ? ` · kept since ${fmtDateTime(f.oldest)}` : ''}`
	let day = ''
	const rows = []
	for (const e of es) {
		const d = new Date(e.t)
		if (d.toDateString() !== day) {
			day = d.toDateString()
			rows.push(`<tr class="day"><td colspan="5">${esc(dayLabel(d))}</td></tr>`)
		}
		const lasted = e.kind === 'alert' ? (e.cleared ? fmtDur(e.cleared - e.t) : '<span class="open">still open</span>') : e.kind === 'clear' && e.duration !== null && e.duration !== undefined ? fmtDur(e.duration) : ''
		const mark = e.kind === 'clear' ? 'clear' : e.level
		rows.push(`<tr class="click lv-${esc(e.level)} k-${esc(e.kind)}${e.cleared ? ' done' : ''}" data-sel="journal:${esc(e.id)}"><td class="when">${fmtTime(e.t)}</td><td class="lv"><i class="mark ${esc(mark)}" title="${esc(LOG_MARK[mark] || mark)}"></i></td><td class="cat">${esc(e.cat)}</td><td>${esc(plainText(e.text))}${e.device ? `<small>${esc(e.device)}</small>` : ''}</td><td class="num dur">${lasted}</td></tr>`)
	}
	body.innerHTML = rows.join('')
	$('logCsv').href = '/api/journal/export?' + logParams(20000)
}
function logCopy() {
	const lines = logView.entries.map((e) => `${fmtDateTime(e.t)}\t${e.kind === 'clear' ? 'cleared' : e.level}\t${e.cat}\t${plainText(e.text)}${e.cleared ? `\t(lasted ${fmtDur(e.cleared - e.t)})` : ''}`)
	navigator.clipboard?.writeText(lines.join('\n')).then(() => ($('logNote').textContent = `${lines.length} rows copied`)).catch(() => {})
}
function saveLogPrefs() {
	try {
		localStorage.setItem('bw-log', JSON.stringify({ levels: [...logView.levels], range: logView.range }))
	} catch {}
}
// a row of the log in the inspector: when, how long, the explanation, and a question ready for the AI
function journalSection(e, open) {
	const when = `${fmtDateTime(e.t)}${e.cleared ? ` → ${fmtDateTime(e.cleared)} · lasted ${fmtDur(e.cleared - e.t)}` : e.kind === 'alert' ? (open ? ' · still open' : '') : e.kind === 'clear' && e.duration ? ` · after ${fmtDur(e.duration)}` : ''}`
	const q = `At ${fmtDateTime(e.t)} the log recorded: "${plainText(e.text)}". What does it mean for the broadcast, and what should I check?`
	return `<div class="kv"><span>When</span><b>${esc(when)}</b><span>Level</span><b class="${esc(e.level)}">${esc(e.kind === 'clear' ? 'cleared' : e.level)}</b><span>Category</span><b>${esc(e.cat)}</b>${e.device ? `<span>Device</span><b>${esc(e.device)}</b>` : ''}${e.alertId ? `<span>Alert</span><b class="mono">${esc(e.alertId)}</b>` : ''}</div>${e.explain ? `<h3>What this means</h3><p class="explain">${esc(e.explain)}</p>` : ''}<div class="insp-actions">${open && e.alertId ? `<button class="btn" data-alert="${esc(e.alertId)}">Open the live alert</button>` : ''}<button class="btn quiet" data-ask="${esc(q)}" ${!aiStatus?.enabled ? 'disabled title="AI not configured"' : ''}>Ask the AI about this</button></div>`
}
function initLog() {
	if (!$('logBar')) return
	try {
		const saved = JSON.parse(localStorage.getItem('bw-log') || 'null')
		if (saved) {
			logView.levels = new Set(saved.levels || ['error', 'warn'])
			logView.range = saved.range || logView.range
		}
	} catch {}
	$('logRange').value = String(logView.range)
	$('logLevels').addEventListener('click', (e) => {
		const b = e.target.closest('button')
		if (!b) return
		const l = b.getAttribute('data-level')
		if (logView.levels.has(l)) logView.levels.delete(l)
		else logView.levels.add(l)
		saveLogPrefs()
		scheduleLog(0)
	})
	$('logRange').addEventListener('change', (e) => {
		logView.range = Number(e.target.value)
		saveLogPrefs()
		scheduleLog(0)
	})
	$('logCat').addEventListener('change', (e) => {
		logView.cat = e.target.value
		scheduleLog(0)
	})
	$('logFind').addEventListener('input', (e) => {
		logView.q = e.target.value.trim()
		scheduleLog(250)
	})
	$('logOpen').addEventListener('change', (e) => {
		logView.open = e.target.checked
		scheduleLog(0)
	})
	$('logCopy').addEventListener('click', logCopy)
	setInterval(() => scheduleLog(0), 60000) // the window slides and "still open" ages
	loadLog()
}

// ------------------------------------------------------------------ the top bar's modules
const HUD_DEFAULT = ['intake', 'wan', 'console', 'vlans']
const HUD_TITLES = { intake: 'Traffic arriving at the switcher (its switch port, live via SNMP)', wan: 'Internet link on the gateway', console: 'The gateway itself', encoder: 'The Web Presenter: stream status, bitrate and cache', switcher: 'The switcher as Companion sees it', record: "The switcher's ISO record", deck: 'The first HyperDeck in the roster', pc: "This computer's load", mics: 'Wireless mics on air and the lowest battery', x32: 'The main console', ndi: 'NDI sources announced on the network', dante: 'The Dante clock', power: 'Power drawn through the PDUs' }
function vlanCells(s) {
	return (s.networks || [])
		.filter((n) => n.watched)
		.slice(0, 4)
		.map((n) => `<div class="vl" title="${esc(n.name)}${n.vlan ? ' · VLAN ' + n.vlan : ''}${n.subnet ? ' · ' + esc(n.subnet) : ''} · ${n.clients} clients · orange = into the VLAN, teal = out of it, last 10 minutes"><label>${esc(vlanLabel(n.name))}${n.vlan ? `<i>vlan ${n.vlan}</i>` : ''}</label><div class="nums"><span class="dn">↓${fmtRate(n.down)}</span><span class="up">↑${fmtRate(n.up)}</span></div>${scope('vl:' + n.name, [{ data: (n.history?.down || []).slice(-60), color: 'in' }, { data: (n.history?.up || []).slice(-60), color: 'out' }], 'vspark', { bare: true })}<small>${n.clients} client${n.clients === 1 ? '' : 's'}</small></div>`)
		.join('')
}
function hudCell(id, s) {
	const gw = s.gateway
	const at = s.atem
	const eq = at?.equipment
	const st = at?.stream
	const cell = (label, big, small, extra = '') => `<div class="cell m-${esc(id)}" title="${esc(HUD_TITLES[id] || '')}"><label>${label}</label>${extra}<b>${big}</b><small>${small}</small></div>`
	const bar = (v, max, cls = '') => `<div class="bar"><i class="${cls}" style="width:${Math.min(100, ((Number(v) || 0) / Math.max(1e-9, max)) * 100).toFixed(0)}%"></i></div>`
	switch (id) {
		case 'intake': {
			const intake = eq ? eq.down : 0
			const full = Math.max(20, (st?.peak || 0) * 1.2, intake * 1.2)
			return `<div class="cell intake m-intake" title="${esc(HUD_TITLES.intake)}"><label>ATEM intake</label><div class="meter"><i class="${st?.state === 'arriving' ? 'stream' : ''}" style="width:${Math.min(100, (intake / full) * 100)}%"></i><em style="left:${Math.min(100, ((st?.baseline || 0) / full) * 100)}%"></em></div><b class="${st?.state === 'arriving' ? 'cyan' : ''}">${eq ? fmtRate(intake) : 'ATEM not seen'}</b><small>${st?.state === 'arriving' ? `stream ${fmtRate(st.rate)} · ${st.sources[0] ? esc(st.sources[0].name) : 'source unknown'} · ${fmtAgo(st.since)}` : eq?.switch ? `quiet · ${esc(eq.switch.name)} port ${eq.switch.port} · ${speedTxt(eq.switch.speed)}` : 'no stream'}</small></div>`
		}
		case 'wan':
			return cell('WAN', gw ? `<span class="dn">${fmtRate(gw.wan.down)}</span> <span class="up">${fmtRate(gw.wan.up)}</span>` : '–', gw ? `<span class="${gw.wan.status !== 'ok' ? 'error' : ''}">${esc(gw.wan.status)} · ${gw.wan.latency ?? '–'} ms · ${speedTxt(gw.wan.speed)}</span>` : 'gateway?')
		case 'console':
			return cell('Console', gw ? `${pct(gw.cpu)} · ${gw.temp ?? '–'}°` : '–', gw ? `${esc(gw.modelName)} · ${s.clients.total} clients · up ${fmtUptime(gw.uptime)}` : '–')
		case 'vlans':
			return `<div class="cell vlans" id="hudVlans">${vlanCells(s)}</div>`
		case 'encoder': {
			const e = (s.equipment || []).find((x) => x.active && x.telemetry?.kind === 'webpresenter' && !x.telemetry.error)
			const t = e?.telemetry
			return cell('Stream out', t ? `${t.streaming ? '<span class="tag stream">live</span>' : ''}${esc(t.status)}` : '–', t ? `${esc(e.name)}${t.bitrate ? ' · ' + (t.bitrate / 1e6).toFixed(1) + ' Mb/s' : ''}${t.cache !== null && t.cache !== undefined ? ' · cache ' + t.cache : ''}${t.format ? ' · ' + esc(t.format) : ''}` : 'no Web Presenter answering', t?.streaming ? bar(e.up, Math.max(1, (t.bitrate || 0) / 1e6), 'up') : '')
		}
		case 'switcher': {
			const t = eq?.telemetry
			const name = (at?.name || 'Switcher').replace(/^ATEM Television Studio\s*/i, 'ATEM ').replace(/\s*ISO$/i, '')
			return cell(esc(name), t && !t.error ? (t.programName ? `PGM ${esc(t.programName)}` : esc(t.product || 'up')) : eq ? esc(eq.status) : '–', t && !t.error ? `${t.previewName ? 'PVW ' + esc(t.previewName) + ' · ' : ''}stream ${esc(t.streaming?.state || '?')}${t.streaming?.bitrate ? ' ' + (t.streaming.bitrate / 1e6).toFixed(1) + ' Mb/s' : ''}${t.streaming?.cache ? ' · cache ' + t.streaming.cache + ' %' : ''}` : t?.error ? esc(t.error) : 'no switcher telemetry')
		}
		case 'record': {
			const r = eq?.telemetry?.recording
			return cell('ISO record', r ? (r.active ? `<span class="tag rec">REC</span>${esc(r.duration || '')}` : 'idle') : '–', r ? `${r.remaining ? esc(r.remaining) + ' left' : ''}${r.disk ? ' · ' + esc(r.disk) : ''}${r.filename ? ' · ' + esc(r.filename) : ''}` || 'ready' : 'no record state from the switcher')
		}
		case 'deck': {
			const d = (s.equipment || []).find((x) => x.active && x.telemetry?.kind === 'hyperdeck' && !x.telemetry.error)
			const t = d?.telemetry
			return cell(d ? esc(d.name) : 'HyperDeck', t ? `${t.recording ? '<span class="tag rec">REC</span>' : ''}${esc(t.recording ? t.timecode || 'recording' : t.mode)}` : '–', t ? `${t.remainingS !== null && t.remainingS !== undefined ? fmtMinutes(Math.round(t.remainingS / 60)) + ' left' : ''}${t.activeDisk ? ' on ' + esc(t.activeDisk.name) : ''}${t.format ? ' · ' + esc(t.format) : ''}` : 'no HyperDeck answering')
		}
		case 'pc': {
			const h = (s.equipment || []).find((x) => x.telemetry?.kind === 'host' && !x.telemetry.error)
			const t = h?.telemetry
			return cell('This PC', t ? `${t.cpu ?? '–'}% <small>cpu</small> ${t.mem?.pct ?? '–'}% <small>ram</small>${t.gpu ? ` ${t.gpu.util}% <small>gpu</small>` : ''}` : '–', t ? `${esc(t.hostname)}${t.gpu ? ' · ' + esc(String(t.gpu.name).replace('NVIDIA GeForce ', '')) + ' ' + t.gpu.temp + '°' : ''}` : 'this computer is not in the roster')
		}
		case 'mics': {
			const ch = (s.audio?.mics || []).filter((m) => m.ok).flatMap((m) => m.channels)
			const on = ch.filter((c) => c.link)
			const low = on.filter((c) => c.battery !== null && c.battery !== undefined).sort((a, b) => a.battery - b.battery)[0]
			return cell('Mics', ch.length ? `${on.length}/${ch.length} <small>on air</small>` : '–', ch.length ? (low ? `lowest battery ${esc(low.name || low.id)} ${low.battery} %${low.rsqi !== null && low.rsqi !== undefined ? ' · RF ' + low.rsqi + ' %' : ''}` : 'no transmitter on') : 'no receivers answering')
		}
		case 'x32': {
			const c = (s.audio?.consoles || []).find((x) => x.ok) || (s.audio?.consoles || [])[0]
			return cell(c ? esc(c.console?.name || c.name) : 'Console', c?.ok ? (c.mainLevel !== null && c.mainLevel > -60 ? c.mainLevel.toFixed(1) + ' <small>dBFS main</small>' : 'quiet') : c ? esc(c.error || 'no meters') : '–', c?.ok ? `${c.active} channel${c.active === 1 ? '' : 's'} with signal · ${c.rate}/s` : 'no X32 in the roster')
		}
		case 'ndi': {
			const src = s.discovery?.ndi || []
			const ndiNet = (s.networks || []).filter((n) => /ndi/i.test(n.name))
			return cell('NDI', `${src.length} <small>source${src.length === 1 ? '' : 's'}</small>`, src.length ? src.slice(0, 3).map((x) => esc(x.name)).join(' · ') + (src.length > 3 ? ' +' + (src.length - 3) : '') : ndiNet.length ? `${ndiNet[0].clients} on ${esc(vlanLabel(ndiNet[0].name))}` : 'none announced')
		}
		case 'dante': {
			const clocks = s.discovery?.clocks || []
			const d = clocks.find((c) => /mobile/i.test(c.network || '')) || clocks[0]
			return cell('Dante clock', d ? (d.status === 'ok' ? '<span class="ok">locked</span>' : `<span class="warn">${esc(d.status)}</span>`) : '–', d ? `${d.leaders[0] ? 'leader ' + esc(d.leaders[0].name || d.leaders[0].ip) + ' · ' + d.leaders[0].syncPerS + ' sync/s' : 'no leader'} · ${d.followers.length} follower${d.followers.length === 1 ? '' : 's'}${clocks.length > 1 ? ' · ' + clocks.length + ' domains' : ''}` : 'no PTP seen on this computer')
		}
		case 'power': {
			const pdus = (s.others || []).filter((o) => o.kind === 'pdu' && o.online)
			const w = pdus.reduce((n, p) => n + (p.acPower || p.powerW || 0), 0)
			return cell('Power', pdus.length ? `${Math.round(w)} <small>W</small>` : '–', pdus.length ? `${pdus.length} PDU${pdus.length === 1 ? '' : 's'} · ${pdus.reduce((n, p) => n + (p.outletsOn || 0), 0)}/${pdus.reduce((n, p) => n + (p.outlets || 0), 0)} outlets on` : 'no PDU seen')
		}
		default:
			return ''
	}
}

// ------------------------------------------------------------------ the health tiles' side panels (drawn from the live state)
const LOCAL_TYPES = new Set(['switcher', 'encoders', 'recorders', 'audio', 'mics', 'dante', 'ndi', 'network'])
const PANEL_KIND = { switcher: 'switcher', encoders: 'streams out', recorders: 'recorders', audio: 'audio', mics: 'wireless mics', dante: 'Dante', ndi: 'NDI', network: 'network' }
const PANEL_TITLE = {
	switcher: (s) => s?.atem?.name || 'Switcher',
	encoders: () => 'Streams out',
	recorders: () => 'Recorders',
	audio: () => 'Audio',
	mics: () => 'Wireless mics',
	dante: () => 'Dante',
	ndi: () => 'NDI',
	network: () => 'Network at a glance',
}
const kvRows = (rows) => `<div class="kv">${rows.filter((r) => r && r[1] !== undefined && r[1] !== null && r[1] !== '').map(([k, v, cls]) => `<span>${esc(k)}</span><b class="${cls || ''}">${v}</b>`).join('')}</div>`
const hbar = (v, max = 100, cls = '') => `<span class="hbar"><i class="${cls}" style="width:${Math.min(100, ((Number(v) || 0) / Math.max(1e-9, max)) * 100).toFixed(0)}%"></i></span>`
const dev = (e, text, cls = '') => `<div data-sel="equipment:${esc(e.ip)}"><span class="tally ${e.active === false ? 'standby' : e.status || (e.online ? 'online' : 'offline')}"></span><div><b>${esc(e.name)}</b>${text ? `<small>${text}</small>` : ''}</div><span class="${cls}"></span></div>`
function localPanel(type, s) {
	if (type === 'switcher') return panelSwitcher(s)
	if (type === 'encoders') return panelEncoders(s)
	if (type === 'recorders') return panelRecorders(s)
	if (type === 'audio') return panelAudio(s)
	if (type === 'mics') return panelMics(s)
	if (type === 'dante') return panelDante(s)
	if (type === 'ndi') return panelNdi(s)
	if (type === 'network') return panelNetwork(s)
	return ''
}
function panelSwitcher(s) {
	const at = s.atem
	if (!at) return '<div class="empty">no switcher configured (Settings › Switcher)</div>'
	const eq = at.equipment
	const t = eq?.telemetry
	const st = at.stream || {}
	const ses = at.session
	const held = (s.forensics?.sessions || []).filter((x) => x.state === 'held')
	const sw = s.audio?.switcher
	const own = ses?.own
	const parts = []
	parts.push(`<div class="verdict"><span class="lamp ${eq?.status === 'online' ? (st.state === 'arriving' || t?.streaming?.state === 'streaming' ? 'ready' : 'ready') : eq ? 'down' : ''}"></span><div><b>${esc(eq ? nice(eq.status) : 'not seen')}</b><small>${eq?.switch ? `${esc(eq.switch.name)} port ${eq.switch.port} · ${speedTxt(eq.switch.speed)} · ` : ''}${esc(at.ip)}${t?.product ? ' · ' + esc(t.product) : ''}${t?.version ? ' v' + esc(t.version) : ''}</small></div></div>`)
	parts.push(`<h3>On air</h3>${kvRows([
		['Program', t?.programName ? `<span class="error">${esc(t.programName)}</span>` : t?.error ? `<span class="warn">${esc(t.error)}</span>` : 'unknown'],
		['Preview', esc(t?.previewName || '')],
		['Stream out', t?.streaming ? `${t.streaming.state === 'streaming' ? '<span class="tag stream">live</span> ' : ''}${esc(t.streaming.state)}${t.streaming.bitrate ? ' · ' + (t.streaming.bitrate / 1e6).toFixed(1) + ' Mb/s' : ''}${t.streaming.cache !== null && t.streaming.cache !== undefined ? ' · cache ' + t.streaming.cache + ' %' : ''}${t.streaming.duration && t.streaming.duration !== '00:00:00' ? ' · ' + esc(t.streaming.duration) : ''}${t.streaming.service ? ' · ' + esc(t.streaming.service) : ''}` : ''],
		['ISO record', t?.recording ? `${t.recording.active ? '<span class="tag rec">REC</span> ' + esc(t.recording.duration || '') : 'idle'}${t.recording.remaining ? ' · ' + esc(t.recording.remaining) + ' left' : ''}${t.recording.disk ? ' · ' + esc(t.recording.disk) : ''}${t.recording.filename ? ' · ' + esc(t.recording.filename) : ''}` : ''],
	])}`)
	parts.push(`<h3>Stream in</h3>${kvRows([
		['Intake', `${eq ? fmtRate(eq.down) : '–'} · ${esc(st.state || 'idle')}${st.state === 'arriving' ? ` · ${fmtRate(st.rate)} above the usual ${fmtRate(st.baseline || 0)} since ${fmtTime(st.since)}` : st.baseline ? ` · usual level ${fmtRate(st.baseline)}` : ''}`],
		['Sources', (st.sources || []).map((x) => `<span class="tag ${esc(x.confidence)}">${esc(x.confidence)}</span> ${esc(x.name)} ${esc(x.detail || '')}`).join('<br>') || (st.state === 'arriving' ? 'not identified yet' : 'none')],
		['Flows in', (at.incoming || []).slice(0, 5).map((x) => `${esc(x.srcName || x.src)} → ${esc(x.proto)} ${x.dport} · ${fmtBytes(x.bytes)}${x.live ? ' · <span class="ok">live</span>' : ''}`).join('<br>')],
		['Paths', (s.streamPaths || []).map((p) => `<span class="pl ${esc(p.status)}"></span> ${esc(p.name)} · ${esc(p.verdict)}`).join('<br>')],
	])}${scope('insp', [{ data: eq?.history?.down || [], color: st.state === 'arriving' ? 'stream' : 'in' }, { data: eq?.history?.up || [], color: 'out' }], 'spark', { baseline: st.baseline })}`)
	parts.push(`<h3>Control connections</h3>${kvRows([
		['Read through', ses ? (ses.mode === 'companion' ? 'Companion (no slot taken)' : ses.mode === 'own' ? "Broadwatch's own session (one slot)" : esc(ses.mode)) : ''],
		['Companion', ses?.companion ? (ses.companion.ok ? (ses.companion.connected ? '<span class="ok">connected to the switcher</span>' : '<span class="warn">not connected to the switcher</span>') : `<span class="warn">${esc(ses.companion.error || 'not reachable')}</span>`) : ''],
		['Own session', own ? (own.state === 'connected' ? `<span class="ok">held since ${fmtTime(own.connectedAt)}</span>` : `${esc(own.state)}${own.error ? ' · ' + esc(own.error) : ''}`) : 'none'],
		['Held now', held.length ? held.map((x) => `${esc(x.name || x.ip)}:${x.port} · since ${fmtTime(x.since)}`).join('<br>') : s.forensics ? 'none seen on the mirror' : 'unknown without the mirror capture'],
		['Known holders', (ses?.controllers || []).map((c) => `${esc(c.name)}: ${c.held === null ? 'unknown' : c.held ? '<span class="warn">holds a slot</span>' : 'not connected'}`).join('<br>')],
	])}`)
	if (sw) parts.push(`<h3>Fairlight</h3>${sw.levels ? `${SCALE}${sw.levels.master ? meterRow('atem:master', 'Σ', 'Master', { level: sw.levels.master.level, peak: sw.levels.master.peak }, { hint: 'mix bus' }) : ''}${sw.levels.sources.slice(0, 12).map((x) => meterRow(`atem:${x.id}`, x.id < 1000 ? x.id : '', x.label, { level: x.level, peak: x.peak }, { muted: x.mix !== null && x.mix !== undefined && x.mix <= -99 && x.level > -60, hint: x.label })).join('')}${sw.levels.sources.length > 12 ? `<p class="ai-meta">${sw.levels.sources.length - 12} more inputs in the Audio section</p>` : ''}` : `<p>${esc(sw.note || 'no levels')}</p>`}`)
	parts.push(`<div class="insp-actions">${eq ? `<button class="btn" data-sel="equipment:${esc(eq.ip)}">Device details</button>` : ''}<button class="btn quiet" data-goto="atemBlock">Streams section</button><button class="btn quiet" data-goto="forBlock">Forensics</button></div>`)
	return parts.join('')
}
function panelEncoders(s) {
	const eq = (s.equipment || []).filter((e) => e.active)
	const wps = eq.filter((e) => e.telemetry?.kind === 'webpresenter')
	const others = eq.filter((e) => e.role === 'encoder' && e.telemetry?.kind !== 'webpresenter')
	const t = s.atem?.equipment?.telemetry
	const rows = []
	for (const e of wps) {
		const w = e.telemetry
		rows.push(dev(e, w.error ? `<span class="warn">${esc(w.error)}</span>` : `${w.streaming ? '<span class="tag stream">live</span> ' : ''}${esc(w.status)}${w.bitrate ? ' · ' + (w.bitrate / 1e6).toFixed(1) + ' Mb/s set' : ''}${w.streaming ? ' · ' + fmtRate(e.up) + ' out' : ''}${w.cache !== null && w.cache !== undefined ? ' · cache ' + w.cache : ''}${w.format ? ' · ' + esc(w.format) : ''}`))
	}
	if (t?.streaming) rows.push(`<div data-sel="switcher:now"><span class="tally ${t.streaming.state === 'streaming' ? 'live' : 'online'}"></span><div><b>${esc(s.atem.name)}</b><small>stream ${esc(t.streaming.state)}${t.streaming.bitrate ? ' · ' + (t.streaming.bitrate / 1e6).toFixed(1) + ' Mb/s' : ''}${t.streaming.cache ? ' · cache ' + t.streaming.cache + ' %' : ''}</small></div><span></span></div>`)
	for (const e of others) rows.push(dev(e, `${esc(e.role)} · ${e.online ? 'on the network' : 'not on the network'}${e.probe ? (e.probe.ok ? ' · answers in ' + e.probe.ms.toFixed(0) + ' ms' : ' · <span class="warn">no answer</span>') : ''} · out ${fmtRate(e.up)}`))
	const paths = (s.streamPaths || []).map((p) => `<div data-sel="path:${esc(p.id)}"><span class="pl ${esc(p.status)}"></span><div><b>${esc(p.name)}</b><small>${esc(p.verdict)}</small></div><span></span></div>`)
	return `<h3>Encoders</h3><div class="rowlist">${rows.join('') || '<div class="empty">no encoder in the roster</div>'}</div>${paths.length ? `<h3>Stream paths in</h3><div class="rowlist">${paths.join('')}</div>` : ''}<p>${esc(s.health?.factors?.find((f) => f.id === 'stream_out')?.reason || '')}</p>`
}
function panelRecorders(s) {
	const decks = (s.equipment || []).filter((e) => e.active && e.telemetry?.kind === 'hyperdeck')
	const t = s.atem?.equipment?.telemetry
	const parts = []
	for (const e of decks) {
		const h = e.telemetry
		parts.push(`<h3>${esc(e.name)} <small>${esc(h.product || '')}${h.version ? ' v' + esc(h.version) : ''}</small></h3>${h.error ? `<p class="warn">${esc(h.error)}</p>` : kvRows([
			['Transport', `${h.recording ? '<span class="tag rec">REC</span> ' : ''}${esc(h.mode)}${h.playback && h.playback.type && h.mode !== 'InputPreview' ? ' · ' + esc(h.playback.type) + (h.playback.speed ? ' ×' + h.playback.speed : '') + (h.playback.loop ? ' loop' : '') : ''}`, h.recording ? 'ok' : ''],
			['Timecode', esc(h.timecode || '')],
			['Format', esc([h.format, h.codec].filter(Boolean).join(' · '))],
			['Disk', h.activeDisk ? `${esc(h.activeDisk.name)}${h.activeDisk.volume ? ' (' + esc(h.activeDisk.volume) + ')' : ''} · ${h.remainingS !== null && h.remainingS !== undefined ? fmtMinutes(Math.round(h.remainingS / 60)) + ' of recording left' : ''}<br>${hbar(h.activeDisk.size - h.activeDisk.free, h.activeDisk.size, h.activeDisk.free / h.activeDisk.size < 0.1 ? 'hot' : '')} ${fmtBytes(h.activeDisk.free)} free of ${fmtBytes(h.activeDisk.size)}${h.activeDisk.clips !== null ? ' · ' + h.activeDisk.clips + ' clips' : ''}` : 'no disk'],
			h.disks?.length > 1 ? ['Slots', h.disks.map((d) => `${esc(d.name)}${d.active ? ' (active)' : ''}${d.free !== null ? ' · ' + fmtBytes(d.free) + ' free' : ''}`).join('<br>')] : null,
			['Network', `${e.switch ? `${esc(e.switch.name)} port ${e.switch.port} · ${speedTxt(e.switch.speed)} · ` : ''}in ${fmtRate(e.down)} · out ${fmtRate(e.up)}`],
		])}<div class="insp-actions"><button class="btn quiet" data-sel="equipment:${esc(e.ip)}">Device details</button></div>`)
	}
	if (t?.recording) parts.push(`<h3>${esc(s.atem.name)} · ISO record</h3>${kvRows([['State', t.recording.active ? `<span class="tag rec">REC</span> ${esc(t.recording.duration || '')}` : 'idle', t.recording.active ? 'ok' : ''], ['Remaining', esc(t.recording.remaining || '')], ['Disk', esc(t.recording.disk || '')], ['File', esc(t.recording.filename || '')]])}`)
	if (!parts.length) return '<div class="empty">no recorder with telemetry in the roster: give a HyperDeck the telemetry "hyperdeck" in Edit roster</div>'
	return parts.join('')
}
function panelAudio(s) {
	const au = s.audio
	if (!au) return '<div class="empty">waiting for the first poll</div>'
	const parts = []
	for (const c of au.consoles) {
		parts.push(`<h3><span class="tally ${c.ok ? 'online' : c.online === false ? 'offline' : 'unresponsive'}"></span> ${esc(c.console?.name || c.name)} <small>${c.console ? esc(c.console.model) + ' · ' : ''}${c.ok ? `${c.active} channel${c.active === 1 ? '' : 's'} with signal · ${c.rate}/s` : esc(c.error || 'no meters')}</small></h3>`)
		if (!c.ok) continue
		const rows = [...c.main.map((m, i) => meterRow(`x32:${c.ip}:main:${i}`, ['L', 'R', 'M'][i], m.name || 'Main', m, { hint: m.name })), '<div class="msep"></div>', ...c.channels.map((m) => meterRow(`x32:${c.ip}:ch:${m.n - 1}`, m.n, m.name, m, { muted: m.on === false, hint: `channel ${m.n}` }))]
		parts.push(`<div class="mcol">${SCALE}${rows.join('')}</div>`)
	}
	const sw = au.switcher
	if (sw) parts.push(`<h3>${esc(sw.name)} · Fairlight</h3>${sw.levels ? `<div class="mcol">${SCALE}${sw.levels.master ? meterRow('atem:master', 'Σ', 'Master', { level: sw.levels.master.level, peak: sw.levels.master.peak }, { hint: 'mix bus' }) : ''}<div class="msep"></div>${sw.levels.sources.map((x) => meterRow(`atem:${x.id}`, x.id < 1000 ? x.id : '', x.label, { level: x.level, peak: x.peak }, { muted: x.mix !== null && x.mix !== undefined && x.mix <= -99 && x.level > -60, hint: x.label })).join('')}</div>` : `<p>${esc(sw.note || 'no levels yet')}</p>`}`)
	if (au.others?.length) parts.push(`<h3>Other audio devices</h3><div class="rowlist">${au.others.map((o) => `<div data-sel="equipment:${esc(o.ip)}"><span class="tally ${o.online ? 'online' : 'offline'}"></span><div><b>${esc(o.name)}</b><small>${esc(o.note)}</small></div><span></span></div>`).join('')}</div>`)
	if (!parts.length) return '<div class="empty">no audio devices in the roster</div>'
	return parts.join('')
}
function panelMics(s) {
	const mics = s.audio?.mics || []
	if (!mics.length) return '<div class="empty">no wireless receivers in the roster (a Sennheiser EW-DX is recognised by its name or vendor, role "audio")</div>'
	return mics
		.map((m) => {
			if (!m.ok) return `<h3><span class="tally ${m.online === false ? 'offline' : 'unresponsive'}"></span> ${esc(m.name)}</h3><p class="warn">${esc(m.error || 'not answering')}${m.online === false ? ' · not on the network' : ''}</p>`
			return `<h3><span class="tally online"></span> ${esc(m.name)} <small>${esc(m.product || '')}</small></h3><table class="compact"><tbody>${m.channels
				.map((ch) => {
					const key = `mic:${m.ip}:${ch.id}`
					const batt = ch.battery
					return `<tr data-mic="${esc(key)}" class="${ch.link ? '' : 'off'}"><td><b>${esc(ch.name || ch.id.toUpperCase())}</b><small>${ch.frequency ? ch.frequency.toFixed(3) + ' MHz' : ''}${ch.link ? '' : ' · transmitter off'}${ch.mute || ch.tx?.mute ? ' · <span class="warn">muted</span>' : ''}${ch.warningText?.length ? ' · <span class="warn">' + esc(ch.warningText.join(', ')) + '</span>' : ''}</small></td><td>${hbar(batt ?? 0, 100, batt === null ? '' : batt < 10 ? 'hot' : batt < 20 ? 'warm' : '')}<em data-f="battTxt">${batt !== null && batt !== undefined ? batt + ' %' : '–'}</em><small>battery${ch.batteryMinutes ? ' · ' + fmtMinutes(ch.batteryMinutes) + ' left' : ''}</small></td><td><span class="hbar"><i class="${ch.rsqi !== null && ch.rsqi < 30 ? 'warm' : ''}" data-f="rf" style="width:${ch.rsqi ?? 0}%"></i></span><em data-f="rfTxt">${ch.rsqi !== null && ch.rsqi !== undefined ? ch.rsqi + ' %' : '–'}</em><small>RF <span data-f="rssi">${ch.rssi !== null && ch.rssi !== undefined ? ch.rssi + ' dBm' : ''}</span></small></td><td><span class="hbar af"><i class="${dbClass(ch.af)}" data-f="af" style="width:${dbPct(ch.af).toFixed(1)}%"></i></span><em data-f="afTxt">${fmtDb(ch.af)}</em><small>audio dBFS</small></td></tr>`
				})
				.join('')}</tbody></table>`
		})
		.join('')
}
function panelDante(s) {
	const disc = s.discovery || {}
	const clocks = disc.clocks || []
	const nets = (s.networks || []).filter((n) => /dante/i.test(n.name))
	const danteIp = (ip) => /^192\.168\.5\.|^10\.56\.19\./.test(ip || '')
	const devices = (s.equipment || []).filter((e) => /dante/i.test(e.network || '') || danteIp(e.ip) || (e.role === 'audio' && /dante|x32|prism|audinate/i.test(e.name + ' ' + (e.oui || ''))))
	const parts = []
	const netName = (d) => d.network || (s.networks || []).find((n) => n.subnet && n.subnet.split('.').slice(0, 3).join('.') === String(d.subnet).split('.').slice(0, 3).join('.'))?.name || null
	parts.push(`<h3>Clock domains <small>PTP v1, heard on this computer's interfaces</small></h3>${clocks.length ? clocks.map((d) => `<div class="kv"><span>Domain</span><b>${esc(netName(d) ? vlanLabel(netName(d)) : d.subnet)}${netName(d) ? ' <small>' + esc(d.subnet) + '</small>' : ''}</b><span>Status</span><b class="${d.status === 'ok' ? 'ok' : 'bad'}">${esc(d.status)}</b>${d.leaders.map((l) => `<span>Leader</span><b>${esc(l.name || l.ip)}${l.name ? ' · ' + esc(l.ip) : ''} · ${l.syncPerS} sync/s${l.uuid ? ' · clock ' + esc(l.uuid) : ''}${l.stratum !== null && l.stratum !== undefined ? ' · stratum ' + l.stratum : ''}</b>`).join('')}<span>Followers</span><b>${d.followers.length ? d.followers.map((f) => `${esc(f.name || f.ip)}${f.name ? ' <small>' + esc(f.ip) + '</small>' : ''}`).join('<br>') : 'none heard'}</b></div>`).join('') : `<p>No PTP traffic reaches this computer${disc.error ? ' (' + esc(disc.error) + ')' : ''}. A network interface on the Dante VLAN hears the clock without joining anything.</p>`}`)
	parts.push(`<h3>Dante devices</h3><div class="rowlist">${devices.map((e) => dev(e, `${esc(e.ip)}${e.network ? ' · ' + esc(vlanLabel(e.network)) : ''}${e.switch ? ' · ' + esc(e.switch.name) + ' p' + e.switch.port : ''} · in ${fmtRate(e.down)} out ${fmtRate(e.up)}`)).join('') || '<div class="empty">none in the roster</div>'}</div>${disc.dante?.length ? `<p>Announced on the network: ${disc.dante.map((d) => esc(d.name) + (d.ip ? ' (' + esc(d.ip) + ')' : '')).join(', ')}</p>` : ''}`)
	if (nets.length) parts.push(`<h3>Dante VLANs</h3>${kvRows(nets.map((n) => [vlanLabel(n.name), `${n.clients} clients · ↓ ${fmtRate(n.down)} ↑ ${fmtRate(n.up)} through the gateway`]))}`)
	parts.push(`<p>Dante routing and subscriptions are not announced on the network; Dante Controller or Dante Director show them. What Broadwatch sees is the clock (every device must follow one leader), who is on the VLANs, and the traffic.</p>`)
	return parts.join('')
}
function panelNdi(s) {
	const disc = s.discovery || {}
	const src = disc.ndi || []
	const nets = (s.networks || []).filter((n) => /ndi/i.test(n.name))
	const devices = (s.equipment || []).filter((e) => /ndi/i.test(e.network || '') || /^10\.56\.2[0-3]\./.test(e.ip || ''))
	const parts = []
	parts.push(`<h3>NDI sources on the air <small>announced over mDNS</small></h3><div class="rowlist">${src.map((x) => `<div ${x.ip && (s.equipment || []).some((e) => e.ip === x.ip) ? `data-sel="equipment:${esc(x.ip)}"` : ''}><span class="tally online"></span><div><b>${esc(x.name)}</b><small>${esc(x.device || x.host || '')}${x.ip ? ' · ' + esc(x.ip) : ''}${x.port ? ':' + x.port : ''}${x.groups && x.groups !== 'public' && x.groups !== 'Public' ? ' · group ' + esc(x.groups) : ''} · seen ${fmtAgo(x.seen)} ago</small></div><span></span></div>`).join('') || `<div class="empty">none announced${disc.error ? ' (' + esc(disc.error) + ')' : ''}; sources on another VLAN are only heard through an interface on it</div>`}</div>`)
	parts.push(`<h3>Devices on the NDI VLAN</h3><div class="rowlist">${devices.map((e) => dev(e, `${esc(e.ip)}${e.switch ? ' · ' + esc(e.switch.name) + ' p' + e.switch.port + ' · ' + speedTxt(e.switch.speed) : ''} · in ${fmtRate(e.down)} out ${fmtRate(e.up)}`)).join('') || '<div class="empty">none in the roster</div>'}</div>`)
	if (nets.length) parts.push(`<h3>NDI VLAN</h3>${kvRows(nets.map((n) => [vlanLabel(n.name), `${n.clients} clients · ↓ ${fmtRate(n.down)} ↑ ${fmtRate(n.up)} through the gateway`]))}${scope('insp', [{ data: nets[0].history?.down || [], color: 'in' }, { data: nets[0].history?.up || [], color: 'out' }], 'spark')}`)
	parts.push('<p>Which device decodes which source is not announced: NDI receivers pull a stream directly from the source over TCP, so the traffic shows on the switch ports (a decoding device has a steady inbound rate on its port) and in the sources\' own monitors.</p>')
	return parts.join('')
}
function panelNetwork(s) {
	const gw = s.gateway
	const sw = s.switches || []
	const errPorts = sw.filter((x) => x.online).flatMap((x) => x.ports.filter((p) => p.errorsRecent).map((p) => ({ key: p.key, n: `${x.name} p${p.idx}`, cause: p.err?.cause })))
	const parts = []
	parts.push(`<h3>Internet</h3>${gw ? kvRows([['WAN', `<span class="${gw.wan.status === 'ok' ? 'ok' : 'bad'}">${esc(gw.wan.status)}</span> · ${gw.wan.latency ?? '–'} ms · ${speedTxt(gw.wan.speed)}${gw.wan.isp ? ' · ' + esc(gw.wan.isp) : ''}`], ['Traffic', `↓ ${fmtRate(gw.wan.down)} ↑ ${fmtRate(gw.wan.up)}`], ['Gateway', `${esc(gw.modelName)} · CPU ${pct(gw.cpu)} · memory ${pct(gw.mem)} · ${gw.temp ?? '–'}° · up ${fmtUptime(gw.uptime)}`], ['Clients', `${s.clients.total} (${s.clients.wired} wired, ${s.clients.wireless} wifi)`]]) + scope('insp', [{ data: gw.wan.history?.down || [], color: 'in' }, { data: gw.wan.history?.up || [], color: 'out' }], 'spark') : '<p class="warn">gateway not found</p>'}`)
	parts.push(`<h3>Switches <small>${sw.filter((x) => x.online).length}/${sw.length} online</small></h3><div class="rowlist">${sw.map((x) => `<div data-sel="switch:${esc(x.mac)}"><span class="tally ${x.online ? 'online' : 'offline'}"></span><div><b>${esc(x.name)}</b><small>${x.online ? `${x.portsUp}/${x.portsTotal} ports · in ${fmtRate(x.totals.down)} out ${fmtRate(x.totals.up)} · uplink ${x.uplink.device ? esc(x.uplink.device) + ' p' + x.uplink.port + ' ' : ''}${speedTxt(x.uplink.speed)}${x.cpu !== null ? ' · cpu ' + x.cpu + '%' : ''}${x.temp !== null ? ' · ' + x.temp + '°' : ''}` : x.lastSeen ? 'last seen ' + fmtAgo(x.lastSeen) + ' ago' : 'offline'}</small></div><span class="${x.uplink.speed && x.uplink.speed < 1000 ? 'warn' : ''}"></span></div>`).join('')}</div>`)
	parts.push(`<h3>VLANs</h3>${kvRows((s.networks || []).filter((n) => n.watched || n.clients > 0).slice(0, 8).map((n) => [vlanLabel(n.name), `${n.clients} clients · ↓ ${fmtRate(n.down)} ↑ ${fmtRate(n.up)}`]))}`)
	if (errPorts.length) parts.push(`<h3>Ports with new errors</h3><div class="rowlist">${errPorts.map((p) => `<div data-sel="port:${esc(p.key)}"><span class="tally unresponsive"></span><div><b>${esc(p.n)}</b><small>${esc({ errors: 'damaged frames', drops: 'congestion', rxdrops: 'refused frames', flaps: 'link flapping' }[p.cause] || 'errors')}</small></div><span></span></div>`).join('')}</div>`)
	const top = (s.flows?.top || []).slice(0, 6)
	if (top.length) parts.push(`<h3>Biggest flows <small>last ${s.flows.window_s} s</small></h3>${kvRows(top.map((f) => [`${f.srcName || f.src}`, `→ ${esc(f.dstName || f.dst)}:${esc(f.dport)} · ${fmtBytes(f.bytes)}${f.action === 'blocked' ? ' · <span class="error">blocked</span>' : ''}`]))}`)
	const alerts = (s.alerts || []).filter((a) => ['wan', 'gateway', 'switch', 'port', 'api'].includes(a.scope))
	parts.push(`<h3>Open network items</h3>${alerts.length ? alerts.map((a) => `<div class="issue ${a.level}" data-alert="${esc(a.id)}"><i class="mark"></i><span>${esc(a.text)}</span></div>`).join('') : '<p class="ok">nothing open</p>'}`)
	parts.push('<div class="insp-actions"><button class="btn quiet" data-goto="gwBlock">Gateway section</button><button class="btn quiet" data-goto="rackBlock">Switches</button><button class="btn quiet" data-goto="mapBlock">Signal map</button></div>')
	return parts.join('')
}

// ------------------------------------------------------------------ equipment widgets: a line of live detail under a roster row
function pbWidget(e) {
	const t = e.telemetry
	if (!t || t.error || !e.active) return ''
	const w = (label, val) => `<span class="w">${label ? `<label>${label}</label>` : ''}<b>${val}</b></span>`
	const bar = (v, max, cls = '') => `<span class="bar"><i class="${cls}" style="width:${Math.min(100, ((Number(v) || 0) / Math.max(1e-9, max)) * 100).toFixed(0)}%"></i></span>`
	let items = []
	if (t.kind === 'hyperdeck') items = [w('transport', `${t.recording ? '<span class="tag rec">REC</span>' : ''}${esc(t.mode)}`), w('timecode', esc(t.timecode || '–')), w('format', esc([t.format, t.codec].filter(Boolean).join(' · ') || '–')), t.activeDisk ? w('disk', `${esc(t.activeDisk.name)} · ${t.remainingS !== null && t.remainingS !== undefined ? fmtMinutes(Math.round(t.remainingS / 60)) + ' left ' : ''}${bar(t.activeDisk.size - t.activeDisk.free, t.activeDisk.size, t.activeDisk.free / t.activeDisk.size < 0.1 ? 'warn' : '')} ${fmtBytes(t.activeDisk.free)} free`) : w('disk', 'none'), t.disks?.length > 1 ? w('slots', t.disks.map((d) => `${esc(d.name)}${d.active ? '*' : ''}`).join(', ')) : '', w('network', `in ${fmtRate(e.down)} · out ${fmtRate(e.up)}${e.switch ? ' · ' + speedTxt(e.switch.speed) : ''}`)]
	else if (t.kind === 'webpresenter') items = [w('stream', `${t.streaming ? '<span class="tag stream">live</span>' : ''}${esc(t.status)}`), w('bitrate', `${t.bitrate ? (t.bitrate / 1e6).toFixed(1) + ' Mb/s set' : '–'}${t.streaming ? ' · ' + fmtRate(e.up) + ' out ' + bar(e.up, (t.bitrate || 0) / 1e6 || 1, 'up') : ''}`), w('cache', t.cache !== null && t.cache !== undefined ? `${t.cache} ${bar(Number(t.cache), 100, Number(t.cache) > 50 ? 'warn' : '')}` : '–'), w('format', esc(t.format || '–')), w('network', `${fmtRate(e.up)} up${e.switch ? ' · ' + speedTxt(e.switch.speed) : ''}`)]
	else if (t.kind === 'atem') items = [w('program', esc(t.programName || '–')), w('preview', esc(t.previewName || '–')), w('stream', `${t.streaming?.state === 'streaming' ? '<span class="tag stream">live</span>' : ''}${esc(t.streaming?.state || '–')}${t.streaming?.bitrate ? ' · ' + (t.streaming.bitrate / 1e6).toFixed(1) + ' Mb/s' : ''}${t.streaming?.cache ? ' · cache ' + t.streaming.cache + ' %' : ''}${t.streaming?.duration && t.streaming.duration !== '00:00:00' ? ' · ' + esc(t.streaming.duration) : ''}`), t.recording ? w('ISO record', `${t.recording.active ? '<span class="tag rec">REC</span>' + esc(t.recording.duration || '') : 'idle'}${t.recording.remaining ? ' · ' + esc(t.recording.remaining) + ' left' : ''}${t.recording.disk ? ' · ' + esc(t.recording.disk) : ''}`) : '', w('control', t.via === 'companion' ? 'via Companion' : 'own session'), w('intake', fmtRate(e.down))]
	else if (t.kind === 'videohub') items = [w('router', `${esc(t.model || 'Videohub')}${t.name ? ' "' + esc(t.name) + '"' : ''}`), w('size', `${t.inputs} in × ${t.outputs} out`), w('routes', `${(t.routing || []).length}${t.locks ? ' · ' + t.locks + ' locked' : ''}`), w('', `<button class="btn mini quiet" data-sel="equipment:${esc(e.ip)}">routing table ▸</button>`)]
	else if (t.kind === 'host') items = [w('cpu', `${t.cpu ?? '–'}% ${bar(t.cpu || 0, 100, t.cpu > 85 ? 'error' : t.cpu > 70 ? 'warn' : '')}`), w('ram', `${t.mem.pct}% ${bar(t.mem.pct, 100, t.mem.pct > 90 ? 'error' : '')} ${fmtBytes(t.mem.used)} of ${fmtBytes(t.mem.total)}`), t.gpu ? w('gpu', `${t.gpu.util}% ${bar(t.gpu.util, 100)} ${esc(String(t.gpu.name).replace('NVIDIA GeForce ', ''))} · ${fmtBytes(t.gpu.memUsed * 1048576)} of ${fmtBytes(t.gpu.memTotal * 1048576)} · ${t.gpu.temp}°${t.gpu.power ? ' · ' + Math.round(t.gpu.power) + ' W' : ''}`) : '', ...(t.disks || []).slice(0, 4).map((d) => w(esc(d.name.split(' ')[0]), `${fmtBytes(d.free)} free ${bar(d.size - d.free, d.size, d.free / d.size < 0.1 ? 'warn' : '')}`)), w('network', `in ${fmtRate(e.down)} · out ${fmtRate(e.up)}`)]
	items = items.filter(Boolean)
	return items.length ? `<div class="pbw">${items.join('')}</div>` : ''
}
// the inspector's extra sections for a device: the Videohub routing table, this PC's details
function equipmentExtra(e) {
	const t = e.telemetry
	if (!t || t.error) return ''
	if (t.kind === 'videohub') return `<h3>Routing <small>${t.inputs} in × ${t.outputs} out${t.locks ? ' · ' + t.locks + ' locked' : ''}</small></h3>${(t.routing || []).map((r) => `<div class="route"><span>${esc(r.outName)}</span><i>←</i><span>${esc(r.inName)}</span></div>`).join('') || '<p>no routes read</p>'}`
	if (t.kind === 'host') return `<h3>This computer</h3>${kvRows([['Host', `${esc(t.hostname)} · ${esc(t.platform)} · up ${fmtUptime(t.uptime)}`], ['CPU', `${t.cpu ?? '–'} % · ${t.cores} cores · ${esc(t.cpuModel || '')}`], ['Memory', `${t.mem.pct} % · ${fmtBytes(t.mem.used)} of ${fmtBytes(t.mem.total)}`], t.gpu ? ['GPU', `${esc(t.gpu.name)} · ${t.gpu.util} % · ${fmtBytes(t.gpu.memUsed * 1048576)} of ${fmtBytes(t.gpu.memTotal * 1048576)} · ${t.gpu.temp} °C${t.gpu.power ? ' · ' + Math.round(t.gpu.power) + ' W' : ''}`] : null, ['Disks', (t.disks || []).map((d) => `${esc(d.name)} · ${fmtBytes(d.free)} free of ${fmtBytes(d.size)}`).join('<br>')]])}`
	if (t.kind === 'hyperdeck' && t.disks?.length) return `<h3>Media</h3>${kvRows(t.disks.map((d) => [d.name, `${d.active ? '<span class="ok">active</span> · ' : ''}${d.volume ? esc(d.volume) + ' · ' : ''}${d.remainingS !== null && d.remainingS !== undefined ? fmtMinutes(Math.round(d.remainingS / 60)) + ' of recording left · ' : ''}${d.free !== null ? fmtBytes(d.free) + ' free of ' + fmtBytes(d.size) : ''}${d.clips !== null ? ' · ' + d.clips + ' clips' : ''}`]))}`
	return ''
}

fetch('/api/state').then((r) => r.json()).then((s) => s.ts && render(s)).catch(() => {})
connect()
initLog()
