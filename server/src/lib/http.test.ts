import { describe, expect, it, vi } from 'vitest';
import { HttpError, errorMiddleware } from './http.js';

function fakeResponse(headersSent: boolean) {
  const res = {
    headersSent,
    status: vi.fn(),
    json: vi.fn(),
    destroy: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

describe('errorMiddleware', () => {
  it('sends the HttpError status before the response has started', () => {
    const res = fakeResponse(false);
    errorMiddleware(new HttpError(404, 'Missing', 'NOT_FOUND'), {} as never, res as never, vi.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Missing', code: 'NOT_FOUND' });
  });

  it('destroys a response that already started streaming', () => {
    const res = fakeResponse(true);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      errorMiddleware(new Error('blob is gone'), {} as never, res as never, vi.fn());
    } finally {
      log.mockRestore();
    }
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(res.destroy).toHaveBeenCalled();
  });
});
