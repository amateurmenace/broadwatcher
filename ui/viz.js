/* Visualizations · experimental (0.14.0). Richer pictures of the state the page already receives: nothing here polls.
   render(s) runs with every state tick while the block is open and on screen; meters(m) feeds the audio waterfall at
   up to five readings a second. The marks follow the paper theme: thin lines, one hue for magnitude (teal, light to
   dark), a fixed order of hues for identity (--viz1 … --viz6), the status colours only for state. Tooltips use
   data-vtip (app.js owns data-tip). */
window.Viz = (function () {
	const $ = (id) => document.getElementById(id)
	const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
	const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()
	const DANTE = /^192\.168\.5\./
	const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|224\.|239\.)/
	const fmtMb = (v) => (v === null || v === undefined ? '–' : (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' Mb/s')
	const fmtBytes = (b) => (b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : b >= 1e3 ? (b / 1e3).toFixed(0) + ' kB' : (b || 0) + ' B')
	const short = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s))
	const vlanName = (n) => String(n || '').replace(/^BIG_/, '').replace(/_/g, ' ')
	const f1 = (x) => Number(x).toFixed(1)
	const CAT = ['--viz1', '--viz2', '--viz3', '--viz4', '--viz5', '--viz6'] // identity hues, always assigned in this order

	let state = null
	let lastDraw = 0

	function onScreen() {
		const el = $('vizBlock')
		if (!el || el.classList.contains('folded')) return false
		const r = el.getBoundingClientRect()
		return r.bottom > 0 && r.top < window.innerHeight
	}

	// ---------------------------------------------------------------- one tooltip for every figure
	let tip = null
	function showTip(text, x, y) {
		if (!tip) {
			tip = document.createElement('div')
			tip.className = 'viztip'
			document.body.appendChild(tip)
		}
		tip.textContent = text
		tip.hidden = false
		const w = tip.offsetWidth
		const h = tip.offsetHeight
		tip.style.left = Math.max(4, Math.min(window.innerWidth - w - 8, x + 14)) + 'px'
		tip.style.top = (y + 18 + h > window.innerHeight ? y - h - 10 : y + 18) + 'px'
	}
	function hideTip() {
		if (tip) tip.hidden = true
	}
	document.addEventListener('mousemove', (e) => {
		const el = e.target.closest?.('[data-vtip]')
		if (el) return showTip(el.getAttribute('data-vtip'), e.clientX, e.clientY)
		if (!e.target.closest?.('.vizbody.water, #vizRiver')) hideTip()
	})
	document.addEventListener('mouseleave', hideTip)

	// ---------------------------------------------------------------- the audio waterfall (canvas, fed by the meters)
	// 32 channels + main L/R of the main console; one row per reading, newest at the top; teal darkens with level,
	// red from -6 dBFS up
	const WF = { cols: 34, rows: [], max: 320, ip: null, canvas: null, ctx: null, w: 0, h: 0, dpr: 1, dirty: true, hex: null }
	const hexRgb = (h) => {
		const m = /^#?([0-9a-f]{6})$/i.exec(h || '')
		if (!m) return [128, 128, 128]
		const n = parseInt(m[1], 16)
		return [n >> 16, (n >> 8) & 255, n & 255]
	}
	function wfColors() {
		if (WF.hex) return WF.hex
		WF.hex = { lo: hexRgb(cssVar('--viz-seq-lo')), hi: hexRgb(cssVar('--viz-seq-hi')), hot: hexRgb(cssVar('--error')), blank: cssVar('--panel') }
		return WF.hex
	}
	function wfColor(db) {
		const c = wfColors()
		if (db === null || db === undefined || db < -89) return c.blank
		if (db >= -6) return `rgb(${c.hot.join(',')})`
		const t = Math.pow(Math.max(0, Math.min(1, (db + 60) / 54)), 0.75)
		return `rgb(${c.lo.map((v, i) => Math.round(v + (c.hi[i] - v) * t)).join(',')})`
	}
	function wfSetup() {
		const c = $('vizWater')
		if (!c) return false
		const dpr = window.devicePixelRatio || 1
		const w = c.clientWidth
		const h = c.clientHeight || 150
		if (!w) return false
		if (c !== WF.canvas || w !== WF.w || h !== WF.h || dpr !== WF.dpr) {
			WF.canvas = c
			WF.w = w
			WF.h = h
			WF.dpr = dpr
			c.width = Math.round(w * dpr)
			c.height = Math.round(h * dpr)
			WF.ctx = c.getContext('2d')
			WF.dirty = true
		}
		return true
	}
	function wfPaintRow(row, y) {
		const ctx = WF.ctx
		const cw = WF.canvas.width / WF.cols
		const rh = Math.max(1, Math.round(WF.dpr))
		for (let i = 0; i < WF.cols; i++) {
			ctx.fillStyle = wfColor(row[i])
			ctx.fillRect(Math.floor(i * cw), y, Math.ceil(cw) - (WF.dpr > 1 ? 1 : 0), rh)
		}
	}
	function wfRedraw() {
		if (!wfSetup()) return
		const ctx = WF.ctx
		const rh = Math.max(1, Math.round(WF.dpr))
		ctx.fillStyle = wfColors().blank
		ctx.fillRect(0, 0, WF.canvas.width, WF.canvas.height)
		for (let k = WF.rows.length - 1, y = 0; k >= 0 && y < WF.canvas.height; k--, y += rh) wfPaintRow(WF.rows[k], y)
		WF.dirty = false
	}
	function wfPush(row) {
		if (!wfSetup()) return
		if (WF.dirty) return wfRedraw()
		const ctx = WF.ctx
		const rh = Math.max(1, Math.round(WF.dpr))
		ctx.drawImage(WF.canvas, 0, 0, WF.canvas.width, WF.canvas.height - rh, 0, rh, WF.canvas.width, WF.canvas.height - rh)
		wfPaintRow(row, 0)
	}
	function meters(m) {
		if (!m || !m.x32) return
		const live = (state?.audio?.consoles || []).filter((c) => c.ok && m.x32[c.ip])
		const pick = live[0]
		if (!pick) return
		const c = m.x32[pick.ip]
		if (WF.ip !== pick.ip) {
			WF.ip = pick.ip
			WF.rows = []
			WF.dirty = true
		}
		const row = new Float32Array(WF.cols)
		for (let i = 0; i < 32; i++) row[i] = c.ch[i] ? c.ch[i][0] : -100
		row[32] = c.main[0] ? c.main[0][0] : -100
		row[33] = c.main[1] ? c.main[1][0] : -100
		WF.rows.push(row)
		if (WF.rows.length > WF.max) WF.rows.shift()
		if (onScreen()) wfPush(row)
	}
	function waterfallFrame(s) {
		const cs = s.audio?.consoles || []
		const live = cs.filter((c) => c.ok)
		const c = live.find((x) => x.ip === WF.ip) || live[0]
		const labels = $('vizWaterLabels')
		const foot = $('vizWaterFoot')
		const note = $('vizWaterNote')
		if (!c) {
			labels.innerHTML = ''
			foot.innerHTML = `<span>${cs.length ? 'no console is sending meters right now' : 'no console in the roster'}</span>`
			return
		}
		const names = [...c.channels.map((ch) => ch.name || ''), 'main L', 'main R']
		labels.innerHTML = names.map((n, i) => `<span title="${esc(n)}">${i < 32 ? i + 1 : i === 32 ? 'L' : 'R'}</span>`).join('')
		note.textContent = `${c.console?.name || c.name}: 32 channels and the main pair, ${c.rate || 5} readings a second, the last ${Math.round(WF.max / Math.max(1, Math.min(c.rate || 5, 5)))} s scrolling down`
		foot.innerHTML = `<span><i class="wfgrad"></i>−60 … −6 dBFS, red above</span><span>${c.active} channel${c.active === 1 ? '' : 's'} with signal</span><span>main ${c.mainLevel !== null && c.mainLevel > -60 ? f1(c.mainLevel) + ' dBFS' : 'quiet'}</span><span>one row per reading · hover a column for the channel</span>`
		if (wfSetup() && WF.dirty) wfRedraw()
		const canvas = $('vizWater')
		if (!canvas.dataset.bound) {
			canvas.dataset.bound = '1'
			canvas.addEventListener('mousemove', (e) => {
				const r = canvas.getBoundingClientRect()
				const i = Math.max(0, Math.min(WF.cols - 1, Math.floor(((e.clientX - r.left) / r.width) * WF.cols)))
				const k = Math.floor((e.clientY - r.top) * WF.dpr / Math.max(1, Math.round(WF.dpr)))
				const row = WF.rows[WF.rows.length - 1 - k]
				const cc = (state?.audio?.consoles || []).find((x) => x.ip === WF.ip)
				const nm = i < 32 ? `channel ${i + 1}${cc?.channels[i]?.name ? ' · ' + cc.channels[i].name : ''}` : i === 32 ? 'main L' : 'main R'
				const db = row ? row[i] : null
				showTip(`${nm}\n${db === null || db < -89 ? 'silent' : f1(db) + ' dBFS'} · ${(k / Math.min(5, cc?.rate || 5)).toFixed(1)} s ago`, e.clientX, e.clientY)
			})
			canvas.addEventListener('mouseleave', hideTip)
		}
	}

	// ---------------------------------------------------------------- who talks to whom (chord-like ribbons)
	const SERVICE = [
		['web', 'web (HTTPS, HTTP)'],
		['stream', 'streams (RTMP, SRT)'],
		['ndi', 'NDI'],
		['dante', 'Dante'],
		['control', 'control (SSH, Blackmagic, OSC, SNMP)'],
		['other', 'everything else'],
	]
	function serviceClass(f) {
		const svc = String(f.service || '').toUpperCase()
		const p = Number(f.dport) || 0
		const q = Number(f.sport) || 0
		const net = String(f.network || '').toUpperCase()
		if (/RTMP|SRT/.test(svc) || [1935, 1936, 1937, 9710].includes(p)) return 'stream'
		if (/NDI/.test(svc) || net.includes('NDI') || (p >= 5960 && p <= 5990) || p === 5997 || p === 5998) return 'ndi'
		if (net.includes('DANTE') || (p >= 4440 && p <= 4455) || p === 319 || p === 320 || (p >= 8700 && p <= 8708) || (p >= 14336 && p <= 14600)) return 'dante'
		if (/HTTPS|HTTP|TLS|QUIC/.test(svc) || [80, 443, 8443, 8080].includes(p)) return 'web'
		if (/SSH|SNMP|OSC/.test(svc) || [22, 161, 45, 9990, 9910, 9993, 9977, 10023, 8000].includes(p) || [9990, 9910, 9993, 9977, 10023].includes(q)) return 'control'
		return 'other'
	}
	function drawRib(s) {
		const box = $('vizRib')
		const foot = $('vizRibFoot')
		const flows = (s.flows?.top || []).filter((f) => f.bytes > 0)
		if (!flows.length) {
			box.innerHTML = '<div class="empty">no gateway flows in the window yet</div>'
			foot.innerHTML = ''
			return
		}
		// names: the roster, then the switch ports' clients, then what the gateway logged; a forwarded flow's far end is
		// named after the port forward (the gateway logs it against the WAN address)
		const names = new Map()
		for (const e of s.equipment || []) if (e.ip && e.name) names.set(e.ip, e.name)
		for (const sw of [...(s.switches || []), ...(s.gateway ? [s.gateway] : [])]) for (const p of sw.ports || []) for (const c of p.clients || []) if (c.ip && c.name && !names.has(c.ip)) names.set(c.ip, c.name)
		const id = (ip) => (PRIVATE.test(ip) ? ip : 'internet')
		const nm = (ip, name, fwd) => (PRIVATE.test(ip) ? fwd || names.get(ip) || name || ip : 'the internet')
		const nodes = new Map()
		const add = (ip, name, bytes, fwd) => {
			const k = id(ip)
			const n = nodes.get(k) || { id: k, name: nm(ip, name, fwd), bytes: 0 }
			n.bytes += bytes
			if (!n.name || n.name === k) n.name = nm(ip, name, fwd)
			nodes.set(k, n)
		}
		for (const f of flows) {
			add(f.src, f.srcName, f.bytes)
			add(f.dst, f.dstName, f.bytes, f.viaForward?.name)
		}
		const MAXN = 14
		const keep = [...nodes.values()].sort((a, b) => b.bytes - a.bytes).slice(0, MAXN)
		const kept = new Set(keep.map((n) => n.id))
		const OTHER = { id: 'other', name: 'other devices', bytes: 0 }
		const pairs = new Map()
		for (const f of flows) {
			let a = id(f.src)
			let b = id(f.dst)
			if (!kept.has(a)) {
				OTHER.bytes += f.bytes
				a = 'other'
			}
			if (!kept.has(b)) {
				OTHER.bytes += f.bytes
				b = 'other'
			}
			if (a === b) continue
			const cls = serviceClass(f)
			const k = [a, b].sort().join('|') + '|' + cls
			const p = pairs.get(k) || { a, b, cls, bytes: 0, flows: 0, services: new Set() }
			p.bytes += f.bytes
			p.flows++
			if (f.service) p.services.add(f.service)
			pairs.set(k, p)
		}
		const list = OTHER.bytes ? [...keep, OTHER] : keep
		const byId = new Map(list.map((n) => [n.id, n]))
		// angular share by the square root of the bytes, so the small talkers stay visible; 3° gaps
		const W = 520
		const H = 340
		const cx = W / 2
		const cy = H / 2 + 4
		const R = 112
		const gap = (3 * Math.PI) / 180
		const sq = list.map((n) => Math.sqrt(n.bytes))
		const sum = sq.reduce((a, b) => a + b, 0) || 1
		const free = Math.PI * 2 - gap * list.length
		let a = -Math.PI / 2
		for (let i = 0; i < list.length; i++) {
			const span = Math.max((6 * Math.PI) / 180, (sq[i] / sum) * free)
			list[i].a0 = a
			list[i].a1 = a + span
			list[i].mid = a + span / 2
			a += span + gap
		}
		// if the minimum spans pushed the ring past 360°, scale everything back down
		const used = a + Math.PI / 2
		if (used > Math.PI * 2) {
			const k = (Math.PI * 2) / used
			let b = -Math.PI / 2
			for (const n of list) {
				const span = (n.a1 - n.a0) * k
				n.a0 = b
				n.a1 = b + span
				n.mid = b + span / 2
				b += span + gap * k
			}
		}
		const px = (ang, r) => (cx + r * Math.cos(ang)).toFixed(1)
		const py = (ang, r) => (cy + r * Math.sin(ang)).toFixed(1)
		const arc = (n) => {
			const large = n.a1 - n.a0 > Math.PI ? 1 : 0
			return `M${px(n.a0, R)} ${py(n.a0, R)} A${R} ${R} 0 ${large} 1 ${px(n.a1, R)} ${py(n.a1, R)} L${px(n.a1, R + 7)} ${py(n.a1, R + 7)} A${R + 7} ${R + 7} 0 ${large} 0 ${px(n.a0, R + 7)} ${py(n.a0, R + 7)} Z`
		}
		const maxPair = Math.max(...[...pairs.values()].map((p) => p.bytes), 1)
		const ribbons = [...pairs.values()]
			.sort((x, y) => y.bytes - x.bytes)
			.map((p) => {
				const A = byId.get(p.a)
				const B = byId.get(p.b)
				if (!A || !B) return ''
				const w = 1.5 + 11 * Math.sqrt(p.bytes / maxPair)
				return `<path class="rib ${p.cls}" data-a="${esc(A.id)}" data-b="${esc(B.id)}" d="M${px(A.mid, R - 2)} ${py(A.mid, R - 2)} Q${cx} ${cy} ${px(B.mid, R - 2)} ${py(B.mid, R - 2)}" style="stroke-width:${w.toFixed(1)}" data-vtip="${esc(`${A.name} ↔ ${B.name}\n${fmtBytes(p.bytes)} in ${p.flows} flow${p.flows === 1 ? '' : 's'} · ${[...p.services].slice(0, 4).join(', ') || p.cls}`)}"/>`
			})
			.join('')
		// labels sit outside the ring, left-aligned on the right half and right-aligned on the left half, and are
		// pushed apart on each side so small neighbours never overprint
		const labs = list.map((n) => {
			const c = Math.cos(n.mid)
			return { n, x: Number(px(n.mid, R + 13)), y: Number(py(n.mid, R + 13)), side: c >= 0 ? 'r' : 'l', anchor: c >= 0 ? 'start' : 'end' }
		})
		for (const side of ['l', 'r']) {
			const g = labs.filter((l) => l.side === side).sort((a, b) => a.y - b.y)
			for (let i = 1; i < g.length; i++) if (g[i].y - g[i - 1].y < 11) g[i].y = g[i - 1].y + 11
			for (let i = g.length - 2; i >= 0; i--) if (g[i + 1].y - g[i].y < 11) g[i].y = g[i + 1].y - 11
		}
		const arcs = labs
			.map(({ n, x, y, anchor }) => `<path class="arc" d="${arc(n)}" data-node="${esc(n.id)}" data-vtip="${esc(`${n.name}${n.id !== n.name && n.id !== 'other' && n.id !== 'internet' ? '\n' + n.id : ''}\n${fmtBytes(n.bytes)} in the window`)}"/><text x="${x.toFixed(1)}" y="${(y + 3.5).toFixed(1)}" text-anchor="${anchor}" data-node="${esc(n.id)}">${esc(short(n.name, 22))}</text>`)
			.join('')
		box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="ribbons" preserveAspectRatio="xMidYMid meet">${ribbons}${arcs}</svg>`
		const svg = box.firstChild
		svg.addEventListener('mouseover', (e) => {
			const n = e.target.closest?.('[data-node]')
			if (!n) return
			const idn = n.getAttribute('data-node')
			svg.classList.add('dim')
			for (const r of svg.querySelectorAll('path.rib')) r.classList.toggle('lit', r.getAttribute('data-a') === idn || r.getAttribute('data-b') === idn)
		})
		svg.addEventListener('mouseout', (e) => {
			if (e.target.closest?.('[data-node]')) svg.classList.remove('dim')
		})
		const total = flows.reduce((n, f) => n + f.bytes, 0)
		const present = new Set([...pairs.values()].map((p) => p.cls))
		foot.innerHTML = `${SERVICE.filter(([k]) => present.has(k))
			.map(([k, l], i) => `<span><i class="sw ${k}"></i>${l}</span>`)
			.join('')}<span class="right">${flows.length} flows · ${fmtBytes(total)} in the last ${Math.round((s.flows.window_s || 900) / 60)} min · same-VLAN traffic never crosses the gateway, so it is not here</span>`
	}

	// ---------------------------------------------------------------- the VLAN river (stacked around the middle)
	function smooth(pts) {
		if (pts.length < 3) return pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')
		let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`
		for (let i = 0; i < pts.length - 1; i++) {
			const p0 = pts[Math.max(0, i - 1)]
			const p1 = pts[i]
			const p2 = pts[i + 1]
			const p3 = pts[Math.min(pts.length - 1, i + 2)]
			d += ` C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)} ${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)} ${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`
		}
		return d
	}
	function drawRiver(s) {
		const box = $('vizRiver')
		const foot = $('vizRiverFoot')
		const all = (s.networks || []).filter((n) => n.history?.down?.length > 1)
		const nets = all.some((n) => n.watched) ? all.filter((n) => n.watched) : all.slice(0, 6)
		if (!nets.length) {
			box.innerHTML = '<div class="empty">no VLAN history yet</div>'
			foot.innerHTML = ''
			return
		}
		const W = 520
		const H = 176
		const L = 6
		const Rm = 96
		const T = 8
		const B = 16
		const n = Math.max(...nets.map((x) => x.history.down.length))
		const series = nets.map((x) => {
			const d = x.history.down
			const pad = n - d.length
			return Array.from({ length: n }, (_, i) => (i < pad ? 0 : Math.max(0, Number(d[i - pad]) || 0)))
		})
		const totals = Array.from({ length: n }, (_, i) => series.reduce((a, sr) => a + sr[i], 0))
		const maxT = Math.max(0.5, ...totals)
		const x = (i) => L + (i / (n - 1)) * (W - L - Rm)
		const ky = (H - T - B) / maxT
		const mid = T + (H - T - B) / 2
		const tops = []
		const bots = []
		for (let i = 0; i < n; i++) {
			let y = mid + (totals[i] * ky) / 2
			const b = []
			const t = []
			for (let k = 0; k < series.length; k++) {
				const h = series[k][i] * ky
				b[k] = y
				t[k] = y - h
				y -= h
			}
			bots[i] = b
			tops[i] = t
		}
		const bands = series
			.map((sr, k) => {
				const top = Array.from({ length: n }, (_, i) => [x(i), tops[i][k]])
				const bot = Array.from({ length: n }, (_, i) => [x(i), bots[i][k]]).reverse()
				return `<path class="band" style="fill:var(${CAT[Math.min(k, CAT.length - 1)]})" d="${smooth(top)} ${smooth(bot).replace(/^M/, 'L')} Z" data-k="${k}"/>`
			})
			.join('')
		// direct labels at the right end, pushed apart so they never overlap
		const labels = series.map((sr, k) => ({ k, y: (tops[n - 1][k] + bots[n - 1][k]) / 2, v: sr[n - 1], name: vlanName(nets[k].name) })).sort((a, b) => a.y - b.y)
		for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 11) labels[i].y = labels[i - 1].y + 11
		for (let i = labels.length - 1; i >= 0; i--) {
			const limit = i === labels.length - 1 ? H - B - 2 : labels[i + 1].y - 11
			if (labels[i].y > limit) labels[i].y = limit
		}
		const texts = labels
			.map((l) => `<line x1="${(W - Rm + 1).toFixed(1)}" y1="${((tops[n - 1][l.k] + bots[n - 1][l.k]) / 2).toFixed(1)}" x2="${(W - Rm + 8).toFixed(1)}" y2="${l.y.toFixed(1)}" class="lead"/><text x="${W - Rm + 11}" y="${(l.y + 3.5).toFixed(1)}"><tspan style="fill:var(${CAT[Math.min(l.k, CAT.length - 1)]})">■</tspan> ${esc(short(l.name, 13))} <tspan class="v">${l.v >= 10 ? l.v.toFixed(0) : l.v.toFixed(1)}</tspan></text>`)
			.join('')
		const peakI = totals.indexOf(Math.max(...totals))
		const axis = `<text x="${x(0).toFixed(1)}" y="${H - 3}" class="ax">−10 min</text><text x="${x((n - 1) / 2).toFixed(1)}" y="${H - 3}" class="ax" text-anchor="middle">−5 min</text><text x="${x(n - 1).toFixed(1)}" y="${H - 3}" class="ax" text-anchor="end">now</text><text x="${(x(peakI) + (peakI > n / 2 ? -4 : 4)).toFixed(1)}" y="${(mid - (totals[peakI] * ky) / 2 - 3).toFixed(1)}" class="ax" text-anchor="${peakI > n / 2 ? 'end' : 'start'}">peak ${fmtMb(totals[peakI])}</text>`
		box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="river" preserveAspectRatio="none">${bands}${texts}${axis}<line class="xh" x1="-10" y1="${T}" x2="-10" y2="${H - B}"/></svg>`
		const svg = box.firstChild
		const xh = svg.querySelector('.xh')
		svg.addEventListener('mousemove', (e) => {
			const r = svg.getBoundingClientRect()
			const fx = ((e.clientX - r.left) / r.width) * W
			const i = Math.max(0, Math.min(n - 1, Math.round(((fx - L) / (W - L - Rm)) * (n - 1))))
			xh.setAttribute('x1', x(i).toFixed(1))
			xh.setAttribute('x2', x(i).toFixed(1))
			const ago = Math.round(((n - 1 - i) * 600) / (n - 1))
			const rows = series.map((sr, k) => [vlanName(nets[k].name), sr[i]]).sort((a, b) => b[1] - a[1])
			showTip(`${ago ? `${Math.floor(ago / 60)}:${String(ago % 60).padStart(2, '0')} ago` : 'now'} · ${fmtMb(totals[i])} in all\n${rows.map(([nm, v]) => `${nm}  ${fmtMb(v)}`).join('\n')}`, e.clientX, e.clientY)
		})
		svg.addEventListener('mouseleave', () => {
			xh.setAttribute('x1', '-10')
			xh.setAttribute('x2', '-10')
			hideTip()
		})
		foot.innerHTML = `${nets.map((x, k) => `<span><i class="sw" style="background:var(${CAT[Math.min(k, CAT.length - 1)]})"></i>${esc(vlanName(x.name))} · ${x.clients} clients · ${fmtMb(x.down)} now</span>`).join('')}`
	}

	// ---------------------------------------------------------------- the Dante clock (leader and followers on a ring)
	function drawOrbit(s) {
		const box = $('vizOrbit')
		const foot = $('vizOrbitFoot')
		const clocks = s.discovery?.clocks || []
		const d = clocks.find((c) => DANTE.test(c.subnet))
		const others = clocks.filter((c) => !DANTE.test(c.subnet))
		const otherTxt = others.length ? `${others.length} other domain${others.length === 1 ? '' : 's'} heard tagged on the mirror (${others.map((o) => `${o.subnet}: ${o.leaders[0] ? o.leaders[0].name || o.leaders[0].ip : 'no leader'}, ${o.followers.length} followers`).join('; ')}) · not watched` : ''
		if (!d) {
			box.innerHTML = '<div class="empty">no PTP heard on the mobile Dante VLAN</div>'
			foot.innerHTML = `<span>${esc(otherTxt)}</span>`
			return
		}
		const W = 520
		const H = 200
		const cx = 118
		const cy = 100
		const R = 68
		const now = Date.now()
		const leader = d.leaders[0]
		const fol = d.followers.slice().sort((a, b) => String(a.name || a.ip).localeCompare(String(b.name || b.ip)))
		const name = (x) => x.name || x.ip
		let svg = `<svg viewBox="0 0 ${W} ${H}" class="orbit" preserveAspectRatio="xMidYMid meet"><circle cx="${cx}" cy="${cy}" r="${R}" class="ring"/>`
		fol.forEach((f, i) => {
			const a = -Math.PI / 2 + (i / fol.length) * Math.PI * 2
			const x = cx + R * Math.cos(a)
			const y = cy + R * Math.sin(a)
			const age = now - (f.last || 0)
			const op = Math.max(0.25, Math.min(1, 1 - age / 30000))
			svg += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="spoke"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5.5" class="fol" style="opacity:${op.toFixed(2)}" data-vtip="${esc(`${name(f)}\n${f.ip}\nlast Delay_Req ${Math.round(age / 1000)} s ago · ${f.reqs} requests heard`)}"/>`
			const tx = cx + (R + 11) * Math.cos(a)
			const ty = cy + (R + 11) * Math.sin(a)
			const c = Math.cos(a)
			svg += `<text x="${tx.toFixed(1)}" y="${(ty + 3.5).toFixed(1)}" text-anchor="${c > 0.2 ? 'start' : c < -0.2 ? 'end' : 'middle'}">${esc(short(name(f), 16))}</text>`
		})
		if (leader) svg += `<circle cx="${cx}" cy="${cy}" r="9" class="pulse"/><circle cx="${cx}" cy="${cy}" r="8" class="lead" data-vtip="${esc(`${name(leader)} · leader\n${leader.ip}\n${leader.syncPerS} Sync a second · stratum ${leader.stratum ?? '–'}${leader.uuid ? ' · clock id ' + leader.uuid : ''}`)}"/>`
		else svg += `<circle cx="${cx}" cy="${cy}" r="8" class="lead missing"/>`
		svg += `<text x="${cx}" y="${cy + 22}" text-anchor="middle" class="ln">${esc(leader ? short(name(leader), 22) : 'no leader heard')}</text>`
		// the facts, to the right
		const facts = [
			['domain', `${d.network ? vlanName(d.network) + ' · ' : ''}${d.subnet}`],
			['leader', leader ? `${name(leader)} · ${leader.syncPerS} sync/s` : 'none heard'],
			['followers', `${fol.length} sending Delay_Req`],
			['state', d.status === 'ok' ? 'locked' : d.status],
			['transport', 'PTP v1 multicast, heard on the Dante NIC'],
		]
		svg += `<g class="facts" transform="translate(236 34)">${facts.map(([k, v], i) => `<text y="${i * 22}"><tspan class="k">${esc(k)}</tspan><tspan x="78" class="v ${k === 'state' ? (d.status === 'ok' ? 'ok' : 'warn') : ''}">${esc(v)}</tspan></text>`).join('')}</g></svg>`
		box.innerHTML = svg
		foot.innerHTML = `<span>a follower fades when its Delay_Req requests stop arriving</span>${otherTxt ? `<span class="right">${esc(otherTxt)}</span>` : ''}`
	}

	// ---------------------------------------------------------------- every port at once (the heatmap)
	function drawHeat(s) {
		const box = $('vizHeat')
		const foot = $('vizHeatFoot')
		const sws = (s.switches || []).filter((x) => x.online && x.portsUp > 0).sort((a, b) => (a.depth || 0) - (b.depth || 0) || String(a.name).localeCompare(String(b.name)))
		if (!sws.length) {
			box.innerHTML = '<div class="empty">no switch online</div>'
			foot.innerHTML = ''
			return
		}
		const lvl = (u) => (u >= 0.5 ? 5 : u >= 0.2 ? 4 : u >= 0.05 ? 3 : u >= 0.01 ? 2 : u > 0.0005 ? 1 : 0)
		const speed = (mb) => (!mb ? '' : mb >= 1000 ? mb / 1000 + 'G' : mb + 'M')
		let busiest = null
		let errs = 0
		const rows = sws
			.map((sw) => {
				const cells = sw.ports
					.map((p) => {
						const u = p.up ? p.util || 0 : 0
						if (p.up && (!busiest || u > busiest.u)) busiest = { u, sw, p }
						if (p.err?.cause) errs++
						const who = (p.clients || []).map((c) => c.name || c.ip).filter(Boolean).slice(0, 3)
						const dev = (p.devices || []).map((c) => c.name).filter(Boolean).slice(0, 2)
						const tipTxt = `${sw.name} · port ${p.idx}${p.label ? ` "${p.label}"` : ''}${p.uplink ? ' · uplink' : ''}\n${p.up ? `${speed(p.speed)}${p.fullDuplex === false ? ' half duplex' : ''} · ↓${fmtMb(p.rx)} ↑${fmtMb(p.tx)} · ${(u * 100).toFixed(1)} % of the link${p.poeW ? ` · PoE ${p.poeW} W` : ''}` : p.enabled === false ? 'disabled' : 'no link'}${who.length ? '\n' + who.join(', ') : dev.length ? '\n' + dev.join(', ') : ''}${p.err?.cause ? `\n${{ errors: 'damaged frames', drops: 'frames dropped (congestion)', rxdrops: 'frames refused', flaps: 'link flapping' }[p.err.cause] || 'errors'} in the last 10 min` : ''}`
						return `<i class="hc${p.up ? ' u' + lvl(u) : p.enabled === false ? ' off' : ' down'}${p.err?.cause ? ' err' : ''}${p.uplink ? ' uplink' : ''}" data-sel="port:${esc(p.key)}" data-vtip="${esc(tipTxt)}"></i>`
					})
					.join('')
				return `<div class="hn" title="${esc(sw.name)}">${esc(short(sw.name, 26))}<small>${sw.portsUp}/${sw.portsTotal}</small></div><div class="hp">${cells}</div>`
			})
			.join('')
		box.innerHTML = `<div class="heat">${rows}</div>`
		foot.innerHTML = `<span><i class="hc u0"></i>idle</span><span><i class="hc u1"></i>&gt;0.05 %</span><span><i class="hc u2"></i>1 %</span><span><i class="hc u3"></i>5 %</span><span><i class="hc u4"></i>20 %</span><span><i class="hc u5"></i>50 % of the link</span><span><i class="hc down"></i>no link</span><span><i class="hc u0 err"></i>errors</span><span><i class="hc u0 uplink"></i>uplink</span><span class="right">${busiest ? `busiest: ${esc(busiest.sw.name)} p${busiest.p.idx} at ${(busiest.u * 100).toFixed(1)} %` : ''}${errs ? ` · ${errs} port${errs === 1 ? '' : 's'} with errors` : ''} · ${sws.length} switches shown (those with a link up)</span>`
	}

	// ---------------------------------------------------------------- drive
	function render(s) {
		state = s
		if (!onScreen()) return
		const now = Date.now()
		if (now - lastDraw < 1500) return
		lastDraw = now
		const hovering = (id) => $(id)?.matches(':hover')
		const safe = (fn, name) => {
			try {
				fn(s)
			} catch (e) {
				console.warn('viz ' + name, e)
			}
		}
		safe(waterfallFrame, 'waterfall')
		if (!hovering('vizRib')) safe(drawRib, 'ribbons')
		if (!hovering('vizRiver')) safe(drawRiver, 'river')
		safe(drawOrbit, 'orbit')
		if (!hovering('vizHeat')) safe(drawHeat, 'heatmap')
	}
	window.addEventListener('resize', () => {
		WF.dirty = true
		WF.hex = null
	})
	new MutationObserver(() => {
		WF.hex = null
		WF.dirty = true
	}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
	window.addEventListener(
		'scroll',
		() => {
			if (state && onScreen() && Date.now() - lastDraw > 3000) render(state)
		},
		{ passive: true }
	)
	return { render, meters }
})()
