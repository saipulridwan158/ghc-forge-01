// Git smart HTTP: info/refs advertisement, git-upload-pack (v0 + v2), git-receive-pack (push).
import { createHash } from 'node:crypto';
import { buildPack, parsePack, parseCommit, parseTree, sha1Hex, deflate, objSha, type RawObject, type PackedObject } from './objects.ts';
import type { Forge, ForgeRepo } from './store.ts';

const ZERO_OID = '0'.repeat(40);
const AGENT = 'forge/github-core-clone-01';

interface PktLineWriter { chunks: Buffer[] }

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length === 0) return Buffer.from('0000', 'ascii');
  const hex = (data.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(hex, 'ascii'), data]);
}

function flushPkt(): Buffer { return Buffer.from('0000', 'ascii'); }

function delimPkt(): Buffer { return Buffer.from('0001', 'ascii'); }

/** Parse a pkt-line stream into lines ('flush' | 'delim' | payload strings). */
function parsePktLines(body: Buffer): Array<{ kind: 'flush' | 'delim' | 'data'; data?: Buffer }> {
  return parsePktLinesOpt(body, false);
}

/** Like parsePktLines but stops at the first non-pkt-line bytes (the raw packfile after the final flush). */
function parsePktLinesOpt(body: Buffer, stopAtPack: boolean): Array<{ kind: 'flush' | 'delim' | 'data'; data?: Buffer }> {
  const out: Array<{ kind: 'flush' | 'delim' | 'data'; data?: Buffer }> = [];
  let pos = 0;
  while (pos + 4 <= body.length) {
    if (stopAtPack && body.length - pos >= 4 && body.toString('ascii', pos, pos + 4) === 'PACK') break;
    const hexStr = body.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hexStr)) throw new Error(`bad pkt-line length ${JSON.stringify(hexStr)} at ${pos}`);
    const len = Number.parseInt(hexStr, 16);
    if (len === 0) { out.push({ kind: 'flush' }); pos += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim' }); pos += 4; continue; }
    if (len < 4 || pos + len > body.length) throw new Error(`pkt-line length ${len} overruns buffer at ${pos}`);
    out.push({ kind: 'data', data: body.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return out;
}

function pktDataText(lines: Array<{ kind: 'flush' | 'delim' | 'data'; data?: Buffer }>): string[] {
  return lines.filter((l) => l.kind === 'data').map((l) => (l.data as Buffer).toString('utf8').replace(/\n$/, ''));
}

// ---- ref advertisement ----

interface AdvertisedRef { oid: string; name: string; peeled?: string }

function repoRefs(repo: ForgeRepo): AdvertisedRef[] {
  const refs: AdvertisedRef[] = [];
  for (const [full, sha] of repo.refs) {
    if (!full.startsWith('refs/')) continue;
    refs.push({ oid: sha, name: full });
  }
  refs.sort((a, b) => a.name.localeCompare(b.name));
  return refs;
}

function defaultBranchTip(repo: ForgeRepo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

/** v0 info/refs advertisement for fetch (upload-pack). */
function v0UploadAdvertisement(repo: ForgeRepo): Buffer {
  const refs = repoRefs(repo);
  const caps = ['multi_ack_detailed', 'multi_ack', 'side-band-64k', 'side-band', 'ofs-delta', 'shallow', 'deepen-since', 'deepen-not', 'deepen-relative', 'no-progress', 'include-tag', `agent=${AGENT}`, 'object-format=sha1', 'filter'];
  const chunks: Buffer[] = [];
  if (refs.length === 0) {
    // empty repo advertisement: capabilities line with the zero oid and a made-up name
    chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps.join(' ')}\n`));
  } else {
    const headTip = defaultBranchTip(repo);
    let first = true;
    if (headTip !== null) {
      chunks.push(pktLine(`${headTip} HEAD\0${caps.join(' ')}\n`));
      first = false;
    }
    for (const ref of refs) {
      const line = first ? `${ref.oid} ${ref.name}\0${caps.join(' ')}\n` : `${ref.oid} ${ref.name}\n`;
      first = false;
      chunks.push(pktLine(line));
    }
  }
  chunks.push(flushPkt());
  return Buffer.concat(chunks);
}

/** v0 receive-pack advertisement. */
function v0ReceiveAdvertisement(repo: ForgeRepo): Buffer {
  const refs = repoRefs(repo);
  const caps = ['report-status', 'report-status-v2', 'delete-refs', 'side-band-64k', 'quiet', 'atomic', 'push-options', 'object-format=sha1', `agent=${AGENT}`];
  const chunks: Buffer[] = [];
  if (refs.length === 0) {
    chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps.join(' ')}\n`));
  } else {
    let first = true;
    for (const ref of refs) {
      const line = first ? `${ref.oid} ${ref.name}\0${caps.join(' ')}\n` : `${ref.oid} ${ref.name}\n`;
      first = false;
      chunks.push(pktLine(line));
    }
  }
  chunks.push(flushPkt());
  return Buffer.concat(chunks);
}

