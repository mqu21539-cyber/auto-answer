// Question queue: watch writes each detected question here so the agent can
// pick it up later, without the watch process having to stay in the loop.
//
// Layout:
//   queue/<sig>.json      the question as detected (full text, lang, samples)
//   queue/<sig>.answered  marker: this signature has been answered

import { mkdir, readdir, readFile, writeFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { APP_DIR } from './chrome.mjs';

export const QUEUE_DIR = path.join(APP_DIR, 'queue');

/** Where the notification tracker persists its counts across restarts. */
export const TRACKER_FILE = process.env.AA_TRACKER_FILE || path.join(APP_DIR, 'tracker.json');

/** Load persisted tracker state, or null when there is none yet. */
export async function loadTrackerState() {
  try {
    return JSON.parse(await readFile(TRACKER_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** Persist tracker state. Failures are non-fatal: worst case a restart re-notifies. */
export async function saveTrackerState(state) {
  try {
    await mkdir(APP_DIR, { recursive: true });
    await writeFile(TRACKER_FILE, JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

async function ensureDir() {
  await mkdir(QUEUE_DIR, { recursive: true });
}

/** Persist a detected question. Overwrites a previous detection of the same sig. */
export async function enqueue(question) {
  await ensureDir();
  const record = {
    sig: question.sig,
    url: question.url,
    title: question.title,
    heading: question.heading,
    body: question.body,
    bodyLength: question.bodyLength,
    samples: question.samples ?? [],
    samplePairs: question.samplePairs ?? [],
    lang: question.lang,
    langOptions: question.langOptions ?? [],
    editorKind: question.editorKind,
    detectedAt: new Date().toISOString(),
  };
  await writeFile(path.join(QUEUE_DIR, `${question.sig}.json`), JSON.stringify(record, null, 2), 'utf8');
  return record;
}

/** Mark a signature as answered so `pending` stops reporting it. */
export async function markAnswered(sig) {
  await ensureDir();
  await writeFile(
    path.join(QUEUE_DIR, `${sig}.answered`),
    JSON.stringify({ sig, answeredAt: new Date().toISOString() }),
    'utf8',
  );
}

/** All queued questions, newest first. */
export async function listQueue() {
  await ensureDir();
  let names;
  try {
    names = await readdir(QUEUE_DIR);
  } catch {
    return [];
  }

  const items = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const sig = name.slice(0, -5);
    const file = path.join(QUEUE_DIR, name);
    try {
      const raw = await readFile(file, 'utf8');
      const q = JSON.parse(raw);
      const answered = await stat(path.join(QUEUE_DIR, `${sig}.answered`)).then(() => true).catch(() => false);
      const st = await stat(file);
      items.push({ ...q, answered, queuedAt: st.mtimeMs });
    } catch {
      // A half-written file is skipped rather than crashing the listing.
    }
  }
  items.sort((a, b) => b.queuedAt - a.queuedAt);
  return items;
}

/** Newest question that has not been answered yet. */
export async function newestPending() {
  const all = await listQueue();
  return all.find((q) => !q.answered) ?? null;
}

/** Remove every queue entry (used by tests and by `queue --clear`). */
export async function clearQueue() {
  await ensureDir();
  const names = await readdir(QUEUE_DIR).catch(() => []);
  for (const n of names) {
    await unlink(path.join(QUEUE_DIR, n)).catch(() => {});
  }
}
