import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
    Link: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
  };
});

vi.mock('../state/AppContext', () => ({
  useApp: () => ({
    session: null,
    sessionLoading: false,
    setSession: vi.fn(),
    companies: [],
    refreshCompanies: vi.fn(),
    setActiveCompany: vi.fn(),
    toast: vi.fn(),
  }),
}));

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    api: { get: mocks.apiGet, post: mocks.apiPost, patch: vi.fn(), del: vi.fn() },
    auth: { session: vi.fn().mockResolvedValue(null) },
    companies: { accounts: vi.fn(), connectUrl: vi.fn(), setHoldingAccounts: vi.fn(), setSyncMode: vi.fn() },
    instanceSettings: { patch: vi.fn(), testEmail: vi.fn() },
    qboDiagnostics: { preflight: vi.fn() },
    setup: { credentials: vi.fn() },
    transactions: { sync: vi.fn() },
  };
});

import Setup from './Setup';

const BASE_STATUS = {
  needsSetup: true,
  credentialsSet: false,
  smtpConfigured: false,
  redirectUri: 'http://umbrel.local:3009/auth/qbo/callback',
  webhookUrl: 'http://umbrel.local:3009/webhooks/qbo',
};

/** Advance the wizard from Start to the Admin step. */
async function gotoAdminStep(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByText('Try the demo'));
  await user.click(screen.getByRole('button', { name: /Continue/ }));
  await screen.findByText('Create the admin account');
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mocks.apiPost.mockResolvedValue({ ok: true, delivered: false });
});

// The wizard must land on the address local sign-in authenticates. If it
// doesn't, the password an Umbrel dashboard displays belongs to no account and
// — with no SMTP for a magic link — the install is a dead end.
describe('Setup · Admin step · local sign-in address', () => {
  it('defaults the email field to the offered address', async () => {
    mocks.apiGet.mockResolvedValue({ ...BASE_STATUS, localAdminEmail: 'admin@recat.local' });
    const user = userEvent.setup();
    render(<Setup />);
    await gotoAdminStep(user);

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toHaveValue('admin@recat.local');
    });
    expect(screen.getByText(/password it shows you signs in to this account/i)).toBeInTheDocument();
  });

  // The warning must describe what actually happens. The magic link is still
  // written to the server log when SMTP is absent, and the login page points
  // users there — so this is manual recovery, not a lockout (codex on #50).
  it('describes log recovery, not a lockout, when the address is changed', async () => {
    mocks.apiGet.mockResolvedValue({ ...BASE_STATUS, localAdminEmail: 'admin@recat.local' });
    const user = userEvent.setup();
    render(<Setup />);
    await gotoAdminStep(user);
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('admin@recat.local'));

    await user.clear(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), 'me@example.com');

    const warning = await screen.findByText(/once you connect real QuickBooks/i);
    expect(warning.textContent).toMatch(/from your server's logs/i);
    expect(warning.textContent).not.toMatch(/locks you out/i);
  });

  // A transient status failure used to hide the password field permanently and
  // submit without it, spending rate-limit budget on requests that cannot
  // succeed (codex on #54).
  it('retries a failed status fetch rather than assuming no password is needed', async () => {
    mocks.apiGet
      .mockRejectedValueOnce(new Error('server starting'))
      .mockResolvedValue({ ...BASE_STATUS, localAdminEmail: 'admin@recat.local' });
    const user = userEvent.setup();
    render(<Setup />);
    await gotoAdminStep(user);

    await waitFor(() => {
      expect(screen.getByLabelText(/app password/i)).toBeInTheDocument();
    }, { timeout: 5_000 });
    expect(screen.getByRole('textbox')).toHaveValue('admin@recat.local');
  });

  // statusUnavailable only becomes true after every retry. While the request is
  // still in flight the requirement is equally unknown, and a restored email
  // makes it easy to reach Continue first (codex on #61).
  it('refuses to submit while the status request is still in flight', async () => {
    let resolveStatus: (value: unknown) => void = () => {};
    mocks.apiGet.mockReturnValue(new Promise((resolve) => { resolveStatus = resolve; }));
    sessionStorage.setItem(
      'recat.setupWizard.v3',
      JSON.stringify({ stepId: 'admin', mode: 'demo', adminEmail: 'restored@example.com' }),
    );
    const user = userEvent.setup();
    render(<Setup />);
    await screen.findByText('Create the admin account');

    await user.click(screen.getByRole('button', { name: /Continue/ }));
    expect(mocks.apiPost).not.toHaveBeenCalled();

    // Once it resolves, the same click works.
    resolveStatus({ ...BASE_STATUS });
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('restored@example.com'));
    await user.click(screen.getByRole('button', { name: /Continue/ }));
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalled());
  });

  it('leaves the field empty and shows no note when local sign-in is off', async () => {
    mocks.apiGet.mockResolvedValue({ ...BASE_STATUS });
    const user = userEvent.setup();
    render(<Setup />);
    await gotoAdminStep(user);

    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.queryByText(/password sign-in only works for/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/signs in to this account/i)).not.toBeInTheDocument();
  });

  it('never overwrites an address restored from wizard progress', async () => {
    // A magic-link or OAuth departure resumes here; the user's own choice must
    // survive it rather than being reset to the deployment default.
    sessionStorage.setItem(
      'recat.setupWizard.v3',
      JSON.stringify({ stepId: 'admin', mode: 'demo', adminEmail: 'chosen@example.com' }),
    );
    mocks.apiGet.mockResolvedValue({ ...BASE_STATUS, localAdminEmail: 'admin@recat.local' });
    render(<Setup />);

    await screen.findByText('Create the admin account');
    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalled());
    expect(screen.getByRole('textbox')).toHaveValue('chosen@example.com');
  });
});