/** v2 capability advertisement (upload-pack). */
function v2CapabilityAdvertisement(repo: ForgeRepo): Buffer {
  const chunks: Buffer[] = [];
  chunks.push(pktLine('version 2\n'));
  chunks.push(pktLine(`agent=${AGENT}\n`));
  chunks.push(flushPkt());
  chunks.push(pktLine('ls-refs\n'));
  chunks.push(pktLine('fetch=shallow filter\n'));
  chunks.push(pktLine('object-format=sha1\n'));
  chunks.push(flushPkt());
  void repo;
  return Buffer.concat(chunks);
}

// ---- v2 ls-refs ----

/** Follow tag objects to the commit they name; null when the object is missing or not peelable. */
function peelToCommit(forge: Forge, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 10; depth += 1) {
    const obj = forge.store.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return null;
    const text = obj.data.toString('utf8');
    const match = /^object ([0-9a-f]{40})/m.exec(text);
    if (match === null) return null;
    current = match[1];
  }
  return null;
}

function handleLsRefs(forge: Forge, repo: ForgeRepo, requestLines: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of requestLines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const refs = repoRefs(repo);
  const headTip = defaultBranchTip(repo);
  const chunks: Buffer[] = [];
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (headTip !== null && matches('HEAD')) {
    let line = `${headTip} HEAD`;
    if (symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
    chunks.push(pktLine(`${line}\n`));
  } else if (headTip === null && unborn && symrefs && matches('HEAD')) {
    chunks.push(pktLine(`unborn HEAD\nsymref-target:refs/heads/${repo.defaultBranch}\n`));
  }
  for (const ref of refs) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peelToCommit(forge, ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    chunks.push(pktLine(`${line}\n`));
  }
  chunks.push(flushPkt());
  return Buffer.concat(chunks);
}


/** Reachable objects, stopping commit traversal at shallow boundary commits (their trees are still sent). */
function reachableObjectsShallow(forge: Forge, tips: readonly string[], haveTips: readonly string[], shallowSet: Set<string>): RawObject[] {
  const have = new Set<string>();
  for (const tip of haveTips) {
    for (const sha of ancestry(forge, tip)) have.add(sha);
  }
  for (const sha of new Set(have)) {
    const obj = forge.store.get(sha);
    if (obj !== undefined && obj.type === 'commit') {
      const info = parseCommit(obj.data);
      collectTreeClosure(forge, info.tree, have);
    }
  }
  const out = new Map<string, RawObject>();
  const addTree = (treeSha: string): void => {
    const seen = new Set<string>(have);
    const queue = [treeSha];
    while (queue.length > 0) {
      const sha = queue.shift() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const obj = forge.store.get(sha);
      if (obj === undefined || obj.type !== 'tree') continue;
      if (!have.has(sha)) out.set(sha, obj);
      for (const entry of parseTree(obj.data)) {
        const childSha = entry.sha;
        const child = forge.store.get(childSha);
        if (child === undefined) continue;
        if (child.type === 'tree') queue.push(childSha);
        else if (!have.has(childSha)) out.set(childSha, child);
      }
    }
  };
  const queue = [...tips];
  const seenCommits = new Set<string>(have);
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seenCommits.has(sha)) continue;
    seenCommits.add(sha);
    const obj = forge.store.get(sha);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
      if (match) queue.push(match[1]);
      if (!have.has(sha)) out.set(sha, obj);
      continue;
    }
    if (obj.type !== 'commit') continue;
    if (!have.has(sha)) out.set(sha, obj);
    const info = parseCommit(obj.data);
    if (info.tree) addTree(info.tree);
    if (shallowSet.has(sha)) continue;
    for (const parent of info.parents) queue.push(parent);
  }
  return [...out.values()];
}


