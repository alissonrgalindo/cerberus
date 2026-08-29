import { describe, expect, it } from 'vitest';
import { analyzeFunctionShape, measureFunctionShapes } from '../../src/analyzers/function-shape.js';
import { baselineWith, inputFromSource } from '../helpers.js';

describe('function-shape analyzer', () => {
  it('passes a short function with few params', async () => {
    const src = `export function add(a: number, b: number) { return a + b; }`;
    const result = await analyzeFunctionShape(inputFromSource('inline.ts', src));
    expect(result.passed).toBe(true);
  });

  it('flags a function over the parameter-count threshold', async () => {
    const src = `export function ugly(a: number, b: number, c: number, d: number, e: number) { return a; }`;
    const result = await analyzeFunctionShape(inputFromSource('inline.ts', src, {
      thresholds: { parameterCount: 4 },
    }));
    const paramViolation = result.violations.find((v) => v.analyzer === 'parameter-count');
    expect(paramViolation).toBeDefined();
    expect(paramViolation?.current).toBe(5);
  });

  it('flags a function over the length threshold', async () => {
    const body = Array.from({ length: 50 }, () => '  console.log("x");').join('\n');
    const src = `export function big() {\n${body}\n}`;
    const result = await analyzeFunctionShape(inputFromSource('inline.ts', src, {
      thresholds: { functionLength: 40 },
    }));
    const lenViolation = result.violations.find((v) => v.analyzer === 'function-length');
    expect(lenViolation).toBeDefined();
    expect(lenViolation?.current).toBeGreaterThan(40);
  });

  it('respects per-function baseline for length', async () => {
    const body = Array.from({ length: 50 }, () => '  console.log("x");').join('\n');
    const src = `export function big() {\n${body}\n}`;
    const result = await analyzeFunctionShape(
      inputFromSource('inline.ts', src, {
        thresholds: { functionLength: 40 },
        baseline: baselineWith({ functionLengthPerFunction: { big: 100 } }),
      }),
    );
    const lenViolation = result.violations.find((v) => v.analyzer === 'function-length');
    expect(lenViolation).toBeUndefined();
  });

  it('measures max length and param count', async () => {
    const src = `export function a(x: number) { return x; }
export function b(p: number, q: number, r: number) { return p + q + r; }`;
    const result = await analyzeFunctionShape(inputFromSource('inline.ts', src));
    expect(result.metrics.maxParameterCount).toBe(3);
  });

  it('excludes Cerberus marker comments from body length', () => {
    const withoutMarker = `export function run() {
  work();
}`;
    const withMarker = `export function run() {
  // TODO: cerberus(cognitive-complexity=22, limit=15, attempt=3/2)
  work();
}`;
    const plainShape = measureFunctionShapes('inline.ts', withoutMarker)[0];
    const markedShape = measureFunctionShapes('inline.ts', withMarker)[0];
    expect(markedShape?.bodyLines).toBe(plainShape?.bodyLines);
  });

  it('counts malformed hand-written marker comments toward body length', () => {
    const withoutMarker = `export function run() {
  work();
}`;
    const withMalformedMarker = `export function run() {
  // TODO: cerberus(whatever)
  work();
}`;
    const plainShape = measureFunctionShapes('inline.ts', withoutMarker)[0];
    const malformedShape = measureFunctionShapes('inline.ts', withMalformedMarker)[0];
    expect(malformedShape?.bodyLines).toBe((plainShape?.bodyLines ?? 0) + 1);
  });
});
