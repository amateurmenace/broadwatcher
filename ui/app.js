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
let hudOpen = false
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
		const x = (i) => 4 + (i / (n - 1)) * (w - 8)
		const y = (v) => h - 4 - (v / max) * (h - 16)
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
	if (aiStatus?.busy && !aiInfo) lamp.className = 'lamp thinking'
	else lamp.className = 'lamp ' + (aiInfo ? verdictClass(aiInfo.verdict) : errors ? 'down' : warns ? 'degraded' : 'ready')
	$('readyVerdict').textContent = aiInfo ? nice(aiInfo.verdict) : aiStatus && !aiStatus.enabled ? 'No AI' : errors ? 'Problems' : warns ? 'Warnings' : 'Nominal'
	$('readyHeadline').textContent = aiInfo ? aiInfo.headline : aiStatus && !aiStatus.enabled ? 'configure ai in config.json' : aiStatus?.busy ? 'assessing…' : `${s.alerts.length} open item${s.alerts.length === 1 ? '' : 's'} · AI assessment pending`
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
		.map((n) => {
			const hist = (n.history?.down || []).slice(-10)
			const mx = Math.max(1, ...hist, ...(n.history?.up || []).slice(-10))
			return `<div class="vl"><label>${esc(n.name.replace(/^BIG_/, ''))}</label><div class="bars">${hist.map((v) => `<i style="height:${Math.max(8, (v / mx) * 100)}%" class="${v > mx * 0.6 ? 'hot' : ''}"></i>`).join('')}</div><b>${fmtRate(n.down)}</b></div>`
		})
		.join('')
	const top = s.flows.top[0]
	$('flowTicker').innerHTML = top ? `<b>${esc(top.srcName || top.src)}</b> → <b>${esc(top.dstName || top.dst)}</b>:${esc(top.dport)} ${esc(top.proto)} ${esc(top.service && top.service !== 'OTHER' ? top.service : '')} ${fmtBytes(top.bytes)}` : 'no flows yet'
	$('hudIssues').innerHTML = (errors ? `<span class="error">${errors} ✕</span>` : '') + (warns ? `<span class="warn">${warns} !</span>` : '') + (!errors && !warns ? '<span class="ok">0 issues</span>' : '')
	document.title = (errors ? '✕ ' : warns ? '! ' : '') + 'Broadwatcher'
}