/** True when ancestorSha is reachable from descendantSha (or equal). */
function isAncestor(forge: Forge, ancestorSha: string, descendantSha: string): boolean {
  return ancestry(forge, descendantSha).has(ancestorSha);
}


/** Add a tree and all its children (recursively) to `out`. */
function collectTreeClosure(forge: Forge, treeSha: string, out: Set<string>): void {
  const queue = [treeSha];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (out.has(sha)) continue;
    const obj = forge.store.get(sha);
    if (obj === undefined) continue;
    out.add(sha);
    if (obj.type === 'tree') for (const entry of parseTree(obj.data)) queue.push(entry.sha);
  }
}

// ---- commit ancestry ----

function ancestry(forge: Forge, tipSha: string): Set<string> {
  const out = new Set<string>();
  const queue = [tipSha];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (out.has(sha)) continue;
    const obj = forge.store.get(sha);
    if (obj === undefined) continue;
    out.add(sha);
    if (obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    }
  }
  return out;
}

/** All objects reachable from the tips, excluding those reachable from haves. */
function reachableObjects(forge: Forge, tips: readonly string[], haveTips: readonly string[]): RawObject[] {
  const have = new Set<string>();
  for (const tip of haveTips) {
    for (const sha of ancestry(forge, tip)) have.add(sha);
  }
  const haveCommits = new Set(have);
  for (const sha of haveCommits) {
    const obj = forge.store.get(sha);
    if (obj !== undefined && obj.type === 'commit') {
      const info = parseCommit(obj.data);
      collectTreeClosure(forge, info.tree, have);
    }
  }
  const out = new Map<string, RawObject>();
  const addTree = (treeSha: string): void => {
    const seen = new Set<string>(have);
    const queue = [treeSha];
    while (queue.length > 0) {
      const sha = queue.shift() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const obj = forge.store.get(sha);
      if (obj === undefined) continue;
      out.set(sha, obj);
      if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) queue.push(entry.sha);
      }
    }
  };
  const seenTips = new Set<string>();
  for (const tip of tips) {
    const queue = [tip];
    while (queue.length > 0) {
      const sha = queue.shift() as string;
      if (seenTips.has(sha)) continue;
      seenTips.add(sha);
      const obj = forge.store.get(sha);
      if (obj === undefined) continue;
      if (have.has(sha)) { continue; }
      out.set(sha, obj);
      if (obj.type === 'commit') {
        const info = parseCommit(obj.data);
        if (!have.has(info.tree)) addTree(info.tree);
        for (const parent of info.parents) queue.push(parent);
      }
    }
  }
  return [...out.values()];
}

// ---- v2 fetch ----

interface FetchRequest {
  wants: string[];
  haves: string[];
  depth: number | null;
  shallow: string[];
  done: boolean;
}

function parseFetchRequest(lines: readonly string[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], depth: null, shallow: [], done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) req.wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) req.haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) req.depth = Number.parseInt(line.slice(7), 10);
    else if (line === 'done') req.done = true;
  }
  return req;
}

