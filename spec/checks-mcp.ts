// env/src/checks-mcp.ts: the agent-native arm of the github-core-clone-01 suite — the `mcp` group, 15 checks,
// registered as `readonly CheckSpec[]` against env/src/manifest.ts (the agent column is this group's passed
// count of 15). It drives the entry's Model Context Protocol endpoint at `<entry base URL>/mcp` through
// env/src/mcp-client.ts, and it judges both protocol eras the rules accept:
//
//   modern 2026-07-28: `server/discover` returns the server's identity, capabilities and supported versions;
//           every request declares its revision in `_meta`; no handshake and no session.
//   legacy 2025-11-25 and earlier: `initialize` + `notifications/initialized`, an optional `Mcp-Session-Id`,
//           and no `server/discover` (the discover check passes with detail "pre-discover revision").
//
// The checks (slugs; each id is checkId('mcp', slug); each 1 bit of the group's 15):
//
//   initialize            the server names itself and declares the tools capability — over whichever of
//                         `server/discover` or `initialize` it negotiated: serverInfo.name and .version
//                         are non-empty strings, capabilities.tools is present
//   server-discover       `server/discover` answers a DiscoverResult with a non-empty `supportedVersions`
//                         of YYYY-MM-DD revisions; a server that predates it (a 404, JSON-RPC -32601, or any
//                         other refusal before a working initialize handshake) passes as
//                         "pre-discover revision", never failed
//   tools-list            `tools/list` offers at least six tools and all of create_repo, get_repo,
//                         create_issue, list_issues, create_pull_request, merge_pull_request by name or
//                         an obvious alias (a server prefix allowed, matched by suffix, case-insensitive)
//   tool-schemas          every listed tool has a non-empty description and an inputSchema of type object
//   create-issue          `tools/call` create_issue creates an issue the REST surface lists (same title)
//   list-issues           `tools/call` list_issues returns an issue that exists in the repository
//   create-pull-request   `tools/call` create_pull_request opens a pull request that REST reads back with
//                         the same head and base refs
//   merge-pull-request    `tools/call` merge_pull_request merges a pull request; REST reads merged:true
//   unknown-tool          an unknown tool name answers a JSON-RPC error (-32602 or -32601), never HTTP 500
//   parse-error           a body that is not JSON answers HTTP 400 with JSON-RPC -32700
//   missing-arguments     tools/call without the required arguments answers isError:true or JSON-RPC -32602
//   concurrent-calls      two concurrent tools/call answers keep their own ids and their own objects
//   tools-list-idempotent two `tools/list` answers hold the same tools array, byte for byte
//   rest-parity           a repository and an issue created over MCP are the same objects over REST, their
//                         ids stable across repeated reads
//   auth-required         a tools/call with no Authorization header answers HTTP 401
//
// The tool argument contract the rules state (github-mcp-server's names; the suite maps the documented name
// to the tool's own schema property by exact normalized name, so a server may use owner_login for owner, and
// a property named full_name receives "owner/repo"): create_repo {name, description?, private?};
// get_repo {owner, repo}; create_issue {owner, repo, title, body?}; list_issues {owner, repo, state?};
// create_pull_request {owner, repo, title, head, base}; merge_pull_request {owner, repo, pull_number}.
// A tool whose inputSchema has a required property the suite cannot fill fails its check with the property
// named, rather than being called with made-up arguments.
//
// The setup uses the REST surface the checks judge as it is (a broken REST route fails these checks with the
// route and status named): GET /api/v3/user (the token's login, the repository owner; the scenario's viewer
// when it refuses); POST /api/v3/user/repos; GET /api/v3/repos/{owner}/{repo}; PUT
// /api/v3/repos/{owner}/{repo}/contents/{path} (with and without `branch`); POST
// /api/v3/repos/{owner}/{repo}/git/refs (or the contents route that creates a branch); GET
// /api/v3/repos/{owner}/{repo}/git/refs/heads/{branch} (or /branches/{branch}); GET/POST
// /api/v3/repos/{owner}/{repo}/issues; GET/POST /api/v3/repos/{owner}/{repo}/pulls and
// GET /api/v3/repos/{owner}/{repo}/pulls/{number}.
//
// Determinism: every name, title, branch, path and byte this group sends comes from the scenario
// (wire.ts buildScenario(), one fixed seed); no Math.random and no clock in a pass bit. The same entry and
// the same scenario issue the same requests in the same order, so state.json's bits replay byte for byte.
// A check that throws fails with its message, never crashes the suite. Nothing here logs the token.

import type { CheckContext, CheckSpec } from './manifest.ts';
import { checkId, fail, pass } from './manifest.ts';
import type { Scenario } from './wire.ts';
import { McpClient, MCP_DEFAULT_TIMEOUT_MS, MCP_LEGACY_REVISIONS, MCP_PREFERRED_REVISION, JSON_RPC_INVALID_PARAMS, JSON_RPC_PARSE_ERROR } from './mcp-client.ts';
import type { McpConnectionInfo, McpDiscoverAttempt, McpRequestOptions, McpTool, McpToolCallOutcome } from './mcp-client.ts';

/** The manifest group these checks count into. */
export const MCP_GROUP = 'mcp';

/** The six tools the agent-native arm needs, by their canonical (github-mcp-server) names. */
export const MCP_REQUIRED_TOOLS = Object.freeze(['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'] as const);

/** The obvious aliases a tool name may carry instead of the canonical name (matched by normalized suffix too). */
export const MCP_TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  create_repo: Object.freeze(['create_repository', 'repo_create', 'repos_create', 'repository_create']),
  get_repo: Object.freeze(['get_repository', 'repo_get', 'repos_get', 'repository_get']),
  create_issue: Object.freeze(['issue_create', 'issues_create']),
  list_issues: Object.freeze(['issues_list', 'issue_list']),
  create_pull_request: Object.freeze(['pull_request_create', 'pulls_create', 'create_pr', 'pr_create']),
  merge_pull_request: Object.freeze(['pull_request_merge', 'pulls_merge', 'merge_pr', 'pr_merge']),
});

/** The revisions this client accepts: the current one, and the handshake revisions it negotiates down to. */
export const MCP_ACCEPTED_REVISIONS = Object.freeze([MCP_PREFERRED_REVISION, ...MCP_LEGACY_REVISIONS]);

// ---------------------------------------------------------------- small utilities

/** Whether `value` is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The message of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The detail for a check that cannot even start (setup refused). */
class SetupFailure extends Error {
  detail: string;

