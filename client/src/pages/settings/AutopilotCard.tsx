import { useEffect, useState } from 'react';
import type { AutopilotSummaryDto } from '@recat/shared';
import { autopilot } from '../../lib/api';
import { ToggleSwitch } from '../../components/ui';
import ConfirmDialog from '../../components/ConfirmDialog';
import { useApp } from '../../state/AppContext';
import { errMsg, fmtWhen } from './format';
import HoverButton from './HoverButton';

const LIVE_CONFIRMATION = 'ENABLE LIVE AUTOPILOT';

export default function AutopilotCard({
  isAdmin,
  readinessVersion = 0,
}: {
  isAdmin: boolean;
  readinessVersion?: number;
}) {
  const {
    activeCompanyId,
    dryRun,
    tagsRequired,
    taxProfile,
    refreshCompanies,
    toast,
  } = useApp();
  const [loadedSummary, setLoadedSummary] = useState<{
    companyId: string;
    value: AutopilotSummaryDto;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmLiveFor, setConfirmLiveFor] = useState<string | null>(null);
  const summary =
    loadedSummary?.companyId === activeCompanyId ? loadedSummary.value : null;
  const confirmLive =
    activeCompanyId !== null && confirmLiveFor === activeCompanyId;

  useEffect(() => {
    if (!activeCompanyId) return;
    const companyId = activeCompanyId;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const value = await autopilot.summary(companyId);
        if (cancelled) return;
        setLoadedSummary({ companyId, value });
        if (value.mode !== 'off') {
          timer = setTimeout(() => void refresh(), 5_000);
        }
      } catch (error) {
        if (!cancelled) {
          toast(errMsg(error));
          if (
            loadedSummary?.companyId === companyId &&
            loadedSummary.value.mode !== 'off'
          ) {
            timer = setTimeout(() => void refresh(), 5_000);
          }
        }
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    activeCompanyId,
    dryRun,
    loadedSummary?.companyId,
    loadedSummary?.value.mode,
    readinessVersion,
    tagsRequired,
    taxProfile?.lastRefreshedAt,
    taxProfile?.status,
    toast,
  ]);

  const toggleShadow = async () => {
    if (!activeCompanyId || !summary || saving) return;
    const companyId = activeCompanyId;
    const previousMode = summary.mode;
    setSaving(true);
    try {
      const next = await autopilot.setMode(
        companyId,
        previousMode === 'off' || previousMode === 'live' ? 'shadow' : 'off',
      );
      setLoadedSummary({ companyId, value: next });
      await refreshCompanies();
      toast(
        next.mode === 'shadow'
          ? previousMode === 'live'
            ? 'Live writes stopped — autopilot is continuing in shadow mode'
            : 'Autopilot shadow mode started'
          : 'Autopilot stopped',
      );
    } catch (error) {
      toast(errMsg(error));
    } finally {
      setSaving(false);
    }
  };

  const enableLive = async () => {
    if (
      !activeCompanyId ||
      confirmLiveFor !== activeCompanyId ||
      !summary ||
      saving
    ) return;
    const companyId = activeCompanyId;
    setSaving(true);
    try {
      const next = await autopilot.setMode(companyId, 'live', LIVE_CONFIRMATION);
      setLoadedSummary({ companyId, value: next });
      await refreshCompanies();
      toast('Live autopilot enabled — verified decisions can now post to QuickBooks');
      setConfirmLiveFor(null);
    } catch (error) {
      toast(errMsg(error));
    } finally {
      setSaving(false);
    }
  };

  const activeCount =
    (summary?.counts.queued ?? 0) +
    (summary?.counts.running ?? 0) +
    (summary?.counts.retry ?? 0);
  const failures = summary?.counts.failed ?? 0;
  const ready = summary !== null && summary.readiness.shadowReady;

  return (
    <div
      style={{
        border: `1px solid ${summary?.mode === 'shadow' ? 'var(--acc)' : 'var(--bd2)'}`,
        borderRadius: 10,
        background: 'var(--card)',
        padding: '20px 24px',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        boxShadow: '0 1px 6px rgba(60,55,45,.05)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Autopilot agent</div>
        <div style={{ fontSize: 13.5, color: 'var(--mut)', marginTop: 3, lineHeight: 1.5 }}>
          {summary === null
            ? 'Loading…'
            : summary.mode === 'live'
              ? `Live · ${activeCount} active · ${summary.counts.completed} completed${failures ? ` · ${failures} failed` : ''}`
              : summary.mode === 'shadow'
              ? `Shadow mode · ${activeCount} active · ${summary.counts.completed} completed${failures ? ` · ${failures} failed` : ''}`
              : 'Off · start in shadow mode to collect decisions without changing your books'}
        </div>
        {summary?.lastRun && (
          <div style={{ fontSize: 12.5, color: 'var(--fnt)', marginTop: 4 }}>
            Last run {fmtWhen(summary.lastRun.completedAt ?? summary.lastRun.startedAt)} ·{' '}
            {summary.lastRun.model}
          </div>
        )}
        {summary && summary.counts.running > 0 && (
          <div style={{ fontSize: 12.5, color: 'var(--acc)', marginTop: 4 }}>
            {summary.counts.running} job{summary.counts.running === 1 ? '' : 's'} currently in
            flight
          </div>
        )}
        {summary?.readiness.fatalGate && (
          <div style={{ fontSize: 12.5, color: 'var(--amT)', marginTop: 4 }}>
            {summary.readiness.fatalGate}
          </div>
        )}
        {summary && (
          <div style={{ fontSize: 12.5, color: 'var(--fnt)', marginTop: 5 }}>
            Live readiness: ChatGPT {summary.readiness.providerConnected ? '✓' : '✕'} · tax{' '}
            {summary.readiness.taxReady ? '✓' : '✕'} · deployment writes{' '}
            {summary.readiness.deploymentWritesEnabled ? '✓' : '✕'} · company writes{' '}
            {summary.readiness.companyWritesEnabled ? '✓' : '✕'} · shadow evidence{' '}
            {summary.readiness.shadowValidated}/{summary.readiness.shadowRequired} · uncertain writes{' '}
            {summary.readiness.openUncertainWrites}
          </div>
        )}
        <div style={{ fontSize: 12.5, color: 'var(--fnt)', marginTop: 4 }}>
          Shadow decisions are visible in the queue but never staged or sent to QuickBooks. Live
          mode remains locked until the write-safety checks are enabled.
        </div>
      </div>
      {isAdmin && summary && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 'none' }}>
          {summary.mode === 'shadow' && (
            <HoverButton
              onClick={() => setConfirmLiveFor(activeCompanyId)}
              disabled={!summary.readiness.liveReady || saving}
              data-tip={summary.readiness.fatalGate ?? 'Enable verified QuickBooks posting'}
              style={{
                border: '1px solid var(--acc)',
                background: summary.readiness.liveReady ? 'var(--acc)' : 'var(--card)',
                color: summary.readiness.liveReady ? '#fff' : 'var(--fnt)',
                borderRadius: 7,
                padding: '8px 12px',
                fontSize: 13,
                fontWeight: 600,
                cursor: summary.readiness.liveReady ? 'pointer' : 'not-allowed',
                fontFamily: 'inherit',
              }}
              hoverStyle={summary.readiness.liveReady ? { background: 'var(--accH)' } : {}}
            >
              Enable live
            </HoverButton>
          )}
          <ToggleSwitch
            on={summary.mode !== 'off'}
            onToggle={() => {
              if ((ready || summary.mode !== 'off') && !saving) void toggleShadow();
            }}
          />
        </div>
      )}
      <ConfirmDialog
        open={confirmLive}
        title="Enable live autopilot?"
        confirmLabel="Enable live"
        tone="danger"
        busy={saving}
        onConfirm={() => void enableLive()}
        onCancel={() => setConfirmLiveFor(null)}
      >
        Recat will stage validated agent decisions, write them to QuickBooks, and verify the saved
        result. Turning autopilot off stops new writes, but any write already in progress will finish
        verification.
      </ConfirmDialog>
    </div>
  );
}
