// Piano roll tools, with the real handlers on a small DOM/canvas adapter.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./ui-test-harness.cjs');

const plain = x => JSON.parse(JSON.stringify(x));
function roll() {
  const s = setup({ roll: true });
  // the roll's own canvas (the playlist made the first two)
  s.rcv = s.elements.filter(e => e.tag === 'canvas')[2];
  s.notes = () => s.S.project.patterns[0].notes[s.S.curCh] || (s.S.project.patterns[0].notes[s.S.curCh] = []);
  s.put = list => { s.S.project.patterns[0].notes[s.S.curCh] = list.map(n => ({ v: 0.78, ...n })); s.bus.emit('render'); return s.notes(); };
  s.key = ev => s.Roll.key({ key: '', ctrlKey: false, altKey: false, shiftKey: false, repeat: false, ...ev });
  return s;
}

test('quick quantize puts starts on the grid; quick legato fills up to the next note', () => {
  const s = roll();
  s.put([{ t: 5, l: 10, k: 60 }, { t: 30, l: 10, k: 62 }]);
  s.key({ altKey: true, code: 'KeyQ' });
  assert.deepEqual(plain(s.notes().map(n => n.t)), [0, 24]);
  s.put([{ t: 0, l: 10, k: 60 }, { t: 0, l: 10, k: 64 }, { t: 48, l: 10, k: 62 }, { t: 96, l: 10, k: 65 }]);
  s.key({ ctrlKey: true, code: 'KeyL' });
  assert.deepEqual(plain(s.notes().map(n => n.l)), [48, 48, 48, 10], 'the last note keeps its length');
});

test('strumizer spreads each chord, low to high, ends staying', () => {
  const s = roll();
  s.put([{ t: 0, l: 96, k: 67 }, { t: 0, l: 96, k: 60 }, { t: 0, l: 96, k: 64 }]);
  s.key({ altKey: true, code: 'KeyS' });
  const by = k => s.notes().find(n => n.k === k);
  // a step (24 ticks) over three notes: 0, 12, 24
  assert.deepEqual(plain([by(60).t, by(64).t, by(67).t]), [0, 12, 24]);
  assert.deepEqual(plain([by(60).t + by(60).l, by(67).t + by(67).l]), [96, 96]);
  s.closeMenu ? s.closeMenu() : null;
});

test('scale lock: keys outside the chosen scale play the nearest note inside it', () => {
  const s = roll();
  assert.equal(s.kbSnap(61), 61, 'no scale: every key is itself');
  s.S.project.scale = { mode: 'major', root: 0 };
  assert.deepEqual(plain([60, 61, 63, 66, 68, 70, 71].map(s.kbSnap)), [60, 60, 62, 65, 67, 69, 71], 'C major, a tie goes down');
  s.S.project.scale = { mode: 'minor', root: 9 };
  assert.deepEqual(plain([57, 58, 59, 60, 61, 62, 63].map(s.kbSnap)), [57, 57, 59, 60, 60, 62, 62], 'A minor');
  const out = [...Array(128).keys()].map(s.kbSnap);
  assert.ok(out.every(k => [0, 2, 3, 5, 7, 8, 10].includes(((k - 9) % 12 + 12) % 12) || k <= 1), 'only scale notes come out');
});

test('chopper cuts notes into grid pieces, once however often the length changes', () => {
  const s = roll();
  s.put([{ t: 0, l: 96, k: 60 }]);
  s.key({ altKey: true, code: 'KeyU' });
  assert.equal(s.notes().length, 4, 'four steps');
  assert.deepEqual(plain(s.notes().map(n => [n.t, n.l])), [[0, 24], [24, 24], [48, 24], [72, 24]]);
});

test('randomizer sets velocities inside the range and pans within the spread', () => {
  const s = roll();
  const ns = s.put(Array.from({ length: 20 }, (_, i) => ({ t: i * 24, l: 24, k: 60 })));
  s.Roll.randomizer();
  assert.ok(ns.every(n => n.v >= 0.5 && n.v <= 1), 'between 50 and 100%');
  assert.ok(ns.every(n => Math.abs(n.p) <= 0.4 + 1e-9));
  assert.ok(new Set(ns.map(n => n.v)).size > 3, 'they differ');
});

