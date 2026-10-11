import { buildApp } from './app.js';
import { valid } from '../contracts/validation.js';
const mode = process.env.AUTO_IN_MODE ?? 'simulation';
if (!valid('Mode', mode)) throw new Error('Invalid AUTO_IN_MODE');
const portText = process.env.PORT ?? '3000';
if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new Error('Invalid PORT');
const app = buildApp({ mode });
try {
  await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(portText) });
  console.info(`AUTO-IN listening in ${mode} mode`);
} catch {
  console.error('AUTO-IN startup failed');
  process.exitCode = 1;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
