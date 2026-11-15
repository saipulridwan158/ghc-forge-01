// The GitHub REST v3 conformance checks: the `repos`, `issues` and `pulls` groups, plus the
// REST share of `protocol`. Every check drives the entry's `/api/v3` surface through
// rest-client.ts and returns {ok, detail}; a check never throws and never scores a timing.
//
// The entry is a fresh server each trial and holds no state of its own, so every check creates
// what it needs through the API: a repository (POST /user/repos), its first commit (PUT
// /contents, which an unborn repository accepts), a branch (POST /git/refs) and the commits and
// pull requests above it. Every name, path, blob, message and title comes from wire.ts's one
// seeded scenario (restScenarioOf), so two runs on the same entry and seed send byte-identical
// requests in the same order and reach the same pass/fail bits. No check reads the clock or
// Math.random, and no timing reaches a bit.
//
// One bearer token (wire.ts TOKEN_ENV, MAKEFUN_SHOP_TOKEN) is the viewer's; a repository belongs
// to the login the token names, and the same name under another seeded login (the stranger) is
// not this token's to read.
//
// The endpoint contract these checks require (the exact statuses the rules must state):
//
//   GET    /api/v3/                                     200, JSON, X-OAuth-Scopes header
//   GET    /api/v3/meta                                 200, {"installed_version": string}
//   POST   /api/v3/user/repos                           201 {name, private, default_branch, ...}
//   GET    /api/v3/repos/{o}/{r}                        200 {name, private, default_branch, description}
//                                                       404 {"message": string} when absent
//   PATCH  /api/v3/repos/{o}/{r}                        200, description updated
//   DELETE /api/v3/repos/{o}/{r}                        204, gone afterwards (404)
//   GET    /api/v3/user/repos?per_page=10               200 list, Link: <...>; rel="next"
//   POST   /api/v3/repos/{o}/{r}/git/refs               201 {ref, object:{sha}}   (branch create)
//   GET    /api/v3/repos/{o}/{r}/branches               200 [{name, commit:{sha}}]
//   GET    /api/v3/repos/{o}/{r}/commits[?sha=<ref>]    200 [{sha, commit:{message}}]
//   PUT    /api/v3/repos/{o}/{r}/contents/{path}        201 {content:{sha, encoding}, commit:{sha}}
//                                                       200 on update, 409 on a stale sha
//   GET    /api/v3/repos/{o}/{r}/contents/{path}[?ref=] 200 file {encoding:"base64", content, sha, size}
//                                                       or a directory listing (array) when a directory
//   DELETE /api/v3/repos/{o}/{r}/contents/{path}        200 {commit:{sha}}, 404 afterwards
//   POST   /api/v3/repos/{o}/{r}/labels                 201 {name, color}
//   POST   /api/v3/repos/{o}/{r}/issues                 201 {number, title, body, state, labels}
//                                                       422 on an unknown label
//   GET    /api/v3/repos/{o}/{r}/issues?state=&sort=    200 list, filtered and sorted
//   GET    /api/v3/repos/{o}/{r}/issues/{n}             200 one issue
//   PATCH  /api/v3/repos/{o}/{r}/issues/{n}             200, {state:"closed"} closes
//   POST   /api/v3/repos/{o}/{r}/issues/{n}/comments    201 {id, body}
//   GET    /api/v3/repos/{o}/{r}/issues/{n}/comments    200 list
//   POST   /api/v3/repos/{o}/{r}/pulls                  201 {number, state:"open", head, base}
//   GET    /api/v3/repos/{o}/{r}/pulls?state=all        200 list
//   GET    /api/v3/repos/{o}/{r}/pulls/{n}              200 one pull; 404 when unknown
//   GET    /api/v3/repos/{o}/{r}/pulls/{n}/files        200 [{filename, status, additions, ...}]
//   PUT    /api/v3/repos/{o}/{r}/pulls/{n}/merge        200 {sha, merged:true, message}
//                                                       404 unknown PR, 405 a conflicted PR
//
// Ownership: a repository belongs to the login the token names, so the same repository name
// under another seeded login is 404 (never 403), and a request with no token is 401.
// Protocol: every reply is application/json (never HTML), an unknown route is a JSON 404, a
// malformed JSON request body is a 400, every reply carries a non-empty X-GitHub-Request-Id
// header, and no X-RateLimit-* header is required.

import {
  apiPath,
  b64decode,
  b64encode,
  checkShape,
  describeResponse,
  expectHeader,
  expectJsonResponse,
  expectNoHtml,
  expectStatus,
  isJsonContentType,
  parseLinkHeader,
  RestClient,
  sameOrigin,
  shapes,
  type RestResponse,
  type Shape,
  type StatusExpectation,
} from './rest-client.ts';
import { checkId, type CheckContext, type CheckGroupId, type CheckSpec } from './manifest.ts';
import type { Scenario } from './wire.ts';

type Json = Record<string, unknown>;

/** The manifest groups this module fills. */
export type RestGroup = Extract<CheckGroupId, 'repos' | 'issues' | 'pulls' | 'protocol'>;

/**
 * Everything the checks send, derived from wire.ts's one seeded scenario. Two runs on the same
 * entry and seed build this object identically: no Date, no Math.random, no process values.
 */
export interface RestScenario {
  /** The login the bearer token owns (wire.ts Scenario.viewer). */
  owner: string;
  /** Another user's login, with no rights on the first user's repositories (Scenario.stranger). */
  otherOwner: string;
  /** Every repository a check creates is named from this prefix plus the check id. */
  repoPrefix: string;
  /** The 30 seeded viewer repository names, created for the pagination check (Scenario.repos). */
  paginationRepos: readonly string[];
  /** A repository-relative file path, usable with the contents API (may hold '/'). */
  filePath: string;
  /** A repository-relative directory path, for the directory-listing check. */
  dirPath: string;
  /** The file's seeded contents, and the second revision the update checks commit. */
  fileContent: string;
  fileContentAlt: string;
  /** The commit message every contents commit carries. */
  commitMessage: string;
  /** The base name of the head branches the pull-request checks open from. */
  branchName: string;
  /** Seeded issue and pull text. */
  issueTitle: string;
  issueBody: string;
  commentBody: string;
  pullTitle: string;
  pullBody: string;
  /** An existing label name (the checks create it through POST /labels) and one that never exists. */
  label: string;
  badLabel: string;
  /** Seeded repository descriptions, before and after the PATCH check. */
  description: string;
  descriptionAlt: string;
}

/** Derive the strings the checks send from wire.ts's scenario; pure and deterministic. */
export function restScenarioOf(scenario: Scenario): RestScenario {
  const first = scenario.repos[0];
  const blobA = scenario.blobs[0];
  const blobB = scenario.blobs[1] ?? scenario.blobs[0];
  const issue = scenario.issues[0];
  const issueAlt = scenario.issues[1] ?? scenario.issues[0];
  const pull = scenario.pulls[0];
  if (first === undefined || blobA === undefined || blobB === undefined || issue === undefined || issueAlt === undefined || pull === undefined) {
    throw new Error('wire.ts buildScenario() returned an empty repos, blobs, issues or pulls list');
  }
  const dirBlob = scenario.blobs.find((blob) => blob.path.includes('/'));
  const dirPath = dirBlob === undefined ? 'src' : dirBlob.path.slice(0, dirBlob.path.lastIndexOf('/'));
  const branchName = scenario.branches.find((name) => name !== first.defaultBranch && !name.endsWith('/')) ?? 'feature';
  const label = scenario.labels[0] ?? 'bug';
  return {
    owner: scenario.viewer.login,
    otherOwner: scenario.stranger.login,
    repoPrefix: first.name,
    paginationRepos: scenario.repos.map((repo) => repo.name),
    filePath: blobA.path,
    dirPath,
    fileContent: blobA.content,
    fileContentAlt: blobB.content,
    commitMessage: scenario.commits[0]?.message ?? 'seeded commit',
    branchName,
    issueTitle: issue.title,
    issueBody: issue.body,
    commentBody: issueAlt.body,
    pullTitle: pull.title,
    pullBody: pull.body,
    label,
    badLabel: `${label}-not-a-label`,
    description: first.description,
    descriptionAlt: `${first.description} (updated)`,
  };
}

/** One check's body: it runs against the clients the runner builds from the manifest CheckContext. */
interface RestDefinition {
  slug: string;
  group: RestGroup;
  title: string;
  run: (set: ClientSet) => Promise<void>;
}

/**
 * The `repos`, `issues` and `pulls` checks: 15 + 15 + 20, one point each in the manifest's
 * group maxima. `repos.pagination` runs first: it creates the 30 seeded repositories and walks
 * the viewer's whole list, so the fewer repositories other checks have made by then the tighter
 * the count (the check itself needs only that all 30 are reachable through the Link chain).
 */
