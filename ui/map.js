/* Signal map: a left-to-right schematic of the live network (internet → console → switches → equipment),
   laid out as a tree from the collector's topology. Links carry two animated strands: amber flowing towards
   the device (traffic into it), blue flowing back (traffic out of it); a stream arriving at the ATEM glows cyan. */
window.NetMap = (function () {
	const NS = 'http://www.w3.org/2000/svg'
	const COL_W = 236
	const ROW_H = 27
	const NODE_H = 22
	const W = { internet: 110, gateway: 186, switch: 186, ap: 170, pdu: 160, equipment: 206 }
	const PAD_X = 24
	const PAD_Y = 34

	const esc = (s) => String(s ?? '')
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
		for (const n of nodes.values()) n.children.sort((a, b) => {
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

	// schematic elbow: out of the parent, along a vertical bus, into the child
	const elbow = (x1, y1, x2, y2, bus, reverse) => (reverse ? `M${x2} ${y2} H${bus} V${y1} H${x1}` : `M${x1} ${y1} H${bus} V${y2} H${x2}`)
	function strand(x1, y1, x2, y2, bus, cls, rate, reverse) {
		const r = Number(rate) || 0
		if (r < 0.05) return null
		const w = 1 + Math.min(5, Math.log10(1 + r) * 1.9)
		const dur = Math.max(0.45, Math.min(7, 7 / Math.log10(10 + r * 8)))
		return el('path', { d: elbow(x1, y1, x2, y2, bus, reverse), class: 'strand ' + cls, 'stroke-width': w.toFixed(1), style: `animation-duration:${dur.toFixed(2)}s` })
	}

	function render(svg, topo, opts = {}) {
		const { nodes, rows, cols, loose } = layout(topo, !!opts.showAll)
		const width = Math.max(cols * COL_W + PAD_X * 2, svg.parentElement?.clientWidth || 0)
		const height = rows * ROW_H + PAD_Y + 20
		svg.setAttribute('width', width)
		svg.setAttribute('height', height)
		svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
		while (svg.firstChild) svg.removeChild(svg.firstChild)
		const colX = (c) => PAD_X + c * COL_W
		const pos = (n) => ({ x: colX(n.col), y: PAD_Y + n.row * ROW_H, w: W[n.kind] || 180, h: NODE_H })
		const byId = new Map(nodes.map((n) => [n.id, n]))
		// column labels
		const labels = ['INTERNET', 'CONSOLE']
		for (let c = 0; c < cols; c++) {
			const txt = labels[c] || (c === cols - 1 && loose ? 'NOT ON THE NETWORK' : nodes.some((n) => n.col === c && n.kind === 'switch') ? (c === 2 ? 'CORE / DISTRIBUTION' : 'EDGE') : 'EQUIPMENT')
			svg.appendChild(el('text', { x: colX(c), y: 16, class: 'col-label' }, txt))
		}
		// links first (under the nodes)
		const gl = el('g')
		svg.appendChild(gl)
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
			const bus = x1 + 22 + (p.kind === 'gateway' ? 0 : 0)
			gl.appendChild(el('path', { d: elbow(x1, y1, x2, y2, bus, false), class: 'link' + (l.up === false ? ' off' : '') }))
			const stream = opts.stream?.state === 'arriving' && n.hero
			const sIn = strand(x1, y1 - 1.5, x2, y2 - 1.5, bus - 1.5, 'in' + (stream ? ' stream' : ''), l.rate?.in, false)
			const sOut = strand(x1, y1 + 1.5, x2, y2 + 1.5, bus + 1.5, 'out', l.rate?.out, true)
			if (sIn) gl.appendChild(sIn)
			if (sOut) gl.appendChild(sOut)
			if (l.fromPort) gl.appendChild(el('text', { x: x2 - 4, y: y2 - 4, class: 'port-label', 'text-anchor': 'end' }, `p${l.fromPort}${l.speed ? ' · ' + (l.speed >= 1000 ? l.speed / 1000 + 'G' : l.speed + 'M') : ''}`))
		}
		// nodes
		const gn = el('g')
		svg.appendChild(gn)
		for (const n of nodes) {
			const { x, y, w, h } = pos(n)
			const cls = ['node', n.kind, n.status || '', n.hero ? 'hero' : '', n.hero && opts.stream?.state === 'arriving' ? 'stream' : '', opts.selected && opts.selected === n.id ? 'sel' : ''].join(' ')
			const g = el('g', { class: cls, transform: `translate(${x} ${y})`, 'data-node': n.id, 'data-tip': 'node:' + n.id })
			g.appendChild(el('rect', { class: 'box', width: w, height: h, rx: 2 }))
			if (n.kind === 'internet') {
				g.appendChild(el('circle', { cx: 11, cy: h / 2, r: 3.5, class: 'tally ' + (n.status === 'online' ? 'online' : 'offline') }))
				g.appendChild(el('text', { x: 20, y: 15 }, trunc(n.name, 13)))
			} else {
				g.appendChild(el('circle', { cx: 11, cy: h / 2, r: 3.5, class: 'tally ' + (n.status || '') }))
				const rate = n.rate || {}
				const bars = (x0) => {
					// two tiny log-scale activity bars: amber = into the device, blue = out of it (numbers in the tooltip)
					const bw = 34
					const f = (v) => Math.min(1, Math.log10(1 + (Number(v) || 0)) / 3) // 1 Gb/s = full
					g.appendChild(el('rect', { x: x0, y: 6, width: bw, height: 4, fill: '#1b1e24' }))
					g.appendChild(el('rect', { x: x0, y: 6, width: (bw * f(rate.in)).toFixed(1), height: 4, fill: '#f2b134' }))
					g.appendChild(el('rect', { x: x0, y: 12, width: bw, height: 4, fill: '#1b1e24' }))
					g.appendChild(el('rect', { x: x0, y: 12, width: (bw * f(rate.out)).toFixed(1), height: 4, fill: '#5b8dff' }))
				}
				if (n.kind === 'equipment') {
					const t = n.telemetry
					const badge = t && (t.recording || t.streaming) ? (t.recording ? 'REC' : 'STREAM') : null
					const bw = badge ? badge.length * 6 + 8 : 0
					g.appendChild(el('text', { x: 20, y: 15 }, trunc(n.name, badge ? 16 : 21)))
					bars(w - 40)
					if (badge) {
						g.appendChild(el('rect', { x: w - 46 - bw, y: 5, width: bw, height: 12, class: 'badge-bg ' + (t.recording ? 'rec' : 'stream') }))
						g.appendChild(el('text', { x: w - 46 - bw / 2, y: 14.2, 'text-anchor': 'middle', class: 'badge' }, badge))
					}
				} else if (n.kind === 'switch') {
					g.appendChild(el('text', { x: 20, y: 15 }, trunc(n.name, 15)))
					bars(w - 40)
					g.appendChild(el('text', { x: w - 44, y: 15, 'text-anchor': 'end', class: 'rate' }, `${n.portsUp}/${n.portsTotal}`))
				} else if (n.kind === 'gateway') {
					g.appendChild(el('text', { x: 20, y: 15 }, trunc(n.name, 17)))
					bars(w - 40)
				} else if (n.kind === 'ap') {
					g.appendChild(el('text', { x: 20, y: 15 }, trunc(n.name, 17)))
					g.appendChild(el('text', { x: w - 6, y: 15, 'text-anchor': 'end', class: 'rate' }, `${n.clients ?? 0} wifi`))
				} else {
					g.appendChild(el('text', { x: 20, y: 15 }, trunc(n.name, 19)))
				}
			}
			gn.appendChild(g)
		}
		return { width, height, count: nodes.length }
	}

	return { render }
})()
