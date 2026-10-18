// Collector: polls the UniFi gateway (devices/ports, clients, traffic flows, system log), probes the
// broadcast equipment, turns everything into one `state` object and emits it after every device poll.
//
// Rates: UniFi's own "-r" fields are slow moving averages. Switches report their cumulative port counters
// to the controller every 5-30 s (varies per switch), so a port's rate is computed from the counter delta
// at the moment the counter changes, and the time since that last change is exposed as `age`.
import { EventEmitter } from 'node:events'
import { UniFi } from './unifi.js'
import { probeAll } from './probe.js'

const num = (x) => {
	const n = Number(x)
	return Number.isFinite(n) ? n : 0
}
const MODEL_NAMES = {
	UDMPROMAX: 'UDM Pro Max',
	UDMPRO: 'UDM Pro',
	UDMPROSE: 'UDM SE',
	USAGGPRO: 'USW Aggregation Pro',
	USL8A: 'USW Aggregation',
	US48PRO: 'USW Pro 48 PoE',
	US24PRO: 'USW Pro 24 PoE',
	US648P: 'USW Pro 48 PoE (Gen2)',
	USL48P: 'USW Lite 48 PoE',
	USL24P: 'USW Lite 24 PoE',
	USL16P: 'USW Lite 16 PoE',
	USL8LP: 'USW Lite 8 PoE',
	USPM16P: 'USW Pro Max 16 PoE',
	USM25G8P: 'USW Flex 2.5G 8 PoE',
	USM25G8: 'USW Flex 2.5G 8',
	US68P: 'USW Enterprise 8 PoE',
	USMINI: 'USW Flex Mini',
	USF5P: 'USW Flex',
	USPPDUP: 'SmartPower PDU Pro',
	UAP6MP: 'U6 Pro',
	U6M: 'U6 Mesh',
	U6LR: 'U6 Long Range',
	U7PRO: 'U7 Pro',
}
const modelName = (d) => MODEL_NAMES[d.model] || d.model_display || d.shortname || d.model
const isPdu = (d) => /^USPPDU|PDU/i.test(d.model || '') || d.type === 'usp'
const mbps = (bytesPerS) => Math.round((num(bytesPerS) * 8) / 1e5) / 10 // Mb/s with one decimal
const lower = (s) => String(s || '').toLowerCase()

class Ring {
	constructor(n) {
		this.n = n
		this.a = []
	}
	push(v) {
		this.a.push(v)
		if (this.a.length > this.n) this.a.shift()
	}
}

export class Collector extends EventEmitter {
	constructor(config, log = console.log) {
		super()
		this.cfg = config
		this.log = log
		this.api = new UniFi(config.gateway)
		this.poll = { devices_s: 5, clients_s: 10, flows_s: 10, log_s: 30, probe_s: 15, history_points: 120, ...(config.poll || {}) }
		this.th = { wan_latency_ms: 80, cpu_pct: 85, mem_pct: 90, temp_c: 70, stream_min_kbps: 500, ...(config.thresholds || {}) }
		this.state = {
			ts: 0,
			started: Date.now(),
			ok: false,
			errors: {},
			gateway: null,
			switches: [],
			aps: [],
			others: [],
			networks: [],
			equipment: [],
			atem: null,
			clients: { total: 0, wired: 0, wireless: 0, byNetwork: {} },
			flows: { recent: [], top: [], window_s: 0, total: 0, blocked: 0 },
			alerts: [],
			log: [],
			updated: {},
		}
		this.counters = new Map() // "mac:port" -> {rx, tx, t, down, up, tRate, errors}
		this.hist = new Map() // key -> {down: Ring, up: Ring}
		this.aliases = new Map() // mac -> name from rest/user
		this.lastSeen = new Map() // mac -> last_seen (s) from rest/user
		this.netconf = []
		this.rawDevices = []
		this.rawClients = []
		this.probes = new Map() // ip -> probe result
		this.flowIds = new Set()
		this.flowCursor = Date.now() - 60000
		this.incoming = new Map() // ATEM incoming streams: "src>dport/proto" -> record
		this.peers = new Map() // equipment ip -> Map(peerKey -> record)
		this.timers = []
		this.busy = new Set()
	}

