// MCP: POST /mcp — streamable HTTP JSON-RPC 2.0, revisions 2026-07-28 (preferred) and legacy.
import type { Forge, ForgeRepo } from './store.ts';
import { repoJson, issueJson, pullJson, userJson } from './rest.ts';

export interface McpCtx {
  forge: Forge;
  token: string | null;
  method: string;
  query: URLSearchParams;
  rawBody: Buffer;
  json: (status: number, body: unknown, headers?: Record<string, string>) => void;
  req: import('node:http').IncomingMessage;
  res: import('node:http').ServerResponse;
}

const PREFERRED_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface JsonRpcRequest { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call: (args: Record<string, unknown>) => { content: Array<Record<string, unknown>>; isError?: boolean } | { error: string };
}

function textContent(text: string): Array<Record<string, unknown>> {
  return [{ type: 'text', text }];
}

function jsonText(value: unknown): Array<Record<string, unknown>> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

function okResult(content: Array<Record<string, unknown>>): Record<string, unknown> {
  return { content, isError: false };
}

function errorResult(message: string): Record<string, unknown> {
  return { content: textContent(message), isError: true };
}

/** Map github-mcp-server argument shapes onto the store. */
function buildTools(ctx: McpCtx): McpTool[] {
  const { forge } = ctx;
  const repoOf = (args: Record<string, unknown>): ForgeRepo | null => {
    // nearest-property mapping: owner/repo, or full_name
    let owner = typeof args.owner === 'string' ? args.owner : undefined;
    let name = typeof args.repo === 'string' ? args.repo : undefined;
    if ((owner === undefined || name === undefined) && typeof args.full_name === 'string') {
      const slash = args.full_name.indexOf('/');
      if (slash !== -1) {
        owner = owner ?? args.full_name.slice(0, slash);
        name = name ?? args.full_name.slice(slash + 1);
      }
    }
    if (owner === undefined || name === undefined) return null;
    const found = forge.repo(owner, name);
    return found === undefined ? null : found;
  };
  const tools: McpTool[] = [
    {
      name: 'create_repo',
      description: 'Create a new repository owned by the authenticated user',
      inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'The name of the repository' }, private: { type: 'boolean', description: 'Whether the repo is private' }, description: { type: 'string', description: 'The description' } }, required: ['name'] },
      call: (args) => {
        const name = typeof args.name === 'string' ? args.name.trim() : '';
        if (name === '') return { error: 'name is required' };
        if (forge.repo(forge.viewer.login, name) !== undefined) return { error: `Repository ${name} already exists` };
        const repo = forge.createRepo(forge.viewer.login, name, typeof args.description === 'string' ? args.description : '', args.private === true);
        return { content: jsonText(repoJson(repo)) };
      },
    },
    {
      name: 'get_repo',
      description: 'Get details of a repository',
      inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' } }, required: [] },
      call: (args) => {
        const repo = repoOf(args);
        if (repo === null) return { error: 'Repository not found' };
        return { content: jsonText(repoJson(repo)) };
      },
    },
    {
      name: 'create_issue',
      description: 'Create a new issue in a repository',
      inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] },
      call: (args) => {
        const repo = repoOf(args);
        if (repo === null) return { error: 'Repository not found' };
        const title = typeof args.title === 'string' ? args.title : '';
        if (title === '') return { error: 'title is required' };
        const issue = forge.createIssue(repo, title, typeof args.body === 'string' ? args.body : '', []);
        return { content: jsonText(issueJson(issue, repo)) };
      },
    },
    {
      name: 'list_issues',
      description: 'List issues in a repository',
      inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed', 'all'] } }, required: [] },
      call: (args) => {
        const repo = repoOf(args);
        if (repo === null) return { error: 'Repository not found' };
        const state = typeof args.state === 'string' ? args.state : 'open';
        const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
        return { content: jsonText(issues.map((issue) => issueJson(issue, repo))) };
      },
    },
    {
      name: 'create_pull_request',
      description: 'Create a new pull request in a repository',
      inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
      call: (args) => {
        const repo = repoOf(args);
        if (repo === null) return { error: 'Repository not found' };
        const title = typeof args.title === 'string' ? args.title : '';
        const head = typeof args.head === 'string' ? args.head : '';
        const base = typeof args.base === 'string' ? args.base : '';
        if (title === '' || head === '' || base === '') return { error: 'title, head and base are required' };
        if (!repo.refs.has(`refs/heads/${head}`)) return { error: `head ref ${head} does not exist` };
        if (!repo.refs.has(`refs/heads/${base}`)) return { error: `base ref ${base} does not exist` };
        const pull = forge.createPull(repo, title, typeof args.body === 'string' ? args.body : '', head, base);
        return { content: jsonText(pullJson(pull, repo)) };
      },
    },
    {
      name: 'merge_pull_request',
      description: 'Merge a pull request',
      inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] },
      call: (args) => {
        const repo = repoOf(args);
        if (repo === null) return { error: 'Repository not found' };
        const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number ?? ''), 10);
        const pull = repo.pulls.find((p) => p.number === pullNumber);
        if (pull === undefined) return { error: 'Pull request not found' };
        const sha = forge.mergePull(repo, pull);
        if (sha === null) return { error: 'Pull request is not mergeable' };
        return { content: jsonText({ sha, merged: true, message: 'Pull Request successfully merged' }) };
      },
    },
    {
      name: 'get_me',
      description: 'Get details of the authenticated user',
      inputSchema: { type: 'object', properties: {} },
      call: () => ({ content: jsonText(userJson(forge.viewer)) }),
    },
    {
      name: 'list_issues_comments',
      description: 'List comments on an issue',
      inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'number' } }, required: [] },
      call: (args) => {
        const repo = repoOf(args);
        if (repo === null) return { error: 'Repository not found' };
        const issueNumber = typeof args.issue_number === 'number' ? args.issue_number : Number.parseInt(String(args.issue_number ?? ''), 10);
        const issue = repo.issues.find((i) => i.number === issueNumber);
        if (issue === undefined) return { error: 'Issue not found' };
        return { content: jsonText(issue.comments) };
      },
    },
  ];
  return tools;
}

