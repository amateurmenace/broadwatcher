// This computer's own load, for the roster entry that is this machine (the Broadcast Pix PC runs the server):
// CPU and memory from Node's os module, the GPU from nvidia-smi when it exists, free space on the fixed disks
// (PowerShell on Windows, df elsewhere), refreshed every 10 s; the GPU and disks every 30 s.
import os from 'node:os'
import { execFile } from 'node:child_process'

const run = (cmd, args, timeout = 8000) =>
	new Promise((resolve) => {
		try {
			execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? null : String(stdout)))
		} catch {
			resolve(null)
		}
	})

export class HostStats {
	constructor({ log = () => {} } = {}) {
		this.log = log
		this.prev = null
		this.cpu = null
		this.gpu = null
		this.gpuChecked = 0
		this.gpuMissing = false
		this.disks = []
		this.disksAt = 0
		this.t = 0
	}

	get addresses() {
		return Object.values(os.networkInterfaces())
			.flat()
			.filter((a) => a && a.family === 'IPv4' && !a.internal)
			.map((a) => a.address)
	}

	cpuNow() {
		const cpus = os.cpus()
		let idle = 0
		let total = 0
		for (const c of cpus) {
			for (const v of Object.values(c.times)) total += v
			idle += c.times.idle
		}
		const prev = this.prev
		this.prev = { idle, total }
		if (!prev || total === prev.total) return this.cpu
		this.cpu = Math.round((1 - (idle - prev.idle) / (total - prev.total)) * 100)
		return this.cpu
	}

	async gpuNow() {
		if (this.gpuMissing && Date.now() - this.gpuChecked < 600000) return this.gpu
		if (Date.now() - this.gpuChecked < 30000) return this.gpu
		this.gpuChecked = Date.now()
		const out = await run('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw', '--format=csv,noheader,nounits'])
		if (!out) {
			this.gpuMissing = true
			return (this.gpu = null)
		}
		this.gpuMissing = false
		const [name, util, memUsed, memTotal, temp, power] = out.trim().split('\n')[0].split(',').map((s) => s.trim())
		this.gpu = { name, util: Number(util) || 0, memUsed: Number(memUsed) || 0, memTotal: Number(memTotal) || 0, temp: Number(temp) || null, power: Number(power) || null }
		return this.gpu
	}

	async disksNow() {
		if (Date.now() - this.disksAt < 30000) return this.disks
		this.disksAt = Date.now()
		let list = []
		if (process.platform === 'win32') {
			const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { $_.DeviceID + '|' + $_.Size + '|' + $_.FreeSpace + '|' + $_.VolumeName }"])
			list = (out || '')
				.split('\n')
				.map((l) => l.trim().split('|'))
				.filter((p) => p.length >= 3 && Number(p[1]) > 0)
				.map((p) => ({ name: p[0] + (p[3] ? ' ' + p[3] : ''), size: Number(p[1]), free: Number(p[2]) }))
		} else {
			const out = await run('df', ['-kP'])
			list = (out || '')
				.split('\n')
				.slice(1)
				.map((l) => l.trim().split(/\s+/))
				.filter((p) => p.length >= 6 && /^\//.test(p[0]) && !/^\/(dev|run|sys|proc)/.test(p[5]))
				.map((p) => ({ name: p[5], size: Number(p[1]) * 1024, free: Number(p[3]) * 1024 }))
		}
		this.disks = list.slice(0, 8)
		return this.disks
	}

	async snapshot() {
		const cpu = this.cpuNow()
		const [gpu, disks] = await Promise.all([this.gpuNow(), this.disksNow()])
		const total = os.totalmem()
		const free = os.freemem()
		this.t = Date.now()
		return { kind: 'host', hostname: os.hostname(), platform: `${os.type()} ${os.release()}`, cpu, cores: os.cpus().length, cpuModel: os.cpus()[0]?.model || null, mem: { total, used: total - free, pct: Math.round(((total - free) / total) * 100) }, gpu, disks, uptime: os.uptime(), load: os.loadavg(), t: this.t, summary: `cpu ${cpu ?? '?'} % · ram ${Math.round(((total - free) / total) * 100)} %${gpu ? ` · gpu ${gpu.util} %` : ''}` }
	}
}
