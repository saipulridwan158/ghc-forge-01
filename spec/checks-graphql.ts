// The `graphql` group: the 20 conformance checks of manifest.ts's GraphQL v4 group. Each sends a document
// gh or github-mcp-server actually sends — gh's `api` package and its githubv4 client (viewer, repository
// fields, the feature-detection `__type` probes, issue and pull-request reads, the create/close/merge
// mutations) and the same githubv4 shapes in github-mcp-server — to POST /api/graphql on the entry's base
// URL with the trial's bearer token and a JSON {query, variables} body.
//
// The group's rules:
//   - the entry serves its data on a fresh, empty forge; the checks seed their own fixtures through the
//     entry's own surfaces: a repository and its branches (REST create plus a git push), issues (REST),
//     pull requests (REST). Every name, path, branch and body is a function of wire.ts's one seeded
//     Scenario (the viewer's first repository, three of its generated branches, two of its blobs, its
//     issue templates), with a fixed suffix on the repository name so no other group's fixtures collide;
//   - a check that needs a fixture builds it on first use and reuses it across the group's checks; a
//     fixture that cannot be built is that check's failure detail, never a crash (the wrapper turns any
//     throw into a failed verdict);
//   - a 200 carrying an `errors` array is a GraphQL-level failure unless the check expects it (only the
//     invalid-field check does);
//   - nothing here times anything: no pass/fail bit reads a clock;
//   - the pull-request checks need a branch with a commit. The env main (#14) installs a git adapter once
//     with configureGraphQLGit(), over the env's git client (#9); without it those four checks fail with a
//     clear detail and the other sixteen still run.
//
// The schema surface the reference forge must implement for this group (the reference-forge item reads
// this list):
//   Query.viewer{login}
//   Query.repository(owner: String!, name: String!) -> Repository, nullable
//   Repository{id, databaseId, name, nameWithOwner, owner{login}, defaultBranchRef{name},
//              viewerPermission, hasIssuesEnabled, issue(number: Int!),
//              issues(first: Int, states: [IssueState!], orderBy: {field: IssueOrderField!,
//              direction: OrderDirection!}, after: String), pullRequests(first: Int),
//              pullRequest(number: Int!)}
//   Issue{id, number, title, state, body}
//   IssueConnection{nodes, pageInfo{hasNextPage, endCursor}}
//   PullRequest{id, number, state, merged, headRefName, baseRefName, mergeable, files(first: Int)}
//   PullRequestConnection{nodes}
//   PullRequestChangedFile{path}
//   User{login}
//   Query.node(id: ID!) -> Node, with `... on Repository { name nameWithOwner }`
//   Query.__type(name: String!) -> __Type, with fields(includeDeprecated: Boolean) and
//              enumValues(includeDeprecated: Boolean), and the aliases gh uses (`Issue: __type(...)`)
//   Mutation.createIssue(input: CreateIssueInput{repositoryId, title, body}) -> {issue{number, id}}
//   Mutation.closeIssue(input: CloseIssueInput{issueId}) -> {issue{number, id, state}}
//   Mutation.createPullRequest(input: CreatePullRequestInput{repositoryId, baseRefName, headRefName, title})
//              -> {pullRequest{number, id, state, headRefName, baseRefName}}
//   Mutation.mergePullRequest(input: MergePullRequestInput{pullRequestId, mergeMethod}) ->
//              {pullRequest{number, merged, state}}, mergeMethod SQUASH accepted
//   Mutation.addComment(input: AddCommentInput{subjectId, body}) -> {commentEdge{node{id, body}}}
//   Arguments: string/int variables, inline enum lists (`states: [OPEN]`), inline input objects
//              (`orderBy: {field: CREATED_AT, direction: DESC}`), null variables (`after: null`),
//              operation names, and a JSON array of operation documents in one request (batching).
//   Enums: IssueState OPEN/CLOSED, MergeableState MERGEABLE/CONFLICTING/UNKNOWN, PullRequestState
//              OPEN/CLOSED/MERGED, PullRequestMergeMethod MERGE/SQUASH/REBASE, RepositoryPermission
//              ADMIN/MAINTAIN/WRITE/TRIAGE/READ, SearchType ISSUE/... (enumValues), IssueOrderField
//              CREATED_AT/UPDATED_AT/COMMENTS, OrderDirection ASC/DESC.
// The reference also implements the REST reads the checks use as their cross-surface view (item #16's
// routes): POST /user/repos, GET /repos/{o}/{r}, POST/GET/PATCH /repos/{o}/{r}/issues[/{n}],
// GET /repos/{o}/{r}/issues/{n}/comments, POST/GET /repos/{o}/{r}/pulls[/{n}].
//
// The 20 checks are exactly the manifest's count for this group (manifest.ts CHECK_GROUPS). gh's three
// remaining feature probes (PullRequest, Repository, SearchType) share one check
// (`graphql.introspection-types`) so the group stays at 20; every other check below is one check.

import { checkId, fail, pass, type CheckContext, type CheckResult, type CheckSpec } from './manifest.ts';
import { CHECK_TIMEOUT_MAX_MS, type Scenario } from './wire.ts';
import { GraphQLClient, type GraphQLResponse } from './graphql-client.ts';

/** The manifest's group name. */
export const GRAPHQL_GROUP = 'graphql' as const;

/**
 * One commit pushed to the fixture repository by the env's git client (#9). The env main installs this
 * adapter with configureGraphQLGit() so the pull-request checks can create the branches a pull request needs
 * without importing the git client here.
 */
export interface GraphQLGitPush {
  owner: string;
  repo: string;
  branch: string;
  /** The branch the commit builds on; unset for the repository's first (root) commit. */
  from?: string;
  path: string;
  content: string;
  message: string;
}

/** The branch fixture the env main installs. */
export interface GraphQLGitFixture {
  /** Push one commit and resolve null on success, or a human-readable failure detail. */
  pushBranch(request: GraphQLGitPush): Promise<string | null>;
}

let gitAdapter: GraphQLGitFixture | null = null;

/**
 * Install the git adapter the pull-request checks use to create their head branches. The env main calls
 * this once before the conformance phase, over the env's git client (#9); passing null removes it.
 */
export function configureGraphQLGit(git: GraphQLGitFixture | null): void {
  gitAdapter = git;
}

// ---------------------------------------------------------------------------------------------------------
// The documents. Each is sent as `query` with its variables; nothing here builds GraphQL text at run time.
// ---------------------------------------------------------------------------------------------------------

/** query ViewerLogin — gh's `api.CurrentLoginName` (api_queries_repo.go: viewer { login }). */
const VIEWER_LOGIN = `query ViewerLogin {
  viewer {
    login
  }
}`;

/** query RepositoryFields — gh's repository lookup (api_queries_repo.go's repository(owner: $owner, name: $name)). */
const REPOSITORY_FIELDS = `query RepositoryFields($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    id
    databaseId
    name
    owner {
      login
    }
    defaultBranchRef {
      name
    }
    viewerPermission
    hasIssuesEnabled
  }
}`;

/** query Issue_fields — gh's featuredetection.IssueFeatures probe (internal/featuredetection/fd.go). */
const ISSUE_FIELDS = `query Issue_fields {
  Issue: __type(name: "Issue") {
    fields(includeDeprecated: true) {
      name
    }
  }
}`;

/** query PullRequestAndRepositoryFields — gh's two probes in one document (fd.go keeps to two __type expressions). */
const TYPE_FIELDS = `query PullRequestAndRepositoryFields {
  PullRequest: __type(name: "PullRequest") {
    fields(includeDeprecated: true) {
      name
    }
  }
  Repository: __type(name: "Repository") {
    fields(includeDeprecated: true) {
      name
    }
  }
}`;

/** query SearchType_enumValues — gh's SearchFeatures probe (fd.go). */
const SEARCH_TYPE_ENUM_VALUES = `query SearchType_enumValues {
  SearchType: __type(name: "SearchType") {
    enumValues(includeDeprecated: true) {
      name
    }
  }
}`;

/** query OpenIssues — gh's issue list (pkg/cmd/issue/list, states + orderBy on repository.issues). */
const OPEN_ISSUES = `query OpenIssues($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number
        title
        state
        id
      }
    }
  }
}`;

/** query IssueByNumber — gh's issue view (api_queries_issue.go's repository.issue(number: $number)). */
const ISSUE_BY_NUMBER = `query IssueByNumber($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number
      title
      state
      id
      body
    }
  }
}`;