  constructor(detail: string) {
    super(detail);
    this.name = 'SetupFailure';
    this.detail = detail;
  }
}

/** The detail of a thrown error: a setup refusal's own words, else the message. */
function detailOf(error: unknown): string {
  return error instanceof SetupFailure ? error.detail : messageOf(error);
}

/** A diagnostic line (never scored). */
function logLine(ctx: CheckContext, line: string): void {
  try {
    ctx.log(line);
  } catch {
    // a logger's trouble is never a check's
  }
}

/** The seeded data every check in this group sends, read from the one scenario. */
interface SeededData {
  /** The scenario seed's first 8 hex characters: the tag that keeps this group's names apart from others'. */
  tag: string;
  repo(part: string): string;
  branch(part: string): string;
  filePath(part: string, which: string): string;
  issue(index: number): { title: string; body: string };
  pull(index: number): { title: string; body: string; head: string; base: string };
  blob(index: number): { path: string; base64: string; content: string };
  commitMessage(index: number): string;
}

/** Build the seeded data from the scenario (see the header). */
function dataFor(scenario: Scenario): SeededData {
  const tag = (typeof scenario.seed === 'string' && scenario.seed !== '' ? scenario.seed : '00000000').slice(0, 8);
  const slug = (part: string): string => part.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return {
    tag,
    repo: (part: string) => `mcp-${tag}-${slug(part)}`,
    branch: (part: string) => `mcp-head-${tag}-${slug(part)}`,
    filePath: (part: string, which: string) => `mcp-${tag}-${slug(part)}-${slug(which)}.txt`,
    issue: (index: number) => scenario.issues[index % scenario.issues.length]!,
    pull: (index: number) => scenario.pulls[index % scenario.pulls.length]!,
    blob: (index: number) => scenario.blobs[index % scenario.blobs.length]!,
    commitMessage: (index: number) => scenario.commits[index % scenario.commits.length]!.message,
  };
}

/** The per-request timeout: the check's own budget, capped at the client's default. */
function requestTimeoutOf(ctx: CheckContext): number {
  const budget = Number.isFinite(ctx.timeoutMs) && ctx.timeoutMs > 0 ? Math.trunc(ctx.timeoutMs) : MCP_DEFAULT_TIMEOUT_MS;
  return Math.max(1, Math.min(budget, MCP_DEFAULT_TIMEOUT_MS));
}

/** A fresh client for this check (its timeout and abort signal are the check's). */
function newClient(ctx: CheckContext): McpClient {
  return new McpClient({ baseUrl: ctx.baseUrl, token: ctx.token, timeoutMs: requestTimeoutOf(ctx), signal: ctx.signal });
}

// ---------------------------------------------------------------- tools and arguments

/** A name normalized for matching: lowercase, every non-alphanumeric removed. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The tool that serves `canonical`: an exact canonical/alias match first, then a tool whose normalized name
 * ends with one (a server prefix such as `github__create_issue`). Null when the server lists none.
 */
export function findTool(tools: readonly McpTool[], canonical: string): McpTool | null {
  const wanted = new Set<string>([canonical, ...(MCP_TOOL_ALIASES[canonical] ?? [])].map(normalizeName));
  const named = tools.filter((tool): tool is McpTool & { name: string } => typeof tool.name === 'string' && tool.name !== '');
  for (const tool of named) if (wanted.has(normalizeName(tool.name))) return tool;
  for (const tool of named) {
    const name = normalizeName(tool.name);
    for (const suffix of wanted) if (name.length > suffix.length && name.endsWith(suffix)) return tool;
  }
  return null;
}

/** The argument names the suite fills, and the schema properties each may be addressed by (normalized). */
const ARGUMENT_SYNONYMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  owner: Object.freeze(['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name']),
  repo: Object.freeze(['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name']),
  repo_full_name: Object.freeze(['full_name', 'repo_full_name', 'repository_full_name', 'fullName']),
  title: Object.freeze(['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']),
  body: Object.freeze(['body', 'issue_body', 'description', 'content', 'text', 'comment']),
  head: Object.freeze(['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch']),
  base: Object.freeze(['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch']),
  pull_number: Object.freeze(['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']),
  name: Object.freeze(['name', 'repo', 'repository', 'repository_name', 'repo_name']),
  description: Object.freeze(['description', 'about', 'summary', 'body']),
  private: Object.freeze(['private', 'is_private']),
  state: Object.freeze(['state', 'status']),
});

interface MappedArguments {
  args: Record<string, unknown>;
  /** The inputSchema's required properties the suite has no value for. */
  missing: string[];
}

/** Map the suite's documented arguments onto a tool's own inputSchema property names. */
function mapArguments(tool: McpTool, semantic: Record<string, unknown>): MappedArguments {
  const schema = isRecord(tool.inputSchema) ? tool.inputSchema : null;
  const properties = schema !== null && isRecord(schema.properties) ? schema.properties : null;
  if (properties === null) return { args: { ...semantic }, missing: [] };
  const byNormalized = new Map<string, string>();
  for (const property of Object.keys(properties)) byNormalized.set(normalizeName(property), property);
  const propertyFor = (key: string): string | null => {
    for (const synonym of ARGUMENT_SYNONYMS[key] ?? [key]) {
      const property = byNormalized.get(normalizeName(synonym));
      if (property !== undefined) return property;
    }
    return null;
  };
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(semantic)) {
    if (value === undefined) continue;
    const property = propertyFor(key);
    if (property !== null) args[property] = value;
  }
  const fullNameProperty = propertyFor('repo_full_name');
  if (propertyFor('repo') === null && fullNameProperty !== null && typeof semantic.owner === 'string' && typeof semantic.repo === 'string') {
    args[fullNameProperty] = `${semantic.owner}/${semantic.repo}`;
  }
  const required = schema !== null && Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === 'string') : [];
  return { args, missing: required.filter((name) => !(name in args)) };
}

/** One mapped tool call, or why it could not be made. */
interface MappedCall {
  toolFound: boolean;
  toolName: string;
  args: Record<string, unknown>;
  missing: string[];
  outcome: McpToolCallOutcome | null;
}