function renderHudPanel(s) {
	if (!hudOpen) return
	const head = '<thead><tr><th>Source</th><th>Destination</th><th>Port</th><th class="num">Bytes</th></tr></thead>'
	const row = (f) => `<tr><td>${esc(f.srcName || f.src)}${f.srcRegion ? `<small>${esc(f.srcRegion)}</small>` : ''}</td><td>${esc(f.dstName || f.dst)}<small>${esc([f.dstRegion, f.network].filter(Boolean).join(' · '))}</small></td><td><span class="tag">${esc(f.proto)} ${esc(f.dport)}</span><small>${f.viaForward ? `via WAN ${esc(f.viaForward.wanPort)} · ` : ''}${esc([f.service, f.app].filter((v) => v && v !== 'OTHER').join(' · '))}${f.action === 'blocked' ? ' <span class="tag blocked">blocked</span>' : ''}</small></td><td class="num">${fmtBytes(f.bytes)}<small>${esc(f.dir)}</small></td></tr>`
	$('hpFlows').innerHTML = `<h3>Biggest flows <small>· last ${s.flows.window_s} s · ${s.flows.total} flows, ${s.flows.blocked} blocked</small></h3>${s.flows.top.length ? `<table>${head}<tbody>${s.flows.top.slice(0, 10).map(row).join('')}</tbody></table>` : '<div class="empty">waiting for flows</div>'}`
	$('hpVlans').innerHTML = `<h3>VLANs through the gateway</h3><table><thead><tr><th>Network</th><th class="num">Clients</th><th class="num">In</th><th class="num">Out</th></tr></thead><tbody>${(s.networks || [])
		.filter((n) => n.watched || n.clients > 0)
		.map((n) => `<tr><td>${esc(n.name)}<small class="mono">${esc(n.subnet || '')}${n.vlan ? ' · vlan ' + n.vlan : ''}</small></td><td class="num">${n.clients}</td><td class="num dn">${fmtRate(n.down)}</td><td class="num up">${fmtRate(n.up)}</td></tr>`)
		.join('')}</tbody></table>`
	const gw = s.gateway
	$('hpConsole').innerHTML = gw
		? `<h3>Console <small>· ${esc(gw.modelName)} v${esc(gw.version || '')}</small></h3><div class="kv"><span>CPU</span><b class="${lvl(gw.cpu, 70, 85)}">${pct(gw.cpu)}</b><span>Memory</span><b class="${lvl(gw.mem, 80, 90)}">${pct(gw.mem)}</b><span>Temps</span><b>${gw.temps.map((t) => `${esc(t.name)} ${t.value}°`).join(' · ')}</b><span>Storage</span><b>${gw.storage.map((x) => `${esc(x.name)} ${fmtBytes(x.used)}/${fmtBytes(x.size)}`).join(' · ')}</b><span>WAN</span><b>${esc(gw.wan.name)} ${esc(gw.wan.status)} ${esc(gw.wan.ip || '')}${gw.wan.isp ? ' · ' + esc(gw.wan.isp) : ''}</b><span>Internet up</span><b>${fmtUptime(gw.wan.uptime)}</b>${gw.speedtest ? `<span>Speedtest</span><b>↓${gw.speedtest.down} ↑${gw.speedtest.up} Mb/s · ${gw.speedtest.ping} ms · ${fmtAgo(gw.speedtest.t * 1000)} ago</b>` : ''}<span>Switches</span><b>${s.switches.filter((x) => x.online).length}/${s.switches.length} online</b><span>APs</span><b>${s.aps.filter((x) => x.online).length}/${s.aps.length} online · ${s.clients.wireless} wifi</b></div>${scope('hud-wan', [{ data: gw.wan.history.down, color: 'in' }, { data: gw.wan.history.up, color: 'out' }], 'scope')}`
		: '<h3>Console</h3><div class="empty">gateway not found</div>'
	$('hpAI').innerHTML = `<h3>Broadcast readiness <small>· ${aiInfo ? esc(aiInfo.model) : 'AI'}</small></h3>${aiInfo ? `<div class="verdict"><span class="lamp ${verdictClass(aiInfo.verdict)}"></span><div><b>${esc(nice(aiInfo.verdict))}</b><small>${esc(aiInfo.headline)}</small></div></div><ul>${aiInfo.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>${aiInfo.actions?.length ? `<ol>${aiInfo.actions.map((r) => `<li>${esc(r)}</li>`).join('')}</ol>` : ''}<div class="ai-meta">${fmtAgo(aiInfo.t)} ago · ${Math.round(aiInfo.ms / 1000)} s</div>` : `<div class="empty">${aiStatus && !aiStatus.enabled ? 'AI not configured' : 'no assessment yet'}</div>`}`
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
	const r = NetMap.render($('map'), topo, { showAll: mapAll, selected: selection && selection.type !== 'alert' ? nodeIdFor(selection) : null, stream: s.atem?.stream })
	$('mapNote').textContent = `${r.count} nodes · orange = into the device, teal = out of it · thicker = more traffic`
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
				<span>Control</span><b>${eq?.probe ? (eq.probe.ok ? `answers · ${esc(eq.probe.info?.state || '')} · ${eq.probe.ms.toFixed(0)} ms` : `<span class="error">no answer (${esc(eq.probe.error || '')})</span>`) : 'not probed'}</b>
				${tl && !tl.error ? `<span>Switcher</span><b>${esc(tl.product || '')} v${esc(tl.version || '')}${tl.programName ? ` · program <span class="error">${esc(tl.programName)}</span> · preview ${esc(tl.previewName || '')}` : ''}</b><span>Own stream</span><b>${esc(tl.streaming?.state || 'unknown')}${tl.streaming?.service ? ' · ' + esc(tl.streaming.service) : ''}${tl.streaming?.url ? ' · ' + esc(tl.streaming.url) : ''}</b>` : tl?.error ? `<span>Switcher</span><b class="warn">${esc(tl.error)}</b>` : ''}
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

// ------------------------------------------------------------------ rack
function portTip(sw, p) {
	const who = [...p.devices.map((d) => `${d.name} (${d.type})`), ...p.clients.map((c) => `${c.name || c.ip || c.mac}${c.ip && c.name ? ' · ' + c.ip : ''}`)]
	return `<b>${esc(sw.name)} · port ${p.idx}${p.name && p.name !== 'Port ' + p.idx ? ' · ' + esc(p.name) : ''}</b><div class="kv"><span>Link</span><b>${p.up ? `${speedTxt(p.speed)} ${p.fullDuplex ? 'full duplex' : 'half duplex'} ${esc(p.media || '')}` : p.enabled ? 'down' : 'disabled'}</b><span>To device</span><b>${fmtRate(p.tx)}</b><span>From device</span><b>${fmtRate(p.rx)}</b><span>Use</span><b>${Math.round(p.util * 100)}%</b>${p.poe ? `<span>PoE</span><b>${p.poeW} W ${esc(p.poeMode || '')}</b>` : ''}${p.lag ? `<span>LAG</span><b>${esc(p.lag)}</b>` : ''}<span>Errors</span><b>${p.errors}${p.errorsRecent ? ' <span class="error">new</span>' : ''}</b><span>Counters</span><b>${p.live ? 'live (SNMP) · ' : ''}${p.age} s ago</b>${who.length ? `<span>Attached</span><b>${who.map(esc).join('<br>')}${p.clientCount > p.clients.length ? `<br>+${p.clientCount - p.clients.length} more` : ''}</b>` : ''}</div>`
}
function renderRack(s) {
	const heroPort = s.atem?.equipment?.switch
	const online = s.switches.filter((x) => x.online)
	const offline = s.switches.filter((x) => !x.online)
	$('rackNote').textContent = `${online.length} online · ${offline.length} not connected · top bar = link speed, line = activity`
	const units = online.map((sw) => {
		const rj = sw.ports.filter((p) => !p.sfp)
		const sfp = sw.ports.filter((p) => p.sfp)
		const port = (p) => {
			const key = `port:${sw.mac}:${p.idx}`
			const cls = ['port', p.up ? 'up ' + speedClass(p.speed) : '', p.uplink ? 'uplink' : '', p.poe && p.poeW > 0 ? 'poe' : '', p.errorsRecent ? 'err' : '', !p.enabled ? 'disabled' : '', heroPort && heroPort.mac === sw.mac && heroPort.port === p.idx ? 'hero' : '', selection?.type === 'port' && selection.id === p.key ? 'sel' : ''].join(' ')
			return `<div class="${cls}" data-sel="port:${esc(p.key)}" ${tipAttr(key, portTip(sw, p))}>${p.idx}${p.up && p.util > 0.005 ? `<i class="act" style="transform:scaleX(${Math.max(0.08, p.util).toFixed(2)})"></i>` : ''}</div>`
		}
		const grid = (list, label) => (list.length ? `<div class="pgrp">${label ? `<label>${label}</label>` : ''}<div class="pgrid${list.length < 3 ? ' single' : ''}">${list.map(port).join('')}</div></div>` : '')
		const upl = sw.uplink
		const max = Math.max(sw.totals.down, sw.totals.up, 1)
		const sel = selection?.type === 'switch' && selection.id === sw.mac ? ' sel' : ''
		const live = sw.ports.some((p) => p.live)
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
				<small>${sw.portsUp}/${sw.portsTotal} ports · ${live ? `live via SNMP · ${sw.age} s` : `counters ${sw.age} s old`}</small>
			</div>
		</div>`
	})
	const off = offline.length ? `<div class="rack-off">${offline.map((sw) => `<span class="chip${sw.lastSeen && Date.now() - sw.lastSeen < 86400000 ? ' recent' : ''}" data-sel="switch:${esc(sw.mac)}">${esc(sw.name)} · ${esc(sw.modelName)} · ${sw.lastSeen ? 'last seen ' + fmtAgo(sw.lastSeen) + ' ago' : 'never seen'}</span>`).join('')}</div>` : ''
	$('rack').innerHTML = units.join('') + off
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
			<td><input data-f="min_speed" class="short" value="${e.min_speed ?? ''}" placeholder="1000"></td>
			<td class="chk"><input type="checkbox" data-f="hero" ${e.hero ? 'checked' : ''} title="the main switcher (intake meter, stream detector)"></td>
			<td><button class="btn quiet" data-del="${i}" title="remove">✕</button></td>
		</tr>`,
		)
		.join('')
	$('rosterEditor').innerHTML = `<header><h2>Broadcast equipment roster</h2><small>tick what is part of this broadcast; unticked devices stay on standby (no alerts, no probes) and can be switched on later</small></header>
		<div class="body">
			<div class="help">Probe: <b>tcp:&lt;port&gt;</b> (HyperDeck 9993, Videohub 9990, Web Presenter 9977), <b>atem</b> (ATEM protocol), <b>x32</b> (OSC). Telemetry reads the device itself: Web Presenter stream status, HyperDeck transport, ATEM program/stream. Min speed in Mb/s raises a warning when the link is slower (video gear defaults to 1000).</div>
			<table><thead><tr><th>In</th><th>Name</th><th>IP</th><th>Group</th><th>Role</th><th>Probe</th><th>Telemetry</th><th>Min speed</th><th>Main</th><th></th></tr></thead><tbody>${rows}</tbody></table>
			<datalist id="groupList">${groups.map((g) => `<option value="${esc(g)}">`).join('')}</datalist>
		</div>
		<footer><button class="btn" id="rosterAdd">+ Add device</button><button class="btn primary" id="rosterSave">Save roster</button><button class="btn quiet" id="rosterCancel">Cancel</button><span class="msg" id="rosterMsg">${esc(msg)}</span></footer>`
}
function readRoster() {
	const rows = [...$('rosterEditor').querySelectorAll('tbody tr')]
	return rows.map((tr) => {
		const get = (f) => tr.querySelector(`[data-f="${f}"]`)
		return { active: get('active').checked, name: get('name').value, ip: get('ip').value.trim(), group: get('group').value, role: get('role').value, probe: get('probe').value.trim() || undefined, telemetry: get('telemetry').value || undefined, min_speed: get('min_speed').value.trim() || undefined, hero: get('hero').checked || undefined }
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
			t && !t.error ? ['Device', t.kind === 'webpresenter' ? `${esc(t.product || '')} ${esc(t.deviceName || '')} v${esc(t.version || '')} · stream ${esc(t.status)}${t.bitrate ? ' · ' + (t.bitrate / 1e6).toFixed(1) + ' Mb/s' : ''}${t.format ? ' · ' + esc(t.format) : ''}` : t.kind === 'hyperdeck' ? `${esc(t.product || '')} ${esc(t.deviceName || '')} v${esc(t.version || '')} · ${esc(t.summary)}` : t.kind === 'atem' ? `${esc(t.product || '')} v${esc(t.version || '')}${t.programName ? ' · program ' + esc(t.programName) + ' · preview ' + esc(t.previewName || '') : ''}${t.streaming ? ` · stream ${esc(t.streaming.state)}${t.streaming.service ? ' (' + esc(t.streaming.service) + ')' : ''}${t.streaming.url ? ' → ' + esc(t.streaming.url) : ''}${t.streaming.bitrate ? ' ' + (t.streaming.bitrate / 1e6).toFixed(1) + ' Mb/s' : ''}` : ''}` : ''] : t?.error ? ['Device', esc(t.error), 'bad'] : null,
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
		])}`
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
	return ''
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
	parts.push(`<div class="verdict"><span class="lamp ${ai ? verdictClass(ai.verdict) : aiStatus?.busy ? 'thinking' : ''}"></span><div><b>${esc(ai ? nice(ai.verdict) : aiStatus?.busy ? 'Assessing' : 'Standby')}</b><small>${esc(ai ? ai.headline : aiStatus?.busy ? 'the model is reading the live state…' : 'the first assessment runs shortly after start')}</small></div></div>`)
	if (ai) {
		parts.push(`<h3>Why</h3><ul>${ai.reasons.map((r) => `<li>${esc(r)}</li>`).join('') || '<li>no reasons given</li>'}</ul>`)
		if (ai.actions?.length) parts.push(`<h3>Do now</h3><ol>${ai.actions.map((r) => `<li>${esc(r)}</li>`).join('')}</ol>`)
		parts.push(`<div class="ai-meta">${esc(ai.model)} · ${Math.round(ai.ms / 1000)} s · ${fmtAgo(ai.t)} ago · confidence ${esc(ai.confidence || '?')}</div>`)
	}
	if (aiStatus?.lastError) parts.push(`<p class="error">AI error: ${esc(aiStatus.lastError)}</p>`)
	parts.push(`<div class="insp-actions"><button class="btn" id="reassess" ${!aiStatus?.enabled || aiStatus?.busy ? 'disabled' : ''}>Reassess now</button></div>`)
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
	renderHudPanel(s)
	renderIssues(s)
	renderMap(s)
	renderAtem(s)
	renderRack(s)
	renderPatch(s)
	renderTape(s)
	if (!selection) renderOpenItems(s)
	drawScopes()
	if (hover) showTip(hover.key, hover.x, hover.y)
}

function connect() {
	const es = new EventSource('/api/events')
	es.addEventListener('state', (e) => render(JSON.parse(e.data)))
	es.addEventListener('ai', (e) => {
		const j = JSON.parse(e.data)
		if (j && !j.error) aiInfo = j
		fetch('/api/ai/status').then((r) => r.json()).then((st) => {
			aiStatus = st
			if (state) {
				renderHud(state)
				renderHudPanel(state)
			}
			if (!selection) renderInspector()
		})
	})
	es.addEventListener('event', () => {
		if (selection) refreshInspector()
	})
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
	if (t.id === 'reassess') {
		t.disabled = true
		t.textContent = 'Assessing…'
		fetch('/api/ai/assess?refresh=1').catch(() => {})
		return
	}
	if (t.id === 'askBtn') return ask($('askInput').value)
	if (t.id === 'inspClose') return closeInspector()
	if (t.closest?.('#hudReady')) return closeInspector()
	if (t.closest?.('#hudToggle')) return toggleHud()
	if (t.closest?.('#themeToggle')) return applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark')
})
document.addEventListener('keydown', (e) => {
	if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') {
		if (e.key === 'Enter' && e.target.id === 'askInput') ask(e.target.value)
		return
	}
	if (e.key === 'h' || e.key === 'H') toggleHud()
	if (e.key === 'Escape') {
		if (!$('rosterOverlay').hidden) $('rosterOverlay').hidden = true
		else if (hudOpen) toggleHud()
		else closeInspector()
	}
})
function toggleHud() {
	hudOpen = !hudOpen
	$('hudPanel').hidden = !hudOpen
	$('hudToggle').classList.toggle('on', hudOpen)
	if (state) renderHudPanel(state)
	drawScopes()
}
$('mapAll').addEventListener('change', (e) => {
	mapAll = e.target.checked
	if (state) renderMap(state)
})
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
fetch('/api/state').then((r) => r.json()).then((s) => s.ts && render(s)).catch(() => {})
connect()
