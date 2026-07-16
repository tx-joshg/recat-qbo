// Date/time formatters for the Settings screen, matching the prototype's copy:
// "4 min ago", "Today, 8:14 AM", "Yesterday, 6:40 PM", "connected Mar 3, 2026".

/** 'Mar 3, 2026' — the connection card's "connected" date. */
export function fmtLongDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Relative-or-clock timestamp: 'just now' / '4 min ago' / 'Today, 8:14 AM' / 'Yesterday, 6:40 PM' / 'Mar 3, 8:14 AM'. */
export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMin = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (dayDiff === 0) return `Today, ${time}`;
  if (dayDiff === 1) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
}

/** Holding-account row count label: 'empty' / '1 transaction' / 'N transactions'. */
export function fmtTxnCount(count: number): string {
  if (count === 0) return 'empty';
  if (count === 1) return '1 transaction';
  return `${count} transactions`;
}

/** Human-readable message for a failed API call, for the toast. */
export function errMsg(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Request failed';
}