/** Resolve the tool, map the arguments and call it. `allowMissing` calls anyway (the missing-arguments check). */
async function callToolByName(client: McpClient, tools: readonly McpTool[], canonical: string, semantic: Record<string, unknown>, options: McpRequestOptions & { allowMissing?: boolean } = {}): Promise<MappedCall> {
  const tool = findTool(tools, canonical);
  if (tool === null) return { toolFound: false, toolName: canonical, args: {}, missing: [], outcome: null };
  const mapped = mapArguments(tool, semantic);
  const name = tool.name ?? canonical;
  if (mapped.missing.length > 0 && options.allowMissing !== true) return { toolFound: true, toolName: name, args: mapped.args, missing: mapped.missing, outcome: null };
  const outcome = await client.callTool(name, mapped.args, options);
  return { toolFound: true, toolName: name, args: mapped.args, missing: mapped.missing, outcome };
}

/** Why a mapped call could not run, or null. */
function callSetupFailure(call: MappedCall, canonical: string): string | null {
  if (!call.toolFound) return `tools/list lists no ${canonical} tool`;
  if (call.missing.length > 0) return `the ${call.toolName} inputSchema requires ${call.missing.join(', ')}, which the suite has no value for`;
  return null;
}

/** Why a called tool failed, or null: a JSON-RPC error or a tool execution error, as its own words. */
function callFailure(call: MappedCall): string | null {
  const outcome = call.outcome;
  if (outcome === null) return `the ${call.toolName} call was not made`;
  if (outcome.error !== undefined) return `tools/call ${call.toolName} -> JSON-RPC ${outcome.error.code}: ${outcome.error.message}`;
  if (outcome.toolError) return `tools/call ${call.toolName} -> isError: ${resultText(outcome.toolResult).slice(0, 300)}`;
  return null;
}

/** A tool result's text blocks, joined (with structured content when the server sent it). */
function resultText(result: unknown): string {
  if (!isRecord(result)) return '';
  const parts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const block of result.content) if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  if (result.structuredContent !== undefined && result.structuredContent !== null) parts.push(JSON.stringify(result.structuredContent));
  return parts.join('\n');
}

/** The first JSON value a tool result holds (structured content first, else the first JSON in its text). */
function resultJson(result: unknown): unknown {
  if (!isRecord(result)) return null;
  if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent;
  const text = resultText(result).trim();
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // a value wrapped in prose: the outermost braces or brackets
  }
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const from = text.indexOf(open);
    const to = text.lastIndexOf(close);
    if (from >= 0 && to > from) {
      try {
        return JSON.parse(text.slice(from, to + 1)) as unknown;
      } catch {
        // not this one
      }
    }
  }
  return null;
}

/** A number out of a JSON value (`number`/`pull_number`/`id` fields), or null. */
function numberFrom(value: unknown, keys: readonly string[]): number | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const found = value[key];
    if (typeof found === 'number' && Number.isInteger(found)) return found;
    if (typeof found === 'string' && /^\d+$/.test(found)) return Number(found);
  }
  return null;
}

// ---------------------------------------------------------------- the REST side of the setup

interface RestAnswer {
  status: number;
  headers: Headers;
  text: string;
  json: unknown | null;
}

/** Encode one path segment (never a whole path: a contents path keeps its slashes). */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment);
}

/** Encode a repo-relative path segment by segment. */
function encodePath(path: string): string {
  return path.split('/').map(encodeSegment).join('/');
}

