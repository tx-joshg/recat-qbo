import { once } from 'node:events';
import { createServer, get, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { installClassificationSearchIsolation } from './classificationSearchIsolation.js';

const servers: Server[] = [];
let restore: (() => void) | undefined;
const userAgent = 'OpenAI File Downloader, XaiImageApiFetch/1.0';
async function listen(server: Server): Promise<string> {
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Synthetic server unavailable');
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  restore?.(); restore = undefined;
  await Promise.all(servers.splice(0).map(async server => {
    const closed = once(server, 'close'); server.closeAllConnections(); server.close(); await closed;
  }));
});

it('denies redirects even when a Request or caller options request following them', async () => {
  let unexpected = 0;
  const other = await listen(createServer((_request, response) => { unexpected += 1; response.end('synthetic'); }));
  const allowed = await listen(createServer((_request, response) => { response.writeHead(302, { location: other }); response.end(); }));
  restore = installClassificationSearchIsolation(allowed).restore;
  await expect(fetch(allowed, { redirect: 'follow', headers: { 'User-Agent': userAgent } })).rejects.toThrow();
  await expect(fetch(new Request(allowed, { redirect: 'follow', headers: { 'User-Agent': userAgent } }))).rejects.toThrow();
  expect(unexpected).toBe(0);
});

it('denies a node HTTP options override of an otherwise allowed URL', async () => {
  let unexpected = 0;
  const other = await listen(createServer((_request, response) => { unexpected += 1; response.end('synthetic'); }));
  const allowed = await listen(createServer((_request, response) => { response.end('allowed'); }));
  restore = installClassificationSearchIsolation(allowed).restore;
  try {
    await new Promise<void>((resolve, reject) => {
      const request = get(allowed, { port: new URL(other).port, headers: { 'User-Agent': userAgent } }, response => {
        response.resume(); response.on('end', resolve);
      });
      request.on('error', reject);
    });
  } catch { /* Rejection is the intended boundary. */ }
  expect(unexpected).toBe(0);
});
