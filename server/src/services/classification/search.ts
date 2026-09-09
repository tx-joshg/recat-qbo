import type {
  ClassificationAction,
  ClassificationActionSummary,
  ClassificationEffectiveSearchMode,
  ClassificationMatchReason,
  ClassificationSearchHit,
  ClassificationSearchMode,
  ClassificationSearchResult,
  ClassificationSearchScope,
} from '@recat/shared';
import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import {
  CLASSIFICATION_CONTRACT_LIMITS,
  parseClassificationSearchHit,
  parseClassificationSearchResult,
} from './contracts.js';
import {
  classificationEmbeddingRuntimeConfig,
  createVoyageEmbeddingClient,
  type VoyageEmbeddingClient,
} from './embedding/client.js';
import {
  classificationEmbeddingGeneration,
  createClassificationSearchDocument,
  type ClassificationEmbeddingGeneration,
  type ClassificationSearchDocument,
} from './embedding/recipe.js';
import {
  PgClassificationVectorStore,
  type VectorGenerationHealth,
  type VectorSearchHit,
} from './embedding/vectorStore.js';
import {
  reciprocalRankFuse,
  rollupSemanticChunks,
  type RankedDocumentList,
} from './rrf.js';
import { normalizeRuleMatchText } from '../ruleMatching.js';
import { normalizeVendorLookupKey } from './vendorIdentity.js';
import { classificationReferenceReasons } from './referenceReadiness.js';
import { parseActionTagIds } from './actionTagIds.js';

const MAX_ACCESSIBLE_COMPANIES = 100;
const SEARCH_FETCH_MULTIPLIER = 5;
const MAX_FETCH = 500;
const COSINE_FLOOR = 0.72;
const MAX_VENDOR_MERGE_HOPS = 20;
const MAX_VENDOR_IDENTITY_SUPPORT_CODE_POINTS = 24_000;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function purchaseTaxSupportCte(companyIds: readonly string[]): Prisma.Sql {
  return Prisma.sql`"purchase_tax_support" AS MATERIALIZED (
    SELECT tax."id" AS "taxCodeId",
           COUNT(component.value)::integer AS "componentCount",
           COUNT(DISTINCT component.value->>'taxRateQboId')::integer
             AS "distinctComponentCount",
           COALESCE(BOOL_AND(
             jsonb_typeof(component.value) = 'object'
             AND NULLIF(btrim(component.value->>'taxRateQboId'), '') IS NOT NULL
             AND COALESCE(
               component.value->>'taxTypeApplicable' = 'TaxOnAmount',
               false
             )
             AND rate."qboId" IS NOT NULL
             AND rate."active" IS TRUE
             AND COALESCE(
               rate."rateValue" BETWEEN 0::numeric AND 999.999999::numeric,
               false
             )
           ), false) AS "componentsValid",
           SUM(rate."rateValue") AS "combinedRate"
    FROM "QboTaxCode" tax
    LEFT JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(tax."purchaseTaxRateList") = 'array'
        THEN tax."purchaseTaxRateList" ELSE '[]'::jsonb END
    ) AS component(value) ON true
    LEFT JOIN "QboTaxRate" rate
      ON rate."companyId" = tax."companyId"
     AND rate."qboId" = component.value->>'taxRateQboId'
    WHERE tax."companyId" IN (${Prisma.join(companyIds)})
    GROUP BY tax."id"
  )`;
}

function purchaseTaxCodeEligibilitySql(
  taxCalculation: Prisma.Sql,
  taxCodeQboId: Prisma.Sql,
): Prisma.Sql {
  return Prisma.sql`CASE
    WHEN ${taxCalculation} = 'NotApplicable'
      THEN ${taxCodeQboId} IS NULL
    WHEN ${taxCalculation} IN ('TaxInclusive', 'TaxExcluded')
      THEN tax."active" IS TRUE
       AND jsonb_typeof(tax."purchaseTaxRateList") = 'array'
       AND (
         (tax."taxable" IS TRUE
          AND (
            (${taxCalculation} = 'TaxInclusive'
             AND jsonb_array_length(tax."purchaseTaxRateList") > 0)
            OR (${taxCalculation} = 'TaxExcluded'
                AND jsonb_array_length(tax."purchaseTaxRateList") = 1)
          )
          AND tax_support."componentsValid"
          AND tax_support."componentCount" = tax_support."distinctComponentCount"
          AND tax_support."combinedRate" IS NOT NULL
          AND tax_support."combinedRate" BETWEEN 0::numeric AND 999.999999::numeric)
         OR (tax."taxable" IS FALSE
             AND jsonb_array_length(tax."purchaseTaxRateList") = 0)
       )
    ELSE false
  END`;
}

function directionalRuleTaxSupportCte(companyIds: readonly string[]): Prisma.Sql {
  return Prisma.sql`"rule_tax_support" AS MATERIALIZED (
    SELECT tax."id" AS "taxCodeId", tax_direction."direction",
           COUNT(component.value)::integer AS "componentCount",
           COUNT(DISTINCT component.value->>'taxRateQboId')::integer
             AS "distinctComponentCount",
           COALESCE(BOOL_AND(
             jsonb_typeof(component.value) = 'object'
             AND NULLIF(btrim(component.value->>'taxRateQboId'), '') IS NOT NULL
             AND COALESCE(component.value->>'taxTypeApplicable' = 'TaxOnAmount', false)
             AND rate."qboId" IS NOT NULL
             AND rate."active" IS TRUE
             AND COALESCE(rate."rateValue" BETWEEN 0::numeric AND 999.999999::numeric, false)
           ), false) AS "componentsValid",
           SUM(rate."rateValue") AS "combinedRate"
    FROM "QboTaxCode" tax
    CROSS JOIN LATERAL (
      VALUES
        ('Purchase'::text, CASE WHEN jsonb_typeof(tax."purchaseTaxRateList") = 'array'
          THEN tax."purchaseTaxRateList" ELSE '[]'::jsonb END),
        ('Deposit'::text, CASE WHEN jsonb_typeof(tax."salesTaxRateList") = 'array'
          THEN tax."salesTaxRateList" ELSE '[]'::jsonb END)
    ) AS tax_direction("direction", "rateList")
    LEFT JOIN LATERAL jsonb_array_elements(tax_direction."rateList")
      AS component(value) ON true
    LEFT JOIN "QboTaxRate" rate
      ON rate."companyId" = tax."companyId"
     AND rate."qboId" = component.value->>'taxRateQboId'
    WHERE tax."companyId" IN (${Prisma.join(companyIds)})
    GROUP BY tax."id", tax_direction."direction"
  )`;
}

function directionalRuleTaxCodeEligibilitySql(
  direction: Prisma.Sql,
  taxCalculation: Prisma.Sql,
  taxCodeQboId: Prisma.Sql,
): Prisma.Sql {
  const rateList = Prisma.sql`CASE ${direction}
    WHEN 'Deposit' THEN tax."salesTaxRateList"
    ELSE tax."purchaseTaxRateList"
  END`;
  return Prisma.sql`CASE
    WHEN ${taxCalculation} = 'NotApplicable'
      THEN ${taxCodeQboId} IS NULL
    WHEN ${taxCalculation} IN ('TaxInclusive', 'TaxExcluded')
      THEN tax."active" IS TRUE
       AND jsonb_typeof(${rateList}) = 'array'
       AND (
         (tax."taxable" IS TRUE
          AND (
            (${taxCalculation} = 'TaxInclusive'
             AND jsonb_array_length(${rateList}) > 0)
            OR (${taxCalculation} = 'TaxExcluded'
                AND jsonb_array_length(${rateList}) = 1)
          )
          AND tax_support."componentsValid"
          AND tax_support."componentCount" = tax_support."distinctComponentCount"
          AND tax_support."combinedRate" IS NOT NULL
          AND tax_support."combinedRate" BETWEEN 0::numeric AND 999.999999::numeric)
         OR (tax."taxable" IS FALSE AND jsonb_array_length(${rateList}) = 0)
       )
    ELSE false
  END`;
}

export interface ClassificationSearchRecord {
  hit: ClassificationSearchHit;
  revisedAt: string;
  lexicalScore: number;
  exactReasons: ClassificationMatchReason[];
  document?: ClassificationSearchDocument;
  /** Internal source identity; never returned to callers. */
  sourceTransactionId?: string;
  /** Deterministic exact-key source; never returned to callers. */
  lookupValue?: string;
  /** Internal rule matcher generation; never returned to callers. */
  ruleMatchSemantics?: 'legacy' | 'canonical';
  /** Optional evidence-native transaction dimensions. Missing dimensions are
   * unknown and remain eligible; known mismatches are excluded before rank. */
  context?: ClassificationSearchRecordContext;
}

export interface ClassificationSearchRecordContext {
  transactionDirection?: 'in' | 'out' | 'unknown';
  qboType?: 'Purchase' | 'Deposit' | 'JournalEntry';
  sourceAccountName?: string | null;
  currency?: string;
  transactionDate?: string;
  jurisdiction?: string | null;
  taxCalculation?: ClassificationAction['taxCalculation'];
}

export interface ClassificationSearchContextFilter {
  transactionDirection?: 'in' | 'out' | 'unknown';
  qboType?: 'Purchase' | 'Deposit' | 'JournalEntry';
  sourceAccountName?: string;
  currency?: string;
  transactionPeriod?: string;
  jurisdiction?: string | null;
  taxCalculation?: ClassificationAction['taxCalculation'];
}

export interface ClassificationSearchRepository {
  exact(
    companyIds: readonly string[],
    query: string,
    limit: number,
    context?: ClassificationSearchContextFilter,
    excludeTransactionId?: string,
  ): Promise<ClassificationSearchRecord[]>;
  search(
    companyIds: readonly string[],
    query: string,
    limit: number,
    context?: ClassificationSearchContextFilter,
    excludeTransactionId?: string,
  ): Promise<ClassificationSearchRecord[]>;
  rehydrate(
    companyIds: readonly string[],
    documentIds: readonly string[],
    context?: ClassificationSearchContextFilter,
    excludeTransactionId?: string,
  ): Promise<ClassificationSearchRecord[]>;
  documents(companyId: string, expectedRevision?: string): Promise<ClassificationSearchCorpus>;
  revisions?(companyIds: readonly string[]): Promise<Readonly<Record<string, string>>>;
}

export interface ClassificationSearchCorpus {
  documents: ClassificationSearchDocument[];
  totalDocuments: number;
  skippedDocuments: number;
  revision: string;
}

export interface ClassificationSemanticSearch {
  generation: ClassificationEmbeddingGeneration;
  client: VoyageEmbeddingClient;
  store: Pick<
    PgClassificationVectorStore,
    'ensureAvailable' | 'healthMany' | 'search'
  >;
}

export interface ClassificationSearchDependencies {
  repository?: ClassificationSearchRepository;
  semantic: ClassificationSemanticSearch | null;
}

export interface ClassificationSearchSnapshot {
  result: ClassificationSearchResult;
  fingerprint: string;
}

export interface ClassificationSearchInput {
  query: string;
  companyId: string;
  scope: ClassificationSearchScope;
  mode: ClassificationSearchMode;
  limit?: number;
  accessibleCompanyIds: readonly string[];
  /** Internal-only evidence filters. Unknown evidence values are retained;
   * an evidence-native known mismatch is excluded before ranking. */
  context?: ClassificationSearchContextFilter;
  /** Internal-only selected transaction identity; matching case evidence is
   * excluded before ranking and never returned to callers. */
  excludeTransactionId?: string;
}

type DegradedReason = Exclude<ClassificationSearchResult['degradedReason'], null>;

export class ClassificationSearchError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_INPUT'
      | 'FORBIDDEN'
      | 'COMPANY_UNAVAILABLE'
      | 'SEMANTIC_UNAVAILABLE',
    public readonly reason: DegradedReason | null = null,
  ) {
    super(
      code === 'FORBIDDEN'
        ? 'Classification company access is forbidden.'
        : code === 'COMPANY_UNAVAILABLE'
          ? 'Classification data is temporarily unavailable.'
        : code === 'SEMANTIC_UNAVAILABLE'
          ? 'Semantic classification search is unavailable.'
          : 'Classification search input is invalid.',
    );
    this.name = 'ClassificationSearchError';
  }
}

async function boundedRepositoryRead<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ClassificationSearchError) throw error;
    throw new ClassificationSearchError('COMPANY_UNAVAILABLE');
  }
}

