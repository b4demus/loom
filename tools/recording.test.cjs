// Recording lifecycle regression checks without a microphone or a running WebView.
// Run: node --test tools/recording.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(handler = () => null) {
  const calls = [], errors = [];
  const listeners = {}, native = {};
  const el = { classList: { toggle() {} }, firstChild: {}, textContent: '', addEventListener() {}, append() {} };
  const elements = new Map();
  const context = vm.createContext({
    URLSearchParams, location: { search: '' }, window: { addEventListener() {}, __TAURI__: { window: { getCurrentWindow() { return {}; } }, event: { listen(name, fn) { native[name] = fn; } } } }, performance,
    requestAnimationFrame() {}, setTimeout,
    document: { querySelector: selector => {
      if (selector === '.win.active') return null;
      if (!elements.has(selector)) elements.set(selector, { ...el, dataset: {} });
      return elements.get(selector);
    }, createElement: () => ({ ...el, setAttribute() {} }), createTextNode: text => text,
    querySelectorAll: () => [], documentElement: el, addEventListener(name, fn) { listeners[name] = fn; } },
    knob: () => ({ update() {} }),
    toast: (...args) => errors.push(args), hint() {},
    Plugins: { reset() {} }, Roll: { setPressed() {} },
  });
  for (const file of ['i18n.js', 'core.js', 'app.js']) {
    const source = fs.readFileSync(path.join(__dirname, '../ui', file), 'utf8');
    vm.runInContext(file === 'app.js' ? source.replace(/main\(\);\s*$/, '') : source, context, { filename: file });
  }
  context.toast = (...args) => errors.push(args);
  context.hint = () => {};
  vm.runInContext(`
    S.project = normalize(emptyProject());
    Rec.countIn = 0;
    globalThis.subject = { S, Rec, Transport, bus, syncInput, setProject, emptyProject, normalize, initTop, initKeys, recordKey, history };
  `, context);
  context.subject.api = vm.runInContext('api', context);
  context.subject.api.call = async (command, args) => {
    calls.push({ command, args });
    if (command === 'sample_wave') return { seconds: 1, peaks: [0, 0] };
    return handler(command, args);
  };
  return { ...context.subject, calls, errors, elements, listeners, native, context };
}

test('undo and redo use physical keys in either layout, including native plugin shortcuts', () => {
  for (const [key, code] of [['z', 'KeyZ'], ['я', 'KeyZ'], ['Я', 'KeyZ'], ['я', ''], ['Z', '']]) {
    const s = setup(); s.initKeys();
    s.history.edit(() => { s.S.project.bpm = 150; });
    let prevented = 0;
    const press = (over = {}) => s.listeners.keydown({ target: {}, key, code, ctrlKey: true, preventDefault() { prevented++; }, ...over });
    press(); assert.equal(s.S.project.bpm, 130, key);
    press({ shiftKey: true }); assert.equal(s.S.project.bpm, 150);
    press(); press({ key: 'н', code: 'KeyY' }); assert.equal(s.S.project.bpm, 150);
    assert.equal(prevented, 4);
    press({ key: 'я', code: 'KeyA' }); assert.equal(s.S.project.bpm, 150, 'supplied physical codes take precedence');
    press({ altKey: true }); assert.equal(s.S.project.bpm, 150, 'AltGr is not undo');
    s.native.kbd({ payload: { code: 'Ctrl+KeyZ', down: true } }); assert.equal(s.S.project.bpm, 130);
    s.native.kbd({ payload: { code: 'Ctrl+Shift+KeyZ', down: true } }); assert.equal(s.S.project.bpm, 150);
    s.native.kbd({ payload: { code: 'Ctrl+KeyZ', down: true } });
    s.native.kbd({ payload: { code: 'Ctrl+KeyY', down: true } }); assert.equal(s.S.project.bpm, 150);
    press({ target: { matches: () => true } }); assert.equal(s.S.project.bpm, 150, 'text fields keep native text undo');
    for (const type of ['checkbox', 'radio', 'range']) {
      press({ target: { type, matches: () => true } }); assert.equal(s.S.project.bpm, 130, type);
      press({ target: { type, matches: () => true }, shiftKey: true }); assert.equal(s.S.project.bpm, 150);
    }
    press({ target: { isContentEditable: true } }); assert.equal(s.S.project.bpm, 150);
  }
});

