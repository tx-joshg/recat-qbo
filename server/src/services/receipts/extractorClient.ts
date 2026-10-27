import { Prisma } from '../../lib/db.js';
import { z } from 'zod';
import { env } from '../../env.js';
import type { AttachmentBlobReader } from '../attachments/types.js';
import type { ResolvedReceiptProvider } from './settings.js';

const MAX_INPUT_BYTES = 100_000_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 120_000;

function decimalString(
  maxAbsolute?: string,
  maxDecimalPlaces?: number,
  minimum?: string,
) {
  return z.union([z.string().max(100), z.number()]).transform((value, ctx) => {
    const text = String(value);
    try {
      const decimal = new Prisma.Decimal(text);
      if (
        !decimal.isFinite()
        || (
          maxAbsolute !== undefined
          && decimal.abs().greaterThanOrEqualTo(maxAbsolute)
        )
        || (
          maxDecimalPlaces !== undefined
          && decimal.decimalPlaces() > maxDecimalPlaces
        )
        || (minimum !== undefined && decimal.lessThan(minimum))
      ) {
        throw new Error('out of range');
      }
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Expected a bounded decimal.' });
      return z.NEVER;
    }
    return text;
  });
}

const nullableDecimal = decimalString().nullable();
const nullableMoney = decimalString('100000000000000', 4).nullable();
const lineItemSchema = z.object({
  description: z.string().max(2_000),
  quantity: nullableDecimal.optional().default(null),
  unit_price: nullableMoney.optional().default(null),
}).strict();
const additionalFieldSchema = z.object({
  key: z.string().max(500),
  value: z.string().max(5_000),
}).strict();
const taxComponentSchema = z.object({
  label: z.string().max(200),
  rate: nullableDecimal.optional().default(null),
  amount: nullableMoney.optional().default(null),
  confidence: z.number().min(0).max(1).nullable().optional().default(null),
}).strict();
const extractionSchema = z.object({
  receipt_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(validDate).nullable().optional().default(null),
  document_title: z.string().max(500).nullable().optional().default(null),
  vendor_name: z.string().max(500).nullable().optional().default(null),
  vendor_tax_id: z.string().max(200).nullable().optional().default(null),
  vendor_receipt_id: z.string().max(200).nullable().optional().default(null),
  client_name: z.string().max(500).nullable().optional().default(null),
  client_tax_id: z.string().max(200).nullable().optional().default(null),
  description: z.string().max(10_000).nullable().optional().default(null),
  line_items: z.array(lineItemSchema).max(1_000).optional().default([]),
  subtotal: nullableMoney.optional().default(null),
  tax_amount: nullableMoney.optional().default(null),
  total_amount: nullableMoney.optional().default(null),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional().default(null),
  payment_method: z.string().max(80).nullable().optional().default(null),
  payment_identifier: z.string().max(200).nullable().optional().default(null),
  language: z.string().max(16).nullable().optional().default(null),
  additional_fields: z.array(additionalFieldSchema).max(200).optional().default([]),
  raw_extracted_text: z.string().max(200_000).nullable().optional().default(null),
  document_type: z.string().max(80).nullable().optional().default(null),
  category: z.string().max(500).nullable().optional().default(null),
  extraction_confidence: z.number().min(0).max(1).nullable().optional().default(null),
  tax_components: z.array(taxComponentSchema).max(20).optional().default([]),
}).strict();
const responseSchema = z.object({
  schema_version: z.literal('recat-receipt-extraction/v1'),
  prompt_version: z.literal('receiptory-5afac9f0+recat-tax-components-v1'),
  page_count: z.number().int().min(1).max(50),
  extraction: extractionSchema,
  parse_salvaged: z.boolean(),
  warnings: z.array(z.string().max(500)).max(100),
  model: z.string().max(200),
  tokens_in: z.number().int().nonnegative().max(2_147_483_647),
  tokens_out: z.number().int().nonnegative().max(2_147_483_647),
  cost_usd: decimalString('1000000', undefined, '0'),
  duration_ms: z.number().int().nonnegative().max(2_147_483_647),
}).strict();

