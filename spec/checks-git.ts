/**
 * The git conformance checks: the manifest's `git` group, 30 `CheckSpec`s.
 *
 * Every check drives the ENTRY's smart-HTTP surface through `git-client.ts` — there is no git binary
 * in the trial pod — and judges it by bytes and hashes alone: an object is correct when its SHA-1
 * recomputes to its id and its content equals the bytes that were pushed. Nothing here turns a
 * duration into a pass bit; a failing check's detail is what the entry answered, never a time.
 *
 * Data: every path, blob content, commit message and author comes from `context.scenario`
 * (`wire.ts` buildScenario()), so live, replay and the entrant's local practice run see byte-identical
 * repositories. Object ids are therefore reproducible across runs, and the `detail` lines a check
 * reports are identical for identical entry behaviour. A check that throws is a failure carrying the
 * message, never a crash: the `fn` wrapper below catches and returns `fail(...)`.
 *
 * Repositories are created through the entry's REST surface (`POST /api/v3/user/repos`), the one
 * creation path the rules state; a smart-HTTP push cannot invent a repository. Each check creates its
 * own deterministically named repo under the scenario viewer's login, so checks are independent and
 * can run in any order, one at a time.
 *
 * Integration: the env's runner collects `GIT_CHECKS` together with the other groups' lists and hands
 * them to `validateCheckSpecs` (manifest.ts). The runner owns timeouts, the deadline and the tracing;
 * this module only registers the specs.
 */

import {
  DEFAULT_GIT_TIMEOUT_MS,
  PKT_LINE_MAX,
  GitClient,
  GitHttpError,
  GitProtocolError,
  ZERO_OID,
  buildCommit,
  buildTag,
  buildTree,
  collectReachable,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  verifyPackChecksum,
} from './git-client.ts';
import type {
  FetchResult,
  GitObject,
  GitObjectType,
  GitPacket,
  PushCommand,
  PushResult,
  TreeEntry,
} from './git-client.ts';
import { checkId, fail, pass } from './manifest.ts';
import type { CheckContext, CheckResult, CheckSpec } from './manifest.ts';
import type { Scenario } from './wire.ts';

// ---------------------------------------------------------------------------------------------
// the group
// ---------------------------------------------------------------------------------------------

/** The `git` group's declared size in the manifest (CHECK_COUNTS.git). */
export const GIT_GROUP_SIZE = 30;

/** Longest detail a check reports; keeps the SDK table and logs bounded. */
const MAX_DETAIL = 600;

const specs: CheckSpec[] = [];

function detail(ok: boolean, text: string): CheckResult {
  const bounded = text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
  return ok ? pass(bounded) : fail(bounded);
}

function describeError(err: unknown): string {
  if (err instanceof GitProtocolError) return `${err.message} [${err.code}]`;
  if (err instanceof GitHttpError) return `${err.message} [HTTP ${err.status}]`;
  if (err instanceof Error) return `threw ${err.name}: ${err.message}`;
  return `threw ${String(err)}`;
}

/**
 * Register one check. The wrapper is the error boundary: a throw becomes `fail` with the message, so
 * no check can crash the suite even if the runner does not wrap `fn` itself.
 */
function define(
  slug: string,
  title: string,
  timeoutMs: number,
  body: (context: CheckContext) => Promise<CheckResult>,
): void {
  specs.push({
    id: checkId('git', slug),
    group: 'git',
    title,
    timeoutMs,
    fn: async (context: CheckContext): Promise<CheckResult> => {
      try {
        return await body(context);
      } catch (err) {
        return fail(describeError(err));
      }
    },
  });
}

// ---------------------------------------------------------------------------------------------
// scenario-derived data
// ---------------------------------------------------------------------------------------------

interface LocalFile {
  readonly path: string;
  readonly data: Buffer;
}

/** One of the scenario's blobs as a file; `revision` gives a distinct version sharing most bytes. */
function scenarioFile(scenario: Scenario, index: number, revision = 0): LocalFile {
  const blob = scenario.blobs[index % scenario.blobs.length];
  const body = revision === 0 ? blob.content : `${blob.content}\n# revision ${revision}\n`;
  return { path: blob.path, data: Buffer.from(body, 'utf8') };
}

/** A deterministic file of about `size` bytes built from a scenario blob (packs and deltas need bulk). */
function scenarioSizedFile(scenario: Scenario, index: number, revision: number, size: number): LocalFile {
  const blob = scenario.blobs[index % scenario.blobs.length];
  const unit = `${blob.content}\n`;
  const parts: string[] = [];
  let length = 0;
  while (length < size) {
    parts.push(unit);
    length += Buffer.byteLength(unit);
  }
  const body = Buffer.from(parts.join(''), 'utf8').subarray(0, size);
  return {
    path: blob.path,
    data: Buffer.concat([body, Buffer.from(`\n# revision ${revision}\n`, 'utf8')]),
  };
}

/** `count` distinct scenario-derived paths, for the 100-file push. */
function scenarioManyFiles(scenario: Scenario, count: number, revision: number): LocalFile[] {
  const files: LocalFile[] = [];
  for (let index = 0; index < count; index += 1) {
    const basePath = scenario.filePaths[index % scenario.filePaths.length];
    const round = Math.floor(index / scenario.filePaths.length);
    const path = round === 0 ? basePath : basePath.replace(/(\.[^./]+)?$/, `.${round}$1`);
    const blob = scenario.blobs[index % scenario.blobs.length];
    files.push({ path, data: Buffer.from(`${blob.content}\nfile ${index} revision ${revision}\n`, 'utf8') });
  }
  return files;
}

/** A commit's message, timestamp and identity, all from the scenario. */
function scenarioCommitMeta(scenario: Scenario, index: number, revision = 0) {
  const template = scenario.commits[index % scenario.commits.length];
  return {
    message: revision === 0 ? template.message : `${template.message}\n\nrevision ${revision}`,
    timestamp: template.epochSec + revision,
    author: `${scenario.viewer.name} <${scenario.viewer.email}>`,
  };
}

// ---------------------------------------------------------------------------------------------
// a local repository model
// ---------------------------------------------------------------------------------------------

/** Objects plus refs: enough to build what a client pushes and to compare a clone against it. */
class LocalRepo {
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  readonly lookup = (oid: string): GitObject | undefined => this.objects.get(oid);

  put(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  blob(data: Buffer | string): string {
    return this.put('blob', typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  }

  treeFromFiles(files: readonly LocalFile[]): string {
    interface Node {
      files: Map<string, Buffer>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const file of files) {
      const segments = file.path.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index];
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1], file.data);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, data] of [...node.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        entries.push({ mode: '100644', name, oid: this.blob(data) });
      }
      for (const [name, child] of [...node.dirs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        entries.push({ mode: '40000', name, oid: build(child) });
      }
      return this.put('tree', buildTree(entries));
    };
    return build(root);
  }

  commit(
    files: readonly LocalFile[],
    meta: { message: string; timestamp: number; author: string },
    parents: readonly string[] = [],
  ): string {
    const tree = this.treeFromFiles(files);
    const data = buildCommit({
      tree,
      parents,
      message: meta.message.endsWith('\n') ? meta.message : `${meta.message}\n`,
      author: meta.author,
      committer: meta.author,
      timestamp: meta.timestamp,
    });
    return this.put('commit', data);
  }

  tag(name: string, target: string, meta: { message: string; timestamp: number; author: string }): string {
    const data = buildTag({
      object: target,
      type: 'commit',
      tag: name,
      message: meta.message.endsWith('\n') ? meta.message : `${meta.message}\n`,
      tagger: meta.author,
      timestamp: meta.timestamp,
    });
    return this.put('tag', data);
  }

  reachable(tips: Iterable<string>): Set<string> {
    return collectReachable(tips, this.lookup);
  }
}

// ---------------------------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------------------------

interface Harness {
  readonly context: CheckContext;
  readonly client: GitClient;
  readonly owner: string;
  readonly repo: string;
  readonly local: LocalRepo;
}

/** A client bound to the entry, and a fresh repository created through the REST surface. */
async function harness(context: CheckContext, slug: string): Promise<Harness> {
  const client = new GitClient({
    baseUrl: context.baseUrl,
    token: context.token,
    signal: context.signal,
    timeoutMs: Math.max(1, Math.min(context.timeoutMs || DEFAULT_GIT_TIMEOUT_MS, DEFAULT_GIT_TIMEOUT_MS)),
  });
  const owner = context.scenario.viewer.login;
  const repo = `gitconf-${slug}`;
  await client.createRepo(owner, repo, { signal: context.signal });
  return { context, client, owner, repo, local: new LocalRepo() };
}

function reportFor(result: PushResult, ref: string) {
  return result.report?.refs.find((entry) => entry.ref === ref);
}

function pushFailure(result: PushResult): string {
  if (!result.report) return 'the server returned no report-status (it did not advertise report-status)';
  if (!result.report.unpackOk) return `unpack failed: ${result.report.unpackDetail}`;
  const bad = result.report.refs.filter((entry) => !entry.ok);
  if (bad.length) return bad.map((entry) => `${entry.ref}: ${entry.reason}`).join('; ');
  return `report-status: ${JSON.stringify(result.report.refs)}`;
}

