// Exercise actual playlist pointer handlers with a small DOM/canvas adapter.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./ui-test-harness.cjs');

function gesture(cv, from, to, extra = {}) {
  cv.emit('pointerdown', { clientX: from[0], clientY: from[1], ...extra });
  if (to) cv.emit('pointermove', { clientX: to[0], clientY: to[1], ...extra });
  cv.emit('pointerup', { clientX: (to || from)[0], clientY: (to || from)[1], ...extra });
}

test('plain left-click and drag set the start without creating or resizing a loop', () => {
  const s = setup();
  gesture(s.cv, [128 + 80 * 4 + 2, 12]);
  assert.equal(s.S.songStart, 384 * 4);
  assert.equal(s.S.project.clips.length, 0);
  gesture(s.cv, [128 + 80, 12], [128 + 240, 12]);
  assert.equal(s.S.project.loop_region, null);
  s.S.project.loop_region = { start: 384, end: 1152, enabled: true };
  gesture(s.cv, [128 + 240, 12], [128 + 320, 12]);
  assert.equal(s.S.project.loop_region.end, 1152);
});

test('dragging the ruler creates a loop, supports resizing, undo and toggling', () => {
  const s = setup();
  gesture(s.cv, [128 + 80, 12], [128 + 240, 12], { button: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(s.S.project.loop_region)), { start: 384, end: 1152, enabled: true });
  assert.equal(s.S.songStart, 384);
  gesture(s.cv, [128 + 240, 12], [128 + 320, 12], { shiftKey: true });
  assert.equal(s.S.project.loop_region.end, 1536);
  s.undo(); assert.equal(s.S.project.loop_region.end, 1152);
  s.redo(); assert.equal(s.S.project.loop_region.end, 1536);
  s.Playlist.key({ key: 'l' }); assert.equal(s.S.project.loop_region.enabled, false);
});

test('a picked audio channel is placed by clicks on empty space until a pattern is picked again', async () => {
  const s = setup();
  s.api.call = async cmd => cmd === 'sample_wave' ? { seconds: 1, peaks: [] } : null;
  s.S.project.channels.push({ id: 9, name: 'vox', vol: 0.8, pan: 0, mute: false, solo: false, mix: 0, inst: { type: 'audio', sample: 'vox.wav', path: 'C:/vox.wav' } });
  await s.Waves.load('vox.wav', 'C:/vox.wav');
  s.bus.emit('render');
  const item = s.elements.find(e => e['data-ach'] === 9);
  assert.ok(item, 'the audio channel is listed in the picker');
  const previews = [];
  const call = s.api.call;
  s.api.call = async (cmd, a) => { if (cmd === 'preview') previews.push(a); return call(cmd, a); };
  item.emit('click');
  assert.equal(s.S.placeCh, 9);
  assert.equal(previews.length, 0, 'a click picks the sound without playing it');
  gesture(s.cv, [128 + 80 * 2 + 4, 45]);
  gesture(s.cv, [128 + 80 * 5 + 4, 45]);
  const audio = s.S.project.clips.filter(c => c.ch === 9);
  assert.equal(audio.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(audio.map(c => c.t))), [768, 1920]);
  assert.equal(audio[0].l, Math.ceil(1 / (60 / (s.S.project.bpm * 96))));
  // clicking a pattern clip makes the pattern the choice again
  s.S.project.clips.push({ p: 1, track: 1, t: 0, l: 384, off: 0 }); s.bus.emit('render');
  gesture(s.cv, [128 + 20, 45 + 48]);
  assert.equal(s.S.placeCh, 0);
  gesture(s.cv, [128 + 80 * 8 + 4, 45]);
  assert.equal(s.S.project.clips.at(-1).p, 1);
  assert.equal(s.S.project.clips.at(-1).ch, undefined);
});

