// Web server: the family page, the installer area, and a small JSON API.

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Inverter } from './inverter.js';
import { DeviceTransport, autoDetectPort, listCandidatePorts } from './transport.js';
import { SimulatedTransport } from './simulator.js';
import { Controller } from './controller.js';
import { History } from './history.js';
import { loadConfig, writeJson } from './store.js';
import { isQueryCommand } from './protocol.js';
import { Sessions, hashPin, checkPin, validPin, readCookie } from './auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COOKIE = 'tollpower_session';

function version() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  let commit = '';
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    /* not a git checkout */
  }
  return { version: pkg.version, commit };
}

export function createApp({ dataDir = path.join(ROOT, 'data'), clock } = {}) {
  const configFile = path.join(dataDir, 'config.json');
  let config = loadConfig(configFile);
  const saveConfig = (c) => {
    config = c;
    writeJson(configFile, c);
  };

  const makeTransport = (c) => {
    if (c.demo) return new SimulatedTransport();
    return new DeviceTransport({ port: c.port === 'auto' ? autoDetectPort() : c.port });
  };

  const inverter = new Inverter(makeTransport(config));
  // Demo readings are kept in a separate file so they never mix with real history.
  const historyFor = (c) => new History(path.join(dataDir, c.demo ? 'history-demo.json' : 'history.json'));
  const controller = new Controller({ inverter, history: historyFor(config), getConfig: () => config, saveConfig, clock });
  const sessions = new Sessions();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  // ---- Family (no PIN) ----------------------------------------------------

  app.get('/api/status', (_req, res) => res.json(controller.snapshot()));

  app.post('/api/mode', async (req, res) => {
    try {
      await controller.setMode(req.body?.mode);
      res.json(controller.snapshot());
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/history', (_req, res) => {
    res.json({ today: controller.history.todayHours(), days: controller.history.lastDays(30) });
  });

  app.get('/api/history.csv', (_req, res) => {
    res.type('text/csv').attachment('tollpower-history.csv').send(controller.history.toCsv());
  });

  // ---- Installer login ----------------------------------------------------

  const loggedIn = (req) => sessions.valid(readCookie(req, COOKIE));
  const setCookie = (res, token) => {
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${12 * 3600}`);
  };

  app.get('/api/auth', (req, res) => res.json({ pinSet: !!config.pinHash, loggedIn: loggedIn(req) }));

  app.post('/api/login', (req, res) => {
    const locked = sessions.lockMessage();
    if (locked) return res.status(429).json({ error: locked });
    if (!checkPin(req.body?.pin ?? '', config.pinHash)) {
      sessions.recordFailure();
      return res.status(401).json({ error: 'Wrong PIN' });
    }
    sessions.recordSuccess();
    setCookie(res, sessions.create());
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    sessions.destroy(readCookie(req, COOKIE));
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  // First-time setup (no PIN yet), or change PIN when logged in.
  app.post('/api/pin', (req, res) => {
    const { newPin } = req.body || {};
    if (config.pinHash && !loggedIn(req)) return res.status(401).json({ error: 'Log in first' });
    if (!validPin(newPin)) return res.status(400).json({ error: 'PIN must be 4 to 8 digits' });
    saveConfig({ ...config, pinHash: hashPin(newPin) });
    sessions.destroyAll();
    setCookie(res, sessions.create());
    res.json({ ok: true });
  });

  // ---- Installer (PIN required) ------------------------------------------

  const installer = express.Router();
  installer.use((req, res, next) => (loggedIn(req) ? next() : res.status(401).json({ error: 'Installer PIN required' })));

  installer.get('/details', (_req, res) => res.json({ ...controller.details(), ...version() }));

  installer.get('/config', (_req, res) => {
    const { pinHash, ...safe } = config;
    void pinHash;
    res.json({ ...safe, ports: listCandidatePorts(), detectedPort: autoDetectPort() });
  });

  installer.post('/config', (req, res) => {
    const b = req.body || {};
    const next = structuredClone(config);
    const errors = [];
    const time = /^([01]\d|2[0-3]):[0-5]\d$/;
    const pct = (v) => Number.isInteger(v) && v >= 5 && v <= 100;

    if (b.tariff) {
      const t = b.tariff;
      if (t.name !== undefined) next.tariff.name = String(t.name).slice(0, 40);
      if (t.cheapStart !== undefined) time.test(t.cheapStart) ? (next.tariff.cheapStart = t.cheapStart) : errors.push('Cheap start must be HH:MM');
      if (t.cheapEnd !== undefined) time.test(t.cheapEnd) ? (next.tariff.cheapEnd = t.cheapEnd) : errors.push('Cheap end must be HH:MM');
      for (const k of ['cheapRatePence', 'peakRatePence']) {
        if (t[k] !== undefined) {
          const v = Number(t[k]);
          Number.isFinite(v) && v >= 0 && v < 200 ? (next.tariff[k] = v) : errors.push('Rates must be in pence per kWh');
        }
      }
    }
    if (b.nightChargeTargetSoc !== undefined) pct(b.nightChargeTargetSoc) ? (next.nightChargeTargetSoc = b.nightChargeTargetSoc) : errors.push('Charge target must be 5-100%');
    if (b.lowBatteryWarnSoc !== undefined) pct(b.lowBatteryWarnSoc) ? (next.lowBatteryWarnSoc = b.lowBatteryWarnSoc) : errors.push('Low battery warning must be 5-100%');
    if (b.installerName !== undefined) next.installerName = String(b.installerName).slice(0, 30);
    if (b.port !== undefined) {
      b.port === 'auto' || /^\/dev\/[\w./-]+$/.test(b.port) ? (next.port = b.port) : errors.push('Port must be "auto" or a /dev path');
    }
    if (b.demo !== undefined) next.demo = !!b.demo;
    if (errors.length) return res.status(400).json({ error: errors.join('. ') });

    const linkChanged = next.demo !== config.demo || next.port !== config.port;
    saveConfig(next);
    if (linkChanged) {
      inverter.setTransport(makeTransport(next));
      controller.liveAt = null;
      controller.settings = null;
      controller.history.save();
      controller.history = historyFor(next);
    }
    res.json({ ok: true });
  });

  // Diagnostics console: read-only queries only.
  installer.post('/query', async (req, res) => {
    const cmd = String(req.body?.command || '').trim().toUpperCase();
    if (!isQueryCommand(cmd)) return res.status(400).json({ error: 'Only read-only Q commands (e.g. QPIGS) are allowed here' });
    try {
      res.json({ command: cmd, reply: await inverter.send(cmd) });
    } catch (err) {
      res.json({ command: cmd, error: err.message });
    }
  });

  installer.post('/update', (_req, res) => {
    const log = fs.openSync(path.join(dataDir, 'update.log'), 'w');
    const child = spawn('bash', [path.join(ROOT, 'scripts', 'update.sh')], { cwd: ROOT, detached: true, stdio: ['ignore', log, log] });
    child.unref();
    res.json({ ok: true, message: 'Update started. The page will reconnect in a minute or two.' });
  });

  installer.get('/update-log', (_req, res) => {
    try {
      res.type('text/plain').send(fs.readFileSync(path.join(dataDir, 'update.log'), 'utf8'));
    } catch {
      res.type('text/plain').send('No update has been run yet.');
    }
  });

  app.use('/api/installer', installer);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

  return { app, controller };
}
