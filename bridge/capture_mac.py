#!/usr/bin/env python3
"""macOS counterpart of capture.ps1 / capture_x11.py: screen-captures the
top-left corner of the native WoW: Forever client and decodes the WoWAI pixel
strip (see Codec.lua in the addon). Prints one JSON line per new message to
stdout, with the same {info|warn|error|id,text} contract as the other capture
scripts. Started by bridge.js.

Uses only the Python stdlib plus the built-in macOS screencapture binary and
osascript. The first run will trigger System Settings permissions for
System Events (window discovery) and Screen Recording (screencapture).

  capture_mac.py --test-image strip.png   decode a PNG once and exit (tests)
  capture_mac.py --probe out.png          save what the capture sees once and exit
  capture_mac.py --window-name NAME       match a window by title instead of process name
"""

import argparse
import json
import os
import struct
import subprocess
import sys
import tempfile
import time
import zlib

p = argparse.ArgumentParser()
p.add_argument("--cell", type=int, default=4)
p.add_argument("--cells", type=int, default=200)
p.add_argument("--max-rows", type=int, default=48)
p.add_argument("--interval-ms", type=int, default=250)
p.add_argument("--process-name", default="World of Warcraft")
p.add_argument("--window-name", default="")
p.add_argument("--test-image", default="")
p.add_argument("--probe", default="")
# macOS specific: how many pixels to search down for the strip (title bar + menu bar)
p.add_argument("--y-slack", type=int, default=200, help="vertical search margin in physical pixels")
# region to capture, in screen points (independent of Retina scale)
p.add_argument("--region-w", type=int, default=1000)
p.add_argument("--region-h", type=int, default=400)
args = p.parse_args()

CELL, CELLS, MAXROWS = args.cell, args.cells, args.max_rows
W, H = CELLS * CELL, MAXROWS * CELL
XSLACK = 8
YSLACK = args.y_slack


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


# ---------------------------------------------------------------------------
# Decoder: identical rules to capture.ps1 and capture_x11.py
# ---------------------------------------------------------------------------

# The addon draws CELL-pixel cells in the game's own resolution. On a Retina
# Mac the game often renders below the panel's native resolution and macOS
# scales it up, so in the screenshot a cell is CELL * scale pixels (4.8 for a
# client at 1/1.2 of the panel). The pitch is therefore a parameter: found
# coarsely through the magic, then fine-tuned until the checksum agrees, and
# remembered in the hint for the next frames.
MAGIC_CELLS = (6, 1, 6, 1, 5)  # 0xC71A as 3-bit cells; the 6th cell holds 1 magic bit + 2 id bits


def cell_value(px, c, r, ox=0, oy=0, pitch=CELL):
    try:
        rr, gg, bb = px(int(ox + (c + 0.5) * pitch), int(oy + (r + 0.5) * pitch))
    except IndexError:  # the search window can reach past a small capture's edge
        return 0
    return (4 if rr >= 128 else 0) + (2 if gg >= 128 else 0) + (1 if bb >= 128 else 0)


def has_magic(px, ox, oy, pitch=CELL):
    for i, want in enumerate(MAGIC_CELLS):  # cheap early exit: most offsets fail on the first cell
        if cell_value(px, i, 0, ox, oy, pitch) != want:
            return False
    return (cell_value(px, 5, 0, ox, oy, pitch) >> 2) == 0


def decode(px, ox=0, oy=0, pitch=CELL, width=None, height=None):
    acc = 0
    nbits = 0
    out = bytearray()
    needed = 6
    total = CELLS * MAXROWS
    for i in range(total):
        r = i // CELLS
        if height is not None and oy + (r + 1) * pitch > height:
            return {"error": "truncated"}
        acc = (acc << 3) | cell_value(px, i % CELLS, r, ox, oy, pitch)
        nbits += 3
        while nbits >= 8:
            out.append((acc >> (nbits - 8)) & 0xFF)
            nbits -= 8
            acc &= (1 << nbits) - 1
            if len(out) == 2 and (out[0] != 0xC7 or out[1] != 0x1A):
                return None
            if len(out) == 6:
                length = out[4] * 256 + out[5]
                needed = 8 + length
                if needed > total * 3 // 8:
                    return {"error": "length"}
            if len(out) >= needed:
                break
        if len(out) >= needed:
            break
    if len(out) < needed:
        return {"error": "truncated"}
    length = out[4] * 256 + out[5]
    s1 = s2 = 0
    for k in range(2, 6 + length):
        s1 = (s1 + out[k]) % 255
        s2 = (s2 + s1) % 255
    if out[6 + length] != s1 or out[7 + length] != s2:
        return {"error": "checksum"}
    text = bytes(out[6:6 + length]).decode("utf-8", errors="replace")
    return {"id": out[2] * 256 + out[3], "text": text}


