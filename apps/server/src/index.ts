import path from 'node:path';
import { createApp } from './app.js';
import { loadHarnesses } from './runtime/harness/registry.js';
import { loadCredentialFiles } from './runtime/credentials.js';

loadCredentialFiles();

const DEFAULT_PORT = 4318;
const rawPort = process.env.PORT ?? process.env.TEAM_API_PORT ?? String(DEFAULT_PORT);
const port = Number(rawPort);
const host = process.env.TEAM_HOST ?? '127.0.0.1';

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(`Invalid API port: ${rawPort}`);
}
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  throw new Error('The Team service only listens on a loopback host.');
}

const controlToken = process.env.TEAM_CONTROL_TOKEN;
delete process.env.TEAM_CONTROL_TOKEN;
const service = createApp({
  controlToken,
  apiPort: port || DEFAULT_PORT,
  // createApp shares the current frontend with the desktop launcher.
  ...(process.env.TEAM_WEB_DIST ? { webDistDir: path.resolve(process.env.TEAM_WEB_DIST) } : {}),
  harnesses: await loadHarnesses(),
});
const server = service.app.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`Team service listening at http://${host}:${actualPort}`);
  if (!controlToken) console.log(`Open TeamSwarm: http://${host}:${actualPort}/#connect=${service.controlToken}`);
});

let closing = false;
function close(): void {
  if (closing) return;
  closing = true;
  server.close();
  void service.close().then(() => { server.closeAllConnections(); process.exit(0); }, error => { console.error(error instanceof Error ? error.message : 'Shutdown failed.'); process.exit(1); });
}

process.once('SIGINT', close);
process.once('SIGTERM', close);
