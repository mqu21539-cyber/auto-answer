// Unit tests for question identity + the notification cap.

import { QuestionTracker, compareQuestions, similarity, canonicalText } from './lib/identity.mjs';

const Q_MERGE = {
  sig: 'aaa111',
  heading: '合并两个排序的链表',
  body: '输入两个递增的链表，单个链表的长度为 n，合并这两个链表并使新链表中的节点仍然是递增排序的。数据范围：0 ≤ n ≤ 1000，-1000 ≤ 节点值 ≤ 1000。要求：空间复杂度 O(1)，时间复杂度 O(n)。',
  lang: 'Java',
};

const Q_REVERSE = {
  sig: 'bbb222',
  heading: '反转链表',
  body: '给定一个单链表的头结点 pHead，长度为 n，反转该链表后，返回新链表的表头。数据范围：0 ≤ n ≤ 1000。要求：空间复杂度 O(1)，时间复杂度 O(n)。',
  lang: 'Java',
};

const Q_DEPTH = {
  sig: 'ccc333',
  heading: '二叉树的最大深度',
  body: '输入一棵二叉树的根节点 root，返回该树的最大深度。深度指从根节点到叶子节点的最长路径上的节点数。数据范围：节点数 0 ≤ n ≤ 100000。',
  lang: 'C++17 (GCC 9.2)',
};

// The same question after a cosmetic re-render: pass-rate changed, a timer ticked.
const Q_MERGE_RERENDER = {
  sig: 'ddd444',           // different exact signature
  heading: '合并两个排序的链表',
  body: '输入两个递增的链表，单个链表的长度为 n，合并这两个链表并使新链表中的节点仍然是递增排序的。数据范围：0 ≤ n ≤ 1000，-1000 ≤ 节点值 ≤ 1000。要求：空间复杂度 O(1)，时间复杂度 O(n)。 通过率：45.12% 耗时：120ms',
  lang: 'Java',
};

// Same question but the operator switched language.
const Q_MERGE_PY = {
  sig: 'eee555',
  heading: '合并两个排序的链表',
  body: Q_MERGE.body,
  lang: 'Python 3',
};

function testCanonical() {
  const a = canonicalText('通过率：32.90%  耗时 120ms\n\n题目正文');
  const b = canonicalText('通过率：99.99% 耗时 5ms 题目正文');
  return {
    ok: !a.includes('32.90') && !a.includes('120ms') && !b.includes('99.99'),
    a, b,
  };
}

function testSimilarity() {
  const same = similarity(Q_MERGE.body, Q_MERGE_RERENDER.body);
  const diff = similarity(Q_MERGE.body, Q_DEPTH.body);
  return {
    ok: same > 0.9 && diff < 0.3,
    rerenderSimilarity: Number(same.toFixed(3)),
    differentSimilarity: Number(diff.toFixed(3)),
  };
}

function testCompare() {
  const sameAfterRerender = compareQuestions(Q_MERGE, Q_MERGE_RERENDER);
  const switched = compareQuestions(Q_MERGE, Q_REVERSE);
  const switched2 = compareQuestions(Q_MERGE, Q_DEPTH);
  const langOnly = compareQuestions(Q_MERGE, Q_MERGE_PY);

  return {
    ok: sameAfterRerender.same === true
        && switched.same === false
        && switched2.same === false
        && langOnly.same === true,
    rerender: sameAfterRerender,
    reverse: switched,
    depth: switched2,
    langSwitch: langOnly,
  };
}

function testTrackerCap() {
  const t = new QuestionTracker({ maxNotifications: 2, minReNotifyMs: 0 });
  const events = [];

  // First sighting of question A -> notify.
  let r = t.observe(Q_MERGE);
  events.push({ step: 'A-first', ...r });

  // Same question re-rendered 5 times -> must stop notifying after the 2nd.
  for (let i = 0; i < 5; i++) {
    r = t.observe({ ...Q_MERGE_RERENDER, sig: `rerender${i}` });
    events.push({ step: `A-rerender-${i}`, ...r });
  }

  // Genuine switch to B -> notify.
  r = t.observe(Q_REVERSE);
  events.push({ step: 'B-first', ...r });

  // Switch back to A -> this is the 2nd notification for A (allowed), then capped.
  r = t.observe(Q_MERGE);
  events.push({ step: 'A-back', ...r });

  r = t.observe({ ...Q_MERGE, sig: 'aaa999' });
  events.push({ step: 'A-back-again', ...r });

  const aNotifications = events.filter((e) => e.step.startsWith('A') && e.notify).length;
  const bNotifications = events.filter((e) => e.step.startsWith('B') && e.notify).length;

  return {
    ok: aNotifications === 2 && bNotifications === 1,
    aNotifications,
    bNotifications,
    events: events.map((e) => ({
      step: e.step,
      isNew: e.isNew,
      notify: e.notify,
      count: e.count,
    })),
  };
}

