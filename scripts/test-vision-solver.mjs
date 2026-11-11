// Unit tests for the vision solver: config resolution, code extraction,
// language guessing, and error paths. Network calls are exercised against a
// local stub server so no API key is needed.
//
// The config file is redirected to a test-only path BEFORE the solver module is
// imported. Pointing these tests at the real solver.json would delete the
// operator's saved key.

import { createServer } from 'node:http';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { APP_DIR } from './lib/chrome.mjs';

process.env.AA_SOLVER_CONFIG = path.join(APP_DIR, 'solver-test.json');

const {
  loadSolverConfig, extractCode, guessLanguage, solveWithVision, SOLVER_CONFIG,
} = await import('./lib/vision-solver.mjs');

const TMP_IMG = path.join(APP_DIR, 'shots', 'solver-test.png');

function testExtract() {
  const cases = [
    ['```java\npublic class Solution {}\n```', 'java', 'public class Solution {}'],
    ['public class A {}', 'java', 'public class A {}'],
    ['```python\ndef f():\n    pass\n```', 'python', 'def f():\n    pass'],
    ['```cpp\n#include <bits/stdc++.h>\n```', 'cpp', '#include <bits/stdc++.h>'],
    ['```\nclass Main {}\n```', 'java', 'class Main {}'],
  ];

  const failures = [];
  for (const [input, wantLang, wantCode] of cases) {
    const code = extractCode(input);
    const lang = guessLanguage(code);
    if (code.trim() !== wantCode.trim() || lang !== wantLang) {
      failures.push({ input, code, lang, wantLang, wantCode });
    }
  }
  return { ok: failures.length === 0, checked: cases.length, failures };
}

async function testConfig() {
  await mkdir(APP_DIR, { recursive: true });
  await rm(SOLVER_CONFIG, { force: true });

  const fromEnv = await loadSolverConfig({});
  const envOk = fromEnv.baseUrl && fromEnv.model;

  await writeFile(SOLVER_CONFIG, JSON.stringify({
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: 'test-key',
    model: 'test-model',
  }), 'utf8');

  const fromFile = await loadSolverConfig({});
  const fileOk = fromFile.apiKey === 'test-key'
    && fromFile.model === 'test-model'
    && fromFile.baseUrl === 'http://127.0.0.1:9/v1';

  const override = await loadSolverConfig({ model: 'override-model' });

  await rm(SOLVER_CONFIG, { force: true });

  return {
    ok: Boolean(envOk) && fileOk && override.model === 'override-model',
    envOk: Boolean(envOk),
    fileOk,
    override: override.model,
  };
}

async function testMissingKey() {
  await rm(SOLVER_CONFIG, { force: true });
  const r = await solveWithVision({
    imagePath: TMP_IMG,
    config: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: null, model: 'x' },
  });
  return { ok: r.ok === false && /API key/i.test(r.error ?? ''), error: r.error };
}

async function testStubServer() {
  // Minimal OpenAI-compatible endpoint that returns a fenced Java answer.
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const parsed = (() => { try { return JSON.parse(body); } catch { return null; } })();
      const hasImage = JSON.stringify(parsed).includes('data:image/png;base64,');
      res.writeHead(hasImage ? 200 : 400, { 'Content-Type': 'application/json' });
      if (!hasImage) {
        res.end(JSON.stringify({ error: 'no image in request' }));
        return;
      }
      res.end(JSON.stringify({
        model: 'stub-vision',
        choices: [{
          message: {
            content: '```java\npublic class Solution {\n    public boolean isPail(ListNode head) {\n        return true;\n    }\n}\n```',
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }));
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const r = await solveWithVision({
    imagePath: TMP_IMG,
    config: {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'stub-key',
      model: 'stub-vision',
      timeoutMs: 10000,
    },
  });

  server.close();

  return {
    ok: r.ok === true
        && r.code.includes('public class Solution')
        && r.code.includes('isPail')
        && !r.code.includes('```')
        && r.model === 'stub-vision',
    code: r.code?.slice(0, 80) ?? null,
    error: r.error ?? null,
    usage: r.usage,
  };
}

async function testHttpError() {
  const server = createServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const r = await solveWithVision({
    imagePath: TMP_IMG,
    config: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'bad', model: 'x', timeoutMs: 5000 },
  });

  server.close();
  return { ok: r.ok === false && /401/.test(r.error ?? ''), error: r.error };
}

async function main() {
  await mkdir(path.dirname(TMP_IMG), { recursive: true });
  // A 1x1 PNG is enough: the stub server only checks that an image was sent.
  await writeFile(TMP_IMG, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ));

  const extract = testExtract();
  const config = await testConfig();
  const missing = await testMissingKey();
  const stub = await testStubServer();
  const httpError = await testHttpError();

  const ok = extract.ok && config.ok && missing.ok && stub.ok && httpError.ok;
  console.log(JSON.stringify({
    ok,
    extract,
    config,
    missingKey: missing,
    stubServer: stub,
    httpError,
  }, null, 2));

  // Use exitCode rather than exit(): tearing the process down while an HTTP
  // server handle is still closing trips a libuv assertion on Windows.
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message, stack: e.stack }, null, 2));
  process.exit(1);
});
