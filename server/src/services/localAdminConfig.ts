import { z } from 'zod';

export interface LocalAdminConfig {
  enabled: boolean;
  email: string;
  password: string;
}

const emailSchema = z.string().trim().toLowerCase().email();

export function parseLocalAdminConfig(email: string, password: string): LocalAdminConfig {
  const hasEmail = email !== '';
  const hasPassword = password !== '';
  if (!hasEmail && !hasPassword) return { enabled: false, email: '', password: '' };
  if (hasEmail !== hasPassword) {
    throw new Error('LOCAL_ADMIN_EMAIL and LOCAL_ADMIN_PASSWORD must be set together');
  }
  const parsedEmail = emailSchema.safeParse(email);
  if (!parsedEmail.success) throw new Error('LOCAL_ADMIN_EMAIL must be a valid email address');
  if (password.length < 12) throw new Error('LOCAL_ADMIN_PASSWORD must be at least 12 characters');
  return { enabled: true, email: parsedEmail.data, password };
}
