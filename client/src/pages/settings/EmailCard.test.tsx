import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InstanceSettingsDto } from '@recat/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  patch: vi.fn(),
  testEmail: vi.fn(),
  onSettings: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  instanceSettings: {
    patch: mocks.patch,
    testEmail: mocks.testEmail,
  },
}));

vi.mock('../../state/AppContext', () => ({
  useApp: () => ({ toast: mocks.toast }),
}));

import EmailCard from './EmailCard';

const SETTINGS: InstanceSettingsDto = {
  intuitClientId: '',
  intuitClientSecretSet: false,
  redirectUri: 'https://recat.example/auth/qbo/callback',
  webhookVerifierTokenSet: false,
  suggestionSource: 'builtin',
  suggestionProvider: 'custom',
  suggestionModel: 'gpt-4o-mini',
  codexModel: 'gpt-5.6-luna',
  aiEndpoint: null,
  aiKeySet: false,
  openrouterKeySet: false,
  openrouterReferer: '',
  openrouterTitle: '',
  needsSetup: false,
  smtpHost: 'smtp.resend.com',
  smtpPort: 587,
  smtpUser: 'resend',
  smtpFrom: 'Recat <noreply@example.com>',
  smtpPassSet: true,
  smtpConfigured: true,
  smtpFromEnv: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.patch.mockResolvedValue(SETTINGS);
  mocks.testEmail.mockResolvedValue({ delivered: true, to: 'admin@example.com' });
});

describe('EmailCard connection status', () => {
  it('shows Connected only after a delivered test email and resets when settings change', async () => {
    const user = userEvent.setup();
    render(<EmailCard settings={SETTINGS} onSettings={mocks.onSettings} />);

    expect(screen.getByRole('status')).toHaveTextContent('Not tested');
    await user.click(screen.getByRole('button', { name: 'Send test email' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('✓ Connected'));
    expect(mocks.testEmail).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith(
      'Test email sent to admin@example.com — check the inbox',
    );

    await user.clear(screen.getByLabelText('SMTP host'));
    expect(screen.getByRole('status')).toHaveTextContent('Not configured');
  });

  it('shows a failed state when the SMTP probe rejects', async () => {
    mocks.testEmail.mockRejectedValue(new Error('SMTP authentication failed'));
    const user = userEvent.setup();
    render(<EmailCard settings={SETTINGS} onSettings={mocks.onSettings} />);

    await user.click(screen.getByRole('button', { name: 'Send test email' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Connection failed'));
    expect(mocks.toast).toHaveBeenCalledWith('SMTP authentication failed');
  });

  it('keeps the successful state after saving pending SMTP edits before the probe', async () => {
    const user = userEvent.setup();
    render(<EmailCard settings={SETTINGS} onSettings={mocks.onSettings} />);

    await user.type(screen.getByLabelText('Password'), 'new-api-key');
    await user.click(screen.getByRole('button', { name: 'Send test email' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('✓ Connected'));
    expect(mocks.patch).toHaveBeenCalledWith({ smtpPass: 'new-api-key' });
    expect(mocks.patch.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.testEmail.mock.invocationCallOrder[0] as number,
    );
  });

  it('does not call an undelivered log-only test Connected', async () => {
    mocks.testEmail.mockResolvedValue({ delivered: false, to: 'admin@example.com' });
    const user = userEvent.setup();
    render(<EmailCard settings={SETTINGS} onSettings={mocks.onSettings} />);

    await user.click(screen.getByRole('button', { name: 'Send test email' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Not configured'));
    expect(screen.queryByText('✓ Connected')).not.toBeInTheDocument();
  });
});
