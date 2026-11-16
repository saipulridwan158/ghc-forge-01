// Git object store: sha1 object model with pack building/parsing via node:zlib.
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface RawObject { type: ObjType; data: Buffer }

export function sha1Hex(type: ObjType, data: Buffer): string {
  return createHash('sha1').update(Buffer.concat([Buffer.from(`${type} ${data.length}\0`), data])).digest('hex');
}

export function objSha(obj: RawObject): string {
  return sha1Hex(obj.type, obj.data);
}

/** Object store: type+data by sha, in memory. */
export class ObjectStore {
  readonly objects = new Map<string, RawObject>();

  put(type: ObjType, data: Buffer): string {
    const sha = sha1Hex(type, data);
    this.objects.set(sha, { type, data });
    return sha;
  }

  get(sha: string): RawObject | undefined {
    return this.objects.get(sha);
  }

  has(sha: string): boolean { return this.objects.has(sha); }
}

const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ---- Deflate with consumed-length tracking ----

export function deflate(data: Buffer): Buffer {
  return zlib.deflateSync(data, { level: 6 });
}

/** Inflate from a buffer starting at `start`; return data + how many compressed bytes were consumed. */
export function inflateAt(buffer: Buffer, start: number): { data: Buffer; consumed: number } {
  const out = zlib.inflateSync(buffer.subarray(start), { finishFlush: zlib.constants.Z_SYNC_FLUSH, info: true }) as unknown as { buffer: ArrayBuffer; length: number; engine?: { bytesWritten?: number } };
  const consumed = out.engine?.bytesWritten ?? 0;
  const data = Buffer.from(out.buffer, 0, out.length);
  return { data, consumed };
}

// ---- Pack building (no deltas: every object stored whole) ----

/** Build a packfile from full objects. */
export function buildPack(objects: readonly RawObject[]): Buffer {
  const chunks: Buffer[] = [];
  const count = objects.length;
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(count, 8);
  chunks.push(header);
  for (const obj of objects) {
    chunks.push(packEntryHeader(TYPE_CODES[obj.type], obj.data.length));
    chunks.push(deflate(obj.data));
  }
  const body = Buffer.concat(chunks);
  const hash = createHash('sha1').update(body).digest();
  return Buffer.concat([body, hash]);
}

/** The variable-length pack entry header: type + size, big-endian 7-bit groups. */
function packEntryHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let byte = (typeCode << 4) | (size & 0x0f);
  size >>>= 4;
  while (size > 0) {
    bytes.push(byte | 0x80);
    byte = size & 0x7f;
    size >>>= 7;
  }
  bytes.push(byte);
  return Buffer.from(bytes);
}

// ---- Pack parsing (full objects, ofs-delta and ref-delta resolution) ----

export interface PackedObject { type: ObjType; data: Buffer; offset: number }

