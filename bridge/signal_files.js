// Signal files: how the bridge turns them "off".
//
// The addon reads a signal file with PlaySoundFile. Some clients (the Windows
// one) refuse an empty file, so "off" is an empty file and "on" a valid one.
// Others (the macOS one) play any file that exists and only refuse one that is
// missing, so there "off" has to be a missing file. Either way a client only
// sees paths that existed when it launched, so every signal file must exist
// while the game starts and may only be deleted once it runs.
//
//   style "empty":  off = empty file (what `npm run slots` creates).
//   style "absent": off = no file. When the addon says hello (the game is up),
//                   clear() deletes every empty signal file, ctl/empty.wav last,
//                   which tells the addon the switch is done. When the game
//                   quits, restore() recreates every missing one, empty, for the
//                   next launch.
'use strict';
const fs = require('fs');
const path = require('path');

function defaultStyle(platform = process.platform) {
  return platform === 'darwin' ? 'absent' : 'empty';
}

// Every signal file the addon may poll, ctl/empty.wav last.
function signalFiles(addonDir, { slots = 200, actMax = 60, stepMax = 30, presenceMax = 2000, syncMax = 500 } = {}) {
  const base = path.join(addonDir, 'WoWAI');
  const p3 = n => String(n).padStart(3, '0');
  const p2 = n => String(n).padStart(2, '0');
  const p4 = n => String(n).padStart(4, '0');
  const out = [];
  for (let i = 1; i <= slots; i++) {
    out.push(path.join(base, 'sig', p3(i) + '.wav'), path.join(base, 'ack', p3(i) + '.wav'));
    for (let k = 1; k <= actMax; k++) out.push(path.join(base, 'act', p3(i), p2(k) + '.wav'));
    for (let k = 1; k <= stepMax; k++) out.push(path.join(base, 'step', p3(i), p2(k) + '.wav'));
  }
  for (let k = 1; k <= presenceMax; k++) out.push(path.join(base, 'presence', p4(k) + '.wav'));
  for (let k = 1; k <= syncMax; k++) out.push(path.join(base, 'sync', p4(k) + '.wav'));
  out.push(path.join(base, 'ctl', 'empty.wav'));
  return out;
}

// Turn one file off in the given style.
function setOff(file, style, atomicWrite) {
  if (style === 'absent') { try { fs.rmSync(file, { force: true }); } catch {} return; }
  try { atomicWrite(file, Buffer.alloc(0)); } catch {}
}

// "absent" style, game running: delete every empty signal file (valid ones are
// signals already raised and stay). Returns how many were deleted.
function clear(files) {
  let n = 0;
  for (const f of files) {
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    if (st.isFile() && st.size === 0) { try { fs.rmSync(f); n++; } catch {} }
  }
  return n;
}

// Game not running: recreate every missing signal file, empty, so the next
// launch sees them all. Returns how many were made.
function restore(files) {
  let n = 0;
  for (const f of files) {
    if (fs.existsSync(f)) continue;
    try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ''); n++; } catch {}
  }
  return n;
}

module.exports = { defaultStyle, signalFiles, setOff, clear, restore };
