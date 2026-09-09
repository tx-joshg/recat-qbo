import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function readPackage(relativePath) {
  return JSON.parse(readFileSync(join(repositoryRoot, relativePath), 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runNpm(fixtureRoot, callsPath, args) {
  writeFileSync(callsPath, '');

  const result = spawnSync('npm', args, {
    shell: process.platform === 'win32',
    cwd: fixtureRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      VITEST_CALLS_PATH: callsPath,
    },
  });

  assert.equal(
    result.status,
    0,
    `npm ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`,
  );

  return readFileSync(callsPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('server scripts keep full coverage and forward focused filters to one suite', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'recat-package-scripts-'));

  try {
    const rootPackage = readPackage('package.json');
    const sharedPackage = readPackage('shared/package.json');
    const serverPackage = readPackage('server/package.json');
    const clientPackage = readPackage('client/package.json');


    mkdirSync(join(fixtureRoot, 'shared'));
    mkdirSync(join(fixtureRoot, 'server'));
    mkdirSync(join(fixtureRoot, 'client'));
    mkdirSync(join(fixtureRoot, 'node_modules', '.bin'), { recursive: true });

    writeJson(join(fixtureRoot, 'package.json'), {
      name: 'package-script-fixture',
      private: true,
      workspaces: rootPackage.workspaces,
      scripts: rootPackage.scripts,
    });
    writeJson(join(fixtureRoot, 'shared', 'package.json'), {
      name: '@recat/shared',
      version: '0.0.0',
      private: true,
      scripts: sharedPackage.scripts,
    });
    writeJson(join(fixtureRoot, 'server', 'package.json'), {
      name: '@recat/server',
      version: '0.0.0',
      private: true,
      scripts: serverPackage.scripts,
    });
    writeJson(join(fixtureRoot, 'client', 'package.json'), {
      name: '@recat/client',
      version: '0.0.0',
      private: true,
      scripts: clientPackage.scripts,
    });

    const fakeVitestPath = join(fixtureRoot, 'node_modules', '.bin', 'vitest');
    writeFileSync(
      fakeVitestPath,
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { basename } = require('node:path');
appendFileSync(
  process.env.VITEST_CALLS_PATH,
  JSON.stringify({ cwd: basename(process.cwd()), args: process.argv.slice(2) }) + '\\n',
);
`,
    );
    chmodSync(fakeVitestPath, 0o755);
    if (process.platform === 'win32') {
      writeFileSync(`${fakeVitestPath}.cmd`, '@node "%~dp0vitest" %*\r\n');
    }

    const callsPath = join(fixtureRoot, 'vitest-calls.jsonl');

    assert.deepEqual(runNpm(fixtureRoot, callsPath, ['run', 'test', '-w', 'server']), [
      { cwd: 'server', args: ['run'] },
      { cwd: 'server', args: ['run', '--config', 'vitest.pg.config.ts'] },
    ]);

    assert.deepEqual(
      runNpm(fixtureRoot, callsPath, [
        'run',
        'test:unit',
        '-w',
        'server',
        '--',
        'src/services/mcp/rules.test.ts',
      ]),
      [{ cwd: 'server', args: ['run', 'src/services/mcp/rules.test.ts'] }],
    );

    assert.deepEqual(
      runNpm(fixtureRoot, callsPath, [
        'run',
        'test:pg',
        '-w',
        'server',
        '--',
        'src/services/mcp/rules.pg.test.ts',
      ]),
      [
        {
          cwd: 'server',
          args: [
            'run',
            '--config',
            'vitest.pg.config.ts',
            'src/services/mcp/rules.pg.test.ts',
          ],
        },
      ],
    );

    assert.deepEqual(
      runNpm(fixtureRoot, callsPath, [
        'run',
        'test:server:unit',
        '--',
        'src/services/mcp/rules.test.ts',
      ]),
      [{ cwd: 'server', args: ['run', 'src/services/mcp/rules.test.ts'] }],
    );

    assert.deepEqual(
      runNpm(fixtureRoot, callsPath, [
        'run',
        'test:server:pg',
        '--',
        'src/services/mcp/rules.pg.test.ts',
      ]),
      [
        {
          cwd: 'server',
          args: [
            'run',
            '--config',
            'vitest.pg.config.ts',
            'src/services/mcp/rules.pg.test.ts',
          ],
        },
      ],
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
