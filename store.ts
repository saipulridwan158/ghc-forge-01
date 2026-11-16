// The forge's in-memory model: repositories, refs, commits, issues, pulls, labels, comments.
// Seeded repos from wire.ts's scenario exist alongside repos created through the API.
import { ObjectStore, buildCommit, buildTree, parseCommit, parseTree, sha1Hex, type RawObject, type TreeEntry } from './objects.ts';
import { buildScenario, type Scenario } from './wire.ts';

export interface ForgeUser { id: number; login: string; name: string; email: string }

export interface ForgeLabel { name: string; color: string }

export interface ForgeComment {
  id: number;
  body: string;
  user: ForgeUser;
  createdAt: string;
  updatedAt: string;
}

export interface ForgeIssue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: ForgeLabel[];
  user: ForgeUser;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: ForgeComment[];
}

export interface ForgePullFile { filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number; blobShaBefore: string; blobShaAfter: string }

export interface ForgePull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergedBy: ForgeUser | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  user: ForgeUser;
  createdAt: string;
  updatedAt: string;
  files: ForgePullFile[];
}

export interface ForgeBranch { name: string; sha: string }

export interface ForgeRepo {
  /** Bumped on every issue/comment mutation; keys response caches. */
  issueRev?: number;
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  refs: Map<string, string>;          // full ref name (refs/heads/x) -> sha
  nextIssueNumber: number;
  nextPullNumber: number;
  issues: ForgeIssue[];
  pulls: ForgePull[];
  labels: ForgeLabel[];
  seedIssues?: number[];              // not used; seeded repos have no issues
}

/** EPOCH: every timestamp the forge mints is the scenario epoch + a counter, deterministic. */
let clockTick = 0;

