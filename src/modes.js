// The family-facing modes, and what each one means for the inverter.
//   Output priority:  SBU = solar, then battery, then grid    UTI = grid powers the house
//   Charger priority: OSO = only solar charges the battery     SNU = solar and grid charge it

export const MODES = {
  auto: {
    label: 'Automatic',
    blurb: 'Solar and battery by day. Uses cheap night-rate power to top up the battery.',
  },
  solar: {
    label: 'Solar & battery',
    blurb: 'Never charges from the grid. Grid only used when the battery runs low.',
  },
  backup: {
    label: 'Keep battery full',
    blurb: 'For storms or expected power cuts. House runs on the grid and the battery stays full.',
  },
  grid: {
    label: 'Grid only',
    blurb: 'House runs on the grid. Solar still charges the battery. Useful for maintenance.',
  },
};

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** Is `date` inside the cheap window? Handles windows that cross midnight. */
export function inCheapWindow(date, tariff) {
  const now = date.getHours() * 60 + date.getMinutes();
  const start = toMinutes(tariff.cheapStart);
  const end = toMinutes(tariff.cheapEnd);
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export function ratePenceAt(date, tariff) {
  return inCheapWindow(date, tariff) ? tariff.cheapRatePence : tariff.peakRatePence;
}

/**
 * Work out what the inverter should be set to right now.
 * `wasGridCharging` gives hysteresis so charging doesn't flick on and off
 * around the target.
 */
export function desiredSettings({ mode, date, tariff, soc, target, wasGridCharging }) {
  switch (mode) {
    case 'solar':
      return { outputPriority: 'SBU', chargerPriority: 'OSO', reason: 'Solar & battery mode' };
    case 'backup':
      return { outputPriority: 'UTI', chargerPriority: 'SNU', reason: 'Keep battery full mode' };
    case 'grid':
      return { outputPriority: 'UTI', chargerPriority: 'OSO', reason: 'Grid only mode' };
    case 'auto':
    default: {
      if (!inCheapWindow(date, tariff)) {
        return { outputPriority: 'SBU', chargerPriority: 'OSO', reason: 'Daytime: solar and battery' };
      }
      const resumeBelow = target - 5;
      const needsCharge = soc === null ? true : wasGridCharging ? soc < target : soc < resumeBelow;
      return {
        outputPriority: 'UTI',
        chargerPriority: needsCharge ? 'SNU' : 'OSO',
        reason: needsCharge
          ? `Cheap rate: charging battery to ${target}%`
          : `Cheap rate: battery at target, saving it for later`,
      };
    }
  }
}