test('record button starts on its first click and stops on its next click', async () => {
  const s = setup();
  s.initTop();
  await s.elements.get('#t-rec').onclick();
  assert.equal(s.Rec.live, true);
  assert.equal(s.S.playing, true);
  assert.equal(s.calls.filter(c => c.command === 'transport' && c.args.action === 'play').length, 1);
  await s.elements.get('#t-rec').onclick();
  assert.equal(s.Rec.live, false);
  assert.equal(s.Rec.armed, false);
});

test('DOM and native shortcuts start and stop on each press, ignoring repeats', async () => {
  for (const source of ['dom', 'Alt+KeyR', 'Plugin+Alt+KeyR']) {
    const s = setup();
    s.initKeys();
    const press = repeat => {
      if (source === 'dom') s.listeners.keydown({ target: {}, key: 'к', code: 'KeyR', altKey: true, repeat, preventDefault() {} });
      else s.native.kbd({ payload: { code: source, down: true, repeat } });
    };
    for (let i = 0; i < 3; i++) {
      press(false); await s.Transport.pending;
      assert.equal(s.Rec.live, true, source);
      press(true);
      assert.equal(s.Rec.live, true, 'autorepeat keeps the take running');
      press(false); await s.Transport.ending;
      assert.equal(s.Rec.live, false, source);
    }
    assert.equal(s.calls.filter(c => c.command === 'transport' && c.args.action === 'play').length, 3);
  }
});

test('native shortcut keeps the roll randomizer context, while a plugin shortcut records', async () => {
  const s = setup();
  let randomizations = 0;
  s.context.Roll.win = { open: true };
  s.context.Roll.randomizer = () => randomizations++;
  s.initKeys();
  s.listeners.pointermove({ target: { isConnected: true, closest: () => ({}) } });
  s.native.kbd({ payload: { code: 'Alt+KeyR', down: true } });
  assert.equal(randomizations, 1);
  assert.equal(s.Rec.live, false);
  s.native.kbd({ payload: { code: 'Plugin+Alt+KeyR', down: true } });
  await s.Transport.pending;
  assert.equal(s.Rec.live, true);
  await s.Transport.stop();
});

test('Alt+R accepts code-less accessibility input in English and Russian', async () => {
  for (const key of ['r', 'R', 'к', 'К']) {
    const s = setup();
    s.initKeys();
    const press = (code = '', ctrlKey = false, repeat = false) => s.listeners.keydown({ target: {}, key, code, altKey: true, ctrlKey, repeat, preventDefault() {} });
    press('KeyK'); press('', true);
    assert.equal(s.Rec.armed, false, 'do not override a supplied physical code or Ctrl+Alt shortcut');
    press(); await s.Transport.pending;
    assert.equal(s.Rec.live, true, key);
    press('', false, true);
    assert.equal(s.Rec.live, true);
    press(); await s.Transport.ending;
    assert.equal(s.Rec.live, false);
  }
});

test('extra clicks during a slow start do not stop or duplicate the take', async () => {
  let ready;
  const opened = new Promise(resolve => { ready = resolve; });
  const s = setup(c => c === 'rec_start' ? opened : c === 'rec_stop' ? [] : null);
  s.Rec.what = 'audio';
  s.Rec.countIn = 1;
  const playing = s.recordKey();
  await new Promise(resolve => setImmediate(resolve));
  s.recordKey();
  ready(['C:/take.wav']);
  await playing;
  assert.equal(s.Rec.live, true);
  assert.equal(s.calls.filter(c => c.command === 'rec_start').length, 1);
  assert.equal(s.calls.filter(c => c.command === 'rec_stop').length, 0);
  await s.recordKey(); // during the count-in, the next deliberate press stops
  assert.equal(s.Rec.live, false);
});

