# Broadwatch roadmap: from network monitor to broadcast console

Written 2026-10-19 after the 0.3.x releases. Steve's ask: monitor the Dante and NDI networks the way Dante
Controller and NDI Tools do (clocking, latency, sources, routing), show live stream and switcher statistics,
live audio meters with their real sources, X32 and wireless-mic state, one overall broadcast-health status
computed from everything that affects a healthy stream, a glanceable home view with detail views behind it,
an in-app setup process for a broadcast, a mobile version, and stronger foundations. Also: should a mirror
port watch the ATEM's traffic, and why do port-forwarded streams not reach the live ATEM input?

The sections below are ordered by value for a Town Meeting night. Each says what the source of truth is,
what has been verified on this network already, what must be set up, and how big the job is.

---

## 0. First: the port-forwarded stream that never goes live

Verified on the UDM tonight (`rest/portforward`):

| Name | WAN port | → LAN target |
|---|---|---|
| ATEM TV Studio HD8 Remote Source | **1937** tcp+udp | 192.168.20.79:**1935** (the HD8) |
| ATEM G2 | **1935** tcp+udp | 192.168.20.189:1935 (the field ATEM Mini Extreme) |
| Second Gateway | 1936 | 192.168.20.88:1935 |
| ATEM IP Patchbay RTMP Server | 9710 | 10.56.21.152:9710 |
| NDI Bridge BPIX / Live Streaming Station | 5997 / 5998 | 10.56.21.152 / 10.56.23.33 |

Three things follow:

1. **WAN port 1935 does not go to the HD8.** A sender that uses the HD8's default RTMP port (1935, which is
   what the HD8's own "remote source" setup file advertises together with the WAN address 207.180.143.114)
   lands on the field Mini at 192.168.20.189 instead. The HD8 is only reachable from outside on **1937**.
   Check the sender's URL: it must be `rtmp://207.180.143.114:1937/...`. If the remote side cannot change the
   port, swap the forwards (give 1935 to the HD8 while the Mini is on standby).
2. **No firewall block is involved.** The last 24 h of blocked inbound flows contain ports 6690, 23, 3389,
   8080 … but nothing on 1935–1937.
3. **Broadwatch could not see a forwarded stream until now.** UniFi logs an inbound forwarded flow against
   the WAN address and WAN port, not the LAN target. Since 0.3.2 the collector reads the forward table and
   maps `WAN:1937` to `HD8:1935`, so such a stream shows under *Connections to the switcher* as
   "via WAN port 1937". If it still never appears while the remote side is sending, the packets are not
   arriving at the UDM at all (wrong public address, ISP/CGNAT, sender behind a firewall).

Then, on the switcher side, the HD8 only shows a remote source live when the input is switched to it
(Steve's macros IN3/IN4 *Streaming 1/2*), the stream format matches the switcher standard, and the stream
key/path matches what the HD8 expects. A stream that arrives but is refused will show as bytes into LIGHTHOUSE
port 15 with no picture.

**Proposed feature, "Stream path check" (small, high value):** for each forward that targets broadcast gear,
show WAN port → target, whether any inbound flow hit it in the last hour (bytes, source, country), whether the
target is on the network, and whether the ATEM's intake rose at the same time. One row per path, green/amber/red.

**Done in 0.4.0 (2026-10-19):** the *Stream path check* block and its alerts (`collector.streamPaths`); flows
below 50 kB are listed as probes (AWS scanners knock on 1935/5997 all day). Also found and fixed the "too many
clients" problem: Companion, ATEM Software Control and the NDI Machine bridge already fill the HD8, so the app
now reads the switcher through Companion's HTTP API and holds no slot (`atem.session`); the capture of the
remote-source commands lives in `AtemClient` (own-session mode) and `scripts/atem-capture.mjs`.

---

## 1. Should a mirror port watch the ATEM?

Yes, for diagnosis; not as the day-to-day data source.

- **What it gives:** every packet to and from the HD8, including same-VLAN streams the UDM never sees, the
  RTMP/SRT handshake itself (so "the stream arrives but the switcher rejects it" becomes visible), codec and
  bitrate from the stream headers, and exact timing.
- **How:** in UniFi, on LIGHTHOUSE, set a spare port's profile to *Mirror* with port 15 as the source (UniFi
  Network > Devices > LIGHTHOUSE > Ports > spare port > Port Profile: Mirroring / Mirror port 15). Plug the
  Broadcast Pix PC's second NIC (or a laptop) into it. The mirror port carries both directions.