export function restChecks(): CheckSpec[] {
  return [
    check('repos', 'pagination', 'GET /user/repos pages 30 seeded repos at per_page=10 through Link rel="next"', reposPagination),
    check('repos', 'root', 'GET /api/v3/ answers 200 JSON with X-OAuth-Scopes', reposRoot),
    check('repos', 'meta', 'GET /api/v3/meta reports installed_version', reposMeta),
    check('repos', 'create', 'POST /user/repos creates and GET round-trips name, private and default_branch', reposCreate),
    check('repos', 'not-found', 'GET a missing repository is a JSON 404', reposNotFound),
    check('repos', 'patch', 'PATCH /repos/{o}/{r} updates the description', reposPatch),
    check('repos', 'delete', 'DELETE /repos/{o}/{r} deletes it and a later GET is 404', reposDelete),
    check('repos', 'branches', 'GET /branches lists a branch created through POST /git/refs', reposBranches),
    check('repos', 'commits', 'GET /commits reflects a commit made on a branch and not the default branch', reposCommits),
    check('repos', 'unauthorized', 'a request without a token is 401', reposUnauthorized),
    check('repos', 'foreign-token', 'the same repository name under another owner is a 404 for this token', reposForeignToken),
    check('repos', 'contents-create', 'PUT /contents creates a file with a commit; GET returns base64 content and sha', reposContentsCreate),
    check('repos', 'contents-directory', 'GET /contents on a directory lists its entries', reposContentsDirectory),
    check('repos', 'contents-stale-sha', 'PUT /contents with a stale sha is 409', reposContentsStaleSha),
    check('repos', 'contents-delete', 'DELETE /contents removes the file with a commit and GET is 404', reposContentsDelete),

    check('issues', 'create', 'POST /issues creates a 201 open issue with a number', issuesCreate),
    check('issues', 'create-title-body', 'POST /issues echoes the title and body', issuesCreateTitleBody),
    check('issues', 'create-labels', 'POST /issues attaches an existing label', issuesCreateLabels),
    check('issues', 'numbers-increment', 'issue numbers increment by one', issuesNumbersIncrement),
    check('issues', 'list-open', 'GET /issues?state=open lists the open issue', issuesListOpen),
    check('issues', 'list-open-excludes-closed', 'GET /issues?state=open omits a closed issue', issuesListOpenExcludesClosed),
    check('issues', 'list-sort-asc', 'GET /issues?sort=created&direction=asc orders by creation', issuesListSortAsc),
    check('issues', 'list-sort-desc', 'GET /issues?sort=created&direction=desc reverses it', issuesListSortDesc),
    check('issues', 'list-shape', 'GET /issues returns the GitHub issue shape', issuesListShape),
    check('issues', 'get-one', 'GET /issues/{n} returns the issue', issuesGetOne),
    check('issues', 'patch-close', 'PATCH /issues/{n} closes it', issuesPatchClose),
    check('issues', 'patch-close-persists', 'the close survives a later GET', issuesPatchClosePersists),
    check('issues', 'comment-create', 'POST /issues/{n}/comments creates a comment', issuesCommentCreate),
    check('issues', 'comments-list', 'GET /issues/{n}/comments lists the comment', issuesCommentsList),
    check('issues', 'bad-label', 'POST /issues with an unknown label is 422', issuesBadLabel),

    check('pulls', 'create', 'POST /pulls creates an open pull request from a head branch', pullsCreate),
    check('pulls', 'create-body', 'POST /pulls echoes the title and body', pullsCreateBody),
    check('pulls', 'create-head-sha', 'the pull head.sha is the head branch tip', pullsCreateHeadSha),
    check('pulls', 'create-base-sha', 'the pull base.sha is the base branch tip', pullsCreateBaseSha),
    check('pulls', 'get-one', 'GET /pulls/{n} returns the pull request', pullsGetOne),
    check('pulls', 'files-list', 'GET /pulls/{n}/files lists the changed path', pullsFilesList),
    check('pulls', 'files-shape', 'pull files carry filename, status and the change counts', pullsFilesShape),
    check('pulls', 'files-multiple', 'GET /pulls/{n}/files lists every changed path', pullsFilesMultiple),
    check('pulls', 'merge-status', 'PUT /pulls/{n}/merge with merge_method=squash is 200', pullsMergeStatus),
    check('pulls', 'merge-body', 'the merge reply is {merged:true, sha, message}', pullsMergeBody),
    check('pulls', 'merge-closes', 'the merged pull is closed, merged and carries merged_at', pullsMergeCloses),
    check('pulls', 'merge-commit-on-default', 'the merge commit appears on the default branch', pullsMergeCommitOnDefault),
    check('pulls', 'merge-content-on-default', 'the squash content is on the default branch', pullsMergeContentOnDefault),
    check('pulls', 'merge-commit-sha', 'the pull reports merge_commit_sha equal to the merge sha', pullsMergeCommitSha),
    check('pulls', 'merge-unknown', 'merging an unknown pull request is 404', pullsMergeUnknown),
    check('pulls', 'merge-conflict', 'merging a conflicted pull request is 405', pullsMergeConflict),
    check('pulls', 'list-state-all', 'GET /pulls?state=all lists open and merged pull requests', pullsListStateAll),
    check('pulls', 'list-default-open', 'GET /pulls defaults to open pull requests', pullsListDefaultOpen),
    check('pulls', 'list-shape', 'GET /pulls returns the GitHub pull-request shape', pullsListShape),
    check('pulls', 'get-unknown', 'GET an unknown pull request is 404', pullsGetUnknown),
  ].map(spec);
}

/**
 * The REST share of the `protocol` group (5 of the manifest's 10): JSON content types, a JSON
 * 404 for unknown routes, a 400 for a malformed body, the request-id header, and the
 * `{message}` error shape. The rate-limit headers are deliberately not required.
 */
export function restProtocolChecks(): CheckSpec[] {
  return [
    check('protocol', 'content-type-json', 'every REST reply is application/json, never HTML', protocolContentType),
    check('protocol', 'unknown-route-json-404', 'an unknown /api/v3 route is a JSON 404', protocolUnknownRoute),
    check('protocol', 'malformed-body-400', 'a malformed JSON body is a 400', protocolMalformedBody),
    check('protocol', 'request-id', 'every reply carries a non-empty X-GitHub-Request-Id', protocolRequestId),
    check('protocol', 'error-message', '401, 404 and 422 bodies carry a string message', protocolErrorMessage),
  ].map(spec);
}

/** Build one definition; ids are `<group>.<slug>` through the manifest's own checkId. */
function check(group: RestGroup, slug: string, title: string, run: (set: ClientSet) => Promise<void>): RestDefinition {
  return { slug, group, title, run };
}

/** A definition as the manifest CheckSpec the runner collects and validates. */
function spec(definition: RestDefinition): CheckSpec {
  return {
    id: checkId(definition.group, definition.slug),
    group: definition.group,
    title: definition.title,
    fn: (context: CheckContext) => runDefinition(context, definition),
  };
}

// ---------------------------------------------------------------------------------------------
// Plumbing

class CheckFailure extends Error {}

function fail(detail: string): never {
  throw new CheckFailure(detail);
}

/** Turn a helper's detail (null on success) into a failed check. */
function expect(detail: string | null): void {
  if (detail !== null) throw new CheckFailure(detail);
}

function clip(text: string, max = 600): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

interface ClientSet {
  scenario: RestScenario;
  owner: string;
  otherOwner: string;
  baseUrl: string;
  client: RestClient;
  anon: RestClient;
}

function clientSet(context: CheckContext): ClientSet {
  const timeoutMs = Math.max(1_000, Math.min(context.timeoutMs, 5_000));
  const scenario = restScenarioOf(context.scenario);
  const shared = { baseUrl: context.baseUrl, timeoutMs, signal: context.signal };
  return {
    scenario,
    owner: scenario.owner,
    otherOwner: scenario.otherOwner,
    baseUrl: context.baseUrl,
    client: new RestClient({ ...shared, token: context.token }),
    anon: new RestClient({ ...shared, token: null }),
  };
}

/** Run one definition against a fresh client set; a throw is a failure, never a crash. */
async function runDefinition(context: CheckContext, definition: RestDefinition): Promise<{ ok: boolean; detail: string }> {
  try {
    await definition.run(clientSet(context));
    return { ok: true, detail: `${definition.title}: ok` };
  } catch (err) {
    if (err instanceof CheckFailure) return { ok: false, detail: clip(err.message) };
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { ok: false, detail: clip(`${definition.slug}: threw ${message}`) };
  }
}

const SHA40 = /^[0-9a-f]{40}$/i;
const shaShape = (): Shape => shapes.string({ nonEmpty: true, pattern: SHA40 });
const messageShape = (): Shape => shapes.object({ message: shapes.string({ nonEmpty: true }) });
const labelShape = (): Shape => shapes.object({ name: shapes.string({ nonEmpty: true }) });

