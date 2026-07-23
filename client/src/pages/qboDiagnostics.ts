import type { QboDiagnosticCode } from '@recat/shared';

export interface QboDiagnosticFailure {
  code: QboDiagnosticCode;
  message: string;
}

export interface QboConnectDiagnosticViewState {
  failure: QboDiagnosticFailure | undefined;
  stepId: string;
  syncing: boolean;
  companyId: string | null;
  /** Included to make mode independence explicit at the Setup render boundary. */
  mode: 'demo' | 'real' | null;
}

export interface QboCallbackProgressState {
  stepId: string;
  adminSent: boolean;
  companyId: string | null;
}

const QBO_DIAGNOSTIC_MESSAGES: Record<QboDiagnosticCode, string> = {
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

const QBO_DIAGNOSTIC_CODES = new Set<string>(Object.keys(QBO_DIAGNOSTIC_MESSAGES));

function isQboDiagnosticCode(value: string): value is QboDiagnosticCode {
  return QBO_DIAGNOSTIC_CODES.has(value);
}

export function qboDiagnosticMessage(code: QboDiagnosticCode): string {
  return QBO_DIAGNOSTIC_MESSAGES[code];
}

export function readQboCallbackFailure(search: string): QboDiagnosticFailure | undefined {
  const params = new URLSearchParams(search);
  const rawCode = params.get('qbo_error');
  if (rawCode !== null) {
    const code = isQboDiagnosticCode(rawCode) ? rawCode : 'QBO_CONNECTION_FAILED';
    return { code, message: qboDiagnosticMessage(code) };
  }
  if (params.get('error') === 'connect_failed') {
    const code = 'QBO_CONNECTION_FAILED';
    return { code, message: qboDiagnosticMessage(code) };
  }
  return undefined;
}

export function qboCallbackProgress<T extends QboCallbackProgressState>(
  search: string,
  saved: T,
):
  | (Omit<T, keyof QboCallbackProgressState> & {
      stepId: 'connect';
      adminSent: false;
      companyId: string | null;
    })
  | undefined {
  const connected = new URLSearchParams(search).get('connected');
  if (connected) {
    return { ...saved, stepId: 'connect', adminSent: false, companyId: connected };
  }
  if (readQboCallbackFailure(search)) {
    return { ...saved, stepId: 'connect', adminSent: false, companyId: null };
  }
  return undefined;
}

export function qboConnectFailureForRender(
  state: QboConnectDiagnosticViewState,
): QboDiagnosticFailure | undefined {
  if (state.stepId !== 'connect' || state.syncing || state.companyId !== null) return undefined;
  return state.failure;
}

export function qboCallbackToastMessage(
  failure: QboDiagnosticFailure | undefined,
  alreadyToasted: boolean,
): string | undefined {
  return failure && !alreadyToasted ? failure.message : undefined;
}
