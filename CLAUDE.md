# Broadwatcher — notes for Claude

Broadwatcher is Steve's (Brookline Interactive Group) broadcast-network console: an Electron app for Mac and
Windows whose Node server polls the UniFi UDM Pro Max, the switches (SNMP) and the Blackmagic gear, detects
streams arriving at the ATEM, and asks a local AI model for a readiness verdict. Read this file end to end before
touching anything. The roadmap for the next phase is in `docs/ROADMAP.md`.

## Where things are

- Source: `A:\___ENGINEERING PROJECTS\BIG NetWatch` (folder name is historical; the app is Broadwatcher).
  Branch `master`. Remote: https://github.com/amateurmenace/broadwatcher (private; `gh` is logged in as
  amateurmenace in Claude's shell, not in Steve's own PowerShell).
- Releases: bump `version` in `package.json`, commit, `git tag -a vX.Y.Z`, push the tag. `.github/workflows/release.yml`
  creates the GitHub release first (prepare job), then builds macOS (dmg + zip, universal) and Windows (nsis +
  portable) and uploads them. Watch with `gh run watch <id> --repo amateurmenace/broadwatcher`. Artifacts are
  named `Broadwatcher-<version>-…` (nsis/portable/dmg each have their own `artifactName`).
- Caches on the Broadcast Pix PC live on `A:` (`A:\AI\npm-cache`, `A:\AI\electron-cache`, `A:\AI\electron-builder-cache`).
  Never put installs, caches or new folders on `C:`.
- Development: `NETWATCH_PORT=8767 node server/server.js` (the installed app owns 8766), open
  http://127.0.0.1:8767. The dev server writes its roster to `config.local.json` (git-ignored); delete it to
  get the bundled defaults back. `npx electron . --smoke` proves the shell loads.
- Shared notes for this project family: `C:\Users\Broadcast Pix\AppData\Roaming\Claude\side-session-notes\local_d99bd98d-7561-426c-a7b3-233b5080f0ea\netwatch.md`
  (the full history of findings); Claude's memory file `big-netwatch-app.md` holds the durable facts.

## Layout

- `server/unifi.js` UniFi local API client (X-API-KEY, self-signed TLS). `server/snmp.js` SNMP v2c (GET/GETBULK, no deps).
- `server/collector.js` the brain: polls (devices 5 s, clients 10 s, flows 10 s, log 30 s, probes 15 s, telemetry
  10 s, SNMP 3 s), per-port rates, stream intake detector + source attribution, topology, alerts with ids and
  explanations, event tape, roster (`setEquipment`), inspector `details()`.
- `server/probe.js` TCP connect / X32 OSC `/xinfo`. `server/rest.js` Blackmagic REST (Web Presenter `livestreams/0`,
  HyperDeck `transports/0`). `server/atem.js` ATEM protocol: `readAtem` (one-shot, tests only) and `AtemClient`
  (persistent, used by the app). `server/ai.js` digest + prompts (LM Studio / OpenAI-compatible or Anthropic).
- `server/server.js` HTTP + SSE + `/api/*` (state, details, equipment GET/POST, ai/*); `loadConfig` merges the
  bundled `config.json` with the user's copy (`config_version`, roster merge by IP when `equipment_edited`).
- `ui/index.html`, `ui/styles.css` (light "paper" theme default, `data-theme="dark"`), `ui/app.js`, `ui/map.js` (SVG signal map).
- `main.js` Electron shell: copies `config.json` to userData on first run, menu (Open config, Restart server, Reset).

## Rules that exist for a reason

1. **Never send bare hellos or one-shot reads to an ATEM from the app.** The HD8 keeps a dead or half-open
   session for ~2 minutes and only has a handful of control slots (Companion and ATEM Software Control need
   them); the 0.1.0 app's 15-second hello probes clogged it and only a power-cycle cleared it. `AtemClient`
   holds one session per switcher, pooled for the life of the process, and never attempts more than one hello
   per two minutes under any failure. Keep it that way; measure nothing by opening sessions.
2. **Rates come from SNMP** (`snmp.community` = `netwatch`, enabled in UniFi 2026-10-18); the controller's
   copies refresh only when a switch informs it (30–90 s). UniFi `traffic-flows` never contains same-VLAN
   switch-to-switch traffic; inbound forwarded flows are logged against the WAN IP + WAN port, so the
   collector maps them through `rest/portforward` (`forwardTarget`).
3. **Roster semantics:** `equipment[].active === false` = standby: shown greyed, not probed, no telemetry, no
   alerts, ignored by the AI, not on the map. Town Hall gear and the field ATEM Mini Extreme ISO G2
   (192.168.20.189) are standby by default. The ATEM at 192.168.20.79 is the ATEM Television Studio HD8 ISO.
4. **Taste:** Steve rejected the dark, condensed-caps, neon look as "AI" and "cybery". Keep the paper theme,
   serif headings, plain sans, tabular numbers, hairlines, calm colours (orange = into a device, teal = out).
   Styled scrollbars everywhere. No rounded "cards" grids.
5. **Config upgrades:** bump `config_version` in `config.json` whenever the bundled device lists or defaults
   change; user edits of gateway/poll/thresholds/ai/snmp survive, a roster edited in the app always wins.
6. **Companion is separate.** The Stream Deck config (`Desktop\Town Meeting Companion`) has its own Python
   UniFi poller; Broadwatcher does not write into Companion (yet, see roadmap).
7. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Bash heredocs on this
   PC collapse `\\` to `\`: write code files with the Write tool, not heredocs.

## Facts about the gear (verified)

- UDM Pro Max 192.168.20.1 "BIG WAN", WAN IP 207.180.143.114. Switches: Fiber Agg (core), LIGHTHOUSE (Studio A,
  HD8 on port 15), Studio A CR Switch, Rack Switch 1–4, Video Rack, AUDIO RACK (192.168.5.x Dante), FIELD, TH …
  VLANs: Default, BIG_NDI (355, 10.56.20.x), BIG_DANTE (354, 10.56.19.x), BIG_MOBILE_DANTE (2, 192.168.5.x).
  UniFi switch interfaces are `0/<port>` in SNMP, the UDM's are `eth<n>` (eth0 = port 1).
- Port forwards that matter: WAN 1937 → HD8 192.168.20.79:1935 (remote source), WAN 1935 → ATEM Mini Extreme
  192.168.20.189:1935, WAN 1936 → 192.168.20.88:1935, WAN 9710 → 10.56.21.152 (ATEM IP Patchbay RTMP), NDI
  Bridge 5997/5998.
- Blackmagic REST at `http://<ip>/control/api/v1/` on Web Presenters (.71 control room, .76 field) and
  HyperDecks (.159 Studio HD, .92 Pro, .129 Mini); the HD8 has none. ATEM protocol commands seen on the HD8
  include `RSDs RSis RSpr RSca` (remote sources; `RSis` carries the WAN IP; layout unknown).
- LM Studio on this PC listens on 0.0.0.0:1234 (`gemma-flash`); Companion web UI on 127.0.0.1:8000.
- The Broadcast Pix PC has 192.168.20.75 (Default) and 10.56.20.33 (BIG_NDI); it is not on the Dante VLANs.
