// Round-trip test: the addon's real Codec.lua (run in a Lua VM) -> PNG -> the capture decoders.
// capture.ps1 on Windows; elsewhere both Python decoders (capture_x11.py for Linux,
// capture_mac.py for macOS: their --test-image mode needs only the stdlib). Simulates game
// rendering with noise and gamma.
'use strict';
const fengari = require('fengari');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { execFileSync } = require('child_process');

// Windows decodes with capture.ps1; elsewhere the Python decoder stands in, if python3 is there.
if (process.platform !== 'win32') {
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); }
  catch { console.log('SKIP Codec.lua round-trip: python3 is required off Windows.'); process.exit(0); }
}

const CODEC = path.join(__dirname, '..', 'addon', 'WoWAI', 'Codec.lua');
const CAPTURE = path.join(__dirname, '..', 'bridge', 'capture.ps1');
const CAPTURE_X11 = path.join(__dirname, '..', 'bridge', 'capture_x11.py');
const CAPTURE_MAC = path.join(__dirname, '..', 'bridge', 'capture_mac.py');
const TMP = path.join(__dirname, 'tmp');
const CELL = 4, CELLS = 200, MAXROWS = 48;
fs.mkdirSync(TMP, { recursive: true });

function encodeWithLua(id, payload) {
  const bytes = Buffer.from(payload, 'utf8');
  const lit = '"' + [...bytes].map(b => '\\' + b).join('') + '"';
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const code = fs.readFileSync(CODEC, 'utf8') +
    `\nlocal cells, n = WoWAI_Codec.Encode(${id}, ${lit})\n` +
    `local t = {}\nfor i = 1, #cells do t[i] = string.format("%d", cells[i]) end\n` +
    `RESULT = table.concat(t, ",")\n`;
  if (lauxlib.luaL_dostring(L, to_luastring(code)) !== 0) {
    throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  }
  lua.lua_getglobal(L, to_luastring('RESULT'));
  return to_jsstring(lua.lua_tostring(L, -1)).split(',').map(Number);
}

function png(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// A Retina Mac whose game renders below the panel's resolution: macOS scales the
// frame up, so a cell is CELL * scale pixels wide and the strip starts under the
// menu bar. Cells are resampled per pixel, and the pixel where two cells meet is
// their average, as macOS's filtering leaves it.
function renderScaled(cells, jitter, scale, offY) {
  const pitch = CELL * scale;
  const W = Math.ceil(CELLS * pitch) + 8, H = Math.ceil(Math.ceil(cells.length / CELLS) * pitch) + offY + 8;
  const rgb = Buffer.alloc(W * H * 3, 0x30);
  const level = v => [Math.floor(v / 4) % 2, Math.floor(v / 2) % 2, v % 2].map(l => l * 255);
  const at = (fx, fy) => {
    const c = Math.floor(fx / pitch), r = Math.floor(fy / pitch), i = r * CELLS + c;
    return c < CELLS && i < cells.length ? level(cells[i]) : null;
  };
  for (let y = offY; y < H; y++) for (let x = 0; x < W; x++) {
    const a = at(x, y - offY), b = at(x + 0.999, y - offY + 0.999);
    if (!a) continue;
    const o = (y * W + x) * 3;
    for (let k = 0; k < 3; k++) {
      const val = b ? (a[k] + b[k]) / 2 : a[k];
      const n = jitter ? Math.round((Math.random() * 2 - 1) * jitter) : 0;
      rgb[o + k] = Math.max(0, Math.min(255, Math.round(val + n)));
    }
  }
  return png(W, H, rgb);
}

// Pure-primary cells, random noise, and a gamma curve like the in-game sliders.
function render(cells, jitter, gamma) {
  const W = CELLS * CELL, H = MAXROWS * CELL;
  const rgb = Buffer.alloc(W * H * 3, 0x30);
  cells.forEach((v, i) => {
    const c = i % CELLS, r = Math.floor(i / CELLS);
    const lv = [Math.floor(v / 4) % 2, Math.floor(v / 2) % 2, v % 2].map(l => l * 255);
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const o = ((r * CELL + y) * W + (c * CELL + x)) * 3;
      for (let k = 0; k < 3; k++) {
        let val = lv[k];
        if (gamma) val = 255 * Math.pow(val / 255, gamma);
        const n = jitter ? Math.round((Math.random() * 2 - 1) * jitter) : 0;
        rgb[o + k] = Math.max(0, Math.min(255, Math.round(val + n)));
      }
    }
  });
  return png(W, H, rgb);
}

