// GraphQL v4: POST /api/graphql answering the documents gh and github-mcp-server send.
import type { Forge, ForgeRepo, ForgeIssue, ForgePull } from './store.ts';
import { repoJson, userJson, issueJson, pullJson } from './rest.ts';

export interface GraphQLCtx {
  forge: Forge;
  token: string | null;
  method: string;
  query: URLSearchParams;
  rawBody: Buffer;
  parsed: unknown;
  malformed: boolean;
  json: (status: number, body: unknown, headers?: Record<string, string>) => void;
}

interface GqlError { message: string; type?: string; path?: readonly (string | number)[] }

function gqlResponse(ctx: GraphQLCtx, status: number, data: unknown, errors?: readonly GqlError[]): void {
  const body: Record<string, unknown> = { data };
  if (errors !== undefined && errors.length > 0) body.errors = errors;
  ctx.json(status, body);
}

function fieldError(ctx: GraphQLCtx, path: readonly (string | number)[], message: string): void {
  const data: Record<string, unknown> = {};
  let cursor: Record<string, unknown> = data;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = String(path[i]);
    const next: Record<string, unknown> = {};
    cursor[key] = next;
    cursor = next;
  }
  cursor[String(path[path.length - 1])] = null;
  gqlResponse(ctx, 200, data, [{ message, type: 'NOT_FOUND', path }]);
}

function errorMessage(ctx: GraphQLCtx, message: string, status = 400): void {
  ctx.json(status, { message });
}

function isEmptySelection(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'object' && !Array.isArray(value)) return Object.keys(value as Record<string, unknown>).length === 0;
  return false;
}

function str(value: unknown): string { return typeof value === 'string' ? value : ''; }


/** Static schema slices for the introspection probes gh sends. */
const INTROSPECTION_TYPES: Record<string, { fields: readonly string[]; enumValues?: readonly string[] }> = {
  Issue: { fields: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'closedAt', 'labels', 'comments', 'repository', 'viewerCanClose'] },
  PullRequest: { fields: ['id', 'number', 'title', 'state', 'merged', 'mergeable', 'body', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'comments', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'repository'] },
  Repository: { fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'isFork', 'isEmpty', 'defaultBranchRef', 'ref', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'pushedAt', 'url'] },
  SearchType: { fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER'] },
};