/** Push commands, sending only the objects the server's advertised tips do not reach. */
async function pushRefs(
  harnessed: Harness,
  commands: readonly PushCommand[],
  options: { objects?: readonly GitObject[]; pack?: Uint8Array } = {},
): Promise<PushResult> {
  let objects = options.objects;
  if (objects === undefined && options.pack === undefined) {
    const advertisement = await harnessed.client.advertisement(harnessed.owner, harnessed.repo, 'git-receive-pack', {
      signal: harnessed.context.signal,
    });
    if (advertisement.protocol !== 0) {
      throw new GitProtocolError('receive-pack answered a non-v0 advertisement', 'push-protocol');
    }
    const onServer = new Set<string>();
    let complete = true;
    for (const ref of advertisement.refs) {
      if (!ref.oid || ref.oid === ZERO_OID) continue;
      try {
        for (const oid of collectReachable([ref.oid], harnessed.local.lookup)) onServer.add(oid);
      } catch {
        complete = false;
        break;
      }
    }
    if (!complete) onServer.clear();
    const send: GitObject[] = [];
    const newTips = commands.filter((command) => command.newOid !== ZERO_OID).map((command) => command.newOid);
    for (const oid of collectReachable(newTips, harnessed.local.lookup)) {
      if (onServer.has(oid)) continue;
      const object = harnessed.local.objects.get(oid);
      if (object) send.push(object);
    }
    objects = send;
  }
  const result = await harnessed.client.push(harnessed.owner, harnessed.repo, commands, {
    objects,
    pack: options.pack,
    signal: harnessed.context.signal,
  });
  if (result.report) {
    for (const report of result.report.refs) {
      if (!report.ok) continue;
      const command = commands.find((candidate) => candidate.ref === report.ref);
      if (!command) continue;
      if (command.newOid === ZERO_OID) harnessed.local.refs.delete(report.ref);
      else harnessed.local.refs.set(report.ref, command.newOid);
    }
  }
  return result;
}

function hashMismatches(objects: ReadonlyMap<string, GitObject>): string[] {
  const bad: string[] = [];
  for (const [oid, object] of objects) if (hashObject(object.type, object.data) !== oid) bad.push(oid);
  return bad;
}

function missingClosure(objects: ReadonlyMap<string, GitObject>, roots: readonly string[]): string[] {
  try {
    collectReachable(roots, (oid) => objects.get(oid));
    return [];
  } catch (err) {
    if (err instanceof GitProtocolError && err.code === 'missing-object') return [err.message];
    throw err;
  }
}

function compareReachable(local: LocalRepo, actual: ReadonlyMap<string, GitObject>, roots: readonly string[]) {
  const expected = [...local.reachable(roots)].sort();
  const missing: string[] = [];
  const different: string[] = [];
  for (const oid of expected) {
    const found = actual.get(oid);
    if (!found) {
      missing.push(oid);
      continue;
    }
    const original = local.objects.get(oid)!;
    if (!original.data.equals(found.data) || original.type !== found.type) different.push(oid);
  }
  return { expected: expected.length, missing, different };
}

function short(oids: readonly string[], max = 3): string {
  if (!oids.length) return '';
  const head = oids.slice(0, max).map((oid) => oid.slice(0, 8)).join(',');
  return oids.length > max ? `${head},…(${oids.length})` : head;
}

/** Create a repo with one commit on `refs/heads/main`; most checks start here. */
async function repoWithInitialCommit(
  context: CheckContext,
  slug: string,
  files?: readonly LocalFile[],
): Promise<{ harnessed: Harness; tip: string }> {
  const harnessed = await harness(context, slug);
  const meta = scenarioCommitMeta(context.scenario, 0, 0);
  const tip = harnessed.local.commit(files ?? [scenarioFile(context.scenario, 0, 0)], meta);
  const pushed = await pushRefs(harnessed, [{ oldOid: ZERO_OID, newOid: tip, ref: 'refs/heads/main' }]);
  if (reportFor(pushed, 'refs/heads/main')?.ok !== true) {
    throw new Error(`setup push to ${harnessed.repo} failed: ${pushFailure(pushed)}`);
  }
  harnessed.local.refs.set('refs/heads/main', tip);
  return { harnessed, tip };
}

// ---------------------------------------------------------------------------------------------
// the checks
// ---------------------------------------------------------------------------------------------

define('advertise-v2', 'protocol v2 capability advertisement is served and well formed', 5000, async (context) => {
  const { harnessed } = await repoWithInitialCommit(context, 'advertise-v2');
  const advertisement = await harnessed.client.advertisement(harnessed.owner, harnessed.repo, 'git-upload-pack', {
    signal: context.signal,
  });
  if (advertisement.protocol !== 2) {
    return detail(false, 'the server answered protocol v0; the rules require Git-Protocol: version=2 to be honoured');
  }
  const capabilities = [...advertisement.capabilities.keys()].sort();
  const missing = ['fetch', 'ls-refs'].filter((name) => !advertisement.capabilities.has(name));
  if (missing.length) return detail(false, `the v2 advertisement is missing ${missing.join(', ')} (saw ${capabilities.join(', ')})`);
  const format = advertisement.capabilities.get('object-format');
  if (format && format !== 'sha1') return detail(false, `object-format ${format}: the rules require sha1`);
  return detail(true, `protocol v2; capabilities: ${capabilities.join(', ')}`);
});

define('advertise-receive-pack', 'receive-pack serves a v0 ref advertisement with push capabilities', 5000, async (context) => {
  const { harnessed, tip } = await repoWithInitialCommit(context, 'advertise-receive-pack');
  const advertisement = await harnessed.client.advertisement(harnessed.owner, harnessed.repo, 'git-receive-pack', {
    signal: context.signal,
  });
  if (advertisement.protocol !== 0) return detail(false, `receive-pack answered protocol v${advertisement.protocol}; it is v0-only`);
  const main = advertisement.refs.find((ref) => ref.name === 'refs/heads/main');
  if (!main || main.oid !== tip) {
    return detail(false, `the advertisement does not list refs/heads/main at ${short([tip])} (refs: ${advertisement.refs.map((ref) => ref.name).join(', ') || 'none'})`);
  }
  const required = ['report-status', 'side-band-64k', 'delete-refs'];
  const missing = required.filter((name) => !advertisement.capabilities.has(name));
  if (missing.length) {
    return detail(false, `receive-pack is missing ${missing.join(', ')} (saw ${[...advertisement.capabilities.keys()].sort().join(', ')})`);
  }
  return detail(true, `v0 advertisement lists ${advertisement.refs.length} ref(s); capabilities: ${[...advertisement.capabilities.keys()].sort().join(', ')}`);
});

define('advertise-headers', 'info/refs answers the smart-HTTP content type and preamble', 5000, async (context) => {
  const { harnessed } = await repoWithInitialCommit(context, 'advertise-headers');
  const v0Client = new GitClient({
    baseUrl: context.baseUrl,
    token: context.token,
    signal: context.signal,
    timeoutMs: Math.min(context.timeoutMs || DEFAULT_GIT_TIMEOUT_MS, DEFAULT_GIT_TIMEOUT_MS),
    gitProtocol: 0,
  });
  const v0 = await v0Client.infoRefs(harnessed.owner, harnessed.repo, 'git-upload-pack', { signal: context.signal });
  const v2 = await harnessed.client.infoRefs(harnessed.owner, harnessed.repo, 'git-upload-pack', { signal: context.signal });
  const receive = await harnessed.client.infoRefs(harnessed.owner, harnessed.repo, 'git-receive-pack', { signal: context.signal });
  const problems: string[] = [];
  for (const [label, raw, expected] of [
    ['v0 upload-pack', v0, 'application/x-git-upload-pack-advertisement'],
    ['v2 upload-pack', v2, 'application/x-git-upload-pack-advertisement'],
    ['receive-pack', receive, 'application/x-git-receive-pack-advertisement'],
  ] as const) {
    if (raw.status !== 200) problems.push(`${label} returned HTTP ${raw.status}`);
    if (!raw.contentType || !raw.contentType.toLowerCase().includes(expected)) {
      problems.push(`${label} content-type ${JSON.stringify(raw.contentType)} is not ${expected}`);
    }
  }
  const firstLine = (raw: { packets: GitPacket[] }): string => {
    const packet = raw.packets.find((candidate) => candidate.kind === 'data');
    return packet && packet.kind === 'data' ? packet.payload.toString('utf8').replace(/\n$/, '') : '';
  };
  const v0Line = firstLine(v0);
  if (v0Line !== '# service=git-upload-pack' && v0Line !== 'version 2') problems.push(`the v0 request's body starts with ${JSON.stringify(v0Line)}, neither the service preamble nor "version 2"`);
  if (firstLine(receive) !== '# service=git-receive-pack') problems.push(`the receive-pack body starts with ${JSON.stringify(firstLine(receive))}, not the service preamble`);
  const v2Line = firstLine(v2);
  const v2IsV0 = v2Line === '# service=git-upload-pack';
  if (!v2IsV0 && v2Line !== 'version 2') problems.push(`the v2 request's body starts with ${JSON.stringify(v2Line)}, not "version 2"`);
  if (problems.length) return detail(false, problems.join('; '));
  return detail(true, `content types and smart-HTTP preambles are correct for v0, v2 and receive-pack${v2IsV0 ? ' (the server answered v0 to the v2 request; git.advertise-v2 owns that)' : ''}`);
});

