import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceSettingsDto } from '@recat/shared';

const mocks = vi.hoisted(() => ({ patch: vi.fn(), toast: vi.fn() }));
vi.mock('../../lib/api', () => ({ instanceSettings: { patch: mocks.patch } }));
vi.mock('../../state/AppContext', () => ({ useApp: () => ({ toast: mocks.toast }) }));

import SuggestionsCard from './SuggestionsCard';

const settings: InstanceSettingsDto = {
  appUrl: 'https://recat.example', appUrlEnvManaged: false,
  intuitClientId: '', intuitClientSecretSet: false, redirectUri: '',
  webhookUrl: '', webhookVerifierTokenSet: false,
  suggestionSource: 'ai', suggestionProvider: 'custom', suggestionModel: 'gpt-4o-mini',
  agentDecisionModel: 'gpt-4o-mini', agentVerifierModel: 'gpt-4o-mini',
  aiEndpoint: '', aiKeySet: false, openrouterKeySet: false,
  openrouterReferer: '', openrouterTitle: '', needsSetup: false,
  smtpHost: '', smtpPort: 587, smtpUser: '', smtpFrom: '',
  smtpPassSet: false, smtpConfigured: false, smtpFromEnv: false,
};
const routerSettings: InstanceSettingsDto = {
  ...settings, suggestionProvider: 'openrouter', suggestionModel: 'openai/gpt-4o-mini',
};

function Harness() {
  const [current, setCurrent] = useState(settings);
  return <SuggestionsCard settings={current} onSettings={setCurrent} />;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.patch.mockImplementation(async (patch) => ({ ...settings, ...patch }));
});

describe('SuggestionsCard model draft', () => {
  it('does not save an untouched model on blur', () => {
    render(<Harness />);
    fireEvent.blur(screen.getByDisplayValue('gpt-4o-mini'));
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it('displays the returned default after switching providers without persisting a model override', async () => {
    mocks.patch.mockResolvedValue(routerSettings);
    render(<Harness />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), { target: { value: 'openrouter' } });
    const model = await screen.findByDisplayValue('openai/gpt-4o-mini');
    fireEvent.blur(model);
    expect(mocks.patch.mock.calls).toEqual([[{ suggestionProvider: 'openrouter' }]]);
  });

  it('follows later effective model changes while pristine', async () => {
    const view = render(<SuggestionsCard settings={routerSettings} onSettings={vi.fn()} />);
    view.rerender(<SuggestionsCard settings={settings} onSettings={vi.fn()} />);
    expect(await screen.findByDisplayValue('gpt-4o-mini')).toBeInTheDocument();
  });

  it('treats surrounding whitespace on the current model as a no-op before switching providers', async () => {
    mocks.patch.mockResolvedValue(routerSettings);
    render(<Harness />);
    const model = screen.getByDisplayValue('gpt-4o-mini');
    fireEvent.change(model, { target: { value: ' gpt-4o-mini ' } });
    fireEvent.blur(model);
    expect(mocks.patch).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), { target: { value: 'openrouter' } });
    await waitFor(() => expect(model).toHaveValue('openai/gpt-4o-mini'));
    fireEvent.blur(model);
    expect(mocks.patch.mock.calls).toEqual([[{ suggestionProvider: 'openrouter' }]]);
  });

  it.each(['vendor/draft-model', ''])('preserves an unsaved draft %j when settings change', (draft) => {
    const view = render(<SuggestionsCard settings={settings} onSettings={vi.fn()} />);
    const model = screen.getByDisplayValue('gpt-4o-mini');
    // A blank draft is also an intentional edit, not a new provider default.
    fireEvent.change(model, { target: { value: draft } });
    view.rerender(<SuggestionsCard settings={routerSettings} onSettings={vi.fn()} />);
    expect(model).toHaveValue(draft);
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it('normalizes a saved draft and follows subsequent settings while pristine', async () => {
    const view = render(<SuggestionsCard settings={settings} onSettings={vi.fn()} />);
    const model = screen.getByDisplayValue('gpt-4o-mini');
    fireEvent.change(model, { target: { value: ' vendor/selected-model ' } });
    fireEvent.blur(model);
    await waitFor(() => expect(model).toHaveValue('vendor/selected-model'));
    expect(mocks.patch).toHaveBeenCalledWith({ suggestionModel: 'vendor/selected-model' });
    view.rerender(<SuggestionsCard settings={routerSettings} onSettings={vi.fn()} />);
    expect(await screen.findByDisplayValue('openai/gpt-4o-mini')).toBeInTheDocument();
  });

  it('preserves edits made after a model save starts', async () => {
    let resolve!: (next: InstanceSettingsDto) => void;
    mocks.patch.mockReturnValue(new Promise<InstanceSettingsDto>((done) => { resolve = done; }));
    render(<Harness />);
    const model = screen.getByDisplayValue('gpt-4o-mini');
    fireEvent.change(model, { target: { value: 'vendor/submitted-model' } });
    fireEvent.blur(model);
    fireEvent.change(model, { target: { value: 'vendor/newer-draft' } });
    await act(async () => resolve({ ...settings, suggestionModel: 'vendor/submitted-model' }));
    expect(model).toHaveValue('vendor/newer-draft');
  });

  it('retains the draft and reports a failed save', async () => {
    mocks.patch.mockRejectedValue(new Error('Synthetic save failed'));
    render(<Harness />);
    const model = screen.getByDisplayValue('gpt-4o-mini');
    fireEvent.change(model, { target: { value: 'vendor/draft-model' } });
    fireEvent.blur(model);
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Synthetic save failed'));
    expect(model).toHaveValue('vendor/draft-model');
  });
});
