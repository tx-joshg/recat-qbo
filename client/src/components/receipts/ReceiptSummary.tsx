import { Select } from '../SelectCombobox';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ReceiptStatsDto } from '@recat/shared';
import { receipts } from '../../lib/api';
import { readPreference, writePreference } from '../../lib/storage';

type Timeframe = '30' | '90' | 'all';

function rangeFor(timeframe: Timeframe): { dateFrom?: string; dateTo?: string } {
  if (timeframe === 'all') return {};
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - Number(timeframe));
  return { dateFrom: start.toISOString(), dateTo: end.toISOString() };
}

function amount(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? parsed.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      })
    : value;
}

interface ReceiptSummaryProps {
  companyId: string;
  refreshKey: number;
  toast(message: string): void;
  uploadSection: ReactNode;
}

export default function ReceiptSummary({
  companyId,
  refreshKey,
  toast,
  uploadSection,
}: ReceiptSummaryProps) {
  const [stats, setStats] = useState<ReceiptStatsDto | null>(null);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);
  const storageKey = `recat_receipt_dashboard_timeframe:${companyId}`;
  const [timeframe, setTimeframe] = useState<Timeframe>(() => {
    const value = readPreference(storageKey);
    return value === '90' || value === 'all' ? value : '30';
  });

  const reload = useCallback(async () => {
    const sequence = ++requestId.current;
    setLoading(true);
    try {
      const result = await receipts.stats(companyId, rangeFor(timeframe));
      if (requestId.current === sequence) setStats(result);
    } catch (error) {
      if (requestId.current === sequence) {
        toast(error instanceof Error ? error.message : 'Could not load receipt totals');
      }
    } finally {
      if (requestId.current === sequence) setLoading(false);
    }
  }, [companyId, timeframe, toast]);

  useEffect(() => {
    setStats(null);
  }, [companyId, timeframe]);

  useEffect(() => {
    requestId.current += 1;
    void reload();
    return () => {
      requestId.current += 1;
    };
  }, [refreshKey, reload]);

  const cards = [
    ['Received', stats?.received ?? '—'],
    ['Needs review', stats?.needsReview ?? '—'],
    ['Queued / processing', stats ? stats.queued + stats.processing : '—'],
    ['Failed', stats?.failed ?? '—'],
  ];

  return (
    <>
      <div className="receipt-toolbar receipt-timeframe-toolbar">
        <Select
          label="Dashboard timeframe"
          value={timeframe}
          onValueChange={(value) => {
            const next = value as Timeframe;
            setTimeframe(next);
            writePreference(storageKey, next);
          }}
          options={[{ value: '30', label: 'Last 30 days' },
            { value: '90', label: 'Last 90 days' },
            { value: 'all', label: 'All time' }]}
        />
      </div>
      <div
        aria-busy={loading}
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))',
          gap: 12,
          margin: '20px 0',
        }}
      >
        {cards.map(([label, value]) => (
          <section key={label} style={{
            border: '1px solid var(--bd2)',
            borderRadius: 10,
            padding: 18,
            background: 'var(--card)',
          }}>
            <div style={{ color: 'var(--mut)', fontSize: 13 }}>{label}</div>
            <div style={{ fontSize: 26, fontWeight: 650, marginTop: 5 }}>{value}</div>
          </section>
        ))}
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))',
        gap: 14,
      }}>
        <section style={{ border: '1px solid var(--bd2)', borderRadius: 10, padding: 18 }}>
          <h2 style={{ fontSize: 16, marginTop: 0 }}>Receipt totals</h2>
          {stats?.totalByCurrency.map((item) => (
            <div key={item.currency}>{item.currency} {amount(item.amount)}</div>
          ))}
          {!stats?.totalByCurrency.length && (
            <div style={{ color: 'var(--mut)' }}>No totals yet.</div>
          )}
        </section>
        <section style={{ border: '1px solid var(--bd2)', borderRadius: 10, padding: 18 }}>
          <h2 style={{ fontSize: 16, marginTop: 0 }}>Tax totals</h2>
          {stats?.totalTaxByCurrency.map((item) => (
            <div key={item.currency}>{item.currency} {amount(item.amount)}</div>
          ))}
          <div style={{ marginTop: 10, color: 'var(--mut)' }}>
            Processing cost: USD {amount(stats?.processingCostUsd ?? '0')}
          </div>
        </section>
      </div>
      {uploadSection}
      <section style={{ marginTop: 20 }}>
        <h2 style={{ fontSize: 17 }}>Recent activity</h2>
        {stats?.recentActivity.map((event) => (
          <div key={event.id} style={{ padding: '7px 0', borderBottom: '1px solid var(--bd)' }}>
            {event.action.replaceAll('_', ' ')} · {new Date(event.createdAt).toLocaleString()}
          </div>
        ))}
        {!stats?.recentActivity.length && (
          <div style={{ color: 'var(--mut)' }}>No recent activity.</div>
        )}
      </section>
    </>
  );
}
