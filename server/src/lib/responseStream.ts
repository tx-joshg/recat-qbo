// Streams an async body into an HTTP response with backpressure, stopping as
// soon as the client goes away.
//
// Waiting on 'drain' alone is not enough: when the client disconnects while
// the socket buffer is full, 'drain' never fires, so the handler — and the
// upstream body it is reading (a QuickBooks download, a database blob, an
// archive) — would stay open forever. Leaving the for-await loop early calls
// the iterator's return(), which closes that upstream.

import type { Response } from 'express';

function drainOrClose(res: Response): Promise<boolean> {
  if (res.destroyed) return Promise.resolve(false);
  return new Promise((resolve) => {
    const settle = (drained: boolean) => () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      resolve(drained);
    };
    const onDrain = settle(true);
    const onClose = settle(false);
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

/**
 * Writes every chunk of `body` to `res`. Resolves true once the body is fully
 * written (and the response ended, when `end` is set), or false if the client
 * disconnected first.
 */
export async function streamToResponse(
  body: AsyncIterable<Uint8Array>,
  res: Response,
  end = true,
): Promise<boolean> {
  for await (const chunk of body) {
    if (res.destroyed) return false;
    if (!res.write(chunk) && !(await drainOrClose(res))) return false;
  }
  if (res.destroyed) return false;
  if (end) res.end();
  return true;
}
