import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

describe('eslint no-restricted-globals fetch fence', () => {
  it('flags fetch() in a file outside src/http/client.ts', () => {
    const source = "export const x = () => fetch('https://example.com');\n";
    let stdout = '';
    let exitCode = 0;
    try {
      execFileSync('npx', ['eslint', '--stdin', '--stdin-filename', 'src/bad.ts'], {
        encoding: 'utf-8',
        cwd: process.cwd(),
        input: source,
      });
    } catch (err) {
      const e = err as { stdout?: string; status?: number; message: string };
      stdout = String(e.stdout ?? e.message);
      exitCode = e.status ?? 1;
    }
    expect(exitCode).not.toBe(0);
    expect(stdout).toMatch(/fetch\(\) is only allowed/);
  });

  it('allows fetch() inside src/http/client.ts', () => {
    const source = "export const x = () => fetch('https://example.com');\n";
    // Should exit 0 (no errors). If it throws, the rule is over-blocking.
    const out = execFileSync(
      'npx',
      ['eslint', '--stdin', '--stdin-filename', 'src/http/client.ts'],
      { encoding: 'utf-8', cwd: process.cwd(), input: source },
    );
    expect(out).not.toMatch(/no-restricted-globals/);
  });
});