function slug(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** A repository name for one check, from the seeded prefix; never longer than GitHub's limit. */
function repoName(set: ClientSet, id: string): string {
  const name = `${set.scenario.repoPrefix}-${slug(id)}`;
  return name.length <= 100 ? name : name.slice(0, 100);
}

/** The 30 seeded viewer repository names the pagination check creates. */
function paginationNames(set: ClientSet): readonly string[] {
  return set.scenario.paginationRepos;
}

/** `docs/readme.md` + `alt` -> `docs/readme-alt.md`; a path with no extension -> `docs/readme-alt`. */
function variantPath(path: string, suffix: string): string {
  const slash = path.lastIndexOf('/');
  const dir = slash === -1 ? '' : path.slice(0, slash + 1);
  const base = slash === -1 ? path : path.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot <= 0 ? base : base.slice(0, dot);
  const ext = dot <= 0 ? '' : base.slice(dot);
  return `${dir}${stem}-${suffix}${ext}`;
}

function lower(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function numberField(object: Json, field: string): number {
  const value = object[field];
  return typeof value === 'number' ? value : Number.NaN;
}

function stringField(object: Json, field: string): string {
  const value = object[field];
  return typeof value === 'string' ? value : '';
}

function objectBody(response: RestResponse, label: string): Json {
  const value = response.body;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label}: expected a JSON object body`);
  return value as Json;
}

function arrayBody(response: RestResponse, label: string): Json[] {
  const value = response.body;
  if (!Array.isArray(value)) fail(`${label}: expected a JSON array body`);
  return value as Json[];
}

// ---------------------------------------------------------------------------------------------
// Repository and content fixtures

interface RepoRef {
  owner: string;
  name: string;
  /** `/api/v3/repos/<owner>/<name>` */
  path: string;
  /** The branch the entry reports, read back after the first commit. */
  defaultBranch: string;
  /** The tip of the default branch after the initial file commit. */
  initialCommitSha: string;
}

interface ContentCommit {
  commitSha: string;
  contentSha: string;
}

const contentCommitShape = (): Shape =>
  shapes.object({
    content: shapes.object({ sha: shaShape(), encoding: shapes.string({ oneOf: ['base64'] }) }),
    commit: shapes.object({ sha: shaShape() }),
  });

/** Create a repository and its first commit through PUT /contents (an unborn repository accepts it). */
async function prepareRepo(set: ClientSet, id: string, options: { private?: boolean; description?: string; filePath?: string; content?: string } = {}): Promise<RepoRef> {
  const name = repoName(set, id);
  const created = await set.client.post(apiPath('user', 'repos'), {
    body: { name, private: options.private ?? true, description: options.description ?? set.scenario.description },
  });
  expect(expectJsonResponse(created, 201, shapes.object({ name: shapes.string({ oneOf: [name] }), private: shapes.boolean() }), `POST /api/v3/user/repos (${name})`));
  const path = apiPath('repos', set.owner, name);
  const put = await putContent(set, { owner: set.owner, name }, { filePath: options.filePath ?? set.scenario.filePath, content: options.content ?? set.scenario.fileContent, message: set.scenario.commitMessage });
  const commit = contentCommit(put, `PUT ${path}/contents/${options.filePath ?? set.scenario.filePath}`);
  const got = await set.client.get(path);
  expect(expectJsonResponse(got, 200, shapes.object({ default_branch: shapes.string({ nonEmpty: true }) }), `GET ${path}`));
  const defaultBranch = stringField(objectBody(got, `GET ${path}`), 'default_branch');
  return { owner: set.owner, name, path, defaultBranch, initialCommitSha: commit.commitSha };
}

/** One contents PUT, unasserted; callers pick the expected status. */
async function putContent(
  set: ClientSet,
  repo: { owner: string; name: string },
  options: { filePath: string; content: string; message: string; branch?: string; sha?: string },
): Promise<RestResponse> {
  const body: Json = { message: options.message, content: b64encode(options.content) };
  if (options.branch !== undefined) body.branch = options.branch;
  if (options.sha !== undefined) body.sha = options.sha;
  return set.client.put(apiPath('repos', repo.owner, repo.name, 'contents', options.filePath), { body });
}

function contentCommit(response: RestResponse, label: string, expected: StatusExpectation = 201): ContentCommit {
  expect(expectJsonResponse(response, expected, contentCommitShape(), label));
  const body = objectBody(response, label);
  const content = body.content as Json;
  const commit = body.commit as Json;
  return { commitSha: stringField(commit, 'sha'), contentSha: stringField(content, 'sha') };
}

interface ContentEntry {
  sha: string;
  content: string;
  size: number;
}

/** GET one file's contents, asserting the file shape. */
async function getContent(set: ClientSet, repo: { owner: string; name: string; path: string }, filePath: string, ref?: string): Promise<ContentEntry> {
  const path = apiPath('repos', repo.owner, repo.name, 'contents', filePath);
  const response = await set.client.get(path, ref === undefined ? {} : { query: { ref } });
  const label = `GET ${path}${ref === undefined ? '' : `?ref=${ref}`}`;
  expect(
    expectJsonResponse(
      response,
      200,
      shapes.object({
        type: shapes.string({ oneOf: ['file'] }),
        encoding: shapes.string({ oneOf: ['base64'] }),
        content: shapes.string(),
        sha: shaShape(),
        size: shapes.number({ integer: true, min: 0 }),
      }),
      label,
    ),
  );
  const body = objectBody(response, label);
  return { sha: stringField(body, 'sha'), content: stringField(body, 'content'), size: numberField(body, 'size') };
}

/** POST /repos/{o}/{r}/git/refs: create a branch at `sha`. */
async function createBranch(set: ClientSet, repo: RepoRef, branch: string, sha: string): Promise<void> {
  const path = `${repo.path}/git/refs`;
  const response = await set.client.post(path, { body: { ref: `refs/heads/${branch}`, sha } });
  expect(
    expectJsonResponse(
      response,
      201,
      shapes.object({ ref: shapes.string({ oneOf: [`refs/heads/${branch}`] }), object: shapes.object({ sha: shaShape() }) }),
      `POST ${path} (${branch})`,
    ),
  );
}

/** Commit one file on a branch through PUT /contents with `branch`; `update` sends the blob sha. */
async function commitOnBranch(set: ClientSet, repo: RepoRef, options: { branch: string; filePath: string; content: string; message: string; update?: boolean }): Promise<ContentCommit> {
  const sha = options.update === true ? (await getContent(set, repo, options.filePath, options.branch)).sha : undefined;
  const response = await putContent(set, repo, { filePath: options.filePath, content: options.content, message: options.message, branch: options.branch, sha });
  return contentCommit(response, `PUT ${repo.path}/contents/${options.filePath}?branch=${options.branch}`, options.update === true ? [200, 201] : 201);
}

const pullShape = (): Shape =>
  shapes.object({
    number: shapes.number({ integer: true, min: 1 }),
    state: shapes.string({ oneOf: ['open', 'closed'] }),
    title: shapes.string(),
    body: shapes.string(),
    head: shapes.object({ ref: shapes.string({ nonEmpty: true }), sha: shaShape() }),
    base: shapes.object({ ref: shapes.string({ nonEmpty: true }), sha: shaShape() }),
  });

async function createPull(set: ClientSet, repo: RepoRef, input: { head: string; base: string; title: string; body: string }): Promise<Json> {
  const response = await set.client.post(`${repo.path}/pulls`, { body: input });
  const label = `POST ${repo.path}/pulls (head ${input.head})`;
  expect(expectJsonResponse(response, 201, pullShape(), label));
  return objectBody(response, label);
}

async function mergePull(set: ClientSet, repo: RepoRef, number: number): Promise<RestResponse> {
  return set.client.put(`${repo.path}/pulls/${number}/merge`, { body: { merge_method: 'squash' } });
}

interface PullFixture {
  repo: RepoRef;
  head: string;
  base: string;
  number: number;
  headCommitSha: string;
  changedPaths: string[];
}

/** A repository with a head branch one commit ahead of the default branch, and an open PR from it. */
async function preparePull(set: ClientSet, id: string, files?: readonly { path: string; content: string }[]): Promise<PullFixture> {
  const repo = await prepareRepo(set, id);
  const head = `${set.scenario.branchName}-${slug(id)}`;
  await createBranch(set, repo, head, repo.initialCommitSha);
  const changes = files ?? [{ path: variantPath(set.scenario.filePath, slug(id)), content: set.scenario.fileContentAlt }];
  let headCommitSha = repo.initialCommitSha;
  for (const change of changes) {
    const commit = await commitOnBranch(set, repo, { branch: head, filePath: change.path, content: change.content, message: `${set.scenario.commitMessage} (${slug(id)})` });
    headCommitSha = commit.commitSha;
  }
  const pull = await createPull(set, repo, { head, base: repo.defaultBranch, title: set.scenario.pullTitle, body: set.scenario.pullBody });
  return { repo, head, base: repo.defaultBranch, number: numberField(pull, 'number'), headCommitSha, changedPaths: changes.map((change) => change.path) };
}

/** The number of a pull request created for a second branch of the same repository. */
async function secondBranchPull(set: ClientSet, repo: RepoRef, id: string): Promise<number> {
  const head = `${set.scenario.branchName}-${slug(id)}-b`;
  await createBranch(set, repo, head, repo.initialCommitSha);
  await commitOnBranch(set, repo, { branch: head, filePath: variantPath(set.scenario.filePath, `${slug(id)}-b`), content: set.scenario.fileContentAlt, message: `${set.scenario.commitMessage} (${slug(id)}-b)` });
  const pull = await createPull(set, repo, { head, base: repo.defaultBranch, title: set.scenario.pullTitle, body: set.scenario.pullBody });
  return numberField(pull, 'number');
}

// ---------------------------------------------------------------------------------------------
// Issues and labels

const issueShape = (): Shape =>
  shapes.object({
    number: shapes.number({ integer: true, min: 1 }),
    title: shapes.string(),
    body: shapes.string(),
    state: shapes.string({ oneOf: ['open', 'closed'] }),
    labels: shapes.array(labelShape()),
  });

interface IssueFixture {
  repo: RepoRef;
  label: string;
}

async function prepareIssueRepo(set: ClientSet, id: string): Promise<IssueFixture> {
  const repo = await prepareRepo(set, id);
  const label = set.scenario.label;
  const response = await set.client.post(`${repo.path}/labels`, { body: { name: label, color: 'ededed' } });
  expect(expectJsonResponse(response, 201, labelShape(), `POST ${repo.path}/labels (${label})`));
  return { repo, label };
}

async function createIssue(set: ClientSet, repo: RepoRef, input: { title: string; body: string; labels?: readonly string[] }): Promise<Json> {
  const response = await set.client.post(`${repo.path}/issues`, { body: input });
  const label = `POST ${repo.path}/issues (${input.title})`;
  expect(expectJsonResponse(response, 201, issueShape(), label));
  return objectBody(response, label);
}

async function listIssues(set: ClientSet, repo: RepoRef, query: Readonly<Record<string, string | number>>): Promise<Json[]> {
  const response = await set.client.get(`${repo.path}/issues`, { query });
  const rendered = Object.entries(query).map(([key, value]) => `${key}=${value}`).join('&');
  const label = `GET ${repo.path}/issues${rendered === '' ? '' : `?${rendered}`}`;
  expect(expectJsonResponse(response, 200, shapes.array(issueShape()), label));
  return arrayBody(response, label);
}

async function setIssueState(set: ClientSet, repo: RepoRef, number: number, state: 'open' | 'closed'): Promise<Json> {
  const response = await set.client.patch(`${repo.path}/issues/${number}`, { body: { state } });
  const label = `PATCH ${repo.path}/issues/${number} {state:${state}}`;
  expect(expectJsonResponse(response, 200, shapes.object({ number: shapes.number({ integer: true, min: 1 }), state: shapes.string({ oneOf: [state] }) }), label));
  return objectBody(response, label);
}

function issueNumber(issue: Json): number {
  return numberField(issue, 'number');
}

function positionOf(list: readonly Json[], number: number): number {
  return list.findIndex((item) => issueNumber(item) === number);
}

// ---------------------------------------------------------------------------------------------
// repos (15)

async function reposRoot(set: ClientSet): Promise<void> {
  const response = await set.client.get(`${apiPath()}/`);
  const label = 'GET /api/v3/';
  expect(expectJsonResponse(response, 200, shapes.looseObject(), label));
  expect(expectHeader(response, 'x-oauth-scopes', label));
}

async function reposMeta(set: ClientSet): Promise<void> {
  const response = await set.client.get(apiPath('meta'));
  expect(expectJsonResponse(response, 200, shapes.object({ installed_version: shapes.string({ nonEmpty: true }) }), 'GET /api/v3/meta'));
}

async function reposCreate(set: ClientSet): Promise<void> {
  const name = repoName(set, 'repos-create');
  const path = apiPath('repos', set.owner, name);
  const created = await set.client.post(apiPath('user', 'repos'), { body: { name, private: true, description: set.scenario.description } });
  expect(expectJsonResponse(created, 201, shapes.object({ name: shapes.string({ oneOf: [name] }), private: shapes.boolean() }), `POST /api/v3/user/repos (${name})`));
  const createdBody = objectBody(created, 'POST /api/v3/user/repos');
  if (createdBody.private !== true) fail(`POST /api/v3/user/repos (${name}) body.private: expected true, got ${JSON.stringify(createdBody.private)}`);

  const first = await set.client.get(path);
  expect(expectJsonResponse(first, 200, shapes.object({ name: shapes.string(), private: shapes.boolean(), default_branch: shapes.string({ nonEmpty: true }) }), `GET ${path}`));
  const repo = objectBody(first, `GET ${path}`);
  if (repo.name !== name) fail(`GET ${path} body.name: expected ${JSON.stringify(name)}, got ${JSON.stringify(repo.name)}`);
  if (repo.private !== true) fail(`GET ${path} body.private: expected true, got ${JSON.stringify(repo.private)}`);
  const defaultBranch = stringField(repo, 'default_branch');

  const second = await set.client.get(path);
  expect(expectJsonResponse(second, 200, shapes.object({ default_branch: shapes.string({ nonEmpty: true }) }), `GET ${path} (second read)`));
  const again = stringField(objectBody(second, `GET ${path} (second read)`), 'default_branch');
  if (again !== defaultBranch) fail(`GET ${path} body.default_branch changed between reads: ${JSON.stringify(defaultBranch)} then ${JSON.stringify(again)}`);
}

async function reposNotFound(set: ClientSet): Promise<void> {
  const missing = `${set.scenario.repoPrefix}-never-created`;
  const path = apiPath('repos', set.owner, missing);
  const response = await set.client.get(path);
  expect(expectJsonResponse(response, 404, messageShape(), `GET ${path}`));
}

async function reposPatch(set: ClientSet): Promise<void> {
  const repo = await prepareRepo(set, 'repos-patch');
  const patched = await set.client.patch(repo.path, { body: { description: set.scenario.descriptionAlt } });
  expect(expectJsonResponse(patched, 200, shapes.object({ description: shapes.string({ oneOf: [set.scenario.descriptionAlt] }) }), `PATCH ${repo.path}`));
  const read = await set.client.get(repo.path);
  expect(expectJsonResponse(read, 200, shapes.object({ description: shapes.string({ oneOf: [set.scenario.descriptionAlt] }) }), `GET ${repo.path} after PATCH`));
}

async function reposDelete(set: ClientSet): Promise<void> {
  const repo = await prepareRepo(set, 'repos-delete');
  const deleted = await set.client.delete(repo.path);
  expect(expectStatus(deleted, 204, `DELETE ${repo.path}`));
  const after = await set.client.get(repo.path);
  expect(expectJsonResponse(after, 404, messageShape(), `GET ${repo.path} after DELETE`));
}

async function reposPagination(set: ClientSet): Promise<void> {
  const names = paginationNames(set);
  for (const name of names) {
    const created = await set.client.post(apiPath('user', 'repos'), { body: { name, private: true, description: set.scenario.description } });
    // A 422 means an earlier group already created this seeded repository: the list below is
    // what the check is about, so accept it as long as the repository is there to be listed.
    if (created.status === 201) {
      expect(expectJsonResponse(created, 201, shapes.object({ name: shapes.string({ oneOf: [name] }) }), `POST /api/v3/user/repos (${name})`));
    } else if (created.status !== 422) {
      fail(`POST /api/v3/user/repos (${name}): expected status 201, got ${describeResponse(created)}`);
    }
    const present = await set.client.get(apiPath('repos', set.owner, name));
    expect(expectJsonResponse(present, 200, shapes.object({ name: shapes.string({ oneOf: [name] }) }), `GET /api/v3/repos/${set.owner}/${name}`));
  }

  const seen: string[] = [];
  const pageSizes: number[] = [];
  let next: string | null = set.client.url(apiPath('user', 'repos'), { per_page: 10 });
  for (let page = 1; next !== null; page += 1) {
    if (page > 20) fail('pagination did not end within 20 pages');
    if (!sameOrigin(next, set.baseUrl)) fail(`Link rel="next" left the entry's origin: ${next}`);
    const response: RestResponse = await set.client.get(next);
    const label = `GET ${next}`;
    expect(expectJsonResponse(response, 200, shapes.array(shapes.object({ name: shapes.string({ nonEmpty: true }) })), label));
    const items = arrayBody(response, label);
    if (items.length > 10) fail(`${label}: returned ${items.length} repositories with per_page=10`);
    pageSizes.push(items.length);
    for (const item of items) seen.push(stringField(item, 'name'));
    next = parseLinkHeader(response.headers.get('link')).next;
  }

  const unique = new Set(seen);
  if (unique.size !== seen.length) fail(`the followed pages repeated a repository (${seen.length} entries, ${unique.size} distinct)`);
  const missing = names.filter((name) => !unique.has(name));
  if (missing.length > 0) fail(`the followed pages are missing ${missing.length} of the 30 created repositories (first: ${JSON.stringify(missing[0])})`);
  if (pageSizes.length < 3) fail(`30 repositories at per_page=10 were served in ${pageSizes.length} page(s), expected at least 3`);
}

