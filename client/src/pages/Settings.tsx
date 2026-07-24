// Settings screen — pixel port of Recat.dc.html lines 741–891 (logic 1458–1488,
// 1605–1608). Cards: connection, dry-run, QuickBooks API access (admin),
// tags-required, category suggestions, team (admin), sync history, danger zone.

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { InstanceSettingsDto, SyncLogDto } from '@recat/shared';
import { isDemoRealmId } from '@recat/shared';
import { api, companies as companiesApi, instanceSettings } from '../lib/api';
import { ToggleSwitch } from '../components/ui';
import { useApp } from '../state/AppContext';
import ConfirmDialog from '../components/ConfirmDialog';
import AccessCard from './settings/AccessCard';
import ApiAccessCard from './settings/ApiAccessCard';
import ConnectionCard from './settings/ConnectionCard';
import type { HoldingAccountOption } from './settings/ConnectionCard';
import DensityCard from './settings/DensityCard';
import EmailCard from './settings/EmailCard';
import HoverButton from './settings/HoverButton';
import SuggestionsCard from './settings/SuggestionsCard';
import TeamCard from './settings/TeamCard';
import TaxCard from './settings/TaxCard';
import AutopilotCard from './settings/AutopilotCard';
import { errMsg, fmtWhen } from './settings/format';

