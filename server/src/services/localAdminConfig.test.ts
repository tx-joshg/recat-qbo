import { describe, expect, it } from 'vitest';
import { parseLocalAdminConfig } from './localAdminConfig.js';

describe('parseLocalAdminConfig', () => {
  it('is disabled only when both values are absent', () => {
    expect(parseLocalAdminConfig('', '')).toEqual({ enabled: false, email: '', password: '' });
  });

  it.each([
    ['admin@example.com', ''],
    ['', 'a-long-random-password'],
  ])('rejects a partial credential pair', (email, password) => {
    expect(() => parseLocalAdminConfig(email, password)).toThrow(
      'LOCAL_ADMIN_EMAIL and LOCAL_ADMIN_PASSWORD must be set together',
    );
  });

  it('rejects an invalid configured email', () => {
    expect(() => parseLocalAdminConfig('not-email', 'a-long-random-password')).toThrow(
      'LOCAL_ADMIN_EMAIL must be a valid email address',
    );
  });

  it('rejects a configured password shorter than 12 characters', () => {
    expect(() => parseLocalAdminConfig('admin@example.com', 'short')).toThrow(
      'LOCAL_ADMIN_PASSWORD must be at least 12 characters',
    );
  });

  it('normalizes the enabled admin email without altering the password', () => {
    expect(parseLocalAdminConfig('  ADMIN@Example.COM ', '  twelve chars kept  ')).toEqual({
      enabled: true,
      email: 'admin@example.com',
      password: '  twelve chars kept  ',
    });
  });
});
