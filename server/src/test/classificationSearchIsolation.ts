import { createRequire, syncBuiltinESMExports } from 'node:module';
import type { ClientRequest } from 'node:http';
import { qboFactory } from '../lib/qbo/factory.js';
import { MockQboClient } from '../lib/qbo/mock.js';
import { RealQboClient } from '../lib/qbo/real.js';

type NetworkKind = 'fetch' | 'http' | 'https';
type RequestFunction = (...args: unknown[]) => ClientRequest;
type MutableModule = {
  request: RequestFunction;
  get: RequestFunction;
};

export interface ClassificationSearchIsolationCounts {
  qboFactory: number;
  qboMutations: Record<string, number>;
  network: Record<NetworkKind, number>;
}

export interface ClassificationSearchIsolation {
  counts(): ClassificationSearchIsolationCounts;
  reset(): void;
  restore(): void;
}

const MUTATING_QBO_METHODS = [
  'uploadAttachments',
  'deleteAttachment',
  'sendPreparedWrite',
  'sendPreparedLineWrite',
  'recategorize',
  'moveToAccount',
  'createTransfer',
] as const;
const QBO_FACTORY_METHODS = ['authorizeUrl', 'exchangeCode', 'forCompany'] as const;
const QBO_CLIENT_PROTOTYPES = [
  ['RealQboClient', RealQboClient.prototype],
  ['MockQboClient', MockQboClient.prototype],
] as const;

function zeroQboMutationCounts(): Record<string, number> {
  return Object.fromEntries(QBO_CLIENT_PROTOTYPES.flatMap(([clientName]) => (
    MUTATING_QBO_METHODS.map((methodName) => [`${clientName}.${methodName}`, 0] as const)
  )));
}

function requestOrigin(kind: Exclude<NetworkKind, 'fetch'>, args: unknown[]): string | null {
  try {
    const first = args[0];
    const base = typeof first === 'string' || first instanceof URL ? new URL(first) : null;
    const candidate = base === null ? first : args[1];
    const options = candidate !== null && typeof candidate === 'object'
      ? candidate as Record<string, unknown> : {};
    // Custom transports can ignore the URL entirely. The deterministic fixture
    // needs only standard TCP requests to one explicit loopback origin.
    if (options.socketPath !== undefined || options.createConnection !== undefined
      || (options.agent !== undefined && options.agent !== false)) return null;
    const protocol = options.protocol ?? base?.protocol ?? `${kind}:`;
    const hostname = options.hostname ?? options.host ?? base?.hostname;
    const port = options.port ?? base?.port;
    if (typeof protocol !== 'string' || typeof hostname !== 'string') return null;
    if (port !== undefined && typeof port !== 'string' && typeof port !== 'number') return null;
    return new URL(`${protocol}//${hostname}${port === undefined || port === '' ? '' : `:${port}`}`).origin;
  } catch {
    return null;
  }
}

function fetchOrigin(input: Parameters<typeof fetch>[0]): string | null {
  try {
    if (typeof input === 'string' || input instanceof URL) return new URL(input).origin;
    return new URL(input.url).origin;
  } catch {
    return null;
  }
}

/** Test-only fail-closed instrumentation around the real accounting and HTTP boundaries. */
export function installClassificationSearchIsolation(allowedOrigin: string): ClassificationSearchIsolation {
  const allowed = new URL(allowedOrigin);
  if (allowed.protocol !== 'http:' || allowed.hostname !== '127.0.0.1' || allowed.origin !== allowedOrigin) {
    throw new Error('Classification search test safety guards require one exact loopback HTTP origin.');
  }
  let restored = false;
  let qboFactoryCalls = 0;
  let qboMutations = zeroQboMutationCounts();
  let network: Record<NetworkKind, number> = { fetch: 0, http: 0, https: 0 };
  const restorers: Array<() => void> = [];

  for (const [clientName, prototype] of QBO_CLIENT_PROTOTYPES) {
    for (const methodName of MUTATING_QBO_METHODS) {
      if (typeof (prototype as unknown as Record<string, unknown>)[methodName] !== 'function') {
        throw new Error(`Classification search test safety guard cannot find ${clientName}.${methodName}.`);
      }
    }
  }

  const mutableFactory = qboFactory as unknown as Record<string, unknown>;
  for (const methodName of QBO_FACTORY_METHODS) {
    const original = mutableFactory[methodName];
    mutableFactory[methodName] = async () => {
      qboFactoryCalls += 1;
      throw new Error(`classification-search-test-unexpected-qbo-factory-call:${methodName}`);
    };
    restorers.push(() => { mutableFactory[methodName] = original; });
  }

  for (const [clientName, prototype] of QBO_CLIENT_PROTOTYPES) {
    const mutablePrototype = prototype as unknown as Record<string, unknown>;
    for (const methodName of MUTATING_QBO_METHODS) {
      const original = mutablePrototype[methodName];
      mutablePrototype[methodName] = async () => {
        const key = `${clientName}.${methodName}`;
        qboMutations[key] = (qboMutations[key] ?? 0) + 1;
        throw new Error(`classification-search-test-unexpected-qbo-mutation:${key}`);
      };
      restorers.push(() => { mutablePrototype[methodName] = original; });
    }
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    if (fetchOrigin(input) !== allowed.origin) {
      network.fetch += 1;
      throw new Error('classification-search-test-unexpected-network:fetch');
    }
    return originalFetch(input, { ...init, redirect: 'error' });
  }) as typeof fetch;
  restorers.push(() => { globalThis.fetch = originalFetch; });

  const require = createRequire(import.meta.url);
  const modules = {
    http: require('node:http') as MutableModule,
    https: require('node:https') as MutableModule,
  };
  for (const kind of ['http', 'https'] as const) {
    const module = modules[kind];
    const originalRequest = module.request;
    const originalGet = module.get;
    const guarded = (original: RequestFunction): RequestFunction => (...args) => {
      if (requestOrigin(kind, args) !== allowed.origin) {
        network[kind] += 1;
        throw new Error(`classification-search-test-unexpected-network:${kind}`);
      }
      return original(...args);
    };
    module.request = guarded(originalRequest);
    module.get = guarded(originalGet);
    restorers.push(() => {
      module.request = originalRequest;
      module.get = originalGet;
    });
  }
  syncBuiltinESMExports();

  return {
    counts: () => ({
      qboFactory: qboFactoryCalls,
      qboMutations: { ...qboMutations },
      network: { ...network },
    }),
    reset() {
      qboFactoryCalls = 0;
      qboMutations = zeroQboMutationCounts();
      network = { fetch: 0, http: 0, https: 0 };
    },
    restore() {
      if (restored) return;
      restored = true;
      for (const restore of restorers.reverse()) restore();
      syncBuiltinESMExports();
    },
  };
}
