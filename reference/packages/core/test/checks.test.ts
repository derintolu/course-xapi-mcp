// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { REGEX_TIME_LIMIT_MS, hasNestedQuantifier, runChecks, type Check } from '../src/index.ts';

const files = { 'a.json': '{"port": 8080, "list": [1, {"x/y": true}]}', 'a.txt': 'hello world' };

describe('runChecks', () => {
  it('passes contains, notContains and regex checks', () => {
    const checks: Check[] = [
      { type: 'contains', file: 'a.txt', value: 'hello', message: 'm' },
      { type: 'notContains', file: 'a.txt', value: 'bye', message: 'm' },
      { type: 'regex', file: 'a.txt', pattern: '^hello\\s', message: 'm' },
    ];
    expect(runChecks(checks, files).passed).toBe(true);
  });

  it('resolves JSON pointers including escapes and array indexes', () => {
    const r = runChecks(
      [
        { type: 'json', file: 'a.json', pointer: '/port', equals: 8080, message: 'm' },
        { type: 'json', file: 'a.json', pointer: '/list/1/x~1y', equals: true, message: 'm' },
      ],
      files,
    );
    expect(r.passed).toBe(true);
  });

  it('fails on a type mismatch, a missing file, invalid JSON and a bad pointer', () => {
    const r = runChecks(
      [
        { type: 'json', file: 'a.json', pointer: '/port', equals: '8080', message: 'type' },
        { type: 'contains', file: 'missing.txt', value: 'x', message: 'missing' },
        { type: 'json', file: 'a.txt', pointer: '/x', equals: 1, message: 'invalid' },
        { type: 'json', file: 'a.json', pointer: 'port', equals: 8080, message: 'pointer' },
      ],
      files,
    );
    expect(r.passed).toBe(false);
    expect(r.results.map((x) => x.passed)).toEqual([false, false, false, false]);
    expect(r.results[0]).toMatchObject({ index: 0, message: 'type' });
  });

  it('compares objects independent of key order', () => {
    const r = runChecks([{ type: 'json', file: 'o.json', pointer: '', equals: { a: 1, b: 2 }, message: 'm' }], {
      'o.json': '{"b": 2, "a": 1}',
    });
    expect(r.passed).toBe(true);
  });

  it('does not read inherited properties as files', () => {
    expect(runChecks([{ type: 'contains', file: 'constructor', value: 'f', message: 'm' }], {}).passed).toBe(false);
  });

  it.each([
    ['^(a+)+$', 'a'.repeat(40) + '!'],
    ['^(a+){3}$', 'a'.repeat(2000) + '!'],
    ['^(a|a)+$', 'a'.repeat(26) + '!'],
    ['^.*.*.*=$', 'x'.repeat(4000)],
  ])('refuses %s on learner text without running it', (pattern, text) => {
    const start = Date.now();
    expect(runChecks([{ type: 'regex', file: 'a.txt', pattern, message: 'm' }], { 'a.txt': text }).passed).toBe(false);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('stops any other slow regex at the time limit; the check fails and says why', () => {
    // Polynomial backtracking the shape heuristic does not catch.
    const slow: Check = { type: 'regex', file: 'a.txt', pattern: '^.*x.*x.*x.*x.*y$', message: 'needs y' };
    expect(hasNestedQuantifier(slow.pattern)).toBe(false);
    const start = Date.now();
    const r = runChecks([slow], { 'a.txt': 'x'.repeat(3000) });
    expect(Date.now() - start).toBeLessThan(REGEX_TIME_LIMIT_MS + 400);
    expect(r.passed).toBe(false);
    expect(r.results[0]!.message).toMatch(/^needs y \(this check took too long on this file and was stopped/);
    expect(runChecks([{ ...slow, pattern: '^x+$' }], { 'a.txt': 'x'.repeat(3000) }).passed).toBe(true);
  });
});

describe('hasNestedQuantifier', () => {
  it.each(['(a+)+', '(\\w*,)*', '((ab)*c)+', '(?:x+y?)+$', '(a{2,})*', '([a-z]+\\s?)+', '^(a+){3}$', '(a*){2,5}', '^(a|a)+$', '(a|b)*', '^.*.*.*=$', '\\s*\\s+', '[a-z]+[0-9]*'])('flags %s', (p) => expect(hasNestedQuantifier(p)).toBe(true));
  it.each(['^hello\\s', '(ab)+', '(a+)?', '(a+){1}', '(a|b)', '[(a+)]+', '\\(a\\)+', '"port"\\s*:\\s*8080', 'a+b?c*', '^.*x.*y$', '(?<name>a+)b'])('allows %s', (p) => expect(hasNestedQuantifier(p)).toBe(false));
});
