import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The same check the updater does before switching over: the real entry
// point starts and answers.
test('server.js starts in demo mode and answers /api/status', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tollpower-start-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, DEMO: '1', PORT: String(port), TOLLPOWER_DATA: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (c) => (output += c));
  child.stderr.on('data', (c) => (output += c));
  try {
    let status = null;
    for (let i = 0; i < 50 && status === null && child.exitCode === null; i++) {
      await new Promise((r) => setTimeout(r, 200));
      status = await fetch(`http://127.0.0.1:${port}/api/status`).then((r) => r.json(), () => null);
    }
    assert.ok(status, `server did not answer. Output:\n${output}`);
    assert.equal(status.demo, true);
  } finally {
    child.kill();
  }
});
