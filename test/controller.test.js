import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Inverter } from '../src/inverter.js';
import { SimulatedTransport } from '../src/simulator.js';
import { Controller } from '../src/controller.js';
import { History } from '../src/history.js';
import { buildFrame } from '../src/protocol.js';
import { DEFAULT_CONFIG, loadConfig, writeJson } from '../src/store.js';
import { defaultSchedule, desiredSettings, inCheapWindow, slotAt, validateSchedule } from '../src/modes.js';

const tariff = DEFAULT_CONFIG.tariff; // 00:30-05:30
const at = (hh, mm = 0) => new Date(2026, 9, 26, hh, mm);

test('cheap window, including windows that cross midnight', () => {
  assert.equal(inCheapWindow(at(0, 29), tariff), false);
  assert.equal(inCheapWindow(at(0, 30), tariff), true);
  assert.equal(inCheapWindow(at(5, 29), tariff), true);
  assert.equal(inCheapWindow(at(5, 30), tariff), false);
  const ig = { ...tariff, cheapStart: '23:30', cheapEnd: '05:30' };
  assert.equal(inCheapWindow(at(23, 45), ig), true);
  assert.equal(inCheapWindow(at(3, 0), ig), true);
  assert.equal(inCheapWindow(at(12, 0), ig), false);
});

test('default timer: grid charging in the cheap window up to 90%, with hysteresis', () => {
  const base = { timerOn: true, schedule: defaultSchedule(tariff), override: null };
  assert.deepEqual(pick(desiredSettings({ ...base, date: at(14), soc: 50, wasGridCharging: false })), ['SBU', 'OSO']);
  assert.deepEqual(pick(desiredSettings({ ...base, date: at(2), soc: 50, wasGridCharging: false })), ['UTI', 'SNU']);
  assert.deepEqual(pick(desiredSettings({ ...base, date: at(2), soc: 90, wasGridCharging: true })), ['UTI', 'OSO']);
  // Stopped at 90%: don't restart until it drops below 85%
  assert.deepEqual(pick(desiredSettings({ ...base, date: at(2), soc: 87, wasGridCharging: false })), ['UTI', 'OSO']);
  assert.deepEqual(pick(desiredSettings({ ...base, date: at(2), soc: 84, wasGridCharging: false })), ['UTI', 'SNU']);
});

test('timer slots wrap around midnight and say when the next one starts', () => {
  const schedule = defaultSchedule(tariff); // 00:30 and 05:30
  assert.equal(slotAt(schedule, at(0, 10)).slot.start, '05:30'); // yesterday's day slot still running
  assert.equal(slotAt(schedule, at(0, 10)).until.getTime(), at(0, 30).getTime());
  assert.equal(slotAt(schedule, at(23, 0)).until.getTime(), new Date(2026, 9, 27, 0, 30).getTime());
  const one = [{ start: '00:00', output: 'SBU', charger: 'OSO', chargeLimit: null }];
  assert.equal(slotAt(one, at(14)).until.getTime(), new Date(2026, 9, 27, 0, 0).getTime());
});

test('timer settings are checked before saving', () => {
  const ok = validateSchedule([
    { start: '05:30', output: 'SBU', charger: 'OSO', chargeLimit: 80 },
    { start: '00:30', output: 'UTI', charger: 'SNU', chargeLimit: 90 },
  ]);
  // Sorted by time; "only solar" can't have a grid charging limit
  assert.deepEqual(ok.slots.map((s) => [s.start, s.chargeLimit]), [['00:30', 90], ['05:30', null]]);
  assert.ok(validateSchedule([]).errors);
  assert.ok(validateSchedule([{ start: '25:00', output: 'SBU', charger: 'OSO' }]).errors);
  assert.ok(validateSchedule([{ start: '01:00', output: 'XYZ', charger: 'OSO' }]).errors);
  assert.ok(validateSchedule([{ start: '01:00', output: 'UTI', charger: 'UTI' }]).errors); // CUT isn't offered
  assert.match(validateSchedule([
    { start: '01:00', output: 'UTI', charger: 'SNU' },
    { start: '01:10', output: 'SBU', charger: 'OSO' },
  ]).errors[0], /too close/);
});

