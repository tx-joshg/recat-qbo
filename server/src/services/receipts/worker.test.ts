import { describe, expect, it, vi } from 'vitest';
import type { ClaimedReceiptJob } from './jobs.js';
import {
  runClaimedReceiptJob,
  type ReceiptWorkerDeps,
} from './worker.js';
import { ExtractorError, type ReceiptExtractionResult } from './extractorClient.js';

function job(): ClaimedReceiptJob {
  const now = new Date();
  return {
    id: 'job-1',
    documentId: 'document-1',
    companyId: 'company-1',
    generation: 1,
    configVersion: 'a'.repeat(64),
    status: 'running',
    dueAt: now,
    lockOwner: 'worker-1',
    leaseExpiresAt: new Date(now.getTime() + 60_000),
    attemptCount: 1,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
  };
}

function extraction(): ReceiptExtractionResult {
  return {
    schemaVersion: 'recat-receipt-extraction/v1',
    promptVersion: 'receiptory-5afac9f0+recat-tax-components-v1',
    pageCount: 1,
    extraction: {
      receiptDate: '2026-07-30',
      documentTitle: null,
      vendorName: 'Synthetic Vendor',
      vendorTaxId: null,
      vendorReceiptId: null,
      clientName: null,
      clientTaxId: null,
      description: null,
      lineItems: [],
      subtotal: '10',
      taxAmount: '1',
      totalAmount: '11',
      currency: 'USD',
      paymentMethod: null,
      paymentIdentifier: null,
      language: 'en',
      additionalFields: [],
      rawExtractedText: null,
      documentType: 'expense_receipt',
      category: null,
      extractionConfidence: 0.9,
      taxComponents: [],
    },
    parseSalvaged: false,
    warnings: [],
    model: 'synthetic/model',
    tokensIn: 10,
    tokensOut: 20,
    costUsd: '0.01',
    durationMs: 10,
  };
}

function fakeDeps(): ReceiptWorkerDeps & {
  status: string;
  attempts: string[];
  matchBuilds: Array<{ documentId: string; generation: number }>;
  blobDeleted: boolean;
  finishOwned: boolean;
} {
  const state = {
    status: 'QUEUED',
    attempts: [] as string[],
    matchBuilds: [] as Array<{ documentId: string; generation: number }>,
    blobDeleted: false,
    finishOwned: true,
  };
  return {
    ...state,
    loadOwnedDocument: async () => ({
      blobId: 'blob-1',
      originalFilename: 'synthetic.png',
      contentType: 'image/png',
      company: {
        names: ['Synthetic Company'],
        addresses: [],
        taxIds: [],
      },
      categories: { expense: [], issued: [] },
    }),
    setProcessing: async () => {
      state.status = 'PROCESSING';
      return true;
    },
    resolveProvider: async () => ({
      settings: {
        enabled: true,
        provider: 'openrouter',
        model: 'synthetic/model',
        confidenceThreshold: 0.8,
        autoMatchThreshold: 85,
        autoMatchMargin: 15,
        maxPages: 20,
        configVersion: 'a'.repeat(64),
      },
      apiBase: 'https://example.invalid',
      apiKey: 'private',
      headers: {},
    }),
    openBlob: async () => ({
      blobId: 'blob-1',
      sizeBytes: 1,
      contentType: 'image/png',
      async *chunks() { yield new Uint8Array([1]); },
    }),
    extract: async () => extraction(),
    renew: async () => true,
    persistOwnedSuccess: async (_job, result) => {
      if (!state.finishOwned) return false;
      state.attempts.push(result.extraction.vendorName!);
      state.status = 'READY';
      return true;
    },
    persistOwnedFailure: async (_job, failure) => {
      if (!state.finishOwned) return false;
      state.attempts.push(failure.errorCode);
      state.status = failure.transient ? 'QUEUED' : 'NEEDS_REVIEW';
      return true;
    },
    buildMatches: async (documentId, generation) => {
      state.matchBuilds.push({ documentId, generation });
    },
    heartbeatMs: 0,
    get status() { return state.status; },
    set status(value: string) { state.status = value; },
    get attempts() { return state.attempts; },
    set attempts(value: string[]) { state.attempts = value; },
    get matchBuilds() { return state.matchBuilds; },
    set matchBuilds(value) { state.matchBuilds = value; },
    get blobDeleted() { return state.blobDeleted; },
    set blobDeleted(value: boolean) { state.blobDeleted = value; },
    get finishOwned() { return state.finishOwned; },
    set finishOwned(value: boolean) { state.finishOwned = value; },
  };
}

describe('receipt extraction worker', () => {
  it('performs zero blob or provider calls while processing is disabled', async () => {
    const fake = fakeDeps();
    fake.resolveProvider = vi.fn<ReceiptWorkerDeps['resolveProvider']>(async () => ({
      settings: {
        enabled: false,
        provider: 'openrouter',
        model: 'synthetic/model',
        confidenceThreshold: 0.8,
        autoMatchThreshold: 85,
        autoMatchMargin: 15,
        maxPages: 20,
        configVersion: 'a'.repeat(64),
      },
      apiBase: '',
      apiKey: '',
      headers: {},
    }));
    fake.openBlob = vi.fn(fake.openBlob);
    fake.extract = vi.fn(fake.extract);

    await runClaimedReceiptJob(job(), fake);

    expect(fake.resolveProvider).toHaveBeenCalledOnce();
    expect(fake.openBlob).not.toHaveBeenCalled();
    expect(fake.extract).not.toHaveBeenCalled();
  });

  it('persists one immutable successful attempt and advances to READY', async () => {
    const fake = fakeDeps();
    await runClaimedReceiptJob(job(), fake);
    expect(fake.attempts).toEqual(['Synthetic Vendor']);
    expect(fake.status).toBe('READY');
    expect(fake.matchBuilds).toEqual([
      { documentId: 'document-1', generation: 1 },
    ]);
  });

  it('keeps the blob and marks permanent failure NEEDS_REVIEW', async () => {
    const fake = fakeDeps();
    fake.extract = async () => {
      throw new ExtractorError('RECEIPT_CONTENT_FILTERED', false);
    };
    await runClaimedReceiptJob(job(), fake);
    expect(fake.status).toBe('NEEDS_REVIEW');
    expect(fake.blobDeleted).toBe(false);
  });

  it('discards a provider result after lease loss', async () => {
    const fake = fakeDeps();
    fake.finishOwned = false;
    await runClaimedReceiptJob(job(), fake);
    expect(fake.attempts).toHaveLength(0);
    expect(fake.matchBuilds).toHaveLength(0);
  });

  it('keeps a completed extraction when matching fails', async () => {
    const fake = fakeDeps();
    fake.buildMatches = async () => {
      throw new Error('synthetic matching failure');
    };

    await runClaimedReceiptJob(job(), fake);

    expect(fake.attempts).toEqual(['Synthetic Vendor']);
    expect(fake.status).toBe('READY');
  });
});
