// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { REGEX_BUDGET_MS, REGEX_TIME_LIMIT_MS, hasNestedQuantifier, runChecks, type Check } from '../src/index.ts';

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
  ])('refuses %s on learner text without running it, and says why', (pattern, text) => {
    const start = Date.now();
    const r = runChecks([{ type: 'regex', file: 'a.txt', pattern, message: 'm' }], { 'a.txt': text });
    expect(Date.now() - start).toBeLessThan(50);
    expect(r.passed).toBe(false);
    expect(r.results[0]!.message).toMatch(/^m \(this check's pattern can take too long on any learner text/);
  });

  it.each([
    ['^(a|a)+$', 'a'.repeat(26) + '!'],
    ['^.*.*.*=$', 'x'.repeat(4000)],
    ['^.*x.*x.*x.*x.*y$', 'x'.repeat(3000)],
  ])('stops %s at the time limit; the check fails and says why', (pattern, text) => {
    const start = Date.now();
    const r = runChecks([{ type: 'regex', file: 'a.txt', pattern, message: 'needs it' }], { 'a.txt': text });
    expect(Date.now() - start).toBeLessThan(REGEX_TIME_LIMIT_MS + 400);
    expect(r.passed).toBe(false);
    expect(r.results[0]!.message).toMatch(/^needs it \(this check took too long on this file and was stopped/);
  });

  it.each([
    ['"port"\\s*:\\s*\\d+', '{"port": 8080}'],
    ['\\w+\\s*=', 'timeout = 30'],
    ['(foo|bar)+', 'foobar'],
    ['^x+$', 'x'.repeat(3000)],
  ])('runs the common pattern %s and passes on matching text', (pattern, text) => {
    expect(runChecks([{ type: 'regex', file: 'a.txt', pattern, message: 'm' }], { 'a.txt': text }).results[0]).toMatchObject({ passed: true, message: 'm' });
  });

  it('gives all the regex checks of one call a total time budget', () => {
    const slow: Check = { type: 'regex', file: 'a.txt', pattern: '^.*x.*x.*x.*x.*y$', message: 'm' };
    const start = Date.now();
    const r = runChecks(Array.from({ length: 15 }, () => slow), { 'a.txt': 'x'.repeat(3000) });
    expect(Date.now() - start).toBeLessThan(REGEX_BUDGET_MS + 500);
    expect(r.results.every((x) => !x.passed)).toBe(true);
    expect(r.results.at(-1)!.message).toMatch(/ran out of time before this one/);
  });
});

describe('hasNestedQuantifier', () => {
  it.each(['(a+)+', '(\\w*,)*', '((ab)*c)+', '(?:x+y?)+$', '(a{2,})*', '([a-z]+\\s?)+', '^(a+){3}$', '(a*){2,5}'])('flags %s', (p) => expect(hasNestedQuantifier(p)).toBe(true));
  it.each(['^hello\\s', '(ab)+', '(a+)?', '(a+){1}', '(a|b)*', '(foo|bar)+', '[(a+)]+', '\\(a+\\)+', '"port"\\s*:\\s*\\d+', '\\w+\\s*=', '.*.*', 'a+b?c*', '(?<name>a+)b'])('allows %s', (p) => expect(hasNestedQuantifier(p)).toBe(false));
});
