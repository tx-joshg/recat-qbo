import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_REALM_IDS } from '@recat/shared';
import type { CompanyDto, InstanceSettingsDto } from '@recat/shared';

const mocks = vi.hoisted(() => ({ patch: vi.fn(), testQbo: vi.fn(), toast: vi.fn(), company: null as CompanyDto | null }));
vi.mock('../../lib/api', () => ({ instanceSettings: { patch: mocks.patch, testQbo: mocks.testQbo } }));
vi.mock('../../state/AppContext', () => ({ useApp: () => ({ toast: mocks.toast, activeCompany: mocks.company }) }));
import ApiAccessCard from './ApiAccessCard';

const settings: InstanceSettingsDto = {
  appUrl: 'https://recat.example', appUrlEnvManaged: false,
  intuitClientId: 'synthetic-client', intuitClientSecretSet: true,
  redirectUri: 'https://recat.example/auth/qbo/callback', webhookUrl: 'https://recat.example/webhooks', webhookVerifierTokenSet: false,
  suggestionSource: 'off', suggestionProvider: 'custom', suggestionModel: '',
  agentDecisionModel: '', agentVerifierModel: '', aiEndpoint: null, aiKeySet: false,
  openrouterKeySet: false, openrouterReferer: '', openrouterTitle: '', needsSetup: false,
  smtpHost: '', smtpPort: 587, smtpUser: '', smtpFrom: '', smtpPassSet: false, smtpConfigured: false, smtpFromEnv: false,
};
const company: CompanyDto = {
  id: 'company-a', realmId: 'synthetic-realm', legalName: 'Example Company', nickname: 'Example',
  env: 'sandbox', syncMode: 'polling', pollIntervalMin: 30, holdingAccountIds: [], dryRun: true,
  tagsRequired: false, retainAttachmentFiles: false, connectedAt: '2025-01-01T00:00:00Z',
  disconnectedAt: null, lastSyncedAt: null,
};
function Card({ initial = settings }: { initial?: InstanceSettingsDto }) {
  const [saved, setSaved] = useState(initial);
  return <ApiAccessCard settings={saved} onSettings={setSaved} syncMode="polling" lastWebhookEventAt={null} />;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.company = { ...company };
  mocks.testQbo.mockResolvedValue({ ok: true });
  mocks.patch.mockImplementation(async (body) => ({ ...settings, ...body, intuitClientSecretSet: true }));
});

describe('saved QuickBooks credential diagnostic', () => {
  it('tests the selected company and keeps a successful result visible', async () => {
    render(<Card />);
    expect(screen.getByText('Stored secret')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Credentials verified'));
    expect(mocks.testQbo).toHaveBeenCalledExactlyOnceWith('company-a');
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it('requires saving credential edits before testing and leaves saved credentials untested', async () => {
    render(<Card />);
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'synthetic-replacement' } });
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Save changes before testing');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled());
    expect(mocks.patch).toHaveBeenCalledWith({ intuitClientSecret: 'synthetic-replacement' });
    expect(screen.getByRole('status')).toHaveTextContent('Not tested');
    expect(mocks.testQbo).not.toHaveBeenCalled();
  });

  it('reports an empty client ID instead of silently ignoring the edit', async () => {
    render(<Card />);
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: ' ' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Client ID');
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
  });

  it('blocks duplicate tests, saves and edits while testing', async () => {
    let finish!: (value: { ok: true }) => void;
    mocks.testQbo.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<Card />);
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(screen.getByRole('button', { name: 'Testing…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(screen.getByLabelText('Client ID')).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Testing…' }));
    expect(mocks.testQbo).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true }));
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled();
  });

  it('allows public URL settings to be saved before QuickBooks credentials are configured', async () => {
    render(<Card initial={{ ...settings, intuitClientId: '', intuitClientSecretSet: false }} />);
    fireEvent.change(screen.getByLabelText(/Public URL/), { target: { value: 'https://new.example' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith({ appUrl: 'https://new.example' }));
  });

  it('does not test or accept duplicate saves while a credential save is pending', async () => {
    let finish!: (value: InstanceSettingsDto) => void;
    mocks.patch.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<Card />);
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'replacement-client' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ...settings, intuitClientId: 'replacement-client' }));
    expect(mocks.testQbo).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Not tested');
  });

  it('discards a pending result after switching companies, even when switching back', async () => {
    let finish!: (value: { ok: true }) => void;
    mocks.testQbo.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const view = render(<Card />);
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    mocks.company = { ...company, id: 'company-b' };
    view.rerender(<Card />);
    mocks.company = { ...company };
    view.rerender(<Card />);
    await act(async () => finish({ ok: true }));
    expect(screen.getByRole('status')).toHaveTextContent('Not tested');
  });

  it('discards pending results when saved settings change', async () => {
    let finish!: (value: { ok: true }) => void;
    mocks.testQbo.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const props = { onSettings: vi.fn(), syncMode: 'polling' as const, lastWebhookEventAt: null };
    const view = render(<ApiAccessCard {...props} settings={settings} />);
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    view.rerender(<ApiAccessCard {...props} settings={{ ...settings, intuitClientId: 'replacement-client' }} />);
    await act(async () => finish({ ok: true }));
    expect(screen.getByRole('status')).not.toHaveTextContent('Credentials verified');
  });

  it('shows a safe persistent failure and allows retry without rendering arbitrary error text', async () => {
    mocks.testQbo.mockRejectedValueOnce(new Error('synthetic-private-provider-body'));
    render(<Card />);
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Connection failed'));
    expect(document.body).not.toHaveTextContent('synthetic-private-provider-body');
    expect(mocks.toast).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Credentials verified'));
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'edited-client' } });
    expect(screen.getByRole('status')).not.toHaveTextContent('Credentials verified');
  });

  it.each([null, { ...company, disconnectedAt: '2025-01-02T00:00:00Z' }, { ...company, realmId: MOCK_REALM_IDS[0] }])(
    'does not offer a real credential test without a connected real company', (selected) => {
      mocks.company = selected;
      render(<Card />);
      expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
      expect(mocks.testQbo).not.toHaveBeenCalled();
    },
  );
});
