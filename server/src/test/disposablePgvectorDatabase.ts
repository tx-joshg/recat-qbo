import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Prisma, PrismaClient } from '@prisma/client';

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/u;

export interface DisposablePgvectorDatabase {
  databaseName: string;
  databaseUrl: string;
  destroy(): Promise<void>;
}

export interface DisposablePgvectorDatabaseTestHooks {
  runMigrations?(args: { defaultRun(): Promise<void> }): Promise<void>;
  dropDatabase?(args: { databaseName: string; defaultDrop(): Promise<void> }): Promise<void>;
}

function databaseUrl(anchor: string, databaseName: string): string {
  const url = new URL(anchor);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function databaseExists(admin: PrismaClient, databaseName: string): Promise<boolean> {
  const rows = await admin.$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
    SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${databaseName}) AS present
  `);
  return rows[0]?.present === true;
}

async function dropDatabase(admin: PrismaClient, databaseName: string): Promise<void> {
  if (!SAFE_IDENTIFIER.test(databaseName)) throw new Error('Unsafe disposable database name.');
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  if (await databaseExists(admin, databaseName)) {
    throw new Error('Classification search test disposable database still exists after drop.');
  }
}

/** Creates, migrates, and later force-drops a unique database without mutating the anchor database. */
export async function createDisposablePgvectorDatabase(
  anchorDatabaseUrl: string,
  testHooks: DisposablePgvectorDatabaseTestHooks = {},
): Promise<DisposablePgvectorDatabase> {
  const databaseName = `recat_search_test_${process.pid}_${randomBytes(6).toString('hex')}`;
  if (!SAFE_IDENTIFIER.test(databaseName)) throw new Error('Unsafe disposable database name.');
  const admin = new PrismaClient({ datasources: { db: { url: anchorDatabaseUrl } } });
  const targetUrl = databaseUrl(anchorDatabaseUrl, databaseName);
  let created = false;
  let destroyed = false;
  const performMigrations = () => {
    const defaultRun = async () => {
      await execFileAsync('npx', ['prisma', 'migrate', 'deploy'], {
        cwd: REPOSITORY_ROOT,
        env: { ...process.env, DATABASE_URL: targetUrl },
        maxBuffer: 2 * 1024 * 1024,
      });
    };
    return testHooks.runMigrations === undefined
      ? defaultRun()
      : testHooks.runMigrations({ defaultRun });
  };
  const performDrop = () => testHooks.dropDatabase === undefined
    ? dropDatabase(admin, databaseName)
    : testHooks.dropDatabase({
        databaseName,
        defaultDrop: () => dropDatabase(admin, databaseName),
      });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    await performMigrations();
    const target = new PrismaClient({ datasources: { db: { url: targetUrl } } });
    try {
      await target.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS vector');
    } finally {
      await target.$disconnect();
    }
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (created) {
      try {
        await performDrop();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      await admin.$disconnect();
    } catch (disconnectError) {
      cleanupErrors.push(disconnectError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `Classification search test database initialization and cleanup failed for ${databaseName}.`,
      );
    }
    throw error;
  }
  return {
    databaseName,
    databaseUrl: targetUrl,
    async destroy() {
      if (destroyed) return;
      await performDrop();
      destroyed = true;
      await admin.$disconnect();
    },
  };
}

/** Truncates every disposable public data table while preserving migration history and extensions. */
export async function resetDisposablePgvectorDatabase(db: PrismaClient): Promise<void> {
  const tables = await db.$queryRaw<Array<{ tablename: string }>>(Prisma.sql`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    ORDER BY tablename ASC
  `);
  const names = tables.map(({ tablename }) => {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(tablename)) {
      throw new Error('Unsafe disposable table name.');
    }
    return `"${tablename}"`;
  });
  if (names.length > 0) {
    await db.$executeRawUnsafe(`TRUNCATE TABLE ${names.join(', ')} RESTART IDENTITY CASCADE`);
  }
}