- **Software:** `tshark` (Wireshark CLI) as a sidecar process started by Broadwatch on the PC only:
  `tshark -i <nic> -f "host 192.168.20.79" -T ek` (JSON lines). A small parser turns it into per-flow pps/bps,
  RTMP `connect`/`publish` commands (stream name, app), SRT handshake state (control packet type 0 =
  handshake, with the SRT version and latency negotiation), and TCP resets. The UI gets a "Stream forensics"
  panel: live flows into the HD8 with protocol detail, plus a 60-second ring of events.
- **Limits:** needs a free switch port and NIC; tshark must be installed (Wireshark on the PC; Npcap driver);
  on a 1 G port the mirror can drop packets when both directions exceed ~1 G combined (fine here).
- **Alternative for day-to-day:** SNMP counters on port 15 (already live, 3 s) plus encoder telemetry; keep
  mirroring as the debugging tool. Size: ~2 days including the parser and UI.

**Done in 0.8.0 (2026-10-19):** LIGHTHOUSE port 13 mirrors port 15 into a 2.5G USB adapter on the Broadcast
Pix PC; `server/forensics.js` runs tshark on it and the *Stream forensics* section shows control sessions
(per socket, with refused hellos), flows with RTMP/SRT detail and the switcher's answers, and an event tape;
a sender the switcher turns away raises an alert. Verified with an ffmpeg publish using a wrong key.

---

## 2. Dante network monitor (default BIG_MOBILE_DANTE, selectable)

*Partly done in 0.12.0:* the Dante tile's panel shows the PTP clock domains heard on this computer (leader,
sync rate, followers, two-leaders/no-leader status), the Dante devices announced over mDNS and the roster's
Dante devices with their traffic. Routing and subscriptions stay with Dante Controller / Director.

**Sources of truth**
- Discovery: Dante devices advertise over mDNS/DNS-SD on their VLAN: `_netaudio-arc._udp`,
  `_netaudio-chan._udp`, `_netaudio-cmc._udp`, `_netaudio-dbc._udp` (device names, channel names).
- Control: the Dante ARC protocol over UDP (ports 4440 ARC, 4455, 4777 and 8700/8800 for settings) answers
  device info, sample rate, encoding, latency setting, TX/RX channel lists and subscriptions (the routing
  grid) with their status. It is undocumented but reverse-engineered; the open-source
  **`network-audio-controller` ("netaudio", Python, chris-ritsen)** implements exactly what Dante Controller
  shows and is the reference to port to Node.
- Clocking: Dante uses PTP v1 (IEEE 1588-2002) multicast on 224.0.1.129 UDP 319/320. Listening to the
  Announce/Sync messages on the VLAN gives the grandmaster identity, the leader device, each follower's sync
  state and offset, exactly the "Clock Status" tab (leader / follower / sync-to-external / mute).
- Audio flows: unicast RTP UDP 14336–14600 and multicast 239.x UDP 4321; per-device bandwidth comes from the
  SNMP counters of the Audio Rack / Field switch ports we already read (channels × 1.5 Mb/s per channel at
  48 kHz/24-bit gives a plausibility check).

**Verified / known here:** the Dante VLANs are BIG_MOBILE_DANTE (VLAN 2, 192.168.5.x: X32 .154, X32 Rack .143,
X32 Dante card .122, Sennheiser EW-DX .11/.12/.13, a Blackmagic device .78) and BIG_DANTE (VLAN 354,
10.56.19.x: PRISM 12x12 .213, town-hall PCs). The Broadcast Pix PC is **not** on either VLAN; unicast control
(OSC to the X32s) is routed through the UDM and works, but mDNS discovery and PTP multicast are not routed.

**Setup needed (one of):**
1. Give the Broadcast Pix PC an interface on the Dante VLAN: a tagged VLAN sub-interface on its NIC (UniFi:
   set the PC's switch port to a profile that tags VLAN 2 as a secondary network; Windows: Intel/Realtek VLAN
   driver or a second NIC into an Audio Rack port on VLAN 2). Simplest: a USB-Ethernet adapter into AUDIO
   RACK port on the Dante VLAN.
2. Or enable **mDNS reflection** between Default and the Dante VLANs in UniFi (Settings > Networks >
   Multicast DNS) so discovery works from the PC; PTP still needs a foot in the VLAN.
3. Or a tiny probe agent (the same Node code) on a box that lives in the VLAN (a Pi or the Zoom Mac if it had a
   Dante interface) reporting to Broadwatch over HTTP.

