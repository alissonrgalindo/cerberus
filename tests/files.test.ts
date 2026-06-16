import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { walkTsFiles } from '../src/files.js';

function tempProject(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'qg-files-'));
  for (const f of files) writeFileSync(join(dir, f), '// placeholder\n');
  return dir;
}

describe('walkTsFiles file selection', () => {
  it('collects JavaScript (.js/.mjs/.cjs/.jsx) alongside TypeScript', () => {
    const dir = tempProject(['a.js', 'b.mjs', 'c.cjs', 'd.jsx', 'e.ts', 'f.tsx']);
    const found = walkTsFiles(dir, []).map((p) => basename(p)).sort();
    expect(found).toEqual(['a.js', 'b.mjs', 'c.cjs', 'd.jsx', 'e.ts', 'f.tsx']);
  });

  it('still excludes declaration files and non-code extensions', () => {
    const dir = tempProject(['keep.js', 'types.d.ts', 'data.json', 'script.py', 'styles.css']);
    const found = walkTsFiles(dir, []).map((p) => basename(p));
    expect(found).toEqual(['keep.js']);
  });
});