test('old stopped status cannot immediately finish a new loop recording', async () => {
  const s = setup();
  s.S.project.loop_region = { start: 384, end: 768, enabled: true };
  s.Transport.seekSong(384);
  const oldSerial = s.Transport.serial;
  await s.recordKey();
  s.Transport.updateStatus({ playing: false, pos: 0 }, oldSerial);
  s.Transport.updateStatus({ playing: false, pos: 384 }, s.Transport.serial);
  assert.equal(s.Rec.live, true);
  assert.equal(s.S.playing, true);
  s.Transport.updateStatus({ playing: true, pos: 500 }, s.Transport.serial);
  s.Transport.updateStatus({ playing: false, pos: 768 }, s.Transport.serial);
  await s.Transport.ending;
  assert.equal(s.Rec.live, false, 'an acknowledged playback still ends at the loop boundary');
  s.Transport.updateStatus({ playing: true, pos: 600 }, oldSerial);
  assert.equal(s.S.playing, false, 'a stale running response cannot undo stop');
});

test('monitoring follows input selection, undo, and the chosen device without reopening on fader edits', async () => {
  const s = setup();
  s.S.project.mixer[1].input = 1;
  s.bus.emit('change'); await s.syncInput();
  assert.equal(s.calls.filter(c => c.command === 'input_open').length, 1);
  s.S.project.mixer[1].vol = 0.4;
  s.bus.emit('change'); await s.syncInput();
  assert.equal(s.calls.filter(c => c.command === 'input_open').length, 1);
  s.Rec.input = 'USB input'; await s.syncInput(true);
  assert.equal(s.calls.at(-1).args.device, 'USB input');
  s.S.project = JSON.parse(JSON.stringify(s.S.project)); // undo replaces the whole project
  s.S.project.mixer[1].input = 0;
  s.bus.emit('change'); await s.syncInput();
  assert.equal(s.calls.at(-1).command, 'input_close');
});

test('armed tracks record independently and import to their mixer tracks with latency compensation', async () => {
  const takes = [1, 2].map(track => ({ path: `C:/takes/ins${track}.wav`, track, seconds: 1, offset_ms: -100 }));
  const s = setup(command => command === 'rec_start' ? takes.map(t => t.path) : command === 'rec_stop' ? takes : null);
  s.S.mode = 'song'; s.S.pos = 384; s.S.songStart = 384;
  // set to record their dry input (by default an armed track records its own sound)
  for (const track of [1, 2]) Object.assign(s.S.project.mixer[track], { input: track, arm: true, rec_dry: true });
  s.Rec.armed = true;
  await s.Transport.play();
  assert.equal(s.calls.filter(c => c.command === 'tap_start').length, 0);
  const specs = s.calls.find(c => c.command === 'rec_start').args.tracks;
  assert.deepEqual(JSON.parse(JSON.stringify(specs)), [{ track: 1, mode: 1 }, { track: 2, mode: 2 }]);
  await s.Transport.stop(); await s.syncInput();
  assert.deepEqual(Array.from(s.S.project.channels.filter(c => c.inst.type === 'audio'), c => c.mix), [1, 2]);
  assert.deepEqual(Array.from(s.S.project.clips, c => c.track), [0, 1]);
  for (const clip of s.S.project.clips) { assert.equal(clip.t, 384); assert.equal(clip.off, 21); }
  assert.equal(s.Rec.live, false); assert.equal(s.Rec.stopping, false);
  assert.equal(s.calls.at(-1).command, 'input_open'); // monitoring stays on after stop
  assert.equal(s.errors.length, 1); // success notification
});

test('whole-input recording closes the temporary input after stop', async () => {
  const s = setup(c => c === 'rec_start' ? ['C:/take.wav'] : c === 'rec_stop' ? [] : null);
  await s.syncInput();
  s.Rec.what = 'audio'; s.Rec.armed = true;
  await s.Transport.play();
  assert.equal(s.calls.find(c => c.command === 'rec_start').args.tracks.length, 0);
  await s.Transport.stop(); await s.syncInput();
  assert.equal(s.calls.at(-1).command, 'input_close');
});

