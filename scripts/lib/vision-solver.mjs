// Vision solver: read a screenshot with a multimodal model and return code.
//
// This is the piece that makes the flow hands-free. Without it, a capture only
// produces a picture, and somebody has to read it. With it, the capture becomes
// an answer file, which the watcher then puts on the clipboard.
//
// Talks to any OpenAI-compatible endpoint, so it works with the official
// providers, the usual proxies, and local servers alike.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { APP_DIR } from './chrome.mjs';
import { verifySamples, canVerify } from './verify.mjs';
import { normalizeLang } from './lang.mjs';

export const SOLVER_CONFIG = process.env.AA_SOLVER_CONFIG
  || path.join(APP_DIR, 'solver.json');

/** Defaults that work for most OpenAI-compatible gateways. */
const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o',
  timeoutMs: 120000,
  maxTokens: 4096,
  temperature: 0.1,
};

/**
 * Load solver configuration.
 * Resolution order: explicit argument > solver.json > environment > defaults.
 *
 * @returns {Promise<{baseUrl:string, apiKey:string|null, model:string, timeoutMs:number, language:string|null}>}
 */
export async function loadSolverConfig(overrides = {}) {
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(await readFile(SOLVER_CONFIG, 'utf8'));
  } catch { /* no config file yet */ }

  const cfg = {
    ...DEFAULTS,
    ...fileCfg,
    ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v != null)),
  };

  cfg.baseUrl = cfg.baseUrl || process.env.AA_API_BASE || DEFAULTS.baseUrl;
  cfg.apiKey = cfg.apiKey || process.env.AA_API_KEY || null;
  cfg.model = cfg.model || process.env.AA_API_MODEL || DEFAULTS.model;

  return cfg;
}

const SYSTEM_PROMPT = [
  'You are a competitive-programming assistant.',
  'The user sends a screenshot of an online judge problem page.',
  'Read the problem statement, the sample cases, the required signature, and the',
  'language shown in the code editor, then write a complete, correct solution.',
  '',
  'Reply with a single JSON object and nothing else:',
  '{"mode":"acm"|"core","language":"python","samples":[{"input":"...","output":"..."}],"code":"..."}',
  '',
  '  mode      "acm"  when the solution reads stdin and writes stdout,',
  '            "core" when it fills in a function/class body instead.',
  '  language  the language selected in the editor dropdown.',
  '  samples   EVERY sample case printed on the page, copied verbatim: the input',
  '            block and the corresponding expected output block. For "core" mode',
  '            use "input" for the arguments and "output" for the return value.',
  '            Omit only when the page truly shows no samples.',
  '  code      the complete solution, ready to paste, no markdown fences.',
  '',
  'Rules:',
  '1. The problem statement is the authority. Read every rule, constraint and',
  '   boundary condition; the samples are the check the code must satisfy.',
  '2. Match the language shown in the editor dropdown (Python, Java, C++, ...).',
  '3. The editor may still contain code from the PREVIOUS problem. If its content',
  '   does not match the statement on screen, ignore it completely and write a',
  '   fresh solution for the current statement. Never adapt leftover code.',
  '4. Only when the editor shows a matching scaffold for THIS problem (a class or',
  '   method the statement names), keep that scaffold and fill in the body.',
  '5. Read the input/output format literally: number of lines, order of values,',
  '   and exact output formatting. The samples are compared character by',
  '   character, so a wrong format fails even with a correct algorithm.',
  '6. If the samples on the page contradict your understanding of the rules,',
  '   trust the samples: find the reading of the rules that reproduces them.',
  '7. Prefer the simplest correct algorithm that fits the stated constraints.',
].join('\n');

/** Strip markdown fences and stray prose the model may add despite instructions. */
export function extractCode(text) {
  let s = String(text ?? '').trim();

  // ```java ... ``` or ``` ... ```
  const fenced = s.match(/```[a-zA-Z0-9+#-]*\n([\s\S]*?)```/);
  if (fenced) s = fenced[1].trim();

  // Drop a leading sentence like "Here is the solution:" if it slipped through.
  const firstBrace = s.search(/[{}#@]|^import\s|^public\s|^class\s|^def\s/m);
  return s;
}

/**
 * Parse the model's reply into code + the samples it claims to have read.
 *
 * The reply is asked to be JSON, but models drift; anything unparseable falls
 * back to treating the whole text as code, which simply means the answer cannot
 * be verified instead of being lost.
 *
 * @returns {{code:string, samples:Array<{input:string,output:string}>, mode:string, language:string|null}}
 */
export function parseAnswer(text) {
  const raw = String(text ?? '').trim();

  // The JSON may be wrapped in a fenced block despite instructions.
  const fenced = raw.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : raw).trim();

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(candidate.slice(start, end + 1));
      if (obj && typeof obj.code === 'string' && obj.code.trim()) {
        const samples = Array.isArray(obj.samples)
          ? obj.samples
            .filter((s) => s && (s.input !== undefined || s.output !== undefined))
            .map((s) => ({
              input: String(s.input ?? ''),
              output: String(s.output ?? ''),
            }))
          : [];
        return {
          code: extractCode(obj.code),
          samples,
          mode: typeof obj.mode === 'string' ? obj.mode.toLowerCase() : 'acm',
          language: typeof obj.language === 'string' ? obj.language : null,
        };
      }
    } catch { /* not JSON; fall through */ }
  }

  return { code: extractCode(raw), samples: [], mode: 'unknown', language: null };
}