**What the panel shows:** device list (name, IP, model, sample rate, latency setting, clock role), the
subscription grid (RX channel → TX source with status: OK, unresolved, no device, bundle mismatch), the
clock tree (leader, followers in sync, any device on its own clock = red), per-device bandwidth, and alerts:
clock leader changed, a follower lost sync, a subscription broke, a device vanished, sample-rate mismatch.
Size: 4–6 days (mDNS + ARC port, PTP listener, UI), plus the VLAN setup.

---

## 3. NDI monitor (BIG_NDI)

*Partly done in 0.12.0:* the NDI tile's panel lists the sources announced over mDNS (name, host, address,
group), the devices on the NDI VLAN with their rates and the VLAN's traffic; the top bar can show the source
count. Which receiver decodes which source is not announced on the network.

**Sources of truth**
- Discovery: NDI sources advertise `_ndi._tcp.local` over mDNS on the NDI VLAN (name "MACHINE (source)",
  TXT with capabilities); NDI 5/6 can also use a Discovery Server (TCP 5959). The PC **is** on BIG_NDI
  (10.56.20.33), so discovery works from Broadwatch as is.
- Statistics (resolution, frame rate, bitrate, dropped frames, latency, who is receiving): only through the NDI
  SDK (`NDIlib_find`, `NDIlib_recv` with `NDIlib_recv_get_performance`/`get_queue`). The NDI 6 SDK is already
  on this PC (it was used for the Community Captioner build), so a small native sidecar (`ndi-probe`, C++ or the
  `grandiose` Node binding built against NDI 6) can enumerate sources and, on request, connect to one for a few
  seconds to read format, fps, bitrate and drops without ever displaying it. NDI Tools' *Analysis* does the same.
- Routing: NDI has no central routing table; "who receives what" is only visible from the receivers (NDI
  Studio Monitor, vMix, OBS, BPix NDI inputs) or from traffic: TCP 5960+ between source and receiver, visible
  as same-VLAN switch-port traffic (SNMP) or flows when it crosses VLANs. The NDI Bridge forwards (5997/5998)
  are external receivers worth listing.

**What the panel shows:** sources (name, machine, IP, format, fps, bitrate, tally if the SDK reports it),
receivers per source where known, VLAN bandwidth, and alerts: an expected source disappeared (per show
profile), frame drops, a source changed format mid-show. Size: 2 days for discovery + stats sidecar on
Windows, +1 day for the Mac build of the sidecar.

---

## 4. Live stream and switcher statistics

Already partly in place; this makes it continuous and visible:

- **Web Presenters (REST, verified):** `livestreams/0` gives status (Idle / Connecting / Streaming /
  Interrupted), configured bitrate, effective format, and `cache` (buffer fill). Poll every 2 s during a show
  and chart bitrate + cache; "Interrupted" is already an alert.
- **HD8 own stream (ATEM protocol, verified):** `StRS` state, `SRSS` encoder bitrate + cache, `SRST`
  duration/timecode, `STAB` audio bitrates, `SRSU` service/URL; recording: `RTMS/RTMD/RMRD` (record state,
  disk, remaining). Expose as the "Stream out" and "ISO record" tiles with a 10-minute chart.
- **Remote sources on the HD8:** the switcher sends `RSDs RSis RSpr RSca` commands (seen); `RSis` holds the
  advertised WAN address. Their layout is undocumented: capture them with
  `readAtem(ip, { capture: ['RSDs','RSis','RSpr','RSca'] })` once while a remote stream is live and once idle,
  diff, and decode (expect: per-source name, state, bitrate). Do this only from a test script when no show is
  on (each one-shot read occupies a control slot for ~2 minutes).
- **ATEM stats:** program/preview per M/E (have), tally per input, aux routes, media pool fill, Fairlight input
  state, time-of-day vs. timecode. All are commands the persistent session already receives; parse and show.

---

## 5. Live audio meters with their real sources

- **ATEM Fairlight meters:** the switcher streams levels only on request. The client sends the "send levels"
  command (`SFLN` for Fairlight; atem-connection calls it `FairlightMixerSendLevelsCommand`) and then
  receives `FDLv` (per input/source levels, peaks) and `FMLv` (master) at ~10 Hz. Add to `AtemClient` a
  `wantLevels(true)` that sends it after `InCm` (and re-sends every 10 s, the switcher stops after a while).
  This is what Companion's meter buttons use; the Fairlight inputs are the real sources: Camera 1–4 SDI
  embedded, MADI 1/2 (house mix), XLR (Zoom), etc. Labels come from `InPr`/`FAIP` names.