define('unknown-repo-404', 'a missing repository advertises 404 and the server stays up', 5000, async (context) => {
  const { harnessed } = await repoWithInitialCommit(context, 'unknown-repo');
  const missingName = `${harnessed.repo}-missing`;
  const upload = await harnessed.client.infoRefs(harnessed.owner, missingName, 'git-upload-pack', { signal: context.signal });
  const receive = await harnessed.client.infoRefs(harnessed.owner, missingName, 'git-receive-pack', { signal: context.signal });
  if (upload.status !== 404) return detail(false, `upload-pack advertisement of a missing repo returned HTTP ${upload.status}, not 404`);
  if (receive.status !== 404) return detail(false, `receive-pack advertisement of a missing repo returned HTTP ${receive.status}, not 404`);
  const healthy = await harnessed.client.infoRefs(harnessed.owner, harnessed.repo, 'git-upload-pack', { signal: context.signal });
  if (healthy.status !== 200) return detail(false, `the server stopped serving a known repo afterwards (HTTP ${healthy.status})`);
  return detail(true, 'a missing repo answers 404 on both services; a known repo still answers 200');
});

define('ls-refs', 'v2 ls-refs reports refs, HEAD symref and peeled tags', 8000, async (context) => {
  const { harnessed, tip } = await repoWithInitialCommit(context, 'ls-refs');
  const meta = scenarioCommitMeta(context.scenario, 1, 0);
  const second = harnessed.local.commit([scenarioFile(context.scenario, 1, 1)], meta, [tip]);
  const tagMeta = scenarioCommitMeta(context.scenario, 2, 0);
  const tag = harnessed.local.tag('v1', second, tagMeta);
  const pushed = await pushRefs(harnessed, [
    { oldOid: tip, newOid: second, ref: 'refs/heads/main' },
    { oldOid: ZERO_OID, newOid: tag, ref: 'refs/tags/v1' },
  ]);
  if (reportFor(pushed, 'refs/heads/main')?.ok !== true || reportFor(pushed, 'refs/tags/v1')?.ok !== true) {
    return detail(false, `setup push failed: ${pushFailure(pushed)}`);
  }
  const listed = await harnessed.client.lsRefs(harnessed.owner, harnessed.repo, {
    signal: context.signal,
    symrefs: true,
    peel: true,
  });
  if (listed.protocol !== 2) return detail(false, `ls-refs needs protocol v2; the server answered v${listed.protocol}`);
  const main = listed.refs.find((ref) => ref.name === 'refs/heads/main');
  if (!main || main.oid !== second) return detail(false, `refs/heads/main is not ${short([second])} in ls-refs`);
  const head = listed.refs.find((ref) => ref.name === 'HEAD');
  if (!head || head.symrefTarget !== 'refs/heads/main') {
    return detail(false, `HEAD does not report symref-target refs/heads/main (saw ${JSON.stringify(head?.symrefTarget ?? null)})`);
  }
  const tagRef = listed.refs.find((ref) => ref.name === 'refs/tags/v1');
  if (!tagRef || tagRef.oid !== tag) return detail(false, 'refs/tags/v1 does not point at the tag object');
  if (tagRef.peeled !== second) return detail(false, `refs/tags/v1 peels to ${short([tagRef.peeled ?? 'none'])}, not ${short([second])}`);
  return detail(true, `ls-refs returned ${listed.refs.length} ref(s); HEAD→refs/heads/main; refs/tags/v1 peeled to its commit`);
});

define('ls-refs-prefix', 'v2 ls-refs honours ref-prefix filtering', 8000, async (context) => {
  const { harnessed, tip } = await repoWithInitialCommit(context, 'ls-refs-prefix');
  const tag = harnessed.local.tag('v1', tip, scenarioCommitMeta(context.scenario, 1, 0));
  const pushed = await pushRefs(harnessed, [{ oldOid: ZERO_OID, newOid: tag, ref: 'refs/tags/v1' }]);
  if (reportFor(pushed, 'refs/tags/v1')?.ok !== true) return detail(false, `setup tag push failed: ${pushFailure(pushed)}`);
  const heads = await harnessed.client.lsRefs(harnessed.owner, harnessed.repo, { signal: context.signal, prefixes: ['refs/heads/'] });
  if (heads.protocol !== 2) return detail(false, `ref-prefix needs protocol v2; the server answered v${heads.protocol}`);
  const tags = await harnessed.client.lsRefs(harnessed.owner, harnessed.repo, { signal: context.signal, prefixes: ['refs/tags/'] });
  const none = await harnessed.client.lsRefs(harnessed.owner, harnessed.repo, {
    signal: context.signal,
    prefixes: ['refs/does-not-exist/'],
  });
  const problems: string[] = [];
  if (heads.rawRefs.some((ref) => !ref.name.startsWith('refs/heads/'))) problems.push(`the server answered the refs/heads/ prefix with ${heads.rawRefs.map((ref) => ref.name).join(', ')}`);
  if (!heads.refs.some((ref) => ref.name === 'refs/heads/main' && ref.oid === tip)) problems.push('refs/heads/main is missing from the heads prefix');
  if (tags.rawRefs.some((ref) => !ref.name.startsWith('refs/tags/'))) problems.push(`the server answered the refs/tags/ prefix with ${tags.rawRefs.map((ref) => ref.name).join(', ')}`);
  if (!tags.refs.some((ref) => ref.name === 'refs/tags/v1' && ref.oid === tag)) problems.push('refs/tags/v1 is missing from the tags prefix');
  if (none.rawRefs.length !== 0) problems.push(`an unmatched prefix returned ${none.rawRefs.length} ref(s)`);
  if (problems.length) return detail(false, problems.join('; '));
  return detail(true, `heads=${heads.refs.length}, tags=${tags.refs.length}, unmatched=0`);
});

define('clone-empty', 'a repository with no refs clones as an empty repository', 8000, async (context) => {
  const harnessed = await harness(context, 'clone-empty');
  const advertisement = await harnessed.client.advertisement(harnessed.owner, harnessed.repo, 'git-upload-pack', {
    signal: context.signal,
  });
  const refs = advertisement.protocol === 2
    ? (await harnessed.client.lsRefs(harnessed.owner, harnessed.repo, { signal: context.signal })).refs
    : advertisement.refs;
  const realRefs = refs.filter((ref) => ref.name.startsWith('refs/'));
  if (realRefs.length) return detail(false, `a fresh repo already advertises ${realRefs.map((ref) => ref.name).join(', ')}`);
  const clone = await harnessed.client.clone(harnessed.owner, harnessed.repo, { signal: context.signal });
  if (clone.objects.size !== 0) return detail(false, `an empty clone fetched ${clone.objects.size} object(s)`);
  if (clone.pack !== null && clone.packBytes > 0) return detail(false, `an empty clone fetched a ${clone.packBytes}-byte pack`);
  const head = clone.head ?? refs.find((ref) => ref.name === 'HEAD')?.symrefTarget ?? null;
  return detail(true, `0 refs; ${head ? `unborn HEAD → ${head}` : 'no HEAD symref'}; no objects transferred`);
});

define('push-first-commit', 'a first commit pushes to an unborn branch and becomes the tip', 8000, async (context) => {
  const harnessed = await harness(context, 'push-first-commit');
  const tip = harnessed.local.commit([scenarioFile(context.scenario, 0, 0)], scenarioCommitMeta(context.scenario, 0, 0));
  const pushed = await pushRefs(harnessed, [{ oldOid: ZERO_OID, newOid: tip, ref: 'refs/heads/main' }]);
  if (pushed.report?.unpackOk !== true) return detail(false, `unpack failed: ${pushed.report?.unpackDetail ?? 'no report'}`);
  if (!reportFor(pushed, 'refs/heads/main')?.ok) return detail(false, `report-status did not accept the first push: ${pushFailure(pushed)}`);
  const after = await harnessed.client.lsRefs(harnessed.owner, harnessed.repo, { signal: context.signal });
  const main = after.refs.find((ref) => ref.name === 'refs/heads/main');
  if (!main || main.oid !== tip) return detail(false, 'refs/heads/main does not advertise the pushed commit');
  const head = after.refs.find((ref) => ref.name === 'HEAD');
  if (!head || head.symrefTarget !== 'refs/heads/main') return detail(false, 'HEAD does not resolve to refs/heads/main after the first push');
  return detail(true, `unborn branch accepted ${short([tip])}; HEAD → refs/heads/main`);
});

