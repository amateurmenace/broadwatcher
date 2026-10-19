// Electron shell: starts the Broadwatcher server in-process and shows the dashboard in a window.
import { app, BrowserWindow, Menu, shell, dialog, nativeTheme } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startServer, loadConfig, saveUserConfig } from './server/server.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// flavour: "private" (BIG's own build, config.json with the site's keys) or "public" (Broadwatcher Community,
// config.public.json without keys; scripts/build-flavor.mjs sets package.json flavor at build time)
let FLAVOR = process.env.BW_FLAVOR || 'private'
try {
	FLAVOR = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).flavor || FLAVOR
} catch {}
const BUNDLED_CONFIG = path.join(__dirname, FLAVOR === 'public' ? 'config.public.json' : 'config.json')

app.setName(FLAVOR === 'public' ? 'Broadwatcher Community' : 'Broadwatcher')
nativeTheme.themeSource = 'dark'

// one Broadwatcher per machine: a second copy would open a second session with every switcher it watches
// (each ATEM has only a handful of control slots) and poll the gateway twice
// (a development copy with NETWATCH_PORT set, and the --smoke build check, may run beside the installed app)
const DEV = !!process.env.NETWATCH_PORT || process.argv.includes('--smoke')
if (!DEV && !app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => {
	if (win) {
		if (win.isMinimized()) win.restore()
		win.focus()
	}
})

const userConfig = () => path.join(app.getPath('userData'), 'config.json')

function ensureUserConfig() {
	const p = userConfig()
	if (!fs.existsSync(p)) {
		try {
			fs.mkdirSync(path.dirname(p), { recursive: true })
			fs.copyFileSync(BUNDLED_CONFIG, p)
		} catch (e) {
			console.error('could not create user config:', e.message)
		}
	}
	return p
}

let running = null
let win = null

async function boot() {
	const cfgPath = ensureUserConfig()
	const config = loadConfig(BUNDLED_CONFIG, cfgPath)
	const port = Number(process.env.NETWATCH_PORT || config.server?.port || 8766)
	const host = process.env.NETWATCH_HOST || config.server?.host || '127.0.0.1'
	try {
		running = await startServer({ config, configPath: cfgPath, host, port })
	} catch (e) {
		// port taken (another Broadwatcher or the standalone server): fall back to a random port
		running = await startServer({ config, configPath: cfgPath, host, port: 0 })
	}
	maybeStartCompanion(config).catch(() => {})
	return running
}

// Companion holds the control session with the switcher that Broadwatcher reads through its HTTP API, so if
// Companion is not running when Broadwatcher starts, start it (config companion.autostart, default on)
function companionExe() {
	if (process.platform === 'win32') {
		const candidates = [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Companion', 'Companion.exe'), path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Companion', 'Companion.exe')]
		return candidates.find((p) => p && fs.existsSync(p)) || null
	}
	if (process.platform === 'darwin') return fs.existsSync('/Applications/Companion.app') ? '/Applications/Companion.app' : null
	return null
}
async function companionUp(url) {
	try {
		const r = await fetch(url.replace(/\/+$/, '') + '/api/connections', { signal: AbortSignal.timeout(2000) })
		return r.ok
	} catch {
		return false
	}
}
async function maybeStartCompanion(config, force = false) {
	const cfg = config.companion || {}
	if (!force && cfg.autostart === false) return 'autostart is off'
	const url = cfg.url || 'http://127.0.0.1:8000'
	if (!/127\.0\.0\.1|localhost/.test(url)) return 'Companion runs on another machine'
	if (await companionUp(url)) return 'Companion is already running'
	const exe = companionExe()
	if (!exe) return 'Companion is not installed on this machine'
	try {
		const child = process.platform === 'darwin' ? spawn('open', ['-a', exe], { detached: true, stdio: 'ignore' }) : spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false })
		child.unref()
		running?.collector?.event('device', `Companion was not running: started ${path.basename(exe)} so it can hold the switcher session`)
		return 'Companion started'
	} catch (e) {
		return 'could not start Companion: ' + e.message
	}
}