// [name, decoded JSON] per decoder that runs on this platform.
function decode(file) {
  const last = out => JSON.parse(out.trim().split('\n').pop());
  if (process.platform === 'win32') {
    return [['capture.ps1', last(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CAPTURE, '-TestImage', file], { encoding: 'utf8' }))]];
  }
  return [['capture_x11.py', CAPTURE_X11], ['capture_mac.py', CAPTURE_MAC]]
    .map(([name, script]) => [name, last(execFileSync('python3', [script, '--test-image', file], { encoding: 'utf8' }))]);
}

const cases = [
  { id: 7, payload: 'sess1\x1Fchat1\x1F7\x1FC:\\Users\\me\\proj\x1F\x1Fname\x1Fhéllo wörld ✓ — "quotes" & \\backslash\\ end', jitter: 0, gamma: 1 },
  { id: 4242, payload: 'sess1\x1Fchat1\x1F4242\x1FC:\\x\x1Fn\x1F\x1F' + 'Refactor the player controller so jumping feels less floaty. '.repeat(40), jitter: 60, gamma: 0.6 },
  { id: 9, payload: 'sess1\x1Fchat1\x1F9\x1FC:\\x\x1F\x1F\x1F' + 'a fairly long paste: '.repeat(140), jitter: 100, gamma: 1.8 },
  { id: 65000, payload: '\x1F\x1F\x1F\x1F\x1F\x1Fx', jitter: 120, gamma: 1 },
  // macOS only: a scaled-up client (a cell is 4.768 px, as measured on a MacBook) under the menu bar.
  { id: 6, payload: 'sess\x1Fchat\x1F6\x1F\x1Fh;c\x1FChat 1\x1F' + 'Character: Lumis, level 5 Человек Паладин\n'.repeat(20), jitter: 30, gamma: 1, scale: 1.192, offY: 75, only: 'capture_mac.py' },
  { id: 8, payload: 'sess\x1Fchat\x1F8\x1F\x1F\x1FChat 1\x1Fshort', jitter: 0, gamma: 1, scale: 1.5, offY: 52, only: 'capture_mac.py' },
];

let pass = 0, total = 0;
for (const t of cases) {
  const cells = encodeWithLua(t.id, t.payload);
  const file = path.join(TMP, `strip_${t.id}.png`);
  fs.writeFileSync(file, t.scale ? renderScaled(cells, t.jitter, t.scale, t.offY) : render(cells, t.jitter, t.gamma));
  for (const [name, res] of decode(file)) {
    if (t.only && name !== t.only) continue;
    total++;
    const ok = res.id === t.id && res.text === t.payload;
    if (ok) pass++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  id=${t.id}  bytes=${Buffer.byteLength(t.payload)}  cells=${cells.length}  rows=${Math.ceil(cells.length / CELLS)}  noise=±${t.jitter} gamma=${t.gamma}${t.scale ? ` scale=${t.scale}` : ''}` + (ok ? '' : `\n   got ${JSON.stringify(res).slice(0, 200)}`));
  }
}
console.log(pass === total ? '>>> CODEC ROUND-TRIP PASS' : '>>> CODEC ROUND-TRIP FAIL');
process.exit(pass === total ? 0 : 1);
