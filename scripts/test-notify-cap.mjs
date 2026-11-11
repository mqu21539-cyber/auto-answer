// Verifies the notification cap holds across the two cases that would silently
// break it:
//
//   1. A question seen long ago (beyond any history window) must still be
//      recognised as the same question and must not get a fresh quota.
//   2. Restarting watch must not reset the per-question counts.
//
// Also re-checks the basic rule: at most 2 notifications per question, at least
// 60s apart, and cosmetic re-renders never notify.

import { QuestionTracker, compareQuestions } from './lib/identity.mjs';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

import { APP_DIR } from './lib/chrome.mjs';
import { loadTrackerState, saveTrackerState, TRACKER_FILE } from './lib/queue.mjs';

const Q = {
  sig: 'q1',
  heading: '合并两个排序的链表',
  body: '输入两个递增的链表，合并这两个链表并使新链表中的节点仍然是递增排序的。',
  lang: 'Java',
};

const Q_RERENDER = {
  sig: 'q1b',
  heading: '合并两个排序的链表',
  body: '输入两个递增的链表，合并这两个链表并使新链表中的节点仍然是递增排序的。通过率：45.12% 耗时：88ms',
  lang: 'Java',
};

const OTHER = {
  sig: 'q2',
  heading: '反转链表',
  body: '给定一个单链表的头结点 pHead，反转该链表并输出反转后链表的头结点。',
  lang: 'Java',
};

/** Simulate time passing without waiting. */
function rewind(tracker, ms) {
  for (const r of tracker.history) {
    if (r.lastNotifyAt) r.lastNotifyAt -= ms;
  }
}

async function testLongHistory() {
  // Push 300 distinct questions, then come back to the first one.
  const t = new QuestionTracker({ maxNotifications: 2 });
  t.observe(Q);
  rewind(t, 61000);
  t.observe(Q_RERENDER);          // 2nd notification used up

  for (let i = 0; i < 300; i++) {
    t.observe({
      sig: `bulk-${i}`,
      heading: `题目 ${i}`,
      body: `这是第 ${i} 道题的正文内容，用于撑大历史记录。`,
      lang: 'Java',
    });
  }

  rewind(t, 61000);
  const back = t.observe(Q);
  return {
    ok: back.isNew === false && back.notify === false && back.count === 2,
    historySize: t.history.length,
    backIsNew: back.isNew,
    backNotify: back.notify,
    backCount: back.count,
    reasons: back.reasons,
  };
}

async function testRestartPersistence() {
  await mkdir(APP_DIR, { recursive: true });
  await rm(TRACKER_FILE, { force: true });

  // First run: question A notified twice.
  const t1 = new QuestionTracker({ maxNotifications: 2, minReNotifyMs: 60000 });
  const a1 = t1.observe(Q);
  rewind(t1, 61000);
  const a2 = t1.observe(Q_RERENDER);
  await saveTrackerState(t1.toJSON());

  // Second run: load state, see A again.
  const saved = await loadTrackerState();
  const t2 = QuestionTracker.fromJSON(saved, { maxNotifications: 2, minReNotifyMs: 60000 });
  rewind(t2, 61000);
  const a3 = t2.observe(Q);

  // A different question still gets its own quota.
  const b1 = t2.observe(OTHER);

  return {
    ok: a1.notify === true && a2.notify === true && a3.notify === false
        && a3.count === 2 && b1.notify === true && b1.isNew === true,
    firstRun: { a1: a1.notify, a2: a2.notify },
    afterRestart: { a3: a3.notify, a3Count: a3.count, reasons: a3.reasons },
    otherQuestionAfterRestart: { isNew: b1.isNew, notify: b1.notify },
    restoredCount: t2.history.length,
  };
}

async function testCapAndSpacing() {
  const t = new QuestionTracker({ maxNotifications: 2, minReNotifyMs: 60000 });
  const at0 = t.observe(Q);            // 1st
  const at0b = t.observe(Q_RERENDER);  // too soon
  rewind(t, 61000);
  const at61 = t.observe(Q);           // 2nd
  rewind(t, 61000);
  const at122 = t.observe(Q);          // capped

  return {
    ok: at0.notify === true && at0b.notify === false
        && at61.notify === true && at122.notify === false
        && at122.count === 2,
    sequence: [at0.notify, at0b.notify, at61.notify, at122.notify],
    finalCount: at122.count,
    capReasons: at122.reasons,
  };
}

async function testRerenderNeverNotifies() {
  const t = new QuestionTracker({ maxNotifications: 2, minReNotifyMs: 60000 });
  t.observe(Q);
  const results = [];
  for (let i = 0; i < 20; i++) {
    const r = t.observe({ ...Q_RERENDER, sig: `rr-${i}` });
    results.push({ isNew: r.isNew, notify: r.notify });
  }
  return {
    ok: results.every((r) => r.isNew === false && r.notify === false),
    rerenders: results.length,
    anyNotified: results.some((r) => r.notify),
    anyNew: results.some((r) => r.isNew),
  };
}

async function testDistinctQuestionsEachGetOwnQuota() {
  const t = new QuestionTracker({ maxNotifications: 2, minReNotifyMs: 0 });
  const a1 = t.observe(Q);
  const a2 = t.observe(Q_RERENDER);
  const b1 = t.observe(OTHER);
  const b2 = t.observe({ ...OTHER, sig: 'q2b' });
  const a3 = t.observe(Q);
  const b3 = t.observe(OTHER);

  return {
    ok: a1.notify && a2.notify && !a3.notify && b1.notify && b2.notify && !b3.notify,
    a: [a1.notify, a2.notify, a3.notify],
    b: [b1.notify, b2.notify, b3.notify],
    historySize: t.history.length,
  };
}

async function testTrackerFileRoundTrip() {
  await rm(TRACKER_FILE, { force: true });
  const t = new QuestionTracker({ maxNotifications: 2, minReNotifyMs: 45000 });
  t.observe(Q);
  rewind(t, 50000);
  t.observe(Q);
  await saveTrackerState(t.toJSON());

  const raw = await readFile(TRACKER_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  const restored = QuestionTracker.fromJSON(parsed);

  return {
    ok: parsed.version === 2
        && parsed.history.length === 1
        && parsed.history[0].count === 2
        && typeof parsed.history[0].bodyHash === 'string'
        && parsed.history[0].body === undefined      // full body must not be stored
        && restored.maxNotifications === 2
        && restored.minReNotifyMs === 45000
        && restored.history[0].count === 2,
    file: TRACKER_FILE,
    version: parsed.version,
    count: parsed.history[0].count,
    storesBodyHash: typeof parsed.history[0].bodyHash === 'string',
    storesFullBody: parsed.history[0].body !== undefined,
    restoredMinReNotifyMs: restored.minReNotifyMs,
  };
}

const long = await testLongHistory();
const restart = await testRestartPersistence();
const cap = await testCapAndSpacing();
const rerender = await testRerenderNeverNotifies();
const perQuestion = await testDistinctQuestionsEachGetOwnQuota();
const roundTrip = await testTrackerFileRoundTrip();

const ok = long.ok && restart.ok && cap.ok && rerender.ok && perQuestion.ok && roundTrip.ok;
console.log(JSON.stringify({
  ok,
  longHistory: long,
  restartPersistence: restart,
  capAndSpacing: cap,
  rerenderNeverNotifies: rerender,
  perQuestionQuota: perQuestion,
  trackerFileRoundTrip: roundTrip,
}, null, 2));
process.exit(ok ? 0 : 1);
