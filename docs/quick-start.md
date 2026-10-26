# Quick start: blank SD card to a working Tollpower

About 30 minutes, most of it waiting for downloads.

## You need

- A Raspberry Pi (3B+, 4, 5 or Zero 2 W) and its power supply. An older Pi 2 should also work: see [Using a Pi 2](#using-a-pi-2).
- A microSD card, 16 GB or bigger (a good brand: it gets written to every few minutes)
- A PC with an SD card reader
- The inverter's USB cable (square USB-B on the inverter end)
- Your home Wi-Fi name and password

## 1. Write the SD card

1. On the PC, install and open **Raspberry Pi Imager** from <https://www.raspberrypi.com/software/>.
2. **Device:** your Pi model. **OS:** *Raspberry Pi OS (other)* → **Raspberry Pi OS Lite (64-bit)**. (A screen and desktop aren't needed. Use the 32-bit Lite on a Pi 3B+ with little memory if you prefer; both work.)
3. **Storage:** the SD card.
4. When it asks about OS customisation, choose **Edit settings** and set:
   - **Hostname:** `tollpower`
   - **Username and password:** your choice (e.g. `pi`). Write them down.
   - **Wireless LAN:** your Wi-Fi name and password, country **GB**
   - **Locale:** time zone **Europe/London**, keyboard **gb**. *This matters:* the cheap-rate window and the timer use the Pi's clock.
   - **Services** tab: **Enable SSH**, with password authentication
5. Save, write the card, and wait for it to verify.

### Using a Pi 2

A Pi 2 hasn't been tested, but it has enough power for Tollpower. Three differences:

- **Choose Raspberry Pi OS Lite (32-bit)** in step 1. The 64-bit version won't boot on most Pi 2s.
- **It has no Wi-Fi.** Plug it into the router with an Ethernet cable (simplest and most reliable), or use a USB Wi-Fi dongle that Raspberry Pi OS supports. With Ethernet, leave the Wireless LAN settings blank.
- **Setup is slower.** The update, install and self-tests in step 3 take a few times longer than on a newer Pi, and so do updates later. Day to day it runs fine.

## 2. First boot

1. Put the card in the Pi and power it on. Leave the inverter cable unplugged for now.
2. Give it 2–3 minutes on the first boot.
3. On the PC, open a terminal (on Windows: PowerShell) and connect:

   ```bash
   ssh pi@tollpower.local
   ```

   Use your own username instead of `pi`. Answer `yes` to the fingerprint question, then type the password.
   If `tollpower.local` isn't found, look up the Pi's IP address in your router's list of devices and use `ssh pi@192.168.x.x` instead.

## 3. Update the Pi and get the code

On the Pi (over SSH):

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y git
timedatectl
```

`timedatectl` should show `Time zone: Europe/London`. If not: `sudo timedatectl set-timezone Europe/London`.

Then:

```bash
git clone https://github.com/thomas-of-rhodes/Tollpower.git tollpower
cd tollpower
./scripts/install.sh
```

The installer installs Node.js, runs the self-tests, sets up the USB port and starts Tollpower as a background service that comes back after every reboot. It ends with the address to open.

## 4. Moving from an old Pi? Bring the data across

Skip this on a first-ever install. The `data` folder holds the PIN, tariff, timer and all the history. To keep them:

1. **Unplug the old Pi** (or `sudo systemctl stop tollpower` on it), so it stops recording and the two Pis don't fight over the `tollpower.local` name.
2. On the new Pi:

   ```bash
   sudo systemctl stop tollpower
   scp -r pi@OLD-PI-IP:tollpower/data ~/tollpower/
   sudo systemctl start tollpower
   ```

   Use the old Pi's IP address and username.

## 5. Connect the inverter

1. Plug the inverter's USB cable into the Pi.
2. Check the Pi sees it:

   ```bash
   ls -l /dev/voltacon
   ```

   It should show a link to a `hidraw` device. If it says "No such file", unplug the cable, wait 5 seconds, plug it back in, and try again.

## 6. Open the page and finish setting up

1. On a phone or PC on the home Wi-Fi, open **http://tollpower.local** (Android: use the IP address the installer printed).
2. Scroll to **Installer settings** at the bottom and **choose a PIN**. (Skip if you copied the data across.)
3. Check the **tariff**: Octopus Go defaults are 00:30–05:30. Update the two prices from your latest Octopus bill or app.
4. Back on the dashboard, check **Timer settings**: by default it charges the battery from the grid in the cheap window, up to 90%.
5. On a phone: browser menu → **Add to Home Screen**.

## 7. Check it's working

- The status at the top is green, and "Right now" shows live numbers (not "–").
- Installer settings → **Connection** shows the port and no errors.
- No orange **Demo mode** banner. If you see one, turn demo mode off in Installer settings.
- After half an hour, "Through the day" starts to fill in.

## Nice to have

- In your router, **reserve the Pi's IP address**, so the IP address never changes (useful for Android phones).
- Put the Pi somewhere it won't get unplugged by accident; a power cut is fine, it starts again by itself.
- Updates: Installer settings → **Check for update and install**.

## If something goes wrong

| Problem | Try |
| --- | --- |
| `ssh: Could not resolve hostname` | Use the IP address from your router instead of `tollpower.local`. |
| Page won't open | On the Pi: `sudo systemctl status tollpower`, and the live log `journalctl -u tollpower -f` |
| "Can't talk to the inverter" | Cable plugged in at both ends? `ls -l /dev/voltacon`. Then Installer settings → Connection for the last error. |
| Cheap-rate times look an hour out | The time zone isn't Europe/London (step 3). Fix it, then `sudo systemctl restart tollpower`. |

More detail is in the main [README](../README.md).
