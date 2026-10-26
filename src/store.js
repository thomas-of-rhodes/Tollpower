// Small JSON files under data/. Writes go to a temp file first and are then
// renamed, so a power cut mid-write can't leave a half-written file.

import fs from 'node:fs';
import path from 'node:path';

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Could not read ${file}: ${err.message}. Using defaults.`);
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export const DEFAULT_CONFIG = {
  demo: false,
  port: 'auto',
  mode: 'auto',
  installerName: 'Tom',
  tariff: {
    name: 'Octopus Go',
    cheapStart: '00:30',
    cheapEnd: '05:30',
    cheapRatePence: 8.5,
    peakRatePence: 27.0,
  },
  nightChargeTargetSoc: 90,
  lowBatteryWarnSoc: 20,
  pinHash: null,
};

export function loadConfig(file) {
  const saved = readJson(file, {});
  return {
    ...DEFAULT_CONFIG,
    ...saved,
    tariff: { ...DEFAULT_CONFIG.tariff, ...(saved.tariff || {}) },
  };
}
