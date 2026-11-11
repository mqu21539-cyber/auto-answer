// Clipboard + notification helpers.
//
// Clipboard: writes via PowerShell Set-Clipboard (system-wide, works while
// Chrome runs headless). Notification: a Windows toast when available, with a
// console fallback so this never becomes a hard dependency.

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

function runPowerShell(script, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out.trim(), stderr: err.trim() });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: e.message });
    });
  });
}

/**
 * Put text on the system clipboard, and verify it actually landed.
 *
 * Two failure modes are handled here that previously both reported success:
 *
 *  1. Set-Clipboard raises a NON-terminating error when another program holds
 *     the clipboard (CLIPBRD_E_CANT_OPEN). Without `$ErrorActionPreference =
 *     'Stop'` the script carried on and printed OK, so a failed write looked
 *     like a success and the answer was silently lost.
 *  2. Even a "successful" write can land empty (clipboard contention, a
 *     listener rewriting it). Reading it back is the only way to be sure.
 *
 * @returns {Promise<{ok:boolean, chars?:number, error?:string}>} ok is true only
 *          when the text was written AND read back identical.
 */
export async function copyToClipboard(text) {
  // Pass the payload through a base64 env var: avoids quoting/encoding issues
  // with newlines, quotes, backticks and CJK characters entirely.
  const b64 = Buffer.from(String(text), 'utf8').toString('base64');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    'try {',
    '  $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AA_CLIP_B64))',
    '  Set-Clipboard -Value $text',
    '  $back = [Windows.Forms.Clipboard]::GetText()',
    '  $a = $text -replace "`r`n", "`n"',
    '  $b = $back -replace "`r`n", "`n"',
    '  if ($a -eq $b) { Write-Output "OK" }',
    '  else { Write-Output ("FAIL: readback mismatch (" + $a.Length + " vs " + $b.Length + ")") }',
    '} catch {',
    '  Write-Output ("FAIL: " + $_.Exception.Message)',
    '}',
  ].join('\n');

  const res = await new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, AA_CLIP_B64: b64 },
      },
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 15000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out.trim(), stderr: err.trim() });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: e.message });
    });
  });

  // "OK" must be the reported result, not merely present somewhere in the output.
  const lines = res.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (res.code === 0 && lines.includes('OK')) {
    return { ok: true, chars: String(text).length };
  }

  const failLine = lines.find((l) => l.startsWith('FAIL:'));
  return {
    ok: false,
    error: failLine ? failLine.slice(5).trim() : (res.stderr || `exit ${res.code}`),
  };
}

/** Read the current clipboard text (used by selftest to verify the write).
 *  Uses .NET Clipboard in an STA process: `Get-Clipboard -Raw` appends a
 *  trailing newline, which makes exact comparison against source code fail. */
export async function readClipboard() {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$t = [Windows.Forms.Clipboard]::GetText()',
    '$b = [Text.Encoding]::UTF8.GetBytes($t)',
    'Write-Output ([Convert]::ToBase64String($b))',
  ].join('; ');

  const res = await new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 15000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.trim() }); });
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, out: '' }); });
  });

  if (res.code !== 0 || !res.out) return null;
  try {
    return Buffer.from(res.out, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

const TOAST_APPID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

/**
 * Show a Windows toast. Silently reports failure — callers should fall back
 * to a console line rather than depend on this.
 *
 * An empty title+message is supported: Windows rejects a ToastGeneric binding
 * with no text nodes, so a single space is used to produce a visually blank
 * card instead of failing silently.
 */
export async function toast(title, message) {
  logToast(title, message);
  const script = `
$ErrorActionPreference = 'Stop'
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

  $title = $env:AA_TOAST_TITLE
  $msg   = $env:AA_TOAST_MSG

  # A ToastGeneric binding needs at least one non-empty <text> node, otherwise
  # Show() throws. Fall back to a single space for an intentionally blank card.
  $nodes = @()
  if ($title -ne '') { $nodes += "<text>$title</text>" }
  if ($msg   -ne '') { $nodes += "<text>$msg</text>" }
  if ($nodes.Count -eq 0) { $nodes = @("<text> </text>") }

  $xml = '<toast duration="short" scenario="reminder"><visual><binding template="ToastGeneric">' + ($nodes -join '') + '</binding></visual></toast>'

  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${TOAST_APPID}').Show($toast)
  Write-Output "OK"
} catch {
  Write-Output "FAIL: $($_.Exception.Message)"
}
`;
  const res = await new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          AA_TOAST_TITLE: String(title).replace(/[<>&]/g, ''),
          AA_TOAST_MSG: String(message).replace(/[<>&]/g, ''),
        },
      },
    );
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 10000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => { clearTimeout(timer); resolve(out.trim()); });
    child.on('error', () => { clearTimeout(timer); resolve('FAIL'); });
  });

  return { ok: /OK/.test(res) };
}

/**
 * Append every shown toast to a log file when AA_TOAST_LOG is set.
 * Used by tests to count notifications without stubbing the module.
 */
function logToast(title, message) {
  const target = process.env.AA_TOAST_LOG;
  if (!target) return;
  try {
    appendFileSync(target, JSON.stringify({ title, message, at: Date.now() }) + '\n');
  } catch { /* logging must never break the pipeline */ }
}

/** Short console bell. Written to stderr so it never corrupts JSON on stdout. */
export function beep() {
  try { process.stderr.write('\u0007'); } catch { /* no tty */ }
}

/**
 * Empty the clipboard.
 *
 * Not `copyToClipboard('')`: Set-Clipboard rejects an empty string, so the
 * "clear before solving" step silently failed and left the previous answer in
 * place — the exact situation it is supposed to prevent.
 *
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function clearClipboard() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    'try {',
    '  [Windows.Forms.Clipboard]::Clear()',
    '  if ([string]::IsNullOrEmpty([Windows.Forms.Clipboard]::GetText())) { Write-Output "OK" }',
    '  else { Write-Output "FAIL: clipboard still holds text" }',
    '} catch {',
    '  Write-Output ("FAIL: " + $_.Exception.Message)',
    '}',
  ].join('\n');

  const res = await new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 15000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out.trim(), stderr: err.trim() });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: e.message });
    });
  });

  const lines = res.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (res.code === 0 && lines.includes('OK')) return { ok: true };

  const failLine = lines.find((l) => l.startsWith('FAIL:'));
  return { ok: false, error: failLine ? failLine.slice(5).trim() : (res.stderr || `exit ${res.code}`) };
}

/**
 * Snapshot the clipboard and return an async function that puts it back.
 *
 * Tests exercise the real system clipboard, which means a test run otherwise
 * leaves its fixture data where the operator's answer should be. That is worse
 * than a failing test: the next Ctrl+V silently pastes the fixture into whatever
 * they are working on.
 *
 * Usage:
 *   const restore = await preserveClipboard();
 *   try { ...test... } finally { await restore(); }
 *
 * @returns {Promise<() => Promise<void>>} restores the original contents
 */
export async function preserveClipboard() {
  let before = null;
  try { before = await readClipboard(); } catch { before = null; }

  return async () => {
    // A null snapshot means the clipboard held no text (an image, or empty);
    // there is nothing meaningful to put back.
    if (before === null) return;
    try { await copyToClipboard(before); } catch { /* best effort */ }
  };
}
