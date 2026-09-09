import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { ClassificationKnowledgeKind } from '@recat/shared';
import { VOYAGE_EMBEDDING_DIMENSIONS } from './client.js';
import type { ClassificationEmbeddingGeneration } from './recipe.js';

export type VectorCapabilityReason = 'vector_capability_unavailable';

export interface VectorCapability {
  available: boolean;
  reason: VectorCapabilityReason | null;
}

export interface StoredEmbeddingChunk {
  documentId: string;
  companyId: string;
  kind: ClassificationKnowledgeKind;
  sourceId: string;
  revisedAt: string;
  chunkIndex: number;
  contentHash: string;
  embedding: readonly number[];
}

export interface VectorSearchHit {
  documentId: string;
  companyId: string;
  kind: ClassificationKnowledgeKind;
  sourceId: string;
  revisedAt: string;
  similarity: number;
}

export interface VectorGenerationHealth {
  activeGeneration: string | null;
  expectedGeneration: string | null;
  expectedState: string | null;
  embedded: number;
  skipped: number;
  backlog: number;
  progress: number;
  lastSuccessAt: string | null;
  lastError: string | null;
  latestAttemptGeneration: string | null;
  latestAttemptState: string | null;
  latestAttemptAt: string | null;
  latestAttemptError: string | null;
  currentCorpusRevision: string | null;
  indexedCorpusRevision: string | null;
  expectedCorpusRevision: string | null;
  latestAttemptCorpusRevision: string | null;
}

export interface ClassificationEmbeddingAttempt {
  targetRevision: string;
  token: string;
}

export interface ClassificationEmbeddingStore {
  ensureAvailable(): Promise<VectorCapability>;
  health?(companyId: string, expectedFingerprint: string): Promise<VectorGenerationHealth>;
  healthMany?(
    companyIds: readonly string[],
    expectedFingerprint: string,
  ): Promise<VectorGenerationHealth[]>;
  beginAttempt?(input: {
    companyId: string;
    fingerprint: string;
  }): Promise<ClassificationEmbeddingAttempt>;
  recordProgress(input: {
    companyId: string;
    fingerprint: string;
    totalDocuments: number;
    embeddedDocuments: number;
    skippedDocuments: number;
    targetRevision: string;
    attemptToken: string;
  }): Promise<void>;
  publishGeneration(input: {
    companyId: string;
    generation: ClassificationEmbeddingGeneration;
    chunks: readonly StoredEmbeddingChunk[];
    totalDocuments: number;
    skippedDocuments: number;
    targetRevision: string;
    attemptToken: string;
  }): Promise<void>;
  recordFailure(input: {
    companyId: string;
    fingerprint: string;
    totalDocuments: number;
    embeddedDocuments: number;
    skippedDocuments: number;
    errorCode: string;
    targetRevision: string;
    attemptToken: string;
  }): Promise<void>;
  currentChunks?(
    companyId: string,
    fingerprint: string,
  ): Promise<StoredEmbeddingChunk[]>;
}

type RawDb = Pick<PrismaClient, '$queryRaw' | '$executeRaw'> & {
  $transaction?: PrismaClient['$transaction'];
};

export class VectorStoreError extends Error {
  constructor(
    public readonly code:
      | 'VECTOR_STORE_UNAVAILABLE'
      | 'INVALID_VECTOR'
      | 'GENERATION_CONFLICT',
  ) {
    super(
      code === 'INVALID_VECTOR'
        ? 'Classification embedding is invalid.'
        : code === 'GENERATION_CONFLICT'
          ? 'Classification embedding generation changed.'
          : 'Classification semantic search is unavailable.',
    );
    this.name = 'VectorStoreError';
  }
}

function checkedIdentifier(value: string): string {
  if (
    typeof value !== 'string'
    || value.trim() === ''
    || Array.from(value).length > 128
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new VectorStoreError('GENERATION_CONFLICT');
  }
  return value.normalize('NFC').trim();
}

