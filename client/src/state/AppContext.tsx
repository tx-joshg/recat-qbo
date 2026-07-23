// Global app state: session, companies, active company, per-company reference
// data (accounts/tags), pending count, theme, and the single toast.
// Renders children inside the `.rr` themed scope div.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import type {
  CompanyDto,
  CompanyPatchBody,
  QboAccountDto,
  QboTaxCodeDto,
  QboTaxProfileDto,
  Role,
  TagDto,
  UserDto,
} from '@recat/shared';
import { roleFor } from '@recat/shared';
import {
  auth,
  companies as companiesApi,
  tags as tagsApi,
  tax as taxApi,
  transactions as txnApi,
} from '../lib/api';

export type Theme = 'light' | 'dark';

export interface ActiveToast {
  id: number;
  msg: string;
}

export interface AppContextValue {
  /** null while signed out; see sessionLoading for the initial fetch. */
  session: UserDto | null;
  sessionLoading: boolean;
  /** Set after a successful magic-link sign-in (login page / auth callback). */
  setSession: (user: UserDto | null) => void;
  signOut: () => Promise<void>;
  /**
   * Effective role for the ACTIVE company (instance admins are 'admin'
   * everywhere); null while signed out or with no active company membership.
   */
  role: Role | null;

  companies: CompanyDto[];
  refreshCompanies: () => Promise<void>;
  activeCompanyId: string | null;
  activeCompany: CompanyDto | null;
  setActiveCompany: (id: string) => void;
  /** PATCH the active company and merge the result into local state. */
  updateCompany: (patch: CompanyPatchBody) => Promise<void>;
  /** Convenience mirrors of activeCompany flags (false when no company). */
  dryRun: boolean;
  tagsRequired: boolean;

  /** Chart of accounts + tags for the active company (refetched on switch). */
  accounts: QboAccountDto[];
  tags: TagDto[];
  refreshAccounts: () => Promise<void>;
  refreshTags: () => Promise<void>;
  taxProfile: QboTaxProfileDto | null;
  taxCodes: QboTaxCodeDto[];
  refreshTax: () => Promise<void>;

  /** PENDING txn count for the active company — the Queue tab badge. */
  pendingCount: number;
  setPendingCount: (n: number) => void;
  refreshPendingCount: () => Promise<void>;

  theme: Theme;
  toggleTheme: () => void;

  /** Row density — maps to the prototype's `.rr[data-density]` CSS vars. */
  density: Density;
  setDensity: (d: Density) => void;

  /** Show the single bottom-center toast for 2.6s (replaces any current one). */
  toast: (msg: string) => void;
  /** Current toast, consumed by <Toast />. */
  activeToast: ActiveToast | null;
}

const THEME_KEY = 'recat.theme';
const COMPANY_KEY = 'recat.activeCompany';
const DENSITY_KEY = 'recat.density';

