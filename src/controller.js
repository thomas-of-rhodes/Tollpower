// The brain: polls the inverter, keeps its settings matching the chosen mode,
// records history and turns problems into plain-English alerts.

import {
  parseQPIGS, parseQPIRI, parseQMOD, parseQPIWS,
  setOutputPriorityCommand, setChargerPriorityCommand,
} from './protocol.js';
import { desiredSettings, inCheapWindow, MODES } from './modes.js';

const OFFLINE_AFTER_MS = 30_000;
const POLL_MS = 5_000;

// What the family should do about each warning.
const ADVICE = {
  'Overload': 'Too much is switched on. Turn off a big appliance (oven, kettle, heater).',
  'Battery low': 'The battery is nearly empty. Avoid big appliances until the sun is out or the grid takes over.',
  'Battery shut down: too low': 'The battery is empty. The house will use the grid if it is available.',
  'Inverter overheating': 'Check nothing is blocking the inverter vents.',
  'Cooling fan stuck': 'Check nothing is blocking the inverter fan.',
  'Grid power lost': 'There is a power cut. The house is running on solar and battery.',
};

export class Controller {
  constructor({ inverter, history, getConfig, saveConfig, clock = () => new Date() }) {
    this.inverter = inverter;
    this.history = history;
    this.getConfig = getConfig;
    this.saveConfig = saveConfig;
    this.clock = clock;

    this.live = null; // last QPIGS
    this.liveAt = null;
    this.mode = null; // last QMOD
    this.settings = null; // last QPIRI
    this.warnings = [];
    this.desired = null;
    this.settingError = null;
    this.unsupported = new Set(); // e.g. 'OSO' on models with 3 charger options
    this.gridCharging = false;
    this.events = [];
    this.activeAlertKeys = new Map();
    this.enforcing = null;
    this.tick = 0;
    this.timer = null;
    this.lastWriteAt = 0;
  }

