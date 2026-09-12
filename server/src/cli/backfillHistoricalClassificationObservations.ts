import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../lib/prisma.js';
import {
  backfillHistoricalClassificationObservations,
  type HistoricalObservationBackfillReport,
} from '../services/classification/historicalObservations.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_PAGE_SIZE = 250;
const MAX_EXCLUSION_IDS = 100;
const MAX_EXCLUSION_FILE_BYTES = 4_096;
const MAX_DATE_SPAN_DAYS = 730;

export interface HistoricalObservationBackfillCliArgs {
  companyId: string;
  startDate: string;
  endDate: string;
  dryRun: boolean;
  pageSize: number;
  json: boolean;
  excludeSourceTransactionIdFile: string | null;
}

export interface HistoricalObservationBackfillCliDependencies {
  backfill(input: {
    companyId: string;
    startDate: string;
    endDate: string;
    dryRun: boolean;
    pageSize: number;
    excludeSourceTransactionIds: readonly string[];
  }): Promise<HistoricalObservationBackfillReport>;
  disconnect(): Promise<void>;
  writeOut(message: string): void;
  writeError(message: string): void;
}

const usage = [
  'Usage: npm run classification:observations:backfill --workspace server --',
  '  --company-id <uuid> --start-date <YYYY-MM-DD> --end-date <YYYY-MM-DD>',
  '  (--dry-run | --apply) [--page-size 1-250]',
  '  [--exclude-source-transaction-id-file <0600-file>] [--json]',
].join('\n');

class CliInputError extends Error {}

function cliError(message: string): never {
  throw new CliInputError(message);
}

