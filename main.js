// Electron shell: starts the NetWatch server in-process and shows the dashboard in a window.
import { app, BrowserWindow, Menu, shell, dialog, nativeTheme } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer, loadConfig } from './server/server.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BUNDLED_CONFIG = path.join(__dirname, 'config.json')

app.setName('BIG NetWatch')
nativeTheme.themeSource = 'dark'

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
	try {
		running = await startServer({ config, host: '127.0.0.1', port })
	} catch (e) {
		// port taken (another NetWatch or the standalone server): fall back to a random port
		running = await startServer({ config, host: '127.0.0.1', port: 0 })
	}
	return running
}

function createWindow(url) {
	win = new BrowserWindow({
		width: 1680,
		height: 1050,
		minWidth: 960,
		minHeight: 640,
		backgroundColor: '#0b0f14',
		title: 'BIG NetWatch',
		autoHideMenuBar: false,
		webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
	})
	win.loadURL(url)
	// `electron . --smoke` : prove the window loads the dashboard, then quit (used by the build check)
	if (process.argv.includes('--smoke')) {
		win.webContents.once('did-finish-load', async () => {
			const title = await win.webContents.executeJavaScript('document.title')
			const cards = await win.webContents.executeJavaScript('document.querySelectorAll(".card").length')
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
	const template = [
		...(isMac ? [{ role: 'appMenu' }] : []),
		{
			label: 'NetWatch',
			submenu: [
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
				{ label: 'Open UniFi Network', click: () => shell.openExternal(loadConfig(BUNDLED_CONFIG, userConfig()).gateway?.ui_url || 'https://192.168.20.1') },
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
