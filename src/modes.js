// The inverter's two priority settings, and the daily timer that chooses them.
//
// The inverter works by two settings (per the Voltronic manual for the 11 kW Axpert MAX):
//   Output source priority (program 01): what powers the house.
//     UTI  the grid; solar and battery only if the grid fails, so solar can only charge the battery.
//     SOL  solar, with the grid topping up; the battery only if the grid fails.
//     SBU  solar, then battery; the grid only when the battery drops to program 12,
//          back to the battery once it recovers to program 13.
//   Charger source priority (program 16): what charges the battery.
//     CSO  solar; the grid only when there is no solar.
//     SNU  solar and grid together.
//     OSO  only solar.
//   The charger setting only applies while running on the grid; on battery, only solar charges.
//
// With the timer on, a daily schedule of slots picks the settings. A manual over-ride then
// lasts until the next slot. With the timer off, the settings stay as last set manually.

// Keys are the PI30 names used in protocol.js; `code` is what the inverter's own screen shows.
export const OUTPUT_INFO = {
  UTI: { code: 'UTI', name: 'Utility first', house: 'Grid. Solar and battery only take over in a power cut.' },
  SOL: { code: 'SOL', name: 'Solar first', house: 'Solar, with the grid topping up. Battery only in a power cut.' },
  SBU: { code: 'SBU', name: 'SBU priority', house: 'Solar → battery → grid (grid only when the battery runs low).' },
};
export const CHARGER_INFO = {
  SOL: { code: 'CSO', name: 'Solar first', battery: 'Solar. The grid only when there is no solar.' },
  SNU: { code: 'SNU', name: 'Solar and utility', battery: 'Solar + grid together.' },
  OSO: { code: 'OSO', name: 'Only solar', battery: 'Solar only. Never the grid.' },
  // Shown if the inverter reports it, but not offered: it isn't in the 11 kW menu.
  UTI: { code: 'CUT', name: 'Utility first', battery: 'Grid first, then solar.' },
};
export const OUTPUT_CHOICES = ['UTI', 'SOL', 'SBU'];
export const CHARGER_CHOICES = ['SOL', 'SNU', 'OSO'];
const GRID_CHARGERS = new Set(['UTI', 'SOL', 'SNU']);

// Each change is an inverter write, so keep the timer from changing too often.
export const MAX_SLOTS = 8;
export const MIN_SLOT_MINUTES = 15;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
export const settingsLabel = ({ output, charger }) => `${OUTPUT_INFO[output].code} + ${CHARGER_INFO[charger].code}`;

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

/** Charge from the grid in the cheap window (up to `target`%), solar and battery the rest of the day. */
export function defaultSchedule(tariff, target = 90) {
  const day = { start: tariff.cheapEnd, output: 'SBU', charger: 'OSO', chargeLimit: null };
  if (tariff.cheapStart === tariff.cheapEnd) return [{ ...day, start: '00:00' }];
  return [{ start: tariff.cheapStart, output: 'UTI', charger: 'SNU', chargeLimit: target }, day]
    .sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
}

/** Configs from before the timer chose one of four named modes; turn that into a schedule. */
export function scheduleFromOldMode(mode, tariff, target) {
  const allDay = (output, charger) => [{ start: '00:00', output, charger, chargeLimit: null }];
  if (mode === 'solar') return allDay('SBU', 'OSO');
  if (mode === 'backup') return allDay('UTI', 'SNU');
  if (mode === 'grid') return allDay('UTI', 'OSO');
  return defaultSchedule(tariff, target);
}

export function validSettings({ output, charger } = {}) {
  return OUTPUT_CHOICES.includes(output) && CHARGER_CHOICES.includes(charger);
}

/** Check and tidy a schedule from the web page. Returns { slots } or { errors }. */
export function validateSchedule(input) {
  if (!Array.isArray(input) || input.length === 0) return { errors: ['The timer needs at least one slot'] };
  if (input.length > MAX_SLOTS) return { errors: [`The timer can have at most ${MAX_SLOTS} slots`] };
  const errors = [];
  const slots = input.map((s, i) => {
    const n = `Slot ${i + 1}`;
    if (!TIME.test(s?.start)) errors.push(`${n}: start must be HH:MM`);
    if (!validSettings(s)) errors.push(`${n}: choose a house and a battery setting`);
    let chargeLimit = s?.chargeLimit ?? null;
    if (!GRID_CHARGERS.has(s?.charger)) chargeLimit = null; // only grid charging can be limited
    if (chargeLimit !== null && !(Number.isInteger(chargeLimit) && chargeLimit >= 10 && chargeLimit <= 100)) {
      errors.push(`${n}: grid charging limit must be 10–100%`);
    }
    return { start: s?.start, output: s?.output, charger: s?.charger, chargeLimit };
  });
  if (errors.length) return { errors };
  slots.sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  for (let i = 0; i < slots.length; i++) {
    const next = slots[(i + 1) % slots.length];
    const gap = (toMinutes(next.start) - toMinutes(slots[i].start) + 1440) % 1440 || 1440;
    if (slots.length > 1 && gap < MIN_SLOT_MINUTES) {
      return { errors: [`Slots at ${slots[i].start} and ${next.start} are too close: keep them at least ${MIN_SLOT_MINUTES} minutes apart`] };
    }
  }
  return { slots };
}

/** The slot in force at `date`, and when the next one starts. `schedule` is sorted by start. */
export function slotAt(schedule, date) {
  const now = date.getHours() * 60 + date.getMinutes();
  let i = schedule.length - 1; // before the first start of the day, yesterday's last slot still runs
  for (let j = 0; j < schedule.length; j++) if (toMinutes(schedule[j].start) <= now) i = j;
  const next = schedule[(i + 1) % schedule.length];
  const until = new Date(date);
  until.setHours(...next.start.split(':').map(Number), 0, 0);
  if (until <= date) until.setDate(until.getDate() + 1);
  return { slot: schedule[i], next, until };
}

/**
 * Work out what the inverter should be set to right now.
 * `wasGridCharging` gives hysteresis so a grid charging limit doesn't flick on and off.
 */
export function desiredSettings({ timerOn, schedule, override, manual, date, soc, wasGridCharging }) {
  let source;
  let chosen;
  let until = null;
  if (!timerOn) {
    source = 'manual';
    chosen = manual;
  } else if (override && date < new Date(override.until)) {
    source = 'override';
    chosen = override;
    until = new Date(override.until);
  } else {
    const now = slotAt(schedule, date);
    source = 'timer';
    chosen = now.slot;
    until = now.until;
  }

  let charger = chosen.charger;
  const limit = chosen.chargeLimit ?? null;
  let limitReached = false;
  if (limit !== null && GRID_CHARGERS.has(charger) && soc !== null) {
    limitReached = wasGridCharging ? soc >= limit : soc >= limit - 5;
    if (limitReached) charger = 'OSO';
  }

  const by = { manual: 'Set manually', override: 'Manual over-ride', timer: `Timer slot from ${chosen.start}` }[source];
  return {
    outputPriority: chosen.output,
    chargerPriority: charger,
    source,
    until: until?.toISOString() ?? null,
    chargeLimit: limit,
    limitReached,
    reason: `${by}: ${settingsLabel({ output: chosen.output, charger })}${limitReached ? ` (battery reached ${limit}%, grid charging paused)` : ''}`,
  };
}
