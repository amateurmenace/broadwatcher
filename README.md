# Broadwatcher

A broadcast-network console for Brookline Interactive Group, for Mac and Windows. It reads the UniFi
Network API and SNMP on the UDM Pro Max and switches, talks to the Blackmagic gear directly (REST on the
Web Presenters and HyperDecks, the ATEM protocol on the switchers) and asks a local AI model to judge
broadcast readiness and explain problems.

## What is on screen

- **HUD** (always on top): the AI readiness lamp and headline, the **ATEM intake** meter (traffic arriving
  at the switcher, with its quiet level marked), WAN in/out and latency, console CPU/temperature, the four
  broadcast VLANs as mini bar graphs, the biggest flow of the moment, the open-issue count, the clock, a
  light/dark switch and **Details** (or the `H` key): a panel with the biggest flows, the VLAN table,
  console vitals and the full AI assessment.
- **Issues strip**: every open alert as a chip. Click one and the inspector explains what it means, shows
  the device/port it is about, the related UniFi events, flows and Broadwatcher events, and offers
  **Diagnose with AI**.
- **Signal map**: a schematic of the live network, internet → console → switches → equipment. Every link
  carries two animated strands, orange flowing towards the device (traffic into it) and teal flowing back
  (out of it); width follows the rate, every node shows its live in/out numbers and trunk links are
  labelled. A stream arriving at the ATEM turns its link blue. Click anything for details; "every switch"
  also shows switches that carry no broadcast gear.
- **Streams into the switcher**: the intake readout with a 10-minute scope, the stream state (quiet /
  arriving since…), and *where it comes from* with a confidence for each candidate source:
  **confirmed** (a flow through the gateway aimed at the ATEM, or an ATEM Mini whose stream URL points at
  it), **likely** (a Web Presenter streaming at about the arriving rate), **possible** (an encoder sending
  about the same rate at the same moment).
- **Stream path check**: one row per gateway port forward that points at broadcast gear (the remote-source
  path into the HD8 on WAN 1937, the field Mini on 1935, the Tightrope and NDI Bridge forwards). Each row
  shows who from the internet sent data to that WAN port in the last hour and how much, whether the target
  is on the network, and whether the switcher's intake rose at the same time. Green = arriving and reaching
  the target now, amber = reaches the gateway but the switcher's intake did not move (check the remote-source
  setup, key and format), red = the forward points at a device that is on standby or off the network (the
  classic case: a sender using the HD8's default port 1935 lands on the field Mini) or the firewall blocked
  it. Port scanners knocking on open ports are listed as probes and ignored. Click a row for the senders.
- **Switches**: one row per switch with its ports (top bar = link speed, line = activity, dot = PoE,
  outline = uplink, red = new errors), uptime, CPU, temperature, PoE budget, uplink and totals; "live via
  SNMP" means the counters are read straight from the switch every 3 s.
- **Broadcast equipment**: the roster, grouped by location, with a tally lamp, link, the device's own
  status (Web Presenter *Streaming 5.8 Mb/s*, HyperDeck *Record*, ATEM *program Camera 2*), traffic and
  probe round trip. **Edit roster** opens the table where devices are ticked in or out of *this
  broadcast*, renamed, regrouped, given a probe/telemetry/minimum link speed, added or removed. Unticked
  devices sit in a collapsed *standby* list: still shown, never probed, never an alert. The inspector of
  any device also has *Put on standby* / *Add to this broadcast*.
- **What changed** / **UniFi events**: Broadwatcher's own event tape (streams starting and stopping, ports
  up/down, devices leaving or returning, alerts raised and cleared, record and stream state) and the
  controller log.
- **Inspector / AI**: the right rail. With nothing selected it shows the AI verdict (Ready / Degraded /
  At risk / Down), why, what to do now, a *Reassess* button and **Ask the engineer**, a chat box that
  answers from the live state.
