// SPDX-License-Identifier: Apache-2.0
// A cmi5 LMS for tests: writes LMS.LaunchData, sends `launched`, serves the fetch URL and can abandon a session.
import { randomUUID } from 'node:crypto';
import { activityIds, ADL_VERBS, CMI5, type XapiAgent, type XapiStatement } from '@course-xapi-mcp/core';
import { checkCmi5Order, isoDuration, type Cmi5Problem } from '@course-xapi-mcp/core/xapi';
import type { TestLrs } from './test-lrs.ts';

export type LaunchMode = 'Normal' | 'Browse' | 'Review';
export type MoveOn = 'Passed' | 'Completed' | 'CompletedAndPassed' | 'CompletedOrPassed' | 'NotApplicable';

export interface LmsSimOptions {
  lrs: TestLrs;
  /** The LRS endpoint the learner is told about; the fetch URL is served beneath it. */
  lrsUrl: string;
  courseId: string;
  aus: { auId: string; url: string; moveOn: MoveOn }[];
  actor?: XapiAgent;
  /** The xAPI version the LMS sends. Default 1.0.3. */
  xapiVersion?: '1.0.3' | '2.0.0';
}

export interface LaunchResult {
  launchUrl: string;
  registration: string;
  sessionId: string;
  activityId: string;
  /** The auth-token the fetch URL returns, on its first POST. */
  token: string;
}

export interface LmsSim {
  launch(auId: string, o?: { launchMode?: LaunchMode; returnURL?: string; registration?: string }): Promise<LaunchResult>;
  /** Sends `abandoned` for the most recent launch, with the time since that launch as its duration. */
  abandonLatest(): Promise<void>;
  /** cmi5 order problems across every statement the LRS holds. */
  problems(): Cmi5Problem[];
}

const DEFAULT_ACTOR: XapiAgent = { objectType: 'Agent', account: { homePage: 'https://lms.example', name: 'learner-1' } };

interface Launched {
  auId: string;
  activityId: string;
  registration: string;
  sessionId: string;
  at: number;
}

export function createLmsSim(o: LmsSimOptions): LmsSim {
  const actor = o.actor ?? DEFAULT_ACTOR;
  const version = o.xapiVersion ?? '1.0.3';
  const base = o.lrsUrl.replace(/\/+$/, '');
  const lmsToken = btoa(`lms:${randomUUID()}`);
  const defaultRegistration = randomUUID();
  const launches: Launched[] = [];
  let lastStamp = 0;

  /** Wall-clock timestamps that never repeat, so the statements this LMS sends are strictly ordered. */
  const stamp = () => {
    lastStamp = Math.max(Date.now(), lastStamp + 1);
    return new Date(lastStamp).toISOString();
  };

  async function call(path: string, init: RequestInit, query?: Record<string, string>): Promise<Response> {
    const url = new URL(`${base}/${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    o.lrs.addToken(lmsToken); // the LRS forgets tokens on reset(); the LMS's own credential must outlive that
    const headers = { authorization: `Basic ${lmsToken}`, 'x-experience-api-version': version, 'content-type': 'application/json' };
    const res = await o.lrs.fetch(new Request(url, { ...init, headers }));
    if (!res.ok) throw new Error(`the test LRS answered ${res.status} to ${init.method} ${path}: ${await res.text()}`);
    return res;
  }

  function lmsStatement(l: Launched, verb: 'launched' | 'abandoned', result?: (nowMs: number) => XapiStatement['result']): XapiStatement {
    const timestamp = stamp();
    const s: XapiStatement = {
      id: randomUUID(),
      actor: structuredClone(actor),
      verb: { id: ADL_VERBS[verb], display: { 'en-US': verb } },
      object: { objectType: 'Activity', id: l.activityId },
      context: {
        registration: l.registration,
        contextActivities: { grouping: [{ objectType: 'Activity', id: l.auId }, { objectType: 'Activity', id: o.courseId }], category: [{ objectType: 'Activity', id: CMI5.categoryCmi5 }] },
        extensions: { [CMI5.extSessionId]: l.sessionId },
      },
      timestamp,
    };
    if (result) s.result = result(Date.parse(timestamp));
    return s;
  }

  return {
    async launch(auId, opts = {}) {
      const au = o.aus.find((a) => a.auId === auId);
      if (!au) throw new Error(`no AU "${auId}" in this course`);
      const l: Launched = {
        auId,
        activityId: activityIds.au(auId),
        registration: opts.registration ?? defaultRegistration,
        sessionId: randomUUID(),
        at: 0,
      };
      const token = btoa(`${randomUUID()}:${randomUUID()}`);
      const fetchId = randomUUID();
      o.lrs.registerFetch(fetchId, token);

      const launchData: Record<string, unknown> = {
        contextTemplate: {
          contextActivities: { grouping: [{ objectType: 'Activity', id: l.auId }, { objectType: 'Activity', id: o.courseId }] },
          extensions: { [CMI5.extSessionId]: l.sessionId },
        },
        launchMode: opts.launchMode ?? 'Normal',
        moveOn: au.moveOn,
      };
      if (opts.returnURL) launchData.returnURL = opts.returnURL;
      await call('activities/state', { method: 'PUT', body: JSON.stringify(launchData) }, {
        activityId: l.activityId,
        agent: JSON.stringify(actor),
        registration: l.registration,
        stateId: 'LMS.LaunchData',
      });
      const stored = lmsStatement(l, 'launched');
      await call('statements', { method: 'POST', body: JSON.stringify(stored) });
      l.at = Date.parse(stored.timestamp);
      launches.push(l);

      const launch = new URL(au.url);
      launch.searchParams.set('endpoint', o.lrsUrl);
      launch.searchParams.set('fetch', `${base}/cmi5/fetch/${fetchId}`);
      launch.searchParams.set('actor', JSON.stringify(actor));
      launch.searchParams.set('registration', l.registration);
      launch.searchParams.set('activityId', l.activityId);
      return { launchUrl: launch.toString(), registration: l.registration, sessionId: l.sessionId, activityId: l.activityId, token };
    },

    async abandonLatest() {
      const l = launches.at(-1);
      if (!l) throw new Error('no launch to abandon');
      const s = lmsStatement(l, 'abandoned', (now) => ({ duration: isoDuration(Math.max(0, now - l.at)) }));
      await call('statements', { method: 'POST', body: JSON.stringify(s) });
    },

    problems: () => checkCmi5Order(o.lrs.statements()),
  };
}
