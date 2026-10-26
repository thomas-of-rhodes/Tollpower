// Voltronic PI30 protocol, used by Voltacon / Axpert-family inverters.
// Pure functions only: no I/O here, so everything in this file is unit-tested.

const CR = 0x0d;

/** CRC-16/XMODEM with the Voltronic tweak: CRC bytes that would collide
 *  with '(' CR or LF are bumped by one. */
export function crc16(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  let hi = (crc >> 8) & 0xff;
  let lo = crc & 0xff;
  if ([0x28, 0x0d, 0x0a].includes(hi)) hi += 1;
  if ([0x28, 0x0d, 0x0a].includes(lo)) lo += 1;
  return [hi, lo];
}

/** Build the bytes to send for a command, e.g. "QPIGS" -> QPIGS + CRC + CR */
export function buildFrame(command) {
  const body = Buffer.from(command, 'ascii');
  return Buffer.concat([body, Buffer.from([...crc16(body), CR])]);
}

/**
 * Check and unwrap a response frame: "(" + payload + CRC(2) + CR.
 * USB HID replies are padded with 0x00 bytes after the CR; everything from
 * the CR on is ignored. (CRC bytes are never CR, but can be 0x00, so zeros
 * before the CR must be kept.) Returns { ok, payload, error }.
 */
export function parseFrame(raw) {
  let buf = Buffer.from(raw);
  // Some USB adapters put zero padding *before* the reply starts; skip it.
  const start = buf.findIndex((b) => b !== 0x00);
  if (start > 0) buf = buf.subarray(start);
  const crIndex = buf.indexOf(CR);
  if (crIndex === -1) return { ok: false, payload: '', error: 'No end-of-frame marker' };
  buf = buf.subarray(0, crIndex);
  if (buf.length < 3) return { ok: false, payload: '', error: 'Frame too short' };
  const body = buf.subarray(0, buf.length - 2);
  const [hi, lo] = crc16(body);
  if (buf[buf.length - 2] !== hi || buf[buf.length - 1] !== lo) {
    return { ok: false, payload: body.toString('latin1'), error: 'Checksum mismatch' };
  }
  const text = body.toString('ascii');
  if (!text.startsWith('(')) return { ok: false, payload: text, error: 'Missing start marker' };
  return { ok: true, payload: text.slice(1) };
}