/** mutation IssueCreate — gh's `gh issue create` (api_queries_issue.go IssueCreate). */
const CREATE_ISSUE = `mutation IssueCreate($input: CreateIssueInput!) {
  createIssue(input: $input) {
    issue {
      number
      id
    }
  }
}`;

/** mutation IssueClose — gh's `gh issue close` (pkg/cmd/issue/close/close.go apiClose). */
const CLOSE_ISSUE = `mutation IssueClose($input: CloseIssueInput!) {
  closeIssue(input: $input) {
    issue {
      number
      id
      state
    }
  }
}`;

/** query PullRequests — gh's `gh pr list` (api_queries_pr.go's repository.pullRequests(first:)). */
const PULL_REQUESTS = `query PullRequests($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first) {
      nodes {
        number
        headRefName
        baseRefName
        mergeable
        state
      }
    }
  }
}`;

/** query PullRequestFiles — gh's PR files read (api_queries_pr.go's pullRequest(number:).files(first:)). */
const PULL_REQUEST_FILES = `query PullRequestFiles($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      files(first: 10) {
        nodes {
          path
        }
      }
    }
  }
}`;

/** query PullRequestId — the minimal read a mutation input needs (the pull request's global id). */
const PULL_REQUEST_ID = `query PullRequestId($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      number
    }
  }
}`;

/** mutation PullRequestCreate — gh's `gh pr create` (api_queries_pr.go CreatePullRequest). */
const CREATE_PULL_REQUEST = `mutation PullRequestCreate($input: CreatePullRequestInput!) {
  createPullRequest(input: $input) {
    pullRequest {
      number
      id
      state
      headRefName
      baseRefName
    }
  }
}`;

/** mutation MergePullRequest — gh's `gh pr merge` (pkg/cmd/pr/merge/http.go mergePullRequest(input:)). */
const MERGE_PULL_REQUEST = `mutation MergePullRequest($input: MergePullRequestInput!) {
  mergePullRequest(input: $input) {
    pullRequest {
      number
      merged
      state
    }
  }
}`;

/** mutation AddComment — GitHub's AddCommentInput, the shape gh's comment paths build. */
const ADD_COMMENT = `mutation AddComment($input: AddCommentInput!) {
  addComment(input: $input) {
    commentEdge {
      node {
        id
        body
      }
    }
  }
}`;

/** query ViewerInvalidField — a document with one field the schema does not hold. */
const INVALID_FIELD = `query ViewerInvalidField {
  viewer {
    login
    noSuchFieldOnViewer
  }
}`;

/** query NodeRepository — gh's Relay `node(id:)` read (api_queries_pr.go SuggestedAssignableActors). */
const NODE_REPOSITORY = `query NodeRepository($id: ID!) {
  node(id: $id) {
    id
    ... on Repository {
      name
      nameWithOwner
    }
  }
}`;

/** query IssuesPage — the cursor form of gh's issue list (first/after). */
const ISSUES_PAGE = `query IssuesPage($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, after: $after) {
      nodes {
        number
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`;

/** Every document the group sends, for the report and the reference forge's executor. */
export const GRAPHQL_DOCUMENTS = Object.freeze({
  viewerLogin: VIEWER_LOGIN,
  repositoryFields: REPOSITORY_FIELDS,
  issueFields: ISSUE_FIELDS,
  typeFields: TYPE_FIELDS,
  searchTypeEnumValues: SEARCH_TYPE_ENUM_VALUES,
  openIssues: OPEN_ISSUES,
  issueByNumber: ISSUE_BY_NUMBER,
  createIssue: CREATE_ISSUE,
  closeIssue: CLOSE_ISSUE,
  pullRequests: PULL_REQUESTS,
  pullRequestFiles: PULL_REQUEST_FILES,
  pullRequestId: PULL_REQUEST_ID,
  createPullRequest: CREATE_PULL_REQUEST,
  mergePullRequest: MERGE_PULL_REQUEST,
  addComment: ADD_COMMENT,
  invalidField: INVALID_FIELD,
  nodeRepository: NODE_REPOSITORY,
  issuesPage: ISSUES_PAGE,
});

// ---------------------------------------------------------------------------------------------------------
// Small readers and assertions.
// ---------------------------------------------------------------------------------------------------------

class CheckFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckFailure';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `at(body, 'repository', 'issue', 'number')`: a nested JSON read that answers undefined on any miss. */
function at(value: unknown, ...keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function json(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

/** Every `name` in a `fields`/`enumValues` list, keeping only non-empty strings. */
function namesFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    const name = at(entry, 'name');
    if (typeof name === 'string' && name !== '') names.push(name);
  }
  return names;
}

function arrayFrom(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function positiveInteger(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new CheckFailure(`${what} is ${json(value)}, expected a positive integer`);
  }
  return value;
}

function nonEmptyString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new CheckFailure(`${what} is ${json(value)}, expected a non-empty string`);
  }
  return value;
}

function statusText(answer: { status: number; transportError?: string; parseError?: string }): string {
  if (answer.transportError !== undefined) return `transport error: ${answer.transportError}`;
  if (answer.parseError !== undefined) return `unparseable response: ${answer.parseError}`;
  return `HTTP ${answer.status}`;
}

/** The `data` object of a GraphQL response, or a CheckFailure naming what the wire did instead. */
function dataOf<T>(response: GraphQLResponse<T>, what: string): T {
  if (response.transportError !== undefined) throw new CheckFailure(`${what}: ${response.transportError}`);
  if (response.parseError !== undefined) throw new CheckFailure(`${what}: ${response.parseError}`);
  if (response.status !== 200) throw new CheckFailure(`${what}: HTTP ${response.status}`);
  if (response.errors.length > 0) {
    throw new CheckFailure(`${what}: GraphQL errors: ${response.errors.map((error) => error.message).join('; ')}`);
  }
  if (response.data === null || typeof response.data !== 'object') {
    throw new CheckFailure(`${what}: the response carries no data object`);
  }
  return response.data;
}

interface RestAnswer {
  status: number;
  body: unknown;
  text: string;
  transportError?: string;
  parseError?: string;
}

/** A per-call budget: the check's remaining timeout for this request. */
interface CallOptions {
  signal: AbortSignal;
  timeoutMs: number;
}

/** The REST v3 view, used as the cross-surface verifier and the fixture creator (prefix /api/v3). */
class RestSurface {
  private readonly root: string;
  private readonly token: string;
  private readonly fetchImpl: (input: string, init: RequestInit) => Promise<Response>;

  constructor(baseUrl: string, token: string, fetchImpl: (input: string, init: RequestInit) => Promise<Response>) {
    this.root = `${baseUrl.replace(/\/+$/u, '')}/api/v3`;
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  get(path: string, options: CallOptions): Promise<RestAnswer> {
    return this.request('GET', path, undefined, options);
  }

  post(path: string, body: unknown, options: CallOptions): Promise<RestAnswer> {
    return this.request('POST', path, body, options);
  }

  patch(path: string, body: unknown, options: CallOptions): Promise<RestAnswer> {
    return this.request('PATCH', path, body, options);
  }

  async request(method: string, path: string, body: unknown, options: CallOptions): Promise<RestAnswer> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'makefun-github-core-clone-env/1',
      authorization: `Bearer ${this.token}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.root}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: options.signal,
      });
    } catch (err) {
      return { status: 0, body: null, text: '', transportError: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
    }
    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      return { status: response.status, body: null, text: '', transportError: `could not read the response body: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (text.trim() === '') return { status: response.status, body: null, text };
    try {
      return { status: response.status, body: JSON.parse(text) as unknown, text };
    } catch {
      const contentType = response.headers.get('content-type') ?? 'no content-type';
      return { status: response.status, body: null, text, parseError: `response is not JSON (${contentType})` };
    }
  }
}

/** A REST response's JSON object, checked for a status and a body. */
function restObject(answer: RestAnswer, expected: number | readonly number[], what: string): Record<string, unknown> {
  const expectedList = typeof expected === 'number' ? [expected] : expected;
  if (answer.transportError !== undefined) throw new CheckFailure(`${what}: ${answer.transportError}`);
  if (answer.parseError !== undefined) throw new CheckFailure(`${what}: ${answer.parseError}`);
  if (!expectedList.includes(answer.status)) {
    throw new CheckFailure(`${what}: ${statusText(answer)}, expected ${expectedList.join(' or ')}`);
  }
  if (!isRecord(answer.body)) throw new CheckFailure(`${what}: the body is not a JSON object`);
  return answer.body;
}