async function reposBranches(set: ClientSet): Promise<void> {
  const repo = await prepareRepo(set, 'repos-branches');
  const branch = `${set.scenario.branchName}-branches`;
  await createBranch(set, repo, branch, repo.initialCommitSha);
  const response = await set.client.get(`${repo.path}/branches`);
  const label = `GET ${repo.path}/branches`;
  expect(expectJsonResponse(response, 200, shapes.array(shapes.object({ name: shapes.string({ nonEmpty: true }), commit: shapes.object({ sha: shaShape() }) })), label));
  const branches = arrayBody(response, label);
  const names = branches.map((entry) => stringField(entry, 'name'));
  if (!names.includes(branch)) fail(`${label}: does not list ${JSON.stringify(branch)} (got ${JSON.stringify(names)})`);
  if (!names.includes(repo.defaultBranch)) fail(`${label}: does not list the default branch ${JSON.stringify(repo.defaultBranch)}`);
  const found = branches.find((entry) => stringField(entry, 'name') === branch);
  const sha = lower(((found?.commit ?? {}) as Json).sha);
  if (sha !== lower(repo.initialCommitSha)) fail(`${label}: ${branch} points at ${JSON.stringify(sha)}, expected ${JSON.stringify(repo.initialCommitSha)}`);
}

