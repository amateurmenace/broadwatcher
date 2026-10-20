// Broadcast health: one score (0-100) and a verdict computed from everything that affects a healthy stream,
// weighed against what the active show profile expects (streaming out, remote sources in, recorders rolling,
// mics on, Dante and NDI in use). Every factor carries its weight, its value (0-1), a one-line reason and a
// level, so the home view and the AI can show *why*. The AI narrates on top of the number; it never overrules it.
//
// Verdict: >= 90 Ready, >= 72 Degraded, >= 50 At risk, below Down. A critical factor at zero (WAN down, the
// switcher off the network, an interrupted outgoing stream) makes it at least "At risk"; two of them, "Down".
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0)
const pct = (x) => Math.round(x * 100)

export const PROFILE_DEFAULTS = [
	{ id: 'studio', name: 'Studio Town Meeting', expect: { stream_out: true, stream_in: true, recording: true, mics: true, dante: true, ndi: true } },
	{ id: 'field', name: 'Field production', expect: { stream_out: true, stream_in: false, recording: true, mics: false, dante: false, ndi: false } },
	{ id: 'rehearsal', name: 'Rehearsal', expect: { stream_out: false, stream_in: false, recording: false, mics: true, dante: true, ndi: true } },
	{ id: 'idle', name: 'Off air', expect: { stream_out: false, stream_in: false, recording: false, mics: false, dante: false, ndi: false } },
]