export async function handleGraphQL(ctx: GraphQLCtx): Promise<void> {
  const { forge } = ctx;
  if (ctx.method !== 'POST') {
    errorMessage(ctx, 'Not Found', 404);
    return;
  }
  if (ctx.token === null) {
    ctx.json(401, { message: 'Requires authentication' });
    return;
  }
  if (ctx.malformed) {
    errorMessage(ctx, 'Problems parsing JSON');
    return;
  }
  if (Array.isArray(ctx.parsed)) {
    const results: unknown[] = [];
    for (const entry of ctx.parsed as Array<{ query?: unknown; variables?: Record<string, unknown> | null }>) {
      if (typeof entry?.query !== 'string') {
        results.push({ data: null, errors: [{ message: 'Problems parsing JSON' }] });
        continue;
      }
      const subCtx: GraphQLCtx = { ...ctx, parsed: entry };
      const captured: unknown[] = [];
      subCtx.json = (_status: number, responseBody: unknown) => { captured.push(responseBody); };
      await handleGraphQL(subCtx);
      results.push(captured[0] ?? { data: null, errors: [{ message: 'no response' }] });
    }
    ctx.json(200, results);
    return;
  }
  const body = ctx.parsed as { query?: unknown; variables?: Record<string, unknown> | null } | undefined;
  if (typeof body?.query !== 'string') {
    errorMessage(ctx, 'Problems parsing JSON');
    return;
  }
  const document = body.query;
  const variables = body.variables ?? {};

  // viewer query
  if (document.includes('viewer {') || /viewer\s*\{/.test(document)) {
    const viewer = forge.viewer;
    {
      const unknownFields = /viewer\s*\{([^}]*)\}/.exec(document);
      const errors: GqlError[] = [];
      if (unknownFields !== null) {
        for (const f of unknownFields[1].match(/\b\w+\b/g) ?? []) {
          if (!(f in { login: 1, name: 1, email: 1, avatarUrl: 1, url: 1, resourcePath: 1, createdAt: 1 })) {
            errors.push({ message: `Field '${f}' doesn't exist on type 'Viewer'`, type: 'VALIDATION' });
          }
        }
      }
      const data: Record<string, unknown> = {
        viewer: {
          login: viewer.login,
          name: viewer.name,
          email: viewer.email,
          avatarUrl: `https://forge.invalid/avatars/${viewer.login}.png`,
          url: `https://forge.invalid/${viewer.login}`,
          resourcePath: `/${viewer.login}`,
          createdAt: '2026-10-28T00:00:00Z',
        },
      };
      gqlResponse(ctx, 200, data, errors);
      return;
    }
  }

  // node(id:) query
  if (document.includes('node(') || document.includes('node (')) {
    const idVar = typeof variables.id === 'string' ? variables.id : /node\(id:\s*"([^"]+)"/.exec(document)?.[1] ?? null;
    let node: Record<string, unknown> | null = null;
    if (idVar !== null) {
      if (idVar.startsWith('repo_')) {
        const numeric = Number.parseInt(idVar.slice(5), 10);
        for (const r of forge.repos.values()) {
          if (r.id === numeric) { node = { id: `repo_${r.id}`, name: r.name, nameWithOwner: `${r.owner}/${r.name}` }; break; }
        }
      } else {
        const found = findIssueNode(forge, idVar);
        if (found !== null) node = { id: idVar, ...pickIssueNodeFields(found.issue, document) };
      }
    }
    gqlResponse(ctx, 200, { node });
    return;
  }


  // introspection: __type(name: "T") { fields { name } } / { enumValues { name } }
  if (document.includes('__type')) {
    const data: Record<string, unknown> = {};
    const aliases = /([\w]+):\s*__type\(name:\s*"([\w]+)"\)/g;
    let m: RegExpExecArray | null;
    let answered = false;
    while ((m = aliases.exec(document)) !== null) {
      const key = m[1];
      const typeName = m[2];
      const spec = INTROSPECTION_TYPES[typeName];
      if (spec === undefined) continue;
      answered = true;
      if (document.includes('enumValues')) {
        data[key] = { enumValues: spec.enumValues?.map((name) => ({ name })) ?? null };
      } else {
        data[key] = { fields: spec.fields.map((name) => ({ name })) };
      }
    }
    if (answered) {
      gqlResponse(ctx, 200, data);
      return;
    }
    gqlResponse(ctx, 200, {}, [{ message: 'The query is not supported by this server', type: 'NOT_SUPPORTED' }]);
    return;
  }

  // repository query
  const ownerMatch = /owner:\s*"([^"]+)"/.exec(document);
  const nameMatch = /name:\s*"([^"]+)"/.exec(document);
  const ownerVar = variables.owner ?? variables.repositoryOwner;
  const nameVar = variables.name ?? variables.repo ?? variables.repositoryName;
  const owner = ownerMatch !== null ? ownerMatch[1] : (typeof ownerVar === 'string' ? ownerVar : null);
  const name = nameMatch !== null ? nameMatch[1] : (typeof nameVar === 'string' ? nameVar : null);

  if (document.includes('repository(') || document.includes('repository (')) {
    if (owner === null || name === null) {
      gqlResponse(ctx, 200, { repository: null }, [{ message: 'owner and name are required', type: 'MISSING_INPUTS' }]);
      return;
    }
    const repo = forge.repo(owner, name);
    if (repo === undefined) {
      gqlResponse(ctx, 200, { repository: null });
      return;
    }
    const data: Record<string, unknown> = { repository: repositoryObject(forge, repo, document, variables) };
    gqlResponse(ctx, 200, data);
    return;
  }

  // issues / pulls list queries without a repository() wrapper: treat as a repository query
  if (document.includes('issues(') || document.includes('pullRequests(')) {
    if (owner === null || name === null) {
      gqlResponse(ctx, 200, null, [{ message: 'owner and name are required', type: 'MISSING_INPUTS' }]);
      return;
    }
    const repo = forge.repo(owner, name);
    if (repo === undefined) {
      gqlResponse(ctx, 200, { repository: null });
      return;
    }
    const data: Record<string, unknown> = { repository: repositoryObject(forge, repo, document, variables) };
    gqlResponse(ctx, 200, data);
    return;
  }

  // mutation dispatch
  if (document.includes('createRepository') || document.includes('createRepo')) {
    const name = str(variables.name ?? readInputString(document, variables, 'name'));
    if (name === '') {
      gqlResponse(ctx, 200, null, [{ message: 'name is required', type: 'VALIDATION' }]);
      return;
    }
    if (forge.repo(forge.viewer.login, name) !== undefined) {
      gqlResponse(ctx, 200, null, [{ message: 'Name already exists on this account', type: 'UNPROCESSABLE' }]);
      return;
    }
    const description = str(variables.description ?? readInputString(document, variables, 'description'));
    const isPrivate = variables.privacy === 'PRIVATE' || variables.private === true || readInputBool(document, variables, 'private') === true;
    const repo = forge.createRepo(forge.viewer.login, name, description, isPrivate);
    const payload: Record<string, unknown> = {
      createRepository: { repository: repositoryObject(forge, repo, document, variables) },
    };
    gqlResponse(ctx, 200, payload);
    return;
  }

  if (document.includes('createIssue')) {
    const repoInfo = readRepoInput(document, variables);
    let repo = repoInfo === null ? undefined : forge.repo(repoInfo.owner, repoInfo.name);
    if (repo === undefined) {
      const inputObj = Object.values(variables).find((v) => typeof v === 'object' && v !== null && !Array.isArray(v)) as Record<string, unknown> | undefined;
      const repoId = typeof inputObj?.repositoryId === 'string' ? inputObj.repositoryId : null;
      if (repoId !== null) {
        const numeric = Number.parseInt(repoId.replace(/^repo_/, ''), 10);
        for (const r of forge.repos.values()) {
          if (r.id === numeric || `repo_${r.id}` === repoId) { repo = r; break; }
        }
      }
    }
    if (repo === undefined) {
      gqlResponse(ctx, 200, null, [{ message: 'Could not resolve to a Repository', type: 'NOT_FOUND' }]);
      return;
    }
    const title = str(variables.title ?? readInputString(document, variables, 'title'));
    const text = str(variables.body ?? readInputString(document, variables, 'body'));
    const issue = forge.createIssue(repo, title, text, []);
    gqlResponse(ctx, 200, { createIssue: { issue: issueObject(issue, repo) } });
    return;
  }

  if (document.includes('createPullRequest')) {
    const repoInfo = readRepoInput(document, variables);
    let repo = repoInfo === null ? undefined : forge.repo(repoInfo.owner, repoInfo.name);
    if (repo === undefined) {
      const inputObj = Object.values(variables).find((v) => typeof v === 'object' && v !== null && !Array.isArray(v)) as Record<string, unknown> | undefined;
      const repoId = typeof inputObj?.repositoryId === 'string' ? inputObj.repositoryId : null;
      if (repoId !== null) {
        const numeric = Number.parseInt(repoId.replace(/^repo_/, ''), 10);
        for (const r of forge.repos.values()) {
          if (r.id === numeric || `repo_${r.id}` === repoId) { repo = r; break; }
        }
      }
    }
    if (repo === undefined) {
      gqlResponse(ctx, 200, null, [{ message: 'Could not resolve to a Repository', type: 'NOT_FOUND' }]);
      return;
    }
    const title = str(variables.title ?? readInputString(document, variables, 'title'));
    const text = str(variables.body ?? readInputString(document, variables, 'body'));
    const head = str(variables.headRefName ?? readInputString(document, variables, 'headRefName') ?? readInputString(document, variables, 'head'));
    const base = str(variables.baseRefName ?? readInputString(document, variables, 'baseRefName') ?? readInputString(document, variables, 'base'));
    if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
      gqlResponse(ctx, 200, null, [{ message: 'Head and base refs must exist', type: 'UNPROCESSABLE' }]);
      return;
    }
    const pull = forge.createPull(repo, title, text, head, base);
    gqlResponse(ctx, 200, { createPullRequest: { pullRequest: pullObject(pull, repo) } });
    return;
  }

  if (document.includes('mergePullRequest')) {
    const pullId = str(variables.pullRequestId ?? readInputString(document, variables, 'pullRequestId'));
    const found = findPullById(forge, pullId);
    if (found === null) {
      gqlResponse(ctx, 200, null, [{ message: `Could not resolve to a node with the global id of '${pullId}'`, type: 'NOT_FOUND' }]);
      return;
    }
    const mergeSha = forge.mergePull(found.repo, found.pull);
    if (mergeSha === null) {
      gqlResponse(ctx, 200, null, [{ message: 'Pull Request is not mergeable', type: 'UNPROCESSABLE' }]);
      return;
    }
    gqlResponse(ctx, 200, { mergePullRequest: { pullRequest: pullObject(found.pull, found.repo) } });
    return;
  }

  if (document.includes('addIssueComment') || document.includes('addComment')) {
    const id = str(variables.subjectId ?? readInputString(document, variables, 'subjectId'));
    const text = str(variables.body ?? readInputString(document, variables, 'body'));
    const found = findIssueById(forge, id);
    if (found === null) {
      gqlResponse(ctx, 200, null, [{ message: `Could not resolve to a node with the global id of '${id}'`, type: 'NOT_FOUND' }]);
      return;
    }
    const comment = forge.createComment(found.repo, found.issue, text);
    gqlResponse(ctx, 200, { addComment: { commentEdge: { node: { id: `node_${comment.id}`, body: comment.body, createdAt: comment.createdAt } } } });
    return;
  }

  if (document.includes('closeIssue')) {
    const id = str(variables.issueId ?? readInputString(document, variables, 'issueId') ?? readInputString(document, variables, 'id'));
    const found = findIssueById(forge, id);
    if (found === null) {
      gqlResponse(ctx, 200, null, [{ message: `Could not resolve to a node with the global id of '${id}'`, type: 'NOT_FOUND' }]);
      return;
    }
    found.issue.state = 'closed';
    found.issue.closedAt = new Date().toISOString();
    found.issue.updatedAt = found.issue.closedAt;
    gqlResponse(ctx, 200, { closeIssue: { issue: issueObject(found.issue, found.repo) } });
    return;
  }

  // unknown document: empty data with a parse-ish error
  gqlResponse(ctx, 200, null, [{ message: 'The query is not supported by this server', type: 'UNSUPPORTED' }]);
}