const num = (s) => {
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

/** QPIGS: live readings. */
export function parseQPIGS(payload) {
  const f = payload.trim().split(/\s+/);
  if (f.length < 17) throw new Error(`QPIGS: expected at least 17 fields, got ${f.length}`);
  const status = f[16] || '';
  const bit = (i) => status.length === 8 && status[i] === '1'; // b7..b0 left to right
  const pvVolts = num(f[13]);
  const pvAmps = num(f[12]);
  return {
    gridVolts: num(f[0]),
    gridHz: num(f[1]),
    outVolts: num(f[2]),
    outHz: num(f[3]),
    outVA: num(f[4]),
    outWatts: num(f[5]),
    loadPercent: num(f[6]),
    busVolts: num(f[7]),
    batteryVolts: num(f[8]),
    batteryChargeAmps: num(f[9]),
    batterySoc: num(f[10]),
    heatsinkC: num(f[11]),
    pvAmps,
    pvVolts,
    batteryVoltsScc: num(f[14]),
    batteryDischargeAmps: num(f[15]),
    // Some firmwares report PV power directly (field 19); otherwise estimate.
    pvWatts: f[19] !== undefined ? num(f[19]) : Math.round((pvVolts || 0) * (pvAmps || 0)),
    loadOn: bit(3),
    charging: bit(5),
    chargingFromSolar: bit(6),
    chargingFromGrid: bit(7),
  };
}

export const OUTPUT_PRIORITIES = ['UTI', 'SOL', 'SBU']; // index = PI30 code
export const CHARGER_PRIORITIES = ['UTI', 'SOL', 'SNU', 'OSO']; // index = PI30 code

/** QPIRI: rated info and current settings. Field positions per PI30 spec. */
export function parseQPIRI(payload) {
  const f = payload.trim().split(/\s+/);
  if (f.length < 18) throw new Error(`QPIRI: expected at least 18 fields, got ${f.length}`);
  return {
    ratedWatts: num(f[6]),
    batteryRatedVolts: num(f[7]),
    batteryRechargeVolts: num(f[8]),
    batteryUnderVolts: num(f[9]),
    batteryBulkVolts: num(f[10]),
    batteryFloatVolts: num(f[11]),
    batteryType: ['AGM', 'Flooded', 'User', 'Pylontech', 'Shinheung', 'Weco', 'Soltaro', 'LIb', 'Lic'][Number(f[12])] ?? `Type ${f[12]}`,
    maxAcChargeAmps: num(f[13]),
    maxChargeAmps: num(f[14]),
    outputPriority: OUTPUT_PRIORITIES[Number(f[16])] ?? null,
    chargerPriority: CHARGER_PRIORITIES[Number(f[17])] ?? null,
  };
}

export const MODES = {
  P: 'Starting up',
  S: 'Standby',
  L: 'Running on grid',
  B: 'Running on battery/solar',
  F: 'Fault',
  H: 'Power saving',
  D: 'Shut down',
};

export function parseQMOD(payload) {
  const code = payload.trim().charAt(0);
  return { code, label: MODES[code] ?? `Unknown (${code})` };
}

// QPIWS warning bits, index = position in the 32-char string.
// level: 'fault' stops the inverter; 'warning' needs attention.
const WARNING_BITS = {
  1: ['fault', 'Inverter fault'],
  2: ['fault', 'Internal voltage too high (bus over)'],
  3: ['fault', 'Internal voltage too low (bus under)'],
  4: ['fault', 'Internal start-up failure (bus soft fail)'],
  5: ['warning', 'Grid power lost'],
  6: ['fault', 'Output short circuit'],
  7: ['fault', 'Output voltage too low'],
  8: ['fault', 'Output voltage too high'],
  9: ['fault', 'Inverter overheating'],
  10: ['warning', 'Cooling fan stuck'],
  11: ['fault', 'Battery voltage too high'],
  12: ['warning', 'Battery low'],
  14: ['fault', 'Battery shut down: too low'],
  16: ['fault', 'Overload'],
  17: ['warning', 'Inverter memory (EEPROM) error'],
  18: ['fault', 'Output over-current'],
  19: ['fault', 'Inverter start-up failure'],
  20: ['fault', 'Self-test failed'],
  21: ['fault', 'DC on output'],
  22: ['fault', 'Battery disconnected'],
  23: ['fault', 'Current sensor failure'],
  24: ['fault', 'Battery short circuit'],
  25: ['warning', 'Power limited'],
  26: ['warning', 'Solar panel voltage too high'],
  27: ['fault', 'Solar charger overload'],
  28: ['warning', 'Solar charger overload'],
  29: ['warning', 'Battery too low to charge'],
};

export function parseQPIWS(payload) {
  const bits = payload.trim();
  const out = [];
  for (const [index, [level, text]] of Object.entries(WARNING_BITS)) {
    if (bits[Number(index)] === '1') out.push({ code: `W${index}`, level, text });
  }
  // When the 'Inverter fault' bit is clear, the inverter is still running:
  // downgrade everything else to a warning (PI30 convention).
  if (bits[1] !== '1') for (const w of out) w.level = w.level === 'fault' ? 'warning' : w.level;
  return out;
}

/** Commands that change settings. Response is "(ACK" or "(NAK". */
export function setOutputPriorityCommand(p) {
  const i = OUTPUT_PRIORITIES.indexOf(p);
  if (i < 0) throw new Error(`Unknown output priority ${p}`);
  return `POP0${i}`;
}

export function setChargerPriorityCommand(p) {
  const i = CHARGER_PRIORITIES.indexOf(p);
  if (i < 0) throw new Error(`Unknown charger priority ${p}`);
  return `PCP0${i}`;
}

/** Only read-only queries may be sent from the diagnostics console. */
export function isQueryCommand(cmd) {
  return /^Q[A-Z0-9]{1,15}$/.test(cmd);
}
