import type { ApiError } from '../lib/api';

interface ReadFailureCardProps {
  title: string;
  context: string;
  error: ApiError | null;
  onRetry: () => void;
}

export function ReadFailureCard({ title, context, error, onRetry }: ReadFailureCardProps) {
  return (
    <section
      role="alert"
      aria-live="assertive"
      style={{
        background: 'var(--erB)',
        border: '1px solid var(--erD)',
        borderRadius: 8,
        padding: '14px 16px',
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 12.5, color: 'var(--fnt)', marginTop: 3 }}>{context}</div>
      <div style={{ fontSize: 13, marginTop: 8 }}>{error?.message ?? 'This data could not be loaded.'}</div>
      {error?.requestId && (
        <div style={{ fontSize: 12, color: 'var(--fnt)', marginTop: 6 }}>
          Reference: {error.requestId}
        </div>
      )}
      <button
        type="button"
        onClick={onRetry}
        style={{
          background: 'transparent',
          border: '1px solid var(--erD)',
          borderRadius: 7,
          color: 'var(--fnt)',
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: 13,
          fontWeight: 600,
          marginTop: 12,
          padding: '7px 12px',
        }}
      >
        Retry
      </button>
    </section>
  );
}
