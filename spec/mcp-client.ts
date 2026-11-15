// env/src/mcp-client.ts: the suite's Model Context Protocol client, hand-rolled over fetch (no dependency, no
// SDK), speaking the Streamable HTTP transport at the entry's `/mcp` endpoint. The suite is the client the
// contest grades: everything checks-mcp.ts sends goes through this file, and nothing here scores anything.
//
// Two protocol eras, one client (the rules accept both; the current revision is 2026-07-28):
//
//   modern  2026-07-28 and later. No handshake: every request declares its revision in
//           `_meta['io.modelcontextprotocol/protocolVersion']` and mirrors it in the `MCP-Protocol-Version`
//           header, and `server/discover` (a mandatory RPC in this revision) returns the server's identity,
//           capabilities and `supportedVersions` in one request. There is no protocol-level session and no
//           GET stream: each POST is answered by one JSON body or by one request-scoped SSE stream whose
//           final data frame is the JSON-RPC response.
//   legacy  2025-11-25 and earlier. The client opens with `initialize` (offering the revisions in
//           MCP_LEGACY_REVISIONS, newest first, and accepting whatever the server echoes back), sends
//           `notifications/initialized`, and carries a `Mcp-Session-Id` header from any response onward.
//
// connect() probes `server/discover` first. A result makes it modern; a 404 (or any answer carrying
// JSON-RPC -32601 Method not found) is the pre-discover era, and the client falls back to the handshake. A
// modern refusal that is not "method not found" — an auth refusal, a 5xx, an UnsupportedProtocolVersionError
// (-32022, retried with a version the server names) — is reported as it is, never smoothed over.
//
// Every request carries `_meta` with the negotiated revision, the client's identity and empty client
// capabilities (plus a plain `protocolVersion` key: the suite's contract says a `_meta` protocolVersion
// field on every request, and an older server may look for that spelling). Every POST carries
// `Accept: application/json, text/event-stream`, `Content-Type: application/json`, the `Mcp-Method` (and,
// for tools/call, `Mcp-Name`) mirrored headers the 2026-07-28 transport requires, the session header when
// one was handed out, and `Authorization: Bearer <token>` when a token is configured. Tool parameters a
// server annotates with `x-mcp-header` are mirrored into `Mcp-Param-*` headers per the transport's value
// encoding rules.
//
// The client never throws for an HTTP status: every answer is an McpHttpResponse carrying the status, the
// exact body text and the JSON-RPC response it held (when it held one), and the checks decide. It throws
// only when the entry did not answer (connection refused), did not answer inside the per-call timeout
// (McpTimeoutError, MCP_DEFAULT_TIMEOUT_MS), or the check's own abort signal fired (McpError). The one
// exception is connect(): a server that speaks neither era is a connection failure, and it throws McpError
// with the evidence from both probes.
//
// Determinism: no clock, Math.random or environment reads. Nothing here names a timing in a pass bit; the
// timeout is a liveness bound on one request, not a score.

/** The current MCP revision (2026-07-28): the suite declares this on every request and negotiates down. */
export const MCP_PREFERRED_REVISION = '2026-07-28';

/**
 * The handshake-era revisions the client offers, newest first, when a server predates `server/discover`. A
 * server that supports one of them answers `initialize` with the revision it chose; the client accepts that
 * echo as the negotiated revision (the brief names 2025-06-18 as one that must not be failed).
 */
export const MCP_LEGACY_REVISIONS: readonly string[] = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

/** The client identity every request's `_meta` carries (`io.modelcontextprotocol/clientInfo`). */
export const MCP_CLIENT_INFO: Readonly<{ name: string; version: string }> = Object.freeze({ name: 'makefun-github-core-clone-env', version: '1.0.0' });

/** The MCP endpoint path on the entry's base URL. The suite always speaks to `<baseUrl>/mcp`. */
export const MCP_ENDPOINT_PATH = '/mcp';

/** The Accept header the transport requires on every POST. */
export const MCP_ACCEPT = 'application/json, text/event-stream';

/** The per-request timeout the suite uses unless a check overrides it, ms (the rules state it). */
export const MCP_DEFAULT_TIMEOUT_MS = 3_000;

