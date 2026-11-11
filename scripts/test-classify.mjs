// Page classification tests: real questions must pass, ordinary pages must not.

import { classifyPage } from './lib/classify.mjs';

const cases = [
  {
    name: 'leetcode-style core code',
    want: true,
    q: {
      heading: '合并两个排序的链表',
      body: `合并两个排序的链表
知识点：链表 | 通过率 32.90% | 时间限制 1s | 空间限制 256M
描述
输入两个递增的链表，单个链表的长度为 n，合并这两个链表并使新链表中的节点仍然是递增排序的。
数据范围：0 ≤ n ≤ 1000，-1000 ≤ 节点值 ≤ 1000
要求：空间复杂度 O(1)，时间复杂度 O(n)
示例1
输入：{1,3,5}, {2,4,6}
返回值：{1,2,3,4,5,6}`,
      editorKind: 'monaco',
      samples: [{ kind: 'input', content: '1 2' }],
      samplePairs: [{ input: '1 2', output: '3' }],
      loggedOutHint: false,
    },
  },
  {
    name: 'acm style with samples',
    want: true,
    q: {
      heading: 'A + B Problem',
      body: `给定两个整数 A 和 B，输出它们的和。
输入格式：一行两个整数 A、B。
输出格式：一行一个整数，表示 A + B。
样例输入：
1 2
样例输出：
3
限制：时间限制 1s，内存限制 256MB。`,
      editorKind: 'textarea',
      samples: [{ kind: 'input', content: '1 2' }, { kind: 'output', content: '3' }],
      samplePairs: [{ input: '1 2', output: '3' }],
      loggedOutHint: false,
    },
  },
  {
    name: 'problem list page',
    want: false,
    q: {
      heading: '题库',
      body: `题库
全部题目
1. 两数之和 简单 通过率 45%
2. 反转链表 简单 通过率 38%
3. 二叉树的最大深度 中等 通过率 29%
搜索  筛选  排序方式`,
      editorKind: 'textarea',      // a search box
      samples: [],
      samplePairs: [],
      loggedOutHint: false,
    },
  },
  {
    name: 'submission records',
    want: false,
    q: {
      heading: '提交记录',
      body: `提交记录
时间  题目  结果  耗时
2026-10-22 10:01  两数之和  通过  12ms
2026-10-22 09:58  反转链表  解答错误  8ms`,
      editorKind: 'textarea',
      samples: [],
      samplePairs: [],
      loggedOutHint: false,
    },
  },
  {
    name: 'profile page',
    want: false,
    q: {
      heading: '个人中心',
      body: `个人中心
昵称：pc
已解决题目：128
排名：1024
我的主页  提交记录  历史记录`,
      editorKind: null,
      samples: [],
      samplePairs: [],
      loggedOutHint: false,
    },
  },
  {
    name: 'login page',
    want: false,
    q: {
      heading: '登录',
      body: '欢迎回来，请登录你的账号以继续。用户名 密码 忘记密码 注册',
      editorKind: 'textarea',
      samples: [],
      samplePairs: [],
      loggedOutHint: true,
    },
  },
  {
    name: 'home page with a comment box',
    want: false,
    q: {
      heading: '首页',
      body: '欢迎来到本站。这里是一个面向程序员的在线学习社区，提供课程、讨论区和练习。写下你的想法……',
      editorKind: 'contenteditable',
      samples: [],
      samplePairs: [],
      loggedOutHint: false,
    },
  },
  {
    name: 'dialog with short text',
    want: false,
    q: {
      heading: '提示',
      body: '确认提交？',
      editorKind: 'textarea',
      samples: [],
      samplePairs: [],
      loggedOutHint: false,
    },
  },
  {
    name: 'question page without editor yet',
    want: false,
    q: {
      heading: '合并两个排序的链表',
      body: '输入两个递增的链表，合并这两个链表并使新链表中的节点仍然是递增排序的。数据范围：0 ≤ n ≤ 1000。',
      editorKind: null,
      samples: [],
      samplePairs: [],
      loggedOutHint: false,
    },
  },
  {
    name: 'empty page',
    want: false,
    q: {
      heading: '',
      body: '',
      editorKind: null,
      samples: [],
      samplePairs: [],
      loggedOutHint: false,
    },
  },
];

const results = cases.map((c) => {
  const r = classifyPage(c.q);
  return {
    name: c.name,
    want: c.want,
    got: r.isQuestion,
    ok: r.isQuestion === c.want,
    score: r.score,
    reason: r.reason ?? null,
    signals: r.signals,
  };
});

const ok = results.every((r) => r.ok);
console.log(JSON.stringify({
  ok,
  passed: results.filter((r) => r.ok).length,
  total: results.length,
  failures: results.filter((r) => !r.ok),
  results,
}, null, 2));
process.exit(ok ? 0 : 1);
