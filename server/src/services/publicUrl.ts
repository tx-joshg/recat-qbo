import { env } from '../env.js';
import { getInstanceSettings } from './instanceSettings.js';

/**
 * Resolves the deployment's public address.
 *
 * The value is configurable because Intuit rejects non-HTTPS redirect URIs for
 * production apps, and packaged deployments (Umbrel and similar) cannot know
 * the address their users will reach them on. It is read on every mutating
 * request through allowedOrigins(), so it is cached rather than fetched:
 * getInstanceSettings() is uncached and would otherwise add a database round
 * trip to every write.
 */

const CACHE_TTL_MS = 60_000;

interface CachedPublicUrl {
  appUrl: string;
  at: number;
}

let cached: CachedPublicUrl | null = null;

/** Drop the cache so the next read picks up a newly saved address. */
export function invalidatePublicUrl(): void {
  cached = null;
}

async function load(): Promise<string> {
  if (cached !== null && Date.now() - cached.at < CACHE_TTL_MS) return cached.appUrl;
  try {
    const { appUrl } = await getInstanceSettings();
    cached = { appUrl, at: Date.now() };
    return appUrl;
  } catch {
    // A database blip must not take down origin checking, which would reject
    // every write. Fall back to the environment value and retry next call.
    return env.APP_URL;
  }
}


/** Public base URL, without a trailing slash. Use for anything user-facing. */
export async function resolvePublicUrl(): Promise<string> {
  return (await load()).replace(/\/+$/, '');
}

/** OAuth callback registered with Intuit — the wizard shows this exact URL. */
export async function resolveRedirectUri(): Promise<string> {
  return `${await resolvePublicUrl()}/auth/qbo/callback`;
}

/** Webhook endpoint registered with Intuit — shown on the wizard's Sync step. */
export async function resolveWebhookUrl(): Promise<string> {
  return `${await resolvePublicUrl()}/webhooks/qbo`;
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Origins accepted by the CSRF check.
 *
 * Always includes the environment's own APP_URL and the address in use before
 * the last change, alongside the configured one. A misconfigured public URL
 * must not be able to lock an operator out: without those, saving a wrong value
 * would reject every subsequent mutating request — including the one needed to
 * correct it. The environment origin alone is not enough, because an operator
 * on a packaged install may only ever reach the instance through the address
 * they configured.
 */
export async function allowedOrigins(): Promise<ReadonlySet<string>> {
  const origins = new Set<string>();
  let previous = '';
  try {
    previous = (await getInstanceSettings()).previousAppUrl;
  } catch {
    // Settings unavailable — the environment origin below still applies.
  }
  for (const candidate of [env.APP_URL, await resolvePublicUrl(), previous]) {
    if (candidate === '') continue;
    const origin = originOf(candidate);
    // Keep unparseable values verbatim so a hand-written APP_URL still matches
    // itself, mirroring what the previous inline check did.
    origins.add(origin ?? candidate);
  }
  return origins;
}
