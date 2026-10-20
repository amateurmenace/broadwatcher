# Broadwatch

A broadcast-network console for Brookline Interactive Group, for Mac and Windows. It reads the UniFi
Network API and SNMP on the UDM Pro Max and switches, talks to the Blackmagic gear directly (REST on the
Web Presenters and HyperDecks, the ATEM protocol on the switchers) and asks a local AI model to judge
broadcast readiness and explain problems.

## What is on screen

- **HUD** (always on top): the readiness lamp and headline, the **ATEM intake** meter (traffic arriving at
  the switcher, with its quiet level marked), WAN in/out and latency, console CPU/temperature, one cell per
  broadcast VLAN (name, VLAN number, in/out and a 10-minute sparkline, client count; which VLANs and in what
  order is a Settings field), the open-alert count ("2 warnings", "1 error" or "all clear"), the clock,
  Settings, the light/dark switch and the readiness-rail toggle (or the `R` key). The clock and the controls
  always fit; the cells drop off whole on narrow windows instead of being cut (console under 1700 px, then
  the VLANs one by one).
- **Section bar**: Health · Gateway · Signal map · Streams · Stream paths · Audio · Forensics · Switches ·
  Equipment · Events, each a jump link; every section has a ▾ to collapse it (remembered), so the map can
  take the room.
- **Broadcast health** (the glance board): one lamp and a score out of 100 computed from everything that
  affects a healthy stream (internet, switches, port errors, link speeds, port load, the switcher, the
  roster, stream out, stream in, recorders, audio, mics, Dante, NDI, error alerts), each factor weighed and
  judged against the active **show profile** (what the show expects: streaming out, remote sources in,
  recorders rolling, mics, Dante, NDI). Ready ≥ 90, Degraded ≥ 72, At risk ≥ 50, else Down; a critical factor
  at zero (WAN down, a switch with broadcast gear offline, the switcher off the network, an interrupted
  stream) pulls the verdict to at least At risk. Then eight tiles: Stream out · Stream in · Audio · Dante ·
  NDI · Mics · Network · Recorders, each with a lamp, one number, one line and a 10-minute sparkline (the
  Audio tile carries a live meter strip instead, one thin bar per X32 channel plus the main pair; the Mics
  tile one battery bar per receiver channel); clicking one opens the thing behind it. The AI narrates on top of the score (its headline, reasons and
  actions) but never changes the verdict; the HUD lamp is the score. **Prepare a broadcast…** picks or
  creates a profile, sets its expectations, ticks the roster (unticked devices go on standby), runs *Test
  every probe* and saves; the profile menu in the header switches profiles without touching the roster.
- **Issues strip**: every open alert as a chip. Click one and the inspector explains what it means, shows
  the device/port it is about, the related UniFi events, flows and Broadwatch events, and offers
  **Diagnose with AI**.
- **Gateway at a glance**: WAN in/out with a 10-minute graph, the VLAN table (clients, in, out, sparkline),
  the console's CPU/memory/temperature gauges with uptime, switch and AP counts, storage and SNMP coverage,
  and the biggest flows of the last poll.
- **Signal map**: a schematic of the live network, internet → console → switches → equipment. Links are
  hairlines with two thin flowing strands, orange towards the device (traffic into it) and teal back out
  of it; brighter and faster means more traffic, every node shows its live in/out numbers and trunk links
  are labelled. A stream arriving at the ATEM turns its link cyan. The map pans with the wheel or by
  dragging, zooms with ctrl/⌘ + wheel or the −/+ buttons, fits with *fit* or a double-click, and its
  height is dragged at the bottom-right corner; the view is remembered. Click anything for details;
  "every switch" also shows switches that carry no broadcast gear.
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
- **Audio**: live meters from the X32 consoles and the state of the wireless mics, with their real sources.
  Every X32 in the roster with the probe `x32` streams its meters over OSC (the open Behringer protocol,
  ten updates a second): 32 channels, 16 mix buses, 6 matrices and the main L/R/mono as thin horizontal
  bars with the level in dBFS, a 1.5-second peak hold, the channel names and mutes from the console.
  Every Sennheiser EW-DX receiver in the roster (role *audio*, recognised by a name or vendor that says
  so) is read over SSC, Sennheiser's JSON-over-UDP control protocol: per receiver channel the name,
  frequency, whether a transmitter is linked (off = "transmitter off", never a guess), the transmitter's
  battery with the minutes left, the RF quality (RSQI, with the RSSI and the antenna in use), the audio
  level, mutes and the receiver's own warnings. A roster audio device that has neither (the field X32
  Dante card) is listed with "nothing to read". The switcher's own Fairlight levels appear here only when
  Broadwatch holds its own session with it (Settings > Switcher: *own session*); read through Companion,
  the switcher sends no levels. Alerts: a transmitter below 20 % battery (error below 10 %), RF quality
  below 30 %, and, when the show profile expects mics, a mic that is muted or off.
