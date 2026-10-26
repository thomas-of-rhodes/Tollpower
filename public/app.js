// Family page. Refreshes every 5 seconds while visible.

import { renderDay } from './daychart.js';

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) node.append(c);
  return node;
};

const kw = (w) => (w === null || w === undefined ? '–' : Math.abs(w) >= 1000 ? `${(w / 1000).toFixed(1)} kW` : `${Math.round(w)} W`);
const pounds = (p) => `£${p.toFixed(2)}`;
const hhmm = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

let busy = false; // a change is being sent; don't redraw the controls under the user
let choosing = null; // { output, charger } while "Manual Over-Ride" is open
let lastStatus = null;

async function getJson(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function render(s) {
  lastStatus = s;
  $('demo').classList.toggle('hidden', !s.demo);

  const st = $('status');
  st.className = `status ${s.status.level}`;
  $('headline').textContent = s.status.headline;

  const alerts = $('alerts');
  alerts.replaceChildren(
    ...s.alerts
      .filter((a) => a.key !== 'demo')
      .map((a) => el('div', { class: `alert ${a.level}` }, el('strong', {}, a.title), el('span', {}, a.advice))),
  );

  $('updated').textContent = s.updatedAt
    ? `Updated ${new Date(s.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
    : 'No live data';

  renderScene(s);
  const t = s.tariff;
  $('rate').textContent = s.cheapNow
    ? `Cheap rate now (${t.cheapStart}–${t.cheapEnd}), ${t.cheapRatePence}p/kWh`
    : `Normal rate now (${t.peakRatePence}p/kWh). Cheap rate ${t.cheapStart}–${t.cheapEnd}.`;

  if (!busy) renderSettings(s);

  // Today
  $('tSolar').textContent = `${s.today.solarKWh.toFixed(1)} kWh`;
  $('tGrid').textContent = `${s.today.gridKWh.toFixed(1)} kWh`;
  $('tSaved').textContent = pounds(s.today.savedPounds);
}

// Below this many watts a line counts as idle (sensor noise, standby).
const IDLE_W = 30;

function setFlow(id, watts, reverse = false) {
  const path = $(id);
  const on = watts !== null && watts !== undefined && Math.abs(watts) >= IDLE_W;
  const level = !on ? 0 : Math.abs(watts) < 300 ? 0 : Math.abs(watts) < 1500 ? 1 : 2;
  path.classList.toggle('on', on);
  path.classList.toggle('reverse', reverse);
  path.style.setProperty('--dur', ['1.1s', '0.65s', '0.4s'][level]);
  path.setAttribute('stroke-width', [2.5, 3.5, 4.5][level]);
}

// Bulb colour by how much the house is using: yellow, then orange, then red.
const BULB_COLOURS = [[1000, '#f5d547'], [2500, '#f59e42'], [Infinity, '#f05252']];

// Battery is green from 25% up; below that it fades from amber to red (fully red at 5%).
const BATTERY_LOW = 25;
const mixHex = (a, b, t) => '#' + [1, 3, 5]
  .map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, '0'))
  .join('');
const batteryColour = (soc) => (soc === null || soc >= BATTERY_LOW
  ? 'var(--battery)'
  : mixHex('#f0b84d', '#f04f4f', Math.min(1, (BATTERY_LOW - soc) / (BATTERY_LOW - 5))));

// "1.8 kW" as a number with a smaller, muted unit.
function setPower(id, watts) {
  const [num, unit] = kw(watts).split(' ');
  const span = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
  span.setAttribute('class', 'unit');
  span.textContent = ` ${unit}`;
  $(id).replaceChildren(num, ...(unit ? [span] : []));
}

// 20 battery segments (5% each), bottom one first. Built once.
let segments = null;
function batterySegments() {
  if (!segments) {
    segments = Array.from({ length: 20 }, (_, i) => {
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      Object.entries({ class: 'battery-seg', x: 396, y: 278.5 - i * 6, width: 48, height: 4.5, rx: 1.5 })
        .forEach(([k, v]) => r.setAttribute(k, v));
      return r;
    });
    $('batterySegs').replaceChildren(...segments);
  }
  return segments;
}

function renderScene(s) {
  const f = s.flow; // null when offline: everything goes still and shows "–"
  const b = s.battery;
  const soc = b?.soc ?? null;

  $('sun').classList.toggle('off', !(f?.solarW >= IDLE_W));
  $('sun').style.opacity = f?.solarW >= IDLE_W ? String(0.55 + 0.45 * Math.min(1, f.solarW / 2000)) : '';
  setPower('sceneSolar', f?.solarW);

  const lit = f?.loadW >= IDLE_W;
  $('bulb').classList.toggle('lit', lit);
  if (lit) $('scene').style.setProperty('--bulb', BULB_COLOURS.find(([max]) => f.loadW < max)[1]);
  $('bulb').querySelector('.glow').style.opacity = lit ? String(0.35 + 0.65 * Math.min(1, f.loadW / 2000)) : '';
  setPower('sceneLoad', f?.loadW);

  $('gridAbout').style.display = f?.gridW >= IDLE_W ? '' : 'none';
  setPower('sceneGrid', f?.gridW);

  // One segment per 5%, rounded up so a nearly empty battery still shows one.
  const litSegs = soc === null ? 0 : Math.ceil(Math.max(0, Math.min(100, soc)) / 5);
  batterySegments().forEach((seg, i) => seg.classList.toggle('on', i < litSegs));
  $('scene').style.setProperty('--bat', batteryColour(soc));
  const bw = b?.watts ?? null;
  const state = !b ? '' : bw > IDLE_W ? 'charging' : bw < -IDLE_W ? 'in use' : 'resting';
  $('sceneBatLbl').textContent = state ? `Battery ${state}` : 'Battery';
  $('sceneSoc').textContent = soc === null ? '–' : `${Math.round(soc)}%`;
  $('led').setAttribute('class', `led ${f ? s.status.level : ''}`);
  $('ledTitle').textContent = f ? s.status.headline : 'No live reading';
  $('sceneBatW').textContent = state === 'charging' || state === 'in use' ? ` · ${kw(Math.abs(bw))}` : '';

  setFlow('flowSolar', f?.solarW);
  setFlow('flowGrid', f?.gridW);
  setFlow('flowLoad', f?.loadW);
  setFlow('flowBattery', bw, bw < 0);

  $('scene').setAttribute('aria-label', !f
    ? 'No live reading'
    : `Solar ${kw(f.solarW)}. House using ${kw(f.loadW)}. From grid about ${kw(f.gridW)}. `
      + `Battery ${soc === null ? 'unknown' : `${Math.round(soc)}%`}${state ? `, ${state}` : ''}${$('sceneBatW').textContent.replace(' · ', ' at ')}.`);
}

// ---- Timer and inverter settings -------------------------------------------

const label = (s, { output, charger }) => `${s.priorities.output[output].code} + ${s.priorities.charger[charger].code}`;

function renderSettings(s) {
  const { output: OUT, charger: CHG } = s.priorities;
  const sw = $('timerSwitch');
  sw.setAttribute('aria-checked', String(s.timerOn));
  // Only animate the lever once it shows the real state, not on page load
  if (!sw.classList.contains('ready')) requestAnimationFrame(() => requestAnimationFrame(() => sw.classList.add('ready')));
  $('timerState').textContent = s.timerOn ? 'On: the timer sets the inverter' : 'Off: stays as set manually';

  // What the inverter itself reports, not what we asked for.
  const now = s.settings;
  const show = (prefix, info, plainKey) => {
    $(`${prefix}Code`).textContent = info ? info.code : '–';
    $(`${prefix}Name`).textContent = info ? info.name : '';
    $(`${prefix}Plain`).textContent = info ? info[plainKey] : 'No live reading';
  };
  show('out', now && OUT[now.output], 'house');
  show('chg', now && CHG[now.charger], 'battery');

  const p = s.plan;
  const note = $('planNote');
  note.replaceChildren();
  if (p && s.online) {
    const changingNow = now && (now.output !== p.output || now.charger !== p.charger);
    let text = changingNow ? `Changing to ${label(s, p)}…` : {
      timer: `Set by the timer until ${p.until && hhmm(p.until)}.`,
      override: `Manual over-ride until ${p.until && hhmm(p.until)}, then the timer takes over.`,
      manual: 'Timer off: stays like this until you change it.',
    }[p.source];
    if (p.limitReached) text += ` Battery reached ${p.chargeLimit}%, so grid charging is paused.`;
    else if (p.chargeLimit && p.charger !== 'OSO') text += ` Grid charging up to ${p.chargeLimit}%.`;
    note.append(text);
    if (p.source === 'override') {
      const back = el('button', { class: 'link', type: 'button' }, 'Back to timer');
      back.addEventListener('click', () => send('/api/settings/back-to-timer', {}, 'Back on the timer.'));
      note.append(' ', back);
    }
  } else if (!s.online) {
    note.append('The settings will be checked again when the inverter is reachable.');
  }

  $('changeBtn').classList.toggle('hidden', !!choosing);
  $('chooser').classList.toggle('hidden', !choosing);
  if (choosing) renderChooser(s);
}

function renderChooser(s) {
  const { output: OUT, charger: CHG, choices } = s.priorities;
  const options = (box, keys, info, plainKey, field) => $(box).replaceChildren(...keys.map((k) => {
    const b = el('button', { class: 'seg', type: 'button', 'aria-pressed': String(choosing[field] === k) },
      el('strong', {}, info[k].code), el('span', {}, info[k].name), el('small', {}, info[k][plainKey]));
    b.addEventListener('click', () => {
      choosing[field] = k;
      renderChooser(s);
    });
    return b;
  }));
  options('chooseOutput', choices.output, OUT, 'house', 'output');
  options('chooseCharger', choices.charger, CHG, 'battery', 'charger');
  $('chooseNote').textContent = s.timerOn
    ? `Lasts until ${s.plan?.until ? hhmm(s.plan.until) : 'the next timer slot'}, then the timer takes over.`
    : 'The timer is off, so this stays until you change it.';
}

async function send(url, body, done) {
  if (busy) return;
  busy = true;
  const msg = $('settingsMsg');
  msg.className = 'msg';
  msg.textContent = 'Sending to the inverter…';
  try {
    const s = await getJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    busy = false;
    render(s);
    const failed = s.alerts.some((a) => a.key === 'setting');
    msg.className = `msg ${failed ? 'error' : 'good'}`;
    msg.textContent = !s.online
      ? 'Saved. It will be applied when the inverter is reachable again.'
      : failed ? "Saved, but the inverter didn't accept it yet. It will keep trying." : done;
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = `Couldn't change it: ${err.message}`;
  } finally {
    busy = false;
    if (lastStatus) renderSettings(lastStatus);
  }
}

