// Settings — connection card (Recat.dc.html lines 746–777).
// Editable nickname (canvas-measured width, prototype line 1486), holding
// accounts watched, polling/webhook sync mode, interval, sync now.

import { useRef, useState } from 'react';
import { isDemoRealmId } from '@recat/shared';
import type { CompanyDto, PollInterval, SyncLogDto, SyncMode } from '@recat/shared';
import { companies as companiesApi } from '../../lib/api';
import { useApp } from '../../state/AppContext';
import { errMsg, fmtLongDate, fmtTxnCount, fmtWhen } from './format';
import HoverButton from './HoverButton';

/** TODO(server): GET /api/companies/:id/holding-account-options — helper missing from lib/api.ts. */
export interface HoldingAccountOption {
  id: string;
  name: string;
  count: number;
}

// Nickname width is measured off-DOM exactly like the prototype (canvas measureText).
let measureCtx: CanvasRenderingContext2D | null = null;
function nickWidth(nick: string): number {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return 90;
  measureCtx.font = "600 16px 'IBM Plex Sans', sans-serif";
  return Math.ceil(measureCtx.measureText(nick).width) + 16;
}

export default function ConnectionCard({
  company,
  holdingOptions,
  reloadSyncLog,
}: {
  company: CompanyDto;
  holdingOptions: HoldingAccountOption[];
  reloadSyncLog: () => Promise<SyncLogDto[]>;
}) {
  const { updateCompany, refreshCompanies, toast } = useApp();

  const nickRef = useRef<HTMLInputElement>(null);
  const [nick, setNick] = useState(company.nickname);
  const [nickHover, setNickHover] = useState(false);
  const [nickFocus, setNickFocus] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const saveNick = () => {
    const trimmed = nick.trim();
    if (!trimmed) {
      setNick(company.nickname);
      return;
    }
    if (trimmed === company.nickname) return;
    updateCompany({ nickname: trimmed }).catch((err) => toast(errMsg(err)));
  };

  const toggleHolding = (id: string) => {
    const on = company.holdingAccountIds.includes(id);
    if (on && company.holdingAccountIds.length === 1) {
      toast('Keep at least one holding account watched');
      return;
    }
    const next = on
      ? company.holdingAccountIds.filter((x) => x !== id)
      : [...company.holdingAccountIds, id];
    updateCompany({ holdingAccountIds: next }).catch((err) => toast(errMsg(err)));
  };

  const setMode = (mode: SyncMode) => {
    if (mode === company.syncMode) return;
    updateCompany({ syncMode: mode })
      .then(() => {
        if (mode === 'webhook') toast('Webhook URL: /webhooks/qbo — add the verifier token from Intuit');
      })
      .catch((err) => toast(errMsg(err)));
  };

  const syncNow = () => {
    if (syncing) return;
    setSyncing(true);
    companiesApi
      .sync(company.id)
      .then(async () => {
        const [log] = await Promise.all([reloadSyncLog(), refreshCompanies()]);
        toast(log[0]?.message ?? 'Sync complete');
      })
      .catch((err) => toast(errMsg(err)))
      .finally(() => setSyncing(false));
  };

  const isDemo = isDemoRealmId(company.realmId);

  // Reconnect re-runs the flow this company was made with: demo companies go
  // back through the fake consent; real ones to Intuit with their stored env.
  const reconnect = () => {
    companiesApi
      .connectUrl(isDemo ? { mode: 'demo' } : { mode: 'real', env: company.env })
      .then(({ url }) => {
        window.location.href = url;
      })
      .catch((err) => toast(errMsg(err)));
  };

  const disconnected = company.disconnectedAt !== null;

  const demoBadge = isDemo && (
    <span
      data-tip="Built-in sample company — not connected to Intuit"
      style={{
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--fnt)',
        background: 'var(--hl)',
        border: '1px solid var(--bd2)',
        borderRadius: 99,
        padding: '1px 8px',
      }}
    >
      demo
    </span>
  );

  return (
    <div
      style={{
        border: '1px solid var(--bd2)',
        borderRadius: 10,
        background: 'var(--card)',
        padding: 24,
        boxShadow: '0 1px 6px rgba(60,55,45,.05)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <span
          style={{
            width: 40,
            height: 40,
            borderRadius: 9,
            background: 'var(--acc)',
            color: '#fff',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 600,
            fontSize: 17,
          }}
        >
          {(nick.trim() || company.nickname).charAt(0).toUpperCase()}
        </span>
        <div>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input
              ref={nickRef}
              value={nick}
              onChange={(e) => setNick(e.target.value)}
              onMouseEnter={() => setNickHover(true)}
              onMouseLeave={() => setNickHover(false)}
              onFocus={() => setNickFocus(true)}
              onBlur={() => {
                setNickFocus(false);
                saveNick();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') nickRef.current?.blur();
              }}
              style={{
                fontSize: 16,
                fontWeight: 600,
                border: `1px solid ${nickFocus ? 'var(--acc)' : nickHover ? 'var(--bd)' : 'transparent'}`,
                borderRadius: 6,
                padding: '2px 6px',
                marginLeft: -7,
                background: nickFocus ? 'var(--card)' : 'transparent',
                color: 'var(--ink)',
                outline: 'none',
                width: nickWidth(nick),
                minWidth: 90,
                fontFamily: 'inherit',
                boxSizing: 'border-box',
              }}
            />
            <HoverButton
              onClick={() => {
                nickRef.current?.focus();
                nickRef.current?.select();
              }}
              data-tip="Rename"
              style={{
                border: 'none',
                background: 'none',
                color: 'var(--fnt)',
                cursor: 'pointer',
                fontSize: 14,
                padding: '2px 4px',
              }}
              hoverStyle={{ color: 'var(--ink)' }}
            >
              ✎
            </HoverButton>
          </span>
          <div style={{ fontSize: 13, color: 'var(--fnt)' }}>
            {company.legalName} · realm {company.realmId} · {company.env} · connected{' '}
            {fmtLongDate(company.connectedAt)}
          </div>
        </div>
        {disconnected ? (
          <span
            style={{
              marginLeft: 'auto',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              fontSize: 13.5,
              fontWeight: 600,
              color: 'var(--mut)',
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: 'var(--fnt)',
                display: 'inline-block',
              }}
            />
            Disconnected
          </span>
        ) : (
          <span
            style={{
              marginLeft: 'auto',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              fontSize: 13.5,
              fontWeight: 600,
              color: 'var(--okT)',
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: 'var(--okT)',
                display: 'inline-block',
              }}
            />
            Connected
          </span>
        )}
        {demoBadge}
        <HoverButton
          onClick={reconnect}
          style={{
            border: '1px solid var(--bd)',
            background: 'var(--card)',
            color: 'var(--ink)',
            borderRadius: 7,
            padding: '8px 14px',
            fontSize: 13.5,
            fontWeight: 500,
            cursor: 'pointer',
            font: 'inherit',
          }}
          hoverStyle={{ background: 'var(--hl)' }}
        >
          Reconnect
        </HoverButton>
      </div>

      <div
        style={{
          borderTop: '1px solid var(--bd2)',
          marginTop: 20,
          paddingTop: 20,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))',
          gap: 24,
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--mut)', marginBottom: 10 }}>
            Holding accounts watched
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {holdingOptions.map((h) => (
              <label
                key={h.id}
                onClick={() => toggleHolding(h.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={company.holdingAccountIds.includes(h.id)}
                  readOnly
                  style={{ width: 15, height: 15, accentColor: 'var(--acc)', pointerEvents: 'none' }}
                />
                {h.name}
                <span style={{ color: 'var(--fnt)', fontSize: 12.5, marginLeft: 'auto' }}>
                  {fmtTxnCount(h.count)}
                </span>
              </label>
            ))}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--mut)', marginBottom: 10 }}>Sync</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button
              onClick={() => setMode('polling')}
              style={{
                flex: 1,
                border: `1.5px solid ${company.syncMode === 'polling' ? 'var(--acc)' : 'var(--bd2)'}`,
                background: 'var(--card)',
                color: 'var(--ink)',
                borderRadius: 7,
                padding: 8,
                fontSize: 13.5,
                fontWeight: 600,
                cursor: 'pointer',
                font: 'inherit',
              }}
            >
              Polling
            </button>
            <button
              onClick={() => setMode('webhook')}
              style={{
                flex: 1,
                border: `1.5px solid ${company.syncMode === 'webhook' ? 'var(--acc)' : 'var(--bd2)'}`,
                background: 'var(--card)',
                color: 'var(--ink)',
                borderRadius: 7,
                padding: 8,
                fontSize: 13.5,
                fontWeight: 600,
                cursor: 'pointer',
                font: 'inherit',
              }}
            >
              Webhooks
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13.5, color: 'var(--mut)' }}>
            Every
            <select
              value={String(company.pollIntervalMin)}
              onChange={(e) =>
                updateCompany({ pollIntervalMin: Number(e.target.value) as PollInterval }).catch((err) =>
                  toast(errMsg(err)),
                )
              }
              style={{
                border: '1px solid var(--bd)',
                borderRadius: 6,
                padding: '5px 8px',
                fontSize: 13.5,
                background: 'var(--card)',
                color: 'var(--ink)',
                cursor: 'pointer',
              }}
            >
              <option value="5">5 min</option>
              <option value="10">10 min</option>
              <option value="30">30 min</option>
              <option value="60">60 min</option>
            </select>
            · last sync {company.lastSyncedAt ? fmtWhen(company.lastSyncedAt) : 'never'}
          </div>
          <HoverButton
            onClick={syncNow}
            disabled={syncing}
            style={{
              marginTop: 12,
              border: '1px solid var(--bd)',
              background: 'var(--card)',
              color: 'var(--ink)',
              borderRadius: 7,
              padding: '7px 13px',
              fontSize: 13.5,
              fontWeight: 500,
              cursor: 'pointer',
              font: 'inherit',
            }}
            hoverStyle={{ background: 'var(--hl)' }}
          >
            ↻ Sync now
          </HoverButton>
        </div>
      </div>
    </div>
  );
}
