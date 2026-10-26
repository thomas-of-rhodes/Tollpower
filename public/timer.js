// Timer settings page: a daily list of slots, each choosing the inverter's two priorities.

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) node.append(c);
  return node;
};
const minutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const pad = (n) => String(n).padStart(2, '0');

let info = null; // names and meanings of the settings, from /api/status
let slots = [];
let dirty = false;

async function getJson(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

const code = (s) => `${info.output[s.output].code} + ${info.charger[s.charger].code}`;
const gridCharging = (s) => s.charger !== 'OSO';

function renderTimeline() {
  const valid = slots.filter((s) => /^\d\d:\d\d$/.test(s.start)).sort((a, b) => minutes(a.start) - minutes(b.start));
  const parts = [];
  if (valid.length) {
    const first = minutes(valid[0].start);
    if (first > 0) parts.push([0, first, valid[valid.length - 1]]); // the last slot runs on past midnight
    valid.forEach((s, i) => parts.push([minutes(s.start), i + 1 < valid.length ? minutes(valid[i + 1].start) : 1440, s]));
  }
  const now = new Date();
  $('timeline').replaceChildren(
    ...parts.filter(([a, b]) => b > a).map(([a, b, s]) => {
      const pct = ((b - a) / 1440) * 100;
      return el('div', { class: `block ${s.output}`, style: `width:${pct}%`, title: `${s.start}: ${code(s)}` }, pct > 14 ? code(s) : pct > 6 ? info.output[s.output].code : '');
    }),
    el('div', { class: 'now', style: `left:${((now.getHours() * 60 + now.getMinutes()) / 1440) * 100}%`, title: 'Now' }),
  );
  $('timeline').setAttribute('aria-label', valid.map((s) => `From ${s.start}: ${code(s)}`).join('. '));
}

function select(options, value, onChange) {
  const s = el('select', {}, ...options.map(([v, text]) => {
    const o = el('option', { value: v }, text);
    if (v === value) o.selected = true;
    return o;
  }));
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

function changed() {
  dirty = true;
  $('msg').className = 'msg';
  $('msg').textContent = 'Not saved yet.';
  renderTimeline();
}

function renderSlots() {
  $('slots').replaceChildren(...slots.map((s, i) => {
    const id = `slot${i}`;
    const time = el('input', { id: `${id}-start`, type: 'time', step: '60', value: s.start, required: '' });
    time.addEventListener('change', () => {
      s.start = time.value;
      changed();
    });
    const out = select(info.choices.output.map((k) => [k, `${info.output[k].code} · ${info.output[k].name}`]), s.output, (v) => {
      s.output = v;
      changed();
      renderSlots();
    });
    out.id = `${id}-out`;
    const chg = select(info.choices.charger.map((k) => [k, `${info.charger[k].code} · ${info.charger[k].name}`]), s.charger, (v) => {
      s.charger = v;
      if (!gridCharging(s)) s.chargeLimit = null;
      changed();
      renderSlots();
    });
    chg.id = `${id}-chg`;
    const remove = el('button', { class: 'remove', type: 'button', title: 'Remove this slot', 'aria-label': `Remove the ${s.start} slot` }, '×');
    remove.disabled = slots.length === 1;
    remove.addEventListener('click', () => {
      slots.splice(i, 1);
      changed();
      renderSlots();
    });

    const row = el('div', { class: 'slot' },
      el('div', { class: 'slot-row' },
        el('div', {}, el('label', { for: time.id }, 'From'), time),
        el('div', { class: 'grow' }, el('label', { for: out.id }, 'Powers the house'), out),
        el('div', { class: 'grow' }, el('label', { for: chg.id }, 'Charges the battery'), chg),
        remove));

    if (gridCharging(s)) {
      const on = el('input', { type: 'checkbox', id: `${id}-lim` });
      on.checked = s.chargeLimit !== null && s.chargeLimit !== undefined;
      const pct = el('input', { type: 'number', min: '10', max: '100', step: '5', value: String(s.chargeLimit ?? 90), 'aria-label': 'Percent' });
      pct.disabled = !on.checked;
      on.addEventListener('change', () => {
        s.chargeLimit = on.checked ? Number(pct.value) : null;
        pct.disabled = !on.checked;
        changed();
      });
      pct.addEventListener('change', () => {
        s.chargeLimit = Number(pct.value);
        changed();
      });
      row.append(el('div', { class: 'slot-limit' }, on, el('label', { for: on.id, style: 'margin:0' }, 'Stop grid charging at'), pct, '%'));
    }
    return row;
  }));
  renderTimeline();
}

function renderGlossary() {
  const entry = (i, plain) => [el('dt', {}, i.code, el('span', {}, i.name)), el('dd', {}, plain)];
  $('glossary').replaceChildren(
    ...info.choices.output.flatMap((k) => entry(info.output[k], `Powers the house from: ${info.output[k].house}`)),
    ...info.choices.charger.flatMap((k) => entry(info.charger[k], `Charges the battery from: ${info.charger[k].battery}`)),
  );
}

function load(s) {
  info = s.priorities;
  slots = s.schedule.map((x) => ({ ...x }));
  dirty = false;
  $('demo').classList.toggle('hidden', !s.demo);
  $('timerOff').classList.toggle('hidden', s.timerOn);
  $('addBtn').disabled = slots.length >= info.limits.maxSlots;
  renderSlots();
  renderGlossary();
}

$('addBtn').addEventListener('click', () => {
  if (slots.length >= info.limits.maxSlots) return;
  // Start an hour after the last slot, wrapping round midnight
  const last = Math.max(...slots.map((s) => minutes(s.start)));
  const m = (last + 60) % 1440;
  slots.push({ start: `${pad(Math.floor(m / 60))}:${pad(m % 60)}`, output: 'SBU', charger: 'OSO', chargeLimit: null });
  $('addBtn').disabled = slots.length >= info.limits.maxSlots;
  changed();
  renderSlots();
});

$('saveBtn').addEventListener('click', async () => {
  const msg = $('msg');
  msg.className = 'msg';
  msg.textContent = 'Saving…';
  try {
    const s = await getJson('/api/schedule', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slots }),
    });
    load(s);
    msg.className = 'msg good';
    msg.textContent = s.timerOn
      ? 'Saved. The inverter follows the new timer from now.'
      : 'Saved. Switch the timer on from the home page to use it.';
  } catch (err) {
    msg.className = 'msg error';
    msg.textContent = err.message;
  }
});

window.addEventListener('beforeunload', (e) => {
  if (dirty) e.preventDefault();
});
setInterval(renderTimeline, 60_000); // keep the "now" line moving

getJson('/api/status').then(load, (err) => {
  $('msg').className = 'msg error';
  $('msg').textContent = `Can't reach the Pi: ${err.message}`;
});
