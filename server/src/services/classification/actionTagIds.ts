const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Exact executable-action policy: invalid input is rejected whole, never filtered or truncated. */
export function parseActionTagIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 50) return null;
  if (value.some((item) => typeof item !== 'string' || !UUID.test(item))) return null;
  const tags = value as string[];
  return new Set(tags).size === tags.length ? [...tags] : null;
}

export function actionTagIdsReason(value: unknown): string | null {
  return parseActionTagIds(value) === null ? 'Action tag IDs are invalid.' : null;
}