function checkedText(value: string, maximum: number): string {
  if (typeof value !== 'string' || CONTROL_CHARACTER.test(value)) {
    throw new ClassificationSearchError('INVALID_INPUT');
  }
  const normalized = value.normalize('NFC').trim();
  if (Array.from(normalized).length < 1 || Array.from(normalized).length > maximum) {
    throw new ClassificationSearchError('INVALID_INPUT');
  }
  return normalized;
}

function checkedOptionalIdentifier(value: string | undefined): string | undefined {
  return value === undefined
    ? undefined
    : checkedText(value, CLASSIFICATION_CONTRACT_LIMITS.identifier);
}

function selectedCompanyIds(input: ClassificationSearchInput): string[] {
  const current = checkedText(input.companyId, CLASSIFICATION_CONTRACT_LIMITS.identifier);
  if (!Array.isArray(input.accessibleCompanyIds)) {
    throw new ClassificationSearchError('INVALID_INPUT');
  }
  const accessible = [...new Set(input.accessibleCompanyIds.map((value) => (
    checkedText(value, CLASSIFICATION_CONTRACT_LIMITS.identifier)
  )))];
  if (accessible.length > MAX_ACCESSIBLE_COMPANIES || !accessible.includes(current)) {
    throw new ClassificationSearchError('FORBIDDEN');
  }
  return input.scope === 'current_company' ? [current] : accessible;
}

function checkedContext(
  raw: ClassificationSearchContextFilter | undefined,
): ClassificationSearchContextFilter | undefined {
  if (raw === undefined) return undefined;
  const result: ClassificationSearchContextFilter = {};
  if (raw.transactionDirection !== undefined) {
    if (!['in', 'out', 'unknown'].includes(raw.transactionDirection)) {
      throw new ClassificationSearchError('INVALID_INPUT');
    }
    if (raw.transactionDirection !== 'unknown') result.transactionDirection = raw.transactionDirection;
  }
  if (raw.qboType !== undefined) {
    if (!['Purchase', 'Deposit', 'JournalEntry'].includes(raw.qboType)) {
      throw new ClassificationSearchError('INVALID_INPUT');
    }
    result.qboType = raw.qboType;
  }
  if (raw.sourceAccountName !== undefined) {
    result.sourceAccountName = checkedText(raw.sourceAccountName, 500);
  }
  if (raw.currency !== undefined) {
    if (!/^[A-Z]{3}$/u.test(raw.currency)) throw new ClassificationSearchError('INVALID_INPUT');
    result.currency = raw.currency;
  }
  if (raw.transactionPeriod !== undefined) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(raw.transactionPeriod)) {
      throw new ClassificationSearchError('INVALID_INPUT');
    }
    result.transactionPeriod = raw.transactionPeriod;
  }
  if (raw.jurisdiction !== undefined && raw.jurisdiction !== null) {
    const jurisdiction = checkedText(raw.jurisdiction, 128);
    if (jurisdiction.toLocaleLowerCase('en-US') !== 'unknown') result.jurisdiction = jurisdiction;
  }
  if (raw.taxCalculation !== undefined) {
    if (!['TaxInclusive', 'TaxExcluded', 'NotApplicable'].includes(raw.taxCalculation)) {
      throw new ClassificationSearchError('INVALID_INPUT');
    }
    result.taxCalculation = raw.taxCalculation;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function recordsMatchingContext(
  records: readonly ClassificationSearchRecord[],
  filter: ClassificationSearchContextFilter | undefined,
  excludeTransactionId?: string,
): ClassificationSearchRecord[] {
  return records.filter((record) => {
    if (excludeTransactionId !== undefined && record.sourceTransactionId === excludeTransactionId) {
      return false;
    }
    if (filter === undefined) return true;
    const value = record.context;
    if (value === undefined) return true;
    const folded = (source: string) => source.normalize('NFC').trim().toLocaleLowerCase('en-US');
    if (filter.transactionDirection !== undefined
      && value.transactionDirection !== undefined
      && value.transactionDirection !== 'unknown'
      && value.transactionDirection !== filter.transactionDirection) return false;
    if (filter.qboType !== undefined && value.qboType !== undefined && value.qboType !== filter.qboType) return false;
    if (filter.sourceAccountName !== undefined
      && value.sourceAccountName !== undefined
      && value.sourceAccountName !== null
      && folded(value.sourceAccountName) !== folded(filter.sourceAccountName)) return false;
    if (filter.currency !== undefined && value.currency !== undefined && value.currency !== filter.currency) return false;
    if (filter.transactionPeriod !== undefined
      && value.transactionDate !== undefined
      && !value.transactionDate.startsWith(`${filter.transactionPeriod}-`)) return false;
    if (filter.jurisdiction !== undefined
      && value.jurisdiction !== undefined
      && value.jurisdiction !== null
      && value.jurisdiction !== 'unknown'
      && value.jurisdiction !== filter.jurisdiction) return false;
    if (filter.taxCalculation !== undefined
      && value.taxCalculation !== undefined
      && value.taxCalculation !== filter.taxCalculation) return false;
    return true;
  });
}

function kindReason(
  kind: ClassificationSearchHit['kind'],
): ClassificationMatchReason {
  switch (kind) {
    case 'vendor_alias': return 'alias';
    case 'rule': return 'rule';
    case 'rule_candidate': return 'candidate';
    case 'classification_case': return 'case';
    case 'vendor_identity': return 'alias';
    case 'historical_observation': return 'observation';
  }
}

function sourceReason(hit: ClassificationSearchHit): ClassificationMatchReason {
  return kindReason(hit.kind);
}

function relationSafeHit(
  raw: ClassificationSearchHit,
  currentCompanyId: string,
): ClassificationSearchHit {
  const foreign = raw.companyId !== currentCompanyId;
  const source = sourceReason(raw);
  const matchedIn = [...new Set([
    source,
    ...raw.matchedIn,
  ])];
  const observation = foreign && raw.observation !== null
    ? {
      ...raw.observation,
      sourceTransactionId: 'redacted',
      sourceQboId: 'redacted',
      sourceQboSyncToken: 'redacted',
    }
    : raw.observation;
  return parseClassificationSearchHit({
    ...raw,
    companyRelation: foreign ? 'foreign' : 'current',
    executable: foreign ? false : raw.executable,
    advisory: foreign ? true : raw.advisory,
    action: foreign ? null : raw.action,
    conflicts: foreign
      ? raw.conflicts.map((conflict) => ({ ...conflict, action: null }))
      : raw.conflicts,
    observation,
    matchedIn,
  });
}

function lexicalLists(records: readonly ClassificationSearchRecord[]): RankedDocumentList[] {
  const ordered = [...records].sort((left, right) => (
    right.lexicalScore - left.lexicalScore
    || Date.parse(right.revisedAt) - Date.parse(left.revisedAt)
    || left.hit.id.localeCompare(right.hit.id)
  ));
  const lists: RankedDocumentList[] = [{
    matchedIn: 'lexical',
    hits: ordered.map((record) => ({ id: record.hit.id, revisedAt: record.revisedAt })),
  }];
  for (const reason of ['alias', 'rule'] as const) {
    const exact = records.filter((record) => record.exactReasons.includes(reason));
    if (exact.length > 0) {
      lists.push({
        matchedIn: reason,
        hits: exact.map((record) => ({ id: record.hit.id, revisedAt: record.revisedAt })),
      });
    }
  }
  return lists;
}

function exactLists(records: readonly ClassificationSearchRecord[]): RankedDocumentList[] {
  return (['alias', 'rule'] as const).flatMap((reason) => {
    const hits = records
      .filter((record) => record.exactReasons.includes(reason))
      .map((record) => ({ id: record.hit.id, revisedAt: record.revisedAt }));
    return hits.length === 0 ? [] : [{ matchedIn: reason, hits }];
  });
}

type SearchTrustTier =
  | 'enabled_rule'
  | 'verified_case'
  | 'ready_candidate'
  | 'historical_observation'
  | 'conflicting_candidate'
  | 'identity_discovery';

const SEARCH_TRUST_TIER_RANK: Readonly<Record<SearchTrustTier, number>> = {
  enabled_rule: 0,
  verified_case: 1,
  ready_candidate: 2,
  historical_observation: 3,
  conflicting_candidate: 4,
  identity_discovery: 5,
};

function searchTrustTier(record: ClassificationSearchRecord): SearchTrustTier {
  switch (record.hit.kind) {
    case 'rule': return 'enabled_rule';
    case 'classification_case': return 'verified_case';
    case 'historical_observation': return 'historical_observation';
    case 'rule_candidate': return record.hit.conflictingEvidenceCount === 0
      ? 'ready_candidate'
      : 'conflicting_candidate';
    case 'vendor_identity':
    case 'vendor_alias': return 'identity_discovery';
  }
}

function rankClassificationRecords(
  fused: readonly ReturnType<typeof reciprocalRankFuse>[number][],
  records: ReadonlyMap<string, ClassificationSearchRecord>,
): ReturnType<typeof reciprocalRankFuse> {
  return [...fused].sort((left, right) => {
    const leftRecord = records.get(left.id);
    const rightRecord = records.get(right.id);
    if (leftRecord === undefined || rightRecord === undefined) {
      return left.id.localeCompare(right.id);
    }
    return SEARCH_TRUST_TIER_RANK[searchTrustTier(leftRecord)]
      - SEARCH_TRUST_TIER_RANK[searchTrustTier(rightRecord)]
      || right.score - left.score
      || Date.parse(rightRecord.revisedAt) - Date.parse(leftRecord.revisedAt)
      || left.id.localeCompare(right.id);
  });
}

async function semanticLeg(
  companyIds: readonly string[],
  query: string,
  fetchLimit: number,
  semantic: ClassificationSemanticSearch,
): Promise<VectorSearchHit[]> {
  let capability;
  try {
    capability = await semantic.store.ensureAvailable();
  } catch {
    throw new ClassificationSearchError('SEMANTIC_UNAVAILABLE', 'semantic_error');
  }
  if (!capability.available) {
    throw new ClassificationSearchError(
      'SEMANTIC_UNAVAILABLE',
      'vector_capability_unavailable',
    );
  }
  let health: VectorGenerationHealth[];
  try {
    health = await semantic.store.healthMany(companyIds, semantic.generation.fingerprint);
  } catch {
    throw new ClassificationSearchError('SEMANTIC_UNAVAILABLE', 'semantic_error');
  }
  if (health.some((state) => (
    state.activeGeneration !== semantic.generation.fingerprint
    || state.expectedGeneration !== semantic.generation.fingerprint
    || state.expectedState !== 'succeeded'
    || state.backlog !== 0
    || state.progress !== 1
    || state.lastError !== null
    || state.currentCorpusRevision !== state.indexedCorpusRevision
    || state.currentCorpusRevision !== state.expectedCorpusRevision
  ))) {
    throw new ClassificationSearchError('SEMANTIC_UNAVAILABLE', 'semantic_unavailable');
  }
  try {
    const embedding = await semantic.client.embedQuery(query);
    return await semantic.store.search({
      companyIds,
      fingerprint: semantic.generation.fingerprint,
      embedding,
      cosineFloor: COSINE_FLOOR,
      limit: fetchLimit,
    });
  } catch (error) {
    if (error instanceof ClassificationSearchError) throw error;
    throw new ClassificationSearchError('SEMANTIC_UNAVAILABLE', 'semantic_error');
  }
}

function finalResult(input: {
  query: string;
  companyId: string;
  scope: ClassificationSearchScope;
  requestedMode: ClassificationSearchMode;
  mode: ClassificationEffectiveSearchMode;
  degradedReason: DegradedReason | null;
  records: readonly ClassificationSearchRecord[];
  lists: readonly RankedDocumentList[];
  limit: number;
}): ClassificationSearchResult {
  const byId = new Map(input.records.map((record) => [record.hit.id, record]));
  const fused = rankClassificationRecords(
    reciprocalRankFuse(input.lists, { limit: MAX_FETCH }),
    byId,
  );
  const hits = fused.flatMap((ranked) => {
    const record = byId.get(ranked.id);
    if (record === undefined) return [];
    const hit = relationSafeHit({
      ...record.hit,
      score: ranked.score,
      matchedIn: [...new Set([...record.hit.matchedIn, ...ranked.matchedIn])],
    }, input.companyId);
    return [hit];
  });
  const page = hits.slice(0, input.limit);
  return parseClassificationSearchResult({
    query: input.query,
    companyId: input.companyId,
    scope: input.scope,
    mode: input.mode,
    requestedMode: input.requestedMode,
    degraded: input.degradedReason !== null,
    degradedReason: input.degradedReason,
    status: page.length === 0 ? 'no_match' : 'matched',
    noMatch: page.length === 0,
    hits: page,
    total: hits.length,
  });
}

export async function searchClassificationMemory(
  rawInput: ClassificationSearchInput,
  dependencies: ClassificationSearchDependencies,
): Promise<ClassificationSearchResult> {
  const query = checkedText(rawInput.query, CLASSIFICATION_CONTRACT_LIMITS.query);
  const companyId = checkedText(rawInput.companyId, CLASSIFICATION_CONTRACT_LIMITS.identifier);
  const companyIds = selectedCompanyIds(rawInput);
  const context = checkedContext(rawInput.context);
  const excludeTransactionId = checkedOptionalIdentifier(rawInput.excludeTransactionId);
  const limit = Math.max(1, Math.min(
    CLASSIFICATION_CONTRACT_LIMITS.hits,
    Math.trunc(rawInput.limit ?? 20),
  ));
  if (!Number.isFinite(limit)) throw new ClassificationSearchError('INVALID_INPUT');
  const fetchLimit = context === undefined
    ? Math.min(MAX_FETCH, limit * SEARCH_FETCH_MULTIPLIER)
    : MAX_FETCH;
  const repository = dependencies.repository ?? new PrismaClassificationSearchRepository();

  if (rawInput.mode === 'exact') {
    const loaded = await boundedRepositoryRead(() => (
      repository.exact(companyIds, query, fetchLimit, context, excludeTransactionId)
    ));
    const records = recordsMatchingContext(loaded, context, excludeTransactionId);
    return finalResult({
      query, companyId, scope: rawInput.scope, requestedMode: 'exact', mode: 'exact',
      degradedReason: null, records, lists: exactLists(records), limit,
    });
  }

  if (rawInput.mode === 'lexical') {
    const loaded = await boundedRepositoryRead(() => (
      repository.search(companyIds, query, fetchLimit, context, excludeTransactionId)
    ));
    const records = recordsMatchingContext(loaded, context, excludeTransactionId);
    return finalResult({
      query, companyId, scope: rawInput.scope, requestedMode: 'lexical', mode: 'lexical',
      degradedReason: null, records, lists: lexicalLists(records), limit,
    });
  }

  if (dependencies.semantic === null) {
    if (rawInput.mode !== 'auto') {
      throw new ClassificationSearchError('SEMANTIC_UNAVAILABLE', 'embedding_not_configured');
    }
    const loaded = await boundedRepositoryRead(() => (
      repository.search(companyIds, query, fetchLimit, context, excludeTransactionId)
    ));
    const records = recordsMatchingContext(loaded, context, excludeTransactionId);
    return finalResult({
      query, companyId, scope: rawInput.scope, requestedMode: 'auto', mode: 'lexical',
      degradedReason: 'embedding_not_configured', records, lists: lexicalLists(records), limit,
    });
  }

  if (rawInput.mode === 'semantic') {
    const semanticHits = await semanticLeg(
      companyIds, query, fetchLimit, dependencies.semantic,
    );
    const rolled = rollupSemanticChunks(semanticHits.map((hit) => ({
      documentId: hit.documentId,
      similarity: hit.similarity,
      revisedAt: hit.revisedAt,
    })), { cosineFloor: COSINE_FLOOR, limit: fetchLimit });
    const loaded = await boundedRepositoryRead(() => (
      repository.rehydrate(companyIds, rolled.map((hit) => hit.id), context, excludeTransactionId)
    ));
    const records = recordsMatchingContext(loaded, context, excludeTransactionId);
    const eligibleIds = new Set(records.map((record) => record.hit.id));
    const eligibleSemantic = rolled.filter((hit) => eligibleIds.has(hit.id));
    return finalResult({
      query, companyId, scope: rawInput.scope, requestedMode: 'semantic', mode: 'semantic',
      degradedReason: null, records,
      lists: [{ matchedIn: 'semantic', hits: eligibleSemantic }], limit,
    });
  }

  const lexicalPromise = boundedRepositoryRead(() => (
    repository.search(companyIds, query, fetchLimit, context, excludeTransactionId)
  ));
  const semanticPromise = semanticLeg(
    companyIds, query, fetchLimit, dependencies.semantic,
  );
  let lexical: ClassificationSearchRecord[];
  let semanticHits: VectorSearchHit[];
  try {
    [lexical, semanticHits] = await Promise.all([lexicalPromise, semanticPromise]);
  } catch (error) {
    if (rawInput.mode !== 'auto') throw error;
    if (error instanceof ClassificationSearchError && error.code !== 'SEMANTIC_UNAVAILABLE') {
      throw error;
    }
    lexical = recordsMatchingContext(await lexicalPromise, context, excludeTransactionId);
    const reason = error instanceof ClassificationSearchError && error.reason !== null
      ? error.reason
      : 'semantic_error';
    return finalResult({
      query, companyId, scope: rawInput.scope, requestedMode: 'auto', mode: 'lexical',
      degradedReason: reason, records: lexical, lists: lexicalLists(lexical), limit,
    });
  }
  const rolled = rollupSemanticChunks(semanticHits.map((hit) => ({
    documentId: hit.documentId,
    similarity: hit.similarity,
    revisedAt: hit.revisedAt,
  })), { cosineFloor: COSINE_FLOOR, limit: fetchLimit });
  const loadedRehydrated = await boundedRepositoryRead(() => (
    repository.rehydrate(companyIds, rolled.map((hit) => hit.id), context, excludeTransactionId)
  ));
  const rehydrated = recordsMatchingContext(loadedRehydrated, context, excludeTransactionId);
  const eligibleSemanticIds = new Set(rehydrated.map((record) => record.hit.id));
  const eligibleSemantic = rolled.filter((hit) => eligibleSemanticIds.has(hit.id));
  lexical = recordsMatchingContext(lexical, context, excludeTransactionId);
  // Lexical rows carry query-specific exact-source provenance; queryless
  // semantic rehydration may fill only IDs that the lexical leg did not find.
  const records = [...new Map(
    [...rehydrated, ...lexical].map((record) => [record.hit.id, record]),
  ).values()];
  return finalResult({
    query,
    companyId,
    scope: rawInput.scope,
    requestedMode: rawInput.mode,
    mode: 'hybrid',
    degradedReason: null,
    records,
    lists: [
      ...lexicalLists(lexical),
      { matchedIn: 'semantic', hits: eligibleSemantic },
    ],
    limit,
  });
}

export async function searchClassificationMemorySnapshot(
  rawInput: ClassificationSearchInput,
  dependencies: ClassificationSearchDependencies,
): Promise<ClassificationSearchSnapshot> {
  const repository = dependencies.repository ?? new PrismaClassificationSearchRepository();
  const companyIds = selectedCompanyIds(rawInput);
  // Retry one transient corpus change; every returned page still has a verified snapshot.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = repository.revisions === undefined
      ? {}
      : await boundedRepositoryRead(() => repository.revisions!(companyIds));
    const result = await searchClassificationMemory(rawInput, { ...dependencies, repository });
    const after = repository.revisions === undefined
      ? before
      : await boundedRepositoryRead(() => repository.revisions!(companyIds));
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      if (attempt === 0) continue;
      throw new ClassificationSearchError('COMPANY_UNAVAILABLE');
    }
    const fingerprint = createHash('sha256').update(JSON.stringify({
      v: 1,
      input: {
        query: rawInput.query,
        companyId: rawInput.companyId,
        scope: rawInput.scope,
        mode: rawInput.mode,
        limit: rawInput.limit ?? 20,
        accessibleCompanyIds: [...new Set(rawInput.accessibleCompanyIds)].sort(),
        context: rawInput.context ?? null,
        ...(rawInput.excludeTransactionId === undefined
          ? {}
          : { excludeTransactionId: rawInput.excludeTransactionId }),
      },
      revisions: after,
      semanticGeneration: dependencies.semantic?.generation.fingerprint ?? null,
      result,
    }), 'utf8').digest('hex');
    return { result, fingerprint };
  }
  throw new ClassificationSearchError('COMPANY_UNAVAILABLE');
}

