// The wire contract for github-core-clone-01, written by the agent in this session: the entry <-> env
// protocol, the export shapes and their validators, the trial clocks, canonical JSON, and waiting.
//
// The entry is a standalone GitHub-compatible forge (a server): the harness starts it beside the env
// and hands it MAKEFUN_ENV_URL. The lifecycle:
//   1. the env listens (MAKEFUN_ENV_HOST / MAKEFUN_ENV_PORT, 8080 in a container), writes /state/ready,
//      and waits for the entry's first register;
//   2. the entry binds its own ephemeral port (listen(0)), then POSTs $MAKEFUN_ENV_URL/register with
//      {"port": N}. The env records req.socket.remoteAddress:N as the entry's base URL and dials it
//      from then on. The first register wins; a later one is answered 409;
//   3. the entry polls GET $MAKEFUN_ENV_URL/done until {"done": true}, then exits 0;
//   4. the env's suite runs boot, conformance, benchmark and export, and writes both export files.
//
// This module imports nothing (Node built-ins avoided on purpose) and touches no Node-only API: timers,
// AbortSignal and TextEncoder are the only globals used.

import {
  buildScenario,
  type Scenario,
  type ScenarioBlob,
  type ScenarioCommit,
  type ScenarioIssue,
  type ScenarioPull,
  type ScenarioRepo,
  type ScenarioUser,
} from './scenario.ts';

export type { Scenario, ScenarioBlob, ScenarioCommit, ScenarioIssue, ScenarioPull, ScenarioRepo, ScenarioUser };
export { buildScenario };

// ---------------------------------------------------------------- errors

/** A contract violation or an unusable value: never thrown for an entry's own behaviour. */
export class WireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WireError';
  }
}

/** A wait that ran out before the value arrived. */
export class WireTimeoutError extends WireError {
  constructor(message: string) {
    super(message);
    this.name = 'WireTimeoutError';
  }
}

/** A wait that an AbortSignal ended. */
export class WireAbortError extends WireError {
  constructor(message: string) {
    super(message);
    this.name = 'WireAbortError';
  }
}

// ---------------------------------------------------------------- the environment

/** The variable naming the env's origin, as the entry receives it (`http://store:8080`). */
export const ENV_URL_ENV = 'MAKEFUN_ENV_URL';
/** The variable naming the state directory outside a container (the process driver sets it). */
export const STATE_DIR_ENV = 'MAKEFUN_STATE_DIR';
/** The variable naming the address the env listens on. */
export const ENV_HOST_ENV = 'MAKEFUN_ENV_HOST';
/** The variable naming the port the env listens on (0 picks one). */
export const ENV_PORT_ENV = 'MAKEFUN_ENV_PORT';
/** The bearer token the entry receives and every API call to it must carry. */
export const TOKEN_ENV = 'MAKEFUN_SHOP_TOKEN';
/** The port an env listens on when MAKEFUN_ENV_PORT is unset. */
export const DEFAULT_ENV_PORT = 8080;
/** The host an env listens on in a container when MAKEFUN_ENV_HOST is unset. */
export const CONTAINER_HOST = '0.0.0.0';
/** The host an env listens on under the process driver when MAKEFUN_ENV_HOST is unset. */
export const PROCESS_DRIVER_HOST = '127.0.0.1';
/** The state directory in a container (MAKEFUN_STATE_DIR replaces it outside one). */
export const CONTAINER_STATE_DIR = '/state';

/** The state directory the env reads its files from: MAKEFUN_STATE_DIR when set, else /state. */
export function stateDirOf(env: Readonly<Record<string, string | undefined>>): string {
  const dir = env[STATE_DIR_ENV];
  return dir !== undefined && dir !== '' ? dir : CONTAINER_STATE_DIR;
}

// ---------------------------------------------------------------- routes and endpoints

