import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createApp, allowedHost } from '../src/app.js';
import { isValidPortPath } from '../src/transport.js';
import { writeJson } from '../src/store.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tollpower-sec-'));
writeJson(path.join(dataDir, 'config.json'), { demo: true });
const { app } = createApp({ dataDir });
const server = app.listen(0);
const port = server.address().port;
after(() => server.close());

// fetch() won't let us set Host, so use http.request directly.
function request({ method = 'GET', url, host, body, cookie }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: url,
      headers: {
        host: host ?? `127.0.0.1:${port}`,
        ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
        ...(cookie ? { cookie } : {}),
      },
    }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('allowedHost accepts IPs, localhost and the Pi\'s own name only', () => {
  for (const h of ['192.168.1.20', '192.168.1.20:3000', '[::1]:80', '[fe80::1]', 'localhost:3000', 'tollpower', 'tollpower.local', 'TollPower.Local:80', 'tollpower.local.']) {
    assert.ok(allowedHost(h, 'tollpower', ''), h);
  }
  for (const h of ['evil.example', 'tollpower.local.evil.example', 'nottollpower.local', '', undefined, 'bad host']) {
    assert.ok(!allowedHost(h, 'tollpower', ''), String(h));
  }
  assert.ok(allowedHost('power.home.lan', 'tollpower', 'power.home.lan, other'));
});

test('requests addressed to another site\'s name are refused (DNS rebinding)', async () => {
  assert.equal((await request({ url: '/api/status' })).status, 200);
  assert.equal((await request({ url: '/api/status', host: `localhost:${port}` })).status, 200);
  assert.equal((await request({ url: '/api/status', host: 'attacker.example' })).status, 421);
  const r = await request({ method: 'POST', url: '/api/mode', host: 'attacker.example', body: { mode: 'grid' } });
  assert.equal(r.status, 421);
  const s = JSON.parse((await request({ url: '/api/status' })).text);
  assert.notEqual(s.mode, 'grid');
});

test('isValidPortPath allows inverter devices and nothing else', () => {
  for (const p of ['auto', '/dev/voltacon', '/dev/hidraw0', '/dev/ttyUSB1', '/dev/ttyACM0', '/dev/ttyAMA0', '/dev/serial0',
    '/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_A1234-if00-port0']) {
    assert.ok(isValidPortPath(p), p);
  }
  for (const p of ['/dev/../home/pi/.bashrc', '/dev/hidraw0/../../etc/passwd', '/dev/serial/by-id/..', '/etc/passwd',
    '/dev/sda', '/dev/null', '/dev/hidraw', 'hidraw0', '', undefined, null, 42]) {
    assert.ok(!isValidPortPath(p), String(p));
  }
});

test('installer cannot point the inverter link at an arbitrary file', async () => {
  const set = await request({ method: 'POST', url: '/api/pin', body: { newPin: '8642' } });
  const cookie = set.headers['set-cookie'][0].split(';')[0];
  const bad = await request({ method: 'POST', url: '/api/installer/config', body: { port: '/dev/../home/pi/.bashrc' }, cookie });
  assert.equal(bad.status, 400);
  const ok = await request({ method: 'POST', url: '/api/installer/config', body: { port: '/dev/ttyUSB0', demo: true }, cookie });
  assert.equal(ok.status, 200);
});
