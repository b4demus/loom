// Start-up, the top bar, transport, keys, files, drag & drop and the status loop.

const Transport = {
  starting: false,
  pending: null,
  ending: null,
  serial: 0,
  heardPlay: false,
  sendMode() { api.call('set_mode', { song: S.mode === 'song', pattern: S.curPat }); },
  setMode(m) {
    if (S.mode === m) return;
    S.mode = m;
    this.sendMode();
    $$('#mode button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    redraw();
  },
  play() {
    if (this.starting || Rec.stopping) return this.pending;
    this.starting = true;
    const serial = ++this.serial;
    this.heardPlay = false;
    this.pending = (async () => {
      try {
        let bars = 0;
        if (S.mode === 'song') {
          const r = S.project.loop_region;
          const start = r && r.enabled && (S.songStart < r.start || S.songStart >= r.end) ? r.start : S.songStart;
          this.seekSong(start || 0);
        }
        if (Rec.armed && !Rec.live) {
          if (!await Rec.begin()) return;
          bars = Rec.countIn;
        }
        if (serial !== this.serial) { if (Rec.live) await Rec.end(); return; }
        api.call('transport', { action: 'play', value: bars || null });
        S.playing = !bars; S.posAt = performance.now();
        syncPlay();
      } finally { this.starting = false; syncInput(); }
    })();
    return this.pending;
  },
  async stop() {
    this.serial++;
    this.heardPlay = false;
    const ending = Rec.live ? (this.ending = Rec.end()) : this.ending;
    api.call('transport', { action: 'stop' }); S.playing = false; S.pos = S.mode === 'song' ? S.songStart : 0; syncPlay(); redraw();
    await ending;
    if (this.starting) await this.pending;
  },
  // during a count-in nothing plays yet, but a second press still stops the take
  toggle() { if (S.playing || Rec.live || this.starting) this.stop(); else this.play(); },
  updateStatus(s, serial) {
    // Ignore a status requested before play/stop or while a take is still opening.
    if (serial !== this.serial || this.starting) return;
    // The play command reaches the audio thread on its next block. A stopped snapshot
    // before that acknowledgement is not the end of a recording over the loop.
    if (!this.heardPlay && S.playing && !s.playing) return;
    const wasPlaying = this.heardPlay;
    this.heardPlay = this.heardPlay || s.playing;
    const changed = S.playing !== s.playing;
    S.pos = s.pos; S.posAt = performance.now(); S.playing = s.playing;
    if (changed) syncPlay();
    if (wasPlaying && !s.playing && Rec.live && !Rec.stopping && Rec.loopEnd != null) this.stop();
  },
  seek(tk) { api.call('transport', { action: 'pos', value: tk }); S.pos = tk; redraw(); },
  seekSong(tk) { this.setMode('song'); S.songStart = Math.max(0, Math.round(tk)); this.seek(S.songStart); },
};
function syncPlay() {
  const b = $('#t-play');
  b.classList.toggle('on', S.playing);
  b.firstChild.textContent = S.playing ? '‖' : '>';
}

// ---------- project files ----------
function normalize(p) {
  const d = emptyProject();
  p = Object.assign({ version: 1, bpm: 130, master: 0.8, swing: 0, channels: [], patterns: [], tracks: [], clips: [], mixer: [], plugins: [] }, p);
  if (!p.patterns.length) p.patterns = d.patterns;
  if (!p.mixer.length) p.mixer = defaultMixer(p.master);
  // an armed track records its own sound, so it needs no input; it plays into the master unless routed
  p.mixer.forEach((m, i) => {
    m.fx = m.fx || []; m.input = inputRoute(m.input) ? m.input : 0; m.input_name = m.input ? (m.input_name || '') : ''; m.arm = !!m.arm; m.rec_dry = !!m.rec_dry; m.fx_off = !!m.fx_off;
    m.out = i === 0 ? [] : Array.isArray(m.out) ? [...new Set(m.out.filter(d => Number.isInteger(d) && d >= 0 && d < p.mixer.length && d !== i))] : [0];
  });
  p.channels.forEach(c => { c.mix = Math.min(c.mix || 0, p.mixer.length - 1); });
  p.patterns.forEach(x => { x.notes = x.notes || {}; x.bars = x.bars || 1; x.color = x.color || null; });
  p.fx_off = !!p.fx_off;
  p.clips.forEach(c => { c.off = c.off || 0; c.ch = c.ch || 0; c.mute = !!c.mute; c.rate = c.rate > 0 && Number.isFinite(c.rate) ? clamp(c.rate, 0.05, 20) : 1;
    c.gain = Number.isFinite(c.gain) ? clamp(c.gain, 0, 4) : 1; c.fade_in = Math.max(0, +c.fade_in || 0); c.fade_out = Math.max(0, +c.fade_out || 0); });
  p.channels.forEach(c => { if (c.inst.type === 'audio') Object.assign(c.inst, { stretch_pitch: !!c.inst.stretch_pitch, pitch: clamp(+c.inst.pitch || 0, -24, 24), reverse: !!c.inst.reverse }); });
  const r = p.loop_region;
  p.loop_region = r && Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start
    ? { start: Math.max(0, Math.round(r.start)), end: Math.round(r.end), enabled: !!r.enabled } : null;
  // audio clips of the first version carried their sound themselves: give each sound a channel
  for (const c of p.clips) {
    if (!c.audio) continue;
    const a = c.audio;
    let ch = p.channels.find(x => x.inst.type === 'audio' && x.inst.sample === a.sample && (x.inst.path || null) === (a.path || null));
    if (!ch) {
      const name = (a.path ? a.path.split(/[\\/]/).pop() : a.sample.replace(/^kit:/, '')).replace(/\.[^.]+$/, '');
      ch = newAudioChannel(p.channels.reduce((m, x) => Math.max(m, x.id), 0) + 1, name, a.sample, a.path);
      ch.mix = a.mix || 0;
      p.channels.push(ch);
    }
    c.ch = ch.id;
    delete c.audio;
  }
  // a clip whose audio channel is gone has nothing to play
  p.clips = p.clips.filter(c => !c.ch || p.channels.some(x => x.id === c.ch));
  while (p.tracks.length < 24) p.tracks.push({ name: '', mute: false });
  // automation lanes: points in time order, lanes of plugins that are gone dropped
  const KINDS = ['mix_vol', 'mix_pan', 'chan_vol', 'chan_pan', 'fx_mix', 'param'];
  p.automation = (p.automation || []).filter(a => a && a.target && KINDS.includes(a.target.kind)).map(a => ({
    id: a.id, track: clamp(a.track | 0, 0, p.tracks.length - 1), target: a.target, name: a.name || '', on: a.on !== false,
    points: (a.points || []).filter(x => Number.isFinite(x.t) && Number.isFinite(x.v)).map(x => ({ t: Math.max(0, x.t), v: clamp(x.v, 0, 1), c: clamp(x.c || 0, -1, 1) })).sort((x, y) => x.t - y.t),
  }));
  p.automation.forEach((a, i) => { if (!a.id) a.id = i + 1; });
  // the piano roll: its scale highlighting and its loop
  const sc = p.scale || {};
  p.scale = { mode: ['none', 'minor', 'major'].includes(sc.mode) ? sc.mode : 'none', root: clamp(sc.root | 0, 0, 11) };
  const pl = p.pat_loop;
  p.pat_loop = pl && Number.isFinite(pl.start) && Number.isFinite(pl.end) && pl.end > pl.start
    ? { start: Math.max(0, Math.round(pl.start)), end: Math.round(pl.end), enabled: !!pl.enabled } : null;
  return p;
}
async function setProject(p, path) {
  await Transport.stop();
  finishDrags();
  S.project = normalize(p);
  S.path = path || null;
  S.dirty = false;
  history.undo = []; history.redo = []; history.pending = null; history.depth = 0; history.mergeKey = null;
  history.revision++;
  history.session++;
  bus.emit('restore');
  S.curPat = S.project.patterns[0].id;
  S.curCh = S.project.channels[0] ? S.project.channels[0].id : 0;
  S.songStart = 0; S.pos = 0;
  api.call('transport', { action: 'pos', value: 0 });
  Transport.sendMode();
  // the old project's plugins go; the new one's load from their saved state
  Plugins.reset();
  changed({ clean: true });
  updateTitle();
}
function projName() { return S.path ? S.path.split(/[\\/]/).pop().replace(/\.loom$/i, '') : t('untitled'); }
function updateTitle() {
  $('#proj').textContent = projName() + (S.dirty ? ' *' : '');
  document.title = 'loom — ' + projName();
}
let newArmed = 0;
function fileNew() {
  if (S.dirty && Date.now() - newArmed > 2500) { newArmed = Date.now(); toast(t('toast.unsaved'), 'info'); return; }
  newArmed = 0;
  setProject(emptyProject(), null);
}
async function fileOpen(path) {
  try {
    const r = await api.call('open_project', { path: path || null });
    if (r) await setProject(JSON.parse(r.json), r.path);
  } catch (e) { toast(t('toast.err', { e }), 'err'); }
}
async function fileSave(as) {
  try {
    await Plugins.captureStates();
    const path = await api.call('save_project', { json: JSON.stringify(S.project, null, 1), path: as ? null : S.path });
    if (path) { S.path = path; S.dirty = false; updateTitle(); toast(t('toast.saved', { name: projName() })); }
  } catch (e) { toast(t('toast.err', { e }), 'err'); }
}
async function fileExport(what) {
  try {
    const song = what === 'song';
    const name = projName() + (song ? '' : ' - ' + curPat().name);
    const path = await api.call('export_wav', { json: JSON.stringify(S.project), song, pattern: S.curPat, name });
    if (path) toast(t('toast.exported', { name: path.split(/[\\/]/).pop() }));
  } catch (e) { toast(t('toast.err', { e }), 'err'); }
}

// ---------- top bar ----------
function initTop() {
  $('.logo').append(h('span', { class: 'proj', id: 'proj', 'data-tauri-drag-region': '' }));
  $('#f-menu').onclick = e => {
    const r = e.currentTarget.getBoundingClientRect();
    menu(r.left, r.bottom + 4, [
      { label: t('new'), key: 'Ctrl+N', fn: fileNew },
      { label: t('open'), key: 'Ctrl+O', fn: () => fileOpen() },
      '-',
      { label: t('save'), key: 'Ctrl+S', fn: () => fileSave(false) },
      { label: t('saveas'), key: 'Ctrl+Shift+S', fn: () => fileSave(true) },
      '-',
      { label: t('export.song'), fn: () => fileExport('song') },
      { label: t('export.pat', { name: curPat().name }), fn: () => fileExport('pat') },
      '-',
      { label: t('midi.import'), fn: () => Midi.import(null, 'new') },
      { label: t('midi.export', { name: curPat().name }), fn: () => Midi.exportPattern() },
    ]);
  };
  $$('#mode button').forEach(b => { b.onclick = () => Transport.setMode(b.dataset.mode); b.classList.toggle('on', b.dataset.mode === S.mode); });
  $('#t-play').onclick = () => Transport.toggle();
  $('#t-stop').onclick = () => Transport.stop();
  $('#t-rec').onclick = () => recordKey();
  $('#t-rec').oncontextmenu = e => { e.preventDefault(); Rec.menu(e.clientX, e.clientY); };
  $('#t-met').onclick = () => Rec.setMetronome(!Rec.metronome);
  $('#t-scale').onclick = e => kbScaleMenu(e.currentTarget);
  bus.on('render', kbScaleSync);
  kbScaleSync();

  const bpm = $('#bpm'), val = $('#bpm-val');
  const setBpm = v => { S.project.bpm = Math.round(clamp(v, 20, 400) * 10) / 10; val.textContent = S.project.bpm.toFixed(1); changed(); };
  bpm.addEventListener('pointerdown', e => {
    if (e.button !== 0 || bpm.querySelector('input')) return;
    history.begin();
    let sy = e.clientY, v = S.project.bpm;
    drag(e, ev => { v += (sy - ev.clientY) * (ev.shiftKey ? 0.1 : 0.5); sy = ev.clientY; setBpm(v); hintValue('bpm', S.project.bpm.toFixed(1)); }, () => history.end());
  });
  bpm.addEventListener('wheel', e => { e.preventDefault(); history.edit(() => setBpm(S.project.bpm + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.1 : 1))); }, { passive: false });
  bpm.addEventListener('dblclick', () => {
    const inp = h('input', { value: S.project.bpm });
    val.replaceWith(inp); inp.focus(); inp.select();
    const done = ok => { if (!inp.isConnected) return; if (ok && +inp.value > 0) history.edit(() => setBpm(+inp.value)); inp.replaceWith(val); val.textContent = S.project.bpm.toFixed(1); };
    inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    inp.addEventListener('blur', () => done(true));
  });
  // the app's own volume: what reaches the speakers, not the song (the master track is in the
  // mixer); kept per computer, never in the project or the export
  let outVol = 1;
  try { const v = parseFloat(localStorage.getItem('loom.outVol')); if (Number.isFinite(v)) outVol = clamp(v, 0, 1); } catch (_) { }
  const setOut = v => { outVol = v; try { localStorage.setItem('loom.outVol', String(v)); } catch (_) { } api.call('set_output_gain', { gain: v }); };
  const mk = knob({ name: t('outvol'), min: 0, max: 1, def: 1, size: 26, free: true, get: () => outVol, set: setOut, fmt: v => Math.round(v * 100) + '%' });
  $('#master').append(mk);
  setOut(outVol);
  bus.on('render', () => { mk.update(); if (!bpm.querySelector('input')) val.textContent = S.project.bpm.toFixed(1); updateTitle(); });

  $$('[data-view]').forEach(b => { b.onclick = () => WM.wins[b.dataset.view].toggle(); });
  const win = TAURI && TAURI.window.getCurrentWindow();
  $('#w-min').onclick = () => win && win.minimize();
  $('#w-max').onclick = () => win && win.toggleMaximize();
  $('#w-close').onclick = () => win && win.close();

  // hints for plain elements; canvases write their own
  document.addEventListener('pointerover', e => {
    const el = e.target.closest && e.target.closest('[data-hint]');
    if (el && !el.classList.contains('knob')) hint(t(el.dataset.hint));
  });
}

