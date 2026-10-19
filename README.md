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

## Configuration

On first run the bundled `config.json` is copied to the app's user-data folder (**Broadwatcher > Open config
file**; macOS `~/Library/Application Support/Broadwatcher/config.json`, Windows `%APPDATA%\Broadwatcher\config.json`).
The roster is edited in the app and saved there; everything else is edited in the file, then
**Broadwatcher > Restart server**. Updates keep your edits: the bundled file carries a `config_version`, and a
roster edited in the app always wins over the bundled list (new bundled devices are appended on standby).

- `gateway`: URL, Integrations API key, site.
- `atem`: the switcher the intake meter and stream detector watch (`ip`, `control_port`).
- `equipment[]`: `active`, `name`, `ip`, `group`, `role`, optional `probe` (`tcp:<port>`, `atem`, `x32`),
  `telemetry` (`webpresenter`, `hyperdeck`, `atem`), `min_speed`, `hero: true` for the main switcher.
- `networks[]`: VLANs in the HUD. `poll`: intervals. `thresholds`: alert levels incl. `stream_min_mbps`.
- `snmp.community`: the SNMP v2c community (`netwatch`, enabled in UniFi on 2026-10-18).
- `ai`: `base_url` of any OpenAI-compatible server (default LM Studio on the Broadcast Pix PC,
  `http://192.168.20.75:1234/v1`, model `gemma-flash`) or `provider: "anthropic"` + `anthropic_api_key`.

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
5. ATEM switchers have a handful of control-connection slots (ATEM Software Control, Companion, panels) and
   the HD8 keeps a dead or half-open session for about two minutes before freeing its slot. Broadwatcher
   therefore holds exactly one session per switcher for as long as it runs, keeps it across *Restart server*,
   never sends bare hellos, and never opens more than one session per two minutes per switcher even if the
   link flaps or the switcher refuses. A second running copy (for example on the Mac) is a second slot; set
   the switcher's telemetry to *none* in that copy's roster if slots are tight. If a switcher ever reports
   "too many clients" with only the expected controllers connected, something else is opening sessions in a
   loop; the only way to clear phantom sessions quickly is a power-cycle of the switcher.

## Development

`npm install`, `npm start` (Electron) or `npm run serve` (server only). Releases: bump the version in
`package.json`, push a `v*` tag; GitHub Actions creates the release, then builds the Mac (dmg + zip,
universal) and Windows (installer + portable) packages into it.

Server modules: `server/unifi.js` (API client), `server/snmp.js` (SNMP v2c), `server/collector.js` (polls,
rates, stream detector, topology, alerts, event tape, roster, inspector details), `server/probe.js`
(TCP / X32 OSC), `server/rest.js` (Blackmagic REST), `server/atem.js` (read-only ATEM protocol client),
`server/ai.js` (digest + prompts), `server/server.js` (HTTP + SSE + roster API). UI: `ui/app.js`,
`ui/map.js`, `ui/styles.css` (light and dark themes).
