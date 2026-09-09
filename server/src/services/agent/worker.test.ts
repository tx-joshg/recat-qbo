import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { beginClaimedLiveRun, runClaimedShadowJob } from './worker.js';

const agentDirectory = dirname(fileURLToPath(import.meta.url));
const serverSourceDirectory = join(agentDirectory, '../..');
const guardedMutationModules = new Set([
  join(serverSourceDirectory, 'services/categorization.ts'),
  join(serverSourceDirectory, 'services/writeback.ts'),
]);

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(path);
    return ['.ts', '.tsx', '.mts', '.cts'].includes(extname(entry.name))
      && !/\.(?:test|spec)\.(?:ts|tsx|mts|cts)$/u.test(entry.name)
      ? [path]
      : [];
  });
}

function guardedEntrypointImporters(
  files: Array<{ fileName: string; source: string }>,
): string[] {
  return files.flatMap(({ fileName, source }) => {
    const parsed = ts.createSourceFile(
      fileName,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const importers: string[] = [];
    const protectedModule = (specifier: ts.Expression | undefined): boolean => {
      if (
        specifier === undefined
        || (!ts.isStringLiteral(specifier)
          && !ts.isNoSubstitutionTemplateLiteral(specifier))
      ) return false;
      const candidate = specifier.text.startsWith('@/')
        ? resolve(serverSourceDirectory, specifier.text.slice(2))
        : specifier.text.startsWith('.')
          ? resolve(dirname(fileName), specifier.text)
          : null;
      return candidate !== null && guardedMutationModules.has(
        candidate.replace(/\.(?:cjs|mjs|js)$/u, '.ts'),
      );
    };
    const isGuardedName = (name: string): boolean =>
      name === 'stageGuardedLiveCategorization'
      || name === 'commitGuardedLiveCategorization'
      || name === 'reconcileGuardedLiveCategorization';
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && protectedModule(node.moduleSpecifier)) {
        const bindings = node.importClause?.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          importers.push(fileName);
        } else if (bindings !== undefined) {
          for (const element of bindings.elements) {
            if (isGuardedName(element.propertyName?.text ?? element.name.text)) {
              importers.push(fileName);
            }
          }
        }
      }
      if (ts.isExportDeclaration(node) && protectedModule(node.moduleSpecifier)) {
        if (
          node.exportClause === undefined
          || ts.isNamespaceExport(node.exportClause)
        ) {
          importers.push(fileName);
        } else {
          for (const element of node.exportClause.elements) {
            if (isGuardedName(element.propertyName?.text ?? element.name.text)) {
              importers.push(fileName);
            }
          }
        }
      }
      if (
        ts.isCallExpression(node)
        && (
          node.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
        )
        && protectedModule(node.arguments[0])
      ) {
        importers.push(fileName);
      }
      if (
        ts.isImportEqualsDeclaration(node)
        && ts.isExternalModuleReference(node.moduleReference)
        && protectedModule(node.moduleReference.expression)
      ) {
        importers.push(fileName);
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    return importers;
  });
}

function capabilityImporters(
  files: Array<{ fileName: string; source: string }>,
  protectedFile: string,
  exportName: string,
): string[] {
  const protectedModule = join(agentDirectory, protectedFile);
  return files.flatMap(({ fileName, source }) => {
    const parsed = ts.createSourceFile(
      fileName,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const importers: string[] = [];
    const resolvesProtectedModule = (specifier: ts.Expression | undefined): boolean => {
      if (
        specifier === undefined
        || (!ts.isStringLiteral(specifier)
          && !ts.isNoSubstitutionTemplateLiteral(specifier))
      ) return false;
      if (!specifier.text.startsWith('.')) return false;
      return resolve(dirname(fileName), specifier.text)
        .replace(/\.(?:cjs|mjs|js)$/u, '.ts') === protectedModule;
    };
    const visit = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node)
        && resolvesProtectedModule(node.moduleSpecifier)
      ) {
        const bindings = node.importClause?.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          importers.push(fileName);
        } else if (
          bindings !== undefined
          && bindings.elements.some((element) =>
            (element.propertyName?.text ?? element.name.text)
              === exportName)
        ) {
          importers.push(fileName);
        }
      }
      if (
        ts.isExportDeclaration(node)
        && resolvesProtectedModule(node.moduleSpecifier)
      ) {
        if (
          node.exportClause === undefined
          || ts.isNamespaceExport(node.exportClause)
          || node.exportClause.elements.some((element) =>
            (element.propertyName?.text ?? element.name.text)
              === exportName)
        ) importers.push(fileName);
      }
      if (
        ts.isCallExpression(node)
        && (
          node.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
        )
        && resolvesProtectedModule(node.arguments[0])
      ) importers.push(fileName);
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    return importers;
  });
}