- **Stream forensics**: with a switch port mirrored from the switcher's port into a spare network adapter of
  this computer, Broadwatch runs tshark on it and shows the switcher's traffic as the switcher sees it:
  every **control session** (who holds one, since when, how many packets a second; two programs on one
  computer show as two sessions) and every hello the switcher **refused** with "too many clients"; every
  **flow** at its port (RTMP with the app name, a masked stream key, the encoder and the switcher's answer;
  SRT handshakes with version, latency and stream id; the HTTPS the switcher itself opens to the cloud),
  with rates both ways; and an event tape. A sender the switcher turns away is the point of it: a reset or a
  close before any publish is accepted shows as "rejected", with an alert that names the usual causes
  (wrong key or app, a format it will not take, the remote source switched off). Start/stop in the section
  header; the interface and tshark path live in Settings > Capture. Mirroring copies packets in the switch's
  hardware and does not touch the switcher's own traffic; a 2.5G mirror port never drops copies of a 1G link.
- **Switches**: one row per switch with its ports (top bar = link speed, line = activity, dot = PoE,
  outline = uplink, red = new errors, violet corner = labelled by hand), uptime, CPU, temperature, PoE
  budget, uplink and totals; "live" means the counters are read straight from the switch over SNMP every
  3 s. **ports ▸** opens the port list of a switch: every port that is up with the device UniFi sees on it
  (name and IP, from the client and device tables), its traffic both ways, and a hand-written **label**
  (device name, IP, note) for what UniFi cannot see: SDI gear behind a small switch, static devices,
  patch-panel positions. Labels are also edited in the port's inspector and are saved in the config file.
  The **find** box above the switches highlights every port (and map node) whose device, IP or label
  matches, and opens the lists that contain a match.
- **Broadcast equipment**: the roster, grouped by location, with a tally lamp, link, the device's own
  status (Web Presenter *Streaming 5.8 Mb/s*, HyperDeck *Record*, ATEM *program Camera 2*), traffic and
  probe round trip. **Edit roster** opens the table where devices are ticked in or out of *this
  broadcast*, renamed, regrouped, given a probe/telemetry/minimum link speed, added or removed. Unticked
  devices sit in a collapsed *standby* list: still shown, never probed, never an alert. The inspector of
  any device also has *Put on standby* / *Add to this broadcast*.
- **Log**: everything that went wrong, and right again, in one filterable table that survives restarts:
  alerts raised and cleared (with how long each lasted and "still open"), port load, flapping links,
  devices leaving and returning, streams, the notable controller events, AI and app errors. Filter by
  level (errors / warnings / notes / cleared), category, free text and time window (last hour to 30 days),
  or "only still open"; click a row for the explanation, the device behind it and an "Ask the AI about
  this" button; *Copy* puts the visible rows on the clipboard, *CSV* downloads them. Kept 30 days in
  `journal/` beside the config file, one file per day.
- **UniFi events**: the controller's own log, newest first.
- **Inspector / AI**: the right rail. With nothing selected it shows the AI verdict (Ready / Degraded /
  At risk / Down), why, what to do now, a *Reassess* button and **Ask the engineer**, a chat box that
  answers from the live state.
