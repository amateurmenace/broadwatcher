# Broadwatcher — notes for Claude

Broadwatcher is Steve's (Brookline Interactive Group) broadcast-network console: an Electron app for Mac and
Windows whose Node server polls the UniFi UDM Pro Max, the switches (SNMP) and the Blackmagic gear, detects
streams arriving at the ATEM, and asks a local AI model for a readiness verdict. Read this file end to end before
touching anything. The roadmap for the next phase is in `docs/ROADMAP.md`.

## Where things are

- Source: `A:\___ENGINEERING PROJECTS\BIG NetWatch\broadwatcher` (the parent folder `BIG NetWatch` is Steve's engineering project folder and may hold other
  material; only `broadwatcher\` is the git repo).
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
  (persistent, opt-in; captures the undocumented `RS*` remote-source commands, `captureReport()`).
  `server/companion.js` Companion HTTP API client (switcher state without a slot). `server/ai.js` digest +
  prompts (LM Studio / OpenAI-compatible, or Anthropic through `@anthropic-ai/sdk`, Claude Opus 5.5 default).
- `server/server.js` HTTP + SSE + `/api/*` (state, details, equipment GET/POST, ai/*, companion, atem/capture,
  atem/session); `loadConfig` merges the bundled `config.json` with the user's copy (`config_version`, roster
  merge by IP when `equipment_edited`; `atem` and `companion` blocks deep-merged).
- Collector extras since 0.4.0: `atemTelemetry` (Companion/auto/own/none with hysteresis), `streamPaths`
  (port forward → target → intake, data threshold 50 kB so port scanners do not count), `knownControllers`
  (slot census: Companion API + process list via PowerShell/ps once a minute), `forwardHits` (last hour),
  `setPortLabel` (hand-written port labels, `port_labels` in the user config, `/api/portlabel`), a 60 s hold
  per poll after the controller answers 5xx or times out, flows every 15 s with 3/2/1 pages.
- UI since 0.6.0: `ui/map.js` has the zoom/pan viewport (`NetMap.zoom/fit`, view remembered in
  localStorage `bw-map-view`, fit = fit width with a 0.72 floor); `app.js` renders the gateway strip
  (`renderGateway`), collapsible blocks (`toggleFold`, `bw-fold`), the rail toggle (`setRail`, `bw-rail`),
  the switch port lists with find and labels (`renderRack`, `openPorts`, `rackFilter`, `labelEdit`).
  The Details HUD panel and the `H` key are gone; the gateway strip replaced them.
- A development server beside the installed app doubles the controller load: `config.local.json`
  (git-ignored) carries lighter poll intervals for it; stop it when not looking at the UI. On 2026-10-19
  08:30 the controller returned HTTP 500 while switches flapped and MACs moved between ports (a loop or
  re-patching, not the polling), so the collector now backs off after 5xx.
- `scripts/atem-capture.mjs` one-shot remote-source capture to JSON (quiet hours only).
- `server/health.js` (0.7.0): `computeHealth(state, profile, thresholds)` = weighted factors (0-1 each, with
  reason, level, critical flag, inspector target) → score 0-100 and verdict; `tiles(state, health)` = the
  eight home tiles; `PROFILE_DEFAULTS`. The collector keeps `profiles` / `activeProfile` (config
  `profiles[]`, `active_profile`; `setProfiles`, `activateProfile(id, {applyRoster})`, `testProbes`), puts
  `state.health`, `state.tiles`, `state.profiles` in every state, and logs verdict changes to the tape. The AI
  gets the score in its digest and its verdict is overridden by the score (`aiVerdict` kept).
- Phone page: `ui/m.html` + `m.js` + `m.css` + `manifest.webmanifest` + `icon-512.png`, served at `/m`;
  non-loopback requests need `server.token` (`?key=` once, then the `bw_key` cookie; manifest and icons are
  public); `/api/phone` lists the LAN links; Electron menu "Open on a phone…" (switches `server.host` to
  0.0.0.0 and restarts on request). `ui/prepare.js` = the Prepare a broadcast dialog (`/api/profiles`,
  `/api/profiles/activate`, `/api/probe/test`).
- `ui/index.html`, `ui/styles.css` (light "paper" theme default, `data-theme="dark"`), `ui/app.js`, `ui/map.js` (SVG signal map),
  `ui/settings.js` (Settings screen: AI local/Claude toggle + keys, gateway, SNMP, Companion, server, thresholds;
  `/api/settings`, `/api/settings/test`; an empty secret field keeps the stored secret, null clears it).
- `main.js` Electron shell: flavour from `package.json.flavor` (set by `scripts/build-flavor.mjs`) picks
  `config.json` (private) or `config.public.json` (Community); copies it to userData on first run; single-instance
  lock (skipped with NETWATCH_PORT / --smoke); Companion autostart; menu (Settings, Open config, Restart server,
  Start Companion, Reset).
- Two flavours per release (`.github/workflows/release.yml` matrix os × flavor): private = `Broadwatcher-…`
  with `config.json`; public = `Broadwatcher Community` (`Broadwatcher-Community-…`, own appId/userData,
  `config.public.json`, no keys). `scripts/embed-secrets.mjs` writes the `ANTHROPIC_API_KEY` repository secret
  into the private build's config at CI time (never commit the key).

## Rules that exist for a reason

1. **Never send bare hellos or one-shot reads to an ATEM from the app, and take no slot by default.** The HD8
   keeps a dead or half-open session for ~2 minutes and has only a handful of control slots: on 2026-10-19 it
   was full with three held sessions (Companion, ATEM Software Control, the NDI Machine ATEM bridge
   `atem-remote.exe`), and Broadwatcher's hello was refused 7 s after a power-cycle. Since 0.4.0 the switcher is
   read **through Companion's HTTP API** (`server/companion.js`, `atem.session = "companion"`), which costs
   the switcher nothing. `AtemClient` (own session) is opt-in (`own`, or `auto` = only while Companion is
   away), pooled for the life of the process, one hello per two minutes under any failure, and it backs off
   2/4/8/15 min when refused. The raw remote-source capture needs an own session. Measure nothing by opening
   sessions; `scripts/atem-capture.mjs` is the only one-shot reader and is for quiet hours.
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
6. **Companion is read, never written.** Broadwatcher reads Companion's HTTP API on this PC
   (`GET /api/connections`, `GET /api/variable/<label>/<name>/value`; the bmd-atem connection is labelled
   `atem` and exposes `pgm1_input`, `pvw1_input`, `stream_active`, `stream_bitrate`, `stream_cache_used`,
   `stream_duration_hms`, `record_active`, `record_duration_hms`, `record_remaining_hms`, `record_filename`,
   `record_disk_volume`, `long_N`/`short_N`, `aux1_input`). The Stream Deck config
   (`Desktop\Town Meeting Companion`) has its own Python UniFi poller; Broadwatcher does not write into
   Companion (yet, see roadmap). The Electron app starts Companion if it is not running (`companion.autostart`).
9. **Secrets:** the UniFi key is bundled in `config.json` (private repo, private build only); the Anthropic key is
   never committed: it comes from the GitHub secret `ANTHROPIC_API_KEY` at build time (set 2026-10-19) or from
   the Settings screen into the user config. `config.public.json` must stay free of keys and of BIG's devices.
   The public builds go to https://github.com/amateurmenace/broadwatcher-community (releases + README only,
   no source) once the secret `PUBLIC_RELEASE_TOKEN` (fine-grained PAT, Contents: write on that repo) exists;
   until then they stay attached to the private release. 0.7.1 was copied there by hand. The private repo's
   history contains the UniFi key: never make it public without rotating that key.
8. **Two Claude sessions may be working in this repo.** On 2026-10-19 a second session (title "Gemini-format
   API endpoint in front of LM Studio", driven by Steve over remote control) committed 0.3.3 (Anthropic SDK)
   while this one was mid-edit. Run `git log` before committing, build on HEAD, commit small and often.
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
- LM Studio on this PC listens on 0.0.0.0:1234 (`gemma-flash`); Companion web UI on 127.0.0.1:8000 (bind_ip
  127.0.0.1, so the Mac cannot read it until the "one server, many viewers" roadmap item).
- The Broadcast Pix PC has 192.168.20.75 (Default, Fiber Agg port 13, 10G), 10.56.20.33 "NDI NIC" (BIG_NDI,
  LIGHTHOUSE port 10) and since 2026-10-19 192.168.5.19 "DANTE NIC" (BIG_MOBILE_DANTE, LIGHTHOUSE port 3,
  profile "DANTE MOBILE Pro AV"). Steve manages Dante with Dante Director (cloud), site "BIG Mobile Dante";
  passive PTP/mDNS monitoring does not conflict with it. Two Dante clock domains: the mobile Dante devices
  (X32 Dante card 192.168.5.122, .200, .132) clock on multicast **224.0.1.131**, Town Hall (leader PRISM
  12x12 10.56.19.213, followers 10.56.19.29/.130) on 224.0.1.129. The Town Hall frames reach the DANTE NIC
  and the mirror **tagged VLAN 354** (verified with tshark `vlan.id`): IGMP snooping is off, so multicast
  floods to every port that allows tagged VLANs, and the Windows I210 driver passes tagged frames to Npcap.
  There is no layer-2 bridge between the Dante VLANs (an earlier note said so; it was the wrong multicast
  group). The 08:06-08:35 flapping coincided with re-patching in the audio rack (a Sennheiser moved from
  AUDIO RACK port 14 to 11, an Audinate device sat on LIGHTHOUSE port 11 for 57 s).
- Mirror port (2026-10-19): LIGHTHOUSE port 13 (2.5G) mirrors port 15 (the HD8); the PC's USB adapter
  "Port 15 MIRROR" (Realtek 2.5GbE, 80:69:1a:e3:d0:e1) sits on it with no IP (169.254.x is expected).
  Wireshark 4.6.6 + Npcap are installed (`C:\Program Files\Wireshark\tshark.exe`, interface name
  `Port 15 MIRROR`). A mirror of a "forward all" port also shows every VLAN's flooded multicast, tagged.
  First captures: the HD8's ATEM-protocol sessions (UDP 9910) came from StevesBIGLaptop 192.168.20.109
  (Fiber Agg port 20) and **VR_Cart 192.168.20.128** (Gigabyte PC, Studio A CR Switch port 33), a slot holder
  nobody had counted; Companion and the NDI Machine bridge were not running at the time.
- HD8 control slots (2026-10-19 07:43): after Steve's power-cycle Companion reconnected at 07:43:23, the NDI
  Machine bridge restarted the same second, ATEM Software Control reconnected, and Broadwatcher's hello was
  refused at 07:43:30. The switcher is full with those three; its exact capacity is still unmeasured. The NDI
  Machine project (`A:\___ENGINEERING PROJECTS\NDI Machine`, `native/atem_remote.cpp`, official BMD SDK)
  keeps `atem-remote.exe <ip> --server` alive while NDI Machine runs; its launcher is a Windows startup item.
- Not ATEM clients: 192.168.20.176 (web UI "Blackmagic Design", syncs to AWS; Cloud Store-like),
  192.168.20.237 "BIGs-Air-2" (only TCP 9990 = Videohub protocol).
- The UDM logs flows to its own address, so a UniFi poller anywhere on the LAN shows up as flows to
  192.168.20.1:443 (only this PC does, every ~11 s). No flow crosses the UDM on port 9910: every ATEM
  controller is on the Default VLAN. Internet scanners knock on the forwarded ports all day (180-byte
  flows from AWS addresses on 1935/5997); only flows above 50 kB count as stream attempts.
