import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  methods: vi.fn(),
  local: vi.fn(),
  setupStatus: vi.fn(),
  navigate: vi.fn(),
  setSession: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mocks.navigate, Link: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> };
});

vi.mock('../state/AppContext', () => ({
  useApp: () => ({
    session: null,
    sessionLoading: false,
    setSession: mocks.setSession,
    toast: mocks.toast,
  }),
}));

vi.mock('../lib/api', () => ({
  auth: { methods: mocks.methods, local: mocks.local },
  api: {
    get: mocks.setupStatus,
    post: vi.fn(),
  },
}));

import Login from './Login';

const USER = {
  id: 'u1',
  email: 'admin@example.com',
  name: null,
  isInstanceAdmin: true,
  invitePending: false,
  memberships: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.methods.mockResolvedValue({ localAdmin: true });
  mocks.setupStatus.mockResolvedValue({ needsSetup: false });
  mocks.local.mockResolvedValue({ user: USER });
});

describe('Login local administrator mode', () => {
  it('keeps local admin access hidden after disabled-method discovery resolves', async () => {
    const methods = deferred<{ localAdmin: boolean }>();
    mocks.methods.mockReturnValue(methods.promise);
    render(<Login />);
    await waitFor(() => expect(mocks.methods).toHaveBeenCalled());
    await act(async () => {
      methods.resolve({ localAdmin: false });
      await methods.promise;
    });
    expect(screen.queryByRole('button', { name: /local admin access/i })).not.toBeInTheDocument();
  });

  it('keeps local admin access hidden when method discovery fails', async () => {
    const methods = deferred<{ localAdmin: boolean }>();
    mocks.methods.mockReturnValue(methods.promise);
    render(<Login />);
    await waitFor(() => expect(mocks.methods).toHaveBeenCalled());
    await act(async () => {
      methods.reject(new Error('Discovery unavailable'));
      await methods.promise.catch(() => undefined);
    });
    expect(screen.queryByRole('button', { name: /local admin access/i })).not.toBeInTheDocument();
  });

  it('shows the warning, submits credentials, sets the session, and navigates', async () => {
    const user = userEvent.setup();
    render(<Login />);
    await user.click(await screen.findByRole('button', { name: /local admin access/i }));

    expect(screen.getByText(/use it only on a trusted network/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Admin email'), ' admin@example.com ');
    await user.type(screen.getByLabelText('Admin password'), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: /sign in as administrator/i }));

    await waitFor(() => expect(mocks.local).toHaveBeenCalledWith('admin@example.com', 'correct horse battery staple'));
    expect(mocks.setSession).toHaveBeenCalledWith(USER);
    expect(mocks.navigate).toHaveBeenCalledWith('/', { replace: true });
    expect(screen.getByLabelText('Admin password')).toHaveValue('');
  });

  it('surfaces generic authentication errors through the existing toast', async () => {
    mocks.local.mockRejectedValue(new Error('Invalid email or password'));
    const user = userEvent.setup();
    render(<Login />);
    await user.click(await screen.findByRole('button', { name: /local admin access/i }));
    await user.type(screen.getByLabelText('Admin email'), 'admin@example.com');
    await user.type(screen.getByLabelText('Admin password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: /sign in as administrator/i }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Invalid email or password'));
  });

  it('clears the password when returning to magic-link login', async () => {
    const user = userEvent.setup();
    render(<Login />);
    await user.click(await screen.findByRole('button', { name: /local admin access/i }));
    await user.type(screen.getByLabelText('Admin password'), 'temporary-secret');
    await user.click(screen.getByRole('button', { name: /use a magic link instead/i }));
    await user.click(screen.getByRole('button', { name: /local admin access/i }));
    expect(screen.getByLabelText('Admin password')).toHaveValue('');
  });

  it('prevents leaving local mode while administrator authentication is pending', async () => {
    const local = deferred<{ user: typeof USER }>();
    mocks.local.mockReturnValue(local.promise);
    const user = userEvent.setup();
    render(<Login />);
    await user.click(await screen.findByRole('button', { name: /local admin access/i }));
    await user.type(screen.getByLabelText('Admin email'), 'admin@example.com');
    await user.type(screen.getByLabelText('Admin password'), 'pending-secret');
    await user.click(screen.getByRole('button', { name: /sign in as administrator/i }));

    const backButton = screen.getByRole('button', { name: /use a magic link instead/i });
    expect(backButton).toBeDisabled();
    await user.click(backButton);
    expect(screen.getByLabelText('Admin password')).toHaveValue('pending-secret');

    await act(async () => {
      local.resolve({ user: USER });
      await local.promise;
    });
    expect(mocks.setSession).toHaveBeenCalledWith(USER);
    expect(mocks.navigate).toHaveBeenCalledWith('/', { replace: true });
  });

  it('ignores a successful local login that resolves after unmount', async () => {
    const local = deferred<{ user: typeof USER }>();
    mocks.local.mockReturnValue(local.promise);
    const user = userEvent.setup();
    const { unmount } = render(<Login />);
    await user.click(await screen.findByRole('button', { name: /local admin access/i }));
    await user.type(screen.getByLabelText('Admin email'), 'admin@example.com');
    await user.type(screen.getByLabelText('Admin password'), 'pending-secret');
    await user.click(screen.getByRole('button', { name: /sign in as administrator/i }));
    await waitFor(() => expect(mocks.local).toHaveBeenCalled());

    unmount();
    await act(async () => {
      local.resolve({ user: USER });
      await local.promise;
    });

    expect(mocks.setSession).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('ignores a failed local login that rejects after unmount', async () => {
    const local = deferred<{ user: typeof USER }>();
    mocks.local.mockReturnValue(local.promise);
    const user = userEvent.setup();
    const { unmount } = render(<Login />);
    await user.click(await screen.findByRole('button', { name: /local admin access/i }));
    await user.type(screen.getByLabelText('Admin email'), 'admin@example.com');
    await user.type(screen.getByLabelText('Admin password'), 'pending-secret');
    await user.click(screen.getByRole('button', { name: /sign in as administrator/i }));
    await waitFor(() => expect(mocks.local).toHaveBeenCalled());

    unmount();
    await act(async () => {
      local.reject(new Error('Authentication unavailable'));
      await local.promise.catch(() => undefined);
    });

    expect(mocks.setSession).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
