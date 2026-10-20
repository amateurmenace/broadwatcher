// CI helper for the private build: put the Anthropic key from the ANTHROPIC_API_KEY environment variable (a GitHub
// Actions repository secret) into the bundled config.json before packaging, and make Claude the default AI
// provider. ANTHROPIC_WORKSPACE_ID (optional, another secret) rides along for keys that are not scoped to a
// workspace: the API then needs the anthropic-workspace-id header on every request. Nothing enters git.
//   node scripts/embed-secrets.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const file = path.join(root, 'config.json')
const key = (process.env.ANTHROPIC_API_KEY || '').trim()
const workspace = (process.env.ANTHROPIC_WORKSPACE_ID || '').trim()
if (!key) {
	console.log('embed-secrets: no ANTHROPIC_API_KEY in the environment, config.json left as is')
	process.exit(0)
}
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
cfg.ai = { ...(cfg.ai || {}), anthropic_api_key: key, provider: 'anthropic', ...(workspace ? { anthropic_workspace_id: workspace } : {}) }
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n')
console.log(`embed-secrets: Anthropic key (…${key.slice(-4)}) embedded in config.json, provider set to anthropic${workspace ? `, workspace ${workspace.slice(0, 12)}…` : ', no workspace id'}`)
