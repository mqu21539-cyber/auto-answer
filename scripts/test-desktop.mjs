// Desktop mode: capture the screen, notify, take the answer, notify again.
// No browser, no CDP port — the trigger is a file so it can be driven headlessly.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { APP_DIR } from './lib/chrome.mjs';
import { readClipboard, preserveClipboard } from './lib/clipboard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AA = path.join(HERE, 'aa.mjs');
const ANSWERS = path.join(APP_DIR, 'answers');
const TRIGGER = path.join(APP_DIR, 'desktop-trigger.txt');
const TOAST_LOG = path.join(APP_DIR, 'toast-desktop.jsonl');
const TRACKER = path.join(APP_DIR, 'tracker-desktop.json');

const ANSWER = `public class Solution {
    public int solve(int n) {
        return n;
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

let restoreClipboard = async () => {};

async function main() {
  restoreClipboard = await preserveClipboard();

  await mkdir(APP_DIR, { recursive: true });
  await rm(TOAST_LOG, { force: true });
  await rm(TRACKER, { force: true });
  await rm(TRIGGER, { force: true });

  const child = spawn(process.execPath, [
    AA, 'watch', '--desktop', '--trigger-file', TRIGGER,
    '--clip-delay', '1', '--answer-timeout', '60',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AA_TOAST_LOG: TOAST_LOG, AA_TRACKER_FILE: TRACKER },
  });

  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });

  await wait(3000);
  const toastsBefore = await toasts();

  // Fire the trigger, as pressing J+K would.
  await writeFile(TRIGGER, `t ${Date.now()}\n`, 'utf8');

  let vision = null;
  for (let i = 0; i < 30; i++) {
    await wait(500);
    vision = parse(out).find((e) => e.event === 'vision-request');
    if (vision) break;
  }

  if (!vision) {
    child.kill();
    return { ok: false, error: 'no vision-request', out: out.slice(0, 500), err: err.slice(0, 500) };
  }

  const toastsAfterCapture = await toasts();
  const shotOk = vision.screenshot ? existsSync(vision.screenshot) : false;
  const shotBytes = shotOk ? (await stat(vision.screenshot)).size : 0;

  // Write the answer under the exact signature the watcher asked for.
  await writeFile(path.join(ANSWERS, `${vision.sig}.java`), ANSWER, 'utf8');

  let copied = null;
  for (let i = 0; i < 30; i++) {
    await wait(500);
    copied = parse(out).find((e) => e.event === 'clipboard-copied');
    if (copied) break;
  }

  const toastsAfterCopy = await toasts();
  const clip = await readClipboard();

  // Second press while the first answer is still outstanding: the capture path
  // must stay responsive instead of reporting "still busy".
  const triggerStat = await stat(TRIGGER);
  await wait(1100); // ensure the mtime advances past the poll interval
  await writeFile(TRIGGER, `t2 ${Date.now()}\n`, 'utf8');

  let second = null;
  for (let i = 0; i < 20; i++) {
    await wait(500);
    const all = parse(out).filter((e) => e.event === 'vision-request');
    if (all.length >= 2) { second = all[1]; break; }
  }

  const toastsAfterSecond = await toasts();
  const secondShotOk = second?.screenshot ? existsSync(second.screenshot) : false;

  child.kill();
  await wait(400);

  return {
    ok: shotOk && shotBytes > 1000
        && toastsBefore === 0
        && toastsAfterCapture === 1
        && toastsAfterCopy === 2
        && toastsAfterSecond === 3
        && copied?.ok === true
        && clip === ANSWER
        && Boolean(second)
        && secondShotOk
        && second.sig !== vision.sig,
    screenshot: { path: vision.screenshot, exists: shotOk, bytes: shotBytes, w: vision.width, h: vision.height },
    sig: vision.sig,
    secondCapture: second ? { sig: second.sig, shotExists: secondShotOk, distinctSig: second.sig !== vision.sig } : null,
    notifications: {
      before: toastsBefore,
      afterCapture: toastsAfterCapture,
      afterCopy: toastsAfterCopy,
      afterSecondCapture: toastsAfterSecond,
    },
    clipboardMatchesAnswer: clip === ANSWER,
    clipboardChars: clip?.length ?? 0,
    stderrTail: err.split('\n').slice(-5).join('\n'),
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