/** Where the entry serves the MCP endpoint (the same path wire.ts's MCP_PATH names). */
export const MCP_PATH = MCP_ENDPOINT_PATH;

/** JSON-RPC's parse error code: the answer a body that is not JSON must get (with HTTP 400). */
export const JSON_RPC_PARSE_ERROR = -32700;
/** JSON-RPC's invalid-params code: a tools/call with missing required arguments may answer this. */
export const JSON_RPC_INVALID_PARAMS = -32602;
/** JSON-RPC's method-not-found code: how a pre-discover server answers `server/discover`. */
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
/** The 2026-07-28 revision's UnsupportedProtocolVersionError code, with the versions it supports in `data.supported`. */
export const MCP_UNSUPPORTED_VERSION = -32022;
/** The 2026-07-28 revision's HeaderMismatch code. */
export const MCP_HEADER_MISMATCH = -32020;

export type JsonRpcId = string | number;

/** Which protocol era a server was found to speak. */
export type McpEra = 'modern' | 'legacy';

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc?: string;
  id?: JsonRpcId | null;
  result?: T;
  error?: JsonRpcErrorObject;
}

/** A server's self-reported identity. */
export interface McpServerInfo {
  name?: string;
  version?: string;
  [key: string]: unknown;
}

/** The `server/discover` result (2026-07-28): supported revisions, capabilities and identity in one answer. */
export interface DiscoverResult {
  resultType?: string;
  supportedVersions?: string[];
  capabilities?: Record<string, unknown>;
  instructions?: string;
  serverInfo?: McpServerInfo;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** One tool as `tools/list` answers it. */
export interface McpTool {
  name?: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  [key: string]: unknown;
}

/** One `tools/call` result: content blocks, optional structured content, and `isError` for tool failures. */
export interface McpToolResult {
  content?: Array<{ type?: string; text?: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
  resultType?: string;
  [key: string]: unknown;
}

/** What one HTTP POST to the MCP endpoint answered, kept whole for the checks that judge a refusal. */
export interface McpHttpResponse {
  /** The HTTP status. */
  status: number;
  /** Whether the status is 2xx. */
  ok: boolean;
  headers: Headers;
  /** The response's Content-Type, lowercased. */
  contentType: string;
  /** The exact body text (the SSE framing included when the answer was a stream). */
  bodyText: string;
  /** The parsed JSON body when it was JSON; null otherwise (an SSE body is not JSON whole). */
  json: unknown | null;
  /** The JSON-RPC response the body or stream carried, when it carried one. */
  rpc: JsonRpcResponse | null;
  /** Whether the answer was an SSE stream. */
  sse: boolean;
}

/** One JSON-RPC request's answer, with the id the client sent and the id the answer carried. */
export interface McpRequestOutcome<T = unknown> {
  /** The JSON-RPC id this request carried. */
  id: JsonRpcId;
  method: string;
  status: number;
  http: McpHttpResponse;
  /** The result when the answer was a success; undefined for an error or no answer. */
  result: T | undefined;
  /** The JSON-RPC error when the answer was an error; undefined for a success. */
  error: JsonRpcErrorObject | undefined;
  /** The id the answer carried (`null` for an error response with no id), when one was parsed. */
  matchedId: JsonRpcId | null;
}

/** One `server/discover` probe's evidence. */
export interface McpDiscoverAttempt {
  /** A JSON-RPC result object came back (whatever it holds: the check validates its fields). */
  ok: boolean;
  /** The HTTP status; null when the request never got an answer. */
  status: number | null;
  /** The parsed result, when ok. */
  result: DiscoverResult | null;
  /** The result's valid `YYYY-MM-DD` entries in `supportedVersions`. */
  supportedVersions: readonly string[];
  /** The JSON-RPC error code, when the answer was an error. */
  errorCode: number | null;
  /** The JSON-RPC error message, when the answer was an error. */
  errorMessage: string | null;
  /** Why no answer came back (connection refused, timeout), when that is what happened. */
  transportError: string | null;
  /** The raw answer, kept for the unsupported-version retry and the checks' details. */
  http: McpHttpResponse | null;
}

/** What connect() settled on. */
export interface McpConnectionInfo {
  era: McpEra;
  /** The revision every subsequent request declares (the server's echo, or one from its supported list). */
  protocolVersion: string;
  supportedVersions: readonly string[];
  serverInfo: McpServerInfo | null;
  capabilities: Record<string, unknown>;
  /** The session the server handed out (legacy), or null. */
  sessionId: string | null;
  /** The `server/discover` probe's evidence: the discover check reads it. */
  discover: McpDiscoverAttempt;
}

/** A `tools/call` answer: the request outcome plus the tool result and whether the tool reported an error. */
export interface McpToolCallOutcome extends McpRequestOutcome<McpToolResult> {
  toolResult: McpToolResult | null;
  /** The tool ran and reported a tool execution error (`isError: true`). */
  toolError: boolean;
}

export interface McpClientOptions {
  /** The entry's base URL as the env recorded it at /register, e.g. `http://127.0.0.1:4123`. */
  baseUrl: string;
  /** The suite's bearer token; requests carry `Authorization: Bearer <token>` when it is non-empty. */
  token?: string;
  /** The per-call timeout, ms (default MCP_DEFAULT_TIMEOUT_MS). */
  timeoutMs?: number;
  /** The identity every request's `_meta` names (default MCP_CLIENT_INFO). */
  clientInfo?: { name: string; version: string };
  /** The fetch implementation (default: the global fetch). */
  fetchImpl?: typeof fetch;
  /** The check's abort signal: every request stops when it fires (the runner's phase deadline). */
  signal?: AbortSignal;
}

/** Per-request options. */
export interface McpRequestOptions {
  /** The JSON-RPC id (default: a client-generated one). */
  id?: JsonRpcId;
  /** The timeout for this request only, ms. */
  timeoutMs?: number;
  /** Send no Authorization header (the no-auth-bypass check). */
  omitAuth?: boolean;
  /** Send no MCP-Protocol-Version header (the handshake's initialize: a legacy server may not know it). */
  omitProtocolVersionHeader?: boolean;
  /** Extra headers (the x-mcp-header parameters a tool's inputSchema asks for). */
  extraHeaders?: Record<string, string>;
}

interface SendOptions extends McpRequestOptions {
  /** The method mirrored into `Mcp-Method`. */
  methodHeader?: string;
  /** The name mirrored into `Mcp-Name` (tools/call). */
  nameHeader?: string;
  /** Extra headers (the x-mcp-header parameters). */
  extraHeaders?: Record<string, string>;
  /** The id whose response ends an SSE stream (notifications pass none). */
  expectedId?: JsonRpcId | null;
}

/** A transport-level failure: the entry did not answer, or answered with something this client cannot use. */
export class McpError extends Error {
  status: number | null;
  code: number | null;
  bodyText: string | null;