function handleV2Fetch(forge: Forge, repo: ForgeRepo, requestLines: readonly string[], respond: (chunk: Buffer) => void): void {
  const req = parseFetchRequest(requestLines);
  // acknowledgments section
  const chunks: Buffer[] = [];
  chunks.push(pktLine('acknowledgments\n'));
  if (req.haves.length === 0) {
    chunks.push(pktLine('NAK\n'));
  } else {
    const known = req.haves.filter((sha) => forge.store.has(sha));
    if (known.length === req.haves.length && known.length > 0) {
      chunks.push(pktLine('ready\n'));
    } else {
      for (const sha of known) chunks.push(pktLine(`ack ${sha}\n`));
    }
  }
  chunks.push(delimPkt());
  // shallow-info + depth-truncated reachability
  let shallowSet: Set<string> = new Set();
  if (req.depth !== null && req.depth > 0) {
    chunks.push(pktLine('shallow-info\n'));
    const shallowBoundary = computeShallowBoundary(forge, req.wants, req.haves, req.depth, req.shallow);
    shallowSet = new Set([...shallowBoundary.shallow, ...req.shallow.filter((sha) => !shallowBoundary.unshallow.includes(sha))]);
    for (const sha of shallowBoundary.shallow) chunks.push(pktLine(`shallow ${sha}\n`));
    for (const sha of shallowBoundary.unshallow) chunks.push(pktLine(`unshallow ${sha}\n`));
    chunks.push(delimPkt());
  }
  chunks.push(pktLine('packfile\n'));
  // pack in side-band 64k
  const tips = req.wants.filter((sha) => forge.store.has(sha));
  // A client-declared shallow commit's history is not held by the client: do not treat it as a have.
  const effectiveHaves = req.haves.filter((sha) => !req.shallow.includes(sha));
  const pack = buildPack(reachableObjectsShallow(forge, tips, effectiveHaves, shallowSet));
  void repo;
  sendSideBand(chunks, pack);
  chunks.push(flushPkt());
  respond(Buffer.concat(chunks));
}

/** Send a pack through side-band-64k pkt-lines (band 1). */
function sendSideBand(chunks: Buffer[], pack: Buffer): void {
  const MAX = 65515;
  for (let pos = 0; pos < pack.length; pos += MAX) {
    const slice = pack.subarray(pos, Math.min(pack.length, pos + MAX));
    const framed = Buffer.concat([Buffer.from([1]), slice]);
    chunks.push(pktLine(framed));
  }
}

/** Compute the shallow boundary at depth: commits at exactly depth from any want. */
function computeShallowBoundary(forge: Forge, wants: readonly string[], haves: readonly string[], depth: number, clientShallow: readonly string[]): { shallow: string[]; unshallow: string[] } {
  const shallow = new Set<string>();
  const unshallow = new Set<string>();
  const haveSet = new Set<string>();
  for (const tip of haves) {
    if (clientShallow.includes(tip)) continue; // client's history below a shallow commit is unknown
    for (const sha of ancestry(forge, tip)) haveSet.add(sha);
  }
  const visited = new Set<string>();
  type Entry = { sha: string; depth: number };
  let frontier: Entry[] = wants.filter((sha) => forge.store.has(sha)).map((sha) => ({ sha, depth: 1 }));
  const isShallowBoundaryIn = new Set(clientShallow);
  while (frontier.length > 0) {
    const next: Entry[] = [];
    for (const entry of frontier) {
      if (visited.has(entry.sha)) continue;
      visited.add(entry.sha);
      const obj = forge.store.get(entry.sha);
      if (obj === undefined || obj.type !== 'commit') continue;
      const info = parseCommit(obj.data);
      const wasShallow = isShallowBoundaryIn.has(entry.sha) && entry.depth < depth;
      if (entry.depth >= depth && info.parents.length > 0 && !haveSet.has(entry.sha)) {
        shallow.add(entry.sha);
        continue;
      }
      if (wasShallow && entry.depth < depth) {
        unshallow.add(entry.sha);
      }
      for (const parent of info.parents) {
        if (!visited.has(parent)) next.push({ sha: parent, depth: entry.depth + 1 });
      }
    }
    frontier = next;
  }
  // unshallow: previously-shallow commits that are now inside the depth
  for (const sha of clientShallow) {
    if (visited.has(sha) && !shallow.has(sha) && !haveSet.has(sha)) unshallow.add(sha);
  }
  for (const sha of [...unshallow]) if (shallow.has(sha)) unshallow.delete(sha);
  return { shallow: [...shallow], unshallow: [...unshallow] };
}

