// The GitHub GraphQL v4 wire, client side: POST /api/graphql on the entry's base URL with an
// `Authorization: Bearer <token>` header and a JSON body {query, variables}, answered with a JSON body
// {data, errors}. gh and github-mcp-server both speak this wire (gh's `api` package and its githubv4 client,
// the MCP server's githubv4 queries), so the env's GraphQL checks (checks-graphql.ts) send the shapes they
// send.
//
// Deliberately no GraphQL library and no schema: the client moves a document string and its variables to
// the server and reads back only the two keys a client may act on — `data` and `errors` — plus the HTTP
// status. A document is written by the caller as a template string; nothing here parses or validates it.
//
// The rules the checks rest on:
//   - a GraphQL-level failure (an unknown field, a bad argument) is a 200 whose body carries `errors`;
//     it is not an HTTP error. The caller decides whether it expected that (checks-graphql.ts's
//     invalid-field check does; every other check treats an `errors` array as a failure);
//   - an unauthenticated request is a 401;
//   - two operation documents may be sent in one HTTP body as a JSON array (GitHub's operation batching),
//     answered by an array of the usual per-operation bodies in the same order.
//
// Node 22's global fetch is the transport (no import), so the module adds no dependency to the sealed
// env bundle. The caller may pass its own fetch (for a test rig) and an AbortSignal per call.

/** The path the GraphQL v4 API is served at, on the entry's base URL. */
export const GRAPHQL_PATH = '/api/graphql';

/** The per-call timeout when a caller names none. A check's own deadline is usually tighter. */
export const GRAPHQL_DEFAULT_TIMEOUT_MS = 10_000;

/** The User-Agent the env sends; GitHub refuses a request without one. */
export const GRAPHQL_USER_AGENT = 'makefun-github-core-clone-env/1';

/** A fetch-shaped function: the two arguments the client uses, and nothing else. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** One entry of a response's `errors` array, as GitHub shapes it (extensions are vendor data). */
export interface GraphQLErrorEntry {
  message: string;
  path?: readonly (string | number)[];
  locations?: readonly { line: number; column: number }[];
  extensions?: Readonly<Record<string, unknown>>;
}

/** One operation, for the batched form. */
export interface GraphQLOperation {
  query: string;
  variables?: Readonly<Record<string, unknown>>;
  operationName?: string;
}

/** What one operation's HTTP exchange yielded. `status` is 0 when the request never reached the server. */
export interface GraphQLResponse<T = Record<string, unknown>> {
  status: number;
  /** The body's `data`, or null when it was absent or null. */
  data: T | null;
  /** The body's `errors`, [] when absent. */
  errors: GraphQLErrorEntry[];
  /** The whole parsed body (an object for one operation). */
  body: unknown;
  /** The raw response text, for a detail string. */
  text: string;
  /** Why the request itself failed (DNS, refused, timeout); absent when a response arrived. */
  transportError?: string;
  /** Why the response body could not be read as the JSON the wire promises. */
  parseError?: string;
}

/** The answer to a batched request: one response per operation, in request order. */
export interface GraphQLBatchResponse {
  /** The HTTP status of the one request; 0 when it never reached the server. */
  status: number;
  /** One per operation, in order; empty when the body was not an array. */
  responses: GraphQLResponse<unknown>[];
  /** The raw response text, for a detail string. */
  text: string;
  /** Why the request itself failed; absent when a response arrived. */
  transportError?: string;
  /** Why the body could not be read as the JSON array operation batching promises. */
  parseError?: string;
}

/** Per-call knobs. */
export interface GraphQLCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** The client's construction options. `token: null` sends no Authorization header. */
export interface GraphQLClientOptions {
  baseUrl: string;
  token: string | null;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  userAgent?: string;
  /** Extra headers sent with every request, after the client's own (so they can override). */
  headers?: Readonly<Record<string, string>>;
}

/** The raw body of one HTTP exchange, before the GraphQL envelope is read. */
interface RawExchange {
  status: number;
  text: string;
  body: unknown;
  transportError?: string;
  parseError?: string;
}

const DEFAULT_FETCH: FetchLike = (input, init) => fetch(input, init);

/** Milliseconds from a timeout option, clamped to a positive integer. */
function timeoutOf(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`timeoutMs must be a positive finite number, got ${String(value)}`);
  }
  return Math.max(1, Math.round(value));
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.name === 'Error' ? err.message : `${err.name}: ${err.message}`;
  return String(err);
}