test('an audio clip cannot be dragged longer than its sound', async () => {
  const s = setup();
  s.api.call = async cmd => cmd === 'sample_wave' ? { seconds: 1, peaks: [] } : null;
  s.S.project.channels.push({ id: 9, name: 'vox', vol: 1, pan: 0, mute: false, solo: false, mix: 0, inst: { type: 'audio', sample: 'vox.wav', path: 'C:/vox.wav' } });
  await s.Waves.load('vox.wav', 'C:/vox.wav');
  const whole = Math.ceil(1 / (60 / (s.S.project.bpm * 96)));
  const c = { p: 0, ch: 9, track: 0, t: 0, l: 100, off: 0, rate: 1, gain: 1, fade_in: 0, fade_out: 0 };
  s.S.project.clips.push(c); s.bus.emit('render');
  gesture(s.cv, [128 + 100 * 80 / 384 - 3, 45], [128 + 900, 45], { altKey: true });
  assert.equal(c.l, whole, 'stops at the end of the sound');
  // a pattern clip is free
  const p = { p: 1, track: 1, t: 0, l: 100, off: 0 };
  s.S.project.clips.push(p); s.bus.emit('render');
  gesture(s.cv, [128 + 100 * 80 / 384 - 3, 45 + 48], [128 + 900, 45 + 48], { altKey: true });
  assert.ok(p.l > whole);
});

test('middle-mouse panning reaches beyond the old timeline boundary and suspends following', () => {
  const s = setup();
  s.S.playing = true; s.S.mode = 'song'; s.S.pos = 0;
  s.Playlist.follow();
  gesture(s.cv, [500, 200], [-4000, 100], { button: 1 });
  const x = s.Playlist.xOfTick(0);
  assert.ok(x < -4000);
  assert.equal(s.S.project.clips.length, 0);
  // panning by hand during playback lets go of the view
  s.Playlist.follow(); assert.equal(s.Playlist.xOfTick(0), x);
  // the next start follows again
  s.S.playing = false; s.Playlist.follow();
  s.S.playing = true; s.Playlist.follow();
  assert.ok(s.Playlist.xOfTick(0) > x);
});

test('following is smooth: the view scrolls so the playhead stays put once it reaches the anchor', () => {
  const s = setup();
  s.S.playing = true; s.S.mode = 'song';
  s.S.pos = 0; s.Playlist.follow();
  assert.equal(s.Playlist.xOfTick(0), 128);
  s.S.pos = 384 * 40; s.Playlist.follow();
  const a = s.Playlist.xOfTick(s.S.pos);
  s.S.pos += 96; s.Playlist.follow();
  assert.ok(Math.abs(s.Playlist.xOfTick(s.S.pos) - a) < 1);
});

test('Alt moves clips freely between grid lines', () => {
  const s = setup();
  const c = { p: 1, track: 0, t: 384, l: 384, off: 0 };
  s.S.project.clips.push(c); s.bus.emit('render');
  gesture(s.cv, [128 + 80 + 30, 45], [128 + 80 + 40, 45], { altKey: true });
  assert.equal(c.t, 432); // 10 pixels = 48 ticks, with a one-bar grid enabled
});

test('automation lanes sit under their track: clicks add points, a drag moves a line, right-click deletes', () => {
  const s = setup();
  s.Playlist.showLane({ kind: 'mix_vol', track: 1 }, '', 0);
  s.bus.emit('render');
  const lane = s.S.project.automation[0];
  assert.equal(s.S.project.tracks[0].auto, true);
  // track 0 is 48 px high from y 24; its lane follows, 43 px (5 px padding top and bottom)
  const top = 24 + 48, h = 43, yOfV = v => top + 5 + (1 - v) * (h - 11);
  gesture(s.cv, [128 + 80 + 3, yOfV(0.5)]);
  gesture(s.cv, [128 + 80 * 3 + 3, yOfV(1)]);
  assert.deepEqual(JSON.parse(JSON.stringify(lane.points.map(p => [p.t, Math.round(p.v * 100) / 100]))), [[384, 0.5], [1152, 1]]);
  // the line between them, dragged down by a quarter of the lane, moves both points
  gesture(s.cv, [128 + 80 * 2, yOfV(0.75)], [128 + 80 * 2, yOfV(0.75) + (h - 10) / 4]);
  assert.ok(Math.abs(lane.points[0].v - 0.25) < 0.03 && Math.abs(lane.points[1].v - 0.75) < 0.03, JSON.stringify(lane.points));
  // right-click on a point deletes it
  gesture(s.cv, [128 + 80 * 3, yOfV(lane.points[1].v)], null, { button: 2 });
  assert.equal(lane.points.length, 1);
  // a click on the track row under the lane still places a clip on track 1
  gesture(s.cv, [128 + 80 * 5 + 4, top + h + 20]);
  assert.equal(s.S.project.clips.at(-1).track, 1);
  // the engine gets the lane in the project
  const sent = JSON.parse(JSON.stringify(s.S.project.automation));
  assert.equal(sent[0].target.kind, 'mix_vol');
});

