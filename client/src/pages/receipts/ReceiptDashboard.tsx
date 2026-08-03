import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ReceiptStatsDto } from '@recat/shared';
import { receipts } from '../../lib/api';
import ReceiptDropzone from '../../components/receipts/ReceiptDropzone';
import { useApp } from '../../state/AppContext';
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

export default function ReceiptDashboard() {
  const { activeCompanyId, role, toast } = useApp();
  const [stats, setStats] = useState<ReceiptStatsDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const requestId = useRef(0);
  const storageKey = activeCompanyId
    ? `recat_receipt_dashboard_timeframe:${activeCompanyId}`
    : null;
  const [timeframe, setTimeframe] = useState<Timeframe>(() => {
    const value = activeCompanyId
      ? readPreference(`recat_receipt_dashboard_timeframe:${activeCompanyId}`)
      : null;
    return value === '90' || value === 'all' ? value : '30';
  });
  const mutable = role === 'admin' || role === 'categorizer';

  const reload = useCallback(async () => {
    if (!activeCompanyId) return;
    const sequence = ++requestId.current;
    setLoading(true);
    try {
      const result = await receipts.stats(activeCompanyId, rangeFor(timeframe));
      if (requestId.current === sequence) setStats(result);
    } catch (error) {
      if (requestId.current === sequence) {
        toast(error instanceof Error ? error.message : 'Could not load receipt totals');
      }
    } finally {
      if (requestId.current === sequence) setLoading(false);
    }
  }, [activeCompanyId, timeframe, toast]);

  useEffect(() => {
    requestId.current += 1;
    setStats(null);
    void reload();
    return () => {
      requestId.current += 1;
    };
  }, [reload]);

  const upload = async (files: File[]) => {
    if (!activeCompanyId || !mutable) return;
    setUploading(true);
    try {
      await receipts.upload(activeCompanyId, files, 'WEB_UPLOAD');
      toast(`${files.length} receipt${files.length === 1 ? '' : 's'} queued`);
      await reload();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Receipt upload failed');
    } finally {
      setUploading(false);
    }
  };

  if (!activeCompanyId) {
    return <div style={{ padding: 32 }}>Choose a company to view receipts.</div>;
  }

  const cards = [
    ['Received', stats?.received ?? '—'],
    ['Needs review', stats?.needsReview ?? '—'],
    ['Queued / processing', stats ? stats.queued + stats.processing : '—'],
    ['Failed', stats?.failed ?? '—'],
  ];
  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: '28px clamp(14px,3vw,32px) 80px' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <h1 className="page-title" style={{ margin: 0 }}>Receipt dashboard</h1>
        <Link to="/receipts" style={{ marginLeft: 'auto', color: 'var(--acc)' }}>
          Browse receipts
        </Link>
        <select
          aria-label="Dashboard timeframe"
          value={timeframe}
          onChange={(event) => {
            const next = event.target.value as Timeframe;
            setTimeframe(next);
            if (storageKey) writePreference(storageKey, next);
          }}
        >
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="all">All time</option>
        </select>
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 14 }}>
        <section style={{ border: '1px solid var(--bd2)', borderRadius: 10, padding: 18 }}>
          <h2 style={{ fontSize: 16, marginTop: 0 }}>Receipt totals</h2>
          {stats?.totalByCurrency.map((item) => (
            <div key={item.currency}>{item.currency} {amount(item.amount)}</div>
          ))}
          {!stats?.totalByCurrency.length && <div style={{ color: 'var(--mut)' }}>No totals yet.</div>}
        </section>
        <section style={{ border: '1px solid var(--bd2)', borderRadius: 10, padding: 18 }}>
          <h2 style={{ fontSize: 16, marginTop: 0 }}>Spend by category</h2>
          {stats?.totalByCategory.map((item) => (
            <div key={`${item.category}:${item.currency}`}>
              {item.category} · {item.currency} {amount(item.amount)}
            </div>
          ))}
          {!stats?.totalByCategory.length && (
            <div style={{ color: 'var(--mut)' }}>No categorized spend yet.</div>
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
      <section style={{ marginTop: 20 }}>
        <h2 style={{ fontSize: 17 }}>Add receipts</h2>
        <ReceiptDropzone
          disabled={!mutable || uploading}
          disabledLabel={!mutable
            ? 'Receipt uploads require categorizer access'
            : 'Uploading receipts…'}
          onFiles={(files) => void upload(files)}
        />
      </section>
      <section style={{ marginTop: 20 }}>
        <h2 style={{ fontSize: 17 }}>Recent activity</h2>
        {stats?.recentActivity.map((event) => (
          <div key={event.id} style={{ padding: '7px 0', borderBottom: '1px solid var(--bd)' }}>
            {event.action.replaceAll('_', ' ')} · {new Date(event.createdAt).toLocaleString()}
          </div>
        ))}
        {!stats?.recentActivity.length && <div style={{ color: 'var(--mut)' }}>No recent activity.</div>}
      </section>
    </main>
  );
}
