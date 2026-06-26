import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { isExtensionGlob, makeBinaryAssetMatcher, walkTsFiles } from '../src/files.js';

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

describe('binaryAssets extension-glob guard', () => {
  it('accepts concrete extension globs', () => {
    for (const ok of ['**/*.pen', '*.png', 'src/**/*.{woff,woff2}', 'a/b/c.svg']) {
      expect(isExtensionGlob(ok)).toBe(true);
    }
  });

  it('rejects patterns that could match arbitrary files', () => {
    for (const bad of ['**', '*', '**/*', '**/*.*', 'secret.env*', 'src/**']) {
      expect(isExtensionGlob(bad)).toBe(false);
    }
  });

  it('matcher honors safe entries and matches by extension', () => {
    const match = makeBinaryAssetMatcher(['**/*.pen', '**/*.png']);
    expect(match('design/main.pen')).toBe(true);
    expect(match('assets/logo.png')).toBe(true);
    expect(match('src/index.ts')).toBe(false);
  });

  it('matcher drops unsafe entries (warning) so it can never match everything', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const match = makeBinaryAssetMatcher(['**/*']);
    // the only entry was unsafe → matcher matches nothing, secret scanner stays live
    expect(match('src/leak.ts')).toBe(false);
    expect(match('anything.pen')).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ignoring binaryAssets entry/));
    warn.mockRestore();
  });
});
