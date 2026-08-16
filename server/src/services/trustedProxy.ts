export type TrustProxyCallback = (ip: string, hop: number) => boolean;

function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  return trimmed.toLowerCase().startsWith('::ffff:') ? trimmed.slice('::ffff:'.length) : trimmed;
}

/** Rejects CIDR, empty and malformed entries — see hasUsableTrustedProxy. */
function isIpAddress(value: string): boolean {
  if (value === '' || value.includes('/')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return value.split('.').every((part) => Number(part) <= 255);
  }
  return value.includes(':') && /^[0-9a-f:.]+$/i.test(value);
}

/**
 * Addresses only reachable from inside the host or its container networks.
 * A peer outside these ranges reached us directly rather than through the
 * reverse proxy we were told to expect, so its forwarded headers are its own
 * claim about itself and must not be believed.
 */
export function isPrivateAddress(ip: string): boolean {
  const addr = normalizeIp(ip).toLowerCase();
  if (addr === '::1' || addr === 'localhost') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) {
    const [a = 0, b = 0] = addr.split('.').map(Number);
    if (a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local
    return false;
  }
  // Unique-local (fc00::/7) and link-local (fe80::/10).
  return /^f[cd]/.test(addr) || /^fe[89ab]/.test(addr);
}

/**
 * `trustHop` trusts the immediate peer as a reverse proxy — but only when that
 * peer is on a private network. It is for deployments where the app's port is
 * not published and the only route in is a proxy on a container network, which
 * is exactly the Umbrel package: its compose declares no `ports:` for the
 * server, so `app_proxy` is the sole path to it.
 *
 * The private-address requirement is what keeps this safe if that ever stops
 * being true. Should the port become directly reachable, a public client's
 * forwarded headers are ignored and it is rate-limited on its own real address
 * instead — the failure mode degrades to the old behaviour rather than to
 * trusting a stranger's claim about who they are.
 */
export function compileTrustedProxy(setting: string, trustHop = false): TrustProxyCallback {
  const trusted = new Set(
    setting
      .split(',')
      .map(normalizeIp)
      .filter((ip) => ip !== ''),
  );
  return (ip, hop) => {
    if (hop !== 0) return false;
    if (trusted.has(normalizeIp(ip))) return true;
    return trustHop && isPrivateAddress(ip);
  };
}

/**
 * Whether this configuration actually yields a per-client `req.ip`.
 *
 * Rate limiters key on that address, and a lockout is only safe to make long
 * when the key identifies one client (#57). A setting that looks configured but
 * matches nothing — a CIDR, a stray comma, a typo — leaves every caller behind
 * a proxy sharing the proxy's address, so it must count as untrusted here.
 */
export function hasUsableTrustedProxy(setting: string, trustHop = false): boolean {
  if (trustHop) return true;
  return setting.split(',').map(normalizeIp).some(isIpAddress);
}
