#!/usr/bin/env node
// Headless smoke test: loads every game script into a Node VM with stubbed DOM/WebGL/localStorage,
// then plays every hero through every floor with a scripted bot, exercising update + draw + UI + saves.
//
// usage: node tools/smoke.js [--seconds 12] [--heroes finn,fp,marceline] [--floors 1-15] [--quiet]
//        exits 1 on any uncaught error. Prints each unique error once with a stack.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const SECONDS = parseFloat(opt('seconds', '12'));
const QUIET = args.includes('--quiet');
const floorsArg = opt('floors', '1-15');
const FLOORS = (() => { const out = []; for (const part of floorsArg.split(',')) { const [a, b] = part.split('-').map(Number); for (let f = a; f <= (b || a); f++) out.push(f); } return out; })();

// ---------------------------------------------------------------- stubs
const noop = () => {};
function ctx2d() {
  const target = {
    measureText: (t) => ({ width: String(t).length * 7, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    createLinearGradient: () => ({ addColorStop: noop }), createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => ({}), getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: noop, drawImage: noop, setTransform: noop, getTransform: () => ({}), setLineDash: noop, getLineDash: () => [],
    isPointInPath: () => false, canvas: null,
  };
  return new Proxy(target, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' && /^[a-z]/.test(k) && !['font', 'fillStyle', 'strokeStyle', 'globalAlpha', 'lineWidth', 'textAlign', 'textBaseline', 'globalCompositeOperation', 'shadowBlur', 'shadowColor', 'lineCap', 'lineJoin', 'imageSmoothingEnabled', 'filter', 'letterSpacing'].includes(k) ? noop : t[k]), set: (t, k, v) => { t[k] = v; return true; } });
}
function canvasStub() { const c = { width: 1400, height: 820, style: {}, getContext: (t) => (t === '2d' ? ctx2d() : null), addEventListener: noop, removeEventListener: noop, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1400, height: 820 }), toDataURL: () => '' }; return c; }
const storage = {};
const elements = { gl: canvasStub(), ui: canvasStub() };
const documentStub = {
  getElementById: (id) => elements[id] || null,
  createElement: (t) => (t === 'canvas' ? canvasStub() : { style: {}, click: noop, remove: noop, appendChild: noop, addEventListener: noop, setAttribute: noop }),
  body: { appendChild: noop, style: {} }, addEventListener: noop, removeEventListener: noop, hidden: false,
  fonts: { load: () => Promise.resolve(), ready: Promise.resolve() },
};
const sandbox = {
  console, Math, JSON, Date, Promise, Set, Map, WeakMap, Symbol, Proxy, Reflect, Error, TypeError, RangeError,
  Uint8Array, Uint8ClampedArray, Int16Array, Int32Array, Uint16Array, Uint32Array, Float32Array, Float64Array, ArrayBuffer, DataView,
  parseInt, parseFloat, isNaN, isFinite, Number, String, Boolean, Array, Object, Function, RegExp, encodeURIComponent, decodeURIComponent, escape, unescape,
  setTimeout: (fn) => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop, queueMicrotask: (fn) => Promise.resolve().then(fn),
  requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
  performance: { now: () => simNow * 1000 },
  navigator: { getGamepads: () => [], userAgent: 'node-smoke' },
  localStorage: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); }, removeItem: (k) => { delete storage[k]; }, clear: () => { for (const k in storage) delete storage[k]; } },
  document: documentStub, location: { search: '', href: 'http://smoke/' },
  innerWidth: 1400, innerHeight: 820, devicePixelRatio: 1,
  addEventListener: noop, removeEventListener: noop,
  Blob: function () {}, URL: { createObjectURL: () => 'blob:x', revokeObjectURL: noop }, FileReader: function () {},
  AudioContext: undefined, webkitAudioContext: undefined,
  URLSearchParams,
  HM: { headless: true },
};
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
let simNow = 0;
vm.createContext(sandbox);

