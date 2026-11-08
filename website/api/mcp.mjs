// The site's MCP endpoint, served at /mcp (see vercel.json): docs_search and
// docs_fetch over the built pages, and the repo's skills/ directory as Agent
// Skills. The build writes the bundle; run `npm run build` first.
//
// Plain ESM rather than TypeScript: this is the file shape the plugin's Vercel
// guide documents, and Vercel runs it as is.
import { createWebRequestHandler } from 'docusaurus-plugin-mcp-server/adapters';
import bundle from '../build/mcp/bundle.json' with { type: 'json' };

export default {
  fetch: createWebRequestHandler({ artifacts: bundle }),
};
