import { z } from 'zod-v4';

export interface McpSchemaBounds {
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxInputDepth: number;
  readonly maxInputKeys: number;
  readonly maxSchemaBytes: number;
  readonly maxSchemaDepth: number;
  readonly maxSchemaKeys: number;
  readonly maxSubschemas: number;
  readonly maxValidationTimeMs: number;
}

export const MCP_SCHEMA_BOUNDS: McpSchemaBounds = Object.freeze({
  maxInputBytes: 64 * 1024,
  maxOutputBytes: 256 * 1024,
  maxInputDepth: 16,
  maxInputKeys: 512,
  maxSchemaBytes: 128 * 1024,
  maxSchemaDepth: 32,
  maxSchemaKeys: 2_048,
  maxSubschemas: 512,
  maxValidationTimeMs: 50,
});

export const MCP_AUTHORED_SCHEMA_BOUNDS: McpSchemaBounds = Object.freeze({
  ...MCP_SCHEMA_BOUNDS,
  maxValidationTimeMs: 5_000,
});

export type McpSchemaBoundsErrorCode =
  | 'INPUT_BYTES'
  | 'INPUT_DEPTH'
  | 'INPUT_KEYS'
  | 'INPUT_SERIALIZATION'
  | 'OUTPUT_BYTES'
  | 'OUTPUT_SERIALIZATION'
  | 'SCHEMA_BYTES'
  | 'SCHEMA_DEPTH'
  | 'SCHEMA_KEYS'
  | 'SCHEMA_SUBSCHEMAS'
  | 'SCHEMA_SERIALIZATION'
  | 'EXTERNAL_REF'
  | 'INVALID_REF'
  | 'INVALID_SCHEMA'
  | 'CYCLIC_VALUE'
  | 'VALIDATION_TIME';

export class McpSchemaBoundsError extends Error {
  constructor(
    public readonly code: McpSchemaBoundsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'McpSchemaBoundsError';
  }
}

export type JsonSchemaObject = Record<string, unknown>;
export type JsonSchema = boolean | JsonSchemaObject;

interface WalkLimits {
  maxDepth: number;
  maxKeys: number;
}

interface WalkResult {
  keys: number;
}

function serializedByteLength(
  value: unknown,
  errorCode: 'INPUT_SERIALIZATION' | 'OUTPUT_SERIALIZATION' | 'SCHEMA_SERIALIZATION',
): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
  } catch {
    throw new McpSchemaBoundsError(errorCode, 'Value must be JSON serializable');
  }
}

export function assertBoundedMcpOutput(
  output: unknown,
  bounds: McpSchemaBounds = MCP_SCHEMA_BOUNDS,
): void {
  const outputBytes = serializedByteLength(output, 'OUTPUT_SERIALIZATION');
  if (outputBytes > bounds.maxOutputBytes) {
    throw new McpSchemaBoundsError(
      'OUTPUT_BYTES',
      `Maximum MCP output size is ${bounds.maxOutputBytes} bytes`,
    );
  }
}

function walkJsonValue(
  value: unknown,
  limits: WalkLimits,
  errorCodes: {
    depth: 'INPUT_DEPTH' | 'SCHEMA_DEPTH';
    keys: 'INPUT_KEYS' | 'SCHEMA_KEYS';
  },
  visitObject?: (value: Record<string, unknown>) => void,
): WalkResult {
  const ancestors = new WeakSet<object>();
  let keys = 0;

  const visit = (current: unknown, depth: number): void => {
    if (current === null || typeof current !== 'object') return;
    if (depth > limits.maxDepth) {
      throw new McpSchemaBoundsError(errorCodes.depth, `Maximum depth is ${limits.maxDepth}`);
    }
    if (ancestors.has(current)) {
      throw new McpSchemaBoundsError('CYCLIC_VALUE', 'Cyclic values are not valid JSON');
    }

    ancestors.add(current);
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
    } else {
      const record = current as Record<string, unknown>;
      const entries = Object.entries(record);
      keys += entries.length;
      if (keys > limits.maxKeys) {
        throw new McpSchemaBoundsError(errorCodes.keys, `Maximum key count is ${limits.maxKeys}`);
      }
      visitObject?.(record);
      for (const [, item] of entries) visit(item, depth + 1);
    }
    ancestors.delete(current);
  };

  visit(value, 1);
  return { keys };
}

const SCHEMA_VALUE_KEYWORDS = [
  'not',
  'if',
  'then',
  'else',
  'items',
  'additionalItems',
  'contains',
  'propertyNames',
  'additionalProperties',
  'unevaluatedItems',
  'unevaluatedProperties',
  'contentSchema',
] as const;

const SCHEMA_ARRAY_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const;

const SCHEMA_MAP_KEYWORDS = [
  '$defs',
  'definitions',
  'properties',
  'patternProperties',
  'dependentSchemas',
] as const;

function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJsonSchema(value: unknown): value is JsonSchema {
  return (
    typeof value === 'boolean' ||
    isJsonSchemaObject(value)
  );
}