function readRepoInput(document: string, variables: Record<string, unknown>): { owner: string; name: string } | null {
  const ownerVar = variables.owner ?? variables.repositoryOwner;
  const nameVar = variables.name ?? variables.repo ?? variables.repositoryName;
  if (typeof ownerVar === 'string' && typeof nameVar === 'string') return { owner: ownerVar, name: nameVar };
  // input: {…} object variable
  for (const value of Object.values(variables)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      if (typeof obj.owner === 'string' && typeof obj.name === 'string') return { owner: obj.owner, name: obj.name };
      if (typeof obj.repositoryId === 'string' || typeof obj.repoId === 'string') {
        // resolve via node id later; unsupported here
        return null;
      }
    }
  }
  // literal input block in the document
  const inputMatch = /input:\s*\{([^}]*)\}/.exec(document);
  if (inputMatch !== null) {
    const ownerM = /owner:\s*"([^"]+)"/.exec(inputMatch[1]);
    const nameM = /name:\s*"([^"]+)"/.exec(inputMatch[1]);
    if (ownerM !== null && nameM !== null) return { owner: ownerM[1], name: nameM[1] };
  }
  return null;
}

function readInputString(document: string, variables: Record<string, unknown>, field: string): string | undefined {
  const direct = variables[field];
  if (typeof direct === 'string') return direct;
  for (const value of Object.values(variables)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const inner = (value as Record<string, unknown>)[field];
      if (typeof inner === 'string') return inner;
    }
  }
  const inputMatch = /input:\s*\{([^}]*)\}/.exec(document);
  if (inputMatch !== null) {
    const m = new RegExp(`${field}:\s*"([^"]*)"`).exec(inputMatch[1]);
    if (m !== null) return m[1];
  }
  return undefined;
}