def fits(width, ox, pitch):
    return ox + CELLS * pitch <= width


def refine(px, width, height, ox, oy, pitch):
    """Around a magic hit, find the pitch (and a pixel or two of offset) at which
    the whole frame decodes with a valid checksum. A wrong pitch drifts by
    CELLS * error over one row, so it has to be right to well under 1%."""
    first = None
    steps = [0.0] + [k * 0.004 * sgn for k in range(1, 50) for sgn in (1, -1)]
    for d in steps:
        p = pitch + d
        if p < 2 or not fits(width, ox, p):
            continue
        for dy in (0, 1, -1):
            for dx in (0, 1, -1):
                x, y = ox + dx, oy + dy
                if x < 0 or y < 0 or not has_magic(px, x, y, p):
                    continue
                res = decode(px, x, y, p, width, height)
                if res and "error" not in res:
                    return res, (x, y, p)
                if first is None:
                    first = res
    return first, None


# Pitches tried when nothing is known yet: the native one first, then the
# usual Retina/scaled ones, then a sweep.
PITCH_GUESSES = [CELL, CELL * 1.2, CELL * 1.25, CELL * 1.5, CELL * 2.0, CELL * 1.6, CELL * 1.33, CELL * 1.1]
PITCH_GUESSES += [round(2.0 + k * 0.1, 2) for k in range(0, 81) if round(2.0 + k * 0.1, 2) not in PITCH_GUESSES]


