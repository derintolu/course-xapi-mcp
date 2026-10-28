// SPDX-License-Identifier: Apache-2.0
// What each tool does, and the per-call pipeline every write follows:
// lock the learner, load, redeliver the outbox, expire an idle session, run the engine step, hand awards to the
// badge service, save with the new statements as the outbox, deliver them, then clear the outbox.
import {
  PRACTICE_HOMEPAGE,
  PRACTICE_LABEL,
  StoreConflictError,
  URIS,
  type BadgeService,
  type CourseModel,
  type Custody,
  type CustodyOption,
  type LaunchContext,
  type LearnerRef,
  type LearnerState,
  type ToolName,
  type XapiAgent,
  type XapiStatement,
} from '@course-xapi-mcp/core';
import { isPracticeHandle, newPracticeHandle, parsePracticeRecord } from '@course-xapi-mcp/core/practice';
import {
  checkCode,
  chooseBranch,
  choosePlacement,
  endSession,
  expireSession,
  getLesson,
  listPaths,
  nextBeat,
  restartCourse,
  revealBug,
  startPlacement,
  status,
  submitCheckpoint,
  type Env,
  type LaunchBinding,
  type Step,
  type StepData,
} from '@course-xapi-mcp/core/session';
import { awardsFor } from '@course-xapi-mcp/badges';
import type { IssuedCredential } from './app.ts';
import type { PracticeCustody } from './custody/practice.ts';
import { withLearnerLock } from './custody/mutex.ts';
import { BUSY, HOLDER_DOWN, StoreFailure, TREAT_AS_DATA, cxmBlock, guarded, makeResults, type Content, type ToolResult } from './results.ts';
import type { EndpointKind } from './tool-schemas.ts';

export interface ToolDeps {
  course: CourseModel;
  kind: EndpointKind;
  /** The custody this endpoint writes to: the course's custody, or the practice custody. */
  custody: Custody;
  /** Set on a practice endpoint (the same object as `custody`). */
  practice?: PracticeCustody;
  badges?: BadgeService;
  /** Official endpoint: false when the learner's account was erased; checked inside the learner's lock before a write. */
  hasLearner?: (subject: string) => Promise<boolean>;
  /** The practice endpoint's URL, on an official endpoint of a course that allows practice. */
  practiceUrl?: string;
  now: () => string;
  uuid: () => string;
}

/** Who is calling: the authenticated learner (official), or nobody yet (practice: the handle argument decides). */
export interface Caller {
  learner?: LearnerRef;
  platform?: string;
}

type Args = Record<string, unknown>;

const NO_STATE = 'this learner has no placement in this course yet; call start_placement, then choose_placement';
const NOT_HANDLE = 'that is not a practice handle; call start_placement to begin a practice run, or resume_practice to continue a practice copy';
const NO_COPY = 'there is no practice run for this handle (practice runs are kept for 30 days); call start_placement to begin a new one, or resume_practice with your exported copy';
const NO_PRACTICE_BADGES = 'practice runs cannot earn badges; this run is not an official record';
const ERASED =
  "this learner's account was deleted with their record, so nothing was written; ask the learner to sign in again through you (as a new learner) to start over";

/**
 * A statement as the agent may see it: without `authority` and `stored`, which the record holder adds when it stores
 * it. Many LRSs put the credential's key or client in `authority` (CXM-SEC-004); custody keeps both, for badges.
 */
const agentView = ({ authority: _authority, stored: _stored, ...s }: XapiStatement & { authority?: unknown; stored?: unknown }): XapiStatement => s;
const agentRecord = <T extends { statements: XapiStatement[] }>(r: T): T => ({ ...r, statements: r.statements.map(agentView) });

/** Resolved per call: the learner, the cmi5 launch the call is bound to (option 1) and the engine's Env. */
interface Bound {
  learner: LearnerRef;
  launch?: LaunchBinding;
  /** True when the practice handle was minted by this call. */
  minted?: boolean;
}

function bindingOf(c: LaunchContext): LaunchBinding {
  return {
    auKey: c.auKey,
    activityId: c.activityId,
    registration: c.registration,
    sessionId: c.sessionId,
    contextTemplate: c.contextTemplate,
    launchMode: c.launchMode,
    ...(c.returnURL !== undefined ? { returnURL: c.returnURL } : {}),
    // A terminated or superseded launch must not write: the engine then answers return-to-lms.
    ended: c.terminatedAt !== undefined || c.supersededAt !== undefined,
  };
}