async function reposCommits(set: ClientSet): Promise<void> {
  const repo = await prepareRepo(set, 'repos-commits');
  const branch = `${set.scenario.branchName}-commits`;
  await createBranch(set, repo, branch, repo.initialCommitSha);
  const filePath = variantPath(set.scenario.filePath, 'commits');
  const commit = await commitOnBranch(set, repo, { branch, filePath, content: set.scenario.fileContentAlt, message: `${set.scenario.commitMessage} (commits)` });

  const label = `GET ${repo.path}/commits?sha=${branch}`;
  const response = await set.client.get(`${repo.path}/commits`, { query: { sha: branch } });
  expect(expectJsonResponse(response, 200, shapes.array(shapes.object({ sha: shaShape(), commit: shapes.object({ message: shapes.string() }) })), label));
  const commits = arrayBody(response, label);
  const found = commits.find((entry) => lower(entry.sha) === lower(commit.commitSha));
  if (found === undefined) fail(`${label}: does not list the commit ${commit.commitSha} created on ${branch}`);
  const message = stringField(found.commit as Json, 'message');
  if (message !== `${set.scenario.commitMessage} (commits)`) fail(`${label}: commit message is ${JSON.stringify(message)}`);

  const baseLabel = `GET ${repo.path}/commits`;
  const baseResponse = await set.client.get(`${repo.path}/commits`);
  expect(expectJsonResponse(baseResponse, 200, shapes.array(shapes.object({ sha: shaShape() })), baseLabel));
  const baseCommits = arrayBody(baseResponse, baseLabel);
  if (baseCommits.some((entry) => lower(entry.sha) === lower(commit.commitSha))) {
    fail(`${baseLabel}: lists ${commit.commitSha}, which was committed to ${branch} only (before any merge)`);
  }
}

async function reposUnauthorized(set: ClientSet): Promise<void> {
  const repo = await prepareRepo(set, 'repos-unauthorized', { private: true });
  const response = await set.anon.get(repo.path);
  expect(expectJsonResponse(response, 401, messageShape(), `GET ${repo.path} without a token`));
}

async function reposForeignToken(set: ClientSet): Promise<void> {
  const name = repoName(set, 'repos-foreign');
  const own = apiPath('repos', set.owner, name);
  const created = await set.client.post(apiPath('user', 'repos'), { body: { name, private: true, description: set.scenario.description } });
  expect(expectJsonResponse(created, 201, shapes.object({ name: shapes.string({ oneOf: [name] }) }), `POST /api/v3/user/repos (${name})`));
  const ownerRead = await set.client.get(own);
  expect(expectJsonResponse(ownerRead, 200, shapes.object({ name: shapes.string({ oneOf: [name] }) }), `GET ${own}`));
  const foreignPath = apiPath('repos', set.otherOwner, name);
  const foreignRead = await set.client.get(foreignPath);
  expect(expectJsonResponse(foreignRead, 404, messageShape(), `GET ${foreignPath} (the same name under ${set.otherOwner})`));
}

async function reposContentsCreate(set: ClientSet): Promise<void> {
  const repo = await prepareRepo(set, 'repos-contents-create');
  const filePath = variantPath(set.scenario.filePath, 'created');
  const content = set.scenario.fileContentAlt;
  const response = await putContent(set, repo, { filePath, content, message: set.scenario.commitMessage });
  const commit = contentCommit(response, `PUT ${repo.path}/contents/${filePath}`);
  const entry = await getContent(set, repo, filePath);
  if (b64decode(entry.content) !== content) fail(`GET ${repo.path}/contents/${filePath}: content does not decode to the committed bytes`);
  if (lower(entry.sha) !== lower(commit.contentSha)) fail(`GET ${repo.path}/contents/${filePath}: sha is ${entry.sha}, expected the PUT's content sha ${commit.contentSha}`);
  if (entry.size !== Buffer.byteLength(content, 'utf8')) fail(`GET ${repo.path}/contents/${filePath}: size is ${entry.size}, expected ${Buffer.byteLength(content, 'utf8')}`);
}

async function reposContentsDirectory(set: ClientSet): Promise<void> {
  const repo = await prepareRepo(set, 'repos-contents-dir', { filePath: `${set.scenario.dirPath}/seed.txt` });
  const names = ['one.txt', 'two.txt'];
  for (const name of names) {
    const filePath = `${set.scenario.dirPath}/${name}`;
    const commit = await putContent(set, repo, { filePath, content: set.scenario.fileContentAlt, message: `${set.scenario.commitMessage} (${name})` });
    contentCommit(commit, `PUT ${repo.path}/contents/${filePath}`);
  }
  const path = apiPath('repos', set.owner, repo.name, 'contents', set.scenario.dirPath);
  const response = await set.client.get(path);
  const label = `GET ${path}`;
  expect(expectJsonResponse(response, 200, shapes.array(shapes.object({ type: shapes.string({ oneOf: ['file', 'dir'] }), name: shapes.string({ nonEmpty: true }), path: shapes.string({ nonEmpty: true }), sha: shaShape() })), label));
  const entries = arrayBody(response, label);
  const listed = entries.map((entry) => stringField(entry, 'name'));
  for (const name of [...names, 'seed.txt']) {
    if (!listed.includes(name)) fail(`${label}: does not list ${JSON.stringify(name)} (got ${JSON.stringify(listed)})`);
  }
}

async function reposContentsStaleSha(set: ClientSet): Promise<void> {
  const repo = await prepareRepo(set, 'repos-contents-stale');
  const current = await getContent(set, repo, set.scenario.filePath);
  const update = await putContent(set, repo, { filePath: set.scenario.filePath, content: set.scenario.fileContentAlt, message: set.scenario.commitMessage, sha: current.sha });
  const updated = contentCommit(update, `PUT ${repo.path}/contents/${set.scenario.filePath} (update)`, [200, 201]);
  if (lower(updated.contentSha) === lower(current.sha)) fail(`PUT ${repo.path}/contents/${set.scenario.filePath}: the update left the content sha unchanged (${current.sha})`);
  const stale = await putContent(set, repo, { filePath: set.scenario.filePath, content: set.scenario.fileContent, message: set.scenario.commitMessage, sha: current.sha });
  expect(expectJsonResponse(stale, 409, messageShape(), `PUT ${repo.path}/contents/${set.scenario.filePath} with the stale sha ${current.sha}`));
}

async function reposContentsDelete(set: ClientSet): Promise<void> {
  const repo = await prepareRepo(set, 'repos-contents-delete');
  const entry = await getContent(set, repo, set.scenario.filePath);
  const path = apiPath('repos', set.owner, repo.name, 'contents', set.scenario.filePath);
  const deleted = await set.client.delete(path, { body: { message: set.scenario.commitMessage, sha: entry.sha } });
  expect(expectJsonResponse(deleted, 200, shapes.object({ commit: shapes.object({ sha: shaShape() }) }), `DELETE ${path}`));
  const after = await set.client.get(path);
  expect(expectJsonResponse(after, 404, messageShape(), `GET ${path} after DELETE`));
}

// ---------------------------------------------------------------------------------------------
// issues (15)

async function issuesCreate(set: ClientSet): Promise<void> {
  const { repo, label } = await prepareIssueRepo(set, 'issues-create');
  const issue = await createIssue(set, repo, { title: set.scenario.issueTitle, body: set.scenario.issueBody, labels: [label] });
  if (issue.state !== 'open') fail(`POST ${repo.path}/issues: body.state is ${JSON.stringify(issue.state)}, expected "open"`);
}

async function issuesCreateTitleBody(set: ClientSet): Promise<void> {
  const { repo } = await prepareIssueRepo(set, 'issues-create-echo');
  const issue = await createIssue(set, repo, { title: set.scenario.issueTitle, body: set.scenario.issueBody });
  if (issue.title !== set.scenario.issueTitle) fail(`POST ${repo.path}/issues: body.title is ${JSON.stringify(issue.title)}, expected ${JSON.stringify(set.scenario.issueTitle)}`);
  if (issue.body !== set.scenario.issueBody) fail(`POST ${repo.path}/issues: body.body is not the submitted body`);
}

async function issuesCreateLabels(set: ClientSet): Promise<void> {
  const { repo, label } = await prepareIssueRepo(set, 'issues-create-labels');
  const issue = await createIssue(set, repo, { title: set.scenario.issueTitle, body: set.scenario.issueBody, labels: [label] });
  const labels = (issue.labels as Json[]).map((entry) => stringField(entry, 'name'));
  if (!labels.includes(label)) fail(`POST ${repo.path}/issues: body.labels is ${JSON.stringify(labels)}, expected it to include ${JSON.stringify(label)}`);
}

async function issuesNumbersIncrement(set: ClientSet): Promise<void> {
  const { repo } = await prepareIssueRepo(set, 'issues-numbers');
  const first = await createIssue(set, repo, { title: `${set.scenario.issueTitle} 1`, body: set.scenario.issueBody });
  const second = await createIssue(set, repo, { title: `${set.scenario.issueTitle} 2`, body: set.scenario.issueBody });
  if (issueNumber(second) !== issueNumber(first) + 1) fail(`the second issue's number is ${issueNumber(second)}, expected ${issueNumber(first) + 1}`);
}

