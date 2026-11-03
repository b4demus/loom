// Floating windows, knobs, popup menus, inline rename.

// ---------- windows ----------
const WM = {
  wins: {}, z: 10, layout: {},
  load() { try { this.layout = JSON.parse(localStorage.getItem('loom.layout') || '{}'); } catch (_) { this.layout = {}; } },
  save() {
    const out = {};
    for (const id in this.wins) {
      const w = this.wins[id];
      out[id] = w.auto ? { open: w.open, max: w.max, min: w.min } : { x: w.x, y: w.y, w: w.w, h: w.h, open: w.open, max: w.max, min: w.min };
    }
    try { localStorage.setItem('loom.layout', JSON.stringify(out)); } catch (_) { }
  },
  create(id, o) {
    const sub = h('span', { class: 'win-sub' });
    const tools = h('div', { class: 'win-tools' });
    // window buttons as in Windows: collapse to the title bar, fill the desk, close
    const bMin = h('button', { class: 'win-x win-min', 'data-hint': 'hint.wmin', onclick: () => win.collapse() }, '_');
    const bMax = h('button', { class: 'win-x win-max', 'data-hint': 'hint.wmax', onclick: () => win.maximize() }, '□');
    const head = h('div', { class: 'win-head' },
      h('div', { class: 'win-title' }, h('span', { class: 'tg' }, o.glyph || '>'), h('span', { 'data-i18n': o.title }, t(o.title))),
      sub, tools,
      h('div', { class: 'win-btns' }, bMin, bMax, h('button', { class: 'win-x win-close', 'data-hint': 'hint.wclose', onclick: () => win.hide() }, 'x')));
    const body = h('div', { class: 'win-body' });
    const grip = h('div', { class: 'win-grip' });
    const el = h('section', { class: 'win hidden', 'data-win': id }, head, body, grip);
    $('#desk').append(el);
    const saved = this.layout[id] || {};
    const d = o.place();
    const win = {
      id, el, head, body, tools, sub, open: false, max: !!saved.max, min: !!saved.min,
      // the default place follows the desk size until the user moves or resizes the window
      auto: saved.x == null, place: o.place,
      x: saved.x ?? d.x, y: saved.y ?? d.y, w: saved.w ?? d.w, h: saved.h ?? d.h,
      minW: o.minW || 320, minH: o.minH || 180,
      apply() {
        const desk = $('#desk');
        const W = desk.clientWidth, H = desk.clientHeight;
        el.classList.toggle('collapsed', this.min);
        el.classList.toggle('maxed', this.max);
        bMax.textContent = this.max ? '▫' : '□';
        if (this.min) {
          // only the title bar, where the window stands
          this.x = clamp(this.x, 0, Math.max(0, W - Math.min(this.w, W)));
          this.y = clamp(this.y, 0, Math.max(0, H - 36));
          Object.assign(el.style, { left: this.x + 'px', top: this.y + 'px', width: Math.min(this.w, W) + 'px', height: '36px' });
        } else if (this.max) { Object.assign(el.style, { left: '0px', top: '0px', width: W + 'px', height: H + 'px' }); }
        else {
          // the whole window stays on the desk: shrink first, then move in
          this.w = clamp(this.w, this.minW, Math.max(this.minW, W));
          this.h = clamp(this.h, this.minH, Math.max(this.minH, H));
          this.x = clamp(this.x, 0, Math.max(0, W - this.w));
          this.y = clamp(this.y, 0, Math.max(0, H - this.h));
          Object.assign(el.style, { left: this.x + 'px', top: this.y + 'px', width: this.w + 'px', height: this.h + 'px' });
        }
        o.onResize && o.onResize();
      },
      // o.fit(): the height the window's content needs; the window takes just that (no empty
      // space under it), within the desk. Called when what it shows changes.
      fit() {
        if (!o.fit || this.max || this.min || !this.open) return;
        const want = o.fit();
        if (!want) return;
        const h = Math.ceil(want + el.offsetHeight - body.offsetHeight);
        if (Math.abs(h - this.h) < 1) return;
        this.h = h;
        this.apply();
      },
      show() { this.open = true; el.classList.remove('hidden'); this.apply(); this.focus(); WM.sync(); o.onShow && o.onShow(); requestAnimationFrame(() => this.fit()); },
      hide() { this.open = false; el.classList.add('hidden'); WM.sync(); },
      toggle() { if (this.open && el.classList.contains('active') && !this.min) this.hide(); else { this.min = false; this.show(); } },
      collapse() { this.min = !this.min; if (this.min) this.max = false; this.apply(); this.focus(); WM.save(); },
      maximize() { this.max = !this.max; this.min = false; this.apply(); this.focus(); WM.save(); },
      focus() {
        el.style.zIndex = ++WM.z;
        $$('.win.active').forEach(x => x !== el && x.classList.remove('active'));
        el.classList.add('active');
      },
    };
    el.addEventListener('pointerdown', () => win.focus(), true);
    head.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('button, input, .seg, .knob, .tool')) return;
      if (win.max) return;
      const sx = e.clientX, sy = e.clientY, ox = win.x, oy = win.y;
      win.auto = false;
      drag(e, ev => { win.x = ox + ev.clientX - sx; win.y = oy + ev.clientY - sy; win.apply(); }, () => WM.save());
    });
    head.addEventListener('dblclick', e => {
      if (e.target.closest('button, input, .seg, .knob, .tool')) return;
      // a collapsed window opens back up; an open one fills the desk or comes back
      if (win.min) win.collapse(); else win.maximize();
    });
    grip.addEventListener('pointerdown', e => {
      e.stopPropagation();
      if (win.max) { win.max = false; }
      win.min = false;
      win.auto = false;
      const sx = e.clientX, sy = e.clientY, ow = win.w, oh = win.h;
      drag(e, ev => { win.w = ow + ev.clientX - sx; win.h = oh + ev.clientY - sy; win.apply(); }, () => WM.save());
    });
    this.wins[id] = win;
    if (saved.open ?? o.open) win.show();
    return win;
  },
  sync() {
    $$('[data-view]').forEach(b => { const w = this.wins[b.dataset.view]; b.classList.toggle('on', !!(w && w.open)); });
    this.save();
  },
  reflow() {
    for (const id in this.wins) {
      const w = this.wins[id];
      if (w.auto) Object.assign(w, w.place());
      if (w.open) { w.apply(); w.fit(); }
    }
  },
};