  constructor(message: string, options: { status?: number | null; code?: number | null; bodyText?: string | null } = {}) {
    super(message);
    this.name = 'McpError';
    this.status = options.status ?? null;
    this.code = options.code ?? null;
    this.bodyText = options.bodyText ?? null;
  }
}

/** The entry did not answer one request inside its timeout. */
export class McpTimeoutError extends McpError {
  constructor(message: string) {
    super(message);
    this.name = 'McpTimeoutError';
  }
}

/** Whether `value` is a plain record (an object that is not an array and not null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `value` is a `YYYY-MM-DD` date string (the protocol's revision spelling). */
export function isRevision(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** A JSON value parsed from `text`; null when `text` is empty or not JSON. */
function parseJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

/** Whether `value` looks like a JSON-RPC response (an id plus a result or an error). */
function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (!isRecord(value)) return false;
  if (value.id === undefined) return false;
  return value.result !== undefined || isRecord(value.error);
}

/** The message of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A date-valid entry list out of whatever `supportedVersions` held. */
function revisionsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRevision);
}

/** The versions a UnsupportedProtocolVersionError names in `data.supported`, in order. */
function supportedFromError(error: JsonRpcErrorObject | undefined): string[] {
  const data = error?.data;
  if (!isRecord(data)) return [];
  return revisionsOf(data.supported);
}

