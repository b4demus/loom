const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./ui-test-harness.cjs');
const plain = v => JSON.parse(JSON.stringify(v));

test('effect wet knob supports repeated undo, redo and a new edit after undo', () => {
  const s = setup({ mixer: true, knobs: true });
  s.S.project.plugins.push({ id: 9, name: 'EQ' });
  s.S.project.mixer[0].fx.push({ pid: 9, on: true, mix: 0.5 });
  s.bus.emit('render');
  const side = s.elements.find(e => e.className === 'mx-side');
  const knob = side.querySelector('.knob');
  knob.emit('wheel', { deltaY: -1 });
  assert.equal(s.S.project.mixer[0].fx[0].mix, 0.525);
  s.undo(); s.bus.emit('render'); assert.equal(s.S.project.mixer[0].fx[0].mix, 0.5);
  s.redo(); s.bus.emit('render'); assert.equal(s.S.project.mixer[0].fx[0].mix, 0.525);
  s.undo(); s.bus.emit('render');
  side.querySelector('.knob').emit('wheel', { deltaY: 1 });
  assert.equal(s.S.project.mixer[0].fx[0].mix, 0.475, 'new controls change the restored project');
  assert.equal(s.history.redo.length, 0);
  s.undo(); assert.equal(s.S.project.mixer[0].fx[0].mix, 0.5);
});

test('undo during a knob drag ends that gesture and blocks later pointer moves', () => {
  const s = setup({ mixer: true, knobs: true });
  const pan = s.elements.find(e => e.className === 'mx-strip master').querySelector('.knob');
  pan.emit('pointerdown', { clientY: 100 });
  pan.emit('pointermove', { clientY: 80 });
  pan.emit('pointermove', { clientY: 60 });
  assert.equal(s.S.project.mixer[0].pan, 0.5);
  s.undo(); assert.equal(s.S.project.mixer[0].pan, 0);
  pan.emit('pointermove', { clientY: 20 }); pan.emit('pointerup');
  assert.equal(s.S.project.mixer[0].pan, 0, 'the old drag cannot change a restored project');
  s.redo(); assert.equal(s.S.project.mixer[0].pan, 0.5);
  assert.equal(s.history.undo.length, 1, 'one drag is one action');
});

test('clip deletion restores every field and works again after redo and undo', () => {
  const s = setup();
  const clip = { p: 1, ch: 0, track: 2, t: 384, l: 768, off: 24, rate: 1.2, gain: 0.6, fade_in: 10, fade_out: 15, mute: true };
  s.S.project.clips.push(clip);
  for (let i = 0; i < 3; i++) {
    s.Playlist.key({ key: 'a', ctrlKey: true });
    s.Playlist.key({ key: 'Delete' });
    assert.equal(s.S.project.clips.length, 0);
    s.undo(); assert.deepEqual(plain(s.S.project.clips), [clip]);
    s.redo(); assert.equal(s.S.project.clips.length, 0);
    s.undo(); assert.deepEqual(plain(s.S.project.clips), [clip]);
  }
});

test('a restored piano roll cannot delete the last note through a stale selection', () => {
  const s = setup({ roll: true });
  const notes = [{ t: 0, l: 24, k: 60, v: 0.7 }, { t: 48, l: 24, k: 64, v: 0.9 }];
  s.S.project.patterns[0].notes[1] = plain(notes);
  s.S.curCh = 1;
  s.Roll.select([s.S.project.patterns[0].notes[1][0]]);
  s.history.edit(() => { s.S.project.bpm = 150; }); s.undo();
  s.Roll.key({ key: 'Delete' });
  assert.deepEqual(plain(s.S.project.patterns[0].notes[1]), notes);
});

