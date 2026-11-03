// Shared state, the project model helpers, undo, and the bridge to the Rust side.
// The UI owns the project: every edit calls changed(), which redraws the views and sends
// the whole project to the engine once per frame.

// ?timer: a hidden preview pane never fires animation frames, so tick on a timer there
if (new URLSearchParams(location.search).has('timer')) window.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 16);

const PPQ = 96, STEP = PPQ / 4, BEAT = PPQ, BAR = PPQ * 4;
function inputRoute(code) {
  if (code === 1) return [0, 0];
  if (code === 2) return [1, 1];
  if (code === 3) return [0, 1];
  if (Number.isInteger(code) && code >= 16 && code <= 79) return [code - 16, code - 16];
  if (Number.isInteger(code) && code >= 1024 && code <= 1086) return [code - 1024, code - 1023];
  return null;
}
function inputNumber(code) {
  const route = inputRoute(code);
  return !route ? '—' : route[0] === route[1] ? String(route[0] + 1) : (route[0] + 1) + '+' + (route[1] + 1);
}
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// MIDI 60 is C5, as most beat makers know it
const keyName = k => NOTE_NAMES[k % 12] + (Math.floor(k / 12));
const isBlack = k => [1, 3, 6, 8, 10].includes(k % 12);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}
// theme tokens for canvas drawing, refreshed on theme/accent change
const TOK = {};
function readTokens() {
  const s = getComputedStyle(document.documentElement);
  for (const k of ['bg', 'surface', 'surface-2', 'line', 'line-strong', 'ink', 'ink-muted', 'ink-faint', 'accent', 'accent-ink', 'on-accent', 'grid-a', 'grid-b', 'danger', 'ok'])
    TOK[k] = s.getPropertyValue('--' + k).trim();
  TOK.font = s.getPropertyValue('--font-mono').trim();
}

// pattern colours: muted, so the accent stays the one loud colour
const PAT_COLORS = ['#bb7463', '#8fb3c9', '#a79bc4', '#9cb48a', '#d9b25f', '#c98fa8', '#7fb5ad', '#b9a58a'];

// small line icons for buttons (16×16, drawn in the text colour)
const ICONS = {
  power: '<path d="M8 2.5v5.5M4.9 4.9a5 5 0 1 0 6.2 0"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8"/><path d="M10.5 5.5v-3h-8v8h3"/>',
  paste: '<rect x="3" y="3.5" width="10" height="10"/><path d="M6 3.5v-1.5h4v1.5"/><path d="M5.5 8h5M5.5 10.5h3"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
};
function icon(name) {
  const s = h('span', { class: 'ic' });
  s.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  return s;
}

// `t` of colour a over colour b (#rrggbb); anything else comes back as a
function mixColor(a, b, t) {
  const rgb = s => /^#[0-9a-f]{6}$/i.test(s) ? [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16)) : null;
  const x = rgb(a), y = rgb(b);
  if (!x || !y) return a;
  return '#' + x.map((v, i) => Math.round(v * t + y[i] * (1 - t)).toString(16).padStart(2, '0')).join('');
}

