/**
 * The loopback server a browser sign-in redirects to. Only `signIn` uses it;
 * it is its own module so a run, which refreshes grants but never signs in,
 * doesn't bundle an HTTP server.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A loopback callback server for the authorization-code redirect. */
export async function callbackServer(
  port: number,
  state: string,
  timeoutMs: number
): Promise<{ redirectUri: string; code: Promise<string>; close(): void }> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/callback') {
      response.writeHead(404).end();
      return;
    }
    const ok =
      url.searchParams.get('state') === state && url.searchParams.has('code');
    response.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html' });
    response.end(
      ok
        ? '<html><body><h3>Signed in. You can close this tab.</h3></body></html>'
        : '<html><body><h3>Sign-in failed. Check the terminal.</h3></body></html>'
    );
    if (url.searchParams.get('state') !== state)
      rejectCode(new Error('OAuth state mismatch; sign-in aborted.'));
    else if (!url.searchParams.has('code'))
      rejectCode(
        new Error(
          `Sign-in failed: ${url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? 'no code'}`
        )
      );
    else resolveCode(url.searchParams.get('code')!);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const timer = setTimeout(
    () => rejectCode(new Error('No sign-in callback within 5 minutes.')),
    timeoutMs
  );
  const actual = (server.address() as AddressInfo).port;
  return {
    // `localhost`, not 127.0.0.1: providers that pre-register the redirect URI
    // (Slack, Google) string-match it.
    redirectUri: `http://localhost:${actual}/callback`,
    code,
    close() {
      clearTimeout(timer);
      server.closeAllConnections();
      server.close();
    },
  };
}
