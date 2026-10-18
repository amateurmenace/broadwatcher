# BIG NetWatch

Real-time network and broadcast-equipment monitor for Brookline Interactive Group. One dark dashboard,
for Mac and Windows, fed by the UniFi Network API on the UDM Pro Max plus direct probes of the gear:

- **Switcher hero panel**: the ATEM Television Studio HD8 ISO, its switch port and link speed, live
  traffic into and out of it, whether its control port (UDP 9910) is answering and whether it still has a
  free client slot, and the **incoming streams** table: every flow whose destination is the ATEM, with the
  source (name, IP, country/zone), the destination port and protocol, bytes, and first/last seen. Live
  flows pulse green.
- **Broadcast equipment** cards grouped by location (Studio A, Town Hall, Field, Video rack, Audio rack):
  online/unresponsive/offline, which switch and port the device is on and at what speed, traffic to and
  from it with a sparkline, the control-port probe (HyperDeck 9993, Videohub 9990, Web Presenter 9977,
  ATEM 9910/UDP, X32 via OSC `/xinfo` which also returns the console's name and firmware) and who it has
  been talking to. Anything with a Blackmagic / Audinate / Sennheiser / Behringer / Ross / NewTek ... MAC
  that is not in the config appears under *Discovered*.
- **Switches**: one card per switch with uptime, CPU, memory, temperature, PoE budget, uplink (which
  switch/port, speed), a port grid laid out like the front panel (odd ports on top, even below, SFP
  group on the right) coloured by link speed with a utilisation bar, PoE marker, uplink ring and error
  outline. Hover a port for the attached client/device, rates, PoE watts and error counters. Switches
  that are not connected (portable Flex Minis, spares) are listed separately and only raise an alert if
  they were online in the last 24 h.
- **Console & networks**: UDM CPU/memory/temperatures/storage, WAN status, IP, latency, speedtest;
  per-VLAN routed traffic and client counts with sparklines; access points; SmartPower PDUs with outlet
  states and watts.
- **Traffic flows**: biggest flows of the last poll and all flows touching the broadcast gear.
- **UniFi events**: the system log with the placeholders resolved (client connected to X on switch Y
  port Z, config changes, admin logins).
- **Alerts** bar + header pill: WAN down/latency, gateway or switch CPU/temperature, offline switches,
  new port errors/drops, slow uplinks, equipment missing or not answering, video gear linked below 1 G,
  ATEM out of client connections.

Rates are computed from the switches' cumulative port counters at the moment they change (switches report
every 5-30 s; the "counters N s ago" text says how fresh they are), which is far livelier than UniFi's
own averaged "-r" numbers.

## Install

Downloads are on the GitHub **Releases** page of this (private) repository.

**Mac**: open the `.dmg` (universal: Apple Silicon and Intel) and drag *BIG NetWatch* to Applications.
The app is not notarised, so the first launch needs **right-click > Open > Open** (or run
`xattr -d com.apple.quarantine "/Applications/BIG NetWatch.app"` once).

**Windows**: run `BIG-NetWatch-<version>-win-x64.exe` (installer) or the `portable` exe. SmartScreen will say
"Windows protected your PC": click **More info > Run anyway** (the build is not code-signed).

The app talks to the UDM at `https://192.168.20.1` with the embedded local Integrations API key, so it only
works on the BIG network (or over VPN to it). Nothing leaves the LAN.

## Configuration

On first run the bundled `config.json` is copied to the app's user-data folder
(**NetWatch > Open config file** in the menu; macOS `~/Library/Application Support/BIG NetWatch/config.json`,
Windows `%APPDATA%\BIG NetWatch\config.json`). Edit it and use **NetWatch > Restart server**.

- `gateway`: URL, API key (UniFi Network > Settings > Control Plane > Integrations), site.
- `atem`: the switcher shown in the hero panel (`ip`, `control_port`, `probe`).
- `equipment[]`: `name`, `ip`, `group`, `role` (switcher / router / recorder / encoder / computer / audio /
  unknown), optional `probe` (`tcp:<port>`, `atem`, `x32`), optional `min_speed` (Mb/s; video gear defaults
  to 1000, set 100 for 100 Mb/s devices like older Videohubs and X32s), `hero: true` for the ATEM card.
- `networks[]`: VLAN names shown in the quick panel.
- `poll`: polling intervals in seconds; `thresholds`: alert levels.
- `auto_discover_ouis[]`: vendor strings that add unknown clients to the *Discovered* group.

Run it without Electron (any machine with Node 22+): `node server/server.js [path/to/config.json]` then open
`http://127.0.0.1:8766`. `NETWATCH_HOST=0.0.0.0` makes it reachable from other machines on the LAN.

## Things to set up in UniFi to get the most out of it

1. **Name every broadcast device** in UniFi (Clients > device > Settings > Name) and give the important
   ones **fixed IPs** (DHCP reservation). NetWatch shows UniFi's name next to its own and the config is
   keyed by IP. Unnamed Blackmagic devices today: 192.168.20.176 (Fiber Agg port 20, 10 G link),
   192.168.20.237 "BIGs-Air-2" (Video Rack port 32), 192.168.5.78 (Audio Rack port 7).
2. **Put remote encoders / streaming sources on their own VLAN** (or let them come in from the internet).
   UniFi only records a *flow* when the traffic passes through the UDM, so a stream from a device on the
   same VLAN as the ATEM (e.g. the field ATEM Mini Pro on `Default`) is only visible as port traffic on
   LIGHTHOUSE port 15, without source/port detail. A `BIG_REMOTE` VLAN for the Mini Pro / Web Presenter /
   Town Hall encoders makes every stream show up in the *Incoming streams → ATEM* table with its source
   and destination port.
3. **Keep Traffic Identification / Flows enabled** (Settings > Security / Traffic Management). The flows
   endpoint also honours the UDM's "Traffic Flows" retention.
4. **Local API key scope**: the key in `config.json` is a *gateway (local) Integrations key*. The Site
   Manager (cloud) key does not work against the local API. Create a dedicated key named `netwatch` so it
   can be revoked without touching the Companion poller's key.
5. **Fixed IP and name for the ATEM itself** (192.168.20.79, currently fingerprinted by UniFi as "ATEM
   Mini Pro f1:68") so the hero panel never loses it after a DHCP change.
6. Optional: enable **port names** on the switches (Ports > Edit > Name) for the ATEM, HyperDecks and
   encoders; the port tooltips show them.

## Development

```bash
npm install                 # Electron + electron-builder (set ELECTRON_CACHE to a drive with space)
npm run serve               # server only, http://127.0.0.1:8766
npm start                   # Electron window
npx electron . --smoke      # loads the window, prints SMOKE OK and quits
npm run dist:win            # Windows NSIS installer + portable exe into dist/
npm run dist:mac            # macOS dmg + zip (run on a Mac)
node build/make-icon.mjs    # regenerates build/icon.png from code (no image libraries needed)
```

Releases: push a tag `vX.Y.Z` and `.github/workflows/release.yml` builds on macOS and Windows runners and
uploads the installers to the GitHub release (macOS runner minutes count 10x against the private-repo quota).

Layout: `server/unifi.js` (API client), `server/collector.js` (polling, rates, flows, alerts),
`server/probe.js` (TCP / ATEM / X32 probes), `server/server.js` (HTTP + SSE + static UI), `ui/` (dashboard),
`main.js` (Electron shell), `config.json` (defaults, API keys included on purpose: private repo).