/** A REST response's JSON array, checked for a status. */
function restArray(answer: RestAnswer, expected: number | readonly number[], what: string): unknown[] {
  const expectedList = typeof expected === 'number' ? [expected] : expected;
  if (answer.transportError !== undefined) throw new CheckFailure(`${what}: ${answer.transportError}`);
  if (answer.parseError !== undefined) throw new CheckFailure(`${what}: ${answer.parseError}`);
  if (!expectedList.includes(answer.status)) {
    throw new CheckFailure(`${what}: ${statusText(answer)}, expected ${expectedList.join(' or ')}`);
  }
  if (!Array.isArray(answer.body)) throw new CheckFailure(`${what}: the body is not a JSON array`);
  return answer.body;
}

// ---------------------------------------------------------------------------------------------------------
// The fixture: one repository, its branches, issues and pull requests, built lazily from the scenario.
// ---------------------------------------------------------------------------------------------------------

/** The names and bodies the fixture uses, all functions of wire.ts's seeded Scenario. */
interface FixtureNames {
  repository: string;
  pagesRepository: string;
  unknownRepository: string;
  baseBranch: string;
  headBranch: string;
  createBranch: string;
  mergeBranch: string;
  filePath: string;
  baseFilePath: string;
  titlePrefix: string;
  body: string;
  comment: string;
  pageSize: number;
  pageCount: number;
}

function fixtureNames(scenario: Scenario): FixtureNames {
  const repo = scenario.repos[0];
  const pulls = scenario.pulls;
  const blobs = scenario.blobs;
  const issues = scenario.issues;
  if (repo === undefined) throw new CheckFailure('the scenario has no viewer repository to build the GraphQL fixture on');
  if (pulls[0] === undefined || pulls[1] === undefined || pulls[2] === undefined) {
    throw new CheckFailure('the scenario has fewer than three pull-request branch pairs');
  }
  if (blobs[0] === undefined || blobs[1] === undefined) throw new CheckFailure('the scenario has fewer than two blobs');
  if (issues[0] === undefined || issues[1] === undefined) throw new CheckFailure('the scenario has fewer than two issue templates');
  const headBranches = [pulls[0].head, pulls[1].head, pulls[2].head];
  if (new Set(headBranches).size !== headBranches.length) throw new CheckFailure('the scenario reuses a pull-request head branch');
  return {
    repository: `${repo.name}-graphql`,
    pagesRepository: `${repo.name}-graphql-pages`,
    unknownRepository: `${repo.name}-graphql-missing`,
    baseBranch: repo.defaultBranch,
    headBranch: pulls[0].head,
    createBranch: pulls[1].head,
    mergeBranch: pulls[2].head,
    filePath: blobs[0].path,
    baseFilePath: blobs[1].path,
    titlePrefix: issues[0].title,
    body: issues[0].body,
    comment: issues[1].body,
    pageSize: 5,
    pageCount: 7,
  };
}

interface RepoFixture {
  /** The repository's global (Relay) id, from the GraphQL read. */
  id: string;
  /** The REST/GraphQL numeric database id. */
  databaseId: number;
}

interface IssueFixture {
  /** Three open issues, in creation order. */
  open: number[];
  /** One closed issue, created after the open three. */
  closed: number;
}

interface PullRequestFixture {
  number: number;
}

interface PageFixture {
  /** The pagination repository's issue numbers, in creation order. */
  numbers: number[];
}

function repoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/** One check's working set: its context and the run's shared harness. */
interface Session {
  readonly ctx: CheckContext;
  readonly harness: Harness;
}

/** One harness per entry base URL and scenario; fixtures are memoized so a check pays for what it needs once. */
class Harness {
  readonly client: GraphQLClient;
  readonly rest: RestSurface;
  readonly viewer: string;
  readonly names: FixtureNames;
  private readonly repoSeed: { private: boolean; description: string };
  private repo: Promise<RepoFixture> | null = null;
  private baseBranch: Promise<void> | null = null;
  private branches: Promise<void> | null = null;
  private issues: Promise<IssueFixture> | null = null;
  private pullRequest: Promise<PullRequestFixture> | null = null;
  private mergePullRequest: Promise<PullRequestFixture> | null = null;
  private pages: Promise<PageFixture> | null = null;

  constructor(context: CheckContext) {
    const fetchImpl = (input: string, init: RequestInit) => fetch(input, init);
    this.client = new GraphQLClient({ baseUrl: context.baseUrl, token: context.token, timeoutMs: CHECK_TIMEOUT_MAX_MS, fetchImpl });
    this.rest = new RestSurface(context.baseUrl, context.token, fetchImpl);
    this.viewer = context.scenario.viewer.login;
    this.names = fixtureNames(context.scenario);
    const seedRepo = context.scenario.repos[0];
    this.repoSeed = { private: seedRepo?.private ?? false, description: seedRepo?.description ?? 'graphql checks' };
  }

  /** Whether a git adapter was installed (check 2 asserts defaultBranchRef only when branches exist). */
  get branchesAvailable(): boolean {
    return gitAdapter !== null;
  }

  /** One GraphQL call, bounded by the check's own budget. */
  query<T>(options: CallOptions, document: string, variables: Readonly<Record<string, unknown>> = {}): Promise<GraphQLResponse<T>> {
    return this.client.request<T>(document, variables, { signal: options.signal, timeoutMs: options.timeoutMs });
  }

  private callOptions(session: Session): CallOptions {
    return { signal: session.ctx.signal, timeoutMs: session.ctx.timeoutMs };
  }

  repoFixture(session: Session): Promise<RepoFixture> {
    this.repo ??= this.buildRepo(session);
    return this.repo;
  }

  /** The repository's first commit on the default branch (the defaultBranchRef the repository check reads). */
  baseBranchFixture(session: Session): Promise<void> {
    this.baseBranch ??= this.buildBaseBranch(session);
    return this.baseBranch;
  }

  branchFixture(session: Session): Promise<void> {
    this.branches ??= this.buildBranches(session);
    return this.branches;
  }

  issueFixture(session: Session): Promise<IssueFixture> {
    this.issues ??= this.buildIssues(session);
    return this.issues;
  }

  pullRequestFixture(session: Session): Promise<PullRequestFixture> {
    this.pullRequest ??= this.buildPullRequest(this.names.headBranch, `${this.names.titlePrefix} fixture pull request`, 'fixture', session);
    return this.pullRequest;
  }

  mergePullRequestFixture(session: Session): Promise<PullRequestFixture> {
    this.mergePullRequest ??= this.buildPullRequest(this.names.mergeBranch, `${this.names.titlePrefix} merge pull request`, 'fixture-merge', session);
    return this.mergePullRequest;
  }

  pageFixture(session: Session): Promise<PageFixture> {
    this.pages ??= this.buildPages(session);
    return this.pages;
  }

  /** Create the fixture repository (idempotent), then read its global and numeric ids over GraphQL. */
  private async buildRepo(session: Session): Promise<RepoFixture> {
    const name = this.names.repository;
    const created = await this.rest.post(
      '/user/repos',
      { name, private: this.repoSeed.private, description: this.repoSeed.description },
      this.callOptions(session),
    );
    if (created.status !== 201 && created.status !== 200 && created.status !== 422 && created.status !== 409) {
      throw new CheckFailure(`POST /api/v3/user/repos answered ${statusText(created)}`);
    }
    const read = await this.rest.get(repoPath(this.viewer, name), this.callOptions(session));
    if (read.status !== 200) {
      throw new CheckFailure(`the fixture repository ${this.viewer}/${name} was not readable after POST /user/repos: ${statusText(read)}`);
    }
    const response = await this.query(this.callOptions(session), REPOSITORY_FIELDS, { owner: this.viewer, name });
    const data = dataOf(response, `graphql lookup of the fixture repository ${this.viewer}/${name}`);
    const id = nonEmptyString(at(data, 'repository', 'id'), 'the fixture repository id');
    const databaseId = positiveInteger(at(data, 'repository', 'databaseId'), 'the fixture repository databaseId');
    return { id, databaseId };
  }

