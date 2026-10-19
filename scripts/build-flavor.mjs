// Build one flavour of the app with electron-builder.
//   node scripts/build-flavor.mjs private [electron-builder args…]   the BIG build (bundled config.json with the site's keys)
//   node scripts/build-flavor.mjs public  [electron-builder args…]   "Broadwatcher Community": no keys, no site devices;
//                                                                     config.public.json is bundled instead of config.json
// The builder configuration is package.json's "build" section with the flavour's overrides, written to
// dist/builder-<flavour>.json and passed with --config (which replaces the package.json section entirely).
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const flavor = process.argv[2] || 'private'
const rest = process.argv.slice(3)
if (!['private', 'public'].includes(flavor)) {
	console.error('flavour must be private or public')
	process.exit(2)
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const build = JSON.parse(JSON.stringify(pkg.build))
build.files = build.files.filter((f) => f !== 'config.json' && f !== 'config.public.json')
if (flavor === 'public') {
	build.files.push('config.public.json')
	build.productName = 'Broadwatcher Community'
	build.appId = pkg.build.appId + '.community'
	build.artifactName = 'Broadwatcher-Community-${version}-${os}-${arch}.${ext}'
	build.nsis = { ...(build.nsis || {}), artifactName: 'Broadwatcher-Community-${version}-win-setup.${ext}' }
	build.portable = { ...(build.portable || {}), artifactName: 'Broadwatcher-Community-${version}-win-portable.${ext}' }
	build.dmg = { ...(build.dmg || {}), artifactName: 'Broadwatcher-Community-${version}-mac.${ext}' }
	build.extraMetadata = { name: 'broadwatcher-community', productName: 'Broadwatcher Community', flavor: 'public', description: 'Broadwatcher Community: real-time broadcast-network monitor (UniFi + Blackmagic + your own AI)' }
	build.directories = { ...(build.directories || {}), output: 'dist/public' }
	// the public build publishes to the public repository when CI has a token for it (BW_PUBLIC_REPO is set
	// together with GH_TOKEN = the PUBLIC_RELEASE_TOKEN secret); otherwise it lands in the private release
	if (process.env.BW_PUBLIC_REPO) build.publish = { provider: 'github', owner: pkg.build.publish?.owner || 'amateurmenace', repo: process.env.BW_PUBLIC_REPO, releaseType: 'release' }
} else {
	build.files.push('config.json')
	build.extraMetadata = { flavor: 'private' }
}
fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
const cfgPath = path.join(root, 'dist', `builder-${flavor}.json`)
fs.writeFileSync(cfgPath, JSON.stringify(build, null, 2))
if (rest.includes('--dry')) {
	console.log(JSON.stringify(build, null, 2))
	process.exit(0)
}
console.log(`building the ${flavor} flavour (${build.productName}) with ${cfgPath}`)
const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron-builder', '--config', cfgPath, ...rest], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
process.exit(r.status ?? 1)