- **Control connection** (in the switcher's inspector): how the switcher is read. By default Broadwatch
  reads the HD8 **through Bitfocus Companion**, which already holds a control session, so Broadwatch takes
  none of the switcher's few slots. The section shows Companion's connection state, Broadwatch's own
  session (none, held, refused with the next attempt time, or released), the list of programs believed to
  hold a slot (Companion and the NDI Machine bridge are detected on this PC; ATEM Software Control on the Mac
  cannot be seen from here), and the switch to *own session* for the raw protocol capture.

## How the stream detection works

The UniFi controller only refreshes a switch's port counters when that switch *informs* it (every 30–90 s),
so Broadwatch reads the counters straight from the switches over **SNMP every 3 s**, reads the encoders
directly every 10–20 s (the field ATEM's stream state, bitrate and destination URL over the ATEM protocol;
the Web Presenters' status and bitrate over REST), and lists gateway flows aimed at the ATEM with their
source and destination port. A stream from a device on the same VLAN as the ATEM never passes the gateway,
so it is detected from the intake counters and attributed from the encoder telemetry or rate matching.

## Install

Downloads are on the **Releases** page of this private repository.

**Mac**: open the `.dmg` (universal) and drag *Broadwatch* to Applications. The app is not notarised, so
the first launch needs **right-click > Open > Open** (or `xattr -d com.apple.quarantine "/Applications/Broadwatch.app"`).

**Windows**: run the installer or the portable exe. SmartScreen will say "Windows protected your PC":
**More info > Run anyway** (not code-signed). The earlier *BIG NetWatch* app is a separate program; uninstall
it from Settings > Apps.

The app talks to the UDM at `https://192.168.20.1` with the embedded Integrations API key, so it works only
on the BIG network (or over VPN). Nothing leaves the LAN unless the AI is pointed at Anthropic.

## Settings and the AI toggle

The gear button in the top bar (or **Broadwatch > Settings…**, Ctrl/Cmd+,) opens the Settings screen:

- **AI**: a two-way switch between a **local AI server** (LM Studio, Ollama, vLLM, anything OpenAI-compatible:
  URL, model, optional key) and **Claude** (your Anthropic API key, model Opus 5.5 / Sonnet 5.5 / Haiku 5.5,
  effort). Each side has a *Test* button that sends one tiny request. The same Local / Claude switch sits
  next to *Reassess now* in the readiness rail for one-click changes during a show; it only offers the
  providers that are set up. Keys are stored in your local config file and masked in the screen (an empty
  field keeps the saved key, *Remove* forgets it).
- **UniFi gateway** (URL, Integrations API key, site), **Switcher** (name, IP and how it is read: through
  Companion, an own session, or not at all; the help text says why Fairlight audio levels need an own
  session), **SNMP** (community, interval), **Companion** (API address, ATEM connection label, start with
  Broadwatch), **Server** (listen on this computer only or on the LAN, port; applies after a restart) and
  the alert **thresholds**, including the mic battery and RF quality levels. Gateway, SNMP and poll changes
  restart the polling in place; AI, thresholds, Companion and the switcher mode apply immediately.

## On a phone

**Broadwatch > Open on a phone…** shows the link to the phone page (`/m`): the health verdict and score,
the eight tiles, open items, streams into the switcher, the stream paths, the wireless mics (one row per
receiver channel with battery, RF and audio bars), the Ask box, the log (errors and warnings of the last
24 hours) and the event tape, in one column, live over
the same server-sent events as the desk. The server must listen on the LAN (the menu
offers to switch *Settings > Server* to the whole LAN and restart; Windows asks once to allow Broadwatch
through the firewall). The link carries an access key generated once per install (`server.token` in the
config file); the phone keeps it in a cookie, and anything on the LAN without the key gets a 401. Open the
link in Safari or Chrome and *Add to Home Screen*: the page has a manifest and an icon.

## Two builds: Broadwatch and Broadwatch Community

Every release carries two flavours built from the same code:

- **Broadwatch** (`Broadwatch-<version>-…`): BIG's own build. `config.json` is bundled with the UniFi key,
  the roster, the VLANs and, when the repository secret `ANTHROPIC_API_KEY` is set in GitHub (Settings >
  Secrets and variables > Actions), the Claude key, embedded at build time by `scripts/embed-secrets.mjs`
  (then Claude is the default AI). The key never enters git.
- **Broadwatch Community** (`Broadwatch-Community-<version>-…`): the public build. `config.public.json`
  is bundled instead: no keys, no devices, Claude selected but without a key. On first start the Settings
  screen opens with a welcome note; enter the gateway URL and key, the SNMP community and either a local AI
  server or an Anthropic key, then add devices with *Edit roster*. It installs beside the BIG build (its own
  app id and user-data folder, `Broadwatch Community`).

Build one locally with `node scripts/build-flavor.mjs public --win` (or `private`, `--mac`); the script writes
the electron-builder configuration to `dist/builder-<flavour>.json` and runs it.

## Configuration file

On first run the bundled config is copied to the app's user-data folder (**Broadwatch > Open config
file**; macOS `~/Library/Application Support/Broadwatch/config.json`, Windows `%APPDATA%\Broadwatch\config.json`).
The roster and the Settings screen write there; anything else can be edited in the file, then
**Broadwatch > Restart server**. Updates keep your edits: the bundled file carries a `config_version`, and a
roster edited in the app always wins over the bundled list (new bundled devices are appended on standby).

- `gateway`: URL, Integrations API key, site.
- `atem`: the switcher the intake meter and stream detector watch (`ip`, `control_port`); `session` = how it
  is read: `companion` (default, through Companion, no slot), `auto` (Companion, own session only while
  Companion is away for 3 min), `own` (always one session of its own; enables the protocol capture), `none`;
  `controllers[]` = the programs listed in the slot census (`detect`: `companion`, `process:<exe>` or empty).
- `companion`: `url` of Companion's HTTP API (`http://127.0.0.1:8000`), `atem_label` (the bmd-atem connection
  label, `atem`), `autostart` (the Electron app starts Companion when it is not running).