  /** The repository's first commit on its default branch, so defaultBranchRef names it. */
  private async buildBaseBranch(session: Session): Promise<void> {
    await this.repoFixture(session);
    const git = gitAdapter;
    if (git === null) {
      throw new CheckFailure('no git fixture provider was installed: the env main must call configureGraphQLGit() so the check can create the branch a pull request needs');
    }
    const detail = await git.pushBranch({
      owner: this.viewer,
      repo: this.names.repository,
      branch: this.names.baseBranch,
      path: this.names.baseFilePath,
      content: `# ${this.names.repository}\n\n${this.names.body}\n`,
      message: `fixture: first commit on ${this.names.baseBranch}`,
    });
    if (detail !== null) throw new CheckFailure(`git fixture for the default branch ${this.names.baseBranch}: ${detail}`);
  }

  /** Push the three head branches the pull-request checks need (the base branch is already there). */
  private async buildBranches(session: Session): Promise<void> {
    await this.baseBranchFixture(session);
    const git = gitAdapter;
    if (git === null) throw new CheckFailure('no git fixture provider was installed: the env main must call configureGraphQLGit()');
    const push = async (branch: string, from: string, path: string, content: string, message: string): Promise<void> => {
      const detail = await git.pushBranch({ owner: this.viewer, repo: this.names.repository, branch, from, path, content, message });
      if (detail !== null) throw new CheckFailure(`git fixture for branch ${branch}: ${detail}`);
    };
    await push(this.names.headBranch, this.names.baseBranch, this.names.filePath, `${this.names.body}\n`, `fixture: add ${this.names.filePath}`);
    await push(this.names.createBranch, this.names.baseBranch, `${this.names.filePath}.create`, `${this.names.body}\n`, 'fixture: branch for createPullRequest');
    await push(this.names.mergeBranch, this.names.baseBranch, `${this.names.filePath}.merge`, `${this.names.body}\n`, 'fixture: branch for mergePullRequest');
  }

  /** Create one issue over REST and answer its number. */
  private async createRestIssue(session: Session, title: string, body: string): Promise<number> {
    const answer = await this.rest.post(`${repoPath(this.viewer, this.names.repository)}/issues`, { title, body }, this.callOptions(session));
    const issue = restObject(answer, 201, `POST an issue "${title}"`);
    return positiveInteger(issue.number, 'the created issue number');
  }

  /** Three open issues and one closed issue, all from the scenario's seed-derived text. */
  private async buildIssues(session: Session): Promise<IssueFixture> {
    await this.repoFixture(session);
    const open: number[] = [];
    for (let index = 1; index <= 3; index += 1) {
      open.push(await this.createRestIssue(session, `${this.names.titlePrefix} open ${index}`, this.names.body));
    }
    const closed = await this.createRestIssue(session, `${this.names.titlePrefix} closed`, this.names.body);
    const patched = await this.rest.patch(`${repoPath(this.viewer, this.names.repository)}/issues/${closed}`, { state: 'closed' }, this.callOptions(session));
    restObject(patched, 200, `PATCH issue #${closed} closed`);
    return { open, closed };
  }

  /** An open pull request from `branch` to the base branch, created over REST; tolerant of a re-run. */
  private async buildPullRequest(branch: string, title: string, tag: string, session: Session): Promise<PullRequestFixture> {
    await this.branchFixture(session);
    const created = await this.rest.post(
      `${repoPath(this.viewer, this.names.repository)}/pulls`,
      { title, body: this.names.body, head: branch, base: this.names.baseBranch },
      this.callOptions(session),
    );
    if (created.status === 201) {
      const pullRequest = restObject(created, 201, `POST a pull request from ${branch}`);
      return { number: positiveInteger(pullRequest.number, `the ${tag} pull request number`) };
    }
    if (created.status === 422) {
      const listed = await this.rest.get(`${repoPath(this.viewer, this.names.repository)}/pulls?state=all`, this.callOptions(session));
      for (const entry of restArray(listed, 200, 'GET the pull requests after a 422 on creation')) {
        if (at(entry, 'head', 'ref') !== branch) continue;
        if (at(entry, 'state') !== 'open') continue;
        return { number: positiveInteger(at(entry, 'number'), `the ${tag} pull request number`) };
      }
    }
    throw new CheckFailure(`POST a pull request from ${branch}: ${statusText(created)}${created.status === 422 ? ' (and no open pull request from that branch was found)' : ''}`);
  }

  /** A second repository holding exactly the scenario's pageCount issues, for the cursor check. */
  private async buildPages(session: Session): Promise<PageFixture> {
    const name = this.names.pagesRepository;
    const created = await this.rest.post('/user/repos', { name, private: false }, this.callOptions(session));
    if (created.status !== 201 && created.status !== 200 && created.status !== 422 && created.status !== 409) {
      throw new CheckFailure(`POST /api/v3/user/repos for the pagination repository answered ${statusText(created)}`);
    }
    const numbers: number[] = [];
    for (let index = 1; index <= this.names.pageCount; index += 1) {
      const answer = await this.rest.post(
        `${repoPath(this.viewer, name)}/issues`,
        { title: `${this.names.titlePrefix} page ${index}`, body: this.names.body },
        this.callOptions(session),
      );
      const issue = restObject(answer, 201, `POST pagination issue ${index}`);
      numbers.push(positiveInteger(issue.number, `pagination issue ${index}'s number`));
    }
    return { numbers };
  }

  /** Read an issue's global id (the input closeIssue and addComment take). */
  async issueGlobalId(session: Session, number: number): Promise<string> {
    const response = await this.query(this.callOptions(session), ISSUE_BY_NUMBER, { owner: this.viewer, name: this.names.repository, number });
    const data = dataOf(response, `query IssueByNumber for issue #${number}`);
    return nonEmptyString(at(data, 'repository', 'issue', 'id'), `issue #${number}'s id`);
  }

  /** Read a pull request's global id (the input mergePullRequest takes). */
  async pullRequestGlobalId(session: Session, number: number): Promise<string> {
    const response = await this.query(this.callOptions(session), PULL_REQUEST_ID, { owner: this.viewer, name: this.names.repository, number });
    const data = dataOf(response, `query PullRequestId for pull request #${number}`);
    return nonEmptyString(at(data, 'repository', 'pullRequest', 'id'), `pull request #${number}'s id`);
  }
}

/** One harness per base URL and seed: all of a run's checks share its fixtures. */
const HARNESSES = new Map<string, Harness>();

function harnessFor(context: CheckContext): Harness {
  const key = `${context.baseUrl}\n${context.scenario.seed}`;
  let harness = HARNESSES.get(key);
  if (harness === undefined) {
    harness = new Harness(context);
    HARNESSES.set(key, harness);
  }
  return harness;
}

/** The one session a check body gets: the run's harness and the check's own context. */
function sessionOf(context: CheckContext): Session {
  const harness = harnessFor(context);
  const signal =
    Number.isFinite(context.timeoutMs) && context.timeoutMs > 0
      ? AbortSignal.any([context.signal, AbortSignal.timeout(context.timeoutMs)])
      : context.signal;
  return { ctx: { ...context, signal }, harness };
}

// ---------------------------------------------------------------------------------------------------------
// The checks.
// ---------------------------------------------------------------------------------------------------------

type CheckBody = (session: Session) => Promise<CheckResult>;

/** 1. query ViewerLogin — the token owner's login. */
async function viewerLogin({ ctx, harness }: Session): Promise<CheckResult> {
  const response = await harness.query(ctx, VIEWER_LOGIN);
  const data = dataOf(response, 'query ViewerLogin');
  const login = at(data, 'viewer', 'login');
  if (typeof login !== 'string' || login === '') return fail(`viewer.login is ${json(login)}, expected a non-empty login`);
  if (login !== harness.viewer) return fail(`viewer.login is ${json(login)}, expected the token owner ${json(harness.viewer)}`);
  return pass(`viewer.login is ${login}`);
}

