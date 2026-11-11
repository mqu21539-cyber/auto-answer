// Sample self-verification.
//
// The model is asked to read the sample input/output pairs off the screen along
// with the problem. Those pairs become an executable check: if the generated
// code does not reproduce the samples, the answer is not delivered at all.
//
// This is the difference between "plausible code" and "code that has been
// proven against the only ground truth on the page". Without it, a model that
// misreads a rule still returns something that looks like a solution.

import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { APP_DIR } from './chrome.mjs';

const WORK_ROOT = path.join(APP_DIR, 'tmp', 'verify');

/** Interpreter candidates, resolved in order. Overridable via environment. */
const CANDIDATES = {
  // Bare names are resolved through PATH; AA_PYTHON covers unusual installs.
  python: [process.env.AA_PYTHON, 'python', 'py', 'python3'].filter(Boolean),
  node: [process.execPath, 'node'].filter(Boolean),
  gpp: [
    process.env.AA_GPP,
    'C:\\Program Files (x86)\\Dev-Cpp\\MinGW64\\bin\\g++.exe',
    'C:\\mingw64\\bin\\g++.exe',
    'g++',
  ].filter(Boolean),
  javac: ['javac'],
  java: ['java'],
};

function resolveTool(list) {
  for (const candidate of list) {
    // Absolute paths are checked directly; bare names are looked up on PATH so a
    // missing interpreter is reported instead of failing at spawn time.
    if (candidate.includes('\\') || candidate.includes('/')) {
      if (existsSync(candidate)) return candidate;
    } else if (onPath(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** True when `name` (or name.exe) is resolvable on PATH. */
function onPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean);
  for (const dir of dirs) {
    for (const ext of ['', ...exts]) {
      try {
        if (existsSync(path.join(dir, name + ext))) return true;
      } catch { /* unreadable directory */ }
    }
  }
  return false;
}

/** Run a command with stdin, capturing stdout/stderr. Never throws. */
function run(cmd, args, { input = '', timeoutMs = 8000, cwd = WORK_ROOT } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: err.message, timedOut: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      try { child.kill(); } catch { /* gone */ }
      done = true;
      resolve({ code: -1, stdout, stderr: `${stderr}\n[timeout after ${timeoutMs}ms]`, timedOut: true });
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: err.message, timedOut: false });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });

    try {
      child.stdin.write(input);
      child.stdin.end();
    } catch { /* the process may have exited already */ }
  });
}

/**
 * Normalise program output for comparison.
 *
 * Judges ignore trailing whitespace and line-ending style but nothing else, so
 * this mirrors that: CRLF to LF, strip trailing blanks per line, drop leading
 * and trailing blank lines. Interior formatting stays significant.
 */
export function normalizeOutput(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/** Extract the name of the public class so a Java file can be compiled. */
function javaClassName(code) {
  const m = String(code).match(/\bpublic\s+(?:final\s+|abstract\s+)?class\s+([A-Za-z_$][\w$]*)/);
  if (m) return m[1];
  const m2 = String(code).match(/\bclass\s+([A-Za-z_$][\w$]*)/);
  return m2 ? m2[1] : 'Main';
}

/**
 * Which languages can actually be executed on this machine.
 * @param {string} lang canonical id from lang.mjs
 */
export function canVerify(lang) {
  if (lang === 'python') return Boolean(resolveTool(CANDIDATES.python));
  if (lang === 'javascript' || lang === 'typescript') return Boolean(resolveTool(CANDIDATES.node));
  if (lang === 'cpp' || lang === 'c') {
    return Boolean(resolveTool(CANDIDATES.gpp)) && Boolean(resolveTool(CANDIDATES.javac) !== null);
  }
  if (lang === 'java') {
    return Boolean(resolveTool(CANDIDATES.javac)) && Boolean(resolveTool(CANDIDATES.java));
  }
  return false;
}

/**
 * Run one solution against every sample.
 *
 * @param {object} opts
 * @param {string} opts.lang  canonical language id
 * @param {string} opts.code  solution source
 * @param {Array<{input:string, output:string}>} opts.samples
 * @param {number} [opts.timeoutMs] per-sample limit
 * @returns {Promise<{supported:boolean, ok:boolean, results:Array, reason?:string}>}
 */
export async function verifySamples({ lang, code, samples, timeoutMs = 8000 }) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return { supported: false, ok: false, results: [], reason: 'no samples were extracted' };
  }
  if (!canVerify(lang)) {
    return { supported: false, ok: false, results: [], reason: `no interpreter available for ${lang}` };
  }

  const dir = path.join(WORK_ROOT, `run-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });

  try {
    const plan = await prepare(lang, code, dir);
    if (!plan.ok) {
      return { supported: true, ok: false, results: [], reason: plan.error };
    }

    const results = [];
    for (const [i, sample] of samples.entries()) {
      const r = await run(plan.cmd, plan.args, {
        input: `${sample.input ?? ''}\n`,
        timeoutMs,
        cwd: dir,
      });
      const actual = normalizeOutput(r.stdout);
      const expected = normalizeOutput(sample.output);
      results.push({
        index: i + 1,
        ok: r.code === 0 && actual === expected,
        input: String(sample.input ?? '').slice(0, 400),
        expected,
        actual: actual.slice(0, 400),
        stderr: r.stderr.trim().slice(0, 300) || null,
        timedOut: r.timedOut,
        exitCode: r.code,
      });
    }

    return { supported: true, ok: results.every((r) => r.ok), results };
  } finally {
    // Best effort: a leftover temp dir is harmless, a crash here is not.
    try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** Write the source, compile when needed, and produce the command to run. */
async function prepare(lang, code, dir) {
  if (lang === 'python') {
    const file = path.join(dir, 'main.py');
    await writeFile(file, code, 'utf8');
    return { ok: true, cmd: resolveTool(CANDIDATES.python), args: [file] };
  }

  if (lang === 'javascript' || lang === 'typescript') {
    const file = path.join(dir, 'main.mjs');
    await writeFile(file, code, 'utf8');
    return { ok: true, cmd: resolveTool(CANDIDATES.node), args: [file] };
  }

  if (lang === 'cpp' || lang === 'c') {
    const ext = lang === 'c' ? '.c' : '.cpp';
    const src = path.join(dir, `main${ext}`);
    const exe = path.join(dir, 'main.exe');
    await writeFile(src, code, 'utf8');

    const gpp = resolveTool(CANDIDATES.gpp);
    // Dev-C++ ships g++ 4.9, which predates -std=c++17; fall back to c++11.
    for (const std of ['c++17', 'c++14', 'c++11']) {
      const c = await run(gpp, ['-std=' + std, '-O2', '-w', '-o', exe, src], { timeoutMs: 20000 });
      if (c.code === 0) return { ok: true, cmd: exe, args: [] };
      if (!/unrecognized command line option/.test(c.stderr)) {
        return { ok: false, error: `compile failed: ${c.stderr.trim().slice(0, 300)}` };
      }
    }
    return { ok: false, error: 'compile failed: no supported -std option' };
  }

  if (lang === 'java') {
    const cls = javaClassName(code);
    const src = path.join(dir, `${cls}.java`);
    await writeFile(src, code, 'utf8');

    const c = await run(resolveTool(CANDIDATES.javac), ['-encoding', 'UTF-8', src], { timeoutMs: 30000 });
    if (c.code !== 0) {
      return { ok: false, error: `javac failed: ${c.stderr.trim().slice(0, 300)}` };
    }
    return { ok: true, cmd: resolveTool(CANDIDATES.java), args: ['-cp', dir, cls] };
  }

  return { ok: false, error: `unsupported language: ${lang}` };
}