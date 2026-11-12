// Import Claude Code sessions into game chats (/wow-ai import).
//
// Sources, in order:
//   - a session id typed after the command: that one session;
//   - otherwise the lists the "Claude Sessions Keeper" editor extension saves per
//     workspace (Cursor or VS Code workspaceState, key local.claude-sessions-keeper).
// Each session becomes a chat bound to its id, so the chat's next message runs
// `claude --resume <id>` in the session's folder. The last few exchanges of the
// session's transcript come along so the chat doesn't start blank.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const KEEPER_KEY = 'local.claude-sessions-keeper';
const SNAPSHOT_KEY = 'claudeSessions.snapshot';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AGE_MS = 3 * 24 * 3600 * 1000;
const MESSAGES = 20;
const MESSAGE_CHARS = 2000;

function projectsDir() { return path.join(os.homedir(), '.claude', 'projects'); }

// workspaceStorage folders of the editors the extension runs in.
function editorStorageDirs() {
  const home = os.homedir();
  const base = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : process.platform === 'win32' ? (process.env.APPDATA || path.join(home, 'AppData', 'Roaming'))
    : path.join(home, '.config');
  return ['Cursor', 'Code'].map(app => path.join(base, app, 'User', 'workspaceStorage'));
}

// One value from a VS Code state database, read-only. node:sqlite where the
// runtime has it, else the sqlite3 command-line tool.
function readStateKey(dbFile, key) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
      return row ? String(row.value) : null;
    } finally { db.close(); }
  } catch (e) {
    if (e && e.code !== 'ERR_UNKNOWN_BUILTIN_MODULE' && e.code !== 'MODULE_NOT_FOUND') return null;
  }
  try {
    const out = execFileSync('sqlite3', ['-readonly', dbFile, `SELECT value FROM ItemTable WHERE key = '${key.replace(/'/g, "''")}'`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return out.trim() || null;
  } catch { return null; }
}

// Every saved snapshot: [{ workspace, savedAt, sessions: [{ sessionId, cwd, title, preview }] }].
function readSnapshots(dirs = editorStorageDirs()) {
  const out = [];
  for (const dir of dirs) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const dbFile = path.join(dir, name, 'state.vscdb');
      if (!fs.existsSync(dbFile)) continue;
      const raw = readStateKey(dbFile, KEEPER_KEY);
      if (!raw) continue;
      let snap;
      try { snap = JSON.parse(raw)[SNAPSHOT_KEY]; } catch { continue; }
      if (!snap || !Array.isArray(snap.sessions)) continue;
      let workspace = '';
      try { workspace = decodeURIComponent(JSON.parse(fs.readFileSync(path.join(dir, name, 'workspace.json'), 'utf8')).folder || '').replace(/^file:\/\//, ''); } catch {}
      out.push({ workspace, savedAt: Number(snap.savedAt) || 0, sessions: snap.sessions.filter(s => s && UUID_RE.test(s.sessionId || '')) });
    }
  }
  return out;
}

function findTranscript(sessionId, dir = projectsDir()) {
  let dirs;
  try { dirs = fs.readdirSync(dir); } catch { return null; }
  for (const d of dirs) {
    const p = path.join(dir, d, sessionId + '.jsonl');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Text a user entry was typed as, or '' for tool results, meta and command noise.
function userText(e) {
  if (e.isMeta || e.isSidechain) return '';
  const c = e.message && e.message.content;
  let text = typeof c === 'string' ? c
    : Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => b.text).join('\n') : '';
  text = text.trim();
  if (!text || /^<(command-|local-command|system-reminder|bash-|task-notification)/.test(text) || text.startsWith('Caveat:')) return '';
  return text;
}

function assistantText(e) {
  if (e.isSidechain) return '';
  const c = e.message && e.message.content;
  if (!Array.isArray(c)) return '';
  return c.filter(b => b && b.type === 'text').map(b => b.text).join('\n').trim();
}

// The session's title (last /rename, else the last automatic one), its folder,
// and its last few user/assistant messages (consecutive assistant pieces of one
// turn joined).
function readTranscript(file, { limit = MESSAGES, chars = MESSAGE_CHARS } = {}) {
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const messages = [];
  let custom = '', ai = '', cwd = '';
  for (const line of src.split('\n')) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'custom-title' && e.customTitle) custom = e.customTitle;
    else if (e.type === 'ai-title' && e.aiTitle) ai = e.aiTitle;
    if (e.cwd && !e.isSidechain) cwd = e.cwd;
    const role = e.type === 'user' ? 'user' : e.type === 'assistant' ? 'assistant' : '';
    if (!role) continue;
    const text = role === 'user' ? userText(e) : assistantText(e);
    if (!text) continue;
    const t = Math.floor((Date.parse(e.timestamp) || 0) / 1000);
    const last = messages[messages.length - 1];
    if (last && last.role === 'assistant' && role === 'assistant') { last.text += '\n\n' + text; last.t = t || last.t; }
    else messages.push({ role, text, t });
  }
  const tail = messages.slice(-limit).map(m => ({
    role: m.role, t: m.t, agent: m.role === 'assistant' ? 'claude' : '',
    text: m.text.length > chars ? m.text.slice(0, chars - 1) + '…' : m.text,
  }));
  return { title: custom || ai, cwd, messages: tail };
}