// ---------- backend ----------
const TAURI = window.__TAURI__;
const api = {
  async call(cmd, args) {
    if (TAURI) return TAURI.core.invoke(cmd, args || {});
    return mock(cmd, args || {});
  },
};
// Browser preview without the Rust side: the transport runs on a clock, levels are made up.
const MOCK = { playing: false, t0: 0, from: 0 };
function mock(cmd, a) {
  const tpms = () => S.project.bpm * PPQ / 60000;
  switch (cmd) {
    case 'transport':
      if (a.action === 'play') { MOCK.playing = true; MOCK.t0 = performance.now(); }
      if (a.action === 'stop') { MOCK.playing = false; MOCK.from = S.mode === 'song' ? S.songStart : 0; }
      if (a.action === 'pos') { MOCK.from = a.value; MOCK.t0 = performance.now(); }
      return null;
    case 'status': {
      let pos = MOCK.from;
      if (MOCK.playing) {
        pos = MOCK.from + (performance.now() - MOCK.t0) * tpms();
        const r = S.mode === 'song' && S.project.loop_region;
        if (r && r.enabled) pos = r.start + ((Math.max(pos, r.start) - r.start) % (r.end - r.start));
        else if (S.mode !== 'song') pos %= patLen(curPat());
      }
      const lvl = () => MOCK.playing ? 0.3 + Math.random() * 0.4 : 0;
      return { pos, playing: MOCK.playing, master: [lvl(), lvl()], chans: S.project.channels.map(lvl), mix: S.project.mixer.flatMap(() => [lvl(), lvl()]), voices: 0, load: 0.04, sr: 48000, error: null };
    }
    case 'preview': return a.path || a.sample ? 2 : null;
    case 'sample_wave': {
      // a made-up drum loop so the preview can draw something
      const n = 1600, peaks = [];
      for (let i = 0; i < n; i++) { const ph = (i % 200) / 200; const e = Math.exp(-ph * 6) * (0.5 + 0.5 * Math.sin(i * 0.37) ** 2) + 0.05; peaks.push(-e * 0.9, e); }
      return { seconds: 4, peaks };
    }
    case 'plugin_default_folders': return ['C:\\Program Files\\Common Files\\VST3'];
    case 'plugin_scan': return {
      plugins: [
        { format: 'vst3', path: 'Serum2.vst3', cid: 'A', name: 'Serum 2', vendor: 'Xfer Records', instrument: true },
        { format: 'vst3', path: 'Petal Keys.vst3', cid: 'B', name: 'Petal Keys', vendor: 'b4demus', instrument: true },
        { format: 'vst2', path: 'OTT_x64.dll', cid: '1', name: 'OTT', vendor: 'Xfer Records', instrument: false },
        { format: 'vst2', path: 'ValhallaRoom_x64.dll', cid: '2', name: 'ValhallaRoom', vendor: 'Valhalla DSP', instrument: false },
        { format: 'vst3', path: 'Petal Verb.vst3', cid: 'C', name: 'Petal Verb', vendor: 'b4demus', instrument: false },
      ], failed: [],
    };
    case 'plugin_load': return { id: a.desc.id, name: a.desc.name, instrument: a.desc.instrument, editor: true };
    case 'plugin_states': return {};
    case 'list_dir': return [
      { name: 'drums', path: a.path + '\\drums', dir: true, kind: '' },
      { name: 'vox chop.wav', path: a.path + '\\vox chop.wav', dir: false, kind: 'audio' },
      { name: 'beat.loom', path: a.path + '\\beat.loom', dir: false, kind: 'project' },
    ];
    case 'audio_devices': return { list: ['Speakers (preview)'], info: { device: 'Speakers (preview)', sr: 48000, channels: 2, format: 'f32', error: null } };
    case 'mixer_inputs': return { device: 'ASIO4ALL v2', driver: 'ASIO', choices: [
      { code: 1, name: 'USB Audio Device · Input 1', stereo: false },
      { code: 2, name: 'Microphone · Left', stereo: false },
      { code: 18, name: 'Microphone · Right', stereo: false },
      { code: 1025, name: 'Microphone · Left + Right', stereo: true },
    ] };
    case 'sample_peaks': {
      const out = [];
      for (let i = 0; i < a.n; i++) { const e = Math.exp(-i / (a.n * 0.2)) * (0.4 + 0.6 * Math.abs(Math.sin(i * 0.9))); out.push(-e, e); }
      return out;
    }
    default: return null;
  }
}

// ---------- state ----------
const S = {
  project: null,
  path: null,          // where the project was saved
  dirty: false,
  curPat: 1,           // pattern shown in the rack and piano roll
  curCh: 1,            // channel the piano roll edits
  placeCh: 0,          // audio channel a click on the playlist places; 0: the current pattern
  mode: 'pat',        // 'pat' | 'song'
  playing: false,
  pos: 0,              // ticks, from the engine
  songStart: 0,        // ruler marker: next playback and stop return here
  peaks: [],
  sr: 48000,
};

const listeners = {};
const bus = {
  on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
  emit(ev, x) { (listeners[ev] || []).forEach(fn => fn(x)); },
};