define('clone-object-hashes', 'a full clone verifies object-for-object', 12000, async (context) => {
  const files = [scenarioFile(context.scenario, 0, 0), scenarioFile(context.scenario, 1, 0)];
  const { harnessed, tip } = await repoWithInitialCommit(context, 'clone-object-hashes', files);
  const second = harnessed.local.commit(
    [scenarioFile(context.scenario, 0, 1), scenarioFile(context.scenario, 1, 0)],
    scenarioCommitMeta(context.scenario, 1, 1),
    [tip],
  );
  const third = harnessed.local.commit(
    [scenarioFile(context.scenario, 0, 1), scenarioFile(context.scenario, 1, 2), scenarioFile(context.scenario, 2, 0)],
    scenarioCommitMeta(context.scenario, 2, 2),
    [second],
  );
  const pushed = await pushRefs(harnessed, [{ oldOid: tip, newOid: third, ref: 'refs/heads/main' }]);
  if (reportFor(pushed, 'refs/heads/main')?.ok !== true) return detail(false, `setup push failed: ${pushFailure(pushed)}`);
  const clone = await harnessed.client.clone(harnessed.owner, harnessed.repo, { signal: context.signal });
  const bad = hashMismatches(clone.objects);
  if (bad.length) return detail(false, `${bad.length} cloned object(s) do not recompute to their id: ${short(bad)}`);
  if (!clone.objects.has(third)) return detail(false, `the clone is missing the tip ${short([third])}`);
  const missing = missingClosure(clone.objects, [third]);
  if (missing.length) return detail(false, `the clone's reachable graph is incomplete: ${missing[0]}`);
  const expected = harnessed.local.reachable([third]);
  const absent = [...expected].filter((oid) => !clone.objects.has(oid));
  if (absent.length) return detail(false, `${absent.length} reachable object(s) are missing from the clone: ${short(absent)}`);
  return detail(true, `cloned ${clone.objects.size} objects (${clone.deltaCount} deltas, ${clone.packBytes} bytes); every SHA-1 recomputed; the closure of ${short([third])} is complete`);
});

define('clone-blob-bytes', 'every cloned blob equals the pushed bytes', 12000, async (context) => {
  const { harnessed, tip } = await repoWithInitialCommit(context, 'clone-blob-bytes', [
    scenarioSizedFile(context.scenario, 0, 0, 4096),
    scenarioFile(context.scenario, 1, 0),
  ]);
  const second = harnessed.local.commit(
    [scenarioSizedFile(context.scenario, 0, 1, 4096), scenarioFile(context.scenario, 1, 0), scenarioFile(context.scenario, 2, 0)],
    scenarioCommitMeta(context.scenario, 1, 1),
    [tip],
  );
  const pushed = await pushRefs(harnessed, [{ oldOid: tip, newOid: second, ref: 'refs/heads/main' }]);
  if (reportFor(pushed, 'refs/heads/main')?.ok !== true) return detail(false, `setup push failed: ${pushFailure(pushed)}`);
  const clone = await harnessed.client.clone(harnessed.owner, harnessed.repo, { signal: context.signal });
  const comparison = compareReachable(harnessed.local, clone.objects, [second]);
  if (comparison.missing.length) return detail(false, `${comparison.missing.length} reachable object(s) missing: ${short(comparison.missing)}`);
  if (comparison.different.length) return detail(false, `${comparison.different.length} object(s) differ byte-for-byte: ${short(comparison.different)}`);
  const blobs = [...clone.objects].filter(([, object]) => object.type === 'blob');
  return detail(true, `${blobs.length} blob(s) byte-identical across ${comparison.expected} objects`);
});

define('clone-tree-entries', 'cloned trees round-trip paths, modes and nested directories', 12000, async (context) => {
  const scenario = context.scenario;
  const nested = scenario.blobs[0].path.includes('/') ? scenario.blobs[0].path : `src/${scenario.blobs[0].path}`;
  const files: LocalFile[] = [
    { path: nested, data: Buffer.from(scenario.blobs[0].content, 'utf8') },
    scenarioFile(scenario, 1, 0),
    scenarioFile(scenario, 2, 0),
    scenarioFile(scenario, 3, 0),
  ];
  const { harnessed, tip } = await repoWithInitialCommit(context, 'clone-tree-entries', files);
  const clone = await harnessed.client.clone(harnessed.owner, harnessed.repo, { signal: context.signal });
  const commit = clone.objects.get(tip);
  if (!commit) return detail(false, 'the tip commit is missing from the clone');
  const rootTree = parseCommit(commit.data).tree;
  const root = clone.objects.get(rootTree);
  if (!root) return detail(false, 'the root tree is missing from the clone');
  const entries = parseTree(root.data);
  const names = entries.map((entry) => entry.name).sort();
  const expectedNames = [...new Set(files.map((file) => file.path.split('/')[0]))].sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    return detail(false, `the root tree entries are ${JSON.stringify(names)}, expected ${JSON.stringify(expectedNames)}`);
  }
  const firstDir = expectedNames.find((name) => files.some((file) => file.path.startsWith(`${name}/`)));
  if (firstDir) {
    const dirEntry = entries.find((entry) => entry.name === firstDir)!;
    if (dirEntry.mode !== '40000') return detail(false, `${firstDir} has mode ${dirEntry.mode}, not 40000`);
    const dirTree = clone.objects.get(dirEntry.oid);
    if (!dirTree) return detail(false, `the ${firstDir} tree object is missing`);
    const dirNames = parseTree(dirTree.data).map((entry) => entry.name).sort();
    const expectedDirNames = files
      .filter((file) => file.path.startsWith(`${firstDir}/`))
      .map((file) => file.path.slice(firstDir.length + 1).split('/')[0]);
    if (JSON.stringify(dirNames) !== JSON.stringify([...new Set(expectedDirNames)].sort())) {
      return detail(false, `the ${firstDir} tree entries are ${JSON.stringify(dirNames)}`);
    }
  }
  const comparison = compareReachable(harnessed.local, clone.objects, [tip]);
  if (comparison.different.length) return detail(false, `${comparison.different.length} tree/object(s) differ byte-for-byte`);
  return detail(true, `${entries.length} root entries, nested ${firstDir ?? '(flat)'} present, every tree byte-identical`);
});

define('clone-commit-bytes', 'commit objects round-trip byte-exactly with their metadata', 12000, async (context) => {
  const { harnessed, tip } = await repoWithInitialCommit(context, 'clone-commit-bytes', [scenarioFile(context.scenario, 0, 0)]);
  const meta = scenarioCommitMeta(context.scenario, 1, 3);
  const second = harnessed.local.commit([scenarioFile(context.scenario, 0, 1)], meta, [tip]);
  const pushed = await pushRefs(harnessed, [{ oldOid: tip, newOid: second, ref: 'refs/heads/main' }]);
  if (reportFor(pushed, 'refs/heads/main')?.ok !== true) return detail(false, `setup push failed: ${pushFailure(pushed)}`);
  const clone = await harnessed.client.clone(harnessed.owner, harnessed.repo, { signal: context.signal });
  const cloned = clone.objects.get(second);
  if (!cloned) return detail(false, 'the tip commit is missing from the clone');
  if (!harnessed.local.objects.get(second)!.data.equals(cloned.data)) {
    return detail(false, 'the tip commit bytes differ from the pushed bytes');
  }
  const parsed = parseCommit(cloned.data);
  if (parsed.parents.length !== 1 || parsed.parents[0] !== tip) return detail(false, `the parent list is ${JSON.stringify(parsed.parents)}`);
  const expectedMessage = meta.message.endsWith('\n') ? meta.message : `${meta.message}\n`;
  if (parsed.message !== expectedMessage) {
    return detail(false, `the message is ${JSON.stringify(parsed.message)}`);
  }
  const stamp = `${meta.timestamp} +0000`;
  if (!parsed.author.includes(stamp) || !parsed.committer.includes(stamp)) {
    return detail(false, `the author/committer timestamps are ${JSON.stringify([parsed.author, parsed.committer])}`);
  }
  if (!parsed.author.includes(context.scenario.viewer.email)) {
    return detail(false, `the author identity is ${JSON.stringify(parsed.author)}`);
  }
  return detail(true, 'the tip commit bytes, parents, message and author/committer lines round-trip exactly');
});