/** A short, safe-for-a-log view of a non-JSON body. */
function preview(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= 120 ? flat : `${flat.slice(0, 117)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The response's `errors` array, keeping the entries that carry a message. */
function errorsOf(value: unknown): GraphQLErrorEntry[] {
  if (!Array.isArray(value)) return [];
  const errors: GraphQLErrorEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const message = entry.message;
    if (typeof message !== 'string') continue;
    const error: GraphQLErrorEntry = { message };
    if (Array.isArray(entry.path)) error.path = entry.path.filter((p): p is string | number => typeof p === 'string' || typeof p === 'number');
    if (Array.isArray(entry.locations)) {
      const locations: { line: number; column: number }[] = [];
      for (const location of entry.locations) {
        if (!isRecord(location)) continue;
        const { line, column } = location;
        if (typeof line === 'number' && typeof column === 'number') locations.push({ line, column });
      }
      if (locations.length > 0) error.locations = locations;
    }
    if (isRecord(entry.extensions)) error.extensions = entry.extensions;
    errors.push(error);
  }
  return errors;
}

/**
 * A GraphQL v4 client for one entry: its base URL, its bearer token and its timeouts. Create one client
 * per base URL; `withoutToken()` makes the same client with no Authorization header (the 401 check).
 */
export class GraphQLClient {
  /** The entry base URL, without its trailing slashes. */
  readonly baseUrl: string;
  /** The bearer token, or null for an unauthenticated client. */
  readonly token: string | null;
  /** The default per-call timeout, in milliseconds. */
  readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string;
  private readonly headers: Readonly<Record<string, string>>;

  constructor(options: GraphQLClientOptions) {
    if (typeof options.baseUrl !== 'string' || options.baseUrl.trim() === '') {
      throw new Error('GraphQLClient needs a baseUrl');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.token = options.token;
    this.timeoutMs = timeoutOf(options.timeoutMs, GRAPHQL_DEFAULT_TIMEOUT_MS);
    this.fetchImpl = options.fetchImpl ?? DEFAULT_FETCH;
    this.userAgent = options.userAgent ?? GRAPHQL_USER_AGENT;
    this.headers = options.headers ?? {};
  }

  /** The absolute URL this client posts documents to. */
  endpoint(): string {
    return `${this.baseUrl}${GRAPHQL_PATH}`;
  }

  /** The same configuration with no bearer token, for the unauthenticated check. */
  withoutToken(): GraphQLClient {
    return new GraphQLClient({
      baseUrl: this.baseUrl,
      token: null,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      userAgent: this.userAgent,
      headers: this.headers,
    });
  }

  /** Run one operation. Never throws for an HTTP status or a GraphQL `errors` array. */
  async request<T = Record<string, unknown>>(
    document: string,
    variables: Readonly<Record<string, unknown>> = {},
    options: GraphQLCallOptions = {},
  ): Promise<GraphQLResponse<T>> {
    const exchange = await this.exchange({ query: document, variables }, options);
    if (exchange.transportError !== undefined || exchange.parseError !== undefined) {
      return {
        status: exchange.status,
        data: null,
        errors: [],
        body: exchange.body,
        text: exchange.text,
        transportError: exchange.transportError,
        parseError: exchange.parseError,
      };
    }
    if (!isRecord(exchange.body)) {
      return {
        status: exchange.status,
        data: null,
        errors: [],
        body: exchange.body,
        text: exchange.text,
        parseError: `expected one JSON object for one operation, got ${Array.isArray(exchange.body) ? 'an array' : 'a non-object body'}`,
      };
    }
    return this.envelopeOf<T>(exchange.status, exchange.body, exchange.text);
  }

  /** Run several operations in one HTTP body (a JSON array), answered in the same order. */
  async batch(
    operations: readonly GraphQLOperation[],
    options: GraphQLCallOptions = {},
  ): Promise<GraphQLBatchResponse> {
    if (operations.length === 0) throw new Error('batch() needs at least one operation');
    const body = operations.map((operation) => {
      const entry: Record<string, unknown> = { query: operation.query, variables: operation.variables ?? {} };
      if (operation.operationName !== undefined) entry.operationName = operation.operationName;
      return entry;
    });
    const exchange = await this.exchange(body, options);
    if (exchange.transportError !== undefined || exchange.parseError !== undefined) {
      return {
        status: exchange.status,
        responses: [],
        text: exchange.text,
        transportError: exchange.transportError,
        parseError: exchange.parseError,
      };
    }
    if (!Array.isArray(exchange.body)) {
      return {
        status: exchange.status,
        responses: [],
        text: exchange.text,
        parseError: `expected a JSON array of ${operations.length} responses, got ${isRecord(exchange.body) ? 'one object' : 'a non-array body'}`,
      };
    }
    const responses = exchange.body.map((entry) => {
      if (!isRecord(entry)) {
        return {
          status: exchange.status,
          data: null,
          errors: [],
          body: entry,
          text: exchange.text,
          parseError: 'a batched response entry is not a JSON object',
        } satisfies GraphQLResponse<unknown>;
      }
      return this.envelopeOf<unknown>(exchange.status, entry, exchange.text);
    });
    return { status: exchange.status, responses, text: exchange.text };
  }

  /** POST one JSON body and read the raw exchange back. */
  private async exchange(body: unknown, options: GraphQLCallOptions): Promise<RawExchange> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': this.userAgent,
      ...this.headers,
    };
    if (this.token !== null) headers.authorization = `Bearer ${this.token}`;
    const timeoutMs = timeoutOf(options.timeoutMs, this.timeoutMs);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint(), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      return { status: 0, text: '', body: null, transportError: describeError(err) };
    }
    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      return { status: response.status, text: '', body: null, transportError: `could not read the response body: ${describeError(err)}` };
    }
    if (text.trim() === '') return { status: response.status, text, body: null };
    try {
      return { status: response.status, text, body: JSON.parse(text) as unknown };
    } catch {
      const contentType = response.headers.get('content-type') ?? 'no content-type';
      return { status: response.status, text, body: null, parseError: `response is not JSON (${contentType}): ${preview(text)}` };
    }
  }

  /** Read one operation's {data, errors} envelope from a parsed body. */
  private envelopeOf<T>(status: number, record: Record<string, unknown>, text: string): GraphQLResponse<T> {
    const data = 'data' in record ? (record.data as T | null) : null;
    const errors = errorsOf(record.errors);
    if (!('data' in record) && errors.length === 0 && status >= 200 && status < 300) {
      return {
        status,
        data: null,
        errors,
        body: record,
        text,
        parseError: `response body has neither data nor errors (keys: ${Object.keys(record).sort().join(', ') || 'none'})`,
      };
    }
    return { status, data, errors, body: record, text };
  }
}
