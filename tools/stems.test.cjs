const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./ui-test-harness.cjs');

function subject() {
  const s = setup();
  const channel = { id: 9, name: 'song', vol: 0.7, pan: -0.2, mix: 3, mute: false, solo: false,
    inst: { type: 'audio', sample: 'song.wav', path: 'C:/source/song.wav', pitch: 4, reverse: true, stretch_pitch: true } };
  const clip = { p: 0, ch: 9, track: 0, t: 768, l: 384, off: 96, rate: 0.75, gain: 0.8, fade_in: 24, fade_out: 48, mute: false };
  s.S.project.channels.push(channel); s.S.project.clips.push(clip);
  s.bus.emit('render');
  const calls = [];
  s.api.call = async (cmd, a) => {
    calls.push({ cmd, a });
    if (cmd === 'stems_start') return 'job1';
    if (cmd === 'stems_status') return { id: 'job1', running: false, phase: 'done', progress: 1,
      outputs: ['vocals', 'drums', 'bass', 'other'].map(stem => ({ stem, path: `C:/stems/${stem}.wav`, seconds: 10 })) };
    if (cmd === 'sample_wave') return { seconds: 10, peaks: [-0.1, 0.1] };
    return null;
  };
  return Object.assign(s, { clip, channel, calls });
}

test('the audio clip menu offers stem separation with four sources and a CPU explanation', () => {
  const s = subject();
  Object.assign(s.clip, { t: 0, off: 0, l: 768, fade_in: 0, fade_out: 0, gain: 1 });
  s.bus.emit('render');
  s.cv.emit('pointerdown', { clientX: 138, clientY: 30 });
  const item = s.getMenu().find(i => i.label?.includes('на стемы'));
  assert.ok(item); assert.equal(item.disabled, false);
  item.fn();
  const inputs = s.elements.filter(e => e.tag === 'input' && e.type === 'checkbox');
  assert.equal(inputs.length, 5, 'four stems plus keeping/muting the original');
  const text = s.elements.filter(e => e.nodeType === 1 && e.tag === 'p').flatMap(e => e.children).map(e => e.textContent).join(' ');
  assert.match(text, /CPU/); assert.match(text, /316/);
});

test('completed stems keep timing, trim, rate, fades, pitch, reverse, levels and routing; one undo restores everything', async () => {
  const s = subject(), P = s.S.project;
  s.channel.solo = true;
  const before = JSON.stringify(P);
  // Leave a busy and a muted lane below the source: both must be skipped.
  P.clips.push({ p: 1, track: 1, t: 768, l: 384 }); P.tracks[2].mute = true;
  const undoBefore = JSON.stringify(P);
  assert.equal(await s.Stems.start(s.clip), true);
  assert.equal(s.Stems.active, null);
  assert.equal(s.clip.mute, true);
  const results = P.clips.filter(c => c.ch && c.ch !== 9);
  assert.equal(results.length, 4);
  assert.deepEqual(Array.from(results, c => c.track), [3, 4, 5, 6]);
  for (const c of results) {
    for (const key of ['t', 'l', 'off', 'rate', 'gain', 'fade_in', 'fade_out']) assert.equal(c[key], s.clip[key], key);
    const ch = P.channels.find(ch => ch.id === c.ch);
    for (const key of ['mix', 'vol', 'pan', 'solo']) assert.equal(ch[key], s.channel[key], key);
    for (const key of ['pitch', 'reverse', 'stretch_pitch']) assert.equal(ch.inst[key], s.channel.inst[key], key);
    assert.match(ch.inst.path, /^C:\/stems\//);
  }
  assert.equal(s.channel.inst.path, 'C:/source/song.wav');
  assert.deepEqual(Array.from(s.calls.find(c => c.cmd === 'stems_start').a.stems), ['vocals', 'drums', 'bass', 'other']);
  s.undo(); assert.equal(JSON.stringify(s.S.project), undoBefore);
  s.redo(); assert.equal(s.S.project.clips.filter(c => c.ch && c.ch !== 9).length, 4);
  assert.notEqual(before, JSON.stringify(P));
});

test('chosen stems alone are imported and a kept original is not muted', async () => {
  const s = subject(); const call = s.api.call;
  s.api.call = async (cmd, a) => {
    const value = await call(cmd, a);
    if (cmd === 'stems_status') value.outputs = value.outputs.filter(o => o.stem === 'vocals');
    return value;
  };
  assert.equal(await s.Stems.start(s.clip, ['vocals'], false), true);
  assert.equal(s.clip.mute, false);
  assert.equal(s.S.project.clips.length, 2);
});

test('cancel during startup reaches the worker and never imports a clip or leaves the UI busy', async () => {
  const s = subject(); const call = s.api.call;
  let ready; const pending = new Promise(resolve => { ready = resolve; });
  s.api.call = async (cmd, a) => cmd === 'stems_start' ? pending : call(cmd, a);
  const before = JSON.stringify(s.S.project);
  const starting = s.Stems.start(s.clip);
  assert.equal(await s.Stems.start(s.clip), false, 'one job at a time');
  await s.Stems.cancel(); ready('job1');
  assert.equal(await starting, false);
  assert.ok(s.calls.some(c => c.cmd === 'stems_cancel' && c.a.id === 'job1'));
  assert.equal(s.Stems.active, null);
  assert.equal(JSON.stringify(s.S.project), before);
});

test('switching projects during separation cannot put old stems in the new project', async () => {
  const s = subject(); const call = s.api.call; const previous = s.S.project;
  s.api.call = async (cmd, a) => {
    if (cmd === 'stems_status') s.S.project = JSON.parse(JSON.stringify(previous));
    return call(cmd, a);
  };
  assert.equal(await s.Stems.start(s.clip), false);
  assert.equal(previous.clips.length, 1);
  assert.equal(s.S.project.clips.length, 1);
  assert.equal(s.clip.mute, false);
});

test('a failing model or invalid result leaves the project untouched and allows retry', async () => {
  for (const status of [{ error: 'not enough memory' }, { outputs: [] }]) {
    const s = subject(); const call = s.api.call;
    s.api.call = async (cmd, a) => cmd === 'stems_status' ? { id: 'job1', running: false, ...status } : call(cmd, a);
    const before = JSON.stringify(s.S.project);
    assert.equal(await s.Stems.start(s.clip), false);
    assert.equal(s.Stems.active, null);
    assert.equal(JSON.stringify(s.S.project), before);
    s.api.call = call;
    assert.equal(await s.Stems.start(s.clip), true);
  }
});

test('a source edited while processing keeps its edits and is not muted at the old position', async () => {
  const s = subject(); const call = s.api.call;
  s.api.call = async (cmd, a) => { if (cmd === 'stems_status') s.clip.t = 1152; return call(cmd, a); };
  assert.equal(await s.Stems.start(s.clip), true);
  assert.equal(s.clip.mute, false); assert.equal(s.clip.t, 1152);
  assert.ok(s.S.project.clips.filter(c => c.ch && c.ch !== 9).every(c => c.t === 768));
});