async function issuesListOpen(set: ClientSet): Promise<void> {
  const { repo } = await prepareIssueRepo(set, 'issues-list-open');
  const open = await createIssue(set, repo, { title: set.scenario.issueTitle, body: set.scenario.issueBody });
  const closed = await createIssue(set, repo, { title: `${set.scenario.issueTitle} closed`, body: set.scenario.issueBody });
  await setIssueState(set, repo, issueNumber(closed), 'closed');
  const list = await listIssues(set, repo, { state: 'open', per_page: 100 });
  if (!list.some((issue) => issueNumber(issue) === issueNumber(open))) fail(`GET ${repo.path}/issues?state=open does not list the open issue ${issueNumber(open)}`);
  for (const issue of list) {
    if (issue.state !== 'open') fail(`GET ${repo.path}/issues?state=open lists issue ${issueNumber(issue)} in state ${JSON.stringify(issue.state)}`);
  }
}

async function issuesListOpenExcludesClosed(set: ClientSet): Promise<void> {
  const { repo } = await prepareIssueRepo(set, 'issues-list-closed');
  const closed = await createIssue(set, repo, { title: set.scenario.issueTitle, body: set.scenario.issueBody });
  await setIssueState(set, repo, issueNumber(closed), 'closed');
  const list = await listIssues(set, repo, { state: 'open', per_page: 100 });
  if (list.some((issue) => issueNumber(issue) === issueNumber(closed))) fail(`GET ${repo.path}/issues?state=open lists the closed issue ${issueNumber(closed)}`);
}

async function issuesListSortAsc(set: ClientSet): Promise<void> {
  const { repo } = await prepareIssueRepo(set, 'issues-sort-asc');
  const created = [
    await createIssue(set, repo, { title: `${set.scenario.issueTitle} a`, body: set.scenario.issueBody }),
    await createIssue(set, repo, { title: `${set.scenario.issueTitle} b`, body: set.scenario.issueBody }),
    await createIssue(set, repo, { title: `${set.scenario.issueTitle} c`, body: set.scenario.issueBody }),
  ].map(issueNumber);
  const list = await listIssues(set, repo, { state: 'open', sort: 'created', direction: 'asc', per_page: 100 });
  const positions = created.map((number) => positionOf(list, number));
  if (positions.some((position) => position === -1)) fail(`GET ${repo.path}/issues?sort=created&direction=asc does not list every created issue (numbers ${JSON.stringify(created)})`);
  if (!(positions[0] < positions[1] && positions[1] < positions[2])) fail(`ascending creation order is ${JSON.stringify(positions)}, expected the three issues in creation order`);
}

async function issuesListSortDesc(set: ClientSet): Promise<void> {
  const { repo } = await prepareIssueRepo(set, 'issues-sort-desc');
  const created = [
    await createIssue(set, repo, { title: `${set.scenario.issueTitle} a`, body: set.scenario.issueBody }),
    await createIssue(set, repo, { title: `${set.scenario.issueTitle} b`, body: set.scenario.issueBody }),
    await createIssue(set, repo, { title: `${set.scenario.issueTitle} c`, body: set.scenario.issueBody }),
  ].map(issueNumber);
  const list = await listIssues(set, repo, { state: 'open', sort: 'created', direction: 'desc', per_page: 100 });
  const positions = created.map((number) => positionOf(list, number));
  if (positions.some((position) => position === -1)) fail(`GET ${repo.path}/issues?sort=created&direction=desc does not list every created issue (numbers ${JSON.stringify(created)})`);
  if (!(positions[2] < positions[1] && positions[1] < positions[0])) fail(`descending creation order is ${JSON.stringify(positions)}, expected the newest first`);
}

async function issuesListShape(set: ClientSet): Promise<void> {
  const { repo } = await prepareIssueRepo(set, 'issues-list-shape');
  await createIssue(set, repo, { title: set.scenario.issueTitle, body: set.scenario.issueBody });
  const list = await listIssues(set, repo, { state: 'open', per_page: 10 });
  if (list.length === 0) fail(`GET ${repo.path}/issues?state=open returned no issues after one was created`);
  for (const issue of list) {
    const problem = checkShape(issue, issueShape(), `GET ${repo.path}/issues body item`);
    if (problem !== null) fail(problem);
  }
}

async function issuesGetOne(set: ClientSet): Promise<void> {
  const { repo } = await prepareIssueRepo(set, 'issues-get-one');
  const created = await createIssue(set, repo, { title: set.scenario.issueTitle, body: set.scenario.issueBody });
  const number = issueNumber(created);
  const response = await set.client.get(`${repo.path}/issues/${number}`);
  const label = `GET ${repo.path}/issues/${number}`;
  expect(expectJsonResponse(response, 200, issueShape(), label));
  const issue = objectBody(response, label);
  if (issueNumber(issue) !== number) fail(`${label}: body.number is ${JSON.stringify(issue.number)}, expected ${number}`);
  if (issue.title !== set.scenario.issueTitle) fail(`${label}: body.title does not match the created issue`);
  if (issue.body !== set.scenario.issueBody) fail(`${label}: body.body does not match the created issue`);
}

async function issuesPatchClose(set: ClientSet): Promise<void> {
  const { repo } = await prepareIssueRepo(set, 'issues-patch-close');
  const created = await createIssue(set, repo, { title: set.scenario.issueTitle, body: set.scenario.issueBody });
  const number = issueNumber(created);
  const patched = await setIssueState(set, repo, number, 'closed');
  if (patched.state !== 'closed') fail(`PATCH ${repo.path}/issues/${number}: body.state is ${JSON.stringify(patched.state)}, expected "closed"`);
}

async function issuesPatchClosePersists(set: ClientSet): Promise<void> {
  const { repo } = await prepareIssueRepo(set, 'issues-close-persists');
  const created = await createIssue(set, repo, { title: set.scenario.issueTitle, body: set.scenario.issueBody });
  const number = issueNumber(created);
  await setIssueState(set, repo, number, 'closed');
  const response = await set.client.get(`${repo.path}/issues/${number}`);
  const label = `GET ${repo.path}/issues/${number} after close`;
  expect(expectJsonResponse(response, 200, issueShape(), label));
  const issue = objectBody(response, label);
  if (issue.state !== 'closed') fail(`${label}: body.state is ${JSON.stringify(issue.state)}, expected "closed"`);
}

async function issuesCommentCreate(set: ClientSet): Promise<void> {
  const { repo } = await prepareIssueRepo(set, 'issues-comment-create');
  const created = await createIssue(set, repo, { title: set.scenario.issueTitle, body: set.scenario.issueBody });
  const number = issueNumber(created);
  const response = await set.client.post(`${repo.path}/issues/${number}/comments`, { body: { body: set.scenario.commentBody } });
  const label = `POST ${repo.path}/issues/${number}/comments`;
  expect(
    expectJsonResponse(
      response,
      201,
      shapes.object({ id: shapes.number({ integer: true, min: 1 }), body: shapes.string({ oneOf: [set.scenario.commentBody] }) }),
      label,
    ),
  );
}

async function issuesCommentsList(set: ClientSet): Promise<void> {
  const { repo } = await prepareIssueRepo(set, 'issues-comments-list');
  const created = await createIssue(set, repo, { title: set.scenario.issueTitle, body: set.scenario.issueBody });
  const number = issueNumber(created);
  const posted = await set.client.post(`${repo.path}/issues/${number}/comments`, { body: { body: set.scenario.commentBody } });
  expect(
    expectJsonResponse(
      posted,
      201,
      shapes.object({ id: shapes.number({ integer: true, min: 1 }), body: shapes.string({ oneOf: [set.scenario.commentBody] }) }),
      `POST ${repo.path}/issues/${number}/comments`,
    ),
  );
  const commentId = numberField(objectBody(posted, `POST ${repo.path}/issues/${number}/comments`), 'id');

  const response = await set.client.get(`${repo.path}/issues/${number}/comments`);
  const label = `GET ${repo.path}/issues/${number}/comments`;
  expect(expectJsonResponse(response, 200, shapes.array(shapes.object({ id: shapes.number({ integer: true, min: 1 }), body: shapes.string() })), label));
  const comments = arrayBody(response, label);
  if (!comments.some((comment) => numberField(comment, 'id') === commentId && comment.body === set.scenario.commentBody)) {
    fail(`${label}: does not list comment ${commentId} with the posted body`);
  }
}

async function issuesBadLabel(set: ClientSet): Promise<void> {
  const { repo } = await prepareIssueRepo(set, 'issues-bad-label');
  const response = await set.client.post(`${repo.path}/issues`, { body: { title: set.scenario.issueTitle, body: set.scenario.issueBody, labels: [set.scenario.badLabel] } });
  expect(expectJsonResponse(response, 422, messageShape(), `POST ${repo.path}/issues with the unknown label ${JSON.stringify(set.scenario.badLabel)}`));
}

// ---------------------------------------------------------------------------------------------
// pulls (20)

