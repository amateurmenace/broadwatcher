// Blackmagic REST control API (Web Presenter, HyperDeck): http://<ip>/control/api/v1/...
// Read-only: stream status + bitrate on the Web Presenters, transport state on the HyperDecks.

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

export async function webPresenter(ip) {
	const [ls, prod] = await Promise.all([get(ip, 'livestreams/0'), product(ip)])
	if (!ls && !prod) return null
	return {
		kind: 'webpresenter',
		deviceName: prod?.deviceName || null,
		product: prod?.productName || null,
		version: prod?.softwareVersion || null,
		status: ls?.status || 'unknown', // Idle | Connecting | Streaming | Interrupted ...
		streaming: /stream/i.test(ls?.status || ''),
		bitrate: ls?.bitrate ?? null, // configured encoder bitrate (bits/s)
		cache: ls?.cache ?? null,
		format: ls?.effectiveVideoFormat || null,
		summary: ls ? `${ls.status}${ls.effectiveVideoFormat ? ' · ' + ls.effectiveVideoFormat : ''}${ls.bitrate ? ' · ' + (ls.bitrate / 1e6).toFixed(1) + ' Mb/s' : ''}` : 'no stream status',
	}
}

export async function hyperDeck(ip) {
	const [tr, rec, tc, prod] = await Promise.all([get(ip, 'transports/0'), get(ip, 'transports/0/record'), get(ip, 'transports/0/timecode'), product(ip)])
	if (!tr && !prod) return null
	const mode = tr?.mode || 'unknown'
	const recording = rec?.recording ?? mode === 'Record'
	return {
		kind: 'hyperdeck',
		deviceName: prod?.deviceName || null,
		product: prod?.productName || null,
		version: prod?.softwareVersion || null,
		mode,
		recording: !!recording,
		timecode: tc?.timecode || tc?.display || null,
		summary: recording ? `RECORDING${tc?.timecode ? ' ' + tc.timecode : ''}` : mode,
	}
}

export async function telemetry(kind, ip) {
	if (kind === 'webpresenter') return webPresenter(ip)
	if (kind === 'hyperdeck') return hyperDeck(ip)
	return null
}
