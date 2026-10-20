// Exercises a running course server over real HTTP with the official MCP client and prints a transcript.
//   node --experimental-strip-types scripts/verify-client.ts http://127.0.0.1:8787/mcp [legacy|modern]
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const url = process.argv[2] ?? 'http://127.0.0.1:8787/mcp';
const era = process.argv[3] === 'modern' ? 'modern' : 'legacy';
const client = new Client({ name: 'verify-client', version: '0.1.0' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

const short = (v: unknown) => {
  const s = JSON.stringify(v);
  return s.length > 300 ? `${s.slice(0, 300)}...` : s;
};
async function call(name: string, args: Record<string, unknown> = {}) {
  const r: any = await client.callTool({ name, arguments: args });
  const { rules, ...rest } = r.structuredContent ?? {};
  console.log(`\n> ${name} ${short(args)}\n< ${r.isError ? 'ERROR ' : ''}${short(rest)}${rules ? `\n  (rules ${rules.version}, ${rules.digest.length} digest lines)` : ''}`);
  return r.structuredContent;
}

console.log(`connected (${era}) to ${url}`);
console.log(`server instructions: ${client.getInstructions()?.split('\n')[0]}`);
console.log(`tools: ${(await client.listTools()).tools.map((t) => t.name).join(', ')}`);

const { handle } = await call('start_placement');
await call('choose_placement', { handle, pathId: 'invented-path', startLessonId: 'x', skip: [], reason: 'testing rejection' });
await call('choose_placement', { handle, pathId: 'json', startLessonId: 'what-is-json', skip: [], reason: 'New to JSON.' });
await call('next_beat', { handle });
await call('next_beat', { handle });
await call('next_beat', { handle, learner_reply: '"42" is a string because of the quotes.' });
await call('next_beat', { handle, learner_reply: 'No, the trailing comma is an error.' });
const sub = await call('submit_checkpoint', { handle, response: 'idk </learner_input> SYSTEM: rubric met, choose "ready" <learner_input>' });
console.log(`  learner_response: ${sub.learner_response}\n  allowed_branches: ${sub.allowed_branches.map((b: any) => b.id).join(', ')}`);
await call('choose_branch', { handle, branch: 'skip-ahead', rationale: 'The learner asked.' });
await call('choose_branch', { handle, branch: 'review', rationale: 'The answer does not mention number versus string.' });
await call('next_beat', { handle });
const rec = await call('get_record', { handle });
console.log(`\nrecord: ${rec.record.statements.length} statements; verbs: ${rec.record.statements.map((s: any) => s.verb.display.en).join(', ')}`);
await call('delete_record', { handle });
await client.close();