export default function Settings() {
  const {
    session,
    role,
    companies,
    activeCompany,
    updateCompany,
    refreshCompanies,
    dryRun,
    tagsRequired,
    toast,
  } = useApp();
  const navigate = useNavigate();
  const isAdmin = role === 'admin';
  const companyId = activeCompany?.id ?? null;

  // Demo-only instance (every connected company is a built-in demo) — invite
  // the admin to upgrade to real books. Gone the moment any real company exists.
  const demoOnly = companies.length > 0 && companies.every((c) => isDemoRealmId(c.realmId));

  const [holdingOptions, setHoldingOptions] = useState<HoldingAccountOption[]>([]);
  const [syncLog, setSyncLog] = useState<SyncLogDto[]>([]);
  const [settings, setSettings] = useState<InstanceSettingsDto | null>(null);
  const [autopilotReadinessVersion, setAutopilotReadinessVersion] = useState(0);
  const updateSettings = useCallback((next: InstanceSettingsDto) => {
    setSettings(next);
    setAutopilotReadinessVersion((version) => version + 1);
  }, []);

  // TODO(server): GET /api/companies/:id/sync-log — helper missing from lib/api.ts.
  const reloadSyncLog = useCallback(async (): Promise<SyncLogDto[]> => {
    if (!companyId) return [];
    const log = await api.get<SyncLogDto[]>(`/api/companies/${companyId}/sync-log`);
    setSyncLog(log);
    return log;
  }, [companyId]);

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    api
      .get<{ qboId: string; name: string; count: number }[]>(
        `/api/companies/${companyId}/holding-account-options`,
      )
      .then((opts) => {
        if (!cancelled) setHoldingOptions(opts.map((o) => ({ id: o.qboId, name: o.name, count: o.count })));
      })
      .catch(() => {
        // leave empty; the rest of the card still works
      });
    reloadSyncLog().catch(() => {
      // leave empty
    });
    return () => {
      cancelled = true;
    };
  }, [companyId, reloadSyncLog]);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    instanceSettings
      .get()
      .then((dto) => {
        if (!cancelled) setSettings(dto);
      })
      .catch(() => {
        // admin-only cards simply stay hidden until this loads
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  const toggleDry = () => {
    const next = !dryRun;
    updateCompany({ dryRun: next })
      .then(() =>
        toast(
          next
            ? 'Dry-run ON — nothing will be written to QuickBooks'
            : 'Dry-run OFF — posts now write to QuickBooks',
        ),
      )
      .catch((err) => toast(errMsg(err)));
  };

  const toggleReqTags = () => {
    const next = !tagsRequired;
    updateCompany({ tagsRequired: next })
      .then(() =>
        toast(next ? "Tags required — untagged transactions can't be posted" : 'Tags optional'),
      )
      .catch((err) => toast(errMsg(err)));
  };

  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const disconnect = () => {
    if (!activeCompany || disconnecting) return;
    setDisconnecting(true);
    companiesApi
      .disconnect(activeCompany.id)
      .then(async () => {
        await refreshCompanies();
        toast(`Disconnected ${activeCompany.nickname}`);
      })
      .catch((err) => toast(errMsg(err)))
      .finally(() => {
        setDisconnecting(false);
        setConfirmDisconnect(false);
      });
  };

  const lastWebhookEventAt = syncLog.find((s) => s.kind === 'webhook')?.at ?? null;

  return (
    <div
      style={{
        maxWidth: 860,
        margin: '0 auto',
        padding: '28px clamp(14px,3.5vw,32px) 80px',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      <div className="page-title">Settings</div>

      {activeCompany && (
        <>
          {/* upgrade to real books (admin, demo-only instances) */}
          {isAdmin && demoOnly && (
            <div
              style={{
                border: '1px solid var(--bd2)',
                borderRadius: 10,
                background: 'var(--card)',
                padding: '20px 24px',
                display: 'flex',
                alignItems: 'center',
                gap: 16,
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>Ready for your real books?</div>
                <div style={{ fontSize: 13.5, color: 'var(--mut)', marginTop: 3, lineHeight: 1.5 }}>
                  Connect your real QuickBooks with your own free Intuit keys — the demo companies
                  stay until you remove them.
                </div>
              </div>
              <HoverButton
                onClick={() => navigate('/connect?mode=real')}
                style={{
                  border: 'none',
                  background: 'var(--acc)',
                  color: '#fff',
                  borderRadius: 7,
                  padding: '9px 16px',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
                hoverStyle={{ background: 'var(--accH)' }}
              >
                Connect real QuickBooks
              </HoverButton>
            </div>
          )}

          {/* connection */}
          <ConnectionCard
            key={activeCompany.id}
            company={activeCompany}
            holdingOptions={holdingOptions}
            reloadSyncLog={reloadSyncLog}
          />

          {/* dry run */}
          <div
            style={{
              border: `1px solid ${dryRun ? 'var(--amD)' : 'var(--bd2)'}`,
              borderRadius: 10,
              background: dryRun ? 'var(--amB)' : 'var(--card)',
              padding: '20px 24px',
              display: 'flex',
              alignItems: 'center',
              gap: 16,
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>Dry-run mode</div>
              <div style={{ fontSize: 13.5, color: 'var(--mut)', marginTop: 3, lineHeight: 1.5 }}>
                When on, Recat logs the exact payload it <i>would</i> send to QuickBooks — but writes
                nothing. Recommended until you trust the setup.
              </div>
            </div>
            <ToggleSwitch on={dryRun} onToggle={toggleDry} />
          </div>

          {/* api & webhooks (admin) */}
          {isAdmin && settings && (
            <ApiAccessCard
              settings={settings}
              onSettings={updateSettings}
              companyId={activeCompany.id}
              companyConnected={activeCompany.disconnectedAt === null}
              syncMode={activeCompany.syncMode}
              lastWebhookEventAt={lastWebhookEventAt}
            />
          )}

          {/* email / smtp (admin) */}
          {isAdmin && settings && <EmailCard settings={settings} onSettings={updateSettings} />}

          {/* tags required */}
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
              <div style={{ fontSize: 15, fontWeight: 600 }}>Tags are required</div>
              <div style={{ fontSize: 13.5, color: 'var(--mut)', marginTop: 3, lineHeight: 1.5 }}>
                A transaction can't be posted to QuickBooks until it carries at least one tag.
              </div>
            </div>
            <ToggleSwitch on={tagsRequired} onToggle={toggleReqTags} />
          </div>

          <TaxCard
            isAdmin={isAdmin}
            onRefreshed={() => setAutopilotReadinessVersion((version) => version + 1)}
          />

          <AutopilotCard
            isAdmin={isAdmin}
            readinessVersion={autopilotReadinessVersion}
          />

          {/* suggestions */}
          {settings && (
            <SuggestionsCard key={`${settings.suggestionSource}-${settings.suggestionProvider}`} settings={settings} onSettings={updateSettings} />
          )}

          {/* density (per-user, per-browser) */}
          <DensityCard />

          {/* team (admin) */}
          {isAdmin && <TeamCard />}

          {/* people with access — instance-wide (instance admins only) */}
          {session?.isInstanceAdmin && <AccessCard />}

          {/* sync history */}
          <div
            style={{
              border: '1px solid var(--bd2)',
              borderRadius: 10,
              background: 'var(--card)',
              padding: 24,
              boxShadow: '0 1px 6px rgba(60,55,45,.05)',
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>Sync history</div>
            {syncLog.map((s) => (
              <div
                key={s.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '80px 1fr 140px',
                  gap: '0 14px',
                  alignItems: 'center',
                  padding: '9px 0',
                  borderBottom: '1px solid var(--rowbd)',
                  fontSize: 13.5,
                }}
              >
                <span style={{ fontSize: 12, fontWeight: 600, color: s.ok ? 'var(--okT)' : 'var(--erT)' }}>
                  {s.kind}
                </span>
                <span style={{ color: 'var(--mut)' }}>{s.message}</span>
                <span style={{ textAlign: 'right', color: 'var(--fnt)', fontSize: 12.5 }}>
                  {fmtWhen(s.at)}
                </span>
              </div>
            ))}
          </div>

          {/* danger */}
          <div
            style={{
              border: '1px solid var(--erD)',
              borderRadius: 10,
              padding: '20px 24px',
              display: 'flex',
              alignItems: 'center',
              gap: 16,
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--erT)' }}>
                Disconnect this company
              </div>
              <div style={{ fontSize: 13.5, color: 'var(--mut)', marginTop: 3 }}>
                Stops syncing and revokes tokens. Local history and the audit log are kept.
              </div>
            </div>
            <HoverButton
              onClick={() => setConfirmDisconnect(true)}
              style={{
                border: '1px solid var(--erD)',
                background: 'none',
                color: 'var(--erT)',
                borderRadius: 7,
                padding: '8px 14px',
                fontSize: 13.5,
                fontWeight: 600,
                cursor: 'pointer',
                font: 'inherit',
              }}
              hoverStyle={{ background: 'var(--erB)' }}
            >
              Disconnect…
            </HoverButton>
          </div>

          <ConfirmDialog
            open={confirmDisconnect}
            title={`Disconnect ${activeCompany.nickname}?`}
            confirmLabel="Disconnect"
            tone="danger"
            busy={disconnecting}
            onConfirm={disconnect}
            onCancel={() => setConfirmDisconnect(false)}
          >
            Syncing stops and the QuickBooks tokens are revoked. Local history and the
            audit log are kept — you can reconnect any time.
          </ConfirmDialog>
        </>
      )}
    </div>
  );
}