function checkedVector(value: readonly number[]): number[] {
  if (
    !Array.isArray(value)
    || value.length !== VOYAGE_EMBEDDING_DIMENSIONS
    || value.some((component) => typeof component !== 'number' || !Number.isFinite(component))
  ) {
    throw new VectorStoreError('INVALID_VECTOR');
  }
  return [...value];
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${checkedVector(vector).join(',')}]`;
}

function asDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new VectorStoreError('GENERATION_CONFLICT');
  return date;
}

function boundedCount(value: number): number {
  return Number.isInteger(value) && value >= 0 && value <= 10_000_000 ? value : 0;
}

function checkedCorpusRevision(value: string): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/u.test(value)) {
    throw new VectorStoreError('GENERATION_CONFLICT');
  }
  return value;
}

const PUBLICATION_BATCH_SIZE = 100;
const MAX_PUBLICATION_CHUNKS = 50_000;
const PUBLICATION_TRANSACTION_TIMEOUT_MS = 120_000;

const INSTALL_SQL = [
  Prisma.sql`
    CREATE TABLE IF NOT EXISTS "ClassificationEmbeddingGeneration" (
      "companyId" text NOT NULL,
      "fingerprint" char(64) NOT NULL,
      "state" varchar(16) NOT NULL,
      "totalDocuments" integer NOT NULL DEFAULT 0,
      "embeddedDocuments" integer NOT NULL DEFAULT 0,
      "skippedDocuments" integer NOT NULL DEFAULT 0,
      "backlogDocuments" integer NOT NULL DEFAULT 0,
      "lastSuccessAt" timestamptz,
      "lastErrorCode" varchar(64),
      "attemptState" varchar(16) NOT NULL DEFAULT 'pending',
      "attemptedAt" timestamptz,
      "indexedCorpusRevision" bigint,
      "attemptCorpusRevision" bigint,
      "attemptToken" varchar(64),
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "activatedAt" timestamptz,
      PRIMARY KEY ("companyId", "fingerprint"),
      FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE
    )
  `,
  Prisma.sql`
    ALTER TABLE "ClassificationEmbeddingGeneration"
      ADD COLUMN IF NOT EXISTS "attemptState" varchar(16) NOT NULL DEFAULT 'pending'
  `,
  Prisma.sql`
    ALTER TABLE "ClassificationEmbeddingGeneration"
      ADD COLUMN IF NOT EXISTS "attemptedAt" timestamptz
  `,
  Prisma.sql`
    ALTER TABLE "ClassificationEmbeddingGeneration"
      ADD COLUMN IF NOT EXISTS "indexedCorpusRevision" bigint
  `,
  Prisma.sql`
    ALTER TABLE "ClassificationEmbeddingGeneration"
      ADD COLUMN IF NOT EXISTS "attemptCorpusRevision" bigint
  `,
  Prisma.sql`
    ALTER TABLE "ClassificationEmbeddingGeneration"
      ADD COLUMN IF NOT EXISTS "attemptToken" varchar(64)
  `,
  Prisma.sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "ClassificationEmbeddingGeneration_one_active"
      ON "ClassificationEmbeddingGeneration" ("companyId")
      WHERE "state" = 'active'
  `,
  Prisma.sql`
    CREATE TABLE IF NOT EXISTS "ClassificationEmbeddingChunk" (
      "companyId" text NOT NULL,
      "fingerprint" char(64) NOT NULL,
      "documentId" varchar(260) NOT NULL,
      "kind" varchar(32) NOT NULL,
      "sourceId" varchar(128) NOT NULL,
      "revisedAt" timestamptz NOT NULL,
      "chunkIndex" integer NOT NULL,
      "contentHash" char(64) NOT NULL,
      "embedding" vector(1024) NOT NULL,
      PRIMARY KEY ("companyId", "fingerprint", "documentId", "chunkIndex"),
      FOREIGN KEY ("companyId", "fingerprint")
        REFERENCES "ClassificationEmbeddingGeneration"("companyId", "fingerprint")
        ON DELETE CASCADE
    )
  `,
  Prisma.sql`
    CREATE INDEX IF NOT EXISTS "ClassificationEmbeddingChunk_lookup"
      ON "ClassificationEmbeddingChunk" ("companyId", "fingerprint", "documentId")
  `,
] as const;

// Store instances are request-scoped, but schema installation belongs to the DB client.
// Failed installs and a removed extension clear the entry so a later call can recover.
const schemaInstallations = new WeakMap<RawDb, Promise<void>>();

export class PgClassificationVectorStore implements ClassificationEmbeddingStore {
  constructor(private readonly db: RawDb) {}