// ---------- metronome and recording ----------
const Rec = {
  armed: false,
  live: false,
  stopping: false,
  what: 'notes',      // 'notes' | 'audio' | 'both'
  input: null,        // input device name, null = the system default
  metronome: false,
  countIn: 1,         // bars of clicks before a take starts
  monitor: false,     // hear the input while recording
  start: 0,           // ticks: where the take starts on the timeline
  t0: 0,
  file: null,         // the WAV being written
  load() {
    try { Object.assign(this, JSON.parse(localStorage.getItem('loom.rec') || '{}')); } catch (_) { }
    this.armed = false; this.live = false; this.stopping = false;
  },
  save() { try { localStorage.setItem('loom.rec', JSON.stringify({ what: this.what, input: this.input, metronome: this.metronome, countIn: this.countIn, monitor: this.monitor })); } catch (_) { } },
  // the count-in, in ms at the current tempo
  countMs() { return this.countIn * 4 * 60000 / S.project.bpm; },
  notes() { return this.live && this.what !== 'audio'; },
  sync() {
    $('#t-rec').classList.toggle('armed', this.armed && !this.live);
    $('#t-rec').classList.toggle('live', this.live);
    $('#t-met').classList.toggle('on', this.metronome);
  },
  setMetronome(on) { this.metronome = on; api.call('set_metronome', { on }); this.save(); this.sync(); },
  arm() {
    if (Transport.starting || this.stopping) return;
    if (this.live) { Transport.stop(); return; }
    this.armed = !this.armed;
    this.sync();
    hint(this.armed ? t('rec.armed', { what: t('rec.' + this.what) }) : '');
  },
  // play pressed while armed: open the input first, so the take starts with the music
  async begin() {
    // Let an in-flight monitoring change finish before rec_start touches the same stream.
    await inputQueue;
    this.start = S.mode === 'song' ? Math.round(S.pos) : 0;
    this.inSong = S.mode === 'song';
    this.from = S.pos;
    this.file = null;
    this.taps = null;
    // takes as they grow, drawn on the playlist behind the playhead: key → {track, t0, row, peaks}
    this.takes = new Map();
    // Armed mixer tracks record their own sound, effects and fader included, input or not; set
    // to "dry input", one with an input records just that. With nothing armed, the whole input,
    // if audio is what the record button is set to.
    const mx = S.project.mixer;
    const dry = mx.map((m, i) => ({ track: i, mode: m.input || 0 })).filter((x, i) => mx[i].arm && mx[i].rec_dry && x.mode);
    const own = mx.map((m, i) => i).filter(i => mx[i].arm && !(mx[i].rec_dry && mx[i].input));
    const d = new Date(), p2 = n => String(n).padStart(2, '0');
    const name = `rec_${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}_${String(d.getMilliseconds()).padStart(3, '0')}.wav`;
    if (dry.length || (!own.length && this.what !== 'notes')) {
      try { this.file = await api.call('rec_start', { device: this.input, project: S.path, name, tracks: dry, monitor: this.monitor }); }
      catch (e) { inputKey = null; toast(t('rec.noinput', { e }), 'err'); return false; }
      inputKey = null; // rec_start can open an input even when monitoring was closed
    }
    if (own.length) {
      try { this.taps = await api.call('tap_start', { project: S.path, name, tracks: own }); }
      catch (e) {
        toast(t('toast.err', { e }), 'err');
        if (this.file) { this.file = null; await api.call('rec_stop').catch(() => { }); }
        return false;
      }
    }
    this.live = true;
    // over an enabled playlist loop the take ends with the loop: the transport stops at its end
    const r = S.project.loop_region;
    this.loopEnd = S.mode === 'song' && r && r.enabled && this.start < r.end ? r.end : null;
    api.call('transport', { action: 'stop_at_end', value: this.loopEnd != null ? 1 : 0 });
    // the music starts after the count-in
    this.t0 = performance.now() + this.countMs();
    this.sync();
    return true;
  },
  // stop: the notes held now are written, the audio take becomes a clip
  async end() {
    if (this.stopping) return;
    this.stopping = true;
    // notes still held end here, timed while the take is still live
    kbReleaseAll();
    this.live = false;
    this.armed = false;
    this.sync();
    const project = S.project, start = this.start, countMs = this.countMs();
    const files = this.file, taps = this.taps, inSong = this.inSong, loopEnd = this.loopEnd;
    this.loopEnd = null;
    api.call('transport', { action: 'stop_at_end', value: 0 });
    this.file = null;
    this.taps = null;
    let takes = [];
    try {
      if (files) {
        try { takes = (await api.call('rec_stop')) || []; } catch (e) { toast(t('toast.err', { e }), 'err'); }
      }
      // mixer tracks that recorded their own sound: each lands where the transport was when its
      // first block played, and plays into where the track played into (its effects are in it)
      let own = [];
      const ownDone = [];
      if (taps) {
        try { own = (await api.call('tap_stop')) || []; } catch (e) { toast(t('toast.err', { e }), 'err'); }
      }
      for (const take of own) {
        if (take.seconds < 0.05) continue;
        const name = take.path.split(/[\\/]/).pop();
        try { await Waves.load(name, take.path); }
        catch (e) { toast(t('toast.err', { e }), 'err'); continue; }
        if (S.project !== project) break;
        const tpms = S.project.bpm * PPQ / 60000;
        const t0 = inSong ? Math.max(0, Math.round(take.tick)) : start;
        // a take over the loop ends with it
        const l = Math.max(1, Math.min(Math.ceil(take.seconds * 1000 * tpms), loopEnd != null ? loopEnd - t0 : Infinity));
        history.edit(() => {
          const free = this.rowFor('mix:' + take.track, t0, l);
          const ch = newAudioChannel(nextId(S.project.channels), name.replace(/\.wav$/i, ''), name, take.path);
          const m = S.project.mixer[take.track];
          ch.mix = take.track === 0 ? 0 : Math.min(m?.out?.[0] ?? 0, S.project.mixer.length - 1);
          S.project.channels.push(ch);
          S.project.clips.push({ p: 0, ch: ch.id, track: free, t: t0, l, off: 0, mute: false, rate: 1, gain: 1, fade_in: 0, fade_out: 0 });
          S.curCh = ch.id;
        });
        ownDone.push(take);
      }
      const done = ownDone;
      for (const take of takes) {
        if (take.seconds < 0.05) continue;
        const name = take.path.split(/[\\/]/).pop();
        try { await Waves.load(name, take.path); }
        catch (e) { toast(t('toast.err', { e }), 'err'); continue; }
        if (S.project !== project) break;
        // Line the take up with the music: its first sample sits offset_ms from where the music
        // started sounding (both measured at the sound card, so its latencies are taken out).
        // A take that began earlier (count-in) starts trimmed; one that began later starts later.
        const tpms = S.project.bpm * PPQ / 60000;
        const total = Math.ceil(take.seconds * 1000 * tpms);
        const shift = Math.round((take.offset_ms != null ? take.offset_ms : -countMs) * tpms);
        const t0 = start + Math.max(0, shift), off = Math.max(0, -shift);
        // the input runs on a little after the transport stopped at the loop's end: cut there
        const l = Math.min(total - off, loopEnd != null ? loopEnd - t0 : Infinity);
        if (l < STEP / 2) continue;
        history.edit(() => {
          // the track it was drawn on while recording (or the first with room); it plays into the
          // mixer track it came from
          const free = this.rowFor('in:' + (take.track || 0), t0, l);
          const ch = newAudioChannel(nextId(S.project.channels), name.replace(/\.wav$/i, ''), name, take.path);
          ch.mix = Math.min(take.track || 0, S.project.mixer.length - 1);
          S.project.channels.push(ch);
          S.project.clips.push({ p: 0, ch: ch.id, track: free, t: t0, l, off, mute: false, rate: 1, gain: 1, fade_in: 0, fade_out: 0 });
          S.curCh = ch.id;
        });
        done.push(take);
      }
      if (done.length === 1) {
        const tk = done[0];
        toast(t('rec.done', { name: tk.path.split(/[\\/]/).pop(), s: tk.seconds.toFixed(1) }) + (tk.offset_ms != null ? ' · ' + t('rec.aligned', { ms: Math.round(tk.offset_ms) }) : ''));
      } else if (done.length) toast(t('rec.donen', { n: done.length, s: done[0].seconds.toFixed(1) }));
    } finally { this.stopping = false; this.takes = null; syncInput(); }
  },
  // the new peaks of the takes being written, every ~80 ms while recording
  async poll() {
    if (!this.live || (!this.file && !this.taps) || this.polling) return;
    this.polling = true;
    try {
      const got = (await api.call('rec_live')) || [];
      const tpms = S.project.bpm * PPQ / 60000;
      for (const t of got) {
        let e = this.takes.get(t.key);
        if (!e) {
          e = { key: t.key, track: t.track, t0: null, row: null, peaks: [] };
          this.takes.set(t.key, e);
        }
        // a mixer track's take knows where it starts; an input's began at the count-in
        if (e.t0 == null) e.t0 = t.key.startsWith('mix:') ? (t.tick ?? null) : this.start - this.countMs() * tpms;
        if (e.t0 != null && e.row == null) e.row = this.freeRow(e.t0);
        for (const v of t.peaks) e.peaks.push(v);
      }
    } catch (_) { } finally { this.polling = false; }
  },
  // the playlist track a growing take is drawn on (and lands on): the first with nothing from
  // its start on, not taken by another take
  freeRow(t0) {
    const used = new Set([...this.takes.values()].map(e => e.row).filter(r => r != null));
    const P = S.project;
    const free = P.tracks.findIndex((_, i) => !used.has(i) && !P.clips.some(c => c.track === i && c.t + c.l > t0));
    return free < 0 ? P.tracks.length - 1 : free;
  },
  // where a finished take goes: the track it was drawn on if it is still free, else the first free
  rowFor(key, t0, l) {
    const P = S.project, fits = i => i >= 0 && i < P.tracks.length && !P.clips.some(c => c.track === i && c.t < t0 + l && c.t + c.l > t0);
    const drawn = this.takes && this.takes.get(key);
    if (drawn && fits(drawn.row)) return drawn.row;
    let free = P.tracks.findIndex((_, i) => fits(i));
    if (free < 0) { free = P.tracks.length; P.tracks.push({ name: '', mute: false }); }
    return free;
  },
  async menu(x, y) {    const inputs = (await api.call('rec_inputs')) || [];
    const busy = Transport.starting || this.live || this.stopping;
    menu(x, y, [
      { head: t('rec.what') },
      ...['notes', 'audio', 'both'].map(w => ({ label: t('rec.' + w), on: this.what === w, disabled: busy, fn: () => { this.what = w; this.save(); } })),
      { head: t('rec.countin') },
      ...[0, 1, 2].map(b => ({ label: b ? t('rec.bars', { n: b }) : t('rec.nocount'), on: this.countIn === b, disabled: busy, fn: () => { this.countIn = b; this.save(); } })),
      { head: t('rec.input') },
      { label: t('rec.monitor'), on: this.monitor, disabled: busy, fn: () => { this.monitor = !this.monitor; this.save(); } },
      '-',
      { label: t('s.default'), on: !this.input, disabled: busy, fn: () => { this.input = null; this.save(); syncInput(true); } },
      ...inputs.map(d => ({ label: d, on: this.input === d, disabled: busy, fn: () => { this.input = d; this.save(); syncInput(true); } })),
    ]);
  },
};