export function computeHealth(state, profile, th = {}) {
	const expect = { stream_out: false, stream_in: false, recording: false, mics: false, dante: false, ndi: false, ...(profile?.expect || {}) }
	const F = []
	const factor = (id, label, weight, value, reason, { critical = false, na = false, target = null } = {}) => {
		const v = na ? null : Math.max(0, Math.min(1, num(value)))
		const level = na ? 'na' : v >= 0.85 ? 'ok' : v >= 0.5 ? 'warn' : 'bad'
		F.push({ id, label, weight, value: v, reason, level, critical, target })
	}
	const gw = state.gateway
	const eq = (state.equipment || []).filter((e) => e.active && !e.discovered)
	const hero = state.atem?.equipment || eq.find((e) => e.hero) || null
	const online = (list) => list.filter((e) => e.online && e.reachable !== false)
	const sw = (state.switches || []).filter((s) => s.online || (s.lastSeen && Date.now() - s.lastSeen < 86400000))
	const swWithGear = new Set(eq.filter((e) => e.switch).map((e) => e.switch.mac))

	// ---- network
	if (!gw) factor('wan', 'Internet', 14, 0, 'the gateway is not in the UniFi device list', { critical: true, target: { type: 'wan' } })
	else if (gw.wan.status !== 'ok') factor('wan', 'Internet', 14, 0, `WAN ${gw.wan.status}`, { critical: true, target: { type: 'wan' } })
	else if (gw.wan.latency !== null && gw.wan.latency > num(th.wan_latency_ms || 80)) factor('wan', 'Internet', 14, 0.6, `WAN up but ${gw.wan.latency} ms latency`, { target: { type: 'wan' } })
	else factor('wan', 'Internet', 14, 1, `WAN ok · ${gw.wan.latency ?? '–'} ms · ${gw.wan.isp || ''}`.trim(), { target: { type: 'wan' } })
	if (gw) factor('gateway', 'Gateway', 4, gw.cpu !== null && gw.cpu > num(th.cpu_pct || 85) ? 0.4 : 1, gw.cpu !== null && gw.cpu > num(th.cpu_pct || 85) ? `gateway CPU ${gw.cpu}%` : `gateway CPU ${gw.cpu ?? '–'}%`, { target: { type: 'gateway', id: gw.mac } })
	const offGear = sw.filter((s) => !s.online && swWithGear.has(s.mac))
	const offOther = sw.filter((s) => !s.online && !swWithGear.has(s.mac))
	if (offGear.length) factor('switches', 'Switches', 14, 0, `${offGear.map((s) => s.name).join(', ')} offline with broadcast gear on it`, { critical: true, target: { type: 'switch', id: offGear[0].mac } })
	else if (offOther.length) factor('switches', 'Switches', 14, 0.7, `${offOther.length} switch${offOther.length === 1 ? '' : 'es'} seen today now offline (no broadcast gear on them)`, { target: { type: 'switch', id: offOther[0].mac } })
	else factor('switches', 'Switches', 14, 1, `${sw.filter((s) => s.online).length} switches online`)
	// damaged frames and flapping links on broadcast or uplink ports weigh more than frames dropped for congestion
	const errPorts = (state.switches || []).filter((s) => s.online).flatMap((s) => s.ports.filter((p) => p.errorsRecent && (p.uplink || p.clients.some((c) => eq.some((e) => e.ip === c.ip)))).map((p) => ({ n: `${s.name} p${p.idx}`, cause: p.err?.cause || 'errors', key: p.key })))
	const damaged = errPorts.filter((p) => p.cause === 'errors' || p.cause === 'flaps')
	const congested = errPorts.filter((p) => p.cause === 'drops' || p.cause === 'rxdrops')
	factor('errors', 'Port errors', 5, damaged.length ? 0.3 : congested.length ? 0.6 : 1, damaged.length ? `damaged frames or a flapping link on ${damaged.map((p) => p.n).slice(0, 3).join(', ')}${damaged.length > 3 ? '…' : ''}` : congested.length ? `frames dropped for congestion on ${congested.map((p) => p.n).slice(0, 3).join(', ')}${congested.length > 3 ? '…' : ''}` : 'no new errors on broadcast or uplink ports', errPorts[0] ? { target: { type: 'port', id: errPorts[0].key } } : {})
	const slow = eq.filter((e) => e.switch?.speed && (e.min_speed ?? (['switcher', 'encoder', 'recorder', 'computer'].includes(e.role) ? 1000 : 0)) > e.switch.speed)
	const slowUp = (state.switches || []).filter((s) => s.online && s.uplink.speed && s.uplink.speed < 1000 && s.uplink.media !== 'wireless')
	factor('links', 'Link speeds', 5, slow.length ? 0.4 : slowUp.length ? 0.6 : 1, slow.length ? `${slow.map((e) => e.name).join(', ')} below the needed link speed` : slowUp.length ? `${slowUp.map((s) => s.name).join(', ')} uplink below 1G` : 'every broadcast link at full speed')
	// a port near line rate: say who is on it and how fast the link is, since a 100M link at 100 % is a different
	// problem (a slow negotiation or an old device) from a 1G link at 100 % (a real flood)
	const hot = (state.switches || []).filter((s) => s.online).flatMap((s) => s.ports.filter((p) => p.up && p.util > 0.7).map((p) => ({ n: `${s.name} p${p.idx}${p.label ? ' ' + p.label : p.clients?.[0] ? ' ' + (p.clients[0].name || p.clients[0].ip) : ''}${p.speed ? ` at ${p.speed >= 1000 ? p.speed / 1000 + 'G' : p.speed + 'M'}` : ''}`, u: p.util, key: p.key }))).sort((a, b) => b.u - a.u)
	factor('util', 'Port load', 4, hot.some((p) => p.u > 0.9) ? 0.2 : hot.length ? 0.5 : 1, hot.length ? `${hot.map((p) => `${p.n} ${pct(p.u)}%`).slice(0, 3).join(', ')}` : 'no port above 70 % of its link', hot[0]?.key ? { target: { type: 'port', id: hot[0].key } } : {})

	// ---- the switcher and the roster
	if (!hero) factor('switcher', 'Switcher', 12, 0.5, 'no main switcher in the roster', { na: true })
	else if (!hero.online) factor('switcher', 'Switcher', 12, 0, `${hero.name} is not on the network`, { critical: true, target: { type: 'equipment', id: hero.ip } })
	else if (hero.reachable === false) factor('switcher', 'Switcher', 12, 0.5, `${hero.name} on the network but not answering (${hero.probe?.error || 'no reply'})`, { target: { type: 'equipment', id: hero.ip } })
	else factor('switcher', 'Switcher', 12, 1, `${hero.name} up${hero.telemetry?.programName ? ' · program ' + hero.telemetry.programName : ''}`, { target: { type: 'equipment', id: hero.ip } })
	const rest = eq.filter((e) => e !== hero)
	const restOk = online(rest)
	const restBad = rest.filter((e) => !restOk.includes(e))
	factor('roster', 'Equipment', 10, rest.length ? restOk.length / rest.length : 1, rest.length ? (restBad.length ? `${restBad.map((e) => e.name).slice(0, 3).join(', ')}${restBad.length > 3 ? ` +${restBad.length - 3}` : ''} not answering` : `all ${rest.length} devices in this broadcast answer`) : 'no other devices in the roster', { target: restBad[0] ? { type: 'equipment', id: restBad[0].ip } : null })

	// ---- streams out
	const encoders = eq.filter((e) => e.telemetry?.kind === 'webpresenter' || (e.telemetry?.kind === 'atem' && e.telemetry.streaming))
	const live = encoders.filter((e) => (e.telemetry.kind === 'webpresenter' && e.telemetry.streaming) || (e.telemetry.kind === 'atem' && e.telemetry.streaming?.state === 'streaming'))
	const broken = encoders.filter((e) => e.telemetry.kind === 'webpresenter' && /interrupt|error|fail/i.test(e.telemetry.status || ''))
	const connecting = encoders.filter((e) => (e.telemetry.kind === 'webpresenter' && /connect/i.test(e.telemetry.status || '')) || (e.telemetry.kind === 'atem' && /connect|stopping/.test(e.telemetry.streaming?.state || '')))
	const outRate = live.reduce((n, e) => n + num(e.telemetry.kind === 'webpresenter' ? e.telemetry.bitrate : e.telemetry.streaming?.bitrate) / 1e6, 0)
	if (!encoders.length) factor('stream_out', 'Stream out', 10, 0, 'no encoder with telemetry in the roster', { na: true })
	else if (broken.length) factor('stream_out', 'Stream out', 10, 0, `${broken.map((e) => e.name).join(', ')}: stream ${broken[0].telemetry.status}`, { critical: expect.stream_out, target: { type: 'equipment', id: broken[0].ip } })
	else if (live.length) factor('stream_out', 'Stream out', 10, 1, `${live.map((e) => e.name).join(', ')} streaming${outRate ? ' at ' + outRate.toFixed(1) + ' Mb/s' : ''}`, { target: { type: 'equipment', id: live[0].ip } })
	else if (connecting.length) factor('stream_out', 'Stream out', 10, 0.5, `${connecting.map((e) => e.name).join(', ')} connecting`, { target: { type: 'equipment', id: connecting[0].ip } })
	else if (expect.stream_out) factor('stream_out', 'Stream out', 10, 0.2, `the profile expects a stream out but ${encoders.map((e) => e.name).join(', ')} ${encoders.length === 1 ? 'is' : 'are'} idle`, { target: { type: 'equipment', id: encoders[0].ip } })
	else factor('stream_out', 'Stream out', 10, 1, `idle (not expected in "${profile?.name || 'this profile'}")`, { target: { type: 'equipment', id: encoders[0].ip } })

	// ---- streams in
	const st = state.atem?.stream
	const paths = state.streamPaths || []
	const heroPath = paths.find((p) => p.target.isAtem) || null
	if (!hero) factor('stream_in', 'Stream in', 8, 0, 'no main switcher', { na: true })
	else if (st?.state === 'arriving') factor('stream_in', 'Stream in', 8, 1, `arriving at ${st.rate} Mb/s${st.sources?.[0] ? ' from ' + st.sources[0].name : ''}`, { target: { type: 'atem' } })
	else if (paths.some((p) => p.status === 'red')) factor('stream_in', 'Stream in', 8, 0.2, paths.find((p) => p.status === 'red').verdict, { target: { type: 'path', id: paths.find((p) => p.status === 'red').id } })
	else if (heroPath?.status === 'amber') factor('stream_in', 'Stream in', 8, 0.5, heroPath.verdict, { target: { type: 'path', id: heroPath.id } })
	else if (expect.stream_in) factor('stream_in', 'Stream in', 8, 0.3, 'no remote stream arriving yet (the profile expects one)', { target: { type: 'atem' } })
	else factor('stream_in', 'Stream in', 8, 1, 'quiet (none expected)', { target: { type: 'atem' } })

	// ---- recorders
	const decks = eq.filter((e) => e.telemetry?.kind === 'hyperdeck')
	const rolling = decks.filter((e) => e.telemetry.recording)
	const heroRec = hero?.telemetry?.recording?.active ? 1 : 0
	if (!decks.length && !hero?.telemetry?.recording) factor('recorders', 'Recorders', 8, 0, 'no recorder with telemetry', { na: true })
	else {
		const total = decks.length + (hero?.telemetry?.recording ? 1 : 0)
		const on = rolling.length + heroRec
		const txt = `${on}/${total} recording${rolling.length ? ' · ' + rolling.map((e) => e.name).join(', ') : ''}${heroRec ? ' · switcher ISO' : ''}`
		if (expect.recording) factor('recorders', 'Recorders', 8, total ? (on === total ? 1 : on ? 0.5 : 0.1) : 1, on === total ? txt : `only ${txt} (the profile expects all)`, { target: decks[0] ? { type: 'equipment', id: decks[0].ip } : { type: 'atem' } })
		else factor('recorders', 'Recorders', 8, 1, on ? txt : `idle (not expected in "${profile?.name || 'this profile'}")`, { target: decks[0] ? { type: 'equipment', id: decks[0].ip } : { type: 'atem' } })
	}

	// ---- audio: the X32 consoles stream their meters (OSC); the wireless mics report link, battery and RF (SSC)
	const au = state.audio
	const consoles = eq.filter((e) => /^x32/.test(String(e.probeSpec || '')))
	if (!consoles.length) factor('audio', 'Audio', 6, 0, 'no X32 in the roster', { na: true })
	else {
		const snap = (e) => (au?.consoles || []).find((c) => c.ip === e.ip) || null
		const live = consoles.filter((e) => snap(e)?.ok)
		const quiet = consoles.filter((e) => !snap(e)?.ok && (snap(e)?.answered || e.probe?.ok))
		const dead = consoles.filter((e) => !live.includes(e) && !quiet.includes(e))
		const v = (live.length + quiet.length * 0.6) / consoles.length
		const liveTxt = live.map((e) => {
			const c = snap(e)
			return `${c.console?.name || e.name}: ${c.active} channel${c.active === 1 ? '' : 's'} with signal, main ${c.mainLevel !== null && c.mainLevel > -60 ? c.mainLevel.toFixed(0) + ' dBFS' : 'quiet'}`
		})
		const badTxt = [...quiet.map((e) => `${e.name} answers but sends no meters`), ...dead.map((e) => `${e.name} not answering`)]
		factor('audio', 'Audio', 6, v, [...liveTxt, ...badTxt].join(' · ') || 'waiting for the first meters', { target: { type: 'equipment', id: (dead[0] || quiet[0] || consoles[0]).ip } })
	}
	const mics = eq.filter(isMic)
	if (!mics.length) factor('mics', 'Mics', 4, 0, 'no wireless receivers in the roster', { na: true })
	else {
		const snap = (e) => (au?.mics || []).find((m) => m.ip === e.ip) || null
		const answering = mics.filter((e) => snap(e)?.ok)
		const silent = mics.filter((e) => !snap(e)?.ok)
		const chans = answering.flatMap((e) => snap(e).channels.map((c) => ({ ...c, rxIp: e.ip, who: c.name || c.id })))
		const linked = chans.filter((c) => c.link)
		const lowBatt = linked.filter((c) => c.battery !== null && c.battery < num(th.mic_battery_pct || 20))
		const weakRf = linked.filter((c) => c.rsqi !== null && c.rsqi < num(th.mic_rf_pct || 30))
		const muted = linked.filter((c) => c.mute || c.tx?.mute)
		const problems = [...lowBatt.map((c) => `${c.who} battery ${c.battery} %`), ...weakRf.map((c) => `${c.who} RF ${c.rsqi} %`), ...(expect.mics ? muted.map((c) => `${c.who} muted`) : [])]
		const worst = lowBatt[0] || weakRf[0] || (expect.mics ? muted[0] : null) || null
		let v
		let reason
		if (!answering.length) {
			const up = mics.filter((e) => e.online)
			v = expect.mics ? 0 : up.length ? 0.9 : 0.6
			reason = `${up.length}/${mics.length} receivers on the network, none answering SSC (UDP 45)${expect.mics ? ' · the profile expects mics' : ''}`
		} else if (expect.mics) {
			// spare channels with the transmitter off do not count against a show; the ones on air must be healthy
			const good = linked.filter((c) => !lowBatt.includes(c) && !weakRf.includes(c) && !muted.includes(c)).length
			v = linked.length ? good / linked.length : 0.2
			reason = linked.length ? `${linked.length}/${chans.length} mics on air${problems.length ? ' · ' + problems.join(', ') : ' · batteries and RF fine'}` : `${chans.length} receiver channels, no transmitter on (the profile expects mics)`
		} else {
			v = problems.length ? 0.7 : 1
			reason = linked.length ? `${linked.length}/${chans.length} mics on${problems.length ? ' · ' + problems.join(', ') : ' · batteries and RF fine'}` : `${answering.length} receiver${answering.length === 1 ? '' : 's'} answering, transmitters off (none expected in "${profile?.name || 'this profile'}")`
		}
		if (silent.length && answering.length) reason += ` · ${silent.map((e) => e.name).join(', ')} not answering SSC`
		factor('mics', 'Mics', 4, v, reason, { target: { type: 'equipment', id: worst?.rxIp || silent[0]?.ip || mics[0].ip } })
	}
	const vlan = (re) => (state.networks || []).filter((n) => re.test(n.name))
	const dante = vlan(/dante/i)
	const danteGear = eq.filter((e) => dante.some((n) => n.subnet && sameSubnet(e.ip, n.subnet)))
	if (!dante.length) factor('dante', 'Dante', 5, 0, 'no Dante VLAN', { na: true })
	else {
		const clients = dante.reduce((n, v) => n + num(v.clients), 0)
		const gearUp = danteGear.filter((e) => e.online).length
		const v = !expect.dante ? 1 : danteGear.length ? gearUp / danteGear.length : clients ? 1 : 0.3
		factor('dante', 'Dante', 5, v, `${dante.map((n) => `${n.name.replace(/^BIG_/, '')} ${n.clients} devices`).join(' · ')}${danteGear.length ? ` · ${gearUp}/${danteGear.length} roster devices up` : ''} · clock status needs a VLAN foot (roadmap)`, { target: { type: 'vlan', id: dante[0].name } })
	}
	const ndi = vlan(/ndi/i)
	const ndiGear = eq.filter((e) => ndi.some((n) => n.subnet && sameSubnet(e.ip, n.subnet)))
	if (!ndi.length) factor('ndi', 'NDI', 5, 0, 'no NDI VLAN', { na: true })
	else {
		const traffic = ndi.reduce((n, v) => n + num(v.down) + num(v.up), 0)
		const gearUp = ndiGear.filter((e) => e.online).length
		const v = !expect.ndi ? 1 : ndiGear.length ? gearUp / ndiGear.length : traffic > 0.5 ? 1 : 0.4
		factor('ndi', 'NDI', 5, v, `${ndi.map((n) => `${n.name.replace(/^BIG_/, '')} ${n.clients} devices · ${traffic.toFixed(1)} Mb/s`).join(' · ')}${ndiGear.length ? ` · ${gearUp}/${ndiGear.length} roster devices up` : ''}`, { target: { type: 'vlan', id: ndi[0].name } })
	}
	const errs = (state.alerts || []).filter((a) => a.level === 'error')
	factor('alerts', 'Alerts', 8, errs.length ? 0.2 : 1, errs.length ? `${errs.length} error-level alert${errs.length === 1 ? '' : 's'}: ${errs[0].text}` : 'no error-level alerts', { target: errs[0] ? { type: 'alert', id: errs[0].id } : null })

	// ---- the score
	const scored = F.filter((f) => f.value !== null)
	const wsum = scored.reduce((n, f) => n + f.weight, 0)
	const score = wsum ? Math.round((scored.reduce((n, f) => n + f.weight * f.value, 0) / wsum) * 100) : 0
	const crit = scored.filter((f) => f.critical && f.value === 0)
	let verdict = score >= 90 ? 'READY' : score >= 72 ? 'DEGRADED' : score >= 50 ? 'AT RISK' : 'DOWN'
	const rank = { READY: 0, DEGRADED: 1, 'AT RISK': 2, DOWN: 3 }
	if (crit.length >= 2 && rank[verdict] < 3) verdict = 'DOWN'
	else if (crit.length && rank[verdict] < 2) verdict = 'AT RISK'
	const detractors = scored.filter((f) => f.value < 1).sort((a, b) => b.weight * (1 - b.value) - a.weight * (1 - a.value))
	const headline = verdict === 'READY' ? `Everything "${profile?.name || 'this profile'}" needs is up.` : detractors.length ? detractors.slice(0, 2).map((f) => f.reason).join('; ') : 'nothing to report'
	return { score, verdict, headline, factors: F, detractors: detractors.slice(0, 5).map((f) => f.id), profile: profile ? { id: profile.id, name: profile.name, expect } : null, t: Date.now() }
}

