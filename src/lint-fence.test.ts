import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
// `eslint/bin/eslint.js` isn't in the package's `exports`, so resolve via package.json
// and join the bin path relative to the package root. This still pins us to the local
// installed copy (no `npx` cold-cache prompts / downloads in CI).
const eslintPkgJson = require.resolve('eslint/package.json');
const eslintBin = resolve(dirname(eslintPkgJson), 'bin', 'eslint.js');

describe('eslint no-restricted-globals fetch fence', () => {
  it('flags fetch() in a file outside src/http/client.ts', () => {
    const source = "export const x = () => fetch('https://example.com');\n";
    let stdout = '';
    let exitCode = 0;
    try {
      execFileSync(process.execPath, [eslintBin, '--stdin', '--stdin-filename', 'src/bad.ts'], {
        encoding: 'utf-8',
        cwd: process.cwd(),
        input: source,
      });
    } catch (err) {
      const e = err as { stdout?: string; status?: number };
      stdout = e.stdout ?? '';
      exitCode = e.status ?? 1;
    }
    expect(exitCode).not.toBe(0);
    expect(stdout, 'expected eslint to write violations to stdout').not.toBe('');
    expect(stdout).toMatch(/fetch\(\) is only allowed/);
  });

  it('allows fetch() inside src/http/client.ts', () => {
    const source = "export const x = () => fetch('https://example.com');\n";
    // If this throws, the override isn't exempting client.ts.
    expect(() =>
      execFileSync(
        process.execPath,
        [eslintBin, '--stdin', '--stdin-filename', 'src/http/client.ts'],
        { encoding: 'utf-8', cwd: process.cwd(), input: source },
      ),
    ).not.toThrow();
  });
});
