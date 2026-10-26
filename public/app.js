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

  // Battery
  const soc = s.battery?.soc;
  const ring = $('socRing');
  ring.style.strokeDashoffset = String(314.16 * (1 - (soc ?? 0) / 100));
  $('socText').textContent = soc === undefined || soc === null ? '–' : `${Math.round(soc)}%`;
  if (!s.battery) {
    $('batteryState').textContent = 'Unknown';
    $('batteryDetail').textContent = 'No live reading';
  } else {
    const w = s.battery.watts;
    $('batteryState').textContent = w > 30 ? `Charging, ${kw(w)}` : w < -30 ? `Powering the house, ${kw(-w)}` : 'Resting';
    $('batteryDetail').textContent = `${s.battery.volts?.toFixed(1)} V`;
  }

  // Power
  $('solarW').textContent = kw(s.flow?.solarW);
  $('loadW').textContent = kw(s.flow?.loadW);
  $('gridW').textContent = kw(s.flow?.gridW);
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