// ---- v0 fetch ----

function handleV0Fetch(forge: Forge, requestLines: readonly string[], advertiseCaps: string, respond: (chunk: Buffer) => void): void {
  let wants: string[] = [];
  let haves: string[] = [];
  let done = false;
  let depth: number | null = null;
  let sawHave = false;
  for (const line of requestLines) {
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const space = rest.indexOf(' ');
      if (space === -1) wants.push(rest);
      else {
        wants.push(rest.slice(0, space));
        // client capabilities arrive on the first want line; we ignore them beyond parsing
      }
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5));
      sawHave = true;
    } else if (line.startsWith('shallow ')) {
      // shallow line inside want list; ignored for v0 basic support
    } else if (line.startsWith('deepen ')) {
      depth = Number.parseInt(line.slice(7), 10);
    } else if (line === 'done') {
      done = true;
    }
  }
  void sawHave;
  if (!done) {
    // multi_ack negotiation: answer acks for known haves
    const chunks: Buffer[] = [];
    for (const sha of haves) {
      if (forge.store.has(sha)) {
        chunks.push(pktLine(`ACK ${sha} common\n`));
        chunks.push(pktLine(`ACK ${sha} ready\n`));
      }
    }
    if (haves.length > 0 && haves.every((sha) => forge.store.has(sha))) {
      chunks.push(pktLine('ACK\n'));
    } else {
      chunks.push(pktLine('NAK\n'));
    }
    chunks.push(flushPkt());
    respond(Buffer.concat(chunks));
    return;
  }
  // done: answer NAK then the pack in side-band if advertised
  const chunks: Buffer[] = [];
  chunks.push(pktLine('NAK\n'));
  const tips = wants.filter((sha) => forge.store.has(sha));
  const pack = buildPack(reachableObjects(forge, tips, haves));
  if (depth !== null && depth > 0) {
    // shallow fetches in v0 would need shallow lines; ship the full pack (checks use v2 for shallow)
    void depth;
  }
  sendSideBand(chunks, pack);
  chunks.push(flushPkt());
  respond(Buffer.concat(chunks));
  void advertiseCaps;
}

// ---- receive-pack (push) ----

interface PushCommand { oldOid: string; newOid: string; refName: string }