  async ensureAvailable(): Promise<VectorCapability> {
    try {
      const rows = await this.db.$queryRaw<Array<{ installed: boolean }>>(Prisma.sql`
        SELECT EXISTS (
          SELECT 1 FROM pg_extension WHERE extname = 'vector'
        ) AS installed
      `);
      if (rows[0]?.installed !== true) {
        schemaInstallations.delete(this.db);
        return { available: false, reason: 'vector_capability_unavailable' };
      }
      let installation = schemaInstallations.get(this.db);
      if (installation === undefined) {
        installation = (async () => {
          for (const statement of INSTALL_SQL) await this.db.$executeRaw(statement);
        })();
        schemaInstallations.set(this.db, installation);
        void installation.catch(() => {
          if (schemaInstallations.get(this.db) === installation) schemaInstallations.delete(this.db);
        });
      }
      await installation;
      return { available: true, reason: null };
    } catch {
      throw new VectorStoreError('VECTOR_STORE_UNAVAILABLE');
    }
  }

  async beginAttempt(input: {
    companyId: string;
    fingerprint: string;
  }): Promise<ClassificationEmbeddingAttempt> {
    const companyId = checkedIdentifier(input.companyId);
    const fingerprint = checkedIdentifier(input.fingerprint);
    const attemptToken = randomUUID();
    if (!/^[0-9a-f]{64}$/u.test(fingerprint)) {
      throw new VectorStoreError('GENERATION_CONFLICT');
    }
    const begin = async (tx: RawDb): Promise<ClassificationEmbeddingAttempt> => {
      await tx.$queryRaw(Prisma.sql`
        SELECT 1 AS locked
        FROM pg_advisory_xact_lock(hashtextextended(${companyId}, 1481988))
      `);
      const rows = await tx.$queryRaw<Array<{ revision: bigint }>>(Prisma.sql`
        SELECT "revision" FROM "ClassificationCorpusRevision"
        WHERE "companyId" = ${companyId}
        ORDER BY "revision" DESC
        LIMIT 1
      `);
      const revision = rows[0]?.revision;
      if (revision === undefined) throw new VectorStoreError('GENERATION_CONFLICT');
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "ClassificationEmbeddingGeneration" (
          "companyId", "fingerprint", "state", "attemptState", "attemptedAt",
          "attemptCorpusRevision", "attemptToken", "totalDocuments", "embeddedDocuments",
          "skippedDocuments", "backlogDocuments", "lastErrorCode"
        ) VALUES (
          ${companyId}, ${fingerprint}, 'building', 'building', now(),
          ${revision}, ${attemptToken}, 0, 0, 0, 0, NULL
        )
        ON CONFLICT ("companyId", "fingerprint") DO UPDATE SET
          "state" = CASE
            WHEN "ClassificationEmbeddingGeneration"."state" = 'active' THEN 'active'
            ELSE 'building'
          END,
          "attemptState" = 'building',
          "attemptedAt" = now(),
          "attemptCorpusRevision" = EXCLUDED."attemptCorpusRevision",
          "attemptToken" = EXCLUDED."attemptToken",
          "totalDocuments" = 0,
          "embeddedDocuments" = 0,
          "skippedDocuments" = 0,
          "backlogDocuments" = 0,
          "lastErrorCode" = NULL
      `);
      return { targetRevision: revision.toString(), token: attemptToken };
    };
    try {
      return typeof this.db.$transaction === 'function'
        ? await this.db.$transaction(async (tx) => begin(tx as unknown as RawDb))
        : await begin(this.db);
    } catch (error) {
      if (error instanceof VectorStoreError) throw error;
      throw new VectorStoreError('VECTOR_STORE_UNAVAILABLE');
    }
  }

  async recordProgress(input: {
    companyId: string;
    fingerprint: string;
    totalDocuments: number;
    embeddedDocuments: number;
    skippedDocuments: number;
    targetRevision: string;
    attemptToken: string;
  }): Promise<void> {
    const companyId = checkedIdentifier(input.companyId);
    const fingerprint = checkedIdentifier(input.fingerprint);
    const totalDocuments = boundedCount(input.totalDocuments);
    const embeddedDocuments = boundedCount(input.embeddedDocuments);
    const skippedDocuments = boundedCount(input.skippedDocuments);
    const targetRevision = checkedCorpusRevision(input.targetRevision);
    const attemptToken = checkedIdentifier(input.attemptToken);
    const backlogDocuments = Math.max(0, totalDocuments - embeddedDocuments - skippedDocuments);
    try {
      const changed = await this.db.$executeRaw(Prisma.sql`
        UPDATE "ClassificationEmbeddingGeneration" generation SET
          "state" = CASE WHEN generation."state" = 'active' THEN 'active' ELSE 'building' END,
          "attemptState" = 'building',
          "attemptedAt" = now(),
          "totalDocuments" = ${totalDocuments},
          "embeddedDocuments" = ${embeddedDocuments},
          "skippedDocuments" = ${skippedDocuments},
          "backlogDocuments" = ${backlogDocuments},
          "lastErrorCode" = NULL
        FROM LATERAL (
          SELECT "revision" FROM "ClassificationCorpusRevision"
          WHERE "companyId" = ${companyId}
          ORDER BY "revision" DESC
          LIMIT 1
        ) corpus
        WHERE generation."companyId" = ${companyId}
          AND generation."fingerprint" = ${fingerprint}
          AND generation."attemptCorpusRevision" = ${targetRevision}::bigint
          AND generation."attemptToken" = ${attemptToken}
          AND corpus."revision" = ${targetRevision}::bigint
      `);
      if (changed !== 1) throw new VectorStoreError('GENERATION_CONFLICT');
    } catch (error) {
      if (error instanceof VectorStoreError) throw error;
      throw new VectorStoreError('VECTOR_STORE_UNAVAILABLE');
    }
  }

  async publishGeneration(input: {
    companyId: string;
    generation: ClassificationEmbeddingGeneration;
    chunks: readonly StoredEmbeddingChunk[];
    totalDocuments: number;
    skippedDocuments: number;
    targetRevision: string;
    attemptToken: string;
  }): Promise<void> {
    const companyId = checkedIdentifier(input.companyId);
    const fingerprint = checkedIdentifier(input.generation.fingerprint);
    if (!/^[0-9a-f]{64}$/u.test(fingerprint)) {
      throw new VectorStoreError('GENERATION_CONFLICT');
    }
    const totalDocuments = boundedCount(input.totalDocuments);
    const skippedDocuments = boundedCount(input.skippedDocuments);
    const targetRevision = checkedCorpusRevision(input.targetRevision);
    const attemptToken = checkedIdentifier(input.attemptToken);
    if (input.chunks.length > MAX_PUBLICATION_CHUNKS) {
      throw new VectorStoreError('GENERATION_CONFLICT');
    }
    const documentIds = new Set(input.chunks.map((chunk) => chunk.documentId));
    const embeddedDocuments = documentIds.size;
    const backlogDocuments = Math.max(0, totalDocuments - embeddedDocuments - skippedDocuments);
    if (backlogDocuments !== 0 || embeddedDocuments + skippedDocuments !== totalDocuments) {
      throw new VectorStoreError('GENERATION_CONFLICT');
    }
    for (const chunk of input.chunks) {
      if (chunk.companyId !== companyId) throw new VectorStoreError('GENERATION_CONFLICT');
      checkedIdentifier(chunk.documentId);
      checkedIdentifier(chunk.sourceId);
      checkedIdentifier(chunk.contentHash);
      if (!Number.isInteger(chunk.chunkIndex) || chunk.chunkIndex < 0) {
        throw new VectorStoreError('GENERATION_CONFLICT');
      }
      checkedVector(chunk.embedding);
      asDate(chunk.revisedAt);
    }

    const publish = async (tx: RawDb) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT 1 AS locked
        FROM pg_advisory_xact_lock(hashtextextended(${companyId}, 1481988))
      `);
      const fence = await tx.$queryRaw<Array<{
        revision: bigint;
        attemptCorpusRevision: bigint | null;
        attemptToken: string | null;
      }>>(Prisma.sql`
        SELECT corpus."revision", generation."attemptCorpusRevision", generation."attemptToken"
        FROM LATERAL (
          SELECT "revision" FROM "ClassificationCorpusRevision"
          WHERE "companyId" = ${companyId}
          ORDER BY "revision" DESC
          LIMIT 1
        ) corpus
        JOIN "ClassificationEmbeddingGeneration" generation
          ON generation."companyId" = ${companyId}
         AND generation."fingerprint" = ${fingerprint}
      `);
      if (
        fence[0]?.revision.toString() !== targetRevision
        || fence[0]?.attemptCorpusRevision?.toString() !== targetRevision
        || fence[0]?.attemptToken !== attemptToken
      ) {
        throw new VectorStoreError('GENERATION_CONFLICT');
      }
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "ClassificationEmbeddingGeneration" (
          "companyId", "fingerprint", "state", "totalDocuments",
          "embeddedDocuments", "skippedDocuments", "backlogDocuments",
          "lastErrorCode", "attemptState", "attemptedAt",
          "indexedCorpusRevision", "attemptCorpusRevision", "attemptToken"
        ) VALUES (
          ${companyId}, ${fingerprint}, 'building', ${totalDocuments},
          ${embeddedDocuments}, ${skippedDocuments}, ${backlogDocuments}, NULL,
          'succeeded', now(), ${targetRevision}::bigint, ${targetRevision}::bigint, ${attemptToken}
        )
        ON CONFLICT ("companyId", "fingerprint") DO UPDATE SET
          "state" = CASE
            WHEN "ClassificationEmbeddingGeneration"."state" = 'active' THEN 'active'
            ELSE 'building'
          END,
          "totalDocuments" = EXCLUDED."totalDocuments",
          "embeddedDocuments" = EXCLUDED."embeddedDocuments",
          "skippedDocuments" = EXCLUDED."skippedDocuments",
          "backlogDocuments" = EXCLUDED."backlogDocuments",
          "lastErrorCode" = NULL,
          "attemptState" = 'succeeded',
          "attemptedAt" = now(),
          "indexedCorpusRevision" = EXCLUDED."indexedCorpusRevision",
          "attemptCorpusRevision" = EXCLUDED."attemptCorpusRevision",
          "attemptToken" = EXCLUDED."attemptToken"
      `);
      await tx.$executeRaw(Prisma.sql`
        DELETE FROM "ClassificationEmbeddingChunk"
        WHERE "companyId" = ${companyId} AND "fingerprint" = ${fingerprint}
      `);
      for (let offset = 0; offset < input.chunks.length; offset += PUBLICATION_BATCH_SIZE) {
        const batch = input.chunks.slice(offset, offset + PUBLICATION_BATCH_SIZE);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "ClassificationEmbeddingChunk" (
            "companyId", "fingerprint", "documentId", "kind", "sourceId",
            "revisedAt", "chunkIndex", "contentHash", "embedding"
          ) VALUES ${Prisma.join(batch.map((chunk) => Prisma.sql`(
            ${companyId}, ${fingerprint}, ${chunk.documentId}, ${chunk.kind}, ${chunk.sourceId},
            ${asDate(chunk.revisedAt)}, ${chunk.chunkIndex}, ${chunk.contentHash},
            ${vectorLiteral(chunk.embedding)}::vector
          )`))}
        `);
      }
      await tx.$executeRaw(Prisma.sql`
        UPDATE "ClassificationEmbeddingGeneration"
        SET "state" = 'retired'
        WHERE "companyId" = ${companyId}
          AND "fingerprint" <> ${fingerprint}
          AND "state" = 'active'
      `);
      await tx.$executeRaw(Prisma.sql`
        UPDATE "ClassificationEmbeddingGeneration"
        SET "state" = 'active', "activatedAt" = now(), "lastSuccessAt" = now(),
            "lastErrorCode" = NULL, "attemptState" = 'succeeded', "attemptedAt" = now(),
            "indexedCorpusRevision" = ${targetRevision}::bigint,
            "attemptCorpusRevision" = ${targetRevision}::bigint,
            "attemptToken" = ${attemptToken}
        WHERE "companyId" = ${companyId} AND "fingerprint" = ${fingerprint}
      `);
      await tx.$executeRaw(Prisma.sql`
        DELETE FROM "ClassificationEmbeddingGeneration"
        WHERE "companyId" = ${companyId} AND "fingerprint" <> ${fingerprint}
      `);
      await tx.$executeRaw(Prisma.sql`
        DELETE FROM "ClassificationCorpusRevision"
        WHERE "companyId" = ${companyId} AND "revision" <> ${targetRevision}::bigint
      `);
    };

    try {
      if (typeof this.db.$transaction === 'function') {
        await this.db.$transaction(
          async (tx) => publish(tx as unknown as RawDb),
          { maxWait: 10_000, timeout: PUBLICATION_TRANSACTION_TIMEOUT_MS },
        );
      } else {
        await publish(this.db);
      }
    } catch (error) {
      if (error instanceof VectorStoreError) throw error;
      throw new VectorStoreError('VECTOR_STORE_UNAVAILABLE');
    }
  }

  async recordFailure(input: {
    companyId: string;
    fingerprint: string;
    totalDocuments: number;
    embeddedDocuments: number;
    skippedDocuments: number;
    errorCode: string;
    targetRevision: string;
    attemptToken: string;
  }): Promise<void> {
    const companyId = checkedIdentifier(input.companyId);
    const fingerprint = checkedIdentifier(input.fingerprint);
    const errorCode = checkedIdentifier(input.errorCode);
    const targetRevision = checkedCorpusRevision(input.targetRevision);
    const attemptToken = checkedIdentifier(input.attemptToken);
    try {
      await this.db.$executeRaw(Prisma.sql`
        UPDATE "ClassificationEmbeddingGeneration" SET
          "state" = CASE WHEN "state" = 'active' THEN 'active' ELSE 'failed' END,
          "totalDocuments" = ${boundedCount(input.totalDocuments)},
          "embeddedDocuments" = ${boundedCount(input.embeddedDocuments)},
          "skippedDocuments" = ${boundedCount(input.skippedDocuments)},
          "backlogDocuments" = ${Math.max(0, boundedCount(input.totalDocuments) - boundedCount(input.embeddedDocuments) - boundedCount(input.skippedDocuments))},
          "lastErrorCode" = ${errorCode},
          "attemptState" = 'failed',
          "attemptedAt" = now()
        WHERE "companyId" = ${companyId}
          AND "fingerprint" = ${fingerprint}
          AND "attemptCorpusRevision" = ${targetRevision}::bigint
          AND "attemptToken" = ${attemptToken}
      `);
    } catch {
      throw new VectorStoreError('VECTOR_STORE_UNAVAILABLE');
    }
  }

  async currentChunks(
    companyId: string,
    fingerprint: string,
  ): Promise<StoredEmbeddingChunk[]> {
    try {
      const rows = await this.db.$queryRaw<Array<{
        documentId: string;
        companyId: string;
        kind: ClassificationKnowledgeKind;
        sourceId: string;
        revisedAt: Date;
        chunkIndex: number;
        contentHash: string;
        embedding: string;
      }>>(Prisma.sql`
        SELECT chunk."documentId", chunk."companyId", chunk."kind", chunk."sourceId",
               chunk."revisedAt", chunk."chunkIndex", chunk."contentHash",
               chunk."embedding"::text AS embedding
        FROM "ClassificationEmbeddingChunk" chunk
        JOIN "ClassificationEmbeddingGeneration" generation
          ON generation."companyId" = chunk."companyId"
         AND generation."fingerprint" = chunk."fingerprint"
         AND generation."state" = 'active'
        WHERE chunk."companyId" = ${checkedIdentifier(companyId)}
          AND chunk."fingerprint" = ${checkedIdentifier(fingerprint)}
        ORDER BY chunk."documentId" ASC, chunk."chunkIndex" ASC
        LIMIT 50000
      `);
      return rows.map((row) => {
        let embedding: unknown;
        try {
          embedding = JSON.parse(row.embedding);
        } catch {
          throw new VectorStoreError('INVALID_VECTOR');
        }
        return {
          ...row,
          revisedAt: row.revisedAt.toISOString(),
          embedding: checkedVector(embedding as number[]),
        };
      });
    } catch (error) {
      if (error instanceof VectorStoreError) throw error;
      throw new VectorStoreError('VECTOR_STORE_UNAVAILABLE');
    }
  }

  async search(input: {
    companyIds: readonly string[];
    fingerprint: string;
    embedding: readonly number[];
    cosineFloor: number;
    limit: number;
  }): Promise<VectorSearchHit[]> {
    if (input.companyIds.length === 0) return [];
    const companyIds = [...new Set(input.companyIds.map(checkedIdentifier))];
    const fingerprint = checkedIdentifier(input.fingerprint);
    const cosineFloor = Number.isFinite(input.cosineFloor)
      ? Math.max(-1, Math.min(1, input.cosineFloor))
      : 0.72;
    const limit = Math.max(1, Math.min(500, Math.trunc(input.limit)));
    try {
      const rows = await this.db.$queryRaw<Array<{
        healthy: boolean;
        documentId: string | null;
        companyId: string | null;
        kind: ClassificationKnowledgeKind | null;
        sourceId: string | null;
        revisedAt: Date | null;
        similarity: number | null;
      }>>(Prisma.sql`
        WITH guard AS (
          SELECT count(*) = ${companyIds.length}::bigint AS healthy
          FROM (
            SELECT DISTINCT ON ("companyId") "companyId", "revision"
            FROM "ClassificationCorpusRevision"
            WHERE "companyId" IN (${Prisma.join(companyIds)})
            ORDER BY "companyId", "revision" DESC
          ) corpus
          JOIN "ClassificationEmbeddingGeneration" generation
            ON generation."companyId" = corpus."companyId"
           AND generation."fingerprint" = ${fingerprint}
           AND generation."state" = 'active'
           AND generation."attemptState" = 'succeeded'
           AND generation."indexedCorpusRevision" = corpus."revision"
           AND generation."attemptCorpusRevision" = corpus."revision"
          WHERE corpus."companyId" IN (${Prisma.join(companyIds)})
        )
        SELECT guard.healthy, hit."documentId", hit."companyId", hit."kind", hit."sourceId",
               hit."revisedAt", hit.similarity
        FROM guard
        LEFT JOIN LATERAL (
          SELECT chunk."documentId", chunk."companyId", chunk."kind", chunk."sourceId",
                 chunk."revisedAt",
                 1 - (chunk."embedding" <=> ${vectorLiteral(input.embedding)}::vector) AS similarity
          FROM "ClassificationEmbeddingChunk" chunk
          WHERE guard.healthy
            AND chunk."companyId" IN (${Prisma.join(companyIds)})
            AND chunk."fingerprint" = ${fingerprint}
            AND 1 - (chunk."embedding" <=> ${vectorLiteral(input.embedding)}::vector) >= ${cosineFloor}
          ORDER BY chunk."embedding" <=> ${vectorLiteral(input.embedding)}::vector,
                   chunk."revisedAt" DESC, chunk."documentId" ASC, chunk."chunkIndex" ASC
          LIMIT ${limit}
        ) hit ON true
      `);
      if (rows[0]?.healthy !== true) throw new VectorStoreError('GENERATION_CONFLICT');
      return rows.flatMap((row) => row.documentId === null ? [] : [{
        documentId: row.documentId,
        companyId: row.companyId!,
        kind: row.kind!,
        sourceId: row.sourceId!,
        revisedAt: row.revisedAt!.toISOString(),
        similarity: Number(row.similarity),
      }]);
    } catch (error) {
      if (error instanceof VectorStoreError) throw error;
      throw new VectorStoreError('VECTOR_STORE_UNAVAILABLE');
    }
  }

  async healthMany(
    companyIds: readonly string[],
    expectedFingerprint: string,
  ): Promise<VectorGenerationHealth[]> {
    try {
      if (!Array.isArray(companyIds) || companyIds.length < 1 || companyIds.length > 100) {
        throw new VectorStoreError('GENERATION_CONFLICT');
      }
      const checkedCompanyIds = [...new Set(companyIds.map(checkedIdentifier))];
      if (checkedCompanyIds.length !== companyIds.length) {
        throw new VectorStoreError('GENERATION_CONFLICT');
      }
      const checkedExpectedFingerprint = checkedIdentifier(expectedFingerprint);
      const rows = await this.db.$queryRaw<Array<{
        companyId: string;
        expectedFingerprint: string | null;
        activeFingerprint: string | null;
        expectedState: string | null;
        embeddedDocuments: number;
        skippedDocuments: number;
        backlogDocuments: number;
        totalDocuments: number;
        lastSuccessAt: Date | null;
        lastErrorCode: string | null;
        latestAttemptFingerprint: string | null;
        latestAttemptState: string | null;
        latestAttemptAt: Date | null;
        latestAttemptErrorCode: string | null;
        currentCorpusRevision: bigint | null;
        indexedCorpusRevision: bigint | null;
        expectedCorpusRevision: bigint | null;
        latestAttemptCorpusRevision: bigint | null;
      }>>(Prisma.sql`
        WITH requested("companyId") AS (
          VALUES ${Prisma.join(checkedCompanyIds.map((companyId) => Prisma.sql`(${companyId})`))}
        )
        SELECT requested."companyId",
               expected."fingerprint" AS "expectedFingerprint",
               active."fingerprint" AS "activeFingerprint",
               expected."attemptState" AS "expectedState",
               COALESCE(expected."embeddedDocuments", 0) AS "embeddedDocuments",
               COALESCE(expected."skippedDocuments", 0) AS "skippedDocuments",
               COALESCE(expected."backlogDocuments", 0) AS "backlogDocuments",
               COALESCE(expected."totalDocuments", 0) AS "totalDocuments",
               expected."lastSuccessAt", expected."lastErrorCode",
               latest_attempt."fingerprint" AS "latestAttemptFingerprint",
               latest_attempt."attemptState" AS "latestAttemptState",
               latest_attempt."attemptedAt" AS "latestAttemptAt",
               latest_attempt."lastErrorCode" AS "latestAttemptErrorCode",
               corpus."revision" AS "currentCorpusRevision",
               active."indexedCorpusRevision" AS "indexedCorpusRevision",
               expected."attemptCorpusRevision" AS "expectedCorpusRevision",
               latest_attempt."attemptCorpusRevision" AS "latestAttemptCorpusRevision"
        FROM requested
        LEFT JOIN LATERAL (
          SELECT "revision" FROM "ClassificationCorpusRevision"
          WHERE "companyId" = requested."companyId"
          ORDER BY "revision" DESC
          LIMIT 1
        ) corpus ON true
        LEFT JOIN LATERAL (
          SELECT * FROM "ClassificationEmbeddingGeneration"
          WHERE "companyId" = requested."companyId"
            AND "fingerprint" = ${checkedExpectedFingerprint}
          LIMIT 1
        ) expected ON true
        LEFT JOIN LATERAL (
          SELECT * FROM "ClassificationEmbeddingGeneration"
          WHERE "companyId" = requested."companyId" AND "state" = 'active'
          ORDER BY "fingerprint" ASC
          LIMIT 1
        ) active ON true
        LEFT JOIN LATERAL (
          SELECT * FROM "ClassificationEmbeddingGeneration"
          WHERE "companyId" = requested."companyId" AND "attemptedAt" IS NOT NULL
          ORDER BY "attemptedAt" DESC, "fingerprint" ASC
          LIMIT 1
        ) latest_attempt ON true
        ORDER BY requested."companyId" ASC
      `);
      const byCompany = new Map(rows.map((row) => [row.companyId, row]));
      if (byCompany.size !== checkedCompanyIds.length) throw new VectorStoreError('GENERATION_CONFLICT');
      return checkedCompanyIds.map((companyId) => {
        const row = byCompany.get(companyId)!;
        const completed = row.embeddedDocuments + row.skippedDocuments;
        return {
          activeGeneration: row.activeFingerprint,
          expectedGeneration: row.expectedFingerprint,
          expectedState: row.expectedState,
          embedded: row.embeddedDocuments,
          skipped: row.skippedDocuments,
          backlog: row.backlogDocuments,
          progress: row.totalDocuments === 0 ? 1 : completed / row.totalDocuments,
          lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
          lastError: row.lastErrorCode,
          latestAttemptGeneration: row.latestAttemptFingerprint,
          latestAttemptState: row.latestAttemptState,
          latestAttemptAt: row.latestAttemptAt?.toISOString() ?? null,
          latestAttemptError: row.latestAttemptErrorCode,
          currentCorpusRevision: row.currentCorpusRevision?.toString() ?? null,
          indexedCorpusRevision: row.indexedCorpusRevision?.toString() ?? null,
          expectedCorpusRevision: row.expectedCorpusRevision?.toString() ?? null,
          latestAttemptCorpusRevision: row.latestAttemptCorpusRevision?.toString() ?? null,
        };
      });
    } catch {
      throw new VectorStoreError('VECTOR_STORE_UNAVAILABLE');
    }
  }

  async health(companyId: string, expectedFingerprint: string): Promise<VectorGenerationHealth> {
    const [health] = await this.healthMany([companyId], expectedFingerprint);
    if (health === undefined) throw new VectorStoreError('VECTOR_STORE_UNAVAILABLE');
    return health;
  }
}