// Messages appended to a transcript since byte `offset`, typed or answered
// outside the bridge (another terminal, the editor): the bridge's own runs are
// marked entrypoint "sdk-cli" and skipped, since the game already has them. Only
// whole lines are read; the returned offset stops before a line still being written.
function readNewMessages(file, offset, { chars = MESSAGE_CHARS } = {}) {
  let size;
  try { size = fs.statSync(file).size; } catch { return { offset, messages: [] }; }
  if (size < offset) offset = 0; // rewritten
  if (size === offset) return { offset, messages: [] };
  const buf = Buffer.alloc(size - offset);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
  const end = buf.lastIndexOf(0x0a);
  if (end < 0) return { offset, messages: [] };
  const messages = [];
  for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.entrypoint === 'sdk-cli') continue;
    const role = e.type === 'user' ? 'user' : e.type === 'assistant' ? 'assistant' : '';
    if (!role) continue;
    const text = role === 'user' ? userText(e) : assistantText(e);
    if (!text) continue;
    const t = Math.floor((Date.parse(e.timestamp) || Date.now()) / 1000);
    const last = messages[messages.length - 1];
    if (last && last.role === 'assistant' && role === 'assistant') { last.text += '\n\n' + text; last.t = t; }
    else messages.push({ role, text, t, agent: role === 'assistant' ? 'claude' : '' });
  }
  for (const m of messages) if (m.text.length > chars) m.text = m.text.slice(0, chars - 1) + '…';
  return { offset: offset + end + 1, messages };
}

// Sessions to import for `filter`:
//   - a session id: just that one;
//   - otherwise every session in snapshots saved within maxAgeMs, newest snapshot
//     first, deduplicated, whose folder contains `filter` (case-insensitive) if given.
// `attached` holds session ids some chat already uses; they are skipped.
// Returns { sessions: [{ sessionId, cwd, title, messages }], note }.
function collect(filter, { attached = new Set(), now = Date.now(), maxAgeMs = MAX_AGE_MS, snapshots, transcriptFor = findTranscript, room = 16 } = {}) {
  filter = String(filter || '').trim();
  const picked = [];
  let skipped = 0, missing = 0;
  if (UUID_RE.test(filter)) {
    picked.push({ sessionId: filter.toLowerCase(), cwd: '', title: '' });
  } else {
    const snaps = (snapshots || readSnapshots())
      .filter(s => now - s.savedAt <= maxAgeMs)
      .sort((a, b) => b.savedAt - a.savedAt);
    if (!snaps.length) return { sessions: [], note: 'No saved Claude sessions from the last 3 days were found (the Claude Sessions Keeper extension saves them in Cursor or VS Code).' };
    const seen = new Set();
    const f = filter.toLowerCase();
    for (const snap of snaps) {
      for (const s of snap.sessions) {
        if (seen.has(s.sessionId)) continue;
        seen.add(s.sessionId);
        if (f && !String(s.cwd || '').toLowerCase().includes(f)) continue;
        picked.push({ sessionId: s.sessionId, cwd: s.cwd || '', title: s.title || s.preview || '' });
      }
    }
    if (!picked.length) return { sessions: [], note: `No saved Claude sessions have a folder matching "${filter}".` };
  }
  const sessions = [];
  for (const p of picked) {
    if (attached.has(p.sessionId)) { skipped++; continue; }
    const file = transcriptFor(p.sessionId);
    const tr = file && readTranscript(file);
    if (!tr) { missing++; continue; }
    sessions.push({ sessionId: p.sessionId, cwd: p.cwd || tr.cwd, title: tr.title || p.title || p.sessionId.slice(0, 8), messages: tr.messages });
  }
  let over = 0;
  if (sessions.length > room) { over = sessions.length - room; sessions.length = Math.max(0, room); }
  const notes = [];
  if (skipped) notes.push(`${skipped} already open in a chat`);
  if (missing) notes.push(`${missing} without a transcript on this computer`);
  if (over) notes.push(`${over} left out: the chat list is full`);
  return { sessions, note: notes.length ? 'Skipped ' + notes.join(', ') + '.' : '' };
}

module.exports = { collect, readSnapshots, readTranscript, readNewMessages, findTranscript, editorStorageDirs, UUID_RE };
