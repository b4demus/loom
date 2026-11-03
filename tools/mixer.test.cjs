const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./ui-test-harness.cjs');

const catalog = { device: 'ASIO4ALL v2', driver: 'ASIO', choices: [
  { code: 1, name: 'C-MEDIA USB Audio Device', stereo: false },
  { code: 2, name: 'Microphone Left', stereo: false },
  { code: 18, name: 'Microphone Right', stereo: false },
  { code: 1025, name: 'Microphone Left + Right', stereo: true },
] };

test('mixer IN displays named ASIO4ALL inputs and selects the actual later input', async () => {
  const s = setup({ mixer: true });
  s.api.call = async command => command === 'mixer_inputs' ? catalog : null;
  const input = s.elements.filter(e => e.className === 'mx-in')[1];
  input.emit('click', { stopPropagation() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(s.getMenu().some(item => item.head?.includes('ASIO4ALL v2')));
  const microphone = s.getMenu().find(item => item.label === 'Microphone Right');
  assert.ok(microphone);
  microphone.fn(); s.bus.emit('render');
  assert.equal(s.S.project.mixer[1].input, 18);
  assert.equal(s.S.project.mixer[1].input_name, 'Microphone Right');
  assert.equal(input.textContent, 'IN Microphone Right');
  const restored = s.normalize(JSON.parse(JSON.stringify(s.S.project)));
  assert.equal(restored.mixer[1].input, 18);
  assert.equal(restored.mixer[1].input_name, 'Microphone Right');
});

test('an effect chain copies to another track as new instances with the same settings', async () => {
  const s = setup({ mixer: true });
  const fx = (id, name, state) => ({ id, format: 'vst3', path: 'C:/' + name + '.vst3', cid: name, name, vendor: 'x', instrument: false, state });
  s.S.project.plugins.push(fx(1, 'EQ', 'eq-state'), fx(2, 'OTT', 'ott-state'));
  s.S.project.mixer[1].fx = [{ pid: 1, on: true, mix: 1 }, { pid: 2, on: false, mix: 0.4 }];
  s.S.project.mixer[2].fx = [{ pid: 3, on: true, mix: 1 }];
  s.S.project.plugins.push(fx(3, 'Old', 'old'));
  s.bus.emit('render');
  const strips = s.elements.filter(e => e['data-mix'] != null);
  strips[1].emit('contextmenu');
  await s.getMenu().find(i => i.label === 'копировать цепочку эффектов').fn();
  strips[2].emit('contextmenu');
  s.getMenu().find(i => i.label === 'вставить цепочку (заменить)').fn();
  const dst = s.S.project.mixer[2].fx;
  assert.equal(dst.length, 2);
  assert.ok(dst.every(f => f.pid > 3), 'pasted effects are new instances');
  const descs = dst.map(f => s.S.project.plugins.find(p => p.id === f.pid));
  const plain = x => JSON.parse(JSON.stringify(x));
  assert.deepEqual(plain(descs.map(d => [d.name, d.state])), [['EQ', 'eq-state'], ['OTT', 'ott-state']]);
  assert.deepEqual(plain(dst.map(f => [f.on, f.mix])), [[true, 1], [false, 0.4]]);
  assert.ok(!s.S.project.plugins.some(p => p.id === 3), 'the replaced effect leaves the project');
  assert.equal(s.S.project.mixer[1].fx[0].pid, 1, 'the source keeps its own instances');
  strips[3].emit('contextmenu');
  s.getMenu().find(i => i.label === 'добавить цепочку в конец').fn();
  assert.equal(s.S.project.mixer[3].fx.length, 2);
  s.undo(); assert.equal(s.S.project.mixer[3].fx.length, 0);
});

test('named stereo inputs preserve routing and clearing the input disarms recording', async () => {
  const s = setup({ mixer: true });
  s.api.call = async command => command === 'mixer_inputs' ? catalog : null;
  const input = s.elements.filter(e => e.className === 'mx-in')[1];
  input.emit('click', { stopPropagation() {} });
  await new Promise(resolve => setImmediate(resolve));
  s.getMenu().find(item => item.label === 'Microphone Left + Right').fn();
  assert.equal(s.S.project.mixer[1].input, 1025);
  s.S.project.mixer[1].arm = true;
  s.getMenu().find(item => item.label === 'нет').fn();
  assert.equal(s.S.project.mixer[1].input, 0);
  assert.equal(s.S.project.mixer[1].input_name, '');
  assert.equal(s.S.project.mixer[1].arm, false);
});

test('mixer tracks route into groups, never into a loop', () => {
  const s = setup({ mixer: true });
  // the master has no route button in its strip: index i is insert i
  const routes = () => s.elements.filter(e => e.className && String(e.className).startsWith('mx-route'));
  const M = s.S.project.mixer;
  // insert 1 → insert 3 (a group), off the master
  routes()[1].emit('click', { stopPropagation() {} });
  s.getMenu().find(i => i.label && i.label.startsWith('3')).fn();
  routes()[1].emit('click', { stopPropagation() {} });
  s.getMenu().find(i => i.label && i.label.startsWith('M')).fn();
  assert.deepEqual(JSON.parse(JSON.stringify(M[1].out)), [3]);
  // insert 3 cannot route back into 1
  s.bus.emit('render');
  routes()[3].emit('click', { stopPropagation() {} });
  const back = s.getMenu().find(i => i.label && i.label.startsWith('1'));
  assert.equal(back.disabled, true);
  assert.equal(s.getMenu().find(i => i.label && i.label.startsWith('2')).disabled, false);
});

test('each mixer strip switches its own effects off and on', () => {
  const s = setup({ mixer: true });
  const M = s.S.project.mixer;
  M[2].fx = [{ pid: 4, on: true, mix: 1 }];
  s.bus.emit('render');
  const fxb = s.elements.filter(e => e.className === 'mx-fxb');
  fxb[2].emit('click', { stopPropagation() {} });
  assert.equal(M[2].fx_off, true);
  assert.equal(M[1].fx_off, false, 'the other tracks keep theirs');
  assert.equal(M[2].fx.length, 1, 'the effect stays in its slot');
  s.undo();
  assert.equal(s.S.project.mixer[2].fx_off, false);
});

test('Shift+wheel moves the same effect across slots and keeps its mix and bypass settings', () => {
  const s = setup({ mixer: true });
  s.S.project.mixer[1].fx = [
    { pid: 1, on: true, mix: 0.2 },
    { pid: 2, on: false, mix: 0.4 },
    { pid: 3, on: true, mix: 0.6 },
  ];
  s.Mixer.select(1);
  const list = () => s.elements.find(e => e.className === 'mx-side').querySelector('.mx-slots');
  const order = () => Array.from(s.S.project.mixer[1].fx, f => f.pid);
  const wheel = (slot, event) => {
    list().children[slot].emit('wheel', { clientX: 40, clientY: 50, ...event });
    s.bus.emit('render');
  };

  list().scrollTop = 14;
  wheel(0, { shiftKey: true, deltaY: 120 });
  assert.deepEqual(order(), [2, 1, 3]);
  assert.equal(list().scrollTop, 14);
  // Chromium can report Shift+wheel on the horizontal axis. The pointer still sits in slot 0.
  wheel(0, { shiftKey: true, deltaX: 120 });
  assert.deepEqual(order(), [2, 3, 1]);
  wheel(0, { shiftKey: true, deltaY: 120 });
  assert.deepEqual(order(), [2, 3, 1], 'the last slot does not wrap');
  wheel(0, { shiftKey: true, deltaY: -120 });
  assert.deepEqual(order(), [2, 1, 3]);

  s.elements.find(e => e.tag === 'window').emit('keyup', { key: 'Shift', shiftKey: false });
  let stopped = false;
  wheel(0, {
    shiftKey: true, deltaY: 120, target: list().children[0].children[2],
    stopPropagation() { stopped = true; },
  });
  assert.ok(stopped, 'Shift+wheel over the knob is intercepted by its row');
  assert.deepEqual(order(), [1, 2, 3]);
  assert.equal(s.S.project.mixer[1].fx[1].on, false);
  assert.equal(s.S.project.mixer[1].fx[1].mix, 0.4);
  s.undo();
  assert.deepEqual(order(), [2, 1, 3]);
  s.redo();
  assert.deepEqual(order(), [1, 2, 3]);

  wheel(0, { deltaY: -120, target: { closest: () => null } });
  assert.deepEqual(order(), [1, 2, 3]);
  assert.equal(s.S.project.mixer[1].fx[0].mix, 0.225);
});