/** A server's identity out of a discover result: its `_meta` key first (2026-07-28), then a loose `serverInfo`. */
function serverInfoOfDiscover(result: DiscoverResult | null): McpServerInfo | null {
  if (result === null) return null;
  const meta = result._meta;
  if (isRecord(meta)) {
    const info = meta['io.modelcontextprotocol/serverInfo'];
    if (isRecord(info)) return info as McpServerInfo;
  }
  if (isRecord(result.serverInfo)) return result.serverInfo as McpServerInfo;
  return null;
}

/** Whether a value can ride a plain ASCII header unchanged (visible ASCII, no surrounding whitespace). */
function isPlainHeaderValue(value: string): boolean {
  return /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(value);
}

/** The base64 the transport's value encoding uses (`=?base64?<this>?=`), over the value's UTF-8 bytes. */
function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A header value per the transport's value encoding: the text as-is when plain, else the base64 sentinel. */
function encodeHeaderValue(value: string): string {
  return isPlainHeaderValue(value) ? value : `=?base64?${base64Utf8(value)}?=`;
}

/** The transport's primitive-to-string conversion for mirrored tool parameters. */
function headerParamString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return null;
}

/**
 * The suite's MCP client (see the file header). One client speaks to one entry base URL; checks construct one,
 * connect it, use it and close it. `connect()` is idempotent: the settled connection (or the first
 * connection failure) answers later calls.
 */
export class McpClient {
  /** The entry's base URL, no trailing slash. */
  readonly baseUrl: string;
  /** `<baseUrl>/mcp`. */
  readonly endpoint: string;
  /** The per-call timeout, ms. */
  readonly timeoutMs: number;
  /** The identity every request's `_meta` names. */
  readonly clientInfo: { name: string; version: string };

  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly abortSignal: AbortSignal | null;
  private sessionId: string | null;
  private revision: string;
  private nextId: number;
  private connection: McpConnectionInfo | null;
  private discoverProbe: McpDiscoverAttempt | null;
  private readonly toolsByName: Map<string, McpTool>;

  constructor(options: McpClientOptions) {
    if (typeof options.baseUrl !== 'string' || options.baseUrl.trim() === '') throw new McpError('McpClient needs the entry base URL');
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.endpoint = `${this.baseUrl}${MCP_ENDPOINT_PATH}`;
    this.token = options.token ?? '';
    this.timeoutMs = options.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;
    this.clientInfo = options.clientInfo ?? { name: MCP_CLIENT_INFO.name, version: MCP_CLIENT_INFO.version };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.abortSignal = options.signal ?? null;
    this.sessionId = null;
    this.revision = MCP_PREFERRED_REVISION;
    this.nextId = 1;
    this.connection = null;
    this.discoverProbe = null;
    this.toolsByName = new Map();
  }

  /** The settled connection, or null before connect() succeeded. */
  get info(): McpConnectionInfo | null {
    return this.connection;
  }

  /** The `server/discover` probe's evidence, or null before connect(). */
  get discoverAttempt(): McpDiscoverAttempt | null {
    return this.discoverProbe;
  }

  /** The session header value the server handed out, or null. */
  get session(): string | null {
    return this.sessionId;
  }

  /** The revision the next request declares. */
  get protocolVersion(): string {
    return this.revision;
  }

  /**
   * Probe `server/discover` once, without connecting or falling back: the discover check judges the raw answer
   * (a result, or method-not-found for a pre-discover server). connect() runs this probe itself.
   */
  async probeDiscover(): Promise<McpDiscoverAttempt> {
    const probe = await this.discoverOnce();
    this.discoverProbe = probe;
    if (probe.ok && probe.supportedVersions.length > 0 && !probe.supportedVersions.includes(this.revision)) {
      this.revision = probe.supportedVersions.includes(MCP_PREFERRED_REVISION) ? MCP_PREFERRED_REVISION : probe.supportedVersions[0]!;
    }
    return probe;
  }