/** One REST call against the entry's /api/v3 surface, with the suite's token and the check's abort signal. */
async function restCall(ctx: CheckContext, method: string, path: string, body?: unknown): Promise<RestAnswer> {
  const base = ctx.baseUrl.replace(/\/+$/, '');
  const url = `${base}/api/v3${path}`;
  const controller = new AbortController();
  const timeoutMs = requestTimeoutOf(ctx);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  if (ctx.signal.aborted) throw new SetupFailure(`${method} ${path} was not sent: the check's budget is spent`);
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'makefun-github-core-clone-env' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (ctx.token !== '') headers.authorization = `Bearer ${ctx.token}`;
  try {
    const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, redirect: 'manual' });
    let text = '';
    try {
      text = await response.text();
    } catch (error) {
      if (ctx.signal.aborted) throw new SetupFailure(`${method} ${path}: the check's budget ran out while reading the answer`);
      throw new SetupFailure(`${method} ${path}: reading the answer failed: ${messageOf(error)}`);
    }
    let json: unknown | null = null;
    if (text.trim() !== '') {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = null;
      }
    }
    return { status: response.status, headers: response.headers, text, json };
  } catch (error) {
    if (error instanceof SetupFailure) throw error;
    if (ctx.signal.aborted) throw new SetupFailure(`${method} ${path}: the check's budget ran out`);
    if (controller.signal.aborted) throw new SetupFailure(`${method} ${path} did not answer inside ${timeoutMs} ms`);
    throw new SetupFailure(`${method} ${path} failed: ${messageOf(error)}`);
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

/** The message a REST error body carries, for a detail (never a token). */
function restMessage(json: unknown): string {
  if (isRecord(json) && typeof json.message === 'string' && json.message !== '') return `: ${json.message}`;
  return '';
}

/** Whether a REST status is a success. */
function restOk(status: number): boolean {
  return status >= 200 && status < 300;
}

interface RepoSetup {
  owner: string;
  repo: string;
  defaultBranch: string;
}

/** The token's own login (GET /api/v3/user), falling back on the scenario's viewer when the route refuses. */
async function resolveOwner(ctx: CheckContext): Promise<string> {
  const answer = await restCall(ctx, 'GET', '/user');
  if (answer.status === 200 && isRecord(answer.json) && typeof answer.json.login === 'string' && answer.json.login !== '') return answer.json.login;
  return ctx.scenario.viewer.login;
}

/** Create a repository over REST for a check's setup, and learn its default branch. */
async function createSetupRepo(ctx: CheckContext, name: string): Promise<RepoSetup> {
  const owner = await resolveOwner(ctx);
  const created = await restCall(ctx, 'POST', '/user/repos', { name, private: true, description: 'github-core-clone-01 MCP setup' });
  if (!restOk(created.status)) throw new SetupFailure(`POST /api/v3/user/repos (${name}) -> HTTP ${created.status}${restMessage(created.json)}`);
  let defaultBranch = isRecord(created.json) && typeof created.json.default_branch === 'string' && created.json.default_branch !== '' ? created.json.default_branch : '';
  const view = await restCall(ctx, 'GET', `/repos/${encodeSegment(owner)}/${encodeSegment(name)}`);
  if (defaultBranch === '' && view.status === 200 && isRecord(view.json) && typeof view.json.default_branch === 'string' && view.json.default_branch !== '') defaultBranch = view.json.default_branch;
  return { owner, repo: name, defaultBranch: defaultBranch === '' ? 'main' : defaultBranch };
}

/** A file write through the contents API (create on a branch when `branch` is given); `contentBase64` is wire-ready. */
async function putFile(ctx: CheckContext, setup: RepoSetup, path: string, contentBase64: string, message: string, branch?: string): Promise<RestAnswer> {
  const body: Record<string, unknown> = { message, content: contentBase64 };
  if (branch !== undefined) body.branch = branch;
  return restCall(ctx, 'PUT', `/repos/${encodeSegment(setup.owner)}/${encodeSegment(setup.repo)}/contents/${encodePath(path)}`, body);
}

/** The sha a ref or branch points at (the Git Data and branches views both answer it, in their own shapes). */
async function refSha(ctx: CheckContext, setup: RepoSetup, branch: string): Promise<string | null> {
  for (const path of [`/repos/${encodeSegment(setup.owner)}/${encodeSegment(setup.repo)}/git/refs/heads/${encodeSegment(branch)}`, `/repos/${encodeSegment(setup.owner)}/${encodeSegment(setup.repo)}/branches/${encodeSegment(branch)}`]) {
    const answer = await restCall(ctx, 'GET', path);
    if (answer.status !== 200 || !isRecord(answer.json)) continue;
    const candidates = [isRecord(answer.json.object) ? answer.json.object.sha : undefined, answer.json.sha, isRecord(answer.json.commit) ? answer.json.commit.sha : undefined];
    for (const candidate of candidates) if (typeof candidate === 'string' && candidate !== '') return candidate;
  }
  return null;
}

/** Whether a branch exists (a ref or a branch read answers 200). */
async function branchExists(ctx: CheckContext, setup: RepoSetup, branch: string): Promise<boolean> {
  const paths = [`/repos/${encodeSegment(setup.owner)}/${encodeSegment(setup.repo)}/git/refs/heads/${encodeSegment(branch)}`, `/repos/${encodeSegment(setup.owner)}/${encodeSegment(setup.repo)}/branches/${encodeSegment(branch)}`];
  for (const path of paths) {
    const answer = await restCall(ctx, 'GET', path);
    if (answer.status === 200) return true;
  }
  return false;
}

/** A repository with a base commit and a head branch that carries one commit more. */
interface PullRequestSetup extends RepoSetup {
  base: string;
  head: string;
}

/**
 * Prepare a pull request's setup over REST: create the repository, commit a file on its default branch, then
 * create the head branch — through the Git Data API's POST /git/refs, or (when the server does not serve it)
 * through a contents write on the branch, whichever creates the ref. Both routes are stated in the rules.
 */
async function preparePullRequest(ctx: CheckContext, setup: RepoSetup, data: SeededData, part: string): Promise<PullRequestSetup> {
  const base = setup.defaultBranch;
  const basePath = data.filePath(part, 'base');
  const baseWrite = await putFile(ctx, setup, basePath, data.blob(0).base64, data.commitMessage(0));
  if (!restOk(baseWrite.status)) throw new SetupFailure(`PUT contents/${basePath} -> HTTP ${baseWrite.status}${restMessage(baseWrite.json)} (a PR needs a base commit)`);
  const head = data.branch(part);
  const baseSha = commitSha(baseWrite.json) ?? (await refSha(ctx, setup, base));
  let headReady = false;
  if (baseSha !== null) {
    const ref = await restCall(ctx, 'POST', `/repos/${encodeSegment(setup.owner)}/${encodeSegment(setup.repo)}/git/refs`, { ref: `refs/heads/${head}`, sha: baseSha });
    headReady = restOk(ref.status);
  }
  const headPath = data.filePath(part, 'head');
  if (!headReady) {
    const write = await putFile(ctx, setup, headPath, data.blob(1).base64, data.commitMessage(1), head);
    if (!restOk(write.status)) {
      const refNote = baseSha === null ? 'POST /git/refs: no base commit sha to point it at' : 'POST /git/refs: refused';
      throw new SetupFailure(`could not create the branch ${head} (${refNote}; PUT contents with branch=${head} -> HTTP ${write.status}${restMessage(write.json)})`);
    }
    headReady = await branchExists(ctx, setup, head);
    if (!headReady) throw new SetupFailure(`PUT contents with branch=${head} answered HTTP ${write.status} but the branch does not exist`);
  } else {
    const write = await putFile(ctx, setup, headPath, data.blob(1).base64, data.commitMessage(1), head);
    if (!restOk(write.status)) throw new SetupFailure(`PUT contents/${headPath} on ${head} -> HTTP ${write.status}${restMessage(write.json)}`);
  }
  return { ...setup, base, head };
}

/** A contents answer's commit sha, when it carries one. */
function commitSha(json: unknown): string | null {
  if (!isRecord(json) || !isRecord(json.commit)) return null;
  return typeof json.commit.sha === 'string' && json.commit.sha !== '' ? json.commit.sha : null;
}

/** The issues a list answer holds, whichever shape the server uses. */
function issuesOf(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (isRecord(json) && Array.isArray(json.issues)) return json.issues;
  if (isRecord(json) && Array.isArray(json.items)) return json.items;
  return [];
}

/** The pull requests a list answer holds. */
function pullsOf(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (isRecord(json) && Array.isArray(json.pulls)) return json.pulls;
  if (isRecord(json) && Array.isArray(json.items)) return json.items;
  return [];
}

/** The pull request object at GET /pulls/{number}, or null. */
async function readPull(ctx: CheckContext, setup: RepoSetup, number: number): Promise<unknown | null> {
  const answer = await restCall(ctx, 'GET', `/repos/${encodeSegment(setup.owner)}/${encodeSegment(setup.repo)}/pulls/${number}`);
  return answer.status === 200 ? answer.json : null;
}

/** A pull request's ref name (`head.ref`, `head.label`'s last segment, or `head` itself). */
function refOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return null;
  if (typeof value.ref === 'string') return value.ref;
  if (typeof value.branch === 'string') return value.branch;
  if (typeof value.label === 'string') return value.label.split(':').pop() ?? null;
  return null;
}

/** Find a pull request by number (from the tool result) or, failing that, by title/head in the list. */
async function findPull(ctx: CheckContext, setup: RepoSetup, wanted: { number: number | null; title: string; head: string }): Promise<unknown | null> {
  if (wanted.number !== null) {
    const direct = await readPull(ctx, setup, wanted.number);
    if (direct !== null) return direct;
  }
  const list = await restCall(ctx, 'GET', `/repos/${encodeSegment(setup.owner)}/${encodeSegment(setup.repo)}/pulls?state=all&per_page=100`);
  if (list.status !== 200) return null;
  for (const pull of pullsOf(list.json)) {
    if (!isRecord(pull)) continue;
    if (pull.title === wanted.title || refOf(pull.head) === wanted.head) return pull;
  }
  return null;
}

