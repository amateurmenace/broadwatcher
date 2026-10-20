// Blackmagic REST control API (Web Presenter, HyperDeck): http://<ip>/control/api/v1/...
// Read-only. Web Presenters: stream status, encoder bitrate, cache, effective format. HyperDecks: transport
// state, record flag, timecode, the active disk with its remaining record time and space, the video and codec
// formats, playback state. Endpoints a firmware does not have simply answer 404 and are skipped.

async function get(ip, path, timeoutMs = 2500) {
	try {
		const r = await fetch(`http://${ip}/control/api/v1/${path}`, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } })
		if (!r.ok) return null
		return await r.json()
	} catch {
		return null
	}
}

const productCache = new Map()
async function product(ip) {
	const c = productCache.get(ip)
	if (c && Date.now() - c.t < 600000) return c.v
	const v = await get(ip, 'system/product')
	if (v) productCache.set(ip, { v, t: Date.now() })
	return v
}
// slow-changing things (formats, codec) once a minute
const slowCache = new Map()
async function slow(ip, path) {
	const k = ip + '|' + path
	const c = slowCache.get(k)
	if (c && Date.now() - c.t < 60000) return c.v
	const v = await get(ip, path)
	slowCache.set(k, { v, t: Date.now() })
	return v
}

export async function webPresenter(ip) {
	const [ls, prod, fmt] = await Promise.all([get(ip, 'livestreams/0'), product(ip), slow(ip, 'system/videoFormat')])
	if (!ls && !prod) return null
	return {
		kind: 'webpresenter',
		deviceName: prod?.deviceName || null,
		product: prod?.productName || null,
		version: prod?.softwareVersion || null,
		status: ls?.status || 'unknown', // Idle | Connecting | Streaming | Interrupted ...
		streaming: /stream/i.test(ls?.status || ''),
		bitrate: ls?.bitrate ?? null, // configured encoder bitrate (bits/s)
		cache: ls?.cache ?? null, // the stream cache fill (0 = empty); it grows when the uplink cannot keep up
		format: ls?.effectiveVideoFormat || null,
		inputFormat: fmt?.name || null,
		summary: ls ? `${ls.status}${ls.effectiveVideoFormat ? ' · ' + ls.effectiveVideoFormat : ''}${ls.bitrate ? ' · ' + (ls.bitrate / 1e6).toFixed(1) + ' Mb/s' : ''}` : 'no stream status',
	}
}

export async function hyperDeck(ip) {
	const [tr, rec, tc, prod, ws, act, vf, cf, pb] = await Promise.all([get(ip, 'transports/0'), get(ip, 'transports/0/record'), get(ip, 'transports/0/timecode'), product(ip), get(ip, 'media/workingset'), get(ip, 'media/active'), slow(ip, 'system/videoFormat'), slow(ip, 'system/codecFormat'), get(ip, 'transports/0/playback')])
	if (!tr && !prod) return null
	const mode = tr?.mode || 'unknown'
	const recording = rec?.recording ?? mode === 'Record'
	const disks = (ws?.workingset || []).filter(Boolean).map((d) => ({ index: d.index, name: d.deviceName || d.volume || `slot ${d.index + 1}`, volume: d.volume || null, active: !!d.activeDisk, remainingS: d.remainingRecordTime ?? null, free: d.remainingSpace ?? null, size: d.totalSpace ?? null, clips: d.clipCount ?? null }))
	const activeDisk = disks.find((d) => d.active) || disks.find((d) => d.name === act?.deviceName) || disks[0] || null
	return {
		kind: 'hyperdeck',
		deviceName: prod?.deviceName || null,
		product: prod?.productName || null,
		version: prod?.softwareVersion || null,
		mode,
		recording: !!recording,
		timecode: tc?.timecode || tc?.display || null,
		timeline: tc?.timeline || null,
		format: vf?.name || null,
		codec: cf?.codecFormat ? `${cf.codecFormat.codec}${cf.codecFormat.container ? ' ' + cf.codecFormat.container : ''}` : null,
		playback: pb ? { type: pb.type, speed: pb.speed, loop: !!pb.loop } : null,
		disks,
		activeDisk,
		remainingS: activeDisk?.remainingS ?? null,
		summary: `${recording ? 'RECORDING' + (tc?.timecode ? ' ' + tc.timecode : '') : mode}${activeDisk?.remainingS !== null && activeDisk?.remainingS !== undefined ? ` · ${Math.round(activeDisk.remainingS / 60)} min left on ${activeDisk.name}` : ''}`,
	}
}

export async function telemetry(kind, ip) {
	if (kind === 'webpresenter') return webPresenter(ip)
	if (kind === 'hyperdeck') return hyperDeck(ip)
	return null
}