/** 2. query RepositoryFields — the repository read gh does before every repo command. */
async function repositoryFields(session: Session): Promise<CheckResult> {
  const { harness, ctx } = session;
  const repo = await harness.repoFixture(session);
  if (harness.branchesAvailable) await harness.baseBranchFixture(session);
  const response = await harness.query(ctx, REPOSITORY_FIELDS, { owner: harness.viewer, name: harness.names.repository });
  const data = dataOf(response, 'query RepositoryFields');
  const node = at(data, 'repository');
  if (!isRecord(node)) throw new CheckFailure(`data.repository is ${json(node)}, expected the fixture repository`);
  if (node.id !== repo.id) throw new CheckFailure(`data.repository.id is ${json(node.id)}, expected ${json(repo.id)}`);
  if (node.databaseId !== repo.databaseId) throw new CheckFailure(`data.repository.databaseId is ${json(node.databaseId)}, expected ${repo.databaseId}`);
  if (node.name !== harness.names.repository) throw new CheckFailure(`data.repository.name is ${json(node.name)}, expected ${json(harness.names.repository)}`);
  const ownerLogin = at(node, 'owner', 'login');
  if (ownerLogin !== harness.viewer) throw new CheckFailure(`data.repository.owner.login is ${json(ownerLogin)}, expected ${json(harness.viewer)}`);
  if (harness.branchesAvailable) {
    const defaultBranch = at(node, 'defaultBranchRef', 'name');
    if (defaultBranch !== harness.names.baseBranch) {
      throw new CheckFailure(`data.repository.defaultBranchRef.name is ${json(defaultBranch)}, expected ${json(harness.names.baseBranch)}`);
    }
  }
  const permission = node.viewerPermission;
  if (typeof permission !== 'string' || !['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'].includes(permission)) {
    throw new CheckFailure(`data.repository.viewerPermission is ${json(permission)}, expected one of ADMIN, MAINTAIN, WRITE, TRIAGE, READ`);
  }
  if (node.hasIssuesEnabled !== true) throw new CheckFailure(`data.repository.hasIssuesEnabled is ${json(node.hasIssuesEnabled)}, expected true`);
  return pass(`repository ${harness.viewer}/${harness.names.repository} reads back with every requested field`);
}

/** 3. query Issue_fields — gh's IssueRelationshipsSupported probe. */
async function issueIntrospection({ ctx, harness }: Session): Promise<CheckResult> {
  const response = await harness.query(ctx, ISSUE_FIELDS);
  const data = dataOf(response, 'query Issue_fields');
  const names = namesFrom(at(data, 'Issue', 'fields'));
  if (names.length === 0) return fail('Issue: __type(name: "Issue").fields is empty');
  const missing = ['id', 'number', 'title', 'state', 'body'].filter((name) => !names.includes(name));
  if (missing.length > 0) return fail(`Issue's schema does not list ${missing.join(', ')}, which the suite reads: ${names.join(', ')}`);
  return pass(`Issue lists ${names.length} field(s), including id, number, title, state and body`);
}

/** 4. query PullRequest_fields + Repository_fields and query SearchType_enumValues — gh's three remaining probes. */
async function typeIntrospection({ ctx, harness }: Session): Promise<CheckResult> {
  const types = await harness.query(ctx, TYPE_FIELDS);
  const data = dataOf(types, 'query PullRequestAndRepositoryFields');
  const pullRequestNames = namesFrom(at(data, 'PullRequest', 'fields'));
  if (pullRequestNames.length === 0) return fail('PullRequest: __type(name: "PullRequest").fields is empty');
  const pullRequestMissing = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'].filter(
    (name) => !pullRequestNames.includes(name),
  );
  if (pullRequestMissing.length > 0) return fail(`PullRequest's schema does not list ${pullRequestMissing.join(', ')}: ${pullRequestNames.join(', ')}`);
  const repositoryNames = namesFrom(at(data, 'Repository', 'fields'));
  if (repositoryNames.length === 0) return fail('Repository: __type(name: "Repository").fields is empty');
  const repositoryMissing = [
    'id',
    'databaseId',
    'name',
    'nameWithOwner',
    'owner',
    'defaultBranchRef',
    'viewerPermission',
    'hasIssuesEnabled',
    'issue',
    'issues',
    'pullRequests',
    'pullRequest',
  ].filter((name) => !repositoryNames.includes(name));
  if (repositoryMissing.length > 0) return fail(`Repository's schema does not list ${repositoryMissing.join(', ')}: ${repositoryNames.join(', ')}`);
  const search = await harness.query(ctx, SEARCH_TYPE_ENUM_VALUES);
  const searchData = dataOf(search, 'query SearchType_enumValues');
  const enumNames = namesFrom(at(searchData, 'SearchType', 'enumValues'));
  if (enumNames.length === 0) return fail('SearchType: __type(name: "SearchType").enumValues is empty');
  if (!enumNames.includes('ISSUE')) return fail(`SearchType does not list ISSUE: ${enumNames.join(', ')}`);
  return pass(`PullRequest (${pullRequestNames.length}), Repository (${repositoryNames.length}) and SearchType (${enumNames.length}) describe their schema`);
}

/** 5. query OpenIssues — the states filter and CREATED_AT DESC order. */
async function openIssues(session: Session): Promise<CheckResult> {
  const { harness, ctx } = session;
  await harness.repoFixture(session);
  const issues = await harness.issueFixture(session);
  const response = await harness.query(ctx, OPEN_ISSUES, { owner: harness.viewer, name: harness.names.repository, first: 10 });
  const data = dataOf(response, 'query OpenIssues');
  const nodes = arrayFrom(at(data, 'repository', 'issues', 'nodes'));
  if (nodes.length === 0) return fail('the OPEN issue list is empty after the fixture created open issues');
  if (nodes.length > 10) return fail(`the OPEN issue list has ${nodes.length} nodes for first: 10`);
  const numbers: number[] = [];
  for (const node of nodes) {
    const number = positiveInteger(at(node, 'number'), 'an open issue number');
    const state = at(node, 'state');
    if (state !== 'OPEN') return fail(`issue #${number} has state ${json(state)}, expected OPEN`);
    if (typeof at(node, 'title') !== 'string') return fail(`issue #${number} has no title string`);
    nonEmptyString(at(node, 'id'), `issue #${number}'s id`);
    numbers.push(number);
  }
  for (let index = 1; index < numbers.length; index += 1) {
    if (numbers[index] > numbers[index - 1]) {
      return fail(`the CREATED_AT DESC list is out of order: #${numbers[index - 1]} comes before #${numbers[index]}`);
    }
  }
  if (numbers.includes(issues.closed)) return fail(`the closed issue #${issues.closed} appears in the OPEN list`);
  const missing = issues.open.filter((number) => !numbers.includes(number));
  if (missing.length > 0) return fail(`the OPEN list is missing open fixture issue(s) ${missing.join(', ')}`);
  return pass(`${numbers.length} OPEN issue(s) in CREATED_AT DESC order, the closed issue excluded`);
}

/** 6. query IssueByNumber — a single issue read. */
async function issueByNumber(session: Session): Promise<CheckResult> {
  const { harness, ctx } = session;
  await harness.repoFixture(session);
  const issues = await harness.issueFixture(session);
  const number = issues.open[0];
  const response = await harness.query(ctx, ISSUE_BY_NUMBER, { owner: harness.viewer, name: harness.names.repository, number });
  const data = dataOf(response, `query IssueByNumber for #${number}`);
  const issue = at(data, 'repository', 'issue');
  if (!isRecord(issue)) throw new CheckFailure(`data.repository.issue is ${json(issue)}, expected #${number}`);
  if (issue.number !== number) throw new CheckFailure(`the issue read back as #${json(issue.number)}, expected #${number}`);
  if (issue.state !== 'OPEN') throw new CheckFailure(`issue #${number}'s state is ${json(issue.state)}, expected OPEN`);
  if (issue.title !== `${harness.names.titlePrefix} open 1`) {
    throw new CheckFailure(`issue #${number}'s title is ${json(issue.title)}, expected ${json(`${harness.names.titlePrefix} open 1`)}`);
  }
  if (issue.body !== harness.names.body) throw new CheckFailure(`issue #${number}'s body does not match the seeded body`);
  nonEmptyString(issue.id, `issue #${number}'s id`);
  return pass(`issue #${number} reads back with its title, state, body and id`);
}

/** 7. mutation IssueCreate — gh's `gh issue create`, then the REST view. */
async function createIssue(session: Session): Promise<CheckResult> {
  const { harness, ctx } = session;
  const repo = await harness.repoFixture(session);
  const title = `${harness.names.titlePrefix} created over graphql`;
  const response = await harness.query(ctx, CREATE_ISSUE, { input: { repositoryId: repo.id, title, body: harness.names.body } });
  const data = dataOf(response, 'mutation IssueCreate');
  const issue = at(data, 'createIssue', 'issue');
  if (!isRecord(issue)) throw new CheckFailure(`createIssue.issue is ${json(issue)}`);
  const number = positiveInteger(issue.number, 'createIssue.issue.number');
  nonEmptyString(issue.id, 'createIssue.issue.id');
  const rest = await harness.rest.get(`${repoPath(harness.viewer, harness.names.repository)}/issues/${number}`, { signal: ctx.signal, timeoutMs: ctx.timeoutMs });
  const created = restObject(rest, 200, `GET issue #${number} after creating it over GraphQL`);
  if (created.number !== number) throw new CheckFailure(`the REST view answers #${json(created.number)}, expected #${number}`);
  if (created.title !== title) throw new CheckFailure(`the REST view's title is ${json(created.title)}, expected ${json(title)}`);
  if (created.state !== 'open') throw new CheckFailure(`the REST view's state is ${json(created.state)}, expected open`);
  return pass(`createIssue made #${number} and the REST view reads it open with the same title`);
}

