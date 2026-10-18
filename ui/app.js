/* BIG NetWatch dashboard. Receives the collector state over server-sent events and re-renders each section. */
'use strict'

const $ = (id) => document.getElementById(id)
let state = null
let lastStateAt = 0
let hover = null // {key, x, y} of the element under the mouse, kept across re-renders

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
	if (s < 60) return s + ' s ago'
	if (s < 3600) return Math.floor(s / 60) + ' min ago'
	if (s < 86400) return Math.floor(s / 3600) + ' h ago'
	return Math.floor(s / 86400) + ' d ago'
}
function fmtTime(ms) {
	if (!ms) return '–'
	return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
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

// ------------------------------------------------------------------ sparklines
const sparkQueue = []
function spark(key, down, up, cls = '') {
	sparkQueue.push({ key, down, up })
	return `<canvas class="spark ${cls}" data-spark="${esc(key)}"></canvas>`
}
function drawSparks() {
	const dpr = window.devicePixelRatio || 1
	for (const { key, down, up } of sparkQueue) {
		const c = document.querySelector(`canvas[data-spark="${CSS.escape(key)}"]`)
		if (!c) continue
		const w = c.clientWidth
		const h = c.clientHeight
		if (!w || !h) continue
		c.width = w * dpr
		c.height = h * dpr
		const ctx = c.getContext('2d')
		ctx.scale(dpr, dpr)
		const a = down || []
		const b = up || []
		const n = Math.max(a.length, b.length, 2)
		const max = Math.max(1, ...a, ...b) * 1.1
		const x = (i) => (i / (n - 1)) * (w - 2) + 1
		const y = (v) => h - 1 - (v / max) * (h - 6)
		// grid
		ctx.strokeStyle = 'rgba(255,255,255,.05)'
		ctx.lineWidth = 1
		for (let g = 1; g < 4; g++) {
			ctx.beginPath()
			ctx.moveTo(0, (h / 4) * g)
			ctx.lineTo(w, (h / 4) * g)
			ctx.stroke()
		}
		const line = (arr, color, fill) => {
			if (arr.length < 2) return
			const off = n - arr.length
			ctx.beginPath()
			arr.forEach((v, i) => (i ? ctx.lineTo(x(i + off), y(v)) : ctx.moveTo(x(i + off), y(v))))
			ctx.strokeStyle = color
			ctx.lineWidth = 1.6
			ctx.lineJoin = 'round'
			ctx.stroke()
			if (fill) {
				ctx.lineTo(x(n - 1), h)
				ctx.lineTo(x(off), h)
				ctx.closePath()
				const g = ctx.createLinearGradient(0, 0, 0, h)
				g.addColorStop(0, fill)
				g.addColorStop(1, 'rgba(0,0,0,0)')
				ctx.fillStyle = g
				ctx.fill()
			}
		}
		line(b, '#4ea1ff', 'rgba(78,161,255,.18)')
		line(a, '#3ddc84', 'rgba(61,220,132,.22)')
		// scale label
		ctx.fillStyle = 'rgba(139,155,176,.8)'
		ctx.font = '10px ui-monospace, Menlo, monospace'
		ctx.textAlign = 'right'
		ctx.fillText(fmtRate(max / 1.1), w - 3, 10)
	}
	sparkQueue.length = 0
}

// ------------------------------------------------------------------ tooltips
const tips = new Map() // key -> html
function tipAttr(key, html) {
	tips.set(key, html)
	return `data-tip="${esc(key)}"`
}
function showTip(key, x, y) {
	const html = tips.get(key)
	const t = $('tip')
	if (!html) return t.classList.add('hidden')
	t.innerHTML = html
	t.classList.remove('hidden')
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
		hover = { key: el.dataset.tip, x: e.clientX, y: e.clientY }
		showTip(hover.key, e.clientX, e.clientY)
	} else if (hover) {
		hover = null
		$('tip').classList.add('hidden')
	}
})