- **Control connection** (in the switcher's inspector): how the switcher is read. By default Broadwatcher
  reads the HD8 **through Bitfocus Companion**, which already holds a control session, so Broadwatcher takes
  none of the switcher's few slots. The section shows Companion's connection state, Broadwatcher's own
  session (none, held, refused with the next attempt time, or released), the list of programs believed to
  hold a slot (Companion and the NDI Machine bridge are detected on this PC; ATEM Software Control on the Mac
  cannot be seen from here), and the switch to *own session* for the raw protocol capture.

## How the stream detection works

The UniFi controller only refreshes a switch's port counters when that switch *informs* it (every 30–90 s),
so Broadwatcher reads the counters straight from the switches over **SNMP every 3 s**, reads the encoders
directly every 10–20 s (the field ATEM's stream state, bitrate and destination URL over the ATEM protocol;
the Web Presenters' status and bitrate over REST), and lists gateway flows aimed at the ATEM with their
source and destination port. A stream from a device on the same VLAN as the ATEM never passes the gateway,
so it is detected from the intake counters and attributed from the encoder telemetry or rate matching.

## Install

Downloads are on the **Releases** page of this private repository.

**Mac**: open the `.dmg` (universal) and drag *Broadwatcher* to Applications. The app is not notarised, so
the first launch needs **right-click > Open > Open** (or `xattr -d com.apple.quarantine "/Applications/Broadwatcher.app"`).

**Windows**: run the installer or the portable exe. SmartScreen will say "Windows protected your PC":
**More info > Run anyway** (not code-signed). The earlier *BIG NetWatch* app is a separate program; uninstall
it from Settings > Apps.

The app talks to the UDM at `https://192.168.20.1` with the embedded Integrations API key, so it works only
on the BIG network (or over VPN). Nothing leaves the LAN unless the AI is pointed at Anthropic.

## Settings and the AI toggle

The gear button in the top bar (or **Broadwatcher > Settings…**, Ctrl/Cmd+,) opens the Settings screen:

- **AI**: a two-way switch between a **local AI server** (LM Studio, Ollama, vLLM, anything OpenAI-compatible:
  URL, model, optional key) and **Claude** (your Anthropic API key, model Opus 5.5 / Sonnet 5.5 / Haiku 5.5,
  effort). Each side has a *Test* button that sends one tiny request. The same Local / Claude switch sits
  next to *Reassess now* in the readiness rail for one-click changes during a show; it only offers the
  providers that are set up. Keys are stored in your local config file and masked in the screen (an empty
  field keeps the saved key, *Remove* forgets it).
- **UniFi gateway** (URL, Integrations API key, site), **SNMP** (community, interval), **Companion** (API
  address, ATEM connection label, start with Broadwatcher), **Server** (listen on this computer only or on the
  LAN, port; applies after a restart) and the alert **thresholds**. Gateway, SNMP and poll changes restart the
  polling in place; AI, thresholds, Companion and the switcher mode apply immediately.

## Two builds: Broadwatcher and Broadwatcher Community

Every release carries two flavours built from the same code:

- **Broadwatcher** (`Broadwatcher-<version>-…`): BIG's own build. `config.json` is bundled with the UniFi key,
  the roster, the VLANs and, when the repository secret `ANTHROPIC_API_KEY` is set in GitHub (Settings >
  Secrets and variables > Actions), the Claude key, embedded at build time by `scripts/embed-secrets.mjs`
  (then Claude is the default AI). The key never enters git.
- **Broadwatcher Community** (`Broadwatcher-Community-<version>-…`): the public build. `config.public.json`
  is bundled instead: no keys, no devices, Claude selected but without a key. On first start the Settings
  screen opens with a welcome note; enter the gateway URL and key, the SNMP community and either a local AI
  server or an Anthropic key, then add devices with *Edit roster*. It installs beside the BIG build (its own
  app id and user-data folder, `Broadwatcher Community`).

Build one locally with `node scripts/build-flavor.mjs public --win` (or `private`, `--mac`); the script writes
the electron-builder configuration to `dist/builder-<flavour>.json` and runs it.

## Configuration file

On first run the bundled config is copied to the app's user-data folder (**Broadwatcher > Open config
file**; macOS `~/Library/Application Support/Broadwatcher/config.json`, Windows `%APPDATA%\Broadwatcher\config.json`).
The roster and the Settings screen write there; anything else can be edited in the file, then
**Broadwatcher > Restart server**. Updates keep your edits: the bundled file carries a `config_version`, and a
roster edited in the app always wins over the bundled list (new bundled devices are appended on standby).

- `gateway`: URL, Integrations API key, site.
- `atem`: the switcher the intake meter and stream detector watch (`ip`, `control_port`); `session` = how it
  is read: `companion` (default, through Companion, no slot), `auto` (Companion, own session only while
  Companion is away for 3 min), `own` (always one session of its own; enables the protocol capture), `none`;
  `controllers[]` = the programs listed in the slot census (`detect`: `companion`, `process:<exe>` or empty).
- `companion`: `url` of Companion's HTTP API (`http://127.0.0.1:8000`), `atem_label` (the bmd-atem connection
  label, `atem`), `autostart` (the Electron app starts Companion when it is not running).