// Serialize input changes: rapid edits/undo must leave the stream matching the latest project.
// A running take owns the stream until rec_stop has finalized all its files.
let inputKey = null, inputQueue = Promise.resolve();
function syncInput(force = false) {
  inputQueue = inputQueue.then(async () => {
    if (Transport.starting || Rec.live || Rec.stopping) return;
    const open = S.project.mixer.some(m => m.input);
    const key = open ? JSON.stringify([Rec.input]) : 'closed';
    if (!force && inputKey === key) return;
    try {
      await api.call(open ? 'input_open' : 'input_close', open ? { device: Rec.input } : undefined);
      inputKey = key;
    } catch (e) { inputKey = null; toast(t('rec.noinput', { e }), 'err'); }
  });
  return inputQueue;
}
bus.on('change', () => syncInput());

// The transport position right now. While recording it is counted from the moment play was
// pressed (steady, whatever the status polling does); recordNote folds it into the pattern.
function nowTick() {
  const tpms = S.project.bpm * PPQ / 60000;
  // a key is pressed against what is heard, which comes out of the speakers late by the
  // output latency: take that off
  if (Rec.live) return Rec.from + (performance.now() - Rec.t0 - (S.outLat || 0)) * tpms;
  if (!S.playing) return S.pos;
  return S.pos + (performance.now() - (S.posAt || performance.now())) * tpms;
}