/** The entry POSTs {"port":N} here. */
export const REGISTER_PATH = '/register';
/** The entry polls this until {"done":true}. */
export const DONE_PATH = '/done';
/** The entry answers 200 {"ok":true} here; the env's boot check calls it twice. */
export const HEALTHZ_PATH = '/healthz';
/** The GitHub REST v3 prefix on the entry. */
export const API_PREFIX = '/api/v3';
/** The GraphQL v4 endpoint on the entry. */
export const GRAPHQL_PATH = '/api/graphql';
/** The Model Context Protocol streamable-HTTP endpoint on the entry. */
export const MCP_PATH = '/mcp';
/** The authorization scheme every API call carries. */
export const AUTH_SCHEME = 'Bearer';
/** The ready file the env writes once listening. */
export const READY_FILE = 'ready';
/** The ready file's schema line. */
export const READY_SCHEMA = 'github-core-clone-01/ready/v1';
/** The directory under the state directory the scorer reads. */
export const EXPORT_DIR = 'export';
/** The run-invariant export. */
export const STATE_FILE = 'state.json';
/** The timings export. */
export const PERF_FILE = 'perf.json';
/** The version both exports carry. */
export const STATE_VERSION = 1 as const;
/** The version perf.json carries. */
export const PERF_VERSION = 1 as const;

/** A port the entry may name: 1..65535 (0 is the entry's own bind, never its announced port). */
export const MIN_PORT = 1;
/** The largest port a register request may name. */
export const MAX_PORT = 65535;
/** The most bytes a register request body may hold. */
export const MAX_REGISTER_BODY_BYTES = 65_536;

/** Whether `value` is a port the register contract accepts: an integer 1..65535. */
export function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT;
}

// ---------------------------------------------------------------- the register contract

/** The body of POST /register: the port the entry listens on. */
export interface RegisterRequest {
  readonly port: number;
}

/** The entry's origin, as the env derived it from the register request. */
export interface EntryBase {
  /** The address the register request came from, IPv4-mapped forms normalized. */
  readonly host: string;
  /** The port the entry named. */
  readonly port: number;
  /** `http://host:port`, no trailing slash. */
  readonly url: string;
}

/** Whether `value` is a well-formed register body (exactly a port in 1..65535; extra keys are ignored). */
export function isRegisterRequest(value: unknown): value is RegisterRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return isPort(record.port);
}

/** The register body, or a WireError naming what is wrong with it. */
export function parseRegisterRequest(value: unknown): RegisterRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WireError('the register body is not a JSON object');
  const port = (value as Record<string, unknown>).port;
  if (!isPort(port)) throw new WireError(`the register body's port is not an integer 1..${MAX_PORT}: ${JSON.stringify(port)}`);
  return { port };
}

/**
 * The address a connection came from, as a host that formats into a URL: an IPv4-mapped IPv6 address
 * (`::ffff:a.b.c.d`) becomes the IPv4 address, brackets around an IPv6 literal are dropped, and a zone
 * suffix (`%eth0`) is dropped. An empty address is a WireError: a register request with no peer address
 * cannot be dialled back.
 */
export function normalizeRemoteAddress(address: string | undefined): string {
  if (address === undefined || address === '') throw new WireError('the register request has no peer address');
  let host = address.trim();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const zone = host.indexOf('%');
  if (zone >= 0) host = host.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
  if (mapped !== null) host = mapped[1] ?? host;
  if (host === '') throw new WireError('the register request has no peer address');
  return host;
}

/** A host as it is written in a URL: an IPv6 literal in brackets, anything else unchanged. */
export function formatHost(host: string): string {
  if (host === '') throw new WireError('a base URL needs a host');
  return host.includes(':') && !(host.startsWith('[') && host.endsWith(']')) ? `[${host}]` : host;
}

/** The entry's base URL from the peer address of its register request and the port it named. */
export function entryBase(remoteAddress: string | undefined, port: number): EntryBase {
  if (!isPort(port)) throw new WireError(`the register port is not an integer 1..${MAX_PORT}: ${JSON.stringify(port)}`);
  const host = normalizeRemoteAddress(remoteAddress);
  return Object.freeze({ host, port, url: `http://${formatHost(host)}:${port}` });
}

