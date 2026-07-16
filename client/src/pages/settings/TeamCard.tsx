// Settings — "Team" card (Recat.dc.html lines 854–869), now per-company:
// members of the ACTIVE company with their per-company role. Deviation from
// the static prototype (which showed the role as plain text): the role is an
// inline <select> so company admins can change it in place. Instance admins
// appear labeled 'admin' with the select disabled — their access is
// instance-wide, not a membership. Invite adds a Membership in this company.

import { useEffect, useState } from 'react';
import type { Role, TeamMemberDto } from '@recat/shared';
import { team as teamApi } from '../../lib/api';
import { useApp } from '../../state/AppContext';
import { errMsg } from './format';
import HoverButton from './HoverButton';

function displayName(m: TeamMemberDto): string {
  return m.name ?? m.email.split('@')[0] ?? m.email;
}

function initials(m: TeamMemberDto): string {
  const src = (m.name ?? '').trim() || (m.email.split('@')[0] ?? m.email);
  const words = src.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

// Member rows: desktop grid `34px 1fr 130px 90px` (as before, just moved from
// inline styles to this class). ≤640px each member collapses to two lines —
// line 1 avatar + name/email (ellipsized), line 2 role left + Invited pill
// right — and the invite row wraps so the email input gets the full width.
const TEAM_CSS = `
.rr .team-row{display:grid;grid-template-columns:34px 1fr 130px 90px;gap:0 14px;align-items:center;padding:10px 0;border-bottom:1px solid var(--rowbd);font-size:14px;}
@media (max-width:640px){
.rr .team-row{grid-template-columns:34px minmax(0,1fr) auto;grid-template-areas:"avatar id id" "role role pill";row-gap:8px;}
.rr .team-avatar{grid-area:avatar;}
.rr .team-id{grid-area:id;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.rr .team-role{grid-area:role;justify-self:start;}
.rr .team-pill{grid-area:pill;justify-self:end;}
.rr .team-invite{flex-wrap:wrap;}
.rr .team-invite input{flex-basis:100% !important;}
}
`;

const roleSelectStyle = {
  border: '1px solid var(--bd)',
  borderRadius: 7,
  padding: '5px 8px',
  fontSize: 13,
  background: 'var(--card)',
  color: 'var(--mut)',
  cursor: 'pointer',
} as const;

export default function TeamCard() {
  const { activeCompanyId, toast } = useApp();

  const [members, setMembers] = useState<TeamMemberDto[]>([]);
  const [invEmail, setInvEmail] = useState('');
  const [invRole, setInvRole] = useState<Role>('categorizer');

  useEffect(() => {
    if (!activeCompanyId) return;
    let cancelled = false;
    teamApi
      .list(activeCompanyId)
      .then((list) => {
        if (!cancelled) setMembers(list);
      })
      .catch(() => {
        // leave the list empty; the invite row still works
      });
    return () => {
      cancelled = true;
    };
  }, [activeCompanyId]);

  const invite = () => {
    if (!activeCompanyId) return;
    const email = invEmail.trim();
    if (!email.includes('@')) {
      toast('Enter a valid email');
      return;
    }
    teamApi
      .invite(activeCompanyId, { email, role: invRole })
      .then((res) => {
        setMembers((prev) => [...prev, res.member]);
        setInvEmail('');
        toast(`Invite sent to ${email}`);
        if (res.devLink !== undefined) console.log('Invite link (dev):', res.devLink);
      })
      .catch((err) => toast(errMsg(err)));
  };

  const changeRole = (member: TeamMemberDto, role: Role) => {
    if (!activeCompanyId || role === member.role) return;
    teamApi
      .patch(activeCompanyId, member.id, { role })
      .then((updated) => {
        setMembers((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
        toast(`${displayName(member)} is now a ${role}`);
      })
      .catch((err) => toast(errMsg(err)));
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
      <style>{TEAM_CSS}</style>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>Team</div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {members.map((m) => (
          <div key={m.id} className="team-row">
            <span
              className="team-avatar"
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
              {initials(m)}
            </span>
            <span className="team-id">
              <span style={{ fontWeight: 500 }}>{displayName(m)}</span>
              <span style={{ color: 'var(--fnt)', fontSize: 13 }}> · {m.email}</span>
            </span>
            {m.isInstanceAdmin ? (
              <span
                className="team-role"
                data-tip="Instance admin — admin in every company"
                style={{ fontSize: 13, color: 'var(--mut)' }}
              >
                admin
              </span>
            ) : (
              <select
                className="team-role"
                value={m.role}
                onChange={(e) => changeRole(m, e.target.value as Role)}
                style={roleSelectStyle}
              >
                <option value="admin">admin</option>
                <option value="categorizer">categorizer</option>
                <option value="viewer">viewer</option>
              </select>
            )}
            <span className="team-pill" style={{ textAlign: 'right' }}>
              {m.invitePending && (
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
          </div>
        ))}
      </div>
      <div className="team-invite" style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <input
          className="input"
          value={invEmail}
          onChange={(e) => setInvEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') invite();
          }}
          placeholder="teammate@company.com"
          style={{ flex: 1, padding: '9px 13px' }}
        />
        <select
          value={invRole}
          onChange={(e) => setInvRole(e.target.value as Role)}
          style={{
            border: '1px solid var(--bd)',
            borderRadius: 7,
            padding: '9px 10px',
            fontSize: 14,
            background: 'var(--card)',
            color: 'var(--ink)',
            cursor: 'pointer',
          }}
        >
          <option value="categorizer">categorizer</option>
          <option value="viewer">viewer</option>
          <option value="admin">admin</option>
        </select>
        <HoverButton
          onClick={invite}
          style={{
            background: 'var(--acc)',
            color: '#fff',
            border: 'none',
            borderRadius: 7,
            padding: '9px 16px',
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
            font: 'inherit',
          }}
          hoverStyle={{ background: 'var(--accH)' }}
        >
          Invite
        </HoverButton>
      </div>
    </div>
  );
}
