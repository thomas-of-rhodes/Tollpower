// Real energy history, built by adding up live readings over time.
// Keeps hourly detail for 31 days and daily totals for 10 years.

import { readJson, writeJson } from './store.js';
import { ratePenceAt } from './modes.js';

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hourKey = (d) => `${dayKey(d)}T${pad(d.getHours())}`;

const emptyTotals = () => ({ solarKWh: 0, loadKWh: 0, gridKWh: 0, gridCostPence: 0, savedPence: 0 });

export class History {
  constructor(file) {
    this.file = file;
    const saved = readJson(file, {});
    this.hours = saved.hours || {}; // hourKey -> totals
    this.days = saved.days || {}; // dayKey -> totals
    this.lastSampleAt = null;
    this.dirty = false;
  }

  /**
   * Add one reading. Watts are integrated over the time since the previous
   * reading; gaps over 30s are skipped so missing data never invents energy.
   */
  add({ at, solarW, loadW, gridW }, tariff) {
    const t = at.getTime();
    const prev = this.lastSampleAt;
    this.lastSampleAt = t;
    if (prev === null) return;
    const seconds = (t - prev) / 1000;
    if (seconds <= 0 || seconds > 30) return; // a gap: don't guess what happened
    const h = seconds / 3600 / 1000; // W -> kWh factor
    const rate = ratePenceAt(at, tariff);
    const solar = Math.max(0, solarW) * h;
    const load = Math.max(0, loadW) * h;
    const grid = Math.max(0, gridW) * h;
    const add = (bucket) => {
      bucket.solarKWh += solar;
      bucket.loadKWh += load;
      bucket.gridKWh += grid;
      bucket.gridCostPence += grid * rate;
      // What the house would have paid with no inverter, minus what it did pay.
      bucket.savedPence += (load - grid) * rate;
    };
    add((this.hours[hourKey(at)] ??= emptyTotals()));
    add((this.days[dayKey(at)] ??= emptyTotals()));
    this.dirty = true;
  }

  /** Called when the link drops so the gap isn't counted. */
  breakSeries() {
    this.lastSampleAt = null;
  }

  save() {
    if (!this.dirty) return;
    const now = Date.now();
    for (const k of Object.keys(this.hours)) {
      if (now - new Date(`${k}:00:00`).getTime() > 31 * 86400e3) delete this.hours[k];
    }
    const dayKeys = Object.keys(this.days).sort();
    for (const k of dayKeys.slice(0, Math.max(0, dayKeys.length - 3650))) delete this.days[k];
    writeJson(this.file, { hours: this.hours, days: this.days });
    this.dirty = false;
  }

  today(now = new Date()) {
    return round(this.days[dayKey(now)] || emptyTotals());
  }

  /** Daily totals for the last `n` days, oldest first (missing days are null). */
  lastDays(n, now = new Date()) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const k = dayKey(d);
      out.push({ date: k, ...(this.days[k] ? round(this.days[k]) : { empty: true }) });
    }
    return out;
  }

  /** Hourly totals for today, 0..23. */
  todayHours(now = new Date()) {
    const out = [];
    for (let hr = 0; hr < 24; hr++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hr);
      const b = this.hours[hourKey(d)];
      out.push({ hour: hr, ...(b ? round(b) : { empty: true }) });
    }
    return out;
  }

  toCsv() {
    const rows = [['date', 'solar_kWh', 'used_kWh', 'grid_kWh', 'grid_cost_GBP', 'saved_GBP']];
    for (const k of Object.keys(this.days).sort()) {
      const d = this.days[k];
      rows.push([k, d.solarKWh.toFixed(2), d.loadKWh.toFixed(2), d.gridKWh.toFixed(2),
        (d.gridCostPence / 100).toFixed(2), (d.savedPence / 100).toFixed(2)]);
    }
    return rows.map((r) => r.join(',')).join('\n') + '\n';
  }
}

function round(b) {
  return {
    solarKWh: +b.solarKWh.toFixed(2),
    loadKWh: +b.loadKWh.toFixed(2),
    gridKWh: +b.gridKWh.toFixed(2),
    gridCostPounds: +(b.gridCostPence / 100).toFixed(2),
    savedPounds: +(b.savedPence / 100).toFixed(2),
  };
}