/** Shared runtime adapter. Provider configuration remains optional: exact and
 * lexical reads stay provider-independent, auto labels lexical degradation,
 * and explicit semantic/hybrid requests fail closed through the canonical
 * search service when configuration is absent or unhealthy. */
export async function searchClassificationMemoryWithRuntime(
  input: ClassificationSearchInput,
): Promise<ClassificationSearchResult> {
  const semantic = classificationSemanticRuntime(input.mode);
  return searchClassificationMemory(input, {
    repository: new PrismaClassificationSearchRepository(prisma),
    semantic,
  });
}

export async function searchClassificationMemoryWithRuntimeSnapshot(
  input: ClassificationSearchInput,
): Promise<ClassificationSearchSnapshot> {
  const semantic = classificationSemanticRuntime(input.mode);
  return searchClassificationMemorySnapshot(input, {
    repository: new PrismaClassificationSearchRepository(prisma),
    semantic,
  });
}

export function classificationSemanticRuntime(
  mode: ClassificationSearchMode,
  readConfig: typeof classificationEmbeddingRuntimeConfig = classificationEmbeddingRuntimeConfig,
): ClassificationSemanticSearch | null {
  if (mode === 'exact' || mode === 'lexical') return null;
  try {
    const config = readConfig();
    if (config === null) return null;
    return {
      generation: classificationEmbeddingGeneration({
        baseUrl: config.baseUrl,
        fingerprintSalt: config.fingerprintSalt,
      }),
      client: createVoyageEmbeddingClient(config),
      store: new PgClassificationVectorStore(prisma),
    };
  } catch {
    if (mode === 'auto') return null;
    throw new ClassificationSearchError('SEMANTIC_UNAVAILABLE', 'embedding_not_configured');
  }
}

/** PostgreSQL-backed repository is implemented below; lexical reads never
 * depend on the optional vector tables. */
export class PrismaClassificationSearchRepository implements ClassificationSearchRepository {
  constructor(private readonly db: PrismaClient = prisma) {}

  async revisions(companyIds: readonly string[]): Promise<Readonly<Record<string, string>>> {
    const checked = checkedCompanyList(companyIds).sort();
    const rows = await this.db.$queryRaw<Array<{ companyId: string; revision: bigint }>>(Prisma.sql`
      SELECT DISTINCT ON (revision."companyId")
             revision."companyId", revision."revision"
        FROM "ClassificationCorpusRevision" revision
       WHERE revision."companyId" IN (${Prisma.join(checked)})
       ORDER BY revision."companyId" ASC, revision."revision" DESC
    `);
    const byCompany = new Map(rows.map((row) => [row.companyId, row.revision.toString()]));
    if (byCompany.size !== checked.length || checked.some((companyId) => !byCompany.has(companyId))) {
      throw new ClassificationSearchError('COMPANY_UNAVAILABLE');
    }
    return Object.fromEntries(checked.map((companyId) => [companyId, byCompany.get(companyId)!]));
  }

  async exact(
    companyIds: readonly string[],
    query: string,
    limit: number,
    context?: ClassificationSearchContextFilter,
    _excludeTransactionId?: string,
  ): Promise<ClassificationSearchRecord[]> {
    const checkedCompanyIds = checkedCompanyList(companyIds);
    const checkedQuery = checkedText(query, CLASSIFICATION_CONTRACT_LIMITS.query);
    const boundedLimit = boundedFetchLimit(limit);
    const [identities, aliases, rules] = await Promise.all([
      this.identityRows(checkedCompanyIds, checkedQuery, null, boundedLimit, true),
      this.aliasRows(checkedCompanyIds, checkedQuery, null, boundedLimit, true),
      this.ruleRows(checkedCompanyIds, checkedQuery, null, boundedLimit, true, context),
    ]);
    return [
      ...identities.map(identityRecord),
      ...aliases.map(aliasRecord),
      ...rules.map(ruleRecord),
    ].flatMap((factory) => {
      try {
        const record = factory();
        record.exactReasons = record.hit.kind === 'rule' ? ['rule'] : ['alias'];
        return [record];
      } catch {
        return [];
      }
    }).sort((left, right) => (
      Date.parse(right.revisedAt) - Date.parse(left.revisedAt)
      || left.hit.id.localeCompare(right.hit.id)
    ));
  }

  async search(
    companyIds: readonly string[],
    query: string,
    limit: number,
    context?: ClassificationSearchContextFilter,
    excludeTransactionId?: string,
  ): Promise<ClassificationSearchRecord[]> {
    const checkedCompanyIds = checkedCompanyList(companyIds);
    const checkedQuery = checkedText(query, CLASSIFICATION_CONTRACT_LIMITS.query);
    return this.load(
      checkedCompanyIds, checkedQuery, null, boundedFetchLimit(limit), checkedContext(context),
      checkedOptionalIdentifier(excludeTransactionId),
    );
  }

