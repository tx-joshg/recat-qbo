import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setActiveCompany: vi.fn(),
  signOut: vi.fn(),
  toast: vi.fn(),
  toggleTheme: vi.fn(),
}));

vi.mock('../state/AppContext', () => ({
  useApp: () => ({
    session: { email: 'admin@example.test', name: 'Admin', isInstanceAdmin: true },
    role: 'admin',
    companies: [],
    activeCompany: null,
    pendingCount: 0,
    dryRun: false,
    theme: 'light',
    setActiveCompany: mocks.setActiveCompany,
    signOut: mocks.signOut,
    toast: mocks.toast,
    toggleTheme: mocks.toggleTheme,
  }),
}));

import Nav from './Nav';

afterEach(() => vi.unstubAllGlobals());

describe('Nav wordmark', () => {
  it('links the Recat wordmark to the canonical Queue route', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      media: '(max-width: 640px)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    render(<MemoryRouter initialEntries={['/reports']}><Nav /></MemoryRouter>);

    expect(screen.getByRole('link', { name: 'Recat' })).toHaveAttribute('href', '/');
  });
});
