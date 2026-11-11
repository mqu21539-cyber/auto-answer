// Switching questions: a request that is still in flight must not touch the
// clipboard once a newer capture has happened.
//
// The first model call is deliberately slow, so the second press overtakes it.
// Without the generation guard, A's answer would land on the clipboard after the
// operator already moved on to B — and they would paste the wrong solution.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';

import { APP_DIR } from './lib/chrome.mjs';
import { readClipboard, preserveClipboard } from './lib/clipboard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AA = path.join(HERE, 'aa.mjs');
const TRIGGER = path.join(APP_DIR, 'supersede-trigger.txt');
const TOAST_LOG = path.join(APP_DIR, 'toast-supersede.jsonl');
const ANSWERS = path.join(APP_DIR, 'answers');

const CODE_A = 'public class SolutionA {\n    int a = 1; // ANSWER-A\n}\n';
const CODE_B = 'public class SolutionB {\n    int b = 2; // ANSWER-B\n}\n';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const parse = (t) => t.split('\n').filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

async function main() {
  const restoreClipboard = await preserveClipboard();

  await mkdir(APP_DIR, { recursive: true });
  await rm(TOAST_LOG, { force: true });
  await rm(TRIGGER, { force: true });

  let calls = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls += 1;
      // First question answers slowly, second one quickly.
      if (calls === 1) {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ model: 'stub', choices: [{ message: { content: CODE_A } }] }));
        }, 3500);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model: 'stub', choices: [{ message: { content: CODE_B } }] }));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const child = spawn(process.execPath, [
    AA, 'watch', '--desktop', '--auto', '--no-toast',
    '--trigger-file', TRIGGER,
    '--api-base', `http://127.0.0.1:${port}/v1`,
    '--api-key', 'stub', '--model', 'stub',
    '--clip-delay', '0',
    '--answer-timeout', '60',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AA_TOAST_LOG: TOAST_LOG },
  });

  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });

  await wait(3000);

  // Question A, then quickly question B.
  await writeFile(TRIGGER, `A ${Date.now()}\n`, 'utf8');
  await wait(700);
  await writeFile(TRIGGER, `B ${Date.now()}\n`, 'utf8');

  // Give both model calls time to finish (A takes 3.5s).
  await wait(12000);

  const events = parse(out);
  const requests = events.filter((e) => e.event === 'vision-request');
  const readyA = events.filter((e) => e.event === 'solve-ready' && e.sig === requests[0]?.sig);
  const copiedEvents = events.filter((e) => e.event === 'clipboard-copied');
  const clip = await readClipboard();

  child.kill();
  await wait(500);
  server.close();

  const sigA = requests[0]?.sig;
  const sigB = requests[1]?.sig;

  // A's answer must exist on disk even though it was not delivered.
  let fileA = null;
  for (const ext of ['.java', '.py', '.cpp']) {
    const p = path.join(ANSWERS, `${sigA}${ext}`);
    try { await readFile(p, 'utf8'); fileA = p; break; } catch { /* keep looking */ }
  }
  const contentA = fileA ? await readFile(fileA, 'utf8') : null;

  const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n').trim();
  const ok = requests.length === 2
    && Boolean(sigA) && Boolean(sigB) && sigA !== sigB
    && copiedEvents.length === 1
    && copiedEvents[0].sig === sigB
    && norm(clip) === norm(CODE_B)
    && norm(contentA) === norm(CODE_A)          // A kept on disk
    && readyA.length === 1
    && readyA[0].stale === true;                // A marked as superseded

  console.log(JSON.stringify({
    ok,
    modelCalls: calls,
    requests: requests.map((r) => ({ sig: r.sig, gen: r.gen })),
    aSolveReady: readyA.map((r) => ({ sig: r.sig, stale: r.stale, file: r.file })),
    clipboardDeliveries: copiedEvents.map((c) => c.sig),
    clipboardIsB: norm(clip) === norm(CODE_B),
    clipboardIsA: norm(clip) === norm(CODE_A),
    aAnswerKeptOnDisk: Boolean(fileA),
    supersededEvents: events.filter((e) => e.event === 'superseded').length,
    stderrTail: err.split('\n').slice(-6).join('\n'),
  }, null, 2));

  await restoreClipboard();

  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message, stack: e.stack }, null, 2));
  process.exitCode = 1;
});