  async rehydrate(
    companyIds: readonly string[],
    documentIds: readonly string[],
    context?: ClassificationSearchContextFilter,
    excludeTransactionId?: string,
  ): Promise<ClassificationSearchRecord[]> {
    const checkedCompanyIds = checkedCompanyList(companyIds);
    if (!Array.isArray(documentIds) || documentIds.length > MAX_FETCH) {
      throw new ClassificationSearchError('INVALID_INPUT');
    }
    const checkedIds = [...new Set(documentIds.map((id) => checkedText(id, 260)))];
    if (checkedIds.length === 0) return [];
    return this.load(
      checkedCompanyIds, null, checkedIds, checkedIds.length, checkedContext(context),
      checkedOptionalIdentifier(excludeTransactionId),
    );
  }

  async documents(companyId: string, expectedRevision?: string): Promise<ClassificationSearchCorpus> {
    const checkedCompanyId = checkedText(companyId, CLASSIFICATION_CONTRACT_LIMITS.identifier);
    const revision = expectedRevision === undefined
      ? await this.corpusRevision(checkedCompanyId)
      : checkedCorpusRevision(expectedRevision);
    await this.assertCorpusRevision(checkedCompanyId, revision);
    const documents: ClassificationSearchDocument[] = [];
    let totalDocuments = 0;
    let skippedDocuments = 0;
    let afterDocumentId: string | null = null;
    for (;;) {
      const ids = await this.documentIdsPage(checkedCompanyId, afterDocumentId, MAX_FETCH);
      await this.assertCorpusRevision(checkedCompanyId, revision);
      if (ids.length === 0) break;
      totalDocuments += ids.length;
      const records = await this.rehydrate([checkedCompanyId], ids);
      await this.assertCorpusRevision(checkedCompanyId, revision);
      const recordsById = new Map(records.map((record) => [record.hit.id, record]));
      for (const id of ids) {
        const document = recordsById.get(id)?.document;
        if (document === undefined) skippedDocuments += 1;
        else documents.push(document);
      }
      afterDocumentId = ids.at(-1) ?? null;
      if (ids.length < MAX_FETCH) break;
    }
    await this.assertCorpusRevision(checkedCompanyId, revision);
    return { documents, totalDocuments, skippedDocuments, revision };
  }

  private async corpusRevision(companyId: string): Promise<string> {
    const rows = await this.db.$queryRaw<Array<{ revision: bigint }>>(Prisma.sql`
      SELECT "revision" FROM "ClassificationCorpusRevision"
      WHERE "companyId" = ${companyId}
      ORDER BY "revision" DESC
      LIMIT 1
    `);
    if (rows.length !== 1) throw new ClassificationSearchError('COMPANY_UNAVAILABLE');
    return rows[0]!.revision.toString();
  }

  private async assertCorpusRevision(companyId: string, expectedRevision: string): Promise<void> {
    if (await this.corpusRevision(companyId) !== expectedRevision) {
      throw new ClassificationSearchError('COMPANY_UNAVAILABLE');
    }
  }

  private async documentIdsPage(
    companyId: string,
    afterDocumentId: string | null,
    limit: number,
  ): Promise<string[]> {
    const afterFilter = afterDocumentId === null
      ? Prisma.empty
      : Prisma.sql`WHERE concat(document_kind, ':', source_id) > ${afterDocumentId}`;
    const aliasResolution = resolvedVendorAliasCte([companyId], null);
    const rows = await this.db.$queryRaw<Array<{ documentId: string }>>(Prisma.sql`
      WITH RECURSIVE ${aliasResolution},
      canonical_documents AS (
        SELECT 'vendor_identity'::text AS document_kind, identity."id"::text AS source_id
        FROM "VendorIdentity" identity
        WHERE identity."companyId" = ${companyId}
          AND NOT EXISTS (
            SELECT 1 FROM "VendorIdentityMerge" pending
            WHERE pending."companyId" = identity."companyId"
              AND pending."sourceVendorIdentityId" = identity."id"
          )
        UNION ALL
        SELECT 'vendor_alias'::text, resolution."aliasId"::text
        FROM resolved_vendor_alias resolution
        WHERE resolution."companyId" = ${companyId}
        UNION ALL
        SELECT 'classification_case'::text, memory."id"::text
        FROM "ClassificationCase" memory
        LEFT JOIN "ClassificationCaseInvalidation" invalidation
          ON invalidation."companyId" = memory."companyId"
         AND invalidation."classificationCaseId" = memory."id"
        WHERE memory."companyId" = ${companyId} AND invalidation."id" IS NULL
        UNION ALL
        SELECT 'rule'::text, rule."id"::text
        FROM "Rule" rule
        WHERE rule."companyId" = ${companyId}
          AND rule."enabled" = true AND rule."retiredAt" IS NULL
        UNION ALL
        SELECT 'rule_candidate'::text, candidate."id"::text
        FROM "AutopilotRuleCandidate" candidate
        WHERE candidate."companyId" = ${companyId}
          AND candidate."state" IN ('ready', 'conflict')
        UNION ALL
        SELECT 'historical_observation'::text, observation."id"::text
        FROM "HistoricalClassificationObservation" observation
        WHERE observation."companyId" = ${companyId}
      )
      SELECT concat(document_kind, ':', source_id) AS "documentId"
      FROM canonical_documents
      ${afterFilter}
      ORDER BY document_kind ASC, source_id ASC
      LIMIT ${boundedFetchLimit(limit)}
    `);
    return rows.map((row) => checkedText(row.documentId, 260));
  }

  private async load(
    companyIds: readonly string[],
    query: string | null,
    documentIds: readonly string[] | null,
    limit: number,
    context?: ClassificationSearchContextFilter,
    excludeTransactionId?: string,
  ): Promise<ClassificationSearchRecord[]> {
    const idsByKind = splitDocumentIds(documentIds);
    const [identities, aliases, cases, rules, candidates, observations] = await Promise.all([
      this.identityRows(companyIds, query, idsByKind.vendor_identity, limit),
      this.aliasRows(companyIds, query, idsByKind.vendor_alias, limit),
      this.caseRows(companyIds, query, idsByKind.classification_case, limit, context),
      this.ruleRows(companyIds, query, idsByKind.rule, limit, false, context),
      this.candidateRows(companyIds, query, idsByKind.rule_candidate, limit),
      this.observationRows(
        companyIds, query, idsByKind.historical_observation, limit, context, excludeTransactionId,
      ),
    ]);
    const records = [
      ...identities.map(identityRecord),
      ...aliases.map(aliasRecord),
      ...cases.map(caseRecord),
      ...rules.map(ruleRecord),
      ...candidates.map(candidateRecord),
      ...observations.map(observationRecord),
    ].flatMap((record) => {
      try {
        const mapped = record();
        if (query !== null && mapped.lookupValue !== undefined) {
          const exact = mapped.ruleMatchSemantics === 'canonical'
            ? normalizeRuleMatchText(query).includes(normalizeRuleMatchText(mapped.lookupValue))
            : normalizeVendorLookupKey(mapped.lookupValue) === normalizeVendorLookupKey(query);
          if (exact) {
            mapped.exactReasons = mapped.hit.kind === 'rule' ? ['rule'] : ['alias'];
          }
        }
        return [mapped];
      } catch {
        // Legacy rows can predate bounded classification contracts. One bad
        // row must not take exact/lexical search down for the whole company.
        return [];
      }
    });
    return records
      .sort((left, right) => (
        right.lexicalScore - left.lexicalScore
        || Date.parse(right.revisedAt) - Date.parse(left.revisedAt)
        || left.hit.id.localeCompare(right.hit.id)
      ))
      .slice(0, limit);
  }

  private identityRows(
    companyIds: readonly string[],
    query: string | null,
    ids: readonly string[] | null,
    limit: number,
    exactOnly = false,
  ) {
    if (ids !== null && ids.length === 0) return Promise.resolve([] as VendorIdentitySearchRow[]);
    const idFilter = ids === null ? Prisma.empty : Prisma.sql`AND identity."id" IN (${Prisma.join(ids)})`;
    const exactKey = query === null ? null : normalizeVendorLookupKey(query);
    const matched = query === null
      ? Prisma.sql`true`
      : exactOnly
        ? Prisma.sql`bool_or(source_support."normalizedName" = ${exactKey})`
        : Prisma.sql`bool_or(
            source_support."normalizedName" = ${exactKey}
            OR to_tsvector('simple', source_support."searchText")
               @@ plainto_tsquery('simple', ${query})
          )`;
    const score = query === null || exactOnly
      ? Prisma.sql`0::double precision`
      : Prisma.sql`COALESCE(max(ts_rank_cd(
          to_tsvector('simple', source_support."searchText"),
          plainto_tsquery('simple', ${query})
        )), 0)::double precision`;
    const exactSourceCte = query === null
      ? Prisma.sql`
        exact_vendor_support ("companyId", "targetId", "exactSourceId", "exactSourceRevisedAt") AS (
          SELECT NULL::text, NULL::text, NULL::text, NULL::timestamptz
          WHERE false
        )
      `
      : Prisma.sql`
        exact_vendor_support AS (
          SELECT DISTINCT ON (source_support."companyId", source_support."targetId")
                 source_support."companyId", source_support."targetId",
                 source_support."id" AS "exactSourceId",
                 source_support."updatedAt" AS "exactSourceRevisedAt"
          FROM source_vendor_support source_support
          WHERE source_support."normalizedName" = ${exactKey}
          ORDER BY source_support."companyId", source_support."targetId",
                   source_support."normalizedName", source_support."id"
        )
      `;
    const vendorResolution = resolvedVendorIdentityCte(companyIds, ids);
    return this.db.$queryRaw<VendorIdentitySearchRow[]>(Prisma.sql`
      WITH RECURSIVE ${vendorResolution},
      source_vendor_support AS (
        SELECT resolution."companyId", resolution."targetId", source."id",
               source."normalizedName",
               GREATEST(source."createdAt", COALESCE(max(alias."createdAt"), source."createdAt")) AS "updatedAt",
               concat_ws(' ', source."displayName",
                 string_agg(alias."value", ' '
                            ORDER BY alias."normalizedValue" ASC, alias."id" ASC)) AS "searchText"
        FROM resolved_vendor_identity resolution
        JOIN "VendorIdentity" source
          ON source."companyId" = resolution."companyId"
         AND source."id" = resolution."sourceId"
        LEFT JOIN "VendorAlias" alias
          ON alias."companyId" = source."companyId"
         AND alias."vendorIdentityId" = source."id"
        GROUP BY resolution."companyId", resolution."targetId", source."id",
                 source."normalizedName", source."displayName", source."createdAt"
      ),
      vendor_identity_support AS (
        SELECT source_support."companyId", source_support."targetId",
               left(string_agg(source_support."searchText", ' '
                               ORDER BY source_support."normalizedName" ASC,
                                        source_support."id" ASC),
                    ${MAX_VENDOR_IDENTITY_SUPPORT_CODE_POINTS}::int) AS "values",
               ${matched} AS "matched", ${score} AS "lexicalScore"
        FROM source_vendor_support source_support
        GROUP BY source_support."companyId", source_support."targetId"
      ),
      ${exactSourceCte}
      SELECT identity."id", identity."companyId", company."nickname" AS "companyName",
             identity."displayName", identity."normalizedName", identity."createdAt" AS "revisedAt",
             support."values" AS "aliases", support."lexicalScore",
             exact_match."exactSourceId", exact_match."exactSourceRevisedAt"
      FROM "VendorIdentity" identity
      JOIN "Company" company ON company."id" = identity."companyId"
      JOIN resolved_vendor_identity canonical
        ON canonical."companyId" = identity."companyId"
       AND canonical."sourceId" = identity."id"
       AND canonical."targetId" = identity."id"
      JOIN vendor_identity_support support
        ON support."companyId" = identity."companyId"
       AND support."targetId" = identity."id"
      LEFT JOIN exact_vendor_support exact_match
        ON exact_match."companyId" = identity."companyId"
       AND exact_match."targetId" = identity."id"
      WHERE identity."companyId" IN (${Prisma.join(companyIds)})
        AND support."matched"
        ${idFilter}
      ORDER BY support."lexicalScore" DESC, identity."createdAt" DESC, identity."id" ASC
      LIMIT ${limit}
    `);
  }