// ------------------------------------------------------------------ header
function renderHeader(s) {
	const gw = s.gateway
	$('gwName').textContent = gw ? `${gw.name} · ${gw.modelName || gw.model} · ${gw.ip}` : 'gateway not found'
	$('wanDown').textContent = gw ? fmtRate(gw.wan.down) : '–'
	$('wanUp').textContent = gw ? fmtRate(gw.wan.up) : '–'
	$('wanLat').textContent = gw && gw.wan.latency !== null ? gw.wan.latency + ' ms' : '–'
	$('clientCount').textContent = `${s.clients.total} (${s.clients.wired} wired)`
	const errors = s.alerts.filter((a) => a.level === 'error').length
	const warns = s.alerts.filter((a) => a.level === 'warn').length
	const pill = $('healthPill')
	pill.className = 'pill ' + (errors ? 'error' : warns ? 'warn' : 'ok')
	pill.querySelector('span:last-child').textContent = errors ? `${errors} problem${errors > 1 ? 's' : ''}` : warns ? `${warns} warning${warns > 1 ? 's' : ''}` : 'all systems nominal'
}

function renderAlerts(s) {
	const el = $('alerts')
	if (!s.alerts.length) return el.classList.add('hidden')
	el.classList.remove('hidden')
	el.innerHTML = s.alerts.map((a) => `<div class="alert ${a.level}"><span class="scope">${esc(a.scope)}</span>${esc(a.text)}</div>`).join('')
}