/** Parse a packfile into objects, resolving ofs/ref deltas against earlier entries. */
export function parsePack(pack: Buffer): PackedObject[] {
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`bad pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const entries: PackedObject[] = [];
  const byOffset = new Map<number, PackedObject>();
  const pending: Array<{ offset: number; baseOffset?: number; baseSha?: string; delta: Buffer }> = [];
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = pos;
    let byte = pack[pos]; pos += 1;
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos]; pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      byte = pack[pos]; pos += 1;
      let off = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[pos]; pos += 1;
        off = ((off + 1) << 7) | (byte & 0x7f);
      }
      const baseOffset = entryOffset - off;
      const { data, consumed } = inflateAt(pack, pos);
      pos += consumed;
      pending.push({ offset: entryOffset, baseOffset, delta: data });
    } else if (typeCode === 7) {
      const baseSha = pack.toString('hex', pos, pos + 20);
      pos += 20;
      const { data, consumed } = inflateAt(pack, pos);
      pos += consumed;
      pending.push({ offset: entryOffset, baseSha, delta: data });
    } else {
      const type = CODE_TYPES[typeCode];
      if (type === undefined) throw new Error(`bad pack object type ${typeCode} at offset ${entryOffset}`);
      const { data, consumed } = inflateAt(pack, pos);
      pos += consumed;
      const obj: PackedObject = { type, data, offset: entryOffset };
      entries.push(obj);
      byOffset.set(entryOffset, obj);
    }
  }
  const shaOf = (obj: PackedObject): string => objSha(obj);
  const resolve = (base: PackedObject, delta: Buffer): { type: ObjType; data: Buffer } => {
    let p = 0;
    const readVarint = (): number => {
      let value = 0; let shift = 0; let b = 0;
      do { b = delta[p]; p += 1; value |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
      return value;
    };
    const baseSize = readVarint();
    if (baseSize !== base.data.length) throw new Error(`delta base size mismatch (${baseSize} vs ${base.data.length})`);
    const resultSize = readVarint();
    const result = Buffer.alloc(resultSize);
    let rp = 0;
    while (p < delta.length) {
      const op = delta[p]; p += 1;
      if (op & 0x80) {
        let cpOff = 0; let cpSize = 0;
        if (op & 0x01) { cpOff = delta[p]; p += 1; }
        if (op & 0x02) { cpOff |= delta[p] << 8; p += 1; }
        if (op & 0x04) { cpOff |= delta[p] << 16; p += 1; }
        if (op & 0x08) { cpOff |= delta[p] << 24; p += 1; }
        if (op & 0x10) { cpSize = delta[p]; p += 1; }
        if (op & 0x20) { cpSize |= delta[p] << 8; p += 1; }
        if (op & 0x40) { cpSize |= delta[p] << 16; p += 1; }
        if (cpSize === 0) cpSize = 0x10000;
        base.data.copy(result, rp, cpOff, cpOff + cpSize);
        rp += cpSize;
      } else {
        delta.copy(result, rp, p, p + op);
        p += op;
        rp += op;
      }
    }
    if (rp !== resultSize) throw new Error(`delta result size mismatch (${rp} vs ${resultSize})`);
    return { type: base.type, data: result };
  };
  let remaining = pending;
  while (remaining.length > 0) {
    const next: typeof remaining = [];
    let progressed = false;
    const shaIndex = new Map<string, PackedObject>();
    for (const e of entries) shaIndex.set(shaOf(e), e);
    for (const item of remaining) {
      let base: PackedObject | undefined;
      if (item.baseOffset !== undefined) base = byOffset.get(item.baseOffset);
      else if (item.baseSha !== undefined) base = shaIndex.get(item.baseSha) ?? entries.find((e) => shaOf(e) === item.baseSha);
      if (base === undefined) { next.push(item); continue; }
      const { type, data } = resolve(base, item.delta);
      const obj: PackedObject = { type, data, offset: item.offset };
      entries.push(obj);
      byOffset.set(item.offset, obj);
      progressed = true;
    }
    if (!progressed) throw new Error('pack has unresolvable deltas');
    remaining = next;
  }
  return entries;
}

// ---- Commit/tree parsing and building ----

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: { name: string; email: string; epochSec: number };
  committer: { name: string; email: string; epochSec: number };
  message: string;
}

const commitCache = new WeakMap<Buffer, CommitInfo>();

export function parseCommit(data: Buffer): CommitInfo {
  const hit = commitCache.get(data);
  if (hit !== undefined) return hit;
  const text = data.toString('utf8');
  const info: CommitInfo = { tree: '', parents: [], author: { name: '', email: '', epochSec: 0 }, committer: { name: '', email: '', epochSec: 0 }, message: '' };
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
    else if (key === 'author') info.author = parseIdent(value);
    else if (key === 'committer') info.committer = parseIdent(value);
  }
  info.message = lines.slice(i).join('\n').replace(/\n$/, '');
  commitCache.set(data, info);
  return info;
}

function parseIdent(value: string): { name: string; email: string; epochSec: number } {
  const lt = value.lastIndexOf('<');
  const gt = value.lastIndexOf('>');
  const name = value.slice(0, lt).trim();
  const email = value.slice(lt + 1, gt);
  const rest = value.slice(gt + 1).trim();
  const epochSec = Number.parseInt(rest.split(' ')[0] ?? '0', 10) || 0;
  return { name, email, epochSec };
}

export function buildCommit(info: Omit<CommitInfo, 'committer'> & { committer?: CommitInfo['committer'] }): Buffer {
  const committer = info.committer ?? info.author;
  const id = (p: { name: string; email: string; epochSec: number }): string => `${p.name} <${p.email}> ${p.epochSec} +0000`;
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${id(info.author)}`);
  lines.push(`committer ${id(committer)}`);
  lines.push('');
  lines.push(info.message);
  lines.push('');
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface TreeEntry { mode: string; name: string; sha: string }

const treeCache = new WeakMap<Buffer, TreeEntry[]>();

export function parseTree(data: Buffer): TreeEntry[] {
  const hit = treeCache.get(data);
  if (hit !== undefined) return hit;
  const entries: TreeEntry[] = [];
  let p = 0;
  while (p < data.length) {
    let sp = p;
    while (data[sp] !== 0x20) sp += 1;
    const mode = data.toString('ascii', p, sp);
    let nul = sp + 1;
    while (data[nul] !== 0) nul += 1;
    const name = data.toString('utf8', sp + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    p = nul + 21;
    entries.push({ mode, name, sha });
  }
  treeCache.set(data, entries);
  return entries;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
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