const byId = (list, id) => list.find(x => x.id === id);
const chan = id => byId(S.project.channels, id);
const pat = id => byId(S.project.patterns, id);
const curPat = () => pat(S.curPat) || S.project.patterns[0];
const curChan = () => chan(S.curCh) || S.project.channels[0];
const nextId = list => list.reduce((m, x) => Math.max(m, x.id), 0) + 1;

// same rule as Pattern::len in engine/src/project.rs
function patLen(p) {
  if (!p) return BAR;
  let last = 0;
  for (const k in p.notes) for (const n of p.notes[k]) last = Math.max(last, n.t + 1);
  return Math.max(Math.ceil(last / BAR), p.bars || 1) * BAR;
}
function songLen() {
  const end = S.project.clips.reduce((m, c) => Math.max(m, c.t + c.l), 0);
  return Math.max(1, Math.ceil(end / BAR)) * BAR;
}
function notesOf(p, chId) {
  if (!p.notes[chId]) p.notes[chId] = [];
  return p.notes[chId];
}
// the key a step plays: samplers at their root, synths at C5
const stepKey = c => c && c.inst.type === 'sampler' ? c.inst.root : 60;

// ---------- undo ----------
const history = {
  undo: [], redo: [], pending: null, depth: 0, revision: 0, session: 0, mergeKey: null,
  // call before an edit that may span many events (a drag); end() records it once
  begin() { if (this.pending == null) this.pending = JSON.stringify(S.project); this.depth++; },
  end(mergeKey = null) {
    if (this.pending == null) return;
    if (--this.depth > 0) return;
    if (this.pending !== JSON.stringify(S.project)) {
      if (!mergeKey || this.mergeKey !== mergeKey) this.undo.push(this.pending);
      if (this.undo.length > 300) this.undo.shift();
      this.redo.length = 0;
      this.mergeKey = mergeKey;
    }
    this.pending = null;
    this.depth = 0;
  },
  // a one-shot edit
  edit(fn, mergeKey = null) {
    this.begin();
    try { fn(); } finally { this.end(mergeKey); changed(); }
  },
  step(from, to) {
    // Finish the current gesture before navigating. No later pointer event may edit
    // objects belonging to the snapshot we are about to replace.
    finishDrags();
    if (typeof closeMenu === 'function') closeMenu();
    if (this.pending != null) { this.depth = 1; this.end(); }
    if (!from.length) return;
    to.push(JSON.stringify(S.project));
    S.project = JSON.parse(from.pop());
    this.revision++;
    this.mergeKey = null;
    fixRefs();
    bus.emit('restore');
    changed();
  },
};
const historyStep = (from, to) => typeof Plugins !== 'undefined' && Plugins.navigate
  ? Plugins.navigate(() => history.step(from, to)) : history.step(from, to);
const undo = () => historyStep(history.undo, history.redo);
const redo = () => historyStep(history.redo, history.undo);

// ---------- sync ----------
let syncQueued = false, viewQueued = false;
// an edit of the project (redraw() alone only repaints); listeners of 'change' must not edit back
function changed(opts) {
  if (!opts || !opts.clean) S.dirty = true;
  bus.emit('change');
  if (!syncQueued) {
    syncQueued = true;
    requestAnimationFrame(() => {
      syncQueued = false;
      api.call('set_project', { json: JSON.stringify(S.project) }).catch(e => toast(t('toast.err', { e }), 'err'));
    });
  }
  redraw();
}
function redraw() {
  if (viewQueued) return;
  viewQueued = true;
  requestAnimationFrame(() => { viewQueued = false; bus.emit('render'); });
}
function fixRefs() {
  const p = S.project;
  if (!pat(S.curPat) && p.patterns[0]) S.curPat = p.patterns[0].id;
  if (!chan(S.curCh) && p.channels[0]) S.curCh = p.channels[0].id;
  if (S.placeCh && chan(S.placeCh)?.inst.type !== 'audio') S.placeCh = 0;
  while (p.tracks.length < 24) p.tracks.push({ name: '', mute: false });
}