/** A URL under an origin: `joinUrl('http://store:8080/', '/api/v3/x')` is `http://store:8080/api/v3/x`. */
export function joinUrl(baseUrl: string, path: string): string {
  const origin = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${origin}${suffix}`;
}

/** A REST v3 URL: `apiUrl(base, '/repos/o/r')` is `<base>/api/v3/repos/o/r`. */
export function apiUrl(baseUrl: string, path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return joinUrl(baseUrl, `${API_PREFIX}${suffix}`);
}

/** The GraphQL endpoint's URL. */
export function graphqlUrl(baseUrl: string): string {
  return joinUrl(baseUrl, GRAPHQL_PATH);
}

/** The MCP endpoint's URL. */
export function mcpUrl(baseUrl: string): string {
  return joinUrl(baseUrl, MCP_PATH);
}

/** The status a first register is answered with. */
export const REGISTER_OK_STATUS = 200;
/** The status a second register is answered with (the first entry stays the one dialled). */
export const REGISTER_CONFLICT_STATUS = 409;
/** The status an unparsable register body is answered with. */
export const REGISTER_BAD_REQUEST_STATUS = 400;
/** The status a register request with another method is answered with. */
export const REGISTER_METHOD_STATUS = 405;

/** The body a first register is answered with. */
export function registerAcceptedBody(): { readonly ok: true } {
  return { ok: true };
}

/** The body a second register is answered with. */
export function registerConflictBody(): { readonly ok: false; readonly error: 'already_registered' } {
  return { ok: false, error: 'already_registered' };
}

// ---------------------------------------------------------------- the done contract

/** The answer while the suite still runs. */
export interface DoneWaiting {
  readonly done: false;
}

/** The answer once the export is written: the entry exits 0. */
export interface DoneComplete {
  readonly done: true;
}

/** GET /done's body: waiting until the suite is over, then complete. */
export type DoneResponse = DoneWaiting | DoneComplete;

/** The shared waiting answer (a fresh object every time, so a caller may mutate its copy). */
export function doneWaiting(): DoneWaiting {
  return { done: false };
}

/** The complete answer. */
export function doneComplete(): DoneComplete {
  return { done: true };
}

/** Whether `value` is a done answer. */
export function isDoneResponse(value: unknown): value is DoneResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const done = (value as Record<string, unknown>).done;
  return done === true || done === false;
}

/** The env answers a done poll within this many ms: never held open. */
export const DONE_ANSWER_DEADLINE_MS = 1_000;
/** The entry's first wait between done polls. */
export const DONE_POLL_INTERVAL_MS = 250;
/** The entry's longest wait between done polls. */
export const DONE_POLL_MAX_MS = 2_000;
/** The entry never holds a done request open longer than this: it polls, it does not long-hold. */
export const DONE_REQUEST_TIMEOUT_MS = 30_000;
/** The exit code the entry ends with once done is true. */
export const ENTRY_EXIT_OK = 0;

/** The wait before the next done poll: exponential from DONE_POLL_INTERVAL_MS to DONE_POLL_MAX_MS. */
export function donePollDelayMs(attempt: number, initialMs: number = DONE_POLL_INTERVAL_MS, maxMs: number = DONE_POLL_MAX_MS): number {
  const step = Number.isFinite(attempt) ? Math.max(0, Math.trunc(attempt)) : 0;
  const first = Math.max(1, initialMs);
  const cap = Math.max(first, maxMs);
  return Math.min(cap, Math.round(first * 2 ** step));
}

// ---------------------------------------------------------------- clocks and budgets

/** The boot phase: ready file present, entry registered, /healthz answered twice. */
export const BOOT_BUDGET_MS = 20_000;
/** The conformance phase: every check, one at a time. */
export const CONFORMANCE_BUDGET_MS = 240_000;
/** The benchmark phase: the four workloads. */
export const BENCHMARK_BUDGET_MS = 240_000;
/** The export phase: both files written and fsynced. */
export const EXPORT_BUDGET_MS = 30_000;
/** What the env's internal deadline leaves of the trial's wall budget for the export and the harness. */
export const DEADLINE_MARGIN_MS = 90_000;
/** The competition's limits.wall_budget_sec, which the internal deadline is derived from. */
export const TRIAL_WALL_BUDGET_SEC = 900;
/** The entry answers GET /healthz this many times before the boot check passes. */
export const HEALTHZ_ATTEMPTS = 2;
/** The boot check's budget for those answers. */
export const HEALTHZ_BUDGET_MS = 10_000;
/** A check's default timeout. */
export const CHECK_TIMEOUT_MS = 15_000;
/** A check may not be given less than this. */
export const CHECK_TIMEOUT_MIN_MS = 5_000;
/** A check may not be given more than this. */
export const CHECK_TIMEOUT_MAX_MS = 15_000;

/** The per-phase budgets, by phase name. */
export const PHASE_BUDGET_MS: Readonly<Record<'boot' | 'conformance' | 'benchmark' | 'export', number>> = Object.freeze({
  boot: BOOT_BUDGET_MS,
  conformance: CONFORMANCE_BUDGET_MS,
  benchmark: BENCHMARK_BUDGET_MS,
  export: EXPORT_BUDGET_MS,
});

/** A phase's name. */
export type Phase = keyof typeof PHASE_BUDGET_MS;

/** The boot wait's backoff: the first gap, its factor, and its ceiling. */
export const BOOT_BACKOFF = Object.freeze({ initialMs: 100, factor: 2, maxMs: 2_000 });

/** The wait before the env's next probe of the ready file (or the register gate): exponential. */
export function bootBackoffMs(attempt: number): number {
  const step = Number.isFinite(attempt) ? Math.max(0, Math.trunc(attempt)) : 0;
  return Math.min(BOOT_BACKOFF.maxMs, Math.round(BOOT_BACKOFF.initialMs * BOOT_BACKOFF.factor ** step));
}

/** The trial's clocks: when the env's program started, and the internal deadline it must export by. */
export interface Deadline {
  readonly startedAtMs: number;
  readonly deadlineMs: number;
}

/** The internal deadline: `startedAtMs + wallBudgetSec * 1000 - DEADLINE_MARGIN_MS`, never before the start. */
export function deadlineOf(startedAtMs: number, wallBudgetSec: number = TRIAL_WALL_BUDGET_SEC): Deadline {
  const wallMs = Number.isFinite(wallBudgetSec) && wallBudgetSec > 0 ? wallBudgetSec * 1000 : TRIAL_WALL_BUDGET_SEC * 1000;
  const deadlineMs = startedAtMs + Math.max(0, wallMs - DEADLINE_MARGIN_MS);
  return Object.freeze({ startedAtMs, deadlineMs });
}

/** What is left of a deadline at `nowMs`, never negative. */
export function remainingMs(deadline: Deadline, nowMs: number): number {
  return Math.max(0, deadline.deadlineMs - nowMs);
}

/** `wantMs` clamped to what is left of the deadline at `nowMs`. */
export function clampToDeadline(wantMs: number, deadline: Deadline, nowMs: number): number {
  const want = Number.isFinite(wantMs) ? Math.max(0, wantMs) : 0;
  return Math.min(want, remainingMs(deadline, nowMs));
}

// ---------------------------------------------------------------- waiting

/** How a wait probes, how often, and what ends it. */
export interface WaitOptions {
  /** The most time the wait may take, ms. */
  readonly timeoutMs: number;
  /** The first gap between probes (default BOOT_BACKOFF.initialMs). */
  readonly initialDelayMs?: number;
  /** The longest gap between probes (default BOOT_BACKOFF.maxMs). */
  readonly maxDelayMs?: number;
  /** The gap's growth factor (default BOOT_BACKOFF.factor). */
  readonly factor?: number;
  /** Ends the wait at once when aborted. */
  readonly signal?: AbortSignal;
  /** The clock, default `Date.now` (only waits read a clock in this module; generated data never does). */
  readonly now?: () => number;
  /** The sleep, default a real timer (a test drives it without waiting). */
  readonly sleep?: (delayMs: number) => Promise<void>;
}

function realSleep(delayMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * Resolve with the first non-null value `probe` returns, polling with exponential backoff; a wait past
 * `timeoutMs` throws WireTimeoutError, an aborted signal WireAbortError. The probe runs at least once.
 */
export async function waitForValue<T>(probe: () => T | null | undefined, options: WaitOptions): Promise<T> {
  const now = options.now ?? ((): number => Date.now());
  const sleep = options.sleep ?? realSleep;
  const initial = Math.max(1, options.initialDelayMs ?? BOOT_BACKOFF.initialMs);
  const cap = Math.max(initial, options.maxDelayMs ?? BOOT_BACKOFF.maxMs);
  const growth = Math.max(1, options.factor ?? BOOT_BACKOFF.factor);
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : 0;
  const deadline = now() + timeoutMs;
  let delay = initial;
  let probes = 0;
  for (;;) {
    if (options.signal?.aborted === true) throw new WireAbortError('the wait was aborted');
    const value = probe();
    if (value !== null && value !== undefined) return value;
    probes += 1;
    const left = deadline - now();
    if (left <= 0) throw new WireTimeoutError(`nothing arrived within ${timeoutMs} ms (${probes} probes)`);
    await sleep(Math.min(delay, left));
    delay = Math.min(cap, Math.round(delay * growth));
  }
}

/** The first register wins: a later one is refused and the first entry base URL stays. */
export class RegisterGate {
  #entry: EntryBase | null = null;

  /** The entry base URL, or null before the first register. */
  get entry(): EntryBase | null {
    return this.#entry;
  }

  /** Whether an entry has registered. */
  get registered(): boolean {
    return this.#entry !== null;
  }

  /** Record `base` if no entry has registered yet; false when the first entry already won. */
  offer(base: EntryBase): boolean {
    if (this.#entry !== null) return false;
    this.#entry = base;
    return true;
  }

  /** Wait for the first register, with the boot backoff, up to the boot budget (or `timeoutMs`). */
  wait(options: Omit<WaitOptions, 'timeoutMs'> & { readonly timeoutMs?: number } = {}): Promise<EntryBase> {
    return waitForValue(() => this.#entry, {
      timeoutMs: options.timeoutMs ?? BOOT_BUDGET_MS,
      initialDelayMs: options.initialDelayMs,
      maxDelayMs: options.maxDelayMs,
      factor: options.factor,
      signal: options.signal,
      now: options.now,
      sleep: options.sleep,
    });
  }
}

// ---------------------------------------------------------------- the ready file

/** What the env writes to /state/ready once its listener is bound. */
export interface ReadyFile {
  readonly schema: string;
  readonly host: string;
  readonly port: number;
}

/** The ready file's body for a listener bound at `host:port`. */
export function readyBody(host: string, port: number): ReadyFile {
  if (!isPort(port) && port !== 0) throw new WireError(`a ready file's port is 0 or 1..${MAX_PORT}: ${JSON.stringify(port)}`);
  return Object.freeze({ schema: READY_SCHEMA, host, port });
}