	// ---------------------------------------------------------------- scheduling
	start() {
		const every = (name, s, fn) => {
			const run = async () => {
				if (this.busy.has(name)) return
				this.busy.add(name)
				try {
					await fn()
					delete this.state.errors[name]
				} catch (e) {
					this.state.errors[name] = `${new Date().toLocaleTimeString()} ${e.message}`
					this.log(`[${name}] ${e.message}`)
				} finally {
					this.busy.delete(name)
				}
			}
			run()
			this.timers.push(setInterval(run, Math.max(2, s) * 1000))
		}
		every('users', 300, () => this.pollUsers())
		every('clients', this.poll.clients_s, () => this.pollClients())
		every('devices', this.poll.devices_s, () => this.pollDevices())
		every('flows', this.poll.flows_s, () => this.pollFlows())
		every('log', this.poll.log_s, () => this.pollLog())
		every('probe', this.poll.probe_s, () => this.pollProbes())
	}

	stop() {
		for (const t of this.timers) clearInterval(t)
		this.timers = []
	}

	history(key) {
		let h = this.hist.get(key)
		if (!h) {
			h = { down: new Ring(this.poll.history_points), up: new Ring(this.poll.history_points) }
			this.hist.set(key, h)
		}
		return h
	}

	// delta rate on a cumulative counter pair; falls back to UniFi's averages when the counter is stale
	rate(key, rx, tx, t, fallbackRx, fallbackTx) {
		let c = this.counters.get(key)
		if (!c) {
			c = { rx, tx, t, down: num(fallbackRx), up: num(fallbackTx), tRate: t }
			this.counters.set(key, c)
		} else if (rx !== c.rx || tx !== c.tx) {
			const dt = (t - c.t) / 1000
			if (dt > 0.5) {
				c.down = Math.max(0, (rx - c.rx) / dt)
				c.up = Math.max(0, (tx - c.tx) / dt)
				c.tRate = t
			}
			c.rx = rx
			c.tx = tx
			c.t = t
		} else if (t - c.tRate > 60000) {
			c.down = num(fallbackRx)
			c.up = num(fallbackTx)
		}
		return { down: c.down, up: c.up, age: Math.round((t - c.tRate) / 1000) }
	}

	// ---------------------------------------------------------------- polls
	async pollUsers() {
		const users = await this.api.users()
		for (const u of users || []) {
			const mac = lower(u.mac)
			if (!mac) continue
			if (u.name) this.aliases.set(mac, u.name)
			if (u.last_seen) this.lastSeen.set(mac, u.last_seen)
		}
		this.netconf = (await this.api.networks()) || []
		this.state.updated.users = Date.now()
	}

	async pollClients() {
		this.rawClients = (await this.api.clients()) || []
		this.state.updated.clients = Date.now()
	}

	async pollLog() {
		const r = await this.api.systemLog({ pageSize: 80, hours: 72 })
		const recs = Array.isArray(r) ? r : r?.data || []
		this.state.log = recs.map(normaliseLog).filter(Boolean).slice(0, 80)
		this.state.updated.log = Date.now()
	}

	async pollProbes() {
		const items = this.cfg.equipment.filter((e) => e.probe && e.ip)
		const res = await probeAll(items)
		for (const [ip, r] of res) this.probes.set(ip, { ...r, t: Date.now() })
		this.state.updated.probe = Date.now()
	}

