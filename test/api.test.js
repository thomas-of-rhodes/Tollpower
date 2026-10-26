import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { writeJson } from '../src/store.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tollpower-api-'));
writeJson(path.join(dataDir, 'config.json'), { demo: true, mode: 'solar' });
const { app, controller } = createApp({ dataDir });
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const post = (url, body, cookie) => fetch(base + url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
});

test('family status works without a PIN and shows the demo warning', async () => {
  await controller.poll();
  const s = await (await fetch(`${base}/api/status`)).json();
  assert.equal(s.online, true);
  assert.equal(s.demo, true);
  assert.ok(s.alerts.some((a) => a.key === 'demo'));
  assert.equal(typeof s.battery.soc, 'number');
});

test('family can change mode, and it reaches the (demo) inverter', async () => {
  const r = await post('/api/mode', { mode: 'backup' });
  assert.equal(r.status, 200);
  assert.equal(controller.settings.outputPriority, 'UTI');
  assert.equal((await post('/api/mode', { mode: 'nonsense' })).status, 400);
});

test('installer area needs a PIN; wrong PINs lock out', async () => {
  assert.equal((await fetch(`${base}/api/installer/details`)).status, 401);
  const set = await post('/api/pin', { newPin: '2468' });
  assert.equal(set.status, 200);
  const cookie = set.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`${base}/api/installer/details`, { headers: { cookie } })).status, 200);

  // Cannot change the PIN without being logged in once one is set
  assert.equal((await post('/api/pin', { newPin: '1111' })).status, 401);

  for (let i = 0; i < 5; i++) assert.equal((await post('/api/login', { pin: '0000' })).status, 401);
  assert.equal((await post('/api/login', { pin: '2468' })).status, 429);
});

test('diagnostics console refuses anything except read-only queries', async () => {
  const fresh = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tollpower-api-')) });
  const s2 = fresh.app.listen(0);
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const p2 = (url, body, cookie) => fetch(b2 + url, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  await p2('/api/installer/config', { demo: true }); // rejected: not logged in
  const cookie = (await p2('/api/pin', { newPin: '1357' })).headers.get('set-cookie').split(';')[0];
  assert.equal((await p2('/api/installer/config', { demo: true }, cookie)).status, 200);
  assert.equal((await p2('/api/installer/query', { command: 'PF' }, cookie)).status, 400);
  assert.equal((await p2('/api/installer/query', { command: 'QPIGS; reboot' }, cookie)).status, 400);
  const ok = await (await p2('/api/installer/query', { command: 'qmod' }, cookie)).json();
  assert.equal(ok.command, 'QMOD');
  assert.ok(ok.reply);
  assert.equal((await p2('/api/installer/config', { tariff: { cheapStart: '25:00' } }, cookie)).status, 400);
  s2.close();
});
