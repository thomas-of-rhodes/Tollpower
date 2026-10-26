// Small JSON files under data/. Writes go to a temp file first and are then
// renamed, so a power cut mid-write can't leave a half-written file.

import fs from 'node:fs';
import path from 'node:path';
import { defaultSchedule, scheduleFromOldMode } from './modes.js';

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Could not read ${file}: ${err.message}. Using defaults.`);
    return fallback;
  }
}

export function writeJson(file, value, indent = 2) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, indent));
  fs.renameSync(tmp, file);
}

const DEFAULT_TARIFF = {
  name: 'Octopus Go',
  cheapStart: '00:30',
  cheapEnd: '05:30',
  cheapRatePence: 8.5,
  peakRatePence: 27.0,
};

export const DEFAULT_CONFIG = {
  demo: false,
  port: 'auto',
  installerName: 'Tom',
  tariff: DEFAULT_TARIFF,
  timerOn: true,
  schedule: defaultSchedule(DEFAULT_TARIFF), // daily slots: { start, output, charger, chargeLimit }
  override: null, // a manual over-ride while the timer is on: { output, charger, until }
  manual: { output: 'SBU', charger: 'OSO' }, // used while the timer is off
  lowBatteryWarnSoc: 20,
  pinHash: null,
};

export function loadConfig(file) {
  const saved = readJson(file, {});
  const { mode, nightChargeTargetSoc, ...rest } = saved; // replaced by the timer
  const config = {
    ...DEFAULT_CONFIG,
    ...rest,
    tariff: { ...DEFAULT_CONFIG.tariff, ...(saved.tariff || {}) },
  };
  if (!saved.schedule) {
    config.schedule = mode
      ? scheduleFromOldMode(mode, config.tariff, nightChargeTargetSoc ?? 90)
      : defaultSchedule(config.tariff);
  }
  return config;
}
