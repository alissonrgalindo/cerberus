import { describe, expect, it } from 'vitest';
import { injectTodos } from '../src/injector.js';
import type { Violation } from '../src/types.js';

const cognitive: Violation = {
  analyzer: 'cognitive-complexity',
  location: 'handleSubmit:3',
  current: 22,
  threshold: 15,
  suggestion: 'x',
};

describe('injectTodos', () => {
  it('inserts a TODO above the violating line, matching indentation', () => {
    const src = ['function a() {', '', '  const x = handleSubmit();', '}'].join('\n');
    const out = injectTodos(src, [cognitive], '3/2').split('\n');
    expect(out[2]).toBe('  // TODO: quality-gate(cognitive-complexity=22, limit=15, attempt=3/2)');
    expect(out[3]).toBe('  const x = handleSubmit();');
  });

  it('inserts bottom-up so multiple line targets stay correct', () => {
    const src = ['line1', 'line2', 'line3', 'line4'].join('\n');
    const v1: Violation = { ...cognitive, location: 'a:2' };
    const v2: Violation = { ...cognitive, location: 'b:4' };
    const out = injectTodos(src, [v1, v2], '3/2');
    expect(out).toContain('line2');
    expect(out).toContain('line4');
    // both TODO comments present
    expect(out.match(/TODO: quality-gate/g)).toHaveLength(2);
  });

  it('is idempotent — does not duplicate an identical TODO already above', () => {
    const src = ['function a() {', '  const x = handleSubmit();', '}'].join('\n');
    const once = injectTodos(src, [{ ...cognitive, location: 'a:2' }], '3/2');
    const twice = injectTodos(once, [{ ...cognitive, location: 'a:3' }], '3/2');
    expect(twice.match(/TODO: quality-gate/g)).toHaveLength(1);
  });

  it('handles type-safety L-style locations', () => {
    const src = ['const a = 1;', 'const b = x as unknown as Y;'].join('\n');
    const v: Violation = { analyzer: 'type-safety', location: 'L2', current: 1, threshold: 0, suggestion: 'x' };
    const out = injectTodos(src, [v], '3/2').split('\n');
    expect(out[1]).toContain('TODO: quality-gate(type-safety=1');
  });
});