function readInputBool(document: string, variables: Record<string, unknown>, field: string): boolean | undefined {
  const direct = variables[field];
  if (typeof direct === 'boolean') return direct;
  for (const value of Object.values(variables)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const inner = (value as Record<string, unknown>)[field];
      if (typeof inner === 'boolean') return inner;
    }
  }
  const inputMatch = /input:\s*\{([^}]*)\}/.exec(document);
  if (inputMatch !== null) {
    const m = new RegExp(`${field}:\s*(true|false)`).exec(inputMatch[1]);
    if (m !== null) return m[1] === 'true';
  }
  return undefined;
}

function findPullById(forge: Forge, nodeId: string): { repo: ForgeRepo; pull: ForgePull } | null {
  for (const repo of forge.repos.values()) {
    for (const pull of repo.pulls) {
      if (`node_${pull.id}` === nodeId || `PR_${pull.id}` === nodeId || `P_${pull.id}` === nodeId) return { repo, pull };
    }
  }
  return null;
}

function findIssueById(forge: Forge, nodeId: string): { repo: ForgeRepo; issue: ForgeIssue } | null {
  for (const repo of forge.repos.values()) {
    for (const issue of repo.issues) {
      if (`node_${issue.id}` === nodeId || `I_${issue.id}` === nodeId) return { repo, issue };
    }
  }
  return null;
}