// a recorded note: from key down to key up, folded into the current pattern
function recordNote(chId, key, from, to) {
  const p = curPat(), c = chan(chId);
  // played during the count-in: before the take, not part of it
  if (!p || !c || from < Rec.from) return;
  const L = patLen(p);
  const t0 = ((Math.round(from) % L) + L) % L;
  const len = Math.max(6, Math.round(to - from));
  history.edit(() => {
    notesOf(p, chId).push({ t: t0, l: Math.min(len, L), k: key, v: 0.8 });
    notesOf(p, chId).sort((a, b) => a.t - b.t);
  });
}

// ---------- the computer keyboard as a piano ----------
// Physical keys (e.code), so any layout works. Bottom row from C of `kbBase`, top row an octave up.
const KB_LOW = ['KeyZ', 'KeyS', 'KeyX', 'KeyD', 'KeyC', 'KeyV', 'KeyG', 'KeyB', 'KeyH', 'KeyN', 'KeyJ', 'KeyM', 'Comma', 'KeyL', 'Period', 'Semicolon', 'Slash'];
const KB_HIGH = ['KeyQ', 'Digit2', 'KeyW', 'Digit3', 'KeyE', 'KeyR', 'Digit5', 'KeyT', 'Digit6', 'KeyY', 'Digit7', 'KeyU', 'KeyI', 'Digit9', 'KeyO', 'Digit0', 'KeyP', 'BracketLeft'];
let kbBase = 48;                 // C4 on Z, C5 on Q
const kbHeld = new Map();        // code -> {key, stop}
// Scale lock: with a scale chosen (the same one the roll highlights, project.scale) the keys
// that fall outside it play the nearest note inside it (a tie goes down).
let kbLock = (() => { try { return localStorage.getItem('loom.scaleLock') !== '0'; } catch (_) { return true; } })();
function kbSnap(k) {
  const sc = S.project.scale, d = kbLock && sc && SCALES[sc.mode];
  if (!d) return k;
  const inScale = x => d.includes(((x - sc.root) % 12 + 12) % 12);
  for (let o = 0; o < 7; o++) {
    if (inScale(k - o)) return k - o;
    if (inScale(k + o)) return k + o;
  }
  return k;
}
function kbKey(code) {
  let i = KB_LOW.indexOf(code);
  if (i >= 0) return kbSnap(kbBase + i);
  i = KB_HIGH.indexOf(code);
  return i >= 0 ? kbSnap(kbBase + 12 + i) : -1;
}
// the scale button in the header: root and mode, lit while the lock is doing something
function kbScaleSync() {
  const sc = S.project.scale, on = kbLock && !!sc && sc.mode !== 'none';
  $('#t-scale-val').textContent = !sc || sc.mode === 'none' ? t('scale.none') : NOTE_NAMES[sc.root] + ' ' + t('scale.short.' + sc.mode);
  $('#t-scale').classList.toggle('on', on);
}
function kbScaleMenu(el) {
  const r = el.getBoundingClientRect(), sc = S.project.scale || { mode: 'none', root: 0 };
  const set = o => history.edit(() => { S.project.scale = { ...sc, ...o }; });
  menu(r.left, r.bottom + 4, [
    { head: t('scale.keys') },
    { label: t('scale.lock'), on: kbLock, fn: () => { kbLock = !kbLock; try { localStorage.setItem('loom.scaleLock', kbLock ? '1' : '0'); } catch (_) { } kbScaleSync(); } },
    ...['none', 'minor', 'major'].map(m => ({ label: t('scale.' + m), on: sc.mode === m, fn: () => set({ mode: m }) })),
    { head: t('scale.root') },
    ...NOTE_NAMES.map((n, i) => ({ label: n, on: sc.root === i, fn: () => set({ root: i, mode: sc.mode === 'none' ? 'minor' : sc.mode }) })),
  ]);
}
function kbShowOctave() { hintValue(t('kb.octave'), keyName(kbBase) + ' – ' + keyName(kbBase + 29)); }
function kbRelease(code) {
  const n = kbHeld.get(code);
  if (!n) return;
  kbHeld.delete(code);
  n.stop();
  if (n.rec != null) recordNote(n.ch, n.key, n.rec, nowTick());
  Roll.setPressed(new Set([...kbHeld.values()].map(x => x.key)));
}
function kbReleaseAll() { [...kbHeld.keys()].forEach(kbRelease); }
// true when the key was a piano key (or an octave key)
function kbDown(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.code === 'Minus' || e.code === 'Equal') {
    kbReleaseAll();
    kbBase = clamp(kbBase + (e.code === 'Minus' ? -12 : 12), 0, 96);
    kbShowOctave();
    return true;
  }
  const key = kbKey(e.code);
  if (key < 0 || key > 127) return false;
  if (e.repeat || kbHeld.has(e.code)) return true;
  const c = curChan();
  if (!c) return true;
  if (c.inst.type === 'audio') {
    // an audio channel has no pitch: any key plays its sound
    api.call('preview', { path: c.inst.path || null, sample: c.inst.path ? null : c.inst.sample });
    kbHeld.set(e.code, { key, stop: () => { } });
    return true;
  }
  kbHeld.set(e.code, { key, ch: c.id, stop: preview(c.id, key, 0.8), rec: Rec.notes() ? nowTick() : null });
  Roll.setPressed(new Set([...kbHeld.values()].map(x => x.key)));
  hint('<b>' + c.name + '</b> ' + keyName(key));
  return true;
}

