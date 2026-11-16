// The entry <-> env lifecycle, as env/src/wire.ts settles it: bind an ephemeral port, tell the env the
// port it bound, then poll until the env says the trial is over and exit 0. Keep this file as it is:
// the suite scores the server app.ts builds, and the lifecycle is the harness's, not the contest's.
//
//   1. MAKEFUN_ENV_URL names the env's origin (http://store:8080 in a trial container). Without it
//      there is nothing to talk to, so the program exits 1 at once.
//   2. Create the server and listen(0): the kernel picks a free port. Never bind 8080 — the env owns it.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the address the request came from
//      plus N as your base URL and dials it from then on. The first register wins; a 409 means another
//      entry already registered, and this process keeps waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env answers at once ({"done":
//      false} while the suite runs), so this is a poll, not a long-held request. A failed or slow poll
//      is retried with a short exponential backoff; the process never exits before the env says done.
//   5. Close the server and exit 0. The harness then stops the env, which writes the export the scorer
//      reads.
//
// main.ts imports only its own server (app.ts) plus a type from node:http: no package, no model call.
// Authored revision: typed retry clock, deadline-aware shutdown, structured stderr diagnostics.

import { createApp } from './app.ts';
import type { Server } from 'node:http';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** How long one register or done request may take before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The first wait between retries, and the longest. */
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;
/** After a successful shutdown, exit 0 — but never hang past this in close(). */
const CLOSE_GRACE_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed requests: exponential from RETRY_INITIAL_MS, capped. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/** One stderr line, prefixed so trial logs stay greppable. */
function note(message: string): void {
  process.stderr.write(`[entry] ${message}\n`);
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer; 409 means a first register
 * already won, which is not this process's to fix. 400 and 405 are contract errors and end the program;
 * a network error or another status is retried, since the env may still be starting.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) {
        if (res.status === 409) note('register answered 409: another entry registered first; idling like the rest');
        return;
      }
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
      if (attempt > 0 && attempt % 20 === 0) {
        note(`register retry attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await sleep(retryDelay(attempt));
  }
}

/**
 * Poll GET /done until it answers {"done":true}; never return before that. Failed polls are counted so
 * a long trial leaves a trace of how often the env was unreachable.
 */
async function waitForDone(): Promise<void> {
  let failures = 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) {
          if (failures > 0) note(`done poll: ${failures} failed poll(s) before the env answered`);
          return;
        }
      } else {
        failures += 1;
      }
    } catch {
      failures += 1; // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

/** Close the listening socket, bounded by CLOSE_GRACE_MS so a stuck keep-alive cannot hang exit. */
async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      note(`server.close() exceeded ${CLOSE_GRACE_MS}ms; destroying open connections`);
      server.closeAllConnections();
      resolve();
    }, CLOSE_GRACE_MS);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Bound the port, register it, then wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  note(`listening on port ${address.port}`);

  // Die cleanly if the env vanishes mid-trial: a SIGTERM/SIGINT should still exit, not leave a zombie
  // holding the ephemeral port open for the harness to reap on timeout.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      note(`received ${signal}; closing and exiting`);
      void closeServer(server).then(() => process.exit(0));
    });
  }

  await register(address.port);
  note('registered; waiting for the env to say done');

  await waitForDone();
  await closeServer(server);
  note('done');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  note(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
