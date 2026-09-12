import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod-v4';
import {
  MCP_SCHEMA_BOUNDS,
  McpSchemaBoundsError,
  assertBoundedJsonSchema,
  assertBoundedMcpOutput,
  parseBoundedMcpInput,
  toBoundedJsonSchema,
} from './schemaBounds.js';

describe('bounded MCP schemas', () => {
  it.each([null, 42, 'schema', [], undefined])(
    'rejects a non-schema root: %j',
    (schema) => {
      expect(() => assertBoundedJsonSchema(schema)).toThrowError(
        expect.objectContaining<McpSchemaBoundsError>({
          code: 'INVALID_SCHEMA',
        }),
      );
    },
  );

  it.each([true, false, { type: 'string' }])('accepts a JSON Schema root: %j', (schema) => {
    expect(() => assertBoundedJsonSchema(schema)).not.toThrow();
  });

  it('emits closed Draft 2020-12 schemas without losing composition keywords', () => {
    const schema = z.strictObject({
      selector: z.union([
        z.strictObject({ id: z.string().max(64) }),
        z.strictObject({ cursor: z.string().max(512) }),
      ]),
    });

    const jsonSchema = toBoundedJsonSchema(schema);

    expect(jsonSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(jsonSchema.additionalProperties).toBe(false);
    expect(jsonSchema.properties).toMatchObject({
      selector: {
        anyOf: [
          expect.objectContaining({ additionalProperties: false }),
          expect.objectContaining({ additionalProperties: false }),
        ],
      },
    });
  });

  it('rejects an external reference without attempting a network fetch', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    expect(() =>
      assertBoundedJsonSchema({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $ref: 'https://schemas.example.test/account.json',
      }),
    ).toThrowError(
      expect.objectContaining<McpSchemaBoundsError>({
        code: 'EXTERNAL_REF',
      }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('accepts local references', () => {
    expect(() =>
      assertBoundedJsonSchema({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $defs: {
          identifier: { type: 'string', maxLength: 64 },
        },
        $ref: '#/$defs/identifier',
      }),
    ).not.toThrow();
  });

  it('rejects an external dynamic reference without attempting a network fetch', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    expect(() =>
      assertBoundedJsonSchema({
        $dynamicRef: 'https://schemas.example.test/account.json',
      }),
    ).toThrowError(
      expect.objectContaining<McpSchemaBoundsError>({
        code: 'EXTERNAL_REF',
      }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('accepts a local dynamic reference', () => {
    expect(() =>
      assertBoundedJsonSchema({
        $dynamicRef: '#account',
      }),
    ).not.toThrow();
  });

  it.each([
    {
      name: 'body bytes',
      input: { value: 'x'.repeat(64) },
      limits: { maxInputBytes: 32 },
      code: 'INPUT_BYTES',
    },
    {
      name: 'input depth',
      input: { one: { two: { three: true } } },
      limits: { maxInputDepth: 2 },
      code: 'INPUT_DEPTH',
    },
    {
      name: 'input keys',
      input: { one: 1, two: 2, three: 3 },
      limits: { maxInputKeys: 2 },
      code: 'INPUT_KEYS',
    },
  ])('rejects inputs beyond the $name limit', ({ input, limits, code }) => {
    expect(() =>
      parseBoundedMcpInput(z.unknown(), input, {
        ...MCP_SCHEMA_BOUNDS,
        ...limits,
      }),
    ).toThrowError(expect.objectContaining<McpSchemaBoundsError>({ code }));
  });

  it('measures output bounds in UTF-8 bytes including JSON syntax', () => {
    expect(() => assertBoundedMcpOutput('😀', { ...MCP_SCHEMA_BOUNDS, maxOutputBytes: 6 })).not.toThrow();
    expect(() => assertBoundedMcpOutput('😀', { ...MCP_SCHEMA_BOUNDS, maxOutputBytes: 5 }))
      .toThrowError(expect.objectContaining({ code: 'OUTPUT_BYTES' }));
  });

  it('turns unserializable output into a bounded error', () => {
    const value: { cycle?: unknown } = {};
    value.cycle = value;
    expect(() => assertBoundedMcpOutput(value))
      .toThrowError(expect.objectContaining({ code: 'OUTPUT_SERIALIZATION' }));
  });

  it('rejects a schema-valid service result whose serialized payload exceeds the output bound', () => {
    expect(() => assertBoundedMcpOutput({ evidence: 'x'.repeat(128) }, {
      ...MCP_SCHEMA_BOUNDS,
      maxOutputBytes: 64,
    })).toThrowError(expect.objectContaining<McpSchemaBoundsError>({
      code: 'OUTPUT_BYTES',
    }));
  });

  it.each([
    {
      name: 'schema bytes',
      schema: { type: 'string', description: 'x'.repeat(64) },
      limits: { maxSchemaBytes: 32 },
      code: 'SCHEMA_BYTES',
    },
    {
      name: 'schema depth',
      schema: { one: { two: { three: true } } },
      limits: { maxSchemaDepth: 2 },
      code: 'SCHEMA_DEPTH',
    },
    {
      name: 'schema keys',
      schema: { one: true, two: true, three: true },
      limits: { maxSchemaKeys: 2 },
      code: 'SCHEMA_KEYS',
    },
    {
      name: 'subschemas',
      schema: {
        anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
      },
      limits: { maxSubschemas: 2 },
      code: 'SCHEMA_SUBSCHEMAS',
    },
  ])('rejects JSON schemas beyond the $name limit', ({ schema, limits, code }) => {
    expect(() =>
      assertBoundedJsonSchema(schema, {
        ...MCP_SCHEMA_BOUNDS,
        ...limits,
      }),
    ).toThrowError(expect.objectContaining<McpSchemaBoundsError>({ code }));
  });

  it('counts boolean schemas in applicator positions toward the subschema limit', () => {
    expect(() =>
      assertBoundedJsonSchema(
        {
          anyOf: Array.from({ length: 513 }, () => true),
        },
        {
          ...MCP_SCHEMA_BOUNDS,
          maxSubschemas: 512,
        },
      ),
    ).toThrowError(
      expect.objectContaining<McpSchemaBoundsError>({
        code: 'SCHEMA_SUBSCHEMAS',
      }),
    );
  });

  it('does not count arbitrary annotation objects as subschemas', () => {
    expect(() =>
      assertBoundedJsonSchema(
        {
          type: 'string',
          examples: Array.from({ length: 32 }, (_, index) => ({
            label: `example-${index}`,
          })),
        },
        {
          ...MCP_SCHEMA_BOUNDS,
          maxSubschemas: 1,
        },
      ),
    ).not.toThrow();
  });

  it('reports cyclic input with its stable cycle error', () => {
    const input: Record<string, unknown> = {};
    input.self = input;

    expect(() => parseBoundedMcpInput(z.unknown(), input)).toThrowError(
      expect.objectContaining<McpSchemaBoundsError>({
        code: 'CYCLIC_VALUE',
      }),
    );
  });

  it('reports cyclic schemas with its stable cycle error', () => {
    const schema: Record<string, unknown> = {};
    schema.properties = { self: schema };

    expect(() => assertBoundedJsonSchema(schema)).toThrowError(
      expect.objectContaining<McpSchemaBoundsError>({
        code: 'CYCLIC_VALUE',
      }),
    );
  });

  it('retains stable serialization errors for non-JSON BigInt values', () => {
    expect(() => parseBoundedMcpInput(z.unknown(), { value: 1n })).toThrowError(
      expect.objectContaining<McpSchemaBoundsError>({
        code: 'INPUT_SERIALIZATION',
      }),
    );
    expect(() => assertBoundedJsonSchema({ const: 1n })).toThrowError(
      expect.objectContaining<McpSchemaBoundsError>({
        code: 'SCHEMA_SERIALIZATION',
      }),
    );
  });

  it('fails closed when Zod validation exceeds its time budget', () => {
    const slowSchema = z.unknown().superRefine(() => {
      const stopAt = performance.now() + 10;
      while (performance.now() < stopAt) {
        // Deliberately consume the validation budget.
      }
    });

    expect(() =>
      parseBoundedMcpInput(slowSchema, 'value', {
        ...MCP_SCHEMA_BOUNDS,
        maxValidationTimeMs: 1,
      }),
    ).toThrowError(
      expect.objectContaining<McpSchemaBoundsError>({
        code: 'VALIDATION_TIME',
      }),
    );
  });

  it('counts structural walking and serialization against the input time budget', () => {
    const input = {
      get delayed(): boolean {
        const stopAt = performance.now() + 10;
        while (performance.now() < stopAt) {
          // Deliberately consume the structural-validation budget.
        }
        return true;
      },
    };

    expect(() =>
      parseBoundedMcpInput(z.unknown(), input, {
        ...MCP_SCHEMA_BOUNDS,
        maxValidationTimeMs: 1,
      }),
    ).toThrowError(
      expect.objectContaining<McpSchemaBoundsError>({
        code: 'VALIDATION_TIME',
      }),
    );
  });
});
