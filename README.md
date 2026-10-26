# Tollpower

A simple home-power page for a **Voltacon** solar inverter (any Voltronic/Axpert-family inverter that speaks the PI30 protocol), served from a **Raspberry Pi** on your home network.

It's built so the household can use it like an appliance:

- **One page, any device.** Open `http://tollpower.local` on any phone, tablet or PC on the home Wi-Fi. On a phone, use "Add to Home Screen" and it opens like an app.
- **A traffic-light status** that says in plain English what's happening and what, if anything, to do.
- **A timer for the inverter's two settings.** A daily timetable picks what powers the house and what charges the battery, for example charging from the grid on a cheap night rate. A big switch turns the timer on or off, and a Manual Over-Ride changes the settings until the next slot. The app sends each change to the inverter, then reads it back to make sure it stuck.
- **Real history only.** Energy and savings are added up from live readings. Nothing is estimated or made up, and gaps in the data stay as gaps.
- **Through the day.** Half-hour charts share one time line: where the power came from (battery charging shows below the line), the battery level, and money spent so far against what it would have been without solar and battery. Step back through earlier days with the arrows.
- **Installer settings behind a PIN.** That covers the tariff, the connection, diagnostics and updates. Nothing on the network can change inverter settings except those two priorities.

## The inverter settings and the timer

The inverter works by two settings, which the dashboard shows as the inverter reports them:

| Setting | Options |
| --- | --- |
| **Output source priority** (program 01): what powers the house | **UTI** utility first · **SOL** solar first · **SBU** solar, then battery, then grid |
| **Charger source priority** (program 16): what charges the battery | **CSO** solar first · **SNU** solar and utility together · **OSO** only solar |

How these behave, per the Voltronic manual for the 11kW Axpert MAX:

- **UTI** runs the house from the grid. Solar and battery only power the house if the grid fails, so solar can only charge the battery.
- **SOL** runs the house from solar, with the grid topping up. The battery is only used if the grid fails.
- **SBU** only turns to the grid when the battery drops to program 12 (default 10% for lithium), and goes back to the battery once it recovers to program 13 (default 30%).
- The charger setting only applies while the inverter is running on the grid. While it runs on the battery, only solar can charge it.

**Timer settings** (linked from the dashboard) hold a daily timetable of up to 8 slots, at least 15 minutes apart. Each slot runs until the next one starts and sets both priorities. A slot that charges from the grid can stop at a battery % (grid charging pauses there and resumes 5% below). The default follows the cheap window of the tariff: **UTI + SNU** up to 90% from 00:30 to 05:30, then **SBU + OSO** for the rest of the day. Older installs set to one of the old named modes are converted to the equivalent timetable.

- **Timer on:** the timetable sets the inverter. A **Manual Over-Ride** on the dashboard lasts until the next slot, then the timer takes over again (or press "Back to timer").
- **Timer off:** the inverter stays on whatever was running when the timer was switched off, until someone changes it by hand.

Every 5 seconds the app reads the inverter. Every minute it also checks the inverter's actual settings, and puts them back if they don't match the timer or over-ride (for example after someone presses buttons on the inverter itself). If the inverter refuses a change, the family page shows an alert. The app retries no more than every 5 minutes, so it doesn't wear out the inverter's settings memory.

Some models only have three charger options and no "only solar". The app detects this the first time the inverter refuses, and uses "solar first" instead.

## What you need

- Raspberry Pi (3B+, 4, 5 or Zero 2 W) running **Raspberry Pi OS Bookworm** or later, connected to your home Wi-Fi
- The USB cable that came with the inverter (square USB-B on the inverter end), plugged into the Pi. A USB-to-RS232 serial adapter also works.

## Install (about 5 minutes)

On the Pi, in a terminal:

```bash
git clone https://github.com/thomas-of-rhodes/Tollpower.git tollpower
cd tollpower
./scripts/install.sh
```

The installer:

1. installs Node.js if it's missing
2. runs the self-tests
3. gives the app permission to use the inverter's USB port, creating a stable `/dev/voltacon` link
4. sets it up to start automatically when the Pi boots, and to restart itself if it ever crashes
5. renames the Pi to `tollpower`, so the address is `http://tollpower.local`. Use `--keep-hostname` to skip this.

Then open the page, scroll to **Installer settings**, and choose a PIN. Check the tariff times and rates while you're there. They default to Octopus Go (00:30–05:30). Then check **Timer settings** on the dashboard: by default it charges from the grid in that cheap window.

> **Android tip:** some Android phones don't understand `.local` addresses. Use the Pi's IP address instead (the installer prints it), and ideally reserve that IP for the Pi in your router.

## Updating

Go to **Installer settings → Check for update and install**, or run `./scripts/update.sh` on the Pi. The update installs the new version, runs its self-tests and checks that it starts up. It only switches over if everything passes; otherwise it automatically goes back to the version you had.

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
| "Open this page using the Pi's address" | For safety the app only answers to the Pi's IP address, `localhost`, or the Pi's own name (e.g. `tollpower.local`). To use another name (say, one set up in your router), add `Environment=TOLLPOWER_HOSTS=power.home.lan` to the service with `sudo systemctl edit tollpower`, then restart it. |
| Forgot the installer PIN | On the Pi: `nano data/config.json`, delete the `pinHash` line, then `sudo systemctl restart tollpower` and choose a new PIN |
| Battery % looks wrong | Without a BMS data cable, the inverter estimates battery % from voltage. That's the inverter's own figure, not the app's. |

## How it works

```
server.js            starts everything
src/protocol.js      PI30 frames, checksum, and decoding of QPIGS / QPIRI / QMOD / QPIWS
src/transport.js     non-blocking USB-HID and serial I/O
src/inverter.js      one command at a time, with a diagnostics log
src/simulator.js     pretend inverter for demo mode and tests
src/modes.js         the two priority settings, the timer and the cheap-rate window
src/controller.js    polling, keeping settings in line with the mode, alerts
src/history.js       energy, cost and savings history (data/history.json): half hours for 400 days, daily totals for 10 years
src/store.js         settings in data/config.json, saved safely against power cuts
src/auth.js          installer PIN, login sessions and lock-out after wrong guesses
src/app.js           web API, with PIN protection for the installer area
public/              the web pages (plain HTML/CSS/JS, no build step)
scripts/             install and safe update
```

Run the tests with `npm test`.

Grid power is **estimated**, because PI30 inverters don't measure it directly. When the inverter is in "line" mode, it counts the house load plus any grid charging. Savings are calculated as "what the house used × the rate at that time", minus "what was bought from the grid × the rate at that time".

## Licence

Apache 2.0. See [LICENSE](LICENSE).
