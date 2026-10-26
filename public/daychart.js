// One day, half hour by half hour: power, battery level and money, sharing one time axis.
// Each half hour is drawn as a flat step (it's an average, not a smooth curve), and
// half hours with no readings are left as gaps.

const ns = 'http://www.w3.org/2000/svg';
const PAD_L = 46, PAD_R = 8, PAD_T = 8;
const node = (tag, attrs = {}, text) => {
  const n = document.createElementNS(ns, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
};
const minutesOf = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const kwText = (kw) => `${kw.toFixed(1)} kW`;
const money = (p) => `${p < 0 ? '−' : ''}£${(Math.abs(p) / 100).toFixed(2)}`;

/** Draw the three charts. `now` (a Date) is given when the day shown is today. */
export function renderDay({ power, battery, money: moneySvg }, slots, { tariff, now } = {}) {
  // Average power over the part of each half hour that had readings.
  const rows = slots.map((s) => {
    if (s.empty || s.minutes < 1) return null;
    const kw = (kwh) => kwh / (s.minutes / 60);
    return {
      solar: kw(s.solarKWh), fromBattery: kw(s.batteryOutKWh), grid: kw(s.gridKWh),
      intoBattery: kw(s.batteryInKWh), house: kw(s.loadKWh), soc: s.soc,
      spent: s.spentPence, would: s.wouldHaveSpentPence, time: s.time,
    };
  });
  // Running totals at the end of each half hour (a gap adds nothing).
  let spent = 0, would = 0;
  const totals = rows.map((r) => {
    if (!r) return null;
    spent += r.spent;
    would += r.would;
    return { spent, would };
  });
  const nowSlot = now ? (now.getHours() * 60 + now.getMinutes()) / 30 : null;

  // ---- Power -------------------------------------------------------------
  drawChart(power, {
    slots, tariff, nowSlot, rows,
    yRange: () => {
      const up = Math.max(0.5, ...rows.map((r) => (r ? Math.max(r.solar + r.fromBattery + r.grid, r.house) : 0)));
      const down = Math.max(0, ...rows.map((r) => (r ? r.intoBattery : 0)));
      return [-down, up];
    },
    yLabel: (v) => `${v < 0 ? '−' : ''}${Math.abs(v)}`,
    draw: (g, x, y) => {
      // Sources stacked above zero, battery charging below it.
      const stack = [['solar', 'sun'], ['fromBattery', 'bat'], ['grid', 'grid']];
      let base = rows.map(() => 0);
      for (const [key, cls] of stack) {
        const top = rows.map((r, i) => (r ? base[i] + r[key] : null));
        g.append(...steps(rows, x, y, base, top, `area ${cls}`));
        base = top.map((v) => v ?? 0);
      }
      g.append(...steps(rows, x, y, rows.map(() => 0), rows.map((r) => (r ? -r.intoBattery : null)), 'area bat into'));
      g.append(...stepLines(rows.map((r) => r?.house ?? null), x, y, 'line house'));
    },
    tip: (r) => [
      r.solar && `Sunshine ${kwText(r.solar)}`, r.fromBattery && `From battery ${kwText(r.fromBattery)}`,
      r.grid && `From grid ${kwText(r.grid)}`, r.intoBattery && `Into battery ${kwText(r.intoBattery)}`,
      `House used ${kwText(r.house)}`,
    ].filter(Boolean),
  });

  // ---- Battery level -----------------------------------------------------
  drawChart(battery, {
    slots, tariff, nowSlot, rows,
    yRange: () => [0, 100],
    yTicks: [0, 50, 100],
    yLabel: (v) => `${v}%`,
    draw: (g, x, y) => {
      const soc = rows.map((r) => r?.soc ?? null);
      g.append(...steps(rows, x, y, rows.map(() => 0), soc, 'area bat level'));
      g.append(...stepLines(soc, x, y, 'line bat'));
    },
    tip: (r) => (r.soc === null ? [] : [`Battery ${r.soc}%`]),
  });

  // ---- Money -------------------------------------------------------------
  drawChart(moneySvg, {
    slots, tariff, nowSlot, rows, xLabels: true,
    yRange: () => [0, Math.max(100, ...totals.map((t) => (t ? Math.max(t.spent, t.would) : 0)))],
    yLabel: (v) => `£${(v / 100).toFixed(v % 100 ? 2 : 0)}`,
    draw: (g, x, y) => {
      // Shade between the lines: green where we've spent less, amber where the
      // battery has been filled ahead (spent more so far, to save later).
      let prev = { spent: 0, would: 0 }; // totals carry across a gap unchanged
      totals.forEach((t, i) => {
        if (!t) return;
        for (const [x0, x1, s0, s1, w0, w1] of splitAtCrossing(x(i), x(i + 1), prev.spent, t.spent, prev.would, t.would)) {
          const pts = [[x0, y(s0)], [x1, y(s1)], [x1, y(w1)], [x0, y(w0)]].map((p) => p.join(',')).join(' ');
          g.append(node('polygon', { points: pts, class: s0 + s1 <= w0 + w1 ? 'gap saved' : 'gap ahead' }));
        }
        prev = t;
      });
      for (const [key, cls] of [['would', 'line would'], ['spent', 'line spent']]) {
        g.append(...joinedLines(totals.map((t) => t?.[key] ?? null), x, y, cls));
      }
    },
    tip: (r, i) => [`Spent so far ${money(totals[i].spent)}`, `Would have spent ${money(totals[i].would)}`],
  });

  const last = totals.findLast((t) => t);
  return last ? { spentPence: last.spent, wouldHaveSpentPence: last.would } : null;
}

function drawChart(svg, { slots, tariff, nowSlot, rows, yRange, yTicks, yLabel, draw, tip, xLabels = false }) {
  const W = Math.max(280, Math.round(svg.clientWidth || svg.parentNode.clientWidth || 600));
  const H = Math.round(svg.clientHeight || 120);
  const padB = xLabels ? 20 : 4;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const n = slots.length;
  const x = (i) => PAD_L + (i / n) * (W - PAD_L - PAD_R);
  const [lo, hi] = yRange();
  const ticks = yTicks || niceTicks(lo, hi);
  const yMin = Math.min(lo, ticks[0]), yMax = Math.max(hi, ticks.at(-1));
  const y = (v) => PAD_T + ((yMax - v) / (yMax - yMin || 1)) * (H - PAD_T - padB);
  const out = [];

  // Cheap-rate hours (the window can cross midnight).
  if (tariff && tariff.cheapStart !== tariff.cheapEnd) {
    const a = minutesOf(tariff.cheapStart) / 30, b = minutesOf(tariff.cheapEnd) / 30;
    for (const [s, e] of a < b ? [[a, b]] : [[a, n], [0, b]]) {
      out.push(node('rect', { class: 'cheap', x: x(s), y: PAD_T, width: x(e) - x(s), height: H - PAD_T - padB }));
    }
  }
  for (const t of ticks) {
    out.push(node('line', { class: t === 0 ? 'zero' : 'gridline', x1: PAD_L, x2: W - PAD_R, y1: y(t), y2: y(t) }));
    out.push(node('text', { class: 'ylabel', x: PAD_L - 6, y: y(t) + 4, 'text-anchor': 'end' }, yLabel(t)));
  }
  if (xLabels) {
    for (let h = 0; h <= 24; h += 6) {
      const anchor = h === 0 ? 'start' : h === 24 ? 'end' : 'middle';
      out.push(node('text', { class: 'xlabel', x: x(h * 2), y: H - 5, 'text-anchor': anchor }, `${String(h % 24).padStart(2, '0')}:00`));
    }
  }
  const g = node('g');
  draw(g, x, y);
  out.push(g);
  if (nowSlot !== null) out.push(node('line', { class: 'now', x1: x(nowSlot), x2: x(nowSlot), y1: PAD_T, y2: H - padB }));

  // Hover/tap targets, one per half hour.
  rows.forEach((r, i) => {
    if (!r) return;
    const end = slots[i + 1]?.time ?? '24:00';
    const hit = node('rect', { class: 'hit', x: x(i), y: 0, width: x(i + 1) - x(i), height: H });
    hit.append(node('title', {}, [`${r.time}–${end}`, ...tip(r, i)].join('\n')));
    out.push(hit);
  });
  svg.replaceChildren(...out);
}

/** Filled steps between `lower` and `upper`, one polygon per run of half hours with readings. */
function steps(rows, x, y, lower, upper, cls) {
  const polys = [];
  for (const [s, e] of runs(upper)) {
    const top = [], bottom = [];
    for (let i = s; i < e; i++) {
      top.push(`${x(i)},${y(upper[i])}`, `${x(i + 1)},${y(upper[i])}`);
      bottom.unshift(`${x(i + 1)},${y(lower[i])}`, `${x(i)},${y(lower[i])}`);
    }
    polys.push(node('polygon', { class: cls, points: [...top, ...bottom].join(' ') }));
  }
  return polys;
}

/** A step line along the tops of the half hours. */
function stepLines(values, x, y, cls) {
  return runs(values).map(([s, e]) => {
    const pts = [];
    for (let i = s; i < e; i++) pts.push(`${x(i)},${y(values[i])}`, `${x(i + 1)},${y(values[i])}`);
    return node('polyline', { class: cls, points: pts.join(' ') });
  });
}

/** A line joining running totals at the end of each half hour, starting from zero at midnight. */
function joinedLines(values, x, y, cls) {
  return runs(values).map(([s, e]) => {
    const pts = [`${x(s)},${y(previous(values, s))}`];
    for (let i = s; i < e; i++) pts.push(`${x(i + 1)},${y(values[i])}`);
    return node('polyline', { class: cls, points: pts.join(' ') });
  });
}

const previous = (values, s) => {
  for (let i = s - 1; i >= 0; i--) if (values[i] !== null) return values[i];
  return 0;
};

/** [start, end) index ranges where values aren't null. */
function runs(values) {
  const out = [];
  let start = null;
  values.forEach((v, i) => {
    if (v !== null && start === null) start = i;
    if (v === null && start !== null) out.push([start, i]), (start = null);
  });
  if (start !== null) out.push([start, values.length]);
  return out;
}

/** Split a segment where the two lines cross, so each piece can be shaded one colour. */
function splitAtCrossing(x0, x1, s0, s1, w0, w1) {
  const d0 = w0 - s0, d1 = w1 - s1;
  if (d0 * d1 >= 0) return [[x0, x1, s0, s1, w0, w1]];
  const t = d0 / (d0 - d1);
  const xm = x0 + t * (x1 - x0), sm = s0 + t * (s1 - s0);
  return [[x0, xm, s0, sm, w0, sm], [xm, x1, sm, s1, sm, w1]];
}

/** About four round-numbered gridlines covering lo..hi. */
function niceTicks(lo, hi) {
  const span = hi - lo || 1;
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const out = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.999; v += step) out.push(+v.toFixed(6));
  return out;
}
