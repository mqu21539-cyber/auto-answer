// Question identity: decide whether a detection is the SAME question we already
// saw, a slightly-changed render of it, or genuinely a new question.
//
// The signature (`sig`) is exact and cheap, but it is also brittle: OJ pages
// re-render constantly (timers, counters, "通过率 32.90%" ticking, lazy-loaded
// sections). An exact-hash-only check would either miss real switches or fire a
// toast on every cosmetic re-render.
//
// So identity is decided in two tiers:
//
//   1. Exact signature match           -> definitely the same question.
//   2. Fuzzy similarity above a cutoff -> same question, content shifted
//                                         (e.g. a counter changed, a section
//                                         finished loading).
//   Otherwise                          -> a new question.

import { normalize } from './editor.mjs';

/** Text that must be ignored when comparing questions. */
const NOISE_PATTERNS = [
  /通过率[:：]?\s*[\d.]+%?/g,
  /正确率[:：]?\s*[\d.]+%?/g,
  /耗时[:：]?\s*[\d.]+\s*(ms|s|秒|毫秒)?/g,
  /\d+\s*次(提交|运行|尝试)/g,
  /剩余时间[:：]?\s*[\d:]+\s*(小时|分钟|秒)?/g,
  /已用时间[:：]?\s*[\d:]+\s*(小时|分钟|秒)?/g,
  /\d{1,2}:\d{2}:\d{2}/g,
  /难度[:：]?\s*(简单|中等|困难)/g,
];

