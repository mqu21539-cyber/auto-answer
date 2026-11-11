// End-to-end notification policy test against a live page.
//
// Scenario:
//   1. Question A appears            -> 1 toast
//   2. A is re-rendered 4 times      -> 0 extra toasts (same question)
//   3. Switch to question B          -> 1 toast
//   4. Switch back to A              -> 0 toasts (A already capped)
//
// Verified by counting the toast log written by the real toast().

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
const TOAST_LOG = path.join(APP_DIR, 'toast-log.jsonl');
const TRACKER_LOG = path.join(APP_DIR, 'tracker-test.json');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function readToasts() {
  try {
    const raw = await readFile(TOAST_LOG, 'utf8');
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** Change the question text without touching the layout. */
async function setQuestion(cdp, { heading, body }) {
  await cdp.evaluate(`(() => {
    document.getElementById('qTitle').textContent = ${JSON.stringify(heading)};
    const blocks = document.querySelectorAll('.left .problem');
    if (blocks[0]) blocks[0].innerHTML = '<h3>描述</h3><p>' + ${JSON.stringify(body)} + '</p>';
    for (let i = 1; i < blocks.length; i++) blocks[i].remove();
    return true;
  })()`);
  await wait(900);
}

/** Cosmetic churn: rewrite a counter, like a live pass-rate widget. */
async function churn(cdp) {
  await cdp.evaluate(`(() => {
    const meta = document.querySelector('.meta');
    if (meta) {
      meta.textContent = '知识点：链表 | 通过率 ' + (Math.random() * 100).toFixed(2) + '% | 时间限制 1s | 空间限制 256M';
    }
    return true;
  })()`);
  await wait(700);
}

async function main() {
  await clearQueue();
  await rm(TOAST_LOG, { force: true });
  await mkdir(APP_DIR, { recursive: true });

  const info = await ensureChrome({ headless: true });
  const { cdp } = await attachPage({ port: info.port, url: pathToFileURL(MOCK).href, timeoutMs: 20000 });
  await wait(2800);

  const watcher = spawn(process.execPath, [
    AA, 'watch', '--queue', '--url', pathToFileURL(MOCK).href,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AA_TOAST_LOG: TOAST_LOG, AA_TRACKER_FILE: TRACKER_LOG },
  });
  let werr = '';
  let wout = '';
  watcher.stderr.setEncoding('utf8');
  watcher.stdout.setEncoding('utf8');
  watcher.stderr.on('data', (d) => { werr += d; });
  watcher.stdout.on('data', (d) => { wout += d; });

  // Wait for the initial detection.
  for (let i = 0; i < 40; i++) {
    await wait(500);
    if ((await listQueue()).length) break;
  }
  const afterInitial = (await readToasts()).length;

  // Re-render churn: same question, five cosmetic updates.
  for (let i = 0; i < 5; i++) await churn(cdp);
  const afterChurn = (await readToasts()).length;

  // Genuine switch.
  await setQuestion(cdp, {
    heading: '反转链表',
    body: '给定一个单链表的头结点 pHead，反转该链表并输出反转后链表的头结点。数据范围：0 ≤ n ≤ 1000。',
  });
  await wait(1500);
  const afterSwitch = (await readToasts()).length;

  // Switch back to the first question: it is already capped, so no toast.
  await setQuestion(cdp, {
    heading: '合并两个排序的链表',
    body: '输入两个递增的链表，单个链表的长度为 n，合并这两个链表并使新链表中的节点仍然是递增排序的。',
  });
  await wait(1500);
  const afterBack = (await readToasts()).length;

  const queue = await listQueue();

  watcher.kill();
  await wait(400);
  cdp.close();
  await stopChrome().catch(() => {});

  const events = wout.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  return {
    ok: afterInitial === 1
        && afterChurn === 1
        && afterSwitch === 2
        && afterBack === 2
        && queue.length === 2,
    toasts: {
      afterInitialQuestion: afterInitial,
      afterFiveRerenders: afterChurn,
      afterRealSwitch: afterSwitch,
      afterSwitchBack: afterBack,
    },
    queue: queue.map((q) => ({ sig: q.sig, heading: q.heading, lang: q.lang })),
    detections: events
      .filter((e) => e.event === 'question-detected')
      .map((e) => ({
        heading: e.heading,
        reason: e.reason,
        isNew: e.isNew,
        notify: e.notify,
        notifyCount: e.notifyCount,
        notifyReasons: e.notifyReasons,
      })),
    queueSkips: events.filter((e) => e.event === 'queue-skipped').length,
  };
}

main().then((r) => {
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}).catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message, stack: e.stack }, null, 2));
  process.exit(1);
});
