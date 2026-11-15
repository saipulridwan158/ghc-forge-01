// The env's GitHub REST v3 client, shared by every REST check in checks-rest.ts.
//
// The env is a CLIENT of the entry: the entry's server records its address when it POSTs
// {"port"} to the env (wire.ts), and every request here is dialled back at that base URL with
// the `/api/v3` prefix. Nothing in this file talks to github.com or any other host: a `Link`
// rel="next" the entry hands back is followed only when it stays on the entry's own origin.
//
// What this file owns:
//   RestClient.request      one fetch: bearer-token auth (or none), JSON request bodies, a
//                           per-call timeout, no throwing on any HTTP outcome. A transport
//                           failure or timeout comes back as a RestResponse with status 0 and
//                           `error` set, so a check reports a human detail instead of crashing.
//   expectStatus            exact-status assertion; the statuses matter, so nothing here
//   expectJsonResponse      coerces them: an expectation names the statuses accepted, never a
//                           range, and a mismatch is a detail string.
//   checkShape              a small declarative JSON-shape assertion with a path in every
//                           message ("body.labels[0].name: expected string, got number").
//   parseLinkHeader         GitHub's `Link: <url>; rel="next"` pagination header.
//
// Every helper returns `null` on success or a one-line human detail on mismatch; the checks
// turn that into {ok:false, detail}. Timing is recorded on every response for diagnostics but
// never reaches a pass/fail bit: a slow entry fails the benchmark (bench.ts), not conformance.
//
// The entry's endpoint contract this client assumes, in full:
//   Authorization: Bearer <token>          the entry's only credential; no token means the
//                                          request is unauthenticated
//   Content-Type: application/json         on every request that carries a body
//   Accept: application/vnd.github+json    sent by default; a server may ignore it
//   every JSON reply is `application/json` (a charset parameter is allowed), never HTML
//   4xx bodies are `{"message": string, ...}`; the exact statuses live in checks-rest.ts

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 1 << 20;
const MAX_DETAIL_BODY_CHARS = 240;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The prefix every GitHub REST v3 route sits under, from the entry base URL. It mirrors
 * wire.ts's API_PREFIX (the sealed contract's own constant) and must stay equal to it.
 */
export const API_PREFIX = '/api/v3';

/** A status, or an explicit set of statuses; never a range. */
export type StatusExpectation = number | readonly number[];

/** One header the client puts on every request that has a body. */
const JSON_CONTENT_TYPE = 'application/json';

export interface RestClientOptions {
  /** The entry's base URL, as wire.ts records it: scheme, host and port, no trailing slash. */
  baseUrl: string;
  /** The bearer token; omitted or `null` sends no Authorization header. */
  token?: string | null;
  /** Per-call timeout in milliseconds; a call may override it. Default 5000. */
  timeoutMs?: number;
  /** Extra headers on every request from this client. */
  headers?: Readonly<Record<string, string>>;
  /** An abort signal composed into every request this client makes (the runner's phase deadline). */
  signal?: AbortSignal;
}

export interface RestRequestOptions {
  /** HTTP method; default GET. */
  method?: string;
  /** Query parameters, percent-encoded; `undefined` and `null` values are dropped. */
  query?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  /** A JSON-serialisable body: serialised with JSON.stringify and sent as application/json. */
  body?: unknown;
  /** A body sent verbatim (the malformed-body checks need one); wins over `body`. */
  rawBody?: string | Uint8Array;
  /** A token for this call only; `null` sends none, `undefined` uses the client's. */
  token?: string | null;
  headers?: Readonly<Record<string, string>>;
  /** Per-call timeout, overriding the client's. */
  timeoutMs?: number;
  /** An external cancellation signal, composed with the timeout. */
  signal?: AbortSignal;
}