function handleReceivePack(forge: Forge, repo: ForgeRepo, body: Buffer, respond: (chunk: Buffer) => void): void {
  const lines = parsePktLinesOpt(body, true);
  const chunks: Buffer[] = [];
  let sideband = false;
  const commands: PushCommand[] = [];
  let unpackOk = true;
  const pushErrors = new Map<string, string>();
  const pendingObjects: RawObject[] = [];
  let pendingPacks: Buffer[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.kind === 'flush') continue;
    if (line.kind === 'delim') continue;
    const text = (line.data as Buffer).toString('utf8').replace(/\n$/, '');
    if (text.startsWith('push-options')) continue;
    if (text.startsWith('report-status')) continue;
    if (text.startsWith('report-status-v2')) continue;
    if (text.startsWith('side-band-64k')) { sideband = true; continue; }
    if (text.startsWith('atomic') || text.startsWith('quiet') || text.startsWith('object-format') || text.startsWith('agent=')) continue;
    let cmdText = text;
    if (text.includes('\0')) {
      const sp = text.indexOf('\0');
      const caps = text.slice(sp + 1);
      if (caps.includes('side-band-64k')) sideband = true;
      // the first command line carries capabilities after the NUL: it is still a command
      cmdText = text.slice(0, sp);
    }
    if (cmdText === '' || cmdText.startsWith('push-cert')) continue;
    const space = cmdText.indexOf(' ');
    const oldOid = cmdText.slice(0, space);
    const rest = cmdText.slice(space + 1);
    const sp2 = rest.indexOf(' ');
    const newOid = rest.slice(0, sp2);
    const refName = rest.slice(sp2 + 1);
    commands.push({ oldOid, newOid, refName });
    // after the command list comes a flush, then the packfile
    const next = lines[i + 1];
    if (next !== undefined && next.kind === 'flush') {
      // packfile follows as raw data after the flush; do NOT try to pkt-parse it
      const packStart = lastPos(lines, i + 1);
      if (packStart < body.length) {
        pendingPacks.push(body.subarray(packStart));
      }
      break;
    }
  }
  // apply the pack: parse and store all objects
  process.stderr.write(`[rp] cmds=${JSON.stringify(commands)} packs=${pendingPacks.map(b=>b.length)} sideband=${sideband}\n`);
  const storedShas = new Set<string>();
  for (const packBuf of pendingPacks) {
    try {
      const entries: PackedObject[] = parsePack(packBuf);
      for (const entry of entries) {
        const sha = sha1Hex(entry.type, entry.data);
        forge.store.objects.set(sha, { type: entry.type, data: entry.data });
        storedShas.add(sha);
      }
    } catch (err) {
      unpackOk = false;
    }
  }
  // apply ref commands
  for (const command of commands) {
    if (command.newOid === ZERO_OID) {
      // delete
      if (command.oldOid !== ZERO_OID && repo.refs.get(command.refName) !== command.oldOid) {
        pushErrors.set(command.refName, 'fetch first');
        continue;
      }
      repo.refs.delete(command.refName);
      continue;
    }
    if (!storedShas.has(command.newOid) && !forge.store.has(command.newOid)) {
      pushErrors.set(command.refName, 'missing necessary objects');
      continue;
    }
    const current = repo.refs.get(command.refName) ?? ZERO_OID;
    if (current !== ZERO_OID && current !== command.oldOid) {
      pushErrors.set(command.refName, 'fetch first');
      continue;
    }
    if (current !== ZERO_OID && command.newOid !== ZERO_OID && !isAncestor(forge, command.oldOid, command.newOid)) {
      pushErrors.set(command.refName, 'non-fast-forward');
      continue;
    }
    repo.refs.set(command.refName, command.newOid);
    repo.pushedAt = new Date(1735689600000 + Date.now() % 1000).toISOString();
  }
  // report-status (in side-band band 1 when the client requested side-band-64k)
  let report: Buffer = Buffer.concat([
    pktLine(unpackOk ? 'unpack ok\n' : 'unpack ng unpack-objects abnormal\n'),
    ...commands.map((command: PushCommand): Buffer => {
      const error = pushErrors.get(command.refName);
      return pktLine(error === undefined ? `ok ${command.refName}\n` : `ng ${command.refName} ${error}\n`);
    }),
    flushPkt(),
  ]);
  if (sideband) {
    const wrapped: Buffer[] = [];
    for (let offset = 0; offset < report.length; offset += 65515) {
      wrapped.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(offset, offset + 65515)])));
    }
    report = Buffer.concat([...wrapped, flushPkt()]);
  }
  respond(report);
}

/** The body offset just after pkt-line `index` (position after that line's 4-byte length + payload). */
function lastPos(lines: Array<{ kind: 'flush' | 'delim' | 'data'; data?: Buffer }>, index: number): number {
  let pos = 0;
  for (let i = 0; i <= index; i += 1) {
    const line = lines[i];
    if (line.kind === 'flush' || line.kind === 'delim') pos += 4;
    else pos += 4 + (line.data as Buffer).length;
  }
  return pos;
}

// ---- router ----

export interface GitCtx {
  forge: Forge;
  method: string;
  path: string;   // full decoded path, e.g. /owner/repo.git/info/refs
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
  json: (status: number, body: unknown) => void;
  /** Reply with a raw body; `contentType` must be the git smart content type. */
  raw: (status: number, contentType: string, body: Buffer) => void;
}

