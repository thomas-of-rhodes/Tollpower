// Talks to the inverter over the USB cable (/dev/hidraw*) or a serial
// adapter (/dev/ttyUSB*). All I/O is non-blocking so the web server can
// never freeze waiting for the inverter.

import fs from 'node:fs';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const execFileAsync = promisify(execFile);

export class DeviceTransport {
  /** @param {{ port: string, timeoutMs?: number }} opts */
  constructor({ port, timeoutMs = 3000 }) {
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.isHid = port.includes('hidraw') || port.endsWith('voltacon');
    this.serialConfigured = false;
  }

  describe() {
    return `${this.isHid ? 'USB' : 'Serial'} ${this.port}`;
  }

  async #configureSerial() {
    if (this.isHid || this.serialConfigured) return;
    // PI30 serial: 2400 baud, 8 data bits, no parity, 1 stop bit, raw mode.
    await execFileAsync('stty', ['-F', this.port, '2400', 'cs8', '-cstopb', '-parenb', 'raw', '-echo']);
    this.serialConfigured = true;
  }

  /** Send one frame, return the raw reply bytes (up to and including CR). */
  async exchange(frame) {
    await this.#configureSerial();
    const fd = fs.openSync(this.port, constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOCTTY);
    try {
      // Drain anything stale left from a previous, interrupted exchange.
      this.#drain(fd);

      if (this.isHid) {
        // The inverter's USB interface takes 8-byte HID reports.
        for (let i = 0; i < frame.length; i += 8) {
          const chunk = Buffer.alloc(8);
          frame.copy(chunk, 0, i, Math.min(i + 8, frame.length));
          fs.writeSync(fd, chunk);
          await sleep(30);
        }
      } else {
        fs.writeSync(fd, frame);
      }

      const deadline = Date.now() + this.timeoutMs;
      const chunks = [];
      const buf = Buffer.alloc(256);
      while (Date.now() < deadline) {
        let n = 0;
        try {
          n = fs.readSync(fd, buf, 0, buf.length, null);
        } catch (err) {
          if (err.code !== 'EAGAIN' && err.code !== 'EWOULDBLOCK') throw err;
        }
        if (n > 0) {
          chunks.push(Buffer.from(buf.subarray(0, n)));
          if (buf.subarray(0, n).includes(0x0d)) return Buffer.concat(chunks);
        } else {
          await sleep(25);
        }
      }
      throw new Error(`No reply from inverter within ${this.timeoutMs / 1000}s`);
    } finally {
      fs.closeSync(fd);
    }
  }

  #drain(fd) {
    const buf = Buffer.alloc(256);
    for (let i = 0; i < 20; i++) {
      try {
        if (fs.readSync(fd, buf, 0, buf.length, null) <= 0) return;
      } catch {
        return;
      }
    }
  }
}

/** Is this hidraw device the Voltacon/Voltronic USB chip (vendor 0665, product 5161)? */
function isVoltronicHid(name) {
  try {
    const uevent = fs.readFileSync(`/sys/class/hidraw/${name}/device/uevent`, 'utf8');
    return /HID_ID=\w+:00000665:00005161/i.test(uevent);
  } catch {
    return false;
  }
}

/** Pick the most likely inverter port. */
export function autoDetectPort() {
  if (fs.existsSync('/dev/voltacon')) return '/dev/voltacon';
  try {
    const names = fs.readdirSync('/dev');
    const hid = names.filter((n) => /^hidraw\d+$/.test(n)).sort();
    const match = hid.find(isVoltronicHid);
    if (match) return `/dev/${match}`;
    const serial = names.filter((n) => /^ttyUSB\d+$/.test(n)).sort();
    if (serial.length) return `/dev/${serial[0]}`;
  } catch {
    /* not Linux */
  }
  return '/dev/voltacon';
}

/** Lists device files that might be the inverter. */
export function listCandidatePorts() {
  const found = [];
  if (fs.existsSync('/dev/voltacon')) found.push({ path: '/dev/voltacon', label: '/dev/voltacon (inverter USB link)' });
  try {
    for (const name of fs.readdirSync('/dev')) {
      if (/^(hidraw\d+|ttyUSB\d+|ttyACM\d+)$/.test(name)) {
        const inverterChip = name.startsWith('hidraw') && isVoltronicHid(name);
        found.push({ path: `/dev/${name}`, label: inverterChip ? `/dev/${name} (inverter USB)` : `/dev/${name}` });
      }
    }
  } catch {
    /* not Linux */
  }
  return found;
}