def find_and_decode(px, width, height, hint, sweep=True):
    """Decode at the last good offset and pitch, else search a top-left window
    for the magic over a range of pitches. The vertical search window is larger
    because the macOS title bar or menu bar pushes the UIParent top-left down.
    The hint is (ox, oy, pitch). With sweep=False and a hint, only the hinted
    pitch is searched: a full sweep costs most of a second in Python."""
    if hint:
        ox, oy, p = hint
        if fits(width, ox, p) and has_magic(px, ox, oy, p):
            res = decode(px, ox, oy, p, width, height)
            if res and "error" not in res:
                return res, hint
            found, h = refine(px, width, height, ox, oy, p)
            return found, (h or hint)
    pitches = PITCH_GUESSES
    if hint:  # the strip moved: try the known pitch first
        pitches = [hint[2]] + ([p for p in PITCH_GUESSES if p != hint[2]] if sweep else [])
    # The first cells survive a wrong pitch (the drift only adds up further
    # along the row), so a magic hit at one pitch is not proof: keep going
    # until a pitch decodes, and only then report the first failure seen.
    failure = None
    for p in pitches:
        if not fits(width, 0, p):
            continue
        tried = set()
        for oy in range(YSLACK + 1):
            for ox in range(XSLACK + 1):
                if has_magic(px, ox, oy, p):
                    key = (ox // 3, oy // 3)
                    if key in tried:
                        continue
                    tried.add(key)
                    found, h = refine(px, width, height, ox, oy, p)
                    if h:
                        return found, h
                    if found and failure is None:
                        failure = found
    return failure, hint


# ---------------------------------------------------------------------------
# PNG in/out (tests, --probe, and screencapture output)
# ---------------------------------------------------------------------------

def read_png(path):
    data = open(path, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos, idat = 8, b""
    width = height = depth = ctype = None
    while pos < len(data):
        (n,) = struct.unpack(">I", data[pos:pos + 4])
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + n]
        pos += 12 + n
        if kind == b"IHDR":
            width, height, depth, ctype = struct.unpack(">IIBB", body[:10])
        elif kind == b"IDAT":
            idat += body
        elif kind == b"IEND":
            break
    if depth != 8 or ctype not in (2, 6):
        raise ValueError("only 8-bit RGB/RGBA PNGs are supported")
    bpp = 3 if ctype == 2 else 4
    raw = zlib.decompress(idat)
    stride = width * bpp
    rows, prev = [], bytearray(stride)
    for y in range(height):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if f == 1:
                line[i] = (line[i] + a) & 0xFF
            elif f == 2:
                line[i] = (line[i] + b) & 0xFF
            elif f == 3:
                line[i] = (line[i] + (a + b) // 2) & 0xFF
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        rows.append(line)
        prev = line

    def px(x, y):
        o = x * bpp
        row = rows[y]
        return row[o], row[o + 1], row[o + 2]
    return px, width, height


def write_png(path, px, width, height):
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            raw.extend(px(x, y))

    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
    with open(path, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
                 + chunk(b"IDAT", zlib.compress(bytes(raw))) + chunk(b"IEND", b""))


if args.test_image:
    px, w, h = read_png(args.test_image)
    msg, _ = find_and_decode(px, w, h, None)
    emit(msg if msg else {"error": "no valid strip in image"})
    sys.exit(0)


# ---------------------------------------------------------------------------
# macOS window discovery and screen capture
# ---------------------------------------------------------------------------

def run_osascript(script):
    """Write the AppleScript to a temp file and run it; multi-line scripts are
    unreliable when passed inline to osascript -e."""
    fd, path = tempfile.mkstemp(suffix=".scpt")
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(script)
        proc = subprocess.run(["osascript", path], capture_output=True, text=True, timeout=10)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "osascript failed")
    return proc.stdout.strip()


CG_WINDOWS_JXA = '''ObjC.import("CoreGraphics");
const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0));
const out = [];
for (let i = 0; i < list.count; i++) {
  const w = list.objectAtIndex(i);
  if (ObjC.unwrap(w.objectForKey("kCGWindowLayer")) !== 0) continue;
  const b = w.objectForKey("kCGWindowBounds");
  out.push([ObjC.unwrap(w.objectForKey("kCGWindowOwnerPID")),
            ObjC.unwrap(b.objectForKey("X")), ObjC.unwrap(b.objectForKey("Y")),
            ObjC.unwrap(b.objectForKey("Width")), ObjC.unwrap(b.objectForKey("Height")),
            ObjC.unwrap(w.objectForKey("kCGWindowOwnerName"))].join("\\t"));
}
out.join("\\n");'''


def game_pids(want):
    """PIDs of processes whose executable path contains the process name
    (the client runs as ".../World of Warcraft.app/Contents/MacOS/World of Warcraft")."""
    try:
        proc = subprocess.run(["pgrep", "-f", want], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return set()
    return {int(p) for p in proc.stdout.split() if p.strip().isdigit()}


def find_window_bounds_cg(want):
    """The game's largest on-screen window through CoreGraphics (JXA). Unlike
    System Events this needs no Accessibility permission: window bounds and
    owners are public. The owner is matched by PID, since the window server
    names the client "Wow" while its process is "World of Warcraft".
    Returns (x, y, w, h), None when no window is on screen, or raises."""
    pids = game_pids(want)
    proc = subprocess.run(["osascript", "-l", "JavaScript", "-e", CG_WINDOWS_JXA],
                          capture_output=True, text=True, timeout=10)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "osascript (JavaScript) failed")
    best = None
    for line in proc.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) < 6:
            continue
        try:
            pid = int(parts[0])
            x, y, w, h = (int(float(v)) for v in parts[1:5])
        except ValueError:
            continue
        if pid not in pids and want.lower() not in parts[5].lower():
            continue
        if w < 200 or h < 150:  # menus, tooltips, the Dock tile
            continue
        if best is None or w * h > best[2] * best[3]:
            best = (x, y, w, h)
    return best


def find_window_bounds():
    """Return (x, y, w, h) in screen points for the best matching window."""
    want = args.process_name
    title = args.window_name

    if not title:
        try:
            return find_window_bounds_cg(want)
        except (RuntimeError, OSError, subprocess.TimeoutExpired) as e:
            # Fall back to System Events (needs Accessibility) below.
            emit({"warn": "CoreGraphics window lookup failed (%s); trying System Events" % e})

    if title:
        script = '''tell application "System Events"
    set allProcs to every process
    repeat with p in allProcs
        try
            set wins to every window of p whose name contains "%s"
            if (count wins) > 0 then
                set w to item 1 of wins
                tell w
                    set {x, y} to position
                    set {ww, hh} to size
                end tell
                return (x as string) & "," & (y as string) & "," & (ww as string) & "," & (hh as string)
            end if
        end try
    end repeat
end tell
return ""''' % title.replace('"', '\\"')
    else:
        script = '''tell application "System Events"
    set pList to every process whose name contains "%s"
    if (count pList) = 0 then
        return ""
    end if
    set p to item 1 of pList
    tell p
        if not (exists front window) then
            return ""
        end if
        set w to front window
        tell w
            set {x, y} to position
            set {ww, hh} to size
        end tell
        return (x as string) & "," & (y as string) & "," & (ww as string) & "," & (hh as string)
    end tell
end tell
return ""''' % want.replace('"', '\\"')

    out = run_osascript(script)
    if not out:
        return None
    parts = out.split(",")
    if len(parts) != 4:
        return None
    return tuple(int(float(p.strip())) for p in parts)