// ------------------------------------------------------------------ overview
function renderOverview(s) {
	const at = s.atem
	const eq = at?.equipment
	const port = eq?.switch
	const probe = eq?.probe
	if (!at) {
		$('atemCard').innerHTML = '<div class="empty">No ATEM configured (config.json → atem)</div>'
	} else {
		$('atemCard').innerHTML = `
			<h3>Switcher <span class="right">${eq ? (eq.status === 'online' ? 'online' : eq.status) : 'not seen'}</span></h3>
			<div class="title"><span class="dot ${eq ? eq.status : 'offline'}"></span><b>${esc(at.name)}</b></div>
			<div class="ip mono">${esc(at.ip)}${eq?.mac ? ' · ' + esc(eq.mac) : ''}</div>
			<div class="bigrates">
				<div class="bigrate in"><span>Into the ATEM</span><b>${eq ? fmtRate(eq.down) : '–'}</b><em>streams, control, NDI…</em></div>
				<div class="bigrate out"><span>Out of the ATEM</span><b>${eq ? fmtRate(eq.up) : '–'}</b><em>stream out, multiview, updates</em></div>
			</div>
			${spark('atem', eq?.history.down, eq?.history.up, 'big')}
			<div class="kv">
				<span>Switch port</span><b>${port ? `${esc(port.name)} · port ${port.port} · ${speedTxt(port.speed)}${port.speed && port.speed < 1000 ? ' ⚠' : ''}` : '–'}</b>
				<span>Control (UDP ${at.control_port})</span><b>${probe ? (probe.ok ? `${esc(probe.info?.state || 'answers')} · ${probe.ms.toFixed(0)} ms` : `no answer (${esc(probe.error || '')})`) : 'not probed yet'}</b>
				<span>Seen by UniFi</span><b>${eq?.online ? 'yes · up ' + fmtUptime(eq.uptime) : eq?.lastSeen ? 'last ' + fmtAgo(eq.lastSeen) : 'no'}</b>
				<span>Counters</span><b>${eq?.age !== null && eq?.age !== undefined ? `refreshed ${eq.age} s ago` : '–'}</b>
			</div>`
	}

	// incoming streams
	const inc = at?.incoming || []
	const live = inc.filter((x) => x.live)
	const rows = inc.slice(0, 14).map((x) => {
		const src = x.srcName ? `${esc(x.srcName)}<small class="mono">${esc(x.src)}</small>` : `<span class="mono">${esc(x.src)}</span>`
		const where = [x.region, x.zone, x.network].filter(Boolean).join(' · ')
		return `<tr>
			<td><span class="dot ${x.live ? 'live' : ''}"></span></td>
			<td>${src}<small>${esc(where)}</small></td>
			<td><span class="tag ${esc((x.proto || '').toLowerCase())}">${esc(x.proto)} :${esc(x.dport)}</span><small>${esc([x.service, x.app].filter((v) => v && v !== 'OTHER').join(' · '))}</small></td>
			<td class="num">${fmtBytes(x.bytes)}<small>${x.flows} flow${x.flows > 1 ? 's' : ''}${x.action === 'blocked' ? ' · <span class="tag blocked">blocked</span>' : ''}</small></td>
			<td class="num">${fmtTime(x.first)}<small>last ${x.ageS < 60 ? x.ageS + ' s' : fmtAgo(x.last)}</small></td>
		</tr>`
	})
	$('streamsCard').innerHTML = `
		<h3>Incoming streams → ATEM <span class="right">${live.length ? `<span class="tag live">${live.length} live</span>` : 'nothing arriving right now'} · last hour</span></h3>
		${rows.length ? `<table><thead><tr><th></th><th>Source</th><th>Port / protocol</th><th class="num">Data</th><th class="num">Since</th></tr></thead><tbody>${rows.join('')}</tbody></table>` : '<div class="empty">No flows into the ATEM yet. Remote streams from the internet or from another VLAN show up here with their source and destination port as soon as they start; streams from the same VLAN are only visible as port traffic on the left.</div>'}`

	// quick status
	const gw = s.gateway
	const sw = s.switches
	const swOff = sw.filter((x) => !x.online).length
	const eqs = s.equipment.filter((e) => !e.discovered)
	const eqOff = eqs.filter((e) => e.status !== 'online').length
	const ports = sw.reduce((n, x) => n + x.portsUp, 0)
	const rowsQ = [
		['Gateway', gw ? `${gw.wan.status === 'ok' ? 'WAN ok' : 'WAN ' + gw.wan.status} · CPU ${pct(gw.cpu)} · ${gw.temp ?? '–'} °C` : 'not found'],
		['Switches', `${sw.length - swOff}/${sw.length} online · ${ports} ports up`],
		['Broadcast gear', `${eqs.length - eqOff}/${eqs.length} ok`],
		['Access points', `${s.aps.filter((a) => a.online).length}/${s.aps.length} online · ${s.clients.wireless} wifi clients`],
		['Flows last poll', `${s.flows.total} seen · ${s.flows.blocked} blocked`],
		['UniFi events', s.log.length ? `${s.log.filter((l) => l.severity !== 'info').length} notable of ${s.log.length}` : '–'],
	]
	const nets = (s.networks || []).filter((n) => n.watched)
	$('quickCard').innerHTML = `<h3>At a glance</h3>
		${rowsQ.map(([k, v]) => `<div class="row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}
		<h3 style="margin-top:14px">VLAN traffic</h3>
		${nets.map((n) => `<div class="row"><span>${esc(n.name)} <small>${n.clients} clients</small></span><b><span style="color:var(--green)">↓ ${fmtRate(n.down)}</span> &nbsp;<span style="color:var(--blue)">↑ ${fmtRate(n.up)}</span></b></div>`).join('') || '<div class="empty">no VLAN counters</div>'}`
}

// ------------------------------------------------------------------ equipment
function renderEquipment(s) {
	const groups = new Map()
	for (const e of s.equipment) {
		if (!groups.has(e.group)) groups.set(e.group, [])
		groups.get(e.group).push(e)
	}
	const ok = s.equipment.filter((e) => e.status === 'online').length
	$('eqSummary').textContent = `${ok} of ${s.equipment.length} online`
	const html = []
	for (const [g, list] of groups) {
		html.push(`<div class="group"><h4>${esc(g)} <small>${list.filter((e) => e.status === 'online').length}/${list.length}</small></h4><div class="eqgrid">`)
		for (const e of list) {
			const link = e.switch ? `${esc(e.switch.name)} · port ${e.switch.port} · ${speedTxt(e.switch.speed)}${e.switch.poeW ? ' · ' + e.switch.poeW + ' W PoE' : ''}` : e.online && e.wired === false ? 'Wi-Fi' : e.lastSeen ? 'last seen ' + fmtAgo(e.lastSeen) : 'not seen by UniFi'
			const probe = e.probe ? (e.probe.ok ? `${esc(e.probe.info?.name || e.probe.info?.state || '')} ${e.probe.ms.toFixed(0)} ms` : `no answer (${esc(e.probe.error || '')})`) : ''
			const peers = e.peers?.length ? `<div class="peers">${e.peers.slice(0, 3).map((p) => `${p.dir === 'in' ? '←' : '→'} ${esc(p.name || p.ip)}${p.service && p.service !== 'OTHER' ? ' ' + esc(p.service) : ''}`).join(' · ')}</div>` : ''
			const tipHtml = `<b>${esc(e.name)}</b>${esc(e.unifiName ? 'UniFi name: ' + e.unifiName : '')}<div class="kv"><span>IP</span><b>${esc(e.ip)}</b><span>MAC</span><b>${esc(e.mac || '–')}</b><span>Vendor</span><b>${esc(e.oui || '–')}</b><span>Network</span><b>${esc(e.network || '–')}</b><span>Uptime</span><b>${fmtUptime(e.uptime)}</b><span>To device</span><b>${fmtRate(e.down)}</b><span>From device</span><b>${fmtRate(e.up)}</b>${e.peers?.length ? `<span>Talks to</span><b>${e.peers.map((p) => `${p.dir === 'in' ? '←' : '→'} ${esc(p.name || p.ip)} ${fmtBytes(p.bytes)}`).join('<br>')}</b>` : ''}</div>`
			html.push(`<div class="eq ${e.status}${e.hero ? ' hero' : ''}" ${tipAttr('eq:' + e.ip, tipHtml)}>
				<div class="head"><span class="dot ${e.status}"></span><b>${esc(e.name)}</b><span class="role">${esc(e.role)}</span></div>
				<div class="ip">${esc(e.ip)}${e.unifiName && e.unifiName !== e.name ? ` · ${esc(e.unifiName)}` : ''}</div>
				<div class="link">${link}</div>
				<div class="rates"><span class="in">↓ ${fmtRate(e.down)}</span><span class="out">↑ ${fmtRate(e.up)}</span><span class="probe">${probe}</span></div>
				${spark('eq:' + e.ip, e.history.down, e.history.up, 'mini')}
				${peers}
			</div>`)
		}
		html.push('</div></div>')
	}
	$('eqGroups').innerHTML = html.join('') || '<div class="empty">no equipment configured</div>'
}

// ------------------------------------------------------------------ switches
function portTip(sw, p) {
	const who = [...p.devices.map((d) => `${d.name} (${d.type})`), ...p.clients.map((c) => `${c.name || c.ip || c.mac}${c.ip ? ' · ' + c.ip : ''}`)]
	return `<b>${esc(sw.name)} · port ${p.idx}${p.name && p.name !== 'Port ' + p.idx ? ' · ' + esc(p.name) : ''}</b>
		<div class="kv">
		<span>Link</span><b>${p.up ? `${speedTxt(p.speed)} ${p.fullDuplex ? 'FDX' : 'HDX'} ${esc(p.media || '')}` : p.enabled ? 'down' : 'disabled'}</b>
		<span>To device</span><b>${fmtRate(p.tx)}</b>
		<span>From device</span><b>${fmtRate(p.rx)}</b>
		<span>Utilisation</span><b>${Math.round(p.util * 100)}%</b>
		${p.poe ? `<span>PoE</span><b>${p.poeW} W ${esc(p.poeMode || '')}</b>` : ''}
		${p.lag ? `<span>LAG</span><b>${esc(p.lag)}</b>` : ''}
		<span>Errors</span><b>${p.errors}${p.errorsRecent ? ' (new!)' : ''}</b>
		<span>Counters</span><b>${p.age} s ago</b>
		${who.length ? `<span>Attached</span><b>${who.map(esc).join('<br>')}${p.clientCount > p.clients.length ? `<br>+${p.clientCount - p.clients.length} more` : ''}</b>` : ''}
		</div>`
}
function renderSwitches(s) {
	const heroIp = s.atem?.ip
	const heroPort = s.atem?.equipment?.switch
	const online = s.switches.filter((x) => x.online)
	const offline = s.switches.filter((x) => !x.online)
	$('swSummary').textContent = `${online.length} online · ${offline.length} not connected`
	const html = online.map((sw) => {
		const rj = sw.ports.filter((p) => !p.sfp)
		const sfp = sw.ports.filter((p) => p.sfp)
		const portHtml = (p) => {
			const key = `port:${sw.mac}:${p.idx}`
			const cls = ['port', p.up ? 'up ' + speedClass(p.speed) : 'down', p.uplink ? 'uplink' : '', p.poe && p.poeW > 0 ? 'poe' : '', p.errorsRecent ? 'err' : '', !p.enabled ? 'disabled' : '', heroPort && heroPort.mac === sw.mac && heroPort.port === p.idx ? 'hero' : ''].join(' ')
			return `<div class="${cls}" style="--u:${p.util.toFixed(2)}" ${tipAttr(key, portTip(sw, p))}>${p.idx}<i class="u"></i></div>`
		}
		const group = (list, label, single) => (list.length ? `<div class="pgroup${single ? ' single' : ''}">${label ? `<span class="lbl">${label}</span>` : ''}${list.map(portHtml).join('')}</div>` : '')
		const upl = sw.uplink
		return `<div class="swcard ${sw.online ? '' : 'offline'}">
			<div class="info">
				<b><span class="dot ${sw.online ? 'online' : 'offline'}"></span>${esc(sw.name)}</b>
				<div class="sub">${esc(sw.modelName || sw.model)} · ${esc(sw.ip || '')}${sw.version ? ' · v' + esc(sw.version) : ''}</div>
				<div class="metrics">
					<div><span>up </span><b>${sw.online ? fmtUptime(sw.uptime) : 'OFFLINE'}</b></div>
					<div><span>cpu </span><b class="${lvl(sw.cpu, 70, 85)}">${pct(sw.cpu)}</b></div>
					<div><span>mem </span><b class="${lvl(sw.mem, 80, 90)}">${pct(sw.mem)}</b></div>
					<div><span>temp </span><b class="${lvl(sw.temp, 60, 70)}">${sw.temp !== null ? sw.temp + ' °C' : '–'}</b></div>
					${sw.poeMax ? `<div><span>PoE </span><b>${sw.poeW} / ${sw.poeMax} W</b></div>` : ''}
					<div><span>ports </span><b>${sw.portsUp}/${sw.portsTotal}</b></div>
					<div><span>uplink </span><b class="${upl.speed && upl.speed < 1000 ? 'warn' : ''}">${upl.device ? `${esc(upl.device)} p${upl.port} · ${speedTxt(upl.speed)}` : speedTxt(upl.speed)}</b></div>
				</div>
			</div>
			<div class="ports">${group(rj, '', false)}${group(sfp, 'SFP', false)}</div>
			<div class="totals">
				<div class="t"><span class="in">↓ ${fmtRate(sw.totals.down)}</span><span class="out">↑ ${fmtRate(sw.totals.up)}</span></div>
				<div class="age">all ports · counters ${sw.age} s ago</div>
				${spark('sw:' + sw.mac, sw.history.down, sw.history.up, 'mini')}
			</div>
		</div>`
	})
	if (offline.length) {
		html.push(`<div class="card offline-list"><h3>Not connected <span class="right">portable kit, spares and anything that dropped off</span></h3><div class="eqgrid">${offline
			.map((sw) => {
				const recent = sw.lastSeen && Date.now() - sw.lastSeen < 86400000
				return `<div class="eq ${recent ? 'offline' : ''}"><div class="head"><span class="dot ${recent ? 'offline' : ''}"></span><b>${esc(sw.name)}</b><span class="role">${esc(sw.modelName || sw.model)}</span></div><div class="link">${sw.lastSeen ? 'last seen ' + fmtAgo(sw.lastSeen) : 'never seen online'}${sw.uplink.device ? ` · was on ${esc(sw.uplink.device)} port ${sw.uplink.port}` : ''}</div></div>`
			})
			.join('')}</div></div>`)
	}
	$('swList').innerHTML = html.join('') || '<div class="empty">no switches</div>'
	void heroIp
}

// ------------------------------------------------------------------ console / networks / APs
function renderConsole(s) {
	const gw = s.gateway
	if (!gw) {
		$('gwCard').innerHTML = '<div class="empty">gateway not found in the UniFi device list</div>'
	} else {
		const st = gw.storage.map((x) => `<div class="gauge"><span>${esc(x.name)} <b>${fmtBytes(x.used)} / ${fmtBytes(x.size)}</b></span><div class="bar"><i class="${lvl((x.used / x.size) * 100, 80, 92)}" style="width:${x.size ? Math.round((x.used / x.size) * 100) : 0}%"></i></div></div>`).join('')
		$('gwCard').innerHTML = `<h3>Console <span class="right">${esc(gw.modelName || gw.model)} · v${esc(gw.version || '')}</span></h3>
			<div class="title"><span class="dot ${gw.online ? 'online' : 'offline'}"></span><b>${esc(gw.name)}</b> <small class="mono">${esc(gw.ip)}</small></div>
			<div class="gauges">
				<div class="gauge"><span>CPU <b>${pct(gw.cpu)}</b></span><div class="bar"><i class="${lvl(gw.cpu, 70, 85)}" style="width:${gw.cpu || 0}%"></i></div></div>
				<div class="gauge"><span>Memory <b>${pct(gw.mem)}</b></span><div class="bar"><i class="${lvl(gw.mem, 80, 90)}" style="width:${gw.mem || 0}%"></i></div></div>
				${st}
			</div>
			<div class="temps">${gw.temps.map((t) => `<span class="tag">${esc(t.name)} ${t.value} °C</span>`).join('')}</div>
			<div class="kv">
				<span>Uptime</span><b>${fmtUptime(gw.uptime)}</b>
				<span>WAN</span><b>${esc(gw.wan.name)} · ${esc(gw.wan.status)} · ${esc(gw.wan.ip || '')}${gw.wan.isp ? ' · ' + esc(gw.wan.isp) : ''}</b>
				<span>WAN link</span><b>${speedTxt(gw.wan.speed)} · latency ${gw.wan.latency ?? '–'} ms · internet up ${fmtUptime(gw.wan.uptime)}</b>
				${gw.speedtest ? `<span>Speedtest</span><b>↓ ${gw.speedtest.down} ↑ ${gw.speedtest.up} Mb/s · ${gw.speedtest.ping} ms · ${fmtAgo(gw.speedtest.t * 1000)}</b>` : ''}
				<span>Clients</span><b>${s.clients.total} · ${s.clients.wired} wired · ${s.clients.wireless} Wi-Fi</b>
			</div>
			${spark('wan', gw.wan.history.down, gw.wan.history.up)}`
	}
	const nets = s.networks || []
	$('vlanCard').innerHTML = `<h3>Networks / VLANs <span class="right">routed through the gateway</span></h3>
		<table class="vlan"><thead><tr><th>Network</th><th class="num">VLAN</th><th class="num">Clients</th><th class="num">↓ in</th><th class="num">↑ out</th><th style="width:120px"></th></tr></thead><tbody>
		${nets.map((n) => `<tr><td class="name"><b>${esc(n.name)}</b><small class="mono">${esc(n.subnet || '')}</small></td><td class="num">${n.vlan ?? '–'}</td><td class="num">${n.clients}</td><td class="num" style="color:var(--green)">${fmtRate(n.down)}</td><td class="num" style="color:var(--blue)">${fmtRate(n.up)}</td><td>${spark('net:' + n.name, n.history.down, n.history.up, 'mini')}</td></tr>`).join('')}
		</tbody></table>`
	const pdus = s.others.filter((o) => o.kind === 'pdu')
	const apCards = s.aps.map((a) => `<div class="eq ${a.online ? 'online' : 'offline'}"><div class="head"><span class="dot ${a.online ? 'online' : 'offline'}"></span><b>${esc(a.name)}</b><span class="role">AP</span></div><div class="ip">${esc(a.modelName || a.model)} · ${esc(a.ip || '')}</div><div class="link">${a.online ? `${a.clients} clients · up ${fmtUptime(a.uptime)} · uplink ${speedTxt(a.uplink.speed)}` : a.lastSeen ? 'offline · last seen ' + fmtAgo(a.lastSeen) : 'offline'}</div><div class="rates"><span class="in">↓ ${fmtRate(a.uplink.down)}</span><span class="out">↑ ${fmtRate(a.uplink.up)}</span></div></div>`)
	const pduCards = pdus.map((p) => `<div class="eq ${p.online ? 'online' : 'offline'}"><div class="head"><span class="dot ${p.online ? 'online' : 'offline'}"></span><b>${esc(p.name)}</b><span class="role">PDU</span></div><div class="ip">${esc(p.modelName || p.model)} · ${esc(p.ip || '')}</div><div class="link">${p.online ? `${p.outletsOn}/${p.outlets} outlets on${p.powerW ? ` · ${p.powerW} W` : ''}${p.voltage ? ` · ${Math.round(p.voltage)} V` : ''} · up ${fmtUptime(p.uptime)}` : p.lastSeen ? 'offline · last seen ' + fmtAgo(p.lastSeen) : 'offline'}</div></div>`)
	$('apList').innerHTML = `<div class="group"><h4>Access points <small>${s.aps.filter((a) => a.online).length}/${s.aps.length}</small></h4><div class="eqgrid">${apCards.join('')}</div></div>` + (pdus.length ? `<div class="group"><h4>Power (PDU) <small>${pdus.filter((p) => p.online).length}/${pdus.length}</small></h4><div class="eqgrid">${pduCards.join('')}</div></div>` : '')
}

// ------------------------------------------------------------------ flows
function flowRow(f) {
	const name = (ip, n) => (n ? `${esc(n)} <small class="mono">${esc(ip)}</small>` : `<span class="mono">${esc(ip)}</span>`)
	return `<tr class="flowrow">
		<td>${name(f.src, f.srcName)}${f.srcRegion ? `<small>${esc(f.srcRegion)}</small>` : ''}</td>
		<td><span class="arrow">→</span></td>
		<td>${name(f.dst, f.dstName)}<small>${esc([f.dstRegion, f.network].filter(Boolean).join(' · '))}</small></td>
		<td><span class="tag ${esc((f.proto || '').toLowerCase())}">${esc(f.proto)} :${esc(f.dport)}</span><small>${esc([f.service, f.app].filter((v) => v && v !== 'OTHER').join(' · '))}${f.action === 'blocked' ? ' <span class="tag blocked">blocked</span>' : ''}</small></td>
		<td class="num">${fmtBytes(f.bytes)}<small>${esc(f.dir)}</small></td>
		<td class="num">${fmtTime(f.t)}</td>
	</tr>`
}
function renderFlows(s) {
	$('flowSummary').textContent = `${s.flows.total} flows in the last ${s.flows.window_s} s poll · ${s.flows.blocked} blocked`
	const head = '<thead><tr><th>Source</th><th></th><th>Destination</th><th>Port</th><th class="num">Bytes</th><th class="num">Time</th></tr></thead>'
	$('topTalkers').innerHTML = `<h3>Biggest flows <span class="right">last poll</span></h3>${s.flows.top.length ? `<table>${head}<tbody>${s.flows.top.map(flowRow).join('')}</tbody></table>` : '<div class="empty">waiting for flows</div>'}`
	$('recentFlows').innerHTML = `<h3>Flows touching the broadcast gear <span class="right">newest first</span></h3>${s.flows.recent.length ? `<table>${head}<tbody>${s.flows.recent.slice(0, 40).map(flowRow).join('')}</tbody></table>` : '<div class="empty">none yet</div>'}`
}

// ------------------------------------------------------------------ log
function renderLog(s) {
	$('logList').innerHTML = s.log.length
		? s.log.map((l) => `<div class="logline ${l.severity}"><span class="t">${fmtDateTime(l.t)}</span><span class="c">${esc(l.category.replace(/_/g, ' '))}</span><span class="m">${esc(l.title)}${l.message && l.message !== l.title ? `<small>${esc(l.message)}</small>` : ''}</span></div>`).join('')
		: '<div class="empty">no events</div>'
}

// ------------------------------------------------------------------ main loop
function render(s) {
	state = s
	lastStateAt = Date.now()
	renderHeader(s)
	renderAlerts(s)
	renderOverview(s)
	renderEquipment(s)
	renderSwitches(s)
	renderConsole(s)
	renderFlows(s)
	renderLog(s)
	drawSparks()
	if (hover) showTip(hover.key, hover.x, hover.y)
	document.title = (s.alerts.some((a) => a.level === 'error') ? '⚠ ' : '') + 'BIG NetWatch'
}

function connect() {
	const es = new EventSource('/api/events')
	es.addEventListener('state', (e) => render(JSON.parse(e.data)))
	es.onerror = () => {
		$('healthPill').className = 'pill error'
		$('healthPill').querySelector('span:last-child').textContent = 'reconnecting…'
	}
}

setInterval(() => {
	$('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
	$('updated').textContent = lastStateAt ? Math.round((Date.now() - lastStateAt) / 1000) + ' s ago' : '–'
	if (lastStateAt && Date.now() - lastStateAt > 30000) {
		$('healthPill').className = 'pill error'
		$('healthPill').querySelector('span:last-child').textContent = 'no data for ' + Math.round((Date.now() - lastStateAt) / 1000) + ' s'
	}
}, 1000)

// tab highlighting
const tabs = [...document.querySelectorAll('#tabs a')]
const sections = tabs.map((a) => document.querySelector(a.getAttribute('href')))
window.addEventListener('scroll', () => {
	let cur = 0
	sections.forEach((sec, i) => {
		if (sec && sec.getBoundingClientRect().top - 90 <= 0) cur = i
	})
	tabs.forEach((a, i) => a.classList.toggle('on', i === cur))
}, { passive: true })
window.addEventListener('resize', () => state && render(state))

fetch('/api/state').then((r) => r.json()).then((s) => s.ts && render(s)).catch(() => {})
connect()
