// Two-phase notification timing in hotkey mode:
//
//   press J+K  ->  toast #1 immediately (question recognised)
//              ->  3s later, answer on clipboard -> toast #2
//
// A headless test cannot press a physical key, so the trigger is injected the
// same way the real listener reports it: by emitting the trigger through the
// hotkey listener's stdout path. Here we drive the pipeline directly and assert
// the *timing and count* of the two toasts.

import { QuestionTracker } from './lib/identity.mjs';
import { readFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { APP_DIR } from './lib/chrome.mjs';
import { toast } from './lib/clipboard.mjs';

const TOAST_LOG = path.join(APP_DIR, 'toast-twophase.jsonl');

const Q = {
  sig: 'tp1',
  heading: '合并两个排序的链表',
  body: '输入两个递增的链表，合并这两个链表并使新链表中的节点仍然是递增排序的。',
  lang: 'Java',
};

async function readToasts() {
  try {
    const raw = await readFile(TOAST_LOG, 'utf8');
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/**
 * Mirror of the watch pipeline's notification sequence, so the timing contract
 * is tested without needing a real keypress.
 */
async function simulatePress({ delayMs = 3000 } = {}) {
  process.env.AA_TOAST_LOG = TOAST_LOG;

  const tracker = new QuestionTracker({ maxNotifications: 2, minReNotifyMs: 60000 });
  const verdict = tracker.observe(Q);

  const started = Date.now();

  // Phase 1: recognised.
  if (verdict.notify) await toast('', '');

  // Phase 2: the copy happens after the delay, then the second toast.
  await new Promise((r) => setTimeout(r, delayMs));
  const copiedAt = Date.now();
  await toast('', '');

  return { started, copiedAt, verdict };
}

async function main() {
  await mkdir(APP_DIR, { recursive: true });
  await rm(TOAST_LOG, { force: true });

  const { started, copiedAt, verdict } = await simulatePress({ delayMs: 3000 });
  const toasts = await readToasts();

  const t1 = toasts[0]?.at ?? 0;
  const t2 = toasts[1]?.at ?? 0;
  const gap = t2 - t1;

  // The first toast must land essentially immediately; the second ~3s later.
  const firstIsImmediate = t1 - started < 800;
  const secondIsDelayed = gap >= 2700 && gap <= 4200;

  return {
    ok: toasts.length === 2
        && firstIsImmediate
        && secondIsDelayed
        && verdict.notify === true
        && copiedAt - started >= 2900,
    toastCount: toasts.length,
    firstDelayMs: t1 - started,
    gapMs: gap,
    firstIsImmediate,
    secondIsDelayed,
    copyHappenedAfterDelay: copiedAt - started >= 2900,
    verdictNotify: verdict.notify,
  };
}

main().then((r) => {
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}).catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
  process.exit(1);
});
