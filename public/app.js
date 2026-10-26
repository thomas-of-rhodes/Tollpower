// Family page. Refreshes every 5 seconds while visible.

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) node.append(c);
  return node;
};

const kw = (w) => (w === null || w === undefined ? '–' : Math.abs(w) >= 1000 ? `${(w / 1000).toFixed(1)} kW` : `${Math.round(w)} W`);
const pounds = (p) => `£${p.toFixed(2)}`;

let changing = false;
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
  $('plan').textContent = s.online && s.plan ? `Now: ${s.plan}` : '';

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

  // Modes
  if (!changing) renderModes(s);

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

function renderModes(s) {
  const box = $('modes');
  box.replaceChildren(
    ...Object.entries(s.modes).map(([key, m]) => {
      const b = el('button', { class: `mode${key === s.mode ? ' active' : ''}`, type: 'button', 'aria-pressed': String(key === s.mode) },
        el('strong', {}, m.label), el('span', {}, m.blurb));
      b.addEventListener('click', () => chooseMode(key, m.label));
      return b;
    }),
  );
}

async function chooseMode(key, label) {
  if (changing || key === lastStatus?.mode) return;
  changing = true;
  const msg = $('modeMsg');
  msg.textContent = `Switching to "${label}"…`;
  for (const b of document.querySelectorAll('.mode')) b.disabled = true;
  try {
    const s = await getJson('/api/mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: key }),
    });
    changing = false;
    render(s);
    const failed = s.alerts.some((a) => a.key === 'setting');
    msg.textContent = !s.online
      ? `Saved. "${label}" will be applied when the inverter is reachable again.`
      : failed
        ? `Saved, but the inverter didn't accept it yet. It will keep trying.`
        : `Done. The inverter confirmed "${label}".`;
  } catch (err) {
    msg.textContent = `Couldn't change mode: ${err.message}`;
  } finally {
    changing = false;
    if (lastStatus) renderModes(lastStatus);
  }
}

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
    $('headline').textContent = "Can't reach the Pi";
    $('plan').textContent = 'Check you are on the home Wi-Fi.';
  }
}

async function refreshHistory() {
  try {
    const h = await getJson('/api/history');
    renderChart(h.days.slice(-14));
  } catch {
    /* try again next time */
  }
}

refresh();
refreshHistory();
setInterval(() => document.visibilityState === 'visible' && refresh(), 5000);
setInterval(() => document.visibilityState === 'visible' && refreshHistory(), 60000);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh());
