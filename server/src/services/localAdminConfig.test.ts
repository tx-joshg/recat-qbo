import { describe, expect, it } from 'vitest';
import { parseLocalAdminConfig } from './localAdminConfig.js';

describe('parseLocalAdminConfig', () => {
  it('is disabled only when both values are absent', () => {
    expect(parseLocalAdminConfig('', '')).toEqual({ enabled: false, email: '', password: '' });
  });

  it('rejects a configured email without a password', () => {
    expect(() => parseLocalAdminConfig('admin@example.com', '')).toThrow(
      'LOCAL_ADMIN_PASSWORD must be set when LOCAL_ADMIN_EMAIL is set',
    );
  });

  it('enables any existing instance admin when only the password is configured', () => {
    expect(parseLocalAdminConfig('', 'a-long-random-password')).toEqual({
      enabled: true,
      email: '',
      password: 'a-long-random-password',
    });
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
    expect(() => parseLocalAdminConfig('', 'short')).toThrow(
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