function calendarDate(value: string, flag: string): Date {
  if (!DATE.test(value)) cliError(`${flag} must be YYYY-MM-DD.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    cliError(`${flag} must be a calendar date.`);
  }
  return date;
}

function requiredValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) cliError(`${flag} requires a value.`);
  return value;
}

export function parseArgs(args: readonly string[]): HistoricalObservationBackfillCliArgs {
  let companyId: string | null = null;
  let startDate: string | null = null;
  let endDate: string | null = null;
  let mode: 'dry_run' | 'apply' | null = null;
  let pageSize = MAX_PAGE_SIZE;
  let json = false;
  let excludeSourceTransactionIdFile: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    switch (argument) {
      case '--company-id':
        if (companyId !== null) cliError('company-id may be supplied only once.');
        companyId = requiredValue(args, index, argument);
        index += 1;
        break;
      case '--start-date':
        if (startDate !== null) cliError('start-date may be supplied only once.');
        startDate = requiredValue(args, index, argument);
        index += 1;
        break;
      case '--end-date':
        if (endDate !== null) cliError('end-date may be supplied only once.');
        endDate = requiredValue(args, index, argument);
        index += 1;
        break;
      case '--page-size': {
        const text = requiredValue(args, index, argument);
        if (!/^\d+$/u.test(text)) cliError('page-size must be an integer from 1 to 250.');
        pageSize = Number(text);
        if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
          cliError('page-size must be an integer from 1 to 250.');
        }
        index += 1;
        break;
      }
      case '--exclude-source-transaction-id-file':
        if (excludeSourceTransactionIdFile !== null) cliError('exclusion file may be supplied only once.');
        excludeSourceTransactionIdFile = requiredValue(args, index, argument);
        index += 1;
        break;
      case '--dry-run':
        if (mode !== null) cliError('choose exactly one mode: --dry-run or --apply.');
        mode = 'dry_run';
        break;
      case '--apply':
        if (mode !== null) cliError('choose exactly one mode: --dry-run or --apply.');
        mode = 'apply';
        break;
      case '--json':
        json = true;
        break;
      default:
        cliError('unknown argument; use --help for supported options.');
    }
  }
  if (companyId === null) cliError('company-id is required.');
  if (!UUID.test(companyId)) cliError('company-id must be a UUID.');
  if (startDate === null) cliError('start-date is required.');
  if (endDate === null) cliError('end-date is required.');
  const start = calendarDate(startDate, 'start-date');
  const end = calendarDate(endDate, 'end-date');
  if (end < start) cliError('end-date must not be before start-date.');
  if ((end.getTime() - start.getTime()) / 86_400_000 > MAX_DATE_SPAN_DAYS) {
    cliError('date range must span at most 731 inclusive days.');
  }
  if (mode === null) cliError('choose exactly one mode: --dry-run or --apply.');
  return {
    companyId: companyId.toLowerCase(), startDate, endDate, dryRun: mode === 'dry_run', pageSize, json,
    excludeSourceTransactionIdFile,
  };
}

/** Reads only exact transaction UUIDs and never reports the path or content. */
export async function readExcludedSourceTransactionIds(filename: string): Promise<string[]> {
  const stats = await lstat(filename);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('exclusion input must be a regular file.');
  if ((stats.mode & 0o777) !== 0o600) throw new Error('exclusion input must have mode 0600.');
  if (stats.size > MAX_EXCLUSION_FILE_BYTES) throw new Error('exclusion input exceeds the safe size limit.');
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  let data: Buffer;
  try {
    const current = await file.stat();
    if (!current.isFile() || (current.mode & 0o777) !== 0o600 || current.size > MAX_EXCLUSION_FILE_BYTES) {
      throw new Error('exclusion input changed while opening.');
    }
    const buffer = Buffer.alloc(MAX_EXCLUSION_FILE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > MAX_EXCLUSION_FILE_BYTES) throw new Error('exclusion input exceeds the safe size limit.');
    data = buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new Error('exclusion input must be valid UTF-8.');
  }
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  if (lines.length === 1 && lines[0] === '') return [];
  if (lines.length > MAX_EXCLUSION_IDS) throw new Error('exclusion input has too many IDs.');
  const values = new Set<string>();
  for (const line of lines) {
    if (!UUID.test(line)) throw new Error('exclusion input contains an invalid transaction ID.');
    const normalized = line.toLowerCase();
    if (values.has(normalized)) throw new Error('exclusion input contains a duplicate transaction ID.');
    values.add(normalized);
  }
  return [...values];
}

const realDependencies: HistoricalObservationBackfillCliDependencies = {
  backfill: backfillHistoricalClassificationObservations,
  disconnect: () => prisma.$disconnect(),
  writeOut: (message) => console.log(message),
  writeError: (message) => console.error(message),
};

export async function runBackfillHistoricalClassificationObservations(
  args: readonly string[],
  dependencies: HistoricalObservationBackfillCliDependencies = realDependencies,
): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    dependencies.writeOut(usage);
    return 0;
  }
  try {
    const parsed = parseArgs(args);
    let excludedSourceTransactionIds: string[] = [];
    if (parsed.excludeSourceTransactionIdFile !== null) {
      try {
        excludedSourceTransactionIds = await readExcludedSourceTransactionIds(
          parsed.excludeSourceTransactionIdFile,
        );
      } catch {
        cliError('protected source exclusion input could not be read safely.');
      }
    }
    const report = await dependencies.backfill({
      companyId: parsed.companyId,
      startDate: parsed.startDate,
      endDate: parsed.endDate,
      dryRun: parsed.dryRun,
      pageSize: parsed.pageSize,
      excludeSourceTransactionIds: excludedSourceTransactionIds,
    });
    dependencies.writeOut(JSON.stringify(report));
    return 0;
  } catch (error) {
    const message = error instanceof CliInputError ? error.message : 'operation failed.';
    dependencies.writeError(`Historical observation backfill failed: ${message}`);
    return 1;
  } finally {
    try {
      await dependencies.disconnect();
    } catch {
      dependencies.writeError('Historical observation backfill disconnect failed.');
    }
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  void runBackfillHistoricalClassificationObservations(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
