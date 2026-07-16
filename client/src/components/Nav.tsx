// Sticky top nav — pixel-for-pixel port of Recat.dc.html lines 183–227.
// ≤640px the tab row and right-side controls collapse under a hamburger menu.

import { useEffect, useState } from 'react';
import type { CSSProperties, MouseEvent } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import type { Role, UserDto } from '@recat/shared';
import { useApp } from '../state/AppContext';

interface Tab {
  label: string;
  to: string;
}

const ALL_TABS: Tab[] = [
  { label: 'Queue', to: '/' },
  { label: 'Rules', to: '/rules' },
  { label: 'Dashboard', to: '/dashboard' },
  { label: 'Reports', to: '/reports' },
  { label: 'Audit log', to: '/audit' },
  { label: 'Tags', to: '/tags' },
  { label: 'Settings', to: '/settings' },
];

/** Tabs by per-company role; no membership in the active company → viewer-like. */
function tabsForRole(role: Role | null): Tab[] {
  if (role === null || role === 'viewer') {
    return ALL_TABS.filter((t) => t.label === 'Dashboard' || t.label === 'Reports');
  }
  if (role === 'categorizer') return ALL_TABS.filter((t) => t.label !== 'Settings');
  return ALL_TABS;
}

function userInitials(user: UserDto): string {
  const src = (user.name ?? '').trim() || user.email;
  const words = src.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

const tabBase: CSSProperties = {
  border: 'none',
  cursor: 'pointer',
  padding: '6px 12px',
  borderRadius: 6,
  textDecoration: 'none',
  font: 'inherit',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
};

/** Queue pending-count badge (shared by desktop tabs and the mobile menu rows). */
function QueueBadge({ count }: { count: number }) {
  return (
    <span
      style={{
        fontSize: 11.5,
        fontWeight: 600,
        background: 'var(--acc)',
        color: '#fff',
        borderRadius: 99,
        padding: '1px 7px',
      }}
    >
      {count}
    </span>
  );
}

export default function Nav() {
  const {
    session,
    role,
    companies,
    activeCompany,
    setActiveCompany,
    pendingCount,
    dryRun,
    theme,
    toggleTheme,
    toast,
    signOut,
  } = useApp();
  const navigate = useNavigate();

  const [coMenu, setCoMenu] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia('(max-width: 640px)').matches,
  );

  // ---- responsive flag (same pattern as Queue/Dashboard); leaving mobile closes the menu ----
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const fn = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
      if (!e.matches) setMobileMenu(false);
    };
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);

  // Close dropdowns and the mobile menu on outside click and Esc.
  useEffect(() => {
    if (!coMenu && !userMenu && !mobileMenu) return;
    const close = () => {
      setCoMenu(false);
      setUserMenu(false);
      setMobileMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [coMenu, userMenu, mobileMenu]);

  if (!session) return null;
  const tabs = tabsForRole(role);
  // Company admin of the ACTIVE company (instance admins qualify everywhere).
  const isCompanyAdmin = role === 'admin';
  const stop = (e: MouseEvent) => e.stopPropagation();

  const dryRunPill = dryRun && (
    <button
      // Only company admins can open /settings — for everyone else the pill is informational.
      onClick={isCompanyAdmin ? () => navigate('/settings') : undefined}
      data-tip="Dry-run is on — nothing is written to QuickBooks"
      data-tip-pos="down"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 13,
        fontWeight: 600,
        color: 'var(--amT)',
        background: 'var(--amB)',
        border: '1px solid var(--amD)',
        padding: '4px 10px',
        borderRadius: 99,
        cursor: isCompanyAdmin ? 'pointer' : 'default',
      }}
    >
      ◦ Dry run
    </button>
  );

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '8px 26px',
        padding: '8px clamp(14px,3vw,32px)',
        minHeight: 60,
        boxSizing: 'border-box',
        borderBottom: '1px solid var(--bd)',
        background: 'var(--sur)',
        position: 'sticky',
        top: 0,
        zIndex: 20,
      }}
    >
      {/* logo */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 2, fontFamily: "'Spectral',serif" }}>
        <span style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-.01em' }}>Recat</span>
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'var(--acc)',
            display: 'inline-block',
            marginLeft: 3,
          }}
        />
      </div>

      {/* tabs (desktop only) */}
      {!isMobile && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, fontSize: 14.5, fontWeight: 500 }}>
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.to === '/'}
              style={({ isActive }) => ({
                ...tabBase,
                background: isActive ? 'var(--hl)' : 'transparent',
                color: isActive ? 'var(--ink)' : 'var(--mut)',
              })}
            >
              {t.label}
              {t.label === 'Queue' && <QueueBadge count={pendingCount} />}
            </NavLink>
          ))}
        </div>
      )}

      {/* right side */}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
        {dryRunPill}

        {isMobile ? (
          /* hamburger (mobile only) — everything else lives in the menu panel */
          <button
            aria-label="Menu"
            onClick={(e) => {
              e.stopPropagation();
              setMobileMenu((v) => !v);
            }}
            className="hov-ink"
            style={{
              border: '1px solid var(--bd)',
              background: 'var(--card)',
              color: 'var(--mut)',
              borderRadius: 7,
              width: 32,
              height: 32,
              cursor: 'pointer',
              fontSize: 15,
            }}
          >
            ☰
          </button>
        ) : (
          <>
            <button
              onClick={toggleTheme}
              data-tip="Toggle theme" data-tip-pos="down"
              className="hov-ink"
              style={{
                border: '1px solid var(--bd)',
                background: 'var(--card)',
                color: 'var(--mut)',
                borderRadius: 7,
                width: 32,
                height: 32,
                cursor: 'pointer',
                fontSize: 14,
              }}
            >
              {theme === 'light' ? '☾' : '☀'}
            </button>

            {/* company switcher */}
            <span style={{ position: 'relative' }}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setCoMenu((v) => !v);
                  setUserMenu(false);
                }}
                className="hov-hl"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 14,
                  border: '1px solid var(--bd)',
                  borderRadius: 7,
                  padding: '6px 12px',
                  background: 'var(--card)',
                  color: 'var(--ink)',
                  cursor: 'pointer',
                  font: 'inherit',
                }}
              >
                {activeCompany?.nickname ?? '—'}{' '}
                <span style={{ color: 'var(--fnt)', fontSize: 11 }}>▾</span>
              </button>
              {coMenu && (
                <span
                  onClick={stop}
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: 'calc(100% + 8px)',
                    width: 270,
                    background: 'var(--card)',
                    border: '1px solid var(--bd)',
                    borderRadius: 10,
                    boxShadow: 'var(--sh)',
                    overflow: 'hidden',
                    display: 'block',
                    zIndex: 30,
                  }}
                >
                  {companies.map((co) => {
                    const active = co.id === activeCompany?.id;
                    return (
                      <button
                        key={co.id}
                        onClick={() => {
                          setActiveCompany(co.id);
                          setCoMenu(false);
                          toast(`Switched to ${co.nickname}`);
                        }}
                        className="hov-hl"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 11,
                          width: '100%',
                          textAlign: 'left',
                          border: 'none',
                          cursor: 'pointer',
                          padding: '11px 14px',
                          font: 'inherit',
                          background: active ? 'var(--hl)' : 'transparent',
                          color: 'var(--ink)',
                        }}
                      >
                        <span
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: 7,
                            background: 'var(--acc)',
                            color: '#fff',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 12,
                            fontWeight: 600,
                          }}
                        >
                          {co.nickname.charAt(0).toUpperCase()}
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'block', fontSize: 14, fontWeight: 600 }}>
                            {co.nickname}
                          </span>
                          <span
                            style={{
                              display: 'block',
                              fontSize: 12,
                              color: 'var(--fnt)',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {co.legalName}
                          </span>
                        </span>
                        {active && <span style={{ color: 'var(--okT)', fontWeight: 600 }}>✓</span>}
                      </button>
                    );
                  })}
                  {session.isInstanceAdmin && (
                    <button
                      onClick={() => {
                        setCoMenu(false);
                        navigate('/connect');
                      }}
                      className="hov-hl"
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        border: 'none',
                        borderTop: '1px solid var(--bd2)',
                        background: 'none',
                        padding: '11px 14px',
                        fontSize: 13.5,
                        fontWeight: 600,
                        color: 'var(--acc)',
                        cursor: 'pointer',
                        font: 'inherit',
                      }}
                    >
                      ＋ Connect another company
                    </button>
                  )}
                </span>
              )}
            </span>

            {/* avatar menu */}
            <span style={{ position: 'relative' }}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setUserMenu((v) => !v);
                  setCoMenu(false);
                }}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  background: 'var(--acc)',
                  color: '#fff',
                  border: 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {userInitials(session)}
              </button>
              {userMenu && (
                <span
                  onClick={stop}
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: 'calc(100% + 8px)',
                    width: 200,
                    background: 'var(--card)',
                    border: '1px solid var(--bd)',
                    borderRadius: 10,
                    boxShadow: 'var(--sh)',
                    overflow: 'hidden',
                    display: 'block',
                    zIndex: 30,
                  }}
                >
                  <span style={{ display: 'block', padding: '12px 16px 8px', borderBottom: '1px solid var(--bd2)' }}>
                    <span style={{ display: 'block', fontSize: 14, fontWeight: 600 }}>
                      {session.name ?? session.email}
                    </span>
                    <span style={{ display: 'block', fontSize: 12.5, color: 'var(--fnt)' }}>
                      {session.isInstanceAdmin ? 'instance admin' : (role ?? 'no access')} · {session.email}
                    </span>
                  </span>
                  <button
                    onClick={() => {
                      setUserMenu(false);
                      void signOut().then(() => navigate('/login'));
                    }}
                    className="hov-hl"
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      border: 'none',
                      background: 'none',
                      padding: '11px 16px',
                      fontSize: 14,
                      color: 'var(--erT)',
                      cursor: 'pointer',
                      font: 'inherit',
                    }}
                  >
                    Sign out
                  </button>
                </span>
              )}
            </span>
          </>
        )}
      </div>

      {/* mobile menu panel — full-width, anchored under the sticky bar */}
      {isMobile && mobileMenu && (
        <div
          onClick={stop}
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            background: 'var(--card)',
            borderBottom: '1px solid var(--bd)',
            boxShadow: 'var(--sh)',
            zIndex: 30,
          }}
        >
          {/* nav items (same role gating as the desktop tabs) */}
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.to === '/'}
              onClick={() => setMobileMenu(false)}
              style={({ isActive }) => ({
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                padding: '12px 18px',
                fontSize: 14.5,
                fontWeight: 500,
                textDecoration: 'none',
                background: isActive ? 'var(--hl)' : 'transparent',
                color: isActive ? 'var(--ink)' : 'var(--mut)',
              })}
            >
              {t.label}
              {t.label === 'Queue' && <QueueBadge count={pendingCount} />}
            </NavLink>
          ))}

          {/* companies */}
          <div style={{ borderTop: '1px solid var(--bd2)' }}>
            {companies.map((co) => {
              const active = co.id === activeCompany?.id;
              return (
                <button
                  key={co.id}
                  onClick={() => {
                    setActiveCompany(co.id);
                    setMobileMenu(false);
                    toast(`Switched to ${co.nickname}`);
                  }}
                  className="hov-hl"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 11,
                    width: '100%',
                    textAlign: 'left',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '11px 18px',
                    font: 'inherit',
                    background: active ? 'var(--hl)' : 'transparent',
                    color: 'var(--ink)',
                  }}
                >
                  <span
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 7,
                      background: 'var(--acc)',
                      color: '#fff',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    {co.nickname.charAt(0).toUpperCase()}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 14, fontWeight: 600 }}>
                      {co.nickname}
                    </span>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 12,
                        color: 'var(--fnt)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {co.legalName}
                    </span>
                  </span>
                  {active && <span style={{ color: 'var(--okT)', fontWeight: 600 }}>✓</span>}
                </button>
              );
            })}
            {session.isInstanceAdmin && (
              <button
                onClick={() => {
                  setMobileMenu(false);
                  navigate('/connect');
                }}
                className="hov-hl"
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  border: 'none',
                  background: 'none',
                  padding: '11px 18px',
                  fontSize: 13.5,
                  fontWeight: 600,
                  color: 'var(--acc)',
                  cursor: 'pointer',
                  font: 'inherit',
                }}
              >
                ＋ Connect another company
              </button>
            )}
          </div>

          {/* theme toggle */}
          <button
            onClick={toggleTheme}
            className="hov-hl"
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              border: 'none',
              borderTop: '1px solid var(--bd2)',
              background: 'none',
              padding: '12px 18px',
              fontSize: 14.5,
              fontWeight: 500,
              color: 'var(--mut)',
              cursor: 'pointer',
              font: 'inherit',
            }}
          >
            {theme === 'light' ? '☾ Dark mode' : '☀ Light mode'}
          </button>

          {/* user */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 11,
              padding: '12px 18px 8px',
              borderTop: '1px solid var(--bd2)',
            }}
          >
            <span
              style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: 'var(--acc)',
                color: '#fff',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 13,
                fontWeight: 600,
                flex: 'none',
              }}
            >
              {userInitials(session)}
            </span>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 14, fontWeight: 600 }}>
                {session.name ?? session.email}
              </span>
              <span
                style={{
                  display: 'block',
                  fontSize: 12.5,
                  color: 'var(--fnt)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {session.isInstanceAdmin ? 'instance admin' : (role ?? 'no access')} · {session.email}
              </span>
            </span>
          </div>
          <button
            onClick={() => {
              setMobileMenu(false);
              void signOut().then(() => navigate('/login'));
            }}
            className="hov-hl"
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              border: 'none',
              background: 'none',
              padding: '11px 18px',
              fontSize: 14,
              color: 'var(--erT)',
              cursor: 'pointer',
              font: 'inherit',
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
