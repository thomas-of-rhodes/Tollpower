# Tollpower

Home-power web app for a Voltacon / Voltronic PI30 solar inverter, running on a Raspberry Pi. Node + Express backend, plain HTML/CSS/JS frontend (no build step). See README.md for what it does for the household.

This is a prototype: commit straight to `main`, no branches or PRs.

## Commands

- `npm ci` – install
- `npm test` – all tests (`node --test`, files in `test/`). Run before every commit.
- `npm run demo` – run with a simulated inverter at http://localhost:3000 (works on Windows). The Claude app's launch config is `demo` in `.claude/launch.json`.
- `TOLLPOWER_DATA=<dir>` – use another data folder, e.g. to keep demo runs away from `data/`.

CI (`.github/workflows/test.yml`) runs `npm test` on Node 18 on every push.

## Layout

- `server.js` – entry point (PORT, `--demo`/`DEMO=1`, TOLLPOWER_DATA)
- `src/protocol.js` – PI30 frames, CRC, parsers. Pure functions, fully unit-tested.
- `src/transport.js` – USB-HID / serial I/O, port detection, `isValidPortPath`
- `src/inverter.js` – single command queue + diagnostics log
- `src/simulator.js` – fake inverter speaking the real byte protocol (demo + tests)
- `src/modes.js` – the four family modes → inverter priorities, cheap-rate window
- `src/controller.js` – polling, enforcing the mode, alerts
- `src/history.js` – energy/cost history in `data/history.json`
- `src/app.js` – API routes, installer PIN, `allowedHost` check
- `public/` – family page (`index.html`, `app.js`) and installer page
- `scripts/install.sh`, `scripts/update.sh` – Pi install and self-update (bash, run on the Pi)

## Rules that matter

- **Inverter writes are limited.** The only setting commands the app sends are output priority (`POP0x`) and charger priority (`PCP0x`). Don't add others without a strong reason. The diagnostics console must stay read-only (`isQueryCommand`).
- **Writes wear the inverter's EEPROM.** Keep the 5-minute retry backoff and the read-back check in `controller.js`.
- **No made-up data.** History only adds up real readings; gaps stay gaps. Show "–" when offline, never stale or estimated numbers (grid power is the one documented estimate).
- **Family API is PIN-free, installer API needs the PIN.** Every request must pass `allowedHost` (anti DNS rebinding). Port paths must pass `isValidPortPath`.
- **Node 18 compatible** (Raspberry Pi OS Bookworm). No build tools, and add npm dependencies only when really needed.
- **Plain-English UI text** for the family page; inverter jargon (SBU, UTI, OSO…) belongs on the installer page only.
- Shell scripts run on the Pi, not on Windows. Keep them LF and executable, and check with `bash -n`.
- `data/` is runtime state (config with PIN hash, history). It is gitignored; never commit it.
