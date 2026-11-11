// Silent mode: the answer must reach the clipboard with ZERO notifications.
//
// Uses a stub model so the timing is deterministic.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';

import { APP_DIR } from './lib/chrome.mjs';
import { readClipboard, preserveClipboard } from './lib/clipboard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AA = path.join(HERE, 'aa.mjs');
const TRIGGER = path.join(APP_DIR, 'silent-trigger.txt');
const TOAST_LOG = path.join(APP_DIR, 'toast-silent-mode.jsonl');

const CODE = 'public class Solution {\n    public int f(int n) { return n; }\n}\n';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function toasts() {
  try {
    return (await readFile(TOAST_LOG, 'utf8')).split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

const parse = (t) => t.split('\n').filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

async function main() {
  const restoreClipboard = await preserveClipboard();

  await mkdir(APP_DIR, { recursive: true });
  await rm(TOAST_LOG, { force: true });
  await rm(TRIGGER, { force: true });

  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: 'stub',
        choices: [{ message: { content: CODE } }],
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const child = spawn(process.execPath, [
    AA, 'watch', '--desktop', '--auto', '--no-toast', '--deadline', '30',
    '--trigger-file', TRIGGER,
    '--api-base', `http://127.0.0.1:${port}/v1`,
    '--api-key', 'stub',
    '--model', 'stub',
    '--clip-delay', '0',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AA_TOAST_LOG: TOAST_LOG },
  });

  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });

  await wait(2500);
  await writeFile(TRIGGER, `t ${Date.now()}\n`, 'utf8');

  let copied = null;
  for (let i = 0; i < 40; i++) {
    await wait(400);
    copied = parse(out).find((e) => e.event === 'clipboard-copied');
    if (copied) break;
  }

  const toastCount = await toasts();
  const clip = await readClipboard();
  const requests = parse(out).filter((e) => e.event === 'vision-request');

  child.kill();
  await wait(400);
  server.close();

  const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n').trim();
  const ok = toastCount === 0
    && copied?.ok === true
    && norm(clip) === norm(CODE)
    && requests.length === 1
    && requests[0].notify === false
    && requests[0].notifyCount === 0;

  console.log(JSON.stringify({
    ok,
    toastCount,
    notificationsSuppressed: requests[0]?.notify === false,
    notifyCount: requests[0]?.notifyCount,
    copied: copied ?? null,
    clipboardMatches: norm(clip) === norm(CODE),
    clipboardChars: clip?.length ?? 0,
  }, null, 2));

  await restoreClipboard();

  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
  process.exitCode = 1;
});