- **X32 meters (OSC, open protocol):** `/meters/1` (channels), `/meters/2` (buses) via `/batchsubscribe`
  (renew every 10 s); the console sends 32-bit float blobs to the subscriber's address at up to 50 Hz. Routed
  unicast works from the PC (the `/xinfo` probe already does). Channel names from `/ch/01/config/name`.
- **Sennheiser EW-DX (SSC, open JSON-over-UDP port 45):** `{"rx1":{"battery":null,"rf":null,"af":null,"mute":null,"name":null,"warnings":null}}`
  style requests; also subscriptions. Gives battery %, RF level, audio level, mute, frequency, warnings
  (low battery, RF loss) per receiver channel: the "mic info if mics are detected" ask. Detection = the
  receivers answer on UDP 45.
- **UI:** a meter strip (peak-hold, 10 Hz) on the Audio tile and a full Audio detail view: Fairlight inputs,
  X32 channels/buses, mics with battery/RF bars. Size: 2 days for ATEM + X32, 1 day for EW-DX.

**Done in 0.9.0 (2026-10-19):** `server/x32.js` subscribes to `/meters/1` (32 channels) and `/meters/2`
(16 buses, 6 matrices, main L/R/mono) on every active roster X32 (probe `x32`), ten updates a second with
1.5 s peak hold, names and mutes from `/ch`, `/bus`, `/mtx`, `/main`; `server/ssc.js` reads the EW-DX
receivers (roster role `audio` with a mic-like name or vendor) over SSC: name, frequency, mute, warnings
(`NoLink` = transmitter off), the linked transmitter's battery, and the AF / RSQI / RSSI meters by
subscription. `state.audio` and a 5-Hz `meters` SSE event feed the *Audio* section (hairline bars with
tabular numbers), the meter strips on the Audio and Mics tiles, the phone page's *Mics* rows, the health
factors (consoles must send meters; mics on air must have battery and RF) and the alerts (battery below
20 %, RSQI below 30 %, muted or off while the profile expects mics). Fairlight levels: `AtemClient.wantLevels`
sends `SFLN` after `InCm` and decodes `FDLv` / `FMLv`, but only when `atem.session` is `own` (Settings >
Switcher says so); through Companion the switcher sends no levels. Verified live on the X32 Compact and X32
Rack and on the three EM 2 Dante receivers (all transmitters were off that evening: the link / battery / RF
paths follow the SSC schema the receivers returned, not a live transmitter). The field X32 Dante card has no
probe and is listed as "nothing to read".

---

## 6. Broadcast health score and the home view

**Score:** a weighted sum of factors with a *show profile* saying what is expected. Factors (each 0–1 with a
weight and a reason string): WAN ok and latency; stream out status + cache; stream in present when the
profile expects remote sources; HD8 session held; recorders recording when expected; Dante clock locked and
subscriptions resolved; NDI expected sources present; mic RF/battery; switch errors in the last 10 min;
links at expected speed; port utilisation < 70 %; UDM CPU; PTP leader stable; no alerts of level error.
The verdict is Ready / Degraded / At risk / Down from thresholds, and the AI writes the narrative on top of the
numbers (it must never contradict the score).

**Home view ("glance board"):** the health score as a large lamp + one sentence, then eight tiles in a fixed
order: Stream out · Stream in · Audio (live meter strip) · Dante clock · NDI · Mics · Network · Recorders.
Each tile = lamp, one number, one line, a 10-minute sparkline. Clicking opens the detail view (Streams, Audio,
Dante, NDI, Network = today's map/switches/equipment, Events). The HUD stays as the persistent strip.

**Setup process (in-app):** "Prepare a broadcast": pick or create a show profile (Studio Town Meeting / Field /
Rehearsal / Idle), tick the roster, choose the Dante and NDI VLANs, say what is expected live (streaming out,
remote sources in, recorders on, which mics), set the AI endpoint, test every probe, and save. Profiles live in
the user config; the active profile drives the score and the alerts (a recorder that is off is only a problem
when the profile says it should run). Size: 3 days (score + tiles + profile editor).

---

**Done in 0.7.0 (2026-10-19):** `server/health.js` (weighted factors, critical overrides, profile
expectations), the home view (lamp, score, why, eight tiles with sparklines and targets), show profiles in
the config with the *Prepare a broadcast* dialog (expectations, roster ticks, test every probe, save and
activate) and the profile menu; the AI narrates on top of the score and cannot change the verdict. Still
open from this section: the Dante clock (section 2). The Audio tile's meter strip and the mics' RF/battery
came with 0.9.0 (section 5).

## 7. Mobile version

Same server, a second page: `/m` renders the glance board, alerts, the stream-in panel and the Ask box in a
single column with large tap targets, as a PWA (manifest, home-screen icon, no service worker needed). The
server must then listen on the LAN (`server.host: 0.0.0.0`) behind a shared token (`?key=…` stored by the
phone) so it is not open to every guest on Wi-Fi; Electron shows a QR code to open it. Size: 1.5 days.

---

**Done in 0.7.0:** `/m` with the manifest and icon, the generated `server.token` with the cookie, `/api/phone`
and the *Open on a phone…* menu (no QR code yet: the menu copies the link instead).

## 8. Foundations: stability, strength, power

1. **One server, many viewers.** Run Broadwatch's server once on the Broadcast Pix PC (as a logon task or a
   Windows service via NSSM, with `0.0.0.0` + token) and let the Mac app, phones and browsers be *viewers* of
   it ("Connect to a server" in the app). This removes double polling, double ATEM slots and double AI runs.
