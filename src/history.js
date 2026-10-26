// Real energy history, built by adding up live readings over time.
// Keeps half-hourly detail for 400 days (tariffs are priced by the half hour,
// so this is enough to try another tariff on our own data later) and daily
// totals for 10 years.

import { readJson, writeJson } from './store.js';
import { ratePenceAt } from './modes.js';

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const slotTime = (d) => `${pad(d.getHours())}:${d.getMinutes() < 30 ? '00' : '30'}`;
const slotKey = (d) => `${dayKey(d)}T${slotTime(d)}`;

const SLOT_DAYS = 400;

const emptyTotals = () => ({ solarKWh: 0, loadKWh: 0, gridKWh: 0, gridCostPence: 0, savedPence: 0 });
// `seconds` is how much of the half hour had readings, so averages aren't diluted by gaps.
// `soc` is the last battery reading in the slot.
const emptySlot = () => ({ ...emptyTotals(), batteryInKWh: 0, batteryOutKWh: 0, seconds: 0, soc: null });

export class History {
  constructor(file) {
    this.file = file;
    const saved = readJson(file, {});
    // Older files had hourly buckets ("hours"); they can't be split into half hours, so they're dropped.
    this.slots = saved.slots || {}; // slotKey -> totals
    this.days = saved.days || {}; // dayKey -> totals
    this.lastSampleAt = null;
    this.dirty = false;
  }

  /**
   * Add one reading. Watts are integrated over the time since the previous
   * reading; gaps over 30s are skipped so missing data never invents energy.
   * batteryW is positive while charging, negative while discharging.
   */
  add({ at, solarW, loadW, gridW, batteryW = 0, soc = null }, tariff) {
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
    const slot = (this.slots[slotKey(at)] ??= emptySlot());
    add(slot);
    slot.batteryInKWh += Math.max(0, batteryW) * h;
    slot.batteryOutKWh += Math.max(0, -batteryW) * h;
    slot.seconds += seconds;
    if (soc !== null && soc !== undefined) slot.soc = soc;
    add((this.days[dayKey(at)] ??= emptyTotals()));
    this.dirty = true;
  }

  /** Called when the link drops so the gap isn't counted. */
  breakSeries() {
    this.lastSampleAt = null;
  }

  save() {
    if (!this.dirty) return;
    const oldest = slotKey(new Date(Date.now() - SLOT_DAYS * 86400e3));
    for (const k of Object.keys(this.slots)) if (k < oldest) delete this.slots[k];
    const dayKeys = Object.keys(this.days).sort();
    for (const k of dayKeys.slice(0, Math.max(0, dayKeys.length - 3650))) delete this.days[k];
    // A year of half hours is ~17,500 entries: write it compactly.
    writeJson(this.file, { slots: this.slots, days: this.days }, 0);
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

  /** The 48 half hours of one day, 00:00..23:30. Half hours with no readings are { empty: true }. */
  daySlots(day = new Date()) {
    const out = [];
    for (let i = 0; i < 48; i++) {
      const d = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(i / 2), (i % 2) * 30);
      const b = this.slots[slotKey(d)];
      out.push({ time: slotTime(d), ...(b ? roundSlot(b) : { empty: true }) });
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

// Pence, not pounds, so 48 slots can be added up without rounding errors piling up.
function roundSlot(b) {
  return {
    solarKWh: +b.solarKWh.toFixed(3),
    loadKWh: +b.loadKWh.toFixed(3),
    gridKWh: +b.gridKWh.toFixed(3),
    batteryInKWh: +b.batteryInKWh.toFixed(3),
    batteryOutKWh: +b.batteryOutKWh.toFixed(3),
    spentPence: +b.gridCostPence.toFixed(2),
    wouldHaveSpentPence: +(b.gridCostPence + b.savedPence).toFixed(2),
    minutes: +(b.seconds / 60).toFixed(1),
    soc: b.soc,
  };
}