// ---------- knobs ----------
// o: {label, min, max, def, get(), set(v), fmt(v), size, bipolar, int, free}
// free: not part of the project (no undo step, no unsaved mark), like the app's volume.
// Double-click or a middle-click puts it back to `def`.
function knob(o) {
  const begin = () => { if (!o.free) history.begin(); }, end = () => { if (!o.free) history.end(); };
  const edit = fn => { if (o.free) fn(); else history.edit(fn); };
  const size = o.size || 26, r = size / 2 - 2, cx = size / 2, cy = size / 2;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', size); svg.setAttribute('height', size);
  const ring = document.createElementNS(NS, 'circle');
  ring.setAttribute('class', 'ring'); ring.setAttribute('cx', cx); ring.setAttribute('cy', cy); ring.setAttribute('r', r);
  const arc = document.createElementNS(NS, 'path'); arc.setAttribute('class', 'arc');
  const tick = document.createElementNS(NS, 'line'); tick.setAttribute('class', 'tick');
  svg.append(ring, arc, tick);
  const el = h('div', { class: 'knob', 'data-hint': 'hint.knob' }, svg);
  const kl = o.label ? h('span', { class: 'kl' }, o.label) : null;
  const kv = o.showValue ? h('span', { class: 'kv' }) : null;
  if (kl) el.append(kl);
  if (kv) el.append(kv);
  const bip = o.bipolar ?? (o.min < 0 && o.max > 0);
  const A0 = -135, A1 = 135;
  const toA = v => A0 + (A1 - A0) * (v - o.min) / (o.max - o.min);
  const pt = (a, rr) => { const rad = (a - 90) * Math.PI / 180; return [cx + rr * Math.cos(rad), cy + rr * Math.sin(rad)]; };
  const fmt = v => o.fmt ? o.fmt(v) : (o.int ? Math.round(v) : v.toFixed(2));
  function update() {
    const v = o.get();
    const a = toA(clamp(v, o.min, o.max));
    const from = bip ? 0 : A0;
    const [a0, a1] = a < from ? [a, from] : [from, a];
    const [x0, y0] = pt(a0, r + 2), [x1, y1] = pt(a1, r + 2);
    arc.setAttribute('d', Math.abs(a1 - a0) < 0.5 ? '' : `M${x0} ${y0} A${r + 2} ${r + 2} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`);
    const [tx0, ty0] = pt(a, r * 0.25), [tx1, ty1] = pt(a, r - 1);
    tick.setAttribute('x1', tx0); tick.setAttribute('y1', ty0); tick.setAttribute('x2', tx1); tick.setAttribute('y2', ty1);
    if (kv) kv.textContent = fmt(v);
  }
  function setV(v) {
    v = clamp(v, o.min, o.max);
    if (o.int) v = Math.round(v);
    o.set(v);
    update();
    hintValue(o.label || o.name || '', fmt(v));
  }
  const reset = () => edit(() => setV(o.def ?? o.min));
  el.addEventListener('pointerdown', e => {
    if (e.button === 1) { e.preventDefault(); e.stopPropagation(); reset(); return; }
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    begin();
    hintLock = true;
    let sy = e.clientY, v = o.get();
    hintValue(o.label || o.name || '', fmt(v));
    drag(e, ev => {
      const range = o.max - o.min;
      v += (sy - ev.clientY) / (ev.shiftKey ? 800 : 160) * range;
      sy = ev.clientY;
      setV(v);
    }, () => { hintLock = false; end(); });
  });
  // no autoscroll on the middle button
  el.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
  el.addEventListener('dblclick', e => { e.stopPropagation(); reset(); });
  el.addEventListener('wheel', e => {
    e.preventDefault(); e.stopPropagation();
    const st = o.int ? 1 : (o.max - o.min) / (e.shiftKey ? 200 : 40);
    edit(() => setV(o.get() + (e.deltaY < 0 ? st : -st)));
  }, { passive: false });
  el.addEventListener('pointerenter', () => hint('<b>' + (o.label || o.name || '') + '</b> ' + fmt(o.get()) + '  · ' + t('hint.knob')));
  el.update = update;
  update();
  return el;
}

