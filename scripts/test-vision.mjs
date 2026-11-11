// End-to-end vision flow:
//
//   trigger -> screenshot captured -> notify #1 -> answer file written
//           -> clipboard gets the answer -> notify #2
//
// Uses --trigger-file so the hotkey can be simulated headlessly: writing the
// trigger file is exactly what the key listener does on a press.

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { ensureChrome, attachPage, stopChrome, APP_DIR, readState } from './lib/chrome.mjs';
import { readClipboard, preserveClipboard } from './lib/clipboard.mjs';
import { clearQueue, listQueue } from './lib/queue.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.resolve(HERE, '..', 'assets', 'mock-core.html');
const AA = path.join(HERE, 'aa.mjs');
const ANSWERS = path.join(APP_DIR, 'answers');
const TRIGGER = path.join(APP_DIR, 'trigger.txt');
const TOAST_LOG = path.join(APP_DIR, 'toast-vision.jsonl');
const TRACKER = path.join(APP_DIR, 'tracker-vision.json');

const JAVA = `public class Solution {
    public ListNode Merge(ListNode a, ListNode b) {
        return a;
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

let restoreClipboard = async () => {};

async function main() {
  restoreClipboard = await preserveClipboard();

  await mkdir(APP_DIR, { recursive: true });
  await clearQueue();
  await rm(TOAST_LOG, { force: true });
  await rm(TRACKER, { force: true });
  await rm(TRIGGER, { force: true });

  // Start watch in vision mode with a file trigger.
  const child = spawn(process.execPath, [
    AA, 'watch', '--vision', '--trigger-file', TRIGGER,
    '--answer-timeout', '40', '--url', pathToFileURL(MOCK).href,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AA_TOAST_LOG: TOAST_LOG,
      AA_TRACKER_FILE: TRACKER,
    },
  });

  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });

  // Wait for the browser and the trigger watcher to come up.
  await wait(9000);

  const toastsBefore = await toasts();

  // Fire the trigger.
  await writeFile(TRIGGER, `trigger ${Date.now()}\n`, 'utf8');

  // Wait for the vision-request event (screenshot captured).
  let vision = null;
  for (let i = 0; i < 30; i++) {
    await wait(500);
    const ev = out.split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean).find((e) => e.event === 'vision-request');
    if (ev) { vision = ev; break; }
  }

  if (!vision) {
    child.kill();
    await stopChrome().catch(() => {});
    return { ok: false, error: 'no vision-request', out: out.slice(0, 600), err: err.slice(0, 600) };
  }

  const toastsAfterRequest = await toasts();
  const shotExists = vision.screenshot ? existsSync(vision.screenshot) : false;
  const shotBytes = vision.screenshot && shotExists ? (await stat(vision.screenshot)).size : 0;

  // Write the answer, as the agent would after reading the screenshot.
  await writeFile(path.join(ANSWERS, `${vision.sig}.java`), JAVA, 'utf8');

  // Wait for the copy.
  let copied = null;
  for (let i = 0; i < 40; i++) {
    await wait(500);
    const ev = out.split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean).find((e) => e.event === 'clipboard-copied');
    if (ev) { copied = ev; break; }
  }

  const toastsAfterCopy = await toasts();
  const clip = await readClipboard();
  const queue = await listQueue();

  child.kill();
  await wait(500);
  await stopChrome().catch(() => {});

  return {
    ok: Boolean(vision)
        && shotExists && shotBytes > 1000
        && toastsBefore === 0
        && toastsAfterRequest === 1
        && toastsAfterCopy === 2
        && copied?.ok === true
        && clip === JAVA
        && queue.length >= 1,
    screenshot: { path: vision.screenshot, exists: shotExists, bytes: shotBytes },
    sig: vision.sig,
    queued: queue.length,
    notifications: { before: toastsBefore, afterCapture: toastsAfterRequest, afterCopy: toastsAfterCopy },
    clipboardMatchesAnswer: clip === JAVA,
    clipboardChars: clip?.length ?? 0,
    answerChars: JAVA.length,
    copiedEvent: copied ?? null,
    stderrTail: err.split('\n').slice(-6).join('\n'),
  };
}

main().then(async (r) => {
  await restoreClipboard();
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}).catch(async (e) => {
  await restoreClipboard();
  console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
  process.exit(1);
});
