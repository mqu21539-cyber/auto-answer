// Live check that the notification cap survives a watch restart.
//
//   1. Run watch, let it detect question A       -> 1 toast
//   2. Kill watch, start it again                -> must NOT re-toast A
//   3. Verify the toast log still holds exactly 1 entry for A

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, rm, readFile } from 'node:fs/promises';

import { ensureChrome, attachPage, stopChrome, APP_DIR } from './lib/chrome.mjs';
import { clearQueue } from './lib/queue.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.resolve(HERE, '..', 'assets', 'mock-core.html');
const AA = path.join(HERE, 'aa.mjs');
const TOAST_LOG = path.join(APP_DIR, 'toast-log.jsonl');
const TRACKER = path.join(APP_DIR, 'tracker.json');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function toasts() {
  try {
    const raw = await readFile(TOAST_LOG, 'utf8');
    return raw.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function runWatcher(seconds) {
  const child = spawn(process.execPath, [
    AA, 'watch', '--queue', '--url', pathToFileURL(MOCK).href,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AA_TOAST_LOG: TOAST_LOG },
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });
  await wait(seconds * 1000);
  child.kill();
  await wait(600);
  return out;
}

async function main() {
  await clearQueue();
  await rm(TOAST_LOG, { force: true });
  await rm(TRACKER, { force: true });
  await mkdir(APP_DIR, { recursive: true });

  // First run.
  const out1 = await runWatcher(12);
  const afterRun1 = await toasts();

  const trackerRaw1 = await readFile(TRACKER, 'utf8').catch(() => null);
  const savedHistory = trackerRaw1 ? JSON.parse(trackerRaw1).history.length : 0;

  // Second run, same page, same question.
  const out2 = await runWatcher(12);
  const afterRun2 = await toasts();

  await stopChrome().catch(() => {});

  const parse = (t) => t.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  const det1 = parse(out1).filter((e) => e.event === 'question-detected');
  const det2 = parse(out2).filter((e) => e.event === 'question-detected');

  return {
    ok: afterRun1 === 1 && afterRun2 === 1 && savedHistory >= 1,
    toastsAfterFirstRun: afterRun1,
    toastsAfterRestart: afterRun2,
    trackerHistoryEntries: savedHistory,
    firstRunDetection: det1[0] ? {
      isNew: det1[0].isNew,
      notify: det1[0].notify,
      count: det1[0].notifyCount,
    } : null,
    secondRunDetection: det2[0] ? {
      isNew: det2[0].isNew,
      notify: det2[0].notify,
      count: det2[0].notifyCount,
      reasons: det2[0].notifyReasons,
    } : null,
  };
}

main().then((r) => {
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}).catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
  process.exit(1);
});