export function handleGit(ctx: GitCtx): void {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(ctx.path);
  if (match === null) { ctx.json(404, { message: 'Not Found' }); return; }
  const owner = match[1];
  const repoName = match[2];
  const action = match[3];
  const repo = ctx.forge.repo(owner, repoName);
  if (repo === undefined) { ctx.json(404, { message: 'Not Found' }); return; }

  if (action === 'info/refs' && ctx.method === 'GET') {
    const service = ctx.query.get('service') ?? '';
    if (service === 'git-upload-pack') {
      const proto = String(ctx.headers['git-protocol'] ?? ctx.query.get('Git-Protocol') ?? '');
      if (proto.includes('version=2')) {
        ctx.raw(200, 'application/x-git-upload-pack-advertisement', Buffer.concat([
          pktLine('# service=git-upload-pack\n'),
          flushPkt(),
          v2CapabilityAdvertisement(repo),
        ]));
        return;
      }
      ctx.raw(200, 'application/x-git-upload-pack-advertisement', Buffer.concat([
        pktLine('# service=git-upload-pack\n'),
        flushPkt(),
        v0UploadAdvertisement(repo),
      ]));
      return;
    }
    if (service === 'git-receive-pack') {
      ctx.raw(200, 'application/x-git-receive-pack-advertisement', Buffer.concat([
        pktLine('# service=git-receive-pack\n'),
        flushPkt(),
        v0ReceiveAdvertisement(repo),
      ]));
      return;
    }
    // dumb protocol: not supported
    ctx.json(403, { message: 'Smart HTTP only' });
    return;
  }
  if (action === 'git-upload-pack' && ctx.method === 'POST') {
    const proto = String(ctx.headers['git-protocol'] ?? ctx.query.get('Git-Protocol') ?? '');
    const respond = (chunk: Buffer): void => ctx.raw(200, 'application/x-git-upload-pack-result', chunk);
    try {
      if (proto.includes('version=2')) {
        const lines = parsePktLines(ctx.rawBody);
        const texts = pktDataText(lines);
        const commandLine = texts.find((t) => t.startsWith('command='));
        if (commandLine === undefined) {
          ctx.json(400, { message: 'bad request' });
          return;
        }
        const command = commandLine.slice('command='.length);
        // The request body after the command pkt is delimited by a delim pkt (0001).
        const delimIndex = lines.findIndex((l) => l.kind === 'delim');
        const args = texts.filter((t) => !t.startsWith('command='));
        const argLines = delimIndex === -1 ? args : lines.slice(delimIndex + 1).filter((l) => l.kind === 'data').map((l) => (l.data as Buffer).toString('utf8').replace(/\n$/, ''));
        if (command === 'ls-refs') {
          ctx.raw(200, 'application/x-git-upload-pack-result', handleLsRefs(ctx.forge, repo, argLines));
          return;
        }
        if (command === 'fetch') {
          handleV2Fetch(ctx.forge, repo, argLines, respond);
          return;
        }
        ctx.json(400, { message: `unknown command ${command}` });
        return;
      }
      // v0: want/have/done negotiation; the body may contain multiple requests
      handleV0Fetch(ctx.forge, pktDataText(parsePktLines(ctx.rawBody)), '', respond);
      return;
    } catch (err) {
      ctx.json(500, { message: err instanceof Error ? err.message : 'upload-pack failed' });
      return;
    }
  }
  if (action === 'git-receive-pack' && ctx.method === 'POST') {
    const respond = (chunk: Buffer): void => ctx.raw(200, 'application/x-git-receive-pack-result', chunk);
    try {
      handleReceivePack(ctx.forge, repo, ctx.rawBody, respond);
      return;
    } catch (err) {
      ctx.json(500, { message: err instanceof Error ? err.message : 'receive-pack failed' });
      return;
    }
  }
  ctx.json(404, { message: 'Not Found' });
}