// ---------- keys ----------
// Alt+R: start recording (armed and playing at once); while it records (or counts in), stop.
// A press while play is still being prepared is let be, not taken for a stop.
// In the piano roll Alt+R is FL's randomizer, but only with the pointer over it: the roll stays
// the active window after a MIDI drop or at start-up, and recording must not hang on that.
let pointerEl = null; // under the pointer (initKeys keeps it)
const overRoll = () => !!(Roll.win && Roll.win.open && !Roll.win.min && pointerEl && pointerEl.isConnected && pointerEl.closest && pointerEl.closest('.win[data-win=roll]'));
function altR() { if (overRoll()) Roll.randomizer(); else recordKey(); }
function recordKey() {
  // Starting/stopping is one operation: another press must not cancel it halfway through.
  if (Transport.starting || Rec.stopping) return;
  if (Rec.live) return Transport.stop();
  Rec.armed = true;
  Rec.sync();
  return Transport.play();
}
const keyIs = (e, code, labels) => e.code ? e.code === code : labels.includes(e.key.toLowerCase());
function initKeys() {
  document.addEventListener('keyup', e => kbRelease(e.code));
  document.addEventListener('pointermove', e => { pointerEl = e.target; }, true);
  document.documentElement.addEventListener('pointerleave', () => { pointerEl = null; });
  // keys typed while a plugin window has the focus come from the Rust side
  if (TAURI && TAURI.event) {
    TAURI.event.listen('kbd', ev => {
      const { code, down, repeat } = ev.payload;
      if (window.__logKbd) api.call('dev_log', { text: 'kbd ' + JSON.stringify({ code, down, repeat, ch: S.curCh }) });
      if (code === 'Ctrl+KeyZ' || code === 'Ctrl+Shift+KeyZ' || code === 'Ctrl+KeyY') {
        if (down) { if (code === 'Ctrl+KeyZ') undo(); else redo(); }
        return;
      }
      // Alt+R typed in a plugin window, or in the frame while the page had lost the focus
      if (code === 'Alt+KeyR' || code === 'Plugin+Alt+KeyR') {
        if (down && !repeat) {
          if (code === 'Alt+KeyR') altR(); else recordKey();
        }
        return;
      }
      if (!down) { kbRelease(code); return; }
      if (code === 'Space') { if (!repeat) Transport.toggle(); return; }
      kbDown({ code, repeat, ctrlKey: false, metaKey: false, altKey: false });
    });
  }
  // a key let go while the window was not looking would hang forever
  window.addEventListener('blur', kbReleaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) kbReleaseAll(); });
  document.addEventListener('keydown', e => {
    if (window.__logKbd) api.call('dev_log', { text: 'dom-key ' + JSON.stringify({ key: e.key, code: e.code, alt: e.altKey, ctrl: e.ctrlKey, repeat: e.repeat }) });
    const field = e.target.matches && e.target.matches('input, textarea');
    const text = e.target.isContentEditable || (field && !['checkbox', 'radio', 'range', 'button', 'submit'].includes(e.target.type));
    const mod = e.ctrlKey || e.metaKey;
    // Switches and sliders can retain focus after an edit. Their Ctrl+Z belongs
    // to the project; text fields retain the browser's own text undo instead.
    if (!text && mod && !e.altKey && keyIs(e, 'KeyZ', 'zя') && !e.shiftKey) { undo(); e.preventDefault(); return; }
    if (!text && mod && !e.altKey && (keyIs(e, 'KeyY', 'yн') || (keyIs(e, 'KeyZ', 'zя') && e.shiftKey))) { redo(); e.preventDefault(); return; }
    if (e.target.matches && e.target.matches('input, textarea')) return;
    if (e.target.isContentEditable) return;
    const k = e.key, ctrl = e.ctrlKey || e.metaKey;
    // Accessibility/remote input may omit the physical code. Real keyboard events still
    // use KeyR in any layout; for code-less events accept R and its Russian key label.
    const recKey = e.altKey && !ctrl && (e.code === 'KeyR' || (!e.code && /^[rк]$/i.test(k)));
    const active = $('.win.active');
    const aw = active && active.dataset.win;
    let done = true;
    if (k === 'Escape') closeMenu();
    // a held key repeats: play/stop and record toggle once per press, not on and off in a burst
    else if (e.repeat && (k === ' ' || recKey)) { }
    else if (k === ' ') Transport.toggle();
    // Alt+R: record (arms and plays); while recording, stop. By key position: any layout
    // (with the pointer over the piano roll it is the randomizer, as in FL)
    else if (recKey) { if (!e.repeat) altR(); }
    else if (k === 'F5') WM.wins.playlist.toggle();
    else if (k === 'F6') WM.wins.rack.toggle();
    else if (k === 'F7') WM.wins.roll.toggle();
    else if (k === 'F8') Browser.toggle();
    else if (k === 'F9') WM.wins.mixer.toggle();
    else if (ctrl && k.toLowerCase() === 's') fileSave(e.shiftKey);
    else if (ctrl && k.toLowerCase() === 'o') fileOpen();
    else if (ctrl && k.toLowerCase() === 'n') fileNew();
    else if (aw === 'roll' && Roll.key(e)) { }
    else if (aw === 'playlist' && Playlist.key(e)) { }
    else if (kbDown(e)) { }
    // keep the webview's own shortcuts (reload, caret browsing, print, find) out of the way
    else if (/^F\d+$/.test(k) || (ctrl && 'rpfgu'.includes(k.toLowerCase()))) { }
    else done = false;
    if (done) e.preventDefault();
  });
}