$('timerSwitch').addEventListener('click', () => {
  if (!lastStatus || busy) return;
  const on = !lastStatus.timerOn;
  $('timerSwitch').setAttribute('aria-checked', String(on)); // move the lever straight away
  send('/api/timer', { on }, on ? 'Timer on: it sets the inverter from now.' : 'Timer off: the settings stay as they are.');
});

$('changeBtn').addEventListener('click', () => {
  if (!lastStatus) return;
  const p = lastStatus.plan ?? lastStatus.settings ?? { output: 'SBU', charger: 'OSO' };
  choosing = { output: p.output, charger: p.charger === 'UTI' ? 'SNU' : p.charger };
  $('settingsMsg').textContent = '';
  renderSettings(lastStatus);
});
$('cancelBtn').addEventListener('click', () => {
  choosing = null;
  if (lastStatus) renderSettings(lastStatus);
});
$('applyBtn').addEventListener('click', () => {
  if (!choosing || !lastStatus) return;
  const chosen = choosing;
  choosing = null;
  send('/api/settings', chosen, `Done. The inverter confirmed ${label(lastStatus, chosen)}.`);
});

function renderChart(days) {
  const svg = $('chart');
  const ns = 'http://www.w3.org/2000/svg';
  const W = 600, H = 160, pad = 18;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const max = Math.max(1, ...days.map((d) => Math.max(d.solarKWh || 0, d.gridKWh || 0)));
  const slot = W / days.length;
  const bw = Math.min(16, slot / 3);
  const nodes = [];
  days.forEach((d, i) => {
    const x = i * slot + slot / 2;
    for (const [key, cls, off] of [['solarKWh', 'bar-solar', -bw - 1], ['gridKWh', 'bar-grid', 1]]) {
      const v = d[key] || 0;
      const h = (v / max) * (H - pad - 6);
      const r = document.createElementNS(ns, 'rect');
      Object.entries({ x: x + off, y: H - pad - h, width: bw, height: Math.max(h, d.empty ? 0 : 1), rx: 2, class: cls })
        .forEach(([k, v2]) => r.setAttribute(k, v2));
      const title = document.createElementNS(ns, 'title');
      title.textContent = `${d.date}: ${v.toFixed(1)} kWh ${key === 'solarKWh' ? 'solar' : 'from grid'}`;
      r.append(title);
      nodes.push(r);
    }
    if (i % 2 === days.length % 2 || i === days.length - 1) {
      const t = document.createElementNS(ns, 'text');
      t.setAttribute('x', x);
      t.setAttribute('y', H - 4);
      t.setAttribute('text-anchor', 'middle');
      t.textContent = i === days.length - 1 ? 'Today' : new Date(d.date).toLocaleDateString([], { day: 'numeric', month: 'short' });
      nodes.push(t);
    }
  });
  svg.replaceChildren(...nodes);
}