test('moving an automated fader by hand overrides its lane until automation is re-enabled', () => {
  const s = setup({ mixer: true });
  s.Playlist.showLane({ kind: 'mix_vol', track: 1 }, '', 0);
  const lane = s.S.project.automation[0];
  lane.points.push({ t: 0, v: 0.2, c: 0 });
  s.S.mode = 'song';
  s.bus.emit('render');
  const fader = s.elements.filter(e => e.className === 'mx-track')[1];
  fader.emit('pointerdown', { button: 1 });
  assert.equal(s.S.project.mixer[1].vol, 1, 'a middle-click puts the fader to 0 dB');
  assert.equal(lane.on, false);
  s.Auto.reEnable();
  assert.equal(s.S.project.automation[0].on, true);
  s.undo();
  assert.equal(s.S.project.automation[0].on, false, 're-enable is one undo step');
});

test('lane values match the engine: held ends, jumps and bends', () => {
  const s = setup();
  const p = (t, v, c = 0) => ({ t, v, c });
  const pts = [p(100, 0.2), p(200, 0.6), p(200, 1), p(300, 0)];
  assert.equal(s.Auto.value(pts, 0), 0.2);
  assert.ok(Math.abs(s.Auto.value(pts, 150) - 0.4) < 1e-9);
  assert.equal(s.Auto.value(pts, 200), 1);
  assert.equal(s.Auto.value(pts, 999), 0);
  assert.ok(s.Auto.value([p(0, 0, 1), p(100, 1)], 50) > 0.8);
  assert.ok(Math.abs(s.Auto.toParam({ kind: 'mix_vol' }, 0.5) - Math.pow(0.5, 2.2) * 1.25) < 1e-9);
  const n = s.normalize({ automation: [{ id: 3, track: 2, target: { kind: 'chan_pan', ch: 1 }, points: [p(50, 2), p(10, -1)] }, { target: { kind: 'nope' } }] });
  assert.equal(n.automation.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(n.automation[0].points.map(x => [x.t, x.v]))), [[10, 0], [50, 1]]);
});

