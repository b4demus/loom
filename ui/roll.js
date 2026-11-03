// Piano roll: the notes of one channel in the current pattern. Keyboard on the left, ruler on
// top (with the pattern loop), velocity or pan lane at the bottom. One canvas for the picture,
// an overlay for the playhead. Tools as in FL: randomizer (Alt+R), strumizer (Alt+S), chopper
// (Alt+U), quick quantize (Alt+Q), quick legato (Ctrl+L), the cut tool, slide notes, note colours
// and scale highlighting.

const SNAPS = [['bar', BAR], ['beat', BEAT], ['half', BEAT / 2], ['step', STEP], ['halfstep', STEP / 2], ['none', 1]];
// scale degrees from the root, for highlighting rows and keys
const SCALES = { none: null, minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11] };
const NOTE_COLORS = PAT_COLORS;

const Roll = (() => {
  const KW = 60, RH = 22, VH = 70;
  let win, wrap, cv, ov, chBtn, snapBtn, ghostBtn, scaleBtn, colorBtn, slideBtn, cutBtn, loopBtn, toolBtn, followBtn;
  let W = 0, H = 0;
  let ppt = 22 / STEP;   // pixels per tick
  let rowH = 14;
  let sx = 0, sy = 0;     // scroll in px
  let snap = STEP, lastLen = STEP, ghosts = true;
  let sel = new Set();
  let band = null;        // rubber band {x0,y0,x1,y1}
  let held = -1;          // key held on the keyboard
  let pressed = new Set(); // keys held on the computer keyboard
  let scrolledFor = null; // channel the view was last centred for
  let lane = 'vel';       // what the bottom lane shows and edits: 'vel' | 'pan'
  let color = 0;          // colour of new notes (NOTE_COLORS index)
  let slideMode = false;  // new notes are slide notes
  let tool = null;        // 'cut' or null
  let cutLine = null;     // the cut tool's line while dragging
  let panning = false;
  let lastGhost = null;   // a right-click on another channel's note: {ch, at}
  let followOn = true, away = false, wasPlaying = false;

  function place() {
    const D = $('#desk'), W0 = D.clientWidth, H0 = D.clientHeight;
    return { x: Math.round(W0 * 0.46) + 24, y: Math.round(H0 * 0.5) + 6, w: W0 - Math.round(W0 * 0.46) - 36, h: Math.round(H0 * 0.5) - 18 };
  }

  function init() {
    win = WM.create('roll', { title: 'w.roll', glyph: '=', place, minW: 480, minH: 240, open: true, onResize: resize, onShow: () => { center(); draw(); } });
    chBtn = h('button', { class: 'tool', onclick: e => chMenu(e.currentTarget) });
    snapBtn = h('button', { class: 'tool', onclick: e => snapMenu(e.currentTarget) });
    ghostBtn = h('button', { class: 'tool', 'data-hint': 'hint.roll.ghost', onclick: () => { ghosts = !ghosts; tools(); draw(); } });
    scaleBtn = h('button', { class: 'tool', 'data-hint': 'hint.roll.scale', onclick: e => scaleMenu(e.currentTarget) });
    colorBtn = h('button', { class: 'tool', 'data-hint': 'hint.roll.color', onclick: e => colorMenu(e.currentTarget) });
    slideBtn = h('button', { class: 'tool', 'data-hint': 'hint.roll.slide', onclick: () => { slideMode = !slideMode; tools(); } });
    cutBtn = h('button', { class: 'tool', 'data-hint': 'hint.roll.cut', onclick: () => { tool = tool === 'cut' ? null : 'cut'; tools(); } });
    loopBtn = h('button', { class: 'tool', 'data-hint': 'hint.roll.loop', onclick: toggleLoop });
    toolBtn = h('button', { class: 'tool', 'data-hint': 'hint.roll.tools', onclick: e => toolMenu(e.currentTarget) });
    followBtn = h('button', { class: 'tool', 'data-hint': 'hint.roll.follow', onclick: () => { followOn = !followOn; away = false; tools(); } });
    win.tools.append(chBtn, snapBtn, scaleBtn, colorBtn, slideBtn, cutBtn, loopBtn, followBtn, ghostBtn, toolBtn);
    wrap = h('div', { class: 'cv-wrap' });
    cv = h('canvas'); ov = h('canvas', { class: 'overlay' });
    wrap.append(cv, ov);
    win.body.append(wrap);
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointermove', hover);
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('wheel', wheel, { passive: false });
    cv.addEventListener('dblclick', e => e.preventDefault());
    cv.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
    new ResizeObserver(resize).observe(wrap);
    bus.on('render', () => { tools(); draw(); });
    bus.on('restore', () => { sel.clear(); band = null; cutLine = null; lastGhost = null; });
    snap = +(localStorage.getItem('loom.rollSnap') || STEP) || STEP;
    lane = localStorage.getItem('loom.rollLane') === 'pan' ? 'pan' : 'vel';
    tools();
  }

  const scale = () => S.project.scale || { mode: 'none', root: 0 };
  const degrees = () => SCALES[scale().mode] || null;
  const inScale = k => { const d = degrees(); return !d || d.includes(((k - scale().root) % 12 + 12) % 12); };
  const isRoot = k => !!degrees() && ((k - scale().root) % 12 + 12) % 12 === 0;

  function tools() {
    if (!win) return;
    const c = curChan();
    chBtn.innerHTML = '';
    chBtn.append(h('span', { class: 'g' }, '>'), h('b', null, c ? c.name : '—'));
    const sn = SNAPS.find(s => s[1] === snap) || SNAPS[3];
    snapBtn.innerHTML = '';
    snapBtn.append(h('span', null, t('snap')), h('b', null, t('snap.' + sn[0])));
    const sc = scale();
    scaleBtn.innerHTML = '';
    scaleBtn.append(h('span', null, t('roll.scale')), h('b', null, sc.mode === 'none' ? t('scale.none') : NOTE_NAMES[sc.root] + ' ' + t('scale.' + sc.mode)));
    colorBtn.innerHTML = '';
    colorBtn.append(h('span', { class: 'swatch', style: 'background:' + NOTE_COLORS[color] }), h('span', null, t('roll.color')));
    slideBtn.textContent = '⤳ ' + t('roll.slide'); slideBtn.classList.toggle('on', slideMode);
    cutBtn.textContent = '✂ ' + t('pl.cut'); cutBtn.classList.toggle('on', tool === 'cut');
    loopBtn.textContent = '↻ ' + t('pl.loop'); loopBtn.classList.toggle('on', !!S.project.pat_loop?.enabled);
    followBtn.textContent = '→ ' + t('pl.follow'); followBtn.classList.toggle('on', followOn && !away);
    ghostBtn.innerHTML = '';
    ghostBtn.append(h('span', { class: 'g' }, ghosts ? '*' : '·'), h('span', null, t('roll.ghost')));
    toolBtn.textContent = '⚙ ' + t('roll.tools');
    const p = curPat();
    win.sub.textContent = p ? '— ' + p.name : '';
  }
  function chMenu(el) {
    const r = el.getBoundingClientRect();
    menu(r.left, r.bottom + 4, S.project.channels.map(c => ({ label: c.name, on: c.id === S.curCh, fn: () => { S.curCh = c.id; sel.clear(); redraw(); } })));
  }
  function snapMenu(el) {
    const r = el.getBoundingClientRect();
    menu(r.left, r.bottom + 4, SNAPS.map(([k, v]) => ({ label: t('snap.' + k), on: v === snap, fn: () => { snap = v; localStorage.setItem('loom.rollSnap', v); tools(); draw(); } })));
  }
  // scale highlighting: none / natural minor / major, and its root (that key lights up)
  function scaleMenu(el) {
    const r = el.getBoundingClientRect(), sc = scale();
    const set = o => history.edit(() => { S.project.scale = { ...scale(), ...o }; });
    menu(r.left, r.bottom + 4, [
      { head: t('roll.scale') },
      ...['none', 'minor', 'major'].map(m => ({ label: t('scale.' + m), on: sc.mode === m, fn: () => set({ mode: m }) })),
      { head: t('scale.root') },
      ...NOTE_NAMES.map((n, i) => ({ label: n, on: sc.root === i, fn: () => set({ root: i, mode: sc.mode === 'none' ? 'minor' : sc.mode }) })),
    ]);
  }
  // the colour of new notes; with notes selected they take it too
  function colorMenu(el) {
    const r = el.getBoundingClientRect();
    menu(r.left, r.bottom + 4, [
      { head: t('roll.color') + (sel.size ? ' · ' + t('roll.selected', { n: sel.size }) : '') },
      ...NOTE_COLORS.map((c, i) => ({ label: '■■■■', on: color === i, fn: () => {
        color = i;
        if (sel.size) history.edit(() => { for (const n of sel) n.c = i; });
        tools(); draw();
      } })),
    ]);
    if (openMenu) $$('button', openMenu).forEach((b, i) => { if (b.children[1]) b.children[1].style.color = NOTE_COLORS[i]; });
  }
  function toolMenu(el) {
    const r = el.getBoundingClientRect(), x = r.left, y = r.bottom + 4;
    menu(x, y, [
      { label: t('tool.random'), key: 'Alt+R', fn: () => randomizer(x, y) },
      { label: t('tool.strum'), key: 'Alt+S', fn: () => strumizer(x, y) },
      { label: t('tool.chop'), key: 'Alt+U', fn: () => chopper(x, y) },
      { label: t('tool.quantize'), key: 'Alt+Q', fn: quantize },
      { label: t('tool.legato'), key: 'Ctrl+L', fn: legato },
      '-',
      { label: t('tool.slide'), disabled: !sel.size, fn: () => history.edit(() => { const on = ![...sel].every(n => n.s); for (const n of sel) n.s = on; }) },
    ]);
  }

  // ---------- the pattern loop (the ruler, as in the playlist) ----------
  function toggleLoop() {
    history.edit(() => {
      const r = S.project.pat_loop;
      if (r) r.enabled = !r.enabled;
      else { const start = Math.floor((S.mode === 'pat' ? S.pos : 0) / BAR) * BAR; S.project.pat_loop = { start, end: start + BAR, enabled: true }; }
    });
  }
  function loopMenu(x, y) {
    menu(x, y, [
      { label: t('pl.loop'), on: !!S.project.pat_loop?.enabled, fn: toggleLoop },
      { label: t('pl.clearloop'), disabled: !S.project.pat_loop, fn: () => history.edit(() => { S.project.pat_loop = null; }) },
    ]);
  }

  function resize() {
    if (!wrap) return;
    W = wrap.clientWidth; H = wrap.clientHeight;
    if (!W || !H) return;
    clampScroll();
    draw();
  }
  const gridH = () => H - RH - VH;
  // free movement: as far right as you like past the pattern, all the keys up and down
  function clampScroll() {
    const maxY = Math.max(0, 128 * rowH - gridH());
    sy = clamp(sy, 0, maxY);
    sx = Math.max(0, sx);
  }
  // centre the view on the channel's notes (or C5) the first time it is shown
  function center() {
    const c = curChan(), p = curPat();
    if (!c || !p || !H) return;
    const notes = p.notes[c.id] || [];
    const mid = notes.length ? notes.reduce((s, n) => s + n.k, 0) / notes.length : 60;
    sy = (127 - mid) * rowH - gridH() / 2;
    sx = 0;
    clampScroll();
    scrolledFor = c.id + ':' + p.id;
  }

  // ---------- geometry ----------
  const xOf = tk => KW + tk * ppt - sx;
  const tOf = x => (x - KW + sx) / ppt;
  const yOf = k => RH + (127 - k) * rowH - sy;
  const kOf = y => 127 - Math.floor((y - RH + sy) / rowH);
  const snapFloor = tk => snap <= 1 ? Math.round(tk) : Math.floor(tk / snap) * snap;
  const snapRound = tk => snap <= 1 ? Math.round(tk) : Math.round(tk / snap) * snap;
  const notes = () => { const c = curChan(), p = curPat(); return c && p ? notesOf(p, c.id) : []; };
  // what a tool works on: the selection, or every note of the channel in the pattern
  const targets = () => sel.size ? [...sel] : notes();
  function noteAt(x, y) {
    const k = kOf(y), tk = tOf(x);
    const ns = notes();
    for (let i = ns.length - 1; i >= 0; i--) { const n = ns[i]; if (n.k === k && tk >= n.t && tk < n.t + n.l) return n; }
    return null;
  }
  // another channel's note (a ghost) under the pointer: that channel's id
  function ghostAt(x, y) {
    const p = curPat();
    if (!p || !ghosts) return null;
    const k = kOf(y), tk = tOf(x);
    for (const id in p.notes) {
      if (+id === S.curCh || !chan(+id)) continue;
      for (const n of p.notes[id]) if (n.k === k && tk >= n.t && tk < n.t + n.l) return +id;
    }
    return null;
  }
  function pt(e) { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  const noteColor = n => NOTE_COLORS[n.c] || NOTE_COLORS[0];
  // the bottom lane's value of a note, 0..1 (pan: 0 left, 0.5 centre, 1 right)
  const laneVal = n => lane === 'vel' ? clamp(n.v, 0, 1) : clamp(((n.p || 0) + 1) / 2, 0, 1);
  const laneText = n => lane === 'vel' ? Math.round(n.v * 100) + '%' : panText(n.p || 0);
  const panText = p => Math.abs(p) < 0.01 ? 'C' : (p < 0 ? 'L' : 'R') + Math.round(Math.abs(p) * 100);

  // ---------- drawing ----------
  function draw() {
    if (!win || !win.open || !W || !H) return;
    const c = curChan(), p = curPat();
    if (c && p && scrolledFor !== c.id + ':' + p.id) center();
    sel = new Set([...sel].filter(n => notes().includes(n)));
    const ctx = fitCanvas(cv, W, H);
    fitCanvas(ov, W, H);
    ctx.fillStyle = TOK.bg; ctx.fillRect(0, 0, W, H);
    const len = patLen(p);
    const gH = gridH();
    const scaled = !!degrees();
    ctx.save();
    ctx.beginPath(); ctx.rect(KW, RH, W - KW, gH); ctx.clip();
    // rows: with a scale its notes are the light rows and the root's the lightest; else the keys
    const k0 = clamp(kOf(RH + gH), 0, 127), k1 = clamp(kOf(RH), 0, 127);
    for (let k = k0; k <= k1; k++) {
      const y = yOf(k);
      ctx.fillStyle = scaled ? (inScale(k) ? TOK['grid-b'] : TOK.bg) : isBlack(k) ? TOK['grid-a'] : TOK['grid-b'];
      ctx.fillRect(KW, y, W - KW, rowH);
      if (isRoot(k)) { ctx.fillStyle = TOK.accent; ctx.globalAlpha = 0.09; ctx.fillRect(KW, y, W - KW, rowH); ctx.globalAlpha = 1; }
      ctx.fillStyle = TOK.line;
      if (k % 12 === 0) ctx.fillRect(KW, y + rowH - 1, W - KW, 1);
    }
    // vertical lines
    const tA = Math.max(0, Math.floor(tOf(KW) / STEP) * STEP), tB = tOf(W);
    const stepPx = STEP * ppt;
    for (let tk = tA; tk <= tB; tk += (stepPx < 6 ? BEAT : STEP)) {
      const x = Math.round(xOf(tk));
      ctx.fillStyle = tk % BAR === 0 ? TOK['line-strong'] : TOK.line;
      ctx.globalAlpha = tk % BAR === 0 ? 0.7 : tk % BEAT === 0 ? 1 : 0.45;
      ctx.fillRect(x, RH, 1, gH);
    }
    ctx.globalAlpha = 1;
    // the loop, shaded down the grid
    const region = S.project.pat_loop;
    if (region) {
      ctx.fillStyle = TOK['accent-ink']; ctx.globalAlpha = region.enabled ? 0.07 : 0.025;
      ctx.fillRect(xOf(region.start), RH, (region.end - region.start) * ppt, gH);
      ctx.globalAlpha = region.enabled ? 0.6 : 0.2;
      ctx.fillRect(xOf(region.start), RH, 1, gH); ctx.fillRect(xOf(region.end), RH, 1, gH);
      ctx.globalAlpha = 1;
    }
    // past the pattern end
    const xe = xOf(len);
    if (xe < W) { ctx.fillStyle = TOK.bg; ctx.globalAlpha = 0.55; ctx.fillRect(Math.max(KW, xe), RH, W, gH); ctx.globalAlpha = 1; }
    // ghosts: the other channels of this pattern (double right-click one: its channel opens here)
    if (ghosts && p) {
      ctx.strokeStyle = TOK['ink-faint']; ctx.lineWidth = 1;
      for (const id in p.notes) {
        if (+id === S.curCh) continue;
        for (const n of p.notes[id]) {
          const x = xOf(n.t), y = yOf(n.k);
          if (x > W || x + n.l * ppt < KW || y > RH + gH || y + rowH < RH) continue;
          ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 1.5, Math.max(2, n.l * ppt - 1), rowH - 3);
        }
      }
    }
    // notes, in their colours; a slide note is outlined with its arrow at the start
    ctx.font = '500 10px ' + TOK.font;
    ctx.textBaseline = 'middle';
    for (const n of notes()) {
      const x = Math.round(xOf(n.t)), y = Math.round(yOf(n.k)), w = Math.max(3, Math.round(n.l * ppt) - 1);
      if (x > W || x + w < KW || y > RH + gH || y + rowH < RH) continue;
      const s = sel.has(n), col = s ? TOK.ink : noteColor(n);
      if (n.s) {
        ctx.fillStyle = col; ctx.globalAlpha = 0.25; ctx.fillRect(x, y + 1, w, rowH - 2); ctx.globalAlpha = 1;
        ctx.strokeStyle = col; ctx.strokeRect(x + 0.5, y + 1.5, w - 1, rowH - 3);
        ctx.beginPath(); ctx.moveTo(x + 2, y + 3); ctx.lineTo(x + 2 + Math.min(8, rowH - 6), y + rowH / 2); ctx.lineTo(x + 2, y + rowH - 3); ctx.closePath(); ctx.fillStyle = col; ctx.fill();
        continue;
      }
      ctx.globalAlpha = 0.55 + 0.45 * clamp(n.v, 0, 1);
      ctx.fillStyle = col;
      ctx.fillRect(x, y + 1, w, rowH - 2);
      ctx.globalAlpha = 1;
      ctx.fillStyle = TOK.bg;
      ctx.fillRect(x + w - 1, y + 1, 1, rowH - 2);
      if (w > 30 && rowH >= 11) { ctx.fillStyle = TOK['on-accent']; ctx.fillText(keyName(n.k), x + 4, y + rowH / 2 + 0.5); }
    }
    if (band) {
      ctx.strokeStyle = TOK['accent-ink']; ctx.setLineDash([3, 3]);
      ctx.strokeRect(Math.min(band.x0, band.x1) + 0.5, Math.min(band.y0, band.y1) + 0.5, Math.abs(band.x1 - band.x0), Math.abs(band.y1 - band.y0));
      ctx.setLineDash([]);
    }
    if (cutLine) {
      const x = Math.round(xOf(cutLine.t)) + 0.5;
      ctx.strokeStyle = TOK.danger; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(x, Math.min(cutLine.y0, cutLine.y1) - 4); ctx.lineTo(x, Math.max(cutLine.y0, cutLine.y1) + 4); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();

    // keyboard: the keys first, then every name centred in its row (drawn over all the keys,
    // so no key's fill covers the name of the one below it)
    ctx.save();
    ctx.beginPath(); ctx.rect(0, RH, KW, gH); ctx.clip();
    for (let k = k0; k <= k1; k++) {
      const y = yOf(k);
      const down = k === held || pressed.has(k);
      ctx.fillStyle = down ? TOK.accent : isBlack(k) ? TOK.bg : TOK['surface-2'];
      ctx.fillRect(0, y, isBlack(k) ? KW * 0.62 : KW, rowH);
      if (isBlack(k) && !down) { ctx.fillStyle = TOK['surface-2']; ctx.fillRect(KW * 0.62, y, KW * 0.38, rowH); }
      // the scale's root: a lighter key with the accent along its edge
      if (isRoot(k) && !down) {
        ctx.fillStyle = TOK.ink; ctx.globalAlpha = 0.16; ctx.fillRect(0, y, KW, rowH); ctx.globalAlpha = 1;
        ctx.fillStyle = TOK.accent; ctx.fillRect(0, y + 1, 3, rowH - 2);
      }
      ctx.fillStyle = TOK.line;
      ctx.fillRect(0, y + rowH - 1, KW, 1);
    }
    // names: all of them while a row is tall enough for one, else only the Cs
    const fs = Math.min(10, rowH - 3);
    const allNames = fs >= 8;
    ctx.font = (fs >= 8 ? fs : 8) + 'px ' + TOK.font;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let k = k0; k <= k1; k++) {
      if (k % 12 !== 0 && !allNames) continue;
      const y = yOf(k);
      const down = k === held || pressed.has(k);
      ctx.fillStyle = down ? TOK['on-accent'] : isRoot(k) || k % 12 === 0 ? TOK.ink : scaled && !inScale(k) ? TOK['ink-faint'] : TOK['ink-muted'];
      ctx.fillText(keyName(k), KW - 5, y + rowH / 2);
    }
    ctx.restore();
    ctx.fillStyle = TOK.line; ctx.fillRect(KW - 1, RH, 1, gH);

    // ruler, with the loop
    ctx.fillStyle = TOK.bg; ctx.fillRect(0, 0, W, RH);
    ctx.fillStyle = TOK.line; ctx.fillRect(0, RH - 1, W, 1);
    ctx.save(); ctx.beginPath(); ctx.rect(KW, 0, W - KW, RH); ctx.clip();
    ctx.font = '10.5px ' + TOK.font; ctx.textBaseline = 'middle';
    if (region) {
      ctx.fillStyle = TOK['accent-ink']; ctx.globalAlpha = region.enabled ? 0.25 : 0.08;
      ctx.fillRect(xOf(region.start), 0, (region.end - region.start) * ppt, RH - 1);
      ctx.globalAlpha = 1;
      for (const tk of [region.start, region.end]) ctx.fillRect(Math.round(xOf(tk)) - 2, 0, 5, 5);
    }
    for (let tk = Math.floor(tA / BEAT) * BEAT; tk <= tB; tk += BEAT) {
      const x = Math.round(xOf(tk));
      if (tk % BAR === 0) { ctx.fillStyle = TOK['ink-muted']; ctx.fillRect(x, 6, 1, RH - 6); ctx.fillText(String(tk / BAR + 1), x + 4, RH / 2); }
      else if (BEAT * ppt > 14) { ctx.fillStyle = TOK['line-strong']; ctx.fillRect(x, RH - 6, 1, 5); }
    }
    if (xe >= KW && xe <= W) { ctx.fillStyle = TOK['accent-ink']; ctx.fillText('┤', xe - 7, RH / 2); }
    ctx.restore();

    // the bottom lane: velocity or pan (click its name to switch)
    const vy = H - VH;
    ctx.fillStyle = TOK.surface; ctx.fillRect(KW, vy, W - KW, VH);
    ctx.fillStyle = TOK.line; ctx.fillRect(0, vy, W, 1);
    ctx.font = '500 9.5px ' + TOK.font; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = lane === 'vel' ? TOK['accent-ink'] : TOK['ink-faint']; ctx.fillText('VEL', 10, vy + 16);
    ctx.fillStyle = lane === 'pan' ? TOK['accent-ink'] : TOK['ink-faint']; ctx.fillText('PAN', 10, vy + 30);
    ctx.save(); ctx.beginPath(); ctx.rect(KW, vy + 1, W - KW, VH - 1); ctx.clip();
    const laneY = f => H - 4 - f * (VH - 12);
    if (lane === 'pan') { ctx.fillStyle = TOK.line; ctx.fillRect(KW, Math.round(laneY(0.5)), W - KW, 1); }
    for (const n of notes()) {
      const x = Math.round(xOf(n.t));
      if (x < KW - 4 || x > W) continue;
      ctx.fillStyle = sel.has(n) ? TOK.ink : noteColor(n);
      const yv = Math.round(laneY(laneVal(n)));
      const base = lane === 'vel' ? H - 4 : Math.round(laneY(0.5));
      ctx.fillRect(x, Math.min(yv, base), 3, Math.max(1, Math.abs(base - yv)));
      ctx.fillRect(x - 2, yv - 1, 7, 2);
    }
    ctx.restore();
    playhead();
  }

  // where the playhead is inside the pattern, -1 when it is not in this one
  function headPos() {
    if (S.mode === 'pat') return S.pos;
    const c = S.project.clips.find(c => c.p === S.curPat && S.pos >= c.t && S.pos < c.t + c.l);
    return c ? (S.pos - c.t + c.off) % patLen(curPat()) : -1;
  }

  // As in FL the view follows the playhead during playback, smoothly: once it reaches the
  // anchor the view scrolls with it, and the loop's jump back brings the view back. A pattern
  // that fits in the window stays put. Scrolling sideways by hand lets go until the next start.
  function follow() {
    if (S.playing && !wasPlaying) away = false;
    wasPlaying = S.playing;
    if (!followOn || away || panning || !S.playing || !W || !win.open || !curPat()) return;
    const pos = headPos();
    if (pos < 0) return;
    const want = patLen(curPat()) * ppt + 16 <= W - KW ? 0 : Math.max(0, pos * ppt - (W - KW) * 0.3);
    if (Math.abs(want - sx) >= 0.5) { sx = want; clampScroll(); draw(); }
  }

  function playhead() {
    if (!ov || !W) return;
    const ctx = ov.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const pos = headPos();
    if (pos < 0 || (!S.playing && pos === 0)) return;
    const x = Math.round(xOf(pos));
    if (x < KW || x > W) return;
    ctx.fillStyle = TOK.accent;
    ctx.fillRect(x, 0, 1, H - VH);
    ctx.fillRect(x - 3, 0, 7, 3);
  }

  // ---------- input ----------
  function hover(e) {
    const [x, y] = pt(e);
    if (panning) { cv.style.cursor = 'grabbing'; return; }
    let cur = 'default', key = 'hint.roll.grid';
    if (x < KW && y > H - VH) { cur = 'pointer'; key = 'hint.roll.lane'; }
    else if (x < KW && y > RH) { cur = 'pointer'; key = 'hint.roll.keys'; }
    else if (y < RH) { cur = 'pointer'; key = 'hint.roll.ruler'; }
    else if (y > H - VH) { cur = 'ns-resize'; key = lane === 'vel' ? 'hint.roll.vel' : 'hint.roll.pan'; }
    else {
      const n = noteAt(x, y);
      if (n) cur = x > xOf(n.t + n.l) - 6 && n.l * ppt > 10 ? 'ew-resize' : 'move';
      if (tool === 'cut') { cur = 'col-resize'; key = 'hint.roll.cut'; }
      const k = kOf(y);
      hint('<b>' + keyName(clamp(k, 0, 127)) + '</b> ' + fmtPos(Math.max(0, snapFloor(tOf(x)))) + (n ? '  ' + laneText(n) : '') + '  · ' + t(key));
      cv.style.cursor = cur;
      return;
    }
    cv.style.cursor = cur;
    hint(t(key));
  }

  function down(e) {
    const c = curChan(), p = curPat();
    if (!c || !p) return;
    const [x, y] = pt(e);
    e.preventDefault();
    // the middle button moves the view anywhere
    if (e.button === 1) return panDown(e, x, y);
    if (x < KW && y > H - VH) { setLane(y < H - VH + 22 ? 'vel' : 'pan'); return; }
    if (x < KW && y > RH) return keyDown(e, c);
    if (y < RH) { if (x > KW) rulerDown(e, x); return; }
    if (y > H - VH) return laneDown(e);
    if (e.button === 2) {
      // a double right-click on another channel's note opens that channel here
      const g = !noteAt(x, y) && ghostAt(x, y);
      if (g) {
        const now = performance.now();
        if (lastGhost && lastGhost.ch === g && now - lastGhost.at < 450) {
          lastGhost = null;
          S.curCh = g; sel.clear(); redraw();
          hint('<b>' + chan(g).name + '</b>');
        } else lastGhost = { ch: g, at: now };
        return;
      }
      return erase(e);
    }
    if (e.button !== 0) return;
    if (tool === 'cut') return cutDown(e, x, y);
    if (e.ctrlKey || e.metaKey) return bandDown(e, x, y);
    let n = noteAt(x, y);
    const arr = notesOf(p, c.id);
    history.begin();
    let mode = 'move';
    if (n) {
      if (!sel.has(n)) { sel = new Set([n]); }
      if (x > xOf(n.t + n.l) - 6 && n.l * ppt > 10) mode = 'size';
      if (e.shiftKey && mode === 'move') {
        // copies stay behind, the originals move
        for (const s of sel) arr.push({ ...s });
      }
    } else {
      const tk = Math.max(0, snapFloor(tOf(x)));
      const k = clamp(kOf(y), 0, 127);
      n = { t: tk, l: lastLen, k, v: 0.78 };
      if (color) n.c = color;
      if (slideMode) n.s = true;
      arr.push(n);
      sel = new Set([n]);
      changed();
    }
    const start = [...sel].map(s => ({ s, t: s.t, k: s.k, l: s.l }));
    const anchor = start.find(a => a.s === n);
    const minT = Math.min(...start.map(a => a.t));
    const minK = Math.min(...start.map(a => a.k)), maxK = Math.max(...start.map(a => a.k));
    let stopPrev = n.s ? () => { } : preview(c.id, n.k, n.v);
    let lastK = n.k;
    const x0 = x, y0 = y;
    drag(e, ev => {
      const [mx, my] = pt(ev);
      if (mode === 'size') {
        const raw = anchor.l + (mx - x0) / ppt;
        const nl = Math.max(snap > 1 ? snap : 6, snapRound(anchor.t + raw) - anchor.t);
        const dl = nl - anchor.l;
        for (const a of start) a.s.l = Math.max(snap > 1 ? snap : 6, a.l + dl);
      } else {
        let dt = snapRound(anchor.t + (mx - x0) / ppt) - anchor.t;
        if (ev.altKey) dt = Math.round((mx - x0) / ppt);
        dt = Math.max(dt, -minT);
        let dk = Math.round((y0 - my) / rowH);
        dk = clamp(dk, -minK, 127 - maxK);
        for (const a of start) { a.s.t = a.t + dt; a.s.k = a.k + dk; }
        if (anchor.s.k !== lastK) { lastK = anchor.s.k; stopPrev(); stopPrev = anchor.s.s ? () => { } : preview(c.id, lastK, anchor.s.v); }
      }
      hintValue(keyName(anchor.s.k), fmtPos(anchor.s.t) + '  ' + (anchor.s.l / STEP).toFixed(2) + ' ' + t('snap.step'));
      changed();
    }, () => {
      stopPrev();
      lastLen = anchor.s.l;
      arr.sort((a, b) => a.t - b.t);
      history.end();
      changed();
    });
  }

  function setLane(l) {
    lane = l;
    try { localStorage.setItem('loom.rollLane', l); } catch (_) { }
    draw();
  }

  function panDown(e, x, y) {
    const ox = sx, oy = sy;
    panning = true; away = true; cv.style.cursor = 'grabbing';
    drag(e, ev => {
      const [mx, my] = pt(ev);
      sx = ox - (mx - x); sy = oy - (my - y);
      clampScroll(); draw();
    }, () => { panning = false; cv.style.cursor = 'default'; });
  }

  // Plain left-click sets the position; right-drag or Shift+left-drag make or resize the loop
  // (its edges too); a right-click without a drag opens the loop's menu. As in the playlist.
  function rulerDown(e, x) {
    if (e.button !== 0 && e.button !== 2) return;
    const seek = () => Transport.seek(Math.max(0, e.altKey ? Math.round(tOf(x)) : snapFloor(tOf(x))));
    if (e.button === 0 && !e.shiftKey) return seek();
    const region = S.project.pat_loop;
    const edge = region && Math.abs(x - xOf(region.start)) < 7 ? 'start'
      : region && Math.abs(x - xOf(region.end)) < 7 ? 'end' : null;
    const anchor = edge ? region[edge === 'start' ? 'end' : 'start'] : Math.max(0, snapFloor(tOf(x)));
    let moved = false;
    drag(e, ev => {
      const [mx] = pt(ev);
      if (!moved && Math.abs(mx - x) < 4) return;
      if (!moved) { history.begin(); moved = true; }
      const at = Math.max(0, ev.altKey ? Math.round(tOf(mx)) : snapRound(tOf(mx)));
      const start = Math.min(anchor, at), end = Math.max(anchor, at, start + (ev.altKey ? 1 : Math.max(1, snap)));
      S.project.pat_loop = { start, end, enabled: true };
      hintValue(t('pl.loop'), fmtPos(start) + ' – ' + fmtPos(end));
      changed();
    }, () => {
      if (moved) {
        history.end();
        if (!S.playing && S.mode === 'pat') Transport.seek(S.project.pat_loop.start);
      } else if (e.button === 2) loopMenu(e.clientX, e.clientY);
      else seek();
    });
  }

  function keyDown(e, c) {
    const [, y] = pt(e);
    held = clamp(kOf(y), 0, 127);
    let stop = preview(c.id, held, 0.8);
    draw();
    drag(e, ev => {
      const k = clamp(kOf(pt(ev)[1]), 0, 127);
      if (k !== held) { stop(); held = k; stop = preview(c.id, k, 0.8); draw(); }
    }, () => { stop(); held = -1; draw(); });
  }

  // drawing velocities or pans: the notes under the pointer take its height
  function laneDown(e) {
    history.begin();
    const set = ev => {
      const [x, y] = pt(ev);
      const f = clamp((H - 4 - y) / (VH - 12), 0, 1);
      const pool = sel.size ? [...sel] : notes();
      let hit = null;
      for (const n of pool) if (Math.abs(xOf(n.t) - x) <= 5) {
        if (lane === 'vel') n.v = clamp(f, 0.02, 1);
        else { const p = f * 2 - 1; n.p = Math.abs(p) < 0.04 ? 0 : p; }
        hit = n;
      }
      if (hit) { hintValue(lane === 'vel' ? 'vel' : 'pan', laneText(hit)); changed(); }
    };
    set(e);
    drag(e, set, () => history.end());
  }

  function erase(e) {
    history.begin();
    const arr = notes();
    const kill = ev => {
      const [x, y] = pt(ev);
      const n = noteAt(x, y);
      if (n) { arr.splice(arr.indexOf(n), 1); sel.delete(n); changed(); }
    };
    kill(e);
    drag(e, kill, () => history.end());
  }

  function bandDown(e, x, y) {
    band = { x0: x, y0: y, x1: x, y1: y };
    const base = e.shiftKey ? new Set(sel) : new Set();
    drag(e, ev => {
      const [mx, my] = pt(ev);
      band.x1 = mx; band.y1 = my;
      const t0 = tOf(Math.min(band.x0, mx)), t1 = tOf(Math.max(band.x0, mx));
      const kHi = kOf(Math.min(band.y0, my)), kLo = kOf(Math.max(band.y0, my));
      sel = new Set(base);
      for (const n of notes()) if (n.t + n.l > t0 && n.t < t1 && n.k >= kLo && n.k <= kHi) sel.add(n);
      draw();
    }, () => { band = null; draw(); });
  }

  // ---------- the cut tool: a click cuts the note under it on the grid; a drag up or down
  // cuts every note the line crosses (Alt: off the grid) ----------
  function splitNote(n, tk, arr) {
    if (tk <= n.t || tk >= n.t + n.l) return null;
    const r = { ...n, t: tk, l: n.t + n.l - tk };
    n.l = tk - n.t;
    arr.push(r);
    return r;
  }
  function cutDown(e, x, y) {
    const at = Math.max(0, e.altKey ? Math.round(tOf(x)) : snapRound(tOf(x)));
    cutLine = { t: at, y0: y, y1: y };
    draw();
    drag(e, ev => { cutLine.y1 = pt(ev)[1]; draw(); }, () => {
      const kHi = kOf(Math.min(cutLine.y0, cutLine.y1)), kLo = kOf(Math.max(cutLine.y0, cutLine.y1));
      cutLine = null;
      const arr = notes();
      history.edit(() => {
        for (const n of arr.slice()) if (n.k >= kLo && n.k <= kHi) splitNote(n, at, arr);
        arr.sort((a, b) => a.t - b.t);
      });
    });
  }

  function wheel(e) {
    e.preventDefault();
    const [x, y] = pt(e);
    // Alt+wheel over the notes: the selected ones (or the one under the pointer) change their
    // velocity or pan, whichever the bottom lane shows; elsewhere the rows' height
    if (e.altKey && y > RH && y < H - VH && x > KW) {
      const under = noteAt(x, y);
      const pool = sel.size ? [...sel] : under ? [under] : [];
      if (pool.length) {
        const d = (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.01 : 0.04);
        history.edit(() => {
          for (const n of pool) {
            if (lane === 'vel') n.v = clamp(n.v + d, 0.02, 1);
            else { const p = clamp((n.p || 0) + d * 2, -1, 1); n.p = Math.abs(p) < 0.01 ? 0 : p; }
          }
        });
        hintValue(lane === 'vel' ? 'vel' : 'pan', laneText(pool[0]) + (pool.length > 1 ? ' · ' + t('roll.selected', { n: pool.length }) : ''));
        return;
      }
    }
    if (e.ctrlKey) {
      const at = tOf(x);
      ppt = clamp(ppt * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 2 / STEP, 80 / STEP);
      sx = at * ppt - (x - KW);
    } else if (e.altKey) {
      rowH = clamp(rowH + (e.deltaY < 0 ? 1 : -1), 8, 26);
    } else if (e.shiftKey) { sx += e.deltaY; away = true; tools(); }
    else { sy += e.deltaY; sx += e.deltaX; if (e.deltaX) { away = true; tools(); } }
    clampScroll();
    draw();
  }

  // ---------- note tools (FL's) ----------
  // Quick quantize (Alt+Q): the notes' starts onto the grid.
  function quantize() {
    const g = Math.max(snap, 1);
    history.edit(() => { for (const n of targets()) n.t = Math.max(0, Math.round(n.t / g) * g); notes().sort((a, b) => a.t - b.t); });
  }
  // Quick legato (Ctrl+L): every note lasts up to the next one that starts after it.
  function legato() {
    const ts = targets().slice().sort((a, b) => a.t - b.t);
    const starts = [...new Set(notes().map(n => n.t))].sort((a, b) => a - b);
    history.edit(() => {
      for (const n of ts) {
        const next = starts.find(t => t > n.t);
        if (next != null) n.l = next - n.t;
      }
    });
  }

  // A tool's window: it edits the notes live; "apply" keeps it, "cancel" puts them back, closing
  // it otherwise (a click away, Esc) keeps it. One undo step either way.
  function toolDialog(title, x, y, build) {
    closeMenu();
    const box = h('div', { class: 'menu prerender roll-tool' });
    const ts = targets();
    const snapshot = ts.map(n => ({ n, ...n }));
    let done = false;
    history.begin();
    const restore = () => { for (const s of snapshot) { const { n, ...v } = s; for (const k of Object.keys(n)) if (!(k in v)) delete n[k]; Object.assign(n, v); } };
    const finish = keep => {
      if (done) return;
      done = true;
      if (!keep) restore();
      notes().sort((a, b) => a.t - b.t);
      history.end();
      changed();
    };
    const api_ = {
      ts, restore, changed: () => { changed(); draw(); },
      apply: () => { finish(true); closeMenu(); },
      cancel: () => { finish(false); closeMenu(); },
    };
    const render = () => {
      box.innerHTML = '';
      box.append(h('div', { class: 'head' }, title + ' · ' + (sel.size ? t('roll.selected', { n: ts.length }) : t('roll.all', { n: ts.length }))), ...build(api_, render));
    };
    render();
    box._onclose = () => finish(true);
    box.style.left = Math.min(x, window.innerWidth - 300) + 'px';
    box.style.top = Math.min(y, window.innerHeight - 320) + 'px';
    document.body.append(box);
    openMenu = box;
  }
  const slider = (label, min, max, step, get, set, fmt) => {
    const inp = h('input', { type: 'range', min, max, step, value: get() });
    const val = h('span', { class: 'rv' }, fmt(get()));
    inp.addEventListener('input', () => { set(+inp.value); val.textContent = fmt(+inp.value); });
    return h('label', { class: 'rt-row' }, h('span', { class: 'rl' }, label), inp, val);
  };
  const check = (label, get, set) => {
    const inp = h('input', { type: 'checkbox', class: 'switch' });
    inp.checked = get();
    inp.addEventListener('change', () => set(inp.checked));
    return h('label', null, inp, h('span', null, label));
  };
  const buttons = (a, extra) => h('div', { class: 'pr-btns' }, extra || null,
    h('button', { class: 'gl-btn gl-btn-primary gl-btn-sm', onclick: a.apply }, t('tool.apply')),
    h('button', { class: 'gl-btn gl-btn-ghost gl-btn-sm', onclick: a.cancel }, t('cancel')));

  // Randomizer (Alt+R): velocity between a low and a high, pan up to an amount either way.
  // The dice stay while the sliders move; "again" throws them anew.
  const rnd = { vel: true, lo: 50, hi: 100, pan: true, amount: 40 };
  function randomizer(x, y) {
    toolDialog(t('tool.random'), x, y, (a, render) => {
      let dice = new Map();
      const roll = () => { dice = new Map(a.ts.map(n => [n, [Math.random(), Math.random() * 2 - 1]])); };
      const apply = () => {
        a.restore();
        for (const n of a.ts) {
          const [u, v] = dice.get(n);
          if (rnd.vel) n.v = clamp((rnd.lo + (rnd.hi - rnd.lo) * u) / 100, 0.02, 1);
          if (rnd.pan) n.p = clamp(v * rnd.amount / 100, -1, 1);
        }
        a.changed();
      };
      roll(); apply();
      return [
        check(t('tool.vel'), () => rnd.vel, v => { rnd.vel = v; apply(); }),
        slider(t('tool.low'), 0, 100, 1, () => rnd.lo, v => { rnd.lo = Math.min(v, rnd.hi); apply(); }, v => v + '%'),
        slider(t('tool.high'), 0, 100, 1, () => rnd.hi, v => { rnd.hi = Math.max(v, rnd.lo); apply(); }, v => v + '%'),
        h('div', { class: 'sep' }),
        check(t('tool.pan'), () => rnd.pan, v => { rnd.pan = v; apply(); }),
        slider(t('tool.amount'), 0, 100, 1, () => rnd.amount, v => { rnd.amount = v; apply(); }, v => '±' + v + '%'),
        h('div', { class: 'sep' }),
        buttons(a, h('button', { class: 'gl-btn gl-btn-secondary gl-btn-sm', onclick: () => { roll(); apply(); } }, t('tool.again'))),
      ];
    });
  }

  // Strumizer (Alt+S): the notes of each chord (same start) spread out in time, low to high
  // (or high to low), over the given time; their ends can stay where they were.
  const strum = { time: STEP, down: false, keepEnd: true };
  function strumizer(x, y) {
    toolDialog(t('tool.strum'), x, y, a => {
      const apply = () => {
        a.restore();
        const chords = new Map();
        for (const n of a.ts) { if (!chords.has(n.t)) chords.set(n.t, []); chords.get(n.t).push(n); }
        for (const ch of chords.values()) {
          if (ch.length < 2) continue;
          ch.sort((p, q) => strum.down ? q.k - p.k : p.k - q.k);
          ch.forEach((n, i) => {
            const d = Math.round(i * strum.time / (ch.length - 1));
            const end = n.t + n.l;
            n.t += d;
            n.l = strum.keepEnd ? Math.max(1, end - n.t) : n.l;
          });
        }
        a.changed();
      };
      apply();
      const ms = v => Math.round(v * 60000 / (S.project.bpm * PPQ)) + ' ms';
      return [
        slider(t('tool.time'), 0, BEAT, 1, () => strum.time, v => { strum.time = v; apply(); }, ms),
        check(t('tool.down'), () => strum.down, v => { strum.down = v; apply(); }),
        check(t('tool.keepend'), () => strum.keepEnd, v => { strum.keepEnd = v; apply(); }),
        h('div', { class: 'sep' }),
        buttons(a),
      ];
    });
  }

  // Chopper (Alt+U): each note cut into pieces of the given length, the last one what is left.
  const CHOPS = [['beat', BEAT], ['half', BEAT / 2], ['step', STEP], ['halfstep', STEP / 2], ['quarterstep', STEP / 4]];
  let chopLen = STEP;
  function chopper(x, y) {
    toolDialog(t('tool.chop'), x, y, a => {
      const arr = notes();
      let added = [];
      const apply = () => {
        for (const n of added) { const i = arr.indexOf(n); if (i >= 0) arr.splice(i, 1); }
        added = [];
        a.restore();
        for (const n of a.ts) {
          const end = n.t + n.l;
          if (n.l <= chopLen) continue;
          n.l = chopLen;
          for (let t0 = n.t + chopLen; t0 < end; t0 += chopLen) {
            const piece = { ...n, t: t0, l: Math.min(chopLen, end - t0) };
            arr.push(piece);
            added.push(piece);
          }
        }
        arr.sort((p, q) => p.t - q.t);
        a.changed();
      };
      const cancel = a.cancel;
      a.cancel = () => { for (const n of added) { const i = arr.indexOf(n); if (i >= 0) arr.splice(i, 1); } added = []; cancel(); };
      apply();
      // the choice is marked in place (building the window again would chop twice)
      const opts = CHOPS.map(([k, v]) => {
        const b = h('button');
        const mark = () => { b.className = v === chopLen ? 'on' : ''; b.textContent = (v === chopLen ? '(•) ' : '( ) ') + t('snap.' + k); };
        b.mark = mark;
        b.addEventListener('click', () => { chopLen = v; apply(); opts.forEach(o => o.mark()); });
        mark();
        return b;
      });
      return [
        ...opts,
        h('div', { class: 'sep' }),
        buttons(a),
      ];
    });
  }

  // ---------- keys (app.js routes them here when the roll is the active window) ----------
  let clip = [];
  function key(e) {
    const arr = notes();
    const k = e.key;
    // FL's tools, by key position (any keyboard layout)
    if (e.altKey && !e.ctrlKey) {
      const at = () => { const r = cv.getBoundingClientRect(); return [r.left + 80, r.top + 40]; };
      if (e.code === 'KeyS') { if (!e.repeat) strumizer(...at()); return true; }
      if (e.code === 'KeyU') { if (!e.repeat) chopper(...at()); return true; }
      if (e.code === 'KeyQ') { if (!e.repeat) quantize(); return true; }
      if (e.code === 'KeyR') { if (!e.repeat) randomizer(...at()); return true; }
    }
    if (e.ctrlKey && e.code === 'KeyL') { if (!e.repeat) legato(); return true; }
    if ((k === 'Delete' || k === 'Backspace') && sel.size) {
      history.edit(() => { for (const n of sel) arr.splice(arr.indexOf(n), 1); sel.clear(); });
      return true;
    }
    if (e.ctrlKey && k.toLowerCase() === 'a') { sel = new Set(arr); draw(); return true; }
    if (e.ctrlKey && k.toLowerCase() === 'c' && sel.size) { clip = [...sel].map(n => ({ ...n })); return true; }
    if (e.ctrlKey && k.toLowerCase() === 'v' && clip.length) {
      const from = Math.min(...clip.map(n => n.t));
      const end = sel.size ? Math.max(...[...sel].map(n => n.t + n.l)) : snapFloor(S.mode === 'pat' ? S.pos : 0);
      const at = snap > 1 ? Math.ceil(end / snap) * snap : end;
      history.edit(() => { const add = clip.map(n => ({ ...n, t: n.t - from + at })); arr.push(...add); sel = new Set(add); arr.sort((a, b) => a.t - b.t); });
      return true;
    }
    if (e.ctrlKey && k.toLowerCase() === 'd' && sel.size) {
      const t0 = Math.min(...[...sel].map(n => n.t)), t1 = Math.max(...[...sel].map(n => n.t + n.l));
      const span = snap > 1 ? Math.ceil((t1 - t0) / snap) * snap : t1 - t0;
      history.edit(() => { const add = [...sel].map(n => ({ ...n, t: n.t + span })); arr.push(...add); sel = new Set(add); arr.sort((a, b) => a.t - b.t); });
      return true;
    }
    if (sel.size && (k === 'ArrowUp' || k === 'ArrowDown')) {
      const d = (k === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
      if ([...sel].every(n => n.k + d >= 0 && n.k + d <= 127)) history.edit(() => { for (const n of sel) n.k += d; });
      return true;
    }
    if (sel.size && (k === 'ArrowLeft' || k === 'ArrowRight')) {
      const d = (k === 'ArrowRight' ? 1 : -1) * Math.max(snap, 1);
      if ([...sel].every(n => n.t + d >= 0)) history.edit(() => { for (const n of sel) n.t += d; });
      return true;
    }
    return false;
  }

  return {
    init, draw, playhead, follow, key, center, randomizer: () => { const r = cv.getBoundingClientRect(); randomizer(r.left + 80, r.top + 40); },
    get win() { return win; }, clearSel() { sel.clear(); }, setPressed(s) { pressed = s; draw(); },
    // for tests
    select(ns) { sel = new Set(ns); }, quantize, legato, geom: { xOf: tk => xOf(tk), yOf: k => yOf(k), get rowH() { return rowH; } },
  };
})();