test('stop during input startup cancels play and finalizes exactly one take', async () => {
  let ready;
  const opened = new Promise(resolve => { ready = resolve; });
  const s = setup(c => c === 'rec_start' ? opened : c === 'rec_stop' ? [] : null);
  s.Rec.what = 'audio'; s.Rec.armed = true;
  const playing = s.Transport.play();
  await new Promise(resolve => setImmediate(resolve));
  const duplicate = s.Transport.play();
  const stopped = s.Transport.stop();
  ready(['C:/take.wav']);
  await Promise.all([playing, duplicate, stopped]);
  await s.syncInput();
  assert.equal(s.calls.filter(c => c.command === 'rec_start').length, 1);
  assert.equal(s.calls.filter(c => c.command === 'rec_stop').length, 1);
  assert.equal(s.calls.filter(c => c.command === 'transport' && c.args.action === 'play').length, 0);
  assert.equal(s.Rec.live, false);
});

test('failed input start leaves transport stopped and reports the error', async () => {
  const s = setup(c => { if (c === 'rec_start') throw Error('input unavailable'); return null; });
  s.Rec.what = 'audio'; s.Rec.armed = true;
  await s.Transport.play();
  assert.equal(s.Rec.live, false);
  assert.equal(s.calls.some(c => c.command === 'transport' && c.args.action === 'play'), false);
  assert.match(s.errors[0][0], /input unavailable/);
});

test('a full playlist gets a new lane for the take', async () => {
  const s = setup(c => c === 'rec_start' ? ['C:/take.wav'] : c === 'rec_stop' ? [{ path: 'C:/take.wav', track: 1, seconds: 1, offset_ms: 0 }] : null);
  s.S.project.clips = s.S.project.tracks.map((_, track) => ({ track, t: 0, l: 2000, p: 1 }));
  s.Rec.what = 'audio'; s.Rec.armed = true;
  await s.Transport.play(); await s.Transport.stop();
  assert.equal(s.S.project.clips.at(-1).track, 24);
  assert.equal(s.S.project.tracks.length, 25);
});

test('switching projects waits for an already-stopping take', async () => {
  let finish;
  const stopping = new Promise(resolve => { finish = resolve; });
  const s = setup(c => c === 'rec_start' ? ['C:/take.wav'] : c === 'rec_stop' ? stopping : null);
  s.Rec.what = 'audio'; s.Rec.armed = true;
  await s.Transport.play();
  const oldProject = s.S.project;
  const stop = s.Transport.stop();
  const switched = s.setProject(s.emptyProject(), null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.S.project, oldProject);
  finish([{ path: 'C:/take.wav', track: 0, seconds: 1, offset_ms: 0 }]);
  await Promise.all([stop, switched]);
  assert.notEqual(s.S.project, oldProject);
  assert.equal(oldProject.clips.length, 1);
  assert.equal(s.S.project.clips.length, 0);
});

test('ruler start survives stop, changing the playback position, and a second play', async () => {
  const s = setup();
  s.Transport.seekSong(8 * 384 + 96);
  await s.Transport.play();
  s.S.pos += 200;
  await s.Transport.stop();
  assert.equal(s.S.pos, 8 * 384 + 96);
  await s.Transport.play();
  const seeks = s.calls.filter(c => c.command === 'transport' && c.args.action === 'pos');
  assert.equal(seeks.at(-1).args.value, 8 * 384 + 96);
});

test('a start outside an enabled region moves to its beginning before recording', async () => {
  const s = setup();
  s.S.project.loop_region = { start: 384, end: 768, enabled: true };
  s.Transport.seekSong(0);
  s.Rec.armed = true;
  await s.Transport.play();
  assert.equal(s.S.songStart, 384);
  assert.equal(s.Rec.start, 384);
  await s.Transport.stop();
});