// ---------- defaults ----------
function newSampler(id, kit, name) {
  return {
    id, name: name || kit, vol: 1, pan: 0, mute: false, solo: false, mix: 0,
    inst: { type: 'sampler', sample: 'kit:' + kit, path: null, root: kit === 'sub' ? 36 : 60, tune: 0, attack: 0, release: 0.05, oneshot: kit !== 'sub', reverse: false, choke: kit === 'hat' || kit === 'openhat', gain: 1 },
  };
}
function newSynth(id, name, over) {
  return {
    id, name: name || 'tone', vol: 1, pan: 0, mute: false, solo: false, mix: 0,
    inst: Object.assign({
      type: 'synth', osc1: 'saw', osc2: 'square', semi2: 0, fine2: 7, mix: 0.4, cutoff: 0.62, res: 0.2, fenv: 0.3, fdecay: 0.3,
      a: 0.003, d: 0.3, s: 0.7, r: 0.18, gain: 0.5, mono: false, glide: 0.06,
    }, over || {}),
  };
}
// an audio channel: the sound behind audio clips on the playlist
function newAudioChannel(id, name, sample, path) {
  return { id, name, vol: 1, pan: 0, mute: false, solo: false, mix: 0, inst: { type: 'audio', sample, path: path || null, stretch_pitch: false, pitch: 0, reverse: false } };
}

// Waveforms of sounds, shared by the playlist, the rack and the channel window.
// get() answers at once with what it has and repaints when a wave arrives.
const Waves = (() => {
  const cache = new Map(); // sample|path -> {seconds, peaks, gain} | 'loading' | 'error'
  const key = (sample, path) => sample + '|' + (path || '');
  function withGain(w) {
    // quiet files are drawn up to 4× taller, so every wave fills its box
    let m = 0;
    for (const v of w.peaks) m = Math.max(m, Math.abs(v));
    w.gain = m > 0 ? Math.min(4, 0.95 / m) : 1;
    return w;
  }
  function get(sample, path) {
    const k = key(sample, path);
    const w = cache.get(k);
    if (w) return w;
    cache.set(k, 'loading');
    api.call('sample_wave', { sample, path: path || null })
      .then(r => { cache.set(k, r ? withGain(r) : 'error'); redraw(); })
      .catch(() => { cache.set(k, 'error'); redraw(); });
    return 'loading';
  }
  async function load(sample, path) {
    const r = (await api.call('sample_wave', { sample, path: path || null })) || { seconds: 1, peaks: [] };
    cache.set(key(sample, path), withGain(r));
    return r;
  }
  // min/max of the peaks between two times (seconds), already scaled by the wave's gain
  function range(w, s0, s1) {
    const n = w.peaks.length / 2;
    let i0 = Math.floor(s0 / w.seconds * n), i1 = Math.max(i0 + 1, Math.ceil(s1 / w.seconds * n));
    i0 = clamp(i0, 0, n - 1); i1 = clamp(i1, 1, n);
    let lo = 0, hi = 0;
    for (let i = i0; i < i1; i++) { lo = Math.min(lo, w.peaks[i * 2]); hi = Math.max(hi, w.peaks[i * 2 + 1]); }
    return [clamp(lo * w.gain, -1, 0), clamp(hi * w.gain, 0, 1)];
  }
  // a mirrored waveform: filled body and crisp edges; `time(px)` maps a column to seconds
  // `solid`: a plain opaque body with no outline (the playlist); else a lighter body and edges
  function paint(ctx, w, x0, x1, mid, amp, col, time, solid) {
    const tops = [], bots = [];
    for (let px = x0; px < x1; px++) {
      const s0 = time(px), s1 = time(px + 1);
      if (s0 >= w.seconds) break;
      if (s1 <= 0) continue;
      const [lo, hi] = range(w, Math.max(0, s0), s1);
      tops.push([px + 0.5, mid - hi * amp]);
      bots.push([px + 0.5, mid - lo * amp]);
    }
    if (!tops.length) return;
    ctx.beginPath();
    ctx.moveTo(tops[0][0], mid);
    for (const [px, py] of tops) ctx.lineTo(px, py);
    for (let i = bots.length - 1; i >= 0; i--) ctx.lineTo(bots[i][0], bots[i][1]);
    ctx.closePath();
    const a = ctx.globalAlpha;
    ctx.fillStyle = col; ctx.globalAlpha = a * (solid ? 0.92 : 0.45); ctx.fill(); ctx.globalAlpha = a;
    if (solid) return;
    ctx.strokeStyle = col; ctx.lineWidth = 1;
    for (const line of [tops, bots]) {
      ctx.beginPath();
      line.forEach(([px, py], i) => i ? ctx.lineTo(px, py) : ctx.moveTo(px, py));
      ctx.stroke();
    }
  }
  return { get, load, paint };
})();
// an audio channel's colour (its clips, its row in the picker): its own pick, else the accent
const audioColor = ch => (ch && ch.color) || TOK.accent;

