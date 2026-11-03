// Browser: docked on the left, in three tabs. ALL: the built-in kit, the plugins the scan found
// and the user's own folders as a lazy tree. FAVORITES: whatever is starred (☆), flat. PACKS:
// the folders picked one by one (+ here, or "to packs" on any folder). Click a sound to hear
// it, double-click (or drag into the rack) to make a channel, drag a sample onto a sampler row
// to swap its sound, drag an effect onto a mixer track.

const Browser = (() => {
  let el, tree, search, foot, addBtn, tabBtns;
  const open = new Set(JSON.parse(localStorage.getItem('loom.brOpen') || '["kit","inst","fx"]'));
  const kids = new Map();   // folder path -> entries | 'loading' | {error}
  let selKey = '';
  let rows = [];            // flat list of visible rows for keyboard moves
  const TABS = ['all', 'fav', 'packs'];
  let tab = TABS.includes(localStorage.getItem('loom.brTab')) ? localStorage.getItem('loom.brTab') : 'all';

  const readList = k => { try { const v = JSON.parse(localStorage.getItem(k) || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } };
  const writeList = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { } };
  const userFolders = () => readList('loom.folders');
  const saveFolders = f => writeList('loom.folders', f);
  const packs = () => readList('loom.packs');
  const savePacks = f => writeList('loom.packs', f);
  const saveOpen = () => { try { localStorage.setItem('loom.brOpen', JSON.stringify([...open])); } catch (_) { } };

  // favorites: what is needed to find the item again, by its row key
  const favs = () => readList('loom.favs');
  const isFav = key => favs().some(f => f.key === key);
  function toggleFav(item, key) {
    const list = favs();
    const i = list.findIndex(f => f.key === key);
    if (i >= 0) list.splice(i, 1);
    else {
      const e = { key, kind: item.kind, name: item.name };
      if (item.kind === 'kit') e.sample = item.sample;
      else if (item.kind === 'plugin') Object.assign(e, { format: item.info.format, path: item.info.path, cid: item.info.cid });
      else e.path = item.path;
      list.push(e);
    }
    writeList('loom.favs', list);
    render();
  }
  // a stored favorite back into a browser item (null: a plugin the scan did not find)
  function favItem(f) {
    if (f.kind === 'kit') return { kind: 'kit', name: f.name, sample: f.sample };
    if (f.kind === 'plugin') {
      const info = Plugins.found.find(p => p.format === f.format && p.path === f.path && p.cid === f.cid);
      return info ? { kind: 'plugin', name: info.name, info } : null;
    }
    return { kind: f.kind, name: f.name, path: f.path };
  }

  function init() {
    el = $('#browser');
    search = h('input', { placeholder: t('br.search'), spellcheck: 'false' });
    search.addEventListener('input', render);
    search.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') { search.value = ''; render(); } });
    tree = h('div', { class: 'br-tree' });
    foot = h('div', { class: 'br-foot' });
    const split = h('div', { class: 'br-split' });
    addBtn = h('button', { class: 'tool icon', onclick: () => tab === 'packs' ? addPack() : addFolder() }, '+');
    tabBtns = TABS.map(k => h('button', { 'data-hint': 'hint.brtab.' + k, onclick: () => setTab(k) }, t('br.tab.' + k)));
    el.append(
      h('div', { class: 'br-head' }, h('span', { class: 'gl-section' }, t('w.browser')), addBtn),
      h('div', { class: 'seg br-tabs' }, ...tabBtns),
      h('div', { class: 'br-search' }, h('span', null, '/'), search),
      tree, foot, split);
    syncTabs();
    split.addEventListener('pointerdown', e => {
      const w0 = el.offsetWidth, x0 = e.clientX;
      drag(e, ev => setWidth(w0 + ev.clientX - x0), () => { try { localStorage.setItem('loom.brW', el.offsetWidth); } catch (_) { } });
    });
    setWidth(+(localStorage.getItem('loom.brW') || 260));
    if (localStorage.getItem('loom.brHidden') === '1') document.body.classList.add('no-browser');
    $('#v-browser').onclick = toggle;
    syncBtn();
    bus.on('plugins', render);
    render();
  }

  function setWidth(w) {
    document.documentElement.style.setProperty('--browser', clamp(w, 180, 520) + 'px');
    WM.reflow();
  }
  function toggle() {
    document.body.classList.toggle('no-browser');
    try { localStorage.setItem('loom.brHidden', document.body.classList.contains('no-browser') ? '1' : '0'); } catch (_) { }
    syncBtn();
    WM.reflow();
  }
  function syncBtn() { $('#v-browser').classList.toggle('on', !document.body.classList.contains('no-browser')); }

  function setTab(k) {
    tab = k;
    try { localStorage.setItem('loom.brTab', k); } catch (_) { }
    syncTabs();
    render();
  }
  function syncTabs() {
    TABS.forEach((k, i) => tabBtns[i].classList.toggle('on', k === tab));
    // + adds a folder to ALL, a pack to PACKS; there is nothing to add to the favorites
    addBtn.style.visibility = tab === 'fav' ? 'hidden' : '';
    addBtn.setAttribute('data-hint', tab === 'packs' ? 'hint.addpack' : 'hint.addfolder');
  }

  async function addFolder() {
    const f = await api.call('pick_folder');
    if (!f) return;
    const list = userFolders();
    if (!list.includes(f)) { list.push(f); saveFolders(list); }
    open.add('dir:' + f); saveOpen();
    load(f);
  }
  function removeFolder(f) {
    saveFolders(userFolders().filter(x => x !== f));
    render();
  }
  function addPackPath(f) {
    const list = packs();
    if (!list.includes(f)) { list.push(f); savePacks(list); }
    open.add('dir:' + f); saveOpen();
    toast(t('br.packadded', { n: folderName(f) }));
    if (tab === 'packs') { if (!kids.has(f)) load(f); render(); }
  }
  async function addPack() {
    const f = await api.call('pick_folder');
    if (f) addPackPath(f);
  }
  function removePack(f) {
    savePacks(packs().filter(x => x !== f));
    render();
  }
  const folderName = f => f.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || f;

  async function load(path) {
    kids.set(path, 'loading');
    render();
    try { kids.set(path, (await api.call('list_dir', { path })) || []); }
    catch (e) { kids.set(path, { error: String(e) }); }
    render();
  }

  // ---------- actions ----------
  // a click plays the sound; a click on the same sound while it still plays stops it
  let playing = null; // {key, until}
  async function previewItem(it, key) {
    if (it.kind !== 'audio' && it.kind !== 'kit') return;
    if (playing && playing.key === key && performance.now() < playing.until) {
      playing = null;
      api.call('preview', {});
      return;
    }
    playing = { key, until: Infinity };
    try {
      const secs = await api.call('preview', it.kind === 'audio' ? { path: it.path } : { sample: 'kit:' + it.sample });
      if (playing && playing.key === key) playing.until = performance.now() + (secs || 0) * 1000;
    } catch (e) { playing = null; toast(t('toast.err', { e }), 'err'); }
  }
  // double-click / drop on the rack: a new channel
  function add(it) {
    if (it.kind === 'plugin') {
      if (it.info.instrument) { Plugins.addInstrument(it.info); Rack.win.show(); }
      else { Plugins.addEffect(it.info, Mixer.selected()); Mixer.win.show(); }
      return;
    }
    if (it.kind === 'project') { fileOpen(it.path); return; }
    if (it.kind === 'midi') { Midi.import(it.path, 'new'); return; }
    history.edit(() => {
      const id = nextId(S.project.channels);
      const c = it.kind === 'kit' ? newSampler(id, it.sample, it.name) : newSampler(id, 'kick', it.name.replace(/\.[^.]+$/, ''));
      if (it.kind === 'audio') Object.assign(c.inst, { sample: it.name, path: it.path, root: 60, oneshot: true, choke: false });
      S.project.channels.push(c);
      S.curCh = id;
    });
    Rack.win.show();
  }

  // ---------- tree ----------
  function row(key, d, glyph, name, extra, cls, item) {
    const r = h('div', { class: 'br-row ' + (cls || '') + (key === selKey ? ' sel' : ''), style: '--d:' + d, 'data-key': key },
      h('span', { class: 'bg' }, glyph), h('span', { class: 'bn', title: name }, name), h('span', { class: 'bx' }, extra || ''), h('span', { class: 'bs' }));
    r._item = item;
    rows.push(r);
    return r;
  }
  function section(key, label, count) {
    const isOpen = open.has(key);
    const r = row(key, 0, isOpen ? '−' : '+', label, count != null ? String(count) : '', 'root');
    r.addEventListener('click', () => { if (open.has(key)) open.delete(key); else open.add(key); saveOpen(); render(); });
    return [r, isOpen];
  }
  const match = (q, s) => !q || s.toLowerCase().includes(q);

  function itemRow(key, d, glyph, name, extra, cls, item) {
    const r = row(key, d, glyph, name, extra, cls, item);
    // the star: ☆ shows on hover, ★ stays while the item is a favorite
    const fav = isFav(key), star = r.querySelector('.bs');
    star.textContent = fav ? '★' : '☆';
    star.classList.toggle('on', fav);
    star.title = t(fav ? 'br.unfav' : 'br.fav');
    star.addEventListener('pointerdown', e => e.stopPropagation());
    star.addEventListener('click', e => { e.stopPropagation(); toggleFav(item, key); });
    star.addEventListener('dblclick', e => e.stopPropagation());
    r.addEventListener('click', () => { selKey = key; $$('.br-row.sel', tree).forEach(x => x.classList.remove('sel')); r.classList.add('sel'); previewItem(item, key); });
    r.addEventListener('dblclick', () => add(item));
    r.addEventListener('pointerdown', e => { if (e.button === 0 && item.kind !== 'project') Dnd.start(e, item); });
    r.addEventListener('pointerenter', () => hint('<b>' + name + '</b>  · ' + t(item.kind === 'plugin' ? (item.info.instrument ? 'hint.br.inst' : 'hint.br.fx') : item.kind === 'project' ? 'hint.br.project' : item.kind === 'midi' ? 'hint.br.midi' : 'hint.br.audio')));
    return r;
  }

  function folderRows(path, d, q, out) {
    const k = kids.get(path);
    if (k === 'loading') { out.push(h('div', { class: 'br-note', style: '--d:' + d }, '…')); return; }
    if (!k) { load(path); return; }
    if (k.error) { out.push(h('div', { class: 'br-note', style: '--d:' + d }, k.error)); return; }
    if (!k.length) { out.push(h('div', { class: 'br-note', style: '--d:' + d }, t('br.empty'))); return; }
    for (const e of k) {
      if (e.dir) {
        const key = 'dir:' + e.path, isOpen = open.has(key);
        const r = row(key, d, isOpen ? '−' : '+', e.name, '', 'dir');
        r.addEventListener('click', () => { if (open.has(key)) open.delete(key); else { open.add(key); if (!kids.has(e.path)) load(e.path); } saveOpen(); render(); });
        r.addEventListener('contextmenu', ev => {
          ev.preventDefault();
          menu(ev.clientX, ev.clientY, [{ label: t('br.topacks'), fn: () => addPackPath(e.path) }]);
        });
        out.push(r);
        if (isOpen) folderRows(e.path, d + 1, q, out);
      } else if (match(q, e.name)) {
        const kind = e.kind === 'project' || e.kind === 'midi' ? e.kind : 'audio';
        const item = { kind, name: e.name, path: e.path };
        out.push(itemRow('f:' + e.path, d, kind === 'project' ? '■' : kind === 'midi' ? '♪' : '~', e.name, kind === 'midi' ? 'mid' : '', kind === 'audio' ? 'audio' : '', item));
      }
    }
  }

  // a folder as a root of the tree; `onRemove` is what the right-click menu's last entry does
  function folderRoot(f, q, out, remove) {
    const key = 'dir:' + f, isOpen = open.has(key) || !!q;
    const r = row(key, 0, isOpen ? '−' : '+', folderName(f), '', 'root');
    r.title = f;
    r.addEventListener('click', () => { if (open.has(key)) open.delete(key); else { open.add(key); if (!kids.has(f)) load(f); } saveOpen(); render(); });
    r.addEventListener('contextmenu', e => {
      e.preventDefault();
      menu(e.clientX, e.clientY, [
        { label: t('br.refresh'), fn: () => { [...kids.keys()].filter(k => k.startsWith(f)).forEach(k => kids.delete(k)); load(f); } },
        { label: t('br.remove'), danger: true, fn: remove },
      ]);
    });
    out.push(r);
    if (isOpen) folderRows(f, 1, q, out);
  }

  // PACKS: the folders picked one by one
  function renderPacks(q, out) {
    const list = packs();
    for (const f of list) folderRoot(f, q, out, () => removePack(f));
    if (!list.length) out.push(h('div', { class: 'br-note' }, t('br.nopacks')));
  }

  // FAVORITES: what is starred, by kind
  function renderFavs(q, out) {
    const groups = [['snd', t('br.favsnd'), []], ['inst', t('br.inst'), []], ['fx', t('br.fx'), []], ['files', t('br.favfiles'), []]];
    let n = 0;
    for (const f of favs()) {
      const item = favItem(f);
      if (!item || !match(q, item.name)) continue;
      const g = item.kind === 'plugin' ? (item.info.instrument ? 1 : 2) : item.kind === 'kit' || item.kind === 'audio' ? 0 : 3;
      groups[g][2].push([f, item]);
      n++;
    }
    for (const [, label, list] of groups) {
      if (!list.length) continue;
      out.push(row('favg:' + label, 0, '', label, String(list.length), 'root'));
      for (const [f, item] of list) {
        const k = item.kind;
        out.push(itemRow(f.key, 1, k === 'plugin' ? '*' : k === 'midi' ? '♪' : k === 'project' ? '■' : k === 'kit' ? '·' : '~',
          item.name, k === 'plugin' ? (item.info.format === 'vst3' ? 'vst3' : 'vst') : k === 'midi' ? 'mid' : '', k === 'plugin' ? 'plug' : k === 'audio' || k === 'kit' ? 'audio' : '', item));
      }
    }
    if (!n) out.push(h('div', { class: 'br-note' }, t(q ? 'br.empty' : 'br.nofavs')));
  }

  function render() {
    if (!tree) return;
    const st = tree.scrollTop;
    const q = search.value.trim().toLowerCase();
    rows = [];
    const out = [];
    if (tab === 'fav') renderFavs(q, out);
    else if (tab === 'packs') renderPacks(q, out);
    else renderAll(q, out);
    tree.replaceChildren(...out);
    tree.scrollTop = st;
    renderFoot();
  }

  // ALL: the kit, the plugins, the user's folders
  function renderAll(q, out) {
    // built-in kit
    const kit = KIT_NAMES.filter(([, n]) => match(q, n));
    const [kr, kOpen] = section('kit', t('br.kit'), kit.length);
    out.push(kr);
    if (kOpen || q) kit.forEach(([k, n]) => out.push(itemRow('kit:' + k, 1, '·', n, '', 'audio', { kind: 'kit', name: n, sample: k })));
    // plugins
    for (const [key, label, list] of [['inst', t('br.inst'), Plugins.instruments()], ['fx', t('br.fx'), Plugins.effects()]]) {
      const l = list.filter(p => match(q, p.name) || match(q, p.vendor));
      const [r, isOpen] = section(key, label, Plugins.scanning && !list.length ? '…' : l.length);
      out.push(r);
      if (isOpen || q) {
        l.forEach(p => out.push(itemRow('p:' + p.format + p.path + p.cid, 1, '*', p.name, p.format === 'vst3' ? 'vst3' : 'vst', 'plug', { kind: 'plugin', name: p.name, info: p })));
        if (!l.length && !q) out.push(h('div', { class: 'br-note', style: '--d:1' }, Plugins.scanning ? t('pl.scanning') : t('pl.none')));
      }
    }
    // the user's folders
    for (const f of userFolders()) folderRoot(f, q, out, () => removeFolder(f));
    if (!userFolders().length) out.push(h('div', { class: 'br-note' }, t('br.nofolders')));
  }

  function renderFoot() {
    foot.innerHTML = '';
    const n = Plugins.found.length;
    const txt = Plugins.scanning ? t('pl.scanning') : t('pl.count', { n }) + (Plugins.failed.length ? ' · ' + t('pl.failed', { n: Plugins.failed.length }) : '');
    const info = h('span', { class: 'grow' }, txt);
    if (Plugins.failed.length) info.title = Plugins.failed.map(f => f[0] + ': ' + f[1]).join('\n');
    foot.append(info,
      h('button', { class: 'tool', 'data-hint': 'hint.plfolders', onclick: e => folderMenu(e.currentTarget) }, t('pl.folders')),
      h('button', { class: 'tool icon', 'data-hint': 'hint.rescan', onclick: () => Plugins.scan(true) }, '↻'));
  }
  async function folderMenu(btn) {
    const r = btn.getBoundingClientRect();
    const list = await Plugins.folders();
    menu(r.left, r.top, [
      { head: t('pl.folders') },
      ...list.map(f => ({ label: f, key: 'x', fn: () => Plugins.removeFolder(f) })),
      '-',
      { label: t('pl.addfolder'), fn: () => Plugins.addFolder() },
    ]);
    if (openMenu) { const mr = openMenu.getBoundingClientRect(); openMenu.style.top = Math.max(4, r.top - mr.height - 4) + 'px'; }
  }

  return { init, render, add, toggle };
})();
