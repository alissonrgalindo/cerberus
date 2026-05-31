import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

function tempProject(configJson?: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'qg-cfg-'));
  if (configJson) writeFileSync(join(dir, '.quality-gate.json'), JSON.stringify(configJson));
  return dir;
}

describe('config loader', () => {
  it('returns built-in defaults when no config file exists', () => {
    const config = loadConfig(tempProject());
    expect(config.thresholds.cognitiveComplexity).toBe(15);
    expect(config.tsxOverrides.cognitiveComplexity).toBe(20);
    expect(config.maxRefactorAttempts).toBe(2);
  });

  it('applies a preset via extends', () => {
    const config = loadConfig(tempProject({ extends: '@quality-gate/nextjs' }));
    expect(config.thresholds.cognitiveComplexity).toBe(15);
    expect(config.ignore).toContain('**/.next/**');
  });

  it('layers user overrides over the preset', () => {
    const config = loadConfig(
      tempProject({ extends: '@quality-gate/nextjs', thresholds: { cognitiveComplexity: 25 } }),
    );
    expect(config.thresholds.cognitiveComplexity).toBe(25);
    // unspecified threshold still comes from the preset/default
    expect(config.thresholds.cyclomaticComplexity).toBe(10);
  });

  it('throws on an unknown preset', () => {
    expect(() => loadConfig(tempProject({ extends: '@quality-gate/nope' }))).toThrow(/Unknown preset/);
  });
});
