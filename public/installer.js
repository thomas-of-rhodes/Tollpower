// Installer page (PIN protected).

const $ = (id) => document.getElementById(id);

async function api(url, body) {
  const res = await fetch(url, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url.startsWith('/api/installer')) {
    showLogin();
    throw new Error('Locked');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function say(id, text, good = true) {
  const m = $(id);
  m.textContent = text;
  m.className = `msg ${good ? 'good' : 'error'}`;
}

function rows(table, pairs) {
  $(table).replaceChildren(
    ...pairs.map(([k, v]) => {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.textContent = k;
      const td = document.createElement('td');
      td.className = 'num';
      if (v instanceof Node) td.append(v);
      else td.textContent = v ?? '–';
      tr.append(th, td);
      return tr;
    }),
  );
}

const pill = (text, kind = '') => {
  const s = document.createElement('span');
  s.className = `pill ${kind}`;
  s.textContent = text;
  return s;
};

const NAMES = {
  SBU: 'Solar → battery → grid (SBU)',
  UTI: 'Grid first (UTI)',
  SOL: 'Solar first (SOL)',
  SNU: 'Solar + grid (SNU)',
  OSO: 'Only solar (OSO)',
};

let pinSet = true;

async function showLogin() {
  $('panel').classList.add('hidden');
  $('loginCard').classList.remove('hidden');
  const a = await api('/api/auth');
  pinSet = a.pinSet;
  $('loginTitle').textContent = pinSet ? 'Enter installer PIN' : 'Choose an installer PIN';
  $('pinLabel').textContent = pinSet ? 'PIN' : 'New PIN (4–8 digits). Only you should know this.';
  $('loginBtn').textContent = pinSet ? 'Unlock' : 'Set PIN';
  $('pin').focus();
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    if (pinSet) await api('/api/login', { pin: $('pin').value });
    else await api('/api/pin', { newPin: $('pin').value });
    $('pin').value = '';
    $('loginMsg').textContent = '';
    start();
  } catch (err) {
    $('loginMsg').textContent = err.message;
  }
});

async function loadDetails() {
  const d = await api('/api/installer/details');
  const l = d.live;
  const fresh = d.liveAt && Date.now() - new Date(d.liveAt).getTime() < 30000;
  rows('liveTable', l ? [
    ['Inverter', d.mode?.label],
    ['Battery', `${l.batterySoc}% · ${l.batteryVolts} V`],
    ['Battery current', `+${l.batteryChargeAmps} A / −${l.batteryDischargeAmps} A`],
    ['Solar', `${l.pvWatts} W · ${l.pvVolts} V`],
    ['Output', `${l.outWatts} W · ${l.outVolts} V · ${l.outHz} Hz · ${l.loadPercent}%`],
    ['Grid', `${l.gridVolts} V · ${l.gridHz} Hz`],
    ['Heatsink', `${l.heatsinkC} °C`],
    ['Last reading', fresh ? pill(new Date(d.liveAt).toLocaleTimeString()) : pill('stale', 'bad')],
  ] : [['Status', pill('No reading yet', 'bad')]]);

  const s = d.settings;
  const want = d.desired;
  const match = (a, b) => (a && b && a === b ? pill('matches') : pill(`should be ${NAMES[b] ?? b ?? '–'}`, 'warn'));
  rows('settingsTable', s ? [
    ['Output priority', NAMES[s.outputPriority] ?? s.outputPriority],
    ['', match(s.outputPriority, want?.outputPriority)],
    ['Charger priority', NAMES[s.chargerPriority] ?? s.chargerPriority],
    ['', match(s.chargerPriority, want?.chargerPriority)],
    ['Battery type', s.batteryType],
    ['Bulk / float', `${s.batteryBulkVolts} V / ${s.batteryFloatVolts} V`],
    ['Back to grid / cut-off', `${s.batteryRechargeVolts} V / ${s.batteryUnderVolts} V`],
    ['Max charge (total / grid)', `${s.maxChargeAmps} A / ${s.maxAcChargeAmps} A`],
    ['Rated power', `${s.ratedWatts} W`],
    ['Last change problem', d.settingError ? pill(d.settingError, 'bad') : pill('none')],
  ] : [['Status', pill('Not read yet', 'warn')]]);

  const k = d.link;
  $('linkSummary').textContent = `${k.describe}. Messages: ${k.ok} ok, ${k.failed} failed.${k.lastError ? ` Last error: ${k.lastError}` : ''}`;
  $('commLog').textContent = d.log
    .map((e) => `${new Date(e.at).toLocaleTimeString()}  ${e.command.padEnd(6)} ${e.ok ? `→ ${e.reply}` : `✗ ${e.error}`}  (${e.ms} ms)`)
    .join('\n') || '–';
  $('events').textContent = d.events.map((e) => `${new Date(e.at).toLocaleString()}  [${e.level}] ${e.text}`).join('\n') || 'Nothing yet.';
  $('version').textContent = `Tollpower ${d.version}${d.commit ? ` (${d.commit})` : ''}`;
}