async function refresh() {
  try {
    render(await getJson('/api/status'));
  } catch {
    $('status').className = 'status problem';
    $('headline').textContent = "Can't reach the Pi. Check you are on the home Wi-Fi.";
  }
}

// Which day "Through the day" shows: 0 is today, -1 yesterday, ...
let dayOffset = 0;
let lastSlots = null;

function shownDay() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset);
}

function drawDay() {
  if (!lastSlots) return;
  const totals = renderDay(
    { power: $('dayPower'), battery: $('dayBattery'), money: $('dayMoney') },
    lastSlots,
    { tariff: lastStatus?.tariff, now: dayOffset === 0 ? new Date() : null },
  );
  $('dayNote').textContent = totals
    ? `Spent ${pounds(totals.spentPence / 100)}. Without solar and battery it would have been ${pounds(totals.wouldHaveSpentPence / 100)}.`
    : 'No readings for this day.';
}

async function refreshHistory() {
  try {
    const d = shownDay();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const h = await getJson(`/api/history?date=${date}`);
    renderChart(h.days.slice(-14));
    lastSlots = h.slots;
    drawDay();
  } catch {
    /* try again next time */
  }
}

function changeDay(step) {
  dayOffset = Math.min(0, Math.max(-399, dayOffset + step));
  const d = shownDay();
  $('dayName').textContent = dayOffset === 0 ? 'Today' : dayOffset === -1 ? 'Yesterday'
    : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  $('dayNext').disabled = dayOffset === 0;
  lastSlots = null;
  refreshHistory();
}
$('dayPrev').addEventListener('click', () => changeDay(-1));
$('dayNext').addEventListener('click', () => changeDay(1));
addEventListener('resize', drawDay);

refresh().finally(refreshHistory); // the day chart shades the cheap hours from the status
setInterval(() => document.visibilityState === 'visible' && refresh(), 5000);
setInterval(() => document.visibilityState === 'visible' && refreshHistory(), 60000);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh());
