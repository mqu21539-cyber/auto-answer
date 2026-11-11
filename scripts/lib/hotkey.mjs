// Global hotkey: detect a key combination system-wide, regardless of which
// window has focus.
//
// The automation browser runs headless, so it can never receive key events —
// the hotkey has to be observed at the OS level. On Windows this uses
// GetAsyncKeyState via a small PowerShell loop, which needs no install and no
// elevation for ordinary keys.
//
// The loop is "press both keys together": either key may go down first, and the
// trigger fires once both are held. It re-arms only after both are released, so
// holding the keys produces exactly one trigger.

import { spawn } from 'node:child_process';

/** Virtual-key codes for the letters used by default. */
const VK = {
  A: 0x41, B: 0x42, C: 0x43, D: 0x44, E: 0x45, F: 0x46, G: 0x47, H: 0x48,
  I: 0x49, J: 0x4A, K: 0x4B, L: 0x4C, M: 0x4D, N: 0x4E, O: 0x4F, P: 0x50,
  Q: 0x51, R: 0x52, S: 0x53, T: 0x54, U: 0x55, V: 0x56, W: 0x57, X: 0x58,
  Y: 0x59, Z: 0x5A,
  0: 0x30, 1: 0x31, 2: 0x32, 3: 0x33, 4: 0x34,
  5: 0x35, 6: 0x36, 7: 0x37, 8: 0x38, 9: 0x39,
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75,
  F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7A, F12: 0x7B,
};

/** Parse "J+K" or "J+K+CTRL" into virtual-key codes. */
export function parseCombo(combo) {
  const parts = String(combo).toUpperCase().split('+').map((s) => s.trim()).filter(Boolean);
  const keys = [];
  const modifiers = { ctrl: false, alt: false, shift: false };

  for (const p of parts) {
    if (p === 'CTRL' || p === 'CONTROL') { modifiers.ctrl = true; continue; }
    if (p === 'ALT') { modifiers.alt = true; continue; }
    if (p === 'SHIFT') { modifiers.shift = true; continue; }
    const code = VK[p];
    if (code === undefined) throw new Error(`Unknown key in combo: ${p}`);
    keys.push(code);
  }

  if (!keys.length) throw new Error(`Combo has no non-modifier key: ${combo}`);
  return { keys, modifiers, raw: combo };
}

// NOTE: this is a plain string, not a template literal. The PowerShell body is
// full of `$name` and `${...}` syntax that JavaScript would otherwise try to
// interpolate, so the placeholders are substituted with explicit replace() calls.
const POWERSHELL_LOOP = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class AAKeyState {',
  '    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);',
  '}',
  '"@',
  '',
  '$keys = @(__KEYS__)',
  '$needCtrl  = __NEED_CTRL__',
  '$needAlt   = __NEED_ALT__',
  '$needShift = __NEED_SHIFT__',
  '',
  '$armed = $true',
  '$out = [Console]::Out',
  '',
  // Windows does not take children down with their parent, so a killed watcher
  // would leave this loop polling the keyboard forever. Watching the parent is
  // what makes the listener die with it, which beats hunting for orphans later.
  '$parentPid = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId',
  '$tick = 0',
  '',
  'while ($true) {',
  '    $allDown = $true',
  '    $anyDown = $false',
  '    foreach ($k in $keys) {',
  '        $isDown = (([AAKeyState]::GetAsyncKeyState($k)) -band 0x8000) -ne 0',
  '        if ($isDown) { $anyDown = $true } else { $allDown = $false }',
  '    }',
  '',
  '    if ($allDown -and $armed) {',
  '        $ctrl = (([AAKeyState]::GetAsyncKeyState(0x11)) -band 0x8000) -ne 0',
  '        $alt = (([AAKeyState]::GetAsyncKeyState(0x12)) -band 0x8000) -ne 0',
  '        $shift = (([AAKeyState]::GetAsyncKeyState(0x10)) -band 0x8000) -ne 0',
  '        $ok = ($ctrl -eq $needCtrl) -and ($alt -eq $needAlt) -and ($shift -eq $needShift)',
  '        if ($ok) {',
  '            $out.WriteLine("TRIGGER")',
  '            $out.Flush()',
  '        }',
  '        $armed = $false',
  '    }',
  '',
  '    if (-not $anyDown) { $armed = $true }',
  '',
  // ~1.4s between liveness checks: cheap enough for idle CPU, fast enough that
  // an orphan cannot linger.
  '    $tick = $tick + 1',
  '    if ($tick -ge 40) {',
  '        $tick = 0',
  '        if (-not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) { break }',
  '    }',
  '',
  '    Start-Sleep -Milliseconds 35',
  '}',
].join('\n');