define('clone-annotated-tag', 'an annotated tag object round-trips and peels to its commit', 10000, async (context) => {
  const { harnessed, tip } = await repoWithInitialCommit(context, 'clone-annotated-tag');
  const tagMeta = scenarioCommitMeta(context.scenario, 1, 0);
  const tag = harnessed.local.tag('v1', tip, tagMeta);
  const pushed = await pushRefs(harnessed, [{ oldOid: ZERO_OID, newOid: tag, ref: 'refs/tags/v1' }]);
  if (reportFor(pushed, 'refs/tags/v1')?.ok !== true) return detail(false, `tag push failed: ${pushFailure(pushed)}`);
  const clone = await harnessed.client.clone(harnessed.owner, harnessed.repo, { signal: context.signal });
  const cloned = clone.objects.get(tag);
  if (!cloned) return detail(false, 'the tag object is missing from the clone');
  if (!cloned.data.equals(harnessed.local.objects.get(tag)!.data)) return detail(false, 'the tag object bytes differ');
  const parsed = parseTag(cloned.data);
  if (parsed.object !== tip || parsed.type !== 'commit' || parsed.tag !== 'v1') {
    return detail(false, `the tag headers are ${JSON.stringify({ object: parsed.object, type: parsed.type, tag: parsed.tag })}`);
  }
  if (!parsed.tagger.includes(context.scenario.viewer.email)) return detail(false, `the tagger is ${JSON.stringify(parsed.tagger)}`);
  const listed = await harnessed.client.lsRefs(harnessed.owner, harnessed.repo, { signal: context.signal, peel: true });
  const ref = listed.refs.find((entry) => entry.name === 'refs/tags/v1');
  if (!ref || ref.oid !== tag) return detail(false, 'refs/tags/v1 does not advertise the tag object');
  if (ref.peeled !== tip) return detail(false, `refs/tags/v1 peels to ${short([ref.peeled ?? 'none'])}, not ${short([tip])}`);
  return detail(true, `tag object byte-identical; object/type/tag headers correct; peeled to ${short([tip])}`);
});

define('fetch-incremental', 'an incremental fetch sends only the new objects and advances the tip', 12000, async (context) => {
  const { harnessed, tip } = await repoWithInitialCommit(context, 'fetch-incremental', [
    scenarioFile(context.scenario, 0, 0),
    scenarioFile(context.scenario, 1, 0),
  ]);
  const firstClone = await harnessed.client.clone(harnessed.owner, harnessed.repo, { signal: context.signal });
  if (!firstClone.objects.has(tip)) return detail(false, 'the first clone is missing the tip');
  const second = harnessed.local.commit(
    [scenarioFile(context.scenario, 0, 1), scenarioFile(context.scenario, 1, 0), scenarioFile(context.scenario, 2, 0)],
    scenarioCommitMeta(context.scenario, 1, 1),
    [tip],
  );
  const pushed = await pushRefs(harnessed, [{ oldOid: tip, newOid: second, ref: 'refs/heads/main' }]);
  if (reportFor(pushed, 'refs/heads/main')?.ok !== true) return detail(false, `setup push failed: ${pushFailure(pushed)}`);
  const fetched: FetchResult = await harnessed.client.fetch(harnessed.owner, harnessed.repo, {
    wants: [second],
    haves: [tip],
    haveObjects: firstClone.objects,
    signal: context.signal,
  });
  if (!fetched.objects.has(second)) return detail(false, 'the incremental fetch did not deliver the new tip');
  if (fetched.objects.has(tip)) return detail(false, `the incremental fetch re-sent the old tip ${short([tip])}`);
  const bad = hashMismatches(fetched.objects);
  if (bad.length) return detail(false, `${bad.length} fetched object(s) do not recompute to their id`);
  const old = harnessed.local.reachable([tip]);
  const expectedNew = [...harnessed.local.reachable([second])].filter((oid) => !old.has(oid));
  const missing = expectedNew.filter((oid) => !fetched.objects.has(oid));
  if (missing.length) return detail(false, `${missing.length} new object(s) were not delivered: ${short(missing)}`);
  const extraOld = [...fetched.objects.keys()].filter((oid) => old.has(oid));
  if (extraOld.length) return detail(false, `${extraOld.length} already-held object(s) were re-sent: ${short(extraOld)}`);
  return detail(true, `${fetched.objects.size} new object(s) (${fetched.packBytes} bytes, ${fetched.deltaCount} deltas); the old tip was not re-sent`);
});

define('fetch-nothing-new', 'a fetch with the tip already held transfers no objects', 10000, async (context) => {
  const { harnessed, tip } = await repoWithInitialCommit(context, 'fetch-nothing-new');
  const clone = await harnessed.client.clone(harnessed.owner, harnessed.repo, { signal: context.signal });
  if (!clone.objects.has(tip)) return detail(false, 'the clone is missing the tip');
  const fetched = await harnessed.client.fetch(harnessed.owner, harnessed.repo, {
    wants: [tip],
    haves: [tip],
    haveObjects: clone.objects,
    signal: context.signal,
  });
  if (fetched.objects.size !== 0) return detail(false, `the fetch delivered ${fetched.objects.size} object(s) that were already held`);
  return detail(true, `no objects delivered (a ${fetched.packBytes}-byte pack with no entries)`);
});

define('fetch-shallow-depth1', 'a depth-1 shallow clone lands the tip only', 12000, async (context) => {
  const { harnessed, tip } = await repoWithInitialCommit(context, 'fetch-shallow-depth1', [scenarioFile(context.scenario, 0, 0)]);
  const second = harnessed.local.commit([scenarioFile(context.scenario, 1, 0)], scenarioCommitMeta(context.scenario, 1, 1), [tip]);
  const third = harnessed.local.commit([scenarioFile(context.scenario, 2, 0)], scenarioCommitMeta(context.scenario, 2, 2), [second]);
  const pushed = await pushRefs(harnessed, [{ oldOid: tip, newOid: third, ref: 'refs/heads/main' }]);
  if (reportFor(pushed, 'refs/heads/main')?.ok !== true) return detail(false, `setup push failed: ${pushFailure(pushed)}`);
  const shallow = await harnessed.client.clone(harnessed.owner, harnessed.repo, { depth: 1, signal: context.signal });
  if (!shallow.objects.has(third)) return detail(false, 'the shallow clone is missing the tip');
  if (shallow.objects.has(second) || shallow.objects.has(tip)) {
    return detail(false, `the shallow clone carried history beyond depth 1 (${shallow.objects.has(second) ? 'parent' : ''}${shallow.objects.has(tip) ? ' grandparent' : ''})`);
  }
  if (!shallow.objects.get(third)!.data.equals(harnessed.local.objects.get(third)!.data)) return detail(false, 'the shallow tip commit bytes differ');
  const commit = parseCommit(shallow.objects.get(third)!.data);
  const tree = shallow.objects.get(commit.tree);
  if (!tree) return detail(false, "the tip's tree is missing from the shallow clone");
  const missingBlobs = parseTree(tree.data).filter((entry) => !shallow.objects.has(entry.oid));
  if (missingBlobs.length) return detail(false, `the tip's tree names ${missingBlobs.length} missing blob(s)`);
  if (!shallow.shallow.includes(third)) return detail(false, `shallow-info did not name the tip (shallow: ${shallow.shallow.join(',') || 'none'})`);
  return detail(true, `tip ${short([third])} only; parent and grandparent absent; shallow-info names the tip; the tip's tree (${parseTree(tree.data).length} entries) and blobs are present`);
});

define('fetch-shallow-deepen', 'deepen 2 extends a shallow clone by exactly one generation', 12000, async (context) => {
  const { harnessed, tip } = await repoWithInitialCommit(context, 'fetch-shallow-deepen', [scenarioFile(context.scenario, 0, 0)]);
  const second = harnessed.local.commit([scenarioFile(context.scenario, 1, 0)], scenarioCommitMeta(context.scenario, 1, 1), [tip]);
  const third = harnessed.local.commit([scenarioFile(context.scenario, 2, 0)], scenarioCommitMeta(context.scenario, 2, 2), [second]);
  const pushed = await pushRefs(harnessed, [{ oldOid: tip, newOid: third, ref: 'refs/heads/main' }]);
  if (reportFor(pushed, 'refs/heads/main')?.ok !== true) return detail(false, `setup push failed: ${pushFailure(pushed)}`);
  const shallow = await harnessed.client.clone(harnessed.owner, harnessed.repo, { depth: 1, signal: context.signal });
  if (!shallow.objects.has(third) || shallow.objects.has(second)) return detail(false, 'the depth-1 setup clone is not at depth 1');
  const deepened = await harnessed.client.fetch(harnessed.owner, harnessed.repo, {
    wants: [third],
    haves: [third],
    shallow: shallow.shallow,
    depth: 2,
    haveObjects: shallow.objects,
    signal: context.signal,
  });
  if (!deepened.objects.has(second)) return detail(false, 'deepen 2 did not deliver the parent commit');
  if (!deepened.objects.get(second)!.data.equals(harnessed.local.objects.get(second)!.data)) {
    return detail(false, 'the deepened parent commit bytes differ');
  }
  if (deepened.objects.has(tip)) return detail(false, `deepen 2 delivered the grandparent ${short([tip])}`);
  if (!deepened.shallow.includes(second) && !deepened.unshallow.includes(third)) {
    return detail(false, `shallow-info did not move the boundary (shallow=${deepened.shallow.join(',') || 'none'} unshallow=${deepened.unshallow.join(',') || 'none'})`);
  }
  const parentTree = parseCommit(deepened.objects.get(second)!.data).tree;
  const tree = deepened.objects.get(parentTree);
  if (!tree) return detail(false, "the delivered parent's tree is missing");
  return detail(true, `parent ${short([second])} delivered with its tree (${parseTree(tree.data).length} entries); the grandparent is still absent; the boundary moved`);
});

