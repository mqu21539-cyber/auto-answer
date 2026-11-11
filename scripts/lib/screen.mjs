// Screen capture that needs no browser and no debug port.
//
// The operator looks at the page in whatever they normally use. Requiring a CDP
// port would mean starting a second browser, which is exactly what must not
// happen. Capturing the screen works with any browser, any PDF viewer, any
// image and any application — the picture is the interface.
//
// Windows-only: uses System.Drawing via PowerShell, present on every supported
// machine.

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';

import { APP_DIR } from './chrome.mjs';

export const SHOT_DIR = path.join(APP_DIR, 'shots');

/**
 * Capture the screen to a PNG.
 *
 * @param {object} [opts]
 * @param {string}  [opts.file]        destination; defaults to a timestamped name
 * @param {boolean} [opts.foreground]  capture only the foreground window
 * @returns {Promise<{ok:boolean, file:string|null, width?:number, height?:number, error?:string}>}
 */
export async function captureScreen({ file = null, foreground = false } = {}) {
  await mkdir(SHOT_DIR, { recursive: true });
  const out = file ?? path.join(SHOT_DIR, `screen-${Date.now()}.png`);

  // NOTE: the P/Invoke block is a here-string, so the script must keep real
  // newlines. Joining with ';' produces a parse error on the @" opener.
  const geometry = foreground
    ? [
      '$h = [AW]::GetForegroundWindow()',
      '$r = New-Object AW+RECT',
      '[AW]::GetWindowRect($h, [ref]$r) | Out-Null',
      '$x = $r.Left; $y = $r.Top',
      '$w = $r.Right - $r.Left; $b = $r.Bottom - $r.Top',
    ]
    : [
      '$bnd = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
      '$x = $bnd.X; $y = $bnd.Y; $w = $bnd.Width; $b = $bnd.Height',
    ];

  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class AW {',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
    '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
    '}',
    '"@',
    ...geometry,
    'if ($w -le 0 -or $b -le 0) { Write-Output "FAIL: empty rect"; exit 1 }',
    '$bmp = New-Object System.Drawing.Bitmap $w, $b',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $b))',
    `$bmp.Save(${JSON.stringify(out)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose()',
    '$bmp.Dispose()',
    'Write-Output ("OK " + $w + " " + $b)',
  ].join('\n');

  const res = await new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let outText = '';
    let errText = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 25000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { outText += d; });
    child.stderr.on('data', (d) => { errText += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, outText: outText.trim(), errText: errText.trim() });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, outText: '', errText: e.message });
    });
  });

  if (res.code !== 0 || !/^OK /.test(res.outText)) {
    return { ok: false, file: null, error: res.errText || res.outText || `exit ${res.code}` };
  }

  const [, w, h] = res.outText.split(' ');
  return { ok: true, file: out, width: Number(w), height: Number(h) };
}

/**
 * Poll a file and fire when it is written.
 *
 * Lets any external tool trigger a capture without the keyboard listener.
 */
export function watchTriggerFile(file, onTrigger, { intervalMs = 250 } = {}) {
  let last = 0;
  let stopped = false;
  try { last = statSync(file).mtimeMs; } catch { /* not created yet */ }

  const timer = setInterval(() => {
    if (stopped) return;
    try {
      const m = statSync(file).mtimeMs;
      if (m > last) {
        last = m;
        try { onTrigger({ at: Date.now() }); } catch { /* keep polling */ }
      }
    } catch { /* missing; ignore */ }
  }, intervalMs);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