/** Option 2: the actor the author-LRS custody keeps the record under (its `actorFor`), so statements match it. */
const actorForOf = (c: Custody) => (c as Custody & { actorFor?: (subject: string) => Promise<XapiAgent> }).actorFor;
/** Option 1: the badge issuer record, which `get_record` appends (design §11 BC-32). */
const issuerRecordsOf = (b: BadgeService | undefined) =>
  (b as (BadgeService & { records?: (l: LearnerRef) => Promise<{ statements: XapiStatement[]; credentials: IssuedCredential[] }> }) | undefined)?.records;
/** The badge service's hook for statements the record holder accepted: it confirms the awards they earned (R52). */
const onDeliveredOf = (b: BadgeService | undefined) => (b as (BadgeService & { onDelivered?: (l: LearnerRef, statementIds: string[]) => Promise<void> }) | undefined)?.onDelivered;
const launchForOf = (c: Custody) => (c as Custody & { launchFor?: (l: LearnerRef, auKey?: string) => Promise<LaunchContext | { error: string }> }).launchFor;

export function createTools(d: ToolDeps) {
  const { course, custody } = d;
  const official = d.kind === 'official';
  const option: CustodyOption = official ? custody.option : 'practice';
  const results = makeResults(course);
  const cxm = (state?: LearnerState) => cxmBlock(option, official, state);
  const ok = (data: Record<string, unknown>, state?: LearnerState, extra?: Content[]) => results.ok(data, cxm(state), extra);
  const err = (error: string, state?: LearnerState) => results.err(error, cxm(state));
  /** Learners with a write in flight on this endpoint: a second write at the same time is refused, not queued. */
  const busy = new Set<string>();

  function envOf(b: Bound, caller: Caller): Env {
    return {
      now: d.now,
      uuid: d.uuid,
      actor: b.learner.actor,
      custody: option,
      practice: !official,
      ...(caller.platform ? { platform: caller.platform } : {}),
      ...(b.launch ? { launch: b.launch } : {}),
    };
  }

  /** The learner this call acts for, or the error to answer with. `mint` lets start_placement begin a practice run. */
  async function bind(caller: Caller, args: Args, o: { mint?: boolean } = {}): Promise<Bound | { error: string }> {
    if (official) {
      let learner = caller.learner!;
      const actorFor = actorForOf(custody);
      if (actorFor) learner = { ...learner, actor: await guarded(() => actorFor(learner.subject)) };
      const launchFor = launchForOf(custody);
      if (custody.option !== 'lms-launched' || !launchFor) return { learner };
      const c = await guarded(() => launchFor(learner));
      if ('error' in c) return { error: c.error };
      return { learner: { ...learner, launchId: c.launchId, actor: c.actor }, launch: bindingOf(c) };
    }
    const handle = args.handle;
    if (handle === undefined && o.mint) {
      const h = newPracticeHandle();
      const actor: XapiAgent = { objectType: 'Agent', account: { homePage: PRACTICE_HOMEPAGE, name: d.uuid() } };
      return { learner: { kind: 'practice', subject: 'practice:' + h, actor, handle: h }, minted: true };
    }
    if (!isPracticeHandle(handle)) return { error: NOT_HANDLE };
    const copy = await guarded(() => d.practice!.exportCopy(handle));
    if (!copy) return { error: NO_COPY };
    return { learner: { kind: 'practice', subject: 'practice:' + handle, actor: copy.actor as XapiAgent, handle } };
  }

  /**
   * Tells the badge service the record holder accepted these statements (inside the learner's lock). A failure here
   * only delays confirmation to the next read of the record, so it never fails the call.
   */
  async function accepted(l: LearnerRef, statements: XapiStatement[]): Promise<void> {
    const hook = official ? onDeliveredOf(d.badges) : undefined;
    if (!hook || statements.length === 0) return;
    try {
      await hook(l, statements.map((s) => s.id));
    } catch {
      // Confirmed on the next read of the record instead.
    }
  }

  /** Saves `state` with `statements` as its outbox, delivers them, then clears the outbox. */
  async function commit(l: LearnerRef, state: LearnerState, statements: XapiStatement[], etag: string | undefined): Promise<'delivered' | 'pending' | undefined> {
    const saved = await guarded(() => custody.save(l, { ...state, outbox: statements }, etag));
    if (statements.length === 0) return undefined;
    try {
      await custody.deliver(l, statements);
    } catch {
      return 'pending';
    }
    await accepted(l, statements);
    await clearOutbox(l, state, saved.etag);
    return 'delivered';
  }

  /**
   * Saves `state` with an empty outbox once its statements were delivered. A custody whose deliver rewrites the
   * learner's copy (practice) changes its version, so on a conflict the version is read again and the save retried
   * when the stored state is still the one this call saved. Any other failure leaves the outbox to be sent again on
   * the next call; the record holder keeps one copy per statement id.
   */
  async function clearOutbox(l: LearnerRef, state: LearnerState, etag: string): Promise<void> {
    try {
      await custody.save(l, { ...state, outbox: [] }, etag);
    } catch (e) {
      if (!(e instanceof StoreConflictError)) return;
      try {
        const cur = await custody.load(l);
        if (cur.state?.registration === state.registration && cur.state.updatedAt === state.updatedAt) await custody.save(l, { ...state, outbox: [] }, cur.etag);
      } catch {
        // Sent again on the next call.
      }
    }
  }

  /** One write: the whole pipeline, under the learner's lock. `fresh`: the step may start a learner with no state. */
  async function write(caller: Caller, args: Args, step: (state: LearnerState | undefined, env: Env) => Step<object>, o: { fresh?: boolean } = {}): Promise<ToolResult> {
    // The learner's key is known before binding; a practice handle minted by this call needs no lock.
    const key = official ? caller.learner!.subject : isPracticeHandle(args.handle) ? 'practice:' + args.handle : undefined;
    if (key !== undefined) {
      if (busy.has(key)) return err(BUSY);
      busy.add(key);
    }
    // Bound inside the lock, so the launch read here is the one the bridge's sweeper leaves alone until this call ends.
    const pipeline = async (): Promise<ToolResult> => {
      const b = await bind(caller, args, { mint: o.fresh && !official });
      if ('error' in b) return err(b.error);
      const l = b.learner;
      // Signed in before an erase that ran while this call waited for the lock: writing now would recreate a record
      // nobody can reach or delete (R68).
      if (official && d.hasLearner && !(await d.hasLearner(l.subject))) return err(ERASED);
      const env = envOf(b, caller);
      const loaded = await guarded(() => custody.load(l));
      let { state, etag } = loaded;
      let redelivered = false;
      if (state && state.outbox.length > 0) {
        try {
          await custody.deliver(l, state.outbox);
        } catch {
          return err(HOLDER_DOWN, state);
        }
        await accepted(l, state.outbox);
        // Delivering may have changed the stored copy's version (practice keeps statements beside the state). Take the
        // new version only when the stored state is still the one loaded; otherwise another process advanced meanwhile.
        const again = await guarded(() => custody.load(l));
        if (again.state?.registration !== state.registration || again.state.updatedAt !== state.updatedAt) return err(BUSY, again.state);
        etag = again.etag;
        state = { ...state, outbox: [] };
        redelivered = true;
      }
      if (!state && !o.fresh) return err(NO_STATE);
      const expired = state ? expireSession(course, state, env) : undefined;
      const base = expired?.ok ? expired.state : state;
      const before = expired?.ok ? expired.statements : [];
      const r = step(base, env);
      if (!r.ok) {
        // Keep what this call already did: the redelivery, and the idle session it closed.
        if (base && (redelivered || before.length > 0)) await commit(l, base, before, etag);
        return err(r.error, base);
      }
      let next = r.state;
      const events = [...(expired?.ok ? expired.events : []), ...r.events];
      // Practice never earns badges, and a practice copy's awards are never acted on.
      if (official && d.badges) {
        const awards = awardsFor(course, next, events);
        if (awards.length > 0) {
          next = { ...next, awards: [...next.awards, ...awards.map((a) => ({ badgeId: a.badgeId, statementId: a.earningStatementId }))] };
          const badges = d.badges;
          await guarded(() => badges.onAwards(l, awards));
        }
      }
      const delivery = await commit(l, next, [...before, ...r.statements], etag);
      const data: Record<string, unknown> = { ...(r.data as StepData) };
      if (b.minted) {
        data.handle = l.handle;
        data.handle_note = 'This is the practice handle. Give it to the learner once and tell them to keep it private; pass it to every tool in this run.';
      }
      if (r.next) data.next = r.next;
      if (r.next?.type === 'return-to-lms' && r.next.returnURL) data.returnURL = r.next.returnURL;
      if (delivery) data.delivery = delivery;
      if (delivery === 'pending') data.delivery_note = 'The record holder has not confirmed this step yet. It is kept and sent again on the next call; do not tell the learner it is recorded until then.';
      return ok(data, next);
    };
    try {
      return key === undefined ? await pipeline() : await withLearnerLock(key, pipeline);
    } finally {
      if (key !== undefined) busy.delete(key);
    }
  }

  /** Loads the learner's state for a read: no lock, no write. */
  async function read(caller: Caller, args: Args): Promise<{ b?: Bound; state?: LearnerState } | { error: string }> {
    if (!official && args.handle === undefined) return {};
    const b = await bind(caller, args);
    if ('error' in b) return b;
    return { b, state: (await guarded(() => custody.load(b.learner))).state };
  }

  const practiceOnly = (tool: string) =>
    err(d.practiceUrl ? `${tool} works only on the practice endpoint, ${d.practiceUrl}` : `${tool} works only on the practice endpoint, and this course has no practice runs`);

  const placeholder: LearnerRef = { kind: 'practice', subject: '', actor: { objectType: 'Agent', account: { homePage: PRACTICE_HOMEPAGE, name: '-' } } };

  const tools: Record<ToolName, (args: Args, caller: Caller) => Promise<ToolResult>> = {
    async get_status(args, caller) {
      const r = await read(caller, args);
      if ('error' in r) return err(r.error);
      const learner = r.b?.learner ?? placeholder;
      const { holder, ...links } = custody.links(learner);
      const s = status(course, r.state, r.b ? envOf(r.b, caller) : ({ custody: option } as Env));
      const launch = r.b?.launch;
      const said = official
        ? `Tell the learner their official record is kept by ${holder}${links.view ? `, where they can view and export it (${links.view})` : ''}, and that nobody in this conversation can change it.`
        : `Tell the learner this is a practice run: ${PRACTICE_LABEL}`;
      return ok(
        {
          course: { id: course.id, title: course.title },
          custody: option,
          official,
          ...(official ? {} : { label: PRACTICE_LABEL }),
          holder,
          links,
          // The record holder's deletion link is required in options 1 to 3. When the holder has none to give, say so.
          ...(official ? { deleteLink: links.delete ?? null } : {}),
          ...(official && !links.delete ? { deleteNote: `No deletion link is available. Tell the learner to ask ${holder} to delete their record.` } : {}),
          position: s.position,
          next_tools: launch?.ended ? [] : s.next,
          ...(launch ? { launch: { lessonKey: launch.auKey, ended: Boolean(launch.ended) } } : {}),
          ...(d.practiceUrl ? { practiceUrl: d.practiceUrl } : {}),
          instruction: launch?.ended
            ? `${said} This LMS launch has ended: send the learner back to their LMS to launch the lesson again.`
            : `${said} Then call ${s.next[0] ?? 'get_record'}.`,
        },
        r.state,
      );
    },

    async list_paths() {
      return ok(listPaths(course));
    },

    start_placement: (args, caller) => write(caller, args, (s, env) => startPlacement(course, s, env), { fresh: true }),
    choose_placement: (args, caller) =>
      write(caller, args, (s, env) => choosePlacement(course, s!, { pathKey: args.pathKey, startLessonKey: args.startLessonKey, skip: args.skip, reason: args.reason }, env)),

    async get_lesson(args) {
      const r = getLesson(course, args.lessonKey as string);
      return r.ok ? ok(r.data) : err(r.error);
    },

    next_beat: (args, caller) => write(caller, args, (s, env) => nextBeat(course, s!, { learner_reply: args.learner_reply }, env)),
    check_code: (args, caller) => write(caller, args, (s, env) => checkCode(course, s!, { file: args.file, content: args.content }, env)),
    reveal_bug: (args, caller) => write(caller, args, (s, env) => revealBug(course, s!, env)),
    submit_checkpoint: (args, caller) => write(caller, args, (s, env) => submitCheckpoint(course, s!, { response: args.response, files: args.files }, env)),
    choose_branch: (args, caller) => write(caller, args, (s, env) => chooseBranch(course, s!, { branch: args.branch, rationale: args.rationale }, env)),
    end_session: (args, caller) => write(caller, args, (s, env) => endSession(course, s!, env)),

    async get_record(args, caller) {
      const b = await bind(caller, args);
      if ('error' in b) return err(b.error);
      const [held, state] = await Promise.all([guarded(() => custody.record(b.learner)), guarded(() => custody.load(b.learner))]);
      const record = agentRecord(held);
      const { holder, ...links } = custody.links(b.learner);
      const data = { record, holder, links, note: `${TREAT_AS_DATA} ${record.note}` };
      if (official) {
        const records = custody.option === 'lms-launched' ? issuerRecordsOf(d.badges) : undefined;
        if (!records) return ok(data, state.state);
        const issued = agentRecord(await guarded(() => records(b.learner)));
        const issuerRecord = { holder: 'this course server, as badge issuer', ...issued, note: 'The badges this course server issued: the earned statements and the credential ids. A credential marked revoked is no longer valid; never present it as a current badge. It is authoritative for these badges.' };
        return ok({ ...data, issuerRecord }, state.state);
      }
      const copy = await guarded(() => d.practice!.exportCopy(b.learner.handle!));
      const exported: Content = { type: 'resource', resource: { uri: URIS.recordExport, mimeType: 'application/json', text: JSON.stringify(copy, null, 2) } };
      return ok({ ...data, instruction: 'Offer the attached practice copy as a file named practice-record.json. resume_practice continues it later.' }, state.state, [exported]);
    },

    async get_badges(args, caller) {
      if (!official) return err(NO_PRACTICE_BADGES);
      // The claim page, never a link that itself grants a badge.
      const claimPage = d.badges?.claimPage ?? course.badgeIssuer?.claimPage ?? null;
      if (!d.badges) return ok({ badges: [], claimPage });
      const badges = d.badges;
      const b = await bind(caller, args);
      if ('error' in b) return err(b.error);
      return ok({ badges: await guarded(() => badges.summaries(b.learner)), claimPage });
    },

    restart_course: (args, caller) => write(caller, args, (s, env) => restartCourse(course, s!, env)),

    async resume_practice(args) {
      if (official) return practiceOnly('resume_practice');
      let raw: unknown;
      try {
        raw = JSON.parse(args.record as string);
      } catch {
        return err('record is not valid JSON; pass the exported practice copy as JSON text');
      }
      const p = parsePracticeRecord(raw, course.id);
      if (!p.ok) return err(p.error);
      const handle = newPracticeHandle();
      await guarded(() => d.practice!.importCopy(handle, p.record));
      const state = p.record.state;
      return ok(
        {
          handle,
          statements: p.record.statements.length,
          placed: Boolean(state.cursor),
          instruction: `${state.cursor ? 'Call next_beat to continue.' : 'Call start_placement to continue placement.'} This is a new practice handle: give it to the learner and tell them to keep it private.`,
        },
        state,
      );
    },

    async delete_practice_record(args) {
      if (official) return practiceOnly('delete_practice_record');
      const handle = args.handle;
      if (!isPracticeHandle(handle)) return err(NOT_HANDLE);
      const deleted = await withLearnerLock('practice:' + handle, () => guarded(() => d.practice!.deletePractice(handle)));
      return ok({ deleted });
    },
  };

  return {
    /** An error result for a failure outside the tools (the SDK's argument validation, an unexpected exception). */
    errorResult: (message: string) => err(message),

    /** Runs a tool; a store failure becomes a tool error with its public message, and nothing else is changed. */
    async run(name: ToolName, args: Args, caller: Caller): Promise<ToolResult> {
      try {
        return await tools[name](args, caller);
      } catch (e) {
        if (e instanceof StoreFailure) return err(e.message);
        throw e;
      }
    },

    /** The `course-xapi-mcp://record/export` resource: the official record, or how to get a practice copy. */
    async exportText(caller: Caller): Promise<string> {
      if (!official) return JSON.stringify({ note: 'A practice copy is tied to its practice handle: call get_record with the handle to export it.' });
      try {
        const b = await bind(caller, {});
        if ('error' in b) return JSON.stringify({ error: b.error });
        const { holder, ...links } = custody.links(b.learner);
        return JSON.stringify({ note: TREAT_AS_DATA, holder, links, record: agentRecord(await guarded(() => custody.record(b.learner))) }, null, 2);
      } catch (e) {
        if (e instanceof StoreFailure) return JSON.stringify({ error: e.message });
        throw e;
      }
    },
  };
}