	async pollFlows() {
		const end = Date.now()
		const start = this.flowCursor - 5000
		const all = []
		// the gateway logs thousands of flows a minute; incoming ones (internet -> LAN, the remote streams)
		// are fetched completely, local (between VLANs) and outgoing ones only the newest pages
		const fetchDir = async (dir, maxPages) => {
			for (let page = 0; page < maxPages; page++) {
				const r = await this.api.flows({ start, end, pageSize: 200, pageNumber: page, direction: [dir] })
				const recs = r?.data || []
				all.push(...recs)
				if (!r?.has_next || recs.length < 200) break
				const oldest = recs[recs.length - 1]?.time
				if (oldest && oldest < this.flowCursor) break
			}
		}
		await fetchDir('incoming', 4)
		await fetchDir('local', 3)
		await fetchDir('outgoing', 1)
		this.flowCursor = end
		const fresh = all.filter((f) => f?.id && !this.flowIds.has(f.id))
		for (const f of fresh) this.flowIds.add(f.id)
		if (this.flowIds.size > 5000) this.flowIds = new Set([...this.flowIds].slice(-2500))
		this.ingestFlows(fresh, end)
		this.state.flows.window_s = Math.round((end - start) / 1000)
		this.state.updated.flows = end
	}

	async pollDevices() {
		const [devices, health] = await Promise.all([this.api.devices(), this.api.health().catch(() => [])])
		this.rawDevices = devices || []
		this.health = Object.fromEntries((health || []).map((h) => [h.subsystem, h]))
		this.rebuild()
		this.state.updated.devices = Date.now()
		this.emit('state', this.state)
	}

	// ---------------------------------------------------------------- flows -> ATEM incoming + peers
	ingestFlows(recs, now) {
		const atemIp = this.cfg.atem?.ip
		const eqIps = new Set(this.cfg.equipment.map((e) => e.ip))
		const recent = this.state.flows.recent
		let bytesTop = []
		let blocked = 0
		for (const f of recs) {
			const src = f.source || {}
			const dst = f.destination || {}
			const td = f.traffic_data || {}
			const bytes = num(td.bytes_total)
			if (f.action === 'blocked') blocked++
			const rec = {
				id: f.id,
				t: f.time || now,
				src: src.ip,
				sport: src.port,
				srcName: src.device_name || this.aliases.get(lower(src.mac)) || null,
				srcRegion: src.region || null,
				srcZone: src.zone_name || null,
				dst: dst.ip,
				dport: dst.port,
				dstName: dst.device_name || this.aliases.get(lower(dst.mac)) || null,
				dstRegion: dst.region || null,
				dstZone: dst.zone_name || null,
				proto: f.protocol,
				service: f.service,
				app: f.application?.app || null,
				cat: f.application?.cat || null,
				dir: f.direction,
				action: f.action,
				network: f.in?.network_name || null,
				bytes,
				bytesRx: num(td.bytes_rx),
				bytesTx: num(td.bytes_tx),
				packets: num(td.packets_total),
				risk: f.risk,
			}
			bytesTop.push(rec)
			const touches = eqIps.has(rec.src) || eqIps.has(rec.dst)
			if (touches) recent.unshift(rec)
			if (atemIp && rec.dst === atemIp) this.noteIncoming(rec, now)
			for (const ip of [rec.src, rec.dst]) {
				if (!eqIps.has(ip)) continue
				const other = ip === rec.src ? rec.dst : rec.src
				const m = this.peers.get(ip) || new Map()
				const k = `${other}/${ip === rec.src ? 'out' : 'in'}/${rec.proto}`
				const p = m.get(k) || { ip: other, name: ip === rec.src ? rec.dstName : rec.srcName, dir: ip === rec.src ? 'out' : 'in', proto: rec.proto, service: rec.service, bytes: 0, count: 0, first: rec.t, last: 0, region: ip === rec.src ? rec.dstRegion : rec.srcRegion }
				p.bytes += bytes
				p.count++
				p.last = Math.max(p.last, rec.t)
				p.service = rec.service || p.service
				m.set(k, p)
				this.peers.set(ip, m)
			}
		}
		this.state.flows.recent = recent.slice(0, 150)
		this.state.flows.total = recs.length
		this.state.flows.blocked = blocked
		if (recs.length) {
			bytesTop.sort((a, b) => b.bytes - a.bytes)
			this.state.flows.top = bytesTop.slice(0, 15)
		}
		// expire old peers
		for (const [, m] of this.peers) for (const [k, p] of m) if (now - p.last > 1800000) m.delete(k)
	}