- `equipment[]`: `active`, `name`, `ip`, `group`, `role`, optional `probe` (`tcp:<port>`, `atem`, `x32`),
  `telemetry` (`webpresenter`, `hyperdeck`, `atem`), `companion` (Companion connection label for a switcher),
  `min_speed`, `hero: true` for the main switcher.
- `networks[]`: VLANs in the HUD. `poll`: intervals. `thresholds`: alert levels incl. `stream_min_mbps`.
- `snmp.community`: the SNMP v2c community (`netwatch`, enabled in UniFi on 2026-10-18).
- `ai`: `base_url` of any OpenAI-compatible server (default LM Studio on the Broadcast Pix PC,
  `http://192.168.20.75:1234/v1`, model `gemma-flash`), or Anthropic's API for use away from the studio or for a
  stronger model: set `provider: "anthropic"` and `anthropic_api_key` (or set the `ANTHROPIC_API_KEY` environment
  variable on the machine), `anthropic_model` (default `claude-opus-5-5`) and `anthropic_effort` (`low`, `medium`,
  `high`). Never paste the key anywhere but that file. A readiness assessment is a few thousand input tokens and a
  few hundred out; at the default three-minute cadence that is roughly $0.50 an hour of open app on Opus 5.5.

Without Electron (Node 22+): `node server/server.js [config.json]`, then open `http://127.0.0.1:8766`.
`NETWATCH_HOST=0.0.0.0` exposes it to the LAN. `GET /api/ai/digest` shows exactly what the AI is told.

## Things to set up in UniFi

1. **SNMP is on** (Settings > System > Advanced > SNMP, v1 & 2c, community `netwatch`). If the community
   ever changes, change `snmp.community` too.
2. **Name every broadcast device** in UniFi and give the important ones **fixed IPs**; the roster is keyed
   by IP. Unnamed Blackmagic devices today: 192.168.20.176 (Fiber Agg port 20), 192.168.20.237
   "BIGs-Air-2", 192.168.5.78.
3. **Give remote encoders their own VLAN** (or let them arrive from the internet) so their streams cross
   the gateway and show up as *confirmed* flows with source and destination port.
4. Keep **Traffic Identification / Flows** on.
5. ATEM switchers have a handful of control-connection slots and the HD8 keeps a dead or half-open session
   for about two minutes before freeing its slot. On this network three programs hold a slot all the time:
   Companion, ATEM Software Control and the NDI Machine ATEM bridge (`atem-remote.exe`, started with NDI
   Machine), and that already fills the HD8: the fourth knock is refused with "too many clients". So
   Broadwatcher takes **no slot**: it reads the switcher through Companion (the default), and only opens a
   session of its own when switched to *own session* (one slot, never more than one hello per two minutes,
   backing off 2, 4, 8 then 15 minutes when refused). A second copy of Broadwatcher on the Mac reads nothing
   from the switcher until Companion's API is reachable from there. If the switcher refuses even with those
   three closed, something else is opening sessions in a loop; a power-cycle of the switcher clears phantoms.

## Development

`npm install`, `npm start` (Electron) or `npm run serve` (server only). Releases: bump the version in
`package.json`, push a `v*` tag; GitHub Actions creates the release, then builds the Mac (dmg + zip,
universal) and Windows (installer + portable) packages into it.

Server modules: `server/unifi.js` (API client), `server/snmp.js` (SNMP v2c), `server/collector.js` (polls,
rates, stream detector, topology, alerts, event tape, roster, inspector details), `server/probe.js`
(TCP / X32 OSC), `server/rest.js` (Blackmagic REST), `server/atem.js` (read-only ATEM protocol client with
the remote-source command capture), `server/companion.js` (Companion HTTP API), `server/ai.js` (digest +
prompts), `server/server.js` (HTTP + SSE + roster API). UI: `ui/app.js`, `ui/map.js`, `ui/styles.css`
(light and dark themes). `node scripts/atem-capture.mjs [ip]` captures the HD8's undocumented remote-source
commands once (one abandoned session: only when no show is on).
