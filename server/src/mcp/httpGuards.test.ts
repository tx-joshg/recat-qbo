import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  createMcpHttpGuards,
  isAllowedMcpHost,
  isAllowedMcpOrigin,
  isMcpJsonContentType,
} from './httpGuards.js';

describe('MCP HTTP guards', () => {
  it('admits the configured public origin without dropping the boot-time one', async () => {
    // #40: appUrl is only the deployment's starting address now. /mcp must
    // follow the address an operator configures, while the original keeps
    // working so a misconfiguration cannot sever a client that works today.
    const app = express();
    app.use(
      '/mcp',
      ...createMcpHttpGuards({
        appUrl: 'https://recat.example',
        resolveExtraOrigins: async () => ['https://recat.tail1234.ts.net'],
        maxBodyBytes: 64,
      }),
    );
    app.use(express.json({ limit: '1kb' }));
    app.post('/mcp', (_req, res) => res.status(204).end());

    await request(app).post('/mcp').set('Host', 'recat.tail1234.ts.net')
      .set('Origin', 'https://recat.tail1234.ts.net').send({}).expect(204);
    await request(app).post('/mcp').set('Host', 'recat.example').send({}).expect(204);
    await request(app).post('/mcp').set('Host', 'evil.example').send({}).expect(421);
    await request(app).post('/mcp').set('Host', 'recat.example')
      .set('Origin', 'https://evil.example').send({}).expect(403);
  });

  it('keeps serving the boot-time origin when the resolver fails', async () => {
    const app = express();
    app.use(
      '/mcp',
      ...createMcpHttpGuards({
        appUrl: 'https://recat.example',
        resolveExtraOrigins: async () => { throw new Error('settings unavailable'); },
        maxBodyBytes: 64,
      }),
    );
    app.use(express.json({ limit: '1kb' }));
    app.post('/mcp', (_req, res) => res.status(204).end());

    await request(app).post('/mcp').set('Host', 'recat.example').send({}).expect(204);
  });

  it('allows only the configured deployment hostname and rejects DNS-rebinding hosts', () => {
    expect(isAllowedMcpHost('recat.example:443', 'https://recat.example')).toBe(true);
    expect(isAllowedMcpHost('recat.example', 'https://recat.example')).toBe(true);
    expect(isAllowedMcpHost('evil.example', 'https://recat.example')).toBe(false);
    expect(isAllowedMcpHost(undefined, 'https://recat.example')).toBe(false);
    expect(isAllowedMcpHost('recat.example.evil.example', 'https://recat.example')).toBe(false);
    expect(isAllowedMcpHost(
      'localhost:3001',
      'http://localhost:5173',
      ['localhost:3001'],
    )).toBe(true);
  });

  it('accepts absent Origin only for non-browser clients and exact configured browser origin', () => {
    expect(isAllowedMcpOrigin(undefined, 'https://recat.example')).toBe(true);
    expect(isAllowedMcpOrigin('https://recat.example', 'https://recat.example')).toBe(true);
    expect(isAllowedMcpOrigin('https://recat.example:444', 'https://recat.example')).toBe(false);
    expect(isAllowedMcpOrigin('null', 'https://recat.example')).toBe(false);
  });

  it('parses JSON media types without accepting lookalikes', () => {
    expect(isMcpJsonContentType('application/json')).toBe(true);
    expect(isMcpJsonContentType('application/json; charset=utf-8')).toBe(true);
    expect(isMcpJsonContentType('Application/JSON ; Charset = UTF-8')).toBe(true);
    expect(isMcpJsonContentType('text/plain')).toBe(false);
    expect(isMcpJsonContentType('application/jsonp')).toBe(false);
    expect(isMcpJsonContentType('application/json; garbage')).toBe(false);
    expect(isMcpJsonContentType('application/json; charset=iso-8859-1')).toBe(false);
    expect(isMcpJsonContentType('application/json; charset=utf-8; charset=utf-8')).toBe(false);
    expect(isMcpJsonContentType('application/json; profile=test')).toBe(false);
    expect(isMcpJsonContentType('application/json;')).toBe(false);
  });

  it('rejects bad host, origin, media type, and oversized bodies before the endpoint', async () => {
    const app = express();
    app.use(
      ...createMcpHttpGuards({
        appUrl: 'https://recat.example',
        maxBodyBytes: 64,
      }),
    );
    app.use(express.json({ limit: '1kb' }));
    app.post('/mcp', (_req, res) => res.status(204).end());

    await request(app).post('/mcp').set('Host', 'evil.example').send({}).expect(421);
    await request(app)
      .post('/mcp')
      .set('Host', 'recat.example')
      .set('Origin', 'https://evil.example')
      .send({})
      .expect(403);
    await request(app)
      .post('/mcp')
      .set('Host', 'recat.example')
      .set('Content-Type', 'text/plain')
      .send('{}')
      .expect(415);
    await request(app)
      .post('/mcp')
      .set('Host', 'recat.example')
      .set('Content-Type', 'application/json')
      .send({ value: 'x'.repeat(100) })
      .expect(413);
  });

  it('allows the documented local MCP server host while retaining the frontend origin check', async () => {
    const app = express();
    app.use(
      ...createMcpHttpGuards({
        appUrl: 'http://localhost:5173',
        additionalHosts: ['localhost:3001'],
        maxBodyBytes: 64 * 1_024,
      }),
    );
    app.post('/mcp', (_req, res) => res.status(204).end());

    await request(app)
      .post('/mcp')
      .set('Host', 'localhost:3001')
      .set('Content-Type', 'application/json')
      .send({})
      .expect(204);
    await request(app)
      .post('/mcp')
      .set('Host', 'localhost:3002')
      .set('Content-Type', 'application/json')
      .send({})
      .expect(421);
  });
});