/**
 * Guess the language from the code the model returned, for the file extension.
 * The watcher only needs the extension to match; the editor decides the rest.
 */
export function guessLanguage(code, hint = null) {
  if (hint) return hint;
  const c = String(code ?? '');
  if (/\bpublic\s+class\b|\bimport\s+java\./.test(c)) return 'java';
  if (/#include\s*<|std::/.test(c)) return 'cpp';
  if (/^\s*def\s+\w+\s*\(|^import\s+\w+$/m.test(c) && !/[;{}]\s*$/m.test(c)) return 'python';
  if (/\bfunction\s+\w+\s*\(|=>/.test(c)) return 'javascript';
  if (/\bfunc\s+\w+\s*\(/.test(c)) return 'go';
  if (/\bfn\s+\w+\s*\(/.test(c)) return 'rust';
  return 'java';
}

/**
 * Statuses worth retrying: the request never reached the model, so trying again
 * is free of side effects. 401/403/404 are permanent and must fail fast.
 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Wait between attempts when the gateway is saturated. */
const RETRY_BACKOFF_MS = [2000, 5000, 10000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Send the screenshot to the model and get a solution back.
 *
 * Retries saturated/failed gateways instead of giving up: `429 queue_full` and
 * `concurrency_limit` are the normal failure mode of a shared relay and they
 * clear within seconds. The whole call is bounded by `budgetMs`, so retrying
 * cannot make the operator wait longer than they were promised.
 *
 * @param {object} opts
 * @param {string} opts.imagePath  PNG/JPG on disk
 * @param {object} [opts.config]   from loadSolverConfig()
 * @param {string} [opts.extra]    extra instruction, e.g. "the language is Python"
 * @param {(info:object)=>void} [opts.onRetry] notified before each retry
 * @returns {Promise<{ok:boolean, code?:string, raw?:string, model?:string, error?:string, ms?:number, attempts?:number}>}
 */
export async function solveWithVision({ imagePath, config, extra = '', onRetry = null }) {
  const cfg = config ?? (await loadSolverConfig());
  if (!cfg.apiKey) {
    return { ok: false, error: 'no API key: set AA_API_KEY or write %LOCALAPPDATA%\\dsh-auto-answer\\solver.json' };
  }

  const started = Date.now();
  const perAttemptMs = cfg.timeoutMs ?? DEFAULTS.timeoutMs;
  // Budget covers all attempts together; without it a retry loop could outlast
  // the window the operator was told to wait.
  const budgetMs = cfg.budgetMs ?? perAttemptMs;
  const deadline = started + budgetMs;
  const maxAttempts = (cfg.retries ?? RETRY_BACKOFF_MS.length) + 1;

  const buf = await readFile(imagePath);
  const b64 = buf.toString('base64');
  const mime = imagePath.toLowerCase().endsWith('.jpg') || imagePath.toLowerCase().endsWith('.jpeg')
    ? 'image/jpeg'
    : 'image/png';

  const url = `${String(cfg.baseUrl).replace(/\/+$/, '')}/chat/completions`;

  const body = {
    model: cfg.model,
    temperature: cfg.temperature ?? DEFAULTS.temperature,
    max_tokens: cfg.maxTokens ?? DEFAULTS.maxTokens,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `题目截图如下。${extra ? `${extra} ` : ''}请直接给出完整代码，只输出代码本身。`,
          },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
        ],
      },
    ],
  };

  const attemptOnce = async (timeoutMs) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      const text = await res.text();
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          retryable: RETRYABLE_STATUS.has(res.status),
          error: `HTTP ${res.status}: ${text.slice(0, 400)}`,
        };
      }

      let json;
      try { json = JSON.parse(text); } catch {
        return { ok: false, status: res.status, retryable: false, error: `non-JSON response: ${text.slice(0, 300)}` };
      }

      const content = json?.choices?.[0]?.message?.content;
      if (!content) {
        return { ok: false, status: res.status, retryable: false, error: `no content in response: ${text.slice(0, 300)}` };
      }

      const parsed = parseAnswer(content);
      if (!parsed.code.trim()) {
        return { ok: false, status: res.status, retryable: true, error: 'model returned empty code', raw: content };
      }

      return {
        ok: true,
        code: parsed.code,
        samples: parsed.samples,
        mode: parsed.mode,
        reportedLanguage: parsed.language,
        raw: content,
        model: json.model ?? cfg.model,
        usage: json.usage ?? null,
      };
    } catch (err) {
      // A timeout is not retried: the attempt already consumed its share of the
      // budget, and a second full wait would blow past the deadline.
      const timedOut = err.name === 'AbortError';
      return {
        ok: false,
        retryable: false,
        error: timedOut ? 'request timed out' : `${err.message}`,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  let last = null;
  let attempts = 0;

  for (let i = 0; i < maxAttempts; i += 1) {
    const remaining = deadline - Date.now();
    // Below this there is no point starting another round trip.
    if (remaining < 3000) break;

    attempts += 1;
    const r = await attemptOnce(Math.min(perAttemptMs, remaining));
    if (r.ok) {
      return { ...r, ms: Date.now() - started, attempts };
    }

    last = r;
    if (!r.retryable) break;

    const wait = RETRY_BACKOFF_MS[Math.min(i, RETRY_BACKOFF_MS.length - 1)];
    if (Date.now() + wait + 3000 > deadline) break;

    if (onRetry) {
      try { onRetry({ attempt: attempts, error: r.error, waitMs: wait }); } catch { /* observer's problem */ }
    }
    await sleep(wait);
  }

  return { ...(last ?? { ok: false, error: 'no attempt was made' }), ms: Date.now() - started, attempts };
}

/**
 * Solve, then prove the solution against the samples on the page.
 *
 * A model that misreads a rule still returns something that looks like code.
 * Running that code on the sample cases is the only check available without
 * touching the judge, so an answer is only reported as deliverable when it
 * reproduces every sample. On a mismatch the failure is fed back and the model
 * gets another try.
 *
 * When the answer cannot be checked — no samples on screen, "core" mode where
 * the code is a function body rather than a program, or no interpreter for the
 * language — it is returned as unverified instead of being thrown away.
 *
 * @returns {Promise<object>} solveWithVision's result plus
 *          `verified` (true/false), `verifyReason`, `verifyResults`, `solveAttempts`
 */
export async function solveAndVerify({
  imagePath,
  config,
  extra = '',
  maxSolveAttempts = 3,
  onRetry = null,
  onVerify = null,
  onSolveRetry = null,
}) {
  const cfg = config ?? (await loadSolverConfig());
  let feedback = '';
  let last = null;

  for (let attempt = 1; attempt <= maxSolveAttempts; attempt += 1) {
    const r = await solveWithVision({
      imagePath,
      config: cfg,
      extra: [extra, feedback].filter(Boolean).join(' '),
      onRetry,
    });

    if (!r.ok) {
      // A transport failure is not a wrong answer; report it as-is.
      return { ...r, verified: false, checkable: false, verifyReason: r.error, solveAttempts: attempt };
    }

    // The model read the editor's language dropdown, so its answer is the better
    // signal; the guess from the code is only a fallback. Getting this wrong
    // tries to compile Python with javac.
    const lang = normalizeLang(r.reportedLanguage) ?? guessLanguage(r.code, null);
    const samples = r.samples ?? [];
    const runnable = r.mode !== 'core' && samples.length > 0 && canVerify(lang);

    if (!runnable) {
      const why = r.mode === 'core'
        ? 'core-code mode: nothing to run without the judge harness'
        : samples.length === 0
          ? 'no sample cases were readable from the screenshot'
          : `no interpreter available for ${lang}`;
      return { ...r, verified: false, checkable: false, verifyReason: why, solveAttempts: attempt };
    }

    const v = await verifySamples({ lang, code: r.code, samples });
    if (onVerify) {
      try { onVerify({ attempt, lang, result: v }); } catch { /* observer's problem */ }
    }

    if (v.ok) {
      return {
        ...r,
        verified: true,
        checkable: true,
        verifyReason: `all ${v.results.length} sample(s) reproduced`,
        verifyResults: v.results,
        solveAttempts: attempt,
      };
    }

    last = { ...r, verified: false, verifyResults: v.results };

    const failing = (v.results ?? []).filter((x) => !x.ok).slice(0, 2);
    if (failing.length === 0) {
      // Nothing ran at all: the code does not compile, or it crashed before
      // printing. Still worth another try with the compiler message attached.
      feedback = `Your previous solution FAILED to run: ${String(v.reason ?? 'the code could not be executed').slice(0, 400)}`
        + ' Fix the code so it compiles and runs, and make sure it reads input exactly as the statement describes.';
      if (onSolveRetry) {
        try { onSolveRetry({ attempt, feedback, failing: [], reason: v.reason }); } catch { /* observer's problem */ }
      }
      continue;
    }

    feedback = 'Your previous solution FAILED the samples on the page. '
      + failing.map((f) => `Sample ${f.index}: input ${JSON.stringify(f.input)}, `
        + `expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}.`).join(' ')
      + ' Re-read the statement and the samples, work out which rule you misread, '
      + 'and correct the code so every sample matches exactly.';

    if (onSolveRetry) {
      try { onSolveRetry({ attempt, feedback, failing }); } catch { /* observer's problem */ }
    }
  }

  return {
    ...(last ?? { ok: false, error: 'no attempt produced code' }),
    ok: Boolean(last?.code),
    verified: false,
    checkable: true,
    verifyReason: `samples still failing after ${maxSolveAttempts} attempts`,
    solveAttempts: maxSolveAttempts,
  };
}