// ---------- automation: playlist lanes, Ableton style (mirrors engine/src/project.rs) ----------
// A lane: {id, track, target: {kind, track|ch|pid, param}, points: [{t, v, c}], on, name}.
// Values are normalized 0..1; toParam maps them like auto_value in the engine.
const Auto = (() => {
  let last = null;
  const bend = (x, c) => Math.abs(c || 0) < 1e-3 ? x : Math.pow(x, Math.pow(2, -clamp(c, -1, 1) * 3));
  function value(points, t) {
    if (!points || !points.length) return null;
    if (t < points[0].t) return points[0].v;
    let lo = 0, hi = points.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (points[m].t <= t) lo = m + 1; else hi = m; }
    const a = points[lo - 1], b = points[lo];
    if (!b) return a.v;
    return a.v + (b.v - a.v) * bend(clamp((t - a.t) / (b.t - a.t), 0, 1), a.c);
  }
  const faderVol = p => Math.pow(clamp(p, 0, 1), 2.2) * 1.25;
  const faderPos = v => Math.pow(clamp(v, 0, 1.25) / 1.25, 1 / 2.2);
  function toParam(tg, v) {
    v = clamp(v, 0, 1);
    switch (tg.kind) {
      case 'mix_vol': return faderVol(v);
      case 'chan_vol': return v * 1.25;
      case 'mix_pan': case 'chan_pan': return v * 2 - 1;
      default: return v;
    }
  }
  function fromParam(tg, x) {
    switch (tg.kind) {
      case 'mix_vol': return faderPos(x);
      case 'chan_vol': return clamp(x / 1.25, 0, 1);
      case 'mix_pan': case 'chan_pan': return clamp((x + 1) / 2, 0, 1);
      default: return clamp(x, 0, 1);
    }
  }
  const key = tg => tg.kind + ':' + (tg.track ?? tg.ch ?? tg.pid) + (tg.kind === 'param' ? ':' + tg.param : '');
  const lanes = () => S.project.automation || [];
  const laneOf = tg => lanes().find(l => key(l.target) === key(tg));
  // defaults of plugin parameters, filled when their list is read
  const paramDefaults = {};
  // the parameter's own value in the project, normalized: where a new lane starts
  function current(tg) {
    const p = S.project;
    switch (tg.kind) {
      case 'mix_vol': return fromParam(tg, p.mixer[tg.track]?.vol ?? 0.8);
      case 'mix_pan': return fromParam(tg, p.mixer[tg.track]?.pan ?? 0);
      case 'chan_vol': return fromParam(tg, chan(tg.ch)?.vol ?? 0.8);
      case 'chan_pan': return fromParam(tg, chan(tg.ch)?.pan ?? 0);
      case 'fx_mix': for (const m of p.mixer) { const f = m.fx.find(x => x.pid === tg.pid); if (f) return f.mix; } return 1;
      default: return p.plugins.find(d => d.id === tg.pid)?.params?.[tg.param] ?? paramDefaults[tg.pid + ':' + tg.param] ?? 0.5;
    }
  }
  // what the engine plays now (the parameter's own value), or null when no lane drives it
  function live(tg) {
    if (S.mode !== 'song') return null;
    const l = laneOf(tg);
    if (!l || !l.on || !l.points.length) return null;
    return toParam(tg, value(l.points, S.pos));
  }
  // A manual change of an automated parameter overrides its lane until automation is
  // re-enabled (Ableton). Call inside the edit that makes the change.
  function touch(tg) {
    last = tg;
    const l = laneOf(tg);
    if (l && l.on && l.points.length) l.on = false;
  }
  const anyOff = () => lanes().some(l => !l.on && l.points.length);
  function reEnable() { history.edit(() => lanes().forEach(l => { l.on = true; })); }
  function fmt(tg, v) {
    const x = toParam(tg, v);
    switch (tg.kind) {
      case 'mix_vol': return x <= 0.0001 ? '-inf dB' : (20 * Math.log10(x)).toFixed(1) + ' dB';
      case 'mix_pan': case 'chan_pan': return Math.abs(x) < 0.01 ? 'C' : (x < 0 ? 'L' : 'R') + Math.round(Math.abs(x) * 100);
      default: return Math.round(x * 100) + '%';
    }
  }
  return { value, bend, toParam, fromParam, key, laneOf, current, live, touch, anyOff, reEnable, fmt, faderVol, faderPos, paramDefaults, get last() { return last; } };
})();

