import { act, render, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AppProvider, useApp, type AppContextValue } from './AppContext';
vi.mock('../lib/api', () => ({ auth: { session: async () => ({ user: { id: 'user-example', role: 'admin', memberships: [] } }), logout: async () => {} }, companies: { list: async () => [] }, tags: {}, tax: {}, transactions: {} }));
let context: AppContextValue;
function Observer() { context = useApp(); return null; }
it('invalidates only the current signed-in company and ignores calls after unmount', async () => {
  const view = render(<AppProvider><Observer /></AppProvider>);
  await waitFor(() => expect(context.sessionLoading).toBe(false));
  act(() => context.setActiveCompany('company-a'));
  const notify = context.notifyQboMutation;
  act(() => notify('company-a')); expect(context.qboMutationRevision).toBe(1);
  act(() => context.setActiveCompany('company-b'));
  act(() => notify('company-a')); expect(context.qboMutationRevision).toBe(1);
  act(() => notify('company-b')); expect(context.qboMutationRevision).toBe(2);
  await act(async () => context.signOut());
  act(() => notify('company-b')); expect(context.qboMutationRevision).toBe(2);
  view.unmount(); act(() => notify('company-b')); expect(context.qboMutationRevision).toBe(2);
});

it('delivers each targeted event even when React batches revisions, and unsubscribes listeners', async () => {
  const view = render(<AppProvider><Observer /></AppProvider>);
  await waitFor(() => expect(context.sessionLoading).toBe(false));
  act(() => context.setActiveCompany('company-a'));
  const listener = vi.fn(); const origin = Symbol('view');
  const unsubscribe = context.subscribeQboMutations(listener);
  act(() => { context.notifyQboMutation('company-a', ['one'], origin); context.notifyQboMutation('company-a', ['two']); context.notifyQboMutation('company-b', ['other']); });
  expect(listener.mock.calls).toEqual([[{ companyId: 'company-a', transactionIds: ['one'], origin }], [{ companyId: 'company-a', transactionIds: ['two'], origin: undefined }]]);
  unsubscribe(); act(() => context.notifyQboMutation('company-a', ['three']));
  expect(listener).toHaveBeenCalledTimes(2); view.unmount();
});
