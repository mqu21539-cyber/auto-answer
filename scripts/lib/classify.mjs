// Is this page actually a coding question?
//
// `watch` fires on every DOM mutation, which includes list pages, profiles,
// result pages, dialogs, and the site's own navigation. Notifying on those is
// noise, so the page must clear a real bar before it counts as a question.
//
// The bar is deliberately stricter than "has a textarea": plenty of pages have
// a search box or a comment field.

import { canonicalText } from './identity.mjs';

/** Text that strongly suggests a coding problem statement. */
const PROBLEM_CUES = [
  /输入格式|输出格式/,
  /样例输入|样例输出|示例\s*\d|输入示例|输出示例/,
  /数据范围|数据规模|限制条件/,
  /时间限制|内存限制|空间限制/,
  /题目描述|题目背景|题目要求|问题描述/,
  /函数签名|类名|方法名/,
  /返回值[:：]/,
  /输入[:：]\s*\S/,
  /输出[:：]\s*\S/,
  /sample\s*input|sample\s*output/i,
  /input\s*format|output\s*format/i,
  /constraints?[:：]/i,
  /time\s*limit|memory\s*limit/i,
  /示例\s*\d/,
  /给定|请你|要求你|编写一个|实现一个|返回/,
];

/** Text that suggests we are NOT on a question (lists, results, profiles). */
const NON_PROBLEM_CUES = [
  /^\s*登录|^\s*注册|^\s*sign\s*in/i,
  /提交记录|运行记录|历史记录|我的主页|个人中心/,
  /全部题目|题库|题目列表|试卷列表|排行榜/,
  /^\s*\d+\s*\/\s*\d+\s*$/,     // pagination only
  /搜索|筛选|排序方式/,
];

/** Editor kinds that only count as a real answer box. */
const ANSWER_EDITORS = new Set(['monaco', 'codemirror6', 'codemirror5', 'textarea', 'contenteditable']);

/**
 * Decide whether a page is a genuine coding question.
 *
 * @param {object} q extracted question
 * @returns {{isQuestion:boolean, score:number, signals:string[], reason?:string}}
 */
export function classifyPage(q) {
  const signals = [];
  let score = 0;

  if (!q) return { isQuestion: false, score: 0, signals: [], reason: 'no-data' };

  const heading = canonicalText(q.heading ?? '');
  const body = canonicalText(q.body ?? '');
  const both = `${heading}\n${body}`;

  // A logged-out page is never a question, regardless of text.
  if (q.loggedOutHint) {
    return { isQuestion: false, score: 0, signals: ['logged-out'], reason: 'logged-out' };
  }

  // An answer box is necessary but far from sufficient.
  if (!q.editorKind || !ANSWER_EDITORS.has(q.editorKind)) {
    return { isQuestion: false, score: 0, signals: ['no-answer-box'], reason: 'no-answer-box' };
  }
  signals.push(`editor:${q.editorKind}`);
  score += 2;

  // A real statement has substance. Short questions exist too (many OJs state
  // the whole problem in two lines), so the bar drops when the page carries
  // samples or explicit constraints — that evidence is worth more than length.
  const hasSampleEvidence = (q.samples?.length ?? 0) > 0 || (q.samplePairs?.length ?? 0) > 0;
  const minBody = hasSampleEvidence ? 40 : 80;
  if (body.length < minBody) {
    return {
      isQuestion: false,
      score,
      signals: [...signals, `body-too-short(<${minBody})`],
      reason: 'body-too-short',
    };
  }
  signals.push(`body:${body.length}`);
  score += 1;

  // Problem-specific vocabulary.
  const cues = PROBLEM_CUES.filter((re) => re.test(both)).length;
  if (cues === 0) {
    return { isQuestion: false, score, signals: [...signals, 'no-problem-cues'], reason: 'no-problem-cues' };
  }
  signals.push(`cues:${cues}`);
  score += Math.min(cues, 4);

  // Structure: real statements have several lines / paragraphs.
  const lines = body.split('\n').filter((l) => l.trim()).length;
  if (lines >= 3) { signals.push(`lines:${lines}`); score += 1; }

  // Samples or explicit constraints raise confidence further.
  if ((q.samples?.length ?? 0) > 0) { signals.push('has-samples'); score += 2; }
  if ((q.samplePairs?.length ?? 0) > 0) { signals.push('has-sample-pairs'); score += 1; }

  // A heading is expected on a question page.
  if (heading.length >= 2) { signals.push('has-heading'); score += 1; }

  // Negative evidence: a page that reads like a list or a record view.
  //
  // Judged on the HEADING only. Real question pages carry the same words in
  // their chrome — every OJ has a "提交记录" / "运行记录" tab — so scanning the
  // body would disqualify the very pages we want.
  const negatives = NON_PROBLEM_CUES.filter((re) => re.test(heading)).length;
  if (negatives > 0) { signals.push(`negatives:${negatives}`); score -= negatives * 2; }

  // A heading made only of digits/punctuation is a counter, not a title.
  // NOTE: do not use /^[\d\s\W]+$/ here — JS treats every CJK character as \W,
  // so that pattern matches any all-Chinese heading.
  if (heading && !/[A-Za-z\u4e00-\u9fff\u3040-\u30ff]/.test(heading)) {
    return { isQuestion: false, score, signals: [...signals, 'numeric-heading'], reason: 'numeric-heading' };
  }

  const isQuestion = score >= 6 && cues >= 1;
  return {
    isQuestion,
    score,
    signals,
    ...(isQuestion ? {} : { reason: 'insufficient-evidence' }),
  };
}
