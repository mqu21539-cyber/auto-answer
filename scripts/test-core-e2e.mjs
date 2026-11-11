// End-to-end core-code mode: against a mock OJ page whose editor already holds
// a class scaffold, the answer must be spliced into the method body, the
// scaffold must survive, and the result must round-trip through the editor.

import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { ensureChrome, attachPage, stopChrome } from './lib/chrome.mjs';
import { writeCode, readEditor, normalize } from './lib/editor.mjs';
import { mergeSolution, analyzeStub } from './lib/stub.mjs';
import { switchLanguage } from './lib/langswitch.mjs';
import { extractQuestion } from './lib/extract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK = path.resolve(HERE, '..', 'assets', 'mock-core.html');

const JAVA_ANSWER = `ListNode dummy = new ListNode(-1);
ListNode cur = dummy;
while (pHead1 != null && pHead2 != null) {
    if (pHead1.val <= pHead2.val) {
        cur.next = pHead1;
        pHead1 = pHead1.next;
    } else {
        cur.next = pHead2;
        pHead2 = pHead2.next;
    }
    cur = cur.next;
}
cur.next = (pHead1 != null) ? pHead1 : pHead2;
return dummy.next;`;

const PY_ANSWER = `if not pHead1:
    return pHead2
if not pHead2:
    return pHead1
if pHead1.val <= pHead2.val:
    pHead1.next = self.Merge(pHead1.next, pHead2)
    return pHead1
pHead2.next = self.Merge(pHead1, pHead2.next)
return pHead2`;

const balance = (s) => {
  let d = 0;
  for (const ch of s) { if (ch === '{') d++; if (ch === '}') d--; }
  return d;
};

async function main() {
  const info = await ensureChrome({ headless: true });
  const { cdp } = await attachPage({ port: info.port, url: pathToFileURL(MOCK).href, timeoutMs: 20000 });

  const results = [];
  try {
    await new Promise((r) => setTimeout(r, 2800));

    const q = await extractQuestion(cdp);

    // --- Java: splice into Merge()
    {
      const stub = await readEditor(cdp);
      const stubText = stub?.text ?? '';
      const merged = mergeSolution(stubText, JAVA_ANSWER, 'java');

      const write = await writeCode(cdp, merged.code, { retries: 3 });
      const back = await readEditor(cdp);
      const actual = back?.text ?? '';

      results.push({
        lang: 'java',
        ok: write.ok
            && normalize(actual) === normalize(merged.code)
            && actual.includes('public class Solution')
            && actual.includes('public ListNode Merge (ListNode pHead1, ListNode pHead2)')
            && actual.includes('ListNode dummy = new ListNode(-1)')
            && !actual.includes('write code here')
            && balance(actual) === 0,
        mode: merged.mode,
        spliced: merged.spliced,
        header: merged.header,
        stubKept: actual.includes('public class Solution'),
        markerGone: !actual.includes('write code here'),
        braceBalance: balance(actual),
        roundTrip: normalize(actual) === normalize(merged.code),
      });
    }

    // --- Switch to Python; the page resets the scaffold; splice there too.
    {
      const sw = await switchLanguage(cdp, 'python');
      const stub = await readEditor(cdp);
      const stubText = stub?.text ?? '';
      const merged = mergeSolution(stubText, PY_ANSWER, 'python');

      const write = await writeCode(cdp, merged.code, { retries: 3 });
      const back = await readEditor(cdp);
      const actual = back?.text ?? '';

      results.push({
        lang: 'python',
        ok: sw.ok
            && write.ok
            && normalize(actual) === normalize(merged.code)
            && actual.includes('class Solution:')
            && actual.includes('def Merge(self, pHead1, pHead2):')
            && actual.includes('if not pHead1:')
            && !actual.includes('write code here'),
        switched: sw.ok,
        mode: merged.mode,
        spliced: merged.spliced,
        roundTrip: normalize(actual) === normalize(merged.code),
        bodyIndented: /^        if not pHead1:/m.test(actual),
      });
    }

    return {
      ok: results.every((r) => r.ok),
      question: { heading: q.heading, editorKind: q.editorKind, lang: q.lang },
      results,
    };
  } finally {
    cdp.close();
    await stopChrome();
  }
}

main().then((r) => {
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}).catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message, stack: e.stack }, null, 2));
  process.exit(1);
});