define('fetch-shallow-new-tip', 'a shallow fetch of a new tip does not pull the old history', 12000, async (context) => {
  const { harnessed, tip } = await repoWithInitialCommit(context, 'fetch-shallow-new-tip', [scenarioFile(context.scenario, 0, 0)]);
  const second = harnessed.local.commit([scenarioFile(context.scenario, 1, 0)], scenarioCommitMeta(context.scenario, 1, 1), [tip]);
  const pushed = await pushRefs(harnessed, [{ oldOid: tip, newOid: second, ref: 'refs/heads/main' }]);
  if (reportFor(pushed, 'refs/heads/main')?.ok !== true) return detail(false, `setup push failed: ${pushFailure(pushed)}`);
  const shallow = await harnessed.client.clone(harnessed.owner, harnessed.repo, { depth: 1, signal: context.signal });
  const third = harnessed.local.commit([scenarioFile(context.scenario, 2, 0)], scenarioCommitMeta(context.scenario, 2, 2), [second]);
  const pushedTip = await pushRefs(harnessed, [{ oldOid: second, newOid: third, ref: 'refs/heads/main' }]);
  if (reportFor(pushedTip, 'refs/heads/main')?.ok !== true) return detail(false, `setup tip push failed: ${pushFailure(pushedTip)}`);
  const fetched = await harnessed.client.fetch(harnessed.owner, harnessed.repo, {
    wants: [third],
    haves: [second],
    shallow: shallow.shallow,
    depth: 1,
    haveObjects: shallow.objects,
    signal: context.signal,
  });
  if (!fetched.objects.has(third)) return detail(false, 'the new tip was not delivered');
  if (fetched.objects.has(tip)) return detail(false, `the shallow fetch pulled the old history (${short([tip])})`);
  if (fetched.objects.has(second)) return detail(false, 'the shallow fetch re-sent the already-held parent');
  return detail(true, `${fetched.objects.size} object(s) for the new tip; the old history is absent`);
});

define('push-update-ref', 'a fast-forward update moves a branch and clones see it', 10000, async (context) => {
  const { harnessed, tip } = await repoWithInitialCommit(context, 'push-update-ref');
  const second = harnessed.local.commit([scenarioFile(context.scenario, 1, 0)], scenarioCommitMeta(context.scenario, 1, 1), [tip]);
  const pushed = await pushRefs(harnessed, [{ oldOid: tip, newOid: second, ref: 'refs/heads/main' }]);
  if (pushed.report?.unpackOk !== true) return detail(false, `unpack failed: ${pushed.report?.unpackDetail ?? 'no report'}`);
  if (!reportFor(pushed, 'refs/heads/main')?.ok) return detail(false, `the fast-forward update was refused: ${pushFailure(pushed)}`);
  const listed = await harnessed.client.lsRefs(harnessed.owner, harnessed.repo, { signal: context.signal });
  if (listed.refs.find((ref) => ref.name === 'refs/heads/main')?.oid !== second) {
    return detail(false, 'refs/heads/main does not advertise the new tip');
  }
  const clone = await harnessed.client.clone(harnessed.owner, harnessed.repo, { signal: context.signal });
  if (!clone.objects.has(second)) return detail(false, 'a clone does not see the updated tip');
  return detail(true, `refs/heads/main advanced ${short([tip])} → ${short([second])}; a clone sees it`);
});

define('push-create-branch', 'creating a branch from an existing commit is reported and advertised', 10000, async (context) => {
  const { harnessed, tip } = await repoWithInitialCommit(context, 'push-create-branch');
  const pushed = await pushRefs(harnessed, [{ oldOid: ZERO_OID, newOid: tip, ref: 'refs/heads/feature' }]);
  if (pushed.report?.unpackOk !== true) return detail(false, `unpack failed: ${pushed.report?.unpackDetail ?? 'no report'}`);
  if (!reportFor(pushed, 'refs/heads/feature')?.ok) return detail(false, `the branch create was refused: ${pushFailure(pushed)}`);
  const listed = await harnessed.client.lsRefs(harnessed.owner, harnessed.repo, { signal: context.signal });
  const feature = listed.refs.find((ref) => ref.name === 'refs/heads/feature');
  if (!feature || feature.oid !== tip) return detail(false, 'refs/heads/feature is not advertised at the created commit');
  const clone = await harnessed.client.clone(harnessed.owner, harnessed.repo, { signal: context.signal });
  if (!clone.refs.some((ref) => ref.name === 'refs/heads/feature' && ref.oid === tip)) {
    return detail(false, 'a clone does not see the new branch');
  }
  return detail(true, `refs/heads/feature created at ${short([tip])}, advertised and cloned`);
});

define('push-delete-branch', 'deleting a branch is reported and removes the ref', 10000, async (context) => {
  const { harnessed, tip } = await repoWithInitialCommit(context, 'push-delete-branch');
  const created = await pushRefs(harnessed, [{ oldOid: ZERO_OID, newOid: tip, ref: 'refs/heads/feature' }]);
  if (!reportFor(created, 'refs/heads/feature')?.ok) return detail(false, `setup branch create failed: ${pushFailure(created)}`);
  const deleted = await pushRefs(harnessed, [{ oldOid: tip, newOid: ZERO_OID, ref: 'refs/heads/feature' }]);
  if (deleted.report?.unpackOk !== true) return detail(false, `unpack failed: ${deleted.report?.unpackDetail ?? 'no report'}`);
  if (!reportFor(deleted, 'refs/heads/feature')?.ok) return detail(false, `the branch delete was refused: ${pushFailure(deleted)}`);
  const listed = await harnessed.client.lsRefs(harnessed.owner, harnessed.repo, { signal: context.signal });
  if (listed.refs.some((ref) => ref.name === 'refs/heads/feature')) return detail(false, 'refs/heads/feature is still advertised after the delete');
  if (listed.refs.find((ref) => ref.name === 'refs/heads/main')?.oid !== tip) return detail(false, 'the delete damaged refs/heads/main');
  const clone = await harnessed.client.clone(harnessed.owner, harnessed.repo, { signal: context.signal });
  if (!clone.objects.has(tip)) return detail(false, 'the repository is no longer clonable after the delete');
  return detail(true, 'refs/heads/feature deleted; refs/heads/main intact; the repo is still clonable');
});

define('push-non-fast-forward', 'a non-fast-forward update is refused per-ref and changes nothing', 10000, async (context) => {
  const { harnessed, tip } = await repoWithInitialCommit(context, 'push-non-fast-forward');
  const second = harnessed.local.commit([scenarioFile(context.scenario, 1, 0)], scenarioCommitMeta(context.scenario, 1, 1), [tip]);
  const pushed = await pushRefs(harnessed, [{ oldOid: tip, newOid: second, ref: 'refs/heads/main' }]);
  if (!reportFor(pushed, 'refs/heads/main')?.ok) return detail(false, `setup push failed: ${pushFailure(pushed)}`);
  const sibling = harnessed.local.commit([scenarioFile(context.scenario, 2, 0)], scenarioCommitMeta(context.scenario, 2, 2), [tip]);
  const refused = await harnessed.client.push(
    harnessed.owner,
    harnessed.repo,
    [{ oldOid: second, newOid: sibling, ref: 'refs/heads/main' }],
    { objects: [...harnessed.local.reachable([sibling])].map((oid) => harnessed.local.objects.get(oid)!), signal: context.signal },
  );
  if (refused.report?.unpackOk !== true) return detail(false, `a refused update must still unpack: ${refused.report?.unpackDetail ?? 'no report'}`);
  const report = reportFor(refused, 'refs/heads/main');
  if (!report || report.ok) return detail(false, `the non-fast-forward update was accepted: ${JSON.stringify(refused.report?.refs)}`);
  if (report.reason !== 'non-fast-forward') return detail(false, `the refusal reason is ${JSON.stringify(report.reason)}, not non-fast-forward`);
  const listed = await harnessed.client.lsRefs(harnessed.owner, harnessed.repo, { signal: context.signal });
  if (listed.refs.find((ref) => ref.name === 'refs/heads/main')?.oid !== second) return detail(false, 'the refused push moved refs/heads/main');
  const healthy = await harnessed.client.infoRefs(harnessed.owner, harnessed.repo, 'git-upload-pack', { signal: context.signal });
  if (healthy.status !== 200) return detail(false, `the server stopped serving advertisements (HTTP ${healthy.status})`);
  const clone = await harnessed.client.clone(harnessed.owner, harnessed.repo, { signal: context.signal });
  if (!clone.objects.has(second)) return detail(false, 'a clone after the refusal does not see the unchanged tip');
  return detail(true, `refused with ng refs/heads/main non-fast-forward; main stayed ${short([second])}; the server is healthy; the clone is intact`);
});