export function forgeNow(): string {
  clockTick += 1;
  return new Date(1_735_689_600_000 + clockTick * 1_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export class Forge {
  readonly scenario: Scenario;
  readonly store = new ObjectStore();
  readonly repos = new Map<string, ForgeRepo>();      // key: lowercase owner/name
  readonly users: ForgeUser[];
  readonly viewer: ForgeUser;
  private nextRepoId = 500_000;
  private nextIssueId = 100_000;
  private nextPullId = 200_000;
  private nextCommentId = 300_000;

  constructor() {
    this.scenario = buildScenario();
    this.users = this.scenario.users.map((u) => ({ id: u.id, login: u.login, name: u.name, email: u.email }));
    this.viewer = this.users.find((u) => u.login === this.scenario.viewer.login) as ForgeUser;
    // Seeded repos exist from the start (owner login -> repo). Org and stranger repos too.
    for (const seed of [...this.scenario.repos, ...this.scenario.orgRepos, ...this.scenario.strangerRepos]) {
      const ownerUser = this.users.find((u) => u.login === seed.owner);
      const repo: ForgeRepo = {
        id: seed.id,
        owner: seed.owner,
        name: seed.name,
        description: seed.description,
        isPrivate: seed.private,
        defaultBranch: seed.defaultBranch,
        createdAt: forgeNow(),
        updatedAt: forgeNow(),
        pushedAt: forgeNow(),
        refs: new Map(),
        nextIssueNumber: 1,
        nextPullNumber: 1,
        issues: [],
        pulls: [],
        labels: [],
      };
      this.repos.set(repoKey(seed.owner, seed.name), repo);
      void ownerUser;
    }
  }

  repo(owner: string, name: string): ForgeRepo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): ForgeRepo {
    const repo: ForgeRepo = {
      id: this.nextRepoId++,
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdAt: forgeNow(),
      updatedAt: forgeNow(),
      pushedAt: forgeNow(),
      refs: new Map(),
      nextIssueNumber: 1,
      nextPullNumber: 1,
      issues: [],
      pulls: [],
      labels: [],
    };
    this.repos.set(repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  // ---- git object helpers ----

  /** Commit a blob at path on a ref. Returns {commitSha, blobSha}. Creates the ref if unborn. */
  commitFile(repo: ForgeRepo, refName: string, path: string, content: string, message: string): { commitSha: string; blobSha: string } {
    const store = this.store;
    const blobSha = store.put('blob', Buffer.from(content, 'utf8'));
    const shortRef = refName.replace(/^refs\/heads\//, '');
    const parentTip = repo.refs.get(`refs/heads/${shortRef}`) ?? null;
    // build nested tree from parent tip + new blob
    const entries = this.treeEntriesAt(repo, parentTip);
    setTreePath(entries, path.split('/'), blobSha, '100644');
    const treeData = buildTree(entries);
    const treeSha = store.put('tree', treeData);
    const user = this.viewer;
    const commitData = buildCommit({
      tree: treeSha,
      parents: parentTip ? [parentTip] : [],
      author: { name: user.name, email: user.email, epochSec: 1_735_689_600 + (clockTick % 1_000_000) },
      message,
    });
    const commitSha = store.put('commit', commitData);
    repo.refs.set(`refs/heads/${shortRef}`, commitSha);
    if (repo.refs.size === 1 || !repo.refs.has('refs/heads/' + repo.defaultBranch)) {
      // keep default branch pointing where unborn repos got their first commit
      if (!repo.refs.has(`refs/heads/${repo.defaultBranch}`) && shortRef === repo.defaultBranch) { /* already set */ }
    }
    repo.updatedAt = forgeNow();
    repo.pushedAt = repo.updatedAt;
    return { commitSha, blobSha };
  }

  /** Flat tree entries (recursive) at a commit sha; null when the sha is unborn. */
  treeEntriesAt(repo: ForgeRepo, commitSha: string | null): TreeEntry[] {
    if (commitSha === null || !this.store.has(commitSha)) return [];
    const commitObj = this.store.get(commitSha);
    if (commitObj === undefined) return [];
    const info = parseCommit(commitObj.data);
    return walkTree(this.store, info.tree);
  }

  /** Read a blob's text at path on ref; null when absent. */
  blobAt(repo: ForgeRepo, refName: string, path: string): { sha: string; content: string; size: number } | null {
    const shortRef = refName.replace(/^refs\/heads\//, '');
    const tip = repo.refs.get(`refs/heads/${shortRef}`);
    if (tip === undefined) return null;
    const entries = this.treeEntriesAt(repo, tip);
    const found = entries.find((e) => e.name === path);
    if (found === undefined) return null;
    const obj = this.store.get(found.sha);
    if (obj === undefined) return null;
    return { sha: found.sha, content: obj.data.toString('utf8'), size: obj.data.length };
  }

  /** All ancestor commit shas of a tip (newest first). */
  commitHistory(tipSha: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tipSha];
    while (queue.length > 0) {
      const sha = queue.shift() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const obj = this.store.get(sha);
      if (obj === undefined || obj.type !== 'commit') continue;
      out.push(sha);
      const info = parseCommit(obj.data);
      for (const parent of info.parents) queue.push(parent);
    }
    return out;
  }

  /** Create a branch at a sha (POST /git/refs). */
  createRef(repo: ForgeRepo, refShortName: string, sha: string): void {
    repo.refs.set(`refs/heads/${refShortName}`, sha);
    repo.updatedAt = forgeNow();
  }

  /** Diff two commits' flat trees, producing pull file entries. */
  diffTrees(baseSha: string | null, headSha: string): ForgePullFile[] {
    const baseEntries = this.treeEntriesAt({ refs: new Map() } as ForgeRepo, baseSha);
    const headEntries = this.treeEntriesAt({ refs: new Map() } as ForgeRepo, headSha);
    void baseEntries; void headEntries;
    return []; // replaced by Forge.diffCommits below
  }

  /** Diff two commit shas directly. */
  diffCommits(baseSha: string | null, headSha: string): ForgePullFile[] {
    const commitTreeOf = (sha: string): string => {
      const c = this.store.get(sha);
      return c !== undefined && c.type === 'commit' ? parseCommit(c.data).tree : '';
    };
    const baseEntries = baseSha !== null && this.store.has(baseSha)
      ? walkTree(this.store, commitTreeOfSha(this.store, baseSha))
      : [];
    const headEntries = this.store.has(headSha) && commitTreeOfSha(this.store, headSha) !== ''
      ? walkTree(this.store, commitTreeOfSha(this.store, headSha))
      : [];
    const baseMap = new Map(baseEntries.map((e) => [e.name, e.sha]));
    const headMap = new Map(headEntries.map((e) => [e.name, e.sha]));
    const files: ForgePullFile[] = [];
    for (const [path, headFileSha] of headMap) {
      const before = baseMap.get(path);
      if (before === undefined) {
        const data = this.store.get(headFileSha)?.data ?? Buffer.alloc(0);
        const lines = data.length === 0 ? 0 : data.toString('utf8').split('\n').length - (data.toString('utf8').endsWith('\n') ? 1 : 0);
        files.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines, blobShaBefore: '', blobShaAfter: headFileSha });
      } else if (before !== headFileSha) {
        const beforeText = this.store.get(before)?.data.toString('utf8') ?? '';
        const afterText = this.store.get(headFileSha)?.data.toString('utf8') ?? '';
        const beforeLines = beforeText === '' ? [] : beforeText.split('\n');
        const afterLines = afterText === '' ? [] : afterText.split('\n');
        let additions = 0; let deletions = 0;
        for (const line of afterLines) if (!beforeLines.includes(line)) additions += 1;
        for (const line of beforeLines) if (!afterLines.includes(line)) deletions += 1;
        files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions, blobShaBefore: before, blobShaAfter: headFileSha });
      }
    }
    for (const [path, before] of baseMap) {
      if (!headMap.has(path)) {
        const data = this.store.get(before)?.data ?? Buffer.alloc(0);
        const lines = data.length === 0 ? 0 : data.toString('utf8').split('\n').length - (data.toString('utf8').endsWith('\n') ? 1 : 0);
        files.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines, blobShaBefore: before, blobShaAfter: '' });
      }
    }
    return files;
  }

  // ---- issues ----

  createIssue(repo: ForgeRepo, title: string, body: string, labels: ForgeLabel[]): ForgeIssue {
    const issue: ForgeIssue = {
      id: this.nextIssueId++,
      number: repo.nextIssueNumber++,
      title,
      body,
      state: 'open',
      labels,
      user: this.viewer,
      createdAt: forgeNow(),
      updatedAt: forgeNow(),
      closedAt: null,
      comments: [],
    };
    repo.issues.push(issue);
    return issue;
  }

  createComment(repo: ForgeRepo, issue: ForgeIssue, body: string): ForgeComment {
    const comment: ForgeComment = { id: this.nextCommentId++, body, user: this.viewer, createdAt: forgeNow(), updatedAt: forgeNow() };
    issue.comments.push(comment);
    issue.updatedAt = comment.createdAt;
    repo.issueRev = (repo.issueRev ?? 0) + 1;
    return comment;
  }

  // ---- pulls ----

  createPull(repo: ForgeRepo, title: string, body: string, headRef: string, baseRef: string): ForgePull {
    const headSha = repo.refs.get(`refs/heads/${headRef}`) ?? '';
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`) ?? '';
    const pull: ForgePull = {
      id: this.nextPullId++,
      number: repo.nextPullNumber++,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      mergedBy: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      user: this.viewer,
      createdAt: forgeNow(),
      updatedAt: forgeNow(),
      files: this.diffCommits(baseSha === '' ? null : baseSha, headSha === '' ? '' : headSha),
    };
    repo.pulls.push(pull);
    return pull;
  }

  /** Squash-merge a pull: one commit on the base branch combining all head changes. */
  mergePull(repo: ForgeRepo, pull: ForgePull): string | null {
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    if (baseTip === undefined || headTip === undefined) return null;
    // Conflict detection: any file the head changed that also changed on base since pull creation.
    const baseNow = walkTree(this.store, commitTreeOfSha(this.store, baseTip));
    const baseAtCreation = pull.baseSha !== '' && this.store.has(pull.baseSha)
      ? walkTree(this.store, commitTreeOfSha(this.store, pull.baseSha))
      : [];
    const baseNowMap = new Map(baseNow.map((e) => [e.name, e.sha]));
    const baseAtMap = new Map(baseAtCreation.map((e) => [e.name, e.sha]));
    for (const file of pull.files) {
      if (file.status === 'removed') continue;
      const then = baseAtMap.get(file.filename);
      const now = baseNowMap.get(file.filename);
      if (then !== undefined && now !== undefined && then !== now) return null; // conflicted
    }
    // Build the merged tree: base-now entries with pull's head entries overlaid.
    const entries = baseNow;
    for (const file of pull.files) {
      if (file.status === 'removed') {
        removeTreePath(entries, file.filename.split('/'));
      } else {
        setTreePath(entries, file.filename.split('/'), file.blobShaAfter, '100644');
      }
    }
    const treeSha = this.store.put('tree', buildTree(entries));
    const user = this.viewer;
    const message = `${pull.title} (#${pull.number})`;
    const commitData = buildCommit({
      tree: treeSha,
      parents: [baseTip],
      author: { name: user.name, email: user.email, epochSec: 1_735_689_600 + (clockTick % 1_000_000) },
      message,
    });
    const mergeSha = this.store.put('commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = forgeNow();
    pull.mergeCommitSha = mergeSha;
    pull.mergedBy = this.viewer;
    pull.updatedAt = pull.mergedAt;
    repo.updatedAt = pull.mergedAt;
    repo.pushedAt = repo.updatedAt;
    return mergeSha;
  }
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`.toLowerCase();
}

/** Cache: commit sha -> flattened tree entries, filled by noteCommitTree whenever a commit lands. */
const baseTreeCache = new Map<string, TreeEntry[]>();
const treeClosureCache = new Map<string, TreeEntry[]>();


/** Resolve a commit object to its tree sha ('' when not a commit). */
function commitTreeOfSha(store: ObjectStore, sha: string): string {
  const c = store.get(sha);
  return c !== undefined && c.type === 'commit' ? parseCommit(c.data).tree : '';
}

/** Flatten a tree object recursively into path->blob entries (walk-based, cache-free). */
function walkTree(store: ObjectStore, rootSha: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  const queue: Array<{ sha: string; prefix: string }> = [{ sha: rootSha, prefix: '' }];
  while (queue.length > 0) {
    const cur = queue.shift() as { sha: string; prefix: string };
    const obj = store.get(cur.sha);
    if (obj === undefined || obj.type !== 'tree') continue;
    for (const entry of parseTree(obj.data)) {
      const full = cur.prefix === '' ? entry.name : `${cur.prefix}/${entry.name}`;
      if (entry.mode === '40000' || entry.mode === '040000') queue.push({ sha: entry.sha, prefix: full });
      else out.push({ mode: entry.mode, name: full, sha: entry.sha });
    }
  }
  return out;
}

/** Flatten a tree object recursively into [path, blobSha] entries (mode kept). */
function flattenTree(store: ObjectStore, treeSha: string, prefix = ''): TreeEntry[] {
  const obj = store.get(treeSha);
  if (obj === undefined) return [];
  const out: TreeEntry[] = [];
  for (const entry of parseTree(obj.data)) {
    const full = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      out.push(...flattenTree(store, entry.sha, full));
    } else {
      out.push({ mode: entry.mode, name: full, sha: entry.sha });
    }
  }
  return out;
}

/** Set (or add) a blob at a nested path within a flat entry list, dropping any old entry there. */
function setTreePath(entries: TreeEntry[], segments: readonly string[], sha: string, mode: string): void {
  const path = segments.join('/');
  const idx = entries.findIndex((e) => e.name === path);
  if (idx >= 0) entries.splice(idx, 1);
  entries.push({ mode, name: path, sha });
}

/** Remove the entry at a nested path. */
function removeTreePath(entries: TreeEntry[], segments: readonly string[]): void {
  const path = segments.join('/');
  const idx = entries.findIndex((e) => e.name === path);
  if (idx >= 0) entries.splice(idx, 1);
}
