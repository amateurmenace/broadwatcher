# BIG NetWatch

A signal console for Brookline Interactive Group's broadcast network, for Mac and Windows. It reads the
UniFi Network API on the UDM Pro Max, talks to the Blackmagic gear directly (REST on the Web Presenters and
HyperDecks, the ATEM protocol on the switchers) and asks a local AI model to judge broadcast readiness and
explain problems.

## What is on screen

- **HUD** (always on top): the AI readiness lamp and headline, the **ATEM intake** meter (traffic arriving at
  the switcher, with its quiet baseline marked), WAN in/out and latency, console CPU/temperature, the four
  broadcast VLANs as mini bar graphs, the biggest flow of the moment, the open-issue count and the clock.
  **DETAILS** (or the `H` key) drops a panel with the biggest flows, the VLAN table, console vitals and the
  full AI assessment.
- **Issues strip**: every open alert as a chip. Click one and the inspector explains what it means, shows
  the device/port it is about, the related UniFi events, flows and NetWatch events, and offers
  **Diagnose with AI**.
- **Signal map**: a schematic of the live network, internet → console → switches → equipment. Every link has
  two animated strands: amber flowing towards the device (traffic into it), blue flowing back (out of it);
  the width follows the rate. A stream arriving at the ATEM makes its link glow cyan. Click anything for
  details; "every switch" also shows switches that carry no broadcast gear.
- **Streams into the ATEM**: the intake readout with a scope of the last 10 minutes, the stream state
  (quiet / arriving since…), and *where it comes from*, with a confidence for each candidate source:
  - **confirmed**: a flow through the gateway aimed at the ATEM (internet or other VLAN: source IP, country,
    destination port and protocol), or an ATEM Mini whose own stream URL points at the ATEM;
  - **likely**: a Web Presenter that is streaming at about the rate that is arriving;
  - **possible**: any encoder sending about the same rate at the same moment.
- **Switch rack**: each switch as a rack unit with its port LEDs (colour = link speed, bar = activity, dot =
  PoE, outline = uplink, red = new errors), uptime, CPU, temperature, PoE budget, uplink and totals. Click a
  port or a switch for its details. Not-connected kit (portable Flex Minis, spares) is listed as chips.
- **Broadcast equipment**: a patch-bay list grouped by location: tally lamp, name, IP, switch/port/speed,
  the device's own status (Web Presenter *Streaming 5.8 Mb/s 1080p29.97*, HyperDeck *RECORDING 01:02:03*,
  ATEM *PGM Camera 2*), traffic in/out and the probe round trip.
- **What changed**: NetWatch's own event tape (streams starting/stopping, ports going up/down, devices
  leaving or returning, alerts raised and cleared, Web Presenter stream state, HyperDeck record state).
- **UniFi events**: the controller log with the placeholders resolved.
- **Inspector / AI**: the right rail. With nothing selected it shows the AI verdict (READY / DEGRADED /
  AT RISK / DOWN), why, what to do now, a *Reassess* button and **Ask the engineer**, a chat box that
  answers from the live state ("is the field kit ready?", "why is the NDI VLAN busy?").

## How the stream detection works (and why it used to lag)

The UniFi controller only refreshes a switch's port counters when that switch *informs* it, which
happens every 30–90 s unless the UniFi web UI is watching that switch. That is why the Companion tiles and
the first NetWatch looked static and why a stream took a while to appear. NetWatch now:

1. computes rates at the moment a counter changes (and shows "counters N s old");
2. reads the encoders directly every 10 s: the field ATEM Mini's stream state, bitrate and destination URL
   over the ATEM protocol, and the Web Presenters' status/bitrate over their REST API, so a stream from
   known gear is reported within seconds even while the switch counters lag;
3. reads the port counters **straight from the switches over SNMP every 3 s** (true real time; SNMP is on
   since 2026-10-18);
4. lists gateway flows aimed at the ATEM with their source and destination port.

A stream from a device on the **same VLAN** as the ATEM never passes the gateway, so it has no flow record;
it is detected from the port counters/SNMP and attributed from the encoder telemetry or rate matching.

## Install

Downloads are on the **Releases** page of this private repository.

**Mac**: open the `.dmg` (universal) and drag *BIG NetWatch* to Applications. The app is not notarised, so
the first launch needs **right-click > Open > Open** (or `xattr -d com.apple.quarantine "/Applications/BIG NetWatch.app"`).