// ---------- MIDI files ----------
const Midi = {
  // A file read in. target 'roll': its notes go to the current channel of the current pattern;
  // a channel id: to that channel (a file dropped on its rack row, say Serum's); otherwise each
  // track becomes a channel of a new pattern (placed where it was dropped on the playlist,
  // `at` = {x, y}). A project with no notes yet takes the file's tempo.
  async import(path, target, at) {
    if (typeof target === 'number') { S.curCh = target; target = 'roll'; }
    let r;
    try { r = await api.call('midi_import', { path: path || null }); }
    catch (e) { toast(t('toast.err', { e }), 'err'); return; }
    if (!r) return;
    const tracks = r.file.tracks;
    if (!tracks.length) { toast(t('midi.empty'), 'info'); return; }
    const P = S.project;
    const fresh = !P.clips.length && !P.patterns.some(p => Object.values(p.notes).some(ns => ns.length));
    const end = Math.max(...tracks.flatMap(tr => tr.notes.map(n => n.t + n.l)));
    let placed = null;
    history.edit(() => {
      if (fresh && r.file.bpm) P.bpm = Math.round(clamp(r.file.bpm, 20, 400) * 10) / 10;
      if (target === 'roll') {
        const c = curChan(), p = curPat();
        if (!c || !p) return;
        const arr = notesOf(p, c.id);
        for (const tr of tracks) for (const n of tr.notes) arr.push({ ...n });
        arr.sort((a, b) => a.t - b.t);
        p.bars = Math.max(p.bars || 1, Math.ceil(end / BAR));
        return;
      }
      const id = nextId(P.patterns);
      const pat = newPattern(id);
      pat.name = r.name;
      pat.bars = Math.max(1, Math.ceil(end / BAR));
      let first = null;
      for (const tr of tracks) {
        const cid = nextId(P.channels);
        // the instrument is the built-in synth: put a plugin or a sound on the channel to taste
        P.channels.push(newSynth(cid, tr.name + (tr.channel === 9 ? ' (drums)' : '')));
        pat.notes[cid] = tr.notes.map(n => ({ ...n }));
        if (first == null) first = cid;
      }
      P.patterns.push(pat);
      S.curPat = id; S.placeCh = 0; S.curCh = first;
      if (at) placed = Playlist.placePattern(id, at.x, at.y);
    });
    if (S.mode === 'pat') Transport.sendMode();
    toast(t('midi.done', { name: r.name, n: tracks.length, notes: tracks.reduce((s, tr) => s + tr.notes.length, 0) }) + (fresh && r.file.bpm ? ' · ' + Math.round(r.file.bpm) + ' bpm' : ''), 'info');
    if (target === 'roll' || !placed) Roll.win.show();
  },
  // where a file dropped on `el` goes: a channel's rack row or its window → that channel,
  // the piano roll → its channel, anywhere else → new channels
  targetOf(el) {
    const row = el && el.closest('.rack-row');
    if (row && chan(+row.dataset.ch)) return +row.dataset.ch;
    return el && el.closest('.win[data-win=roll], .win[data-win=chan]') ? 'roll' : 'new';
  },
  // The current pattern as a MIDI file: a track per channel with notes (slides left out).
  async exportPattern() {
    const p = curPat();
    const tracks = S.project.channels.filter(c => (p.notes[c.id] || []).some(n => !n.s))
      .map(c => ({ name: c.name, notes: p.notes[c.id].filter(n => !n.s).map(n => ({ t: n.t, l: n.l, k: n.k, v: n.v })) }));
    if (!tracks.length) { toast(t('midi.nothing'), 'info'); return; }
    try {
      const path = await api.call('midi_export', { bpm: S.project.bpm, name: projName() + ' - ' + p.name, tracks });
      if (path) toast(t('toast.exported', { name: path.split(/[\\/]/).pop() }));
    } catch (e) { toast(t('toast.err', { e }), 'err'); }
  },
};

// ---------- files dropped on the window ----------
function initDrop() {
  if (!TAURI || !TAURI.webviewWindow) return;
  // the position comes in physical pixels of the window
  const at = p => p ? document.elementFromPoint(p.x / devicePixelRatio, p.y / devicePixelRatio) : null;
  let lit = null, midi = false; // the drag carries a MIDI file ('enter' has the paths, 'over' not)
  const light = el => { if (lit !== el) { if (lit) lit.classList.remove('drop-on'); lit = el; if (lit) lit.classList.add('drop-on'); } };
  TAURI.webviewWindow.getCurrentWebviewWindow().onDragDropEvent(async ev => {
    const { type, paths, position } = ev.payload;
    if (type === 'over' || type === 'enter') {
      const el = at(position);
      // a MIDI file lights the channel row it would go to
      if (type === 'enter') midi = (paths || []).some(p => /\.midi?$/i.test(p));
      light(el && el.closest(midi ? '[data-pl], .rack-row' : '[data-pl]'));
      return;
    }
    light(null);
    if (type !== 'drop') return;
    const el = at(position);
    const onPlaylist = el && el.closest('[data-pl]');
    let x = position ? position.x / devicePixelRatio : 0;
    const y = position ? position.y / devicePixelRatio : 0;
    for (const path of paths) {
      if (/\.loom$/i.test(path)) { fileOpen(path); return; }
      // a MIDI file: into the piano roll's channel, or new channels (and a clip where it fell)
      if (/\.midi?$/i.test(path)) {
        await Midi.import(path, Midi.targetOf(el), onPlaylist ? { x, y } : null);
        continue;
      }
      const name = path.split(/[\\/]/).pop();
      try {
        if (onPlaylist) {
          await Playlist.dropAudio({ kind: 'audio', name, path }, x, y);
          // the next file goes right after this one
          const c = S.project.clips[S.project.clips.length - 1];
          x = Playlist.xOfTick(c.t + c.l) + 1;
        } else Rack.addSampleChannel(await api.call('load_sample', { path }));
      } catch (e) { toast(t('toast.err', { e }), 'err'); }
    }
  });
}