// ---------------------------------------------------------------- the checks

/** The check list: exactly the 15 the manifest's `mcp` group declares (validateCheckSpecs proves the count). */
export const MCP_CHECKS: readonly CheckSpec[] = Object.freeze([
  {
    id: checkId('mcp', 'initialize'),
    group: MCP_GROUP,
    title: 'initialize: serverInfo.name/version and capabilities.tools, over whichever era the server negotiates',
    async fn(ctx: CheckContext) {
      const client = newClient(ctx);
      try {
        const info: McpConnectionInfo = await client.connect();
        const name = info.serverInfo?.name;
        const version = info.serverInfo?.version;
        if (typeof name !== 'string' || name.trim() === '') return fail(`the server identity has no name (era ${info.era}, revision ${info.protocolVersion})`);
        if (typeof version !== 'string' || version.trim() === '') return fail(`the server identity has no version (era ${info.era}, revision ${info.protocolVersion})`);
        if (!isRecord(info.capabilities.tools)) return fail(`capabilities.tools is missing (era ${info.era}, revision ${info.protocolVersion})`);
        return pass(`${info.era === 'modern' ? 'server/discover' : 'initialize'}: ${name} ${version}, protocol ${info.protocolVersion}, tools capability present`);
      } catch (error) {
        return fail(detailOf(error));
      } finally {
        await client.close();
      }
    },
  },
  {
    id: checkId('mcp', 'server-discover'),
    group: MCP_GROUP,
    title: 'server/discover: a DiscoverResult with supportedVersions, or the pre-discover era',
    async fn(ctx: CheckContext) {
      const client = newClient(ctx);
      try {
        const info: McpConnectionInfo = await client.connect();
        const probe: McpDiscoverAttempt | null = client.discoverAttempt;
        if (info.era === 'modern') {
          if (info.supportedVersions.length === 0) return fail('server/discover answered without a supportedVersions list');
          return pass(`server/discover: supportedVersions ${info.supportedVersions.join(', ')}; negotiated ${info.protocolVersion}`);
        }
        // A pre-discover server may refuse an unknown method in any of its own ways (404, -32601, an HTML 400);
        // what makes it legal is that the initialize handshake then worked, which connect() proved.
        const how = probe === null ? 'no answer' : probe.status === 404 ? 'HTTP 404' : probe.errorCode !== null ? `HTTP ${probe.status ?? 'none'}, JSON-RPC ${probe.errorCode}` : `HTTP ${probe.status ?? 'none'}`;
        return pass(`pre-discover revision (${how}; the server answers initialize)`);
      } catch (error) {
        return fail(detailOf(error));
      } finally {
        await client.close();
      }
    },
  },
  {
    id: checkId('mcp', 'tools-list'),
    group: MCP_GROUP,
    title: 'tools/list: at least six tools, all six required ones present by name or obvious alias',
    async fn(ctx: CheckContext) {
      const client = newClient(ctx);
      try {
        await client.connect();
        const tools = await client.listTools();
        if (tools.length < 6) return fail(`tools/list returned ${tools.length} tools, fewer than six`);
        const found: string[] = [];
        const missing: string[] = [];
        for (const canonical of MCP_REQUIRED_TOOLS) {
          const tool = findTool(tools, canonical);
          if (tool !== null) found.push(`${canonical}->${tool.name}`);
          else missing.push(canonical);
        }
        if (missing.length > 0) return fail(`tools/list is missing ${missing.join(', ')} (${tools.length} tools; found ${found.join(', ') || 'none'})`);
        return pass(`${tools.length} tools; all six present: ${found.join(', ')}`);
      } catch (error) {
        return fail(detailOf(error));
      } finally {
        await client.close();
      }
    },
  },
  {
    id: checkId('mcp', 'tool-schemas'),
    group: MCP_GROUP,
    title: 'every tool has a non-empty description and an inputSchema of type object',
    async fn(ctx: CheckContext) {
      const client = newClient(ctx);
      try {
        await client.connect();
        const tools = await client.listTools();
        if (tools.length === 0) return fail('tools/list returned no tools to inspect');
        const bad: string[] = [];
        for (const tool of tools) {
          const label = typeof tool.name === 'string' && tool.name !== '' ? tool.name : '(unnamed)';
          if (typeof tool.description !== 'string' || tool.description.trim() === '') bad.push(`${label}: no description`);
          if (!isRecord(tool.inputSchema) || tool.inputSchema.type !== 'object') bad.push(`${label}: inputSchema.type is not object`);
        }
        if (bad.length > 0) return fail(`${bad.slice(0, 4).join('; ')}${bad.length > 4 ? ` (+${bad.length - 4} more)` : ''}`);
        return pass(`all ${tools.length} tools have a description and an object inputSchema`);
      } catch (error) {
        return fail(detailOf(error));
      } finally {
        await client.close();
      }
    },
  },
  {
    id: checkId('mcp', 'create-issue'),
    group: MCP_GROUP,
    title: 'tools/call create_issue creates an issue the REST surface lists',
    async fn(ctx: CheckContext) {
      const client = newClient(ctx);
      try {
        await client.connect();
        const tools = await client.listTools();
        const data = dataFor(ctx.scenario);
        const setup = await createSetupRepo(ctx, data.repo('issue-create'));
        const issue = data.issue(0);
        const call = await callToolByName(client, tools, 'create_issue', { owner: setup.owner, repo: setup.repo, title: issue.title, body: issue.body });
        const setupFailure = callSetupFailure(call, 'create_issue');
        if (setupFailure !== null) return fail(setupFailure);
        const failure = callFailure(call);
        if (failure !== null) return fail(failure);
        const listed = await restCall(ctx, 'GET', `/repos/${encodeSegment(setup.owner)}/${encodeSegment(setup.repo)}/issues?state=all&per_page=100`);
        if (listed.status !== 200) return fail(`the REST view of the repository's issues answered HTTP ${listed.status}${restMessage(listed.json)}`);
        const issues = issuesOf(listed.json);
        const found = issues.find((entry) => isRecord(entry) && entry.title === issue.title);
        if (found === undefined) return fail(`the issue created over MCP is not visible over REST (${issues.length} issues listed, none titled "${issue.title}")`);
        return pass(`created issue #${String(isRecord(found) ? found.number : '?')} over MCP; REST lists it with the same title`);
      } catch (error) {
        return fail(detailOf(error));
      } finally {
        await client.close();
      }
    },
  },
  {
    id: checkId('mcp', 'list-issues'),
    group: MCP_GROUP,
    title: 'tools/call list_issues returns an issue the repository holds',
    async fn(ctx: CheckContext) {
      const client = newClient(ctx);
      try {
        await client.connect();
        const tools = await client.listTools();
        const data = dataFor(ctx.scenario);
        const setup = await createSetupRepo(ctx, data.repo('issue-list'));
        const issue = data.issue(1);
        const created = await restCall(ctx, 'POST', `/repos/${encodeSegment(setup.owner)}/${encodeSegment(setup.repo)}/issues`, { title: issue.title, body: issue.body });
        if (!restOk(created.status)) return fail(`POST /api/v3/repos/${setup.owner}/${setup.repo}/issues -> HTTP ${created.status}${restMessage(created.json)}`);
        const number = numberFrom(created.json, ['number']);
        const call = await callToolByName(client, tools, 'list_issues', { owner: setup.owner, repo: setup.repo, state: 'open' });
        const setupFailure = callSetupFailure(call, 'list_issues');
        if (setupFailure !== null) return fail(setupFailure);
        const failure = callFailure(call);
        if (failure !== null) return fail(failure);
        const text = resultText(call.outcome?.toolResult ?? null);
        const foundByTitle = text.includes(issue.title);
        const foundByNumber = number !== null && new RegExp(`"number"\\s*:\\s*${number}(?!\\d)`).test(text);
        if (!foundByTitle && !foundByNumber) return fail(`list_issues did not return ${number === null ? 'the issue' : `issue #${number}`} ("${issue.title}") the repository holds`);
        return pass(`list_issues returned ${number === null ? 'the issue' : `issue #${number}`} (${foundByTitle ? 'by title' : 'by number'})`);
      } catch (error) {
        return fail(detailOf(error));
      } finally {
        await client.close();
      }
    },
  },
  {
    id: checkId('mcp', 'create-pull-request'),
    group: MCP_GROUP,
    title: 'tools/call create_pull_request opens a pull request REST reads back with the same head and base',
    async fn(ctx: CheckContext) {
      const client = newClient(ctx);
      try {
        await client.connect();
        const tools = await client.listTools();
        const data = dataFor(ctx.scenario);
        const setup = await createSetupRepo(ctx, data.repo('pr-create'));
        const prepared = await preparePullRequest(ctx, setup, data, 'pr-create');
        const template = data.pull(0);
        const call = await callToolByName(client, tools, 'create_pull_request', { owner: prepared.owner, repo: prepared.repo, title: template.title, body: template.body, head: prepared.head, base: prepared.base });
        const setupFailure = callSetupFailure(call, 'create_pull_request');
        if (setupFailure !== null) return fail(setupFailure);
        const failure = callFailure(call);
        if (failure !== null) return fail(failure);
        const number = numberFrom(resultJson(call.outcome?.toolResult ?? null), ['number', 'pull_number', 'pull_request_number']);
        const pull = await findPull(ctx, prepared, { number, title: template.title, head: prepared.head });
        if (pull === null || !isRecord(pull)) return fail('the pull request created over MCP is not visible over REST');
        if (refOf(pull.head) !== prepared.head) return fail(`REST reads head ${String(refOf(pull.head))}, not ${prepared.head}`);
        if (refOf(pull.base) !== prepared.base) return fail(`REST reads base ${String(refOf(pull.base))}, not ${prepared.base}`);
        return pass(`pull request #${String(pull.number ?? number ?? '?')} created over MCP; REST reads ${prepared.head} into ${prepared.base}, state ${String(pull.state ?? '?')}`);
      } catch (error) {
        return fail(detailOf(error));
      } finally {
        await client.close();
      }
    },
  },
  {
    id: checkId('mcp', 'merge-pull-request'),
    group: MCP_GROUP,
    title: 'tools/call merge_pull_request merges; REST reads merged:true',
    async fn(ctx: CheckContext) {
      const client = newClient(ctx);
      try {
        await client.connect();
        const tools = await client.listTools();
        const data = dataFor(ctx.scenario);
        const setup = await createSetupRepo(ctx, data.repo('pr-merge'));
        const prepared = await preparePullRequest(ctx, setup, data, 'pr-merge');
        const template = data.pull(1);
        const created = await restCall(ctx, 'POST', `/repos/${encodeSegment(prepared.owner)}/${encodeSegment(prepared.repo)}/pulls`, { title: template.title, head: prepared.head, base: prepared.base });
        if (!restOk(created.status)) return fail(`POST pulls (setup) -> HTTP ${created.status}${restMessage(created.json)}`);
        const number = numberFrom(created.json, ['number']);
        if (number === null) return fail('POST pulls answered no pull request number');
        const call = await callToolByName(client, tools, 'merge_pull_request', { owner: prepared.owner, repo: prepared.repo, pull_number: number });
        const setupFailure = callSetupFailure(call, 'merge_pull_request');
        if (setupFailure !== null) return fail(setupFailure);
        const failure = callFailure(call);
        if (failure !== null) return fail(failure);
        const pull = await readPull(ctx, prepared, number);
        if (!isRecord(pull)) return fail(`REST does not read pull request #${number} after the merge`);
        if (pull.merged !== true) return fail(`REST reads merged=${String(pull.merged)}, state=${String(pull.state)} after merge_pull_request`);
        return pass(`pull request #${number} merged over MCP; REST reads merged:true, state ${String(pull.state ?? '?')}`);
      } catch (error) {
        return fail(detailOf(error));
      } finally {
        await client.close();
      }
    },
  },
  {
    id: checkId('mcp', 'unknown-tool'),
    group: MCP_GROUP,
    title: 'an unknown tool name answers JSON-RPC -32602 or -32601, never HTTP 500',
    async fn(ctx: CheckContext) {
      const client = newClient(ctx);
      try {
        await client.connect();
        const data = dataFor(ctx.scenario);
        const outcome = await client.request('tools/call', { name: `mcp_no_such_tool_${data.tag}`, arguments: {} });
        if (outcome.status === 500) return fail('tools/call with an unknown tool name answered HTTP 500');
        if (outcome.error !== undefined) {
          if (outcome.error.code === JSON_RPC_INVALID_PARAMS || outcome.error.code === -32601) return pass(`HTTP ${outcome.status}, JSON-RPC ${outcome.error.code}: ${outcome.error.message}`);
          return fail(`tools/call with an unknown tool name answered JSON-RPC ${outcome.error.code}: ${outcome.error.message}`);
        }
        return fail(`tools/call with an unknown tool name answered a result (HTTP ${outcome.status}), not a JSON-RPC error`);
      } catch (error) {
        return fail(detailOf(error));
      } finally {
        await client.close();
      }
    },
  },
  {
    id: checkId('mcp', 'parse-error'),
    group: MCP_GROUP,
    title: 'a body that is not JSON answers HTTP 400 with JSON-RPC -32700',
    async fn(ctx: CheckContext) {
      const client = newClient(ctx);
      try {
        const info = await client.connect();
        const answer = await client.postRaw('{"jsonrpc": "2.0", "id": 424242, "method": "tools/list"', { methodHeader: 'tools/list', expectedId: 424242 });
        const code = answer.rpc?.error?.code ?? null;
        if (code === JSON_RPC_PARSE_ERROR && answer.status === 400) return pass('HTTP 400, JSON-RPC -32700 parse error');
        if (code === JSON_RPC_PARSE_ERROR && answer.status === 200 && info.era === 'legacy') return pass('HTTP 200, JSON-RPC -32700 parse error (the pre-2026-07-28 transport status)');
        return fail(`a malformed body answered HTTP ${answer.status}, ${code === null ? 'no JSON-RPC error' : `JSON-RPC ${code}`}`);
      } catch (error) {
        return fail(detailOf(error));
      } finally {
        await client.close();
      }
    },
  },
  {
    id: checkId('mcp', 'missing-arguments'),
    group: MCP_GROUP,
    title: 'tools/call with missing required arguments answers isError:true or JSON-RPC -32602',
    async fn(ctx: CheckContext) {
      const client = newClient(ctx);
      try {
        await client.connect();
        const tools = await client.listTools();
        const call = await callToolByName(client, tools, 'create_issue', {}, { allowMissing: true });
        if (!call.toolFound) return fail('tools/list lists no create_issue tool');
        const outcome = call.outcome;
        if (outcome === null) return fail('the create_issue call was not made');
        if (outcome.error !== undefined) {
          if (outcome.error.code === JSON_RPC_INVALID_PARAMS) return pass('JSON-RPC -32602 invalid params');
          return fail(`tools/call create_issue without required arguments answered JSON-RPC ${outcome.error.code}: ${outcome.error.message}`);
        }
        if (outcome.toolError) return pass('isError:true');
        return fail(`tools/call create_issue with no arguments was accepted (HTTP ${outcome.status}, isError=${String(outcome.toolResult?.isError)})`);
      } catch (error) {
        return fail(detailOf(error));
      } finally {
        await client.close();
      }
    },
  },
  {
    id: checkId('mcp', 'concurrent-calls'),
    group: MCP_GROUP,
    title: 'two concurrent tool calls answer under their own ids and their own objects',
    async fn(ctx: CheckContext) {
      const client = newClient(ctx);
      try {
        await client.connect();
        const tools = await client.listTools();
        const data = dataFor(ctx.scenario);
        const left = await createSetupRepo(ctx, data.repo('concurrent-left'));
        const right = await createSetupRepo(ctx, data.repo('concurrent-right'));
        const leftTool = findTool(tools, 'get_repo');
        if (leftTool === null) return fail('tools/list lists no get_repo tool');
        const leftMapped = mapArguments(leftTool, { owner: left.owner, repo: left.repo });
        const rightMapped = mapArguments(leftTool, { owner: right.owner, repo: right.repo });
        if (leftMapped.missing.length > 0) return fail(`the get_repo inputSchema requires ${leftMapped.missing.join(', ')}, which the suite has no value for`);
        if (rightMapped.missing.length > 0) return fail(`the get_repo inputSchema requires ${rightMapped.missing.join(', ')}, which the suite has no value for`);
        const leftId = `concurrent-left-${data.tag}`;
        const rightId = `concurrent-right-${data.tag}`;
        const [leftAnswer, rightAnswer] = await Promise.all([
          client.callTool(leftTool.name ?? 'get_repo', leftMapped.args, { id: leftId }),
          client.callTool(leftTool.name ?? 'get_repo', rightMapped.args, { id: rightId }),
        ]);
        if (leftAnswer.matchedId !== leftId) return fail(`the answer for id ${leftId} carried id ${String(leftAnswer.matchedId)}`);
        if (rightAnswer.matchedId !== rightId) return fail(`the answer for id ${rightId} carried id ${String(rightAnswer.matchedId)}`);
        if (leftAnswer.error !== undefined || rightAnswer.error !== undefined) return fail(`a concurrent call failed: ${leftAnswer.error?.message ?? rightAnswer.error?.message ?? 'unknown'}`);
        const leftText = resultText(leftAnswer.toolResult);
        const rightText = resultText(rightAnswer.toolResult);
        if (!leftText.includes(left.repo)) return fail(`the answer to ${leftId} does not name ${left.repo}`);
        if (!rightText.includes(right.repo)) return fail(`the answer to ${rightId} does not name ${right.repo}`);
        return pass(`two concurrent tools/call answers kept their ids (${leftId}, ${rightId}) and their own repositories`);
      } catch (error) {
        return fail(detailOf(error));
      } finally {
        await client.close();
      }
    },
  },
  {
    id: checkId('mcp', 'tools-list-idempotent'),
    group: MCP_GROUP,
    title: 'two tools/list answers hold the same tools array, byte for byte',
    async fn(ctx: CheckContext) {
      const client = newClient(ctx);
      try {
        await client.connect();
        const first = await client.listTools();
        const second = await client.listTools();
        if (first.length !== second.length) return fail(`tools/list changed between two calls (${first.length} vs ${second.length} tools)`);
        const left = JSON.stringify(first);
        const right = JSON.stringify(second);
        if (left !== right) return fail(`tools/list changed between two calls (${first.length} tools, a different list)`);
        return pass(`${first.length} tools, byte-identical over two calls`);
      } catch (error) {
        return fail(detailOf(error));
      } finally {
        await client.close();
      }
    },
  },
  {
    id: checkId('mcp', 'rest-parity'),
    group: MCP_GROUP,
    title: 'a repository and an issue created over MCP are the same objects over REST, ids stable',
    async fn(ctx: CheckContext) {
      const client = newClient(ctx);
      try {
        await client.connect();
        const tools = await client.listTools();
        const data = dataFor(ctx.scenario);
        const repoName = data.repo('parity');
        let owner = await resolveOwner(ctx);
        const createdRepo = await callToolByName(client, tools, 'create_repo', { owner, name: repoName, description: ctx.scenario.repos[0]!.description, private: true });
        const setupFailure = callSetupFailure(createdRepo, 'create_repo');
        if (setupFailure !== null) return fail(setupFailure);
        const repoFailure = callFailure(createdRepo);
        if (repoFailure !== null) return fail(repoFailure);
        const repoJson = resultJson(createdRepo.outcome?.toolResult ?? null);
        let repo = repoName;
        const fullName = isRecord(repoJson) && typeof repoJson.full_name === 'string' ? repoJson.full_name : null;
        if (fullName !== null && fullName.includes('/')) {
          const [namedOwner, namedRepo] = fullName.split('/', 2);
          if (namedOwner !== '' && namedRepo !== '') {
            owner = namedOwner;
            repo = namedRepo;
          }
        }
        const repoPath = `/repos/${encodeSegment(owner)}/${encodeSegment(repo)}`;
        const firstRepo = await restCall(ctx, 'GET', repoPath);
        if (firstRepo.status !== 200) return fail(`GET ${repoPath} -> HTTP ${firstRepo.status} after create_repo${restMessage(firstRepo.json)}`);
        const secondRepo = await restCall(ctx, 'GET', repoPath);
        const repoId = isRecord(firstRepo.json) ? firstRepo.json.id : undefined;
        const secondRepoId = isRecord(secondRepo.json) ? secondRepo.json.id : undefined;
        if (repoId === undefined || repoId === null) return fail('the REST repository object has no id');
        if (String(repoId) !== String(secondRepoId)) return fail(`the REST repository id changed between reads (${String(repoId)} then ${String(secondRepoId)})`);
        const issue = data.issue(2);
        const createdIssue = await callToolByName(client, tools, 'create_issue', { owner, repo, title: issue.title, body: issue.body });
        const issueSetupFailure = callSetupFailure(createdIssue, 'create_issue');
        if (issueSetupFailure !== null) return fail(issueSetupFailure);
        const issueFailure = callFailure(createdIssue);
        if (issueFailure !== null) return fail(issueFailure);
        let number = numberFrom(resultJson(createdIssue.outcome?.toolResult ?? null), ['number']);
        if (number === null) {
          const listed = await restCall(ctx, 'GET', `${repoPath}/issues?state=all&per_page=100`);
          if (listed.status === 200) {
            for (const entry of issuesOf(listed.json)) if (isRecord(entry) && entry.title === issue.title && typeof entry.number === 'number') number = entry.number;
          }
        }
        if (number === null) return fail('the issue created over MCP has no number REST can read');
        const issuePath = `${repoPath}/issues/${number}`;
        const firstIssue = await restCall(ctx, 'GET', issuePath);
        if (firstIssue.status !== 200) return fail(`GET ${issuePath} -> HTTP ${firstIssue.status} after create_issue`);
        const secondIssue = await restCall(ctx, 'GET', issuePath);
        const issueId = isRecord(firstIssue.json) ? firstIssue.json.id : undefined;
        const secondIssueId = isRecord(secondIssue.json) ? secondIssue.json.id : undefined;
        const issueReadTitle = isRecord(firstIssue.json) ? firstIssue.json.title : undefined;
        if (issueId === undefined || issueId === null) return fail('the REST issue object has no id');
        if (String(issueId) !== String(secondIssueId)) return fail(`the REST issue id changed between reads (${String(issueId)} then ${String(secondIssueId)})`);
        if (issueReadTitle !== issue.title) return fail(`the REST issue title is ${String(issueReadTitle)}, not ${issue.title}`);
        return pass(`repo ${owner}/${repo} id ${String(repoId)} and issue #${number} id ${String(issueId)} are the same objects over MCP and REST, stable across reads`);
      } catch (error) {
        return fail(detailOf(error));
      } finally {
        await client.close();
      }
    },
  },
  {
    id: checkId('mcp', 'auth-required'),
    group: MCP_GROUP,
    title: 'a tools/call with no Authorization header answers HTTP 401',
    async fn(ctx: CheckContext) {
      const client = newClient(ctx);
      try {
        await client.connect();
        const data = dataFor(ctx.scenario);
        const issue = data.issue(3);
        // The resolved name when the server lists one (a prefixed tool is still the same tool); otherwise the
        // canonical name: authentication is decided before any tool exists, so the refusal must be 401 either way.
        const tools = await client.listTools().catch(() => [] as McpTool[]);
        const name = findTool(tools, 'create_issue')?.name ?? 'create_issue';
        const outcome = await client.callTool(name, { owner: 'no-auth', repo: `no-auth-${data.tag}`, title: issue.title, body: issue.body }, { omitAuth: true });
        if (outcome.status === 401) return pass('unauthenticated tools/call -> HTTP 401');
        return fail(`unauthenticated tools/call -> HTTP ${outcome.status}${outcome.error !== undefined ? ` (JSON-RPC ${outcome.error.code})` : ''}`);
      } catch (error) {
        return fail(detailOf(error));
      } finally {
        await client.close();
      }
    },
  },
]);

/** The 15 check ids, in run order (the manifest's `mcp` group, exactly). */
export const MCP_CHECK_IDS = Object.freeze(MCP_CHECKS.map((check) => check.id));

/** The group module's list under the name the other group modules use. */
export const CHECKS = MCP_CHECKS;

/** Run every MCP check in order, one at a time: the SDK runner's and a local test's convenience. */
export async function runMcpChecks(ctx: CheckContext): Promise<Array<{ id: string; group: string; title: string; result: { ok: boolean; detail?: string } }>> {
  const results: Array<{ id: string; group: string; title: string; result: { ok: boolean; detail?: string } }> = [];
  for (const check of MCP_CHECKS) {
    let result: { ok: boolean; detail?: string };
    try {
      result = await check.fn(ctx);
    } catch (error) {
      result = fail(detailOf(error));
    }
    logLine(ctx, `${check.id}: ${result.ok ? 'pass' : 'fail'}${result.detail === undefined ? '' : ` — ${result.detail}`}`);
    results.push({ id: check.id, group: check.group, title: check.title, result });
  }
  return results;
}
