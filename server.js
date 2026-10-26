// Tollpower: starts the web server and the inverter controller.
// Usage: node server.js            (PORT env var, default 80 on the Pi via systemd, 3000 otherwise)
//        DEMO=1 node server.js     (forces demo mode for trying it out on a PC)

import os from 'node:os';
import { createApp } from './src/app.js';
import { loadConfig, writeJson } from './src/store.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = process.env.TOLLPOWER_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
if (process.env.DEMO === '1') {
  const file = path.join(dataDir, 'config.json');
  writeJson(file, { ...loadConfig(file), demo: true });
}

const { app, controller } = createApp({ dataDir });
const port = Number(process.env.PORT || 3000);

const server = app.listen(port, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
  const suffix = port === 80 ? '' : `:${port}`;
  console.log(`Tollpower running. Open http://${os.hostname()}.local${suffix}${ips.length ? ` or http://${ips[0]}${suffix}` : ''}`);
});

controller.start();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    controller.stop(); // saves history
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
