/**
 * A webhook receiver of the test's own: it answers 200 and keeps what it was sent, raw, so a
 * test can check the signature. It listens on E2E_HOOK_PORT when set, else on a port the system
 * picks.
 */
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Delivery {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export async function startReceiver() {
  const received: Delivery[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      received.push({ path: req.url ?? '/', headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(process.env.E2E_HOOK_PORT ?? 0), '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