define('push-mixed-report', 'one command list reports ok and ng per ref, and applies only the ok one', 12000, async (context) => {
  const { harnessed, tip } = await repoWithInitialCommit(context, 'push-mixed-report');
  const second = harnessed.local.commit([scenarioFile(context.scenario, 1, 0)], scenarioCommitMeta(context.scenario, 1, 1), [tip]);
  const setup = await pushRefs(harnessed, [
    { oldOid: tip, newOid: second, ref: 'refs/heads/main' },
    { oldOid: ZERO_OID, newOid: second, ref: 'refs/heads/side' },
  ]);
  if (!reportFor(setup, 'refs/heads/main')?.ok || !reportFor(setup, 'refs/heads/side')?.ok) {
    return detail(false, `setup push failed: ${pushFailure(setup)}`);
  }
  const forward = harnessed.local.commit([scenarioFile(context.scenario, 2, 0)], scenarioCommitMeta(context.scenario, 2, 2), [second]);
  const sibling = harnessed.local.commit([scenarioFile(context.scenario, 3, 0)], scenarioCommitMeta(context.scenario, 3, 3), [tip]);
  const objects = [...new Set([...harnessed.local.reachable([forward]), ...harnessed.local.reachable([sibling])])].map(
    (oid) => harnessed.local.objects.get(oid)!,
  );
  const mixed = await harnessed.client.push(
    harnessed.owner,
    harnessed.repo,
    [
      { oldOid: second, newOid: forward, ref: 'refs/heads/main' },
      { oldOid: second, newOid: sibling, ref: 'refs/heads/side' },
    ],
    { objects, signal: context.signal },
  );
  if (mixed.report?.unpackOk !== true) return detail(false, `unpack failed: ${mixed.report?.unpackDetail ?? 'no report'}`);
  const mainReport = reportFor(mixed, 'refs/heads/main');
  const sideReport = reportFor(mixed, 'refs/heads/side');
  if (!mainReport?.ok) return detail(false, `the fast-forward half was refused: ${mainReport?.reason ?? 'missing'}`);
  if (!sideReport || sideReport.ok) return detail(false, 'the non-fast-forward half was accepted');
  if (sideReport.reason !== 'non-fast-forward') return detail(false, `the refused half's reason is ${JSON.stringify(sideReport.reason)}`);
  if (mixed.report.refs.length !== 2) return detail(false, `the report has ${mixed.report.refs.length} ref line(s), expected 2`);
  const listed = await harnessed.client.lsRefs(harnessed.owner, harnessed.repo, { signal: context.signal });
  if (listed.refs.find((ref) => ref.name === 'refs/heads/main')?.oid !== forward) return detail(false, 'the accepted ref did not advance');
  if (listed.refs.find((ref) => ref.name === 'refs/heads/side')?.oid !== second) return detail(false, 'the refused ref moved');
  return detail(true, 'report-status: ok refs/heads/main, ng refs/heads/side non-fast-forward; only main advanced');
});

define('push-delete-tag', 'deleting a tag ref is reported and removes the ref', 10000, async (context) => {
  const { harnessed, tip } = await repoWithInitialCommit(context, 'push-delete-tag');
  const tag = harnessed.local.tag('v1', tip, scenarioCommitMeta(context.scenario, 1, 0));
  const created = await pushRefs(harnessed, [{ oldOid: ZERO_OID, newOid: tag, ref: 'refs/tags/v1' }]);
  if (!reportFor(created, 'refs/tags/v1')?.ok) return detail(false, `setup tag create failed: ${pushFailure(created)}`);
  const deleted = await pushRefs(harnessed, [{ oldOid: tag, newOid: ZERO_OID, ref: 'refs/tags/v1' }]);
  if (deleted.report?.unpackOk !== true) return detail(false, `unpack failed: ${deleted.report?.unpackDetail ?? 'no report'}`);
  if (!reportFor(deleted, 'refs/tags/v1')?.ok) return detail(false, `the tag delete was refused: ${pushFailure(deleted)}`);
  const listed = await harnessed.client.lsRefs(harnessed.owner, harnessed.repo, { signal: context.signal });
  if (listed.refs.some((ref) => ref.name === 'refs/tags/v1')) return detail(false, 'refs/tags/v1 is still advertised after the delete');
  return detail(true, 'refs/tags/v1 deleted; refs/heads/main untouched');
});

define('push-100-files', 'a 100-file single-commit push round-trips byte-exactly', 15000, async (context) => {
  const harnessed = await harness(context, 'push-100-files');
  const files = scenarioManyFiles(context.scenario, 100, 1);
  const tip = harnessed.local.commit(files, scenarioCommitMeta(context.scenario, 0, 1));
  const pushed = await pushRefs(harnessed, [{ oldOid: ZERO_OID, newOid: tip, ref: 'refs/heads/main' }]);
  if (pushed.report?.unpackOk !== true) return detail(false, `unpack failed: ${pushed.report?.unpackDetail ?? 'no report'}`);
  if (!reportFor(pushed, 'refs/heads/main')?.ok) return detail(false, `the 100-file push was refused: ${pushFailure(pushed)}`);
  const clone = await harnessed.client.clone(harnessed.owner, harnessed.repo, { signal: context.signal });
  const comparison = compareReachable(harnessed.local, clone.objects, [tip]);
  if (comparison.missing.length) return detail(false, `${comparison.missing.length} object(s) missing after the 100-file clone: ${short(comparison.missing)}`);
  if (comparison.different.length) return detail(false, `${comparison.different.length} object(s) differ byte-for-byte: ${short(comparison.different)}`);
  const commit = parseCommit(clone.objects.get(tip)!.data);
  let checked = 0;
  for (const file of files) {
    let oid = commit.tree;
    let found = true;
    for (const segment of file.path.split('/')) {
      const treeObject = clone.objects.get(oid);
      if (!treeObject) {
        found = false;
        break;
      }
      const entry = parseTree(treeObject.data).find((candidate) => candidate.name === segment);
      if (!entry) {
        found = false;
        break;
      }
      oid = entry.oid;
    }
    if (!found) return detail(false, `the cloned tree is missing the path ${file.path}`);
    const blob = clone.objects.get(oid);
    if (!blob || blob.type !== 'blob' || !blob.data.equals(file.data)) {
      return detail(false, `the cloned bytes for ${file.path} differ`);
    }
    checked += 1;
  }
  return detail(true, `${checked} files byte-identical; ${comparison.expected} objects; every SHA-1 recomputed`);
});

define('pack-integrity', 'a fetched pack is structurally valid and checksummed', 12000, async (context) => {
  const { harnessed, tip } = await repoWithInitialCommit(context, 'pack-integrity', [
    scenarioSizedFile(context.scenario, 0, 0, 2048),
  ]);
  const second = harnessed.local.commit([scenarioSizedFile(context.scenario, 0, 1, 2048)], scenarioCommitMeta(context.scenario, 1, 1), [tip]);
  const pushed = await pushRefs(harnessed, [{ oldOid: tip, newOid: second, ref: 'refs/heads/main' }]);
  if (reportFor(pushed, 'refs/heads/main')?.ok !== true) return detail(false, `setup push failed: ${pushFailure(pushed)}`);
  const fetched = await harnessed.client.fetch(harnessed.owner, harnessed.repo, {
    wants: [second],
    parse: false,
    signal: context.signal,
  });
  if (!fetched.pack) return detail(false, 'the fetch delivered no pack');
  const checksum = verifyPackChecksum(fetched.pack);
  if (!checksum.ok) return detail(false, `the pack trailer ${checksum.actual} does not match the bytes ${checksum.expected}`);
  const parsed = readPack(fetched.pack);
  if (parsed.declaredCount !== parsed.entries.length) return detail(false, `the header declares ${parsed.declaredCount} objects, ${parsed.entries.length} parsed`);
  if (parsed.objects.size !== parsed.declaredCount) return detail(false, `${parsed.declaredCount} entries resolved to ${parsed.objects.size} unique objects`);
  if (parsed.version !== 2 && parsed.version !== 3) return detail(false, `pack version ${parsed.version}`);
  const bad = hashMismatches(parsed.objects);
  if (bad.length) return detail(false, `${bad.length} pack object(s) do not recompute to their id`);
  return detail(true, `${fetched.packBytes} bytes, version ${parsed.version}, ${parsed.declaredCount} objects (${parsed.deltaCount} deltas), trailer ${checksum.actual.slice(0, 12)} verified`);
});