/** Whether `value` is a ready file body. */
export function isReadyFile(value: unknown): value is ReadyFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schema === READY_SCHEMA && typeof record.host === 'string' && record.host !== '' && isPort(record.port);
}

/**
 * Wait for /state/ready to be readable, up to the boot budget (or `timeoutMs`). `read` is the caller's
 * file read (this module imports no `node:fs`) returning the parsed body or null; the env's own write
 * at boot makes this resolve at once, and a runner that writes the file before starting the entry makes
 * it the start signal. Then the env waits for the first register (RegisterGate.wait).
 */
export function waitForReadyFile(
  read: () => ReadyFile | null,
  options: Omit<WaitOptions, 'timeoutMs'> & { readonly timeoutMs?: number } = {},
): Promise<ReadyFile> {
  return waitForValue(read, {
    timeoutMs: options.timeoutMs ?? BOOT_BUDGET_MS,
    initialDelayMs: options.initialDelayMs,
    maxDelayMs: options.maxDelayMs,
    factor: options.factor,
    signal: options.signal,
    now: options.now,
    sleep: options.sleep,
  });
}

// ---------------------------------------------------------------- paths

/** Join path parts with `/`, tolerating a trailing slash (this module imports no `node:path`). */
export function joinPath(...parts: readonly string[]): string {
  const absolute = parts.length > 0 && (parts[0] ?? '').startsWith('/');
  const clean: string[] = [];
  for (const part of parts) {
    if (part === '') continue;
    const piece = part.replace(/^\/+/, '').replace(/\/+$/, '');
    if (piece !== '') clean.push(piece);
  }
  return `${absolute ? '/' : ''}${clean.join('/')}`;
}

