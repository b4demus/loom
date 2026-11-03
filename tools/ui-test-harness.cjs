const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup({ mixer = false, roll = false, knobs = false, plugins = false, channel = false } = {}) {
  const elements = [], storage = new Map(), calls = [];
  let menuItems = [];
  const drawing = new Proxy({ globalAlpha: 1, measureText: text => ({ width: text.length * 6 }) }, { get: (o, k) => k in o ? o[k] : () => {} });
  class Element {
    constructor(tag) {
      this.tag = tag; this.nodeType = 1; this.children = []; this.style = { setProperty() {} }; this.events = {};
      this.clientWidth = 900; this.clientHeight = 400; this.scrollLeft = 0; this.scrollTop = 0;
      this.classes = new Set();
      this.classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name), contains: name => this.classes.has(name) };
      elements.push(this);
    }
    append(...kids) { for (const child of kids) { child.parentElement = this; this.children.push(child); } }
    querySelector(selector) { for (const child of this.children) { if (child.className?.split(' ').includes(selector.slice(1))) return child; const found = child.querySelector?.(selector); if (found) return found; } return null; }
    get firstChild() { return this.children[0]; }
    set innerHTML(value) { this.children = []; }
    setAttribute(key, value) { this[key] = value; }
    addEventListener(type, fn) { (this.events[type] ||= []).push(fn); }
    removeEventListener(type, fn) { this.events[type] = (this.events[type] || []).filter(f => f !== fn); }
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
    getContext() { return drawing; }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(c => c !== this); }
    setPointerCapture() {}
    emit(type, event = {}) {
      const e = { currentTarget: this, target: this, clientX: 0, clientY: 0, button: 0, pointerId: 1, preventDefault() {}, stopPropagation() {}, ...event };
      for (const fn of [...(this.events[type] || [])]) fn(e);
    }
  }
  const dummy = new Element('dummy'); dummy.append({ textContent: '' });
  const document = { createElement: tag => new Element(tag), createElementNS: (ns, tag) => new Element(tag), createTextNode: text => ({ nodeType: 3, textContent: String(text) }), querySelector: () => dummy, querySelectorAll: () => [], body: new Element('body') };
  const context = vm.createContext({
    document, window: { innerWidth: 1600, innerHeight: 900 }, location: { search: '' }, URLSearchParams, performance, setTimeout, clearTimeout,
    requestAnimationFrame() {}, ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() { this.fn(); } },
    localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    WM: { create: () => ({ open: true, show() {}, tools: new Element('tools'), body: new Element('body'), sub: new Element('span') }) },
    menu: (x, y, items) => { menuItems = items.filter(Boolean); },
    // a popup (tool window) closes as widgets.js closes it
    openMenu: null, closeMenu() { const m = context.openMenu; context.openMenu = null; if (m && m._onclose) m._onclose(); },
    knob: () => { const k = new Element('knob'); k.update = () => {}; return k; },
    ...(plugins ? {} : { Plugins: { reset() {} } }), ...(roll ? {} : { Roll: { setPressed() {}, clearSel() {} } }),
  });
  for (const file of ['i18n.js', 'core.js', ...(knobs ? ['widgets.js'] : []), ...(plugins ? ['plugins.js'] : []), 'playlist.js', 'stems.js', ...(roll ? ['roll.js'] : []), 'mixer.js', ...(channel ? ['panels.js'] : []), 'app.js']) {
    const source = fs.readFileSync(path.join(__dirname, '../ui', file), 'utf8');
    const code = file === 'app.js' ? source.replace(/main\(\);\s*$/, '') : file === 'widgets.js'
      ? source.slice(source.indexOf('// ---------- knobs'), source.indexOf('// ---------- popup menu')) : source;
    vm.runInContext(code, context, { filename: file });
  }
  context.toast = () => {};
  vm.runInContext(`
    ${roll ? '' : "const SNAPS = [['bar', BAR], ['step', STEP], ['none', 1]];"}
    api.call = async (cmd, args) => null;
    S.project = normalize(emptyProject());
    ${plugins ? '' : `Object.assign(Plugins, {
      captureStates: async () => {}, desc: pid => S.project.plugins.find(p => p.id === pid),
      nameOf: pid => (S.project.plugins.find(p => p.id === pid) || {}).name || '?', errorOf: () => null,
      collect() { const used = new Set(S.project.mixer.flatMap(m => m.fx.map(f => f.pid))); S.project.plugins = S.project.plugins.filter(p => used.has(p.id)); },
    });`}
    Playlist.init(); ${mixer ? 'Mixer.init();' : ''} ${roll ? 'Roll.init();' : ''} ${channel ? 'Chan.init();' : ''} bus.emit('render');
    globalThis.subject = { S, Playlist, Patterns, Mixer, Transport, Waves, Auto, Stems, Roll: typeof Roll !== 'undefined' ? Roll : null, Midi, api, undo, redo, bus, syncInput, normalize, history, Plugins, kbSnap, Chan: typeof Chan !== 'undefined' ? Chan : null };
  `, context);
  return { ...context.subject, cv: elements.find(e => e.tag === 'canvas'), elements, calls, getMenu: () => menuItems };
}


module.exports = { setup };
