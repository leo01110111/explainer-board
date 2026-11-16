'use strict';

const ERRORS = [];
for (const k of ['warn', 'error']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { ERRORS.push(k + ': ' + a.map(String).join(' ')); document.body && (document.body.dataset.errors = ERRORS.length); orig(...a); };
}
window.addEventListener('error', (e) => { ERRORS.push('uncaught: ' + e.message); document.body.dataset.errors = ERRORS.length; });
window.boardErrors = ERRORS;

const W = 1600, H = 900;
const PALETTE = {
  teal: '#5CD0B3', blue: '#58C4DD', yellow: '#F4D35E', orange: '#FF8C42', red: '#FC6255',
  green: '#83C167', gray: '#8A8A9A', grey: '#8A8A9A', white: '#ECECF0', black: '#1c1c28',
  purple: '#B48EF0', pink: '#F08EC0',
};
const BG = '#1c1c28';
const REGIONS = {
  full: { x: 90, y: 122, w: 1420, h: 748 },
  left: { x: 70, y: 122, w: 710, h: 748 },
  right: { x: 830, y: 122, w: 700, h: 748 },
  top: { x: 90, y: 122, w: 1420, h: 360 },
  bottom: { x: 90, y: 500, w: 1420, h: 370 },
};
const GAP = 26;
const BEAT_PAUSE = 0.8;
const DEFAULT_DUR = 0.8;