function pickIssueNodeFields(issue: ForgeIssue, document: string): Record<string, unknown> {
  const out: Record<string, unknown> = { id: `node_${issue.id}`, number: issue.number, title: issue.title, state: issue.state === 'open' ? 'OPEN' : 'CLOSED', body: issue.body };
  if (!document.includes('number') && !document.includes('title')) return { id: out.id };
  return out;
}

// ---- object renderers honouring the requested selection set ----

function wants(document: string, field: string): boolean {
  // crude but effective: the field name appears in the document
  return document.includes(field);
}

function repositoryObject(forge: Forge, repo: ForgeRepo, document: string, variables: Record<string, unknown>): Record<string, unknown> {
  const base = repoJson(repo);
  const out: Record<string, unknown> = {
    id: `repo_${repo.id}`,
    databaseId: repo.id,
    hasIssuesEnabled: true,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: userJson(forge.users.find((u) => u.login === repo.owner) ?? forge.viewer),
    description: repo.description,
    isPrivate: repo.isPrivate,
    isFork: false,
    isEmpty: repo.refs.size === 0,
    defaultBranchRef: { name: repo.defaultBranch, target: null },
    url: `https://forge.invalid/${repo.owner}/${repo.name}`,
    resourcePath: `/${repo.owner}/${repo.name}`,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    pushedAt: repo.pushedAt,
    viewerPermission: 'ADMIN',
  };
  // ref lookup: ref(qualifiedName: "refs/heads/x") { target { oid } }
  if (wants(document, 'ref(') || document.includes('ref (')) {
    const refMatch = /qualifiedName:\s*"([^"]+)"/.exec(document);
    const qualified = refMatch !== null ? refMatch[1] : `refs/heads/${repo.defaultBranch}`;
    const sha = repo.refs.get(qualified);
    out.ref = sha === undefined
      ? null
      : { name: qualified.replace(/^refs\/heads\//, ''), target: commitNode(forge, sha, document) };
  }
  if (wants(document, 'issue(') || wants(document, 'issue {')) {
    const numM = /issue\(number:\s*([\w$]+)/.exec(document);
    let num: number | null = null;
    if (numM !== null) {
      const raw = numM[1].replace(/^\$/, '');
      num = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : (typeof variables[raw] === 'number' ? variables[raw] as number : null);
    }
    const found = num !== null ? repo.issues.find((i2) => i2.number === num) : undefined;
    out.issue = found === undefined ? null : issueObject(found, repo);
  }
  if (wants(document, 'pullRequest(') || wants(document, 'pullRequest {')) {
    const numM = /pullRequest\(number:\s*([\w$]+)/.exec(document);
    let num: number | null = null;
    if (numM !== null) {
      const raw = numM[1].replace(/^\$/, '');
      num = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : (typeof variables[raw] === 'number' ? variables[raw] as number : null);
    }
    const found = num !== null ? repo.pulls.find((p2) => p2.number === num) : undefined;
    out.pullRequest = found === undefined ? null : pullObject(found, repo);
  }
  if (wants(document, 'issues(') || wants(document, 'issues {')) {
    let issueNodes = repo.issues.map((issue) => issueObject(issue, repo));
    if (/orderBy:\s*\{[^}]*direction:\s*DESC/.test(document)) {
      issueNodes = issueNodes.slice().sort((a, b) => (b.number as number) - (a.number as number));
    } else {
      issueNodes = issueNodes.slice().sort((a, b) => (a.number as number) - (b.number as number));
    }
    if (document.includes('states: [OPEN]') || document.includes('states:OPEN')) {
      issueNodes = issueNodes.filter((n) => n.state === 'OPEN');
    } else if (document.includes('states: [CLOSED]') || document.includes('states:CLOSED')) {
      issueNodes = issueNodes.filter((n) => n.state === 'CLOSED');
    }
    out.issues = connection(issueNodes, document, 'issues', variables);
  }
  if (wants(document, 'pullRequests(') || wants(document, 'pullRequests {')) {
    out.pullRequests = connection(repo.pulls.map((pull) => pullObject(pull, repo)), document, 'pullRequests', variables);
  }
  if (wants(document, 'object(') || document.includes('object (')) {
    const exprMatch = /object\(\s*(?:expression:\s*"([^"]*)")?[^)]*\)/.exec(document);
    const expression = exprMatch !== null && exprMatch[1] !== undefined ? exprMatch[1] : repo.defaultBranch;
    const sha = repo.refs.get(`refs/heads/${expression}`) ?? repo.refs.get(expression);
    out.object = sha === undefined ? null : commitNode(forge, sha, document);
  }
  void variables;
  // strip anything the document never asked for? keep: extra fields are tolerated
  return { ...base, ...out };
}

function connection(nodes: readonly Record<string, unknown>[], document: string, field: string, variables: Record<string, unknown> = {}): Record<string, unknown> {
  const args = connectionArgs(document, field);
  const first = resolveInt(args.first, variables) ?? 30;
  const start = resolveInt(args.after, variables) ?? 0;
  const page = nodes.slice(start, start + first);
  return {
    totalCount: nodes.length,
    pageInfo: {
      hasNextPage: start + first < nodes.length,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? String(start + 1) : null,
      endCursor: page.length > 0 ? String(start + page.length) : null,
    },
    edges: page.map((node, index) => ({ node, cursor: String(start + index + 1) })),
    nodes: page,
  };
}

/** Read `field(first: $first, after: $after)`'s argument expressions from a document. */
function connectionArgs(document: string, field: string): Record<string, string> {
  const out: Record<string, string> = {};
  let from = document.indexOf(`${field}(`);
  while (from >= 0) {
    const open = from + field.length;
    let depth = 0;
    let end = -1;
    for (let i = open; i < document.length; i += 1) {
      const ch = document[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') { depth -= 1; if (depth === 0) { end = i; break; } }
    }
    if (end > open) {
      const inside = document.slice(open + 1, end);
      for (const part of inside.split(',')) {
        const colon = part.indexOf(':');
        if (colon < 0) continue;
        const key = part.slice(0, colon).trim();
        if (key !== '') out[key] = part.slice(colon + 1).trim();
      }
      return out;
    }
    from = document.indexOf(`${field}(`, from + 1);
  }
  return out;
}

function resolveInt(expression: string | undefined, variables: Record<string, unknown>): number | null {
  if (expression === undefined || expression === 'null') return null;
  if (/^\d+$/.test(expression)) return Number.parseInt(expression, 10);
  const name = expression.startsWith('$') ? expression.slice(1) : expression;
  const value = variables[name];
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function commitNode(forge: Forge, sha: string, document: string): Record<string, unknown> | null {
  const obj = forge.store.get(sha);
  if (obj === undefined) return null;
  const info = parseCommitSafe(obj.data);
  return {
    id: `commit_${sha}`,
    oid: sha,
    abbreviatedOid: sha.slice(0, 7),
    message: info.message,
    messageHeadline: info.message.split('\n')[0] ?? '',
    messageBody: info.message.split('\n').slice(1).join('\n').trim(),
    committedDate: new Date(info.committer.epochSec * 1000).toISOString(),
    authoredDate: new Date(info.author.epochSec * 1000).toISOString(),
    pushedDate: new Date(info.committer.epochSec * 1000).toISOString(),
    author: { name: info.author.name, email: info.author.email, date: new Date(info.author.epochSec * 1000).toISOString(), user: null },
    committer: { name: info.committer.name, email: info.committer.email, date: new Date(info.committer.epochSec * 1000).toISOString(), user: null },
    parents: info.parents.map((p) => ({ oid: p, abbreviatedOid: p.slice(0, 7) })),
    tree: { oid: info.tree, entries: null },
    additions: 0,
    deletions: 0,
    changedFiles: 0,
  };
  void document;
}

function issueObject(issue: ForgeIssue, repo: ForgeRepo): Record<string, unknown> {
  return {
    id: `node_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    author: userJson(issue.user),
    labels: { totalCount: issue.labels.length, nodes: issue.labels.map((l) => ({ id: `label_${l.name}`, name: l.name, color: l.color })) },
    comments: { totalCount: issue.comments.length, nodes: issue.comments.map((c) => ({ id: `node_${c.id}`, body: c.body, createdAt: c.createdAt, author: userJson(c.user) })) },
    url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    resourcePath: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullObject(pull: ForgePull, repo: ForgeRepo): Record<string, unknown> {
  return {
    id: `node_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergedAt: pull.mergedAt,
    mergeable: pull.merged ? 'MERGED' : 'MERGEABLE',
    mergeCommit: pull.mergeCommitSha === null ? null : { oid: pull.mergeCommitSha },
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRefOid: pull.headSha,
    baseRefOid: pull.baseSha,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    author: userJson(pull.user),
    files: { totalCount: pull.files.length, nodes: pull.files.map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions, changeCount: f.changes })) },
    commits: { totalCount: 1, nodes: [{ commit: commitNodeCacheSafe(pull.headSha) }] },
    url: `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    resourcePath: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function commitNodeCacheSafe(sha: string): Record<string, unknown> | null {
  if (sha === '') return null;
  return { oid: sha, abbreviatedOid: sha.slice(0, 7) };
}

function parseCommitSafe(data: Buffer): { tree: string; parents: string[]; author: { name: string; email: string; epochSec: number }; committer: { name: string; email: string; epochSec: number }; message: string } {
  const text = data.toString('utf8');
  const info = { tree: '', parents: [] as string[], author: { name: '', email: '', epochSec: 0 }, committer: { name: '', email: '', epochSec: 0 }, message: '' };
  const lines = text.split('\n');
  let i = 0;
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === '') { i += 1; break; }
    const sp = line.indexOf(' ');
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1);
    if (key === 'tree') info.tree = value;
    else if (key === 'parent') info.parents.push(value);
    else if (key === 'author' || key === 'committer') {
      const lt = value.lastIndexOf('<');
      const gt = value.lastIndexOf('>');
      const ident = {
        name: value.slice(0, lt).trim(),
        email: value.slice(lt + 1, gt),
        epochSec: Number.parseInt(value.slice(gt + 1).trim().split(' ')[0] ?? '0', 10) || 0,
      };
      if (key === 'author') info.author = ident; else info.committer = ident;
    }
  }
  info.message = lines.slice(i).join('\n').replace(/\n$/, '');
  return info;
}
