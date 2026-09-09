import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseArgs,
  readExcludedSourceTransactionIds,
  runBackfillHistoricalClassificationObservations,
  type HistoricalObservationBackfillCliDependencies,
} from './backfillHistoricalClassificationObservations.js';

const COMPANY = '4b20f911-85dd-44f5-97c6-5fec9e7b33df';
const SOURCE = '2f2c9b1b-9d84-4eaf-8218-47e983fa66a6';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function exclusionFile(contents: string, mode = 0o600): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'recat-observation-cli-'));
  temporaryDirectories.push(directory);
  const filename = path.join(directory, 'protected-source-ids.txt');
  await writeFile(filename, contents, { encoding: 'utf8', mode });
  await chmod(filename, mode);
  return filename;
}

function dependencies(
  overrides: Partial<HistoricalObservationBackfillCliDependencies> = {},
): HistoricalObservationBackfillCliDependencies {
  return {
    backfill: vi.fn(async () => ({
      mode: 'dry_run' as const,
      startDate: '2025-01-01', endDate: '2026-12-31', scanned: 0, eligible: 0, inserted: 0, existing: 0,
      excluded: {
        excluded_source: 0, not_posted: 0, unsupported_qbo_type: 0, split_transaction: 0,
        missing_source_identity: 0, missing_category: 0, invalid_tax_action: 0, missing_currency: 0,
        missing_display_summary: 0, already_verified_case: 0,
      },
    })),
    disconnect: vi.fn(async () => undefined),
    writeOut: vi.fn(),
    writeError: vi.fn(),
    ...overrides,
  };
}

describe('historical observation backfill CLI', () => {
  it('parses an explicitly bounded dry run', () => {
    expect(parseArgs([
      '--company-id', COMPANY,
      '--start-date', '2025-01-01',
      '--end-date', '2026-12-31',
      '--dry-run', '--json',
    ])).toEqual({
      companyId: COMPANY, startDate: '2025-01-01', endDate: '2026-12-31',
      dryRun: true, pageSize: 250, json: true, excludeSourceTransactionIdFile: null,
    });
  });

  it.each([
    ['missing company', ['--dry-run']],
    ['missing mode', ['--company-id', COMPANY, '--start-date', '2026-06-01', '--end-date', '2026-06-30']],
    ['missing start date', ['--company-id', COMPANY, '--end-date', '2026-12-31', '--dry-run']],
    ['both modes', ['--company-id', COMPANY, '--start-date', '2025-01-01', '--end-date', '2026-12-31', '--apply', '--dry-run']],
    ['unknown flag', ['--company-id', COMPANY, '--start-date', '2025-01-01', '--end-date', '2026-12-31', '--dry-run', '--all-companies']],
    ['reversed dates', ['--company-id', COMPANY, '--start-date', '2026-12-31', '--end-date', '2025-01-01', '--dry-run']],
  ])('rejects %s', (_label, args) => {
    expect(() => parseArgs(args)).toThrow();
  });

  it('accepts only a 0600 bounded unique UUID exclusion file', async () => {
    const valid = await exclusionFile(`${SOURCE}\n`);
    await expect(readExcludedSourceTransactionIds(valid)).resolves.toEqual([SOURCE]);

    const duplicate = await exclusionFile(`${SOURCE}\n${SOURCE}\n`);
    await expect(readExcludedSourceTransactionIds(duplicate)).rejects.toThrow('duplicate');

    const unsafe = await exclusionFile(`${SOURCE}\n`, 0o644);
    await expect(readExcludedSourceTransactionIds(unsafe)).rejects.toThrow('0600');
  });

  it('prints one sanitized JSON report without constructing a QBO connection', async () => {
    const deps = dependencies();

    const code = await runBackfillHistoricalClassificationObservations([
      '--company-id', COMPANY, '--start-date', '2025-01-01', '--end-date', '2026-12-31', '--dry-run', '--json',
    ], deps);

    expect(code).toBe(0);
    expect(deps.backfill).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY, dryRun: true, excludeSourceTransactionIds: [],
    }));
    expect(deps.writeOut).toHaveBeenCalledTimes(1);
    expect(JSON.parse((deps.writeOut as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toMatchObject({
      mode: 'dry_run', scanned: 0, inserted: 0,
    });
    expect(deps.writeError).not.toHaveBeenCalled();
    expect(deps.disconnect).toHaveBeenCalledOnce();
  });

  it('does not disclose an exclusion-file path when file validation fails', async () => {
    const deps = dependencies();
    const privatePath = '/private/temporary/protected-source-ids.txt';

    const code = await runBackfillHistoricalClassificationObservations([
      '--company-id', COMPANY, '--start-date', '2025-01-01', '--end-date', '2026-12-31', '--dry-run',
      '--exclude-source-transaction-id-file', privatePath,
    ], deps);

    expect(code).toBe(1);
    expect(deps.backfill).not.toHaveBeenCalled();
    expect(deps.writeError).toHaveBeenCalledWith(expect.not.stringContaining(privatePath));
  });
});


it('rejects symlink and oversized exclusion files before reading protected IDs', async () => {
  const target = await exclusionFile(`${SOURCE}\n`);
  const link = path.join(path.dirname(target), 'excluded-symlink.txt');
  await symlink(target, link);
  await expect(readExcludedSourceTransactionIds(link)).rejects.toThrow();
  await expect(readExcludedSourceTransactionIds(await exclusionFile('x'.repeat(4097)))).rejects.toThrow();
});

it('does not echo arbitrary arguments or database/disconnect error payloads', async () => {
  const marker = 'synthetic-private-error-marker';
  const args = ['--company-id', COMPANY, '--start-date', '2026-06-01', '--end-date', '2026-06-30', '--apply'];
  for (const [input, deps] of [
    [[marker], dependencies()],
    [args, dependencies({ backfill: vi.fn(async () => { throw new Error(marker); }), disconnect: vi.fn(async () => { throw new Error(marker); }) })],
  ] as const) {
    expect(await runBackfillHistoricalClassificationObservations(input, deps)).toBe(1);
    expect(JSON.stringify((deps.writeError as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(marker);
  }
});
