import { describe, expect, it } from 'vitest';
import { analyzeCognitive } from '../../src/analyzers/cognitive-complexity.js';
import { analyzeCyclomatic } from '../../src/analyzers/cyclomatic-complexity.js';
import { analyzeFunctionShape } from '../../src/analyzers/function-shape.js';
import { baselineWith, inputFromSource } from '../helpers.js';

// True anonymous IIFE (no name binding) — the only identity is a line number, so it
// cannot be grandfathered per-name and must fall back to the file's baseline max.
function nestedIIFE(depth: number): string {
  let open = '';
  let close = '';
  for (let i = 0; i < depth; i++) {
    open += `if (x${i}) {`;
    close += '}';
  }
  return `(function () { ${open} doThing(); ${close} })();\n`;
}

const longIIFE = `(function () {\n${'  doThing();\n'.repeat(100)}})();\n`;

describe('anonymous-function grandfathering (survives line shifts)', () => {
  it('cognitive: anonymous fn over threshold but <= baseline max is grandfathered', async () => {
    const result = await analyzeCognitive(
      inputFromSource('a.ts', nestedIIFE(12), { baseline: baselineWith({ cognitiveMax: 200 }) }),
    );
    expect(result.violations).toHaveLength(0);
  });

  it('cyclomatic: anonymous fn over threshold but <= baseline max is grandfathered', async () => {
    const result = await analyzeCyclomatic(
      inputFromSource('a.ts', nestedIIFE(12), { baseline: baselineWith({ cyclomaticMax: 200 }) }),
    );
    expect(result.violations).toHaveLength(0);
  });

  it('function-length: anonymous fn over the limit but <= baseline max is grandfathered', async () => {
    const result = await analyzeFunctionShape(
      inputFromSource('a.ts', longIIFE, { baseline: baselineWith({ functionLengthMax: 200 }) }),
    );
    expect(result.violations.filter((v) => v.analyzer === 'function-length')).toHaveLength(0);
  });

  it('function-length: anonymous fn that EXCEEDS the baseline max is still flagged', async () => {
    const result = await analyzeFunctionShape(
      inputFromSource('a.ts', longIIFE, { baseline: baselineWith({ functionLengthMax: 50 }) }),
    );
    expect(result.violations.filter((v) => v.analyzer === 'function-length')).toHaveLength(1);
  });
});
