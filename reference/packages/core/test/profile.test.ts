import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROFILE_VERSION, buildProfile } from '../src/index.ts';
import { loadCourse } from './fixtures.ts';
import { runHappyPath } from './flow.ts';

const profile = buildProfile() as any;

describe('xAPI profile', () => {
  it('matches profile/xapi-profile.jsonld (run scripts/build-profile.ts after changes)', () => {
    const file = JSON.parse(readFileSync(new URL('../../../../profile/xapi-profile.jsonld', import.meta.url), 'utf8'));
    expect(file).toEqual(JSON.parse(JSON.stringify(profile)));
  });

  it('has the required top-level properties of xAPI Profiles 1.0', () => {
    for (const k of ['@context', 'id', 'type', 'conformsTo', 'prefLabel', 'definition', 'author', 'versions']) expect(profile).toHaveProperty(k);
    expect(profile['@context']).toBe('https://w3id.org/xapi/profiles/context');
    expect(profile.conformsTo).toBe('https://w3id.org/xapi/profiles#1.0');
    expect(profile.versions[0].id).toBe(PROFILE_VERSION);
  });

  it('gives every concept and template the required properties, in this version', () => {
    for (const c of [...profile.concepts, ...profile.templates]) {
      for (const k of ['id', 'type', 'inScheme', 'prefLabel', 'definition']) expect(c, c.id).toHaveProperty(k);
      expect(c.inScheme).toBe(PROFILE_VERSION);
    }
    const ids = [...profile.concepts, ...profile.templates, ...profile.patterns].map((x: any) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('builds patterns that use exactly one operator and only known ids', () => {
    const known = new Set([...profile.templates, ...profile.patterns].map((x: any) => x.id));
    for (const p of profile.patterns) {
      const ops = ['alternates', 'optional', 'oneOrMore', 'sequence', 'zeroOrMore'].filter((k) => k in p);
      expect(ops, p.id).toHaveLength(1);
      for (const ref of [p[ops[0]]].flat()) expect(known.has(ref), `${p.id} -> ${ref}`).toBe(true);
      if (p.primary) expect(p).toHaveProperty('prefLabel');
    }
  });

  it('has a template for every verb and object type pair the server emits', () => {
    const { record } = runHappyPath(loadCourse());
    const pairs = new Set(profile.templates.map((t: any) => `${t.verb} ${t.objectActivityType}`));
    for (const s of record.statements) expect(pairs.has(`${s.verb.id} ${s.object.definition.type}`), s.verb.id).toBe(true);
  });
});