/**
 * Start listening for the combo.
 *
 * The listener is a separate PowerShell process, and it can disappear on its
 * own: antivirus interference, a Windows update, a long-running hiccup. When it
 * goes, the main process keeps running and looks healthy while the hotkey does
 * nothing — indistinguishable from "the key isn't bound" or "the model is
 * stuck". So the listener is restarted automatically, and if it cannot be kept
 * alive the caller is told rather than left with a zombie.
 *
 * @param {string} combo e.g. "J+K"
 * @param {(info:{at:number})=>void} onTrigger called once per press
 * @param {object} [opts]
 * @param {number} [opts.maxRestarts=5]     consecutive restarts before giving up
 * @param {number} [opts.restartDelayMs=2000]
 * @param {(msg:string)=>void} [opts.log]   where lifecycle messages go
 * @param {(reason:string)=>void} [opts.onDead] called once when restarts are exhausted
 * @returns {{stop:()=>void, child:import('node:child_process').ChildProcess|null, restarts:()=>number}}
 */
export function startHotkey(combo, onTrigger, {
  maxRestarts = 5,
  restartDelayMs = 2000,
  log = (msg) => process.stderr.write(`[aa] ${msg}\n`),
  onDead = null,
} = {}) {
  const { keys, modifiers } = parseCombo(combo);

  const script = POWERSHELL_LOOP
    .replace('__KEYS__', keys.join(','))
    .replace('__NEED_CTRL__', modifiers.ctrl ? '$true' : '$false')
    .replace('__NEED_ALT__', modifiers.alt ? '$true' : '$false')
    .replace('__NEED_SHIFT__', modifiers.shift ? '$true' : '$false');

  let stopped = false;
  let dead = false;
  let restarts = 0;
  let current = null;
  let buffer = '';
  let stderr = '';

  const spawnLoop = () => {
    buffer = '';
    stderr = '';

    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    current = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line === 'TRIGGER' && !stopped) {
          try { onTrigger({ at: Date.now() }); } catch { /* listener errors must not kill the loop */ }
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; });

    // spawn() reports EACCES/ENOENT/EINVAL asynchronously; without a listener
    // that event is an uncaught exception that takes the whole watcher down.
    child.on('error', (err) => {
      if (stopped) return;
      log(`hotkey listener spawn error: ${err.message}`);
    });

    // A listener that never started cannot be "still starting": if the process
    // is gone and we did not kill it, that is the restart case.
    child.on('close', (code, signal) => {
      if (stopped || dead) return;

      restarts += 1;
      const detail = stderr.trim().slice(0, 200);
      if (restarts > maxRestarts) {
        dead = true;
        const reason = `hotkey listener died ${restarts} times; giving up`
          + ` (last exit ${code ?? signal ?? '?'}${detail ? `: ${detail}` : ''})`;
        log(reason);
        if (onDead) {
          try { onDead(reason); } catch { /* caller's problem */ }
        }
        return;
      }

      log(`hotkey listener exited (${code ?? signal ?? '?'});`
        + ` restarting in ${restartDelayMs}ms [${restarts}/${maxRestarts}]`
        + (detail ? ` — ${detail}` : ''));
      const t = setTimeout(() => {
        if (!stopped && !dead) spawnLoop();
      }, restartDelayMs);
      t.unref?.();
    });
  };

  spawnLoop();

  return {
    // Expose the *current* child so a caller that inspects it after a restart
    // still sees the live process.
    get child() { return current; },
    restarts: () => restarts,
    stop() {
      stopped = true;
      try { current?.kill(); } catch { /* already gone */ }
    },
  };
}
