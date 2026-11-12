'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SF = require('../bridge/signal_files');

const small = { slots: 2, actMax: 2, stepMax: 1, presenceMax: 3, syncMax: 2 };

function tmpAddons() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-sf-'));
  for (const f of SF.signalFiles(dir, small)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ''); }
  return dir;
}

test('signalFiles lists every polled file once, ctl/empty.wav last', () => {
  const files = SF.signalFiles('/a', small);
  assert.equal(files.length, 2 * (2 + 2 + 1) + 3 + 2 + 1);
  assert.equal(new Set(files).size, files.length);
  assert.equal(files[files.length - 1], path.join('/a', 'WoWAI', 'ctl', 'empty.wav'));
  assert.ok(files.includes(path.join('/a', 'WoWAI', 'act', '002', '02.wav')));
});

test('clear deletes empty signal files and keeps raised ones; restore brings them back empty', () => {
  const dir = tmpAddons();
  const files = SF.signalFiles(dir, small);
  const raised = path.join(dir, 'WoWAI', 'presence', '0001.wav');
  fs.writeFileSync(raised, 'RIFF');
  assert.equal(SF.clear(files), files.length - 1);
  assert.ok(fs.existsSync(raised), 'a raised signal stays');
  assert.ok(!fs.existsSync(path.join(dir, 'WoWAI', 'ctl', 'empty.wav')), 'the done marker is gone');
  assert.equal(SF.restore(files), files.length - 1);
  assert.equal(fs.readFileSync(path.join(dir, 'WoWAI', 'sig', '001.wav')).length, 0);
  assert.equal(fs.readFileSync(raised, 'utf8'), 'RIFF', 'restore leaves existing files alone');
});

test('setOff empties or deletes by style', () => {
  const dir = tmpAddons();
  const f = path.join(dir, 'WoWAI', 'ack', '001.wav');
  fs.writeFileSync(f, 'RIFF');
  SF.setOff(f, 'empty', (file, buf) => fs.writeFileSync(file, buf));
  assert.equal(fs.statSync(f).size, 0);
  SF.setOff(f, 'absent');
  assert.ok(!fs.existsSync(f));
  assert.equal(SF.defaultStyle('darwin'), 'absent');
  assert.equal(SF.defaultStyle('win32'), 'empty');
});