describe('shadow worker safety boundary', () => {
  it('restricts direct imports to snapshot, classification search, and durable job helpers', () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const fileName = join(directory, 'worker.ts');
    const source = readFileSync(fileName, 'utf8');
    const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
    const imports: string[] = [];
    parsed.forEachChild((node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.push(node.moduleSpecifier.text);
      }
    });

    expect(imports).toEqual([
      './classificationSearch.js',
      './core/decision.js',
      './core/model.js',
      './core/runner.js',
      './core/snapshot.js',
      './jobs.js',
      './snapshotLoader.js',
    ]);
    expect(source).not.toMatch(
      /stageCategorization|commitStagedCategorization|writeback|transfer|qboFactory|sendPreparedWrite|fetch\(/u,
    );
  });

  it('exports the claimed-job entry point without mutation service dependencies', () => {
    expect(runClaimedShadowJob).toBeTypeOf('function');
    expect(beginClaimedLiveRun).toBeTypeOf('function');
  });

  it('keeps the staging, writeback, and QBO bridge in the outer live worker', () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(directory, 'liveWorker.ts'), 'utf8');

    expect(source).toContain("from '../categorization.js'");
    expect(source).toContain("from '../writeback.js'");
    expect(source).toContain("from '../../lib/qbo/factory.js'");
    expect(source).not.toContain("from './core/fakeModel.js'");
  });

  it('does not export caller-forgeable autopilot writer factories', () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const categorization = readFileSync(join(directory, '../categorization.ts'), 'utf8');
    const writeback = readFileSync(join(directory, '../writeback.ts'), 'utf8');

    expect(categorization).not.toMatch(
      /export\s+(?:async\s+)?function\s+create(?:Production)?AutopilotCategorizationStager/u,
    );
    expect(writeback).not.toMatch(
      /export\s+(?:async\s+)?function\s+create(?:Production)?AutopilotWritebackCommitter/u,
    );
    expect(writeback).not.toMatch(
      /export\s+(?:interface|type)\s+AutopilotWritebackAuthorityInput/u,
    );
  });

  it('keeps guarded live mutation entry points private to the outer live worker', () => {
    const directory = agentDirectory;
    const productionFiles = productionTypeScriptFiles(serverSourceDirectory);
    const importers = guardedEntrypointImporters(productionFiles.map((fileName) => ({
      fileName,
      source: readFileSync(fileName, 'utf8'),
    })));

    expect(importers).toEqual([
      join(directory, 'liveReconciliation.ts'),
      join(directory, 'liveWorker.ts'),
      join(directory, 'liveWorker.ts'),
    ]);
    expect(productionFiles).toContain(join(serverSourceDirectory, 'index.ts'));
  });

  it('keeps the null-actor reconciliation capability private to the scheduler', () => {
    const productionFiles = productionTypeScriptFiles(serverSourceDirectory);
    const importers = capabilityImporters(
      productionFiles.map((fileName) => ({
        fileName,
        source: readFileSync(fileName, 'utf8'),
      })),
      'liveReconciliation.ts',
      'reconcileScheduledLiveMutation',
    );

    expect(importers).toEqual([join(agentDirectory, 'scheduler.ts')]);
  });

  it('allows authenticated live reconciliation only through the two guarded routes', () => {
    const productionFiles = productionTypeScriptFiles(serverSourceDirectory);
    const importers = capabilityImporters(
      productionFiles.map((fileName) => ({
        fileName,
        source: readFileSync(fileName, 'utf8'),
      })),
      'liveReconciliation.ts',
      'reconcileLiveMutation',
    );

    expect(importers).toEqual([
      join(serverSourceDirectory, 'routes/autopilot.ts'),
      join(serverSourceDirectory, 'routes/transactions.ts'),
    ]);
  });

  it('allows authenticated live enable and pause capabilities only through the admin route', () => {
    const productionFiles = productionTypeScriptFiles(serverSourceDirectory);
    const sources = productionFiles.map((fileName) => ({
      fileName,
      source: readFileSync(fileName, 'utf8'),
    }));

    expect(capabilityImporters(
      sources,
      'liveGates.ts',
      'enableLiveModeForAdmin',
    )).toEqual([join(serverSourceDirectory, 'routes/autopilot.ts')]);
    expect(capabilityImporters(
      sources,
      'circuitBreaker.ts',
      'pauseLiveModeManually',
    )).toEqual([join(serverSourceDirectory, 'routes/autopilot.ts')]);
  });

  it('keeps lower live enable and pause primitives out of every route', () => {
    const productionFiles = productionTypeScriptFiles(serverSourceDirectory);
    const sources = productionFiles.map((fileName) => ({
      fileName,
      source: readFileSync(fileName, 'utf8'),
    }));
    const routeDirectory = join(serverSourceDirectory, 'routes');

    expect(capabilityImporters(
      sources,
      'liveGates.ts',
      'enableLiveMode',
    ).filter((fileName) => fileName.startsWith(routeDirectory))).toEqual([]);
    expect(capabilityImporters(
      sources,
      'circuitBreaker.ts',
      'pauseLiveCompany',
    ).filter((fileName) => fileName.startsWith(routeDirectory))).toEqual([]);
    expect(capabilityImporters(
      sources,
      'circuitBreaker.ts',
      'pauseLiveCompanyInTransaction',
    )).toEqual([
      join(agentDirectory, 'liveWorker.ts'),
      join(serverSourceDirectory, 'services/writeback.ts'),
    ]);
  });

  it('keeps opaque reconciliation operation loading private to the autopilot route', () => {
    const productionFiles = productionTypeScriptFiles(serverSourceDirectory);
    const importers = capabilityImporters(
      productionFiles.map((fileName) => ({
        fileName,
        source: readFileSync(fileName, 'utf8'),
      })),
      'liveReconciliation.ts',
      'loadLiveReconciliationOperation',
    );

    expect(importers).toEqual([join(serverSourceDirectory, 'routes/autopilot.ts')]);
  });

  it('detects every import and re-export form that exposes guarded live mutation modules', () => {
    const files = [{
      fileName: join(serverSourceDirectory, 'routes/synthetic.ts'),
      source: [
        "import { commitGuardedLiveCategorization as unsafeCommit } from '../services/writeback.js';",
        "export { stageGuardedLiveCategorization as unsafeStage } from '../services/categorization.js';",
        "export { reconcileGuardedLiveCategorization as unsafeReconcile } from '../services/writeback.js';",
        "import * as writeback from '../services/writeback.js';",
        "export * from '../services/categorization.js';",
        "async function loadWriter() { return import('../services/writeback.js'); }",
      ].join('\n'),
    }];

    expect(guardedEntrypointImporters(files)).toEqual([
      files[0]!.fileName,
      files[0]!.fileName,
      files[0]!.fileName,
      files[0]!.fileName,
      files[0]!.fileName,
      files[0]!.fileName,
    ]);
  });
});