// wireless receivers: by name (EW-DX, "receiver", "wireless mic") or by vendor (Sennheiser, Shure)
export const isMic = (e) => /ew-?dx?\b|\breceiver\b|wireless\s*mic|\bmics?\b/i.test(e.name || '') || /sennheiser|shure/i.test(e.oui || '')

function sameSubnet(ip, cidr) {
	const [net, bitsStr] = String(cidr).split('/')
	const bits = Number(bitsStr || 24)
	const toN = (s) => s.split('.').reduce((n, o) => ((n << 8) | (Number(o) & 255)) >>> 0, 0)
	if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip || '') || !/^\d+\.\d+\.\d+\.\d+$/.test(net || '')) return false
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
	return (toN(ip) & mask) === (toN(net) & mask)
}

// the eight tiles of the home view (and the phone page): lamp, one number, one line, a 10-minute series
export function tiles(state, health) {
	const f = Object.fromEntries((health?.factors || []).map((x) => [x.id, x]))
	const eq = (state.equipment || []).filter((e) => e.active)
	const hero = state.atem?.equipment || null
	const gw = state.gateway
	const live = eq.filter((e) => (e.telemetry?.kind === 'webpresenter' && e.telemetry.streaming) || (e.telemetry?.kind === 'atem' && e.telemetry.streaming?.state === 'streaming'))
	const outRate = live.reduce((n, e) => n + num(e.telemetry.kind === 'webpresenter' ? e.telemetry.bitrate : e.telemetry.streaming?.bitrate) / 1e6, 0)
	const enc = eq.find((e) => e.telemetry?.kind === 'webpresenter')
	const decks = eq.filter((e) => e.telemetry?.kind === 'hyperdeck')
	const rolling = decks.filter((e) => e.telemetry.recording)
	const consoles = eq.filter((e) => /^x32/.test(String(e.probeSpec || '')))
	const mics = eq.filter(isMic)
	const au = state.audio
	const consolesLive = (au?.consoles || []).filter((c) => c.ok && consoles.some((e) => e.ip === c.ip))
	const micChans = (au?.mics || []).filter((m) => m.ok && mics.some((e) => e.ip === m.ip)).flatMap((m) => m.channels)
	const nets = state.networks || []
	const dante = nets.filter((n) => /dante/i.test(n.name))
	const ndi = nets.filter((n) => /ndi/i.test(n.name))
	const sw = state.switches || []
	const rate = (v) => (v >= 1000 ? (v / 1000).toFixed(2) + ' Gb/s' : v >= 100 ? v.toFixed(0) + ' Mb/s' : v >= 1 ? v.toFixed(1) + ' Mb/s' : v > 0 ? Math.round(v * 1000) + ' kb/s' : '0')
	const lvl = (id) => f[id]?.level || 'na'
	const sum = (arrs) => {
		const n = Math.max(0, ...arrs.map((a) => a.length))
		return Array.from({ length: n }, (_, i) => arrs.reduce((s, a) => s + num(a[a.length - n + i]), 0))
	}
	// the switcher tile joins the stream in, the switcher's own stream out and its record state; every tile opens
	// its own side panel (type = the tile id, rendered by the page from the live state)
	const worst = (ids) => (ids.map(lvl).includes('bad') ? 'bad' : ids.map(lvl).includes('warn') ? 'warn' : ids.every((i) => lvl(i) === 'na') ? 'na' : 'ok')
	const tl = hero?.telemetry || null
	const st = state.atem?.stream || null
	const held = (state.forensics?.sessions || []).filter((s) => s.state === 'held').length
	const switcherLine = hero
		? [
				st?.state === 'arriving' ? `stream in ${rate(st.rate)}` : 'no stream in',
				tl?.streaming?.state === 'streaming' ? `streaming out${tl.streaming.bitrate ? ' ' + rate(tl.streaming.bitrate / 1e6) : ''}` : null,
				tl?.recording?.active ? `ISO recording ${tl.recording.duration || ''}` : null,
				tl?.programName ? `program ${tl.programName}` : null,
				held ? `${held} control session${held === 1 ? '' : 's'}` : null,
			]
				.filter(Boolean)
				.join(' · ')
		: 'no switcher in the roster'
	const switcherName = (state.atem?.name || 'Switcher').replace(/^ATEM Television Studio\s*/i, 'ATEM ').replace(/\s*ISO$/i, '')
	return [
		{ id: 'switcher', label: switcherName, level: hero ? worst(['switcher', 'stream_in']) : 'na', value: hero ? (hero.status !== 'online' ? hero.status : st?.state === 'arriving' ? rate(hero.down) : tl?.programName ? tl.programName : 'up') : '–', unit: hero && hero.status === 'online' && st?.state === 'arriving' ? 'in' : hero && tl?.programName ? 'on program' : '', line: switcherLine, series: hero ? hero.history?.down || [] : [], target: { type: 'switcher' } },
		{ id: 'encoders', label: 'Stream out', level: lvl('stream_out'), value: live.length ? rate(outRate) : enc ? enc.telemetry.status || 'idle' : '–', line: f.stream_out?.reason || '', series: enc ? enc.history?.up || [] : [], target: { type: 'encoders' } },
		{ id: 'recorders', label: 'Recorders', level: lvl('recorders'), value: decks.length || hero?.telemetry?.recording ? `${rolling.length + (hero?.telemetry?.recording?.active ? 1 : 0)}/${decks.length + (hero?.telemetry?.recording ? 1 : 0)}` : '–', line: f.recorders?.reason || '', series: [], target: { type: 'recorders' }, unit: 'rolling' },
		{ id: 'audio', label: 'Audio', level: lvl('audio'), value: consoles.length ? `${consolesLive.length}/${consoles.length}` : '–', line: f.audio?.reason || '', series: [], target: { type: 'audio' }, unit: consoles.length ? 'consoles live' : '', strip: 'x32' },
		{ id: 'mics', label: 'Mics', level: lvl('mics'), value: !mics.length ? '–' : micChans.length ? `${micChans.filter((c) => c.link).length}/${micChans.length}` : `${mics.filter((e) => e.online).length}/${mics.length}`, unit: !mics.length ? '' : micChans.length ? 'on air' : 'receivers', line: f.mics?.reason || '', series: [], target: { type: 'mics' }, strip: 'mics' },
		{ id: 'dante', label: 'Dante', level: lvl('dante'), value: dante.length ? `${dante.reduce((n, v) => n + num(v.clients), 0)}` : '–', line: f.dante?.reason || '', series: sum(dante.map((n) => n.history?.down || [])), target: { type: 'dante' }, unit: 'devices' },
		{ id: 'ndi', label: 'NDI', level: lvl('ndi'), value: ndi.length ? rate(ndi.reduce((n, v) => n + num(v.down) + num(v.up), 0)) : '–', line: f.ndi?.reason || '', series: sum(ndi.map((n) => n.history?.down || [])), target: { type: 'ndi' } },
		{ id: 'network', label: 'Network', level: worst(['wan', 'switches', 'errors', 'links', 'util', 'gateway']), value: gw ? `${sw.filter((s) => s.online).length}/${sw.length}` : '–', line: [f.wan, f.switches, f.errors, f.links, f.util].filter((x) => x && x.value !== null && x.value < 1).map((x) => x.reason)[0] || `${f.wan?.reason || ''}`, series: gw ? gw.wan.history?.down || [] : [], target: { type: 'network' }, unit: 'switches' },
	]
}
