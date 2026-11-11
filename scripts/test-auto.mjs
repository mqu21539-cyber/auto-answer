// End-to-end auto mode: one keypress -> capture -> vision model -> answer file
// -> clipboard -> second notification. No human in the loop.
//
// The model is a local stub so the test needs no API key and no network.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';

import { APP_DIR } from './lib/chrome.mjs';
import { readClipboard, preserveClipboard } from './lib/clipboard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AA = path.join(HERE, 'aa.mjs');
const TRIGGER = path.join(APP_DIR, 'auto-trigger.txt');
const TOAST_LOG = path.join(APP_DIR, 'toast-auto.jsonl');

const MODEL_CODE = `import java.util.*;

public class Solution {
    public boolean isPail (ListNode head) {
        if (head == null || head.next == null) return true;
        ListNode slow = head, fast = head;
        while (fast.next != null && fast.next.next != null) {
            slow = slow.next;
            fast = fast.next.next;
        }
        ListNode prev = null, cur = slow.next;
        while (cur != null) {
            ListNode next = cur.next;
            cur.next = prev;
            prev = cur;
            cur = next;
        }
        ListNode a = head, b = prev;
        while (b != null) {
            if (a.val != b.val) return false;
            a = a.next;
            b = b.next;
        }
        return true;
    }
}
`;

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

  let modelCalls = 0;
  let lastRequestHadImage = false;

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      modelCalls += 1;
      lastRequestHadImage = body.includes('data:image/png;base64,');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: 'stub-vision',
        choices: [{ message: { content: MODEL_CODE } }],
        usage: { prompt_tokens: 1200, completion_tokens: 300 },
      }));
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const child = spawn(process.execPath, [
    AA, 'watch', '--desktop', '--auto',
    '--trigger-file', TRIGGER,
    '--api-base', `http://127.0.0.1:${port}/v1`,
    '--api-key', 'stub-key',
    '--model', 'stub-vision',
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
  const toastsBefore = await toasts();

  await writeFile(TRIGGER, `t ${Date.now()}\n`, 'utf8');

  // Wait for the model to be called and the answer to be written.
  let solveReady = null;
  for (let i = 0; i < 60; i++) {
    await wait(500);
    solveReady = parse(out).find((e) => e.event === 'solve-ready');
    if (solveReady) break;
  }

  // Wait for the copy.
  let copied = null;
  for (let i = 0; i < 30; i++) {
    await wait(500);
    copied = parse(out).find((e) => e.event === 'clipboard-copied');
    if (copied) break;
  }

  const toastsAfter = await toasts();
  const clip = await readClipboard();

  child.kill();
  await wait(500);
  server.close();

  // Compare normalised: the clipboard round-trips CRLF, and the solver trims
  // the trailing newline the model emitted.
  const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n').trim();

  const ok = modelCalls === 1
    && lastRequestHadImage
    && Boolean(solveReady)
    && copied?.ok === true
    && norm(clip) === norm(MODEL_CODE)
    && toastsBefore === 0
    && toastsAfter === 2;

  console.log(JSON.stringify({
    ok,
    modelCalls,
    lastRequestHadImage,
    solveReady: solveReady ?? null,
    copied: copied ?? null,
    notifications: { before: toastsBefore, after: toastsAfter },
    clipboardMatchesModelOutput: norm(clip) === norm(MODEL_CODE),
    clipboardChars: clip?.length ?? 0,
    modelChars: MODEL_CODE.length,
    stderrTail: err.split('\n').slice(-6).join('\n'),
  }, null, 2));

  await restoreClipboard();

  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message, stack: e.stack }, null, 2));
  process.exitCode = 1;
});
