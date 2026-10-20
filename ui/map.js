/* Signal map: a left-to-right schematic of the live network (internet → console → switches → equipment),
   laid out as a tree from the collector's topology. Links are hairlines with two thin flowing strands: orange
   towards the device (traffic into it), teal back out of it; a stream arriving at the ATEM glows cyan.
   The drawing sits in a zoomable, pannable viewport: ctrl/⌘ + wheel zooms at the cursor, dragging empty space
   pans, double-click fits, the −/+/fit buttons do the same; the view is remembered. */
window.NetMap = (function () {
	const NS = 'http://www.w3.org/2000/svg'
	const COL_W = 240
	const ROW_H = 29
	const NODE_H = 24
	const W = { internet: 112, gateway: 198, switch: 198, ap: 170, pdu: 160, equipment: 216 }
	const PAD_X = 30
	const PAD_Y = 40
	const KEY = 'bw-map-view'
	const view = { k: 1, x: 0, y: 0, auto: true } // auto = fit to the container until the user zooms or pans
	let content = { width: 0, height: 0 }
	let current = null // the svg we draw into

	try {
		const v = JSON.parse(localStorage.getItem(KEY) || 'null')
		if (v && typeof v.k === 'number') Object.assign(view, v)
	} catch {}
	const remember = () => {
		try {
			localStorage.setItem(KEY, JSON.stringify(view))
		} catch {}
	}

	function el(name, attrs = {}, text) {
		const e = document.createElementNS(NS, name)
		for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, v)
		if (text !== undefined) e.textContent = text
		return e
	}
	function fmtRate(v) {
		v = Number(v) || 0
		if (v >= 1000) return (v / 1000).toFixed(1) + 'G'
		if (v >= 10) return v.toFixed(0) + 'M'
		if (v >= 1) return v.toFixed(1) + 'M'
		if (v > 0) return (v * 1000).toFixed(0) + 'k'
		return '0'
	}
	const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

	function layout(topo, showAll) {
		const nodes = new Map(topo.nodes.map((n) => [n.id, { ...n, children: [] }]))
		for (const l of topo.links) {
			const c = nodes.get(l.to)
			const p = nodes.get(l.from)
			if (!c || !p || c.parent) continue
			c.parent = p.id
			c.link = l
			p.children.push(c.id)
		}
		const keep = (id) => {
			const n = nodes.get(id)
			if (!n) return false
			if (n._keep !== undefined) return n._keep
			if (n.kind === 'equipment') return (n._keep = true)
			n._keep = false // guard against cycles
			const kids = n.children.map(keep).some(Boolean)
			n._keep = kids || showAll || n.kind === 'gateway' || n.kind === 'internet'
			return n._keep
		}
		for (const n of nodes.values()) keep(n.id)
		const order = { switch: 0, ap: 1, pdu: 2, equipment: 3 }
		for (const n of nodes.values())
			n.children.sort((a, b) => {
				const A = nodes.get(a)
				const B = nodes.get(b)
				return (order[A.kind] ?? 9) - (order[B.kind] ?? 9) || String(A.group || '').localeCompare(String(B.group || '')) || Number(!!B.hero) - Number(!!A.hero) || A.name.localeCompare(B.name)
			})
		let row = 0
		let maxCol = 0
		const place = (id, col) => {
			const n = nodes.get(id)
			n.col = col
			maxCol = Math.max(maxCol, col)
			const kids = n.children.filter((k) => nodes.get(k)._keep)
			if (!kids.length) {
				n.row = row++
				return
			}
			let first = null
			let last = null
			for (const k of kids) {
				place(k, col + 1)
				const kn = nodes.get(k)
				if (first === null) first = kn.row
				last = kn.row
			}
			n.row = (first + last) / 2
		}
		const roots = [...nodes.values()].filter((n) => !n.parent && n._keep && n.kind !== 'equipment')
		for (const r of roots) place(r.id, 0)
		// equipment with no switch (wifi without AP info, or offline): own column at the far right
		const loose = [...nodes.values()].filter((n) => !n.parent && n._keep && n.kind === 'equipment').sort((a, b) => a.name.localeCompare(b.name))
		if (loose.length) {
			maxCol += 1
			for (const n of loose) {
				n.col = maxCol
				n.row = row++
			}
		}
		return { nodes: [...nodes.values()].filter((n) => n._keep), rows: row, cols: maxCol + 1, loose: loose.length }
	}

	// schematic elbow with rounded corners: out of the parent, along a vertical bus, into the child
	function elbow(x1, y1, x2, y2, bus, r = 7) {
		const dir = y2 > y1 ? 1 : y2 < y1 ? -1 : 0
		if (!dir) return `M${x1} ${y1} H${x2}`
		const rr = Math.min(r, Math.abs(y2 - y1) / 2)
		return `M${x1} ${y1} H${bus - rr} Q${bus} ${y1} ${bus} ${y1 + dir * rr} V${y2 - dir * rr} Q${bus} ${y2} ${bus + rr} ${y2} H${x2}`
	}
	function strand(x1, y1, x2, y2, bus, cls, rate) {
		const r = Number(rate) || 0
		if (r < 0.05) return null
		const w = 1.1 + Math.min(1.5, Math.log10(1 + r) * 0.5) // 1 Mb/s ≈ 1.3 px, 100 Mb/s ≈ 2.1 px, 1 Gb/s = 2.6 px
		const dur = Math.max(0.5, Math.min(8, 8 / Math.log10(10 + r * 6)))
		return el('path', { d: elbow(x1, y1, x2, y2, bus), class: 'strand ' + cls, 'stroke-width': w.toFixed(2), style: `animation-duration:${dur.toFixed(2)}s`, opacity: (0.55 + Math.min(0.4, Math.log10(1 + r) * 0.15)).toFixed(2) })
	}

	// ------------------------------------------------------------------ viewport
	function apply() {
		const g = current?.querySelector('g.viewport')
		if (g) g.setAttribute('transform', `translate(${view.x.toFixed(1)} ${view.y.toFixed(1)}) scale(${view.k.toFixed(3)})`)
		const lbl = document.getElementById('mapZoom')
		if (lbl) lbl.textContent = Math.round(view.k * 100) + '%'
	}
	// "fit" means fit the width (the tree is wide and shallow); it never shrinks below 0.72 so names stay readable,
	// and whatever does not fit vertically is reached by panning
	function fit() {
		if (!current) return
		const cw = current.clientWidth || current.parentElement?.clientWidth || 800
		const ch = current.clientHeight || current.parentElement?.clientHeight || 400
		const k = Math.min(1.15, Math.max(0.72, (cw - 16) / Math.max(1, content.width)))
		view.k = k
		view.x = Math.max(6, (cw - content.width * k) / 2)
		view.y = content.height * k <= ch ? Math.max(4, (ch - content.height * k) / 2) : 4
		view.auto = true
		apply()
		remember()
	}
	// keep the drawing within reach: never pan it entirely out of the container
	function clamp() {
		if (!current) return
		const cw = current.clientWidth || 800
		const ch = current.clientHeight || 400
		const w = content.width * view.k
		const h = content.height * view.k
		const span = (size, room, pad) => (size <= room ? [pad, room - size - pad] : [room - size - pad, pad]) // [lowest, highest] offset
		const [x0, x1] = span(w, cw, 6)
		const [y0, y1] = span(h, ch, 4)
		view.x = Math.min(Math.max(view.x, x0), x1)
		view.y = Math.min(Math.max(view.y, y0), y1)
	}
	function zoomAt(factor, cx, cy) {
		const k = Math.min(3, Math.max(0.3, view.k * factor))
		const f = k / view.k
		view.x = cx - (cx - view.x) * f
		view.y = cy - (cy - view.y) * f
		view.k = k
		view.auto = false
		clamp()
		apply()
		remember()
	}
	function zoom(factor) {
		if (!current) return
		zoomAt(factor, current.clientWidth / 2, current.clientHeight / 2)
	}
	function bind(svg) {
		if (svg.__bound) return
		svg.__bound = true
		svg.addEventListener(
			'wheel',
			(e) => {
				e.preventDefault()
				const r = svg.getBoundingClientRect()
				if (e.ctrlKey || e.metaKey) return zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top)
				// a plain wheel pans (shift + wheel sideways), like a map
				const dx = e.shiftKey ? e.deltaY : e.deltaX
				const dy = e.shiftKey ? 0 : e.deltaY
				view.x -= dx
				view.y -= dy
				view.auto = false
				clamp()
				apply()
				remember()
			},
			{ passive: false },
		)
		let drag = null
		svg.addEventListener('pointerdown', (e) => {
			if (e.button !== 0 || e.target.closest('.node')) return
			drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }
			svg.setPointerCapture(e.pointerId)
		})
		svg.addEventListener('pointermove', (e) => {
			if (!drag) return
			const dx = e.clientX - drag.x
			const dy = e.clientY - drag.y
			if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
			if (!drag.moved) return
			view.x = drag.vx + dx
			view.y = drag.vy + dy
			view.auto = false
			clamp()
			svg.classList.add('dragging')
			apply()
		})
		const end = () => {
			if (drag?.moved) remember()
			drag = null
			svg.classList.remove('dragging')
		}
		svg.addEventListener('pointerup', end)
		svg.addEventListener('pointercancel', end)
		svg.addEventListener('dblclick', (e) => {
			if (e.target.closest('.node')) return
			fit()
		})
	}

	function render(svg, topo, opts = {}) {
		current = svg
		bind(svg)
		const { nodes, rows, cols, loose } = layout(topo, !!opts.showAll)
		const width = cols * COL_W + PAD_X * 2
		const height = rows * ROW_H + PAD_Y + 24
		const sizeChanged = width !== content.width || height !== content.height
		content = { width, height }
		while (svg.firstChild) svg.removeChild(svg.firstChild)
		const vp = el('g', { class: 'viewport' })
		svg.appendChild(vp)
		const colX = (c) => PAD_X + c * COL_W
		const pos = (n) => ({ x: colX(n.col), y: PAD_Y + n.row * ROW_H, w: W[n.kind] || 180, h: NODE_H })
		const byId = new Map(nodes.map((n) => [n.id, n]))
		// column labels
		const labels = ['INTERNET', 'CONSOLE']
		for (let c = 0; c < cols; c++) {
			const txt = labels[c] || (c === cols - 1 && loose ? 'NOT ON THE NETWORK' : nodes.some((n) => n.col === c && n.kind === 'switch') ? (c === 2 ? 'CORE / DISTRIBUTION' : 'EDGE') : 'EQUIPMENT')
			vp.appendChild(el('text', { x: colX(c), y: 18, class: 'col-label' }, txt))
		}
		// links first (under the nodes)
		const gl = el('g')
		vp.appendChild(gl)
		for (const n of nodes) {
			if (!n.parent) continue
			const p = byId.get(n.parent)
			if (!p) continue
			const a = pos(p)
			const b = pos(n)
			const x1 = a.x + a.w
			const y1 = a.y + a.h / 2
			const x2 = b.x
			const y2 = b.y + b.h / 2
			const l = n.link || {}
			const bus = x1 + 24
			gl.appendChild(el('path', { d: elbow(x1, y1, x2, y2, bus), class: 'link' + (l.up === false ? ' off' : '') }))
			const stream = opts.stream?.state === 'arriving' && n.hero
			const sIn = strand(x1, y1 - 2, x2, y2 - 2, bus - 2, 'in' + (stream ? ' stream' : ''), l.rate?.in)
			const sOut = strand(x1, y1 + 2, x2, y2 + 2, bus + 2, 'out', l.rate?.out)
			if (sIn) gl.appendChild(sIn)
			if (sOut) gl.appendChild(sOut)
			if (l.fromPort) gl.appendChild(el('text', { x: x2 - 5, y: y2 - 5, class: 'port-label', 'text-anchor': 'end' }, `p${l.fromPort}${l.speed ? ' · ' + (l.speed >= 1000 ? l.speed / 1000 + 'G' : l.speed + 'M') : ''}`))
			const busy = Math.max(l.rate?.in || 0, l.rate?.out || 0)
			if (busy >= 0.5 && n.kind !== 'equipment') {
				// uplinks: write the rate on the horizontal run into the child so trunk traffic reads at a glance
				const t = el('text', { x: x2 - 5, y: y2 + 13, class: 'link-label', 'text-anchor': 'end' })
				t.appendChild(el('tspan', { class: 'i' }, `↓${fmtRate(l.rate.in)}`))
				t.appendChild(el('tspan', { class: 'o', dx: 5 }, `↑${fmtRate(l.rate.out)}`))
				gl.appendChild(t)
			}
		}
		// nodes
		const gn = el('g')
		vp.appendChild(gn)
		for (const n of nodes) {
			const { x, y, w, h } = pos(n)
			const cls = ['node', n.kind, n.status || '', n.hero ? 'hero' : '', n.hero && opts.stream?.state === 'arriving' ? 'stream' : '', opts.selected && opts.selected === n.id ? 'sel' : '', opts.match && opts.match(n) ? 'match' : '', n.label ? 'labelled' : ''].join(' ')
			const g = el('g', { class: cls, transform: `translate(${x} ${y})`, 'data-node': n.id, 'data-tip': 'node:' + n.id })
			g.appendChild(el('rect', { class: 'box', width: w, height: h, rx: 3 }))
			if (n.hero) g.appendChild(el('rect', { class: 'accent', x: 0, y: 0, width: 3, height: h, rx: 1 }))
			if (n.label) g.appendChild(el('rect', { class: 'tag', x: w - 6, y: 0, width: 6, height: 6 })) // a hand-written name: violet corner, like a labelled port
			const nm = n.label || n.name
			g.appendChild(el('circle', { cx: 12, cy: h / 2, r: 3.2, class: 'tally ' + (n.kind === 'internet' ? (n.status === 'online' ? 'online' : 'offline') : n.status || '') }))
			const rate = n.rate || {}
			const rates = () => {
				const t = el('text', { x: w - 7, y: 16, 'text-anchor': 'end', class: 'rate' })
				t.appendChild(el('tspan', { class: 'i' }, `↓${fmtRate(rate.in)}`))
				t.appendChild(el('tspan', { class: 'o', dx: 5 }, `↑${fmtRate(rate.out)}`))
				g.appendChild(t)
			}
			if (n.kind === 'internet') g.appendChild(el('text', { x: 22, y: 16, class: 'name' }, trunc(nm,13)))
			else if (n.kind === 'equipment') {
				const t = n.telemetry
				const badge = t && (t.recording || t.streaming) ? (t.recording ? 'REC' : 'STREAM') : null
				const bw = badge ? badge.length * 6 + 8 : 0
				g.appendChild(el('text', { x: 22, y: 16, class: 'name' }, trunc(nm,badge ? 12 : 16)))
				if (badge) {
					g.appendChild(el('rect', { x: w - 88 - bw, y: 6, width: bw, height: 12, rx: 2, class: 'badge-bg ' + (t.recording ? 'rec' : 'stream') }))
					g.appendChild(el('text', { x: w - 88 - bw / 2, y: 15.2, 'text-anchor': 'middle', class: 'badge' }, badge))
				}
				rates()
			} else if (n.kind === 'switch' || n.kind === 'gateway') {
				g.appendChild(el('text', { x: 22, y: 16, class: 'name' }, trunc(nm,14)))
				rates()
			} else if (n.kind === 'ap') {
				g.appendChild(el('text', { x: 22, y: 16, class: 'name' }, trunc(nm,17)))
				g.appendChild(el('text', { x: w - 7, y: 16, 'text-anchor': 'end', class: 'rate' }, `${n.clients ?? 0} wifi`))
			} else g.appendChild(el('text', { x: 22, y: 16, class: 'name' }, trunc(nm,19)))
			gn.appendChild(g)
		}
		if (view.auto || sizeChanged) {
			if (view.auto) fit()
			else apply()
		} else apply()
		return { width, height, count: nodes.length }
	}

	return { render, zoom, fit, get view() { return view } }
})()