function testDistinctQuestionsNotMerged() {
  // Two questions that share boilerplate ("数据范围", "时间复杂度") must not merge.
  const t = new QuestionTracker({ maxNotifications: 2 });
  const r1 = t.observe(Q_MERGE);
  const r2 = t.observe(Q_REVERSE);
  const r3 = t.observe(Q_DEPTH);
  return {
    ok: r1.isNew && r2.isNew && r3.isNew && r2.notify && r3.notify,
    r1: { isNew: r1.isNew },
    r2: { isNew: r2.isNew },
    r3: { isNew: r3.isNew },
    historySize: t.history.length,
  };
}

function testSingleNotificationMode() {
  const t = new QuestionTracker({ maxNotifications: 1, minReNotifyMs: 0 });
  const a = t.observe(Q_MERGE);
  const b = t.observe({ ...Q_MERGE_RERENDER, sig: 'x' });
  return {
    ok: a.notify === true && b.notify === false,
    first: a.notify,
    second: b.notify,
  };
}

function testBurstSuppression() {
  // Two re-renders inside the same second must yield at most one notification,
  // because re-notification requires a full minute.
  const t = new QuestionTracker({ maxNotifications: 2 });
  const a = t.observe(Q_MERGE);
  const b = t.observe({ ...Q_MERGE_RERENDER, sig: 'r1' });
  const c = t.observe({ ...Q_MERGE_RERENDER, sig: 'r2' });
  return {
    ok: a.notify === true && b.notify === false && c.notify === false,
    defaultMinReNotifyMs: t.minReNotifyMs,
    first: a.notify,
    burstSecond: b.notify,
    burstThird: c.notify,
    reasonsThird: c.reasons,
  };
}

function testOneMinuteSpacing() {
  // Simulate the passage of time: the 2nd notification is allowed only after
  // the spacing window, and never a 3rd.
  const t = new QuestionTracker({ maxNotifications: 2, minReNotifyMs: 60000 });
  const a = t.observe(Q_MERGE);

  // 30s later: still too soon.
  const rec = t.history[0];
  rec.lastNotifyAt = Date.now() - 30000;
  const b = t.observe({ ...Q_MERGE, sig: 'later30' });

  // 61s later: allowed (this is the 2nd).
  rec.lastNotifyAt = Date.now() - 61000;
  const c = t.observe({ ...Q_MERGE, sig: 'later61' });

  // 61s later again: cap reached, must stay silent.
  rec.lastNotifyAt = Date.now() - 61000;
  const d = t.observe({ ...Q_MERGE, sig: 'later122' });

  return {
    ok: a.notify === true && b.notify === false && c.notify === true && d.notify === false,
    at0s: a.notify,
    at30s: b.notify,
    at61s: c.notify,
    at122s: d.notify,
    capReason: d.reasons,
  };
}

const canonical = testCanonical();
const sim = testSimilarity();
const cmp = testCompare();
const cap = testTrackerCap();
const distinct = testDistinctQuestionsNotMerged();
const single = testSingleNotificationMode();
const burst = testBurstSuppression();
const spacing = testOneMinuteSpacing();

const ok = canonical.ok && sim.ok && cmp.ok && cap.ok && distinct.ok && single.ok
        && burst.ok && spacing.ok;
console.log(JSON.stringify({
  ok,
  canonical,
  similarity: sim,
  compare: cmp,
  cap,
  distinct,
  singleNotification: single,
  burstSuppression: burst,
  oneMinuteSpacing: spacing,
}, null, 2));
process.exit(ok ? 0 : 1);
