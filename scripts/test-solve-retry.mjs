// Gateway retry: a saturated relay returns 429/503 and clears within seconds, so
// the solver must try again instead of dropping the question.
//
// The server below is a real HTTP endpoint that fails on purpose, so this
// exercises the actual fetch/errno path rather than a mocked function.

import { createServer } from 'node:http';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { solveWithVision, loadSolverConfig } from './lib/vision-solver.mjs';
import { APP_DIR } from './lib/chrome.mjs';

const IMG = path.join(APP_DIR, 'shots', 'retry-test.png');
const CODE = 'public class Solution { int f(int n) { return n; } }';

/** Server that returns `statuses[n]` for the n-th request. */
async function startStub(statuses) {
  let calls = 0;
  const seen = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls += 1;
      seen.push(calls);
      const status = statuses[Math.min(calls - 1, statuses.length - 1)];
      if (status === 200) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model: 'stub', choices: [{ message: { content: CODE } }] }));
      } else {
        const code = status === 429 ? 'gateway_queue_full' : 'upstream_error';
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code, message: 'try later' } }));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    calls: () => calls,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

function cfgFor(port, extra = {}) {
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'stub',
    model: 'stub',
    timeoutMs: 60000,
    budgetMs: 60000,
    ...extra,
  };
}

async function caseRetryThenSucceed() {
  const stub = await startStub([429, 429, 200]);
  const retries = [];
  const t = Date.now();
  const r = await solveWithVision({
    imagePath: IMG,
    config: cfgFor(stub.port),
    onRetry: (i) => retries.push(i),
  });
  const ms = Date.now() - t;
  await stub.close();
  return {
    ok: r.ok === true && r.attempts === 3 && stub.calls() === 3
        && retries.length === 2 && r.code.includes('class Solution'),
    attempts: r.attempts,
    serverCalls: stub.calls(),
    retries: retries.map((x) => ({ attempt: x.attempt, waitMs: x.waitMs, error: (x.error ?? '').slice(0, 40) })),
    ms,
  };
}

async function casePermanentFailsFast() {
  const stub = await startStub([401]);
  const retries = [];
  const t = Date.now();
  const r = await solveWithVision({
    imagePath: IMG,
    config: cfgFor(stub.port),
    onRetry: (i) => retries.push(i),
  });
  const ms = Date.now() - t;
  await stub.close();
  return {
    // 401 must not be retried: no amount of waiting fixes a bad key.
    ok: r.ok === false && r.attempts === 1 && stub.calls() === 1 && retries.length === 0 && /401/.test(r.error ?? ''),
    attempts: r.attempts,
    serverCalls: stub.calls(),
    retries: retries.length,
    ms,
  };
}

async function caseBudgetStopsRetry() {
  const stub = await startStub([503]);
  const t = Date.now();
  const r = await solveWithVision({
    imagePath: IMG,
    // A 4s budget cannot fit a 2s backoff plus another attempt.
    config: cfgFor(stub.port, { budgetMs: 4000 }),
  });
  const ms = Date.now() - t;
  await stub.close();
  return {
    ok: r.ok === false && ms < 8000,
    attempts: r.attempts,
    serverCalls: stub.calls(),
    ms,
    error: (r.error ?? '').slice(0, 60),
  };
}

async function main() {
  await mkdir(path.dirname(IMG), { recursive: true });
  await writeFile(IMG, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ));

  const retry = await caseRetryThenSucceed();
  const permanent = await casePermanentFailsFast();
  const budget = await caseBudgetStopsRetry();

  const ok = retry.ok && permanent.ok && budget.ok;

  console.log(JSON.stringify({ ok, retry, permanent, budget }, null, 2));
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
  process.exitCode = 1;
});