  private aliasRows(
    companyIds: readonly string[],
    query: string | null,
    ids: readonly string[] | null,
    limit: number,
    exactOnly = false,
  ) {
    if (ids !== null && ids.length === 0) return Promise.resolve([] as VendorAliasSearchRow[]);
    const idFilter = ids === null ? Prisma.empty : Prisma.sql`AND alias."id" IN (${Prisma.join(ids)})`;
    const exactKey = query === null ? null : normalizeVendorLookupKey(query);
    const queryFilter = query === null ? Prisma.empty : exactOnly ? Prisma.sql`
      AND alias."normalizedValue" = ${exactKey}
    ` : Prisma.sql`
      AND (
        alias."normalizedValue" = ${exactKey}
        OR to_tsvector('simple', concat_ws(' ', alias."value", identity."displayName"))
           @@ plainto_tsquery('simple', ${query})
      )
    `;
    const score = query === null ? Prisma.sql`0::double precision` : Prisma.sql`
      ts_rank_cd(
        to_tsvector('simple', concat_ws(' ', alias."value", identity."displayName")),
        plainto_tsquery('simple', ${query})
      )::double precision
    `;
    const vendorResolution = resolvedVendorAliasCte(companyIds, ids);
    return this.db.$queryRaw<VendorAliasSearchRow[]>(Prisma.sql`
      WITH RECURSIVE ${vendorResolution}
      SELECT alias."id", alias."companyId", company."nickname" AS "companyName",
             identity."id" AS "vendorIdentityId", alias."value", alias."normalizedValue", alias."source",
             alias."createdAt" AS "revisedAt", identity."displayName" AS "vendorName",
             ${score} AS "lexicalScore"
      FROM "VendorAlias" alias
      JOIN "Company" company ON company."id" = alias."companyId"
      JOIN resolved_vendor_alias resolution
        ON resolution."companyId" = alias."companyId"
       AND resolution."aliasId" = alias."id"
      JOIN "VendorIdentity" identity
        ON identity."companyId" = resolution."companyId"
       AND identity."id" = resolution."targetId"
      WHERE alias."companyId" IN (${Prisma.join(companyIds)})
        ${idFilter} ${queryFilter}
      ORDER BY "lexicalScore" DESC, alias."createdAt" DESC, alias."id" ASC
      LIMIT ${limit}
    `);
  }

  private caseRows(
    companyIds: readonly string[],
    query: string | null,
    ids: readonly string[] | null,
    limit: number,
    context?: ClassificationSearchContextFilter,
  ) {
    if (ids !== null && ids.length === 0) return Promise.resolve([] as ClassificationCaseSearchRow[]);
    const idFilter = ids === null ? Prisma.empty : Prisma.sql`AND memory."id" IN (${Prisma.join(ids)})`;
    const snapshotPayee = Prisma.sql`CASE
      WHEN jsonb_typeof(memory."transactionSnapshot"->'payee') = 'string'
       AND char_length(memory."transactionSnapshot"->>'payee') BETWEEN 1 AND 500
      THEN memory."transactionSnapshot"->>'payee'
      ELSE left(transaction."payee", 500)
    END`;
    const snapshotMemo = Prisma.sql`CASE
      WHEN jsonb_typeof(memory."transactionSnapshot"->'memo') = 'string'
       AND char_length(memory."transactionSnapshot"->>'memo') <= 500
      THEN memory."transactionSnapshot"->>'memo'
      WHEN memory."transactionSnapshot" ? 'memo'
       AND memory."transactionSnapshot"->'memo' = 'null'::jsonb
      THEN NULL
      ELSE left(transaction."memo", 500)
    END`;
    const text = Prisma.sql`concat_ws(' ', ${snapshotPayee}, ${snapshotMemo}, identity."displayName",
      account."fullName", transaction."category", tax."name", transaction."taxCode",
      memory."rationale", memory."requiredEvidence"::text,
      memory."examples"::text, memory."counterexamples"::text, memory."citations"::text,
      memory."context"::text)`;
    const queryFilter = query === null ? Prisma.empty : Prisma.sql`
      AND to_tsvector('simple', ${text}) @@ plainto_tsquery('simple', ${query})
    `;
    const score = query === null ? Prisma.sql`0::double precision` : Prisma.sql`
      ts_rank_cd(to_tsvector('simple', ${text}), plainto_tsquery('simple', ${query}))::double precision
    `;
    const contextFilter = classificationCaseSqlFilter(context);
    return this.db.$queryRaw<ClassificationCaseSearchRow[]>(Prisma.sql`
      WITH ${purchaseTaxSupportCte(companyIds)}
      SELECT memory."id", memory."companyId", company."nickname" AS "companyName",
             memory."vendorIdentityId", identity."displayName" AS "vendorName", memory."action",
             memory."originIntent", memory."rationale", memory."requiredEvidence", memory."examples",
             memory."counterexamples", memory."reviewer", memory."jurisdiction", memory."currency",
             memory."context", memory."provenance", memory."verifiedAt", memory."verifiedAt" AS "revisedAt",
             memory."transactionId" AS "sourceTransactionId",
             transaction."date" AS "transactionDate",
             ${snapshotPayee} AS "payee", ${snapshotMemo} AS "memo",
             COALESCE(account."name", transaction."category") AS "categoryName",
             COALESCE(tax."name", transaction."taxCode") AS "taxCodeName",
             account."active" IS TRUE AS "categoryActive",
             company."taxSupportStatus" = 'ready' AS "taxReady",
             ${purchaseTaxCodeEligibilitySql(
               Prisma.sql`memory."action"->>'taxCalculation'`,
               Prisma.sql`memory."action"->>'taxCodeQboId'`,
             )}
               AS "taxCodeEligible",
             NOT EXISTS (
               SELECT 1
               FROM jsonb_array_elements_text(
                 CASE WHEN jsonb_typeof(memory."action"->'tagIds') = 'array'
                      THEN memory."action"->'tagIds' ELSE '[]'::jsonb END
               ) requested_tag("id")
               WHERE NOT EXISTS (
                 SELECT 1 FROM "Tag" current_tag
                 WHERE current_tag."companyId" = memory."companyId"
                   AND current_tag."id" = requested_tag."id"
               )
             ) AS "tagsExist",
             ${text} AS "searchText", ${score} AS "lexicalScore"
      FROM "ClassificationCase" memory
      JOIN "Company" company ON company."id" = memory."companyId"
      JOIN "Transaction" transaction ON transaction."companyId" = memory."companyId"
        AND transaction."id" = memory."transactionId"
      LEFT JOIN "VendorIdentity" identity ON identity."companyId" = memory."companyId"
        AND identity."id" = memory."vendorIdentityId"
      LEFT JOIN "QboAccount" account ON account."companyId" = memory."companyId"
        AND account."qboId" = memory."action"->>'categoryQboId'
      LEFT JOIN "QboTaxCode" tax ON tax."companyId" = memory."companyId"
        AND tax."qboId" = memory."action"->>'taxCodeQboId'
      LEFT JOIN "purchase_tax_support" tax_support
        ON tax_support."taxCodeId" = tax."id"
      LEFT JOIN "ClassificationCaseInvalidation" invalidation
        ON invalidation."companyId" = memory."companyId"
       AND invalidation."classificationCaseId" = memory."id"
      WHERE memory."companyId" IN (${Prisma.join(companyIds)})
        AND invalidation."id" IS NULL
        ${idFilter} ${queryFilter} ${contextFilter}
      ORDER BY "lexicalScore" DESC, memory."verifiedAt" DESC, memory."id" ASC
      LIMIT ${limit}
    `);
  }

  private ruleRows(
    companyIds: readonly string[],
    query: string | null,
    ids: readonly string[] | null,
    limit: number,
    exactOnly = false,
    context?: ClassificationSearchContextFilter,
  ) {
    if (ids !== null && ids.length === 0) return Promise.resolve([] as RuleSearchRow[]);
    const idFilter = ids === null ? Prisma.empty : Prisma.sql`AND rule."id" IN (${Prisma.join(ids)})`;
    const text = Prisma.sql`concat_ws(' ', revision."matchText", revision."category", account."fullName",
      revision."taxCode", tax."name", tags."names", rule."reviewReason")`;
    const legacyExactKey = query === null ? null : normalizeVendorLookupKey(query);
    const legacyMatched = query === null
      ? Prisma.sql`TRUE`
      : exactOnly
        ? Prisma.sql`normalize(lower(regexp_replace(trim(revision."matchText"), '\\s+', ' ', 'g')), NFC) = ${legacyExactKey}`
        : Prisma.sql`(
            normalize(lower(regexp_replace(trim(revision."matchText"), '\\s+', ' ', 'g')), NFC) = ${legacyExactKey}
            OR to_tsvector('simple', ${text}) @@ plainto_tsquery('simple', ${query})
          )`;
    const canonicalMatched = query === null
      ? Prisma.sql`TRUE`
      : exactOnly
        ? Prisma.sql`position(rule_match_key(revision."matchText") IN rule_match_key(${query})) > 0`
        : Prisma.sql`(
            position(rule_match_key(revision."matchText") IN rule_match_key(${query})) > 0
            OR to_tsvector('simple', ${text}) @@ plainto_tsquery('simple', ${query})
          )`;
    const canonicalDirectionMatched = context?.qboType === 'Purchase' || context?.qboType === 'Deposit'
      ? Prisma.sql`revision."direction"::text = ${context.qboType}`
      : context?.qboType === 'JournalEntry'
        ? Prisma.sql`FALSE`
        : Prisma.sql`TRUE`;
    const effectiveDirection = Prisma.sql`CASE
      WHEN company."ruleRuntimeMode"::text = 'canonical' THEN revision."direction"::text
      ELSE 'Purchase'
    END`;
    const score = query === null ? Prisma.sql`0::double precision` : Prisma.sql`
      ts_rank_cd(to_tsvector('simple', ${text}), plainto_tsquery('simple', ${query}))::double precision
    `;
    return this.db.$queryRaw<RuleSearchRow[]>(Prisma.sql`
      WITH ${directionalRuleTaxSupportCte(companyIds)}
      SELECT rule."id", rule."companyId", company."nickname" AS "companyName",
             revision."matchText", revision."categoryQboId", revision."taxCalculation", revision."taxCodeQboId",
             revision."originIntent", revision."revision", revision."changedBy" AS "updatedById",
             revision."createdAt" AS "revisedAt",
             revision."direction"::text AS "direction", company."ruleRuntimeMode"::text AS "ruleRuntimeMode",
             rule."reviewRequiredAt", rule."reviewReason",
             COALESCE(account."name", revision."category") AS "categoryName",
             COALESCE(tax."name", revision."taxCode") AS "taxCodeName",
             account."active" IS TRUE AND (
               company."ruleRuntimeMode"::text <> 'canonical'
               OR CASE revision."direction"::text
                 WHEN 'Purchase' THEN account."classification" IN ('COGS', 'Expenses')
                 WHEN 'Deposit' THEN account."classification" = 'Income'
                 ELSE false
               END
             ) AS "categoryActive",
             company."taxSupportStatus" = 'ready' AS "taxReady",
             ${directionalRuleTaxCodeEligibilitySql(
               effectiveDirection,
               Prisma.sql`revision."taxCalculation"`,
               Prisma.sql`revision."taxCodeQboId"`,
             )}
               AS "taxCodeEligible",
             NOT EXISTS (
               SELECT 1
               FROM jsonb_array_elements(CASE WHEN jsonb_typeof(revision."tagIds") = 'array'
                 THEN CASE WHEN jsonb_array_length(revision."tagIds") <= 50
                   THEN revision."tagIds" ELSE '[]'::jsonb END
                 ELSE '[]'::jsonb END) value
               WHERE jsonb_typeof(value) <> 'string'
                 OR NOT EXISTS (SELECT 1 FROM "Tag" current_tag
                   WHERE current_tag."id" = value #>> '{}' AND current_tag."companyId" = rule."companyId")
             ) AND CASE WHEN jsonb_typeof(revision."tagIds") = 'array'
               THEN jsonb_array_length(revision."tagIds") <= 50 ELSE false END AS "tagsExist",
             revision."tagIds" AS "tagIds",
             COALESCE(tags."namesArray", '[]'::jsonb) AS "tagNames",
             ${text} AS "searchText", ${score} AS "lexicalScore"
      FROM "Rule" rule
      JOIN "RuleRevision" revision ON revision."companyId" = rule."companyId"
        AND revision."ruleId" = rule."id" AND revision."revision" = rule."revision"
      JOIN "Company" company ON company."id" = rule."companyId"
      LEFT JOIN "QboAccount" account ON account."companyId" = rule."companyId"
        AND account."qboId" = revision."categoryQboId"
      LEFT JOIN "QboTaxCode" tax ON tax."companyId" = rule."companyId"
        AND tax."qboId" = revision."taxCodeQboId"
      LEFT JOIN "rule_tax_support" tax_support
        ON tax_support."taxCodeId" = tax."id"
       AND tax_support."direction" = ${effectiveDirection}
      LEFT JOIN LATERAL (
        SELECT string_agg(tag."name", ' ' ORDER BY relation."ordinal" ASC) AS "names",
               jsonb_agg(tag."name" ORDER BY relation."ordinal" ASC) AS "namesArray"
        FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(revision."tagIds") = 'array'
          THEN CASE WHEN jsonb_array_length(revision."tagIds") <= 50
            THEN revision."tagIds" ELSE '[]'::jsonb END
          ELSE '[]'::jsonb END)
          WITH ORDINALITY AS relation("tagId", "ordinal")
        JOIN "Tag" tag ON tag."id" = relation."tagId"
          AND tag."companyId" = rule."companyId"
      ) tags ON true
      WHERE rule."companyId" IN (${Prisma.join(companyIds)})
        AND rule."enabled" = true AND rule."retiredAt" IS NULL
        AND revision."state" = 'enabled' AND revision."retiredAt" IS NULL
        AND (
          (company."ruleRuntimeMode"::text IN ('legacy', 'bridge') AND ${legacyMatched})
          OR (
            company."ruleRuntimeMode"::text = 'canonical'
            AND rule."reviewRequiredAt" IS NULL AND rule."repairReason" IS NULL
            AND rule."canonicalVersion" = 2
            AND rule."direction"::text = revision."direction"::text
            AND revision."canonicalVersion" = 2
            AND revision."direction"::text IN ('Purchase', 'Deposit')
            AND rule_match_key(revision."matchText") <> ''
            AND ${canonicalDirectionMatched}
            AND ${canonicalMatched}
          )
        )
        ${idFilter}
      ORDER BY "lexicalScore" DESC, revision."createdAt" DESC, rule."id" ASC
      LIMIT ${limit}
    `);
  }

