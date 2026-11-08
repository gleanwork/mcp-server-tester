// Calls the Vercel function (api/mcp.mjs) in-process against the built bundle:
// the status check, a search, every skill in the repo's skills/ directory, and
// a 2025-era initialize. Run after `npm run build`; exits non-zero on any
// failure. The full MST conformance run is `npm run test:site` at the repo root.
import { readdirSync } from 'node:fs';
import handler from '../api/mcp.mjs';

const origin = 'https://smoke.test';
let failures = 0;

function check(label: string, ok: boolean, detail: string) {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures++;
}

function post(body: Record<string, unknown>) {
  return handler.fetch(
    new Request(`${origin}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
    })
  );
}

const status = await handler.fetch(new Request(`${origin}/mcp`));
const statusBody = (await status.json()) as {
  initialized?: boolean;
  docCount?: number;
};
check(
  'GET returns the status',
  status.ok && statusBody.initialized === true,
  JSON.stringify(statusBody)
);
check(
  'the bundle has documents',
  (statusBody.docCount ?? 0) > 0,
  `docCount ${statusBody.docCount}`
);

const search = await post({
  method: 'tools/call',
  params: { name: 'docs_search', arguments: { query: 'toContainToolText' } },
});
const searchText = await search.text();
check(
  'docs_search finds the assertions guide',
  search.ok && searchText.includes('/docs/assertions'),
  searchText.slice(0, 300)
);

const skillsDir = new URL('../../skills/', import.meta.url);
const skills = readdirSync(skillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
for (const skill of skills) {
  const fetched = await post({
    method: 'tools/call',
    params: {
      name: 'docs_fetch',
      arguments: { url: `skill://${skill}/SKILL.md` },
    },
  });
  const text = await fetched.text();
  check(
    `docs_fetch serves the ${skill} skill`,
    fetched.ok && text.includes(`name: ${skill}`),
    text.slice(0, 300)
  );
}

const init = await post({
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0' },
  },
});
const initText = await init.text();
check(
  '2025-era initialize succeeds',
  init.ok && initText.includes('"serverInfo"'),
  initText.slice(0, 300)
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nMCP endpoint OK');