/** One HTTP exchange as the checks see it. `status` is 0 only when no reply arrived. */
export interface RestResponse<T = unknown> {
  /** The HTTP status, or 0 on a transport error or timeout. */
  status: number;
  statusText: string;
  /** The absolute URL requested. */
  url: string;
  /** `status` in 200..299 (false for status 0). */
  ok: boolean;
  headers: Headers;
  /** The raw Content-Type header, or null. */
  contentType: string | null;
  /** The parsed JSON body when the reply said it was JSON and parsed; else undefined. */
  body: T | undefined;
  /** The reply body as text (truncated past MAX_RESPONSE_BYTES), always populated when a reply arrived. */
  text: string;
  /** Set when the reply claimed JSON and did not parse. */
  parseError: string | null;
  /** Set (with status 0) on a transport failure, timeout or refused off-origin URL. */
  error: string | null;
  /** Wall time of the exchange in milliseconds; diagnostics only, never scored. */
  elapsedMs: number;
}

type JsonObject = Record<string, unknown>;

/** A value a check can assert without writing a predicate: the body's shape as data. */
export type Shape =
  | { kind: 'any' }
  | { kind: 'object'; props?: Readonly<Record<string, Shape>>; required?: readonly string[]; allowExtra?: boolean }
  | { kind: 'array'; items?: Shape; min?: number; max?: number }
  | { kind: 'string'; nonEmpty?: boolean; oneOf?: readonly string[]; pattern?: RegExp }
  | { kind: 'number'; integer?: boolean; min?: number; max?: number }
  | { kind: 'boolean' }
  | { kind: 'null' };

/** Convenience shapes for the checks; all are `Shape` values. */
export const shapes = {
  any: (): Shape => ({ kind: 'any' }),
  object: (props: Readonly<Record<string, Shape>> = {}, required?: readonly string[]): Shape => ({
    kind: 'object',
    props,
    required: required ?? Object.keys(props),
  }),
  looseObject: (): Shape => ({ kind: 'object', props: {}, required: [], allowExtra: true }),
  array: (items?: Shape, bounds: { min?: number; max?: number } = {}): Shape => ({ kind: 'array', items, ...bounds }),
  string: (opts: { nonEmpty?: boolean; oneOf?: readonly string[]; pattern?: RegExp } = {}): Shape => ({ kind: 'string', ...opts }),
  number: (opts: { integer?: boolean; min?: number; max?: number } = {}): Shape => ({ kind: 'number', ...opts }),
  boolean: (): Shape => ({ kind: 'boolean' }),
  null: (): Shape => ({ kind: 'null' }),
} as const;

