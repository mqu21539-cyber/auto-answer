// Core-code mode tests, built from the real scaffold seen in a LeetCode-style
// Java editor plus equivalents for the other supported languages.

import { analyzeStub, mergeSolution, stubSummary } from './lib/stub.mjs';
import { normalize } from './lib/editor.mjs';

const JAVA_STUB = `import java.util.*;

/*
 * public class ListNode {
 *     int val;
 *     ListNode next = null;
 *     public ListNode(int val) {
 *         this.val = val;
 *     }
 * }
 */

public class Solution {
    /**
     * 代码中的类名、方法名、参数名已经指定，请勿修改，直接返回方法规定的值即可
     *
     * @param pHead1 ListNode类
     * @param pHead2 ListNode类
     * @return ListNode类
     */
    public ListNode Merge (ListNode pHead1, ListNode pHead2) {
        // write code here
    }
}`;

const CPP_STUB = `#include <bits/stdc++.h>
using namespace std;

class Solution {
public:
    /**
     * @param pHead1 ListNode类
     * @param pHead2 ListNode类
     * @return ListNode类
     */
    ListNode* Merge(ListNode* pHead1, ListNode* pHead2) {
        // write code here
    }
};`;

const PY_STUB = `class Solution:
    def Merge(self, pHead1, pHead2):
        # write code here
        pass`;

const GO_STUB = `package main

type ListNode struct {
    Val  int
    Next *ListNode
}

func Merge(pHead1 *ListNode, pHead2 *ListNode) *ListNode {
    // write code here
}`;

const JS_STUB = `/*
 * function ListNode(x){
 *   this.val = x;
 *   this.next = null;
 * }
 */
function Merge(pHead1, pHead2) {
    // write code here
}`;

const ACM_STUB = ``;

const CASES = [
  {
    name: 'java-leetcode-scaffold',
    lang: 'java',
    stub: JAVA_STUB,
    wantMode: 'core',
    wantHeaderHas: 'Merge',
  },
  {
    name: 'cpp-scaffold',
    lang: 'cpp',
    stub: CPP_STUB,
    wantMode: 'core',
    wantHeaderHas: 'Merge',
  },
  {
    name: 'python-scaffold',
    lang: 'python',
    stub: PY_STUB,
    wantMode: 'core',
    wantHeaderHas: 'def Merge',
  },
  {
    name: 'go-scaffold',
    lang: 'go',
    stub: GO_STUB,
    wantMode: 'core',
    wantHeaderHas: 'func Merge',
  },
  {
    name: 'js-scaffold',
    lang: 'javascript',
    stub: JS_STUB,
    wantMode: 'core',
    wantHeaderHas: 'function Merge',
  },
  {
    name: 'empty-editor',
    lang: 'python',
    stub: ACM_STUB,
    wantMode: 'acm',
  },
  {
    name: 'acm-program',
    lang: 'cpp',
    stub: '#include <bits/stdc++.h>\nint main() {\n    return 0;\n}\n',
    wantMode: 'acm',
  },
];

// What an agent writes for the Java scaffold: just the method body.
const JAVA_BODY = `ListNode dummy = new ListNode(-1);
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

const PY_BODY = `if not pHead1:
    return pHead2
if not pHead2:
    return pHead1
if pHead1.val <= pHead2.val:
    pHead1.next = self.Merge(pHead1.next, pHead2)
    return pHead1
pHead2.next = self.Merge(pHead1, pHead2.next)
return pHead2`;

function runCase(c) {
  const analysis = analyzeStub(c.stub, c.lang);
  const okMode = analysis.mode === c.wantMode;
  const okHeader = c.wantHeaderHas
    ? String(analysis.header ?? '').includes(c.wantHeaderHas)
    : true;
  return {
    name: c.name,
    lang: c.lang,
    mode: analysis.mode,
    reason: analysis.reason,
    header: analysis.header ?? null,
    okMode,
    okHeader,
    ok: okMode && okHeader,
  };
}

function runMerge() {
  // Java: splice the body in; the class scaffold must survive untouched.
  const java = mergeSolution(JAVA_STUB, JAVA_BODY, 'java');
  const javaOk = java.spliced
    && java.code.includes('public class Solution')
    && java.code.includes('public ListNode Merge (ListNode pHead1, ListNode pHead2)')
    && java.code.includes('ListNode dummy = new ListNode(-1)')
    && java.code.includes('return dummy.next;')
    && !java.code.includes('write code here')
    // The ListNode comment block must be preserved verbatim.
    && java.code.includes('public ListNode(int val)');

  // Braces must still balance.
  const balance = (s) => {
    let d = 0;
    for (const ch of s) { if (ch === '{') d++; if (ch === '}') d--; }
    return d;
  };

  // Python: indentation-based splice, method must keep 4-space body.
  const py = mergeSolution(PY_STUB, PY_BODY, 'python');
  const pyOk = py.spliced
    && py.code.includes('class Solution:')
    && py.code.includes('    def Merge(self, pHead1, pHead2):')
    && /^        if not pHead1:/m.test(py.code)
    && !py.code.includes('write code here');

  // An answer that is a whole method (agent over-wrote) must be reduced to its body.
  const fullMethod = `public ListNode Merge(ListNode pHead1, ListNode pHead2) {
    return pHead1;
}`;
  const reduced = mergeSolution(JAVA_STUB, fullMethod, 'java');

  // ACM: the whole solution replaces the editor.
  const acm = mergeSolution('', '#include <bits/stdc++.h>\nint main(){}\n', 'cpp');

  return {
    java: { ok: javaOk, mode: java.mode, spliced: java.spliced, braceBalance: balance(java.code) },
    python: { ok: pyOk, mode: py.mode, spliced: py.spliced },
    reduceWholeMethod: {
      ok: reduced.spliced && !reduced.code.includes('public ListNode Merge(ListNode pHead1, ListNode pHead2) {\n    return pHead1;\n}'),
      mode: reduced.mode,
    },
    acm: { ok: acm.mode === 'acm' && !acm.spliced, mode: acm.mode },
  };
}

function main() {
  const cases = CASES.map(runCase);
  const merge = runMerge();
  const ok = cases.every((c) => c.ok)
    && merge.java.ok && merge.python.ok && merge.reduceWholeMethod.ok && merge.acm.ok;
  return { ok, cases, merge };
}

const result = main();
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