**Windows**: run the installer or the portable exe. SmartScreen will say "Windows protected your PC":
**More info > Run anyway** (not code-signed).

The app talks to the UDM at `https://192.168.20.1` with the embedded Integrations API key, so it works only
on the BIG network (or over VPN). Nothing leaves the LAN except, optionally, the AI calls if you point them
at Anthropic instead of the local model.

## Configuration

On first run the bundled `config.json` is copied to the app's user-data folder (**NetWatch > Open config
file**; macOS `~/Library/Application Support/BIG NetWatch/config.json`, Windows `%APPDATA%\BIG NetWatch\config.json`).
Edit it, then **NetWatch > Restart server**.

- `gateway`: URL, Integrations API key, site.
- `atem`: the switcher the intake meter and stream detector watch (`ip`, `control_port`).
- `equipment[]`: `name`, `ip`, `group`, `role` (switcher / router / recorder / encoder / computer / audio /
  unknown), optional `probe` (`tcp:<port>`, `atem`, `x32`), optional `telemetry` (`webpresenter`, `hyperdeck`,
  `atem`), optional `min_speed`, `hero: true` for the ATEM.
- `networks[]`: VLANs in the HUD. `poll`: intervals. `thresholds`: alert levels incl. `stream_min_mbps` (how
  far above its baseline the intake must rise to count as a stream).
- `snmp.community`: set it to turn on real-time port counters from the switches.
- `ai`: `base_url` of any OpenAI-compatible server (default: LM Studio on the Broadcast Pix PC,
  `http://192.168.20.75:1234/v1`, model `gemma-flash`; the PC must be on and LM Studio's server running with
  "serve on local network"), or `provider: "anthropic"` + `anthropic_api_key` to use Claude instead.
  `assess_every_s` controls the automatic reassessment (it also re-runs when the set of alerts changes).

Without Electron (Node 22+): `node server/server.js [config.json]`, then open `http://127.0.0.1:8766`.
`NETWATCH_HOST=0.0.0.0` exposes it to the LAN. `GET /api/ai/digest` shows exactly what the AI is told.

## Things to set up in UniFi

1. **SNMP is enabled** (UniFi Network > Settings > System > Advanced > SNMP, version 1 & 2c, community
   `netwatch`, done 2026-10-18) and the community is in `snmp.community`, so every up port on every switch is
   read every 3 s ("live via SNMP" in the rack). If the community string ever changes in UniFi, change it in
   the config too. UniFi switches name their interfaces `0/<port>`, the UDM `eth<n>` (eth0 = port 1).
2. **Name every broadcast device** in UniFi and give the important ones **fixed IPs**; the config is keyed by
   IP. Unnamed Blackmagic devices today: 192.168.20.176 (Fiber Agg port 20, 10 G), 192.168.20.237
   "BIGs-Air-2" (Video Rack port 32), 192.168.5.78 (Audio Rack port 7).
3. **Give remote encoders their own VLAN** (e.g. `BIG_REMOTE`) or let them arrive from the internet, so their
   streams cross the gateway and show up as *confirmed* flows with source and destination port.
4. Keep **Traffic Identification / Flows** on, and consider a dedicated Integrations API key named `netwatch`
   so it can be revoked separately from the Companion poller's key.
5. The HD8 reports **"too many clients"** when every control-connection slot is used (ATEM Software Control,
   Companion, panels). NetWatch warns when that happens; close unused ATEM Software Control windows.

## Development

`npm install`, `npm start` (Electron) or `npm run serve` (server only). Releases: bump the version in
`package.json`, push a `v*` tag; GitHub Actions builds the Mac (dmg + zip, universal) and Windows (installer +
portable) packages and publishes them to the release. Caches on the Broadcast Pix PC live on `A:\AI`.

Server modules: `server/unifi.js` (API client), `server/collector.js` (polls, rates, stream detector, topology,
alerts, event tape, inspector details), `server/probe.js` (TCP / ATEM hello / X32 OSC), `server/rest.js`
(Blackmagic REST), `server/atem.js` (read-only ATEM protocol client), `server/snmp.js` (SNMP v2c),
`server/ai.js` (digest + prompts), `server/server.js` (HTTP + SSE). UI: `ui/app.js`, `ui/map.js`, `ui/styles.css`.