test('old configs with a named mode become an equivalent timer', () => {
  const file = path.join(tempDir(), 'config.json');
  writeJson(file, { mode: 'auto', nightChargeTargetSoc: 80 });
  const c = loadConfig(file);
  assert.equal(c.mode, undefined);
  assert.deepEqual(
    c.schedule.map((s) => [s.start, s.output, s.charger, s.chargeLimit]),
    [['00:30', 'UTI', 'SNU', 80], ['05:30', 'SBU', 'OSO', null]],
  );
  writeJson(file, { mode: 'backup' });
  assert.deepEqual(loadConfig(file).schedule, [{ start: '00:00', output: 'UTI', charger: 'SNU', chargeLimit: null }]);
});

const pick = (d) => [d.outputPriority, d.chargerPriority];

// Temp data folders, removed once this file's tests finish.
const tempDirs = [];
const tempDir = (prefix = 'tollpower-') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};
after(() => tempDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function setup({ clockAt = at(14), ...cfg } = {}) {
  const dir = tempDir();
  let now = clockAt;
  const clock = () => now;
  const sim = new SimulatedTransport({ clock });
  const inverter = new Inverter(sim);
  let config = { ...DEFAULT_CONFIG, ...cfg };
  const history = new History(path.join(dir, 'history.json'));
  const controller = new Controller({ inverter, history, getConfig: () => config, saveConfig: (c) => (config = c), clock });
  return { sim, inverter, controller, history, config: () => config, advance: (ms) => (now = new Date(now.getTime() + ms)) };
}

test('the timer really sends commands at the slot change and confirms them', async () => {
  const { sim, controller, advance } = setup({ clockAt: at(0, 29) });
  sim.soc = 50;
  await controller.poll();
  assert.deepEqual([sim.outputPriority, sim.chargerPriority], ['SBU', 'OSO']);
  advance(60_000); // 00:30: the cheap-rate slot starts
  await controller.poll();
  assert.deepEqual([sim.outputPriority, sim.chargerPriority], ['UTI', 'SNU']);
  assert.equal(controller.settings.outputPriority, 'UTI'); // read back from inverter
  assert.equal(controller.settingError, null);
  assert.equal(controller.snapshot().plan.source, 'timer');
});

test('a manual over-ride lasts until the next timer slot', async () => {
  const { sim, controller, advance, config } = setup({ clockAt: at(14) });
  await controller.poll();
  await controller.setSettings({ output: 'UTI', charger: 'SNU' });
  assert.deepEqual([sim.outputPriority, sim.chargerPriority], ['UTI', 'SNU']);
  assert.equal(config().override.until, new Date(2026, 9, 27, 0, 30).toISOString());
  assert.equal(controller.snapshot().plan.source, 'override');

  advance(11 * 3600_000); // 01:00 next day: the 00:30 slot has taken over
  sim.soc = 50;
  await controller.poll();
  assert.equal(config().override, null);
  assert.equal(controller.snapshot().plan.source, 'timer');

  await controller.setSettings({ output: 'SBU', charger: 'OSO' });
  await controller.clearOverride();
  assert.deepEqual([sim.outputPriority, sim.chargerPriority], ['UTI', 'SNU']);
  await assert.rejects(controller.setSettings({ output: 'SBU', charger: 'UTI' }));
});

test('timer off keeps the current settings until set manually', async () => {
  const { sim, controller, advance, config } = setup({ clockAt: at(14) });
  await controller.poll();
  await controller.setTimer(false);
  assert.deepEqual(config().manual, { output: 'SBU', charger: 'OSO' });
  advance(12 * 3600_000); // 02:00: the timer would charge from the grid, but it's off
  await controller.poll();
  assert.deepEqual([sim.outputPriority, sim.chargerPriority], ['SBU', 'OSO']);
  await controller.setSettings({ output: 'SOL', charger: 'SOL' });
  assert.deepEqual([sim.outputPriority, sim.chargerPriority], ['SOL', 'SOL']);
  assert.equal(config().override, null);
  await controller.setTimer(true);
  sim.soc = 50;
  await controller.poll();
  assert.deepEqual([sim.outputPriority, sim.chargerPriority], ['UTI', 'SNU']);
});

test('falls back to "solar first" on models without "only solar"', async () => {
  const { sim, controller } = setup();
  const original = sim.exchange.bind(sim);
  sim.exchange = async (frame) => {
    if (frame.toString('latin1').startsWith('PCP03')) return buildFrame('(NAK');
    return original(frame);
  };
  sim.chargerPriority = 'SNU';
  await controller.poll();
  assert.equal(sim.chargerPriority, 'SOL');
  assert.ok(controller.unsupported.has('OSO'));
});

test('goes offline and shows no numbers when the inverter stops answering', async () => {
  const { sim, controller, advance } = setup();
  await controller.poll();
  assert.equal(controller.snapshot().online, true);
  sim.failNext = 100;
  advance(31_000);
  await controller.poll().catch(() => {});
  const snap = controller.snapshot();
  assert.equal(snap.online, false);
  assert.equal(snap.battery, null);
  assert.equal(snap.status.level, 'problem');
  assert.match(snap.status.headline, /Can't talk/);
});

test('history adds up energy and savings from real readings', () => {
  const dir = tempDir();
  const h = new History(path.join(dir, 'h.json'));
  // 1 kW load, all from solar, for one hour at peak rate, sampled every 10s
  for (let s = 0; s <= 3600; s += 10) {
    h.add({ at: new Date(at(12).getTime() + s * 1000), solarW: 1000, loadW: 1000, gridW: 0 }, tariff);
  }
  const t = h.today(at(13));
  assert.equal(t.solarKWh, 1);
  assert.equal(t.loadKWh, 1);
  assert.equal(t.savedPounds, +(tariff.peakRatePence / 100).toFixed(2));
  h.save();
  const reloaded = new History(path.join(dir, 'h.json'));
  assert.equal(reloaded.today(at(13)).solarKWh, 1);
  assert.match(reloaded.toCsv(), /2026-10-26,1.00,1.00,0.00/);
});

test('history keeps half hours, with the battery and spent vs would-have-spent', () => {
  const dir = tempDir();
  const h = new History(path.join(dir, 'h.json'));
  // 01:00-01:30, cheap rate: 1 kW house + 2 kW into the battery, all from the grid
  for (let s = 0; s <= 1800; s += 10) {
    h.add({ at: new Date(at(1).getTime() + s * 1000), solarW: 0, loadW: 1000, gridW: 3000, batteryW: 2000, soc: 40 + s / 180 }, tariff);
  }
  h.breakSeries();
  // 18:00-18:15 only, peak rate: 2 kW house from the battery
  for (let s = 0; s <= 900; s += 10) {
    h.add({ at: new Date(at(18).getTime() + s * 1000), solarW: 0, loadW: 2000, gridW: 0, batteryW: -2000, soc: 60 }, tariff);
  }
  h.save();
  const slots = new History(path.join(dir, 'h.json')).daySlots(at(12));
  assert.equal(slots.length, 48);
  assert.equal(slots[0].time, '00:00');
  assert.equal(slots[0].empty, true);
  // The first reading only starts the series, and the one at exactly 01:30 lands in the
  // next half hour, so 01:00 holds 1790 seconds.
  const kWh = (watts) => (watts * 1790) / 3600 / 1000;
  const night = slots[2];
  assert.equal(night.time, '01:00');
  assert.equal(night.minutes, +(1790 / 60).toFixed(1));
  assert.equal(night.batteryInKWh, +kWh(2000).toFixed(3));
  assert.equal(night.spentPence, +(kWh(3000) * tariff.cheapRatePence).toFixed(2));
  assert.equal(night.wouldHaveSpentPence, +(kWh(1000) * tariff.cheapRatePence).toFixed(2));
  // A half hour that only had 15 minutes of readings says so, rather than being stretched.
  const evening = slots[36];
  assert.equal(evening.minutes, 15);
  assert.equal(evening.batteryOutKWh, 0.5);
  assert.equal(evening.spentPence, 0);
  assert.equal(evening.wouldHaveSpentPence, 0.5 * tariff.peakRatePence);
  assert.equal(evening.soc, 60);
});

test('history does not invent energy across a gap', () => {
  const dir = tempDir();
  const h = new History(path.join(dir, 'h.json'));
  h.add({ at: at(12), solarW: 1000, loadW: 0, gridW: 0 }, tariff);
  h.add({ at: at(14), solarW: 1000, loadW: 0, gridW: 0 }, tariff); // 2h gap: not counted
  assert.equal(h.today(at(15)).solarKWh, 0);
});

