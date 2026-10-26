// One queue for every conversation with the inverter, so two commands can
// never overlap on the wire. Keeps a small log for the diagnostics screen.

import { buildFrame, parseFrame } from './protocol.js';

export class Inverter {
  constructor(transport) {
    this.transport = transport;
    this.queue = Promise.resolve();
    this.stats = { sent: 0, ok: 0, failed: 0, lastOkAt: null, lastError: null };
    this.log = [];
  }

  setTransport(transport) {
    this.transport = transport;
    this.stats = { sent: 0, ok: 0, failed: 0, lastOkAt: null, lastError: null };
  }

  #record(entry) {
    this.log.unshift({ at: new Date().toISOString(), ...entry });
    if (this.log.length > 100) this.log.length = 100;
  }

  /** Send a command and return the reply payload (text after "("). */
  send(command) {
    const run = async () => {
      const frame = buildFrame(command);
      this.stats.sent++;
      const started = Date.now();
      try {
        const raw = await this.transport.exchange(frame);
        const { ok, payload, error } = parseFrame(raw);
        if (!ok) throw new Error(`${error} in reply to ${command}`);
        this.stats.ok++;
        this.stats.lastOkAt = new Date().toISOString();
        this.#record({ command, ok: true, reply: payload, ms: Date.now() - started });
        return payload;
      } catch (err) {
        this.stats.failed++;
        this.stats.lastError = err.message;
        this.#record({ command, ok: false, error: err.message, ms: Date.now() - started });
        throw err;
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {}); // keep the queue alive after failures
    return result;
  }

  /** Send a setting command; resolves only if the inverter answers ACK. */
  async set(command) {
    const reply = await this.send(command);
    if (reply.trim() !== 'ACK') throw new Error(`Inverter refused ${command} (replied "${reply.trim()}")`);
  }
}