test('cut, mute and stretch tools', () => {
  const s = setup();
  const btn = label => s.elements.find(e => e.tag === 'button' && String(e.textContent || '').includes(label));
  const P = s.S.project;
  P.clips.push({ p: 1, track: 0, t: 384, l: 768, off: 0, ch: 0, mute: false, rate: 1 });
  P.clips.push({ p: 1, track: 1, t: 0, l: 1536, off: 0, ch: 0, mute: false, rate: 1 });
  s.bus.emit('render');
  // cut: a click slices the clip under it on the grid
  btn('резать').emit('click');
  gesture(s.cv, [128 + 80 * 2 + 3, 45]);
  const t0 = P.clips.filter(c => c.track === 0).map(c => [c.t, c.l, c.off]);
  assert.deepEqual(JSON.parse(JSON.stringify(t0)), [[384, 384, 0], [768, 384, 384]]);
  // a drag down cuts every clip under the line at bar 4 (track 0's clip ends there: untouched)
  gesture(s.cv, [128 + 80 * 3 + 3, 45], [128 + 80 * 3 + 3, 93]);
  assert.equal(P.clips.filter(c => c.track === 1).length, 2);
  assert.equal(P.clips.filter(c => c.track === 0).length, 2);
  // mute: a click silences a clip, again brings it back; empty space mutes the track
  btn('мьют').emit('click');
  const first = P.clips.find(c => c.track === 0 && c.t === 384);
  gesture(s.cv, [128 + 80 + 20, 45]);
  assert.equal(first.mute, true);
  assert.equal(P.clips.filter(c => c.mute).length, 1);
  gesture(s.cv, [128 + 80 + 20, 45]);
  assert.equal(first.mute, false);
  gesture(s.cv, [128 + 80 * 6, 24 + 48 * 2 + 20]);
  assert.equal(P.tracks[2].mute, true);
  // stretch: dragging an audio clip's right edge to twice the length halves its speed
  P.channels.push({ id: 9, name: 'vox', vol: 0.8, pan: 0, mute: false, solo: false, mix: 0, inst: { type: 'audio', sample: 'v.wav', path: 'C:/v.wav' } });
  const a = { p: 0, ch: 9, track: 3, t: 0, l: 384, off: 0, mute: false, rate: 1 };
  P.clips.push(a); s.bus.emit('render');
  btn('стретч').emit('click');
  gesture(s.cv, [128 + 80 - 2, 24 + 48 * 3 + 20], [128 + 160 - 2, 24 + 48 * 3 + 20]);
  assert.equal(a.l, 768);
  assert.equal(a.rate, 0.5);
  // cutting a stretched clip moves the right part's offset at its rate
  btn('резать').emit('click');
  gesture(s.cv, [128 + 80 + 3, 24 + 48 * 3 + 20]);
  const parts = P.clips.filter(c => c.ch === 9).map(c => [c.t, c.l, c.off, c.rate]);
  assert.deepEqual(JSON.parse(JSON.stringify(parts)), [[0, 384, 0, 0.5], [384, 384, 192, 0.5]]);
});

test('audio clips: fade handles, a volume grip and Alt+wheel; make unique; the clip menu', () => {
  const s = setup();
  const P = s.S.project;
  P.channels.push({ id: 9, name: 'vox', vol: 0.8, pan: 0, mute: false, solo: false, mix: 2, inst: { type: 'audio', sample: 'v.wav', path: 'C:/v.wav' } });
  const a = { p: 0, ch: 9, track: 0, t: 0, l: 768, off: 0, mute: false, rate: 1, gain: 1, fade_in: 0, fade_out: 0 };
  P.clips.push(a); s.bus.emit('render');
  // the clip spans x 128..288 on track 0 (top at y 26)
  gesture(s.cv, [130, 28], [168, 28]);
  assert.equal(a.fade_in, 192);
  gesture(s.cv, [286, 28], [248, 28]);
  assert.equal(a.fade_out, 192);
  gesture(s.cv, [208, 28], [208, 8]);
  assert.ok(Math.abs(20 * Math.log10(a.gain) - 5) < 0.01, 'dragging the grip up 20 px is +5 dB');
  s.cv.emit('wheel', { altKey: true, deltaY: -100, clientX: 200, clientY: 50 });
  assert.ok(Math.abs(20 * Math.log10(a.gain) - 5.5) < 0.01, 'Alt+wheel adds half a dB');
  // the ≡ opens the clip's menu; make unique gives it its own channel
  gesture(s.cv, [138, 30]);
  const item = s.getMenu().find(i => i.label && i.label.includes('make unique'));
  assert.ok(item);
  item.fn();
  assert.notEqual(a.ch, 9);
  const copy = P.channels.find(c => c.id === a.ch);
  assert.equal(copy.inst.path, 'C:/v.wav');
  assert.equal(copy.mix, 2);
  // a pattern clip gets its own pattern
  const pc = { p: 1, track: 1, t: 0, l: 384, off: 0, mute: false, rate: 1, gain: 1, fade_in: 0, fade_out: 0 };
  P.clips.push(pc);
  s.Playlist.makeUnique(pc);
  assert.equal(P.patterns.length, 2);
  assert.equal(pc.p, P.patterns[1].id);
  assert.deepEqual(JSON.parse(JSON.stringify(P.patterns[1].notes)), JSON.parse(JSON.stringify(P.patterns[0].notes)));
});

