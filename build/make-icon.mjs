// Renders build/icon.png (1024x1024) without any image library: a paper-coloured rounded tile with the Broadwatch
// pulse line, matching ui/icon.svg. Run: node build/make-icon.mjs
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const SIZE = 1024
const SS = 3 // supersampling for anti-aliasing
const W = SIZE * SS
const px = new Float32Array(W * W * 4)

function blend(x, y, r, g, b, a) {
	if (x < 0 || y < 0 || x >= W || y >= W) return
	const i = (y * W + x) * 4
	const ia = 1 - a
	px[i] = px[i] * ia + r * a
	px[i + 1] = px[i + 1] * ia + g * a
	px[i + 2] = px[i + 2] * ia + b * a
	px[i + 3] = px[i + 3] * ia + 255 * a
}

// rounded rectangle with a vertical gradient
function roundedRect(x0, y0, x1, y1, rad, colorAt) {
	for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
		for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
			const cx = Math.min(Math.max(x, x0 + rad), x1 - rad)
			const cy = Math.min(Math.max(y, y0 + rad), y1 - rad)
			const d = Math.hypot(x - cx, y - cy)
			if (d > rad) continue
			const [r, g, b] = colorAt((y - y0) / (y1 - y0), (x - x0) / (x1 - x0))
			blend(x, y, r, g, b, 1)
		}
	}
}

function circle(cx, cy, rad, [r, g, b]) {
	for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++)
		for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) if (Math.hypot(x - cx, y - cy) <= rad) blend(x, y, r, g, b, 1)
}

function thickLine(x0, y0, x1, y1, width, color) {
	const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0))
	for (let s = 0; s <= steps; s++) {
		const t = s / steps
		circle(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, width / 2, color)
	}
}

const S = (v) => (v / 64) * W // ui/icon.svg uses a 64 unit viewBox
const bgTop = [250, 248, 243]
const bgBot = [236, 232, 223]
roundedRect(S(2), S(2), S(62), S(62), S(14), (t) => bgTop.map((c, i) => c + (bgBot[i] - c) * t))
// subtle border
const border = [194, 187, 171]
for (let k = 0; k < S(1.2); k++) {
	const inset = k
	roundedRectOutline(S(2) + inset, S(2) + inset, S(62) - inset, S(62) - inset, S(14) - inset, border)
}
function roundedRectOutline(x0, y0, x1, y1, rad, color) {
	const steps = 4000
	const perim = (x, y) => circle(x, y, 1.5, color)
	for (let s = 0; s < steps; s++) {
		const t = s / steps
		// walk the rounded rectangle path
		const L = 2 * (x1 - x0 - 2 * rad) + 2 * (y1 - y0 - 2 * rad) + 2 * Math.PI * rad
		let d = t * L
		const segs = [
			['h', x0 + rad, y0, x1 - rad, y0],
			['a', x1 - rad, y0 + rad, -Math.PI / 2, 0],
			['v', x1, y0 + rad, x1, y1 - rad],
			['a', x1 - rad, y1 - rad, 0, Math.PI / 2],
			['h', x1 - rad, y1, x0 + rad, y1],
			['a', x0 + rad, y1 - rad, Math.PI / 2, Math.PI],
			['v', x0, y1 - rad, x0, y0 + rad],
			['a', x0 + rad, y0 + rad, Math.PI, 1.5 * Math.PI],
		]
		for (const sg of segs) {
			const len = sg[0] === 'a' ? (Math.PI / 2) * rad : Math.hypot(sg[3] - sg[1], sg[4] - sg[2])
			if (d <= len) {
				if (sg[0] === 'a') {
					const ang = sg[3] + (d / len) * (sg[4] - sg[3])
					perim(sg[1] + Math.cos(ang) * rad, sg[2] + Math.sin(ang) * rad)
				} else perim(sg[1] + ((sg[3] - sg[1]) * d) / len, sg[2] + ((sg[4] - sg[2]) * d) / len)
				break
			}
			d -= len
		}
	}
}

const green = [194, 86, 27]
const blue = [31, 111, 139]
const pts = [
	[10, 40],
	[20, 40],
	[25, 24],
	[31, 50],
	[37, 30],
	[42, 40],
	[54, 40],
]
for (let i = 1; i < pts.length; i++) thickLine(S(pts[i - 1][0]), S(pts[i - 1][1]), S(pts[i][0]), S(pts[i][1]), S(4), green)
circle(S(54), S(40), S(4), blue)
circle(S(10), S(40), S(4), blue)

// downsample
const out = Buffer.alloc(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y++)
	for (let x = 0; x < SIZE; x++) {
		let r = 0, g = 0, b = 0, a = 0
		for (let dy = 0; dy < SS; dy++)
			for (let dx = 0; dx < SS; dx++) {
				const i = ((y * SS + dy) * W + (x * SS + dx)) * 4
				const al = px[i + 3] / 255
				r += px[i] * al
				g += px[i + 1] * al
				b += px[i + 2] * al
				a += al
			}
		const o = (y * SIZE + x) * 4
		if (a > 0) {
			out[o] = Math.round(r / a)
			out[o + 1] = Math.round(g / a)
			out[o + 2] = Math.round(b / a)
		}
		out[o + 3] = Math.round((a / (SS * SS)) * 255)
	}

// PNG encode
const crcTable = new Int32Array(256).map((_, n) => {
	let c = n
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
	return c
})
const crc32 = (buf) => {
	let c = -1
	for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
	return (c ^ -1) >>> 0
}
const chunk = (type, data) => {
	const len = Buffer.alloc(4)
	len.writeUInt32BE(data.length)
	const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
	const crc = Buffer.alloc(4)
	crc.writeUInt32BE(crc32(td))
	return Buffer.concat([len, td, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
for (let y = 0; y < SIZE; y++) {
	raw[y * (SIZE * 4 + 1)] = 0 // filter none
	out.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
const here = path.dirname(fileURLToPath(import.meta.url))
fs.writeFileSync(path.join(here, 'icon.png'), png)
console.log(`wrote build/icon.png (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(0)} kB)`)
