// Multi-site extraction test: the same code must recognise questions from
// different OJ platforms without a per-site adapter.
//
// Uses live pages when the network is available; each site is judged on the
// same contract: a heading, a statement, and an editor.

import { ensureChrome, attachPage, stopChrome } from './lib/chrome.mjs';
import { extractQuestion } from './lib/extract.mjs';
import { classifyPage } from './lib/classify.mjs';
import { readEditor } from './lib/editor.mjs';

const SITES = [
  {
    name: 'nowcoder',
    url: 'https://www.nowcoder.com/practice/886370fe658f41b498d40fb34ae76ff9?tpId=295&tqId=1377477',
    expectHeading: /链表/,
  },
  {
    name: 'leetcode-cn',
    url: 'https://leetcode.cn/problems/merge-two-sorted-lists/',
    expectHeading: /合并|Merge/i,
  },
];

async function probeSite(port, site) {
  const { cdp } = await attachPage({ port, url: site.url, timeoutMs: 40000 });
  // Give the SPA time to render its statement and editor.
  await new Promise((r) => setTimeout(r, 4000));

  const q = await extractQuestion(cdp);
  const cls = classifyPage(q);
  const editor = await readEditor(cdp).catch(() => null);

  const result = {
    name: site.name,
    url: site.url,
    finalUrl: q.url,
    heading: q.heading,
    headingMatches: site.expectHeading.test(q.heading ?? ''),
    bodyChars: q.bodyLength,
    samples: q.samples?.length ?? 0,
    lang: q.lang,
    editorKind: q.editorKind,
    editorChars: editor?.text?.length ?? 0,
    isQuestion: cls.isQuestion,
    score: cls.score,
    signals: cls.signals,
    reason: cls.reason ?? null,
  };

  cdp.close();
  return result;
}

const info = await ensureChrome({ headless: true });
const results = [];

for (const site of SITES) {
  try {
    results.push(await probeSite(info.port, site));
  } catch (err) {
    results.push({ name: site.name, url: site.url, error: err.message });
  }
}

await stopChrome().catch(() => {});

const ok = results.every((r) => !r.error && r.isQuestion === true && r.headingMatches
  && r.bodyChars > 100 && Boolean(r.editorKind));

console.log(JSON.stringify({ ok, results }, null, 2));
process.exit(ok ? 0 : 1);
