# Broadwatch — notes for Claude

Broadwatch (named Broadwatcher until 0.9.0; the GitHub repositories and the folder keep the old name) is
Steve's (Brookline Interactive Group) broadcast-network console: an Electron app for Mac and
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
  named `Broadwatch-<version>-…` (nsis/portable/dmg each have their own `artifactName`).
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
- `server/forensics.js` (0.8.0): two tshark sidecars on the mirror NIC (`config.capture`): the main one prints
  one `-T fields` line per packet (no payload; RTMP via the Info column + `amf.string`, SRT via `srt.*`), the
  second prints the payload of hello-sized UDP 9910 packets for the hello reply code. Tracks flows per
  (peer, proto, ports) with state (opening/established/publishing/streaming/rejected/reset/closed/no answer),
  ATEM sessions per client socket (held = the switcher's ~1/s "Time" keepalive still arrives), events ring.
  `/api/forensics` GET/POST(start|stop); `state.forensics` (snapshot) feeds the stream sources, the alerts
  ("turned a stream away", "control connection refused") and the AI digest. UI block "Stream forensics",
  Settings > Capture (interface, tshark, enabled, "List interfaces" = `tshark -D`). Verified with an ffmpeg
  publish to the HD8 using a wrong key: connect accepted, then the switcher closes the connection before
  any publish → "rejected" + alert. Killing node abruptly can orphan tshark: the restart recipe kills
  `tshark` and `dumpcap` too.
- Live audio (0.9.0): `server/x32.js` (`X32Meters`: one UDP socket, `/batchsubscribe` to `/meters/1` and
  `/meters/2` with timefactor 2 = 10 blobs/s, `/renew` every 8 s, names and `mix/on` once a minute, peak hold
  1.5 s then 12 dB/s; the blobs are little-endian; `snapshot()` / `compact()`), `server/ssc.js`
  (`SscMonitor`: JSON over UDP 45, polls rx/mates/m every 5 s, subscribes to the `m` meters for 12 s and
  renews every 10 s, 424 on `mates.txN` = no transmitter linked, `NoLink` in `warnings` = transmitter off).
  The collector keeps both (`syncAudioTargets`: X32 = roster probe `x32`, receivers = role `audio` +
  `isMic` from `health.js`), builds `state.audio` (`consoles`, `mics`, `others` = audio gear with nothing to
  read, `switcher` = Fairlight levels or the note why not, `summary`) in `audioState`, attaches `audio` to
  each roster entry, emits a `meters` event (≤ 5/s, compact arrays) that `server.js` broadcasts as SSE
  `meters`; `/api/audio`. Health: `audio` = consoles sending meters (answering without meters counts 0.6),
  `mics` = on-air channels with battery ≥ `mic_battery_pct` and RSQI ≥ `mic_rf_pct` (thresholds,
  config_version 7; spare channels with the transmitter off do not count against a show). Alerts scope
  `audio`. UI: Audio section (`renderAudio`, `applyMeters` moves the bars without re-rendering, `meterEls`),
  tile strips (`stripHtml`, `tiles[].strip`), inspector `audioSection`, phone `renderMics`; Settings got a
  Switcher section (name, IP, session mode with the Fairlight note) and the two mic thresholds.
  `AtemClient.wantLevels(on)` sends `SFLN` after `InCm` (once per session since 0.14.3, again only if levels
  stop for 30 s) and decodes `FDLv` / `FMLv` into `levelsSnapshot()`; the collector turns it on only when
  `atem.session === 'own'`.
- `server/journal.js` (0.10.0): the log. Every collector event, alerts raised and cleared (paired, with the
  duration), the notable UniFi events (client connect/disconnect/roam filtered out), forensics events, AI
  and app errors (`process.on('unhandledRejection'|'uncaughtException')` → the server carries on), newest
  first in memory (8000) and appended to `<config folder>/journal/YYYY-MM-DD.jsonl`, 30 days. `/api/journal`
  (since, levels, cat, q, clears, open, limit → entries + facets + summary), `/api/journal/export` (CSV),
  `/api/details?type=journal&id=` (the entry plus its entity's details); `ai.journal.summaryText()` in the
  digest. UI: the `logBlock` (filters remembered in localStorage `bw-log`, rows open the inspector,
  `journalSection`, "Ask the AI about this"); the phone page lists the last 24 h of errors and warnings.
- 0.11.0: the top bar is 84 px with a spelled-out Settings button and the Theme / Panel switches under the
  clock; sections run Health, Open items, Signal map, Gateway, Audio, Streams, …; the port objects carry
  `err` (10-min deltas of rx_errors/tx_errors/rx_dropped/tx_dropped/link_down_count with `cause`
  errors|drops|rxdrops|flaps and `window_s`), `errTotals`, `sfp` (part, compliance, rx/tx power, temp,
  faults), `autoneg`, `flowctrl`, `storm` (broadcast+multicast pps) and `errDetail` (the EtherLike/RMON
  breakdown over SNMP, `SnmpSwitch.errorDetail`, once a minute for ports with damaged frames); the port
  alerts are `port:errors` / `port:drops` / `port:flaps` with the far end and, for congestion, the busiest
  port of the downstream switch. `roster_switches` (config, Edit roster > Whole switches, default LIGHTHOUSE,
  AUDIO RACK, BHS Auditorium - 48-PoE): wired clients on those switches become `auto` roster entries (no row,
  no probe, alert only once seen online; `guessRole`). `/api/roster/add` (the inspector's "+ device" buttons
  on ports and auto entries). `map_labels` (config) = hand-written names on the signal map, `/api/maplabel`,
  double-click a node; USER_KEYS keeps them. The AI diagnosis buttons pick Claude or the local model per
  call (`/api/ai/diagnose?provider=`, `ai.chat({provider})`); `ui/localai.js` is the local AI guide (LM
  Studio / Ollama). Roles gained `playback` (Tightrope Flex 4).
- 0.12.0: `server/discover.js` (mDNS queries for `_ndi._tcp` and `_netaudio-arc._udp` on every interface
  every 30 s; PTP v1 listener on UDP 319 joining 224.0.1.129-132: leaders = Sync senders, followers =
  Delay_Req senders, domains told apart by subnet) → `state.discovery = {ndi, dante, clocks}`;
  `server/host.js` (this PC: cpu/ram/gpu via nvidia-smi/disks; telemetry kind `host` for the first roster
  entry with one of this machine's addresses); `server/videohub.js` (TCP 9990 read-only dump: labels,
  routing, locks; telemetry kind `videohub` for probe tcp:9990); `rest.js` reads the HyperDeck working set
  (remaining record time, free space, clips), formats, codec, playback and the Web Presenter cache. Tiles:
  `switcher` (stream in + out + record + sessions), `encoders`, `recorders`, `audio`, `mics`, `dante`, `ndi`,
  `network`; each opens a panel drawn client-side (`LOCAL_TYPES`, `localPanel`). `hud_modules` (config,
  Settings > Top bar) drives the top-bar cells (`hudCell`). Forensics keeps the whole session (4000 flows,
  1000 sockets, 4000 events, 24 h): `full()` / `/api/forensics/all` (q, kind, since, state), `/api/forensics/
  export` (json|csv), raw packets `startRaw/stopRaw` = a third tshark `-w` into `<config dir>/captures/`
  (ring 5 × 100 MB, `/api/forensics/pcap[/name]`), `ai.explainForensics` + `/api/ai/forensics` (focus peer,
  question, provider). The Fairlight decoder was fixed (see the facts below). PDUs carry `outletList`,
  `acPower`, `acBudget`.
- 0.13.0: the Equipment section is a card grid (`eqCard` per telemetry kind / audio kind / role, `pduCard`,
  `.eqgrid` / `.eqc` in styles.css; standby devices keep `pbRow`); the health cards are 196 px tall with the
  line clamped at three lines and a labelled graphic pinned to the bottom (`tileGraphic` per tile id:
  sparkline, `gaugeHtml`, the strips, `.trow` rows, `.tmini` readouts). `TILE_IDS` in health.js adds `power`
  and `pc` tiles; a show profile may carry `tiles[]` (Prepare a broadcast > Cards on the health board,
  `setProfiles` validates against TILE_IDS, `state.profiles.list[].tiles`); the page shows only those when
  set. `pbWidget` is unused since the cards.
- 0.14.0: the switcher's ISO record is decoded as atem-connection lays it out (`server/atem.js`, `recordingView`):
  RTMS status word bit 0 = recording, bit 7 = stopping (the HD8 shows **2 idle and 3 recording**, verified on
  Steve's test recording 2026-10-21 00:34-00:36 through the tape; until 0.14.0 the 2 was read as "recording"
  and the duration stood in for the time left), the error word at bytes 2-3 carries the previous
  seconds-left on the HD8 (stale buffer), so it is read only when made of the known bits and not stale; RTMD
  per disk = id u32 @0, **seconds left u32 @4, status u16 @8** (idle 1 / unformatted 2 / active 4 /
  recording 8 / removed 32; 0.14.0 had the two swapped and dropped every disk as "removed"), volume name @12;
  RMSu (file name, working-set disk ids, record in all cameras); RTMR = duration hh:mm:ss:ff at bytes 0-3
  (bytes 4-7 carry other counters, not the drop-frame flag); RMRD stays raw. The capture report keeps the
  last bodies of RTMS/RTMD/RMSu beside the RS* commands.
  `telemetry.recording` = `{state, active, raw, error, errorRaw, remainingS, remaining, disk, disks[], filename,
  allCameras, duration}`; every state change goes to the tape with the status word (`record` events), so the
  next test recording leaves the proof. Passive capture recipe: `tshark -i "Port 15 MIRROR" -f "udp src port
  9910 and src host 192.168.20.79" -Y 'data.data contains "RTMS" …' -T fields -e data.data`, then parse the
  commands from byte 12. Companion also hands over `long_N`/`short_N` (inputs 1-8) → `inputs` for the tally
  row. Only the 192.168.5.x Dante VLAN is watched (`DANTE_NET` in app.js; the Town Hall devices on
  10.56.19.x are in `retired_equipment`, config_version 10). Top bar: every cell has a fixed width, the
  VLAN cells 140 px (130 px under 1680 px), and `fitHud` drops modules when the window is too narrow (the
  gateway cell first, then from the right end; the VLAN cells and the first module never); `hud_modules`
  follows the bundled default until Settings sets `hud_modules_edited` (USER_KEYS); defaults gained `dante`
  and `record`. Health cards: the switcher's tally row (inputs 1-8, program red, preview green) and the
  Fairlight master row, every path out on Stream out, main L/R rows on Audio, RF/audio rows per mic on
  air; card copies of a meter carry a `tile:` key prefix (`applyMeters` moves both). `ui/viz.js` =
  "Visualizations · experimental" (`vizBlock`, after Audio): audio waterfall (canvas, fed by the meters
  event), who-talks-to-whom ribbons (`flows.top`, names from the roster and the switch ports, forwarded
  flows named after the port forward), VLAN river (watched VLANs, stacked around the middle), Dante clock
  orbit (the 192.168.5.x PTP domain), the port heatmap (`util` ramp, red ring = errors, click opens the
  port); draws only while the block is open and on screen; `--viz1…6` identity hues and the `--seq1…5` ramp
  pass the colour-vision checks on both themes; tooltips use `data-vtip` (app.js owns `data-tip`).
- 0.14.1: recording and live states on the cards: `.tile.rec` / `.eqc.rec` (red top border, `--rec-tint`,
  pulsing lamp `recpulse`, a `.recbadge` with a blinking dot in the status line or after the name) while the
  switcher's ISO record or a HyperDeck rolls; `.tile.live` / `.eqc.live` (teal, `.livebadge`) while a Web
  Presenter or the switcher streams; every `.tag.rec` carries the blinking dot; the ISO record top-bar cell
  gets `.cell.rec`. `prefers-reduced-motion` stops the animation.
- 0.14.2: the top bar keeps every configured module as long as it can: the cells have a fixed flex basis and
  a minimum (`flex: 0 1 <basis>`, `min-width`), the VLAN group no longer wraps; `fitHud` sums the minimums
  (border-box) against the cells column, switches the bar to `.hud.compact` when they do not fit (the brand
  to its mark, the readiness to its word, the cells' third lines hidden, smaller minimums, the VLAN numbers
  stacked) and only then drops modules (the gateway cell first, then from the right; never a VLAN cell or
  the first module). At the default 1680 px window all six default modules show, compact. The old
  `max-width` media queries for the bar are gone.
- 0.14.3: the own switcher session keeps to the protocol (rule 1 below explains why): command ids start at 1 in every
  session, unacknowledged commands go out again, a session that cannot deliver is dropped, `SFLN` once per session
  instead of every 10 s. `scripts/atem-session-check.mjs`. The BIG site's copy stays on `atem.session = companion`.
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
- Two flavours per release (`.github/workflows/release.yml` matrix os × flavor): private = `Broadwatch-…`
  with `config.json`; public = `Broadwatch Community` (`Broadwatch-Community-…`, own appId/userData,
  `config.public.json`, no keys). `scripts/embed-secrets.mjs` writes the `ANTHROPIC_API_KEY` repository secret
  into the private build's config at CI time (never commit the key).

## Rules that exist for a reason

1. **Never send bare hellos or one-shot reads to an ATEM from the app, and take no slot by default.** The HD8
   keeps a dead or half-open session for ~2 minutes and has only a handful of control slots: on 2026-10-19 it
   was full with three held sessions (Companion, ATEM Software Control, the NDI Machine ATEM bridge
   `atem-remote.exe`), and Broadwatch's hello was refused 7 s after a power-cycle. Since 0.4.0 the switcher is
   read **through Companion's HTTP API** (`server/companion.js`, `atem.session = "companion"`), which costs
   the switcher nothing. `AtemClient` (own session) is opt-in (`own`, or `auto` = only while Companion is
   away), pooled for the life of the process, one hello per two minutes under any failure, and it backs off
   2/4/8/15 min when refused. The raw remote-source capture needs an own session. Measure nothing by opening
   sessions; `scripts/atem-capture.mjs` is the only one-shot reader and is for quiet hours.
   A session's command ids must start at 1, and a command must be delivered: until 0.14.3 `AtemClient.pid` ran on
   across reconnects and nothing was ever re-sent, so the HD8 answered each `SFLN` with a resend request for packet 1
   and acted on none, and it locked up about 90 minutes (some 500 requests) after each reconnect, four times on
   2026-11-01 (BIG Studio Launcher's README, "The HD8's control slots"). Now commands stay in `inFlight` until
   acknowledged, go out again after 1.5 s or when the switcher asks, at most five times, at most eight waiting, and a
   session that cannot deliver is dropped. `node scripts/atem-session-check.mjs` checks all of it against a fake
   switcher on localhost; the fake answers the way the HD8 did on the mirror. Five live sessions, not three, fill the
   switcher.
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
   change; user edits of gateway/poll/thresholds/ai/snmp/capture survive (`DEEP_KEYS`), a roster edited in the
   app always wins, and so do `port_labels`, `profiles`, `active_profile` and, once the VLAN list was edited in
   Settings (`networks_edited`), `networks` (`USER_KEYS` in `server/server.js`, 0.8.1). Before 0.8.1 a version
   bump silently dropped those.
6. **Companion is read, never written.** Broadwatch reads Companion's HTTP API on this PC
   (`GET /api/connections`, `GET /api/variable/<label>/<name>/value`; the bmd-atem connection is labelled
   `atem` and exposes `pgm1_input`, `pvw1_input`, `stream_active`, `stream_bitrate`, `stream_cache_used`,
   `stream_duration_hms`, `record_active`, `record_duration_hms`, `record_remaining_hms`, `record_filename`,
   `record_disk_volume`, `long_N`/`short_N`, `aux1_input`). The Stream Deck config
   (`Desktop\Town Meeting Companion`) has its own Python UniFi poller; Broadwatch does not write into
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
  nobody had counted. Later the same day the HD8 held **four** sessions at once (laptop, VR_Cart, and two
  from this PC: Companion + the NDI Machine bridge), so its capacity is at least four. Since the forward
  moved to WAN 1935, internet scanners (91.230.168.233, 54.236.100.41 …) open RTMP connections to the HD8
  directly; the mirror shows them as RTMP flows that close within a second.
- HD8 Fairlight levels on the wire (protocol 2.32, read passively off the mirror 2026-10-20, fixed in 0.12.0;
  0.9.0 had the two names swapped): once SFLN asks, the switcher sends one **FMLv per audio input** per tick
  (40 bytes: source id int64 at 0 = -65280 for an input's default source, input index u16 at 8, then int16
  hundredths of dB from 10: in L/R pre-fader, in peaks, compressor, limiter, expander, out L/R after
  dynamics, out peaks, mix L/R = what reaches the program (-100 when the input is off), mix peaks) and one
  **FDLv = master** (28 bytes: in L/R, in peaks, compressor, limiter, out L/R, out peaks, mix L/R, mix peaks).
  -10000 = nothing / no held peak. The installed app saw 29 inputs and ~900 FMLv/s.
- HD8 control slots (2026-10-19 07:43): after Steve's power-cycle Companion reconnected at 07:43:23, the NDI
  Machine bridge restarted the same second, ATEM Software Control reconnected, and Broadwatch's hello was
  refused at 07:43:30. The switcher is full with those three; its exact capacity is still unmeasured. The NDI
  Machine project (`A:\___ENGINEERING PROJECTS\NDI Machine`, `native/atem_remote.cpp`, official BMD SDK)
  keeps `atem-remote.exe <ip> --server` alive while NDI Machine runs; its launcher is a Windows startup item.
- Not ATEM clients: 192.168.20.176 (web UI "Blackmagic Design", syncs to AWS; Cloud Store-like),
  192.168.20.237 "BIGs-Air-2" (only TCP 9990 = Videohub protocol). BIGs-Air-2 and the audio-rack Blackmagic
  box 192.168.5.78 left the network on 2026-10-20 and are in `retired_equipment` (0.10.0): a config upgrade
  drops them even from a roster edited in the app.
- Audio gear (verified 2026-10-19 from this PC, routed unicast through the UDM): X32 (Studio) 192.168.5.154 =
  "BIG_Compact-01", X32 Compact, firmware 4.09; X32 Rack 192.168.5.143 = "BIG_MBR-AudioRack", firmware
  4.06-8; both answer `/batchsubscribe` with `/meters/1` = 96 floats (32 channels, 32 gate, 32 dynamics) and
  `/meters/2` = 49 floats (16 bus, 6 matrix, main L, main R, mono, 24 gain reductions). Channel 1 is "Neil",
  2 "L Pod", 3/4 "Floor L/R", 7/8 "Zoom L/R"; the Rack's bus 1 is "Caption Mix", the Compact's bus 2 "MADI
  Return". The three EW-DX receivers 192.168.5.11-.13 are EW-DX EM 2 Dante (product `EWDX2CHD`, device name
  `EWDXEM2D`, firmware 2.0.1): channels WHH-1/WHH-2 (496.6 / 497.2 MHz), WHH-3/W-4 (487.0 / 489.4),
  W-5/W-6 (494.2 / 497.8). SSC facts: `m.rxN` has `af` (dBFS, -138.5 = nothing), `rsqi` (%), `rssi` (dBm),
  `divi` (0/1/2 = none/A/B); battery lives on the linked transmitter (`mates.txN.battery.gauge`, %) and is 424
  "failed dependency" while no transmitter is linked; subscriptions (`osc.state.subscribe`, `#` with
  min/max/count/lifetime) work and the receiver clamps the interval to 480 ms. Every transmitter was off
  during the 0.9.0 build, so battery / RF / AF on air have not been seen live yet.
- The UDM logs flows to its own address, so a UniFi poller anywhere on the LAN shows up as flows to
  192.168.20.1:443 (only this PC does, every ~11 s). No flow crosses the UDM on port 9910: every ATEM
  controller is on the Default VLAN. Internet scanners knock on the forwarded ports all day (180-byte
  flows from AWS addresses on 1935/5997); only flows above 50 kB count as stream attempts.