export interface ReceiptExtractionDocument {
  receiptDate: string | null;
  documentTitle: string | null;
  vendorName: string | null;
  vendorTaxId: string | null;
  vendorReceiptId: string | null;
  clientName: string | null;
  clientTaxId: string | null;
  description: string | null;
  lineItems: Array<{
    description: string;
    quantity: string | null;
    unitPrice: string | null;
  }>;
  subtotal: string | null;
  taxAmount: string | null;
  totalAmount: string | null;
  currency: string | null;
  paymentMethod: string | null;
  paymentIdentifier: string | null;
  language: string | null;
  additionalFields: Array<{ key: string; value: string }>;
  rawExtractedText: string | null;
  documentType: string | null;
  category: string | null;
  extractionConfidence: number | null;
  taxComponents: Array<{
    label: string;
    rate: string | null;
    amount: string | null;
    confidence: number | null;
  }>;
}

export interface ReceiptExtractionResult {
  schemaVersion: 'recat-receipt-extraction/v1';
  promptVersion: 'receiptory-5afac9f0+recat-tax-components-v1';
  pageCount: number;
  extraction: ReceiptExtractionDocument;
  parseSalvaged: boolean;
  warnings: string[];
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: string;
  durationMs: number;
}

export interface ExtractReceiptInput {
  requestId: string;
  filename: string;
  contentType: string;
  blob: AttachmentBlobReader;
  provider: ResolvedReceiptProvider;
  company: {
    names: string[];
    addresses: string[];
    taxIds: string[];
  };
  categories: {
    expense: Array<{ name: string; description: string }>;
    issued: Array<{ name: string; description: string }>;
  };
}

export interface ExtractorClientDeps {
  fetch: typeof fetch;
  url: string;
  token: string;
  timeoutMs?: number;
}

export class ExtractorError extends Error {
  constructor(
    readonly code: string,
    readonly transient: boolean,
    message = 'Receipt extraction failed.',
  ) {
    super(message);
    this.name = 'ExtractorError';
  }
}

const defaultDeps: ExtractorClientDeps = {
  fetch,
  url: env.RECEIPT_EXTRACTOR_URL,
  token: env.RECEIPT_EXTRACTOR_TOKEN,
};

export async function extractReceipt(
  input: ExtractReceiptInput,
  deps: ExtractorClientDeps = defaultDeps,
): Promise<ReceiptExtractionResult> {
  validateEndpoint(deps);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const bytes = await readBlobBounded(input.blob, controller.signal);
    const form = new FormData();
    form.set('request', JSON.stringify({
      request_id: input.requestId,
      model: input.provider.settings.model,
      api_base: input.provider.apiBase,
      api_key: input.provider.apiKey,
      provider_headers: input.provider.headers,
      temperature: 0,
      max_tokens: 8_192,
      parse_retries: 2,
      reasoning_effort: 'none',
      max_pages: input.provider.settings.maxPages,
      business: {
        names: input.company.names,
        addresses: input.company.addresses,
        tax_ids: input.company.taxIds,
      },
      categories: input.categories,
    }));
    const fileBytes = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(fileBytes).set(bytes);
    form.set('file', new File([fileBytes], input.filename, {
      type: input.contentType,
    }));
    const response = await deps.fetch(joinUrl(deps.url), {
      method: 'POST',
      headers: { 'X-Recat-Extractor-Token': deps.token },
      body: form,
      signal: controller.signal,
    });
    const raw = await readResponseBounded(response, controller.signal);
    if (!response.ok) throw workerError(response.status, raw);

    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new ExtractorError('RECEIPT_EXTRACTOR_RESPONSE_INVALID', false);
    }
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) {
      throw new ExtractorError('RECEIPT_EXTRACTOR_RESPONSE_INVALID', false);
    }
    return projectResponse(parsed.data);
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      throw new ExtractorError('RECEIPT_EXTRACTOR_TIMEOUT', true);
    }
    if (error instanceof ExtractorError) throw error;
    throw new ExtractorError('RECEIPT_EXTRACTOR_UNAVAILABLE', true);
  } finally {
    clearTimeout(timeout);
  }
}