test('pre-render: the clips become one audio clip, rendered from where they start', async () => {
  const s = setup();
  const P = s.S.project;
  let args = null;
  s.api.call = async (cmd, a) => {
    if (cmd === 'render_clips') { args = a; return { path: 'C:/song/rendered/drums_render.wav', seconds: 3 }; }
    if (cmd === 'sample_wave') return { seconds: 3, peaks: [] };
    return null;
  };
  P.channels.forEach(c => { c.mix = 4; });
  P.patterns[0].notes = { [P.channels[0].id]: [{ t: 0, l: 24, k: 60, v: 1 }] };
  P.mixer[0].fx = [{ pid: 7, on: true, mix: 1 }];
  const c1 = { p: 1, track: 2, t: 768, l: 384, off: 0, mute: false, rate: 1, gain: 1, fade_in: 0, fade_out: 0 };
  const c2 = { p: 1, track: 3, t: 1152, l: 768, off: 0, mute: false, rate: 1, gain: 1, fade_in: 0, fade_out: 0 };
  const other = { p: 1, track: 0, t: 0, l: 384, off: 0, mute: false, rate: 1, gain: 1, fade_in: 0, fade_out: 0 };
  P.clips.push(c1, c2, other);
  await s.Playlist.preRender([c1, c2], { tail: false, inserts: false, master: false });
  const sent = JSON.parse(args.json);
  assert.equal(args.len, 1152);
  assert.equal(args.tail, false);
  assert.deepEqual(sent.clips.map(c => c.t), [0, 384], 'moved to start at 0, the other clip left out');
  assert.ok(sent.channels.every(c => c.mix === 0), 'without inserts the channels go straight to the master');
  assert.equal(sent.mixer[0].fx.length, 0, 'no master effects');
  // the originals stay, muted (their patterns kept); the render goes on the first free track
  // below them and plays into their insert
  assert.equal(P.clips.length, 4);
  assert.ok(c1.mute && c2.mute && !other.mute);
  assert.equal(P.patterns.length, 1);
  const nc = P.clips.find(c => c.ch);
  assert.deepEqual([nc.t, nc.l, nc.track], [768, 1152, 4]);
  const ch = P.channels.find(c => c.id === nc.ch);
  assert.equal(ch.mix, 4);
  assert.equal(ch.inst.path, 'C:/song/rendered/drums_render.wav');
  // it is a sound like any other: reverse and pitch from its clip's menu
  s.bus.emit('render');
  const x = 128 + 80 * 2 + 10, y = 24 + 48 * 4 + 6;
  gesture(s.cv, [x, y]);
  s.getMenu().find(i => i.label === 'реверс').fn();
  assert.equal(ch.inst.reverse, true);
  gesture(s.cv, [x, y]);
  s.getMenu().find(i => i.label === 'питч +12 (октава)').fn();
  assert.equal(ch.inst.pitch, 12);
  // asked to, the originals go and the render takes their place
  const d1 = { p: 1, track: 6, t: 0, l: 384, off: 0, mute: false, rate: 1, gain: 1, fade_in: 0, fade_out: 0 };
  P.clips.push(d1);
  await s.Playlist.preRender([d1], { tail: false, inserts: true, master: false, originals: 'delete' });
  assert.ok(!P.clips.includes(d1));
  assert.equal(P.clips.at(-1).track, 6);
});

test('Ctrl+click on a track solos it; again, all tracks come back', () => {
  const s = setup();
  const T = s.S.project.tracks;
  // track 2's on/off square sits at x 18, y 24 + 48 * 2 + 24
  gesture(s.cv, [18, 24 + 48 * 2 + 24], null, { ctrlKey: true });
  assert.ok(T.every((k, i) => k.mute === (i !== 2)));
  gesture(s.cv, [18, 24 + 48 * 2 + 24], null, { ctrlKey: true });
  assert.ok(T.every(k => !k.mute));
  // a plain click still just mutes one
  gesture(s.cv, [18, 24 + 48 * 1 + 24]);
  assert.equal(T.filter(k => k.mute).length, 1);
});
