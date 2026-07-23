import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { UserDto } from '@recat/shared';
import { auth } from '../../lib/api';

export interface LocalAdminLoginProps {
  email: string;
  setEmail(email: string): void;
  onSuccess(user: UserDto): void;
  onError(message: string): void;
  onBack(): void;
}

export default function LocalAdminLogin({
  email,
  setEmail,
  onSuccess,
  onError,
  onBack,
}: LocalAdminLoginProps) {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const requestGeneration = useRef(0);

  useEffect(() => () => {
    requestGeneration.current += 1;
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedEmail = email.trim();
    if (!normalizedEmail || !password || submitting) return;
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    setSubmitting(true);
    try {
      const session = await auth.local(normalizedEmail, password);
      if (generation !== requestGeneration.current) return;
      setPassword('');
      onSuccess(session.user);
    } catch (error) {
      if (generation !== requestGeneration.current) return;
      onError(error instanceof Error ? error.message : 'Could not sign in — try again');
    } finally {
      if (generation === requestGeneration.current) setSubmitting(false);
    }
  };

  const back = () => {
    if (submitting) return;
    setPassword('');
    onBack();
  };

  return (
    <form onSubmit={submit}>
      <div style={{ fontFamily: "'Spectral',serif", fontSize: 21, fontWeight: 500 }}>
        Local admin access
      </div>
      <div
        role="note"
        style={{
          margin: '12px 0 20px',
          padding: 12,
          borderRadius: 8,
          border: '1px solid var(--amD)',
          background: 'var(--amB)',
          color: 'var(--amT)',
          fontSize: 13.5,
          lineHeight: 1.5,
        }}
      >
        Local admin access is enabled. This password signs in as the configured instance
        administrator. Use it only on a trusted network.
      </div>
      <label
        htmlFor="local-admin-email"
        style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--mut)', marginBottom: 6 }}
      >
        Admin email
      </label>
      <input
        id="local-admin-email"
        className="input-lg"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        type="email"
        autoComplete="username"
        autoFocus
      />
      <label
        htmlFor="local-admin-password"
        style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--mut)', margin: '14px 0 6px' }}
      >
        Admin password
      </label>
      <input
        id="local-admin-password"
        className="input-lg"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        type="password"
        autoComplete="current-password"
      />
      <button
        type="submit"
        className="lg-primary"
        disabled={submitting}
        style={{ width: '100%', marginTop: 14, background: 'var(--acc)', color: '#fff', border: 'none', borderRadius: 8, padding: 12, fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
      >
        {submitting ? 'Signing in…' : 'Sign in as administrator'}
      </button>
      <button
        type="button"
        onClick={back}
        className="lg-dashed"
        disabled={submitting}
        style={{ width: '100%', marginTop: 10, border: '1px dashed var(--bd)', background: 'var(--hl)', color: 'var(--mut)', borderRadius: 8, padding: 10, fontSize: 13.5, cursor: 'pointer', fontFamily: 'inherit' }}
      >
        Use a magic link instead
      </button>
    </form>
  );
}