async function loadConfig() {
  const c = await api('/api/installer/config');
  $('tName').value = c.tariff.name;
  $('installerName').value = c.installerName;
  $('cheapStart').value = c.tariff.cheapStart;
  $('cheapEnd').value = c.tariff.cheapEnd;
  $('cheapRate').value = c.tariff.cheapRatePence;
  $('peakRate').value = c.tariff.peakRatePence;
  $('target').value = c.nightChargeTargetSoc;
  $('lowWarn').value = c.lowBatteryWarnSoc;
  $('demo').checked = c.demo;
  const opts = [{ path: 'auto', label: `Automatic (currently ${c.detectedPort})` }, ...c.ports];
  if (c.port !== 'auto' && !opts.some((o) => o.path === c.port)) opts.push({ path: c.port, label: `${c.port} (not found)` });
  $('port').replaceChildren(...opts.map((o) => {
    const opt = document.createElement('option');
    opt.value = o.path;
    opt.textContent = o.label;
    opt.selected = o.path === c.port;
    return opt;
  }));
}

$('tariffForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/installer/config', {
      installerName: $('installerName').value,
      tariff: {
        name: $('tName').value,
        cheapStart: $('cheapStart').value,
        cheapEnd: $('cheapEnd').value,
        cheapRatePence: Number($('cheapRate').value),
        peakRatePence: Number($('peakRate').value),
      },
      nightChargeTargetSoc: Number($('target').value),
      lowBatteryWarnSoc: Number($('lowWarn').value),
    });
    say('tariffMsg', 'Saved.');
  } catch (err) {
    say('tariffMsg', err.message, false);
  }
});

$('linkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/installer/config', { port: $('port').value, demo: $('demo').checked });
    say('linkMsg', 'Saved. Reconnecting…');
    setTimeout(loadDetails, 6000);
  } catch (err) {
    say('linkMsg', err.message, false);
  }
});

$('queryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/installer/query', { command: $('query').value });
    $('queryOut').textContent = r.error ? `${r.command}: ✗ ${r.error}` : `${r.command} → ${r.reply}`;
  } catch (err) {
    $('queryOut').textContent = err.message;
  }
});

$('updateBtn').addEventListener('click', async () => {
  if (!confirm('Download and install the latest version? The page will be unavailable for a minute or two.')) return;
  const log = $('updateLog');
  log.classList.remove('hidden');
  try {
    log.textContent = (await api('/api/installer/update', {})).message;
    const poll = setInterval(async () => {
      try {
        const res = await fetch('/api/installer/update-log');
        if (res.ok) log.textContent = await res.text();
        if (/Update finished|rolled back|Already up to date/.test(log.textContent)) clearInterval(poll);
      } catch {
        /* server restarting */
      }
    }, 3000);
  } catch (err) {
    log.textContent = err.message;
  }
});

$('pinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/pin', { newPin: $('newPin').value });
    $('newPin').value = '';
    say('pinMsg', 'PIN changed.');
  } catch (err) {
    say('pinMsg', err.message, false);
  }
});

$('logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', {});
  showLogin();
});

let timer;
async function start() {
  try {
    await loadDetails();
    await loadConfig();
  } catch {
    return; // showLogin already called
  }
  $('loginCard').classList.add('hidden');
  $('panel').classList.remove('hidden');
  clearInterval(timer);
  timer = setInterval(() => document.visibilityState === 'visible' && loadDetails().catch(() => {}), 5000);
}

start();
