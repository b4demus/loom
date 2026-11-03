// Channel rack: one row per channel — on/off, pan, volume, name, level, and the steps of the
// current pattern. A row whose notes are not plain steps shows a small piano-roll preview.

const Rack = (() => {
  let win, rowsEl, patBtn, barsLbl, swingKnob;
  const rows = new Map(); // channel id -> row parts
  let curStep = -1;

  function place() {
    const W = $('#desk').clientWidth, H = $('#desk').clientHeight;
    return { x: 12, y: Math.round(H * 0.5) + 6, w: Math.round(W * 0.46), h: Math.round(H * 0.5) - 18 };
  }

  // the window is as tall as its rows and the footer (with the rows' scrollbar), no more
  let footEl, fitted = -1;
  function contentHeight() {
    if (!rowsEl) return 0;
    const cs = getComputedStyle(rowsEl);
    const rowsH = [...rowsEl.children].reduce((s, k) => s + k.offsetHeight, 0) + (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    return rowsH + (rowsEl.offsetHeight - rowsEl.clientHeight) + footEl.offsetHeight;
  }

  function init() {
    win = WM.create('rack', { title: 'w.rack', glyph: '#', place, minW: 560, minH: 120, open: true, fit: contentHeight });
    patBtn = h('button', { class: 'tool', 'data-hint': 'hint.pat', onclick: e => patMenu(e.currentTarget) });
    barsLbl = h('span', { class: 'tlabel' });
    swingKnob = knob({ label: '', name: t('swing'), min: 0, max: 1, def: 0, size: 20, get: () => S.project.swing, set: v => { S.project.swing = v; changed(); }, fmt: v => Math.round(v * 100) + '%' });
    win.tools.append(
      h('button', { class: 'tool icon', onclick: () => cyclePat(-1) }, '<'), patBtn, h('button', { class: 'tool icon', onclick: () => cyclePat(1) }, '>'),
      h('button', { class: 'tool icon', 'data-hint': 'pat.new', onclick: () => Patterns.add() }, '+'),
      h('span', { style: 'width:8px' }),
      h('button', { class: 'tool icon', onclick: () => setBars(-1) }, '−'), barsLbl, h('button', { class: 'tool icon', onclick: () => setBars(1) }, '+'),
      h('span', { style: 'width:8px' }), h('span', { class: 'tlabel', 'data-i18n': 'swing' }, t('swing')), swingKnob,
    );
    rowsEl = h('div', { class: 'rack-rows' });
    const add = h('button', { class: 'gl-btn gl-btn-ghost gl-btn-sm', onclick: e => addMenu(e.currentTarget) }, t('add.channel'));
    footEl = h('div', { class: 'rack-foot' }, add);
    win.body.append(h('div', { class: 'rack' }, rowsEl, footEl));
    bus.on('render', render);
    render();
  }

  function cyclePat(d) {
    const ps = S.project.patterns, i = ps.findIndex(p => p.id === S.curPat);
    Patterns.select(ps[(i + d + ps.length) % ps.length].id);
  }
  function setBars(d) {
    history.edit(() => {
      const p = curPat();
      const cur = patLen(p) / BAR;
      p.bars = clamp(cur + d, 1, 64);
      if (d < 0) {
        // shrinking drops the notes past the new end
        const end = p.bars * BAR;
        for (const k in p.notes) p.notes[k] = p.notes[k].filter(n => n.t < end);
      }
    });
  }
  function patMenu(el) {
    const r = el.getBoundingClientRect();
    menu(r.left, r.bottom + 4, [
      ...S.project.patterns.map(p => ({ label: p.name, on: p.id === S.curPat, fn: () => Patterns.select(p.id) })),
      '-', { label: t('pat.new'), fn: () => Patterns.add() },
    ]);
  }

  function addChannel(make) {
    history.edit(() => {
      const id = nextId(S.project.channels);
      S.project.channels.push(make(id));
      S.curCh = id;
    });
  }
  function addMenu(el) {
    const r = el.getBoundingClientRect();
    const inst = Plugins.instruments();
    menu(r.left, r.top - 8, [
      { label: t('add.synth'), fn: () => addChannel(id => newSynth(id)) },
      { label: t('add.file'), fn: () => addFromFile() },
      {
        label: t('add.plugin'), key: inst.length ? String(inst.length) : '',
        fn: () => inst.length
          ? pickList(r.left, r.top - 8, {
            title: t('br.inst'), placeholder: t('pk.search'), empty: t('pk.none'),
            items: inst.map(info => ({ label: info.name, sub: info.vendor, tag: info.format === 'vst3' ? 'vst3' : 'vst', info })),
            onPick: it => Plugins.addInstrument(it.info),
          })
          : toast(Plugins.scanning ? t('pl.scanning') : t('pl.none'), 'info'),
      },
      { head: t('add.kit') },
      ...KIT_NAMES.map(([k, label]) => ({ label, fn: () => addChannel(id => newSampler(id, k, label)) })),
    ]);
    // the menu opened at the bottom edge: move it above the button
    if (openMenu) { const mr = openMenu.getBoundingClientRect(); openMenu.style.top = Math.max(4, r.top - mr.height - 4) + 'px'; }
  }
  async function addFromFile() {
    try {
      const s = await api.call('pick_sample');
      if (s) addSampleChannel(s);
    } catch (e) { toast(t('toast.err', { e }), 'err'); }
  }
  function addSampleChannel(s) {
    addChannel(id => {
      const c = newSampler(id, 'kick', s.name.replace(/\.[^.]+$/, ''));
      Object.assign(c.inst, { sample: s.name, path: s.path, oneshot: true, choke: false });
      return c;
    });
  }

  function chanMenu(c, x, y) {
    const items = [
      c.inst.type === 'plugin' && { label: t('fx.open'), fn: () => Plugins.openEditor(c.inst.pid) },
      { label: t('ch.roll'), key: 'F7', fn: () => { S.curCh = c.id; Roll.win.show(); redraw(); } },
      { label: t('ch.settings'), fn: () => Chan.open(c.id) },
      { label: t('ch.rename'), fn: () => renameAt(rows.get(c.id).name.getBoundingClientRect(), c.name, v => history.edit(() => { c.name = v; })) },
      { label: t('ch.clone'), fn: () => cloneChan(c) },
      { label: t('ch.solo'), on: c.solo, fn: () => solo(c) },
      '-',
      { label: t('au.vol'), fn: () => Playlist.showLane({ kind: 'chan_vol', ch: c.id }) },
      { label: t('au.pan'), fn: () => Playlist.showLane({ kind: 'chan_pan', ch: c.id }) },
      c.inst.type === 'plugin' && { label: t('au.param'), fn: () => Playlist.chooseParam(c.inst.pid, x, y, (tg, name) => Playlist.showLane(tg, name)) },
      '-',
      ...[2, 4, 8].map(n => ({ label: t('ch.fill', { n }), fn: () => fill(c, n) })),
      { label: t('ch.clear'), fn: () => history.edit(() => { curPat().notes[c.id] = []; }) },
      '-',
      { label: t('ch.up'), fn: () => move(c, -1) },
      { label: t('ch.down'), fn: () => move(c, 1) },
      { label: t('ch.delete'), danger: true, fn: () => removeChan(c) },
    ];
    menu(x, y, items);
  }
  function mixMenu(c, el) {
    const r = el.getBoundingClientRect();
    menu(r.left, r.bottom + 4, [
      { head: t('mx.target') },
      ...S.project.mixer.map((m, i) => ({
        label: (i === 0 ? 'M  ' : String(i).padEnd(3)) + (m.name || (i === 0 ? t('master') : t('insert', { n: i }))),
        on: c.mix === i, fn: () => history.edit(() => { c.mix = i; }),
      })),
      '-',
      { label: t('mx.free'), fn: () => history.edit(() => { c.mix = freeInsert(); }) },
    ]);
  }
  // the first insert nothing plays into and with no effects, or a new one (at most 64)
  function freeInsert() {
    const mx = S.project.mixer;
    for (let i = 1; i < mx.length; i++) {
      if (!mx[i].fx.length && !mx[i].input && !S.project.channels.some(ch => ch.mix === i)) return i;
    }
    if (mx.length >= 64) return 0;
    mx.push({ name: '', vol: 1, pan: 0, mute: false, solo: false, fx: [], input: 0, arm: false, out: [0] });
    return mx.length - 1;
  }
  function cloneChan(c) {
    history.edit(() => {
      const id = nextId(S.project.channels);
      const copy = JSON.parse(JSON.stringify(c));
      copy.id = id; copy.name = c.name + ' 2'; copy.solo = false;
      const chs = S.project.channels;
      chs.splice(chs.indexOf(c) + 1, 0, copy);
      S.curCh = id;
    });
  }
  function solo(c) {
    history.edit(() => {
      const on = !c.solo;
      S.project.channels.forEach(x => { x.solo = false; });
      c.solo = on;
    });
  }
  function fill(c, n) {
    history.edit(() => {
      const p = curPat(), len = patLen(p);
      const out = [];
      for (let t0 = 0; t0 < len; t0 += n * STEP) out.push({ t: t0, l: STEP, k: stepKey(c), v: 0.78 });
      p.notes[c.id] = out;
    });
  }
  function move(c, d) {
    history.edit(() => {
      const chs = S.project.channels, i = chs.indexOf(c), j = clamp(i + d, 0, chs.length - 1);
      chs.splice(i, 1); chs.splice(j, 0, c);
    });
  }
  function removeChan(c) {
    history.edit(() => {
      S.project.channels = S.project.channels.filter(x => x !== c);
      S.project.patterns.forEach(p => { delete p.notes[c.id]; });
      // an audio channel takes its clips with it
      S.project.clips = S.project.clips.filter(x => x.ch !== c.id);
      Plugins.collect();
      fixRefs();
    });
  }

  // plain steps: every note on the grid, one step long, at the channel's step key
  function stepLike(c, notes) {
    const k = stepKey(c);
    return notes.every(n => n.t % STEP === 0 && n.l <= STEP && n.k === k);
  }

  function makeRow(c) {
    const r = { id: c.id };
    r.mute = h('button', { class: 'rk-mute', 'data-hint': 'hint.mute' });
    r.mute.addEventListener('click', () => history.edit(() => { const x = chan(r.id); x.mute = !x.mute; }));
    r.mute.addEventListener('contextmenu', e => { e.preventDefault(); solo(chan(r.id)); });
    // in song mode the knobs follow their automation; turning one by hand overrides it
    const panTg = () => ({ kind: 'chan_pan', ch: r.id }), volTg = () => ({ kind: 'chan_vol', ch: r.id });
    r.pan = knob({ name: t('pan'), min: -1, max: 1, def: 0, size: 20, get: () => Auto.live(panTg()) ?? chan(r.id).pan, set: v => { Auto.touch(panTg()); chan(r.id).pan = v; changed(); }, fmt: v => Math.abs(v) < 0.01 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100) });
    r.vol = knob({ name: t('vol'), min: 0, max: 1.25, def: 1, size: 20, get: () => Auto.live(volTg()) ?? chan(r.id).vol, set: v => { Auto.touch(volTg()); chan(r.id).vol = v; changed(); }, fmt: v => Math.round(v * 100) + '%' });
    r.nameText = h('span', { class: 'nt' });
    r.plug = h('span', { class: 'np' });
    r.name = h('button', { class: 'rk-name', 'data-hint': 'hint.chname' }, h('span', { class: 'ng' }, '>'), r.nameText, r.plug);
    // an audio channel picked here is also what a click on the playlist places
    r.name.addEventListener('click', () => { if (chan(r.id).inst.type === 'audio') Patterns.pickAudio(r.id); else { S.curCh = r.id; redraw(); } });
    // a plugin channel opens the plugin's own window, like a synth in any DAW
    r.name.addEventListener('dblclick', () => { const c = chan(r.id); if (c.inst.type === 'plugin') Plugins.openEditor(c.inst.pid); else Chan.open(r.id); });
    r.mix = h('button', { class: 'rk-mix', 'data-hint': 'hint.mixbox' });
    r.mix.addEventListener('click', e => mixMenu(chan(r.id), e.currentTarget));
    r.mix.addEventListener('wheel', e => {
      e.preventDefault();
      const c = chan(r.id);
      history.edit(() => { c.mix = clamp(c.mix + (e.deltaY < 0 ? 1 : -1), 0, S.project.mixer.length - 1); });
    }, { passive: false });
    r.name.addEventListener('contextmenu', e => { e.preventDefault(); S.curCh = r.id; redraw(); chanMenu(chan(r.id), e.clientX, e.clientY); });
    r.lvlBar = h('i');
    r.lvl = h('div', { class: 'rk-lvl' }, r.lvlBar);
    r.stepsBox = h('div', { class: 'steps' });
    r.el = h('div', { class: 'rack-row', 'data-ch': c.id }, r.mute, r.pan, r.vol, r.name, r.mix, r.lvl, r.stepsBox);
    r.n = -1; r.mode = '';
    return r;
  }

  function buildSteps(r, n) {
    r.stepsBox.innerHTML = '';
    r.steps = [];
    let grp;
    for (let i = 0; i < n; i++) {
      if (i % 4 === 0) { grp = h('div', { class: 'grp' + ((i / 4) % 2 ? ' alt' : '') }); r.stepsBox.append(grp); }
      const s = h('div', { class: 'step', 'data-i': i, 'data-hint': 'hint.step' });
      grp.append(s);
      r.steps.push(s);
    }
    r.stepsBox.onpointerdown = e => stepDown(e, r);
    r.stepsBox.oncontextmenu = e => e.preventDefault();
  }

  function setStep(c, i, on) {
    const notes = notesOf(curPat(), c.id);
    const t0 = i * STEP, at = notes.findIndex(n => n.t === t0);
    if (on && at < 0) { notes.push({ t: t0, l: STEP, k: stepKey(c), v: 0.78 }); notes.sort((a, b) => a.t - b.t); return true; }
    if (!on && at >= 0) { notes.splice(at, 1); }
    return false;
  }
  function stepDown(e, r) {
    const s = e.target.closest('.step');
    if (!s) return;
    e.preventDefault();
    const c = chan(r.id);
    const i = +s.dataset.i;
    const on = e.button === 2 ? false : !s.classList.contains('on');
    history.begin();
    if (setStep(c, i, on)) preview(c.id, stepKey(c), 0.78, 120);
    changed();
    let last = i;
    drag(e, ev => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const st = el && el.closest('.step');
      if (!st || !r.stepsBox.contains(st)) return;
      const j = +st.dataset.i;
      if (j === last) return;
      last = j;
      setStep(c, j, on);
      changed();
    }, () => history.end());
  }

  function drawMini(r, c, notes, n) {
    const w = n * 19 + Math.ceil(n / 4) * 6 - 6;
    const cv = r.mini;
    const ctx = fitCanvas(cv, w, 24);
    ctx.clearRect(0, 0, w, 24);
    const len = n * STEP;
    let lo = 127, hi = 0;
    notes.forEach(x => { lo = Math.min(lo, x.k); hi = Math.max(hi, x.k); });
    const span = Math.max(12, hi - lo + 1);
    lo = Math.max(0, Math.round((lo + hi) / 2 - span / 2));
    ctx.fillStyle = TOK.line;
    for (let b = BAR; b < len; b += BAR) ctx.fillRect(Math.round(b / len * w), 0, 1, 24);
    ctx.fillStyle = TOK.accent;
    for (const x of notes) {
      const y = 21 - (x.k - lo) / span * 18;
      ctx.fillRect(x.t / len * w, Math.round(y), Math.max(2, x.l / len * w - 1), 2);
    }
  }

  function drawWaveRow(r, c, n) {
    const w = n * 19 + Math.ceil(n / 4) * 6 - 6, hh = 24;
    const ctx = fitCanvas(r.mini, w, hh);
    ctx.clearRect(0, 0, w, hh);
    const wv = Waves.get(c.inst.sample, c.inst.path);
    ctx.globalAlpha = c.mute ? 0.4 : 1;
    if (wv && wv.peaks) {
      // the whole sound across the row
      Waves.paint(ctx, wv, 0, w, hh / 2, hh / 2 - 2, c.color || TOK.accent, px => px / w * wv.seconds);
      ctx.fillStyle = TOK['ink-muted']; ctx.font = '10px ' + TOK.font; ctx.textBaseline = 'middle';
      const txt = wv.seconds.toFixed(2) + 's';
      ctx.fillStyle = TOK['grid-a']; ctx.fillRect(w - ctx.measureText(txt).width - 8, 2, ctx.measureText(txt).width + 6, 12);
      ctx.fillStyle = TOK['ink-muted']; ctx.fillText(txt, w - ctx.measureText(txt).width - 5, 8.5);
    } else {
      ctx.fillStyle = TOK['ink-faint']; ctx.fillRect(0, hh / 2, w, 1);
    }
    ctx.globalAlpha = 1;
  }

  function render() {
    if (!win) return;
    const p = curPat();
    patBtn.innerHTML = '';
    patBtn.append(h('span', { class: 'g' }, '■'), h('b', null, p ? p.name : '—'));
    patBtn.querySelector('.g').style.color = p && p.color || TOK.accent;
    barsLbl.textContent = t('bars.n', { n: patLen(p) / BAR });
    swingKnob.update();
    const chs = S.project.channels;
    // drop rows of deleted channels
    for (const [id, r] of rows) if (!chan(id)) { r.el.remove(); rows.delete(id); }
    if (!chs.length) {
      if (!rowsEl.querySelector('.rack-empty')) rowsEl.append(h('div', { class: 'rack-empty' }, t('rack.empty')));
    } else { const e = rowsEl.querySelector('.rack-empty'); if (e) e.remove(); }
    const n = patLen(p) / STEP;
    // a channel came or went: the window fits its rows again
    if (chs.length !== fitted) { fitted = chs.length; requestAnimationFrame(() => win.fit()); }
    chs.forEach((c, idx) => {
      let r = rows.get(c.id);
      if (!r) { r = makeRow(c); rows.set(c.id, r); }
      // keep DOM order without touching rows that are already in place (a drag may hold one)
      if (rowsEl.children[idx] !== r.el) rowsEl.insertBefore(r.el, rowsEl.children[idx] || null);
      r.el.classList.toggle('sel', c.id === S.curCh);
      r.el.classList.toggle('solo', !!c.solo);
      r.mute.classList.toggle('off', !!c.mute);
      r.nameText.textContent = c.name;
      r.plug.textContent = c.inst.type === 'plugin' ? (Plugins.errorOf(c.inst.pid) ? '!' : '*') : '';
      r.mix.textContent = c.mix ? String(c.mix) : '—';
      r.mix.classList.toggle('set', !!c.mix);
      r.pan.update(); r.vol.update();
      const notes = p ? (p.notes[c.id] || []) : [];
      const mode = c.inst.type === 'audio' ? 'audio' : stepLike(c, notes) ? 'steps' : 'mini';
      if (mode !== r.mode || n !== r.n) {
        r.mode = mode; r.n = n;
        if (mode === 'steps') buildSteps(r, n);
        else if (mode === 'audio') {
          // an audio channel has no steps: its sound, drawn where the steps would be
          r.stepsBox.innerHTML = '';
          r.stepsBox.onpointerdown = null;
          r.mini = h('canvas', { class: 'mini-roll mini-wave', 'data-hint': 'hint.audioch' });
          r.mini.addEventListener('click', () => Patterns.pickAudio(c.id));
          r.mini.addEventListener('dblclick', () => Chan.open(c.id));
          r.stepsBox.append(r.mini);
        } else {
          r.stepsBox.innerHTML = '';
          r.stepsBox.onpointerdown = null;
          r.mini = h('canvas', { class: 'mini-roll', 'data-hint': 'hint.mini' });
          r.mini.addEventListener('click', () => { S.curCh = c.id; Roll.win.show(); redraw(); });
          r.stepsBox.append(r.mini);
        }
      }
      if (mode === 'steps') {
        const on = new Set(notes.map(x => x.t / STEP));
        r.steps.forEach((s, i) => s.classList.toggle('on', on.has(i)));
      } else if (mode === 'audio') drawWaveRow(r, c, n);
      else drawMini(r, c, notes, n);
    });
    curStep = -1;
  }

  // called every status frame
  function tick() {
    if (!win || !win.open) return;
    let st = -1;
    if (S.playing && S.mode === 'pat') st = Math.floor(S.pos / STEP);
    if (S.playing && S.mode === 'song') {
      // show the step of the current pattern where a clip of it is playing
      const c = S.project.clips.find(c => c.p === S.curPat && S.pos >= c.t && S.pos < c.t + c.l);
      if (c) st = Math.floor(((S.pos - c.t + c.off) % patLen(curPat())) / STEP);
    }
    if (st !== curStep) {
      for (const r of rows.values()) if (r.steps) {
        if (curStep >= 0 && r.steps[curStep]) r.steps[curStep].classList.remove('cur');
        if (st >= 0 && r.steps[st]) r.steps[st].classList.add('cur');
      }
      curStep = st;
    }
    S.project.channels.forEach((c, i) => {
      const r = rows.get(c.id);
      if (!r) return;
      const v = S.peaks[i] || 0;
      r.level = Math.max(v, (r.level || 0) * 0.85);
      r.lvlBar.style.height = Math.round(clamp(r.level, 0, 1) * 22) + 'px';
      // knobs follow their automation in song mode
      if (S.mode === 'song' && (S.project.automation || []).length) { r.vol.update(); r.pan.update(); }
    });
  }

  return { init, tick, addSampleChannel, mixMenu, get win() { return win; } };
})();

// kit sounds for the add menu, same order as engine/src/kit.rs
const KIT_NAMES = [
  ['kick', 'kick'], ['snare', 'snare'], ['clap', 'clap'], ['hat', 'hat'], ['openhat', 'open hat'], ['rim', 'rim'],
  ['tom', 'tom'], ['sub', 'sub 808'], ['crash', 'crash'], ['shaker', 'shaker'], ['snap', 'snap'], ['cowbell', 'cowbell'],
];
