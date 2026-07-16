// Settings — "People with access" card (instance admins only). Instance-wide
// view of EVERYONE who can sign in to this deployment, across all companies —
// the per-company Team card above it only shows the active company. Access is
// invitation-only (no self-signup), so this list is the full census. The ×
// fully removes a person: all memberships and sessions (server: DELETE
// /api/users/:id, which guards self-delete and the last instance admin).

import { useCallback, useEffect, useState } from 'react';
import type { UserDto } from '@recat/shared';
import ConfirmDialog from '../../components/ConfirmDialog';
import { InfoDot } from '../../components/ui';
import { users as usersApi } from '../../lib/api';
import { useApp } from '../../state/AppContext';
import { errMsg } from './format';

function displayName(u: UserDto): string {
  return u.name ?? u.email.split('@')[0] ?? u.email;
}

function initials(u: UserDto): string {
  const src = (u.name ?? '').trim() || (u.email.split('@')[0] ?? u.email);
  const words = src.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

// Rows: avatar | identity (name/email + access summary) | Invited pill | remove ×.
// ≤640px the pill and × stay on the first line and the summary keeps its
// ellipsis via min-width:0 on the identity column.
const ACCESS_CSS = `
.rr .access-row{display:grid;grid-template-columns:34px minmax(0,1fr) auto 24px;gap:0 14px;align-items:center;padding:10px 0;border-bottom:1px solid var(--rowbd);font-size:14px;}
.rr .access-del:hover{color:var(--erT);}
.rr .access-summary{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:var(--mut);margin-top:1px;}
`;

export default function AccessCard() {
  const { session, companies, toast } = useApp();

  const [people, setPeople] = useState<UserDto[]>([]);
  const [pendingRemoval, setPendingRemoval] = useState<UserDto | null>(null);
  const [removing, setRemoving] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    const list = await usersApi.list();
    setPeople(list);
  }, []);

  useEffect(() => {
    reload().catch(() => {
      // leave the list empty; nothing else on the card depends on it
    });
  }, [reload]);

  const companyName = useCallback(
    (companyId: string): string =>
      companies.find((c) => c.id === companyId)?.nickname ?? 'disconnected company',
    [companies],
  );

  const accessSummary = useCallback(
    (u: UserDto): string => {
      if (u.isInstanceAdmin) return 'instance admin — all companies';
      const n = u.memberships.length;
      if (n === 0) return 'no companies';
      const parts = u.memberships.map((m) => `${companyName(m.companyId)} (${m.role})`);
      return `${n} ${n === 1 ? 'company' : 'companies'}: ${parts.join(', ')}`;
    },
    [companyName],
  );

  const remove = () => {
    if (!pendingRemoval || removing) return;
    const target = pendingRemoval;
    setRemoving(true);
    usersApi
      .del(target.id)
      .then(async () => {
        await reload();
        toast(`${target.email} removed`);
        setPendingRemoval(null);
      })
      .catch((err) => toast(errMsg(err)))
      .finally(() => setRemoving(false));
  };

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
      <style>{ACCESS_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>People with access</span>
        <InfoDot tip="Everyone who can sign in to this deployment, across all companies. Access is invitation-only — there is no self-signup." />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {people.map((u) => {
          const summary = accessSummary(u);
          const isSelf = session !== null && u.id === session.id;
          return (
            <div key={u.id} className="access-row">
              <span
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: '50%',
                  background: 'var(--hl)',
                  border: '1px solid var(--bd2)',
                  color: 'var(--mut)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                {initials(u)}
              </span>
              <span style={{ minWidth: 0 }}>
                <span
                  style={{
                    display: 'block',
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span style={{ fontWeight: 500 }}>{displayName(u)}</span>
                  <span style={{ color: 'var(--fnt)', fontSize: 13 }}> · {u.email}</span>
                </span>
                {u.isInstanceAdmin ? (
                  <span className="access-summary">{summary}</span>
                ) : (
                  <span className="access-summary" data-tip={summary}>
                    {summary}
                  </span>
                )}
              </span>
              <span style={{ textAlign: 'right' }}>
                {u.invitePending && (
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: 'var(--amT)',
                      background: 'var(--amB)',
                      border: '1px solid var(--amD)',
                      padding: '3px 9px',
                      borderRadius: 99,
                    }}
                  >
                    Invited
                  </span>
                )}
              </span>
              {isSelf ? (
                <span style={{ fontSize: 12, color: 'var(--fnt)', textAlign: 'center' }}>you</span>
              ) : (
                <button
                  className="access-del"
                  onClick={() => setPendingRemoval(u)}
                  data-tip="Remove this person entirely — all roles and sessions"
                  data-tip-align="right"
                  style={{
                    border: 'none',
                    background: 'none',
                    color: 'var(--fnt)',
                    fontSize: 16,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    padding: 0,
                  }}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={pendingRemoval !== null}
        title={`Remove ${pendingRemoval ? displayName(pendingRemoval) : ''}?`}
        confirmLabel="Remove access"
        tone="danger"
        busy={removing}
        onConfirm={remove}
        onCancel={() => setPendingRemoval(null)}
      >
        They lose access to every company on this deployment immediately. Their past actions
        remain in the audit log.
      </ConfirmDialog>
    </div>
  );
}