// ---------------------------------------------------------------- load scripts in index.html order
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const files = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
const errors = new Map();
function report(where, e) {
  const key = (e && e.stack ? e.stack.split('\n').slice(0, 2).join(' | ') : String(e));
  if (!errors.has(key)) { errors.set(key, { where, count: 0, stack: e && e.stack ? e.stack.split('\n').slice(0, 7).join('\n') : String(e) }); }
  errors.get(key).count++;
}
for (const f of files) {
  const p = path.join(ROOT, f);
  try { vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: f }); }
  catch (e) {
    report('load ' + f, e);
    const stub = path.join(ROOT, 'src/stubs', path.basename(f));
    if (fs.existsSync(stub)) { console.log(`!! ${f} failed to load — falling back to stub`); vm.runInContext(fs.readFileSync(stub, 'utf8'), sandbox, { filename: 'stub:' + f }); }
  }
}
const HM = sandbox.HM;
const log = (...a) => { if (!QUIET) console.log(...a); };

// ---------------------------------------------------------------- boot
function guard(where, fn) { try { return fn(); } catch (e) { report(where, e); return undefined; } }
guard('R.init', () => HM.R.init(null, { headless: true, w: 1400, h: 820 }));
guard('UI.init', () => HM.UI.init(elements.ui));
guard('Save.use', () => HM.Save.use(1, 'Smoke'));
guard('Game.init', () => HM.Game.init());

const DT = 1 / 60;
let frameMs = 0, frames = 0;
function step(n) {
  for (let k = 0; k < n; k++) {
    simNow += DT;
    const t0 = process.hrtime.bigint();
    guard('Input.beginFrame', () => HM.Input.beginFrame(HM.Game.realT + DT));
    guard('Game.update[' + HM.Game.state + ']', () => HM.Game.update(DT));
    guard('Game.draw[' + HM.Game.state + ']', () => HM.Game.draw());
    frameMs += Number(process.hrtime.bigint() - t0) / 1e6; frames++;
  }
}
function press(code) { HM.Input._pressedEdge.add(code); HM.Input.down.add(code); }
function release(code) { HM.Input.down.delete(code); HM.Input._releasedEdge.add(code); }
function releaseAll() { for (const c of [...HM.Input.down]) release(c); }

// draw every menu state once (UI robustness)
for (const s of ['title', 'slots', 'heroSelect', 'options', 'codex', 'heirlooms']) { guard('setState ' + s, () => HM.Game.setState(s)); step(3); }
guard('setState title', () => HM.Game.setState('title')); step(2);

// ---------------------------------------------------------------- bot
function bot(t) {
  const G = HM.Game, p = G.player; if (!p || p.dead) return;
  releaseAll();
  let tgt = null, bd = 1e9;
  for (const a of G.entities) if (a.team === 1 && !a.dead) { const d = Math.hypot(a.x - p.x, a.y - p.y); if (d < bd) { bd = d; tgt = a; } }
  const goal = tgt || (G.floor && G.floor.exit) || p;
  const [sx, sy] = HM.R.worldToScreen(goal.x, goal.y, 0);
  HM.Input.mouse.sx = sx; HM.Input.mouse.sy = sy;
  const dx = goal.x - p.x, dy = goal.y - p.y;
  if (bd > 40) { if (dx > 8) press('KeyD'); if (dx < -8) press('KeyA'); if (dy > 8) press('KeyS'); if (dy < -8) press('KeyW'); }
  const f = Math.floor(t * 60);
  if (f % 9 === 0) press('Mouse0');
  if (f % 53 === 0) press('Mouse2');
  if (f % 97 === 0) press('KeyQ');
  if (f % 131 === 0) press('KeyE');
  if (f % 307 === 0) press('KeyR');
  if (f % 71 === 0) press('Space');
  if (f % 400 === 0) press('Digit1');
  if (f % 450 === 0) press('KeyF');
  if (f % 240 === 0) p.hp = p.maxHp; // keep the bot alive so it reaches every floor
}