2. **Replace the Companion poller.** Broadwatch already has every value `unifi/unifi-poller.py` computes;
   push them into Companion's custom variables (`POST /api/custom-variable/<name>/value`) from the collector
   and retire the Python poller. One source of truth for the Stream Deck health pages.
3. **History on disk** (SQLite via `better-sqlite3` prebuilds, or JSON ring files): 24 h of rates, levels and
   events for post-show review and "what happened at 7:42?" questions to the AI. *Done in 0.10.0 for events:*
   `server/journal.js` keeps alerts (raised, cleared, duration), events, notable UniFi events and AI/app errors
   in JSONL files per day (30 days) with the filterable Log block, CSV export and a 24 h summary in the AI
   digest. Rates and levels history is still to do.
4. **Notifications:** desktop notifications for error-level alerts; optional e-mail/SMS/Slack for show nights;
   a visible "show mode" that raises polling rates and makes alerts louder.
5. **Tests and replay:** record raw API/protocol responses once and replay them so the UI can be developed
   without the studio; unit tests for the parsers (SNMP BER, ATEM commands, SSC, OSC, flows).
6. **Code signing and auto-update:** an Apple Developer ID + notarisation and a Windows signing certificate end
   the Gatekeeper/SmartScreen warnings; `electron-updater` with the `latest*.yml` the builds already produce
   gives one-click updates.
7. **Resilience:** watchdog restart on crash, log file with rotation, memory caps, a `/api/health` the Companion
   HEALTH page can watch, and a visible "data freshness" per source. *0.10.0:* unhandled errors are written to
   the log and the server carries on; a controller 5xx / timeout is a note on the first miss and an alert on
   the second; the AI timer stops knocking on a key or workspace error until the settings change.
8. **Config UI** for thresholds, polling, the AI endpoint and the SNMP community, not only the roster; a
   "test" button next to each. *Done in 0.5.0:* the Settings screen (AI local/Claude toggle with keys, gateway,
   SNMP, Companion, server, thresholds, each with Test), plus the public "Broadwatch Community" flavour.
9. **Security:** the embedded UniFi key is read-only for most things but can read client lists; keep the repo
   private, rotate the key if the laptop is ever lost, add the LAN token before exposing the server.

---

## Suggested order

1. Stream path check (section 0) + remote-source command capture (4) — directly aimed at the forwarded-stream problem.
2. Health score, show profiles, glance board, mobile page (6, 7).
3. Audio: Fairlight + X32 meters, EW-DX mics (5). *Done in 0.9.0.*
4. One server / viewers + Companion variables (8.1, 8.2).
5. Dante (2) once the PC has a foot in the VLAN; NDI (3).
6. Mirror-port forensics (1) when needed.
7. Foundations (8.3–8.9) alongside.

---

## Prompt for the next session

> Read `CLAUDE.md` and `docs/ROADMAP.md` in `A:\___ENGINEERING PROJECTS\BIG NetWatch\broadwatcher` (the Broadwatch
> repo, github amateurmenace/broadwatcher) end to end, then the hand-over notes in
> `C:\Users\Broadcast Pix\AppData\Roaming\Claude\side-session-notes\local_d99bd98d-7561-426c-a7b3-233b5080f0ea\netwatch.md`.
> Then implement roadmap items in the suggested order, releasing a tagged version after each milestone and
> checking the GitHub Actions build. Start with the "Stream path check" panel and the HD8 remote-source
> command capture (only when no show is on), then the health score with show profiles, the glance-board home
> view and the mobile page. Never open repeated ATEM sessions; keep the paper theme. Ask Steve before anything
> that needs a UniFi change (VLAN interface for Dante, mirror port) and list exactly what to click.
