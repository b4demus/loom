// Playlist: patterns placed on tracks along the song. A clip longer than its pattern repeats it.
// The picker on the left (patterns, then audio channels) chooses what a click places; the last
// thing picked there, or the clip last clicked, stays the choice.

const Patterns = {
  select(id) {
    S.curPat = id;
    S.placeCh = 0;
    if (S.mode === 'pat') Transport.sendMode();
    Roll.clearSel();
    redraw();
  },
  add() {
    history.edit(() => {
      const id = nextId(S.project.patterns);
      S.project.patterns.push(newPattern(id));
      S.curPat = id;
      S.placeCh = 0;
    });
    if (S.mode === 'pat') Transport.sendMode();
  },
  clone(p) {
    history.edit(() => {
      const id = nextId(S.project.patterns);
      const c = JSON.parse(JSON.stringify(p));
      c.id = id; c.name = p.name + ' 2';
      const ps = S.project.patterns;
      ps.splice(ps.indexOf(p) + 1, 0, c);
      S.curPat = id;
      S.placeCh = 0;
    });
  },
  remove(p) {
    if (S.project.patterns.length < 2) return;
    history.edit(() => {
      S.project.patterns = S.project.patterns.filter(x => x !== p);
      S.project.clips = S.project.clips.filter(c => c.p !== p.id);
      fixRefs();
    });
    Transport.sendMode();
  },
  // an audio channel becomes what a click on the playlist places; it is not played
  pickAudio(id) {
    S.placeCh = id;
    S.curCh = id;
    redraw();
  },
};

