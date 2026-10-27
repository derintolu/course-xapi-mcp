// SPDX-License-Identifier: Apache-2.0
// The pages the bridge shows in the learner's browser. Every interpolated value is HTML-escaped.

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STYLE = `
  :root { color-scheme: light dark; --fg: #1d1d1f; --muted: #555; --bg: #fff; --box: #f3f3f5; --line: #d0d0d6; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ececf0; --muted: #a8a8b0; --bg: #16161a; --box: #24242a; --line: #3a3a44; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 36rem; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 1.5rem; margin: 0 0 4px; }
  h2 { font-size: 1.05rem; margin: 28px 0 8px; }
  p, li { color: var(--fg); }
  .muted { color: var(--muted); }
  input { width: 100%; font: 15px/1.4 ui-monospace, monospace; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--box); color: var(--fg); }
  ol { padding-left: 1.25rem; }
  li { margin: 6px 0; }
  code { font: 14px ui-monospace, monospace; background: var(--box); padding: 1px 5px; border-radius: 4px; overflow-wrap: anywhere; }
  .code { font: 600 2rem/1.2 ui-monospace, monospace; letter-spacing: 0.2em; background: var(--box); border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px; display: inline-block; }
`;

/** Content-Security-Policy for bridge pages: no scripts, no external loads, no framing. */
export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'";

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escape(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

/** The page after a good launch: continue in the agent, the MCP URL, how to add it, and the pairing code. */
export function launchPage(o: { courseTitle: string; lessonTitle: string; mcpUrl: string; pairingCode: string }): string {
  const url = escape(o.mcpUrl);
  return layout(
    'Continue in your agent',
    `<h1>Continue in your agent</h1>
<p class="muted">${escape(o.lessonTitle)} &middot; ${escape(o.courseTitle)}</p>
<p>This lesson runs in your AI agent. Your progress is recorded by your learning platform.</p>

<h2>The course address</h2>
<input readonly value="${url}" aria-label="Course MCP URL">

<h2>How to add it</h2>
<ol>
<li><strong>Claude:</strong> Settings, Connectors, Add custom connector. Paste the address.</li>
<li><strong>ChatGPT:</strong> Settings, Apps &amp; Connectors, Create (developer mode). Paste the address.</li>
<li><strong>Cursor:</strong> Settings, MCP, Add new MCP server. Use the address as the server URL.</li>
<li><strong>Claude Code:</strong> run <code>claude mcp add --transport http course ${url}</code></li>
</ol>
<p>Then ask your agent to start the lesson. It will open a sign-in page in your browser.</p>

<h2>Pairing code</h2>
<p>If the sign-in page asks for a code, use this one. It works once and expires in 10 minutes.</p>
<p class="code">${escape(o.pairingCode)}</p>
<p><strong>Type this code only on the sign-in page, never in the chat.</strong></p>`,
  );
}

/** A launch that could not start. `detail` is shown as-is (escaped). */
export function errorPage(o: { heading: string; message: string; detail?: string }): string {
  return layout(
    o.heading,
    `<h1>${escape(o.heading)}</h1>
<p>${escape(o.message)}</p>
${o.detail ? `<p class="muted">${escape(o.detail)}</p>` : ''}`,
  );
}