async function pullsCreate(set: ClientSet): Promise<void> {
  const fixture = await preparePull(set, 'pulls-create');
  const response = await set.client.get(`${fixture.repo.path}/pulls/${fixture.number}`);
  const label = `GET ${fixture.repo.path}/pulls/${fixture.number}`;
  expect(expectJsonResponse(response, 200, pullShape(), label));
  const pull = objectBody(response, label);
  if (pull.state !== 'open') fail(`${label}: body.state is ${JSON.stringify(pull.state)}, expected "open"`);
  if (stringField(pull.head as Json, 'ref') !== fixture.head) fail(`${label}: body.head.ref is ${JSON.stringify(stringField(pull.head as Json, 'ref'))}, expected ${JSON.stringify(fixture.head)}`);
  if (stringField(pull.base as Json, 'ref') !== fixture.base) fail(`${label}: body.base.ref is ${JSON.stringify(stringField(pull.base as Json, 'ref'))}, expected ${JSON.stringify(fixture.base)}`);
}

async function pullsCreateBody(set: ClientSet): Promise<void> {
  const fixture = await preparePull(set, 'pulls-create-body');
  const response = await set.client.get(`${fixture.repo.path}/pulls/${fixture.number}`);
  const label = `GET ${fixture.repo.path}/pulls/${fixture.number}`;
  expect(expectJsonResponse(response, 200, pullShape(), label));
  const pull = objectBody(response, label);
  if (pull.title !== set.scenario.pullTitle) fail(`${label}: body.title does not match the submitted title`);
  if (pull.body !== set.scenario.pullBody) fail(`${label}: body.body does not match the submitted body`);
}

async function pullsCreateHeadSha(set: ClientSet): Promise<void> {
  const fixture = await preparePull(set, 'pulls-create-head');
  const response = await set.client.get(`${fixture.repo.path}/pulls/${fixture.number}`);
  const label = `GET ${fixture.repo.path}/pulls/${fixture.number}`;
  expect(expectJsonResponse(response, 200, pullShape(), label));
  const sha = lower(stringField(objectBody(response, label).head as Json, 'sha'));
  if (sha !== lower(fixture.headCommitSha)) fail(`${label}: body.head.sha is ${JSON.stringify(sha)}, expected the head branch tip ${JSON.stringify(fixture.headCommitSha)}`);
}

async function pullsCreateBaseSha(set: ClientSet): Promise<void> {
  const fixture = await preparePull(set, 'pulls-create-base');
  const response = await set.client.get(`${fixture.repo.path}/pulls/${fixture.number}`);
  const label = `GET ${fixture.repo.path}/pulls/${fixture.number}`;
  expect(expectJsonResponse(response, 200, pullShape(), label));
  const sha = lower(stringField(objectBody(response, label).base as Json, 'sha'));
  if (sha !== lower(fixture.repo.initialCommitSha)) fail(`${label}: body.base.sha is ${JSON.stringify(sha)}, expected the base tip ${JSON.stringify(fixture.repo.initialCommitSha)}`);
}

async function pullsGetOne(set: ClientSet): Promise<void> {
  const fixture = await preparePull(set, 'pulls-get-one');
  const response = await set.client.get(`${fixture.repo.path}/pulls/${fixture.number}`);
  const label = `GET ${fixture.repo.path}/pulls/${fixture.number}`;
  expect(expectJsonResponse(response, 200, pullShape(), label));
  const pull = objectBody(response, label);
  if (numberField(pull, 'number') !== fixture.number) fail(`${label}: body.number is ${JSON.stringify(pull.number)}, expected ${fixture.number}`);
  if (pull.title !== set.scenario.pullTitle) fail(`${label}: body.title does not match the created pull request`);
}

const pullFileShape = (): Shape =>
  shapes.object({
    filename: shapes.string({ nonEmpty: true }),
    status: shapes.string({ nonEmpty: true }),
    additions: shapes.number({ integer: true, min: 0 }),
    deletions: shapes.number({ integer: true, min: 0 }),
    changes: shapes.number({ integer: true, min: 0 }),
  });

async function pullsFiles(set: ClientSet, id: string, files?: readonly { path: string; content: string }[]): Promise<{ fixture: PullFixture; files: Json[] }> {
  const fixture = await preparePull(set, id, files);
  const response = await set.client.get(`${fixture.repo.path}/pulls/${fixture.number}/files`);
  const label = `GET ${fixture.repo.path}/pulls/${fixture.number}/files`;
  expect(expectJsonResponse(response, 200, shapes.array(pullFileShape()), label));
  return { fixture, files: arrayBody(response, label) };
}

async function pullsFilesList(set: ClientSet): Promise<void> {
  const { fixture, files } = await pullsFiles(set, 'pulls-files-list');
  const wanted = fixture.changedPaths[0] ?? '';
  const found = files.find((file) => stringField(file, 'filename') === wanted);
  if (found === undefined) fail(`GET ${fixture.repo.path}/pulls/${fixture.number}/files does not list ${JSON.stringify(wanted)}`);
  if (!['added', 'modified', 'changed'].includes(stringField(found, 'status'))) fail(`pull file ${wanted}: status is ${JSON.stringify(found.status)}, expected added or modified`);
  if (numberField(found, 'additions') < 1) fail(`pull file ${wanted}: additions is ${JSON.stringify(found.additions)}, expected at least 1`);
}

async function pullsFilesShape(set: ClientSet): Promise<void> {
  const { fixture, files } = await pullsFiles(set, 'pulls-files-shape');
  if (files.length === 0) fail(`GET ${fixture.repo.path}/pulls/${fixture.number}/files returned no files for a pull request that changed one`);
  for (const file of files) {
    const problem = checkShape(file, pullFileShape(), `GET ${fixture.repo.path}/pulls/${fixture.number}/files body item`);
    if (problem !== null) fail(problem);
  }
}

async function pullsFilesMultiple(set: ClientSet): Promise<void> {
  const first = variantPath(set.scenario.filePath, 'multi-a');
  const second = variantPath(set.scenario.filePath, 'multi-b');
  const { fixture, files } = await pullsFiles(set, 'pulls-files-multiple', [
    { path: first, content: set.scenario.fileContentAlt },
    { path: second, content: set.scenario.fileContent },
  ]);
  const listed = files.map((file) => stringField(file, 'filename'));
  for (const path of [first, second]) {
    if (!listed.includes(path)) fail(`GET ${fixture.repo.path}/pulls/${fixture.number}/files lists ${JSON.stringify(listed)}, expected ${JSON.stringify(path)}`);
  }
}

async function mergedPull(set: ClientSet, id: string): Promise<{ fixture: PullFixture; mergeSha: string }> {
  const fixture = await preparePull(set, id);
  const response = await mergePull(set, fixture.repo, fixture.number);
  const label = `PUT ${fixture.repo.path}/pulls/${fixture.number}/merge`;
  expect(expectJsonResponse(response, 200, shapes.object({ merged: shapes.boolean(), sha: shaShape(), message: shapes.string() }), label));
  const body = objectBody(response, label);
  if (body.merged !== true) fail(`${label}: body.merged is ${JSON.stringify(body.merged)}, expected true`);
  return { fixture, mergeSha: stringField(body, 'sha') };
}

async function pullsMergeStatus(set: ClientSet): Promise<void> {
  const fixture = await preparePull(set, 'pulls-merge-status');
  const response = await mergePull(set, fixture.repo, fixture.number);
  expect(expectStatus(response, 200, `PUT ${fixture.repo.path}/pulls/${fixture.number}/merge`));
}

async function pullsMergeBody(set: ClientSet): Promise<void> {
  const { mergeSha } = await mergedPull(set, 'pulls-merge-body');
  if (!SHA40.test(mergeSha)) fail(`the merge sha ${JSON.stringify(mergeSha)} is not a 40-character hex commit id`);
}

async function pullsMergeCloses(set: ClientSet): Promise<void> {
  const { fixture } = await mergedPull(set, 'pulls-merge-closes');
  const response = await set.client.get(`${fixture.repo.path}/pulls/${fixture.number}`);
  const label = `GET ${fixture.repo.path}/pulls/${fixture.number} after merge`;
  expect(
    expectJsonResponse(
      response,
      200,
      shapes.object({ state: shapes.string({ oneOf: ['closed'] }), merged: shapes.boolean(), merged_at: shapes.string({ nonEmpty: true }) }),
      label,
    ),
  );
  const pull = objectBody(response, label);
  if (pull.merged !== true) fail(`${label}: body.merged is ${JSON.stringify(pull.merged)}, expected true`);
}

async function pullsMergeCommitOnDefault(set: ClientSet): Promise<void> {
  const { fixture, mergeSha } = await mergedPull(set, 'pulls-merge-on-default');
  const response = await set.client.get(`${fixture.repo.path}/commits`, { query: { sha: fixture.base } });
  const label = `GET ${fixture.repo.path}/commits?sha=${fixture.base}`;
  expect(expectJsonResponse(response, 200, shapes.array(shapes.object({ sha: shaShape() })), label));
  const commits = arrayBody(response, label);
  if (!commits.some((commit) => lower(commit.sha) === lower(mergeSha))) fail(`${label}: does not list the merge commit ${mergeSha}`);
}