  private candidateRows(
    companyIds: readonly string[],
    query: string | null,
    ids: readonly string[] | null,
    limit: number,
  ) {
    if (ids !== null && ids.length === 0) return Promise.resolve([] as CandidateSearchRow[]);
    const idFilter = ids === null ? Prisma.empty : Prisma.sql`AND candidate."id" IN (${Prisma.join(ids)})`;
    const text = Prisma.sql`concat_ws(' ', candidate."matchText", account."fullName", tax."name",
      evidence."patterns", evidence."transactions")`;
    const queryFilter = query === null ? Prisma.empty : Prisma.sql`
      AND to_tsvector('simple', ${text}) @@ plainto_tsquery('simple', ${query})
    `;
    const score = query === null ? Prisma.sql`0::double precision` : Prisma.sql`
      ts_rank_cd(to_tsvector('simple', ${text}), plainto_tsquery('simple', ${query}))::double precision
    `;
    return this.db.$queryRaw<CandidateSearchRow[]>(Prisma.sql`
      SELECT candidate."id", candidate."companyId", company."nickname" AS "companyName",
             candidate."matchText", candidate."state", candidate."categoryQboId",
             candidate."taxCalculation", candidate."taxCodeQboId", candidate."tagIds",
             candidate."evidenceCount", candidate."conflictingEvidenceCount",
             GREATEST(candidate."createdAt", COALESCE(evidence."latestObservedAt", candidate."createdAt")) AS "revisedAt",
             account."name" AS "categoryName",
             tax."name" AS "taxCodeName", COALESCE(evidence."patterns", '') AS "patterns",
             COALESCE(evidence."transactions", '') AS "transactions",
             ${text} AS "searchText", ${score} AS "lexicalScore"
      FROM "AutopilotRuleCandidate" candidate
      JOIN "Company" company ON company."id" = candidate."companyId"
      LEFT JOIN "QboAccount" account ON account."companyId" = candidate."companyId"
        AND account."qboId" = candidate."categoryQboId"
      LEFT JOIN "QboTaxCode" tax ON tax."companyId" = candidate."companyId"
        AND tax."qboId" = candidate."taxCodeQboId"
      LEFT JOIN LATERAL (
        SELECT left(string_agg(bounded_evidence.pattern_text, ' '
                              ORDER BY bounded_evidence."observedAt" DESC, bounded_evidence."id" ASC), 8000)
                 AS "patterns",
               left(string_agg(bounded_evidence.transaction_text, ' '
                              ORDER BY bounded_evidence."observedAt" DESC, bounded_evidence."id" ASC), 8000)
                 AS "transactions", max(bounded_evidence."observedAt") AS "latestObservedAt"
        FROM (
          SELECT candidateEvidence."id", candidateEvidence."observedAt",
                 left(candidateEvidence."pattern"::text, 1000) AS pattern_text,
                 left(concat_ws(' ', left(transaction."payee", 500), left(transaction."memo", 500)), 1000)
                   AS transaction_text
          FROM "AutopilotRuleCandidateEvidence" candidateEvidence
          JOIN "Transaction" transaction ON transaction."companyId" = candidateEvidence."companyId"
            AND transaction."id" = candidateEvidence."transactionId"
          WHERE candidateEvidence."companyId" = candidate."companyId"
            AND candidateEvidence."candidateId" = candidate."id"
            AND candidateEvidence."active" = true
          ORDER BY candidateEvidence."observedAt" DESC, candidateEvidence."id" ASC
          LIMIT 50
        ) bounded_evidence
      ) evidence ON true
      WHERE candidate."companyId" IN (${Prisma.join(companyIds)})
        AND candidate."state" IN ('ready', 'conflict')
        ${idFilter} ${queryFilter}
      ORDER BY "lexicalScore" DESC, "revisedAt" DESC, candidate."id" ASC
      LIMIT ${limit}
    `);
  }

  private observationRows(
    companyIds: readonly string[],
    query: string | null,
    ids: readonly string[] | null,
    limit: number,
    context?: ClassificationSearchContextFilter,
    excludeTransactionId?: string,
  ) {
    if (ids !== null && ids.length === 0) {
      return Promise.resolve([] as HistoricalObservationSearchRow[]);
    }
    const idFilter = ids === null
      ? Prisma.empty
      : Prisma.sql`AND observation."id" IN (${Prisma.join(ids)})`;
    const tagText = Prisma.sql`COALESCE((
      SELECT string_agg(tag_name, ' ' ORDER BY ordinal ASC)
      FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(observation."tagNames") = 'array'
          THEN observation."tagNames" ELSE '[]'::jsonb END
      ) WITH ORDINALITY tags(tag_name, ordinal)
    ), '')`;
    const text = Prisma.sql`concat_ws(' ', 'historical advisory observation', observation."payee",
      observation."memo", observation."sourceQboType", to_char(observation."transactionDate", 'YYYY-MM-DD'),
      observation."currency", observation."sourceAccountName", observation."categoryName",
      observation."taxCalculation", observation."taxCodeName", ${tagText})`;
    const queryFilter = query === null ? Prisma.empty : Prisma.sql`
      AND to_tsvector('simple', ${text}) @@ plainto_tsquery('simple', ${query})
    `;
    const score = query === null ? Prisma.sql`0::double precision` : Prisma.sql`
      ts_rank_cd(to_tsvector('simple', ${text}), plainto_tsquery('simple', ${query}))::double precision
    `;
    const sourceFilter = excludeTransactionId === undefined ? Prisma.empty : Prisma.sql`
      AND observation."sourceTransactionId" <> ${excludeTransactionId}
    `;
    const contextFilter = historicalObservationSqlFilter(context);
    return this.db.$queryRaw<HistoricalObservationSearchRow[]>(Prisma.sql`
      SELECT observation."id", observation."companyId", company."nickname" AS "companyName",
             observation."sourceTransactionId", observation."sourceQboType", observation."sourceQboId",
             observation."sourceTransactionRevision", observation."sourceQboSyncToken", observation."sourceStatus",
             observation."sourceUpdatedAt", observation."observedAt", observation."observedAt" AS "revisedAt",
             observation."transactionDate", observation."payee", observation."memo", observation."amountCents",
             observation."currency", observation."sourceAccountName", observation."categoryName",
             observation."taxCalculation", observation."taxCodeName", observation."tagNames",
             ${text} AS "searchText", ${score} AS "lexicalScore"
      FROM "HistoricalClassificationObservation" observation
      JOIN "Company" company ON company."id" = observation."companyId"
      WHERE observation."companyId" IN (${Prisma.join(companyIds)})
        ${idFilter} ${sourceFilter} ${queryFilter} ${contextFilter}
      ORDER BY "lexicalScore" DESC, observation."observedAt" DESC, observation."id" ASC
      LIMIT ${limit}
    `);
  }
}

type BaseSearchRow = {
  id: string;
  companyId: string;
  companyName: string;
  revisedAt: Date;
  lexicalScore: number;
};

type VendorIdentitySearchRow = BaseSearchRow & {
  displayName: string;
  normalizedName: string;
  aliases: string;
  exactSourceId: string | null;
  exactSourceRevisedAt: Date | null;
};

type VendorAliasSearchRow = BaseSearchRow & {
  vendorIdentityId: string;
  value: string;
  normalizedValue: string;
  source: string;
  vendorName: string;
};

type ClassificationCaseSearchRow = BaseSearchRow & {
  vendorIdentityId: string | null;
  vendorName: string | null;
  action: Prisma.JsonValue;
  originIntent: string;
  rationale: string;
  requiredEvidence: Prisma.JsonValue;
  examples: Prisma.JsonValue;
  counterexamples: Prisma.JsonValue;
  reviewer: Prisma.JsonValue;
  context: Prisma.JsonValue;
  jurisdiction: string;
  currency: string;
  provenance: Prisma.JsonValue;
  verifiedAt: Date;
  sourceTransactionId: string;
  transactionDate: Date;
  payee: string;
  memo: string | null;
  categoryName: string | null;
  taxCodeName: string | null;
  categoryActive: boolean;
  taxReady: boolean;
  taxCodeEligible: boolean;
  tagsExist: boolean;
  searchText: string;
};

type RuleSearchRow = BaseSearchRow & {
  matchText: string;
  categoryQboId: string | null;
  taxCalculation: string | null;
  taxCodeQboId: string | null;
  originIntent: string | null;
  revision: number;
  updatedById: string | null;
  direction: 'Purchase' | 'Deposit' | null;
  ruleRuntimeMode: 'legacy' | 'bridge' | 'paused' | 'canonical';
  reviewRequiredAt: Date | null;
  reviewReason: string | null;
  categoryName: string | null;
  taxCodeName: string | null;
  tagIds: Prisma.JsonValue;
  tagNames: Prisma.JsonValue;
  categoryActive: boolean;
  taxReady: boolean;
  taxCodeEligible: boolean;
  tagsExist: boolean;
  searchText: string;
};

type CandidateSearchRow = BaseSearchRow & {
  matchText: string;
  state: string;
  categoryQboId: string | null;
  taxCalculation: string | null;
  taxCodeQboId: string | null;
  tagIds: Prisma.JsonValue;
  evidenceCount: number;
  conflictingEvidenceCount: number;
  categoryName: string | null;
  taxCodeName: string | null;
  patterns: string;
  transactions: string;
  searchText: string;
};

type HistoricalObservationSearchRow = BaseSearchRow & {
  sourceTransactionId: string;
  sourceQboType: string;
  sourceQboId: string;
  sourceTransactionRevision: number;
  sourceQboSyncToken: string;
  sourceStatus: string;
  sourceUpdatedAt: Date;
  observedAt: Date;
  transactionDate: Date;
  payee: string;
  memo: string | null;
  amountCents: bigint;
  currency: string;
  sourceAccountName: string;
  categoryName: string;
  taxCalculation: string;
  taxCodeName: string | null;
  tagNames: Prisma.JsonValue;
  searchText: string;
};

function boundedFetchLimit(limit: number): number {
  if (!Number.isFinite(limit)) throw new ClassificationSearchError('INVALID_INPUT');
  return Math.max(1, Math.min(MAX_FETCH, Math.trunc(limit)));
}

function checkedCorpusRevision(value: string): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/u.test(value)) {
    throw new ClassificationSearchError('INVALID_INPUT');
  }
  return value;
}