/** `<stateDir>/ready`. */
export function readyFilePath(stateDir: string): string {
  return joinPath(stateDir, READY_FILE);
}

/** `<stateDir>/export`. */
export function exportDirPath(stateDir: string): string {
  return joinPath(stateDir, EXPORT_DIR);
}

/** `<stateDir>/export/state.json`. */
export function stateFilePath(stateDir: string): string {
  return joinPath(stateDir, EXPORT_DIR, STATE_FILE);
}

/** `<stateDir>/export/perf.json`. */
export function perfFilePath(stateDir: string): string {
  return joinPath(stateDir, EXPORT_DIR, PERF_FILE);
}

// ---------------------------------------------------------------- the exports

/** 0 or 1: a check's bit, and the working column. */
export type Bit = 0 | 1;

/** A check id: `<group>.<slug>`, as manifest.ts's checkId() builds it. */
export type CheckId = string;

/** A perf tier: 0..4, one workload's band. */
export type PerfTier = 0 | 1 | 2 | 3 | 4;

/** One group's totals in the export. */
export interface GroupCount {
  readonly total: number;
  readonly passed: number;
}

/** The export's counts: the whole manifest and each group. */
export interface StateCounts {
  /** Every check the manifest declares (120). */
  readonly total: number;
  /** How many of them passed. */
  readonly passed: number;
  /** Per group id: declared checks and passed checks. */
  readonly byGroup: Readonly<Record<string, GroupCount>>;
}

