import { resolveLLMEndpoint } from '../../llm/endpoint.js';
import {
  errorChain,
  PlannerConnectionError,
  PlannerStatusError,
  type ComputerUsePlanner,
  type PlannerRequest,
  type PlannerResponse,
} from './computerUseLoop.js';

/**
 * The Computer Use planner: Anthropic's Messages API with the Computer Use
 * beta, over `fetch`. The endpoint and credential come from
 * `resolveLLMEndpoint()` on every request, so LLM gateways and their
 * short-lived tokens work as they do for MST's other LLM calls
 * (docs/llm-gateways.md). Retries match the Anthropic SDK's defaults: two
 * quick retries for a dropped connection or a retryable status.
 */

const PUBLIC_API = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const COMPUTER_USE_BETA = 'computer-use-2025-11-24';
/** The SDK's default request timeout. */
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RETRIES = 2;
const RETRYABLE_STATUS = (status: number) =>
  status === 408 || status === 409 || status === 429 || status >= 500;

/** A planner request that ran out of time. Not retried: it may still be running. */
export class PlannerTimeoutError extends Error {
  override name = 'PlannerTimeoutError';
  constructor() {
    super('Computer Use planner request timed out');
  }
}

export interface PlannerOptions {
  /** The environment the endpoint is resolved from. */
  env: NodeJS.ProcessEnv;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  requestTimeoutMs?: number;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Aborted');
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortReason(signal));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** An error status, with what the response said about retrying it. */
class StatusFailure extends PlannerStatusError {
  constructor(
    status: number,
    readonly retryable: boolean,
    readonly retryAfterMs: number | undefined
  ) {
    super(status);
  }
}

/** The server's `retry-after-ms` or `retry-after`, when it is from 0 to 60 s. */
function retryAfterMs(headers: Headers): number | undefined {
  const afterMs = Number(headers.get('retry-after-ms'));
  if (Number.isFinite(afterMs) && afterMs > 0 && afterMs <= 60_000)
    return afterMs;
  const after = headers.get('retry-after');
  if (!after) return undefined;
  const seconds = Number(after);
  const ms = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(after) - Date.now();
  return Number.isFinite(ms) && ms > 0 && ms <= 60_000 ? ms : undefined;
}

/** The SDK's backoff: 0.5 s doubling to at most 8 s, less up to 25% jitter. */
function backoffMs(retry: number): number {
  return Math.min(500 * 2 ** retry, 8000) * (1 - Math.random() * 0.25);
}

function shouldRetry(response: Response): boolean {
  const header = response.headers.get('x-should-retry');
  if (header === 'true') return true;
  if (header === 'false') return false;
  return RETRYABLE_STATUS(response.status);
}

function isPlannerResponse(value: unknown): value is PlannerResponse {
  return (
    value !== null &&
    typeof value === 'object' &&
    Array.isArray((value as { content?: unknown }).content) &&
    (value as { content: unknown[] }).content.every(
      (block) =>
        block !== null &&
        typeof block === 'object' &&
        typeof (block as { type?: unknown }).type === 'string'
    )
  );
}

export function anthropicComputerUsePlanner(
  options: PlannerOptions
): ComputerUsePlanner {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? abortableSleep;
  const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  async function endpoint() {
    const resolved = await resolveLLMEndpoint('anthropic', {
      env: options.env,
    });
    if (!resolved.apiKey && !resolved.authToken)
      throw new Error(
        'The Computer Use planner needs ANTHROPIC_API_KEY, or ANTHROPIC_BASE_URL with MST_LLM_AUTH_COMMAND or ANTHROPIC_AUTH_TOKEN for an LLM gateway.'
      );
    // A gateway token never goes to the public API.
    if (
      resolved.authToken &&
      resolved.baseURL.replace(/\/+$/, '') === PUBLIC_API
    )
      throw new Error('A gateway token requires a gateway base URL');
    return resolved;
  }

  async function send(
    request: PlannerRequest,
    signal: AbortSignal
  ): Promise<PlannerResponse> {
    const target = await endpoint();
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${target.baseURL}/v1/messages?beta=true`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-beta': COMPUTER_USE_BETA,
          // Exactly one credential, for exactly this endpoint.
          ...(target.authToken
            ? { authorization: `Bearer ${target.authToken}` }
            : { 'x-api-key': target.apiKey! }),
        },
        body: JSON.stringify(request),
        signal: AbortSignal.any([signal, timeout]),
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (timeout.aborted) throw new PlannerTimeoutError();
      throw new PlannerConnectionError(errorChain(error));
    }
    if (!response.ok) {
      // The body can echo request content; it is never read into an error.
      await response.body?.cancel().catch(() => undefined);
      throw new StatusFailure(
        response.status,
        shouldRetry(response),
        retryAfterMs(response.headers)
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (timeout.aborted) throw new PlannerTimeoutError();
      throw new PlannerConnectionError(errorChain(error));
    }
    if (!isPlannerResponse(body))
      throw new Error('Computer Use planner returned an invalid response');
    return body;
  }

  return {
    async prepare() {
      await endpoint();
    },
    async create(request, signal) {
      for (let retry = 0; ; retry++) {
        try {
          return await send(request, signal);
        } catch (error) {
          const status = error instanceof StatusFailure ? error : undefined;
          const retryable =
            error instanceof PlannerConnectionError ||
            status?.retryable === true;
          if (!retryable || retry === MAX_RETRIES || signal.aborted)
            throw error;
          await sleep(status?.retryAfterMs ?? backoffMs(retry), signal);
        }
      }
    },
  };
}
