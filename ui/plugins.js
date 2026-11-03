// Plugins on the UI side: what the scan found, which instances the project needs, and the
// glue to the Rust host (load/unload, editors, state). Instances follow project.plugins:
// sync() loads what is missing and unloads what is gone after every edit.

const Plugins = (() => {
  let found = [];          // PluginInfo[] from the last scan
  let failed = [];
  let scanning = false;
  const loaded = new Map(); // id -> {name, editor, error}
  let syncTimer = 0, syncing = false, again = false;
  let gesture = 0, pendingPoll = Promise.resolve(), navigation = Promise.resolve();
  const gestures = new Map();

  const key = d => d.format + '|' + d.path + '|' + d.cid;
  const loadFolders = () => { try { return JSON.parse(localStorage.getItem('loom.pluginFolders') || 'null'); } catch (_) { return null; } };
  const saveFolders = f => { try { localStorage.setItem('loom.pluginFolders', JSON.stringify(f)); } catch (_) { } };

  async function folders() {
    let f = loadFolders();
    if (!f) { f = (await api.call('plugin_default_folders')) || []; saveFolders(f); }
    return f;
  }

  // a second call while one runs waits for that one
  let running = null;
  function scan(rescan) {
    if (running) return running;
    running = (async () => {
      scanning = true;
      bus.emit('plugins');
      try {
        const r = await api.call('plugin_scan', { folders: await folders(), rescan: !!rescan });
        found = (r && r.plugins) || [];
        failed = (r && r.failed) || [];
      } catch (e) { toast(t('toast.err', { e }), 'err'); }
      scanning = false;
      running = null;
      bus.emit('plugins');
    })();
    return running;
  }

  async function addFolder() {
    const f = await api.call('pick_folder');
    if (!f) return;
    const list = await folders();
    if (!list.includes(f)) { list.push(f); saveFolders(list); }
    scan();
  }
  async function removeFolder(f) {
    saveFolders((await folders()).filter(x => x !== f));
    scan();
  }

  // ---------- instances ----------
  const nextPid = () => S.project.plugins.reduce((m, p) => Math.max(m, p.id), 0) + 1;
  function descFor(info) {
    return { id: nextPid(), format: info.format, path: info.path, cid: info.cid, name: info.name, vendor: info.vendor, instrument: info.instrument, state: '' };
  }

  // plugins nobody refers to any more leave the project
  function collect() {
    const used = new Set();
    S.project.channels.forEach(c => { if (c.inst.type === 'plugin') used.add(c.inst.pid); });
    S.project.mixer.forEach(m => m.fx.forEach(f => used.add(f.pid)));
    S.project.plugins = S.project.plugins.filter(p => used.has(p.id));
  }

  function schedule() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => sync().catch(e => toast(t('toast.err', { e }), 'err')), 60);
  }
  async function sync() {
    if (syncing) { again = true; return; }
    syncing = true;
    let did = false;
    try {
      // a project switch unloads first: ids repeat across projects
      await unloading;
      const want = new Map(S.project.plugins.map(p => [p.id, p]));
      const gone = [...loaded.keys()].filter(id => !want.has(id) || loaded.get(id).key !== key(want.get(id)));
      if (gone.length) {
        did = true;
        await api.call('plugin_unload', { ids: gone });
        gone.forEach(id => loaded.delete(id));
      }
      for (const [id, d] of want) {
        if (loaded.has(id)) {
          const instance = loaded.get(id);
          if (instance.error) continue;
          const values = Object.assign({}, instance.base, d.params);
          const delta = Object.entries(values).filter(([param, v]) => instance.values[param] !== v).map(([param, v]) => [+param, v]);
          if (delta.length) {
            await api.call('plugin_set_params', { id, values: delta });
            delta.forEach(([param, v]) => { instance.values[param] = v; });
          }
          continue;
        }
        did = true;
        try {
          const r = await api.call('plugin_load', { desc: d });
          const values = Object.assign({}, r?.params, d.params);
          loaded.set(id, { key: key(d), name: r ? r.name : d.name, editor: r ? r.editor : false, base: { ...values }, values: { ...values } });
          // Seed the before-value once, without creating an edit just for loading.
          if (S.project.plugins.includes(d)) d.params = values;
          else again = true;
        } catch (e) {
          loaded.set(id, { key: key(d), name: d.name, error: String(e) });
          toast(d.name + ': ' + e, 'err');
        }
      }
    } finally {
      syncing = false;
      // repaint only when something came or went: a repaint never asks for another sync
      if (did) redraw();
      if (again) { again = false; sync().catch(e => toast(t('toast.err', { e }), 'err')); }
    }
  }

  // a project switch: everything goes, the new project loads its own
  let unloading = Promise.resolve();
  function reset() {
    const ids = [...loaded.keys()];
    loaded.clear();
    gestures.clear();
    if (ids.length) unloading = api.call('plugin_unload', { ids }).catch(() => { });
    schedule();
  }

  function addInstrument(info) {
    let id;
    history.edit(() => {
      const d = descFor(info);
      S.project.plugins.push(d);
      id = nextId(S.project.channels);
      const c = newSynth(id, info.name);
      c.inst = { type: 'plugin', pid: d.id };
      S.project.channels.push(c);
      S.curCh = id;
    });
    schedule();
    return id;
  }

  // into the first free slot of a mixer track (or a given slot)
  function addEffect(info, track, slot) {
    let pid;
    history.edit(() => {
      const d = descFor(info);
      pid = d.id;
      S.project.plugins.push(d);
      const fx = S.project.mixer[track].fx;
      const old = slot != null ? fx[slot] : null;
      if (slot != null && slot < fx.length) fx[slot] = { pid: d.id, on: true, mix: 1 };
      else fx.push({ pid: d.id, on: true, mix: 1 });
      if (old) collect();
    });
    schedule();
    return pid;
  }

  function desc(pid) { return S.project.plugins.find(p => p.id === pid); }
  function nameOf(pid) { const d = desc(pid); const l = loaded.get(pid); return (l && l.name) || (d && d.name) || '?'; }
  function errorOf(pid) { const l = loaded.get(pid); return l && l.error; }

  async function openEditor(pid) {
    const d = desc(pid);
    if (!d) return;
    // still loading (a fresh project, a slow plugin): wait for it, up to 15 s
    for (let i = 0; i < 150 && (syncing || !loaded.has(pid)); i++) {
      if (!syncing) await sync();
      else await new Promise(r => setTimeout(r, 100));
    }
    const l = loaded.get(pid);
    if (l && l.error) { toast(d.name + ': ' + l.error, 'err'); return; }
    hint('<b>' + d.name + '</b>  · ' + t('fx.opening'));
    try { await api.call('plugin_editor', { id: pid, title: d.name + ' — loom' }); }
    catch (e) { toast(d.name + ': ' + e, 'err'); }
  }

  // current plugin states into the project, before it is written to disk
  async function captureStates() {
    if (!S.project.plugins.length) return;
    try {
      await pendingPoll;
      edited(await api.call('plugin_edits'));
      const project = S.project;
      const st = await api.call('plugin_states');
      if (!st || S.project !== project) return;
      for (const p of project.plugins) {
        if (st[p.id] == null) continue;
        p.state = st[p.id].state;
        p.params = st[p.id].params;
        const instance = loaded.get(p.id);
        if (instance && p.params) instance.values = { ...p.params };
      }
    } catch (e) { toast(t('toast.err', { e }), 'err'); }
  }

  // Plugin callbacks arrive independently of the audio thread. Keep a complete
  // gesture as one undo entry, even when it spans many status responses.
  function edited(list) {
    for (const [pid, event] of list || []) {
      const d = desc(pid), instance = loaded.get(pid);
      if (!d || !instance || instance.error) continue;
      const id = event.id, slot = pid + ':' + id;
      if (event.kind === 'end') {
        if (history.mergeKey === gestures.get(slot)?.key) history.mergeKey = null;
        gestures.delete(slot);
        continue;
      }
      const now = performance.now();
      let g = gestures.get(slot);
      if (event.kind === 'begin' || !g || (!g.explicit && now - g.at > 350)) {
        g = { key: 'plugin:' + ++gesture, explicit: event.kind === 'begin', at: now };
        gestures.set(slot, g);
      }
      g.at = now;
      if (event.kind === 'value' && Number.isFinite(event.value)) {
        const value = clamp(event.value, 0, 1);
        // Update the host mirror before changed() schedules synchronization: a
        // user's own edit is already playing, and must not be sent back as automation.
        instance.values[id] = value;
        history.edit(() => {
          d.params ||= { ...instance.base };
          d.params[id] = value;
          Auto.touch({ kind: 'param', pid, param: id });
        }, g.key);
      } else if (event.kind === 'begin' && Auto.laneOf({ kind: 'param', pid, param: id })?.on) {
        history.edit(() => Auto.touch({ kind: 'param', pid, param: id }), g.key);
      }
    }
  }
  function poll(promise) {
    const project = S.project, revision = history.revision;
    pendingPoll = promise.then(s => {
      if (S.project === project && history.revision === revision) edited(s?.edits);
      else if (s) return { ...s, edits: [], touched: [] };
      return s;
    });
    return pendingPoll;
  }
  function navigate(step) {
    if (!loaded.size && !syncing) {
      step();
      if (S.project.plugins.length) return sync();
      return;
    }
    const session = history.session;
    navigation = navigation.catch(() => {}).then(async () => {
      await pendingPoll.catch(() => {});
      if (session !== history.session) return;
      const events = await api.call('plugin_edits');
      if (session !== history.session) return;
      edited(events);
      step();
      gestures.clear();
      // Apply the restored values immediately; do not wait for the next status tick.
      while (syncing) await new Promise(resolve => setTimeout(resolve, 10));
      await sync();
    }).catch(e => toast(t('toast.err', { e }), 'err'));
    return navigation;
  }

  bus.on('change', schedule);

  return {
    scan, addFolder, removeFolder, folders, addInstrument, addEffect, collect, openEditor, captureStates, reset, sync, edited, poll, navigate,
    nameOf, errorOf, desc,
    get found() { return found; }, get failed() { return failed; }, get scanning() { return scanning; },
    instruments: () => found.filter(p => p.instrument),
    effects: () => found.filter(p => !p.instrument),
  };
})();

