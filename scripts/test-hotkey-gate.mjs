// Hotkey gating: with --hotkey, nothing happens until the combo is pressed.
//
// A headless test cannot press physical keys, so this verifies the gating
// contract instead:
//   - starting watch with --hotkey produces NO detection and NO toast
//   - the listener process is alive
//   - DOM churn on a real question page still produces nothing
//
// The trigger path itself is covered by test-hotkey.mjs (parsing + liveness) and
// by the manual smoke test documented in SKILL.md.

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, rm, readFile } from 'node:fs/promises';

import { ensureChrome, attachPage, stopChrome, APP_DIR } from './lib/chrome.mjs';
import { clearQueue, listQueue } from './lib/queue.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.resolve(HERE, '..', 'assets', 'mock-core.html');
const AA = path.join(HERE, 'aa.mjs');
const TOAST_LOG = path.join(APP_DIR, 'toast-hotkey.jsonl');
const TRACKER = path.join(APP_DIR, 'tracker-hotkey.json');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function toasts() {
  try {
    const raw = await readFile(TOAST_LOG, 'utf8');
    return raw.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function main() {
  await mkdir(APP_DIR, { recursive: true });
  await clearQueue();
  await rm(TOAST_LOG, { force: true });
  await rm(TRACKER, { force: true });

  const child = spawn(process.execPath, [
    AA, 'watch', '--queue', '--hotkey', 'J+K', '--url', pathToFileURL(MOCK).href,
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

  // Let the browser load and the listener start.
  await wait(9000);

  const afterStartToasts = await toasts();
  const afterStartQueue = await listQueue();
  const listenerAlive = child.exitCode === null;

  // Churn the question page: with a hotkey, this must still do nothing.
  const info = await ensureChrome({ headless: true });
  const { cdp } = await attachPage({ port: info.port, url: null, timeoutMs: 8000 });
  for (let i = 0; i < 4; i++) {
    await cdp.evaluate(`(() => {
      const meta = document.querySelector('.meta');
      if (meta) meta.textContent = '知识点：链表 | 通过率 ' + (${i} * 7.3).toFixed(2) + '% | 时间限制 1s';
      return true;
    })()`);
    await wait(600);
  }
  cdp.close();
  await wait(2500);

  const afterChurnToasts = await toasts();
  const afterChurnQueue = await listQueue();

  child.kill();
  await wait(600);
  await stopChrome().catch(() => {});

  const events = out.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  const detections = events.filter((e) => e.event === 'question-detected');
  const hotkeyEvents = events.filter((e) => e.event === 'hotkey');

  return {
    ok: afterStartToasts === 0
        && afterChurnToasts === 0
        && afterStartQueue.length === 0
        && afterChurnQueue.length === 0
        && detections.length === 0
        && hotkeyEvents.length === 0
        && listenerAlive,
    listenerAlive,
    toastsBeforePress: afterStartToasts,
    toastsAfterChurn: afterChurnToasts,
    queuedBeforePress: afterStartQueue.length,
    queuedAfterChurn: afterChurnQueue.length,
    detections: detections.length,
    hotkeyFires: hotkeyEvents.length,
    stderrTail: err.split('\n').slice(-6).join('\n'),
  };
}

main().then((r) => {
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}).catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
  process.exit(1);
});
