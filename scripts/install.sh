#!/usr/bin/env bash
# Tollpower installer for Raspberry Pi OS (Bookworm or later).
# Run from the tollpower folder as your normal user (not root):
#   ./scripts/install.sh
# Options:
#   --hostname NAME   rename the Pi so the page is at http://NAME.local (default: tollpower)
#   --keep-hostname   don't rename the Pi
#   --port N          web port (default 80, so no :port is needed in the address)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_NAME="$(id -un)"
NEW_HOSTNAME="tollpower"
WEB_PORT=80

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hostname) NEW_HOSTNAME="$2"; shift 2 ;;
    --keep-hostname) NEW_HOSTNAME=""; shift ;;
    --port) WEB_PORT="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ "$USER_NAME" == "root" ]]; then
  echo "Please run this as your normal user (e.g. pi), not with sudo. It will ask for sudo when needed."
  exit 1
fi

step() { printf '\n\033[1;32m==> %s\033[0m\n' "$1"; }

step "Checking Node.js"
NODE_MAJOR=0
if command -v node >/dev/null; then NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"; fi
if (( NODE_MAJOR < 18 )); then
  echo "Installing Node.js from Raspberry Pi OS packages..."
  sudo apt-get update
  sudo apt-get install -y nodejs npm
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if (( NODE_MAJOR < 18 )); then
    echo "Node.js 18 or newer is needed (found $(node -v)). See README for how to install a newer one."
    exit 1
  fi
fi
echo "Node $(node -v)"

step "Installing Tollpower"
cd "$DIR"
npm ci --omit=dev --no-audit --no-fund
mkdir -p data

step "Running self-tests"
npm test --silent

step "Allowing access to the inverter's USB port"
sudo tee /etc/udev/rules.d/99-voltacon.rules >/dev/null <<'EOF'
# Voltacon / Voltronic inverter USB link (Cypress chip 0665:5161) -> /dev/voltacon
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0665", ATTRS{idProduct}=="5161", MODE="0660", GROUP="plugdev", SYMLINK+="voltacon"
EOF
sudo udevadm control --reload-rules
sudo udevadm trigger --subsystem-match=hidraw || true
sudo usermod -aG plugdev,dialout "$USER_NAME"
if [[ -e /dev/voltacon ]]; then echo "Inverter found at /dev/voltacon"; else echo "Inverter not detected yet (that's fine if the USB cable isn't plugged in)."; fi

step "Setting up the background service"
NODE_BIN="$(command -v node)"
sudo tee /etc/systemd/system/tollpower.service >/dev/null <<EOF
[Unit]
Description=Tollpower home power controller
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
SupplementaryGroups=plugdev dialout
WorkingDirectory=$DIR
ExecStart=$NODE_BIN $DIR/server.js
Environment=NODE_ENV=production
Environment=PORT=$WEB_PORT
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable tollpower.service
sudo systemctl restart tollpower.service

if [[ -n "$NEW_HOSTNAME" && "$(hostname)" != "$NEW_HOSTNAME" ]]; then
  step "Renaming this Pi to '$NEW_HOSTNAME'"
  OLD="$(hostname)"
  sudo hostnamectl set-hostname "$NEW_HOSTNAME"
  sudo sed -i "s/\b$OLD\b/$NEW_HOSTNAME/g" /etc/hosts
  sudo systemctl restart avahi-daemon 2>/dev/null || true
fi

SUFFIX=""
[[ "$WEB_PORT" != "80" ]] && SUFFIX=":$WEB_PORT"
IP="$(hostname -I | awk '{print $1}')"
step "Done"
cat <<EOF

  Tollpower is running and will start automatically when the Pi boots.

  On any phone, tablet or PC on your home Wi-Fi, open:
      http://$(hostname).local$SUFFIX
  or  http://$IP$SUFFIX

  First time: go to "Installer settings" at the bottom of the page and
  choose your installer PIN.

  Useful commands:
      sudo systemctl status tollpower     # is it running?
      journalctl -u tollpower -f          # live log
EOF