const Playlist = (() => {
  const TW = 128, RH = 24, AW = 22;
  let win, wrap, cv, ov, list, snapBtn, handBtn, loopBtn, followBtn, drawBtn, reBtn, cutBtn, muteBtn, strBtn, scrollX, scrollY;
  // a clip tool (FL style): 'cut' slices clips, 'mute' silences them, 'stretch' makes an audio
  // clip's edges change its speed; null is the usual place/move/resize
  let tool = null, cutLine = null;
  let W = 0, H = 0;
  let ppt = 80 / BAR, trackH = 48, sx = 0, sy = 0, snap = BAR;
  let sel = new Set(), band = null;
  let hand = false, panning = false, followOn = true, away = false;
  // automation: draw mode (Ableton's B), the track new lanes go to, the point under the mouse
  let drawMode = false, curTrack = 0, hot = null;

  function place() {
    const D = $('#desk');
    return { x: 12, y: 12, w: D.clientWidth - 24, h: Math.round(D.clientHeight * 0.5) - 18 };
  }

  function init() {
    win = WM.create('playlist', { title: 'w.playlist', glyph: '≡', place, minW: 560, minH: 200, open: true, onResize: resize });
    snapBtn = h('button', { class: 'tool', onclick: e => snapMenu(e.currentTarget) });
    handBtn = h('button', { class: 'tool', 'data-hint': 'hint.pl.pan', onclick: () => { hand = !hand; tools(); } });
    loopBtn = h('button', { class: 'tool', 'data-hint': 'hint.pl.loop', onclick: toggleLoop });
    followBtn = h('button', { class: 'tool', 'data-hint': 'hint.pl.follow', onclick: () => { followOn = !followOn; away = false; tools(); } });
    drawBtn = h('button', { class: 'tool', 'data-hint': 'hint.au.draw', onclick: () => { drawMode = !drawMode; tools(); } });
    reBtn = h('button', { class: 'tool re-auto', 'data-hint': 'hint.au.reenable', onclick: () => Auto.reEnable() });
    const pick = name => () => { tool = tool === name ? null : name; tools(); };
    cutBtn = h('button', { class: 'tool', 'data-hint': 'hint.pl.cut', onclick: pick('cut') });
    muteBtn = h('button', { class: 'tool', 'data-hint': 'hint.pl.mutetool', onclick: pick('mute') });
    strBtn = h('button', { class: 'tool', 'data-hint': 'hint.pl.stretch', onclick: pick('stretch') });
    win.tools.append(snapBtn, cutBtn, muteBtn, strBtn, handBtn, loopBtn, followBtn, drawBtn, reBtn);
    list = h('div', { class: 'picker-list' });
    const picker = h('div', { class: 'picker' },
      h('div', { class: 'picker-head' }, h('span', { class: 'gl-section', 'data-i18n': 'patterns' }, t('patterns')),
        h('button', { class: 'tool icon', onclick: () => Patterns.add() }, '+')),
      list);
    wrap = h('div', { class: 'cv-wrap', 'data-pl': '' });
    cv = h('canvas'); ov = h('canvas', { class: 'overlay' });
    scrollX = h('div', { class: 'pl-scroll-x', role: 'scrollbar', 'aria-label': t('pl.horizontal') }, h('div'));
    scrollY = h('div', { class: 'pl-scroll-y', role: 'scrollbar', 'aria-label': t('pl.vertical') }, h('div'));
    scrollX.addEventListener('scroll', () => { if (Math.abs(scrollX.scrollLeft - sx) < 1) return; sx = scrollX.scrollLeft; away = true; tools(); draw(); });
    scrollY.addEventListener('scroll', () => { if (Math.abs(scrollY.scrollTop - sy) < 1) return; sy = scrollY.scrollTop; draw(); });
    wrap.append(cv, ov, scrollX, scrollY);
    win.body.append(picker, wrap);
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointermove', hover);
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('dblclick', dbl);
    cv.addEventListener('wheel', wheel, { passive: false });
    new ResizeObserver(resize).observe(wrap);
    snap = +(localStorage.getItem('loom.plSnap') || BAR) || BAR;
    bus.on('render', () => { tools(); renderList(); draw(); });
    bus.on('restore', () => { sel.clear(); band = null; hot = null; cutLine = null; });
  }

  function tools() {
    const sn = SNAPS.find(s => s[1] === snap) || SNAPS[0];
    snapBtn.innerHTML = '';
    snapBtn.append(h('span', null, t('snap')), h('b', null, t('snap.' + sn[0])));
    handBtn.textContent = '✥ ' + t('pl.hand'); handBtn.classList.toggle('on', hand);
    loopBtn.textContent = '↻ ' + t('pl.loop'); loopBtn.classList.toggle('on', !!S.project.loop_region?.enabled);
    followBtn.textContent = '→ ' + t('pl.follow'); followBtn.classList.toggle('on', followOn && !away);
    drawBtn.textContent = '✎ ' + t('au.draw'); drawBtn.classList.toggle('on', drawMode);
    cutBtn.textContent = '✂ ' + t('pl.cut'); cutBtn.classList.toggle('on', tool === 'cut');
    muteBtn.textContent = '⊘ ' + t('pl.mute'); muteBtn.classList.toggle('on', tool === 'mute');
    strBtn.textContent = '↔ ' + t('pl.stretch'); strBtn.classList.toggle('on', tool === 'stretch');
    // Ableton's "re-enable automation": lit while a lane is overridden by hand
    const off = Auto.anyOff();
    reBtn.textContent = '⟲ ' + t('au.reenable'); reBtn.classList.toggle('warn', off); reBtn.disabled = !off;
  }
  function toggleLoop() {
    history.edit(() => {
      if (S.project.loop_region) S.project.loop_region.enabled = !S.project.loop_region.enabled;
      else { const start = Math.floor((S.songStart || 0) / BAR) * BAR; S.project.loop_region = { start, end: start + BAR, enabled: true }; }
    });
  }
  function loopMenu(x, y) {
    menu(x, y, [
      { label: t('pl.loop'), on: !!S.project.loop_region?.enabled, fn: toggleLoop },
      { label: t('pl.clearloop'), disabled: !S.project.loop_region, fn: () => history.edit(() => { S.project.loop_region = null; }) },
    ]);
  }
  function snapMenu(el) {
    const r = el.getBoundingClientRect();
    menu(r.left, r.bottom + 4, SNAPS.filter(s => s[1] >= STEP || s[1] === 1).map(([k, v]) => ({ label: t('snap.' + k), on: v === snap, fn: () => { snap = v; localStorage.setItem('loom.plSnap', v); tools(); } })));
  }

  // The colour entries of a pattern's or a sound's menu: the theme's accent (no colour of its
  // own, so it follows the theme), then the palette
  function colorItems(cur, set) {
    return [
      { head: t('pat.color') },
      { label: t('pat.accent'), on: !cur, fn: () => history.edit(() => set(null)) },
      ...PAT_COLORS.map(c => ({ label: '■■■■', on: cur === c, fn: () => history.edit(() => set(c)) })),
    ];
  }
  // colour the swatches of the menu just opened
  function paintColorItems() {
    if (!openMenu) return;
    const rows = $$('button', openMenu);
    const accent = rows.find(b => b.textContent.includes(t('pat.accent')));
    if (accent && accent.children[1]) accent.children[1].style.color = TOK.accent;
    rows.filter(b => b.textContent.includes('■■■■')).forEach((b, i) => { b.children[1].style.color = PAT_COLORS[i]; });
  }

  function renderList() {
    list.innerHTML = '';
    const audio = S.project.channels.filter(c => c.inst.type === 'audio');
    if (S.placeCh && !audio.some(c => c.id === S.placeCh)) S.placeCh = 0;
    for (const p of S.project.patterns) {
      const it = h('button', { class: 'pat-item' + (!S.placeCh && p.id === S.curPat ? ' on' : ''), 'data-hint': 'hint.pat', style: '--c:' + (p.color || TOK.accent) },
        h('span', { class: 'pg' }), h('span', { class: 'sw' }), h('span', { class: 'pn' }, p.name), h('span', { class: 'pl' }, patLen(p) / BAR));
      it.addEventListener('click', () => Patterns.select(p.id));
      it.addEventListener('dblclick', () => renameAt(it.getBoundingClientRect(), p.name, v => history.edit(() => { p.name = v || p.name; })));
      it.addEventListener('contextmenu', e => {
        e.preventDefault();
        menu(e.clientX, e.clientY, [
          { label: t('pat.rename'), fn: () => renameAt(it.getBoundingClientRect(), p.name, v => history.edit(() => { p.name = v || p.name; })) },
          { label: t('pat.clone'), fn: () => Patterns.clone(p) },
          ...colorItems(p.color, c => { p.color = c; }),
          '-',
          S.project.patterns.length > 1 && { label: t('pat.delete'), danger: true, fn: () => Patterns.remove(p) },
        ]);
        paintColorItems();
      });
      list.append(it);
    }
    list.append(h('div', { class: 'picker-head sub' }, h('span', { class: 'gl-section' }, t('pl.audio')),
      h('button', { class: 'tool icon', 'data-hint': 'hint.pl.addaudio', onclick: addAudio }, '+')));
    if (!audio.length) list.append(h('div', { class: 'picker-empty' }, t('pl.noaudio')));
    for (const c of audio) {
      const wv = Waves.get(c.inst.sample, c.inst.path);
      const it = h('button', { class: 'pat-item audio' + (S.placeCh === c.id ? ' on' : ''), 'data-hint': 'hint.plaudio', 'data-ach': c.id, style: '--c:' + audioColor(c) },
        h('span', { class: 'pg' }), h('span', { class: 'sw' }), h('span', { class: 'pn' }, c.name), h('span', { class: 'pl' }, wv && wv.seconds ? wv.seconds.toFixed(1) + 's' : '~'));
      it.addEventListener('click', () => Patterns.pickAudio(c.id));
      it.addEventListener('dblclick', () => { Patterns.pickAudio(c.id); Chan.open(c.id); });
      it.addEventListener('contextmenu', e => {
        e.preventDefault();
        menu(e.clientX, e.clientY, [
          { label: t('ch.settings'), fn: () => Chan.open(c.id) },
          { label: t('pl.listen'), fn: () => api.call('preview', { path: c.inst.path || null, sample: c.inst.path ? null : c.inst.sample }) },
          { label: t('pat.rename'), fn: () => renameAt(it.getBoundingClientRect(), c.name, v => history.edit(() => { c.name = v || c.name; })) },
          ...colorItems(c.color, v => { c.color = v; }),
        ]);
        paintColorItems();
      });
      list.append(it);
    }
  }

  // a sound from a file: a new audio channel, picked for placing
  async function addAudio() {
    const s = await api.call('pick_sample').catch(e => { toast(t('toast.err', { e }), 'err'); });
    if (!s) return;
    history.edit(() => {
      let ch = S.project.channels.find(c => c.inst.type === 'audio' && c.inst.path === s.path);
      if (!ch) { ch = newAudioChannel(nextId(S.project.channels), s.name.replace(/\.[^.]+$/, ''), s.name, s.path); S.project.channels.push(ch); }
      S.placeCh = ch.id; S.curCh = ch.id;
    });
  }

  function resize() {
    if (!wrap) return;
    W = wrap.clientWidth; H = wrap.clientHeight;
    if (!W || !H) return;
    clampScroll();
    draw();
  }
  function clampScroll() {
    sy = clamp(sy, 0, Math.max(0, relayout().total - (H - RH)));
    sx = Math.max(0, sx);
  }
  function syncScrollbars() {
    if (!scrollX) return;
    scrollX.firstChild.style.width = Math.ceil(Math.max((songLen() + 32 * BAR) * ppt, sx + W - TW + 16 * BAR * ppt)) + 'px';
    scrollY.firstChild.style.height = L.total + 'px';
    scrollX.scrollLeft = sx; scrollY.scrollTop = sy;
  }

  // ---------- rows: each track, then its automation lanes when it shows them ----------
  // L.rows: [{tr, y, h, lane?}] (y from the top of the first track), L.trackY[tr], L.total
  let L = { rows: [], trackY: [], total: 0 };
  const laneH = () => Math.max(40, Math.round(trackH * 0.9));
  function relayout() {
    const rows = [], trackY = [];
    let y = 0;
    const lanes = S.project.automation || [];
    S.project.tracks.forEach((tk, tr) => {
      trackY[tr] = y;
      rows.push({ tr, y, h: trackH });
      y += trackH;
      if (tk.auto) for (const lane of lanes) if (lane.track === tr) { rows.push({ tr, lane, y, h: laneH() }); y += laneH(); }
    });
    L = { rows, trackY, total: y };
    return L;
  }
  function rowAt(y) {
    const yy = y - RH + sy;
    return L.rows.find(r => yy >= r.y && yy < r.y + r.h) || null;
  }
  // the track a y belongs to (a lane belongs to its track), clamped to the tracks
  function trackNear(y) {
    const r = rowAt(y);
    if (r) return r.tr;
    return y - RH + sy < 0 ? 0 : S.project.tracks.length - 1;
  }

  const xOf = tk => TW + tk * ppt - sx;
  const tOf = x => (x - TW + sx) / ppt;
  const yOf = tr => RH + (L.trackY[tr] ?? tr * trackH) - sy;
  const rowY = r => RH + r.y - sy;
  const snapRound = tk => snap <= 1 ? Math.round(tk) : Math.round(tk / snap) * snap;
  const snapFloor = tk => snap <= 1 ? Math.round(tk) : Math.floor(tk / snap) * snap;
  function pt(e) { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  function clipAt(x, y) {
    const r = rowAt(y);
    if (!r || r.lane) return null;
    const tr = r.tr, tk = tOf(x);
    const cs = S.project.clips;
    for (let i = cs.length - 1; i >= 0; i--) { const c = cs[i]; if (c.track === tr && tk >= c.t && tk < c.t + c.l) return c; }
    return null;
  }

  // ---------- drawing ----------
  function draw() {
    if (!win || !win.open || !W || !H) return;
    sel = new Set([...sel].filter(c => S.project.clips.includes(c)));
    relayout();
    clampScroll();
    syncScrollbars();
    const ctx = fitCanvas(cv, W, H);
    fitCanvas(ov, W, H);
    ctx.fillStyle = TOK.bg; ctx.fillRect(0, 0, W, H);
    const tracks = S.project.tracks;
    const gH = H - RH;
    const tA = Math.max(0, Math.floor(tOf(TW) / BAR) * BAR), tB = tOf(W);
    const end = songLen();
    ctx.save();
    ctx.beginPath(); ctx.rect(TW, RH, W - TW, gH); ctx.clip();
    // rows (lanes on the plain background, a little darker)
    const vis = L.rows.filter(r => rowY(r) + r.h > RH && rowY(r) < H);
    for (const r of vis) {
      const y = rowY(r);
      ctx.fillStyle = r.lane ? TOK.bg : r.tr % 2 ? TOK['grid-a'] : TOK['grid-b'];
      ctx.fillRect(TW, y, W - TW, r.h);
      ctx.fillStyle = TOK['line-strong']; ctx.globalAlpha = 0.3; ctx.fillRect(TW, y + r.h - 1, W - TW, 1); ctx.globalAlpha = 1;
    }
    // bar / beat lines
    const barPx = BAR * ppt;
    const every = barPx < 14 ? 4 : 1;
    // three weights: beats faint, bars clear, every fourth bar strong
    if (barPx > 90) {
      ctx.fillStyle = TOK.line; ctx.globalAlpha = 0.7;
      for (let tk = tA; tk <= tB; tk += BEAT) if (tk % BAR) ctx.fillRect(Math.round(xOf(tk)), RH, 1, gH);
      ctx.globalAlpha = 1;
    }
    for (let tk = tA; tk <= tB; tk += BAR) {
      const b = tk / BAR;
      if (b % every) continue;
      ctx.fillStyle = TOK['line-strong'];
      ctx.globalAlpha = b % 4 === 0 ? 0.55 : 0.22;
      ctx.fillRect(Math.round(xOf(tk)), RH, 1, gH);
    }
    ctx.globalAlpha = 1;
    const region = S.project.loop_region;
    if (region) {
      ctx.fillStyle = TOK['accent-ink']; ctx.globalAlpha = region.enabled ? 0.08 : 0.025;
      ctx.fillRect(xOf(region.start), RH, (region.end - region.start) * ppt, gH);
      ctx.globalAlpha = region.enabled ? 0.6 : 0.2;
      ctx.fillRect(xOf(region.start), RH, 1, gH); ctx.fillRect(xOf(region.end), RH, 1, gH);
      ctx.globalAlpha = 1;
    }
    const xe = xOf(end);
    if (xe < W) { ctx.fillStyle = TOK.bg; ctx.globalAlpha = 0.5; ctx.fillRect(Math.max(TW, xe), RH, W, gH); ctx.globalAlpha = 1; }
    // clips
    ctx.textBaseline = 'middle';
    for (const c of S.project.clips) {
      const ach = c.ch ? audioChan(c) : null;
      const p = c.ch ? null : pat(c.p);
      if (!ach && !p) continue;
      const x = Math.round(xOf(c.t)), w = Math.max(4, Math.round(c.l * ppt)), y = yOf(c.track) + 2, hh = trackH - 5;
      if (x > W || x + w < TW || y > H || y + hh < RH) continue;
      const muted = c.mute || (tracks[c.track] && tracks[c.track].mute);
      ctx.globalAlpha = muted ? 0.35 : 1;
      // an audio clip of a muted channel looks muted too
      if (ach && ach.mute) ctx.globalAlpha *= 0.4;
      if (ach) drawAudio(ctx, c, ach, x, y, w, hh, sel.has(c));
      else drawClip(ctx, c, p, x, y, w, hh, sel.has(c));
      ctx.globalAlpha = 1;
    }
    for (const r of vis) if (r.lane) drawLane(ctx, r);
    // the cut tool's line, across the tracks it will cut
    if (cutLine) {
      const x = Math.round(xOf(cutLine.t)) + 0.5;
      ctx.strokeStyle = TOK.danger; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(x, Math.min(cutLine.y0, cutLine.y1) - 4); ctx.lineTo(x, Math.max(cutLine.y0, cutLine.y1) + 4); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (band) {
      ctx.strokeStyle = TOK['accent-ink']; ctx.setLineDash([3, 3]);
      ctx.strokeRect(Math.min(band.x0, band.x1) + 0.5, Math.min(band.y0, band.y1) + 0.5, Math.abs(band.x1 - band.x0), Math.abs(band.y1 - band.y0));
      ctx.setLineDash([]);
    }
    ctx.restore();

    // track headers, and the headers of their lanes
    ctx.save(); ctx.beginPath(); ctx.rect(0, RH, TW, gH); ctx.clip();
    for (const r of vis) {
      const y = rowY(r), tk = tracks[r.tr];
      ctx.fillStyle = r.lane ? TOK.surface : TOK.bg; ctx.fillRect(0, y, TW, r.h);
      ctx.fillStyle = TOK.line; ctx.fillRect(0, y + r.h - 1, TW, 1);
      if (r.lane) { laneHead(ctx, r, y); continue; }
      ctx.font = '11.5px ' + TOK.font;
      // on/off square, like the rack
      ctx.fillStyle = tk.mute ? TOK.bg : TOK.accent;
      ctx.fillRect(12, y + trackH / 2 - 6, 12, 12);
      ctx.strokeStyle = TOK['line-strong']; ctx.lineWidth = 1;
      ctx.strokeRect(12.5, y + trackH / 2 - 5.5, 11, 11);
      ctx.fillStyle = tk.name ? TOK.ink : TOK['ink-faint'];
      ctx.fillText(clipText(ctx, tk.name || t('track', { n: r.tr + 1 }), TW - 58), 34, y + trackH / 2 + 2.5);
      // the automation fold: "A", lit when the track has lanes, filled while they show
      const has = (S.project.automation || []).some(l => l.track === r.tr);
      const ax = TW - AW - 6, ay = y + trackH / 2 - 8;
      ctx.fillStyle = tk.auto && has ? TOK['accent-soft'] || TOK['surface-2'] : TOK.bg;
      ctx.fillRect(ax, ay, AW, 16);
      ctx.strokeStyle = has ? TOK['accent-ink'] : TOK.line; ctx.strokeRect(ax + 0.5, ay + 0.5, AW - 1, 15);
      ctx.fillStyle = has ? TOK['accent-ink'] : TOK['ink-faint'];
      ctx.font = '600 10px ' + TOK.font;
      // centred in its box (the glyphs sit high in their line, so a touch lower than the middle)
      ctx.textAlign = 'center';
      ctx.fillText((tk.auto && has ? '▾' : '▸') + 'A', ax + AW / 2, ay + 10);
      ctx.textAlign = 'left';
    }
    ctx.restore();
    ctx.fillStyle = TOK.line; ctx.fillRect(TW - 1, RH, 1, gH);

    // ruler
    ctx.fillStyle = TOK.bg; ctx.fillRect(0, 0, W, RH);
    ctx.fillStyle = TOK.line; ctx.fillRect(0, RH - 1, W, 1);
    ctx.save(); ctx.beginPath(); ctx.rect(TW, 0, W - TW, RH); ctx.clip();
    ctx.font = '10.5px ' + TOK.font;
    if (region) {
      ctx.fillStyle = TOK['accent-ink']; ctx.globalAlpha = region.enabled ? 0.25 : 0.08;
      ctx.fillRect(xOf(region.start), 0, (region.end - region.start) * ppt, RH - 1);
      ctx.globalAlpha = 1;
      for (const tk of [region.start, region.end]) ctx.fillRect(Math.round(xOf(tk)) - 2, 0, 5, 5);
    }
    const lab = barPx < 28 ? 4 : 1;
    for (let tk = tA; tk <= tB; tk += BAR) {
      const b = tk / BAR, x = Math.round(xOf(tk));
      if (b % lab === 0) { ctx.fillStyle = TOK['ink-muted']; ctx.fillRect(x, 8, 1, RH - 8); ctx.fillText(String(b + 1), x + 4, RH / 2); }
      else { ctx.fillStyle = TOK['line-strong']; ctx.fillRect(x, RH - 6, 1, 5); }
    }
    if (xe >= TW && xe <= W) { ctx.fillStyle = TOK['accent-ink']; ctx.fillText('┤', xe - 7, RH / 2); }
    ctx.restore();
    ctx.fillStyle = TOK['ink-faint']; ctx.font = '500 9.5px ' + TOK.font;
    ctx.fillText(S.project.clips.length ? fmtTime(end) : '', 12, RH / 2);
    playhead();
  }

  function clipText(ctx, s, w) {
    if (ctx.measureText(s).width <= w) return s;
    while (s.length > 1 && ctx.measureText(s + '…').width > w) s = s.slice(0, -1);
    return s + '…';
  }

  // A clip is a header strip (the name, the handles) over a body (the notes, or the wave). The
  // pattern's colour makes the header bright and the body a dark tint of it; an audio clip's
  // header is dimmer and its body darker, so the two kinds differ in structure, not only in hue.
  const headOf = hh => hh >= 36 ? 14 : 12;
  function clipFill(ctx, x, y, w, hh, col, selected, head, body) {
    ctx.fillStyle = mixColor(col, TOK.bg, selected ? Math.min(1, body + 0.12) : body);
    ctx.fillRect(x, y, w, hh);
    ctx.fillStyle = mixColor(col, TOK.bg, selected ? 1 : head);
    ctx.fillRect(x, y, w, headOf(hh));
  }
  function clipOutline(ctx, x, y, w, hh, col, selected) {
    ctx.strokeStyle = selected ? TOK.ink : mixColor(col, TOK.bg, 0.45);
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, hh - 1);
  }

  function drawClip(ctx, c, p, x, y, w, hh, selected) {
    const col = p.color || TOK.accent, hd = headOf(hh);
    clipFill(ctx, x, y, w, hh, col, selected, 0.88, 0.24);
    // notes of every channel, squeezed into the clip body, repeated with the pattern
    const len = patLen(p);
    let lo = 127, hi = 0, any = false;
    for (const id in p.notes) for (const n of p.notes[id]) { lo = Math.min(lo, n.k); hi = Math.max(hi, n.k); any = true; }
    const top = y + hd + 2, bh = hh - hd - 4;
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, hh); ctx.clip();
    if (any) {
      const span = Math.max(12, hi - lo + 1);
      for (let k = Math.floor(c.off / len); (k * len - c.off) < c.l; k++) {
        const base = x + (k * len - c.off) * ppt;
        ctx.fillStyle = col;
        for (const id in p.notes) for (const n of p.notes[id]) {
          const nx = base + n.t * ppt;
          if (nx < x || nx > x + w) continue;
          const ny = top + bh - 2 - (n.k - lo) / span * (bh - 2);
          ctx.fillRect(nx, Math.round(ny), Math.max(1.5, n.l * ppt - 1), 2);
        }
        // where the pattern starts over
        if (k * len - c.off > 0) { ctx.fillStyle = mixColor(col, TOK.bg, 0.5); ctx.fillRect(Math.round(base), y + hd, 1, hh - hd); }
      }
    }
    ctx.font = '500 10.5px ' + TOK.font;
    ctx.fillStyle = TOK['on-accent'];
    ctx.fillText(clipText(ctx, (c.mute ? '⊘ ' : '') + p.name, w - 24), x + (w < 26 ? 8 : CLIP_TEXT), y + hd / 2 + 0.5);
    ctx.restore();
    clipOutline(ctx, x, y, w, hh, col, selected);
    clipHandles(ctx, c, x, y, w, hh, TOK['on-accent']);
  }

  // ---------- audio clips: each plays the sound of its audio channel ----------
  const audioChan = c => { const ch = c.ch ? chan(c.ch) : null; return ch && ch.inst.type === 'audio' ? ch : null; };
  const clipName = c => c.ch ? (audioChan(c) || {}).name || '?' : (pat(c.p) || {}).name || '?';
  const secPerTick = () => 60 / (S.project.bpm * PPQ);
  // a new clip of an audio channel: as long as its sound, or its last clip while the wave loads
  function audioLen(ch) {
    const wv = Waves.get(ch.inst.sample, ch.inst.path);
    if (wv && wv.seconds) return Math.max(STEP, Math.ceil(wv.seconds / secPerTick()));
    const last = S.project.clips.filter(c => c.ch === ch.id).pop();
    return last ? last.l : BAR;
  }

  // The longest an audio clip may get: what is left of its sound from where it starts playing.
  // `keep` (the clip's length when the drag began) is the floor, so a clip already longer than
  // its sound never jumps shorter; Infinity for pattern clips or while the wave is not loaded.
  function soundLeft(c, keep) {
    const ch = c.ch ? audioChan(c) : null;
    const wv = ch && Waves.get(ch.inst.sample, ch.inst.path);
    if (!wv || !wv.seconds) return Infinity;
    return Math.max(keep, Math.max(STEP, Math.ceil((wv.seconds / secPerTick() - c.off) / (c.rate || 1))));
  }

  function drawAudio(ctx, c, ch, x, y, w, hh, selected) {
    const col = audioColor(ch), hd = headOf(hh);
    clipFill(ctx, x, y, w, hh, col, selected, 0.5, 0.13);
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, hh); ctx.clip();
    const wv = Waves.get(ch.inst.sample, ch.inst.path);
    const top = y + hd + 1, bh = hh - hd - 3, mid = top + bh / 2, amp = bh / 2;
    // centre line
    ctx.fillStyle = mixColor(col, TOK.bg, 0.3);
    ctx.fillRect(x, Math.round(mid), w, 1);
    const rate = c.rate || 1, gain = c.gain ?? 1, rev = !!ch.inst.reverse;
    if (wv && wv.peaks) {
      // one column per pixel, mirrored around the centre; a stretched clip runs through it
      // faster, a reversed sound from its end; the clip's volume scales it. The wave stays
      // inside the body: past the box it is cut, which is how it looks when it clips.
      const spt = secPerTick();
      const time = px => ((px - x) / ppt * rate + c.off) * spt;
      ctx.save(); ctx.beginPath(); ctx.rect(x, y + hd, w, hh - hd); ctx.clip();
      Waves.paint(ctx, wv, Math.max(x, TW), Math.min(x + w, W), mid, amp * Math.min(gain, 1.6), mixColor(col, TOK.ink, 0.8), rev ? px => wv.seconds - time(px) : time, true);
      ctx.restore();
      // where the sound ends inside a longer clip
      const endX = x + (wv.seconds / spt - c.off) / rate * ppt;
      if (endX > x + 3 && endX < x + w) { ctx.fillStyle = mixColor(col, TOK.bg, 0.5); ctx.fillRect(Math.round(endX), y + hd, 1, hh - hd); }
    } else {
      ctx.fillStyle = TOK['ink-faint']; ctx.font = '10.5px ' + TOK.font;
      ctx.fillText(wv === 'error' ? '!' : '…', x + 8, mid);
    }
    // fades: the ramps, shaded outside them
    const fi = (c.fade_in || 0) * ppt, fo = (c.fade_out || 0) * ppt;
    ctx.fillStyle = TOK.bg; ctx.globalAlpha *= 0.55;
    if (fi > 0) { ctx.beginPath(); ctx.moveTo(x, y + hd); ctx.lineTo(x + fi, y + hd); ctx.lineTo(x, y + hh); ctx.closePath(); ctx.fill(); }
    if (fo > 0) { ctx.beginPath(); ctx.moveTo(x + w, y + hd); ctx.lineTo(x + w - fo, y + hd); ctx.lineTo(x + w, y + hh); ctx.closePath(); ctx.fill(); }
    ctx.globalAlpha /= 0.55;
    ctx.strokeStyle = TOK.ink; ctx.lineWidth = 1;
    if (fi > 0) { ctx.beginPath(); ctx.moveTo(x, y + hh); ctx.lineTo(x + fi, y + hd); ctx.stroke(); }
    if (fo > 0) { ctx.beginPath(); ctx.moveTo(x + w - fo, y + hd); ctx.lineTo(x + w, y + hh); ctx.stroke(); }
    ctx.font = '500 10.5px ' + TOK.font;
    ctx.fillStyle = TOK.ink;
    const tags = (Math.abs(rate - 1) > 1e-3 ? '  ×' + rate.toFixed(2) : '') + (Math.abs(gain - 1) > 1e-3 ? '  ' + gainText(gain) : '') + (rev ? '  ⇐' : '');
    ctx.fillText(clipText(ctx, (c.mute ? '⊘ ' : '~ ') + clipName(c) + tags, w - 30), x + CLIP_TEXT, y + hd / 2 + 0.5);
    ctx.restore();
    clipOutline(ctx, x, y, w, hh, col, selected);
    clipHandles(ctx, c, x, y, w, hh, TOK.ink);
  }

  // ---------- a clip's handles: its menu (≡) on every clip; on audio clips the fade-in and
  // fade-out corners and the volume grip in the middle of the top edge ----------
  const CLIP_TEXT = 20;
  const gainText = g => g <= 0.0001 ? '-inf dB' : (g > 1 ? '+' : '') + (20 * Math.log10(g)).toFixed(1) + ' dB';
  // `fg`: the colour of the header's text, which the handles share
  function clipHandles(ctx, c, x, y, w, hh, fg) {
    if (w < 26) return;
    const hd = headOf(hh);
    ctx.fillStyle = fg; ctx.font = '600 10px ' + TOK.font;
    ctx.fillText('≡', x + 8, y + hd / 2);
    if (!c.ch) return;
    const fi = x + (c.fade_in || 0) * ppt, fo = x + w - (c.fade_out || 0) * ppt;
    ctx.fillRect(Math.round(fi), y + 1, 5, 5);
    ctx.fillRect(Math.round(fo) - 5, y + 1, 5, 5);
    if (w > 70) {
      const gx = Math.round(x + w / 2), set = Math.abs((c.gain ?? 1) - 1) > 1e-3;
      ctx.globalAlpha *= set ? 1 : 0.5;
      ctx.fillRect(gx - 7, y + 2, 14, 3);
      ctx.globalAlpha /= set ? 1 : 0.5;
    }
  }
  // which handle of clip `c` is at (x, y), if any
  function clipPart(c, x, y) {
    const cx = Math.round(xOf(c.t)), w = Math.max(4, Math.round(c.l * ppt)), cy = yOf(c.track) + 2;
    if (w < 26 || y > cy + 12) return null;
    if (c.ch) {
      const fi = cx + (c.fade_in || 0) * ppt, fo = cx + w - (c.fade_out || 0) * ppt;
      if (x >= fi - 2 && x <= fi + 6 && y <= cy + 7) return 'fadein';
      if (x >= fo - 6 && x <= fo + 2 && y <= cy + 7) return 'fadeout';
    }
    if (x >= cx + 5 && x <= cx + 16) return 'menu';
    if (c.ch && w > 70 && Math.abs(x - (cx + w / 2)) <= 9 && y <= cy + 7) return 'gain';
    return null;
  }
  function fadeDrag(e, c, which) {
    history.begin();
    const hk = which === 'fadein' ? 'fade_in' : 'fade_out';
    drag(e, ev => {
      const [mx] = pt(ev);
      const end = c.t + c.l;
      // in ticks, free (Alt off: the grid when it is finer than a bar)
      const tk = which === 'fadein' ? tOf(mx) - c.t : end - tOf(mx);
      const other = which === 'fadein' ? c.fade_out : c.fade_in;
      c[hk] = Math.round(clamp(tk, 0, c.l - (other || 0)));
      hintValue(t(which === 'fadein' ? 'cl.fadein' : 'cl.fadeout'), (c[hk] / PPQ).toFixed(2) + ' ' + t('cl.beats'));
      changed();
    }, () => history.end());
  }
  function gainDrag(e, c, y0) {
    history.begin();
    const db0 = 20 * Math.log10(Math.max(c.gain ?? 1, 1e-4));
    drag(e, ev => {
      const [, my] = pt(ev);
      const db = clamp(db0 + (y0 - my) * (ev.shiftKey ? 0.05 : 0.25), -48, 12);
      c.gain = db <= -47.9 ? 0 : Math.pow(10, db / 20);
      hintValue(clipName(c), gainText(c.gain));
      changed();
    }, () => history.end());
  }

  // ---------- the clip menu ----------
  function clipMenu(c, x, y) {
    const list = sel.has(c) && sel.size > 1 ? [...sel] : [c];
    menu(x, y, [
      { head: clipName(c) + (list.length > 1 ? ' +' + (list.length - 1) : '') },
      { label: t('cl.unique'), fn: () => makeUnique(c) },
      { label: t('cl.render'), key: 'Ctrl+Alt+C', fn: () => preRenderDialog(list, x, y) },
      c.ch && audioChan(c) && { label: t('stem.title'), disabled: !!Stems.active || !audioChan(c).inst.path, fn: () => Stems.dialog(c, x, y) },
      { label: c.mute ? t('cl.unmute') : t('cl.mute'), fn: () => history.edit(() => { const m = !c.mute; list.forEach(k => { k.mute = m; }); }) },
      // the sound's own pitch and direction (every clip of it: make unique first for just this one)
      ...(c.ch && audioChan(c) ? soundItems(audioChan(c)) : []),
      c.ch && { label: t('cl.gain0'), disabled: (c.gain ?? 1) === 1, fn: () => history.edit(() => { c.gain = 1; }) },
      c.ch && { label: t('cl.nofade'), disabled: !c.fade_in && !c.fade_out, fn: () => history.edit(() => { c.fade_in = 0; c.fade_out = 0; }) },
      c.ch && { label: t('ch.settings'), fn: () => Chan.open(c.ch) },
      '-',
      { label: t('ch.delete'), danger: true, fn: () => history.edit(() => { S.project.clips = S.project.clips.filter(k => !list.includes(k)); sel.clear(); }) },
    ]);
  }
  function soundItems(ch) {
    const shared = S.project.clips.filter(k => k.ch === ch.id).length > 1;
    const st = ch.inst.pitch || 0;
    const pitch = d => history.edit(() => { ch.inst.pitch = clamp(Math.round((ch.inst.pitch || 0) + d), -24, 24); });
    return [
      '-',
      { head: t('cl.sound') + (shared ? ' · ' + t('cl.shared') : '') },
      { label: t('c.reverse'), on: !!ch.inst.reverse, fn: () => history.edit(() => { ch.inst.reverse = !ch.inst.reverse; }) },
      { label: t('cl.pitchup'), key: (st > 0 ? '+' : '') + st + ' st', fn: () => pitch(1) },
      { label: t('cl.pitchdown'), fn: () => pitch(-1) },
      { label: t('cl.pitchoct'), fn: () => pitch(12) },
      { label: t('cl.pitch0'), disabled: !st, fn: () => history.edit(() => { ch.inst.pitch = 0; }) },
      '-',
    ];
  }

  // FL's make unique: the clip gets its own copy of its pattern (or of its audio channel, with
  // the sound's settings), so changing it leaves the other clips alone
  function makeUnique(c) {
    history.edit(() => {
      const P = S.project;
      if (c.ch) {
        const ch = chan(c.ch);
        if (!ch) return;
        const copy = JSON.parse(JSON.stringify(ch));
        copy.id = nextId(P.channels);
        copy.name = uniqueName(ch.name, P.channels.map(x => x.name));
        P.channels.push(copy);
        c.ch = copy.id;
        S.curCh = S.placeCh = copy.id;
      } else {
        const p = pat(c.p);
        if (!p) return;
        const copy = JSON.parse(JSON.stringify(p));
        copy.id = nextId(P.patterns);
        copy.name = uniqueName(p.name, P.patterns.map(x => x.name));
        P.patterns.splice(P.patterns.indexOf(p) + 1, 0, copy);
        c.p = copy.id;
        S.curPat = copy.id;
        S.placeCh = 0;
      }
    });
    if (S.mode === 'pat') Transport.sendMode();
  }
  function uniqueName(base, taken) {
    for (let n = 2; ; n++) if (!taken.includes(base + ' #' + n)) return base + ' #' + n;
  }

  // ---------- pre-render (FL's consolidate, Ctrl+Alt+C) ----------
  // The clips become one audio clip: rendered from where the first starts, the rest of the
  // song silent. Options: keep what rings on past them (leave remainder) or cut it, render the
  // insert effects and/or the master's into it.
  function preRenderDialog(clips, x, y) {
    clips = clips.filter(c => S.project.clips.includes(c));
    if (!clips.length) return;
    closeMenu();
    // originals: 'mute' (they stay, silent, the patterns with them), 'keep' or 'delete'
    let o = { tail: false, inserts: true, master: false, originals: 'mute' };
    try { o = Object.assign(o, JSON.parse(localStorage.getItem('loom.prerender') || '{}')); } catch (_) { }
    const radio = (on, label, fn) => { const b = h('button', { class: on ? 'on' : '' }, (on ? '(•) ' : '( ) ') + label); b.addEventListener('click', fn); return b; };
    const check = (key, label) => {
      const inp = h('input', { type: 'checkbox', class: 'switch' });
      inp.checked = !!o[key];
      inp.addEventListener('change', () => { o[key] = inp.checked; });
      return h('label', null, inp, h('span', null, label));
    };
    const box = h('div', { class: 'menu prerender' });
    const build = () => {
      box.innerHTML = '';
      box.append(
        h('div', { class: 'head' }, t('cl.render') + ' · ' + clips.length),
        radio(!o.tail, t('cl.cut'), () => { o.tail = false; build(); }),
        radio(o.tail, t('cl.leave'), () => { o.tail = true; build(); }),
        h('div', { class: 'sep' }),
        check('inserts', t('cl.inserts')),
        check('master', t('cl.masterfx')),
        h('div', { class: 'sep' }),
        h('div', { class: 'head' }, t('cl.originals')),
        ...['mute', 'keep', 'delete'].map(k => radio(o.originals === k, t('cl.orig.' + k), () => { o.originals = k; build(); })),
        h('div', { class: 'sep' }),
        h('div', { class: 'pr-btns' },
          h('button', { class: 'gl-btn gl-btn-primary gl-btn-sm', onclick: () => { closeMenu(); try { localStorage.setItem('loom.prerender', JSON.stringify(o)); } catch (_) { } preRender(clips, o); } }, t('cl.go')),
          h('button', { class: 'gl-btn gl-btn-ghost gl-btn-sm', onclick: closeMenu }, t('cancel'))));
    };
    build();
    box.style.left = Math.min(x, window.innerWidth - 300) + 'px';
    box.style.top = Math.min(y, window.innerHeight - 260) + 'px';
    document.body.append(box);
    openMenu = box;
  }

  // the project cut down to `clips`, moved to start at 0, with the effects asked for
  function renderProject(clips, o) {
    const t0 = Math.min(...clips.map(c => c.t));
    const p = JSON.parse(JSON.stringify(S.project));
    const keep = new Set(clips.map(c => S.project.clips.indexOf(c)));
    p.clips = p.clips.filter((c, i) => keep.has(i) && !c.mute).map(c => ({ ...c, t: c.t - t0 }));
    p.tracks.forEach(tk => { tk.mute = false; });
    p.loop_region = null;
    p.automation = (p.automation || []).map(l => ({ ...l, points: l.points.map(q => ({ ...q, t: q.t - t0 })) }));
    // without the inserts the channels play straight into the master, as they sound themselves
    if (!o.inserts) p.channels.forEach(ch => { ch.mix = 0; });
    if (!o.master) { p.mixer[0].fx = []; p.mixer[0].vol = 1; p.mixer[0].pan = 0; }
    return p;
  }
  // the mixer track the clips' channels share (the rendered clip plays there when it has no
  // insert effects in it), else the master
  function sharedMix(clips) {
    const mixes = new Set();
    for (const c of clips) {
      if (c.ch) { const ch = chan(c.ch); if (ch) mixes.add(ch.mix); continue; }
      const p = pat(c.p);
      for (const id in (p && p.notes) || {}) if (p.notes[id].length && chan(+id)) mixes.add(chan(+id).mix);
    }
    return mixes.size === 1 ? [...mixes][0] : 0;
  }
  async function preRender(clips, o) {
    const live = clips.filter(c => !c.mute);
    if (!live.length) { toast(t('cl.nothing'), 'info'); return; }
    const t0 = Math.min(...live.map(c => c.t)), t1 = Math.max(...live.map(c => c.t + c.l));
    const name = clipName(live[0]).replace(/[\\/:*?"<>|]/g, '_') + '_render';
    hint('<b>' + t('cl.render') + '</b>  · ' + t('cl.rendering'));
    let r;
    try { r = await api.call('render_clips', { json: JSON.stringify(renderProject(live, o)), project: S.path, name, len: t1 - t0, tail: !!o.tail }); }
    catch (e) { toast(t('toast.err', { e }), 'err'); return; }
    if (!r) return;
    const file = r.path.split(/[\\/]/).pop();
    try { await Waves.load(file, r.path); } catch (_) { }
    const l = o.tail ? Math.max(t1 - t0, Math.ceil(r.seconds / secPerTick())) : t1 - t0;
    const mixTo = o.inserts ? 0 : sharedMix(live);
    history.edit(() => {
      const P = S.project;
      const top = Math.min(...live.map(c => c.track));
      // the originals stay (silenced unless asked otherwise): their patterns and notes are kept
      if (o.originals === 'delete') P.clips = P.clips.filter(c => !clips.includes(c));
      else if (o.originals !== 'keep') clips.forEach(c => { c.mute = true; });
      // the render goes on the first track from the originals' down with room for it
      let track = top;
      while (track < P.tracks.length && P.clips.some(c => c.track === track && c.t < t0 + l && c.t + c.l > t0)) track++;
      if (track >= P.tracks.length) P.tracks.push({ name: '', mute: false });
      const ch = newAudioChannel(nextId(P.channels), file.replace(/\.wav$/i, ''), file, r.path);
      ch.mix = Math.min(mixTo, P.mixer.length - 1);
      P.channels.push(ch);
      const nc = { p: 0, ch: ch.id, track, t: t0, l, off: 0, mute: false, rate: 1, gain: 1, fade_in: 0, fade_out: 0 };
      P.clips.push(nc);
      sel = new Set([nc]);
      S.curCh = S.placeCh = ch.id;
    });
    toast(t('cl.rendered', { name: file, s: r.seconds.toFixed(1) }), 'info');
  }

  // A sound dropped on the playlist (browser item or a file from Explorer) becomes an audio clip
  // where it lands, as long as the sound. Its audio channel in the rack is reused when the
  // same sound already has one, otherwise made.
  async function dropAudio(it, cx, cy) {
    const r = cv.getBoundingClientRect();
    const x = cx - r.left, y = cy - r.top;
    const tr = trackNear(Math.max(y, RH));
    const t0 = Math.max(0, snapFloor(tOf(Math.max(x, TW))));
    const sample = it.kind === 'kit' ? 'kit:' + it.sample : it.name, path = it.kind === 'kit' ? null : it.path;
    let wv;
    try { wv = await Waves.load(sample, path); }
    catch (e) { toast(t('toast.err', { e }), 'err'); return; }
    const l = Math.max(STEP, Math.ceil(wv.seconds / secPerTick()));
    history.edit(() => {
      let ch = S.project.channels.find(c => c.inst.type === 'audio' && c.inst.sample === sample && (c.inst.path || null) === path);
      if (!ch) {
        ch = newAudioChannel(nextId(S.project.channels), it.name.replace(/\.[^.]+$/, ''), sample, path);
        S.project.channels.push(ch);
      }
      S.curCh = ch.id;
      S.placeCh = ch.id;
      const c = { p: 0, ch: ch.id, track: tr, t: t0, l, off: 0 };
      S.project.clips.push(c);
      sel = new Set([c]);
    });
    Transport.setMode('song');
  }
  const cloneClip = c => ({ ...c });
  // a pattern clip where a file was dropped (client coordinates); returns the clip
  function placePattern(pid, cx, cy) {
    const r = cv.getBoundingClientRect();
    relayout();
    const tr = trackNear(Math.max(cy - r.top, RH));
    const t0 = Math.max(0, snapFloor(tOf(Math.max(cx - r.left, TW))));
    const c = { p: pid, track: tr, t: t0, l: patLen(pat(pid)), off: 0, ch: 0, mute: false, rate: 1, gain: 1, fade_in: 0, fade_out: 0 };
    S.project.clips.push(c);
    sel = new Set([c]);
    return c;
  }

  function playhead() {
    if (!ov || !W) return;
    const ctx = ov.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (S.mode !== 'song') return;
    const marker = Math.round(xOf(S.songStart || 0));
    if (marker >= TW && marker <= W) {
      ctx.fillStyle = TOK['ink-muted']; ctx.fillRect(marker - 4, 3, 9, 4);
    }
    drawLive(ctx);
    const x = Math.round(xOf(S.pos));
    if (x < TW || x > W) return;
    ctx.fillStyle = TOK.accent;
    ctx.fillRect(x, 0, 1, H);
    ctx.fillRect(x - 3, 0, 7, 3);
    // where each lane is at the playhead, and its value in the lane's header
    for (const r of L.rows) {
      if (!r.lane || !r.lane.points.length || rowY(r) + r.h < RH || rowY(r) > H) continue;
      const v = Auto.value(r.lane.points, S.pos);
      ctx.fillStyle = r.lane.on ? TOK.accent : TOK['ink-muted'];
      ctx.beginPath(); ctx.arc(x + 0.5, vY(r, v), 3.5, 0, Math.PI * 2); ctx.fill();
      if (S.playing) {
        const y = rowY(r);
        ctx.fillStyle = TOK.surface; ctx.fillRect(26, y + 21, TW - 30, 14);
        ctx.fillStyle = r.lane.on ? TOK['accent-ink'] : TOK['ink-muted']; ctx.font = '500 10px ' + TOK.font; ctx.textBaseline = 'middle';
        ctx.fillText(Auto.fmt(r.lane.target, v) + (r.lane.on ? '' : '  ' + t('au.off')), 28, y + 28);
      }
    }
  }
  // Recording: each take grows from where it started up to the playhead, its wave drawn as it
  // comes in (as in FL). Peaks are min/max pairs per 10 ms from the start of the take.
  function drawLive(ctx) {
    if (typeof Rec === 'undefined' || !Rec.live || !Rec.takes || !Rec.takes.size) return;
    const tpms = S.project.bpm * PPQ / 60000;
    ctx.save();
    ctx.beginPath(); ctx.rect(TW, RH, W - TW, H - RH); ctx.clip();
    for (const e of Rec.takes.values()) {
      if (e.t0 == null || e.row == null || L.trackY[e.row] == null) continue;
      const y = yOf(e.row) + 2, hh = trackH - 5;
      const xs = xOf(Math.max(0, e.t0)), x0 = Math.max(TW, xs), x1 = Math.min(W, xOf(S.pos));
      if (y > H || y + hh < RH || x1 <= x0) continue;
      ctx.fillStyle = TOK['surface-2']; ctx.fillRect(x0, y, x1 - x0, hh);
      ctx.fillStyle = TOK.danger; ctx.globalAlpha = 0.1; ctx.fillRect(x0, y, x1 - x0, hh); ctx.globalAlpha = 1;
      // the wave: a column per pixel, the peaks that fall in it
      const p = e.peaks, n = p.length / 2;
      const top = y + 15, bh = hh - 17, mid = top + bh / 2, amp = bh / 2 - 1;
      ctx.fillStyle = TOK.accent;
      for (let px = Math.floor(x0); px < x1; px++) {
        const a = (tOf(px) - e.t0) / tpms / 10, b = (tOf(px + 1) - e.t0) / tpms / 10;
        if (b <= 0) continue;
        let lo = 0, hi = 0;
        for (let i = Math.max(0, Math.floor(a)); i < Math.min(n, Math.ceil(b)); i++) { lo = Math.min(lo, p[i * 2]); hi = Math.max(hi, p[i * 2 + 1]); }
        if (hi - lo > 0) ctx.fillRect(px, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
      }
      ctx.strokeStyle = TOK.danger; ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(x0) + 0.5, y + 0.5, Math.max(1, x1 - x0 - 1), hh - 1);
      ctx.fillStyle = TOK.danger; ctx.font = '500 10.5px ' + TOK.font; ctx.textBaseline = 'middle';
      if (x1 - x0 > 40) ctx.fillText('● ' + t('rec.rec') + (e.key.startsWith('mix:') ? ' · ' + (e.track ? t('insert', { n: e.track }) : t('master')) : ''), x0 + 6, y + 8);
    }
    ctx.restore();
  }

  // keep the playhead on screen while the song plays
  // As in FL, smooth: once the playhead reaches the anchor the view scrolls with it, so it stays
  // there; a jump back (loop, seek) brings the view back. Scrolling by hand lets go until the
  // next start.
  let wasPlaying = false;
  function follow() {
    if (S.playing && !wasPlaying) away = false;
    wasPlaying = S.playing;
    if (!followOn || away || panning || !S.playing || S.mode !== 'song' || !W || !win.open) return;
    const want = Math.max(0, S.pos * ppt - (W - TW) * 0.3);
    if (Math.abs(want - sx) >= 0.5) { sx = want; clampScroll(); draw(); }
  }

  // ---------- automation lanes (Ableton) ----------
  // A lane row shows one parameter's envelope under its track. Click empty space: a breakpoint;
  // drag a point (Shift fine, Alt off the grid); drag a line: move it up/down, Alt+drag: bend it;
  // double-click or right-click a point: delete, right-drag: erase; ✎ draw mode paints steps.
  const PAD = 5;
  const vY = (r, v) => rowY(r) + PAD + (1 - v) * (r.h - PAD * 2 - 1);
  const yV = (r, y) => clamp(1 - (y - rowY(r) - PAD) / (r.h - PAD * 2 - 1), 0, 1);

  function laneLabel(l) {
    const tg = l.target, mx = S.project.mixer;
    const mixName = i => (i === 0 ? 'M ' : i + ' ') + (mx[i]?.name || (i === 0 ? t('master') : t('insert', { n: i })));
    switch (tg.kind) {
      case 'mix_vol': return mixName(tg.track) + ' · ' + t('vol');
      case 'mix_pan': return mixName(tg.track) + ' · ' + t('pan');
      case 'chan_vol': return (chan(tg.ch)?.name || '?') + ' · ' + t('vol');
      case 'chan_pan': return (chan(tg.ch)?.name || '?') + ' · ' + t('pan');
      case 'fx_mix': return Plugins.nameOf(tg.pid) + ' · ' + t('fx.mix');
      default: return Plugins.nameOf(tg.pid) + ' · ' + (l.name || '#' + tg.param);
    }
  }

  function drawLane(ctx, r) {
    const l = r.lane, pts = l.points;
    const col = l.on ? TOK.accent : TOK['ink-muted'];
    const x0 = TW, x1 = W;
    if (!pts.length) {
      // no points yet: the parameter's own value, dashed
      const y = vY(r, Auto.current(l.target));
      ctx.strokeStyle = TOK['ink-faint']; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0, y + 0.5); ctx.lineTo(x1, y + 0.5); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = TOK['ink-faint']; ctx.font = '10.5px ' + TOK.font;
      ctx.fillText(t('au.empty'), x0 + 8, rowY(r) + r.h / 2);
      return;
    }
    // the envelope, a column per two pixels (bends and jumps included)
    ctx.beginPath();
    for (let x = x0; x <= x1 + 2; x += 2) {
      const y = vY(r, Auto.value(pts, tOf(x)));
      if (x === x0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.lineTo(x1 + 2, rowY(r) + r.h - 1); ctx.lineTo(x0, rowY(r) + r.h - 1); ctx.closePath();
    ctx.fillStyle = col; ctx.globalAlpha = l.on ? 0.12 : 0.06; ctx.fill(); ctx.globalAlpha = 1;
    ctx.beginPath();
    for (let x = x0; x <= x1 + 2; x += 2) {
      const y = vY(r, Auto.value(pts, tOf(x)));
      if (x === x0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.stroke(); ctx.lineWidth = 1;
    // breakpoints
    for (const p of pts) {
      const x = xOf(p.t);
      if (x < x0 - 6 || x > x1 + 6) continue;
      const y = vY(r, p.v), big = hot && hot.p === p;
      const s = big ? 4 : 3;
      ctx.fillStyle = TOK.bg; ctx.fillRect(x - s, y - s, s * 2, s * 2);
      ctx.strokeStyle = col; ctx.strokeRect(x - s + 0.5, y - s + 0.5, s * 2 - 1, s * 2 - 1);
      if (big) { ctx.fillStyle = col; ctx.fillRect(x - 2, y - 2, 4, 4); }
    }
  }

  function laneHead(ctx, r, y) {
    const l = r.lane;
    // the lane's LED: lit while it plays, hollow while a manual change overrides it
    ctx.fillStyle = l.on ? TOK.accent : TOK.bg;
    ctx.fillRect(14, y + 9, 8, 8);
    ctx.strokeStyle = l.on ? TOK.accent : TOK['ink-muted']; ctx.strokeRect(14.5, y + 9.5, 7, 7);
    ctx.font = '10.5px ' + TOK.font; ctx.fillStyle = TOK.ink;
    ctx.fillText(clipText(ctx, laneLabel(l), TW - 34 - 14), 28, y + 13.5);
    // the value at the playhead (or the parameter's own value)
    const v = l.points.length ? Auto.value(l.points, S.pos) : Auto.current(l.target);
    ctx.fillStyle = l.on ? TOK['accent-ink'] : TOK['ink-muted']; ctx.font = '500 10px ' + TOK.font;
    ctx.fillText(Auto.fmt(l.target, v) + (l.on ? '' : '  ' + t('au.off')), 28, y + 28);
    // ✕: remove the lane
    ctx.fillStyle = TOK['ink-faint']; ctx.fillText('✕', TW - 18, y + 13.5);
  }

  // ---------- picking what a lane drives: a device, then its parameter ----------
  function chooseTarget(x, y, onPick) {
    const P = S.project, items = [];
    const last = Auto.last;
    if (last) items.push({ label: t('au.last'), sub: lastLabel(last), tag: '★', direct: last });
    P.mixer.forEach((m, i) => items.push({ label: (i === 0 ? 'M  ' : i + '  ') + (m.name || (i === 0 ? t('master') : t('insert', { n: i }))), sub: t('w.mixer'), tag: '|', mix: i }));
    P.channels.forEach(c => items.push({ label: c.name, sub: t('w.chan'), tag: '#', ch: c.id }));
    P.plugins.forEach(d => {
      const where = P.mixer.findIndex(m => m.fx.some(f => f.pid === d.id));
      items.push({ label: Plugins.nameOf(d.id), sub: where >= 0 ? t('w.mixer') + ' ' + (where || 'M') : t('c.plugin'), tag: d.format === 'vst3' ? 'vst3' : 'vst', pid: d.id, fx: where >= 0 });
    });
    pickList(x, y, {
      title: t('au.choose'), placeholder: t('pk.search'), empty: t('pk.none'), items,
      onPick: it => {
        if (it.direct) return onPick(it.direct, it.direct.kind === 'param' ? lastName : '');
        if (it.mix != null) {
          const fx = P.mixer[it.mix].fx;
          menu(x, y, [
            { head: it.label },
            { label: t('vol'), fn: () => onPick({ kind: 'mix_vol', track: it.mix }) },
            { label: t('pan'), fn: () => onPick({ kind: 'mix_pan', track: it.mix }) },
            ...fx.map(f => ({ label: Plugins.nameOf(f.pid) + ' · ' + t('fx.mix'), fn: () => onPick({ kind: 'fx_mix', pid: f.pid }) })),
          ]);
        } else if (it.ch != null) {
          menu(x, y, [
            { head: it.label },
            { label: t('vol'), fn: () => onPick({ kind: 'chan_vol', ch: it.ch }) },
            { label: t('pan'), fn: () => onPick({ kind: 'chan_pan', ch: it.ch }) },
          ]);
        } else chooseParam(it.pid, x, y, onPick, it.fx);
      },
    });
  }
  let lastName = '';
  function lastLabel(tg) {
    if (tg.kind === 'param') return Plugins.nameOf(tg.pid) + ' · ' + (lastName || '#' + tg.param);
    return laneLabel({ target: tg });
  }
  async function chooseParam(pid, x, y, onPick, isFx) {
    let ps;
    try { ps = await api.call('plugin_params', { id: pid }); }
    catch (e) { toast(Plugins.nameOf(pid) + ': ' + e, 'err'); return; }
    ps = ps || [];
    ps.forEach(p => { Auto.paramDefaults[pid + ':' + p.id] = p.default; });
    const items = [];
    if (isFx) items.push({ label: t('fx.mix'), sub: 'dry/wet', fxmix: true });
    ps.forEach(p => items.push({ label: p.name, sub: '#' + p.id, param: p }));
    pickList(x, y, {
      title: Plugins.nameOf(pid) + ' · ' + t('au.params', { n: ps.length }), placeholder: t('pk.search'), empty: t('pk.none'), items,
      onPick: it => it.fxmix ? onPick({ kind: 'fx_mix', pid }) : onPick({ kind: 'param', pid, param: it.param.id }, it.param.name),
    });
  }

  // a lane for `tg` under track `tr` (an existing lane of it moves there), shown
  function showLane(tg, name, tr) {
    tr = tr ?? curTrack;
    history.edit(() => {
      const P = S.project;
      P.automation = P.automation || [];
      let l = Auto.laneOf(tg);
      if (!l) { l = { id: nextId(P.automation), track: tr, target: tg, name: name || '', points: [], on: true }; P.automation.push(l); }
      else { l.track = tr; if (name) l.name = name; }
      P.tracks[l.track].auto = true;
    });
    win.show();
  }
  function addLaneMenu(tr, x, y) {
    curTrack = tr;
    chooseTarget(x, y, (tg, name) => showLane(tg, name, tr));
  }
  function laneMenu(r, x, y) {
    const l = r.lane;
    menu(x, y, [
      { head: laneLabel(l) },
      { label: t('au.change'), fn: () => chooseTarget(x, y, (tg, name) => history.edit(() => {
        const other = Auto.laneOf(tg);
        if (other && other !== l) S.project.automation = S.project.automation.filter(a => a !== other);
        l.target = tg; l.name = name || '';
      })) },
      { label: t('au.add'), fn: () => addLaneMenu(l.track, x, y) },
      { label: l.on ? t('au.disable') : t('au.enable'), fn: () => history.edit(() => { l.on = !l.on; }) },
      { label: t('au.clear'), disabled: !l.points.length, fn: () => history.edit(() => { l.points = []; }) },
      '-',
      { label: t('au.delete'), danger: true, fn: () => removeLane(l) },
    ]);
  }
  function removeLane(l) {
    history.edit(() => { S.project.automation = S.project.automation.filter(a => a !== l); });
  }

  // ---------- editing a lane ----------
  function pointAt(r, x, y) {
    let best = null, bd = 7;
    for (const p of r.lane.points) {
      const d = Math.max(Math.abs(xOf(p.t) - x), Math.abs(vY(r, p.v) - y));
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }
  const insertPoint = (pts, p) => { let i = 0; while (i < pts.length && pts[i].t <= p.t) i++; pts.splice(i, 0, p); return p; };
  const laneTime = (x, free) => Math.max(0, free ? Math.round(tOf(x)) : snapRound(tOf(x)));

  function laneDown(e, r, x, y) {
    const l = r.lane, pts = l.points;
    curTrack = l.track;
    if (e.button === 2) return laneErase(e, r);
    if (e.button !== 0) return;
    history.begin();
    if (drawMode) return lanePaint(e, r);
    let p = pointAt(r, x, y);
    const onLine = pts.length && Math.abs(vY(r, Auto.value(pts, tOf(x))) - y) <= 5;
    if (!p && onLine && (e.altKey || pts.length > 1)) return laneSegment(e, r, x, y, e.altKey);
    if (!p) { p = insertPoint(pts, { t: laneTime(x, e.altKey), v: yV(r, y), c: 0 }); changed(); }
    // drag the point: between its neighbours in time, Shift for fine values, Alt off the grid
    const i0 = pts.indexOf(p);
    const tMin = i0 > 0 ? pts[i0 - 1].t : 0, tMax = i0 < pts.length - 1 ? pts[i0 + 1].t : Infinity;
    let lastY = y;
    hot = { lane: l, p };
    drag(e, ev => {
      const [mx, my] = pt(ev);
      p.v = ev.shiftKey ? clamp(p.v + (lastY - my) / (r.h - PAD * 2) * 0.15, 0, 1) : yV(r, my);
      lastY = my;
      p.t = clamp(laneTime(mx, ev.altKey), tMin, tMax);
      hintValue(laneLabel(l), fmtPos(p.t) + ' · ' + Auto.fmt(l.target, p.v));
      changed();
    }, () => { history.end(); changed(); });
  }

  // drag a line between two points up or down; with Alt, bend it
  function laneSegment(e, r, x, y, bendIt) {
    const pts = r.lane.points, tk = tOf(x);
    let i = pts.findIndex((p, k) => p.t <= tk && (k === pts.length - 1 || pts[k + 1].t > tk));
    // before the first point the first one holds; it moves alone
    if (i < 0) i = 0;
    const a = pts[i], b = pts[i + 1];
    const start = { av: a.v, bv: b ? b.v : 0, c: a.c || 0 };
    let moved = false;
    drag(e, ev => {
      const [, my] = pt(ev);
      if (!moved && Math.abs(my - y) < 3) return;
      moved = true;
      const dy = (y - my) / (r.h - PAD * 2);
      if (bendIt && b) {
        // up bows the line up, whichever way it runs
        a.c = clamp(start.c + dy * 2 * (b.v >= a.v ? 1 : -1), -1, 1);
        hintValue(laneLabel(r.lane), t('au.bend') + ' ' + Math.round(a.c * 100));
      } else {
        a.v = clamp(start.av + dy, 0, 1);
        if (b) b.v = clamp(start.bv + dy, 0, 1);
        hintValue(laneLabel(r.lane), Auto.fmt(r.lane.target, a.v) + (b ? ' → ' + Auto.fmt(r.lane.target, b.v) : ''));
      }
      changed();
    }, () => {
      // a click on the line without a drag puts a breakpoint on it
      if (!moved && !bendIt) insertPoint(pts, { t: laneTime(x, e.altKey), v: Auto.value(pts, tk), c: 0 });
      history.end(); changed();
    });
  }

  // Draw mode: a flat step per grid cell under the pointer. The stroke rebuilds its span from
  // the lane as it was, so steps meet in jumps and what lies outside keeps its shape.
  function lanePaint(e, r) {
    const l = r.lane, origin = l.points.slice();
    const cell = snap > 1 ? snap : STEP;
    const cells = new Map();
    let prev = null;
    const paint = ev => {
      const [mx, my] = pt(ev);
      const c = Math.max(0, Math.floor(tOf(mx) / cell) * cell), v = yV(r, my);
      // a fast stroke skips cells: fill them in between
      if (prev && Math.abs(c - prev.c) > cell) {
        const n = Math.abs(c - prev.c) / cell, dir = Math.sign(c - prev.c);
        for (let k = 1; k < n; k++) cells.set(prev.c + dir * k * cell, prev.v + (v - prev.v) * k / n);
      }
      cells.set(c, v);
      prev = { c, v };
      const lo = Math.min(...cells.keys()), hi = Math.max(...cells.keys()) + cell;
      const out = origin.filter(p => p.t < lo);
      if (out.length) out.push({ t: lo, v: Auto.value(origin, lo - 1e-6), c: 0 });
      for (let t0 = lo; t0 < hi; t0 += cell) {
        const cv0 = cells.get(t0) ?? Auto.value(origin, t0) ?? v;
        out.push({ t: t0, v: cv0, c: 0 }, { t: t0 + cell, v: cv0, c: 0 });
      }
      const right = origin.filter(p => p.t > hi);
      if (right.length) out.push({ t: hi, v: Auto.value(origin, hi + 1e-6), c: 0 });
      l.points = out.concat(right);
      hintValue(laneLabel(l), fmtPos(c) + ' · ' + Auto.fmt(l.target, v));
      changed();
    };
    paint(e);
    drag(e, paint, () => { history.end(); changed(); });
  }

  // right button: a click deletes the point under it, a drag erases the points it passes
  function laneErase(e, r) {
    history.begin();
    const l = r.lane;
    let lastX = pt(e)[0];
    const kill = ev => {
      const [mx, my] = pt(ev);
      const a = tOf(Math.min(lastX, mx) - 4), b = tOf(Math.max(lastX, mx) + 4);
      const hit = pointAt(r, mx, my);
      l.points = l.points.filter(p => p !== hit && (ev === e || p.t < a || p.t > b));
      lastX = mx;
      changed();
    };
    kill(e);
    drag(e, kill, () => history.end());
  }

  // ---------- input ----------
  // the clip under the mouse and where the mouse is (for Ctrl+Alt+C)
  let underMouse = null;
  const mouse = { x: 0, y: 0 };
  function hover(e) {
    const [x, y] = pt(e);
    mouse.x = e.clientX; mouse.y = e.clientY;
    underMouse = x > TW && y > RH ? clipAt(x, y) : null;
    if (panning) { cv.style.cursor = 'grabbing'; return; }
    let cur = hand ? 'grab' : 'default', key = hand ? 'hint.pl.pan' : 'hint.pl.grid';
    const row = y >= RH ? rowAt(y) : null;
    const was = hot;
    hot = null;
    if (y < RH) { cur = 'pointer'; key = 'hint.pl.ruler'; }
    else if (x < TW) { cur = 'pointer'; key = row && row.lane ? 'hint.au.head' : 'hint.pl.track'; }
    else if (row && row.lane) {
      const p = pointAt(row, x, y);
      if (p) hot = { lane: row.lane, p };
      cur = drawMode ? 'crosshair' : p ? 'move' : 'pointer';
      key = 'hint.au.lane';
      const v = Auto.value(row.lane.points, tOf(x));
      if (was?.p !== hot?.p) draw();
      cv.style.cursor = cur;
      hint('<b>' + fmtPos(Math.max(0, tOf(x))) + (v != null ? ' · ' + Auto.fmt(row.lane.target, p ? p.v : v) : '') + '</b>  · ' + t(key));
      return;
    }
    else {
      const c = clipAt(x, y);
      if (c) { const cx = xOf(c.t), cw = c.l * ppt; cur = x > cx + cw - 6 || x < cx + 6 ? 'ew-resize' : 'move'; }
      const part = c && !tool && clipPart(c, x, y);
      if (part) { cur = part === 'menu' ? 'pointer' : part === 'gain' ? 'ns-resize' : 'ew-resize'; key = 'hint.cl.' + part; }
      if (tool === 'cut') { cur = 'col-resize'; key = 'hint.pl.cut'; }
      else if (tool === 'mute') { cur = 'pointer'; key = 'hint.pl.mutetool'; }
      else if (tool === 'stretch') key = 'hint.pl.stretch';
    }
    if (was && !hot) draw();
    cv.style.cursor = cur;
    hint((y > RH && x > TW ? '<b>' + fmtPos(Math.max(0, snapFloor(tOf(x)))) + '</b>  · ' : '') + t(key));
  }

  function soloTrack(tr) {
    const tks = S.project.tracks;
    const alone = !tks[tr].mute && tks.every((k, i) => i === tr || k.mute);
    tks.forEach((k, i) => { k.mute = alone ? false : i !== tr; });
  }

  // a click on a track's header: the A box folds its lanes (or adds the first), the rest mutes
  function headDown(e, row, x, y) {
    const tr = row.tr, tk = S.project.tracks[tr];
    curTrack = tr;
    if (row.lane) {
      const l = row.lane, ry = rowY(row);
      if (e.button === 2) return laneMenu(row, e.clientX, e.clientY);
      if (e.button !== 0) return;
      if (x >= TW - 24 && y < ry + 20) return removeLane(l);
      if (x < 26) return history.edit(() => { l.on = !l.on; });
      return chooseTarget(e.clientX, e.clientY, (tg, name) => history.edit(() => {
        const other = Auto.laneOf(tg);
        if (other && other !== l) S.project.automation = S.project.automation.filter(a => a !== other);
        l.target = tg; l.name = name || '';
      }));
    }
    const has = (S.project.automation || []).some(l => l.track === tr);
    const ry = rowY(row);
    if (e.button === 2) {
      return menu(e.clientX, e.clientY, [
        { head: tk.name || t('track', { n: tr + 1 }) },
        { label: t('au.add'), fn: () => addLaneMenu(tr, e.clientX, e.clientY) },
        has && { label: tk.auto ? t('au.hide') : t('au.show'), fn: () => history.edit(() => { tk.auto = !tk.auto; }) },
      ]);
    }
    if (e.button !== 0) return;
    if (x >= TW - AW - 6 && x < TW - 6 && y >= ry + trackH / 2 - 8 && y < ry + trackH / 2 + 8) {
      if (!has) return addLaneMenu(tr, e.clientX, e.clientY);
      return history.edit(() => { tk.auto = !tk.auto; });
    }
    // Ctrl+click: solo (this track alone plays); again, when it already is alone, all back on
    if (e.ctrlKey || e.metaKey) return history.edit(() => soloTrack(tr));
    history.edit(() => { tk.mute = !tk.mute; });
  }

  function down(e) {
    const [x, y] = pt(e);
    e.preventDefault();
    if (e.button === 1 || (hand && e.button === 0 && !(y < RH && e.shiftKey))) return panDown(e, x, y);
    if (y < RH) { if (x > TW) rulerDown(e, x); return; }
    relayout();
    const row = rowAt(y);
    if (!row) return;
    if (x < TW) return headDown(e, row, x, y);
    if (row.lane) return laneDown(e, row, x, y);
    const tr = row.tr;
    curTrack = tr;
    if (e.button === 2) return erase(e);
    if (e.button !== 0) return;
    if (tool === 'cut') return cutDown(e, x, y);
    if (tool === 'mute') return muteDown(e, x, y, tr);
    if (e.ctrlKey || e.metaKey) return bandDown(e, x, y);
    let c = clipAt(x, y), mode = 'move', placed = false;
    // the clip's own handles: its menu, an audio clip's fades and volume
    const part = c && !tool && clipPart(c, x, y);
    if (part === 'menu') return clipMenu(c, e.clientX, e.clientY);
    if (part === 'fadein' || part === 'fadeout') return fadeDrag(e, c, part);
    if (part === 'gain') return gainDrag(e, c, y);
    history.begin();
    if (c) {
      if (!sel.has(c)) sel = new Set([c]);
      const cx = xOf(c.t), cw = c.l * ppt;
      if (x > cx + cw - 6) mode = 'size'; else if (x < cx + 6) mode = 'trim';
      // the stretch tool on an audio clip's edge: the sound speeds up or slows down to fit
      if (tool === 'stretch' && c.ch && mode !== 'move') { mode = mode === 'size' ? 'ssize' : 'strim'; sel = new Set([c]); }
      if (e.shiftKey && mode === 'move') for (const s of sel) S.project.clips.push(cloneClip(s));
    } else {
      const at = Math.max(0, e.altKey ? Math.round(tOf(x)) : snapFloor(tOf(x)));
      const ach = S.placeCh ? chan(S.placeCh) : null;
      if (ach && ach.inst.type === 'audio') c = { p: 0, ch: ach.id, track: tr, t: at, l: audioLen(ach), off: 0 };
      else {
        const p = curPat();
        if (!p) return history.end();
        c = { p: p.id, track: tr, t: at, l: patLen(p), off: 0 };
      }
      S.project.clips.push(c);
      sel = new Set([c]);
      placed = true;
      changed();
    }
    const start = [...sel].map(s => ({ s, t: s.t, l: s.l, off: s.off, track: s.track, rate: s.rate || 1 }));
    const a = start.find(q => q.s === c);
    const minT = Math.min(...start.map(q => q.t)), minTr = Math.min(...start.map(q => q.track)), maxTr = Math.max(...start.map(q => q.track));
    const x0 = x, y0 = y;
    let moved = false;
    drag(e, ev => {
      const [mx, my] = pt(ev);
      if (Math.abs(mx - x0) > 2 || Math.abs(my - y0) > 2) moved = true;
      const raw = (mx - x0) / ppt;
      const round = ev.altKey ? Math.round : snapRound;
      const minL = ev.altKey || snap <= 1 ? 1 : snap;
      // a stretch keeps what the clip plays (l × rate) and changes how long it takes
      const lims = l => clamp(l, Math.max(minL, a.l * a.rate / 20), a.l * a.rate / 0.05);
      if (mode === 'ssize') {
        c.l = Math.round(lims(round(a.t + a.l + raw) - a.t));
        c.rate = a.l * a.rate / c.l;
        hintValue(clipName(c), '×' + c.rate.toFixed(3) + ' · ' + (c.l / BAR).toFixed(2) + ' ' + t('bars'));
        changed();
        return;
      } else if (mode === 'strim') {
        const end = a.t + a.l;
        c.l = Math.round(lims(end - Math.max(0, round(a.t + raw))));
        c.t = end - c.l;
        c.rate = a.l * a.rate / c.l;
        hintValue(clipName(c), '×' + c.rate.toFixed(3) + ' · ' + (c.l / BAR).toFixed(2) + ' ' + t('bars'));
        changed();
        return;
      } else if (mode === 'size') {
        const nl = Math.max(minL, round(a.t + a.l + raw) - a.t);
        // an audio clip does not run past the end of its sound (the wave is not repeated or stretched)
        for (const q of start) q.s.l = Math.min(Math.max(minL, q.l + nl - a.l), soundLeft(q.s, q.l));
      } else if (mode === 'trim') {
        // move the left edge, keep the right edge where it is; an audio clip's offset runs at its rate
        const r = q => q.s.ch ? q.rate : 1;
        let nt = clamp(round(a.t + raw), Math.max(0, a.t - a.off / r(a)), a.t + a.l - minL);
        const d = nt - a.t;
        for (const q of start) { q.s.t = q.t + d; q.s.l = q.l - d; q.s.off = Math.max(0, q.off + d * r(q)); }
      } else {
        const dt = Math.max(round(a.t + raw) - a.t, -minT);
        const dtr = clamp(trackNear(my) - trackNear(y0), -minTr, S.project.tracks.length - 1 - maxTr);
        for (const q of start) { q.s.t = q.t + dt; q.s.track = q.track + dtr; }
      }
      hintValue(clipName(c), fmtPos(c.t) + ' · ' + (c.l / BAR).toFixed(2) + ' ' + t('bars'));
      changed();
    }, () => {
      history.end();
      // a click on a clip picks what it plays (its pattern, or its audio channel), and that is
      // what the next click on empty space places
      if (!moved && !placed && c.ch) Patterns.pickAudio(c.ch);
      else if (!moved && !placed && (c.p !== S.curPat || S.placeCh)) Patterns.select(c.p);
      changed();
    });
  }

  function panDown(e, x, y) {
    const startX = sx, startY = sy;
    panning = true; away = true; tools(); cv.style.cursor = 'grabbing';
    drag(e, ev => {
      const [mx, my] = pt(ev);
      sx = startX - (mx - x); sy = startY - (my - y);
      clampScroll(); draw();
    }, () => { panning = false; cv.style.cursor = hand ? 'grab' : 'default'; });
  }

  // Plain left-click sets the start. Only right-drag or Shift+left-drag select/resize loops.
  function rulerDown(e, x) {
    if (e.button !== 0 && e.button !== 2) return;
    if (e.button === 0 && !e.shiftKey) {
      Transport.seekSong(Math.max(0, e.altKey ? Math.round(tOf(x)) : snapFloor(tOf(x))));
      return;
    }
    const region = S.project.loop_region;
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
      S.project.loop_region = { start, end, enabled: true };
      hintValue(t('pl.loop'), fmtPos(start) + ' – ' + fmtPos(end));
      changed();
    }, () => {
      if (moved) {
        history.end();
        if (!S.playing) Transport.seekSong(S.project.loop_region.start);
      } else if (e.button === 2) loopMenu(e.clientX, e.clientY);
      else Transport.seekSong(Math.max(0, e.altKey ? Math.round(tOf(x)) : snapFloor(tOf(x))));
    });
  }

  function dbl(e) {
    const [x, y] = pt(e);
    const row = y > RH ? rowAt(y) : null;
    if (row && row.lane) {
      // a double-click on a breakpoint deletes it
      const p = x > TW && pointAt(row, x, y);
      if (p) history.edit(() => { row.lane.points = row.lane.points.filter(q => q !== p); });
      return;
    }
    if (x < TW && row) {
      const tr = row.tr, tk = S.project.tracks[tr];
      if (!tk || x >= TW - AW - 6) return;
      const r = cv.getBoundingClientRect();
      renameAt({ left: r.left + 30, top: r.top + yOf(tr) + trackH / 2 - 13, width: TW - 64 }, tk.name, v => history.edit(() => { tk.name = v; }));
      return;
    }
    const c = clipAt(x, y);
    // an audio clip opens its channel's window (the sampler); a pattern clip opens its pattern
    const ach = c && audioChan(c);
    if (ach) { Patterns.pickAudio(ach.id); Chan.open(ach.id); }
    else if (c) { Patterns.select(c.p); Roll.win.show(); }
  }

  // Cuts clip `c` at tick `tk`: it keeps the left part, a copy takes the rest (off moves on, at
  // the clip's rate for audio). Returns the new right part, or null when tk is not inside.
  function splitAt(c, tk) {
    if (tk <= c.t || tk >= c.t + c.l) return null;
    const d = tk - c.t;
    const right = { ...c, t: tk, l: c.l - d, off: c.off + d * (c.ch ? (c.rate || 1) : 1) };
    c.l = d;
    S.project.clips.push(right);
    return right;
  }
  // The cut tool: a click cuts the clip under it; dragging up or down cuts every clip the
  // line crosses, on the grid (Alt: anywhere).
  function cutDown(e, x, y) {
    const at = () => Math.max(0, e.altKey ? Math.round(tOf(x)) : snapRound(tOf(x)));
    cutLine = { t: at(), y0: y, y1: y };
    draw();
    drag(e, ev => { cutLine.y1 = pt(ev)[1]; draw(); }, () => {
      const r0 = trackNear(Math.min(cutLine.y0, cutLine.y1)), r1 = trackNear(Math.max(cutLine.y0, cutLine.y1));
      const tk = cutLine.t;
      cutLine = null;
      history.edit(() => {
        for (const c of S.project.clips.slice()) if (c.track >= r0 && c.track <= r1) splitAt(c, tk);
      });
      draw();
    });
  }
  // The mute tool: a click silences (or brings back) the clip under it, a drag paints that state
  // over the clips it passes; on empty space it mutes the track.
  function muteDown(e, x, y, tr) {
    const c = clipAt(x, y);
    if (!c) { history.edit(() => { S.project.tracks[tr].mute = !S.project.tracks[tr].mute; }); return; }
    history.begin();
    const state = !c.mute;
    const paint = ev => {
      const [mx, my] = pt(ev);
      const k = clipAt(mx, my);
      if (k && k.mute !== state) { k.mute = state; changed(); }
    };
    c.mute = state;
    changed();
    drag(e, paint, () => history.end());
  }

  function erase(e) {
    history.begin();
    const kill = ev => {
      const [x, y] = pt(ev);
      const c = clipAt(x, y);
      if (c) { S.project.clips.splice(S.project.clips.indexOf(c), 1); sel.delete(c); changed(); }
    };
    kill(e);
    drag(e, kill, () => history.end());
  }

  function bandDown(e, x, y) {
    band = { x0: x, y0: y, x1: x, y1: y };
    drag(e, ev => {
      const [mx, my] = pt(ev);
      band.x1 = mx; band.y1 = my;
      const t0 = tOf(Math.min(x, mx)), t1 = tOf(Math.max(x, mx));
      const r0 = trackNear(Math.min(y, my)), r1 = trackNear(Math.max(y, my));
      sel = new Set(S.project.clips.filter(c => c.t + c.l > t0 && c.t < t1 && c.track >= r0 && c.track <= r1));
      draw();
    }, () => { band = null; draw(); });
  }

  function wheel(e) {
    e.preventDefault();
    const [x, y] = pt(e);
    // Alt+wheel over an audio clip: its volume, half a dB a notch (as in FL)
    const over = e.altKey && x > TW && y > RH ? clipAt(x, y) : null;
    if (over && over.ch) {
      history.edit(() => {
        const db = clamp(20 * Math.log10(Math.max(over.gain ?? 1, 1e-4)) + (e.deltaY < 0 ? 0.5 : -0.5) * (e.shiftKey ? 0.2 : 1), -48, 12);
        over.gain = db <= -47.9 ? 0 : Math.pow(10, db / 20);
      });
      hintValue(clipName(over), gainText(over.gain));
      return;
    }
    if (!e.ctrlKey && !e.altKey && (e.shiftKey || e.deltaX)) { away = true; tools(); }
    if (e.ctrlKey) {
      const at = tOf(x);
      ppt = clamp(ppt * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 6 / BAR, 600 / BAR);
      sx = at * ppt - (x - TW);
    } else if (e.altKey) trackH = clamp(trackH + (e.deltaY < 0 ? 4 : -4), 24, 96);
    else if (e.shiftKey) sx += e.deltaY;
    else { sy += e.deltaY; sx += e.deltaX; }
    clampScroll();
    draw();
  }

  function key(e) {
    const k = e.key;
    if (k === 'Home') { Transport.seekSong(0); sx = 0; draw(); return true; }
    if (k === 'End') { Transport.seekSong(songLen()); sx = Math.max(0, songLen() * ppt - (W - TW) * 0.5); draw(); return true; }
    if (k.toLowerCase() === 'l' && !e.ctrlKey && !e.altKey) { toggleLoop(); return true; }
    // Ctrl+Alt+C: pre-render the selected clips (or the one under the mouse); by key position,
    // so it works in any keyboard layout
    if (e.ctrlKey && e.altKey && e.code === 'KeyC') {
      const list = sel.size ? [...sel] : underMouse ? [underMouse] : [];
      if (list.length) preRenderDialog(list, mouse.x, mouse.y);
      return true;
    }
    if ((k === 'Delete' || k === 'Backspace') && sel.size) {
      history.edit(() => { S.project.clips = S.project.clips.filter(c => !sel.has(c)); sel.clear(); });
      return true;
    }
    if (e.ctrlKey && k.toLowerCase() === 'a') { sel = new Set(S.project.clips); draw(); return true; }
    if (e.ctrlKey && k.toLowerCase() === 'd' && sel.size) {
      const t0 = Math.min(...[...sel].map(c => c.t)), t1 = Math.max(...[...sel].map(c => c.t + c.l));
      history.edit(() => { const add = [...sel].map(c => ({ ...cloneClip(c), t: c.t + (t1 - t0) })); S.project.clips.push(...add); sel = new Set(add); });
      return true;
    }
    return false;
  }

  // timeline tick → client x (for placing several dropped files one after another)
  const xOfTick = tk => cv.getBoundingClientRect().left + xOf(tk);
  return { init, draw, playhead, follow, key, dropAudio, xOfTick, showLane, chooseParam, preRender, makeUnique, placePattern, get win() { return win; } };
})();
