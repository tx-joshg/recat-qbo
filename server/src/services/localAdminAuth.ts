import { createHash, timingSafeEqual } from 'node:crypto';
import type { Membership, User } from '@prisma/client';
import { localAdminConfig } from '../env.js';
import { prisma } from '../lib/prisma.js';
import type { LocalAdminConfig } from './localAdminConfig.js';

export type LocalAdminUser = User & { memberships: Membership[] };

export interface LocalAdminUserReader {
  user: {
    findUnique(args: {
      where: { email: string };
      include: { memberships: true };
    }): Promise<LocalAdminUser | null>;
  };
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function localAdminPasswordMatches(submitted: string, configured: string): boolean {
  return timingSafeEqual(digest(submitted), digest(configured));
}

export async function authenticateLocalAdmin(
  rawEmail: string,
  password: string,
  config: LocalAdminConfig = localAdminConfig,
  db: LocalAdminUserReader = prisma,
): Promise<LocalAdminUser | null> {
  if (!config.enabled) return null;
  const email = rawEmail.trim().toLowerCase();
  const passwordMatches = localAdminPasswordMatches(password, config.password);
  const user = await db.user.findUnique({
    where: { email: config.email },
    include: { memberships: true },
  });
  if (email !== config.email || !passwordMatches || !user?.isInstanceAdmin) return null;
  return user;
}
