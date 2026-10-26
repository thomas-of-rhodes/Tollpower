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
import { DEFAULT_CONFIG } from '../src/store.js';
import { desiredSettings, inCheapWindow } from '../src/modes.js';

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

test('automatic mode: day vs cheap night, with charge target and hysteresis', () => {
  const base = { mode: 'auto', tariff, target: 90 };
  assert.deepEqual(
    pick(desiredSettings({ ...base, date: at(14), soc: 50, wasGridCharging: false })),
    ['SBU', 'OSO'],
  );
  assert.deepEqual(pick(desiredSettings({ ...base, date: at(2), soc: 50, wasGridCharging: false })), ['UTI', 'SNU']);
  assert.deepEqual(pick(desiredSettings({ ...base, date: at(2), soc: 90, wasGridCharging: true })), ['UTI', 'OSO']);
  // Stopped at 90%: don't restart until it drops below 85%
  assert.deepEqual(pick(desiredSettings({ ...base, date: at(2), soc: 87, wasGridCharging: false })), ['UTI', 'OSO']);
  assert.deepEqual(pick(desiredSettings({ ...base, date: at(2), soc: 84, wasGridCharging: false })), ['UTI', 'SNU']);
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

function setup({ mode = 'solar', clockAt = at(14) } = {}) {
  const dir = tempDir();
  let now = clockAt;
  const clock = () => now;
  const sim = new SimulatedTransport({ clock });
  const inverter = new Inverter(sim);
  const config = { ...DEFAULT_CONFIG, mode };
  const history = new History(path.join(dir, 'history.json'));
  const controller = new Controller({ inverter, history, getConfig: () => config, saveConfig: () => {}, clock });
  return { sim, inverter, controller, config, history, advance: (ms) => (now = new Date(now.getTime() + ms)) };
}

test('changing mode really sends commands and confirms them', async () => {
  const { sim, controller } = setup({ mode: 'solar' });
  sim.outputPriority = 'UTI';
  sim.chargerPriority = 'SNU';
  await controller.poll();
  assert.equal(sim.outputPriority, 'SBU');
  assert.equal(sim.chargerPriority, 'OSO');
  assert.equal(controller.settingError, null);

  await controller.setMode('backup');
  assert.equal(sim.outputPriority, 'UTI');
  assert.equal(sim.chargerPriority, 'SNU');
  assert.equal(controller.settings.outputPriority, 'UTI'); // read back from inverter
});

test('falls back to "solar first" on models without "only solar"', async () => {
  const { sim, controller } = setup({ mode: 'solar' });
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

test('history does not invent energy across a gap', () => {
  const dir = tempDir();
  const h = new History(path.join(dir, 'h.json'));
  h.add({ at: at(12), solarW: 1000, loadW: 0, gridW: 0 }, tariff);
  h.add({ at: at(14), solarW: 1000, loadW: 0, gridW: 0 }, tariff); // 2h gap: not counted
  assert.equal(h.today(at(15)).solarKWh, 0);
});