  /**
   * Connect: modern `server/discover` first, then the handshake when the server answers method-not-found. Throws
   * McpError when the entry serves no endpoint this client can speak to; the checks report its message.
   */
  async connect(): Promise<McpConnectionInfo> {
    if (this.connection !== null) return this.connection;
    const probe = await this.discoverOnce();
    this.discoverProbe = probe;
    if (probe.ok) {
      const info = this.settleModern(probe);
      this.connection = info;
      return info;
    }
    if (probe.transportError !== null) {
      throw new McpError(`the entry did not answer server/discover at ${this.endpoint}: ${probe.transportError}`);
    }
    if (probe.errorCode === MCP_UNSUPPORTED_VERSION) {
      const supported = supportedFromError(probe.http?.rpc?.error);
      const chosen = supported.includes(MCP_PREFERRED_REVISION) ? MCP_PREFERRED_REVISION : supported[0];
      if (chosen === undefined) throw new McpError(`server/discover rejected ${MCP_PREFERRED_REVISION} and named no usable version`, { status: probe.status, code: probe.errorCode });
      this.revision = chosen;
      const retry = await this.discoverOnce();
      this.discoverProbe = retry;
      if (retry.ok) {
        const info = this.settleModern(retry);
        this.connection = info;
        return info;
      }
      throw new McpError(`server/discover kept failing after retrying with ${chosen}: HTTP ${retry.status ?? 'none'}${retry.errorCode !== null ? `, JSON-RPC ${retry.errorCode}` : ''}`, { status: retry.status, code: retry.errorCode });
    }
    const methodNotFound = probe.errorCode === JSON_RPC_METHOD_NOT_FOUND;
    const missingEndpoint = probe.status === 404 || probe.status === 405;
    const modernRefusal = probe.errorCode !== null && [MCP_HEADER_MISMATCH, MCP_UNSUPPORTED_VERSION, -32021, -32600, JSON_RPC_INVALID_PARAMS].includes(probe.errorCode);
    if (!methodNotFound && !missingEndpoint) {
      if (modernRefusal || probe.status === 401 || probe.status === 403 || (probe.status !== null && probe.status >= 500)) {
        const why = probe.errorCode !== null ? `JSON-RPC ${probe.errorCode}: ${probe.errorMessage ?? ''}` : `HTTP ${probe.status}`;
        throw new McpError(`the MCP endpoint refused server/discover (${why})`, { status: probe.status, code: probe.errorCode });
      }
    }
    return this.initializeLegacy(probe);
  }

  /** The legacy handshake: initialize with the newest revision it accepts, then notifications/initialized. */
  private async initializeLegacy(probe: McpDiscoverAttempt): Promise<McpConnectionInfo> {
    let last: McpRequestOutcome<Record<string, unknown>> | null = null;
    for (const revision of MCP_LEGACY_REVISIONS) {
      const outcome = await this.request<Record<string, unknown>>('initialize', { protocolVersion: revision, capabilities: {}, clientInfo: { ...this.clientInfo } }, { id: 'initialize-1', omitProtocolVersionHeader: true });
      last = outcome;
      if (outcome.error === undefined && isRecord(outcome.result)) {
        const negotiated = isRevision(outcome.result.protocolVersion) ? outcome.result.protocolVersion : revision;
        this.revision = negotiated;
        await this.notify('notifications/initialized', {}, { omitProtocolVersionHeader: true }).catch(() => null);
        return {
          era: 'legacy',
          protocolVersion: negotiated,
          supportedVersions: [],
          serverInfo: isRecord(outcome.result.serverInfo) ? (outcome.result.serverInfo as McpServerInfo) : null,
          capabilities: isRecord(outcome.result.capabilities) ? outcome.result.capabilities : {},
          sessionId: this.sessionId,
          discover: probe,
        };
      }
      if (outcome.error?.code !== JSON_RPC_INVALID_PARAMS) break;
    }
    const attempt = last;
    const why =
      attempt === null
        ? `server/discover HTTP ${probe.status ?? 'none'}${probe.errorCode !== null ? `, JSON-RPC ${probe.errorCode}` : ''}`
        : attempt.error !== undefined
          ? `initialize answered JSON-RPC ${attempt.error.code}: ${attempt.error.message}`
          : `initialize answered no result (HTTP ${attempt.status})`;
    throw new McpError(`the entry serves no MCP endpoint at ${this.endpoint} (${why})`, { status: attempt?.status ?? probe.status, code: attempt?.error?.code ?? probe.errorCode });
  }

