import { describe, expect, it } from 'vitest';
import type { QboDiagnosticCode } from '@recat/shared';
import {
  qboCallbackToastMessage,
  qboCallbackProgress,
  qboConnectFailureForRender,
  qboDiagnosticMessage,
  readQboCallbackFailure,
} from './qboDiagnostics';

const expectedMessages: Record<QboDiagnosticCode, string> = {
  INVALID_CLIENT_CREDENTIALS:
    'QuickBooks rejected the Client ID and Client Secret pair. Confirm both credentials come from the same Intuit app and environment.',
  REDIRECT_URI_MISMATCH:
    'The redirect URI does not match the URI configured in Intuit. Copy the exact redirect URI shown in Recat into your Intuit app.',
  AUTHORIZATION_EXPIRED:
    'The QuickBooks authorization code expired before it could be used. Start the connection again and complete authorization promptly.',
  ACCESS_DENIED:
    'QuickBooks authorization was cancelled or denied. Try again and approve access to the company.',
  STATE_EXPIRED:
    'This QuickBooks connection attempt expired. Start the connection again from Recat.',
  INTUIT_UNAVAILABLE:
    'Intuit is temporarily unavailable. Wait a few minutes, then try connecting again.',
  COMPANY_INFO_FAILED:
    'Recat connected to QuickBooks but could not read the company details. Confirm the selected company is accessible, then try again.',
  COMPANY_DISCONNECTED:
    'This company is disconnected from QuickBooks. Reconnect it before testing the connection.',
  QBO_CONNECTION_FAILED:
    'QuickBooks could not complete the connection. Check the app environment and redirect URI, then try again.',
};

describe('qboDiagnosticMessage', () => {
  it.each(Object.entries(expectedMessages) as [QboDiagnosticCode, string][])(
    'maps %s to public actionable copy',
    (code, message) => {
      expect(qboDiagnosticMessage(code)).toBe(message);
    },
  );
});

describe('readQboCallbackFailure', () => {
  it('reads a whitelisted diagnostic code from the OAuth callback', () => {
    expect(readQboCallbackFailure('?qbo_error=INVALID_CLIENT_CREDENTIALS')).toEqual({
      code: 'INVALID_CLIENT_CREDENTIALS',
      message:
        'QuickBooks rejected the Client ID and Client Secret pair. Confirm both credentials come from the same Intuit app and environment.',
    });
  });

  it('preserves the legacy connect_failed callback', () => {
    expect(readQboCallbackFailure('?error=connect_failed')?.code).toBe('QBO_CONNECTION_FAILED');
  });

  it('maps an unknown diagnostic code to the generic public failure', () => {
    expect(readQboCallbackFailure('?qbo_error=NOT_A_REAL_CODE')?.code).toBe(
      'QBO_CONNECTION_FAILED',
    );
  });

  it('ignores callback searches without a QuickBooks failure', () => {
    expect(readQboCallbackFailure('?connected=company-1')).toBeUndefined();
    expect(readQboCallbackFailure('?error=unrelated')).toBeUndefined();
    expect(readQboCallbackFailure('')).toBeUndefined();
  });
});

describe('qboConnectFailureForRender', () => {
  it.each([
    '?qbo_error=INVALID_CLIENT_CREDENTIALS',
    '?error=connect_failed',
  ])('keeps %s visible after query consumption with no saved mode', (search) => {
    const capturedFailure = readQboCallbackFailure(search);
    const savedMode = null;

    expect(readQboCallbackFailure('')).toBeUndefined();
    expect(
      qboConnectFailureForRender({
        failure: capturedFailure,
        stepId: 'connect',
        syncing: false,
        companyId: null,
        mode: savedMode,
      }),
    ).toEqual(capturedFailure);
  });

  it('does not render a callback failure after a company connects', () => {
    const failure = readQboCallbackFailure('?qbo_error=ACCESS_DENIED');

    expect(
      qboConnectFailureForRender({
        failure,
        stepId: 'connect',
        syncing: false,
        companyId: 'company-1',
        mode: null,
      }),
    ).toBeUndefined();
  });
});

describe('qboCallbackToastMessage', () => {
  it('returns a callback message once and suppresses StrictMode effect replay', () => {
    const failure = readQboCallbackFailure('?qbo_error=STATE_EXPIRED');

    expect(qboCallbackToastMessage(failure, false)).toBe(failure?.message);
    expect(qboCallbackToastMessage(failure, true)).toBeUndefined();
  });
});

describe('qboCallbackProgress', () => {
  it.each([
    '?qbo_error=INVALID_CLIENT_CREDENTIALS',
    '?error=connect_failed',
  ])('clears a stale company for %s and keeps its diagnostic renderable', (search) => {
    const saved = {
      stepId: 'sync',
      mode: 'demo' as const,
      adminSent: true,
      companyId: 'stale-company',
      preserved: 'wizard-field',
    };
    const failure = readQboCallbackFailure(search);
    const transitioned = qboCallbackProgress(search, saved);

    expect(transitioned).toEqual({
      ...saved,
      stepId: 'connect',
      adminSent: false,
      companyId: null,
    });
    expect(readQboCallbackFailure('')).toBeUndefined();
    expect(
      qboConnectFailureForRender({
        failure,
        stepId: transitioned?.stepId ?? '',
        syncing: false,
        companyId: transitioned ? transitioned.companyId : 'missing-transition',
        mode: transitioned?.mode ?? null,
      }),
    ).toEqual(failure);
  });

  it('preserves successful connected callback behavior', () => {
    const saved = {
      stepId: 'sync',
      mode: 'real' as const,
      adminSent: true,
      companyId: 'stale-company',
    };

    expect(qboCallbackProgress('?connected=new-company', saved)).toEqual({
      ...saved,
      stepId: 'connect',
      adminSent: false,
      companyId: 'new-company',
    });
  });
});