function classificationCaseSqlFilter(
  context: ClassificationSearchContextFilter | undefined,
): Prisma.Sql {
  if (context === undefined) return Prisma.empty;
  const clauses: Prisma.Sql[] = [];
  if (context.transactionDirection !== undefined) clauses.push(Prisma.sql`
    AND (
      NOT (memory."context" ? 'transactionDirection')
      OR jsonb_typeof(memory."context"->'transactionDirection') <> 'string'
      OR memory."context"->>'transactionDirection' = 'unknown'
      OR memory."context"->>'transactionDirection' = ${context.transactionDirection}
    )
  `);
  if (context.qboType !== undefined) clauses.push(Prisma.sql`
    AND (
      NOT (memory."context" ? 'qboType')
      OR jsonb_typeof(memory."context"->'qboType') <> 'string'
      OR memory."context"->>'qboType' = ${context.qboType}
    )
  `);
  if (context.sourceAccountName !== undefined) clauses.push(Prisma.sql`
    AND (
      NOT (memory."context" ? 'sourceAccountName')
      OR jsonb_typeof(memory."context"->'sourceAccountName') <> 'string'
      OR lower(trim(memory."context"->>'sourceAccountName')) = lower(trim(${context.sourceAccountName}))
    )
  `);
  if (context.currency !== undefined) clauses.push(Prisma.sql`
    AND memory."currency" = ${context.currency}
  `);
  if (context.transactionPeriod !== undefined) clauses.push(Prisma.sql`
    AND to_char(transaction."date", 'YYYY-MM') = ${context.transactionPeriod}
  `);
  if (context.jurisdiction !== undefined) clauses.push(Prisma.sql`
    AND (memory."jurisdiction" IS NULL OR memory."jurisdiction" = 'unknown' OR memory."jurisdiction" = ${context.jurisdiction})
  `);
  if (context.taxCalculation !== undefined) clauses.push(Prisma.sql`
    AND (
      NOT (memory."action" ? 'taxCalculation')
      OR jsonb_typeof(memory."action"->'taxCalculation') <> 'string'
      OR memory."action"->>'taxCalculation' = ${context.taxCalculation}
    )
  `);
  return clauses.length === 0 ? Prisma.empty : Prisma.join(clauses, ' ');
}

function historicalObservationSqlFilter(
  context: ClassificationSearchContextFilter | undefined,
): Prisma.Sql {
  if (context === undefined) return Prisma.empty;
  const clauses: Prisma.Sql[] = [];
  if (context.transactionDirection !== undefined) clauses.push(Prisma.sql`
    AND (CASE WHEN observation."amountCents" < 0 THEN 'out'
              WHEN observation."amountCents" > 0 THEN 'in' ELSE 'unknown' END)
      IN (${context.transactionDirection}, 'unknown')
  `);
  if (context.qboType !== undefined) clauses.push(Prisma.sql`
    AND observation."sourceQboType" = ${context.qboType}
  `);
  if (context.sourceAccountName !== undefined) clauses.push(Prisma.sql`
    AND lower(trim(observation."sourceAccountName")) = lower(trim(${context.sourceAccountName}))
  `);
  if (context.currency !== undefined) clauses.push(Prisma.sql`
    AND observation."currency" = ${context.currency}
  `);
  if (context.transactionPeriod !== undefined) clauses.push(Prisma.sql`
    AND to_char(observation."transactionDate", 'YYYY-MM') = ${context.transactionPeriod}
  `);
  if (context.taxCalculation !== undefined) clauses.push(Prisma.sql`
    AND observation."taxCalculation" = ${context.taxCalculation}
  `);
  return clauses.length === 0 ? Prisma.empty : Prisma.join(clauses, ' ');
}

function checkedCompanyList(companyIds: readonly string[]): string[] {
  if (!Array.isArray(companyIds) || companyIds.length < 1 || companyIds.length > MAX_ACCESSIBLE_COMPANIES) {
    throw new ClassificationSearchError('INVALID_INPUT');
  }
  return [...new Set(companyIds.map((id) => (
    checkedText(id, CLASSIFICATION_CONTRACT_LIMITS.identifier)
  )))];
}

function resolvedVendorIdentityCte(
  companyIds: readonly string[],
  targetIds: readonly string[] | null,
): Prisma.Sql {
  const targetFilter = targetIds === null
    ? Prisma.empty
    : Prisma.sql`AND target."id" IN (${Prisma.join(targetIds)})`;
  return Prisma.sql`
    vendor_identity_walk ("companyId", "sourceId", "targetId", "path", "depth") AS (
      SELECT target."companyId", target."id", target."id",
             ARRAY[target."id"]::text[], 0
      FROM "VendorIdentity" target
      WHERE target."companyId" IN (${Prisma.join(companyIds)})
        ${targetFilter}
        AND NOT EXISTS (
          SELECT 1 FROM "VendorIdentityMerge" pending
          WHERE pending."companyId" = target."companyId"
            AND pending."sourceVendorIdentityId" = target."id"
        )
      UNION ALL
      SELECT walk."companyId", merge."sourceVendorIdentityId", walk."targetId",
             walk."path" || merge."sourceVendorIdentityId", walk."depth" + 1
      FROM vendor_identity_walk walk
      JOIN "VendorIdentityMerge" merge
        ON merge."companyId" = walk."companyId"
       AND merge."targetVendorIdentityId" = walk."sourceId"
      JOIN "VendorIdentity" source
        ON source."companyId" = merge."companyId"
       AND source."id" = merge."sourceVendorIdentityId"
      WHERE walk."depth" < ${MAX_VENDOR_MERGE_HOPS - 1}
        AND NOT merge."sourceVendorIdentityId" = ANY(walk."path")
    ),
    resolved_vendor_identity ("companyId", "sourceId", "targetId") AS (
      SELECT walk."companyId", walk."sourceId", walk."targetId"
      FROM vendor_identity_walk walk
    )
  `;
}

function resolvedVendorAliasCte(
  companyIds: readonly string[],
  aliasIds: readonly string[] | null,
): Prisma.Sql {
  const aliasFilter = aliasIds === null
    ? Prisma.empty
    : Prisma.sql`AND alias."id" IN (${Prisma.join(aliasIds)})`;
  return Prisma.sql`
    vendor_alias_walk ("companyId", "aliasId", "currentId", "path", "depth") AS (
      SELECT alias."companyId", alias."id", alias."vendorIdentityId",
             ARRAY[alias."vendorIdentityId"]::text[], 0
      FROM "VendorAlias" alias
      WHERE alias."companyId" IN (${Prisma.join(companyIds)})
        ${aliasFilter}
      UNION ALL
      SELECT walk."companyId", walk."aliasId", merge."targetVendorIdentityId",
             walk."path" || merge."targetVendorIdentityId", walk."depth" + 1
      FROM vendor_alias_walk walk
      JOIN "VendorIdentityMerge" merge
        ON merge."companyId" = walk."companyId"
       AND merge."sourceVendorIdentityId" = walk."currentId"
      JOIN "VendorIdentity" target
        ON target."companyId" = merge."companyId"
       AND target."id" = merge."targetVendorIdentityId"
      WHERE walk."depth" < ${MAX_VENDOR_MERGE_HOPS - 1}
        AND NOT merge."targetVendorIdentityId" = ANY(walk."path")
    ),
    resolved_vendor_alias ("companyId", "aliasId", "targetId") AS (
      SELECT walk."companyId", walk."aliasId", walk."currentId"
      FROM vendor_alias_walk walk
      WHERE NOT EXISTS (
        SELECT 1 FROM "VendorIdentityMerge" pending
        WHERE pending."companyId" = walk."companyId"
          AND pending."sourceVendorIdentityId" = walk."currentId"
      )
    )
  `;
}

function splitDocumentIds(documentIds: readonly string[] | null): Record<
  'vendor_identity' | 'vendor_alias' | 'classification_case' | 'rule' | 'rule_candidate' | 'historical_observation',
  string[] | null
> {
  const result: Record<
    'vendor_identity' | 'vendor_alias' | 'classification_case' | 'rule' | 'rule_candidate' | 'historical_observation',
    string[] | null
  > = {
    vendor_identity: documentIds === null ? null : [],
    vendor_alias: documentIds === null ? null : [],
    classification_case: documentIds === null ? null : [],
    rule: documentIds === null ? null : [],
    rule_candidate: documentIds === null ? null : [],
    historical_observation: documentIds === null ? null : [],
  } satisfies Record<string, string[] | null>;
  if (documentIds === null) return result;
  for (const documentId of documentIds) {
    const separator = documentId.indexOf(':');
    if (separator < 1) continue;
    const kind = documentId.slice(0, separator) as keyof typeof result;
    const sourceId = documentId.slice(separator + 1);
    if (kind in result && sourceId !== '') {
      const bucket = result[kind];
      if (bucket !== null) bucket.push(sourceId);
    }
  }
  return result;
}

function jsonStrings(value: Prisma.JsonValue): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').slice(0, 20)
    : [];
}

function actionTagNames(value: Prisma.JsonValue): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').slice(0, 50)
    : [];
}

function taxCalculation(value: string | null): ClassificationAction['taxCalculation'] | null {
  return value === 'TaxInclusive' || value === 'TaxExcluded' || value === 'NotApplicable'
    ? value
    : null;
}

export function actionFromColumns(input: {
  categoryQboId: string | null;
  taxCalculation: string | null;
  taxCodeQboId: string | null;
  tagIds: Prisma.JsonValue;
}): ClassificationAction | null {
  const calculation = taxCalculation(input.taxCalculation);
  const tagIds = parseActionTagIds(input.tagIds);
  if (input.categoryQboId === null || calculation === null || tagIds === null) return null;
  if ((calculation === 'NotApplicable') !== (input.taxCodeQboId === null)) return null;
  return {
    categoryQboId: input.categoryQboId,
    taxCalculation: calculation,
    taxCodeQboId: input.taxCodeQboId,
    tagIds,
  };
}

function actionFromJson(value: Prisma.JsonValue): ClassificationAction | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, Prisma.JsonValue>;
  return actionFromColumns({
    categoryQboId: typeof row.categoryQboId === 'string' ? row.categoryQboId : null,
    taxCalculation: typeof row.taxCalculation === 'string' ? row.taxCalculation : null,
    taxCodeQboId: typeof row.taxCodeQboId === 'string' ? row.taxCodeQboId : null,
    tagIds: row.tagIds ?? [],
  });
}

function actionSummary(
  action: ClassificationAction | null,
  categoryName: string | null,
  taxCodeName: string | null,
  tagNames: string[] = [],
): ClassificationActionSummary | null {
  if (action === null || categoryName === null) return null;
  if ((action.taxCalculation === 'NotApplicable') !== (taxCodeName === null)) return null;
  return { categoryName, taxCalculation: action.taxCalculation, taxCodeName, tagNames };
}

function historicalRuleRationale(row: RuleSearchRow, rawAction: ClassificationAction | null): string | null {
  if (row.reviewReason !== null) return row.reviewReason;
  if (rawAction !== null) return null;
  const category = row.categoryName === null ? 'category unavailable' : `category “${row.categoryName}”`;
  const tax = row.taxCalculation === null
    ? 'tax treatment unavailable'
    : `stored tax treatment “${row.taxCalculation}”`;
  return `Historical rule classification: ${category}; ${tax}.`;
}

function documentFor(
  hit: ClassificationSearchHit,
  revisedAt: string,
  searchText: string,
): ClassificationSearchDocument {
  return createClassificationSearchDocument({
    companyId: hit.companyId,
    kind: hit.kind,
    sourceId: hit.sourceId,
    revisedAt,
    fields: [['classification context', searchText]],
  });
}

function optionalDocumentFor(
  hit: ClassificationSearchHit,
  revisedAt: string,
  searchText: string,
): ClassificationSearchDocument | undefined {
  try {
    return documentFor(hit, revisedAt, searchText);
  } catch {
    return undefined;
  }
}