	noteIncoming(rec, now) {
		const key = `${rec.src}>${rec.dport}/${rec.proto}`
		const s = this.incoming.get(key) || {
			key,
			src: rec.src,
			sport: rec.sport,
			srcName: rec.srcName,
			region: rec.srcRegion,
			zone: rec.srcZone,
			dport: rec.dport,
			proto: rec.proto,
			service: rec.service,
			app: rec.app,
			network: rec.network,
			action: rec.action,
			first: rec.t,
			last: 0,
			bytes: 0,
			packets: 0,
			flows: 0,
		}
		s.last = Math.max(s.last, rec.t)
		s.bytes += rec.bytes
		s.packets += rec.packets
		s.flows++
		s.service = rec.service || s.service
		s.app = rec.app || s.app
		s.action = rec.action
		s.srcName = rec.srcName || s.srcName
		this.incoming.set(key, s)
		for (const [k, v] of this.incoming) if (now - v.last > 3600000) this.incoming.delete(k)
	}

	// ---------------------------------------------------------------- state assembly
	rebuild() {
		const now = Date.now()
		const devices = this.rawDevices
		const clients = this.rawClients
		const devByMac = new Map(devices.map((d) => [lower(d.mac), d]))
		const clientByIp = new Map()
		const clientsByPort = new Map() // "swmac:port" -> [client]
		const clientsByAp = new Map()
		const netCounts = {}
		let wired = 0
		let wireless = 0
		if (!this.ipToMac) this.ipToMac = new Map()
		for (const c of clients) {
			const mac = lower(c.mac)
			c._name = this.aliases.get(mac) || c.name || c.hostname || null
			if (c.ip) {
				clientByIp.set(c.ip, c)
				this.ipToMac.set(c.ip, mac)
			}
			if (c.is_wired) {
				wired++
				const k = `${lower(c.sw_mac)}:${c.sw_port}`
				if (!clientsByPort.has(k)) clientsByPort.set(k, [])
				clientsByPort.get(k).push(c)
			} else {
				wireless++
				const k = lower(c.ap_mac)
				if (!clientsByAp.has(k)) clientsByAp.set(k, [])
				clientsByAp.get(k).push(c)
			}
			const n = c.network || '?'
			netCounts[n] = (netCounts[n] || 0) + 1
		}
		this.state.clients = { total: clients.length, wired, wireless, byNetwork: netCounts }

		// downstream devices hanging off a port (uplink_remote_port on the child)
		const devicesByPort = new Map()
		for (const d of devices) {
			const up = d.uplink || {}
			const parent = lower(up.uplink_mac)
			if (parent && up.uplink_remote_port) {
				const k = `${parent}:${up.uplink_remote_port}`
				if (!devicesByPort.has(k)) devicesByPort.set(k, [])
				devicesByPort.get(k).push(d)
			}
		}

		const switches = []
		const aps = []
		const others = []
		let gateway = null
		for (const d of devices) {
			const mac = lower(d.mac)
			const online = d.state === 1
			const ss = d['system-stats'] || {}
			const t = d.last_seen ? d.last_seen * 1000 : now
			const temps = Array.isArray(d.temperatures) ? d.temperatures.map((x) => ({ name: x.name, value: Math.round(num(x.value) * 10) / 10 })) : []
			const temp = d.general_temperature ?? temps.find((x) => /cpu/i.test(x.name))?.value ?? temps[0]?.value ?? null
			const ports = []
			let rxAll = 0
			let txAll = 0
			let poeAll = 0
			let portsUp = 0
			for (const p of d.port_table || []) {
				const idx = p.port_idx
				const key = `${mac}:${idx}`
				const r = this.rate(key, num(p.rx_bytes), num(p.tx_bytes), t, p['rx_bytes-r'], p['tx_bytes-r'])
				const errs = num(p.rx_errors) + num(p.tx_errors) + num(p.rx_dropped) + num(p.tx_dropped)
				const c = this.counters.get(key)
				const errDelta = c.errors === undefined ? 0 : Math.max(0, errs - c.errors)
				c.errors = errs
				c.errSeen = errDelta > 0 ? now : c.errSeen || 0
				const cl = clientsByPort.get(key) || []
				const dd = devicesByPort.get(key) || []
				const up = !!p.up
				if (up) portsUp++
				rxAll += r.down
				txAll += r.up
				poeAll += num(p.poe_power)
				ports.push({
					idx,
					name: p.name || `Port ${idx}`,
					up,
					enabled: p.enable !== false && p.forward !== 'disabled',
					speed: num(p.speed),
					fullDuplex: p.full_duplex !== false,
					media: p.media || (p.sfp_found ? 'SFP' : 'GE'),
					sfp: p.media === 'SFP' || p.media === 'SFP+' || !!p.sfp_found,
					poe: !!p.port_poe,
					poeW: Math.round(num(p.poe_power) * 10) / 10,
					poeMode: p.poe_mode || null,
					uplink: !!p.is_uplink || dd.length > 0,
					lag: p.aggregated_by || null,
					rx: mbps(r.down), // from the attached device into the switch
					tx: mbps(r.up), // from the switch to the attached device
					age: r.age,
					util: p.speed ? Math.min(1, Math.max(r.down, r.up) * 8 / (num(p.speed) * 1e6)) : 0,
					errors: errs,
					errorsRecent: now - (c.errSeen || 0) < 600000,
					clients: cl.slice(0, 6).map((x) => ({ name: x._name, ip: x.ip, mac: x.mac })),
					clientCount: cl.length,
					devices: dd.map((x) => ({ name: x.name, ip: x.ip, type: x.type })),
				})
			}
			ports.sort((a, b) => a.idx - b.idx)
			const h = this.history(mac)
			h.down.push(mbps(rxAll))
			h.up.push(mbps(txAll))
			const upl = d.uplink || {}
			const entry = {
				mac,
				name: d.name || d.model,
				model: d.model,
				modelName: modelName(d),
				ip: d.lan_ip || d.ip,
				type: d.type,
				online,
				state: d.state,
				uptime: online ? num(d.uptime) : 0,
				lastSeen: d.last_seen ? d.last_seen * 1000 : null,
				version: d.version,
				upgradable: !!d.upgradable,
				cpu: ss.cpu !== undefined ? Math.round(num(ss.cpu)) : null,
				mem: ss.mem !== undefined ? Math.round(num(ss.mem)) : null,
				temp: temp !== null ? Math.round(num(temp)) : null,
				temps,
				overheating: !!d.overheating,
				fan: d.fan_level ?? null,
				satisfaction: d.satisfaction ?? null,
				uplink: {
					device: upl.uplink_device_name || null,
					port: upl.uplink_remote_port || null,
					localPort: upl.port_idx || null,
					speed: num(upl.speed),
					media: upl.media || upl.type || null,
					down: mbps(upl['rx_bytes-r']),
					up: mbps(upl['tx_bytes-r']),
				},
				depth: d.uplink_depth ?? null,
				ports,
				portsUp,
				portsTotal: ports.length,
				totals: { down: mbps(rxAll), up: mbps(txAll) },
				poeW: Math.round(poeAll * 10) / 10,
				poeMax: num(d.total_max_power) || null,
				clients: (d.type === 'uap' ? clientsByAp.get(mac) || [] : []).length,
				history: { down: h.down.a, up: h.up.a },
				age: online ? Math.round((now - t) / 1000) : null,
			}
			if (isPdu(d)) {
				const outlets = d.outlet_table || []
				others.push({
					...entry,
					kind: 'pdu',
					ports: [],
					outlets: outlets.length,
					outletsOn: outlets.filter((o) => o.relay_state).length,
					powerW: Math.round(outlets.reduce((s, o) => s + num(o.outlet_power), 0) * 10) / 10,
					voltage: outlets.find((o) => num(o.outlet_voltage))?.outlet_voltage ?? null,
				})
				continue
			}
			if (d.type === 'udm' || d.type === 'uxg' || d.type === 'ugw') {
				const wan = this.health?.wan || {}
				const www = this.health?.www || {}
				const w1 = d.wan1 || {}
				gateway = {
					...entry,
					ip: d.lan_ip || safeHost(this.cfg.gateway.url) || d.ip,
					wanIp: d.ip,
					storage: (d.storage || []).map((s) => ({ name: s.name, used: num(s.used), size: num(s.size) })),
					wan: {
						status: wan.status || (w1.up ? 'ok' : 'unknown'),
						name: wan.gw_name || w1.name || 'WAN',
						ip: wan.wan_ip || w1.ip || null,
						down: mbps(wan['rx_bytes-r'] ?? upl['rx_bytes-r']),
						up: mbps(wan['tx_bytes-r'] ?? upl['tx_bytes-r']),
						latency: www.latency ?? null,
						uptime: www.uptime ?? null,
						speed: num(w1.speed) || num(upl.speed),
						isp: w1.isp_name || null,
						maxDown: num(wan.speedtest_lastrun ? w1.max_rx : 0) || null,
					},
					speedtest: d['speedtest-status'] ? { down: d['speedtest-status'].xput_download, up: d['speedtest-status'].xput_upload, ping: d['speedtest-status'].latency, t: d['speedtest-status'].rundate } : null,
					networks: [],
				}
				const wh = this.history('wan')
				wh.down.push(gateway.wan.down)
				wh.up.push(gateway.wan.up)
				gateway.wan.history = { down: wh.down.a, up: wh.up.a }
				// VLANs: per-network routed counters live on the gateway
				const conf = new Map(this.netconf.map((n) => [n.name, n]))
				for (const n of d.network_table || []) {
					const cfgN = conf.get(n.name) || {}
					const nh = this.history(`net:${n.name}`)
					const down = mbps(n['rx_bytes-r'])
					const up = mbps(n['tx_bytes-r'])
					nh.down.push(down)
					nh.up.push(up)
					gateway.networks.push({
						name: n.name,
						vlan: n.vlan ?? cfgN.vlan ?? null,
						subnet: n.ip_subnet || cfgN.ip_subnet || null,
						purpose: cfgN.purpose || null,
						clients: n.num_sta ?? netCounts[n.name] ?? 0,
						down,
						up,
						watched: (this.cfg.networks || []).includes(n.name),
						history: { down: nh.down.a, up: nh.up.a },
					})
				}
				gateway.networks.sort((a, b) => Number(b.watched) - Number(a.watched) || b.clients - a.clients)
			} else if (d.type === 'usw') switches.push(entry)
			else if (d.type === 'uap') aps.push(entry)
			else others.push({ ...entry, kind: d.type, ports: [] })
		}
		// online switches by distance from the gateway, then the ones that are not connected (portable kit, spares)
		switches.sort((a, b) => Number(b.online) - Number(a.online) || (a.depth ?? 9) - (b.depth ?? 9) || a.name.localeCompare(b.name))
		this.state.gateway = gateway
		this.state.switches = switches
		this.state.aps = aps
		this.state.others = others
		this.state.networks = gateway?.networks || []

		// equipment: config entries + auto-discovered broadcast vendors
		const known = new Set(this.cfg.equipment.map((e) => e.ip))
		const discovered = []
		const ouis = (this.cfg.auto_discover_ouis || []).map(lower)
		for (const c of clients) {
			if (!c.ip || known.has(c.ip)) continue
			const oui = lower(c.oui)
			if (ouis.some((o) => oui.includes(o))) discovered.push({ name: c._name || `${String(c.oui).split(/\s+/)[0]} device`, ip: c.ip, group: 'Discovered (by vendor)', role: 'unknown', discovered: true })
		}
		const equipment = []
		for (const e of [...this.cfg.equipment, ...discovered]) {
			const c = clientByIp.get(e.ip)
			const mac = lower(c?.mac)
			const sw = c ? devByMac.get(lower(c.sw_mac || c.ap_mac)) : null
			const swEntry = sw ? [...switches, gateway, ...aps].find((s) => s && s.mac === lower(sw.mac)) : null
			const port = swEntry && c?.is_wired ? swEntry.ports.find((p) => p.idx === c.sw_port) : null
			const pr = this.probes.get(e.ip) || null
			const h = this.history(`eq:${e.ip}`)
			const down = port ? port.tx : mbps(c?.['rx_bytes-r'])
			const up = port ? port.rx : mbps(c?.['tx_bytes-r'])
			h.down.push(down)
			h.up.push(up)
			const peers = [...(this.peers.get(e.ip) || new Map()).values()].sort((a, b) => b.last - a.last).slice(0, 8)
			equipment.push({
				...e,
				probeSpec: e.probe || null,
				unifiName: c?._name || null,
				online: !!c,
				wired: c ? !!c.is_wired : null,
				mac: c?.mac || null,
				oui: c?.oui || null,
				network: c?.network || null,
				uptime: c ? num(c.uptime) : 0,
				lastSeen: c ? now : this.lastSeenByIp(e.ip),
				switch: swEntry ? { name: swEntry.name, mac: swEntry.mac, port: c.sw_port, speed: port?.speed || null, poeW: port?.poeW || 0 } : null,
				down,
				up,
				age: port?.age ?? null,
				probe: pr,
				reachable: pr ? pr.ok : null,
				status: !c ? 'offline' : pr && !pr.ok ? 'unresponsive' : 'online',
				peers,
				history: { down: h.down.a, up: h.up.a },
			})
		}
		this.state.equipment = equipment

		// ATEM hero
		const atemCfg = this.cfg.atem
		if (atemCfg?.ip) {
			const eq = equipment.find((e) => e.ip === atemCfg.ip)
			const incoming = [...this.incoming.values()].sort((a, b) => b.last - a.last)
			this.state.atem = {
				...atemCfg,
				equipment: eq || null,
				incoming: incoming.map((s) => ({ ...s, live: now - s.last < 45000, ageS: Math.round((now - s.last) / 1000) })),
				liveCount: incoming.filter((s) => now - s.last < 45000).length,
			}
		}

		this.state.alerts = this.computeAlerts(now)
		this.state.ts = now
		this.state.ok = Object.keys(this.state.errors).length === 0
	}

