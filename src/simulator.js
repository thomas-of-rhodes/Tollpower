// A pretend inverter for demo mode and tests. It speaks the same byte-level
// protocol as the real one, so everything above the transport is exercised.

import { buildFrame, OUTPUT_PRIORITIES, CHARGER_PRIORITIES } from './protocol.js';

function reply(payload) {
  // A real reply frame is "(" + payload + CRC + CR
  return buildFrame(`(${payload}`);
}

const pad = (n, width, decimals = 0) => n.toFixed(decimals).padStart(width, '0');

export class SimulatedTransport {
  constructor({ clock = () => new Date() } = {}) {
    this.clock = clock;
    this.outputPriority = 'SBU';
    this.chargerPriority = 'OSO';
    this.soc = 72;
    this.lastTick = null;
    this.failNext = 0; // tests can force failures
  }

  describe() {
    return 'Demo inverter (simulated)';
  }

  #solarWatts(now) {
    const h = now.getHours() + now.getMinutes() / 60;
    if (h < 7 || h > 19) return 0;
    return Math.round(Math.sin(((h - 7) / 12) * Math.PI) * 2400 * (0.85 + Math.random() * 0.15));
  }

  #loadWatts(now) {
    const h = now.getHours();
    let w = 350 + Math.random() * 120;
    if (h >= 7 && h < 9) w += 900;
    if (h >= 17 && h < 21) w += 1300;
    return Math.round(w);
  }

  #state() {
    const now = this.clock();
    const solar = this.#solarWatts(now);
    const load = this.#loadWatts(now);
    const onGrid = this.outputPriority === 'UTI' || (this.outputPriority === 'SBU' && this.soc <= 20);
    const gridCharge = this.chargerPriority === 'SNU' || this.chargerPriority === 'UTI';
    let batteryWatts; // + charging, - discharging
    if (onGrid) batteryWatts = solar + (gridCharge && this.soc < 100 ? 1500 : 0);
    else batteryWatts = solar - load;
    if (this.soc >= 100 && batteryWatts > 0) batteryWatts = 0;

    // Integrate state of charge (10 kWh battery)
    const t = now.getTime();
    if (this.lastTick) {
      const hours = Math.min((t - this.lastTick) / 3.6e6, 0.05);
      this.soc = Math.max(5, Math.min(100, this.soc + (batteryWatts * hours) / 100));
    }
    this.lastTick = t;
    return { solar, load, onGrid, batteryWatts, gridCharge };
  }

  async exchange(frame) {
    await new Promise((r) => setTimeout(r, 15));
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('No reply from inverter within 3s');
    }
    // Strip the 2 CRC bytes and CR to get the command text.
    const cmd = frame.subarray(0, frame.length - 3).toString('ascii');
    const s = this.#state();
    const volts = 48 + (this.soc / 100) * 6;

    if (cmd === 'QPIGS') {
      const chargeA = s.batteryWatts > 0 ? s.batteryWatts / volts : 0;
      const dischargeA = s.batteryWatts < 0 ? -s.batteryWatts / volts : 0;
      // Status bits, written b7..b0: b4 load on, b2 charging, b1 solar charging, b0 grid charging
      const charging = s.batteryWatts > 0;
      const bits = `0001 0${charging ? 1 : 0}${charging && s.solar > 0 ? 1 : 0}${charging && s.gridCharge && s.onGrid ? 1 : 0}`.replace(' ', '');
      const pvV = s.solar > 0 ? 180 + Math.random() * 20 : 0;
      return reply([
        '230.1', '50.0', '229.8', '50.0',
        pad(s.load * 1.05, 4), pad(s.load, 4), pad((s.load / 5000) * 100, 3),
        '390', pad(volts, 5, 2), pad(chargeA, 3), pad(this.soc, 3), '0038',
        pad(pvV ? s.solar / pvV : 0, 4, 1), pad(pvV, 5, 1), pad(volts, 5, 2), pad(dischargeA, 5),
        bits, '00', '00', pad(s.solar, 5), '010',
      ].join(' '));
    }
    if (cmd === 'QPIRI') {
      const op = OUTPUT_PRIORITIES.indexOf(this.outputPriority);
      const cp = CHARGER_PRIORITIES.indexOf(this.chargerPriority);
      return reply(`230.0 21.7 230.0 50.0 21.7 5000 5000 48.0 48.0 44.0 56.4 54.0 2 30 60 0 ${op} ${cp} 1 01 0 0 52.0 0 1`);
    }
    if (cmd === 'QMOD') return reply(s.onGrid ? 'L' : 'B');
    if (cmd === 'QPIWS') return reply('0'.repeat(32));
    if (cmd === 'QID') return reply('92931705100001');
    if (cmd === 'QVFW') return reply('VERFW:00072.70');

    let m = /^POP0([0-2])$/.exec(cmd);
    if (m) {
      this.outputPriority = OUTPUT_PRIORITIES[Number(m[1])];
      return reply('ACK');
    }
    m = /^PCP0([0-3])$/.exec(cmd);
    if (m) {
      this.chargerPriority = CHARGER_PRIORITIES[Number(m[1])];
      return reply('ACK');
    }
    return reply('NAK');
  }
}