test('Alt+wheel turns the selected notes up; a double right-click on a ghost opens its channel', () => {
  const s = roll();
  const ns = s.put([{ t: 0, l: 24, k: 60 }, { t: 24, l: 24, k: 62 }]);
  s.Roll.select(ns);
  const g = s.Roll.geom;
  s.rcv.emit('wheel', { altKey: true, deltaY: -100, clientX: g.xOf(4), clientY: g.yOf(60) + 5 });
  assert.ok(ns.every(n => Math.abs(n.v - 0.82) < 1e-9), JSON.stringify(ns));
  // channel 2 has a note on beat 2, in view: two right-clicks on it
  const other = s.S.project.channels[1].id;
  s.S.project.patterns[0].notes[other] = [{ t: 96, l: 24, k: 63, v: 0.8 }];
  s.bus.emit('render');
  const at = { button: 2, clientX: g.xOf(100), clientY: g.yOf(63) + 5 };
  s.rcv.emit('pointerdown', at);
  s.rcv.emit('pointerdown', at);
  assert.equal(s.S.curCh, other);
});

test('the ruler makes the pattern loop; the engine gets it', () => {
  const s = roll();
  s.put([]);
  const g = s.Roll.geom;
  s.rcv.emit('pointerdown', { button: 2, clientX: g.xOf(96), clientY: 10 });
  s.rcv.emit('pointermove', { button: 2, clientX: g.xOf(288), clientY: 10 });
  s.rcv.emit('pointerup', { button: 2, clientX: g.xOf(288), clientY: 10 });
  assert.deepEqual(plain(s.S.project.pat_loop), { start: 96, end: 288, enabled: true });
  assert.equal(s.normalize(plain(s.S.project)).pat_loop.end, 288);
});

test('the cut tool slices the note under the line', () => {
  const s = roll();
  s.put([{ t: 0, l: 96, k: 60 }]);
  // the roll's own (the playlist has one too)
  const cut = s.elements.filter(e => e.tag === 'button' && String(e.textContent || '').includes('резать')).pop();
  cut.emit('click');
  const g = s.Roll.geom;
  s.rcv.emit('pointerdown', { clientX: g.xOf(48) + 1, clientY: g.yOf(60) + 5 });
  s.rcv.emit('pointerup', { clientX: g.xOf(48) + 1, clientY: g.yOf(60) + 5 });
  assert.deepEqual(plain(s.notes().map(n => [n.t, n.l])), [[0, 48], [48, 48]]);
});

test('MIDI: a file becomes channels and a pattern, or notes in the roll; a pattern goes back out', async () => {
  const s = roll();
  const file = { path: 'C:/m/song.mid', name: 'song', file: { bpm: 90, tracks: [
    { name: 'lead', channel: 0, notes: [{ t: 0, l: 96, k: 60, v: 0.8 }] },
    { name: 'kick', channel: 9, notes: [{ t: 0, l: 24, k: 36, v: 1 }, { t: 384, l: 24, k: 36, v: 1 }] },
  ] } };
  let sent = null;
  s.api.call = async (cmd, a) => cmd === 'midi_import' ? file : cmd === 'midi_export' ? (sent = a, 'C:/out.mid') : null;
  const P = s.S.project;
  const chans = P.channels.length;
  await s.Midi.import(null, 'new');
  assert.equal(P.bpm, 90, 'an empty project takes the file\'s tempo');
  const pat = P.patterns.at(-1);
  assert.equal(pat.name, 'song');
  assert.equal(pat.bars, 2);
  assert.deepEqual(plain(P.channels.slice(chans).map(c => c.name)), ['lead', 'kick (drums)']);
  assert.equal(s.S.curPat, pat.id);
  // into the roll: the notes of every track go to the channel it shows
  const lead = P.channels[chans].id;
  s.S.curCh = lead;
  await s.Midi.import(null, 'roll');
  assert.equal(pat.notes[lead].length, 4);
  assert.equal(P.bpm, 90);
  // dropped on a channel's rack row (say Serum's): into that channel, which becomes current
  const kick = P.channels[chans + 1].id;
  const row = { closest: sel => sel === '.rack-row' ? { dataset: { ch: String(kick) } } : null };
  assert.equal(s.Midi.targetOf(row), kick);
  assert.equal(s.Midi.targetOf(null), 'new');
  await s.Midi.import(null, s.Midi.targetOf(row));
  assert.equal(pat.notes[kick].length, 5);
  assert.equal(s.S.curCh, kick);
  assert.equal(pat.notes[lead].length, 4);
  await s.Midi.exportPattern();
  assert.deepEqual(plain(sent.tracks.map(t => [t.name, t.notes.length])), [['lead', 4], ['kick (drums)', 5]]);
});
