// Serves the deployed MCP function (api/mcp.mjs) over local HTTP, on the built
// bundle, at http://localhost:$PORT/mcp (default 3459). The site contract
// tests (playwright.site.config.ts at the repo root) run against it, so they
// test the file Vercel deploys. Run after `npm run build`.
import http from 'node:http';
import handler from '../api/mcp.mjs';

const port = Number(process.env.PORT ?? 3459);
const MAX_BODY = 4 * 1024 * 1024;

const server = http.createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > MAX_BODY) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(buffer);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined) {
        headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
    }
    const hasBody =
      req.method !== 'GET' && req.method !== 'HEAD' && chunks.length > 0;
    const response = await handler.fetch(
      new Request(new URL(req.url ?? '/', `http://localhost:${port}`), {
        method: req.method,
        headers,
        ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
      })
    );
    response.headers.forEach((value, name) => res.setHeader(name, value));
    // The docs server is stateless: every response, SSE included, ends once
    // the request is answered, so it can be read whole.
    res.writeHead(response.status);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.listen(port, () => {
  console.log(`MCP function (api/mcp.mjs) at http://localhost:${port}/mcp`);
});