// ---------- popup menu ----------
let openMenu = null;
// a popup may set `_onclose` (a tool dialog finishing its edit however it is closed)
function closeMenu() { if (openMenu) { const m = openMenu; openMenu = null; m.remove(); if (m._onclose) m._onclose(); } }
function menu(x, y, items) {
  closeMenu();
  const m = h('div', { class: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { m.append(h('hr')); continue; }
    if (it.head) { m.append(h('div', { class: 'mh' }, it.head)); continue; }
    m.append(h('button', {
      class: (it.on ? 'on ' : '') + (it.danger ? 'danger' : ''),
      disabled: !!it.disabled,
      onclick: () => { closeMenu(); it.fn && it.fn(); },
    }, h('span', { class: 'mg' }), h('span', null, it.label), h('span', { class: 'mk' }, it.key || '')));
  }
  document.body.append(m);
  const W = innerWidth, H = innerHeight, r = m.getBoundingClientRect();
  m.style.left = Math.min(x, W - r.width - 4) + 'px';
  m.style.top = Math.min(y, H - r.height - 4) + 'px';
  openMenu = m;
}
document.addEventListener('pointerdown', e => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }, true);

// ---------- searchable list (long lists: plugins) ----------
// items: [{label, sub, tag}]; type to filter by label or sub, ↑↓ to move, Enter to pick, Esc to close
function pickList(x, y, o) {
  closeMenu();
  const input = h('input', { class: 'pk-input', placeholder: o.placeholder || '', spellcheck: 'false' });
  const list = h('div', { class: 'pk-list' });
  const count = h('span', { class: 'pk-count' });
  const m = h('div', { class: 'menu picker-pop' },
    o.title ? h('div', { class: 'mh' }, o.title) : null,
    h('div', { class: 'pk-search' }, h('span', null, '/'), input, count), list);
  let shown = [], at = 0;
  function render() {
    const q = input.value.trim().toLowerCase();
    // every word must match, in any order: "fab q" finds "FabFilter Pro-Q 4"
    const words = q.split(/\s+/).filter(Boolean);
    shown = o.items.filter(it => { const s = (it.label + ' ' + (it.sub || '')).toLowerCase(); return words.every(w => s.includes(w)); });
    at = clamp(at, 0, Math.max(0, shown.length - 1));
    count.textContent = shown.length + '/' + o.items.length;
    list.replaceChildren(...shown.slice(0, 300).map((it, i) => {
      const b = h('button', { class: i === at ? 'on' : '' },
        h('span', { class: 'mg' }), h('span', { class: 'pk-l' }, it.label, it.sub ? h('span', { class: 'pk-sub' }, '  ' + it.sub) : null), h('span', { class: 'mk' }, it.tag || ''));
      b.addEventListener('click', () => pick(it));
      b.addEventListener('pointermove', () => { if (at !== i) { at = i; mark(); } });
      return b;
    }));
    if (!shown.length) list.append(h('div', { class: 'pk-none' }, o.empty || '—'));
  }
  function mark() {
    $$('button', list).forEach((b, i) => b.classList.toggle('on', i === at));
    const b = list.children[at];
    if (b && b.scrollIntoView) b.scrollIntoView({ block: 'nearest' });
  }
  function pick(it) { closeMenu(); o.onPick(it); }
  input.addEventListener('input', () => { at = 0; render(); });
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') { at = Math.min(at + 1, shown.length - 1); mark(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { at = Math.max(at - 1, 0); mark(); e.preventDefault(); }
    else if (e.key === 'Enter') { if (shown[at]) pick(shown[at]); }
    else if (e.key === 'Escape') closeMenu();
  });
  render();
  document.body.append(m);
  const W = innerWidth, H = innerHeight, r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, W - r.width - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(y, H - r.height - 4)) + 'px';
  openMenu = m;
  input.focus();
}

// ---------- inline rename ----------
function renameAt(rect, value, done) {
  const inp = h('input', { class: 'rename', value: value || '' });
  Object.assign(inp.style, { left: rect.left + 'px', top: rect.top + 'px', width: Math.max(120, rect.width) + 'px' });
  document.body.append(inp);
  inp.focus(); inp.select();
  let fin = false;
  const finish = ok => {
    if (fin) return; fin = true;
    const v = inp.value.trim();
    inp.remove();
    if (ok && v !== value) done(v);
  };
  inp.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  inp.addEventListener('blur', () => finish(true));
}

// ---------- ASCII level bar ----------
function asciiMeter(el, v, n) {
  const db = v > 0 ? 20 * Math.log10(v) : -96;
  const fill = clamp(Math.round((db + 48) / 48 * n), 0, n);
  const clip = v >= 0.999;
  el.innerHTML = '<span class="' + (clip ? 'c' : 'f') + '">' + '■'.repeat(fill) + '</span><span class="r">' + '·'.repeat(n - fill) + '</span>';
}