  start() {
    const loop = async () => {
      await this.poll().catch((err) => console.error('Poll failed:', err.message));
      this.timer = setTimeout(loop, POLL_MS);
    };
    loop();
    this.saveTimer = setInterval(() => this.history.save(), 5 * 60_000);
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.saveTimer);
    this.history.save();
  }

  async poll() {
    const n = this.tick++;
    try {
      const live = parseQPIGS(await this.inverter.send('QPIGS'));
      this.live = live;
      this.liveAt = this.clock();
      this.mode = parseQMOD(await this.inverter.send('QMOD'));
      if (n % 3 === 0) this.warnings = parseQPIWS(await this.inverter.send('QPIWS'));
      if (n % 12 === 0 || !this.settings) this.settings = parseQPIRI(await this.inverter.send('QPIRI'));

      const flow = this.powerFlow();
      this.history.add({ at: this.liveAt, solarW: flow.solarW, loadW: flow.loadW, gridW: flow.gridW }, this.getConfig().tariff);
      await this.enforceMode();
    } catch (err) {
      if (!this.isOnline()) this.history.breakSeries();
      throw err;
    } finally {
      this.updateAlerts();
    }
  }

  isOnline() {
    return this.liveAt !== null && this.clock() - this.liveAt < OFFLINE_AFTER_MS;
  }

  /** Make the inverter's settings match the chosen mode, and check they stuck. */
  enforceMode() {
    // Only one enforcement at a time (the poll loop and a button press can overlap).
    if (!this.enforcing) {
      this.enforcing = this.#enforce().finally(() => {
        this.enforcing = null;
      });
    }
    return this.enforcing;
  }

  async #enforce() {
    const cfg = this.getConfig();
    const want = desiredSettings({
      mode: cfg.mode,
      date: this.clock(),
      tariff: cfg.tariff,
      soc: this.live?.batterySoc ?? null,
      target: cfg.nightChargeTargetSoc,
      wasGridCharging: this.gridCharging,
    });
    // Models with only three charger options have no "only solar"; use "solar first".
    if (want.chargerPriority === 'OSO' && this.unsupported.has('OSO')) want.chargerPriority = 'SOL';
    this.desired = want;
    this.gridCharging = want.chargerPriority === 'SNU';
    if (!this.settings) return;

    const changes = [];
    if (this.settings.outputPriority !== want.outputPriority) changes.push(['output', want.outputPriority]);
    if (this.settings.chargerPriority !== want.chargerPriority) changes.push(['charger', want.chargerPriority]);
    if (changes.length === 0) {
      this.settingError = null;
      return;
    }
    // Don't hammer the inverter's memory if something keeps failing.
    if (this.settingError && this.clock() - this.lastWriteAt < 5 * 60_000) return;
    this.lastWriteAt = this.clock().getTime();

    try {
      for (const [kind, value] of changes) {
        const cmd = kind === 'output' ? setOutputPriorityCommand(value) : setChargerPriorityCommand(value);
        try {
          await this.inverter.set(cmd);
        } catch (err) {
          if (kind === 'charger' && value === 'OSO' && /refused/.test(err.message)) {
            this.unsupported.add('OSO');
            await this.inverter.set(setChargerPriorityCommand('SOL'));
          } else {
            throw err;
          }
        }
      }
      // Read back to confirm the inverter really changed.
      this.settings = parseQPIRI(await this.inverter.send('QPIRI'));
      const final = { ...want };
      if (final.chargerPriority === 'OSO' && this.unsupported.has('OSO')) final.chargerPriority = 'SOL';
      if (this.settings.outputPriority !== final.outputPriority || this.settings.chargerPriority !== final.chargerPriority) {
        throw new Error('The inverter accepted the change but is still reporting the old setting');
      }
      this.settingError = null;
      this.logEvent('info', `Inverter set for: ${want.reason}`);
    } catch (err) {
      this.settingError = err.message;
      this.logEvent('warning', `Could not change inverter setting: ${err.message}`);
    }
  }

  /** Approximate power flows in watts. Grid is estimated (PI30 has no grid meter). */
  powerFlow() {
    const l = this.live;
    if (!l) return { solarW: 0, loadW: 0, batteryW: 0, gridW: 0 };
    const batteryW = Math.round((l.batteryVolts || 0) * ((l.batteryChargeAmps || 0) - (l.batteryDischargeAmps || 0)));
    const solarW = l.pvWatts || 0;
    const loadW = l.outWatts || 0;
    let gridW = 0;
    if (this.mode?.code === 'L') {
      gridW = loadW;
      if (l.chargingFromGrid && batteryW > 0) gridW += Math.max(0, batteryW - solarW);
    }
    return { solarW, loadW, batteryW, gridW };
  }

  /** Everything the web page needs, in one object. */
  snapshot() {
    const cfg = this.getConfig();
    const online = this.isOnline();
    const flow = this.powerFlow();
    return {
      demo: cfg.demo,
      online,
      updatedAt: this.liveAt?.toISOString() ?? null,
      mode: cfg.mode,
      modes: MODES,
      cheapNow: inCheapWindow(this.clock(), cfg.tariff),
      tariff: cfg.tariff,
      nightChargeTargetSoc: cfg.nightChargeTargetSoc,
      plan: this.desired?.reason ?? null,
      status: this.status(),
      alerts: this.currentAlerts(),
      battery: online ? { soc: this.live.batterySoc, volts: this.live.batteryVolts, watts: flow.batteryW } : null,
      flow: online ? flow : null,
      inverterMode: online ? this.mode?.label : null,
      today: this.history.today(this.clock()),
    };
  }

  /** Detailed readings for the installer screen. */
  details() {
    return {
      live: this.live,
      liveAt: this.liveAt,
      mode: this.mode,
      settings: this.settings,
      desired: this.desired,
      warnings: this.warnings,
      settingError: this.settingError,
      unsupported: [...this.unsupported],
      link: { describe: this.inverter.transport.describe(), ...this.inverter.stats },
      log: this.inverter.log.slice(0, 40),
      events: this.events.slice(0, 50),
    };
  }

  currentAlerts() {
    const cfg = this.getConfig();
    const who = cfg.installerName ? `Call ${cfg.installerName}.` : 'Check the inverter.';
    const alerts = [];
    if (cfg.demo) {
      alerts.push({ key: 'demo', level: 'warning', title: 'Demo mode: these are not real readings', advice: 'Turn off demo mode in Installer settings.' });
    }
    if (!this.isOnline()) {
      alerts.push({
        key: 'offline', level: 'problem', title: "Can't talk to the inverter",
        advice: `The readings below are not live. Check the USB cable between the Pi and the inverter. ${who}`,
      });
      return alerts;
    }
    if (this.mode?.code === 'F') {
      alerts.push({ key: 'fault', level: 'problem', title: 'The inverter has stopped with a fault', advice: who });
    }
    for (const w of this.warnings) {
      alerts.push({
        key: w.code, level: w.level === 'fault' ? 'problem' : 'attention', title: w.text,
        advice: ADVICE[w.text] || who,
      });
    }
    const soc = this.live?.batterySoc;
    if (soc !== null && soc !== undefined && soc <= cfg.lowBatteryWarnSoc && !this.warnings.some((w) => w.text === 'Battery low')) {
      alerts.push({ key: 'lowsoc', level: 'attention', title: `Battery is low (${soc}%)`, advice: ADVICE['Battery low'] });
    }
    if (this.settingError) {
      alerts.push({ key: 'setting', level: 'attention', title: "The inverter didn't accept the mode change", advice: `It will keep trying. ${who}` });
    }
    return alerts;
  }

  status() {
    const alerts = this.currentAlerts().filter((a) => a.key !== 'demo');
    if (alerts.some((a) => a.level === 'problem')) return { level: 'problem', headline: alerts.find((a) => a.level === 'problem').title };
    if (alerts.length) return { level: 'attention', headline: alerts[0].title };
    const f = this.powerFlow();
    let headline = 'All good';
    if (this.mode?.code === 'L') headline = f.batteryW > 50 ? 'All good: on grid power, charging the battery' : 'All good: running on grid power';
    else if (f.solarW > f.loadW) headline = 'All good: solar is powering the house';
    else if (f.solarW > 50) headline = 'All good: running on solar and battery';
    else headline = 'All good: running on the battery';
    return { level: 'ok', headline };
  }

  updateAlerts() {
    const now = new Map();
    for (const a of this.currentAlerts()) {
      now.set(a.key, a.title);
      if (!this.activeAlertKeys.has(a.key)) this.logEvent(a.level === 'problem' ? 'problem' : 'warning', a.title);
    }
    for (const [k, title] of this.activeAlertKeys) {
      if (!now.has(k)) this.logEvent('info', k === 'offline' ? 'Inverter connection restored' : `Cleared: ${title}`);
    }
    this.activeAlertKeys = now;
  }

  logEvent(level, text) {
    this.events.unshift({ at: this.clock().toISOString(), level, text });
    if (this.events.length > 200) this.events.length = 200;
  }

  async setMode(mode) {
    if (!MODES[mode]) throw new Error(`Unknown mode ${mode}`);
    const cfg = this.getConfig();
    cfg.mode = mode;
    this.saveConfig(cfg);
    this.settingError = null;
    this.logEvent('info', `Mode changed to "${MODES[mode].label}"`);
    await this.enforcing; // let any in-flight change finish, then apply the new mode
    await this.enforceMode();
  }
}