// ---------- status loop: position, levels, playheads ----------
let master = [0, 0], lastErr = null, recLevel = 0;
// automated plugin values the plugin windows were last told, by "pid:param"
const followed = new Map();
bus.on('restore', () => { followed.clear(); Transport.sendMode(); });
function followList() {
  const out = [];
  if (S.mode !== 'song') { followed.clear(); return out; }
  for (const l of S.project.automation || []) {
    if (l.target.kind !== 'param' || !l.on || !l.points.length) continue;
    const k = l.target.pid + ':' + l.target.param, v = Auto.value(l.points, S.pos);
    if (followed.get(k) !== v) { followed.set(k, v); out.push([l.target.pid, l.target.param, v]); }
  }
  return out;
}
// parameters grabbed in a plugin window: their lanes stop until automation is re-enabled
function pluginTouched(list) {
  if (!list || !list.length) return;
  const hit = list.filter(([pid, param]) => Auto.laneOf({ kind: 'param', pid, param })?.on);
  list.forEach(([pid, param]) => { if (!hit.length) Auto.touch({ kind: 'param', pid, param }); });
  if (hit.length) history.edit(() => hit.forEach(([pid, param]) => Auto.touch({ kind: 'param', pid, param })));
}
async function statusLoop() {
  for (;;) {
    try {
      const serial = Transport.serial;
      const request = api.call('status', { chans: S.project.channels.length, mix: S.project.mixer.length, follow: followList() });
      const s = await (Plugins.poll ? Plugins.poll(request) : request);
      if (s) {
        pluginTouched(s.touched);
        if (Rec.live && performance.now() - (Rec.polled || 0) > 80) { Rec.polled = performance.now(); Rec.poll(); }
        Transport.updateStatus(s, serial);
        S.peaks = s.chans || [];
        S.outLat = s.out_latency_ms || 0;
        if (s.error && s.error !== lastErr) toast(t('toast.audio', { e: s.error }), 'err');
        lastErr = s.error;
        const st = $('#stat');
        st.classList.toggle('err', !!s.error);
        st.textContent = s.error ? t('st.off', { e: s.error }) : t('st.info', { sr: s.sr, v: s.voices, load: Math.round((s.load || 0) * 100) });
        if (Rec.live) {
          // ● rec 0:12 · the input level as ASCII
          recLevel = Math.max(s.input || 0, recLevel * 0.85);
          const secs = (performance.now() - Rec.t0) / 1000;
          const lvl = Rec.file ? '  ' + t('rec.in') + ' ' + '■'.repeat(clamp(Math.round((20 * Math.log10(recLevel || 1e-5) + 48) / 48 * 10), 0, 10)).padEnd(10, '·') : '';
          // before the music starts: the count-in, beat by beat
          const what = secs < 0 ? t('rec.counting', { n: Math.ceil(-secs * S.project.bpm / 60) })
            : t('rec.rec') + ' ' + Math.floor(secs / 60) + ':' + String(Math.floor(secs % 60)).padStart(2, '0');
          st.prepend(h('span', { class: 'rec' }, '● ' + what + lvl + '   '));
        }
        Mixer.tick(s.mix || []);
        master = master.map((m, i) => Math.max(s.master[i] || 0, m * 0.82));
      }
    } catch (_) { }
    $('#pos-val').textContent = fmtPos(S.pos);
    $('#pos-time').textContent = fmtTime(S.pos);
    asciiMeter($('#m-l'), master[0], 16);
    asciiMeter($('#m-r'), master[1], 16);
    Rack.tick();
    Chan.tick();
    Roll.follow();
    Roll.playhead();
    Playlist.playhead();
    Playlist.follow();
    await new Promise(r => requestAnimationFrame(r));
  }
}

// `--plugtest`: a self-check with real plugins. Scans (with D:\Program Files\VST if it is there),
// adds an instrument channel with notes and an effect on the master, plays, and logs what it got.
async function plugTest(flags) {
  const log = (tag, x) => api.call('dev_log', { text: tag + ' ' + JSON.stringify(x) });
  const list = await Plugins.folders();
  const added = !list.includes('D:\\Program Files\\VST');
  if (added) { list.push('D:\\Program Files\\VST'); localStorage.setItem('loom.pluginFolders', JSON.stringify(list)); }
  await Plugins.scan();
  if (added) await Plugins.scan();
  log('scan', { found: Plugins.found.length, failed: Plugins.failed, names: Plugins.found.map(p => p.format + ':' + p.name) });
  const want = (flags.find(f => f.startsWith('--inst=')) || '--inst=Petal Keys').slice(7);
  const fxName = (flags.find(f => f.startsWith('--fx=')) || '--fx=OTT').slice(5);
  const inst = Plugins.instruments().find(p => p.name === want) || Plugins.instruments()[0];
  const fx = Plugins.effects().find(p => p.name === fxName) || Plugins.effects()[0];
  if (inst) {
    const id = Plugins.addInstrument(inst);
    history.edit(() => { curPat().notes[id] = [0, 4, 8, 12].map(s => ({ t: s * STEP, l: STEP * 3, k: 60 + (s % 8 ? 7 : 0), v: 0.9 })); });
  }
  const fxPid = fx ? Plugins.addEffect(fx, 0) : 0;
  await new Promise(r => setTimeout(r, 2500));
  if (flags.includes('--keys')) {
    // keys come from outside (tools posting key messages to the plugin window): open the
    // instrument's window, log the voices for a while, play nothing
    const c = S.project.channels.slice(-1)[0];
    S.curCh = c.id;
    await Plugins.openEditor(c.inst.pid);
    window.__logKbd = true;
    for (let i = 0; i < 40; i++) {
      const s = await api.call('status', { chans: 0, mix: 0 });
      if (s.voices) log('voices', { t: i, voices: s.voices });
      await new Promise(r => setTimeout(r, 250));
    }
    return;
  }
  if (fxPid && flags.includes('--openfx')) {
    // the same path a click on the mixer slot takes
    Mixer.win.show();
    Mixer.select(0);
    const slot = $('.mx-slot[data-slot="0"] .sn');
    log('slot', { found: !!slot, text: slot && slot.textContent });
    if (slot) slot.click();
    await new Promise(r => setTimeout(r, 1500));
  }
  Transport.setMode('pat');
  Transport.play();
  if (inst) { const c = S.project.channels.slice(-1)[0]; c && (S.curCh = c.id); Plugins.openEditor(c.inst.pid); }
  await new Promise(r => setTimeout(r, 3000));
  const s = await api.call('status', { chans: S.project.channels.length, mix: S.project.mixer.length });
  log('play', { inst: inst && inst.name, fx: fx && fx.name, plugins: S.project.plugins.map(p => [p.id, p.name, Plugins.errorOf(p.id) || 'ok']), peaks: s.chans, master: s.master, voices: s.voices, load: s.load });
}