// the master and 8 inserts; more can be added in the mixer
function defaultMixer(masterVol) {
  const m = [{ name: '', vol: masterVol == null ? 1 : masterVol, pan: 0, mute: false, solo: false, fx: [], input: 0, arm: false, out: [0] }];
  for (let i = 1; i <= 8; i++) m.push({ name: '', vol: 1, pan: 0, mute: false, solo: false, fx: [], input: 0, arm: false, out: [0] });
  return m;
}
// colour null: the theme's accent, whatever it is now
function newPattern(id) { return { id, name: t('pattern', { n: id }), bars: 1, notes: {}, color: null }; }

function emptyProject() {
  const p = { version: 1, bpm: 130, master: 1, swing: 0, channels: [], patterns: [], tracks: [], clips: [], mixer: defaultMixer(), plugins: [] };
  ['kick', 'clap', 'hat', 'snare'].forEach((k, i) => p.channels.push(newSampler(i + 1, k)));
  p.patterns.push(newPattern(1));
  for (let i = 0; i < 24; i++) p.tracks.push({ name: '', mute: false });
  return p;
}

// A short original groove in A minor so a fresh start makes sound right away.
function demoProject() {
  const p = { version: 1, bpm: 124, master: 0.8, swing: 0.18, channels: [], patterns: [], tracks: [], clips: [], mixer: defaultMixer(), plugins: [] };
  p.channels.push(newSampler(1, 'kick'), newSampler(2, 'clap'), newSampler(3, 'hat'), newSampler(4, 'openhat', 'open hat'), newSampler(5, 'sub', 'sub 808'));
  p.channels.push(newSynth(6, 'pluck', { osc1: 'saw', osc2: 'square', semi2: 12, fine2: 4, mix: 0.3, cutoff: 0.42, res: 0.35, fenv: 0.45, fdecay: 0.22, a: 0.002, d: 0.35, s: 0.0, r: 0.25, gain: 0.45 }));
  p.channels.push(newSynth(7, 'pad', { osc1: 'saw', osc2: 'saw', semi2: 0, fine2: 14, mix: 0.5, cutoff: 0.48, res: 0.1, fenv: 0.15, fdecay: 1.2, a: 0.35, d: 0.8, s: 0.75, r: 0.9, gain: 0.32 }));
  p.channels[2].vol = 0.55; p.channels[3].vol = 0.45; p.channels[4].vol = 0.85; p.channels[6].vol = 0.6;
  // each part on its own mixer track, hats share one
  [1, 2, 3, 3, 4, 5, 6].forEach((m, i) => { p.channels[i].mix = m; });
  ['', 'kick', 'clap', 'hats', 'sub', 'pluck', 'pad'].forEach((n, i) => { p.mixer[i].name = n; });
  const n = (t, k, l, v) => ({ t, l: l || STEP, k, v: v == null ? 0.78 : v });

  const drums = newPattern(1); drums.name = 'drums';
  drums.notes[1] = [0, 4, 8, 12].map(s => n(s * STEP, 60, STEP, 0.9));
  drums.notes[2] = [4, 12].map(s => n(s * STEP, 60));
  drums.notes[3] = [2, 6, 10, 13, 14].map(s => n(s * STEP, 60, STEP, s === 13 ? 0.45 : 0.7));
  drums.notes[4] = [n(15 * STEP, 60, STEP, 0.5)];

  const chords = [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]]; // Am F C G
  const roots = [33, 29, 36, 31];
  const bass = newPattern(2); bass.name = 'bass'; bass.bars = 4;
  bass.notes[5] = [];
  roots.forEach((r, b) => [[0, 3], [3, 3], [6, 2], [10, 4], [14, 2]].forEach(([s, l], i) => {
    if (b % 2 === 1 && i === 4) return;
    bass.notes[5].push(n(b * BAR + s * STEP, r + (i === 3 ? 12 : 0), l * STEP, 0.85));
  }));

  const pad = newPattern(3); pad.name = 'chords'; pad.bars = 4;
  pad.notes[7] = [];
  chords.forEach((c, b) => c.forEach(k => pad.notes[7].push(n(b * BAR, k, BAR - STEP, 0.7))));

  const lead = newPattern(4); lead.name = 'pluck'; lead.bars = 4;
  lead.notes[6] = [];
  const arp = [0, 1, 2, 1, 2, 0, 1, 2];
  chords.forEach((c, b) => arp.forEach((a, i) => lead.notes[6].push(n(b * BAR + i * 2 * STEP, c[a] + 12, STEP + 6, i % 4 === 0 ? 0.85 : 0.62))));

  p.patterns.push(drums, bass, pad, lead);
  ['drums', 'bass', 'chords', 'pluck'].forEach(name => p.tracks.push({ name, mute: false }));
  for (let i = p.tracks.length; i < 24; i++) p.tracks.push({ name: '', mute: false });
  p.clips.push(
    { p: 3, track: 2, t: 0, l: 16 * BAR, off: 0 },
    { p: 1, track: 0, t: 4 * BAR, l: 12 * BAR, off: 0 },
    { p: 2, track: 1, t: 4 * BAR, l: 8 * BAR, off: 0 },
    { p: 2, track: 1, t: 12 * BAR, l: 4 * BAR, off: 0 },
    { p: 4, track: 3, t: 8 * BAR, l: 8 * BAR, off: 0 },
  );
  return p;
}