// ---------- dragging things out of the browser ----------
// item: {kind: 'audio'|'kit'|'plugin', name, path?, sample?, info?}
const Dnd = (() => {
  let ghost = null, over = null, item = null;
  function targetAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    // a MIDI file: onto the piano roll (its channel), the playlist (a clip there) or the rack
    if (item.kind === 'midi') return el.closest('.win[data-win=roll] .cv-wrap, .win[data-win=chan] .win-body, [data-pl], .rack-row, .rack');
    if (item.kind === 'plugin' && !item.info.instrument) return el.closest('.mx-slot, .mx-strip');
    if (item.kind === 'plugin') return el.closest('.rack-row, .rack');
    return el.closest('.rack-row, .rack, [data-pl]');
  }
  function start(e, it) {
    item = it;
    const sx = e.clientX, sy = e.clientY;
    let live = false;
    drag(e, ev => {
      if (!live && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      if (!live) { live = true; ghost = h('div', { class: 'ghost' }, it.name); document.body.append(ghost); }
      ghost.style.left = ev.clientX + 12 + 'px';
      ghost.style.top = ev.clientY + 10 + 'px';
      const tg = targetAt(ev.clientX, ev.clientY);
      if (tg !== over) { if (over) over.classList.remove('drop-on'); over = tg; if (over) over.classList.add('drop-on'); }
    }, ev => {
      if (ghost) ghost.remove();
      ghost = null;
      if (over) over.classList.remove('drop-on');
      const tg = live ? targetAt(ev.clientX, ev.clientY) : null;
      over = null;
      if (tg) drop(it, tg, ev.clientX, ev.clientY);
    });
  }
  function drop(it, tg, x, y) {
    if (it.kind === 'midi') {
      Midi.import(it.path, Midi.targetOf(tg), tg.hasAttribute('data-pl') ? { x, y } : null);
      return;
    }
    // a sound on the playlist: an audio clip right there
    if (tg.hasAttribute('data-pl')) { Playlist.dropAudio(it, x, y); return; }
    if (it.kind === 'plugin' && !it.info.instrument) {
      const strip = tg.closest('[data-mix]');
      const track = strip ? +strip.dataset.mix : Mixer.selected();
      const slot = tg.dataset.slot != null ? +tg.dataset.slot : null;
      Plugins.addEffect(it.info, track, slot);
      Mixer.select(track);
      return;
    }
    const row = tg.closest('.rack-row');
    const c = row && chan(+row.dataset.ch);
    if (c && (c.inst.type === 'sampler' || c.inst.type === 'audio') && it.kind !== 'plugin') {
      // onto a sampler or audio channel: that channel (and all its clips) takes the new sound
      history.edit(() => {
        if (it.kind === 'kit') Object.assign(c.inst, { sample: 'kit:' + it.sample, path: null });
        else Object.assign(c.inst, { sample: it.name, path: it.path });
        c.name = it.name.replace(/\.[^.]+$/, '');
      });
      return;
    }
    Browser.add(it);
  }
  return { start };
})();