const heroes = (opt('heroes', '') ? opt('heroes').split(',') : (HM.Heroes && HM.Heroes.list ? HM.Heroes.list.map((h) => h.id) : ['finn']));
const summary = [];
for (const hero of heroes) {
  guard('newRun ' + hero, () => HM.Game.newRun(hero, { seed: 4242 }));
  for (const fl of FLOORS) {
    guard('enterFloor ' + fl, () => { if (HM.Game.run.floorIndex !== fl) HM.Game.enterFloor(fl); });
    let t = 0; const n = Math.round(SECONDS * 60);
    const ents0 = HM.Game.entities.length;
    for (let k = 0; k < n; k++) { t += DT; guard('bot', () => bot(t)); step(1); if (HM.Game.state !== 'play') break; }
    // UI states mid-run
    for (const s of ['pause', 'inventory']) { guard('state ' + s, () => HM.Game.setState(s)); step(2); guard('state play', () => HM.Game.setState('play')); }
    const alive = HM.Game.entities.filter((a) => a.team === 1 && !a.dead).length;
    summary.push(`${hero} f${fl}: ents ${ents0} → alive enemies ${alive}, kills ${HM.Game.run ? HM.Game.run.kills : '?'}, lvl ${HM.Game.run ? HM.Game.run.level : '?'}, proj ${HM.Game.projectiles.length}, zones ${HM.Game.zones.length}`);
    // descend
    guard('openExit', () => HM.Game.openExit('smoke'));
    guard('descend', () => { if (HM.Game.state === 'play') HM.Game.descend(); });
    let guardN = 0;
    while (HM.Game.state === 'boon' && guardN++ < 10) { step(2); guard('chooseBoon', () => HM.Game.chooseBoon(HM.Game.menuData.draft[0].id)); }
    if (HM.Game.state === 'shop') guard('leave shop', () => HM.Game.setState('play'));
    if (HM.Game.state === 'victory') { step(5); break; }
  }
  // death path
  if (HM.Game.player && HM.Game.state === 'play') {
    guard('kill player', () => HM.Combat.damage(HM.Game.player, { amount: 1e9, type: 'phys', ignoreIframes: true }));
    for (let k = 0; k < 200 && HM.Game.state === 'play'; k++) step(1);
    log(`${hero}: after death → state ${HM.Game.state}`);
    step(5);
  }
  guard('quitToTitle', () => HM.Game.quitToTitle()); step(3);
}

// ---------------------------------------------------------------- save roundtrip
guard('save roundtrip', () => {
  const env = HM.Save.exportEnvelope(1);
  if (!env) throw new Error('exportEnvelope returned null');
  const v = HM.Save.validate(JSON.parse(JSON.stringify(env)), 2);
  if (!v.ok) throw new Error('validate failed: ' + v.error);
  const bad = JSON.parse(JSON.stringify(env)); bad.data.meta.ashes = 999999;
  const v2 = HM.Save.validate(bad, 2); if (v2.ok) throw new Error('tampered save passed checksum');
  const r = HM.Save.commitImport(2, v.data); if (!r.ok) throw new Error('commitImport failed: ' + r.error);
  if (!HM.Save.list()[1].exists) throw new Error('imported slot not listed');
});

// ---------------------------------------------------------------- report
log('\n' + summary.join('\n'));
log(`\nframes ${frames}, avg ${(frameMs / Math.max(1, frames)).toFixed(2)} ms/frame (node, headless; includes rasterization)`);
if (errors.size) {
  console.log(`\n${errors.size} unique error(s):`);
  for (const [, e] of errors) console.log(`\n[${e.where}] x${e.count}\n${e.stack}`);
  process.exit(1);
} else console.log('\nSMOKE OK — no errors.');
