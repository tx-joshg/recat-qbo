import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../lib/prisma.js';
import { backfillCanonicalRules } from '../services/ruleCanonicalBackfill.js';
import { parseRuleCutoverArgs } from './ruleCutoverCli.js';

export interface CanonicalBackfillCliDependencies {
  backfill: typeof backfillCanonicalRules;
  disconnect(): Promise<void>;
  writeOut(message: string): void;
  writeError(message: string): void;
}

const dependencies: CanonicalBackfillCliDependencies = {
  backfill: backfillCanonicalRules,
  disconnect: () => prisma.$disconnect(),
  writeOut: (message) => console.log(message),
  writeError: (message) => console.error(message),
};

export async function runBackfillCanonicalRules(
  args: readonly string[],
  deps: CanonicalBackfillCliDependencies = dependencies,
): Promise<number> {
  try {
    const parsed = parseRuleCutoverArgs(args, { allowActivate: true });
    deps.writeOut(JSON.stringify(await deps.backfill(parsed)));
    return 0;
  } catch (error) {
    deps.writeError(`Canonical rule backfill failed: ${error instanceof Error ? error.message : 'unknown failure'}`);
    return 1;
  } finally {
    await deps.disconnect().catch((error: unknown) => {
      deps.writeError(`Canonical rule backfill disconnect failed: ${error instanceof Error ? error.message : 'unknown failure'}`);
    });
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  void runBackfillCanonicalRules(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