export type Density = 'comfortable' | 'compact';

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<UserDto | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);

  const [companies, setCompanies] = useState<CompanyDto[]>([]);
  const [activeCompanyId, setActiveCompanyIdState] = useState<string | null>(
    () => localStorage.getItem(COMPANY_KEY),
  );

  const [accounts, setAccounts] = useState<QboAccountDto[]>([]);
  const [tags, setTags] = useState<TagDto[]>([]);
  const [taxProfile, setTaxProfile] = useState<QboTaxProfileDto | null>(null);
  const [taxCodes, setTaxCodes] = useState<QboTaxCodeDto[]>([]);
  const [pendingCount, setPendingCount] = useState(0);

  const [theme, setTheme] = useState<Theme>(() =>
    localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light',
  );

  const [activeToast, setActiveToast] = useState<ActiveToast | null>(null);
  const toastTimer = useRef<number | null>(null);
  const toastSeq = useRef(0);

  // ---- session (initial fetch) ----
  useEffect(() => {
    let cancelled = false;
    auth
      .session()
      .then((s) => {
        if (!cancelled) setSession(s.user);
      })
      .catch(() => {
        if (!cancelled) setSession(null);
      })
      .finally(() => {
        if (!cancelled) setSessionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- companies ----
  const refreshCompanies = useCallback(async () => {
    const list = await companiesApi.list();
    setCompanies(list);
  }, []);

  useEffect(() => {
    if (!session) {
      setCompanies([]);
      return;
    }
    refreshCompanies().catch(() => {
      // leave companies empty; screens surface their own errors
    });
  }, [session, refreshCompanies]);

  // Reconcile the persisted active company against the fetched list.
  useEffect(() => {
    if (companies.length === 0) return;
    if (activeCompanyId === null || !companies.some((c) => c.id === activeCompanyId)) {
      const first = companies[0];
      if (first) {
        setActiveCompanyIdState(first.id);
        localStorage.setItem(COMPANY_KEY, first.id);
      }
    }
  }, [companies, activeCompanyId]);

  const setActiveCompany = useCallback((id: string) => {
    setActiveCompanyIdState(id);
    localStorage.setItem(COMPANY_KEY, id);
  }, []);

  const activeCompany = useMemo(
    () => companies.find((c) => c.id === activeCompanyId) ?? null,
    [companies, activeCompanyId],
  );

  const role = useMemo<Role | null>(
    () => (session ? roleFor(session, activeCompanyId) : null),
    [session, activeCompanyId],
  );

  const updateCompany = useCallback(
    async (patch: CompanyPatchBody) => {
      if (!activeCompanyId) return;
      const updated = await companiesApi.patch(activeCompanyId, patch);
      setCompanies((prev) => prev.map((c) => (c.id === activeCompanyId ? updated : c)));
    },
    [activeCompanyId],
  );

  // ---- per-company reference data ----
  // Guards against a slow response from company A landing after a switch to
  // company B (or after sign-out) and poisoning accounts/tags/pendingCount:
  // each fetch captures the companyId it started for and its result is dropped
  // unless that id is still the live one at resolution time.
  const refDataCompanyRef = useRef<string | null>(null);

  const refreshAccounts = useCallback(async () => {
    const cid = activeCompanyId;
    if (!cid) return;
    const list = await companiesApi.accounts(cid);
    if (refDataCompanyRef.current === cid) setAccounts(list);
  }, [activeCompanyId]);

  const refreshTags = useCallback(async () => {
    const cid = activeCompanyId;
    if (!cid) return;
    const list = await tagsApi.list(cid);
    if (refDataCompanyRef.current === cid) setTags(list);
  }, [activeCompanyId]);

  const refreshTax = useCallback(async () => {
    const cid = activeCompanyId;
    if (!cid) return;
    const [profile, codes] = await Promise.all([taxApi.profile(cid), taxApi.codes(cid)]);
    if (refDataCompanyRef.current === cid) {
      setTaxProfile(profile);
      setTaxCodes(codes);
    }
  }, [activeCompanyId]);

  const refreshPendingCount = useCallback(async () => {
    const cid = activeCompanyId;
    if (!cid) return;
    const res = await txnApi.list(cid, { status: 'PENDING', countOnly: true });
    if (refDataCompanyRef.current === cid) setPendingCount(res.pendingCount);
  }, [activeCompanyId]);

  useEffect(() => {
    if (!session || !activeCompanyId) {
      refDataCompanyRef.current = null;
      setAccounts([]);
      setTags([]);
      setTaxProfile(null);
      setTaxCodes([]);
      setPendingCount(0);
      return;
    }
    refDataCompanyRef.current = activeCompanyId;
    setAccounts([]);
    setTags([]);
    setTaxProfile(null);
    setTaxCodes([]);
    const swallow = () => {
      // screens surface their own errors; the shell just stays empty
    };
    refreshAccounts().catch(swallow);
    refreshTags().catch(swallow);
    refreshTax().catch(swallow);
    refreshPendingCount().catch(swallow);
  }, [session, activeCompanyId, refreshAccounts, refreshTags, refreshTax, refreshPendingCount]);

  // ---- theme ----
  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next: Theme = t === 'light' ? 'dark' : 'light';
      localStorage.setItem(THEME_KEY, next);
      return next;
    });
  }, []);

  // ---- density (comfortable default, per prototype) ----
  const [density, setDensityState] = useState<Density>(() =>
    localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable',
  );
  const setDensity = useCallback((d: Density) => {
    localStorage.setItem(DENSITY_KEY, d);
    setDensityState(d);
  }, []);

  // ---- toast (single, 2.6s, matches prototype) ----
  const toast = useCallback((msg: string) => {
    toastSeq.current += 1;
    setActiveToast({ id: toastSeq.current, msg });
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setActiveToast(null), 2600);
  }, []);

  // ---- sign out ----
  const signOut = useCallback(async () => {
    try {
      await auth.logout();
    } catch {
      // clear the client session regardless
    }
    refDataCompanyRef.current = null;
    setSession(null);
    setCompanies([]);
    setAccounts([]);
    setTags([]);
    setTaxProfile(null);
    setTaxCodes([]);
    setPendingCount(0);
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({
      session,
      sessionLoading,
      setSession,
      signOut,
      role,
      companies,
      refreshCompanies,
      activeCompanyId,
      activeCompany,
      setActiveCompany,
      updateCompany,
      dryRun: activeCompany?.dryRun ?? false,
      tagsRequired: activeCompany?.tagsRequired ?? false,
      accounts,
      tags,
      refreshAccounts,
      refreshTags,
      taxProfile,
      taxCodes,
      refreshTax,
      pendingCount,
      setPendingCount,
      refreshPendingCount,
      theme,
      toggleTheme,
      density,
      setDensity,
      toast,
      activeToast,
    }),
    [
      session,
      sessionLoading,
      signOut,
      role,
      companies,
      refreshCompanies,
      activeCompanyId,
      activeCompany,
      setActiveCompany,
      updateCompany,
      accounts,
      tags,
      refreshAccounts,
      refreshTags,
      taxProfile,
      taxCodes,
      refreshTax,
      pendingCount,
      refreshPendingCount,
      theme,
      toggleTheme,
      density,
      setDensity,
      toast,
      activeToast,
    ],
  );

  return (
    <AppContext.Provider value={value}>
      <div
        className="rr"
        data-theme={theme}
        data-density={density}
        style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--ink)', fontSize: 15 }}
      >
        {children}
      </div>
    </AppContext.Provider>
  );
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}