  /** Record a modern connection from a successful discover result. */
  private settleModern(probe: McpDiscoverAttempt): McpConnectionInfo {
    const result = probe.result as DiscoverResult;
    const supported = probe.supportedVersions;
    const chosen = supported.includes(MCP_PREFERRED_REVISION) ? MCP_PREFERRED_REVISION : (supported[0] ?? MCP_PREFERRED_REVISION);
    this.revision = chosen;
    return {
      era: 'modern',
      protocolVersion: chosen,
      supportedVersions: supported,
      serverInfo: serverInfoOfDiscover(result),
      capabilities: isRecord(result.capabilities) ? result.capabilities : {},
      sessionId: this.sessionId,
      discover: probe,
    };
  }

  /** One `server/discover` request, its evidence captured (never thrown). */
  private async discoverOnce(): Promise<McpDiscoverAttempt> {
    try {
      const outcome = await this.request('server/discover', {}, { id: 'discover-1' });
      if (outcome.error === undefined && isRecord(outcome.result)) {
        const result = outcome.result as DiscoverResult;
        return { ok: true, status: outcome.status, result, supportedVersions: revisionsOf(result.supportedVersions), errorCode: null, errorMessage: null, transportError: null, http: outcome.http };
      }
      return {
        ok: false,
        status: outcome.status,
        result: null,
        supportedVersions: [],
        errorCode: outcome.error?.code ?? null,
        errorMessage: outcome.error?.message ?? null,
        transportError: null,
        http: outcome.http,
      };
    } catch (error) {
      return { ok: false, status: null, result: null, supportedVersions: [], errorCode: null, errorMessage: null, transportError: messageOf(error), http: null };
    }
  }

  /** Send one JSON-RPC request and return its answer whole (see McpRequestOutcome). */
  async request<T = unknown>(method: string, params?: Record<string, unknown>, options: McpRequestOptions = {}): Promise<McpRequestOutcome<T>> {
    const id = options.id ?? this.allocateId();
    const body = {
      jsonrpc: '2.0',
      id,
      method,
      params: this.withMeta(params),
    };
    const http = await this.send(body, {
      ...options,
      methodHeader: method,
      nameHeader: typeof params?.name === 'string' ? params.name : undefined,
      expectedId: id,
    });
    const rpc = http.rpc;
    return {
      id,
      method,
      status: http.status,
      http,
      result: rpc?.result as T | undefined,
      error: rpc?.error,
      matchedId: rpc?.id ?? null,
    };
  }

  /** Send one JSON-RPC notification (no id); its answer is the HTTP response, and a lost notification is no error. */
  async notify(method: string, params?: Record<string, unknown>, options: McpRequestOptions = {}): Promise<McpHttpResponse> {
    return this.send({ jsonrpc: '2.0', method, params: this.withMeta(params) }, { ...options, methodHeader: method, expectedId: null });
  }

  /** POST an exact body (the parse-error check sends one that is not JSON). */
  async postRaw(bodyText: string, options: McpRequestOptions & { methodHeader?: string; nameHeader?: string; expectedId?: JsonRpcId | null } = {}): Promise<McpHttpResponse> {
    return this.send(bodyText, { ...options, expectedId: options.expectedId ?? null });
  }