test('armed tracks without an input record their own sound and land where it played', async () => {
  const own = [{ path: 'C:/takes/rec_mix3.wav', track: 3, seconds: 2, tick: 768 }];
  const s = setup(command => command === 'tap_start' ? own.map(t => t.path) : command === 'tap_stop' ? own : null);
  s.S.mode = 'song'; s.S.pos = 768; s.S.songStart = 768;
  // insert 3 plays into a group on insert 5, so its recording plays there (its effects are in it)
  Object.assign(s.S.project.mixer[3], { arm: true, out: [5] });
  s.Rec.armed = true;
  await s.Transport.play();
  const start = s.calls.find(c => c.command === 'tap_start');
  assert.ok(start, 'the track records its own sound');
  assert.deepEqual(JSON.parse(JSON.stringify(start.args.tracks)), [3]);
  assert.equal(s.calls.filter(c => c.command === 'rec_start').length, 0, 'no input is opened for it');
  await s.Transport.stop();
  const ch = s.S.project.channels.find(c => c.inst.type === 'audio');
  assert.equal(ch.mix, 5);
  const clip = s.S.project.clips.find(c => c.ch === ch.id);
  assert.equal(clip.t, 768);
  assert.equal(clip.off, 0);
  assert.equal(clip.l, Math.ceil(2 * 1000 * s.S.project.bpm * 96 / 60000));
});

test('a take grows on the playlist while it records and lands on the track it was drawn on', async () => {
  const own = [{ path: 'C:/takes/rec_mix2.wav', track: 2, seconds: 1, tick: 384 }];
  let live = [{ key: 'mix:2', track: 2, tick: 384, peaks: [-0.5, 0.5, -0.25, 0.25] }];
  const s = setup(command => command === 'tap_start' ? ['C:/takes/rec_mix2.wav'] : command === 'tap_stop' ? own : command === 'rec_live' ? live : null);
  s.S.mode = 'song'; s.S.pos = 384; s.S.songStart = 384;
  // track 0 is busy from bar 2 on: the take goes below it
  s.S.project.clips.push({ p: 1, track: 0, t: 384, l: 3840, off: 0, ch: 0 });
  s.S.project.mixer[2].arm = true;
  s.Rec.armed = true;
  await s.Transport.play();
  await s.Rec.poll();
  live = [{ key: 'mix:2', track: 2, tick: 384, peaks: [-0.1, 0.1] }];
  await s.Rec.poll();
  const e = s.Rec.takes.get('mix:2');
  assert.equal(e.t0, 384);
  assert.equal(e.row, 1);
  assert.equal(e.peaks.length, 6, 'the peaks add up as they come');
  await s.Transport.stop();
  const clip = s.S.project.clips.find(c => c.ch);
  assert.equal(clip.track, 1);
  assert.equal(clip.t, 384);
  assert.equal(s.Rec.takes, null);
});

test('recording over the playlist loop stops at its end and the take is cut there', async () => {
  // the take ran on 6 s (past the loop's 3.5 s at 130 bpm); the loop is bars 2..3 (384..1152)
  const own = [{ path: 'C:/takes/rec_mix0.wav', track: 0, seconds: 6, tick: 384 }];
  const s = setup(command => command === 'tap_start' ? ['C:/takes/rec_mix0.wav'] : command === 'tap_stop' ? own : null);
  s.S.mode = 'song'; s.S.pos = 384; s.S.songStart = 384;
  s.S.project.loop_region = { start: 384, end: 1152, enabled: true };
  s.S.project.mixer[0].arm = true;
  s.Rec.armed = true;
  await s.Transport.play();
  const flags = () => s.calls.filter(c => c.command === 'transport' && c.args.action === 'stop_at_end').map(c => c.args.value);
  assert.deepEqual(flags(), [1], 'the engine is told to stop at the loop end');
  await s.Transport.stop();
  assert.deepEqual(flags(), [1, 0], 'and back to looping after the take');
  const clip = s.S.project.clips.find(c => c.ch);
  assert.equal(clip.t, 384);
  assert.equal(clip.l, 768, 'cut at the loop end');
});
