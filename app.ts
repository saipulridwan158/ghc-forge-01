// The forge's HTTP surface: healthz, REST v3, GraphQL v4, MCP, git smart HTTP, JSON 404.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGit } from './git-http.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

const forge = new Forge();

/** Answer one request with a JSON body. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const requestHeaders: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestId(),
    ...headers,
  };
  if (status === 204) {
    res.writeHead(204, requestHeaders);
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  requestHeaders['content-length'] = Buffer.byteLength(text);
  res.writeHead(status, requestHeaders);
  res.end(text);
}

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `FFFF:${String(requestCounter).padStart(12, '0')}`;
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return decodeURIComponent(new URL(req.url ?? '/', 'http://entry').pathname);
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function tokenOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header === undefined) return null;
  const match = /^Bearer (.+)$/.exec(header);
  if (match === null) return null;
  return match[1];
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      const query = queryOf(req);
      const token = tokenOf(req);

      const json = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
        sendJson(res, status, body, headers);
      };

      // The env's boot check calls this twice: 200 {"ok":true}.
      if (method === 'GET' && path === '/healthz') {
        json(200, { ok: true });
        return;
      }

      // The GitHub API root: a 200 with the token's scopes, as api.github.com answers GET /.
      if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
        json(200, {
          current_user_url: '/api/v3/user',
          rate_limit_url: '/api/v3/rate_limit',
          user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
          repository_url: '/api/v3/repos/{owner}/{repo}',
        }, { 'x-oauth-scopes': 'repo, read:org' });
        return;
      }

      // REST v3
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const subPath = path.slice('/api/v3'.length);
        const rawBody = await readBody(req);
        // malformed JSON on body-carrying methods is a 400 (checked inside the routers)
        if ((method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') && rawBody.length > 0) {
          const contentType = req.headers['content-type'] ?? '';
          if (contentType.includes('application/json')) {
            try {
              JSON.parse(rawBody.toString('utf8'));
            } catch {
              json(400, { message: 'Problems parsing JSON' });
              return;
            }
          }
        }
        await handleRest({ forge, token, method, path: subPath, query, json, rawBody, host: String(req.headers.host ?? 'localhost') }).catch((err: unknown) => {
          json(500, { message: err instanceof Error ? err.message : 'internal error' });
        });
        return;
      }

      // GraphQL v4
      if (path === '/api/graphql') {
        const rawBody = await readBody(req);
        let parsed: unknown = undefined;
        let malformed = false;
        try {
          parsed = JSON.parse(rawBody.toString('utf8'));
        } catch {
          malformed = true;
        }
        await handleGraphQL({ forge, token, method, query, rawBody, parsed, malformed, json }).catch((err: unknown) => {
          json(500, { message: err instanceof Error ? err.message : 'internal error' });
        });
        return;
      }

      // MCP
      if (path === '/mcp') {
        const rawBody = await readBody(req);
        await handleMcp({ forge, token, method, query, rawBody, json, req, res }).catch((err: unknown) => {
          json(500, { message: err instanceof Error ? err.message : 'internal error' });
        });
        return;
      }

      // git smart HTTP
      if (path.includes('.git/') || path.endsWith('.git')) {
        const rawBody = await readBody(req);
        try {
          handleGit({
            forge,
            method,
            path,
            query,
            headers: req.headers,
            rawBody,
            json: (status, body) => sendJson(res, status, body),
            raw: (status, contentType, body) => {
              res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'cache-control': 'no-cache' });
              res.end(body);
            },
          });
        } catch (err) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'git error' });
        }
        return;
      }

      // Everything else, every method: GitHub's 404 body.
      sendJson(res, 404, { message: 'Not Found' });
    })().catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
      else res.end();
    });
  });
}
