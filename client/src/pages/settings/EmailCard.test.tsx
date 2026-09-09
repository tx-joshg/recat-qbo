import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceSettingsDto } from '@recat/shared';

const mocks = vi.hoisted(() => ({ patch: vi.fn(), testEmail: vi.fn(), toast: vi.fn() }));
vi.mock('../../lib/api', () => ({ instanceSettings: { patch: mocks.patch, testEmail: mocks.testEmail } }));
vi.mock('../../state/AppContext', () => ({ useApp: () => ({ toast: mocks.toast }) }));
import EmailCard from './EmailCard';

const settings: InstanceSettingsDto = {
  appUrl: 'https://recat.example', appUrlEnvManaged: false,
  intuitClientId: '', intuitClientSecretSet: false,
  redirectUri: 'https://recat.example/callback', webhookUrl: 'https://recat.example/webhooks', webhookVerifierTokenSet: false,
  suggestionSource: 'off', suggestionProvider: 'custom', suggestionModel: '',
  agentDecisionModel: '', agentVerifierModel: '', aiEndpoint: null, aiKeySet: false,
  openrouterKeySet: false, openrouterReferer: '', openrouterTitle: '', needsSetup: false,
  smtpHost: 'smtp.example.com', smtpPort: 587, smtpUser: 'operator@example.com',
  smtpFrom: 'sender@example.com', smtpPassSet: true, smtpConfigured: true, smtpFromEnv: false,
};

function show(overrides: Partial<InstanceSettingsDto> = {}) {
  return render(<EmailCard settings={{ ...settings, ...overrides }} onSettings={vi.fn()} />);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.patch.mockImplementation(async (body) => ({ ...settings, ...body }));
  mocks.testEmail.mockResolvedValue({ delivered: true, to: 'operator@example.com' });
});

describe('EmailCard SMTP probe', () => {
  it('saves pending settings before sending the test email', async () => {
    let save!: (value: InstanceSettingsDto) => void;
    mocks.patch.mockReturnValue(new Promise<InstanceSettingsDto>((resolve) => { save = resolve; }));
    show();
    fireEvent.change(screen.getByPlaceholderText('smtp.example.com'), { target: { value: 'smtp.changed.example' } });
    await userEvent.click(screen.getByRole('button', { name: 'Send test email' }));
    expect(mocks.patch).toHaveBeenCalledWith({ smtpHost: 'smtp.changed.example' });
    expect(mocks.testEmail).not.toHaveBeenCalled();
    await act(async () => save({ ...settings, smtpHost: 'smtp.changed.example' }));
    await waitFor(() => expect(mocks.testEmail).toHaveBeenCalledTimes(1));
  });

  it('shows an announced delivered status that remains visible after the request finishes', async () => {
    show();
    expect(screen.getByRole('status')).toHaveTextContent('Not tested');
    await userEvent.click(screen.getByRole('button', { name: 'Send test email' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Connected'));
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('button', { name: 'Send test email' })).toBeEnabled();
  });

  it.each([
    ['SMTP host', 'smtp.changed.example'], ['Port', '465'],
    ['Username', 'changed@example.com'], ['Password', 'synthetic-password'],
    ['From address', 'changed@example.com'],
  ])('resets delivered status when %s is edited using its accessible label', async (label, value) => {
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Send test email' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Connected'));
    fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });
    expect(screen.getByRole('status')).toHaveTextContent('Not tested');
  });

  it('resets status when a provider preset is selected or the SMTP host is cleared', async () => {
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Send test email' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Connected'));
    await userEvent.click(screen.getByRole('button', { name: 'Resend' }));
    expect(screen.getByRole('status')).toHaveTextContent('Not tested');
    fireEvent.change(screen.getByLabelText('SMTP host'), { target: { value: '' } });
    expect(screen.getByRole('status')).toHaveTextContent('Not configured');
  });

  it('never marks a log-only test as connected', async () => {
    mocks.testEmail.mockResolvedValue({ delivered: false, to: 'operator@example.com' });
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Send test email' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Not configured'));
    expect(screen.getByRole('status')).not.toHaveTextContent('Connected');
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('server log'));
  });

  it('shows a failed test and allows a successful retry', async () => {
    mocks.testEmail.mockRejectedValueOnce(new Error('Synthetic SMTP failure'));
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Send test email' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Connection failed'));
    expect(screen.getByRole('button', { name: 'Send test email' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Send test email' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Connected'));
  });

  it('locks save, repeat test, and draft edits while the probe is pending', async () => {
    let finish!: (value: { delivered: boolean; to: string }) => void;
    mocks.testEmail.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    show();
    await userEvent.click(screen.getByRole('button', { name: 'Send test email' }));
    expect(screen.getByRole('status')).toHaveTextContent('Testing connection');
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(screen.getByLabelText('SMTP host')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Resend' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(mocks.patch).not.toHaveBeenCalled();
    await act(async () => finish({ delivered: true, to: 'operator@example.com' }));
    expect(screen.getByRole('status')).toHaveTextContent('Connected');
    expect(screen.getByLabelText('SMTP host')).toBeEnabled();
  });

  it('disables testing during a save and leaves newly saved settings untested', async () => {
    let save!: (value: InstanceSettingsDto) => void;
    mocks.patch.mockReturnValue(new Promise<InstanceSettingsDto>((resolve) => { save = resolve; }));
    show();
    fireEvent.change(screen.getByLabelText('SMTP host'), { target: { value: 'smtp.changed.example' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByRole('button', { name: 'Send test email' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Send test email' }));
    expect(mocks.testEmail).not.toHaveBeenCalled();
    await act(async () => save({ ...settings, smtpHost: 'smtp.changed.example' }));
    expect(screen.getByRole('status')).toHaveTextContent('Not tested');
    expect(screen.getByRole('button', { name: 'Send test email' })).toBeEnabled();
  });

  it('does not send a probe when saving its draft fails', async () => {
    mocks.patch.mockRejectedValue(new Error('Synthetic save failure'));
    show();
    fireEvent.change(screen.getByLabelText('SMTP host'), { target: { value: 'smtp.changed.example' } });
    await userEvent.click(screen.getByRole('button', { name: 'Send test email' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Connection failed'));
    expect(mocks.testEmail).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send test email' })).toBeEnabled();
  });

  it('tests environment-managed SMTP without saving database settings', async () => {
    show({ smtpFromEnv: true });
    await userEvent.click(screen.getByRole('button', { name: 'Send test email' }));
    await waitFor(() => expect(mocks.testEmail).toHaveBeenCalledTimes(1));
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
  });
});