/** Whether a Content-Type header names JSON (`application/json`, `application/vnd.github+json`, `+json`). */
export function isJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  return /^application\/(?:[A-Za-z0-9!#$&^_.+-]+\+)?json(?:\s*;.*)?$/i.test(value.trim());
}

/** Whether two absolute URLs share scheme, host and port. */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** The relations of a `Link` header, absolute URLs as the server wrote them. */
export interface LinkRelations {
  next: string | null;
  prev: string | null;
  first: string | null;
  last: string | null;
}

/** Parse GitHub's `Link: <url>; rel="next", <url>; rel="last"` header. */
export function parseLinkHeader(value: string | null): LinkRelations {
  const out: LinkRelations = { next: null, prev: null, first: null, last: null };
  if (value === null || value.trim() === '') return out;
  for (const part of value.split(',')) {
    const match = /<([^>]*)>\s*;\s*rel\s*=\s*"?([A-Za-z]+)"?/.exec(part.trim());
    if (match === null) continue;
    const url = match[1] ?? '';
    const rel = (match[2] ?? '').toLowerCase();
    if (rel === 'next' || rel === 'prev' || rel === 'first' || rel === 'last') out[rel] = url;
  }
  return out;
}

/** Encode one path segment, keeping `/` inside it (a repository-relative file path). */
function encodeSegment(segment: string): string {
  return segment
    .split('/')
    .map((piece) => encodeURIComponent(piece))
    .join('/');
}

/**
 * Build an `/api/v3` path from raw segments, encoding each one:
 *   apiPath('repos', owner, repo, 'contents', 'docs/readme.md')
 *     -> /api/v3/repos/<owner>/<repo>/contents/docs/readme.md
 */
export function apiPath(...segments: readonly (string | number)[]): string {
  const tail = segments.map((segment) => encodeSegment(String(segment))).join('/');
  return tail === '' ? API_PREFIX : `${API_PREFIX}/${tail}`;
}

/** Base64 (standard alphabet) of a UTF-8 string, as the contents API wants it. */
export function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Decode base64 content, ignoring the newlines GitHub wraps it at. */
export function b64decode(content: string): string {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64').toString('utf8');
}

/** A one-line description of a response for a failure detail. */
export function describeResponse(response: RestResponse): string {
  if (response.status === 0) return `no response: ${response.error ?? 'unknown transport error'}`;
  const status = `${response.status}${response.statusText === '' ? '' : ` ${response.statusText}`}`;
  const body = response.text.length > MAX_DETAIL_BODY_CHARS ? `${response.text.slice(0, MAX_DETAIL_BODY_CHARS)}…` : response.text;
  return body === '' ? status : `${status}; body ${body}`;
}

function formatExpectation(expected: StatusExpectation): string {
  return typeof expected === 'number' ? String(expected) : expected.join(' or ');
}

/** Assert the exact status (or one of the named statuses). Null when it matches. */
export function expectStatus(response: RestResponse, expected: StatusExpectation, label: string): string | null {
  const wanted = typeof expected === 'number' ? [expected] : expected;
  if (wanted.includes(response.status)) return null;
  return `${label}: expected status ${formatExpectation(expected)}, got ${describeResponse(response)}`;
}

/** Assert a header is present (and, with `nonEmpty`, not an empty string). Null when it matches. */
export function expectHeader(response: RestResponse, name: string, label: string, options: { nonEmpty?: boolean } = {}): string | null {
  const value = response.headers.get(name);
  if (value === null) return `${label}: expected header ${name}, but the response did not carry it`;
  if (options.nonEmpty === true && value.trim() === '') return `${label}: expected a non-empty ${name} header, got an empty one`;
  return null;
}

/** Assert the reply is not HTML: not a text/html content type and not an HTML-looking body. */
export function expectNoHtml(response: RestResponse, label: string): string | null {
  const type = response.contentType ?? '';
  if (/^text\/html\b/i.test(type.trim())) return `${label}: expected JSON, got ${type}`;
  if (/^\s*</.test(response.text)) return `${label}: expected JSON, got an HTML body (${response.text.slice(0, 80)}…)`;
  return null;
}

/**
 * The helper the checks use: exact status, a JSON content type, a parsed JSON body and an
 * optional shape. Returns null when everything matches, a human detail otherwise.
 */
export function expectJsonResponse<T = unknown>(
  response: RestResponse<T>,
  expected: StatusExpectation,
  shape: Shape | null,
  label: string,
): string | null {
  const status = expectStatus(response, expected, label);
  if (status !== null) return status;
  const html = expectNoHtml(response, label);
  if (html !== null) return html;
  if (!isJsonContentType(response.contentType)) {
    return `${label}: expected a JSON content type, got ${response.contentType ?? 'none'} (body ${response.text.slice(0, MAX_DETAIL_BODY_CHARS)})`;
  }
  if (response.parseError !== null) return `${label}: response body is not valid JSON: ${response.parseError}`;
  if (shape !== null) {
    const problem = checkShape(response.body, shape, `${label} body`);
    if (problem !== null) return problem;
  }
  return null;
}

/** Assert a value against a declarative shape; the first mismatch as a path-qualified detail. */
export function checkShape(value: unknown, shape: Shape, path = 'body'): string | null {
  switch (shape.kind) {
    case 'any':
      return null;
    case 'null':
      return value === null ? null : `${path}: expected null, got ${typeName(value)}`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path}: expected boolean, got ${typeName(value)}`;
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value)) return `${path}: expected number, got ${typeName(value)}`;
      if (shape.integer === true && !Number.isInteger(value)) return `${path}: expected an integer, got ${value}`;
      if (shape.min !== undefined && value < shape.min) return `${path}: expected at least ${shape.min}, got ${value}`;
      if (shape.max !== undefined && value > shape.max) return `${path}: expected at most ${shape.max}, got ${value}`;
      return null;
    }
    case 'string': {
      if (typeof value !== 'string') return `${path}: expected string, got ${typeName(value)}`;
      if (shape.nonEmpty === true && value === '') return `${path}: expected a non-empty string, got an empty one`;
      if (shape.oneOf !== undefined && !shape.oneOf.includes(value)) {
        return `${path}: expected one of ${shape.oneOf.map((item) => JSON.stringify(item)).join(', ')}, got ${JSON.stringify(value)}`;
      }
      if (shape.pattern !== undefined && !shape.pattern.test(value)) {
        return `${path}: ${JSON.stringify(value)} does not match ${shape.pattern}`;
      }
      return null;
    }
    case 'array': {
      if (!Array.isArray(value)) return `${path}: expected array, got ${typeName(value)}`;
      if (shape.min !== undefined && value.length < shape.min) return `${path}: expected at least ${shape.min} items, got ${value.length}`;
      if (shape.max !== undefined && value.length > shape.max) return `${path}: expected at most ${shape.max} items, got ${value.length}`;
      if (shape.items !== undefined) {
        for (let index = 0; index < value.length; index += 1) {
          const problem = checkShape(value[index], shape.items, `${path}[${index}]`);
          if (problem !== null) return problem;
        }
      }
      return null;
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${path}: expected object, got ${typeName(value)}`;
      const object = value as JsonObject;
      const required = shape.required ?? Object.keys(shape.props ?? {});
      for (const key of required) {
        if (!(key in object)) return `${path}.${key}: missing required property`;
      }
      if (shape.props !== undefined) {
        for (const [key, childShape] of Object.entries(shape.props)) {
          if (!(key in object)) continue;
          const problem = checkShape(object[key], childShape, `${path}.${key}`);
          if (problem !== null) return problem;
        }
      }
      if (shape.allowExtra === false && shape.props !== undefined) {
        for (const key of Object.keys(object)) {
          if (!(key in shape.props)) return `${path}.${key}: unexpected property`;
        }
      }
      return null;
    }
  }
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function truncatedMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/** The env's one HTTP client. Construct one per token; never share state between requests. */
export class RestClient {
  readonly baseUrl: string;
  readonly token: string | null;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
  private readonly defaultHeaders: Readonly<Record<string, string>>;