function createWindow(url) {
	win = new BrowserWindow({
		width: 1680,
		height: 1050,
		minWidth: 960,
		minHeight: 640,
		backgroundColor: '#f3f0e8',
		title: 'Broadwatcher',
		autoHideMenuBar: false,
		webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
	})
	win.loadURL(url)
	// `electron . --smoke` : prove the window loads the dashboard, then quit (used by the build check)
	if (process.argv.includes('--smoke')) {
		win.webContents.once('did-finish-load', async () => {
			const title = await win.webContents.executeJavaScript('document.title')
			const cards = await win.webContents.executeJavaScript('document.querySelectorAll(".ru, .pb, [data-node]").length')
			console.log(`SMOKE OK: loaded ${url} title="${title}" cards=${cards}`)
			setTimeout(() => app.quit(), 1500)
		})
		win.webContents.once('did-fail-load', (_e, code, desc) => {
			console.log(`SMOKE FAIL: ${code} ${desc}`)
			app.exit(1)
		})
	}
	win.webContents.setWindowOpenHandler(({ url: target }) => {
		shell.openExternal(target)
		return { action: 'deny' }
	})
	win.on('closed', () => (win = null))
}

function buildMenu() {
	const isMac = process.platform === 'darwin'
	const cfg = loadConfig(BUNDLED_CONFIG, userConfig())
	const template = [
		...(isMac ? [{ role: 'appMenu' }] : []),
		{
			label: 'Broadwatcher',
			submenu: [
				{ label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => win?.webContents.executeJavaScript('window.Settings && Settings.open()').catch(() => {}) },
				{ label: 'Reload dashboard', accelerator: 'CmdOrCtrl+R', click: () => win?.reload() },
				{ label: 'Open in browser', click: () => running && shell.openExternal(running.url) },
				{ type: 'separator' },
				{ label: 'Open config file', click: () => shell.showItemInFolder(userConfig()) },
				{
					label: 'Restart server (re-read config)',
					click: async () => {
						running?.close()
						running = await boot()
						win?.loadURL(running.url)
					},
				},
				{ label: 'Reset config to defaults', click: resetConfig },
				{ type: 'separator' },
				{
					label: 'Start Companion now',
					click: async () => {
						const msg = await maybeStartCompanion(loadConfig(BUNDLED_CONFIG, userConfig()), true)
						dialog.showMessageBox(win, { type: 'info', message: msg })
					},
				},
				{
					label: 'Start Companion with Broadwatcher',
					type: 'checkbox',
					checked: cfg.companion?.autostart !== false,
					click: (item) => {
						saveUserConfig(userConfig(), { companion: { ...(cfg.companion || {}), autostart: item.checked } })
						if (running?.collector) running.collector.cfg.companion = { ...(running.collector.cfg.companion || {}), autostart: item.checked }
					},
				},
				{ type: 'separator' },
				{
					label: 'Open UniFi Network',
					click: () => {
						const g = loadConfig(BUNDLED_CONFIG, userConfig()).gateway || {}
						shell.openExternal(g.ui_url || g.url || 'https://192.168.1.1')
					},
				},
				{ type: 'separator' },
				isMac ? { role: 'close' } : { role: 'quit' },
			],
		},
		{ role: 'viewMenu' },
		{ role: 'windowMenu' },
	]
	Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function resetConfig() {
	const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Reset', 'Cancel'], defaultId: 1, message: 'Replace your config.json with the bundled defaults?' })
	if (r.response !== 0) return
	fs.copyFileSync(BUNDLED_CONFIG, userConfig())
	running?.close()
	running = await boot()
	win?.loadURL(running.url)
}

app.whenReady().then(async () => {
	buildMenu()
	const r = await boot()
	createWindow(r.url)
	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow(running.url)
	})
})

app.on('window-all-closed', () => {
	running?.close()
	app.quit()
})
