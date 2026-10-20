// The journal: everything that went wrong, and right again, in one place that survives restarts. Alerts raised
// and cleared (with how long they lasted), device / stream / health events from the collector, the notable
// UniFi events, AI and application errors. Kept newest-first in memory and appended to one JSONL file per day
// under <config folder>/journal, 30 days back, so a show night can be read the morning after and filtered by
// level, category, text and time (/api/journal), or exported as CSV.
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'

export const KEEP_DAYS = 30
const MAX_MEMORY = 8000
const DEDUPE_MS = 3600000 // the same keyed note (an AI error, a UniFi event) is written once an hour

// the category shown in the filter, from an alert's scope or an event's kind
const CATS = {
	api: 'Controller',
	wan: 'WAN',
	gateway: 'Gateway',
	switch: 'Switches',
	port: 'Ports',
	link: 'Ports',
	equipment: 'Equipment',
	device: 'Equipment',
	stream: 'Streams',
	path: 'Streams',
	flow: 'Streams',
	record: 'Streams',
	audio: 'Audio',
	capture: 'Capture',
	forensics: 'Capture',
	power: 'Power',
	health: 'Health',
	unifi: 'UniFi',
	ai: 'AI',
	server: 'App',
}
export const CATEGORIES = [...new Set(Object.values(CATS))]
const pad = (n) => String(n).padStart(2, '0')
const dayFile = (t) => {
	const d = new Date(t)
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`
}

export class Journal extends EventEmitter {
	constructor(dir, log = console.log) {
		super()
		this.dir = dir
		this.log = log
		this.entries = [] // newest first
		this.byId = new Map()
		this.open = new Map() // alert id -> the entry that raised it (until it clears)
		this.keyed = new Map() // dedupe key -> last time written
		this.seq = 0
		this.disabled = false
		this.load()
	}

	// ---------------------------------------------------------------- storage
	load() {
		try {
			fs.mkdirSync(this.dir, { recursive: true })
		} catch (e) {
			this.log(`[journal] cannot create ${this.dir}: ${e.message}; the log stays in memory`)
			this.disabled = true
			return
		}
		let files = []
		try {
			files = fs.readdirSync(this.dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()
		} catch {}
		const cutoff = Date.now() - KEEP_DAYS * 86400000
		const loaded = []
		for (const f of files) {
			const day = Date.parse(f.slice(0, 10) + 'T12:00:00')
			if (day < cutoff) {
				try {
					fs.unlinkSync(path.join(this.dir, f))
				} catch {}
				continue
			}
			try {
				for (const line of fs.readFileSync(path.join(this.dir, f), 'utf8').split('\n')) {
					if (!line.trim()) continue
					try {
						const e = JSON.parse(line)
						if (e && typeof e.t === 'number' && e.text) loaded.push(e)
					} catch {}
				}
			} catch (e) {
				this.log(`[journal] ${f}: ${e.message}`)
			}
		}
		loaded.sort((a, b) => a.t - b.t)
		// replay oldest first so raise / clear pairs find each other again
		for (const e of loaded) this.place(e, false)
		this.trim()
		if (loaded.length) this.log(`[journal] ${this.entries.length} entries from ${files.length} day file(s) in ${this.dir}`)
	}

	append(entry) {
		if (this.disabled) return
		try {
			fs.appendFileSync(path.join(this.dir, dayFile(entry.t)), JSON.stringify(entry) + '\n')
		} catch (e) {
			if (!this.warned) this.log(`[journal] cannot write ${this.dir}: ${e.message}`)
			this.warned = true
		}
	}

	trim() {
		if (this.entries.length > MAX_MEMORY) {
			for (const e of this.entries.splice(MAX_MEMORY)) this.byId.delete(e.id)
		}
	}

	// put an entry into memory (and pair clears with their raise); write = also append it to today's file
	place(e, write = true) {
		if (!e.id) e.id = `${e.t}-${++this.seq}`
		if (this.byId.has(e.id)) e.id = `${e.t}-${++this.seq}`
		if (e.key && !write) this.keyed.set(e.key, e.t)
		if (e.kind === 'alert' && e.alertId) {
			const prev = this.open.get(e.alertId)
			if (prev && !prev.cleared) prev.cleared = e.t // a raise while one is open (a restart in between): close the old one
			this.open.set(e.alertId, e)
		} else if (e.kind === 'clear' && e.alertId) {
			const raised = this.open.get(e.alertId)
			if (raised) {
				raised.cleared = e.t
				raised.duration = e.duration ?? e.t - raised.t
				this.open.delete(e.alertId)
			}
		}
		this.entries.unshift(e)
		this.byId.set(e.id, e)
		if (write) this.append(e)
		return e
	}

	// ---------------------------------------------------------------- input
	// a collector event ({t, kind, text, level, entity, alertId, scope, kind, explain, duration}), an AI or app note
	// ({kind:'ai'|'server', level, text, key}) or a UniFi event (importUnifi)
	record(ev, { key = null, dedupeMs = DEDUPE_MS } = {}) {
		if (!ev || !ev.text) return null
		const k = key || ev.key || null
		const t = ev.t || Date.now()
		if (k) {
			const last = this.keyed.get(k)
			if (last && t - last < dedupeMs) return null
			this.keyed.set(k, t)
			if (this.keyed.size > 4000) this.keyed.delete(this.keyed.keys().next().value)
		}
		const scope = ev.scope || (ev.alertId ? String(ev.alertId).split(':')[0] : null)
		const entry = {
			id: null,
			t: ev.t || Date.now(),
			kind: ev.kind || 'note',
			level: ev.level || (ev.kind === 'alert' ? 'warn' : 'info'),
			cat: CATS[scope] || CATS[ev.kind] || 'Other',
			text: String(ev.text).slice(0, 600),
			alertId: ev.alertId || null,
			scope: scope || null,
			sub: ev.kind === 'alert' || ev.kind === 'clear' ? String(ev.alertId || '').split(':')[1] || null : null,
			entity: ev.entity && ev.entity.type ? { type: ev.entity.type, id: ev.entity.id ?? null } : null,
			explain: ev.explain ? String(ev.explain).slice(0, 2000) : null,
			duration: ev.duration ?? null,
			device: ev.device || null,
			key: k || undefined, // kept so a reload does not import the same UniFi event twice
		}
		this.place(entry, true)
		this.trim()
		this.emit('entry', entry)
		return entry
	}

	// the controller's own events (state.log, normalised by the collector): the notable ones, once each
	importUnifi(list) {
		if (!Array.isArray(list)) return
		for (const l of list) {
			if (!l || l.severity === 'info') continue
			// phones roaming and laptops going to sleep are not broadcast news: client connect/disconnect/roam
			// events (wireless/LAN user and guest) stay in the UniFi block only; device events (switches,
			// gateway, access points) and anything rated high or critical come in
			if (/^EVT_(WU|LU|WG|LG)_/i.test(l.event || '') && l.severity !== 'error') continue
			const key = `unifi:${l.t}:${(l.title || '').slice(0, 80)}`
			if (this.keyed.has(key)) continue
			this.record({ t: l.t, kind: 'unifi', level: l.severity, text: l.title + (l.message && l.message !== l.title ? ' — ' + l.message : ''), device: l.device || null }, { key, dedupeMs: 365 * 86400000 })
		}
	}

	// ---------------------------------------------------------------- output
	get(id) {
		return this.byId.get(id) || null
	}

	// levels: Set of 'error'|'warn'|'info'; clears: include the "cleared" rows; q: free text; cat: one category
	query({ since = 0, until = Infinity, levels = null, cat = null, q = '', clears = false, limit = 500, open = false } = {}) {
		const needle = String(q || '').trim().toLowerCase()
		const out = []
		for (const e of this.entries) {
			if (e.t < since) break // newest first: everything after this is older
			if (e.t > until) continue
			if (e.kind === 'clear') {
				if (!clears || open) continue // "cleared" rows are their own switch, not a level
			} else {
				if (open && (e.kind !== 'alert' || e.cleared)) continue
				if (levels && !levels.has(e.level)) continue
			}
			if (cat && e.cat !== cat) continue
			if (needle && !`${e.text} ${e.cat} ${e.device || ''} ${e.alertId || ''}`.toLowerCase().includes(needle)) continue
			out.push(e)
			if (out.length >= limit) break
		}
		return out
	}

	// what the filter bar needs: categories with counts and the level totals, over a window
	facets(since = 0) {
		const cats = {}
		const levels = { error: 0, warn: 0, info: 0 }
		let clears = 0
		for (const e of this.entries) {
			if (e.t < since) break
			if (e.kind === 'clear') {
				clears++
				continue
			}
			cats[e.cat] = (cats[e.cat] || 0) + 1
			levels[e.level] = (levels[e.level] || 0) + 1
		}
		return { cats, levels, clears, total: this.entries.length, oldest: this.entries.length ? this.entries[this.entries.length - 1].t : null, dir: this.disabled ? null : this.dir }
	}

	// one paragraph for the AI digest and the inspector: the last 24 h in numbers and the repeat offenders
	summary(now = Date.now()) {
		const since = now - 86400000
		const recent = this.entries.filter((e) => e.t >= since && e.kind !== 'clear')
		const levels = { error: 0, warn: 0, info: 0 }
		const episodes = new Map() // alert id -> {count, total, text}
		for (const e of recent) {
			levels[e.level] = (levels[e.level] || 0) + 1
			if (e.kind === 'alert' && e.alertId) {
				const ep = episodes.get(e.alertId) || { count: 0, total: 0, text: e.text.replace(/^(PROBLEM|Warning|Note): /, ''), cat: e.cat, level: e.level }
				ep.count++
				ep.total += e.duration ?? (e.cleared ? e.cleared - e.t : now - e.t)
				episodes.set(e.alertId, ep)
			}
		}
		const recurring = [...episodes.values()].filter((x) => x.count >= 2 || x.total >= 600000).sort((a, b) => b.count - a.count || b.total - a.total).slice(0, 6)
		const open = [...this.open.values()].filter((e) => !e.cleared)
		return { since, levels, recurring, open: open.length, entries: recent.length }
	}
	summaryText(now = Date.now()) {
		const s = this.summary(now)
		const min = (ms) => `${Math.round(ms / 60000)} min`
		return `LOG, LAST 24 H: ${s.levels.error} errors, ${s.levels.warn} warnings, ${s.levels.info} notes; ${s.open} alert(s) open now${s.recurring.length ? '; recurring: ' + s.recurring.map((r) => `${r.text} (${r.count}×, ${min(r.total)} in total)`).join('; ') : '; nothing recurring'}`
	}

	csv(entries) {
		const cell = (v) => {
			const s = v === null || v === undefined ? '' : String(v)
			return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
		}
		const rows = [['time', 'level', 'category', 'kind', 'text', 'duration_min', 'cleared', 'alert_id', 'entity'].join(',')]
		for (const e of entries) rows.push([new Date(e.t).toISOString(), e.level, e.cat, e.kind, cell(e.text), e.duration != null ? Math.round(e.duration / 60000) : e.cleared ? Math.round((e.cleared - e.t) / 60000) : '', e.cleared ? new Date(e.cleared).toISOString() : '', e.alertId || '', e.entity ? `${e.entity.type}:${e.entity.id ?? ''}` : ''].map((v, i) => (i === 4 ? v : cell(v))).join(','))
		return rows.join('\n') + '\n'
	}
}