async function readBlobBounded(
  blob: AttachmentBlobReader,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(blob.sizeBytes)
    || blob.sizeBytes < 0
    || blob.sizeBytes > MAX_INPUT_BYTES
  ) {
    throw new ExtractorError('RECEIPT_EXTRACTOR_INPUT_TOO_LARGE', false);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const iterator = blob.chunks()[Symbol.asyncIterator]();
  while (true) {
    const next = await abortable(iterator.next(), signal);
    if (next.done) break;
    const chunk = next.value;
    total += chunk.byteLength;
    if (total > MAX_INPUT_BYTES || total > blob.sizeBytes) {
      throw new ExtractorError('RECEIPT_EXTRACTOR_INPUT_TOO_LARGE', false);
    }
    chunks.push(chunk);
  }
  if (total !== blob.sizeBytes) {
    throw new ExtractorError('RECEIPT_EXTRACTOR_INPUT_INVALID', false);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      new ExtractorError('RECEIPT_EXTRACTOR_TIMEOUT', true),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      reject(new ExtractorError('RECEIPT_EXTRACTOR_TIMEOUT', true));
    };
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

async function readResponseBounded(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) > MAX_RESPONSE_BYTES) {
    throw new ExtractorError('RECEIPT_EXTRACTOR_RESPONSE_TOO_LARGE', false);
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel(); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ExtractorError(
          'RECEIPT_EXTRACTOR_RESPONSE_TOO_LARGE',
          false,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ExtractorError) throw error;
    if (signal.aborted) {
      throw new ExtractorError('RECEIPT_EXTRACTOR_TIMEOUT', true);
    }
    throw new ExtractorError('RECEIPT_EXTRACTOR_UNAVAILABLE', true);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function workerError(status: number, raw: Uint8Array): ExtractorError {
  try {
    const body = JSON.parse(new TextDecoder().decode(raw)) as unknown;
    const parsed = z.object({
      code: z.string().regex(/^RECEIPT_[A-Z0-9_]{1,80}$/),
      message: z.unknown().optional(),
      transient: z.boolean(),
    }).passthrough().safeParse(body);
    if (parsed.success) {
      return new ExtractorError(parsed.data.code, parsed.data.transient);
    }
  } catch {
    // Worker details are intentionally discarded.
  }
  return new ExtractorError(
    'RECEIPT_EXTRACTOR_HTTP_ERROR',
    status === 408 || status === 429 || status >= 500,
  );
}

function validateEndpoint(deps: ExtractorClientDeps): void {
  try {
    const url = new URL(deps.url);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username !== ''
      || url.password !== ''
      || url.search !== ''
      || url.hash !== ''
      || deps.token.length < 32
    ) {
      throw new Error('invalid');
    }
  } catch {
    throw new ExtractorError('RECEIPT_EXTRACTOR_CONFIG_INVALID', false);
  }
}

function joinUrl(base: string): string {
  return `${base.replace(/\/+$/, '')}/v1/extract`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function validDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === value;
}

function projectResponse(
  response: z.infer<typeof responseSchema>,
): ReceiptExtractionResult {
  const extraction = response.extraction;
  return {
    schemaVersion: response.schema_version,
    promptVersion: response.prompt_version,
    pageCount: response.page_count,
    extraction: {
      receiptDate: extraction.receipt_date,
      documentTitle: extraction.document_title,
      vendorName: extraction.vendor_name,
      vendorTaxId: extraction.vendor_tax_id,
      vendorReceiptId: extraction.vendor_receipt_id,
      clientName: extraction.client_name,
      clientTaxId: extraction.client_tax_id,
      description: extraction.description,
      lineItems: extraction.line_items.map((item) => ({
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unit_price,
      })),
      subtotal: extraction.subtotal,
      taxAmount: extraction.tax_amount,
      totalAmount: extraction.total_amount,
      currency: extraction.currency,
      paymentMethod: extraction.payment_method,
      paymentIdentifier: extraction.payment_identifier,
      language: extraction.language,
      additionalFields: extraction.additional_fields,
      rawExtractedText: extraction.raw_extracted_text,
      documentType: extraction.document_type,
      category: extraction.category,
      extractionConfidence: extraction.extraction_confidence,
      taxComponents: extraction.tax_components.map((component) => ({
        label: component.label,
        rate: component.rate,
        amount: component.amount,
        confidence: component.confidence,
      })),
    },
    parseSalvaged: response.parse_salvaged,
    warnings: response.warnings,
    model: response.model,
    tokensIn: response.tokens_in,
    tokensOut: response.tokens_out,
    costUsd: response.cost_usd,
    durationMs: response.duration_ms,
  };
}