/** 8. mutation IssueClose — gh's `gh issue close`, then the REST view. */
async function closeIssue(session: Session): Promise<CheckResult> {
  const { harness, ctx } = session;
  await harness.repoFixture(session);
  const created = await harness.rest.post(
    `${repoPath(harness.viewer, harness.names.repository)}/issues`,
    { title: `${harness.names.titlePrefix} closed over graphql`, body: harness.names.body },
    { signal: ctx.signal, timeoutMs: ctx.timeoutMs },
  );
  const number = positiveInteger(restObject(created, 201, 'POST the issue to close').number, 'the issue number');
  const id = await harness.issueGlobalId(session, number);
  const response = await harness.query(ctx, CLOSE_ISSUE, { input: { issueId: id } });
  const data = dataOf(response, 'mutation IssueClose');
  const closed = at(data, 'closeIssue', 'issue');
  if (!isRecord(closed)) throw new CheckFailure(`closeIssue.issue is ${json(closed)}`);
  if (closed.number !== number) throw new CheckFailure(`closeIssue names #${json(closed.number)}, expected #${number}`);
  if (closed.state !== 'CLOSED') throw new CheckFailure(`closeIssue.issue.state is ${json(closed.state)}, expected CLOSED`);
  const rest = await harness.rest.get(`${repoPath(harness.viewer, harness.names.repository)}/issues/${number}`, { signal: ctx.signal, timeoutMs: ctx.timeoutMs });
  const read = restObject(rest, 200, `GET issue #${number} after closing it`);
  if (read.state !== 'closed') throw new CheckFailure(`the REST view's state is ${json(read.state)}, expected closed`);
  return pass(`closeIssue closed #${number} and the REST view shows it closed`);
}

/** 9. query PullRequests — gh's `gh pr list`. */
async function pullRequests(session: Session): Promise<CheckResult> {
  const { harness, ctx } = session;
  const pullRequest = await harness.pullRequestFixture(session);
  const response = await harness.query(ctx, PULL_REQUESTS, { owner: harness.viewer, name: harness.names.repository, first: 5 });
  const data = dataOf(response, 'query PullRequests');
  const nodes = arrayFrom(at(data, 'repository', 'pullRequests', 'nodes'));
  if (nodes.length > 5) return fail(`the pull request list has ${nodes.length} nodes for first: 5`);
  const node = nodes.find((entry) => at(entry, 'number') === pullRequest.number);
  if (node === undefined) return fail(`pull request #${pullRequest.number} is not in the open list: ${nodes.map((entry) => json(at(entry, 'number'))).join(', ')}`);
  const head = at(node, 'headRefName');
  const base = at(node, 'baseRefName');
  if (head !== harness.names.headBranch) throw new CheckFailure(`pull request #${pullRequest.number}'s headRefName is ${json(head)}, expected ${json(harness.names.headBranch)}`);
  if (base !== harness.names.baseBranch) throw new CheckFailure(`pull request #${pullRequest.number}'s baseRefName is ${json(base)}, expected ${json(harness.names.baseBranch)}`);
  if (at(node, 'state') !== 'OPEN') throw new CheckFailure(`pull request #${pullRequest.number}'s state is ${json(at(node, 'state'))}, expected OPEN`);
  const mergeable = at(node, 'mergeable');
  if (typeof mergeable !== 'string' || !['MERGEABLE', 'CONFLICTING', 'UNKNOWN'].includes(mergeable)) {
    throw new CheckFailure(`pull request #${pullRequest.number}'s mergeable is ${json(mergeable)}, expected MERGEABLE, CONFLICTING or UNKNOWN`);
  }
  return pass(`pull request #${pullRequest.number} lists with its head, base, state and mergeable`);
}

/** 10. query PullRequestFiles — the changed files of a pull request. */
async function pullRequestFiles(session: Session): Promise<CheckResult> {
  const { harness, ctx } = session;
  const pullRequest = await harness.pullRequestFixture(session);
  const response = await harness.query(ctx, PULL_REQUEST_FILES, {
    owner: harness.viewer,
    name: harness.names.repository,
    number: pullRequest.number,
  });
  const data = dataOf(response, `query PullRequestFiles for #${pullRequest.number}`);
  const node = at(data, 'repository', 'pullRequest');
  if (!isRecord(node)) throw new CheckFailure(`data.repository.pullRequest is ${json(node)}`);
  if (node.number !== pullRequest.number) throw new CheckFailure(`the pull request read back as #${json(node.number)}, expected #${pullRequest.number}`);
  const paths: string[] = [];
  for (const entry of arrayFrom(at(node, 'files', 'nodes'))) {
    const path = at(entry, 'path');
    if (typeof path === 'string' && path !== '') paths.push(path);
  }
  if (!paths.includes(harness.names.filePath)) {
    return fail(`pull request #${pullRequest.number}'s files do not include the changed path ${json(harness.names.filePath)}: ${paths.length === 0 ? 'none' : paths.join(', ')}`);
  }
  return pass(`pull request #${pullRequest.number}'s files include ${harness.names.filePath}`);
}

/** 11. mutation PullRequestCreate — gh's `gh pr create`. */
async function createPullRequest(session: Session): Promise<CheckResult> {
  const { harness, ctx } = session;
  const repo = await harness.repoFixture(session);
  await harness.branchFixture(session);
  const title = `${harness.names.titlePrefix} created over graphql`;
  const response = await harness.query(ctx, CREATE_PULL_REQUEST, {
    input: { repositoryId: repo.id, baseRefName: harness.names.baseBranch, headRefName: harness.names.createBranch, title },
  });
  const data = dataOf(response, 'mutation PullRequestCreate');
  const pullRequest = at(data, 'createPullRequest', 'pullRequest');
  if (!isRecord(pullRequest)) throw new CheckFailure(`createPullRequest.pullRequest is ${json(pullRequest)}`);
  const number = positiveInteger(pullRequest.number, 'createPullRequest.pullRequest.number');
  nonEmptyString(pullRequest.id, 'createPullRequest.pullRequest.id');
  if (pullRequest.state !== 'OPEN') throw new CheckFailure(`createPullRequest.pullRequest.state is ${json(pullRequest.state)}, expected OPEN`);
  if (pullRequest.headRefName !== harness.names.createBranch) {
    throw new CheckFailure(`createPullRequest.pullRequest.headRefName is ${json(pullRequest.headRefName)}, expected ${json(harness.names.createBranch)}`);
  }
  if (pullRequest.baseRefName !== harness.names.baseBranch) {
    throw new CheckFailure(`createPullRequest.pullRequest.baseRefName is ${json(pullRequest.baseRefName)}, expected ${json(harness.names.baseBranch)}`);
  }
  const rest = await harness.rest.get(`${repoPath(harness.viewer, harness.names.repository)}/pulls/${number}`, { signal: ctx.signal, timeoutMs: ctx.timeoutMs });
  const read = restObject(rest, 200, `GET pull request #${number} after creating it over GraphQL`);
  if (at(read, 'head', 'ref') !== harness.names.createBranch) {
    throw new CheckFailure(`the REST view's head.ref is ${json(at(read, 'head', 'ref'))}, expected ${json(harness.names.createBranch)}`);
  }
  if (at(read, 'base', 'ref') !== harness.names.baseBranch) {
    throw new CheckFailure(`the REST view's base.ref is ${json(at(read, 'base', 'ref'))}, expected ${json(harness.names.baseBranch)}`);
  }
  return pass(`createPullRequest made #${number} from ${harness.names.createBranch} and the REST view reads it`);
}

