// Formatting helpers matching the prototype's fmt()/money() exactly.

/**
 * Signed money per the prototype's `fmt`: absolute value, 2 decimals, thousands
 * separators, prefixed '+$' when positive, otherwise '−$' (MINUS SIGN U+2212,
 * not a hyphen). Note zero renders as '−$0.00', exactly like the prototype.
 */
export function fmtMoney(a: number): string {
  const s = Math.abs(a).toLocaleString('en-US', { minimumFractionDigits: 2 });
  return (a > 0 ? '+$' : '−$') + s;
}

/**
 * 'Jul 1' for current-year dates, 'Jul 1, 2024' otherwise — older rows always
 * say how far back they are. UTC so date-only ISO strings never shift a day.
 */
export function fmtDate(iso: string): string {
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  if (d.getUTCFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-US', opts);
}

/** 'Jul 1, 2026' — always includes the year (history views). */
export function fmtDateY(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * '$24.6k' — dashboard KPI style, one decimal.
 * Takes DOLLARS (24600 → '$24.6k'). The prototype's `money()` received values
 * already divided by 1000; server dashboard data is in dollars, so we divide here.
 */
export function moneyK(v: number): string {
  return '$' + (v / 1000).toFixed(1) + 'k';
}