  /** `tools/list`, following `nextCursor` (bounded); each tool is remembered for x-mcp-header mirroring. */
  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const outcome = await this.request<{ tools?: unknown; nextCursor?: unknown }>('tools/list', cursor === undefined ? {} : { cursor });
      if (outcome.error !== undefined) throw new McpError(`tools/list answered JSON-RPC ${outcome.error.code}: ${outcome.error.message}`, { status: outcome.status, code: outcome.error.code });
      const list = isRecord(outcome.result) && Array.isArray(outcome.result.tools) ? outcome.result.tools : null;
      if (list === null) throw new McpError(`tools/list answered no tools array (HTTP ${outcome.status})`, { status: outcome.status });
      for (const tool of list) if (isRecord(tool) && typeof tool.name === 'string' && tool.name !== '') { tools.push(tool as McpTool); this.toolsByName.set(tool.name, tool as McpTool); }
      const next = isRecord(outcome.result) && typeof outcome.result.nextCursor === 'string' && outcome.result.nextCursor !== '' ? outcome.result.nextCursor : undefined;
      if (next === undefined) break;
      cursor = next;
    }
    return tools;
  }

  /** `tools/call`, the tool result parsed out; the checks judge `error` and `toolError` themselves. */
  async callTool(name: string, args: Record<string, unknown> = {}, options: McpRequestOptions = {}): Promise<McpToolCallOutcome> {
    const outcome = await this.request<McpToolResult>('tools/call', { name, arguments: args }, { ...options, extraHeaders: this.headerParamsFor(name, args) });
    const toolResult = isRecord(outcome.result) ? (outcome.result as McpToolResult) : null;
    return { ...outcome, toolResult, toolError: toolResult !== null && toolResult.isError === true };
  }

  /** Close: a legacy session is DELETEd best-effort; nothing else is held. */
  async close(): Promise<void> {
    const session = this.sessionId;
    if (session === null) return;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 1_000));
      try {
        await this.fetchImpl(this.endpoint, {
          method: 'DELETE',
          headers: { accept: 'application/json, text/event-stream', 'mcp-session-id': session, ...(this.token === '' ? {} : { authorization: `Bearer ${this.token}` }) },
          signal: controller.signal,
          redirect: 'manual',
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // A session the server already forgot needs no goodbye.
    }
  }

  /** The mirrored Mcp-Param-* headers a tool's inputSchema asks for (x-mcp-header), value-encoded. */
  private headerParamsFor(name: string, args: Record<string, unknown>): Record<string, string> {
    const tool = this.toolsByName.get(name);
    if (tool === undefined || !isRecord(tool.inputSchema)) return {};
    const properties = tool.inputSchema.properties;
    if (!isRecord(properties)) return {};
    const headers: Record<string, string> = {};
    for (const [parameter, schema] of Object.entries(properties)) {
      if (!isRecord(schema)) continue;
      const header = schema['x-mcp-header'];
      if (typeof header !== 'string' || header === '') continue;
      const value = args[parameter];
      if (value === undefined) continue;
      const text = headerParamString(value);
      if (text === null) continue;
      headers[`Mcp-Param-${header}`] = encodeHeaderValue(text);
    }
    return headers;
  }

  /** Allocate the next JSON-RPC id. */
  private allocateId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  /** The params with `_meta` added (never overwriting an explicit key). */
  private withMeta(params: Record<string, unknown> | undefined): Record<string, unknown> {
    const meta = {
      'io.modelcontextprotocol/protocolVersion': this.revision,
      'io.modelcontextprotocol/clientInfo': { ...this.clientInfo },
      'io.modelcontextprotocol/clientCapabilities': {},
      protocolVersion: this.revision,
    };
    const given = isRecord(params?._meta) ? params._meta : {};
    return { ...(params ?? {}), _meta: { ...meta, ...given } };
  }

  /** The headers every POST carries. */
  private headersFor(options: SendOptions): Record<string, string> {
    const headers: Record<string, string> = { accept: MCP_ACCEPT, 'content-type': 'application/json' };
    if (options.omitProtocolVersionHeader !== true) headers['mcp-protocol-version'] = this.revision;
    if (options.methodHeader !== undefined) headers['mcp-method'] = options.methodHeader;
    if (options.nameHeader !== undefined && options.nameHeader !== '') headers['mcp-name'] = encodeHeaderValue(options.nameHeader);
    if (this.sessionId !== null) headers['mcp-session-id'] = this.sessionId;
    if (options.omitAuth !== true && this.token !== '') headers.authorization = `Bearer ${this.token}`;
    for (const [name, value] of Object.entries(options.extraHeaders ?? {})) headers[name] = value;
    return headers;
  }

  /** POST one body (an object to serialize, or exact text) and capture the answer whole. Throws only on no answer. */
  private async send(body: string | Record<string, unknown>, options: SendOptions): Promise<McpHttpResponse> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    if (this.abortSignal !== null && this.abortSignal.aborted) throw new McpError(`POST ${this.endpoint} was not sent: the check's budget is spent`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    const onAbort = (): void => controller.abort();
    this.abortSignal?.addEventListener('abort', onAbort, { once: true });
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: this.headersFor(options),
          body: typeof body === 'string' ? body : JSON.stringify(body),
          signal: controller.signal,
          redirect: 'manual',
        });
      } catch (error) {
        if (this.abortSignal !== null && this.abortSignal.aborted) throw new McpError(`POST ${this.endpoint} stopped: the check's budget ran out`);
        if (controller.signal.aborted) throw new McpTimeoutError(`POST ${this.endpoint} did not answer inside ${timeoutMs} ms`);
        throw new McpError(`POST ${this.endpoint} failed: ${messageOf(error)}`);
      }
      const session = response.headers.get('mcp-session-id');
      if (session !== null) this.sessionId = session;
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      const sse = contentType.includes('text/event-stream');
      let bodyText = '';
      let rpc: JsonRpcResponse | null = null;
      if (sse && response.body !== null) {
        const stream = await this.readEventStream(response, options.expectedId ?? null, controller.signal, timeoutMs);
        bodyText = stream.bodyText;
        rpc = stream.rpc;
      } else {
        try {
          bodyText = await response.text();
        } catch (error) {
          if (this.abortSignal !== null && this.abortSignal.aborted) throw new McpError(`POST ${this.endpoint} stopped: the check's budget ran out`);
          if (controller.signal.aborted) throw new McpTimeoutError(`POST ${this.endpoint} did not answer inside ${timeoutMs} ms`);
          throw new McpError(`reading ${this.endpoint}'s answer failed: ${messageOf(error)}`);
        }
        const parsed = parseJson(bodyText);
        if (isJsonRpcResponse(parsed)) rpc = parsed;
        else if (Array.isArray(parsed)) {
          const found = parsed.find(isJsonRpcResponse);
          if (found !== undefined) rpc = found;
        }
      }
      const json = sse ? null : parseJson(bodyText);
      return { status: response.status, ok: response.status >= 200 && response.status < 300, headers: response.headers, contentType, bodyText, json, rpc, sse };
    } finally {
      clearTimeout(timer);
      this.abortSignal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Read a request-scoped SSE stream until the JSON-RPC response with `expectedId` arrives (or the stream ends).
   * Notifications and comment lines before it are skipped; the response is the last data frame per the transport.
   */
  private async readEventStream(response: Response, expectedId: JsonRpcId | null, signal: AbortSignal, timeoutMs: number): Promise<{ bodyText: string; rpc: JsonRpcResponse | null }> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let bodyText = '';
    let buffer = '';
    let dataLines: string[] = [];
    const dispatch = (): JsonRpcResponse | null => {
      if (dataLines.length === 0) return null;
      const parsed = parseJson(dataLines.join('\n'));
      dataLines = [];
      if (!isJsonRpcResponse(parsed)) return null;
      if (expectedId === null || parsed.id === expectedId) return parsed;
      return null;
    };
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          if (this.abortSignal !== null && this.abortSignal.aborted) throw new McpError(`POST ${this.endpoint} stopped: the check's budget ran out`);
          if (signal.aborted) throw new McpTimeoutError(`POST ${this.endpoint} did not answer inside ${timeoutMs} ms`);
          throw new McpError(`reading ${this.endpoint}'s SSE answer failed: ${messageOf(error)}`);
        }
        if (chunk.done) break;
        const text = decoder.decode(chunk.value, { stream: true });
        bodyText += text;
        buffer += text;
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const raw = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
          if (line === '') {
            const found = dispatch();
            if (found !== null) {
              await reader.cancel().catch(() => undefined);
              return { bodyText, rpc: found };
            }
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).replace(/^ /, ''));
          }
        }
      }
      return { bodyText, rpc: dispatch() };
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // an already-cancelled reader holds no lock to release
      }
    }
  }
}

/** A client for one entry base URL (the checks' shorthand). */
export function createMcpClient(options: McpClientOptions): McpClient {
  return new McpClient(options);
}
