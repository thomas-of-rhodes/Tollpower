# Tollpower

A simple home-power page for a **Voltacon** solar inverter (any Voltronic/Axpert-family inverter that speaks the PI30 protocol), served from a **Raspberry Pi** on your home network.

It's built so the household can use it like an appliance:

- **One page, any device.** Open `http://tollpower.local` on any phone, tablet or PC on the home Wi-Fi. On a phone, use "Add to Home Screen" and it opens like an app.
- **A traffic-light status** that says in plain English what's happening and what, if anything, to do.
- **Four modes instead of inverter jargon.** The app sends the settings to the inverter, then reads them back to make sure they stuck.
- **Real history only.** Energy and savings are added up from live readings. Nothing is estimated or made up, and gaps in the data stay as gaps.
- **Installer settings behind a PIN.** That covers the tariff, the connection, diagnostics and updates. Nothing on the network can change inverter settings except through the four modes.

## The modes

| Mode | What the family sees | What the inverter is set to |
| --- | --- | --- |
| **Automatic** (default) | Solar and battery by day; tops up the battery on cheap night-rate power | Outside the cheap window: output **SBU**, charger **only solar**. Inside the cheap window: output **UTI**, charger **solar + grid** until the battery reaches the target % (default 90%), then **only solar** |
| **Solar & battery** | Never charges from the grid | Output **SBU**, charger **only solar** |
| **Keep battery full** | For storms or expected power cuts | Output **UTI**, charger **solar + grid** |
| **Grid only** | For maintenance | Output **UTI**, charger **only solar** |

Every 5 seconds the app reads the inverter. Every minute it also checks the inverter's actual settings, and puts them back if they don't match the chosen mode (for example after someone presses buttons on the inverter itself). If the inverter refuses a change, the family page shows an alert. The app retries no more than every 5 minutes, so it doesn't wear out the inverter's settings memory.

Some models only have three charger options and no "only solar". The app detects this the first time the inverter refuses, and uses "solar first" instead.

## What you need

- Raspberry Pi (3B+, 4, 5 or Zero 2 W) running **Raspberry Pi OS Bookworm** or later, connected to your home Wi-Fi
- The USB cable that came with the inverter (square USB-B on the inverter end), plugged into the Pi. A USB-to-RS232 serial adapter also works.

## Install (about 5 minutes)

On the Pi, in a terminal:

```bash
git clone https://github.com/spunkyindigo/tollpower.git
cd tollpower
./scripts/install.sh
```

The installer:

1. installs Node.js if it's missing
2. runs the self-tests
3. gives the app permission to use the inverter's USB port, creating a stable `/dev/voltacon` link
4. sets it up to start automatically when the Pi boots, and to restart itself if it ever crashes
5. renames the Pi to `tollpower`, so the address is `http://tollpower.local`. Use `--keep-hostname` to skip this.

Then open the page, scroll to **Installer settings**, and choose a PIN. Check the tariff times and rates while you're there. They default to Octopus Go (00:30–05:30).

> **Android tip:** some Android phones don't understand `.local` addresses. Use the Pi's IP address instead (the installer prints it), and ideally reserve that IP for the Pi in your router.

## Updating

Go to **Installer settings → Check for update and install**, or run `./scripts/update.sh` on the Pi. The update installs the new version and runs its self-tests. It only switches over if everything passes; otherwise it automatically goes back to the version you had.

## Trying it without an inverter

```bash
npm install
npm run demo        # then open http://localhost:3000
```

Demo mode uses a pretend inverter and shows a large orange banner, so it can't be mistaken for real readings. Its history is stored separately from the real history.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| "Can't talk to the inverter" | Is the USB cable plugged in at both ends? Installer settings → Connection shows the port and the last error. `ls -l /dev/voltacon` should show the device. |
| Page won't open | `sudo systemctl status tollpower` on the Pi. Live log: `journalctl -u tollpower -f` |
| Forgot the installer PIN | On the Pi: `nano data/config.json`, delete the `pinHash` line, then `sudo systemctl restart tollpower` and choose a new PIN |
| Battery % looks wrong | Without a BMS data cable, the inverter estimates battery % from voltage. That's the inverter's own figure, not the app's. |

## How it works

```
server.js            starts everything
src/protocol.js      PI30 frames, checksum, and decoding of QPIGS / QPIRI / QMOD / QPIWS
src/transport.js     non-blocking USB-HID and serial I/O
src/inverter.js      one command at a time, with a diagnostics log
src/simulator.js     pretend inverter for demo mode and tests
src/modes.js         the four modes and the cheap-rate schedule
src/controller.js    polling, keeping settings in line with the mode, alerts
src/history.js       energy, cost and savings history (data/history.json)
src/app.js           web API, with PIN protection for the installer area
public/              the web pages (plain HTML/CSS/JS, no build step)
scripts/             install and safe update
```

Run the tests with `npm test`.

Grid power is **estimated**, because PI30 inverters don't measure it directly. When the inverter is in "line" mode, it counts the house load plus any grid charging. Savings are calculated as "what the house used × the rate at that time", minus "what was bought from the grid × the rate at that time".

## Licence

Apache 2.0. See [LICENSE](LICENSE).
