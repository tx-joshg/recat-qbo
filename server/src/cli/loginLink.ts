import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { User } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { issueMagicLink } from '../services/magicLink.js';

type LoginLinkUser = Pick<User, 'id' | 'email'>;

export interface LoginLinkDependencies {
  findUser(email: string): Promise<LoginLinkUser | null>;
  issueLink(user: LoginLinkUser): Promise<{ link: string }>;
  writeOut(message: string): void;
  writeError(message: string): void;
  disconnect(): Promise<void>;
}

const emailSchema = z.string().trim().toLowerCase().email();

const realDependencies: LoginLinkDependencies = {
  findUser: (email) => prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  }),
  issueLink: (user) => issueMagicLink(user, { deliver: false }),
  writeOut: (message) => console.log(message),
  writeError: (message) => console.error(message),
  disconnect: () => prisma.$disconnect(),
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runLoginLink(
  args: string[],
  deps: LoginLinkDependencies = realDependencies,
): Promise<number> {
  let exitCode = 0;
  try {
    if (args.length !== 1) {
      deps.writeError('Usage: npm run login-link -- <email>');
      exitCode = 2;
    } else {
      const parsed = emailSchema.safeParse(args[0]);
      if (!parsed.success) {
        deps.writeError('Enter one valid email address.');
        exitCode = 2;
      } else {
        try {
          const user = await deps.findUser(parsed.data);
          if (!user) {
            deps.writeError('No Recat user exists with that email.');
            exitCode = 1;
          } else {
            const { link } = await deps.issueLink(user);
            deps.writeOut(`Login link for ${user.email} (expires in 15 minutes):\n${link}`);
          }
        } catch (error) {
          deps.writeError(`Could not create login link: ${errorMessage(error)}`);
          exitCode = 1;
        }
      }
    }
  } finally {
    try {
      await deps.disconnect();
    } catch (error) {
      deps.writeError(`Could not close database connection: ${errorMessage(error)}`);
      exitCode = 1;
    }
  }
  return exitCode;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  void runLoginLink(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
