import express from 'express';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { streamToResponse } from './responseStream.js';

describe('streamToResponse', () => {
  it('stops and closes the upstream body when the client disconnects under backpressure', async () => {
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((resolve) => { upstreamClosed = resolve; });
    let handlerResult!: (value: boolean) => void;
    const finished = new Promise<boolean>((resolve) => { handlerResult = resolve; });

    async function* endless(): AsyncGenerator<Uint8Array> {
      try {
        for (;;) yield new Uint8Array(64 * 1024);
      } finally {
        upstreamClosed();
      }
    }

    const app = express();
    app.get('/download', (_req, res) => {
      void streamToResponse(endless(), res).then(handlerResult);
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      await new Promise<void>((resolve) => {
        const req = httpRequest({ host: '127.0.0.1', port, path: '/download' }, (res) => {
          // Read nothing: the server's socket buffer fills and it waits for
          // 'drain', which never comes once we hang up.
          res.pause();
          setTimeout(() => {
            req.destroy();
            resolve();
          }, 100);
        });
        req.on('error', () => undefined);
        req.end();
      });

      await expect(finished).resolves.toBe(false);
      await closed;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('writes the whole body and ends the response', async () => {
    const app = express();
    app.get('/download', (_req, res) => {
      void streamToResponse((async function* () {
        yield new TextEncoder().encode('hello ');
        yield new TextEncoder().encode('world');
      })(), res);
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/download`);
      expect(await response.text()).toBe('hello world');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