test('nested edits form one step, no-op changes keep redo, and branching discards redo', () => {
  const s = setup();
  s.history.edit(() => {
    s.S.project.bpm = 140;
    s.history.edit(() => { s.S.project.swing = 0.3; });
    s.S.project.master = 0.5;
  });
  assert.equal(s.history.undo.length, 1);
  s.undo(); assert.equal(s.S.project.bpm, 130); assert.equal(s.S.project.swing, 0);
  s.history.edit(() => {}); assert.equal(s.history.redo.length, 1);
  s.history.edit(() => { s.S.project.bpm = 160; });
  assert.equal(s.history.redo.length, 0);
  s.undo(); assert.equal(s.S.project.bpm, 130);
});

test('channel switches redraw on undo and an undone channel addition leaves no stale controls', () => {
  const s = setup({ channel: true, knobs: true });
  s.S.project.channels[0].inst = { type: 'synth', mono: false };
  s.Chan.open(1); s.bus.emit('render');
  const form = s.elements.find(e => e.className === 'form');
  const switches = () => {
    const result = [];
    const visit = el => { if (el.type === 'checkbox') result.push(el); for (const child of el.children || []) visit(child); };
    visit(form); return result;
  };
  const checkbox = switches()[0];
  checkbox.checked = !checkbox.checked; checkbox.emit('change');
  const edited = JSON.stringify(s.S.project.channels[0].inst);
  s.undo(); s.bus.emit('render');
  assert.equal(switches()[0].checked, !checkbox.checked);
  s.redo(); s.bus.emit('render'); assert.equal(JSON.stringify(s.S.project.channels[0].inst), edited);
  s.history.edit(() => { const c = plain(s.S.project.channels[0]); c.id = 9; s.S.project.channels.push(c); });
  s.Chan.open(9); s.bus.emit('render');
  s.undo(); s.bus.emit('render'); s.bus.emit('render');
  assert.equal(switches().length, 0, 'deleted channel controls must not dereference its old object');
});

async function pluginSetup() {
  const s = setup({ plugins: true });
  const host = new Map(), calls = [], queued = [];
  s.api.call = async (cmd, args) => {
    calls.push({ cmd, args: args && plain(args) });
    if (cmd === 'plugin_load') {
      const params = { 7: 0.25, 8: 0.5, ...args.desc.params };
      host.set(args.desc.id, params);
      return { name: 'test effect', editor: true, params: { ...params } };
    }
    if (cmd === 'plugin_unload') { args.ids.forEach(id => host.delete(id)); return; }
    if (cmd === 'plugin_set_params') { args.values.forEach(([id, value]) => { host.get(args.id)[id] = value; }); return; }
    if (cmd === 'plugin_edits') return queued.splice(0);
    if (cmd === 'plugin_states') return Object.fromEntries([...host].map(([id, params]) => [id, { state: 'current-state', params: { ...params } }]));
    return null;
  };
  s.S.project.plugins.push({ id: 1, format: 'vst3', path: 'test.vst3', cid: 'test', name: 'test effect', state: '' });
  s.S.project.mixer[0].fx.push({ pid: 1, on: true, mix: 1 });
  await s.Plugins.sync();
  const edit = (...events) => {
    for (const e of events) if (e.kind === 'value') host.get(1)[e.id] = e.value;
    s.Plugins.edited(events.map(e => [1, e]));
  };
  return { ...s, host, calls, queued, edit };
}

test('native plugin gesture spans status polls as one action and restores actual host values', async () => {
  const s = await pluginSetup();
  s.edit({ kind: 'begin', id: 7 }, { kind: 'value', id: 7, value: 0.4 });
  s.edit({ kind: 'value', id: 7, value: 0.6 });
  s.edit({ kind: 'value', id: 7, value: 0.8 }, { kind: 'end', id: 7 });
  assert.equal(s.history.undo.length, 1);
  await s.undo(); assert.equal(s.host.get(1)[7], 0.25); assert.equal(s.S.project.plugins[0].params[7], 0.25);
  await s.redo(); assert.equal(s.host.get(1)[7], 0.8);
  s.edit({ kind: 'begin', id: 7 }, { kind: 'value', id: 7, value: 0.9 }, { kind: 'end', id: 7 });
  assert.equal(s.history.undo.length, 2, 'a second gesture on the same knob is separate');
  await s.undo(); assert.equal(s.host.get(1)[7], 0.8);
  s.edit({ kind: 'begin', id: 8 }, { kind: 'value', id: 8, value: 0.1 }, { kind: 'end', id: 8 });
  assert.equal(s.history.redo.length, 0);
  await s.undo(); assert.equal(s.host.get(1)[8], 0.5); assert.equal(s.host.get(1)[7], 0.8);
});