function baseHit(input: {
  row: BaseSearchRow;
  kind: ClassificationSearchHit['kind'];
  vendorIdentityId: string | null;
  vendorName: string | null;
  action: ClassificationAction | null;
  summary: ClassificationActionSummary | null;
  executable: boolean;
  advisory: boolean;
  originIntent: ClassificationSearchHit['originIntent'];
  evidenceCount: number;
  conflictingEvidenceCount: number;
  conflicts?: ClassificationSearchHit['conflicts'];
  provenance: ClassificationSearchHit['provenance'];
  rationale?: string | null;
  examples?: string[];
  counterexamples?: string[];
  jurisdiction?: string | null;
  currency?: string | null;
  verifiedAt?: string | null;
  ruleRevision?: number | null;
  observation?: ClassificationSearchHit['observation'];
}): ClassificationSearchHit {
  const historicalRationale = input.action === null && input.summary === null
    && ['classification_case', 'rule', 'rule_candidate'].includes(input.kind)
    ? 'Historical classification evidence is retained, but no usable action or display summary is available.'
    : null;
  return parseClassificationSearchHit({
    id: `${input.kind}:${input.row.id}`,
    sourceId: input.row.id,
    kind: input.kind,
    companyId: input.row.companyId,
    companyName: input.row.companyName,
    companyRelation: 'current',
    executable: input.executable,
    advisory: input.advisory,
    matchedIn: [kindReason(input.kind)],
    score: 0,
    vendorIdentityId: input.vendorIdentityId,
    vendorName: input.vendorName,
    action: input.action,
    actionSummary: input.summary,
    originIntent: input.originIntent,
    evidenceCount: input.evidenceCount,
    conflictingEvidenceCount: input.conflictingEvidenceCount,
    conflicts: input.conflicts ?? [],
    provenance: input.provenance,
    rationale: input.rationale ?? historicalRationale,
    examples: input.examples ?? [],
    counterexamples: input.counterexamples ?? [],
    jurisdiction: input.jurisdiction ?? null,
    currency: input.currency ?? null,
    verifiedAt: input.verifiedAt ?? null,
    ruleRevision: input.ruleRevision ?? null,
    observation: input.observation ?? null,
  });
}

function identityRecord(row: VendorIdentitySearchRow): () => ClassificationSearchRecord {
  return () => {
    const revisedAt = row.revisedAt.toISOString();
    const hit = baseHit({
      row, kind: 'vendor_identity', vendorIdentityId: row.id, vendorName: row.displayName,
      action: null, summary: null, executable: false, advisory: true, originIntent: null,
      evidenceCount: 0, conflictingEvidenceCount: 0,
      provenance: {
        source: 'user',
        sourceId: row.exactSourceId ?? row.id,
        actorId: null,
        recordedAt: row.exactSourceRevisedAt?.toISOString() ?? revisedAt,
      },
    });
    const searchText = `${row.displayName} ${row.aliases}`.trim();
    return {
      hit, revisedAt, lexicalScore: Number(row.lexicalScore),
      exactReasons: row.exactSourceId === null ? [] : ['alias'],
      document: optionalDocumentFor(hit, revisedAt, searchText),
    };
  };
}

function aliasRecord(row: VendorAliasSearchRow): () => ClassificationSearchRecord {
  return () => {
    const revisedAt = row.revisedAt.toISOString();
    const hit = baseHit({
      row, kind: 'vendor_alias', vendorIdentityId: row.vendorIdentityId, vendorName: row.vendorName,
      action: null, summary: null, executable: false, advisory: true, originIntent: null,
      evidenceCount: 0, conflictingEvidenceCount: 0,
      provenance: {
        source: row.source === 'qbo' ? 'qbo_verified' : 'user',
        sourceId: row.id, actorId: null, recordedAt: revisedAt,
      },
    });
    const searchText = `${row.value} ${row.vendorName}`;
    return {
      hit, revisedAt, lexicalScore: Number(row.lexicalScore),
      exactReasons: [], document: optionalDocumentFor(hit, revisedAt, searchText), lookupValue: row.value,
    };
  };
}

function caseRecord(row: ClassificationCaseSearchRow): () => ClassificationSearchRecord {
  return () => {
    const revisedAt = row.revisedAt.toISOString();
    const rawAction = actionFromJson(row.action);
    const summary = actionSummary(rawAction, row.categoryName, row.taxCodeName);
    const referencesValid = rawAction !== null && classificationReferenceReasons(rawAction, {
      categoryActive: row.categoryActive,
      taxReady: row.taxReady,
      taxCodeEligible: row.taxCodeEligible,
      tagsExist: row.tagsExist,
    }).length === 0;
    const action = referencesValid && summary !== null ? rawAction : null;
    const provenance = row.provenance as unknown as ClassificationSearchHit['provenance'];
    const hit = baseHit({
      row, kind: 'classification_case', vendorIdentityId: row.vendorIdentityId, vendorName: row.vendorName,
      action, summary, executable: action !== null && summary !== null && row.jurisdiction !== 'unknown',
      advisory: action === null || summary === null || row.jurisdiction === 'unknown',
      originIntent: row.originIntent as ClassificationSearchHit['originIntent'],
      evidenceCount: 1, conflictingEvidenceCount: 0, provenance,
      rationale: row.rationale, examples: jsonStrings(row.examples),
      counterexamples: jsonStrings(row.counterexamples), jurisdiction: row.jurisdiction,
      currency: row.currency, verifiedAt: row.verifiedAt.toISOString(),
    });
    const rawContext = typeof row.context === 'object' && row.context !== null && !Array.isArray(row.context)
      ? row.context as Record<string, Prisma.JsonValue>
      : {};
    const transactionDirection = rawContext.transactionDirection === 'in'
      || rawContext.transactionDirection === 'out'
      || rawContext.transactionDirection === 'unknown'
      ? rawContext.transactionDirection
      : undefined;
    const qboType = rawContext.qboType === 'Purchase'
      || rawContext.qboType === 'Deposit'
      || rawContext.qboType === 'JournalEntry'
      ? rawContext.qboType
      : undefined;
    const sourceAccountName = typeof rawContext.sourceAccountName === 'string'
      ? rawContext.sourceAccountName
      : rawContext.sourceAccountName === null ? null : undefined;
    return {
      hit, revisedAt, lexicalScore: Number(row.lexicalScore), exactReasons: [],
      document: optionalDocumentFor(hit, revisedAt, row.searchText),
      sourceTransactionId: row.sourceTransactionId,
      context: {
        ...(transactionDirection === undefined ? {} : { transactionDirection }),
        ...(qboType === undefined ? {} : { qboType }),
        ...(sourceAccountName === undefined ? {} : { sourceAccountName }),
        currency: row.currency,
        transactionDate: row.transactionDate.toISOString().slice(0, 10),
        jurisdiction: row.jurisdiction,
        ...(rawAction === null ? {} : { taxCalculation: rawAction.taxCalculation }),
      },
    };
  };
}

function ruleRecord(row: RuleSearchRow): () => ClassificationSearchRecord {
  return () => {
    const revisedAt = row.revisedAt.toISOString();
    const invalidTags = parseActionTagIds(row.tagIds) === null;
    const rawAction = actionFromColumns(row);
    const summary = actionSummary(rawAction, row.categoryName, row.taxCodeName, actionTagNames(row.tagNames));
    const referenceReasons = rawAction === null ? [] : classificationReferenceReasons(rawAction, {
      categoryActive: row.categoryActive,
      taxReady: row.taxReady,
      taxCodeEligible: row.taxCodeEligible,
      tagsExist: row.tagsExist,
    });
    const referencesValid = rawAction !== null && referenceReasons.length === 0;
    const action = referencesValid && summary !== null ? rawAction : null;
    const taxed = rawAction !== null && rawAction.taxCalculation !== 'NotApplicable';
    const conflicted = row.reviewRequiredAt !== null;
    const conflict = conflicted ? [{
      id: `rule-review:${row.id}`,
      companyId: row.companyId,
      sourceId: row.id,
      kind: 'rule' as const,
      reason: row.reviewReason ?? 'This rule requires review after contradictory verified evidence.',
      action,
      actionSummary: summary,
      evidenceCount: 1,
    }] : [];
    const hit = baseHit({
      row, kind: 'rule', vendorIdentityId: null, vendorName: row.matchText,
      action, summary, executable: action !== null && summary !== null && !taxed && !conflicted,
      advisory: action === null || summary === null || taxed || conflicted,
      originIntent: row.originIntent as ClassificationSearchHit['originIntent'],
      evidenceCount: 0, conflictingEvidenceCount: conflict.length, conflicts: conflict,
      provenance: { source: 'rule', sourceId: row.id, actorId: row.updatedById, recordedAt: revisedAt },
      rationale: invalidTags ? 'Historical rule action is unavailable because its tag IDs are invalid.'
        : !row.tagsExist ? 'Historical rule action is unavailable because one or more current tags are missing.'
        : historicalRuleRationale(row, rawAction), jurisdiction: taxed ? 'unknown' : null,
      ruleRevision: row.revision,
    });
    return {
      hit, revisedAt, lexicalScore: Number(row.lexicalScore), exactReasons: [],
      document: optionalDocumentFor(hit, revisedAt, row.searchText), lookupValue: row.matchText,
      ruleMatchSemantics: row.ruleRuntimeMode === 'canonical' ? 'canonical' : 'legacy',
    };
  };
}

function candidateRecord(row: CandidateSearchRow): () => ClassificationSearchRecord {
  return () => {
    const revisedAt = row.revisedAt.toISOString();
    const rawAction = actionFromColumns(row);
    const summary = actionSummary(rawAction, row.categoryName, row.taxCodeName);
    const action = summary === null ? null : rawAction;
    const conflict = row.state === 'conflict' ? [{
      id: `candidate-conflict:${row.id}`,
      companyId: row.companyId,
      sourceId: row.id,
      kind: 'candidate' as const,
      reason: 'Verified outcomes disagree for this rule candidate.',
      action,
      actionSummary: summary,
      evidenceCount: row.conflictingEvidenceCount,
    }] : [];
    const hit = baseHit({
      row, kind: 'rule_candidate', vendorIdentityId: null, vendorName: row.matchText,
      action, summary, executable: false, advisory: true, originIntent: 'auto_candidate',
      evidenceCount: row.evidenceCount, conflictingEvidenceCount: row.conflictingEvidenceCount,
      conflicts: conflict,
      provenance: { source: 'candidate', sourceId: row.id, actorId: null, recordedAt: revisedAt },
      rationale: row.state === 'conflict' ? 'Verified outcomes disagree for this candidate.' : null,
      jurisdiction: action !== null && action.taxCalculation !== 'NotApplicable' ? 'unknown' : null,
    });
    return {
      hit, revisedAt, lexicalScore: Number(row.lexicalScore), exactReasons: [],
      document: optionalDocumentFor(hit, revisedAt, row.searchText),
    };
  };
}

function observationRecord(row: HistoricalObservationSearchRow): () => ClassificationSearchRecord {
  return () => {
    const revisedAt = row.revisedAt.toISOString();
    const calculation = taxCalculation(row.taxCalculation);
    const tags = actionTagNames(row.tagNames);
    if (calculation === null
      || !Array.isArray(row.tagNames)
      || row.tagNames.length > CLASSIFICATION_CONTRACT_LIMITS.tags
      || tags.length !== row.tagNames.length
      || (calculation === 'NotApplicable') !== (row.taxCodeName === null)
      || !Number.isSafeInteger(Number(row.amountCents))) {
      throw new ClassificationSearchError('INVALID_INPUT');
    }
    const summary: ClassificationActionSummary = {
      categoryName: row.categoryName,
      taxCalculation: calculation,
      taxCodeName: row.taxCodeName,
      tagNames: tags,
    };
    const observation = {
      sourceTransactionId: row.sourceTransactionId,
      sourceQboType: row.sourceQboType as 'Purchase' | 'Deposit' | 'JournalEntry',
      sourceQboId: row.sourceQboId,
      sourceTransactionRevision: row.sourceTransactionRevision,
      sourceQboSyncToken: row.sourceQboSyncToken,
      sourceStatus: row.sourceStatus as 'POSTED',
      sourceUpdatedAt: row.sourceUpdatedAt.toISOString(),
      observedAt: row.observedAt.toISOString(),
    } satisfies NonNullable<ClassificationSearchHit['observation']>;
    const hit = baseHit({
      row, kind: 'historical_observation', vendorIdentityId: null, vendorName: row.payee,
      action: null, summary, executable: false, advisory: true, originIntent: null,
      evidenceCount: 0, conflictingEvidenceCount: 0,
      provenance: { source: 'historical_observation', sourceId: row.id, actorId: null, recordedAt: revisedAt },
      currency: row.currency, observation,
    });
    return {
      hit, revisedAt, lexicalScore: Number(row.lexicalScore), exactReasons: [],
      document: optionalDocumentFor(hit, revisedAt, row.searchText),
      sourceTransactionId: row.sourceTransactionId,
      context: {
        transactionDirection: row.amountCents < 0n ? 'out' : row.amountCents > 0n ? 'in' : 'unknown',
        qboType: observation.sourceQboType,
        sourceAccountName: row.sourceAccountName,
        currency: row.currency,
        transactionDate: row.transactionDate.toISOString().slice(0, 10),
        taxCalculation: calculation,
      },
    };
  };
}