/** 12. mutation MergePullRequest — gh's `gh pr merge --squash`, then the REST view. */
async function mergePullRequest(session: Session): Promise<CheckResult> {
  const { harness, ctx } = session;
  const pullRequest = await harness.mergePullRequestFixture(session);
  const id = await harness.pullRequestGlobalId(session, pullRequest.number);
  const response = await harness.query(ctx, MERGE_PULL_REQUEST, { input: { pullRequestId: id, mergeMethod: 'SQUASH' } });
  const data = dataOf(response, `mutation MergePullRequest for #${pullRequest.number}`);
  const merged = at(data, 'mergePullRequest', 'pullRequest');
  if (!isRecord(merged)) throw new CheckFailure(`mergePullRequest.pullRequest is ${json(merged)}`);
  if (merged.merged !== true) throw new CheckFailure(`mergePullRequest.pullRequest.merged is ${json(merged.merged)}, expected true`);
  const rest = await harness.rest.get(`${repoPath(harness.viewer, harness.names.repository)}/pulls/${pullRequest.number}`, { signal: ctx.signal, timeoutMs: ctx.timeoutMs });
  const read = restObject(rest, 200, `GET pull request #${pullRequest.number} after merging it`);
  if (read.merged !== true) throw new CheckFailure(`the REST view's merged is ${json(read.merged)}, expected true`);
  if (read.state !== 'closed') throw new CheckFailure(`the REST view's state is ${json(read.state)}, expected closed after a merge`);
  return pass(`mergePullRequest squash-merged #${pullRequest.number} and the REST view shows merged: true, state closed`);
}

/** 13. mutation AddComment — a comment on an issue, then the REST view's comment list. */
async function addComment(session: Session): Promise<CheckResult> {
  const { harness, ctx } = session;
  await harness.repoFixture(session);
  const created = await harness.rest.post(
    `${repoPath(harness.viewer, harness.names.repository)}/issues`,
    { title: `${harness.names.titlePrefix} commented over graphql`, body: harness.names.body },
    { signal: ctx.signal, timeoutMs: ctx.timeoutMs },
  );
  const number = positiveInteger(restObject(created, 201, 'POST the issue to comment on').number, 'the issue number');
  const id = await harness.issueGlobalId(session, number);
  const response = await harness.query(ctx, ADD_COMMENT, { input: { subjectId: id, body: harness.names.comment } });
  const data = dataOf(response, 'mutation AddComment');
  const comment = at(data, 'addComment', 'commentEdge', 'node');
  if (!isRecord(comment)) throw new CheckFailure(`addComment.commentEdge.node is ${json(comment)}`);
  if (comment.body !== harness.names.comment) throw new CheckFailure('addComment did not echo the comment body');
  nonEmptyString(comment.id, 'addComment.commentEdge.node.id');
  const rest = await harness.rest.get(`${repoPath(harness.viewer, harness.names.repository)}/issues/${number}/comments`, { signal: ctx.signal, timeoutMs: ctx.timeoutMs });
  const comments = restArray(rest, 200, `GET issue #${number}'s comments`);
  if (!comments.some((entry) => at(entry, 'body') === harness.names.comment)) {
    return fail(`the REST comment list for issue #${number} does not hold the added comment`);
  }
  return pass(`addComment wrote a comment on #${number} and the REST view lists it`);
}

/** 14. An unknown field is a 200 with an `errors` array, not an HTTP 400. */
async function invalidField({ ctx, harness }: Session): Promise<CheckResult> {
  const response = await harness.query(ctx, INVALID_FIELD);
  if (response.transportError !== undefined) throw new CheckFailure(`query with an invalid field: ${response.transportError}`);
  if (response.status !== 200) return fail(`HTTP ${response.status} for a query with an invalid field, expected 200 with an errors array`);
  if (response.parseError !== undefined) throw new CheckFailure(`query with an invalid field: ${response.parseError}`);
  if (response.errors.length === 0) return fail('the response carries no errors array: the invalid field was not reported');
  if (!response.errors.some((error) => error.message.includes('noSuchFieldOnViewer'))) {
    return fail(`the errors do not name the invalid field: ${response.errors.map((error) => error.message).join('; ')}`);
  }
  return pass(`HTTP 200 with ${response.errors.length} GraphQL error(s) naming noSuchFieldOnViewer`);
}

/** 15. An unauthenticated query is a 401. */
async function unauthenticated({ ctx, harness }: Session): Promise<CheckResult> {
  const anon = harness.client.withoutToken();
  const response = await anon.request(VIEWER_LOGIN, {}, { signal: ctx.signal, timeoutMs: ctx.timeoutMs });
  if (response.transportError !== undefined) throw new CheckFailure(`unauthenticated query: ${response.transportError}`);
  if (response.status !== 401) return fail(`HTTP ${response.status} for an unauthenticated query, expected 401`);
  return pass('an unauthenticated POST /api/graphql is 401');
}

/** 16. Query.node(id:) — the Relay global id round-trips a repository. */
async function nodeRepository(session: Session): Promise<CheckResult> {
  const { harness, ctx } = session;
  const repo = await harness.repoFixture(session);
  const response = await harness.query(ctx, NODE_REPOSITORY, { id: repo.id });
  const data = dataOf(response, 'query NodeRepository');
  const node = at(data, 'node');
  if (!isRecord(node)) throw new CheckFailure(`data.node is ${json(node)}, expected the repository`);
  if (node.id !== repo.id) throw new CheckFailure(`data.node.id is ${json(node.id)}, expected ${json(repo.id)}`);
  if (node.name !== harness.names.repository) throw new CheckFailure(`data.node.name is ${json(node.name)}, expected ${json(harness.names.repository)}`);
  const nameWithOwner = `${harness.viewer}/${harness.names.repository}`;
  if (node.nameWithOwner !== nameWithOwner) throw new CheckFailure(`data.node.nameWithOwner is ${json(node.nameWithOwner)}, expected ${json(nameWithOwner)}`);
  return pass(`node(id:) round-trips repository ${nameWithOwner}`);
}

/** 17. A repository lookup for an unknown owner/name is data.repository = null and no errors. */
async function unknownRepository({ ctx, harness }: Session): Promise<CheckResult> {
  const response = await harness.query(ctx, REPOSITORY_FIELDS, { owner: harness.viewer, name: harness.names.unknownRepository });
  const data = dataOf(response, `query RepositoryFields for the unknown repository ${harness.names.unknownRepository}`);
  const repository = at(data, 'repository');
  if (repository !== null) return fail(`data.repository is ${json(repository)}, expected null`);
  return pass(`data.repository is null for ${json(harness.names.unknownRepository)} with no errors`);
}

/** 18. Two operation documents in one HTTP body (GitHub's operation batching). */
async function batchedOperations({ ctx, harness }: Session): Promise<CheckResult> {
  const response = await harness.client.batch([{ query: VIEWER_LOGIN }, { query: ISSUE_FIELDS }], { signal: ctx.signal, timeoutMs: ctx.timeoutMs });
  if (response.transportError !== undefined) throw new CheckFailure(`batched request: ${response.transportError}`);
  if (response.status !== 200) return fail(`HTTP ${response.status} for a batched request, expected 200`);
  if (response.parseError !== undefined) throw new CheckFailure(`batched request: ${response.parseError}`);
  if (response.responses.length !== 2) return fail(`the batched response holds ${response.responses.length} entries, expected 2`);
  const viewer = dataOf(response.responses[0], 'the batched viewer operation');
  const introspection = dataOf(response.responses[1], 'the batched Issue introspection operation');
  const login = at(viewer, 'viewer', 'login');
  if (login !== harness.viewer) return fail(`the first batched operation answered viewer.login ${json(login)}, expected ${json(harness.viewer)}`);
  const names = namesFrom(at(introspection, 'Issue', 'fields'));
  if (names.length === 0) return fail('the second batched operation answered an empty Issue fields list');
  return pass('two operation documents in one body answer two data objects in order');
}

