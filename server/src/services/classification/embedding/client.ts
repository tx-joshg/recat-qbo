export const VOYAGE_EMBEDDING_PROVIDER = 'voyage' as const;
export const VOYAGE_EMBEDDING_MODEL = 'voyage-4-large' as const;
export const VOYAGE_EMBEDDING_DIMENSIONS = 1024 as const;
export const VOYAGE_EMBEDDING_OUTPUT_DTYPE = 'float' as const;

const MAX_BATCH_SIZE = 128;
const MAX_INPUTS_PER_CALL = 512;
const MAX_INPUT_CODE_POINTS = 8_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 60_000;

export type VoyageEmbeddingErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_INPUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'INVALID_PROVIDER_RESPONSE';

export class VoyageEmbeddingError extends Error {
  constructor(public readonly code: VoyageEmbeddingErrorCode) {
    super(
      code === 'INVALID_INPUT'
        ? 'Embedding input is invalid.'
        : code === 'INVALID_CONFIGURATION'
          ? 'Embedding provider is not configured.'
          : 'Embedding provider is unavailable.',
    );
    this.name = 'VoyageEmbeddingError';
  }
}

export interface VoyageEmbeddingClientConfig {
  apiKey: string;
  /** `/embeddings` is appended to this Voyage v1 base URL. */
  baseUrl: string;
  timeoutMs: number;
  batchSize: number;
  fetch?: typeof fetch;
}

export interface VoyageEmbeddingClient {
  embedDocuments(inputs: readonly string[]): Promise<number[][]>;
  embedQuery(input: string): Promise<number[]>;
}

export interface ClassificationEmbeddingRuntimeConfig extends VoyageEmbeddingClientConfig {
  fingerprintSalt: string;
}

function integerEnvironmentValue(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/u.test(value)) throw new VoyageEmbeddingError('INVALID_CONFIGURATION');
  return Number(value);
}

/** Reads only the dedicated Voyage variables at call time; no key is cached or logged. */
export function classificationEmbeddingRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ClassificationEmbeddingRuntimeConfig | null {
  const apiKey = environment.VOYAGE_API_KEY;
  if (apiKey === undefined || apiKey.trim() === '') return null;
  const config = {
    apiKey,
    baseUrl: environment.CLASSIFICATION_EMBEDDING_BASE_URL
      || 'https://api.voyageai.com/v1',
    batchSize: integerEnvironmentValue(
      environment.CLASSIFICATION_EMBEDDING_BATCH_SIZE,
      32,
    ),
    timeoutMs: integerEnvironmentValue(
      environment.CLASSIFICATION_EMBEDDING_TIMEOUT_MS,
      10_000,
    ),
    fingerprintSalt: environment.CLASSIFICATION_EMBEDDING_FINGERPRINT_SALT
      || 'recat-classification-embeddings-v1',
  };
  checkedConfig(config);
  return config;
}

function checkedConfig(config: VoyageEmbeddingClientConfig): Required<VoyageEmbeddingClientConfig> {
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(config.baseUrl);
  } catch {
    throw new VoyageEmbeddingError('INVALID_CONFIGURATION');
  }
  if (
    typeof config.apiKey !== 'string'
    || config.apiKey.trim() === ''
    || !['http:', 'https:'].includes(parsedBaseUrl.protocol)
    || !Number.isInteger(config.batchSize)
    || config.batchSize < 1
    || config.batchSize > MAX_BATCH_SIZE
    || !Number.isInteger(config.timeoutMs)
    || config.timeoutMs < MIN_TIMEOUT_MS
    || config.timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new VoyageEmbeddingError('INVALID_CONFIGURATION');
  }
  return { ...config, baseUrl: parsedBaseUrl.toString(), fetch: config.fetch ?? fetch };
}

function checkedInputs(inputs: readonly string[]): string[] {
  if (
    !Array.isArray(inputs)
    || inputs.length < 1
    || inputs.length > MAX_INPUTS_PER_CALL
  ) {
    throw new VoyageEmbeddingError('INVALID_INPUT');
  }
  return inputs.map((input) => {
    if (
      typeof input !== 'string'
      || input.trim() === ''
      || Array.from(input).length > MAX_INPUT_CODE_POINTS
      // Recipe documents deliberately use LF between labelled fields. Other
      // controls remain forbidden at the provider boundary.
      || /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(input)
    ) {
      throw new VoyageEmbeddingError('INVALID_INPUT');
    }
    return input.normalize('NFC').trim();
  });
}

function parseEmbeddingResponse(value: unknown, expectedCount: number): number[][] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new VoyageEmbeddingError('INVALID_PROVIDER_RESPONSE');
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.object !== 'list' || envelope.model !== VOYAGE_EMBEDDING_MODEL) {
    throw new VoyageEmbeddingError('INVALID_PROVIDER_RESPONSE');
  }
  const data = envelope.data;
  if (!Array.isArray(data) || data.length !== expectedCount) {
    throw new VoyageEmbeddingError('INVALID_PROVIDER_RESPONSE');
  }
  return data.map((candidate, expectedIndex) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new VoyageEmbeddingError('INVALID_PROVIDER_RESPONSE');
    }
    const row = candidate as Record<string, unknown>;
    if (
      row.object !== 'embedding'
      || row.index !== expectedIndex
      || !Array.isArray(row.embedding)
    ) {
      throw new VoyageEmbeddingError('INVALID_PROVIDER_RESPONSE');
    }
    if (
      row.embedding.length !== VOYAGE_EMBEDDING_DIMENSIONS
      || row.embedding.some((component) => typeof component !== 'number' || !Number.isFinite(component))
    ) {
      throw new VoyageEmbeddingError('INVALID_PROVIDER_RESPONSE');
    }
    return row.embedding as number[];
  });
}

export function createVoyageEmbeddingClient(
  provided: VoyageEmbeddingClientConfig,
): VoyageEmbeddingClient {
  const config = checkedConfig(provided);
  const endpoint = new URL(
    `${config.baseUrl.replace(/\/+$/u, '')}/embeddings`,
  ).toString();

  async function requestBatch(
    inputs: readonly string[],
    inputType: 'document' | 'query',
  ): Promise<number[][]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await config.fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: inputs,
          model: VOYAGE_EMBEDDING_MODEL,
          input_type: inputType,
          output_dimension: VOYAGE_EMBEDDING_DIMENSIONS,
          output_dtype: VOYAGE_EMBEDDING_OUTPUT_DTYPE,
          truncation: false,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new VoyageEmbeddingError('PROVIDER_UNAVAILABLE');
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new VoyageEmbeddingError('INVALID_PROVIDER_RESPONSE');
      }
      return parseEmbeddingResponse(body, inputs.length);
    } catch (error) {
      if (error instanceof VoyageEmbeddingError) throw error;
      throw new VoyageEmbeddingError('PROVIDER_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async embedDocuments(rawInputs) {
      const inputs = checkedInputs(rawInputs);
      const result: number[][] = [];
      for (let offset = 0; offset < inputs.length; offset += config.batchSize) {
        result.push(...await requestBatch(
          inputs.slice(offset, offset + config.batchSize),
          'document',
        ));
      }
      return result;
    },
    async embedQuery(rawInput) {
      const [input] = checkedInputs([rawInput]);
      const [embedding] = await requestBatch([input!], 'query');
      if (embedding === undefined) throw new VoyageEmbeddingError('INVALID_PROVIDER_RESPONSE');
      return embedding;
    },
  };
}