function countJsonSchemaPositions(schema: unknown): number {
  if (typeof schema === 'boolean') return 1;
  if (!isJsonSchemaObject(schema)) return 0;

  const schemaObject = schema;
  let count = 1;
  const countSchema = (candidate: unknown): void => {
    if (isJsonSchema(candidate)) count += countJsonSchemaPositions(candidate);
  };

  for (const keyword of SCHEMA_VALUE_KEYWORDS) {
    const candidate = schemaObject[keyword];
    if (keyword === 'items' && Array.isArray(candidate)) {
      for (const item of candidate) countSchema(item);
    } else {
      countSchema(candidate);
    }
  }

  for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
    const candidates = schemaObject[keyword];
    if (!Array.isArray(candidates)) continue;
    for (const candidate of candidates) countSchema(candidate);
  }

  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    const candidates = schemaObject[keyword];
    if (candidates === null || typeof candidates !== 'object' || Array.isArray(candidates)) {
      continue;
    }
    for (const candidate of Object.values(candidates)) countSchema(candidate);
  }

  const dependencies = schemaObject.dependencies;
  if (dependencies !== null && typeof dependencies === 'object' && !Array.isArray(dependencies)) {
    for (const candidate of Object.values(dependencies)) {
      if (!Array.isArray(candidate)) countSchema(candidate);
    }
  }

  return count;
}

function assertWithinTime(startedAt: number, maxValidationTimeMs: number): void {
  if (performance.now() - startedAt > maxValidationTimeMs) {
    throw new McpSchemaBoundsError(
      'VALIDATION_TIME',
      `Validation exceeded ${maxValidationTimeMs}ms`,
    );
  }
}

export function assertBoundedJsonSchema(
  schema: unknown,
  bounds: McpSchemaBounds = MCP_SCHEMA_BOUNDS,
): asserts schema is JsonSchema {
  if (!isJsonSchema(schema)) {
    throw new McpSchemaBoundsError(
      'INVALID_SCHEMA',
      'JSON Schema must be an object or boolean',
    );
  }

  const startedAt = performance.now();
  walkJsonValue(
    schema,
    {
      maxDepth: bounds.maxSchemaDepth,
      maxKeys: bounds.maxSchemaKeys,
    },
    {
      depth: 'SCHEMA_DEPTH',
      keys: 'SCHEMA_KEYS',
    },
    (object) => {
      for (const keyword of ['$ref', '$dynamicRef'] as const) {
        if (!Object.hasOwn(object, keyword)) continue;
        const reference = object[keyword];
        if (typeof reference !== 'string') {
          throw new McpSchemaBoundsError(
            'INVALID_REF',
            `JSON Schema ${keyword} must be a string`,
          );
        }
        if (!reference.startsWith('#')) {
          throw new McpSchemaBoundsError(
            'EXTERNAL_REF',
            'Only document-local JSON Schema references are allowed',
          );
        }
      }
    },
  );

  const schemaBytes = serializedByteLength(schema, 'SCHEMA_SERIALIZATION');
  if (schemaBytes > bounds.maxSchemaBytes) {
    throw new McpSchemaBoundsError(
      'SCHEMA_BYTES',
      `Maximum JSON Schema size is ${bounds.maxSchemaBytes} bytes`,
    );
  }

  if (countJsonSchemaPositions(schema) > bounds.maxSubschemas) {
    throw new McpSchemaBoundsError(
      'SCHEMA_SUBSCHEMAS',
      `Maximum subschema count is ${bounds.maxSubschemas}`,
    );
  }
  assertWithinTime(startedAt, bounds.maxValidationTimeMs);
}

export function toBoundedJsonSchema<T extends z.ZodType>(
  schema: T,
  bounds: McpSchemaBounds = MCP_SCHEMA_BOUNDS,
): JsonSchemaObject {
  const startedAt = performance.now();
  const jsonSchema = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'throw',
    cycles: 'ref',
    reused: 'ref',
  });
  assertBoundedJsonSchema(jsonSchema, bounds);
  assertWithinTime(startedAt, bounds.maxValidationTimeMs);
  return jsonSchema as JsonSchemaObject;
}

export function parseBoundedMcpInput<T extends z.ZodType>(
  schema: T,
  input: unknown,
  bounds: McpSchemaBounds = MCP_SCHEMA_BOUNDS,
): z.output<T> {
  const startedAt = performance.now();
  walkJsonValue(
    input,
    {
      maxDepth: bounds.maxInputDepth,
      maxKeys: bounds.maxInputKeys,
    },
    {
      depth: 'INPUT_DEPTH',
      keys: 'INPUT_KEYS',
    },
  );

  const inputBytes = serializedByteLength(input, 'INPUT_SERIALIZATION');
  if (inputBytes > bounds.maxInputBytes) {
    throw new McpSchemaBoundsError(
      'INPUT_BYTES',
      `Maximum MCP input size is ${bounds.maxInputBytes} bytes`,
    );
  }
  assertWithinTime(startedAt, bounds.maxValidationTimeMs);

  const result = schema.safeParse(input);
  // Zod validation is synchronous, so this is a fail-closed post-parse overrun
  // check; the input and authored-schema structural limits constrain its work.
  assertWithinTime(startedAt, bounds.maxValidationTimeMs);
  if (!result.success) throw result.error;
  return result.data;
}