/**
 * export/state.json: everything about a run that does not change between two runs on the same entry
 * and the same seed. No times, no ports, no random ids. `checks` holds every check id with its 0|1 (a
 * check that did not run, at the deadline, is 0); `counts` is derived from it; `perfTiers` is the one
 * timing-derived field, kept coarse (0..4) as the settled shape requires; `notes` names fixed causes
 * ("no register before the boot deadline") and holds no timings.
 */
export interface StateFile {
  readonly version: typeof STATE_VERSION;
  readonly working: Bit;
  readonly checks: Readonly<Record<CheckId, Bit>>;
  readonly counts: StateCounts;
  readonly perfTiers: Readonly<Record<string, PerfTier>>;
  readonly notes?: readonly string[];
}

/** One benchmark workload's timings in export/perf.json. */
export interface PerfWorkload {
  /** Its name from manifest.ts BENCH_WORKLOADS. */
  readonly name: string;
  /** Each timed round's wall time, ms, in order. */
  readonly rounds: readonly number[];
  /** The median round, ms. */
  readonly p50_ms: number;
  /** The 99th percentile round, ms (the largest round when few). */
  readonly p99_ms: number;
  /** The fixed operations one round performs (manifest.ts BENCH_WORKLOADS). */
  readonly ops: number;
  /** 0..50: the points this workload earned by the tier formula (0 uncalibrated or failed). */
  readonly points: number;
  /** Why there are no points, when the workload failed or was cut short. */
  readonly error?: string;
}

/**
 * export/perf.json: the timings, which state.json must not hold. `rounds` is each timed round's ms;
 * `tiers` and `points` are keyed by workload name as well, so a reader takes one map; `perf_p50_us` is
 * the leaderboard's tie-break (the geometric mean of the four p50_ms, in microseconds, rounded);
 * `points_total` is 0..200 and is the perf column. Times never enter state.json or a check's pass bit.
 */
export interface PerfFile {
  readonly version: typeof PERF_VERSION;
  /** Whether T_ref_MS held a calibrated time for every workload when the run was made. */
  readonly calibrated: boolean;
  readonly workloads: readonly PerfWorkload[];
  readonly tiers: Readonly<Record<string, PerfTier>>;
  readonly points: Readonly<Record<string, number>>;
  readonly perf_p50_us: number;
  readonly points_total: number;
  readonly notes: readonly string[];
}

/** The note a boot-failed export carries (fixed, no timing). */
export const BOOT_FAILED_NOTE = 'no entry registered before the boot deadline';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isBitRecord(value: unknown): value is Record<string, Bit> {
  if (!isRecord(value)) return false;
  for (const bit of Object.values(value)) if (bit !== 0 && bit !== 1) return false;
  return true;
}

function isPerfTier(value: unknown): value is PerfTier {
  return value === 0 || value === 1 || value === 2 || value === 3 || value === 4;
}