define('pack-deltas', 'delta-compressed objects resolve correctly (when the server sends them)', 15000, async (context) => {
  const { harnessed, tip } = await repoWithInitialCommit(context, 'pack-deltas', [scenarioSizedFile(context.scenario, 0, 0, 20000)]);
  let parent = tip;
  for (let revision = 1; revision <= 3; revision += 1) {
    const child = harnessed.local.commit(
      [scenarioSizedFile(context.scenario, 0, revision, 20000)],
      scenarioCommitMeta(context.scenario, revision, revision),
      [parent],
    );
    const pushed = await pushRefs(harnessed, [{ oldOid: parent, newOid: child, ref: 'refs/heads/main' }]);
    if (reportFor(pushed, 'refs/heads/main')?.ok !== true) return detail(false, `setup push ${revision} failed: ${pushFailure(pushed)}`);
    parent = child;
  }
  const clone = await harnessed.client.clone(harnessed.owner, harnessed.repo, { signal: context.signal });
  if (!clone.objects.has(parent)) return detail(false, 'the clone is missing the tip');
  const bad = hashMismatches(clone.objects);
  if (bad.length) return detail(false, `${bad.length} object(s) (including any delta-resolved ones) do not recompute to their id`);
  const comparison = compareReachable(harnessed.local, clone.objects, [parent]);
  if (comparison.different.length) return detail(false, `${comparison.different.length} delta-resolved object(s) differ byte-for-byte`);
  return detail(true, `${clone.objects.size} objects, ${clone.deltaCount} delta object(s) resolved; every object verified; ${clone.packBytes} bytes`);
});

define('sideband-framing', 'the fetch packfile section is valid sideband framing', 12000, async (context) => {
  const { harnessed, tip } = await repoWithInitialCommit(context, 'sideband-framing', [scenarioSizedFile(context.scenario, 0, 0, 4096)]);
  const second = harnessed.local.commit([scenarioSizedFile(context.scenario, 0, 1, 4096)], scenarioCommitMeta(context.scenario, 1, 1), [tip]);
  const pushed = await pushRefs(harnessed, [{ oldOid: tip, newOid: second, ref: 'refs/heads/main' }]);
  if (reportFor(pushed, 'refs/heads/main')?.ok !== true) return detail(false, `setup push failed: ${pushFailure(pushed)}`);
  const packets: GitPacket[] = [];
  await harnessed.client.fetch(harnessed.owner, harnessed.repo, {
    wants: [second],
    parse: false,
    signal: context.signal,
    observe: (packet) => packets.push(packet),
  });
  const packChunks: Buffer[] = [];
  let progressBytes = 0;
  let sidebandPackets = 0;
  let section = '';
  for (const packet of packets) {
    if (packet.kind !== 'data') {
      if (packet.kind === 'flush' || packet.kind === 'delim') section = '';
      continue;
    }
    if (packet.raw.length > PKT_LINE_MAX) return detail(false, `a pkt-line is ${packet.raw.length} bytes, over ${PKT_LINE_MAX}`);
    const text = packet.payload.toString('utf8');
    if (section === '') {
      if (text === 'packfile\n') {
        section = 'packfile';
        continue;
      }
      if (text === 'acknowledgments\n' || text === 'shallow-info\n' || text === 'wanted-refs\n') {
        section = 'control';
        continue;
      }
      // A v0 response has no section names: after NAK/ACK the sideband packets follow directly.
      const band = packet.payload[0];
      if (band !== 1 && band !== 2 && band !== 3) continue;
    } else if (section !== 'packfile') {
      continue;
    }
    sidebandPackets += 1;
    if (packet.payload.length < 1) return detail(false, 'an empty sideband packet in the packfile section');
    const band = packet.payload[0];
    if (band === 1) packChunks.push(packet.payload.subarray(1));
    else if (band === 2) progressBytes += packet.payload.length - 1;
    else if (band === 3) return detail(false, `the server sent a sideband error: ${packet.payload.subarray(1).toString('utf8').trim()}`);
    else return detail(false, `invalid sideband band ${band}`);
  }
  if (sidebandPackets === 0) return detail(false, 'the fetch response had no packfile sideband packets');
  const pack = Buffer.concat(packChunks);
  if (!pack.length) return detail(false, 'the packfile section carried no band-1 data');
  const parsed = readPack(pack);
  if (!verifyPackChecksum(pack).ok) return detail(false, 'the reassembled pack fails its trailer checksum');
  return detail(true, `${sidebandPackets} sideband packet(s); ${pack.length} band-1 bytes, ${progressBytes} progress bytes; pack ${parsed.declaredCount} objects, checksum verified`);
});

define('push-sideband-report', 'the push report arrives in valid sideband frames', 12000, async (context) => {
  const { harnessed, tip } = await repoWithInitialCommit(context, 'push-sideband-report');
  const second = harnessed.local.commit([scenarioFile(context.scenario, 1, 0)], scenarioCommitMeta(context.scenario, 1, 1), [tip]);
  const pushed = await pushRefs(harnessed, [{ oldOid: tip, newOid: second, ref: 'refs/heads/main' }]);
  if (!pushed.sideband) return detail(false, 'the server did not advertise side-band-64k for receive-pack');
  if (pushed.report?.unpackOk !== true) return detail(false, `unpack failed inside the sideband report: ${pushed.report?.unpackDetail ?? 'no report'}`);
  if (!reportFor(pushed, 'refs/heads/main')?.ok) return detail(false, `the push was refused: ${pushFailure(pushed)}`);
  return detail(true, `report-status demuxed from band 1; unpack ok; refs/heads/main ok; ${pushed.progress.length} progress byte(s)`);
});

define('repo-survives-errors', 'the server stays healthy through 404s, refusals and a malformed request', 15000, async (context) => {
  const { harnessed, tip } = await repoWithInitialCommit(context, 'repo-survives-errors', [scenarioFile(context.scenario, 0, 0)]);
  const missing = await harnessed.client.infoRefs(harnessed.owner, `${harnessed.repo}-missing`, 'git-upload-pack', {
    signal: context.signal,
  });
  if (missing.status !== 404) return detail(false, `a missing repo returned HTTP ${missing.status}`);
  const second = harnessed.local.commit([scenarioFile(context.scenario, 1, 0)], scenarioCommitMeta(context.scenario, 1, 1), [tip]);
  const setup = await pushRefs(harnessed, [{ oldOid: tip, newOid: second, ref: 'refs/heads/main' }]);
  if (reportFor(setup, 'refs/heads/main')?.ok !== true) return detail(false, `setup push failed: ${pushFailure(setup)}`);
  const sibling = harnessed.local.commit([scenarioFile(context.scenario, 2, 0)], scenarioCommitMeta(context.scenario, 2, 2), [tip]);
  const probe = await harnessed.client.push(
    harnessed.owner,
    harnessed.repo,
    [{ oldOid: second, newOid: sibling, ref: 'refs/heads/main' }],
    { objects: [...harnessed.local.reachable([sibling])].map((oid) => harnessed.local.objects.get(oid)!), signal: context.signal },
  );
  // Either verdict is survivable: the refusal itself is git.push-non-fast-forward's check.
  const probeReport = reportFor(probe, 'refs/heads/main');
  const probeNote = probeReport?.ok ? 'an accepted non-fast-forward update' : `ng ${probeReport?.reason ?? 'unreported'}`;
  let malformedNote = '';
  try {
    const malformed = await harnessed.client.postRaw(
      harnessed.owner,
      harnessed.repo,
      'git-upload-pack',
      Buffer.from('zzzznot-a-pkt-line', 'ascii'),
      { signal: context.signal },
    );
    malformedNote = `HTTP ${malformed.status}`;
  } catch (err) {
    malformedNote = describeError(err);
  }
  const healthy = await harnessed.client.infoRefs(harnessed.owner, harnessed.repo, 'git-upload-pack', { signal: context.signal });
  if (healthy.status !== 200) return detail(false, `after the errors a known repo answers HTTP ${healthy.status}`);
  const listed = await harnessed.client.lsRefs(harnessed.owner, harnessed.repo, { signal: context.signal });
  const mainTip = listed.refs.find((ref) => ref.name === 'refs/heads/main')?.oid;
  if (!mainTip) return detail(false, 'after the errors refs/heads/main no longer exists');
  const clone = await harnessed.client.clone(harnessed.owner, harnessed.repo, { signal: context.signal });
  if (!clone.objects.has(mainTip)) return detail(false, `after the errors a clone is missing the advertised tip ${short([mainTip])}`);
  const bad = hashMismatches(clone.objects);
  if (bad.length) return detail(false, `after the errors ${bad.length} cloned object(s) are corrupt`);
  const missingObjects = missingClosure(clone.objects, [mainTip]);
  if (missingObjects.length) return detail(false, `after the errors the clone's graph is incomplete: ${missingObjects[0]}`);
  return detail(true, `404, ${probeNote} and a malformed POST (${malformedNote}) were handled; the clone at ${short([mainTip])} is intact`);
});

// ---------------------------------------------------------------------------------------------
// exports
// ---------------------------------------------------------------------------------------------

/**
 * The git group's `CheckSpec`s, in run order. `validateCheckSpecs` fails the suite unless this list
 * holds exactly CHECK_COUNTS.git (30) ids, each `<group>.<slug>` under `git`.
 */
export const GIT_CHECKS: readonly CheckSpec[] = Object.freeze(specs);

/** The ids, for the SDK's table and the export. */
export const GIT_CHECK_IDS: readonly string[] = Object.freeze(specs.map((spec) => spec.id));

if (GIT_CHECKS.length !== GIT_GROUP_SIZE) {
  throw new Error(`checks-git registers ${GIT_CHECKS.length} checks; the manifest's git group is ${GIT_GROUP_SIZE}`);
}
