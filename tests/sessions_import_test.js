// /wow-ai import: reading a Claude transcript, picking sessions from editor
// snapshots, and the import bundle in the slot file.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const SI = require('../bridge/sessions_import');
const P = require('../bridge/protocol');

const TMP = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP, { recursive: true });

const A = '11111111-2222-3333-4444-555555555555';
const B = '66666666-7777-8888-9999-000000000000';

function transcript(file, entries) {
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

const user = (text, extra = {}) => ({ type: 'user', cwd: '/w/proj', timestamp: '2026-11-12T10:00:00Z', message: { role: 'user', content: text }, ...extra });
const said = text => ({ type: 'assistant', cwd: '/w/proj', timestamp: '2026-11-12T10:00:05Z', message: { role: 'assistant', content: [{ type: 'text', text }] } });

test('readTranscript keeps typed messages, joins a turn and takes the latest title', () => {
  const file = transcript(path.join(TMP, 'tr_a.jsonl'), [
    { type: 'ai-title', aiTitle: 'auto title' },
    user('first question'),
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x' }, { type: 'tool_use', name: 'Bash' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'out' }] } },
    said('part one'),
    said('part two'),
    user('<command-name>/model</command-name>'),
    user('<task-notification>done</task-notification>'),
    user('meta', { isMeta: true }),
    user('second question'),
    { type: 'custom-title', customTitle: 'My title' },
  ]);
  const tr = SI.readTranscript(file);
  assert.equal(tr.title, 'My title');
  assert.equal(tr.cwd, '/w/proj');
  assert.deepEqual(tr.messages.map(m => [m.role, m.text]), [
    ['user', 'first question'], ['assistant', 'part one\n\npart two'], ['user', 'second question'],
  ]);
  assert.equal(tr.messages[1].agent, 'claude');
  assert.equal(SI.readTranscript(file, { limit: 1 }).messages.length, 1);
});

test('collect picks recent snapshots, filters by folder and skips attached sessions', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  const files = { [A]: transcript(path.join(TMP, 'tr_ca.jsonl'), [user('a?'), said('a!')]), [B]: transcript(path.join(TMP, 'tr_cb.jsonl'), [user('b?')]) };
  const snapshots = [
    { workspace: '/w/rm', savedAt: now - 3600e3, sessions: [{ sessionId: A, cwd: '/w/rm/core', title: 'Task A' }, { sessionId: B, cwd: '/w/rm/clu', title: 'Task B' }] },
    { workspace: '/w/old', savedAt: now - 10 * 86400e3, sessions: [{ sessionId: '99999999-2222-3333-4444-555555555555', cwd: '/w/old' }] },
  ];
  const opts = { now, snapshots, transcriptFor: id => files[id] || null };
  let r = SI.collect('', opts);
  assert.deepEqual(r.sessions.map(s => [s.sessionId, s.cwd, s.title]), [[A, '/w/rm/core', 'Task A'], [B, '/w/rm/clu', 'Task B']]);
  assert.equal(r.note, '');
  r = SI.collect('CLU', opts);
  assert.deepEqual(r.sessions.map(s => s.sessionId), [B]);
  r = SI.collect('', { ...opts, attached: new Set([A]) });
  assert.deepEqual(r.sessions.map(s => s.sessionId), [B]);
  assert.match(r.note, /1 already open/);
  r = SI.collect('', { ...opts, room: 1 });
  assert.equal(r.sessions.length, 1);
  assert.match(r.note, /1 left out/);
  r = SI.collect('nowhere', opts);
  assert.equal(r.sessions.length, 0);
  assert.match(r.note, /nowhere/);
  // A session id imports that one session, wherever it was saved.
  r = SI.collect(B.toUpperCase(), { ...opts, snapshots: [] });
  assert.deepEqual(r.sessions.map(s => [s.sessionId, s.cwd]), [[B, '/w/proj']]);
  assert.match(SI.collect('', { ...opts, snapshots: [] }).note, /No saved Claude sessions/);
});

test('the import flags and bundle travel through the strip and the slot file', () => {
  const [job] = P.jobsFromStrip(5, ['tok', '', '5', '', 'i;room=7', '', 'rmbo-core'].join('\x1F'));
  assert.equal(job.import, true);
  assert.equal(job.room, 7);
  assert.equal(job.text, 'rmbo-core');
  const lua = P.luaTable('WoWAI_SlotData', [], { import: { token: 'tok', id: 5, note: 'Skipped "x".', chats: [
    { id: 'abc', name: 'Task', cwd: '/w', agent: 'claude', dev: true, messages: [{ role: 'user', id: 0, t: 1, text: 'hi' }] },
  ] } });
  assert.match(lua, /import = \{/);
  assert.match(lua, /agent = "claude",/);
  assert.match(lua, /dev = true,/);
  assert.match(lua, /note = "Skipped \\"x\\"\.",/);
});
