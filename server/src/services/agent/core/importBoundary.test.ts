import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const coreDirectory = dirname(fileURLToPath(import.meta.url));
const allowedProductionModules = new Set([
  'node:buffer',
  'zod',
  './decision.js',
  './fakeModel.js',
  './model.js',
  './runner.js',
  './snapshot.js',
  './tools.js',
  './verifier.js',
]);
const typeScriptExtensions = new Set(['.ts', '.tsx', '.mts', '.cts']);
const nonliteralSpecifier = '[nonliteral module specifier]';

interface ForbiddenImport {
  fileName: string;
  specifier: string;
}

function collectForbiddenImports(files: Array<{ fileName: string; sourceText: string }>): ForbiddenImport[] {
  return files.flatMap(({ fileName, sourceText }) =>
    collectModuleSpecifiers(sourceText, fileName)
      .filter((specifier) => specifier === nonliteralSpecifier || !allowedProductionModules.has(specifier))
      .map((specifier) => ({ fileName, specifier })),
  );
}

function collectModuleSpecifiers(sourceText: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, scriptKindForFile(fileName));
  const specifiers: string[] = [];
  const add = (node: ts.Node | undefined, rejectNonliteral = false): void => {
    if (node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) specifiers.push(node.text);
    else if (rejectNonliteral) specifiers.push(nonliteralSpecifier);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0], true);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') add(node.arguments[0], true);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function scriptKindForFile(fileName: string): ts.ScriptKind {
  return extname(fileName) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function coreTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return coreTypeScriptFiles(path);
    return isProductionTypeScriptSourceFile(path) ? [path] : [];
  });
}

function isTypeScriptSourceFile(path: string): boolean {
  return typeScriptExtensions.has(extname(path));
}

function isProductionTypeScriptSourceFile(path: string): boolean {
  return isTypeScriptSourceFile(path) && !/\.(?:test|spec)\.(?:ts|tsx|mts|cts)$/u.test(path);
}

describe('agent core import boundary', () => {
  it('catches static, type-only, re-export, dynamic, relative, and aliased imports outside the allowlist', () => {
    const syntheticFile = join(coreDirectory, 'synthetic.ts');
    const sourceText = [
      "import { PrismaClient } from '@prisma/client';",
      "import type { Request } from 'express';",
      "export * from '../../writeback.js';",
      "export type { QboClient } from '@/lib/qbo/real.js';",
      "type LazyMcp = import('../../../mcp/client.js').Client;",
      "async function loadScheduler() { return import('../../../jobs/scheduler.js'); }",
      "async function loadQbo() { return import(`../../qbo/client.js`); }",
    ].join('\n');

    expect(collectForbiddenImports([{ fileName: syntheticFile, sourceText }]).map((entry) => entry.specifier)).toEqual([
      '@prisma/client',
      'express',
      '../../writeback.js',
      '@/lib/qbo/real.js',
      '../../../mcp/client.js',
      '../../../jobs/scheduler.js',
      '../../qbo/client.js',
    ]);
  });

  it('scans every supported TypeScript source extension', () => {
    expect(['core.ts', 'core.tsx', 'core.mts', 'core.cts', 'core.js'].map(isTypeScriptSourceFile)).toEqual([true, true, true, true, false]);
  });

  it('treats nonliteral loading, CommonJS loading, and TSX imports as boundary violations', () => {
    const sources = [
      { fileName: join(coreDirectory, 'dynamic.ts'), sourceText: "const path = '../../qbo/client.js'; void import(path);" },
      { fileName: join(coreDirectory, 'commonjs.ts'), sourceText: "const client = require('../../qbo/client.js');" },
      { fileName: join(coreDirectory, 'commonjs-dynamic.ts'), sourceText: "const path = '../../qbo/client.js'; const client = require(path);" },
      { fileName: join(coreDirectory, 'component.tsx'), sourceText: "const View = () => <section />; import client from '../../qbo/client.js';" },
    ];

    expect(collectForbiddenImports(sources).map((entry) => entry.specifier)).toEqual([
      nonliteralSpecifier,
      '../../qbo/client.js',
      nonliteralSpecifier,
      '../../qbo/client.js',
    ]);
  });

  it('rejects the real categorization service and persistence-capable built-ins', () => {
    const syntheticFile = join(coreDirectory, 'synthetic.ts');
    const sourceText = [
      "import { stageCategorization } from '../../categorization.js';",
      "import { writeFile } from 'node:fs';",
    ].join('\n');

    expect(collectForbiddenImports([{ fileName: syntheticFile, sourceText }]).map((entry) => entry.specifier)).toEqual([
      '../../categorization.js',
      'node:fs',
    ]);
  });

  it('allows the actual provider-neutral core', () => {
    const files = coreTypeScriptFiles(coreDirectory).map((fileName) => ({ fileName, sourceText: readFileSync(fileName, 'utf8') }));
    expect(collectForbiddenImports(files)).toEqual([]);
  });
});