/** 19. The global id is opaque and stable across reads. */
async function globalIdStability(session: Session): Promise<CheckResult> {
  const { harness, ctx } = session;
  const repo = await harness.repoFixture(session);
  const first = await harness.query(ctx, REPOSITORY_FIELDS, { owner: harness.viewer, name: harness.names.repository });
  const second = await harness.query(ctx, REPOSITORY_FIELDS, { owner: harness.viewer, name: harness.names.repository });
  const firstData = dataOf(first, 'the first repository read');
  const secondData = dataOf(second, 'the second repository read');
  const firstId = nonEmptyString(at(firstData, 'repository', 'id'), 'the repository id');
  const secondId = nonEmptyString(at(secondData, 'repository', 'id'), 'the repository id on the second read');
  if (firstId !== secondId) return fail(`the repository id changed between reads: ${json(firstId)} then ${json(secondId)}`);
  if (firstId === String(repo.databaseId)) return fail(`the repository id ${json(firstId)} is the plain databaseId, not an opaque global id`);
  const issues = await harness.issueFixture(session);
  const number = issues.open[0];
  const firstIssue = await harness.query(ctx, ISSUE_BY_NUMBER, { owner: harness.viewer, name: harness.names.repository, number });
  const secondIssue = await harness.query(ctx, ISSUE_BY_NUMBER, { owner: harness.viewer, name: harness.names.repository, number });
  const firstIssueData = dataOf(firstIssue, 'the first issue read');
  const secondIssueData = dataOf(secondIssue, 'the second issue read');
  const firstIssueId = nonEmptyString(at(firstIssueData, 'repository', 'issue', 'id'), `issue #${number}'s id`);
  const secondIssueId = nonEmptyString(at(secondIssueData, 'repository', 'issue', 'id'), `issue #${number}'s id on the second read`);
  if (firstIssueId !== secondIssueId) return fail(`issue #${number}'s id changed between reads: ${json(firstIssueId)} then ${json(secondIssueId)}`);
  if (firstIssueId === String(number)) return fail(`issue #${number}'s id ${json(firstIssueId)} is the plain number, not an opaque global id`);
  return pass('the repository and issue global ids are non-empty, opaque and equal on repeated reads');
}

/** 20. Cursor pagination on issues(first, after) with pageInfo. */
async function issuesPagination(session: Session): Promise<CheckResult> {
  const { harness, ctx } = session;
  const pages = await harness.pageFixture(session);
  const first = await harness.query(ctx, ISSUES_PAGE, {
    owner: harness.viewer,
    name: harness.names.pagesRepository,
    first: harness.names.pageSize,
    after: null,
  });
  const firstData = dataOf(first, 'the first issues page');
  const firstConnection = at(firstData, 'repository', 'issues');
  if (!isRecord(firstConnection)) throw new CheckFailure(`data.repository.issues is ${json(firstConnection)}`);
  const firstNodes = arrayFrom(firstConnection.nodes);
  if (firstNodes.length !== harness.names.pageSize) return fail(`the first page holds ${firstNodes.length} node(s), expected ${harness.names.pageSize}`);
  if (at(firstConnection, 'pageInfo', 'hasNextPage') !== true) return fail('the first page does not report hasNextPage: true');
  const cursor = at(firstConnection, 'pageInfo', 'endCursor');
  if (typeof cursor !== 'string' || cursor === '') return fail(`the first page's endCursor is ${json(cursor)}, expected a non-empty cursor`);
  const second = await harness.query(ctx, ISSUES_PAGE, {
    owner: harness.viewer,
    name: harness.names.pagesRepository,
    first: harness.names.pageSize,
    after: cursor,
  });
  const secondData = dataOf(second, 'the second issues page');
  const secondConnection = at(secondData, 'repository', 'issues');
  if (!isRecord(secondConnection)) throw new CheckFailure(`the second page's data.repository.issues is ${json(secondConnection)}`);
  const secondNodes = arrayFrom(secondConnection.nodes);
  if (secondNodes.length !== harness.names.pageCount - harness.names.pageSize) {
    return fail(`the second page holds ${secondNodes.length} node(s), expected ${harness.names.pageCount - harness.names.pageSize}`);
  }
  if (at(secondConnection, 'pageInfo', 'hasNextPage') !== false) return fail('the second page does not report hasNextPage: false');
  const seen = new Set<number>();
  for (const node of [...firstNodes, ...secondNodes]) {
    const number = positiveInteger(at(node, 'number'), 'a paged issue number');
    if (seen.has(number)) return fail(`issue #${number} appears on both pages`);
    seen.add(number);
  }
  const expected = new Set(pages.numbers);
  for (const number of seen) {
    if (!expected.has(number)) return fail(`the pages hold issue #${number}, which the fixture did not create`);
  }
  if (seen.size !== harness.names.pageCount) return fail(`the two pages hold ${seen.size} distinct issue(s), expected ${harness.names.pageCount}`);
  return pass(`${harness.names.pageCount} issues paged by the cursor as ${harness.names.pageSize} + ${harness.names.pageCount - harness.names.pageSize}`);
}

/** The check table: one entry per check, in the order the group lists them. */
const CHECK_TABLE: readonly { slug: string; title: string; timeoutMs: number; body: CheckBody }[] = [
  { slug: 'viewer-login', title: 'query { viewer { login } } answers the token owner', timeoutMs: 8_000, body: viewerLogin },
  { slug: 'repository-fields', title: 'repository(owner:, name:) answers id, databaseId, name, owner, defaultBranchRef, viewerPermission and hasIssuesEnabled', timeoutMs: 10_000, body: repositoryFields },
  { slug: 'introspection-issue', title: '__type(name: "Issue") lists the fields gh feature-detects', timeoutMs: 8_000, body: issueIntrospection },
  { slug: 'introspection-types', title: '__type lists PullRequest, Repository and SearchType (gh\'s other probes, one check)', timeoutMs: 10_000, body: typeIntrospection },
  { slug: 'issues-open-order', title: 'issues(first: 10, states: [OPEN], orderBy: CREATED_AT DESC) filters and orders', timeoutMs: 12_000, body: openIssues },
  { slug: 'issue-by-number', title: 'issue(number:) reads one issue', timeoutMs: 10_000, body: issueByNumber },
  { slug: 'create-issue', title: 'createIssue creates an issue the REST view sees', timeoutMs: 12_000, body: createIssue },
  { slug: 'close-issue', title: 'closeIssue closes an issue the REST view shows closed', timeoutMs: 12_000, body: closeIssue },
  { slug: 'pull-requests-list', title: 'pullRequests(first: 5) lists number, headRefName, baseRefName, mergeable and state', timeoutMs: 15_000, body: pullRequests },
  { slug: 'pull-request-files', title: 'pullRequest(number:).files lists the changed paths', timeoutMs: 12_000, body: pullRequestFiles },
  { slug: 'create-pull-request', title: 'createPullRequest creates a pull request', timeoutMs: 15_000, body: createPullRequest },
  { slug: 'merge-pull-request', title: 'mergePullRequest SQUASH merges and the REST view shows merged: true', timeoutMs: 15_000, body: mergePullRequest },
  { slug: 'add-comment', title: 'addComment writes an issue comment the REST view lists', timeoutMs: 12_000, body: addComment },
  { slug: 'invalid-field', title: 'an invalid field is a 200 with an errors array', timeoutMs: 8_000, body: invalidField },
  { slug: 'unauthenticated', title: 'an unauthenticated query is a 401', timeoutMs: 8_000, body: unauthenticated },
  { slug: 'node-repository', title: 'node(id:) round-trips a repository', timeoutMs: 10_000, body: nodeRepository },
  { slug: 'unknown-repository', title: 'an unknown repository reads data.repository = null with no errors', timeoutMs: 8_000, body: unknownRepository },
  { slug: 'batched-operations', title: 'two operation documents in one body answer in order', timeoutMs: 10_000, body: batchedOperations },
  { slug: 'global-id-stability', title: 'global ids are opaque and equal on repeated reads', timeoutMs: 12_000, body: globalIdStability },
  { slug: 'issues-pagination', title: 'issues(first, after) pages by cursor to the end', timeoutMs: 12_000, body: issuesPagination },
];

/** The group's 20 checks, as the manifest's registry takes them. */
export const GRAPHQL_CHECKS: readonly CheckSpec[] = Object.freeze(
  CHECK_TABLE.map((entry) => {
    const body = entry.body;
    return Object.freeze({
      id: checkId('graphql', entry.slug),
      group: 'graphql' as const,
      title: entry.title,
      timeoutMs: entry.timeoutMs,
      fn: async (context: CheckContext): Promise<CheckResult> => {
        try {
          if (!Number.isFinite(context.timeoutMs) || context.timeoutMs <= 0) return fail('deadline');
          return await body(sessionOf(context));
        } catch (err) {
          if (err instanceof CheckFailure) return fail(err.message);
          return fail(`check threw: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
        }
      },
    });
  }),
);

/** Every check id in the group, in table order. */
export const GRAPHQL_CHECK_IDS: readonly string[] = Object.freeze(GRAPHQL_CHECKS.map((check) => check.id));