const $ = (id) => document.getElementById(id);
function mk(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}
const SVGNS = 'http://www.w3.org/2000/svg';
function mks(tag, attrs, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

const _cc = document.createElement('canvas').getContext('2d');
const _colorCache = {};
function rgb(c) {
  if (Array.isArray(c)) return c;
  const key = String(c);
  if (_colorCache[key]) return _colorCache[key];
  _cc.fillStyle = '#000';
  _cc.fillStyle = PALETTE[key] || key;
  const s = _cc.fillStyle;
  let r = [255, 255, 255];
  if (s[0] === '#') r = [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  else {
    const m = s.match(/[\d.]+/g);
    if (m) r = m.slice(0, 3).map(Number);
  }
  return (_colorCache[key] = r);
}
const cssc = (c) => { const r = rgb(c); return `rgb(${r[0] | 0},${r[1] | 0},${r[2] | 0})`; };
const lerpColor = (a, b, t) => { const x = rgb(a), y = rgb(b); return [lerp(x[0], y[0], t), lerp(x[1], y[1], t), lerp(x[2], y[2], t)]; };

// ---------- TeX helpers ----------
function tex(el, s, display) {
  try {
    katex.render(String(s), el, { displayMode: !!display, throwOnError: false, strict: false });
  } catch (e) {
    el.textContent = s;
  }
}
function mixed(el, s) {
  el.textContent = '';
  const parts = String(s).split(/(\$[^$]+\$)/);
  for (const p of parts) {
    if (!p) continue;
    if (p.length > 2 && p[0] === '$' && p[p.length - 1] === '$') {
      const sp = mk('span', null, el);
      tex(sp, p.slice(1, -1), false);
    } else el.appendChild(document.createTextNode(p));
  }
}
function looksTeX(s) {
  s = String(s);
  if (s.includes('$')) return false;
  if (/[\\^_{}]/.test(s)) return true;
  return s.length <= 8 && !/[A-Za-z]{2,}/.test(s) && !/[^\x20-\x7e]/.test(s);
}
function label(el, s) {
  if (looksTeX(s)) { tex(el, s, false); return true; }
  mixed(el, s);
  return false;
}

// ---------- expressions ----------
function lgamma(x) {
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
const HELPERS = {
  lgamma,
  gammaFn: (x) => Math.exp(lgamma(x)),
  normpdf: (x, mu = 0, s = 1) => Math.exp(-0.5 * ((x - mu) / s) ** 2) / (s * Math.sqrt(2 * Math.PI)),
  chi2pdf: (x, k) => (x <= 0 ? 0 : Math.exp((k / 2 - 1) * Math.log(x) - x / 2 - (k / 2) * Math.log(2) - lgamma(k / 2))),
};
const _fnCache = {};
function compile(expr, arg) {
  const key = arg + '|' + expr;
  if (_fnCache[key]) return _fnCache[key];
  let f;
  try {
    const raw = new Function('H', arg, `with (Math) { with (H) { return (${expr}); } }`);
    f = (v) => { try { return +raw(HELPERS, v); } catch (e) { return NaN; } };
  } catch (e) {
    console.warn('bad expression', expr, e);
    f = () => NaN;
  }
  return (_fnCache[key] = f);
}

// ---------- seeded random ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
class RNG {
  constructor(seed) { this.u = mulberry32((seed * 2654435761) ^ 0x9E3779B9); this.spare = null; }
  uniform() { let v = this.u(); while (v === 0) v = this.u(); return v; }
  normal() {
    if (this.spare !== null) { const s = this.spare; this.spare = null; return s; }
    const u1 = this.uniform(), u2 = this.uniform();
    const r = Math.sqrt(-2 * Math.log(u1));
    this.spare = r * Math.sin(2 * Math.PI * u2);
    return r * Math.cos(2 * Math.PI * u2);
  }
  gamma(k) {
    if (k < 1) return this.gamma(k + 1) * Math.pow(this.uniform(), 1 / k);
    const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x, v;
      do { x = this.normal(); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      const u = this.uniform();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }
  chi2(d, exact) {
    if (!exact) return 2 * this.gamma(d / 2);
    let s = 0;
    for (let i = 0; i < d; i++) { const z = this.normal(); s += z * z; }
    return s;
  }
}
const _genCache = {};
function generate(g) {
  const key = JSON.stringify(g);
  if (_genCache[key]) return _genCache[key];
  const n = g.n ?? 2000, d = g.d ?? 1, rng = new RNG(g.seed ?? 0);
  const exact = d * n <= 2e6;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    switch (g.kind) {
      case 'dist': out[i] = Math.sqrt(2 * rng.chi2(d, exact)); break;
      case 'dist_scaled': out[i] = Math.sqrt(rng.chi2(d, exact) / d); break;
      case 'S': out[i] = 2 * rng.chi2(d, exact); break;
      case 'S_scaled': out[i] = rng.chi2(d, exact) / d; break;
      case 'D2': { const z = rng.normal(); out[i] = 2 * z * z; break; }
      case 'gauss2d': { const s = g.sigma ?? 1; out[i] = [s * rng.normal(), s * rng.normal()]; break; }
      case 'rayleigh': { const a = rng.normal(), b = rng.normal(); out[i] = Math.sqrt(2 * (a * a + b * b)); break; }
      default: console.warn('unknown generator', g.kind); out[i] = 0;
    }
  }
  return (_genCache[key] = out);
}

// ---------- clock / animation ----------
const clock = {
  acc: 0, since: null, running: false,
  now() { return this.acc + (this.running ? (performance.now() - this.since) / 1000 : 0); },
  start() { if (!this.running) { this.since = performance.now(); this.running = true; } },
  stop() { if (this.running) { this.acc = this.now(); this.running = false; } },
};
const anim = {
  tweens: [], events: [], instant: false,
  tween(dur, fn, done, key) {
    if (key) {
      const old = this.tweens.find((t) => t.key === key);
      if (old) old.dead = true;
    }
    if (this.instant || !(dur > 0)) { fn(1); if (done) done(); return; }
    fn(0);
    this.tweens.push({ start: clock.now(), dur, fn, done, key });
  },
  at(time, fn) {
    const e = { time, fn };
    let i = this.events.length;
    while (i > 0 && this.events[i - 1].time > time) i--;
    this.events.splice(i, 0, e);
  },
  reset() { this.tweens = []; this.events = []; },
  step() {
    const t = clock.now();
    while (this.events.length && this.events[0].time <= t) this.events.shift().fn();
    const list = this.tweens;
    this.tweens = [];
    for (const tw of list) {
      if (tw.dead) continue;
      const p = clamp((t - tw.start) / tw.dur, 0, 1);
      tw.fn(p);
      if (p >= 1) { tw.dead = true; if (tw.done) tw.done(); } else this.tweens.push(tw);
    }
    this.tweens = this.tweens.filter((tw) => !tw.dead);
  },
};

// ---------- board ----------
const board = {
  objs: new Map(), dying: new Set(), plots: new Map(), layout: 'full', scene: null, hiddenRows: {},
  root: null, titleEl: null, titleText: '',
};

function resetBoard(scene) {
  anim.reset();
  board.root.textContent = '';
  board.objs.clear(); board.dying.clear(); board.plots.clear();
  board.titleEl.textContent = ''; board.titleText = '';
  board.scene = scene;
  board.layout = scene.layout || 'full';
  board.hiddenRows = {};
  for (const b of scene.beats || [])
    for (const op of b.do || [])
      if (op.op === 'show_row') (board.hiddenRows[op.id] = board.hiddenRows[op.id] || new Set()).add(op.row);
}

function defaultRegion() { return board.layout === 'split' ? 'left' : board.layout === 'stack' ? 'top' : 'full'; }
function regionOf(op) { return REGIONS[op.region] ? op.region : defaultRegion(); }
function sizeFactor(s) {
  if (s == null) return 1;
  if (typeof s === 'string') return { small: 0.75, normal: 1, large: 1.3, huge: 1.6 }[s] || 1;
  return s <= 5 ? s : s / 34;
}

function setTitle(text, dur) {
  text = text || '';
  if (text === board.titleText) return;
  board.titleText = text;
  const olds = [...board.titleEl.children];
  for (const o of olds) anim.tween(dur * 0.5, (p) => { o.style.opacity = 1 - p; }, () => o.remove());
  if (!text) return;
  const t = mk('div', 't', board.titleEl);
  mixed(t, text);
  const w = t.offsetWidth, maxW = 1500;
  const s = w > maxW ? maxW / w : 1;
  t.style.transform = `scale(${s})`;
  anim.tween(dur, (p) => { t.style.opacity = p; });
}

function posObj(o) {
  o.el.style.transform = `translate(${o.x}px,${o.y}px) scale(${o.s})`;
}

function measure(o) {
  return { w: o.inner.offsetWidth, h: o.inner.offsetHeight };
}

function relayout(dur) {
  const byRegion = {};
  for (const o of board.objs.values()) (byRegion[o.region] = byRegion[o.region] || []).push(o);
  for (const rname in byRegion) {
    const R = REGIONS[rname];
    const list = byRegion[rname].sort((a, b) => a.ord - b.ord);
    const flows = list.filter((o) => o.kind !== 'plot');
    const plots = list.filter((o) => o.kind === 'plot');
    const align = rname === 'left' || rname === 'right' ? 'left' : 'center';
    const sizes = flows.map((o) => {
      const m = measure(o);
      const px = o.boxed ? 20 : 0, py = o.boxed ? 14 : 0;
      return { w: m.w + 2 * px, h: m.h + 2 * py, px, py };
    });
    const colH = sizes.reduce((a, s) => a + s.h, 0) + GAP * Math.max(0, sizes.length - 1);
    const tops = plots.filter((p) => p.slot === 'top'), bots = plots.filter((p) => p.slot === 'bottom');
    const fills = plots.filter((p) => p.slot !== 'top' && p.slot !== 'bottom');
    const k = tops.length + bots.length;
    let fixedH = 0;
    if (k) {
      if (!flows.length && !fills.length) fixedH = (R.h - GAP * (k - 1)) / k;
      else if (k === 1 && !fills.length) fixedH = clamp(R.h - colH - 2 * GAP, 0.46 * R.h, 0.58 * R.h);
      else fixedH = k === 1 ? 0.58 * R.h : 0.38 * R.h;
    }
    const avail = R.h - k * (fixedH + GAP);
    const textMax = fills.length ? (flows.length ? 0.42 * avail : 0) : avail;
    const s = flows.length ? Math.min(1, textMax / colH) : 1;
    let y = R.y;
    const place = (p, h) => setPlotRect(p, { x: R.x, y, w: R.w, h }, dur);
    for (const p of tops) { place(p, fixedH); y += fixedH + GAP; }
    for (let i = 0; i < flows.length; i++) {
      const o = flows[i], sz = sizes[i];
      const si = Math.min(s, R.w / sz.w);
      const tx = (align === 'left' ? R.x : R.x + (R.w - sz.w * si) / 2) + sz.px * si;
      const ty = y + sz.py * si + (sz.h * (s - si)) / 2;
      moveObj(o, tx, ty, si, dur);
      y += sz.h * s + GAP * s;
    }
    if (flows.length) y += GAP * (1 - s);
    const botTop = R.y + R.h - bots.length * (fixedH + GAP) + GAP;
    if (fills.length) {
      const fh = (botTop - GAP - y - GAP * (fills.length - 1)) / fills.length;
      for (const p of fills) { place(p, Math.max(fh, 60)); y += fh + GAP; }
    }
    let yb = botTop;
    for (const p of bots) { setPlotRect(p, { x: R.x, y: yb, w: R.w, h: fixedH }, dur); yb += fixedH + GAP; }
  }
}

function moveObj(o, x, y, s, dur) {
  if (!o.placed || dur <= 0 || anim.instant) {
    o.x = x; o.y = y; o.s = s; o.placed = true; posObj(o);
    anim.tween(0, () => {}, null, o.id + ':pos');
    return;
  }
  const x0 = o.x, y0 = o.y, s0 = o.s;
  if (Math.abs(x0 - x) + Math.abs(y0 - y) + Math.abs(s0 - s) < 0.01) return;
  anim.tween(dur, (p) => {
    const q = smooth(p);
    o.x = lerp(x0, x, q); o.y = lerp(y0, y, q); o.s = lerp(s0, s, q); posObj(o);
  }, null, o.id + ':pos');
}

let ordCounter = 0;
function newObj(op, kind) {
  const old = board.objs.get(op.id);
  if (old) killObj(old, 0);
  const o = {
    id: op.id, kind, region: regionOf(op), ord: ordCounter++, x: 0, y: 0, s: 1, placed: false,
    color: op.color || 'white', boxed: false,
  };
  o.el = mk('div', 'obj ' + kind, board.root);
  o.inner = mk('div', 'inner', o.el);
  o.el.style.color = cssc(o.color);
  o.el.style.opacity = 0;
  board.objs.set(op.id, o);
  return o;
}

function fillContent(o, op, c) {
  c.textContent = '';
  const f = sizeFactor(op.size ?? o.size);
  if (op.size != null) o.size = op.size;
  c.style.fontSize = f !== 1 ? `${34 * f}px` : '';
  if (o.kind === 'math') {
    const m = mk('span', 'm', c);
    tex(m, op.tex ?? op.text ?? '', true);
    const lab = op.label !== undefined ? op.label : o.labelText;
    o.labelText = lab;
    if (lab) { const l = mk('span', 'label', c); l.textContent = lab; }
  } else {
    const t = mk('span', 't', c);
    if (op.text == null && op.tex != null) tex(t, op.tex, false);
    else mixed(t, op.text ?? '');
    const lab = op.label !== undefined ? op.label : o.labelText;
    o.labelText = lab;
    if (lab) { const l = mk('span', 'label', c); l.textContent = lab; }
  }
}

function wipeIn(el, dur, fadeEl) {
  anim.tween(dur, (p) => {
    const q = smooth(p);
    el.style.clipPath = p >= 1 ? '' : `inset(-60px ${(1 - q) * 100}% -60px -60px)`;
    (fadeEl || el).style.opacity = Math.min(1, p * 2.5);
  });
}

function opFlow(op, kind, dur) {
  const o = newObj(op, kind);
  o.content = mk('div', 'content', o.inner);
  fillContent(o, op, o.content);
  relayout(Math.min(dur, 0.6));
  o.el.style.opacity = 1;
  wipeIn(o.inner, dur);
}

function opTable(op, dur) {
  const o = newObj(op, 'table');
  o.content = mk('div', 'content', o.inner);
  const t = mk('table', 'tbl', o.content);
  const hidden = board.hiddenRows[op.id] ? true : false;
  o.rows = [];
  (op.rows || []).forEach((row, i) => {
    const tr = mk('tr', op.header && i === 0 ? 'head' : '', t);
    for (const cell of row) {
      const td = mk(op.header && i === 0 ? 'th' : 'td', null, tr);
      tex(td, cell, false);
    }
    tr.style.opacity = hidden ? 0 : 1;
    o.rows.push(tr);
  });
  relayout(Math.min(dur, 0.6));
  anim.tween(dur, (p) => { o.el.style.opacity = p; });
}

function opShowRow(op, dur) {
  const o = board.objs.get(op.id);
  if (!o || !o.rows) return;
  const tr = o.rows[op.row];
  if (!tr) return;
  anim.tween(dur, (p) => { tr.style.opacity = smooth(p); tr.style.transform = `translateY(${(1 - smooth(p)) * 10}px)`; });
}

function itemPartial(op) {
  const { op: _o, id: _i, at: _a, dur: _d, ...rest } = op;
  return rest;
}

function opReplace(op, dur) {
  const o = board.objs.get(op.id);
  if (!o) { const it = findItem(op.id); if (it) return updateItems(it.plot, { [op.id]: itemPartial(op) }, dur); return; }
  if (o.kind === 'plot' || o.kind === 'table') return;
  const old = o.content;
  old.classList.add('old');
  o.content = mk('div', 'content', o.inner);
  o.inner.insertBefore(o.content, old);
  if (op.color) { o.color = op.color; o.el.style.color = cssc(op.color); }
  if (o.kind === 'math' && op.tex == null && op.text != null) op = { ...op, tex: op.text };
  fillContent(o, op, o.content);
  o.content.style.opacity = 0;
  relayout(Math.min(dur, 0.6));
  anim.tween(dur, (p) => {
    const q = smooth(p);
    old.style.opacity = 1 - q;
    o.content.style.opacity = q;
  }, () => old.remove());
}

function opHighlight(op, dur) {
  const o = board.objs.get(op.id);
  const c = op.color || 'yellow';
  if (!o) {
    const it = findItem(op.id);
    if (it) anim.tween(dur, (p) => { it.item.flash = Math.sin(Math.PI * p); it.plot.dirty = true; });
    return;
  }
  const ol = mk('div', 'outline', o.inner);
  ol.style.color = cssc(c);
  ol.style.opacity = 0;
  anim.tween(Math.max(dur, 0.6), (p) => {
    const a = Math.sin(Math.PI * p);
    ol.style.opacity = a;
    o.inner.style.transform = `scale(${1 + 0.06 * a})`;
  }, () => { ol.remove(); o.inner.style.transform = ''; });
}

function opBox(op, dur) {
  const o = board.objs.get(op.id);
  if (!o || o.kind === 'plot') return;
  if (o.boxEl) o.boxEl.remove();
  o.boxed = true;
  const b = mk('div', 'box', o.inner);
  b.style.color = cssc(op.color || 'yellow');
  o.boxEl = b;
  relayout(Math.min(dur, 0.5));
  anim.tween(dur, (p) => {
    const q = smooth(p);
    b.style.opacity = q;
    b.style.transform = `scale(${1.12 - 0.12 * q})`;
  });
}

function opColor(op, dur) {
  const o = board.objs.get(op.id);
  if (!o) { const it = findItem(op.id); if (it) updateItems(it.plot, { [op.id]: { color: op.color } }, dur); return; }
  if (o.kind === 'plot') return;
  const c0 = o.color, c1 = op.color;
  o.color = c1;
  anim.tween(dur, (p) => { o.el.style.color = cssc(lerpColor(c0, c1, smooth(p))); });
}

function killObj(o, dur) {
  board.objs.delete(o.id);
  board.dying.add(o);
  const a0 = parseFloat(o.el.style.opacity || '1');
  anim.tween(dur, (p) => { o.el.style.opacity = a0 * (1 - p); }, () => { o.el.remove(); board.dying.delete(o); });
  if (o.kind === 'plot' && board.plots.get(o.id) === o.plot) board.plots.delete(o.id);
}

function opRemove(op, dur) {
  for (const id of op.ids || (op.id ? [op.id] : [])) {
    const o = board.objs.get(id);
    if (o) { killObj(o, dur); continue; }
    const it = findItem(id);
    if (it) removeItem(it.plot, it.item, dur);
  }
  relayout(Math.min(dur, 0.6));
}

function opClear(op, dur) {
  for (const o of [...board.objs.values()]) if (!op.region || o.region === op.region) killObj(o, dur);
  relayout(0);
}

// ---------- plots ----------
const ITEM_DEFAULTS = {
  curve: { color: 'yellow', width: 4, opacity: 1 },
  hist: { color: 'teal', opacity: 0.8, bins: 40, norm: 'density' },
  points: { color: 'blue', size: 3, opacity: 0.8 },
  point: { color: 'yellow', size: 7, opacity: 1 },
  line: { color: 'white', width: 3, opacity: 1 },
  arrow: { color: 'white', width: 3, opacity: 1 },
  vline: { color: 'yellow', width: 3, opacity: 1 },
  circle: { color: 'teal', width: 3, opacity: 1 },
  ring: { color: 'teal', opacity: 0.35 },
  rect: { color: 'yellow', opacity: 0.3 },
  band: { color: 'teal', opacity: 0.3 },
  walks: { color: 'teal', width: 2, opacity: 0.75, n: 1, steps: 100, gen: 'chi1x2-2' },
  note: { color: 'white', opacity: 1 },
};
const ITEM_DUR = { hist: 1.4, walks: 1.8, points: 1.2, curve: 1.2, band: 1.0 };

function findItem(id) {
  for (const P of board.plots.values()) {
    const item = P.items.find((i) => i.id === id && !i.removing);
    if (item) return { plot: P, item };
  }
  return null;
}

function opPlot(op, dur) {
  const o = newObj(op, 'plot');
  o.inner.remove();
  o.el.className = 'plot';
  o.el.style.color = '';
  o.slot = op.slot || 'fill';
  const P = {
    id: op.id, o, el: o.el, rect: { x: 0, y: 0, w: 400, h: 300 },
    xr: (op.x || [0, 1]).slice(), yr: (op.y || [0, 1]).slice(),
    xticks: op.xticks || null, yticks: op.yticks || null, xlabel: op.xlabel || null, ylabel: op.ylabel || null,
    grid: !!op.grid, equal: !!op.equal, axes: op.axes !== false, items: [], axisP: 0, dirty: true,
  };
  o.plot = P;
  P.svg = mks('svg', {}, o.el);
  P.gGrid = mks('g', {}, P.svg);
  P.gAxes = mks('g', {}, P.svg);
  const cid = 'clip_' + op.id.replace(/[^\w-]/g, '_') + '_' + o.ord;
  const defs = mks('defs', {}, P.svg);
  const cp = mks('clipPath', { id: cid }, defs);
  P.clipRect = mks('rect', {}, cp);
  P.gItems = mks('g', { 'clip-path': `url(#${cid})` }, P.svg);
  P.ovl = mk('div', 'ovl', o.el);
  P.axLabels = [];
  board.plots.set(op.id, P);
  if (!op.y) autoY(P, op.items || []);
  relayout(Math.min(dur, 0.6));
  o.el.style.opacity = 1;
  const items = op.items || [];
  const total = dur;
  const axDur = items.length ? Math.min(0.8, total * 0.3) : total;
  anim.tween(axDur, (p) => { P.axisP = smooth(p); P.dirty = true; });
  addItems(P, items, total - axDur, axDur);
  renderPlot(P);
}

function autoY(P, items) {
  let m = 0;
  for (const s of items) {
    const it = makeItem(P, s);
    if (it.type === 'hist') m = Math.max(m, ...it.data.h);
    if (it.type === 'curve') {
      const f = compile(it.params.fn, 'x'), r = it.params.range || P.xr;
      for (let i = 0; i <= 100; i++) { const v = f(lerp(r[0], r[1], i / 100)); if (isFinite(v)) m = Math.max(m, v); }
    }
  }
  if (m > 0) P.yr = [0, m * 1.12];
}

function itemDur(spec) { return ITEM_DUR[spec.type] || 0.7; }

function addItems(P, specs, dur, delay = 0) {
  const weights = specs.map(itemDur);
  const tot = weights.reduce((a, b) => a + b, 0) || 1;
  let t = delay;
  specs.forEach((spec, i) => {
    const it = makeItem(P, spec);
    const d = dur * weights[i] / tot;
    const existing = it.id ? P.items.findIndex((x) => x.id === it.id) : -1;
    if (existing >= 0) removeItem(P, P.items[existing], 0);
    P.items.push(it);
    it.p = 0;
    const startAt = t;
    const go = () => anim.tween(d, (p) => { it.p = it.type === 'hist' || it.type === 'walks' ? p : smooth(p); P.dirty = true; });
    if (anim.instant || startAt <= 0) go();
    else anim.at(clock.now() + startAt, go);
    t += d;
  });
  P.dirty = true;
}

function makeItem(P, spec) {
  const params = { ...(ITEM_DEFAULTS[spec.type] || {}), ...spec };
  const it = { id: spec.id, type: spec.type, params, prev: null, m: 1, p: 1, alpha: 1, flash: 0, data: null, prevData: null };
  derive(it);
  return it;
}

function derive(it) {
  const q = it.params;
  if (it.type === 'hist') {
    const vals = q.gen ? generate(q.gen) : [];
    const bins = Math.max(1, q.bins | 0), r = q.range || [Math.min(...vals), Math.max(...vals)];
    const w = (r[1] - r[0]) / bins;
    const counts = new Array(bins).fill(0);
    for (const v of vals) {
      const b = Math.floor((v - r[0]) / w);
      if (b >= 0 && b < bins) counts[b]++;
      else if (v === r[1]) counts[bins - 1]++;
    }
    const mx = Math.max(1, ...counts);
    const h = counts.map((c) => (q.norm === 'count' ? c : q.norm === 'max1' ? c / mx : c / (vals.length * w)));
    it.data = { a: r[0], w, bins, h };
  } else if (it.type === 'points') {
    let pts = q.pts;
    if (!pts && q.gen) pts = generate(q.gen).map((v) => (Array.isArray(v) ? v : [v, 0]));
    it.data = { pts: pts || [] };
  } else if (it.type === 'walks') {
    const n = q.n | 0, steps = q.steps | 0, seed = q.seed ?? 0;
    const off = q.offset != null ? compile(String(q.offset), 'i') : null;
    const walks = [];
    for (let j = 0; j < n; j++) {
      const rng = new RNG(seed * 1000003 + j);
      const ys = new Float64Array(steps + 1);
      let s = 0;
      ys[0] = off ? off(0) : 0;
      for (let i = 1; i <= steps; i++) {
        const z = rng.normal();
        s += 2 * z * z - 2;
        ys[i] = s + (off ? off(i) : 0);
      }
      walks.push(ys);
    }
    it.data = { walks, steps };
  } else it.data = {};
}

function cur(it, k) {
  const b = it.params[k];
  if (it.m >= 1 || !it.prev || !(k in it.prev)) return b;
  const a = it.prev[k];
  return lerpAny(a, b, smooth(it.m), k);
}
function lerpAny(a, b, t, k) {
  if (k === 'color') return lerpColor(a, b, t);
  if (typeof a === 'number' && typeof b === 'number') return lerp(a, b, t);
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && typeof a[0] === 'number')
    return a.map((v, i) => lerp(v, b[i], t));
  return t < 0.5 ? a : b;
}

function updateItems(P, upd, dur) {
  const entries = Array.isArray(upd) ? upd.map((u) => [u.id, u]) : Object.entries(upd || {});
  for (const [id, partial] of entries) {
    const it = P.items.find((i) => i.id === id && !i.removing);
    if (!it) continue;
    const snap = {};
    for (const k of new Set([...Object.keys(it.params), ...Object.keys(partial)])) snap[k] = cur(it, k);
    it.prev = snap;
    it.prevData = it.data;
    it.prevFn = it.type === 'curve' ? compile(String(snap.fn), 'x') : null;
    it.prevLo = it.type === 'band' ? [compile(String(snap.fn_lo), 'x'), compile(String(snap.fn_hi), 'x')] : null;
    const { op, id: _i, type, dur: _d, ...rest } = partial;
    it.params = { ...it.params, ...rest };
    if (it.labelEl && 'label' in rest) { it.labelEl.remove(); it.labelEl = null; }
    if (it.noteEl && 'tex' in rest) { it.noteEl.remove(); it.noteEl = null; }
    derive(it);
    it.chain = undefined;
    it.p = 1;
    it.m = 0;
    anim.tween(dur, (p) => { it.m = p; P.dirty = true; }, () => { it.m = 1; it.prev = null; it.prevData = null; P.dirty = true; }, 'm:' + P.id + ':' + id);
  }
}

function removeItem(P, it, dur) {
  it.removing = true;
  anim.tween(dur, (p) => { it.alpha = 1 - p; P.dirty = true; }, () => {
    if (it.g) it.g.remove();
    if (it.labelEl) it.labelEl.remove();
    if (it.noteEl) it.noteEl.remove();
    P.items = P.items.filter((x) => x !== it);
  });
}

function opAdd(op, dur) {
  const P = board.plots.get(op.id);
  if (!P) return console.warn('add: no plot', op.id);
  addItems(P, op.items || [], dur);
}

function opUpdate(op, dur) {
  const P = board.plots.get(op.id);
  if (!P) {
    const it = findItem(op.id);
    if (it) updateItems(it.plot, { [op.id]: itemPartial(op) }, dur);
    return;
  }
  for (const k of ['xlabel', 'ylabel', 'grid', 'equal']) if (k in op) { P[k] = op[k]; P.axLabelsDirty = true; }
  if (op.x || op.y) {
    const x0 = P.xr.slice(), y0 = P.yr.slice(), x1 = op.x || x0, y1 = op.y || y0;
    if (op.x) { P.xticks = op.xticks || null; P.xticksFrom = null; }
    anim.tween(dur, (p) => {
      const q = smooth(p);
      P.xr = [lerp(x0[0], x1[0], q), lerp(x0[1], x1[1], q)];
      P.yr = [lerp(y0[0], y1[0], q), lerp(y0[1], y1[1], q)];
      P.dirty = true;
    }, null, 'r:' + P.id);
  }
  if ('xticks' in op && !op.x) P.xticks = op.xticks;
  if ('yticks' in op) P.yticks = op.yticks;
  if (op.items) updateItems(P, op.items, dur);
  P.dirty = true;
}

function setPlotRect(o, r, dur) {
  const P = o.plot;
  if (!o.placed || dur <= 0 || anim.instant) {
    P.rect = { ...r }; o.placed = true; P.dirty = true;
    anim.tween(0, () => {}, null, o.id + ':pos');
    return;
  }
  const r0 = { ...P.rect };
  if (Math.abs(r0.x - r.x) + Math.abs(r0.y - r.y) + Math.abs(r0.w - r.w) + Math.abs(r0.h - r.h) < 0.5) return;
  anim.tween(dur, (p) => {
    const q = smooth(p);
    P.rect = { x: lerp(r0.x, r.x, q), y: lerp(r0.y, r.y, q), w: lerp(r0.w, r.w, q), h: lerp(r0.h, r.h, q) };
    P.dirty = true;
  }, null, o.id + ':pos');
}

function niceTicks(a, b, n = 6) {
  const span = b - a;
  if (!(span > 0)) return [a];
  const raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
  const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(a / step - 1e-9) * step; v <= b + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}
function fmtNum(v) {
  if (Math.abs(v) < 1e-12) return '0';
  let s = parseFloat(Number(v).toPrecision(6)).toString();
  if (Math.abs(v) >= 10000 && Number.isInteger(+s)) s = (+s).toLocaleString('en-US');
  return s.replace('-', '−');
}

function mapping(P) {
  const r = P.rect;
  const hasYAxisLabels = !!(P.yticks || P.ylabel);
  const pad = { l: hasYAxisLabels ? 64 : 16, r: 20, t: 14, b: 44 };
  if (P.xlabel) pad.r = Math.max(20, (P.xlabelW || 0) + 18);
  if (P.ylabel) pad.t = Math.max(14, (P.ylabelH || 0) + 10);
  let ix = pad.l, iy = pad.t, iw = Math.max(10, r.w - pad.l - pad.r), ih = Math.max(10, r.h - pad.t - pad.b);
  const [xa, xb] = P.xr, [yc, yd] = P.yr;
  if (P.equal) {
    const k = Math.min(iw / (xb - xa), ih / (yd - yc));
    const nw = k * (xb - xa), nh = k * (yd - yc);
    ix += (iw - nw) / 2; iy += (ih - nh) / 2; iw = nw; ih = nh;
  }
  const sx = (x) => ix + ((x - xa) / (xb - xa)) * iw;
  const sy = (y) => iy + ih - ((y - yc) / (yd - yc)) * ih;
  return { ix, iy, iw, ih, sx, sy, xa, xb, yc, yd, kx: iw / (xb - xa), ky: ih / (yd - yc) };
}

function renderPlot(P) {
  P.dirty = false;
  const r = P.rect, o = P.o;
  o.el.style.transform = `translate(${r.x}px,${r.y}px)`;
  P.svg.setAttribute('width', r.w);
  P.svg.setAttribute('height', r.h);
  buildAxisLabels(P);
  const M = mapping(P);
  P.clipRect.setAttribute('x', M.ix - 6); P.clipRect.setAttribute('y', M.iy - 6);
  P.clipRect.setAttribute('width', M.iw + 12); P.clipRect.setAttribute('height', M.ih + 12);
  drawAxes(P, M);
  for (const it of P.items) drawItem(P, it, M);
}

function drawAxes(P, M) {
  const a = P.axisP;
  if (!P.axes) { P.gAxes.innerHTML = ''; P.gGrid.innerHTML = ''; return; }
  const xAxisY = M.sy(M.yc <= 0 && M.yd >= 0 ? 0 : M.yc);
  const yCross = M.xa < 0 && M.xb > 0;
  const showY = yCross || P.yticks || P.ylabel;
  const yAxisX = M.sx(yCross ? 0 : M.xa);
  const xt = (P.xticks || niceTicks(M.xa, M.xb, Math.max(3, Math.round(M.iw / 130)))).map((t) => (Array.isArray(t) ? t : [t, null]));
  const ytAuto = niceTicks(M.yc, M.yd, Math.max(3, Math.round(M.ih / 110)));
  const yt = (P.yticks || ytAuto).map((t) => (Array.isArray(t) ? t : [t, null]));
  let g = '';
  if (P.grid) {
    const gx = P.xticks ? niceTicks(M.xa, M.xb, Math.max(3, Math.round(M.iw / 70))) : xt.map((t) => t[0]);
    const gy = niceTicks(M.yc, M.yd, Math.max(3, Math.round(M.ih / 70)));
    const ga = 0.22 * a;
    for (const x of gx) if (x >= M.xa && x <= M.xb) g += `<line x1="${M.sx(x)}" x2="${M.sx(x)}" y1="${M.iy}" y2="${M.iy + M.ih}"/>`;
    for (const y of gy) if (y >= M.yc && y <= M.yd) g += `<line x1="${M.ix}" x2="${M.ix + M.iw}" y1="${M.sy(y)}" y2="${M.sy(y)}"/>`;
    P.gGrid.innerHTML = `<g stroke="rgb(88,196,221)" stroke-opacity="${ga}" stroke-width="1.5">${g}</g>`;
  } else P.gGrid.innerHTML = '';
  let s = `<g stroke="#d8d8e0" stroke-width="2.5" stroke-linecap="round">`;
  s += `<line x1="${M.ix}" y1="${xAxisY}" x2="${M.ix + M.iw * a}" y2="${xAxisY}"/>`;
  if (showY) s += `<line x1="${yAxisX}" y1="${M.iy + M.ih}" x2="${yAxisX}" y2="${M.iy + M.ih - M.ih * a}"/>`;
  s += '</g>';
  let ticks = '', labels = '';
  const fs = 22;
  for (const [v, lab] of xt) {
    if (v < M.xa - 1e-9 || v > M.xb + 1e-9) continue;
    const x = M.sx(v);
    ticks += `<line x1="${x}" x2="${x}" y1="${xAxisY - 6}" y2="${xAxisY + 6}"/>`;
    if (yCross && Math.abs(v) < 1e-12 && showY) continue;
    labels += `<text x="${x}" y="${xAxisY + 32}" text-anchor="middle">${escapeXml(lab ?? fmtNum(v))}</text>`;
  }
  if (showY) {
    for (const [v, lab] of yt) {
      if (v < M.yc - 1e-9 || v > M.yd + 1e-9) continue;
      if (Math.abs(v - (M.yc <= 0 && M.yd >= 0 ? 0 : M.yc)) < 1e-12) continue;
      const y = M.sy(v);
      ticks += `<line x1="${yAxisX - 6}" x2="${yAxisX + 6}" y1="${y}" y2="${y}"/>`;
      if (P.yticks) labels += `<text x="${yAxisX - 14}" y="${y + 7}" text-anchor="end">${escapeXml(lab ?? fmtNum(v))}</text>`;
    }
  }
  s += `<g stroke="#d8d8e0" stroke-width="2" opacity="${a}">${ticks}</g>`;
  s += `<g fill="#c8c8d4" font-family="KaTeX_Main, serif" font-size="${fs}" opacity="${a}" stroke="${BG}" stroke-width="5" stroke-linejoin="round" paint-order="stroke">${labels}</g>`;
  P.gAxes.innerHTML = s;
  for (const e of P.axLabels) {
    e.style.opacity = a;
    const w = e.offsetWidth, h = e.offsetHeight;
    if (e.dataset.k === 'x') {
      e.style.left = `${M.ix + M.iw + 14}px`;
      e.style.top = `${xAxisY - h / 2}px`;
    } else {
      e.style.left = `${yAxisX - w / 2}px`;
      e.style.top = `${M.iy - h - 8}px`;
    }
  }
}

function buildAxisLabels(P) {
  if (!P.axLabelsDirty && P.axLabelsBuilt) return;
  for (const e of P.axLabels) e.remove();
  P.axLabels = [];
  P.xlabelW = 0; P.ylabelH = 0;
  if (P.xlabel) { const e = mk('div', 'axlab', P.ovl); if (!label(e, P.xlabel)) e.classList.add('txt'); e.dataset.k = 'x'; P.axLabels.push(e); P.xlabelW = e.offsetWidth; }
  if (P.ylabel) { const e = mk('div', 'axlab', P.ovl); if (!label(e, P.ylabel)) e.classList.add('txt'); e.dataset.k = 'y'; P.axLabels.push(e); P.ylabelH = e.offsetHeight; }
  P.axLabelsBuilt = true; P.axLabelsDirty = false;
}
function escapeXml(s) { return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

const pf = (v) => (isFinite(v) ? clamp(v, -1e5, 1e5).toFixed(2) : '0');

function ensureG(P, it) {
  if (!it.g) {
    it.g = mks('g', {}, P.gItems);
    it.paths = [];
  }
  return it.g;
}
function path(it, i, attrs) {
  let p = it.paths[i];
  if (!p) { p = it.paths[i] = mks('path', {}, it.g); }
  for (const k in attrs) p.setAttribute(k, attrs[k]);
  return p;
}
function trimPaths(it, n) {
  while (it.paths.length > n) it.paths.pop().remove();
}

function drawItem(P, it, M) {
  ensureG(P, it);
  const col = cssc(cur(it, 'color'));
  const op = cur(it, 'opacity') ?? 1;
  const alpha = it.alpha * op;
  const p = it.p;
  const flash = it.flash || 0;
  const width = (cur(it, 'width') || 3) * (1 + flash * 0.8);
  let anchor = null;
  it.g.setAttribute('opacity', clamp(alpha, 0, 1));
  const strokeBase = { fill: 'none', stroke: col, 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  switch (it.type) {
    case 'curve': {
      const r = cur(it, 'range') || [M.xa, M.xb];
      const f = compile(String(it.params.fn), 'x');
      const fp = it.prevFn && it.m < 1 ? it.prevFn : null, t = smooth(it.m);
      const N = 360, x1 = lerp(r[0], r[1], p);
      let d = '', pen = false, last = null, peak = null;
      for (let i = 0; i <= N; i++) {
        const x = lerp(r[0], x1, i / N);
        let y = f(x);
        if (fp) y = lerp(fp(x), y, t);
        if (!isFinite(y)) { pen = false; continue; }
        const X = M.sx(x), Y = M.sy(y);
        d += (pen ? 'L' : 'M') + pf(X) + ' ' + pf(Y);
        pen = true; last = [X, Y];
        if (Y >= M.iy && Y <= M.iy + M.ih && (!peak || Y < peak[1] - 0.5)) peak = [X, Y];
      }
      path(it, 0, { ...strokeBase, d: p > 0 ? d : '' });
      trimPaths(it, 1);
      const an = peak || last;
      if (an) anchor = [an[0] + 10, an[1] - 22, 'l'];
      break;
    }
    case 'hist': {
      const D = it.data, t = smooth(it.m), PD = it.m < 1 ? it.prevData : null;
      const base = M.sy(M.yc <= 0 && M.yd >= 0 ? 0 : M.yc);
      let d = '', top = null;
      for (let i = 0; i < D.bins; i++) {
        const a = D.a + i * D.w, c = a + D.w / 2;
        let h = D.h[i];
        if (PD) {
          const j = Math.floor((c - PD.a) / PD.w);
          const h0 = j >= 0 && j < PD.bins ? PD.h[j] : 0;
          h = lerp(h0, h, t);
        }
        const q = clamp(p * 2 - (i / D.bins), 0, 1);
        h *= smooth(q);
        if (h <= 0) continue;
        const X0 = M.sx(a), X1 = M.sx(a + D.w), Y = M.sy(h);
        d += `M${pf(X0)} ${pf(base)}V${pf(Y)}H${pf(X1)}V${pf(base)}Z`;
        if (!top || Y < top[1]) top = [X1, Y];
      }
      const bw = Math.abs(M.sx(D.a + D.w) - M.sx(D.a));
      path(it, 0, { d, fill: col, stroke: BG, 'stroke-width': bw > 6 ? 1.2 : 0, 'stroke-opacity': 0.9 });
      trimPaths(it, 1);
      anchor = top ? [M.ix + M.iw - 10, M.iy + 20, 'r'] : null;
      break;
    }
    case 'points': {
      const pts = it.data.pts, t = smooth(it.m);
      const prev = it.m < 1 && it.prevData && it.prevData.pts && it.prevData.pts.length === pts.length ? it.prevData.pts : null;
      const r = cur(it, 'size') || 3;
      const n = Math.ceil(pts.length * p);
      if (it.chain === undefined) {
        let maxGap = 0;
        for (let i = 1; i < pts.length; i++) maxGap = Math.max(maxGap, Math.hypot(M.sx(pts[i][0]) - M.sx(pts[i - 1][0]), M.sy(pts[i][1]) - M.sy(pts[i - 1][1])));
        it.chain = !!it.params.pts && pts.length >= 30 && maxGap < 25;
      }
      let d = '';
      for (let i = 0; i < n; i++) {
        let [x, y] = pts[i];
        if (prev) { x = lerp(prev[i][0], x, t); y = lerp(prev[i][1], y, t); }
        const X = M.sx(x), Y = M.sy(y);
        d += it.chain ? (i ? 'L' : 'M') + pf(X) + ' ' + pf(Y) : `M${pf(X)} ${pf(Y)}h0.01`;
      }
      if (it.chain) path(it, 0, { ...strokeBase, d, 'stroke-width': (it.params.width || 4) * (1 + flash * 0.8) });
      else path(it, 0, { d, fill: 'none', stroke: col, 'stroke-width': 2 * r * (1 + flash * 0.6), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      trimPaths(it, 1);
      if (n) { const lp = pts[n - 1]; anchor = [M.sx(lp[0]) + 10, M.sy(lp[1]) - 16, 'l']; }
      break;
    }
    case 'point': {
      const [x, y] = cur(it, 'at');
      const r = (cur(it, 'size') || 7) * (1 + flash * 0.6);
      const X = M.sx(x), Y = M.sy(y);
      path(it, 0, { d: `M${pf(X)} ${pf(Y)}h0.01`, stroke: col, 'stroke-width': 2 * r * smooth(clamp(p * 1.5, 0, 1)), 'stroke-linecap': 'round', fill: 'none' });
      trimPaths(it, 1);
      anchor = [X + r + 6, Y - r - 14, 'l'];
      break;
    }
    case 'line':
    case 'arrow': {
      const [x0, y0] = cur(it, 'from'), [x1, y1] = cur(it, 'to');
      const X0 = M.sx(x0), Y0 = M.sy(y0);
      let X1 = M.sx(lerp(x0, x1, p)), Y1 = M.sy(lerp(y0, y1, p));
      const dash = it.params.dashed ? { 'stroke-dasharray': `${width * 3.5} ${width * 3}` } : { 'stroke-dasharray': 'none' };
      if (it.type === 'arrow') {
        const dx = X1 - X0, dy = Y1 - Y0, L = Math.hypot(dx, dy) || 1;
        const hl = Math.min(20, L * 0.5), hw = hl * 0.55, ux = dx / L, uy = dy / L;
        const bx = X1 - ux * hl, by = Y1 - uy * hl;
        path(it, 0, { ...strokeBase, ...dash, d: L > 1 ? `M${pf(X0)} ${pf(Y0)}L${pf(bx + ux * 2)} ${pf(by + uy * 2)}` : '' });
        path(it, 1, { fill: col, stroke: 'none', d: L > 1 ? `M${pf(X1)} ${pf(Y1)}L${pf(bx - uy * hw)} ${pf(by + ux * hw)}L${pf(bx + uy * hw)} ${pf(by - ux * hw)}Z` : '' });
        trimPaths(it, 2);
      } else {
        path(it, 0, { ...strokeBase, ...dash, d: `M${pf(X0)} ${pf(Y0)}L${pf(X1)} ${pf(Y1)}` });
        trimPaths(it, 1);
      }
      {
        const mx = (X0 + X1) / 2, my = (Y0 + Y1) / 2, L = Math.hypot(X1 - X0, Y1 - Y0) || 1;
        let nx = -(Y1 - Y0) / L, ny = (X1 - X0) / L;
        if (ny > 0) { nx = -nx; ny = -ny; }
        anchor = [mx + nx * 22, my + ny * 22, 'c'];
      }
      break;
    }
    case 'vline': {
      const x = cur(it, 'x'), X = M.sx(x);
      const Yb = M.iy + M.ih, Yt = M.iy;
      const dash = it.params.dashed ? { 'stroke-dasharray': `${width * 3.5} ${width * 3}` } : { 'stroke-dasharray': 'none' };
      path(it, 0, { ...strokeBase, ...dash, d: `M${pf(X)} ${pf(Yb)}L${pf(X)} ${pf(lerp(Yb, Yt, p))}` });
      trimPaths(it, 1);
      anchor = [X, Yt - 4, 'c'];
      break;
    }
    case 'circle': {
      const [cx, cy] = cur(it, 'center'), r = cur(it, 'r');
      const N = 160, n = Math.ceil(N * p);
      let d = '';
      for (let i = 0; i <= n; i++) {
        const th = (2 * Math.PI * Math.min(i, N * p)) / N;
        d += (i ? 'L' : 'M') + pf(M.sx(cx + r * Math.cos(th))) + ' ' + pf(M.sy(cy + r * Math.sin(th)));
      }
      if (p >= 1) d += 'Z';
      path(it, 0, { ...strokeBase, d: p > 0 ? d : '' });
      trimPaths(it, 1);
      anchor = [M.sx(cx + r * 0.72) + 8, M.sy(cy + r * 0.72) - 16, 'l'];
      break;
    }
    case 'ring': {
      const [cx, cy] = cur(it, 'center'), r1 = cur(it, 'r1'), r2 = cur(it, 'r2');
      const ell = (r) => {
        const rx = r * M.kx, ry = r * M.ky, X = M.sx(cx), Y = M.sy(cy);
        return `M${pf(X - rx)} ${pf(Y)}a${pf(rx)} ${pf(ry)} 0 1 0 ${pf(2 * rx)} 0a${pf(rx)} ${pf(ry)} 0 1 0 ${pf(-2 * rx)} 0Z`;
      };
      path(it, 0, { d: ell(Math.max(r1, r2)) + ell(Math.min(r1, r2)), fill: col, 'fill-rule': 'evenodd', 'fill-opacity': smooth(p), stroke: 'none' });
      trimPaths(it, 1);
      anchor = [M.sx(cx + r2 * 0.72) + 8, M.sy(cy + r2 * 0.72) - 16, 'l'];
      break;
    }
    case 'rect': {
      const [x0, y0] = cur(it, 'from'), [x1, y1] = cur(it, 'to');
      const X0 = M.sx(Math.min(x0, x1)), X1 = M.sx(Math.max(x0, x1)), Y0 = M.sy(Math.max(y0, y1)), Y1 = M.sy(Math.min(y0, y1));
      path(it, 0, { d: `M${pf(X0)} ${pf(Y0)}H${pf(X1)}V${pf(Y1)}H${pf(X0)}Z`, fill: col, 'fill-opacity': smooth(p), stroke: 'none' });
      trimPaths(it, 1);
      anchor = [(X0 + X1) / 2, Y0 - 16, 'c'];
      break;
    }
    case 'band': {
      const r = cur(it, 'range') || [M.xa, M.xb];
      const lo = compile(String(it.params.fn_lo), 'x'), hi = compile(String(it.params.fn_hi), 'x');
      const t = smooth(it.m), pl = it.m < 1 ? it.prevLo : null;
      const N = 200, x1 = lerp(r[0], r[1], p);
      const top = [], bot = [];
      for (let i = 0; i <= N; i++) {
        const x = lerp(r[0], x1, i / N);
        let a = lo(x), b = hi(x);
        if (pl) { a = lerp(pl[0](x), a, t); b = lerp(pl[1](x), b, t); }
        if (!isFinite(a) || !isFinite(b)) continue;
        top.push(pf(M.sx(x)) + ' ' + pf(M.sy(b)));
        bot.push(pf(M.sx(x)) + ' ' + pf(M.sy(a)));
      }
      const d = top.length ? 'M' + top.join('L') + 'L' + bot.reverse().join('L') + 'Z' : '';
      path(it, 0, { d: p > 0 ? d : '', fill: col, stroke: 'none' });
      trimPaths(it, 1);
      break;
    }
    case 'walks': {
      const W_ = it.data.walks, steps = it.data.steps;
      const n = Math.floor(steps * p);
      W_.forEach((ys, j) => {
        let d = '';
        for (let i = 0; i <= n; i++) d += (i ? 'L' : 'M') + pf(M.sx(i)) + ' ' + pf(M.sy(ys[i]));
        path(it, j, { ...strokeBase, d: n > 0 ? d : '' });
      });
      trimPaths(it, W_.length);
      if (W_.length && n > 0) anchor = [M.sx(n) + 8, M.sy(W_[W_.length - 1][n]) - 16, 'l'];
      break;
    }
    case 'note': {
      if (!it.noteEl) { it.noteEl = mk('div', 'lab', P.ovl); tex(it.noteEl, it.params.tex || '', false); }
      const [x, y] = cur(it, 'at');
      it.noteEl.style.left = M.sx(x) + 'px';
      it.noteEl.style.top = M.sy(y) + 'px';
      it.noteEl.style.color = col;
      it.noteEl.style.opacity = clamp(alpha * smooth(p), 0, 1);
      break;
    }
    default:
      if (!it.warned) { console.warn('unknown item type', it.type); it.warned = true; }
  }
  const labText = it.params.label;
  if (labText && it.type !== 'note' && anchor) {
    if (!it.labelEl) {
      it.labelEl = mk('div', 'lab', P.ovl);
      if (!label(it.labelEl, labText)) it.labelEl.classList.add('txt');
    }
    const e = it.labelEl;
    e.style.color = col;
    e.style.opacity = clamp(alpha * clamp(p * 2 - 1, 0, 1), 0, 1);
    const w = e.offsetWidth, h = e.offsetHeight;
    let lx = anchor[2] === 'l' ? anchor[0] + w / 2 : anchor[2] === 'r' ? anchor[0] - w / 2 : anchor[0];
    let ly = anchor[1];
    lx = clamp(lx, w / 2 + 2, P.rect.w - w / 2 - 2);
    ly = clamp(ly, h / 2, P.rect.h - h / 2);
    e.style.left = lx + 'px';
    e.style.top = ly + 'px';
  } else if (it.labelEl && !labText) { it.labelEl.remove(); it.labelEl = null; }
}

// ---------- op dispatch ----------
function opDuration(op) {
  if (op.dur != null) return op.dur;
  if (op.op === 'plot') return (op.items || []).length ? 0.7 + (op.items || []).reduce((a, s) => a + itemDur(s), 0) : 1.0;
  if (op.op === 'add') return (op.items || []).reduce((a, s) => a + itemDur(s), 0) || DEFAULT_DUR;
  if (op.op === 'update') return 1.2;
  return DEFAULT_DUR;
}

function runOp(op, dur) {
  try {
    switch (op.op) {
      case 'title': return setTitle(op.text ?? op.tex ?? '', dur);
      case 'text': return opFlow(op, 'text', dur);
      case 'math': return opFlow(op, 'math', dur);
      case 'replace': return opReplace(op, dur);
      case 'highlight': return opHighlight(op, dur);
      case 'box': return opBox(op, dur);
      case 'color': return opColor(op, dur);
      case 'remove': return opRemove(op, dur);
      case 'clear': return opClear(op, dur);
      case 'plot': return opPlot(op, dur);
      case 'add': return opAdd(op, dur);
      case 'update': return opUpdate(op, dur);
      case 'table': return opTable(op, dur);
      case 'show_row': return opShowRow(op, dur);
      default: console.warn('unknown op', op.op);
    }
  } catch (e) {
    console.error('op failed', op, e);
  }
}

function scheduleBeat(beat, beatDur, t0) {
  let cursor = 0, end = 0;
  for (const op of beat.do || []) {
    const d = opDuration(op);
    const start = op.at != null ? op.at * beatDur : cursor;
    cursor = start + d;
    end = Math.max(end, cursor);
    anim.at(t0 + start, () => runOp(op, d));
  }
  return end;
}

function applyBeatInstant(beat) {
  for (const op of beat.do || []) runOp(op, 0);
}

function renderAllPlots(force) {
  for (const P of board.plots.values()) if (P.dirty || force) renderPlot(P);
}

// ---------- audio ----------
const audioCache = new Map();
function getAudio(text) {
  if (!text) return Promise.resolve(null);
  if (audioCache.has(text)) return audioCache.get(text);
  const pr = fetch('/api/tts?text=' + encodeURIComponent(text))
    .then((r) => { if (!r.ok) throw new Error('tts ' + r.status); return r.blob(); })
    .then((b) => new Promise((res) => {
      const url = URL.createObjectURL(b);
      const a = new Audio();
      a.preload = 'auto';
      a.onloadedmetadata = () => res({ url, dur: a.duration });
      a.onerror = () => res(null);
      a.src = url;
    }))
    .catch((e) => { console.warn('tts failed', e); audioCache.delete(text); return null; });
  audioCache.set(text, pr);
  return pr;
}
const estDur = (text) => Math.max(1.5, (text || '').split(/\s+/).length / 2.5);

// ---------- player ----------
const params = new URLSearchParams(location.search);

const SESSION = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '') + '_' + Math.random().toString(36).slice(2, 8);
const EVQ = [];
const LOGGING = params.get('log') !== '0';
let CONSENT = null;
function ev(e, data) {
  if (LOGGING && CONSENT !== false) EVQ.push({ e, t: Date.now(), pt: +performance.now().toFixed(1), ...data });
}
function flushEvents(beacon) {
  if (CONSENT !== true) { if (CONSENT === false) EVQ.length = 0; return; }
  if (!EVQ.length) return;
  const body = JSON.stringify({ session: SESSION, events: EVQ.splice(0) });
  if (beacon && navigator.sendBeacon) navigator.sendBeacon('/api/events', new Blob([body], { type: 'application/json' }));
  else fetch('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
}
if (LOGGING) {
  setInterval(() => flushEvents(false), 2000);
  window.addEventListener('pagehide', () => { ev('session_end'); flushEvents(true); });
  document.addEventListener('visibilitychange', () => ev('visibility', { state: document.visibilityState }));
  window.addEventListener('error', (e) => ev('error', { msg: e.message }));
}

const player = {
  data: { order: [], scenes: {} }, sceneId: null, scene: null, bi: 0, gen: 0,
  state: 'idle', autoplay: params.get('autoplay') !== '0', paused: false,
  beatEnd: 0, audioEl: new Audio(), captions: true, view: 'play',
};

async function loadScenes() {
  try {
    const r = await fetch('/api/scenes', { cache: 'no-store' });
    player.data = await r.json();
    const ver = r.headers.get('X-Board-Version');
    if (ver !== player.dataVersion) {
      player.dataVersion = ver;
      ev('scenes', { version: ver, order: player.data.order });
    }
  } catch (e) { console.warn('scenes fetch failed', e); }
  drawScrubber();
}

function sceneList() {
  const o = player.data.order.filter((id) => player.data.scenes[id]);
  return o.length ? o : Object.keys(player.data.scenes).sort();
}

function loadSceneInstant(id, nBeats) {
  const sc = player.data.scenes[id];
  if (!sc) { console.warn('no scene', id); return false; }
  player.sceneId = id;
  player.scene = JSON.parse(JSON.stringify(sc));
  player.sceneVersion = player.dataVersion;
  ordCounter = 0;
  resetBoard(player.scene);
  anim.instant = true;
  const beats = player.scene.beats || [];
  for (let k = 0; k < Math.min(nBeats, beats.length); k++) applyBeatInstant(beats[k]);
  relayout(0);
  anim.instant = false;
  renderAllPlots(true);
  return true;
}

function showStatic(id, k) {
  player.gen++;
  stopAudio();
  const beats = (player.data.scenes[id] || {}).beats || [];
  k = clamp(k, 0, Math.max(0, beats.length - 1));
  if (!loadSceneInstant(id, k + 1)) return;
  player.bi = k;
  player.state = 'static';
  ev('show_static', { scene: id, beat: k, version: player.sceneVersion });
  updateBar();
}

function playFrom(id, k) {
  player.gen++;
  stopAudio();
  if (!loadSceneInstant(id, k)) return;
  startBeat(k);
}

function stopAudio() {
  try { player.audioEl.pause(); } catch (e) {}
}

const PLAYLOG = [];
async function startBeat(k) {
  const beats = player.scene.beats || [];
  if (k >= beats.length) return player.scene.complete === false ? waitForBeats(k) : nextScene();
  const gen = ++player.gen;
  player.bi = k;
  player.state = 'loading';
  updateBar();
  const beat = beats[k];
  const au = await getAudio(beat.say);
  for (let j = 1; j <= 2; j++) if (beats[k + j]) getAudio(beats[k + j].say);
  if (k + 1 >= beats.length) {
    const nxt = sceneList()[sceneList().indexOf(player.sceneId) + 1];
    const ns = nxt && player.data.scenes[nxt];
    if (ns && ns.beats && ns.beats[0]) getAudio(ns.beats[0].say);
  }
  if (gen !== player.gen) return;
  await waitUnpaused(gen);
  if (gen !== player.gen) return;
  const sayDur = au ? au.dur : estDur(beat.say);
  const beatDur = sayDur + BEAT_PAUSE;
  const t0 = clock.now();
  const opsEnd = scheduleBeat(beat, beatDur, t0);
  player.beatEnd = t0 + Math.max(beatDur, opsEnd + 0.2);
  player.beatStart = t0;
  player.state = 'playing';
  ev('beat', { scene: player.sceneId, beat: k, version: player.sceneVersion, say: beat.say, dur: +beatDur.toFixed(2), audio: !!au });
  PLAYLOG.push(player.sceneId + ':' + k);
  document.body.dataset.playLog = PLAYLOG.join(',');
  document.body.dataset.errorLog = ERRORS.join(' | ');
  if (au) {
    player.audioEl.src = au.url;
    player.audioEl.currentTime = 0;
    player.audioEl.play().catch((e) => { console.warn('audio play blocked', e); ev('audio_blocked'); showStart(); });
  }
}

function waitForBeats(k) {
  const gen = ++player.gen;
  const id = player.sceneId;
  player.bi = Math.max(0, k - 1);
  player.state = 'writing';
  updateBar();
  const poll = async () => {
    if (gen !== player.gen) return;
    let sc = null, ver = null;
    try {
      const r = await fetch('/api/scene/' + encodeURIComponent(id), { cache: 'no-store' });
      if (r.ok) { sc = await r.json(); ver = r.headers.get('X-Board-Version'); }
    } catch (e) {}
    if (gen !== player.gen) return;
    if (sc && Array.isArray(sc.beats)) {
      const cur = player.scene.beats || (player.scene.beats = []);
      const added = sc.beats.slice(cur.length);
      for (const b of added) { cur.push(JSON.parse(JSON.stringify(b))); getAudio(b.say); }
      if (added.length || ver !== player.sceneVersion) {
        player.sceneVersion = ver;
        ev('scene_grew', { scene: id, version: ver, beats: cur.length, complete: sc.complete !== false });
      }
      player.scene.complete = sc.complete;
      if (sc.title) player.scene.title = sc.title;
      player.data.scenes[id] = sc;
      if (k < cur.length) return startBeat(k);
      if (sc.complete !== false) {
        await loadScenes();
        if (gen !== player.gen) return;
        return nextScene();
      }
    }
    setTimeout(poll, 250);
  };
  poll();
}

function waitUnpaused(gen) {
  return new Promise((res) => {
    const chk = () => (!player.paused || gen !== player.gen ? res() : setTimeout(chk, 100));
    chk();
  });
}

function nextScene() {
  const list = sceneList();
  const i = list.indexOf(player.sceneId);
  if (i >= 0 && i + 1 < list.length) return playFrom(list[i + 1], 0);
  player.state = 'ended';
  ev('ended', { scene: player.sceneId });
  updateBar();
}

function pause() {
  if (player.paused) return;
  player.paused = true;
  ev('pause', { scene: player.sceneId, beat: player.bi });
  clock.stop();
  stopAudio();
  updateBar();
}
function resume() {
  if (!player.paused) return;
  player.paused = false;
  ev('resume', { scene: player.sceneId, beat: player.bi });
  clock.start();
  if (player.state === 'playing' && player.audioEl.src && player.audioEl.currentTime < player.audioEl.duration)
    player.audioEl.play().catch(() => {});
  updateBar();
}

function step(dir) {
  const list = sceneList();
  let id = player.sceneId, k = player.bi + dir;
  const n = ((player.data.scenes[id] || {}).beats || []).length;
  if (k < 0) {
    const i = list.indexOf(id);
    if (i <= 0) k = 0;
    else { id = list[i - 1]; k = (player.data.scenes[id].beats || []).length - 1; }
  } else if (k >= n) {
    const i = list.indexOf(id);
    if (i < 0 || i + 1 >= list.length) k = n - 1;
    else { id = list[i + 1]; k = 0; }
  }
  ev('step', { dir, from_scene: player.sceneId, from_beat: player.bi, scene: id, beat: k });
  if (!player.autoplay || player.paused || player.state === 'static' || player.state === 'ended') showStatic(id, k);
  else playFrom(id, k);
}

// ---------- bar ----------
function drawScrubber() {
  const sc = $('scrub');
  sc.textContent = '';
  const list = sceneList();
  const cur = list.indexOf(player.sceneId);
  list.forEach((id, i) => {
    const s = player.data.scenes[id];
    const seg = mk('div', 'seg' + (i === cur ? ' cur' : i < cur ? ' done' : ''), sc);
    seg.style.flexGrow = Math.max(1, (s.beats || []).length);
    seg.title = s.title || id;
    if (i === cur) {
      const f = mk('div', 'fill', seg);
      const n = (s.beats || []).length || 1;
      f.style.width = `${((player.bi + 1) / n) * 100}%`;
    }
    seg.onclick = () => (ev('seek', { from_scene: player.sceneId, from_beat: player.bi, scene: id, beat: 0 }), player.autoplay && !player.paused ? playFrom(id, 0) : showStatic(id, 0));
  });
}

function updateBar() {
  const sc = player.scene;
  if (!sc) return;
  $('scene-title').textContent = sc.title || sc.id || '';
  const n = (sc.beats || []).length;
  let st = `beat ${player.bi + 1}/${n}${sc.complete === false ? '+' : ''}`;
  if (player.paused) st = '⏸ ' + st;
  $('beatno').textContent = st;
  const b = (sc.beats || [])[player.bi];
  $('caption').textContent = b ? b.say || '' : '';
  $('caption').classList.toggle('off', !player.captions);
  $('bar').classList.toggle('writing', player.state === 'writing');
  drawScrubber();
}

// ---------- feedback ----------
const fb = { rec: null, chunks: [], stream: null, t0: 0, timer: null, poll: null, lastSpace: 0, mode: null };
const ACK_TEXT = 'Good question. One moment.';
const ackEl = new Audio();
async function playAck() {
  const au = await getAudio(ACK_TEXT);
  if (!au || fb.mode !== 'waiting') return;
  ackEl.src = au.url;
  ackEl.currentTime = 0;
  ackEl.play().catch((e) => console.warn('ack play blocked', e));
}
function ackDone() {
  return new Promise((res) => {
    if (ackEl.paused || ackEl.ended) return res();
    const t = setTimeout(res, 4000);
    ackEl.addEventListener('ended', () => { clearTimeout(t); res(); }, { once: true });
  });
}

function overlay(head, body, foot) {
  $('overlay').classList.remove('hidden');
  $('ov-head').innerHTML = head;
  $('ov-body').textContent = body || '';
  $('ov-foot').textContent = foot || '';
}
function hideOverlay() { $('overlay').classList.add('hidden'); }
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

async function startRecording() {
  fb.mode = 'starting';
  pause();
  overlay('<span class="spin"></span>Opening microphone…', '', 'Esc to cancel');
  try {
    fb.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    overlay('Microphone unavailable', String(e), '');
    fb.mode = null;
    setTimeout(() => { hideOverlay(); resume(); }, 2000);
    return;
  }
  if (fb.mode !== 'starting') { fb.stream.getTracks().forEach((t) => t.stop()); return; }
  fb.chunks = [];
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
  fb.rec = new MediaRecorder(fb.stream, mime ? { mimeType: mime } : {});
  fb.rec.ondataavailable = (e) => { if (e.data.size) fb.chunks.push(e.data); };
  fb.rec.start(250);
  fb.mode = 'recording';
  fb.t0 = performance.now();
  fb.meta = { scene: player.sceneId, beat: player.bi, time: +(clock.now() - (player.beatStart || clock.now())).toFixed(2),
    session: SESSION, version: player.sceneVersion };
  ev('question_start', fb.meta);
  const tick = () => overlay('<span class="dot"></span>Recording ' + mmss((performance.now() - fb.t0) / 1000), '', 'Ctrl+Space to send · Esc to cancel');
  tick();
  fb.timer = setInterval(tick, 250);
}

function stopStream() {
  clearInterval(fb.timer);
  if (fb.stream) fb.stream.getTracks().forEach((t) => t.stop());
  fb.stream = null;
}

function cancelFeedback() {
  ev('question_cancel', { stage: fb.mode });
  if (fb.rec && fb.rec.state !== 'inactive') { fb.rec.onstop = null; fb.rec.stop(); }
  stopStream();
  clearInterval(fb.poll);
  try { ackEl.pause(); } catch (e) {}
  fb.mode = null; fb.rec = null;
  hideOverlay();
  resume();
}

function sendRecording() {
  fb.mode = 'uploading';
  ev('question_end', { secs: +((performance.now() - fb.t0) / 1000).toFixed(2) });
  clearInterval(fb.timer);
  const rec = fb.rec;
  rec.onstop = async () => {
    stopStream();
    const blob = new Blob(fb.chunks, { type: rec.mimeType || 'audio/webm' });
    overlay('<span class="spin"></span>Transcribing…', '', 'Esc to cancel');
    const fd = new FormData();
    fd.append('audio', blob, 'question.webm');
    fd.append('json', JSON.stringify(fb.meta));
    let res;
    try {
      res = await (await fetch('/api/feedback', { method: 'POST', body: fd })).json();
    } catch (e) { res = { error: String(e) }; }
    ev('question_result', { fb: res.id || null, transcript: res.transcript || null, rejected: !!res.rejected, error: res.error || null });
    if (fb.mode !== 'uploading') return;
    if (res.error || res.rejected || !res.id) {
      overlay(res.rejected ? 'Didn’t catch a question' : 'Upload failed', res.transcript || res.error || '', 'resuming…');
      fb.mode = null;
      setTimeout(() => { if (!fb.mode) { hideOverlay(); resume(); } }, 2200);
      return;
    }
    waitAnswer(res.id, res.transcript);
    playAck();
  };
  rec.stop();
}

function waitAnswer(id, transcript) {
  fb.mode = 'waiting';
  const t0 = performance.now();
  const show = () => overlay('<span class="spin"></span>Waiting for an answer ' + mmss((performance.now() - t0) / 1000), '“' + transcript + '”', 'Esc to dismiss and resume');
  show();
  fb.timer = setInterval(show, 500);
  fb.poll = setInterval(async () => {
    let d;
    try { d = await (await fetch('/api/feedback/' + id, { cache: 'no-store' })).json(); } catch (e) { return; }
    if (d.status !== 'done' || fb.mode !== 'waiting') return;
    clearInterval(fb.poll); clearInterval(fb.timer);
    fb.mode = 'answering';
    overlay('Answer ready', d.note || '', '');
    await Promise.all([loadScenes(), ackDone()]);
    if (fb.mode !== 'answering') return;
    fb.mode = null;
    setTimeout(hideOverlay, 1800);
    player.paused = false;
    clock.start();
    const target = d.scene && player.data.scenes[d.scene] ? d.scene : player.sceneId;
    ev('answer', { fb: id, scene: target, note: d.note || null, wait_s: +((performance.now() - t0) / 1000).toFixed(1), version: player.dataVersion });
    playFrom(target, 0);
  }, 250);
}

// ---------- input ----------
function onKey(e) {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
  const isSpace = e.code === 'Space' || e.key === ' ';
  if (isSpace && e.ctrlKey) {
    e.preventDefault();
    if (e.repeat) return;
    const now = performance.now();
    if (now - fb.lastSpace < 600) return;
    fb.lastSpace = now;
    if (!started) return beginPlayback();
    if (!fb.mode) startRecording();
    else if (fb.mode === 'recording') sendRecording();
    return;
  }
  if (isSpace) {
    e.preventDefault();
    if (e.repeat || fb.mode) return;
    if (!started) return beginPlayback();
    if (player.state === 'static' && player.autoplay) { player.paused = false; clock.start(); playFrom(player.sceneId, player.bi); }
    else if (player.paused) resume(); else pause();
    return;
  }
  if (e.key === 'Escape') { e.preventDefault(); if (fb.mode) cancelFeedback(); return; }
  if (fb.mode) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  else if (e.key === 'c' || e.key === 'C') { player.captions = !player.captions; ev('captions', { on: player.captions }); updateBar(); }
  else if (e.key === 'p' || e.key === 'P') {
    if (player.state === 'static' && player.autoplay) { player.paused = false; clock.start(); playFrom(player.sceneId, player.bi); }
    else if (player.paused) resume(); else pause();
  } else if (e.key === 'Enter' && !started) beginPlayback();
  else if (e.key === 'r' || e.key === 'R') { ev('restart_scene', { scene: player.sceneId }); loadScenes().then(() => playFrom(player.sceneId, 0)); }
}

// ---------- main ----------
let stageScale = 1;
function fit() {
  const vp = $('viewport');
  const w = vp.clientWidth, h = vp.clientHeight;
  stageScale = Math.min(w / W, h / H);
  const st = $('stage');
  st.style.transform = `scale(${stageScale})`;
  st.style.left = `${(w - W * stageScale) / 2}px`;
  st.style.top = `${(h - H * stageScale) / 2}px`;
}

function frame() {
  anim.step();
  renderAllPlots(false);
  if (player.state === 'playing' && !player.paused && clock.now() >= player.beatEnd) {
    player.state = 'advancing';
    startBeat(player.bi + 1);
  }
  requestAnimationFrame(frame);
}

let started = false;
function showStart() { $('start').classList.remove('hidden'); }
function showConsent() {
  for (const b of document.querySelectorAll('#consent button')) b.classList.toggle('on', CONSENT === (b.dataset.v === '1'));
  $('start').querySelector('.start-msg').textContent = CONSENT === null ? 'Choose an option to start' : 'Click or press Enter to start';
}
async function loadConsent() {
  try { CONSENT = (await (await fetch('/api/consent', { cache: 'no-store' })).json()).record; } catch (e) {}
  if (CONSENT !== true && CONSENT !== false) CONSENT = null;
  showConsent();
}
async function setConsent(v) {
  const first = CONSENT === null;
  try { await fetch('/api/consent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ record: v }) }); } catch (e) {}
  CONSENT = v;
  if (v) ev('consent', { record: true });
  showConsent();
  if (first) beginPlayback();
}
function beginPlayback() {
  if (CONSENT === null && LOGGING && !$('start').classList.contains('hidden')) return;
  $('start').classList.add('hidden');
  if (started) { player.audioEl.play().catch(() => {}); return; }
  started = true;
  ev('start', { scene: player.sceneId, beat: player.bi });
  clock.start();
  playFrom(player.sceneId, player.bi);
}

async function preloadFonts() {
  const fams = ['20px KaTeX_Main', 'italic 20px KaTeX_Main', 'bold 20px KaTeX_Main', 'italic 20px KaTeX_Math', '20px KaTeX_Size1',
    '20px KaTeX_Size2', '20px KaTeX_Size3', '20px KaTeX_Size4', '20px KaTeX_AMS', '20px Inter'];
  try {
    await Promise.race([Promise.all(fams.map((f) => document.fonts.load(f))), new Promise((r) => setTimeout(r, 4000))]);
  } catch (e) {}
}

async function main() {
  ev('session_start', { url: location.href, ua: navigator.userAgent, viewport: [innerWidth, innerHeight] });
  board.root = $('board');
  board.titleEl = $('title');
  fit();
  window.addEventListener('resize', fit);
  document.addEventListener('keydown', onKey);
  $('start').addEventListener('click', beginPlayback);
  $('consent').addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target.dataset && e.target.dataset.v) setConsent(e.target.dataset.v === '1');
  });
  await loadConsent();
  await preloadFonts();
  await loadScenes();
  const list = sceneList();
  const sid = params.get('scene') && player.data.scenes[params.get('scene')] ? params.get('scene') : list[0];
  if (!sid) { $('caption').textContent = 'No scenes yet.'; return; }
  const k = parseInt(params.get('beat') || '0', 10) || 0;
  if (!player.autoplay) {
    started = true;
    showStatic(sid, k);
  } else {
    player.sceneId = sid;
    player.bi = k;
    loadSceneInstant(sid, k);
    updateBar();
    if (params.get('start') === '1') beginPlayback(); else showStart();
  }
  document.fonts.addEventListener('loadingdone', () => { if (!anim.tweens.length) { relayout(0); renderAllPlots(true); } });
  setInterval(loadScenes, 3000);
  getAudio(ACK_TEXT);
  requestAnimationFrame(frame);
  document.body.dataset.ready = '1';
  document.body.dataset.errorLog = ERRORS.join(' | ');
}

main();
