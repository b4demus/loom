// Mixer: the master and the insert tracks as strips (fader, meter, pan, mute, solo), and the
// effect slots of the selected track on the right. Channels pick their track in the rack.

const Mixer = (() => {
  let win, stripsEl, side, allOff;
  let sel = 0;
  const strips = []; // per track: {el, cap, mL, mR, db, pan, mute, solo, name, fx, lvl: [l, r]}

  function place() {
    const D = $('#desk');
    return { x: 24, y: Math.round(D.clientHeight * 0.3), w: Math.min(D.clientWidth - 48, 1100), h: Math.max(340, Math.round(D.clientHeight * 0.55)) };
  }
  function init() {
    win = WM.create('mixer', { title: 'w.mixer', glyph: '|', place, minW: 520, minH: 300, open: false, onResize: () => relayout() });
    // every effect of the mixer off at once: hear the mix dry, then back
    allOff = h('button', { class: 'tool fx-off', 'data-hint': 'hint.mxalloff', onclick: () => history.edit(() => { S.project.fx_off = !S.project.fx_off; }) });
    win.tools.append(allOff);
    stripsEl = h('div', { class: 'mx-strips' });
    side = h('div', { class: 'mx-side' });
    win.body.append(h('div', { class: 'mixer' }, makeCurrent(), stripsEl, side));
    bus.on('render', render);
    bus.on('restore', () => { sideSig = ''; });
    new ResizeObserver(relayout).observe(stripsEl);
  }
  // a resized window: the caps, the meter colours and the scale follow the new height
  function relayout() {
    if (!win || !win.open) return;
    strips.forEach((s, i) => { if (i < mix().length) placeCap(s, i); });
    alignScale();
  }

  // ---------- meter scale ----------
  // FL-like: +6 dB at the top, 3 dB steps down to -36 over most of the height, the quiet rest
  // squeezed into the bottom. Every meter and the scale strip use it, so their levels line up.
  const TOP_DB = 6, LOW_DB = -36, FLOOR_DB = -60, LOW_AT = 0.12;
  const meterPos = db => db >= LOW_DB ? clamp(LOW_AT + (db - LOW_DB) / (TOP_DB - LOW_DB) * (1 - LOW_AT), 0, 1)
    : clamp((db - FLOOR_DB) / (LOW_DB - FLOOR_DB) * LOW_AT, 0, 1);
  const toDb = v => v > 0 ? 20 * Math.log10(v) : -Infinity;
  const SCALE = []; // {db, label?}
  for (let db = TOP_DB; db >= LOW_DB; db -= 3) SCALE.push({ db, label: db > 0 ? '+' + db : String(db) });
  for (let db = -40; db > FLOOR_DB; db -= 4) SCALE.push({ db });
  const scaleMark = db => h('span', { class: 'mx-mark' + (db === 0 ? ' zero' : '') + (db % 6 ? ' odd' : ''), style: 'top:' + (1 - meterPos(db)) * 100 + '%' });

  // The "current" strip: the selected track's level, big, against the dB scale, with its peak
  // held below (click it to clear).
  const cur = { lvl: [0, 0], hold: [0, 0], holdT: [0, 0], peak: 0 };
  function makeCurrent() {
    cur.name = h('div', { class: 'mx-name' });
    cur.mL = h('b'); cur.mR = h('b');
    cur.hL = h('s'); cur.hR = h('s');
    cur.scale = h('div', { class: 'mx-scale' },
      h('div', { class: 'mx-cur-meter' }, h('i', null, cur.mL, cur.hL), h('i', null, cur.mR, cur.hR)),
      ...SCALE.map(m => m.label != null
        ? h('span', { class: 'mx-lbl' + (m.db === 0 ? ' zero' : '') + (m.db % 6 ? ' odd' : ''), style: 'top:' + (1 - meterPos(m.db)) * 100 + '%' }, m.label)
        : h('span', { class: 'mx-tick', style: 'top:' + (1 - meterPos(m.db)) * 100 + '%' })));
    cur.peakEl = h('button', { class: 'mx-peak', 'data-hint': 'hint.mxpeak', onclick: () => { cur.peak = 0; showPeak(); } });
    cur.el = h('div', { class: 'mx-cur', 'data-hint': 'hint.mxcur' }, h('div', { class: 'mx-cur-head' }, t('mx.current')), cur.name, cur.scale, cur.peakEl);
    showPeak();
    return cur.el;
  }
  function showPeak() {
    const db = toDb(cur.peak);
    cur.peakEl.textContent = db === -Infinity ? '-inf' : (db > 0 ? '+' : '') + db.toFixed(1);
    cur.peakEl.classList.toggle('clip', cur.peak >= 0.999);
  }
  // the scale sits level with the strips' meters (the master's stands for all of them)
  function alignScale() {
    const m = strips[0] && strips[0].el.querySelector('.mx-meter i');
    if (!m || !cur.el.offsetParent) return;
    const a = m.getBoundingClientRect(), b = cur.el.getBoundingClientRect();
    if (!a.height) return;
    cur.scale.style.top = Math.round(a.top - b.top) + 'px';
    cur.scale.style.height = Math.round(a.height) + 'px';
    cur.el.style.setProperty('--mh', Math.round(a.height) + 'px');
    cur.peakEl.style.top = Math.round(a.bottom - b.top + 10) + 'px';
    // too short for a label every 3 dB: every 6
    cur.scale.classList.toggle('dense', a.height < 200);
  }
  const mix = () => S.project.mixer;
  const label = i => i === 0 ? 'M' : String(i);
  const trackName = i => mix()[i].name || (i === 0 ? t('master') : t('insert', { n: i }));
  // fader travel: cube-ish curve so the useful range gets the room; 1.0 sits at about 80%
  const toPos = v => Math.pow(clamp(v, 0, 1.25) / 1.25, 1 / 2.2);
  const fromPos = p => Math.pow(clamp(p, 0, 1), 2.2) * 1.25;
  const dbText = v => v <= 0.0001 ? '-inf' : (20 * Math.log10(v)).toFixed(1);

  function select(i) {
    const was = sel;
    sel = clamp(i, 0, mix().length - 1);
    // the scale strip follows the selection: its peaks start over
    if (sel !== was) { cur.peak = 0; cur.hold = [0, 0]; cur.lvl = [0, 0]; showPeak(); }
    render();
  }

  function addTrack() {
    if (mix().length >= 64) return;
    history.edit(() => { mix().push({ name: '', vol: 1, pan: 0, mute: false, solo: false, fx: [], input: 0, arm: false, out: [0] }); });
    select(mix().length - 1);
  }
  // prev: the track selected before this right-click (FL: route the selected track here)
  function trackMenu(i, x, y, prev = sel) {
    const m = mix()[i];
    menu(x, y, [
      { label: t('track.rename'), fn: () => renameAt(strips[i].name.getBoundingClientRect(), m.name, v => history.edit(() => { m.name = v; })) },
      i > 0 && { label: t('mx.route'), fn: () => { history.edit(() => { const c = curChan(); if (c) c.mix = i; }); } },
      i > 0 && { label: t('mx.routeto', { track: '' }) + '…', fn: () => routeMenu(i, strips[i].route) },
      // FL's quick route: the selected track into this one
      i !== prev && prev > 0 && { label: t('mx.routesel', { from: label(prev) + ' ' + trackName(prev) }), on: mix()[prev].out.includes(i), disabled: !mix()[prev].out.includes(i) && reaches(i, prev), fn: () => setRoute(prev, i, !mix()[prev].out.includes(i)) },
      '-',
      { label: t('au.vol'), fn: () => Playlist.showLane({ kind: 'mix_vol', track: i }) },
      { label: t('au.pan'), fn: () => Playlist.showLane({ kind: 'mix_pan', track: i }) },
      '-',
      { label: t('mx.copychain'), disabled: !m.fx.length, fn: () => copyChain(i) },
      { label: t('mx.pastechain'), disabled: !chain, fn: () => pasteChain(i, false) },
      { label: t('mx.appendchain'), disabled: !chain || m.fx.length >= MAX_FX, fn: () => pasteChain(i, true) },
      i > 0 && i === mix().length - 1 && '-',
      i > 0 && i === mix().length - 1 && { label: t('ch.delete'), danger: true, fn: () => removeTrack(i) },
    ]);
  }

  // ---------- copying an effect chain to another track ----------
  // The copy keeps each plugin's settings as they are now; pasting makes new instances from them.
  const MAX_FX = 10;
  let chain = null; // [{desc, on, mix}]
  async function copyChain(i) {
    const fx = mix()[i].fx;
    if (!fx.length) return;
    await Plugins.captureStates();
    chain = fx.map(f => ({ desc: Plugins.desc(f.pid), on: f.on, mix: f.mix })).filter(x => x.desc)
      .map(x => ({ ...x, desc: JSON.parse(JSON.stringify(x.desc)) }));
    toast(t('mx.copied', { n: chain.length }), 'info');
    render();
  }
  function pasteChain(i, append) {
    if (!chain) return;
    history.edit(() => {
      const m = mix()[i];
      const copies = chain.map(x => {
        const d = { ...JSON.parse(JSON.stringify(x.desc)), id: S.project.plugins.reduce((n, p) => Math.max(n, p.id), 0) + 1 };
        S.project.plugins.push(d);
        return { pid: d.id, on: x.on, mix: x.mix };
      });
      m.fx = (append ? m.fx.concat(copies) : copies).slice(0, MAX_FX);
      Plugins.collect();
    });
    toast(t('mx.pasted', { track: label(i) + ' ' + trackName(i) }), 'info');
  }
  function removeTrack(i) {
    history.edit(() => {
      mix().splice(i, 1);
      S.project.channels.forEach(c => { if (c.mix === i) c.mix = 0; else if (c.mix > i) c.mix--; });
      // routes into it go to the master instead; the rest keep their tracks
      mix().forEach((m, k) => {
        if (!k) return;
        const had = m.out.includes(i);
        m.out = m.out.filter(d => d !== i).map(d => d > i ? d - 1 : d);
        if (had && !m.out.length) m.out = [0];
      });
      Plugins.collect();
    });
    select(Math.min(sel, mix().length - 1));
  }

  // ---------- routing: a track plays into any other tracks (FL's "route to") ----------
  // true when `from` already reaches `to` through its routes (a route to → from would loop)
  function reaches(from, to) {
    const seen = new Set(), stack = [from];
    while (stack.length) {
      const k = stack.pop();
      if (k === to) return true;
      if (seen.has(k)) continue;
      seen.add(k);
      stack.push(...(mix()[k]?.out || []));
    }
    return false;
  }
  function setRoute(i, d, on) {
    history.edit(() => {
      const m = mix()[i];
      m.out = on ? [...new Set([...m.out, d])].sort((a, b) => a - b) : m.out.filter(x => x !== d);
    });
  }
  function routeMenu(i, el) {
    const r = el.getBoundingClientRect(), m = mix()[i];
    menu(r.left, r.bottom + 4, [
      { head: t('mx.routeto', { track: label(i) + ' ' + trackName(i) }) },
      ...mix().map((_, d) => d === i ? null : {
        label: label(d).padEnd(3) + trackName(d), on: m.out.includes(d),
        // a track that already plays into this one cannot take it back: that is a loop
        disabled: !m.out.includes(d) && reaches(d, i),
        fn: () => setRoute(i, d, !m.out.includes(d)),
      }),
      '-',
      { label: t('mx.routemaster'), fn: () => history.edit(() => { m.out = [0]; }) },
      { label: t('mx.routenone'), fn: () => history.edit(() => { m.out = []; }) },
    ]);
  }
  const routeText = m => !m.out.length ? '→ —' : '→ ' + m.out.map(label).join(' ');

  function makeStrip(i) {
    const s = { lvl: [0, 0] };
    s.num = h('div', { class: 'mx-num' }, label(i));
    s.name = h('div', { class: 'mx-name' });
    s.fx = h('div', { class: 'mx-fx' });
    // live input heard through the track, and arming it for recording (as in FL)
    s.in = h('button', { class: 'mx-in', 'data-hint': 'hint.mxin' });
    s.in.addEventListener('click', e => { e.stopPropagation(); inputMenu(i, e.currentTarget); });
    // armed, the track records its own sound (input or not); right-click: or its dry input
    s.arm = h('button', { class: 'mx-arm', 'data-hint': 'hint.mxarm', 'aria-label': t('rec.rec') });
    s.arm.addEventListener('click', e => { e.stopPropagation(); history.edit(() => { mix()[i].arm = !mix()[i].arm; }); });
    s.arm.addEventListener('contextmenu', e => {
      e.preventDefault(); e.stopPropagation();
      const m = mix()[i];
      menu(e.clientX, e.clientY, [
        { head: t('mx.recwhat') },
        { label: t('mx.recout'), on: !m.rec_dry, fn: () => history.edit(() => { m.rec_dry = false; m.arm = true; }) },
        { label: t('mx.recdry'), on: !!m.rec_dry, disabled: !m.input, fn: () => history.edit(() => { m.rec_dry = true; m.arm = true; }) },
      ]);
    });
    // where the track plays into: the master unless routed elsewhere (FL routing)
    s.route = h('button', { class: 'mx-route', 'data-hint': 'hint.mxroute' });
    s.route.addEventListener('click', e => { e.stopPropagation(); routeMenu(i, e.currentTarget); });
    s.cap = h('div', { class: 'mx-cap' });
    const unity = h('div', { class: 'mx-unity' });
    const track = h('div', { class: 'mx-track', 'data-hint': 'hint.fader' }, unity, s.cap);
    s.mL = h('b'); s.mR = h('b');
    // the dB marks beside each meter, level with the scale strip
    const meter = h('div', { class: 'mx-meter' }, h('i', null, s.mL), h('i', null, s.mR),
      h('div', { class: 'mx-marks' }, ...SCALE.filter(m => m.label != null).map(m => scaleMark(m.db))));
    s.db = h('div', { class: 'mx-db' });
    const panTg = { kind: 'mix_pan', track: i };
    s.pan = knob({ name: t('pan'), min: -1, max: 1, def: 0, size: 22, get: () => Auto.live(panTg) ?? mix()[i].pan, set: v => { Auto.touch(panTg); mix()[i].pan = v; changed(); }, fmt: v => Math.abs(v) < 0.01 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100) });
    s.mute = h('button', { class: 'rk-mute', 'data-hint': 'hint.mute' });
    s.mute.addEventListener('click', e => { e.stopPropagation(); history.edit(() => { mix()[i].mute = !mix()[i].mute; }); });
    s.solo = h('button', { class: 'mx-solo', 'data-hint': 'hint.solo' }, 's');
    s.solo.addEventListener('click', e => {
      e.stopPropagation();
      history.edit(() => { const on = !mix()[i].solo; mix().forEach(m => { m.solo = false; }); mix()[i].solo = on; });
    });
    // this track's effects on/off, right on the strip (the slots keep them, the sound passes by)
    s.fxb = h('button', { class: 'mx-fxb', 'data-hint': 'hint.mxfxoff' }, 'fx');
    s.fxb.addEventListener('click', e => { e.stopPropagation(); history.edit(() => { mix()[i].fx_off = !mix()[i].fx_off; }); });
    const btns = h('div', { class: 'mx-btns' }, s.mute, i > 0 ? s.solo : null, s.fxb);
    s.el = h('div', { class: 'mx-strip' + (i === 0 ? ' master' : ''), 'data-mix': i },
      s.num, s.name, h('div', { class: 'mx-io' }, s.in, s.arm), s.fx, s.pan, h('div', { class: 'mx-fader' }, track, meter), s.db, btns, i > 0 ? s.route : null);
    s.el.addEventListener('pointerdown', () => { if (sel !== i) select(i); });
    s.el.addEventListener('contextmenu', e => { e.preventDefault(); const prev = sel; select(i); trackMenu(i, e.clientX, e.clientY, prev); });
    s.name.addEventListener('dblclick', () => renameAt(s.name.getBoundingClientRect(), mix()[i].name, v => history.edit(() => { mix()[i].name = v; })));
    // the fader: drag the track anywhere, Shift for fine, double-click or middle-click for 0 dB.
    // Moving it by hand overrides its automation (Ableton) until automation is re-enabled.
    const volTg = { kind: 'mix_vol', track: i };
    const setVol = v => { Auto.touch(volTg); mix()[i].vol = v; };
    track.addEventListener('pointerdown', e => {
      if (e.button === 1) { e.preventDefault(); history.edit(() => setVol(1)); return; }
      if (e.button !== 0) return;
      e.preventDefault();
      history.begin();
      hintLock = true;
      const r = track.getBoundingClientRect();
      let p = toPos(Auto.live(volTg) ?? mix()[i].vol);
      let last = e.clientY;
      const set = () => { setVol(fromPos(p)); placeCap(s, i); hintValue(trackName(i), dbText(mix()[i].vol) + ' dB'); changed(); };
      if (!e.target.classList.contains('mx-cap')) { p = clamp(1 - (e.clientY - r.top) / r.height, 0, 1); set(); }
      drag(e, ev => { p = clamp(p + (last - ev.clientY) / r.height * (ev.shiftKey ? 0.2 : 1), 0, 1); last = ev.clientY; set(); },
        () => { hintLock = false; history.end(); });
    });
    track.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
    track.addEventListener('dblclick', () => history.edit(() => setVol(1)));
    track.addEventListener('wheel', e => { e.preventDefault(); history.edit(() => setVol(fromPos(clamp(toPos(mix()[i].vol) + (e.deltaY < 0 ? 0.02 : -0.02), 0, 1)))); }, { passive: false });
    return s;
  }
  function placeCap(s, i) {
    const h0 = s.cap.parentElement.clientHeight || 100;
    // automation moves the fader in song mode
    const vol = Auto.live({ kind: 'mix_vol', track: i }) ?? mix()[i].vol;
    s.cap.style.top = Math.round((1 - toPos(vol)) * h0) + 'px';
    s.el.style.setProperty('--mh', h0 + 'px');
    s.db.textContent = dbText(vol);
    s.el.classList.toggle('auto', !!Auto.laneOf({ kind: 'mix_vol', track: i })?.points.length);
    const u = s.cap.parentElement.querySelector('.mx-unity');
    if (u) u.style.top = Math.round((1 - toPos(1)) * h0) + 'px';
  }

  async function inputMenu(i, el, thenArm) {
    const r = el.getBoundingClientRect(), m = mix()[i];
    let catalog;
    try { catalog = await api.call('mixer_inputs', { device: Rec.input }); }
    catch (e) { toast(t('rec.noinput', { e }), 'err'); return; }
    if (mix()[i] !== m) return;
    const choices = catalog?.choices || [];
    const busy = Rec.live || Rec.stopping || Transport.starting;
    const choose = choice => history.edit(() => {
      m.input = choice.code; m.input_name = choice.name;
      if (!m.input) m.arm = false; else if (thenArm) m.arm = true;
    });
    menu(r.left, r.bottom + 4, [
      { head: [t('mx.input'), catalog?.driver, catalog?.device].filter(Boolean).join(' · ') },
      { label: t('mx.in0'), on: !m.input, disabled: busy, fn: () => choose({ code: 0, name: '' }) },
      ...choices.map(choice => ({
        label: choice.name, key: t(choice.stereo ? 'mx.stereo' : 'mx.mono') + ' · ' + inputNumber(choice.code), on: m.input === choice.code,
        disabled: busy, fn: () => choose(choice),
      })),
      !choices.length && { head: t('mx.noinputs') },
      '-',
      catalog?.driver === 'ASIO' && { label: t('s.asiopanel'), disabled: busy, fn: async () => {
        try { await api.call('audio_panel'); } catch (e) { toast(t('toast.err', { e }), 'err'); }
      } },
      { label: t('mx.refreshinputs'), disabled: busy, fn: async () => {
        try {
          if (catalog?.driver === 'ASIO') { await api.call('set_device', { device: 'asio:' + catalog.device }); await syncInput(true); }
          await inputMenu(i, el, thenArm);
        } catch (e) { toast(t('rec.noinput', { e }), 'err'); }
      } },
    ]);
  }

  function slotMenu(i, k, x, y) {
    const f = mix()[i].fx[k];
    menu(x, y, [
      { label: t('fx.open'), fn: () => Plugins.openEditor(f.pid) },
      { label: f.on ? t('fx.bypass') : t('fx.enable'), fn: () => history.edit(() => { f.on = !f.on; }) },
      { label: t('au.param'), fn: () => Playlist.chooseParam(f.pid, x, y, (tg, name) => Playlist.showLane(tg, name), true) },
      k > 0 && { label: t('ch.up'), fn: () => history.edit(() => { const a = mix()[i].fx; [a[k - 1], a[k]] = [a[k], a[k - 1]]; }) },
      k < mix()[i].fx.length - 1 && { label: t('ch.down'), fn: () => history.edit(() => { const a = mix()[i].fx; [a[k + 1], a[k]] = [a[k], a[k + 1]]; }) },
      '-',
      { label: t('ch.delete'), danger: true, fn: () => history.edit(() => { mix()[i].fx.splice(k, 1); Plugins.collect(); }) },
    ]);
  }
  function effectMenu(i, slot, x, y) {
    const fx = Plugins.effects();
    if (!fx.length) { toast(Plugins.scanning ? t('pl.scanning') : t('pl.none'), 'info'); return; }
    pickList(x, y, {
      title: t('pl.effects') + ' · ' + label(i) + ' ' + trackName(i), placeholder: t('pk.search'), empty: t('pk.none'),
      items: fx.map(info => ({ label: info.name, sub: info.vendor, tag: info.format === 'vst3' ? 'vst3' : 'vst', info })),
      onPick: it => Plugins.addEffect(it.info, i, slot),
    });
  }

  // rebuilt only when what it shows changes: a rebuild under the pointer would eat clicks and drags
  let sideSig = '', sideKnobs = [];
  function renderSide() {
    const m = mix()[sel];
    if (!m) return;
    const sig = [sel, trackName(sel), m.input, m.input_name, LANG, !!chain, !!m.fx_off, !!S.project.fx_off, ...m.fx.map(f => f.pid + ':' + f.on + ':' + Plugins.nameOf(f.pid) + ':' + (Plugins.errorOf(f.pid) || ''))].join('|');
    if (sig === sideSig) { sideKnobs.forEach(k => k.update()); return; }
    sideSig = sig;
    sideKnobs = [];
    side.innerHTML = '';
    const i = sel;
    const copyBtn = h('button', { class: 'tool', 'data-hint': 'hint.mxcopy', disabled: !m.fx.length, onclick: () => copyChain(i) }, icon('copy'), t('mx.copy'));
    const pasteBtn = h('button', { class: 'tool', 'data-hint': 'hint.mxpaste', disabled: !chain, onclick: () => pasteChain(i, false) }, icon('paste'), t('mx.paste'));
    // this track's processing on/off (the slots stay, the sound passes them by)
    const offBtn = h('button', { class: 'tool fx-off' + (m.fx_off ? ' on' : ''), 'data-hint': 'hint.mxfxoff', onclick: () => history.edit(() => { mix()[i].fx_off = !mix()[i].fx_off; }) }, icon('power'), m.fx_off ? t('mx.fxoff') : t('mx.fxon'));
    side.append(h('div', { class: 'mx-side-head' },
      h('span', { class: 'gl-section' }, t('mx.slots')),
      h('span', { class: 't' }, label(sel) + ' · ' + trackName(sel)),
      h('div', { class: 'mx-chain' }, offBtn, copyBtn, pasteBtn)));
    side.append(h('div', { class: 'mx-input-name', title: m.input_name || '' }, t('mx.input') + ': ' + (m.input ? m.input_name || inputNumber(m.input) : t('mx.in0'))));
    const list = h('div', { class: 'mx-slots' + (m.fx_off || S.project.fx_off ? ' bypassed' : '') });
    m.fx.forEach((f, k) => {
      const current = () => mix()[i]?.fx.find(x => x.pid === f.pid);
      const err = Plugins.errorOf(f.pid);
      const on = h('button', { class: 'rk-mute' + (f.on ? '' : ' off'), 'data-hint': 'hint.bypass' });
      on.addEventListener('click', e => { e.stopPropagation(); history.edit(() => { const fx = current(); if (fx) fx.on = !fx.on; }); });
      const name = h('span', { class: 'sn', title: err || '' }, h('span', { class: 'so' }, '['), Plugins.nameOf(f.pid), h('span', { class: 'so' }, ']'));
      const wetTg = { kind: 'fx_mix', pid: f.pid };
      const wet = knob({ name: t('fx.mix'), min: 0, max: 1, def: 1, size: 18, get: () => Auto.live(wetTg) ?? current()?.mix ?? 1, set: v => { const fx = current(); if (fx) { Auto.touch(wetTg); fx.mix = v; changed(); } }, fmt: v => Math.round(v * 100) + '%' });
      sideKnobs.push(wet);
      const row = h('div', { class: 'mx-slot' + (f.on ? '' : ' off') + (err ? ' err' : ''), 'data-slot': k, 'data-hint': 'hint.slot' }, on, name, wet);
      // the whole row opens the plugin's window; the square and the knob keep their own jobs
      row.addEventListener('click', e => { if (!e.target.closest('.knob, .rk-mute')) Plugins.openEditor(f.pid); });
      row.addEventListener('contextmenu', e => { e.preventDefault(); slotMenu(sel, k, e.clientX, e.clientY); });
      // The wheel over a slot turns its wet knob (as over the knob itself) instead of scrolling
      // the list, which made the slots slide up and down under the pointer.
      row.addEventListener('wheel', e => {
        if (e.target.closest('.knob')) return;
        e.preventDefault();
        const fx = current();
        if (!fx) return;
        const v = clamp((fx.mix ?? 1) + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.005 : 0.025), 0, 1);
        Auto.touch(wetTg);
        history.edit(() => { fx.mix = v; });
        wet.update();
        hintValue(t('fx.mix'), Math.round(v * 100) + '%');
      }, { passive: false });
      list.append(row);
    });
    if (m.fx.length < MAX_FX) {
      const add = h('div', { class: 'mx-slot empty', 'data-slot': m.fx.length, 'data-hint': 'hint.addfx' }, icon('plus'), h('span', null, t('fx.add')));
      add.addEventListener('click', e => effectMenu(sel, null, e.clientX, e.clientY));
      list.append(add);
    }
    side.append(list);
  }

  let built = -1;
  function render() {
    if (!win || !win.open) return;
    allOff.textContent = (S.project.fx_off ? '⊘ ' : '◇ ') + t(S.project.fx_off ? 'mx.alloff' : 'mx.allon');
    allOff.classList.toggle('on', !!S.project.fx_off);
    const n = mix().length;
    if (built !== n) {
      stripsEl.innerHTML = '';
      strips.length = 0;
      for (let i = 0; i < n; i++) { const s = makeStrip(i); strips.push(s); stripsEl.append(s.el); }
      stripsEl.append(h('button', { class: 'mx-add', 'data-hint': 'hint.addtrack', onclick: addTrack }, '+'));
      built = n;
    }
    sel = Math.min(sel, n - 1);
    const target = curChan() ? curChan().mix : -1;
    strips.forEach((s, i) => {
      const m = mix()[i];
      s.el.classList.toggle('sel', i === sel);
      s.el.classList.toggle('target', i === target);
      s.name.textContent = m.name || (i === 0 ? t('master') : '');
      s.name.classList.toggle('empty', !m.name && i > 0);
      s.fx.textContent = m.fx.length ? '*'.repeat(Math.min(m.fx.length, 6)) : '';
      s.fx.classList.toggle('off', !!m.fx_off || !!S.project.fx_off);
      s.fxb.classList.toggle('off', !!m.fx_off);
      s.fxb.classList.toggle('none', !m.fx.length);
      s.mute.classList.toggle('off', !!m.mute);
      s.solo.classList.toggle('on', !!m.solo);
      s.in.textContent = 'IN ' + (m.input_name || inputNumber(m.input));
      s.in.title = m.input_name ? m.input_name + ' · ' + inputNumber(m.input) : t('mx.input') + ': ' + inputNumber(m.input);
      s.in.classList.toggle('set', !!m.input);
      s.arm.classList.toggle('on', !!m.arm);
      s.arm.classList.toggle('dry', !!m.rec_dry && !!m.input);
      if (s.route) { s.route.textContent = routeText(m); s.route.classList.toggle('none', !m.out.length); s.route.classList.toggle('bus', m.out.some(d => d > 0)); }
      // the tracks the selected one plays into
      s.el.classList.toggle('feeds', i !== sel && (mix()[sel]?.out || []).includes(i) && i > 0);
      s.el.classList.toggle('armed', !!m.arm);
      s.pan.update();
      placeCap(s, i);
    });
    cur.name.textContent = label(sel) + ' ' + trackName(sel);
    cur.name.title = cur.name.textContent;
    cur.el.querySelector('.mx-cur-head').textContent = t('mx.current');
    alignScale();
    renderSide();
  }

  function tick(peaks) {
    if (!win || !win.open) return;
    // faders and pans follow their automation while the song plays
    const moving = S.mode === 'song' && (S.project.automation || []).length > 0;
    strips.forEach((s, i) => {
      if (moving && i < mix().length) { placeCap(s, i); s.pan.update(); if (i === sel) sideKnobs.forEach(k => k.update()); }
      for (let c = 0; c < 2; c++) {
        const v = peaks[i * 2 + c] || 0;
        s.lvl[c] = Math.max(v, s.lvl[c] * 0.85);
        const b = c ? s.mR : s.mL;
        b.style.height = meterPos(toDb(s.lvl[c])) * 100 + '%';
        b.classList.toggle('clip', s.lvl[c] >= 0.999);
      }
    });
    // the selected track on the scale strip: level, a peak line held 1.5 s, the peak since cleared
    const now = performance.now();
    for (let c = 0; c < 2; c++) {
      const v = peaks[sel * 2 + c] || 0;
      cur.lvl[c] = Math.max(v, cur.lvl[c] * 0.85);
      if (v >= cur.hold[c]) { cur.hold[c] = v; cur.holdT[c] = now; }
      else if (now - cur.holdT[c] > 1500) cur.hold[c] *= 0.9;
      const b = c ? cur.mR : cur.mL, hl = c ? cur.hR : cur.hL;
      b.style.height = meterPos(toDb(cur.lvl[c])) * 100 + '%';
      b.classList.toggle('clip', cur.lvl[c] >= 0.999);
      hl.style.bottom = meterPos(toDb(cur.hold[c])) * 100 + '%';
      hl.style.display = cur.hold[c] > 0.001 ? '' : 'none';
      if (v > cur.peak) { cur.peak = v; showPeak(); }
    }
  }

  return { init, render, tick, select, selected: () => sel, effectMenu, get win() { return win; } };
})();