  constructor(options: RestClientOptions) {
    const base = options.baseUrl.trim().replace(/\/+$/, '');
    let parsed: URL;
    try {
      parsed = new URL(base);
    } catch {
      throw new TypeError(`RestClient: baseUrl is not an absolute URL: ${JSON.stringify(options.baseUrl)}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new TypeError(`RestClient: baseUrl must be http or https, got ${parsed.protocol}`);
    }
    this.baseUrl = base;
    this.token = options.token ?? null;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultHeaders = options.headers ?? {};
    this.signal = options.signal;
  }

  /** The same base URL with another token (`null` for none). */
  withToken(token: string | null): RestClient {
    return new RestClient({ baseUrl: this.baseUrl, token, timeoutMs: this.timeoutMs, headers: this.defaultHeaders, signal: this.signal });
  }

  /** The absolute URL a path (or an absolute same-origin URL) and query resolve to. */
  url(path: string, query?: RestRequestOptions['query']): string {
    const absolute = /^https?:\/\//i.test(path) ? path : `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const url = new URL(absolute);
    if (query !== undefined) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /** One exchange; never throws for an HTTP or transport outcome. */
  async request<T = unknown>(path: string, options: RestRequestOptions = {}): Promise<RestResponse<T>> {
    const started = performance.now();
    const method = (options.method ?? 'GET').toUpperCase();
    const url = this.url(path, options.query);
    const token = options.token === undefined ? this.token : options.token;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;

    if (!sameOrigin(url, this.baseUrl)) {
      return this.failure(url, `refused to leave the entry's origin: ${url}`, started);
    }

    const headers = new Headers(this.defaultHeaders);
    headers.set('accept', 'application/vnd.github+json');
    if (token !== null) headers.set('authorization', `Bearer ${token}`);
    for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);

    // fetch's BodyInit takes a view over a plain ArrayBuffer, never one over a SharedArrayBuffer, so a
    // Uint8Array raw body is copied byte for byte into a view fetch accepts: the wire bytes are the same.
    let body: string | Uint8Array<ArrayBuffer> | undefined;
    if (options.rawBody !== undefined) {
      body = typeof options.rawBody === 'string' ? options.rawBody : new Uint8Array(options.rawBody);
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      if (!headers.has('content-type')) headers.set('content-type', JSON_CONTENT_TYPE);
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onExternalAbort = (): void => controller.abort();
    const signals = [this.signal, options.signal].filter((signal): signal is AbortSignal => signal !== undefined);
    for (const signal of signals) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
        redirect: 'follow',
      });
      const contentType = response.headers.get('content-type');
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const truncated = bytes.byteLength > MAX_RESPONSE_BYTES;
      const text = new TextDecoder('utf-8').decode(truncated ? bytes.subarray(0, MAX_RESPONSE_BYTES) : bytes);
      const out: RestResponse<T> = {
        status: response.status,
        statusText: response.statusText,
        url,
        ok: response.status >= 200 && response.status <= 299,
        headers: response.headers,
        contentType,
        body: undefined,
        text,
        parseError: null,
        error: null,
        elapsedMs: performance.now() - started,
      };
      if (isJsonContentType(contentType) && text.trim() !== '' && !truncated && !REDIRECT_STATUSES.has(response.status)) {
        try {
          out.body = JSON.parse(text) as T;
        } catch (err) {
          out.parseError = truncatedMessage(err);
        }
      }
      return out;
    } catch (err) {
      const reason = timedOut ? `timeout after ${timeoutMs}ms` : controller.signal.aborted ? 'aborted' : truncatedMessage(err);
      return this.failure(url, reason, started);
    } finally {
      clearTimeout(timer);
      for (const signal of signals) signal.removeEventListener('abort', onExternalAbort);
    }
  }