async function pullsMergeContentOnDefault(set: ClientSet): Promise<void> {
  const { fixture } = await mergedPull(set, 'pulls-merge-content');
  const changedPath = fixture.changedPaths[0] ?? '';
  const entry = await getContent(set, fixture.repo, changedPath, fixture.base);
  if (b64decode(entry.content) !== set.scenario.fileContentAlt) fail(`GET contents/${changedPath}?ref=${fixture.base}: content does not decode to the merged bytes`);
}

async function pullsMergeCommitSha(set: ClientSet): Promise<void> {
  const { fixture, mergeSha } = await mergedPull(set, 'pulls-merge-commit-sha');
  const response = await set.client.get(`${fixture.repo.path}/pulls/${fixture.number}`);
  const label = `GET ${fixture.repo.path}/pulls/${fixture.number} after merge`;
  expect(expectJsonResponse(response, 200, shapes.object({ merge_commit_sha: shaShape() }), label));
  const reported = lower(stringField(objectBody(response, label), 'merge_commit_sha'));
  if (reported !== lower(mergeSha)) fail(`${label}: body.merge_commit_sha is ${JSON.stringify(reported)}, expected the merge sha ${JSON.stringify(mergeSha)}`);
}

async function pullsMergeUnknown(set: ClientSet): Promise<void> {
  const repo = await prepareRepo(set, 'pulls-merge-unknown');
  const response = await mergePull(set, repo, 999_999_999);
  expect(expectJsonResponse(response, 404, messageShape(), `PUT ${repo.path}/pulls/999999999/merge`));
}

async function pullsMergeConflict(set: ClientSet): Promise<void> {
  const repo = await prepareRepo(set, 'pulls-merge-conflict');
  const branchA = `${set.scenario.branchName}-conflict-a`;
  const branchB = `${set.scenario.branchName}-conflict-b`;
  await createBranch(set, repo, branchA, repo.initialCommitSha);
  await createBranch(set, repo, branchB, repo.initialCommitSha);
  const filePath = set.scenario.filePath;
  await commitOnBranch(set, repo, { branch: branchA, filePath, content: `${set.scenario.fileContentAlt} (a)`, message: `${set.scenario.commitMessage} (conflict a)`, update: true });
  await commitOnBranch(set, repo, { branch: branchB, filePath, content: `${set.scenario.fileContentAlt} (b)`, message: `${set.scenario.commitMessage} (conflict b)`, update: true });
  const first = await createPull(set, repo, { head: branchA, base: repo.defaultBranch, title: `${set.scenario.pullTitle} a`, body: set.scenario.pullBody });
  const second = await createPull(set, repo, { head: branchB, base: repo.defaultBranch, title: `${set.scenario.pullTitle} b`, body: set.scenario.pullBody });
  const firstMerge = await mergePull(set, repo, numberField(first, 'number'));
  expect(expectStatus(firstMerge, 200, `PUT ${repo.path}/pulls/${numberField(first, 'number')}/merge (first)`));
  const conflicted = await mergePull(set, repo, numberField(second, 'number'));
  expect(expectJsonResponse(conflicted, 405, messageShape(), `PUT ${repo.path}/pulls/${numberField(second, 'number')}/merge (conflicted)`));
}

async function pullsListStateAll(set: ClientSet): Promise<void> {
  const { fixture } = await mergedPull(set, 'pulls-list-all');
  const open = await secondBranchPull(set, fixture.repo, 'pulls-list-all');
  const response = await set.client.get(`${fixture.repo.path}/pulls`, { query: { state: 'all', per_page: 100 } });
  const label = `GET ${fixture.repo.path}/pulls?state=all`;
  expect(expectJsonResponse(response, 200, shapes.array(pullShape()), label));
  const numbers = arrayBody(response, label).map((pull) => numberField(pull, 'number'));
  for (const number of [fixture.number, open]) {
    if (!numbers.includes(number)) fail(`${label}: does not list pull request ${number} (got ${JSON.stringify(numbers)})`);
  }
}

async function pullsListDefaultOpen(set: ClientSet): Promise<void> {
  const { fixture } = await mergedPull(set, 'pulls-list-open');
  const open = await secondBranchPull(set, fixture.repo, 'pulls-list-open');
  const response = await set.client.get(`${fixture.repo.path}/pulls`, { query: { per_page: 100 } });
  const label = `GET ${fixture.repo.path}/pulls`;
  expect(expectJsonResponse(response, 200, shapes.array(pullShape()), label));
  const numbers = arrayBody(response, label).map((pull) => numberField(pull, 'number'));
  if (numbers.includes(fixture.number)) fail(`${label}: lists the merged pull request ${fixture.number}; the default state is open only`);
  if (!numbers.includes(open)) fail(`${label}: does not list the open pull request ${open}`);
}

async function pullsListShape(set: ClientSet): Promise<void> {
  const fixture = await preparePull(set, 'pulls-list-shape');
  const response = await set.client.get(`${fixture.repo.path}/pulls`, { query: { state: 'all', per_page: 10 } });
  const label = `GET ${fixture.repo.path}/pulls?state=all`;
  expect(expectJsonResponse(response, 200, shapes.array(pullShape()), label));
  const list = arrayBody(response, label);
  if (list.length === 0) fail(`${label} returned no pull requests after one was opened`);
  for (const pull of list) {
    const problem = checkShape(pull, pullShape(), `${label} body item`);
    if (problem !== null) fail(problem);
  }
}

async function pullsGetUnknown(set: ClientSet): Promise<void> {
  const repo = await prepareRepo(set, 'pulls-get-unknown');
  const response = await set.client.get(`${repo.path}/pulls/999999999`);
  expect(expectJsonResponse(response, 404, messageShape(), `GET ${repo.path}/pulls/999999999`));
}

// ---------------------------------------------------------------------------------------------
// protocol (5)

async function protocolContentType(set: ClientSet): Promise<void> {
  const repo = await prepareRepo(set, 'protocol-content-type');
  const calls: readonly { label: string; run: () => Promise<RestResponse> }[] = [
    { label: 'GET /api/v3/', run: () => set.client.get(`${apiPath()}/`) },
    { label: 'GET /api/v3/meta', run: () => set.client.get(apiPath('meta')) },
    { label: `GET ${repo.path}`, run: () => set.client.get(repo.path) },
    { label: `GET ${repo.path}/issues`, run: () => set.client.get(`${repo.path}/issues`) },
    { label: 'GET an unknown route', run: () => set.client.get(apiPath('no-such-route-content-type')) },
    { label: `GET ${repo.path} without a token`, run: () => set.anon.get(repo.path) },
  ];
  for (const call of calls) {
    const response = await call.run();
    if (response.status === 0) fail(`${call.label}: ${describeResponse(response)}`);
    if (!isJsonContentType(response.contentType)) fail(`${call.label}: content-type is ${response.contentType ?? 'none'}, expected application/json`);
    expect(expectNoHtml(response, call.label));
  }
}

async function protocolUnknownRoute(set: ClientSet): Promise<void> {
  const path = apiPath('no-such-route', set.scenario.repoPrefix);
  const response = await set.client.get(path);
  expect(expectJsonResponse(response, 404, messageShape(), `GET ${path}`));
  expect(expectNoHtml(response, `GET ${path}`));
}

async function protocolMalformedBody(set: ClientSet): Promise<void> {
  const path = apiPath('user', 'repos');
  const response = await set.client.post(path, { rawBody: '{"name":', headers: { 'content-type': 'application/json' } });
  expect(expectJsonResponse(response, 400, messageShape(), `POST ${path} with the body {"name":`));
}

async function protocolRequestId(set: ClientSet): Promise<void> {
  const repo = await prepareRepo(set, 'protocol-request-id');
  const calls: readonly { label: string; run: () => Promise<RestResponse> }[] = [
    { label: 'GET /api/v3/', run: () => set.client.get(`${apiPath()}/`) },
    { label: `GET ${repo.path}`, run: () => set.client.get(repo.path) },
    { label: 'GET an unknown route', run: () => set.client.get(apiPath('no-such-route-request-id')) },
    { label: `GET ${repo.path} without a token`, run: () => set.anon.get(repo.path) },
  ];
  for (const call of calls) {
    const response = await call.run();
    if (response.status === 0) fail(`${call.label}: ${describeResponse(response)}`);
    expect(expectHeader(response, 'x-github-request-id', call.label, { nonEmpty: true }));
  }
}

async function protocolErrorMessage(set: ClientSet): Promise<void> {
  const missing = await set.client.get(apiPath('repos', set.owner, `${set.scenario.repoPrefix}-never-created`));
  expect(expectJsonResponse(missing, 404, messageShape(), 'GET a missing repository'));

  const repo = await prepareRepo(set, 'protocol-error-message', { private: true });
  const unauthorized = await set.anon.get(repo.path);
  expect(expectJsonResponse(unauthorized, 401, messageShape(), `GET ${repo.path} without a token`));

  const { repo: issueRepo } = await prepareIssueRepo(set, 'protocol-error-message-issues');
  const unprocessable = await set.client.post(`${issueRepo.path}/issues`, { body: { title: set.scenario.issueTitle, body: set.scenario.issueBody, labels: [set.scenario.badLabel] } });
  expect(expectJsonResponse(unprocessable, 422, messageShape(), `POST ${issueRepo.path}/issues with an unknown label`));
}
