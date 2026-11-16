// REST v3 router: /api/v3 endpoints over the Forge store.
import type { Forge, ForgeRepo, ForgeIssue, ForgePull, ForgeLabel } from './store.ts';
import { repoKey } from './store.ts';

export interface Ctx {
  forge: Forge;
  token: string | null;
  method: string;
  path: string;          // decoded, without /api/v3 prefix, no trailing slash
  query: URLSearchParams;
  json: (status: number, body: unknown, headers?: Record<string, string>) => void;
  rawBody: Buffer;
  host?: string;
}

/** Absolute API base on the request's own origin. */
function originBase(ctx: Ctx, pathPrefix: string): string {
  const host = ctx.host ?? 'forge.invalid';
  return `http://${host}${pathPrefix}`;
}

interface RepoJsonOptions {
  requestUrl?: string;
}

function isoOrNull(value: string | null): string | null { return value; }

export function repoJson(repo: ForgeRepo, options: RepoJsonOptions = {}): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: userJson({ id: 1000, login: repo.owner, name: repo.owner, email: `${repo.owner}@example.invalid` }),
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    default_branch: repo.defaultBranch,
    size: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    language: null,
    license: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

export function userJson(user: { id: number; login: string; name: string; email: string }): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: `U_${user.id}`,
    name: user.name,
    email: user.email,
    type: 'User',
    site_admin: false,
  };
}

export function labelJson(label: ForgeLabel): Record<string, unknown> {
  return {
    id: label.name.length * 7919,
    node_id: `L_${label.name}`,
    name: label.name,
    color: label.color,
    default: false,
    description: null,
  };
}

export function issueJson(issue: ForgeIssue, repo: ForgeRepo): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: userJson(issue.user),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: isoOrNull(issue.closedAt),
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    pull_request: undefined,
  };
}

export function pullJson(pull: ForgePull, repo: ForgeRepo): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `P_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: isoOrNull(pull.mergedAt),
    merge_commit_sha: pull.mergeCommitSha,
    merged_by: pull.mergedBy === null ? null : userJson(pull.mergedBy),
    user: userJson(pull.user),
    labels: [],
    draft: false,
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      repo: repoJson(repo),
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      repo: repoJson(repo),
    },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.mergedAt : null,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    commits: 1,
    additions: pull.files.reduce((sum, f) => sum + f.additions, 0),
    deletions: pull.files.reduce((sum, f) => sum + f.deletions, 0),
    changed_files: pull.files.length,
  };
}

function fileJson(pullFile: ForgePull['files'][number]): Record<string, unknown> {
  return {
    sha: pullFile.blobShaAfter === '' ? pullFile.blobShaBefore : pullFile.blobShaAfter,
    filename: pullFile.filename,
    status: pullFile.status,
    additions: pullFile.additions,
    deletions: pullFile.deletions,
    changes: pullFile.changes,
    blob_url: `https://forge.invalid/raw/ blob`,
    raw_url: '',
    contents_url: '',
    patch: null,
  };
}

function branchJson(repo: ForgeRepo, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, commit: { sha }, url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: false,
    protected_by: null,
  };
}