/** Collapse a question's text into a comparable canonical form. */
export function canonicalText(text) {
  let s = String(text ?? '');
  for (const re of NOISE_PATTERNS) s = s.replace(re, ' ');
  return normalize(s)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Split into shingles (n-gram character windows) for Jaccard similarity. */
function shingles(text, n = 4) {
  const s = canonicalText(text).replace(/\s+/g, '');
  const out = new Set();
  if (s.length <= n) {
    if (s) out.add(s);
    return out;
  }
  for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
  return out;
}

/**
 * Jaccard similarity of two texts, 0..1.
 * Cheap enough to run on every detection (a few thousand shingles).
 */
export function similarity(a, b) {
  const A = shingles(a);
  const B = shingles(b);
  if (!A.size && !B.size) return 1;
  if (!A.size || !B.size) return 0;

  let inter = 0;
  const [small, large] = A.size <= B.size ? [A, B] : [B, A];
  for (const s of small) if (large.has(s)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Stable 32-bit fingerprint of a question body, used when the full text is not
 * stored (see toJSON). Not cryptographic — just enough to tell bodies apart.
 */
export function bodyHash(text) {
  const s = canonicalText(text);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Compare a new detection against the previously accepted question.
 *
 * @param {object} prev  previous accepted record { sig, heading, body, samples, lang }
 * @param {object} next  new detection
 * @returns {{same:boolean, score:number, reasons:string[]}}
 */
export function compareQuestions(prev, next) {
  if (!prev) return { same: false, score: 0, reasons: ['no-previous'] };

  const reasons = [];

  // Exact signature is conclusive.
  if (prev.sig && next.sig && prev.sig === next.sig) {
    return { same: true, score: 1, reasons: ['sig-match'] };
  }

  const headingA = canonicalText(prev.heading ?? '');
  const headingB = canonicalText(next.heading ?? '');
  const bodyA = canonicalText(prev.body ?? '');
  const bodyB = canonicalText(next.body ?? '');

  // A different heading with real content is the strongest signal of a switch.
  const headingSame = headingA === headingB;
  const headingScore = similarity(headingA, headingB);
  const bodyScore = similarity(bodyA, bodyB);

  if (headingA && headingB && headingSame) reasons.push('heading-identical');
  else if (headingA && headingB) reasons.push(`heading-sim=${headingScore.toFixed(2)}`);

  reasons.push(`body-sim=${bodyScore.toFixed(2)}`);

  // Language differences alone do not make it a new question: the same problem
  // is often shown with a different default language.
  const langSame = !prev.lang || !next.lang
    || canonicalText(prev.lang) === canonicalText(next.lang);
  if (!langSame) reasons.push('lang-differs');

  // An identical heading is the platform's own label for the question. OJ
  // headings are unique per problem, so this alone identifies it — the body
  // score is unreliable here because the extracted region may include or omit
  // surrounding chrome (breadcrumbs, meta rows, samples) between renders.
  if (headingA && headingSame) {
    return { same: true, score: Math.max(bodyScore, 0.9), reasons };
  }

  // A restored record has no body text, only a hash. If the new body hashes to
  // the same value, it is the same question.
  if (prev.bodyHash && next.bodyHash && prev.bodyHash === next.bodyHash) {
    reasons.push('body-hash-match');
    return { same: true, score: 1, reasons };
  }

  // Same heading + very similar body => same question.
  if (headingSame && bodyScore >= 0.85) {
    return { same: true, score: bodyScore, reasons };
  }

  // Near-identical heading (typo/timer in the title) + similar body.
  if (headingScore >= 0.9 && bodyScore >= 0.8) {
    return { same: true, score: Math.min(headingScore, bodyScore), reasons };
  }

  // Body barely changed even though the heading did: some OJs rewrite the
  // heading with a prefix while keeping the statement.
  if (bodyScore >= 0.93) {
    return { same: true, score: bodyScore, reasons };
  }

  return { same: false, score: bodyScore, reasons };
}

/**
 * Tracks accepted questions and enforces a per-question notification cap.
 *
 * Policy: one question may notify at most `maxNotifications` times. The first
 * detection notifies; a later *re-detection* of the same question may notify
 * once more (e.g. the operator switched away and came back), but never a third
 * time.
 */
export class QuestionTracker {
  constructor({ maxNotifications = 2, historyLimit = 2000, minReNotifyMs = 60000 } = {}) {
    this.maxNotifications = maxNotifications;
    // History is NOT trimmed for correctness: dropping an old record would make
    // that question look new again and hand it a fresh notification quota.
    // 2000 records is a few hundred KB at most, so keep them all.
    this.historyLimit = historyLimit;
    // Two notifications for the same question must be at least a minute apart.
    // A burst of re-renders therefore yields at most one toast.
    this.minReNotifyMs = minReNotifyMs;
    /** @type {Map<string, object>} */
    this.byKey = new Map();
    /** @type {Array<object>} */
    this.history = [];
  }

  /**
   * Serialize state so notification counts survive a watch restart.
   *
   * Only a hash of the body is stored: the full text is large (several KB per
   * question), may contain characters that make the file awkward to inspect,
   * and is not needed for identity — the heading plus a body fingerprint is
   * enough to recognise a question across restarts.
   */
  toJSON() {
    return {
      version: 2,
      maxNotifications: this.maxNotifications,
      minReNotifyMs: this.minReNotifyMs,
      history: this.history.map((r) => ({
        sig: r.sig,
        heading: r.heading,
        bodyHash: bodyHash(r.body ?? ''),
        bodyLength: (r.body ?? '').length,
        lang: r.lang,
        count: r.count,
        observations: r.observations,
        firstSeen: r.firstSeen,
        lastNotifyAt: r.lastNotifyAt,
      })),
    };
  }

  /** Restore state saved by toJSON(). Tolerates a missing/corrupt file. */
  static fromJSON(data, { maxNotifications, minReNotifyMs } = {}) {
    const t = new QuestionTracker({
      maxNotifications: maxNotifications ?? data?.maxNotifications ?? 2,
      minReNotifyMs: minReNotifyMs ?? data?.minReNotifyMs ?? 60000,
    });
    for (const r of data?.history ?? []) {
      if (!r || typeof r.sig !== 'string') continue;
      t.history.push({
        sig: r.sig,
        heading: r.heading ?? '',
        // The body is not stored; identity falls back to the heading, which is
        // the platform's own per-question label.
        body: '',
        bodyHash: r.bodyHash ?? '',
        bodyLength: r.bodyLength ?? 0,
        lang: r.lang ?? '',
        count: r.count ?? 0,
        observations: r.observations ?? 1,
        firstSeen: r.firstSeen ?? Date.now(),
        lastNotifyAt: r.lastNotifyAt ?? 0,
      });
      t.byKey.set(r.sig, t.history[t.history.length - 1]);
    }
    return t;
  }

  /**
   * Look up the tracked record for a detection, if it is a question we know.
   * Returns the record and whether it is a re-detection.
   */
  find(q) {
    // Fast path: exact signature.
    for (const rec of this.history) {
      if (rec.sig === q.sig) return rec;
    }
    // Slow path: fuzzy match against recent history.
    for (let i = this.history.length - 1; i >= 0; i--) {
      const rec = this.history[i];
      const cmp = compareQuestions(rec, q);
      if (cmp.same) return rec;
    }
    return null;
  }

  /**
   * Register a detection and decide whether a notification is allowed.
   *
   * @returns {{isNew:boolean, notify:boolean, count:number, score:number, reasons:string[], sig:string}}
   */
  observe(q) {
    const existing = this.find(q);
    const now = Date.now();

    if (existing) {
      // `count` tracks *notifications actually sent*, not observations. An
      // observation suppressed by the spacing window must not consume one of
      // the two allowed notifications.
      const underCap = existing.count < this.maxNotifications;
      const spacedOut = !existing.lastNotifyAt
        || now - existing.lastNotifyAt >= this.minReNotifyMs;
      const notify = underCap && spacedOut;

      if (notify) {
        existing.count += 1;
        existing.lastNotifyAt = now;
      }

      // Adopt the newest signature so later exact matches stay cheap.
      if (existing.sig !== q.sig) existing.sig = q.sig;

      return {
        isNew: false,
        notify,
        count: existing.count,
        observations: (existing.observations ?? 1) + 1,
        score: 1,
        reasons: [
          'same-question',
          ...(underCap ? [] : ['cap-reached']),
          ...(spacedOut ? [] : ['too-soon']),
        ],
        sig: q.sig,
      };
    }

    const rec = {
      sig: q.sig,
      heading: q.heading ?? '',
      body: q.body ?? '',
      lang: q.lang ?? '',
      count: this.maxNotifications >= 1 ? 1 : 0,
      observations: 1,
      firstSeen: now,
      lastNotifyAt: this.maxNotifications >= 1 ? now : 0,
    };
    this.history.push(rec);
    // Trim only beyond a very high ceiling, and never for correctness: a dropped
    // record would reset that question's notification quota.
    if (this.history.length > this.historyLimit) this.history.shift();
    this.byKey.set(rec.sig, rec);

    return {
      isNew: true,
      notify: this.maxNotifications >= 1,
      count: rec.count,
      observations: 1,
      score: 0,
      reasons: ['new-question'],
      sig: q.sig,
    };
  }

  /** Remaining notifications allowed for a signature (for diagnostics). */
  remaining(sig) {
    const rec = this.history.find((r) => r.sig === sig);
    if (!rec) return this.maxNotifications;
    return Math.max(0, this.maxNotifications - rec.count);
  }

  /** Summary of everything seen, for the `status`/`queue` output. */
  summary() {
    return this.history.map((r) => ({
      sig: r.sig,
      heading: r.heading,
      lang: r.lang,
      notifications: r.count,
      firstSeen: r.firstSeen,
    }));
  }
}