def capture_region(x, y, w, h, out_path):
    """Use screencapture to grab a region of the screen into a PNG.
    Coordinates are in screen points (macOS logical coordinates); the resulting
    PNG is in device pixels, which is what the decoder expects."""
    cmd = [
        "screencapture",
        "-R%d,%d,%d,%d" % (int(x), int(y), int(w), int(h)),
        "-x",  # no sound
        out_path,
    ]
    subprocess.run(cmd, check=True, timeout=5)


def grab(out_path):
    """Find the WoW window, capture the top-left region, and return a pixel accessor."""
    bounds = find_window_bounds()
    if not bounds:
        return None
    x, y, ww, wh = bounds
    rw = min(args.region_w, ww)
    rh = min(args.region_h, wh)
    if rw <= 0 or rh <= 0:
        return None
    try:
        capture_region(x, y, rw, rh, out_path)
    except Exception as e:
        return {"error": "screencapture failed: %s" % e}
    return read_png(out_path)


def run():
    if args.probe:
        fd, tmp = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        try:
            g = grab(tmp)
            if g is None:
                emit({"error": "no game window found"})
                sys.exit(1)
            if isinstance(g, dict):
                emit(g)
                sys.exit(1)
            px, width, height = g
            write_png(args.probe, px, width, height)
            msg, off = find_and_decode(px, width, height, None)
            emit({"info": "saved %dx%d to %s" % (width, height, args.probe), "strip": msg, "offset": off})
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        return

    last_key = None
    last_warn = 0.0
    bounds = None
    bounds_at = 0
    hint = None
    last_sweep = 0.0
    while True:
        start = time.time()
        # Refresh window bounds every 5 s so moving/resizing the window is picked up.
        if bounds is None or start - bounds_at > 5:
            try:
                bounds = find_window_bounds()
            except (RuntimeError, subprocess.TimeoutExpired) as e:
                # Usually a missing permission: reading a window's position needs
                # Accessibility for the app the bridge runs in (-25211), listing
                # processes needs Automation for System Events (-1743).
                msg = str(e)
                if "-25211" in msg or "assistive access" in msg:
                    msg = ("macOS blocks reading the game window's position: allow the app the bridge runs in "
                           "(Terminal, iTerm, ...) under System Settings > Privacy & Security > Accessibility, "
                           "then restart it")
                elif "-1743" in msg or "not authorized" in msg.lower():
                    msg = ("macOS blocks System Events: allow the app the bridge runs in under System Settings > "
                           "Privacy & Security > Automation > System Events, then restart it")
                emit({"error": "window lookup failed: " + msg})
                bounds = None
                time.sleep(10)
                continue
            bounds_at = start
        if not bounds:
            emit({"info": "waiting for %s window" % (args.window_name or args.process_name)})
            time.sleep(3)
            continue
        x, y, ww, wh = bounds
        rw = min(args.region_w, ww)
        rh = min(args.region_h, wh)
        fd, tmp = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        try:
            try:
                capture_region(x, y, rw, rh, tmp)
            except Exception as e:
                emit({"warn": "screencapture failed: %s" % e})
                time.sleep(1)
                continue
            px, width, height = read_png(tmp)
            # Once a pitch is known, frames without a strip only re-check that
            # pitch; a full sweep (the window or game resolution may have
            # changed) runs at most every 15 s.
            sweep = hint is None or start - last_sweep >= 15
            if sweep:
                last_sweep = start
            msg, hint = find_and_decode(px, width, height, hint, sweep)
            if msg and msg.get("error"):
                if time.time() - last_warn >= 5:
                    last_warn = time.time()
                    emit({"warn": "strip seen but rejected: " + msg["error"]})
            elif msg:
                key = "%d:%s" % (msg["id"], msg["text"])
                if key != last_key:
                    last_key = key
                    emit(msg)
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        elapsed = time.time() - start
        sleep = max(0, args.interval_ms / 1000.0 - elapsed)
        if sleep:
            time.sleep(sleep)


try:
    run()
except KeyboardInterrupt:
    pass
