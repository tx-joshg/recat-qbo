export type TrustProxyCallback = (ip: string, hop: number) => boolean;

function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  return trimmed.toLowerCase().startsWith('::ffff:') ? trimmed.slice('::ffff:'.length) : trimmed;
}

export function compileTrustedProxy(setting: string): TrustProxyCallback {
  const trusted = new Set(
    setting
      .split(',')
      .map(normalizeIp)
      .filter((ip) => ip !== ''),
  );
  return (ip, hop) => hop === 0 && trusted.has(normalizeIp(ip));
}