	lastSeenByIp(ip) {
		const mac = this.ipToMac?.get(ip)
		const ls = mac ? this.lastSeen.get(mac) : null
		return ls ? ls * 1000 : null
	}

	computeAlerts(now) {
		const a = []
		const st = this.state
		for (const [k, v] of Object.entries(st.errors)) a.push({ level: 'error', scope: 'api', text: `UniFi ${k} poll failing: ${v}` })
		const gw = st.gateway
		if (gw) {
			if (gw.wan.status !== 'ok') a.push({ level: 'error', scope: 'wan', text: `WAN ${gw.wan.status}` })
			if (gw.wan.latency !== null && gw.wan.latency > this.th.wan_latency_ms) a.push({ level: 'warn', scope: 'wan', text: `WAN latency ${gw.wan.latency} ms` })
			if (gw.cpu !== null && gw.cpu > this.th.cpu_pct) a.push({ level: 'warn', scope: 'gateway', text: `${gw.name} CPU ${gw.cpu}%` })
			if (gw.mem !== null && gw.mem > this.th.mem_pct) a.push({ level: 'warn', scope: 'gateway', text: `${gw.name} memory ${gw.mem}%` })
			if (gw.temp !== null && gw.temp > this.th.temp_c) a.push({ level: 'warn', scope: 'gateway', text: `${gw.name} ${gw.temp} °C` })
		} else if (!st.errors.devices && st.updated.devices) a.push({ level: 'error', scope: 'gateway', text: 'Gateway not in the device list' })
		for (const s of st.switches) {
			if (!s.online) {
				// portable Flex Minis and spares sit offline for months: only a switch seen in the last day is an alert
				if (s.lastSeen && now - s.lastSeen < 86400000) a.push({ level: 'error', scope: 'switch', text: `${s.name} OFFLINE (last seen ${Math.round((now - s.lastSeen) / 60000)} min ago)` })
			} else {
				if (s.cpu !== null && s.cpu > this.th.cpu_pct) a.push({ level: 'warn', scope: 'switch', text: `${s.name} CPU ${s.cpu}%` })
				if (s.overheating || (s.temp !== null && s.temp > this.th.temp_c)) a.push({ level: 'warn', scope: 'switch', text: `${s.name} ${s.temp} °C` })
				for (const p of s.ports) if (p.errorsRecent) a.push({ level: 'warn', scope: 'port', text: `${s.name} port ${p.idx} errors/drops` })
				if (s.uplink.speed && s.uplink.speed < 1000 && s.uplink.media !== 'wireless') a.push({ level: 'warn', scope: 'switch', text: `${s.name} uplink at ${s.uplink.speed} Mb/s` })
			}
		}
		for (const e of st.equipment) {
			if (e.discovered) continue
			const minSpeed = e.min_speed ?? (['switcher', 'encoder', 'recorder', 'computer'].includes(e.role) ? 1000 : 0)
			if (!e.online) a.push({ level: e.hero ? 'error' : 'warn', scope: 'equipment', text: `${e.name} not on the network` })
			else if (e.reachable === false) a.push({ level: e.hero ? 'error' : 'warn', scope: 'equipment', text: `${e.name} not answering (${e.probeSpec}: ${e.probe?.error || 'no reply'})` })
			else if (e.probe?.info?.state === 'too many clients') a.push({ level: 'warn', scope: 'equipment', text: `${e.name} has no free control connection (too many clients): ATEM Software Control or Companion may fail to connect` })
			else if (e.switch?.speed && minSpeed && e.switch.speed < minSpeed) a.push({ level: 'warn', scope: 'equipment', text: `${e.name} linked at ${e.switch.speed} Mb/s` })
		}
		for (const o of st.others) if (o.kind === 'pdu' && o.online && o.outlets && o.outletsOn < o.outlets) a.push({ level: 'info', scope: 'power', text: `${o.name}: ${o.outlets - o.outletsOn} outlet(s) switched off` })
		const order = { error: 0, warn: 1, info: 2 }
		a.sort((x, y) => order[x.level] - order[y.level])
		return a
	}
}

