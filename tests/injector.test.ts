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
    expect(out[2]).toBe('  // TODO: cerberus(cognitive-complexity=22, limit=15, attempt=3/2)');
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
    expect(out.match(/TODO: cerberus/g)).toHaveLength(2);
  });

  it('is idempotent — does not duplicate an identical TODO already above', () => {
    const src = ['function a() {', '  const x = handleSubmit();', '}'].join('\n');
    const once = injectTodos(src, [{ ...cognitive, location: 'a:2' }], '3/2');
    const twice = injectTodos(once, [{ ...cognitive, location: 'a:3' }], '3/2');
    expect(twice.match(/TODO: cerberus/g)).toHaveLength(1);
  });

  it('does not duplicate the same analyzer marker across different attempts', () => {
    const src = ['function a() {', '  const x = handleSubmit();', '}'].join('\n');
    const once = injectTodos(src, [{ ...cognitive, location: 'a:2' }], '3/2');
    const twice = injectTodos(once, [{ ...cognitive, location: 'a:3' }], '4/2');
    expect(twice.match(/TODO: cerberus/g)).toHaveLength(1);
    expect(twice).toContain('attempt=4/2');
    expect(twice).not.toContain('attempt=3/2');
  });

  it('refreshes one analyzer and adds another in the same marker block', () => {
    const src = ['function a() {', '  const x = handleSubmit();', '}'].join('\n');
    const typeSafety: Violation = {
      analyzer: 'type-safety',
      location: 'L2',
      current: 1,
      threshold: 0,
      suggestion: 'x',
    };
    const once = injectTodos(src, [{ ...cognitive, location: 'a:2' }], '3/2');
    const twice = injectTodos(
      once,
      [{ ...cognitive, location: 'a:3' }, { ...typeSafety, location: 'L3' }],
      '4/2',
    );
    expect(twice.match(/TODO: cerberus/g)).toHaveLength(2);
    expect(twice).toContain('cerberus(cognitive-complexity=22, limit=15, attempt=4/2)');
    expect(twice).toContain('cerberus(type-safety=1, limit=0, attempt=4/2)');
    expect(twice).not.toContain('attempt=3/2');
  });

  it('refreshes a marker for a target that started on line 1', () => {
    const src = ['const x = handleSubmit();', 'const y = 2;'].join('\n');
    const violation = { ...cognitive, location: 'a:1' };
    const once = injectTodos(src, [violation], '3/2');
    const twice = injectTodos(once, [violation], '4/2');
    expect(twice.match(/TODO: cerberus/g)).toHaveLength(1);
    expect(twice).toContain('attempt=4/2');
    expect(twice).not.toContain('attempt=3/2');
  });

  it('refreshes markers whose analyzer name is not lowercase kebab-case', () => {
    const src = ['function a() {', '  const x = handleSubmit();', '}'].join('\n');
    const custom = { ...cognitive, analyzer: 'Type_Safety.v2', location: 'a:2' };
    const once = injectTodos(src, [custom], '3/2');
    const twice = injectTodos(once, [{ ...custom, location: 'a:3' }], '4/2');
    expect(twice.match(/TODO: cerberus/g)).toHaveLength(1);
    expect(twice).toContain('cerberus(Type_Safety.v2=22, limit=15, attempt=4/2)');
  });

  it('handles type-safety L-style locations', () => {
    const src = ['const a = 1;', 'const b = x as unknown as Y;'].join('\n');
    const v: Violation = { analyzer: 'type-safety', location: 'L2', current: 1, threshold: 0, suggestion: 'x' };
    const out = injectTodos(src, [v], '3/2').split('\n');
    expect(out[1]).toContain('TODO: cerberus(type-safety=1');
  });
});
