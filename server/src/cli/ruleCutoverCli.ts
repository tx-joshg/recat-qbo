const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface RuleCutoverCliArgs {
  companyId: string;
  actor: string;
  apply: boolean;
  activate?: true;
}

function requiredValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

export function parseRuleCutoverArgs(args: readonly string[], options: { allowActivate?: boolean } = {}): RuleCutoverCliArgs {
  let activate = false;
  let companyId: string | null = null;
  let actor: string | null = null;
  let mode: 'dry-run' | 'apply' | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--company-id') {
      if (companyId !== null) throw new Error('company-id may be supplied only once.');
      companyId = requiredValue(args, index, argument);
      index += 1;
    } else if (argument === '--actor') {
      if (actor !== null) throw new Error('actor may be supplied only once.');
      actor = requiredValue(args, index, argument);
      index += 1;
    } else if (argument === '--activate' && options.allowActivate) {
      if (activate) throw new Error('activate may be supplied only once.');
      activate = true;
    } else if (argument === '--apply' || argument === '--dry-run') {
      if (mode !== null) throw new Error('choose at most one mode: --dry-run or --apply.');
      mode = argument.slice(2) as 'dry-run' | 'apply';
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (companyId === null || !UUID.test(companyId)) throw new Error('company-id must be one UUID.');
  const normalizedActor = actor?.trim() ?? '';
  if (normalizedActor.length === 0 || normalizedActor.length > 128) {
    throw new Error('actor must be a nonblank value of at most 128 characters.');
  }
  return { companyId: companyId.toLowerCase(), actor: normalizedActor, apply: mode === 'apply', ...(activate ? { activate: true as const } : {}) };
}
