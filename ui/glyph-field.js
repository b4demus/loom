// Glyph AsciiField without React: sparse ASCII particles drifting under the whole window.
// Same algorithm and fixed values as the design system (density 0.05, speed 0.2).
// Cheap to run: glyphs come from a pre-rendered atlas, only the cells glyphs touched are
// wiped each frame, the canvas is capped at 1.5x and the loop stops whenever it is not seen.
function GlyphField(el) {
  const DENSITY = 0.05, SPEED = 0.2, ACCENT_RATE = 0.02, R = 84;
  const RAMP = ['·', '-', '-', '=', '-', '=', '—', '=', '≡', '■'];
  const GLYPHS = RAMP.concat('0123456789'.split('')), G = GLYPHS.length;
  const CELL_W = 7.2, CELL_H = 12;

  const hash = (i, j) => { const x = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return x - Math.floor(x); };
  function vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  const smooth = (e0, e1, x) => { const k = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return k * k * (3 - 2 * k); };

  const c = el.querySelector('canvas'), ctx = c.getContext('2d');
  const atlas = document.createElement('canvas'), actx = atlas.getContext('2d');
  let dpr = 1, gw = 0, gh = 0, span = 0, parts = [], drawn = new Float32Array(0), nDrawn = 0;
  let raf = 0, last = 0, t = 0, running = false, paused = false, visible = true;
  const rect = { left: 0, top: 0 }, mouse = { x: -1e4, y: -1e4 };
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function buildAtlas() {
    const s = getComputedStyle(el);
    const tones = [s.getPropertyValue('--ink-faint').trim() || '#4a4744', s.getPropertyValue('--ink-muted').trim() || '#9a958c', s.getPropertyValue('--accent').trim() || '#bb7463'];
    atlas.width = gw * G; atlas.height = gh * 3;
    actx.setTransform(dpr, 0, 0, dpr, 0, 0);
    actx.font = '12px ' + (s.getPropertyValue('--font-mono').trim() || 'monospace');
    actx.textBaseline = 'top';
    for (let k = 0; k < 3; k++) {
      actx.fillStyle = tones[k];
      for (let g = 0; g < G; g++) actx.fillText(GLYPHS[g], (g * gw) / dpr + 1, (k * gh) / dpr + 1);
    }
  }
  function resize() {
    // 1.5x is crisp enough for faint background glyphs and halves the fill cost of a 2x screen
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const W = el.clientWidth, H = el.clientHeight;
    const b = el.getBoundingClientRect(); rect.left = b.left; rect.top = b.top;
    c.width = Math.max(1, Math.round(W * dpr)); c.height = Math.max(1, Math.round(H * dpr));
    gw = Math.ceil((CELL_W + 2) * dpr); gh = Math.ceil((CELL_H + 2) * dpr);
    buildAtlas();
    const cols = Math.ceil(W / CELL_W) + 1, rows = Math.ceil(H / CELL_H), rate = DENSITY * 0.5;
    span = cols * CELL_W;
    // every cell gets the same chance, so the field is equally sparse top to bottom
    parts = [];
    for (let r = 0; r < rows; r++) {
      const drift = (hash(r, 7) - 0.5) * 12; // cells per unit of t; each row drifts its own way
      for (let col = 0; col < cols; col++) {
        if (Math.random() >= rate) continue;
        const q = Math.random();
        parts.push({
          x: col * CELL_W, y: r * CELL_H, drift, clock: Math.random() * 1000,
          g: q < 0.12 ? RAMP.length + Math.floor(Math.random() * 10) : Math.floor(Math.pow(Math.random(), 1.8) * RAMP.length),
          tone: q > 1 - ACCENT_RATE ? 2 : q > 0.88 ? 1 : 0,
        });
      }
    }
    drawn = new Float32Array(parts.length * 2); nDrawn = 0;
    ctx.clearRect(0, 0, c.width, c.height);
    draw();
  }
  function draw() {
    // the field is ~2% glyphs: wipe only where glyphs were, not the whole screen
    for (let j = 0; j < nDrawn; j++) ctx.clearRect(drawn[j * 2], drawn[j * 2 + 1], gw, gh);
    nDrawn = 0;
    const R2 = R * R;
    for (const p of parts) {
      // each glyph fades in and out on its own clock
      let a = smooth(0.35, 0.75, vnoise(p.clock, t * 1.5));
      if (a < 0.02) continue;
      const x = ((p.x + p.drift * CELL_W * t) % span + span) % span - CELL_W;
      let tone = p.tone;
      const dx = x - mouse.x, dy = p.y - mouse.y, d2 = dx * dx + dy * dy;
      if (d2 < R2) { const d = Math.sqrt(d2) / R; a *= d * d; if (d > 0.8) tone = 2; if (a < 0.02) continue; }
      const px = Math.round(x * dpr) - 1, py = Math.round(p.y * dpr) - 1;
      ctx.globalAlpha = a * 0.55;
      ctx.drawImage(atlas, p.g * gw, tone * gh, gw, gh, px, py, gw, gh);
      drawn[nDrawn * 2] = px; drawn[nDrawn * 2 + 1] = py; nDrawn++;
    }
    ctx.globalAlpha = 1;
  }
  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (now - last < 33) return; // ~30 fps is plenty for a drift of a few pixels a second
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0.033;
    last = now; t += dt * SPEED;
    draw();
  }
  // the loop runs only while the window is shown, the field is on screen and the page is visible
  function sync() {
    const want = !still && !paused && visible && !document.hidden;
    if (want && !running) { running = true; last = 0; raf = requestAnimationFrame(frame); }
    else if (!want && running) { running = false; cancelAnimationFrame(raf); }
  }
  function recolor() { buildAtlas(); ctx.clearRect(0, 0, c.width, c.height); nDrawn = 0; draw(); }

  new ResizeObserver(resize).observe(el);
  resize();
  new IntersectionObserver(es => { visible = es[0].isIntersecting; sync(); }).observe(el);
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('pointermove', e => { mouse.x = e.clientX - rect.left; mouse.y = e.clientY - rect.top; if (still) draw(); }, { passive: true });
  document.addEventListener('pointerleave', () => { mouse.x = mouse.y = -1e4; });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(recolor);
  sync();

  return {
    // The window can be hidden to the tray without the page noticing: the app says so.
    pause(on) { paused = on; sync(); },
    // Theme switches should not wait for the next frame.
    recolor,
  };
}
