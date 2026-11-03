// The channel window (sampler or synth controls) and the settings window.

const Chan = (() => {
  let win, form, id = null, built = '', knobs = [], wave = null, peaksKey = '', mixBtn = null;

  function place() {
    const D = $('#desk');
    return { x: Math.round(D.clientWidth * 0.5) - 260, y: 80, w: 520, h: 470 };
  }
  function init() {
    win = WM.create('chan', { title: 'w.chan', glyph: '~', place, minW: 440, minH: 160, open: false, onResize: () => drawWave(), fit: contentHeight });
    form = h('div', { class: 'form' });
    win.body.append(form);
    bus.on('render', render);
    bus.on('restore', () => { built = null; peaksKey = ''; });
  }
  function open(chId) {
    id = chId;
    S.curCh = chId;
    built = '';
    win.show();
    redraw();
  }

  // the wave's height in the channel window, border included (style.css .wave)
  const WAVE_H = 72;
  // what the form needs: its rows, the gaps between them and its padding
  function contentHeight() {
    if (!form || !form.children.length) return 0;
    const cs = getComputedStyle(form);
    const kids = [...form.children];
    return kids.reduce((s, k) => s + k.offsetHeight, 0) + (parseFloat(cs.rowGap) || 0) * (kids.length - 1)
      + (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  }

  const c = () => chan(id);
  const ip = () => c().inst;
  function kn(label, min, max, def, key, fmt, extra) {
    const k = knob(Object.assign({
      label, min, max, def, size: 30, showValue: true, fmt,
      // a value the channel does not have yet (made before the field existed) reads as the default
      get: () => ip()[key] ?? def, set: v => { ip()[key] = v; changed(); },
    }, extra || {}));
    knobs.push(k);
    return k;
  }
  // the channel's fader and pan: they follow automation in song mode, a turn by hand overrides it
  function chKn(label, min, max, def, key, fmt) {
    const tg = () => ({ kind: key === 'vol' ? 'chan_vol' : 'chan_pan', ch: id });
    const k = knob({ label, min, max, def, size: 30, showValue: true, fmt, get: () => Auto.live(tg()) ?? c()[key], set: v => { Auto.touch(tg()); c()[key] = v; changed(); } });
    knobs.push(k);
    return k;
  }
  // which mixer track the channel plays into, right here (like the rack's box)
  function mixBox() {
    const b = h('button', { class: 'gl-btn gl-btn-secondary gl-btn-sm mixbox', 'data-hint': 'hint.chmix' });
    const label = () => {
      const i = c().mix, m = S.project.mixer[i] || {};
      b.textContent = '| ' + (i === 0 ? 'M' : i) + '  ' + (m.name || (i === 0 ? t('master') : t('insert', { n: i })));
    };
    label();
    b.addEventListener('click', e => Rack.mixMenu(c(), e.currentTarget));
    b.addEventListener('wheel', e => {
      e.preventDefault();
      history.edit(() => { c().mix = clamp(c().mix + (e.deltaY < 0 ? 1 : -1), 0, S.project.mixer.length - 1); });
    }, { passive: false });
    b.update = label;
    return b;
  }
  function sw(label, key) {
    const inp = h('input', { type: 'checkbox', class: 'switch' });
    inp.checked = !!ip()[key];
    inp.addEventListener('change', () => history.edit(() => { ip()[key] = inp.checked; }));
    return h('label', null, inp, h('span', null, label));
  }
  function waves(key) {
    const seg = h('div', { class: 'seg tiny' });
    for (const [w, lbl] of [['sine', 'sin'], ['tri', 'tri'], ['saw', 'saw'], ['square', 'sqr'], ['noise', 'nse']]) {
      const b = h('button', { class: ip()[key] === w ? 'on' : '' }, lbl);
      b.addEventListener('click', () => { history.edit(() => { ip()[key] = w; }); $$('button', seg).forEach(x => x.classList.toggle('on', x === b)); });
      seg.append(b);
    }
    return seg;
  }
  const sec = s => s.toFixed(s < 0.1 ? 3 : 2) + 's';
  const pct = v => Math.round(v * 100) + '%';

  function build() {
    form.innerHTML = '';
    knobs = []; wave = null;
    const ch = c();
    if (!ch) { form.append(h('div', { class: 'muted' }, t('c.none'))); return; }
    const name = h('input', { class: 'field', value: ch.name, style: 'flex:1' });
    name.addEventListener('change', () => history.edit(() => { c().name = name.value.trim() || c().name; }));
    name.addEventListener('keydown', e => e.stopPropagation());
    mixBtn = mixBox();
    form.append(h('div', { class: 'frow', style: 'align-items:center' },
      h('div', { class: 'fblock', style: 'flex:1;min-width:160px' }, h('span', { class: 'gl-section' }, t('c.name')), name),
      h('div', { class: 'fblock' }, h('span', { class: 'gl-section' }, t('mx.target')), mixBtn),
      chKn(t('vol'), 0, 1.25, 1, 'vol', pct), chKn(t('pan'), -1, 1, 0, 'pan', v => Math.abs(v) < 0.01 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100))));
    if (ch.inst.type === 'sampler') buildSampler();
    else if (ch.inst.type === 'plugin') buildPlugin();
    else if (ch.inst.type === 'audio') buildAudio();
    else buildSynth();
  }

  // an audio channel: the sound of its playlist clips
  function buildAudio() {
    const p = ip();
    const uses = S.project.clips.filter(c => c.ch === id).length;
    wave = h('canvas', { class: 'wave' });
    form.append(
      h('div', { class: 'fblock' }, h('span', { class: 'gl-section' }, t('c.audio')), wave,
        h('div', { class: 'file-line' },
          h('span', { class: 'fn' }, p.path ? p.sample : p.sample.replace(/^kit:/, '')),
          h('span', { class: 'fs' }, t('c.clips', { n: uses })),
          h('span', { style: 'flex:1' }),
          h('button', { class: 'gl-btn gl-btn-secondary gl-btn-sm', onclick: pickFile }, t('c.replace')))),
      // pitch (the length kept) and backwards, for every clip of this sound
      h('div', { class: 'knobs' },
        kn(t('c.pitch'), -24, 24, 0, 'pitch', v => (v > 0 ? '+' : '') + v.toFixed(2) + ' st'),
        h('div', { class: 'fline', style: 'align-self:center' }, sw(t('c.reverse'), 'reverse'))),
      // what the playlist's stretch tool does to this sound
      h('div', { class: 'fline', style: 'gap:18px' }, sw(t('c.stretchpitch'), 'stretch_pitch'),
        h('span', { class: 'muted' }, t(p.stretch_pitch ? 'c.stretchpitch.on' : 'c.stretchpitch.off'))),
      h('div', { class: 'muted' }, t('c.audiohint')));
    peaksKey = '';
    requestAnimationFrame(drawWave);
  }

  function buildPlugin() {
    const pid = ip().pid, d = Plugins.desc(pid) || {}, err = Plugins.errorOf(pid);
    form.append(
      h('div', { class: 'fblock' }, h('span', { class: 'gl-section' }, t('c.plugin')),
        h('div', { class: 'file-line' }, h('span', { class: 'fn' }, Plugins.nameOf(pid)), h('span', { class: 'fs' }, (d.vendor || '') + ' · ' + (d.format || '').toUpperCase()))),
      err ? h('div', { class: 'muted', style: 'color:var(--danger)' }, err) : null,
      h('div', { class: 'fline' }, h('button', { class: 'gl-btn gl-btn-primary gl-btn-sm', onclick: () => Plugins.openEditor(pid) }, t('fx.open'))),
      h('div', { class: 'muted' }, t('c.pluginhint')));
  }

  function buildSampler() {
    const p = ip();
    wave = h('canvas', { class: 'wave' });
    const file = h('div', { class: 'file-line' },
      h('span', { class: 'fn' }, p.path ? p.sample : (KIT_NAMES.find(k => 'kit:' + k[0] === p.sample) || [, p.sample])[1]),
      h('span', { class: 'fs' }, p.path ? '' : t('c.kit')),
      h('span', { style: 'flex:1' }),
      h('button', { class: 'gl-btn gl-btn-secondary gl-btn-sm', onclick: pickFile }, t('c.file')));
    const chips = h('div', { class: 'chips' });
    for (const [k, label] of KIT_NAMES) {
      const b = h('button', { class: 'chip' + (!p.path && p.sample === 'kit:' + k ? ' on' : '') }, label);
      b.addEventListener('click', () => {
        history.edit(() => { Object.assign(ip(), { sample: 'kit:' + k, path: null, root: k === 'sub' ? 36 : 60, oneshot: k !== 'sub', choke: k === 'hat' || k === 'openhat' }); });
        built = '';
        preview(id, ip().root, 0.8, 300);
      });
      chips.append(b);
    }
    form.append(
      h('div', { class: 'fblock' }, h('span', { class: 'gl-section' }, t('c.sample')), wave, file),
      h('div', { class: 'fblock' }, h('span', { class: 'gl-section' }, t('c.kit')), chips),
      h('div', { class: 'knobs' },
        kn(t('c.root'), 0, 127, 60, 'root', v => keyName(Math.round(v)), { int: true }),
        kn(t('c.tune'), -24, 24, 0, 'tune', v => (v > 0 ? '+' : '') + v.toFixed(2)),
        kn(t('c.attack'), 0, 1, 0, 'attack', sec),
        kn(t('c.release'), 0, 2, 0.05, 'release', sec),
        kn(t('c.gain'), 0, 2, 1, 'gain', pct)),
      h('div', { class: 'fline', style: 'gap:18px' }, sw(t('c.oneshot'), 'oneshot'), sw(t('c.reverse'), 'reverse'), sw(t('c.choke'), 'choke')));
    peaksKey = '';
    requestAnimationFrame(drawWave);
  }

  async function pickFile() {
    try {
      const s = await api.call('pick_sample');
      if (!s) return;
      history.edit(() => {
        Object.assign(ip(), { sample: s.name, path: s.path });
        if (ip().type === 'sampler') ip().root = 60;
      });
      built = '';
    } catch (e) { toast(t('toast.err', { e }), 'err'); }
  }

  async function drawWave() {
    if (!wave || !wave.isConnected || !c() || (ip().type !== 'sampler' && ip().type !== 'audio')) return;
    // measured from the box around it: the canvas's own size is what this sets, and reading it
    // back (inside its border) would shrink it on every redraw, down to nothing
    const w = Math.floor(wave.parentElement.clientWidth) - 2, hh = WAVE_H - 2;
    if (w <= 0) return;
    const p = ip();
    const key = p.sample + '|' + p.path + '|' + w;
    if (key !== peaksKey) {
      peaksKey = key;
      wave._peaks = await api.call('sample_peaks', { sample: p.sample, path: p.path, n: Math.floor(w / 2) }) || [];
    }
    const ctx = fitCanvas(wave, w, hh);
    // its box stays the stylesheet's; the pixels above fill the inside of its border
    wave.style.width = '100%'; wave.style.height = WAVE_H + 'px';
    ctx.clearRect(0, 0, w, hh);
    ctx.fillStyle = TOK.line; ctx.fillRect(0, hh / 2, w, 1);
    ctx.fillStyle = TOK['accent-ink'];
    const pk = wave._peaks, n = pk.length / 2;
    for (let i = 0; i < n; i++) {
      const lo = pk[i * 2], hi = pk[i * 2 + 1];
      const x = p.reverse ? w - 2 - i * 2 : i * 2;
      const y0 = hh / 2 - hi * (hh / 2 - 4), y1 = hh / 2 - lo * (hh / 2 - 4);
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }

  function buildSynth() {
    form.append(
      h('div', { class: 'frow' },
        h('div', { class: 'fblock' }, h('span', { class: 'gl-section' }, t('c.osc1')), waves('osc1')),
        h('div', { class: 'fblock' }, h('span', { class: 'gl-section' }, t('c.osc2')), waves('osc2'))),
      h('div', { class: 'knobs' },
        kn(t('c.semi'), -24, 24, 0, 'semi2', v => (v > 0 ? '+' : '') + Math.round(v), { int: true }),
        kn(t('c.fine'), -100, 100, 7, 'fine2', v => Math.round(v) + 'c'),
        kn(t('c.mix'), 0, 1, 0.4, 'mix', pct)),
      h('div', { class: 'fblock' }, h('span', { class: 'gl-section' }, t('c.filter')),
        h('div', { class: 'knobs' },
          kn(t('c.cutoff'), 0, 1, 0.62, 'cutoff', v => { const hz = 20 * Math.pow(2, 10 * v); return hz < 1000 ? Math.round(hz) + 'Hz' : (hz / 1000).toFixed(1) + 'k'; }),
          kn(t('c.res'), 0, 1, 0.2, 'res', pct),
          kn(t('c.fenv'), -1, 1, 0.3, 'fenv', v => Math.round(v * 100)),
          kn(t('c.fdecay'), 0, 3, 0.3, 'fdecay', sec))),
      h('div', { class: 'fblock' }, h('span', { class: 'gl-section' }, t('c.amp')),
        h('div', { class: 'knobs' },
          kn(t('c.a'), 0, 2, 0.003, 'a', sec), kn(t('c.d'), 0, 4, 0.3, 'd', sec), kn(t('c.s'), 0, 1, 0.7, 's', pct), kn(t('c.r'), 0, 4, 0.18, 'r', sec),
          kn(t('c.gain'), 0, 1, 0.5, 'gain', pct), kn(t('c.glide'), 0, 1, 0.06, 'glide', sec))),
      h('div', { class: 'fline' }, sw(t('c.mono'), 'mono')));
  }

  function render() {
    if (!win || !win.open) return;
    const ch = c();
    const sig = ch ? ch.id + ':' + ch.inst.type + ':' + (ch.inst.sample || '') + ':' + (ch.inst.path || '') + ':' + (ch.inst.pid || '') + ':' + !!ch.inst.stretch_pitch + ':' + !!ch.inst.reverse + ':' + LANG : '';
    win.sub.textContent = ch ? '— ' + ch.name : '';
    if (sig !== built) { built = sig; build(); requestAnimationFrame(() => win.fit()); return; }
    knobs.forEach(k => k.update());
    if (mixBtn && mixBtn.isConnected) mixBtn.update();
    drawWave();
  }
  // automated knobs move with the song
  function tick() {
    if (win && win.open && c() && S.mode === 'song' && (S.project.automation || []).length) knobs.forEach(k => k.update());
  }

  return { init, open, tick, get win() { return win; } };
})();

const ACCENTS = {
  clay: ['#bb7463', '#94503f'], pink: ['#c98fa8', '#8e4a66'], purple: ['#a79bc4', '#5e4f8a'], blue: ['#8fb3c9', '#2f5f7a'],
  cyan: ['#7fb5ad', '#2f6b63'], green: ['#9cb48a', '#4f6b3c'], orange: ['#d99a5f', '#8a5422'], red: ['#e8695e', '#a32d25'],
};

const Settings = (() => {
  let win, form;
  const prefs = { theme: 'dark', accent: 'clay', lang: 'ru' };
  function load() {
    try { Object.assign(prefs, JSON.parse(localStorage.getItem('loom.prefs') || '{}')); } catch (_) { }
    apply();
  }
  function save() { try { localStorage.setItem('loom.prefs', JSON.stringify(prefs)); } catch (_) { } }
  function apply() {
    document.documentElement.dataset.theme = prefs.theme;
    const a = ACCENTS[prefs.accent] || ACCENTS.clay;
    document.documentElement.style.setProperty('--accent', a[0]);
    document.documentElement.style.setProperty('--accent-ink', prefs.theme === 'light' ? a[1] : a[0]);
    LANG = prefs.lang;
    readTokens();
    applyI18n();
    if (window.FIELD) FIELD.recolor();
  }
  function place() { const D = $('#desk'); return { x: D.clientWidth - 452, y: 12, w: 440, h: 520 }; }
  function init() {
    win = WM.create('settings', { title: 'w.settings', glyph: '*', place, minW: 380, minH: 300, open: false, onShow: build });
    form = h('div', { class: 'form' });
    win.body.append(form);
  }
  function seg(opts, cur, fn) {
    const s = h('div', { class: 'seg compact' });
    for (const [v, label] of opts) s.append(h('button', { class: v === cur ? 'on' : '', onclick: () => fn(v) }, label));
    return s;
  }
  async function build() {
    form.innerHTML = '';
    const devs = await api.call('audio_devices') || { list: [], info: {} };
    const list = h('div', { class: 'dev-list' });
    const cur = devs.info.id || devs.info.device;
    for (const choice of devs.list) {
      const d = typeof choice === 'string' ? { id: choice, name: choice, driver: 'WASAPI' } : choice;
      list.append(h('button', {
        class: 'dev' + (d.id === cur ? ' on' : ''),
        onclick: async () => {
          try {
            await api.call('set_device', { device: d.id });
            localStorage.setItem('loom.audioDevice', d.id);
            await syncInput(true);
            build();
          }
          catch (e) { toast(t('toast.err', { e }), 'err'); }
        },
      }, h('span', { class: 'dg' }), h('span', null, d.driver + ' · ' + d.name)));
    }
    const info = devs.info.error ? h('div', { class: 'muted', style: 'color:var(--danger)' }, devs.info.error)
      : h('div', { class: 'muted' }, (devs.info.driver || 'WASAPI') + ' · ' + t('s.info', { sr: devs.info.sr, ch: devs.info.channels, fmt: devs.info.format }));
    const panel = devs.info.driver === 'ASIO' && h('button', { class: 'tool', onclick: async () => {
      try { await api.call('audio_panel'); } catch (e) { toast(t('toast.err', { e }), 'err'); }
    } }, t('s.asiopanel'));
    const look = h('div', { class: 'fblock' });
    const sws = h('div', { class: 'swatches' });
    for (const k in ACCENTS) sws.append(h('button', { class: 'swatch' + (k === prefs.accent ? ' on' : ''), style: '--c:' + ACCENTS[k][0], title: k, onclick: () => { prefs.accent = k; save(); apply(); build(); redraw(); } }));
    look.append(
      h('div', { class: 'set-row' }, h('span', { class: 'set-name' }, t('s.theme')), seg([['dark', t('s.night')], ['light', t('s.paper')]], prefs.theme, v => { prefs.theme = v; save(); apply(); build(); redraw(); })),
      h('div', { class: 'set-row' }, h('span', { class: 'set-name' }, t('s.accent')), sws),
      h('div', { class: 'set-row' }, h('span', { class: 'set-name' }, t('s.lang')), seg([['ru', 'русский'], ['en', 'english']], prefs.lang, v => { prefs.lang = v; save(); apply(); build(); redraw(); })));
    const keys = [
      ['Space', t('hint.play').replace(/<[^>]+>.*$/, '')], ['F5 · F6 · F7', t('w.playlist') + ' · ' + t('w.rack') + ' · ' + t('w.roll')],
      ['F8 · F9', t('w.browser') + ' · ' + t('w.mixer')],
      ['Z…/ Q…[ · − =', t('kb.keys')],
      ['Ctrl+Z · Ctrl+Y', 'undo · redo'], ['Ctrl+S · Ctrl+O', t('save') + ' · ' + t('open')],
      ['Ctrl+A · Ctrl+D', 'select all · duplicate'], ['Ctrl+C · Ctrl+V', 'copy · paste'], ['Del', t('ch.delete')], ['↑ ↓ (Shift)', '±1 (±12)'],
      ['Ctrl+wheel · Alt+wheel', 'zoom'],
    ];
    const kl = h('div', { class: 'fblock' }, ...keys.map(([k, v]) => h('div', { class: 'fline', style: 'justify-content:space-between' }, h('span', { style: 'color:var(--accent-ink)' }, k), h('span', null, v))));
    form.append(
      h('div', { class: 'fblock' }, h('span', { class: 'gl-section' }, t('s.audio') + ' · ' + t('s.device')), list, info, panel),
      h('div', { class: 'fblock' }, h('span', { class: 'gl-section' }, t('s.look')), look),
      h('div', { class: 'fblock' }, h('span', { class: 'gl-section' }, t('s.keys')), kl));
  }
  return { init, load, apply, prefs, get win() { return win; } };
})();