// ---------- small UI services ----------
let toastTimer = 0;
function toast(msg, kind) {
  const el = $('#toast');
  el.className = 'toast show ' + (kind || 'info');
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

// hint line in the top bar: whatever is under the pointer, or the value being dragged
let hintLock = false;
function hint(html) { if (!hintLock) $('#hint').innerHTML = html || ''; }
function hintValue(label, value) { $('#hint').innerHTML = '<b>' + label + '</b> ' + value; }

function fmtPos(ticks) {
  const bar = Math.floor(ticks / BAR) + 1;
  const beat = Math.floor((ticks % BAR) / BEAT) + 1;
  const step = Math.floor((ticks % BEAT) / STEP) + 1;
  return bar + ':' + beat + ':' + step;
}
function fmtTime(ticks) {
  const sec = ticks / PPQ * 60 / S.project.bpm;
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}

// pointer drags with capture; fn(move, up) get the event
const activeDrags = new Set();
function finishDrags() { for (const done of [...activeDrags]) done(); }
function drag(e, move, up) {
  const el = e.currentTarget || e.target;
  try { el.setPointerCapture(e.pointerId); } catch (_) { }
  let last = e;
  const mv = ev => { last = ev; move && move(ev); };
  const done = ev => {
    if (!activeDrags.delete(done)) return;
    el.removeEventListener('pointermove', mv);
    el.removeEventListener('pointerup', done);
    el.removeEventListener('pointercancel', done);
    up && up(ev || last);
  };
  activeDrags.add(done);
  el.addEventListener('pointermove', mv);
  el.addEventListener('pointerup', done);
  el.addEventListener('pointercancel', done);
}

// a canvas that fills its wrapper at the device pixel ratio
function fitCanvas(c, w, h) {
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    c.style.width = w + 'px'; c.style.height = h + 'px';
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

// preview a note on a channel for `ms`, or until the returned function is called
function preview(chId, key, vel, ms) {
  api.call('note', { ch: chId, key, vel: vel == null ? 0.8 : vel, on: true });
  let off = false;
  const stop = () => { if (!off) { off = true; api.call('note', { ch: chId, key, vel: 0, on: false }); } };
  if (ms) setTimeout(stop, ms);
  return stop;
}