  get<T = unknown>(path: string, options: Omit<RestRequestOptions, 'method'> = {}): Promise<RestResponse<T>> {
    return this.request<T>(path, { ...options, method: 'GET' });
  }

  post<T = unknown>(path: string, options: Omit<RestRequestOptions, 'method'> = {}): Promise<RestResponse<T>> {
    return this.request<T>(path, { ...options, method: 'POST' });
  }

  patch<T = unknown>(path: string, options: Omit<RestRequestOptions, 'method'> = {}): Promise<RestResponse<T>> {
    return this.request<T>(path, { ...options, method: 'PATCH' });
  }

  put<T = unknown>(path: string, options: Omit<RestRequestOptions, 'method'> = {}): Promise<RestResponse<T>> {
    return this.request<T>(path, { ...options, method: 'PUT' });
  }

  delete<T = unknown>(path: string, options: Omit<RestRequestOptions, 'method'> = {}): Promise<RestResponse<T>> {
    return this.request<T>(path, { ...options, method: 'DELETE' });
  }

  private failure(url: string, error: string, started: number): RestResponse<never> {
    return {
      status: 0,
      statusText: '',
      url,
      ok: false,
      headers: new Headers(),
      contentType: null,
      body: undefined,
      text: '',
      parseError: null,
      error,
      elapsedMs: performance.now() - started,
    };
  }
}
