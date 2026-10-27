// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CXM_ACTIVITY_TYPES, CXM_EXT, CXM_VERBS, PRACTICE_CATEGORY, PROFILE_ID, PROFILE_VERSION_IRI, SITE } from '../src/constants.ts';
import {
  TEMPLATES,
  buildAllowed,
  buildDefined,
  buildEarned,
  buildProfile,
  checkProfile,
  validateStatement,
  type XapiStatement,
} from '../src/xapi/index.ts';
import { AU, AU_REF, COURSE, clock, ctx } from './xapi-fixtures.ts';

const profile = buildProfile() as any;
const EXTERNAL = ['http://adlnet.gov/expapi/verbs/', 'https://w3id.org/xapi/adl/verbs/', 'https://w3id.org/xapi/cmi5/', 'http://specification.openbadges.org/xapi/'];

describe('xAPI profile', () => {
  it('matches profile/xapi-profile.jsonld (run npm run profile after changes)', () => {
    const file = JSON.parse(readFileSync(new URL('../../../../profile/xapi-profile.jsonld', import.meta.url), 'utf8'));
    expect(file).toEqual(JSON.parse(JSON.stringify(profile)));
  });

  it('has the required top-level properties of xAPI Profiles 1.0', () => {
    for (const k of ['@context', 'id', 'type', 'conformsTo', 'prefLabel', 'definition', 'author', 'versions']) expect(profile).toHaveProperty(k);
    expect(profile['@context']).toBe('https://w3id.org/xapi/profiles/context');
    expect(profile.conformsTo).toBe('https://w3id.org/xapi/profiles#1.0');
    expect(profile.id).toBe(PROFILE_ID);
    expect(profile.versions[0].id).toBe(PROFILE_VERSION_IRI);
  });

  it('gives every concept and template the required properties, in this version', () => {
    for (const c of [...profile.concepts, ...profile.templates]) {
      const required = c.type === 'Activity' ? ['id', 'type', 'inScheme', 'activityDefinition'] : ['id', 'type', 'inScheme', 'prefLabel', 'definition'];
      for (const k of required) expect(c, c.id).toHaveProperty(k);
      expect(c.inScheme).toBe(PROFILE_VERSION_IRI);
    }
    const ids = [...profile.concepts, ...profile.templates, ...profile.patterns].map((x: any) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('defines every cxm verb, activity type and extension, and the practice category', () => {
    const ids = new Set(profile.concepts.map((c: any) => c.id));
    for (const iri of [...Object.values(CXM_VERBS), ...Object.values(CXM_ACTIVITY_TYPES), ...Object.values(CXM_EXT), PRACTICE_CATEGORY]) expect(ids.has(iri), iri).toBe(true);
  });

  it('has every concept IRI under the site, and refers only to site, ADL, cmi5 or Open Badges IRIs', () => {
    for (const c of profile.concepts) expect(c.id.startsWith(SITE + '/'), c.id).toBe(true);
    for (const t of profile.templates) {
      for (const iri of [t.verb, t.objectActivityType].filter(Boolean)) {
        expect(iri.startsWith(SITE + '/') || EXTERNAL.some((p) => iri.startsWith(p)), iri).toBe(true);
      }
    }
  });

  it('has one template per TEMPLATES entry', () => {
    expect(profile.templates).toHaveLength(TEMPLATES.length);
    const ids = profile.templates.map((t: any) => t.id);
    for (const id of ids) expect(id.startsWith(PROFILE_VERSION_IRI + '/templates/'), id).toBe(true);
  });

  it('builds patterns that use exactly one operator and only known ids', () => {
    const known = new Set([...profile.templates, ...profile.patterns].map((x: any) => x.id));
    for (const p of profile.patterns) {
      const ops = ['alternates', 'optional', 'oneOrMore', 'sequence', 'zeroOrMore'].filter((k) => k in p);
      expect(ops, p.id).toHaveLength(1);
      for (const ref of [p[ops[0]!]].flat()) expect(known.has(ref), `${p.id} -> ${ref}`).toBe(true);
      if (p.primary) expect(p).toHaveProperty('prefLabel');
    }
  });

  it('every TEMPLATES entry has a builder output that passes validateStatement and checkProfile', () => {
    const next = clock();
    const c = ctx();
    const parent = AU_REF;
    const sample = (t: (typeof TEMPLATES)[number]): XapiStatement => {
      if (t.kind === 'badge') return buildEarned(c, { id: 'https://example.org/badges/1', name: 'B' }, 'urn:uuid:11111111-1111-4111-8111-111111111111', next().id, next());
      if (t.kind === 'defined') {
        const target = t.object === 'block' ? { blockId: COURSE + '/paths/json' } : t.object === 'course' ? { courseId: COURSE } : { au: AU_REF };
        return buildDefined(c, t.verb as any, target, { ...next(), duration: 'PT1S', reason: t.verb === 'waived' ? 'Tested Out' : undefined });
      }
      const result: Record<string, any> = {
        answered: { response: 'r' },
        passed: { success: true },
        failed: { success: false },
        caught: { success: true, extensions: { [CXM_EXT.checks]: [] } },
        placed: { extensions: { [CXM_EXT['start-lesson']]: AU + '/au' } },
        branched: { extensions: { [CXM_EXT.branch]: 'b', [CXM_EXT.to]: null, [CXM_EXT.rationale]: 'r' } },
      };
      return buildAllowed(c, t.verb as any, { id: AU + '/x/' + t.object, kind: t.object, name: t.object }, parent, { ...next(), result: result[t.verb] });
    };
    for (const t of TEMPLATES) {
      const s = sample(t);
      expect(validateStatement(s), `${t.kind} ${t.verb} ${t.object}`).toEqual([]);
      expect(checkProfile(s), `${t.kind} ${t.verb} ${t.object}`).toEqual([]);
    }
  });
});
