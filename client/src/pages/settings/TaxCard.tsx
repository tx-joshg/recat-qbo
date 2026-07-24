import { useState } from 'react';
import { tax as taxApi } from '../../lib/api';
import { useApp } from '../../state/AppContext';
import HoverButton from './HoverButton';
import { errMsg, fmtFullDateTime } from './format';

export default function TaxCard({
  isAdmin,
  onRefreshed,
}: {
  isAdmin: boolean;
  onRefreshed?: () => void;
}) {
  const {
    activeCompanyId,
    taxProfile,
    taxCodes,
    refreshTax,
    toast,
  } = useApp();
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    if (!activeCompanyId || refreshing) return;
    setRefreshing(true);
    try {
      await taxApi.refresh(activeCompanyId);
      await refreshTax();
      onRefreshed?.();
      toast('QuickBooks tax codes refreshed');
    } catch (error) {
      toast(errMsg(error));
    } finally {
      setRefreshing(false);
    }
  };

  const status = taxProfile?.status ?? 'needs_setup';
  const statusText = status
    .replaceAll('_', ' ')
    .replace(/^./, (first) => first.toUpperCase());
  const statusColor =
    status === 'ready' ? 'var(--okT)' : status === 'unsupported' ? 'var(--erT)' : 'var(--amT)';

  return (
    <div
      style={{
        border: '1px solid var(--bd2)',
        borderRadius: 10,
        background: 'var(--card)',
        padding: '20px 24px',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        boxShadow: '0 1px 6px rgba(60,55,45,.05)',
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Purchase tax</div>
        <div style={{ fontSize: 13.5, color: 'var(--mut)', marginTop: 3, lineHeight: 1.5 }}>
          <b style={{ color: statusColor }}>{statusText}</b>
          {' · '}
          {taxCodes.filter((code) => code.active && code.purchaseApplicable).length} purchase tax codes
          {taxProfile?.lastRefreshedAt
            ? ` · refreshed ${fmtFullDateTime(taxProfile.lastRefreshedAt)}`
            : ' · not refreshed yet'}
        </div>
        {taxProfile?.reason && (
          <div style={{ fontSize: 12.5, color: 'var(--fnt)', marginTop: 4 }}>{taxProfile.reason}</div>
        )}
      </div>
      {isAdmin && (
        <HoverButton
          onClick={() => void refresh()}
          disabled={refreshing}
          style={{
            border: '1px solid var(--bd)',
            background: 'var(--card)',
            color: 'var(--mut)',
            borderRadius: 7,
            padding: '8px 14px',
            fontSize: 13.5,
            fontWeight: 600,
            cursor: refreshing ? 'wait' : 'pointer',
            font: 'inherit',
          }}
          hoverStyle={{ borderColor: 'var(--acc)', color: 'var(--acc)' }}
        >
          {refreshing ? 'Refreshing…' : 'Refresh tax codes'}
        </HoverButton>
      )}
    </div>
  );
}