// `--audiotest [--wav=<file>]`: drops a file and a kit sound into the playlist, plays the song,
// logs the levels (checks for audio clips and their waveforms)
async function audioTest(flags) {
  const log = (tag, x) => api.call('dev_log', { text: tag + ' ' + JSON.stringify(x) });
  const wav = (flags.find(f => f.startsWith('--wav=')) || '').slice(6);
  WM.wins.playlist.show();
  if (!WM.wins.playlist.max) WM.wins.playlist.maximize();
  await new Promise(r => setTimeout(r, 300));
  const r = $('[data-pl]').getBoundingClientRect();
  if (wav) await Playlist.dropAudio({ kind: 'audio', name: wav.split(/[\\/]/).pop(), path: wav }, r.left + 128 + 3, r.top + 34);
  await Playlist.dropAudio({ kind: 'kit', name: 'crash', sample: 'crash' }, r.left + 128 + 80 * 2 + 3, r.top + 82);
  // the crash's audio channel goes to insert 1: its sound must show on that track
  const crash = S.project.channels.find(c => c.inst.type === 'audio' && c.inst.sample === 'kit:crash');
  history.edit(() => { crash.mix = 1; });
  Transport.seekSong(0);
  Transport.play();
  // halfway into the crash (bar 3): the master must be moving
  const crashAt = BAR * 2 * 60 / (S.project.bpm * PPQ) * 1000;
  await new Promise(r => setTimeout(r, crashAt + 400));
  let peak = 0, insert1 = 0, chanPeak = 0;
  const ci = S.project.channels.indexOf(crash);
  for (let i = 0; i < 10; i++) {
    const s = await api.call('status', { chans: S.project.channels.length, mix: 2 });
    peak = Math.max(peak, s.master[0], s.master[1]);
    insert1 = Math.max(insert1, s.mix[2], s.mix[3]);
    chanPeak = Math.max(chanPeak, s.chans[ci]);
    await new Promise(r => setTimeout(r, 30));
  }
  log('audio', { channels: S.project.channels.map(c => [c.id, c.name, c.inst.type, c.mix]), clips: S.project.clips.map(c => [c.ch, c.t, c.l]), master: peak, insert1, crashChannel: chanPeak });
}

// `--rectest [--recaudio]`: arms recording in song mode, plays two notes from the "keyboard"
// on the first channel, stops, and logs what got written (notes, and with --recaudio the take)
async function recTest(flags) {
  const log = (tag, x) => api.call('dev_log', { text: tag + ' ' + JSON.stringify(x) });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const preferences = { what: Rec.what, countIn: Rec.countIn, monitor: Rec.monitor, metronome: Rec.metronome };
  window.addEventListener('blur', () => log('blur', { at: Math.round(performance.now()) }));
  await sleep(2500);
  log('start', { at: Math.round(performance.now()), focus: document.hasFocus() });
  Rec.what = flags.includes('--recaudio') ? 'both' : 'notes';
  Rec.countIn = flags.includes('--count') ? 1 : 0;
  Rec.monitor = flags.includes('--monitor');
  Rec.setMetronome(true);
  S.curCh = S.project.channels[0].id;
  Transport.setMode('song');
  // keep what rec_stop answers
  let takes = [];
  const orig = api.call;
  api.call = async (c, a) => { const r = await orig(c, a); if (c === 'rec_stop') takes = r || []; return r; };
  // --track: arm mixer track 1 on input 1 (an FL-style track recording) instead of the whole input
  if (flags.includes('--track')) history.edit(() => { S.project.mixer[1].input = 1; S.project.mixer[1].arm = true; });
  if (flags.includes('--multitrack')) history.edit(() => { S.project.mixer[2].input = 3; S.project.mixer[2].arm = true; });
  await syncInput();
  const before = await api.call('status', { chans: 0, mix: 3 });
  log('rec-monitor', { inputOpen: before.input != null, recording: before.recording, mix: before.mix });
  Rec.arm();
  await Transport.play();
  // a note during the count-in must not be recorded
  if (Rec.countIn) { kbDown({ code: 'KeyW', repeat: false }); await sleep(100); kbRelease('KeyW'); await sleep(Rec.countMs() - 100); }
  await sleep(500);
  const press = async (code, ms) => { kbDown({ code, repeat: false, ctrlKey: false, metaKey: false, altKey: false }); await sleep(ms); kbRelease(code); };
  await press('KeyQ', 450);
  await sleep(200);
  await press('KeyE', 250);
  await sleep(400);
  const s = await api.call('status', { chans: 0, mix: 0 });
  await Transport.stop();
  await syncInput();
  api.call = orig;
  const after = await api.call('status', { chans: 0, mix: 3 });
  log('rec', {
    notes: (curPat().notes[S.project.channels[0].id] || []).map(n => [n.t, n.l, n.k]),
    outLatencyMs: S.outLat, takes: takes.map(take => ({ seconds: take.seconds, offset_ms: take.offset_ms, sr: take.sr, ch: take.channels, track: take.track })),
    recLevelSeen: s.input, live: Rec.live,
    after: { inputOpen: after.input != null, recording: after.recording },
    channels: S.project.channels.filter(c => c.inst.type === 'audio').map(c => [c.name, c.inst.path, 'mix', c.mix]),
    clips: S.project.clips.map(c => [c.ch, c.track, c.t, c.l]),
  });
  Object.assign(Rec, preferences);
  Rec.setMetronome(preferences.metronome);
}

async function main() {
  Settings.load();
  WM.load();
  // every start is a clean, empty project (the demo song only with --demo / ?demo)
  try { localStorage.removeItem('loom.autosave'); } catch (_) { }
  const flags = (await api.call('launch_flags')) || [];
  const demo = new URLSearchParams(location.search).has('demo') || flags.includes('--demo');
  S.project = normalize(demo ? demoProject() : emptyProject());
  S.path = null;
  S.curPat = S.project.patterns[0].id;
  S.curCh = (S.project.channels[0] || {}).id || 0;
  window.FIELD = GlyphField($('#field'));
  initTop();
  Rec.load();
  Rec.sync();
  const audioDevice = (flags.find(f => f.startsWith('--driver=')) || '').slice(9) || localStorage.getItem('loom.audioDevice');
  if (audioDevice) {
    try { await api.call('set_device', { device: audioDevice }); }
    catch (e) { toast(t('toast.audio', { e }), 'err'); }
  }
  if (Rec.metronome) api.call('set_metronome', { on: true });
  Playlist.init(); Rack.init(); Roll.init(); Chan.init(); Mixer.init(); Settings.init();
  Browser.init();
  Plugins.scan();
  WM.sync();
  initKeys();
  if (flags.includes('--keys')) window.__logKbd = true;
  initDrop();
  new ResizeObserver(() => WM.reflow()).observe($('#desk'));
  changed({ clean: true });
  S.dirty = false;
  Transport.sendMode();
  applyI18n();
  updateTitle();
  statusLoop();
  const launch = await api.call('launch_file');
  if (launch) await fileOpen(launch);
  if (flags.includes('--song')) Transport.setMode('song');
  if (flags.includes('--play')) setTimeout(() => Transport.play(), 300);
  if (flags.includes('--plugtest')) plugTest(flags);
  if (flags.includes('--audiotest')) audioTest(flags);
  if (flags.includes('--rectest')) recTest(flags);
  if (flags.includes('--log')) {
    const dump = tag => api.call('dev_log', { text: tag + ' ' + JSON.stringify({
      dpr: devicePixelRatio, inner: [innerWidth, innerHeight], desk: [$('#desk').clientWidth, $('#desk').clientHeight],
      wins: Object.fromEntries(Object.values(WM.wins).map(w => [w.id, [w.x, w.y, w.w, w.h, w.auto, w.open]])),
      saved: localStorage.getItem('loom.layout'),
    }) });
    dump('start');
    setTimeout(() => dump('3s'), 3000);
  }
}
main();