test('plugin undo flushes a pending status and final native events before restoring', async () => {
  const s = await pluginSetup();
  let deliver;
  s.Plugins.poll(new Promise(resolve => { deliver = resolve; }));
  s.host.get(1)[7] = 0.9;
  s.queued.push([1, { kind: 'value', id: 7, value: 0.9 }], [1, { kind: 'end', id: 7 }]);
  const undo = s.undo();
  deliver({ edits: [[1, { kind: 'begin', id: 7 }], [1, { kind: 'value', id: 7, value: 0.7 }]] });
  await undo;
  assert.equal(s.host.get(1)[7], 0.25);
  await s.redo(); assert.equal(s.host.get(1)[7], 0.9, 'redo includes the last unpolled value');
});

test('deleting and undoing an effect recreates it with its manually edited parameters', async () => {
  const s = await pluginSetup();
  s.edit({ kind: 'begin', id: 7 }, { kind: 'value', id: 7, value: 0.7 }, { kind: 'end', id: 7 });
  s.history.edit(() => { s.S.project.mixer[0].fx = []; s.Plugins.collect(); });
  await s.Plugins.sync(); assert.equal(s.host.size, 0);
  await s.undo();
  assert.equal(s.S.project.mixer[0].fx.length, 1); assert.equal(s.host.get(1)[7], 0.7);
  await s.undo(); assert.equal(s.host.get(1)[7], 0.25);
});

test('plugin edits override automation in the same undo step and redo restores that override', async () => {
  const s = await pluginSetup();
  s.S.project.automation = [{ id: 1, track: 0, name: 'gain', on: true, target: { kind: 'param', pid: 1, param: 7 }, points: [{ t: 0, v: 0.5 }] }];
  s.edit({ kind: 'begin', id: 7 });
  s.edit({ kind: 'value', id: 7, value: 0.8 }, { kind: 'end', id: 7 });
  assert.equal(s.S.project.automation[0].on, false); assert.equal(s.history.undo.length, 1);
  await s.undo(); assert.equal(s.S.project.automation[0].on, true); assert.equal(s.host.get(1)[7], 0.25);
  await s.redo(); assert.equal(s.S.project.automation[0].on, false); assert.equal(s.host.get(1)[7], 0.8);
});

test('saving/copying captures plugin state with matching values and does not revert unreported values', async () => {
  const s = await pluginSetup();
  s.host.get(1)[8] = 0.9;
  await s.Plugins.captureStates();
  assert.equal(s.S.project.plugins[0].state, 'current-state');
  assert.equal(s.S.project.plugins[0].params[8], 0.9);
  await s.Plugins.sync();
  assert.equal(s.host.get(1)[8], 0.9);
});

test('a status requested before restoration cannot disable restored automation or replay old edits', async () => {
  const s = await pluginSetup();
  s.history.edit(() => { s.S.project.bpm = 150; });
  let deliver;
  const status = s.Plugins.poll(new Promise(resolve => { deliver = resolve; }));
  s.history.step(s.history.undo, s.history.redo);
  deliver({ touched: [[1, 7]], edits: [[1, { kind: 'value', id: 7, value: 0.9 }]] });
  const result = await status;
  assert.equal(result.touched.length, 0); assert.equal(result.edits.length, 0);
  assert.equal(s.S.project.plugins[0].params[7], 0.25);
});