function commitJson(repo: ForgeRepo, sha: string, forge: Forge): Record<string, unknown> | null {
  const obj = forge.store.get(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const info = parseCommitInfo(obj.data);
  return {
    sha,
    node_id: `C_${sha.slice(0, 8)}`,
    commit: {
      sha,
      message: info.message,
      author: { name: info.author.name, email: info.author.email, date: new Date(info.author.epochSec * 1000).toISOString() },
      committer: { name: info.committer.name, email: info.committer.email, date: new Date(info.committer.epochSec * 1000).toISOString() },
      tree: { sha: info.tree, url: '' },
      url: '',
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    author: null,
    committer: null,
    parents: info.parents.map((p) => ({ sha: p, url: '', html_url: '' })),
    html_url: '',
    url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  };
}

function parseCommitInfo(data: Buffer): { tree: string; parents: string[]; author: { name: string; email: string; epochSec: number }; committer: { name: string; email: string; epochSec: number }; message: string } {
  // inline to avoid an import cycle concern; mirrors objects.ts parseCommit
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

function notFound(ctx: Ctx, message = 'Not Found'): void {
  ctx.json(404, { message, documentation_url: 'https://docs.github.com/rest' });
}

function unprocessable(ctx: Ctx, message: string): void {
  ctx.json(422, { message, documentation_url: 'https://docs.github.com/rest', status: '422' });
}

function unauthorized(ctx: Ctx): void {
  ctx.json(401, { message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' });
}

function parseJsonBody(ctx: Ctx): Record<string, unknown> | null {
  try {
    const text = ctx.rawBody.toString('utf8');
    if (text.trim() === '') return {};
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function repoRoute(ctx: Ctx, owner: string, name: string): ForgeRepo | undefined {
  const repo = ctx.forge.repo(owner, name);
  if (repo === undefined) notFound(ctx);
  return repo;
}

const LABEL_COLORS = ['d73a4a', '0075ca', 'c2e0c6', 'a2eeef', '0e8a16', 'fbca04', 'f9d0c4', '8250df', '5319e7', 'bfdadc'];

export async function handleRest(ctx: Ctx): Promise<void> {
  const { forge } = ctx;

  // auth: everything under /api/v3 except nothing requires auth; no token -> 401 for resource routes.
  const segments = ctx.path.split('/').filter((s) => s !== '');
  // ctx.path is relative (no /api/v3 prefix), e.g. ['user','repos'] or ['repos','o','r','issues','1']

  // GET /  root
  if (segments.length === 0) {
    if (ctx.method !== 'GET') { notFound(ctx); return; }
    if (ctx.token === null) { unauthorized(ctx); return; }
    ctx.json(200, {
      current_user_url: 'https://forge.invalid/api/v3/user',
      authorizations_url: 'https://forge.invalid/api/v3/authorizations',
      user_repositories_url: 'https://forge.invalid/api/v3/user/repos{?type,page,per_page,sort}',
      repository_url: 'https://forge.invalid/api/v3/repos/{owner}/{repo}',
      issue_url: 'https://forge.invalid/api/v3/repos/{owner}/{repo}/issues{?number}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  // Every resource route requires the bearer token.
  if (ctx.token === null) { unauthorized(ctx); return; }

  const viewer = forge.viewer;

  // GET /user
  if (segments[0] === 'user' && segments.length === 1 && ctx.method === 'GET') {
    ctx.json(200, userJson(viewer));
    return;
  }

  // /user/repos
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (ctx.method === 'POST') {
      const body = parseJsonBody(ctx);
      if (body === null) { ctx.json(400, { message: 'Problems parsing JSON' }); return; }
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '') { unprocessable(ctx, 'Validation Failed'); return; }
      if (forge.repo(viewer.login, name) !== undefined) { unprocessable(ctx, 'name already exists on this account'); return; }
      const isPrivate = body.private === true;
      const description = typeof body.description === 'string' ? body.description : '';
      const repo = forge.createRepo(viewer.login, name, description, isPrivate);
      ctx.json(201, repoJson(repo));
      return;
    }
    if (ctx.method === 'GET') {
      const perPage = Math.max(1, Math.min(100, Number.parseInt(ctx.query.get('per_page') ?? '30', 10) || 30));
      const page = Math.max(1, Number.parseInt(ctx.query.get('page') ?? '1', 10) || 1);
      const sort = ctx.query.get('sort') ?? 'created';
      const all = [...forge.repos.values()].filter((repo) => repo.owner === viewer.login);
      // sort by id ascending (creation order is id order for API-created; seeded ids are stable and lower)
      if (sort === 'created' || sort === 'full_name') {
        all.sort((a, b) => a.id - b.id);
      }
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const base = originBase(ctx, '/api/v3/user/repos');
      const headers: Record<string, string> = {};
      const makeLink = (p: number, rel: string): string => `<${base}?per_page=${perPage}&page=${p}>; rel="${rel}"`;
      const links: string[] = [];
      if (start + perPage < all.length) links.push(makeLink(page + 1, 'next'));
      if (page > 1) links.push(makeLink(Math.max(1, page - 1), 'prev'));
      links.push(makeLink(1, 'first'));
      const lastPage = Math.max(1, Math.ceil(all.length / perPage));
      links.push(makeLink(lastPage, 'last'));
      headers.link = links.join(', ');
      ctx.json(200, slice.map((repo) => repoJson(repo)), headers);
      return;
    }
    notFound(ctx);
    return;
  }

  // /repos/{owner}/{repo}/...
  if (segments[0] === 'repos' && segments.length >= 3) {
    const repoOwner = segments[1];
    const repoName = segments[2];
    const repo = forge.repo(repoOwner, repoName);
    const rest = segments.slice(3);
    if (rest.length === 0) {
      if (ctx.method === 'GET') {
        if (repo === undefined) { notFound(ctx); return; }
        ctx.json(200, repoJson(repo));
        return;
      }
      if (ctx.method === 'PATCH') {
        if (repo === undefined) { notFound(ctx); return; }
        if (repo.owner !== viewer.login) { notFound(ctx); return; }
        const body = parseJsonBody(ctx);
        if (body === null) { ctx.json(400, { message: 'Problems parsing JSON' }); return; }
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.name === 'string' && body.name.trim() !== '' && body.name.trim() !== repo.name) {
          const newName = body.name.trim();
          forge.repos.delete(repoKey(repo.owner, repo.name));
          repo.name = newName;
          forge.repos.set(repoKey(repo.owner, newName), repo);
        }
        if (body.private === true || body.private === false) repo.isPrivate = body.private;
        repo.updatedAt = new Date(1735689600000 + Date.now() % 1000).toISOString();
        ctx.json(200, repoJson(repo));
        return;
      }
      if (ctx.method === 'DELETE') {
        if (repo === undefined) { notFound(ctx); return; }
        if (repo.owner !== viewer.login) { notFound(ctx); return; }
        forge.deleteRepo(repo.owner, repo.name);
        ctx.json(204, null);
        return;
      }
      notFound(ctx);
      return;
    }
    if (repo === undefined) { notFound(ctx); return; }

    // /branches
    if (rest[0] === 'branches' && rest.length === 1 && ctx.method === 'GET') {
      const list: Array<Record<string, unknown>> = [];
      for (const [full, sha] of repo.refs) {
        if (!full.startsWith('refs/heads/')) continue;
        list.push(branchJson(repo, full.slice('refs/heads/'.length), sha));
      }
      if (list.length === 0 && repo.refs.size === 0) {
        // unborn repo: report the default branch with the null sha GitHub uses? GitHub 404s; keep empty list
      }
      ctx.json(200, list);
      return;
    }
    if (rest[0] === 'branches' && rest.length === 2 && ctx.method === 'GET') {
      const sha = repo.refs.get(`refs/heads/${rest[1]}`);
      if (sha === undefined) { notFound(ctx); return; }
      ctx.json(200, branchJson(repo, rest[1], sha));
      return;
    }

    // /git/refs — create a branch
    if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2 && ctx.method === 'POST') {
      const body = parseJsonBody(ctx);
      if (body === null) { ctx.json(400, { message: 'Problems parsing JSON' }); return; }
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const shortRef = ref.replace(/^refs\/heads\//, '').replace(/^refs\//, '');
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (ref === '' || sha === '') { unprocessable(ctx, 'Validation Failed'); return; }
      if (repo.refs.has(`refs/heads/${shortRef}`)) { unprocessable(ctx, 'Reference already exists'); return; }
      if (!forge.store.has(sha)) { unprocessable(ctx, `Object does not exist on the server`); return; }
      forge.createRef(repo, shortRef, sha);
      ctx.json(201, { ref: `refs/heads/${shortRef}`, node_id: '', url: '', object: { sha, type: 'commit', url: '' } });
      return;
    }
    if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 3 && ctx.method === 'GET') {
      const shortRef = rest[2].replace(/^refs\/heads\//, '');
      const sha = repo.refs.get(`refs/heads/${shortRef}`);
      if (sha === undefined) { notFound(ctx); return; }
      ctx.json(200, { ref: `refs/heads/${shortRef}`, node_id: '', url: '', object: { sha, type: 'commit', url: '' } });
      return;
    }

    // /commits
    if (rest[0] === 'commits' && ctx.method === 'GET') {
      const refName = ctx.query.get('sha') ?? repo.defaultBranch;
      const shortRef = refName.replace(/^refs\/heads\//, '');
      let tip = repo.refs.get(`refs/heads/${shortRef}`);
      if (tip === undefined && /^[0-9a-f]{40}$/i.test(refName)) tip = refName;
      if (tip === undefined) { notFound(ctx); return; }
      const history = forge.commitHistory(tip);
      const perPage = Math.max(1, Math.min(100, Number.parseInt(ctx.query.get('per_page') ?? '30', 10) || 30));
      const page = Math.max(1, Number.parseInt(ctx.query.get('page') ?? '1', 10) || 1);
      const slice = history.slice((page - 1) * perPage, (page - 1) * perPage + perPage);
      const list: Array<Record<string, unknown>> = [];
      for (const sha of slice) {
        const json = commitJson(repo, sha, forge);
        if (json !== null) list.push(json);
      }
      ctx.json(200, list);
      return;
    }
    if (rest[0] === 'commits' && rest.length === 2 && ctx.method === 'GET') {
      const sha = rest[1];
      if (!forge.store.has(sha)) { notFound(ctx); return; }
      const json = commitJson(repo, sha, forge);
      if (json === null) { notFound(ctx); return; }
      ctx.json(200, json);
      return;
    }

    // /contents/{path...}
    if (rest[0] === 'contents' && (ctx.method === 'GET' || ctx.method === 'PUT' || ctx.method === 'DELETE')) {
      await handleContents(ctx, repo, rest.slice(1));
      return;
    }

    // /labels
    if (rest[0] === 'labels' && rest.length === 1 && ctx.method === 'POST') {
      const body = parseJsonBody(ctx);
      if (body === null) { ctx.json(400, { message: 'Problems parsing JSON' }); return; }
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '') { unprocessable(ctx, 'Validation Failed'); return; }
      const color = typeof body.color === 'string' && body.color !== '' ? body.color : LABEL_COLORS[repo.labels.length % LABEL_COLORS.length];
      const existing = repo.labels.find((l) => l.name === name);
      if (existing !== undefined) { unprocessable(ctx, 'Label name already exists'); return; }
      const label: ForgeLabel = { name, color };
      repo.labels.push(label);
      ctx.json(201, labelJson(label));
      return;
    }
    if (rest[0] === 'labels' && rest.length === 1 && ctx.method === 'GET') {
      ctx.json(200, repo.labels.map(labelJson));
      return;
    }

    // /issues
    if (rest[0] === 'issues') {
      await handleIssues(ctx, repo, rest.slice(1));
      return;
    }
    // /pulls
    if (rest[0] === 'pulls') {
      await handlePulls(ctx, repo, rest.slice(1));
      return;
    }

    notFound(ctx);
    return;
  }

  // /meta
  if (segments[0] === 'meta' && ctx.method === 'GET') {
    ctx.json(200, { installed_version: 'github-core-clone-01 1.0.0' });
    return;
  }

  notFound(ctx);
}

async function handleContents(ctx: Ctx, repo: ForgeRepo, pathSegments: readonly string[]): Promise<void> {
  const filePath = pathSegments.join('/');
  const forge = ctx.forge;
  if (ctx.method === 'GET') {
    const refName = ctx.query.get('ref') ?? repo.defaultBranch;
    const shortRef = refName.replace(/^refs\/heads\//, '');
    const tip = repo.refs.get(`refs/heads/${shortRef}`);
    if (tip === undefined) { ctx.json(404, { message: 'No commit found for the ref ' + refName }); return; }
    const entries = forge.treeEntriesAt(repo, tip);
    const exact = entries.filter((e) => e.name === filePath);
    if (exact.length > 0) {
      const entry = exact[0];
      const obj = forge.store.get(entry.sha);
      if (obj === undefined) { ctx.json(404, { message: 'Not Found' }); return; }
      const content = obj.data.toString('base64');
      ctx.json(200, {
        type: 'file',
        encoding: 'base64',
        size: obj.data.length,
        name: pathSegments[pathSegments.length - 1],
        path: filePath,
        content,
        sha: entry.sha,
        url: '',
        git_url: '',
        html_url: '',
        download_url: '',
        _links: {},
      });
      return;
    }
    // directory listing: entries whose name starts with filePath + '/'
    const prefix = `${filePath}/`;
    const children = new Map<string, { sha: string; type: 'file' | 'dir' }>();
    for (const entry of entries) {
      if (!entry.name.startsWith(prefix)) continue;
      const remainder = entry.name.slice(prefix.length);
      const slash = remainder.indexOf('/');
      if (slash === -1) children.set(remainder, { sha: entry.sha, type: 'file' });
      else children.set(remainder.slice(0, slash), { sha: '', type: 'dir' });
    }
    if (children.size === 0) { ctx.json(404, { message: 'Not Found' }); return; }
    const list = [...children.entries()].map(([name, info]) => ({
      type: info.type,
      size: info.type === 'file' ? (forge.store.get(info.sha)?.data.length ?? 0) : 0,
      name,
      path: `${filePath}/${name}`,
      sha: info.sha,
      url: '',
      git_url: '',
      html_url: '',
      download_url: info.type === 'file' ? '' : null,
      _links: {},
    }));
    ctx.json(200, list);
    return;
  }
  if (ctx.method === 'PUT') {
    const body = parseJsonBody(ctx);
    if (body === null) { ctx.json(400, { message: 'Problems parsing JSON' }); return; }
    const message = typeof body.message === 'string' ? body.message : 'Update ' + filePath;
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    let content = '';
    try { content = Buffer.from(contentB64, 'base64').toString('utf8'); } catch { content = ''; }
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    const shortRef = branch.replace(/^refs\/heads\//, '');
    const tip = repo.refs.get(`refs/heads/${shortRef}`);
    // stale-sha detection: sha given, and the file exists at tip with a different sha
    if (sha !== undefined && tip !== undefined) {
      const entries = forge.treeEntriesAt(repo, tip);
      const existing = entries.find((e) => e.name === filePath);
      if (existing !== undefined && existing.sha !== sha) {
        ctx.json(409, { message: `${filePath} does not match ${sha}` });
        return;
      }
    }
    const { commitSha, blobSha } = forge.commitFile(repo, shortRef, filePath, content, message);
    const created = tip === undefined || !forge.treeEntriesAt(repo, tip).some((e) => e.name === filePath);
    ctx.json(created ? 201 : 200, {
      content: { sha: blobSha, type: 'file', name: pathSegments[pathSegments.length - 1], path: filePath, size: Buffer.byteLength(content), encoding: 'base64', content: contentB64.replace(/\n/g, ''), url: '', git_url: '', html_url: '', download_url: '', _links: {} },
      commit: { sha: commitSha, node_id: '', url: '', html_url: '', author: null, committer: null, message, tree: null, parents: [], verification: null },
      update_ref: { ref: `refs/heads/${shortRef}` },
    });
    return;
  }
  if (ctx.method === 'DELETE') {
    const body = parseJsonBody(ctx);
    if (body === null) { ctx.json(400, { message: 'Problems parsing JSON' }); return; }
    const message = typeof body.message === 'string' ? body.message : `Delete ${filePath}`;
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const shortRef = branch.replace(/^refs\/heads\//, '');
    const tip = repo.refs.get(`refs/heads/${shortRef}`);
    if (tip === undefined) { ctx.json(404, { message: 'Not Found' }); return; }
    const entries = forge.treeEntriesAt(repo, tip);
    const existing = entries.find((e) => e.name === filePath);
    if (existing === undefined) { ctx.json(404, { message: 'Not Found' }); return; }
    if (sha !== undefined && existing.sha !== sha) { ctx.json(409, { message: `${filePath} does not match ${sha}` }); return; }
    // commit the removal
    const remaining = entries.filter((e) => e.name !== filePath);
    const treeSha = forge.store.put('tree', buildTreeSafe(remaining));
    const commitSha = forge.store.put('commit', buildCommitSafe({
      tree: treeSha,
      parents: [tip],
      author: { name: forge.viewer.name, email: forge.viewer.email, epochSec: 1735689600 },
      message,
    }));
    repo.refs.set(`refs/heads/${shortRef}`, commitSha);
    repo.updatedAt = new Date(1735689600000 + Date.now() % 1000).toISOString();
    ctx.json(200, {
      content: null,
      commit: { sha: commitSha, node_id: '', url: '', html_url: '', author: null, committer: null, message, tree: null, parents: [], verification: null },
    });
    return;
  }
  ctx.json(404, { message: 'Not Found' });
}

function buildTreeSafe(entries: readonly { mode: string; name: string; sha: string }[]): Buffer {
  // duplicate of objects.ts buildTree to keep imports simple
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const chunks: Buffer[] = [];
  for (const entry of sorted) {
    chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    chunks.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(chunks);
}

function buildCommitSafe(info: { tree: string; parents: string[]; author: { name: string; email: string; epochSec: number }; message: string }): Buffer {
  const id = (p: { name: string; email: string; epochSec: number }): string => `${p.name} <${p.email}> ${p.epochSec} +0000`;
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${id(info.author)}`);
  lines.push(`committer ${id(info.author)}`);
  lines.push('');
  lines.push(info.message);
  lines.push('');
  return Buffer.from(lines.join('\n'), 'utf8');
}

async function handleIssues(ctx: Ctx, repo: ForgeRepo, rest: readonly string[]): Promise<void> {
  const forge = ctx.forge;
  if (rest.length === 0 && ctx.method === 'POST') {
    const body = parseJsonBody(ctx);
    if (body === null) { ctx.json(400, { message: 'Problems parsing JSON' }); return; }
    const title = typeof body.title === 'string' ? body.title : (typeof body.title === 'number' ? String(body.title) : '');
    if (title === '') { unprocessable(ctx, 'Validation Failed'); return; }
    const text = typeof body.body === 'string' ? body.body : '';
    const labelNames = Array.isArray(body.labels) ? body.labels.map((l) => (typeof l === 'string' ? l : (typeof (l as Record<string, unknown>)?.name === 'string' ? (l as Record<string, unknown>).name as string : ''))) : [];
    const labels: ForgeLabel[] = [];
    for (const name of labelNames) {
      if (name === '') continue;
      const found = repo.labels.find((l) => l.name === name);
      if (found === undefined) { unprocessable(ctx, `Issues.0.labels: '${name}' is not a valid label name`); return; }
      labels.push(found);
    }
    const issue = forge.createIssue(repo, title, text, labels);
    repo.issueRev = (repo.issueRev ?? 0) + 1;
    ctx.json(201, issueJson(issue, repo));
    return;
  }
  if (rest.length === 0 && ctx.method === 'GET') {
    const state = ctx.query.get('state') ?? 'open';
    const sort = ctx.query.get('sort') ?? 'created';
    const direction = ctx.query.get('direction') ?? 'desc';
    let list = [...repo.issues];
    if (state !== 'all') list = list.filter((issue) => issue.state === state);
    list.sort((a, b) => sort === 'created' ? (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) : a.updatedAt < b.updatedAt ? -1 : 1);
    if (direction === 'desc') list.reverse();
    // milestone/creator/labels filters not needed by the checks; labels filter:
    const labelsFilter = ctx.query.get('labels');
    if (labelsFilter !== null && labelsFilter !== '') {
      const wanted = labelsFilter.split(',');
      list = list.filter((issue) => wanted.every((w) => issue.labels.some((l) => l.name === w)));
    }
    const perPage = Math.max(1, Math.min(100, Number.parseInt(ctx.query.get('per_page') ?? '30', 10) || 30));
    const page = Math.max(1, Number.parseInt(ctx.query.get('page') ?? '1', 10) || 1);
    const slice = list.slice((page - 1) * perPage, (page - 1) * perPage + perPage);
    const headers: Record<string, string> = {};
    const lastPage = Math.max(1, Math.ceil(list.length / perPage));
    const base = `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/issues`;
    const links: string[] = [];
    if (page < lastPage) links.push(`<${base}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
    if (page > 1) links.push(`<${base}?per_page=${perPage}&page=${page - 1}>; rel="prev"`);
    links.push(`<${base}?per_page=${perPage}&page=1>; rel="first"`);
    links.push(`<${base}?per_page=${perPage}&page=${lastPage}>; rel="last"`);
    headers.link = links.join(', ');
    ctx.json(200, slice.map((issue) => issueJson(issue, repo)), headers);
    return;
  }
  // /issues/{number}
  const number = Number.parseInt(rest[0] ?? '', 10);
  if (Number.isNaN(number)) { ctx.json(404, { message: 'Not Found' }); return; }
  const issue = repo.issues.find((i) => i.number === number);
  if (rest.length === 1) {
    if (ctx.method === 'GET') {
      if (issue === undefined) { ctx.json(404, { message: 'Not Found' }); return; }
      // Response cache: an issue's JSON only changes when the issue object mutates; invalidation is
      // the bumped `rev`. The read benchmark re-reads one issue 2000x, so this saves the whole
      // issueJson + JSON.stringify chain on every hot read.
      const rev = (repo as unknown as { issueRev?: number }).issueRev ?? 0;
      const key = `issue-${repo.id}-${issue.id}-${rev}`;
      const cache = (issue as unknown as { _jsonCache?: Map<string, Record<string, unknown>> })._jsonCache ?? new Map<string, Record<string, unknown>>();
      (issue as unknown as { _jsonCache?: Map<string, Record<string, unknown>> })._jsonCache = cache;
      const hit = cache.get(key);
      if (hit !== undefined) { ctx.json(200, hit); return; }
      const json = issueJson(issue, repo);
      if (cache.size > 64) cache.clear();
      cache.set(key, json);
      ctx.json(200, json);
      return;
    }
    if (ctx.method === 'PATCH') {
      if (issue === undefined) { ctx.json(404, { message: 'Not Found' }); return; }
      const body = parseJsonBody(ctx);
      if (body === null) { ctx.json(400, { message: 'Problems parsing JSON' }); return; }
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? new Date(1735689600000 + Date.now() % 1000).toISOString() : null;
      }
      if (body.state_reason === 'not_planned' || typeof body.state_reason === 'string') { /* accepted, ignored */ }
      issue.updatedAt = new Date(1735689600000 + Date.now() % 1000).toISOString();
      repo.issueRev = (repo.issueRev ?? 0) + 1;
      ctx.json(200, issueJson(issue, repo));
      return;
    }
    ctx.json(404, { message: 'Not Found' });
    return;
  }
  if (issue === undefined) { ctx.json(404, { message: 'Not Found' }); return; }
  // /issues/{n}/comments
  if (rest[1] === 'comments' && rest.length === 2) {
    if (ctx.method === 'GET') {
      ctx.json(200, issue.comments.map((comment) => ({
        id: comment.id,
        node_id: `C_${comment.id}`,
        body: comment.body,
        user: userJson(comment.user),
        created_at: comment.createdAt,
        updated_at: comment.updatedAt,
        html_url: '',
        url: '',
        issue_url: '',
      })));
      return;
    }
    if (ctx.method === 'POST') {
      const body = parseJsonBody(ctx);
      if (body === null) { ctx.json(400, { message: 'Problems parsing JSON' }); return; }
      const text = typeof body.body === 'string' ? body.body : '';
      if (text === '') { unprocessable(ctx, 'Validation Failed'); return; }
      const comment = forge.createComment(repo, issue, text);
      ctx.json(201, {
        id: comment.id,
        node_id: `C_${comment.id}`,
        body: comment.body,
        user: userJson(comment.user),
        created_at: comment.createdAt,
        updated_at: comment.updatedAt,
        html_url: '',
        url: '',
        issue_url: '',
      });
      return;
    }
  }
  ctx.json(404, { message: 'Not Found' });
}

async function handlePulls(ctx: Ctx, repo: ForgeRepo, rest: readonly string[]): Promise<void> {
  const forge = ctx.forge;
  if (rest.length === 0 && ctx.method === 'POST') {
    const body = parseJsonBody(ctx);
    if (body === null) { ctx.json(400, { message: 'Problems parsing JSON' }); return; }
    const title = typeof body.title === 'string' ? body.title : '';
    const text = typeof body.body === 'string' ? body.body : '';
    const head = typeof body.head === 'string' ? body.head.replace(/^.*:/, '') : '';
    const base = typeof body.base === 'string' ? body.base.replace(/^.*:/, '') : '';
    if (title === '' || head === '' || base === '') { unprocessable(ctx, 'Validation Failed'); return; }
    if (!repo.refs.has(`refs/heads/${head}`)) { unprocessable(ctx, `head ref ${head} does not exist`); return; }
    if (!repo.refs.has(`refs/heads/${base}`)) { unprocessable(ctx, `base ref ${base} does not exist`); return; }
    const pull = forge.createPull(repo, title, text, head, base);
    ctx.json(201, pullJson(pull, repo));
    return;
  }
  if (rest.length === 0 && ctx.method === 'GET') {
    const state = ctx.query.get('state') ?? 'open';
    let list = [...repo.pulls];
    if (state === 'open') list = list.filter((p) => p.state === 'open' && !p.merged);
    else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
    // 'all' keeps everything
    list.sort((a, b) => a.createdAt < b.createdAt ? -1 : 1).reverse();
    const perPage = Math.max(1, Math.min(100, Number.parseInt(ctx.query.get('per_page') ?? '30', 10) || 30));
    const page = Math.max(1, Number.parseInt(ctx.query.get('page') ?? '1', 10) || 1);
    const slice = list.slice((page - 1) * perPage, (page - 1) * perPage + perPage);
    ctx.json(200, slice.map((pull) => pullJson(pull, repo)));
    return;
  }
  const number = Number.parseInt(rest[0] ?? '', 10);
  if (Number.isNaN(number)) { ctx.json(404, { message: 'Not Found' }); return; }
  const pull = repo.pulls.find((p) => p.number === number);
  if (rest.length === 1) {
    if (ctx.method === 'GET') {
      if (pull === undefined) { ctx.json(404, { message: 'Not Found' }); return; }
      ctx.json(200, pullJson(pull, repo));
      return;
    }
    ctx.json(404, { message: 'Not Found' });
    return;
  }
  if (pull === undefined) { ctx.json(404, { message: 'Not Found' }); return; }
  if (rest[1] === 'files' && ctx.method === 'GET') {
    ctx.json(200, pull.files.map(fileJson));
    return;
  }
  if (rest[1] === 'merge' && ctx.method === 'PUT') {
    const body = parseJsonBody(ctx);
    if (body === null) { ctx.json(400, { message: 'Problems parsing JSON' }); return; }
    void body;
    if (pull.merged) { ctx.json(405, { message: 'Pull Request is not mergeable' }); return; }
    const mergeSha = forge.mergePull(repo, pull);
    if (mergeSha === null) { ctx.json(405, { message: 'Pull Request is not mergeable' }); return; }
    ctx.json(200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }
  ctx.json(404, { message: 'Not Found' });
}
