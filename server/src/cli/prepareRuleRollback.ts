import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../lib/prisma.js';
import { prepareRuleRollback } from '../services/ruleRollbackGuard.js';
import { parseRuleCutoverArgs } from './ruleCutoverCli.js';

export interface RuleRollbackCliDependencies {
  rollback: typeof prepareRuleRollback;
  disconnect(): Promise<void>;
  writeOut(message: string): void;
  writeError(message: string): void;
}

const dependencies: RuleRollbackCliDependencies = {
  rollback: prepareRuleRollback,
  disconnect: () => prisma.$disconnect(),
  writeOut: (message) => console.log(message),
  writeError: (message) => console.error(message),
};

export async function runPrepareRuleRollback(
  args: readonly string[],
  deps: RuleRollbackCliDependencies = dependencies,
): Promise<number> {
  try {
    const parsed = parseRuleCutoverArgs(args);
    deps.writeOut(JSON.stringify(await deps.rollback(parsed)));
    return 0;
  } catch (error) {
    deps.writeError(`Rule rollback guard failed: ${error instanceof Error ? error.message : 'unknown failure'}`);
    return 1;
  } finally {
    await deps.disconnect().catch((error: unknown) => {
      deps.writeError(`Rule rollback guard disconnect failed: ${error instanceof Error ? error.message : 'unknown failure'}`);
    });
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  void runPrepareRuleRollback(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