/** Match a requested tool name: server prefix allowed, suffix matched case-insensitively. */
function findTool(tools: readonly McpTool[], requested: string): McpTool | null {
  const wanted = requested.toLowerCase();
  for (const tool of tools) {
    const bare = tool.name.toLowerCase();
    if (wanted === bare || wanted.endsWith(`__${bare}`) || wanted.endsWith(`_${bare}`)) return tool;
  }
  return null;
}

function httpError(ctx: McpCtx, status: number, rpcError: { code: number; message: string } | null, id: unknown): void {
  if (rpcError === null) {
    ctx.json(status, { message: rpcMessage(status) });
    return;
  }
  ctx.json(status, { jsonrpc: '2.0', id, error: { code: rpcError.code, message: rpcError.message } });
}

function rpcMessage(status: number): string {
  if (status === 400) return 'Bad Request';
  if (status === 401) return 'Unauthorized';
  return 'Internal Server Error';
}

export async function handleMcp(ctx: McpCtx): Promise<void> {
  const { forge } = ctx;
  if (ctx.method !== 'POST') {
    ctx.json(405, { message: 'Method Not Allowed' });
    return;
  }
  // auth: a call with no Authorization header answers 401
  if (ctx.token === null) {
    ctx.json(401, { message: 'Unauthorized' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.rawBody.toString('utf8'));
  } catch {
    // a body that is not JSON answers HTTP 400 with -32700 (200 with -32700 from a pre-2026-07-28 server)
    ctx.json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const request = parsed as JsonRpcRequest;
  const id = request.id;
  const revision = String(ctx.req.headers['mcp-protocol-version'] ?? PREFERRED_REVISION);
  void revision;

  if (request.method === 'initialize') {
    const clientRevision = typeof (request.params as Record<string, unknown> | undefined)?.protocolVersion === 'string'
      ? (request.params as Record<string, string>).protocolVersion
      : PREFERRED_REVISION;
    const negotiated = clientRevision === PREFERRED_REVISION || LEGACY_REVISIONS.includes(clientRevision) ? clientRevision : PREFERRED_REVISION;
    ctx.json(200, {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: negotiated,
        capabilities: {
          tools: {},
        },
        serverInfo: { name: 'forge-mcp', version: '1.0.0' },
      },
    });
    return;
  }

  if (request.method === 'notifications/initialized' || request.method === 'notifications/cancelled') {
    ctx.json(202, { jsonrpc: '2.0', result: {} });
    return;
  }

  if (request.method === 'tools/list') {
    const tools = buildTools(ctx);
    ctx.json(200, {
      jsonrpc: '2.0',
      id,
      result: {
        tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
      },
    });
    return;
  }

  if (request.method === 'server/discover') {
    ctx.json(200, {
      jsonrpc: '2.0',
      id,
      result: {
        supportedVersions: [PREFERRED_REVISION, ...LEGACY_REVISIONS],
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'forge-mcp', version: '1.0.0' } },
        capabilities: { tools: { listChanged: false } },
      },
    });
    return;
  }

  if (request.method === 'tools/call') {
    const params = (request.params ?? {}) as { name?: unknown; arguments?: Record<string, unknown> };
    const requested = typeof params.name === 'string' ? params.name : '';
    const tools = buildTools(ctx);
    const tool = findTool(tools, requested);
    if (tool === null) {
      ctx.json(200, { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${requested}` } });
      return;
    }
    const args = params.arguments ?? {};
    // missing required argument answers isError:true
    const required = (tool.inputSchema.required as readonly string[] | undefined) ?? [];
    const missing = required.filter((key) => (args as Record<string, unknown>)[key] === undefined);
    if (missing.length > 0) {
      ctx.json(200, { jsonrpc: '2.0', id, result: errorResult(`Missing required argument: ${missing[0]}`) });
      return;
    }
    try {
      const outcome = tool.call(args);
      if ('error' in outcome && outcome.error !== undefined) {
        ctx.json(200, { jsonrpc: '2.0', id, result: errorResult(outcome.error) });
        return;
      }
      ctx.json(200, { jsonrpc: '2.0', id, result: okResult((outcome as { content: Array<Record<string, unknown>> }).content) });
      return;
    } catch (err) {
      ctx.json(200, { jsonrpc: '2.0', id, result: errorResult(err instanceof Error ? err.message : 'tool failed') });
      return;
    }
  }

  // unknown method
  ctx.json(200, { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `Method not found: ${request.method}` } });
}