function isPerfTierRecord(value: unknown): value is Record<string, PerfTier> {
  if (!isRecord(value)) return false;
  for (const tier of Object.values(value)) if (!isPerfTier(tier)) return false;
  return true;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Whether `value` is a state.json this contract wrote (a scorer zeroes the columns otherwise). */
export function isStateFile(value: unknown): value is StateFile {
  if (!isRecord(value) || value.version !== STATE_VERSION) return false;
  if (value.working !== 0 && value.working !== 1) return false;
  if (!isBitRecord(value.checks)) return false;
  if (!isPerfTierRecord(value.perfTiers)) return false;
  if (!isRecord(value.counts)) return false;
  if (!isCount(value.counts.total) || !isCount(value.counts.passed)) return false;
  if (!isRecord(value.counts.byGroup)) return false;
  for (const group of Object.values(value.counts.byGroup)) {
    if (!isRecord(group) || !isCount(group.total) || !isCount(group.passed)) return false;
  }
  if (value.notes !== undefined && !isStringArray(value.notes)) return false;
  return true;
}

/** Whether `value` is a perf.json this contract wrote. */
export function isPerfFile(value: unknown): value is PerfFile {
  if (!isRecord(value) || value.version !== PERF_VERSION) return false;
  if (typeof value.calibrated !== 'boolean') return false;
  if (!Array.isArray(value.workloads)) return false;
  for (const workload of value.workloads) {
    if (!isRecord(workload)) return false;
    if (typeof workload.name !== 'string' || workload.name === '') return false;
    if (!Array.isArray(workload.rounds) || !workload.rounds.every(isFiniteNumber)) return false;
    if (!isFiniteNumber(workload.p50_ms) || !isFiniteNumber(workload.p99_ms)) return false;
    if (!isCount(workload.ops)) return false;
    if (!isCount(workload.points) || workload.points > 50) return false;
    if (workload.error !== undefined && typeof workload.error !== 'string') return false;
  }
  if (!isPerfTierRecord(value.tiers)) return false;
  if (!isRecord(value.points)) return false;
  for (const points of Object.values(value.points)) if (!isCount(points) || points > 50) return false;
  if (!isCount(value.perf_p50_us)) return false;
  if (!isCount(value.points_total) || value.points_total > 200) return false;
  if (!isStringArray(value.notes)) return false;
  return true;
}

/** A value's JSON with object keys sorted at every depth: the same bytes for the same value, always. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/** canonicalJson plus a trailing newline, the export files' exact bytes. */
export function canonicalJsonLine(value: unknown): string {
  return `${canonicalJson(value)}\n`;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined) continue;
    sorted[key] = sortKeysDeep(item);
  }
  return sorted;
}

/** The working column: 1 only when the entry registered and at least one check passed. */
export function workingBit(bootOk: boolean, passedChecks: number): Bit {
  return bootOk && Number.isFinite(passedChecks) && passedChecks > 0 ? 1 : 0;
}

/** Zeroed counts for a run that never got an entry: every group's declared total, nothing passed. */
export function emptyCounts(groupCounts: Readonly<Record<string, number>>, totalChecks: number): StateCounts {
  const byGroup: Record<string, GroupCount> = {};
  for (const [group, declared] of Object.entries(groupCounts)) byGroup[group] = { total: isCount(declared) ? declared : 0, passed: 0 };
  return { total: isCount(totalChecks) ? totalChecks : 0, passed: 0, byGroup };
}

/**
 * The export a boot failure writes: every check 0, working 0, counts zeroed, a fixed note. It is the
 * "clear export (all checks failed, working=0)" of the contract, so a trial that never got an entry is
 * scored 0 rather than void.
 */
export function bootFailureState(checkIds: readonly CheckId[], groupCounts: Readonly<Record<string, number>>, notes: readonly string[] = [BOOT_FAILED_NOTE]): StateFile {
  const checks: Record<CheckId, Bit> = {};
  for (const id of checkIds) checks[id] = 0;
  return {
    version: STATE_VERSION,
    working: 0,
    checks,
    counts: emptyCounts(groupCounts, checkIds.length),
    perfTiers: {},
    notes: notes.slice(),
  };
}

/** The perf export a run with no timings writes (a boot failure or a skipped benchmark): all zero. */
export function emptyPerfFile(notes: readonly string[] = [BOOT_FAILED_NOTE]): PerfFile {
  return {
    version: PERF_VERSION,
    calibrated: false,
    workloads: [],
    tiers: {},
    points: {},
    perf_p50_us: 0,
    points_total: 0,
    notes: notes.slice(),
  };
}