- `profiles[]` (`id`, `name`, `expect` {stream_out, stream_in, recording, mics, dante, ndi}, optional
  `roster` = the IPs that are active in that show) and `active_profile`; edited with *Prepare a broadcast*.
- `server`: `host` (`127.0.0.1`, or `0.0.0.0` for phones), `port`, `token` (the phone access key, generated).
- `port_labels`: hand-written labels per switch port (`"<switch mac>:<port>": {name, ip, note}`).
- `capture`: `interface` (the adapter on the mirror port, as tshark lists it), `tshark` (path; empty = the
  usual place), `enabled`. Setting up the mirror in UniFi: Devices > the switch > Ports > a spare port >
  Port Manager > Operation Mirroring, source = the switcher's port. Install Wireshark with Npcap on this
  computer; give the adapter no IP (it gets none anyway).
- `equipment[]`: `active`, `name`, `ip`, `group`, `role`, optional `probe` (`tcp:<port>`, `atem`, `x32`; an
  X32 with this probe also streams its meters), `telemetry` (`webpresenter`, `hyperdeck`, `atem`),
  `companion` (Companion connection label for a switcher), `min_speed`, `hero: true` for the main switcher. A
  device with role `audio` whose name says EW-DX / receiver / wireless mic (or whose vendor is Sennheiser or
  Shure) is read over SSC on UDP 45.
- `thresholds.mic_battery_pct` (20) and `thresholds.mic_rf_pct` (30): the mic alert levels.
- `networks[]`: VLANs in the HUD, in that order (Settings > UniFi gateway > *VLANs in the top bar*; once
  edited there, `networks_edited` keeps your list across upgrades). `poll`: intervals. `thresholds`: alert
  levels incl. `stream_min_mbps`.
- `retired_equipment[]`: IPs of devices that left the building; a config upgrade removes them even from a
  roster edited in the app.
- `ai.anthropic_workspace_id`: only for an Anthropic key that is not scoped to a workspace (the API then
  answers 400 "must include the anthropic-workspace-id header"); the id is under console.anthropic.com >
  Settings > Workspaces. The private build takes it from the `ANTHROPIC_WORKSPACE_ID` repository secret.
- The log lives in `journal/` beside the config file: one JSON-lines file per day, 30 days, readable with
  any text tool.
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
   Broadwatch takes **no slot**: it reads the switcher through Companion (the default), and only opens a
   session of its own when switched to *own session* (one slot, never more than one hello per two minutes,
   backing off 2, 4, 8 then 15 minutes when refused). A second copy of Broadwatch on the Mac reads nothing
   from the switcher until Companion's API is reachable from there. If the switcher refuses even with those
   three closed, something else is opening sessions in a loop; a power-cycle of the switcher clears phantoms.

## Development

`npm install`, `npm start` (Electron) or `npm run serve` (server only). Releases: bump the version in
`package.json`, push a `v*` tag; GitHub Actions creates the release, then builds the Mac (dmg + zip,
universal) and Windows (installer + portable) packages into it.

Server modules: `server/unifi.js` (API client), `server/snmp.js` (SNMP v2c), `server/collector.js` (polls,
rates, stream detector, topology, alerts, event tape, roster, inspector details), `server/probe.js`
(TCP / X32 OSC), `server/rest.js` (Blackmagic REST), `server/atem.js` (read-only ATEM protocol client with
the remote-source command capture and the Fairlight level request), `server/x32.js` (X32 meters over OSC),
`server/ssc.js` (Sennheiser EW-DX over SSC), `server/companion.js` (Companion HTTP API), `server/ai.js`
(digest + prompts), `server/server.js` (HTTP + SSE + roster API). UI: `ui/app.js`, `ui/map.js`, `ui/styles.css`
(light and dark themes). `node scripts/atem-capture.mjs [ip]` captures the HD8's undocumented remote-source
commands once (one abandoned session: only when no show is on).