function safeHost(url) {
	try {
		return new URL(url).hostname
	} catch {
		return null
	}
}

// system-log records carry title_raw / message_raw with {PLACEHOLDERS} resolved from `parameters`
function normaliseLog(r) {
	if (!r || typeof r !== 'object') return null
	const params = r.parameters || {}
	const fill = (s) =>
		String(s || '').replace(/\{([A-Z_0-9]+)\}/g, (m, k) => {
			const p = params[k]
			if (p === undefined || p === null) return m
			if (typeof p !== 'object') return String(p)
			return p.name || p.hostname || p.ip || p.id || m
		})
	const t = r.timestamp || r.time
	const ts = typeof t === 'number' ? (t > 1e12 ? t : t * 1000) : t ? Date.parse(t) : Date.now()
	const ev = String(r.event || r.key || '')
	const sev = lower(r.severity)
	const bad = /DISCONNECT|LOST|DOWN|FAIL|OFFLINE|RESTART|ERROR|BLOCK|ROGUE|STP|LOOP|UPGRADE|ALERT|ISOLAT|OVERHEAT|POE/.test(ev)
	return {
		t: ts,
		category: r.category || r.type || '',
		event: ev,
		severity: /crit|high/.test(sev) ? 'error' : bad ? 'warn' : 'info',
		title: fill(r.title_raw || r.title).slice(0, 200),
		message: fill(r.message_raw || r.message).slice(0, 400),
		device: params.DEVICE?.name || params.CLIENT?.name || params.CLIENT?.hostname || null,
	}
}
