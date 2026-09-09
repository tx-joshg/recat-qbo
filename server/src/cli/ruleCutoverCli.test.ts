import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runBackfillCanonicalRules } from './backfillCanonicalRules.js';
import { runPrepareRuleRollback } from './prepareRuleRollback.js';
import { parseRuleCutoverArgs } from './ruleCutoverCli.js';

const COMPANY = '11111111-1111-4111-8111-111111111111';

describe('rule cutover CLI arguments', () => {
  it('wires the exact package scripts to the built CLI entry points', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts['rules:canonical-backfill']).toBe(
      'node dist/cli/backfillCanonicalRules.js',
    );
    expect(packageJson.scripts['rules:rollback-guard']).toBe(
      'node dist/cli/prepareRuleRollback.js',
    );
  });
  it('defaults to dry-run and requires one company and actor', () => {
    expect(parseRuleCutoverArgs([
      '--company-id', COMPANY, '--actor', 'release-operator',
    ])).toEqual({ companyId: COMPANY, actor: 'release-operator', apply: false });
  });

  it('accepts an explicit apply mode', () => {
    expect(parseRuleCutoverArgs([
      '--company-id', COMPANY, '--actor', 'release-operator', '--apply',
    ])).toEqual({ companyId: COMPANY, actor: 'release-operator', apply: true });
  });

  it('accepts explicit activation only for the backfill command', async () => {
    let received: unknown;
    const args = ['--company-id', COMPANY, '--actor', 'release-operator', '--activate', '--dry-run'];
    expect(await runBackfillCanonicalRules(args, {
      backfill: async (input) => { received = input; return {} as never; },
      disconnect: async () => undefined, writeOut: () => undefined, writeError: () => undefined,
    })).toBe(0);
    expect(received).toEqual({ companyId: COMPANY, actor: 'release-operator', apply: false, activate: true });
    expect(await runPrepareRuleRollback(args, {
      rollback: async () => { throw new Error('must not run'); },
      disconnect: async () => undefined, writeOut: () => undefined, writeError: () => undefined,
    })).toBe(1);
  });

  it.each([
    ['missing company', ['--actor', 'operator']],
    ['invalid company', ['--company-id', 'all', '--actor', 'operator']],
    ['missing actor', ['--company-id', COMPANY]],
    ['blank actor', ['--company-id', COMPANY, '--actor', '   ']],
    ['both modes', ['--company-id', COMPANY, '--actor', 'operator', '--apply', '--dry-run']],
    ['duplicate company', ['--company-id', COMPANY, '--company-id', COMPANY, '--actor', 'operator']],
    ['unknown broad mode', ['--company-id', COMPANY, '--actor', 'operator', '--all-companies']],
  ])('rejects %s', (_label, args) => {
    expect(() => parseRuleCutoverArgs(args)).toThrow();
  });

  it.each([
    ['backfill', runBackfillCanonicalRules, 'backfill'],
    ['rollback', runPrepareRuleRollback, 'rollback'],
  ] as const)('writes deterministic JSON and disconnects for %s', async (_label, run, method) => {
    const output: string[] = [];
    const errors: string[] = [];
    let disconnected = 0;
    const report = { companyId: COMPANY, applied: false, examinedRules: 2 };
    const dependencies = {
      [method]: async () => report,
      disconnect: async () => { disconnected += 1; },
      writeOut: (message: string) => output.push(message),
      writeError: (message: string) => errors.push(message),
    };
    const code = await run([
      '--company-id', COMPANY, '--actor', 'release-operator',
    ], dependencies as never);
    expect(code).toBe(0);
    expect(output).toEqual([JSON.stringify(report)]);
    expect(errors).toEqual([]);
    expect(disconnected).toBe(1);
  });

  it('returns nonzero without invoking backfill for invalid broad scope', async () => {
    let called = 0;
    const errors: string[] = [];
    const code = await runBackfillCanonicalRules([
      '--company-id', COMPANY, '--actor', 'release-operator', '--all-companies',
    ], {
      backfill: async () => { called += 1; return {} as never; },
      disconnect: async () => undefined,
      writeOut: () => undefined,
      writeError: (message) => errors.push(message),
    });
    expect(code).toBe(1);
    expect(called).toBe(0);
    expect(errors[0]).toMatch(/unknown argument/i);
  });
});
