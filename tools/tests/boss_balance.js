#!/usr/bin/env node
// Boss BALANCE harness (owner: bosses/enemies/fx). Unlike tools/tests/bosses.js (a damage-cheat smoke of every phase),
// this plays each boss fight "for real": a level-appropriate hero with floor-appropriate gear, NO damage multiplier,
// and a "reasonable dodger" bot that
//   * reads live telegraphs (HM.FX.telegraphList) and walks out of them, or rolls through when it is too late,
//   * rolls through expanding rings (sonic / lava / Well pulses) and marching orb lines,
//   * steps off burning/acid/ice ground and out of beams and breath,
//   * notices only `--react` (default 0.75) of the threats, after a ~0.22 s reaction delay,
//   * eats a Bacon Pancake (35% max HP over 2 s) when below 35% HP (counted, unlimited supply).
// Reports per boss: fight length, damage taken (and in max-HP units), pancakes used, deaths, the worst offenders.
// usage: node tools/tests/boss_balance.js [--floors 3,6,9,12,15] [--hero finn] [--seconds 150] [--react 0.75] [--trials 2]
//        [--dmg 1] [--levels 4,7,9,11,12] [--quiet]
// Exit code 1 only on script errors; the numbers are for tuning (targets: late bosses 60-90 s, <= 2 pancakes, 0 deaths).
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const FLOORS = opt('floors', '3,6,9,12,15').split(',').map(Number);
const HERO = opt('hero', 'finn');
const SECONDS = parseFloat(opt('seconds', '150'));
const REACT = parseFloat(opt('react', '0.75'));
const TRIALS = parseInt(opt('trials', '2'), 10);
const DMG = parseFloat(opt('dmg', '1'));
const QUIET = args.includes('--quiet');
const DEBUG = opt('debug', '');
const DBG = {};
const LEVELS = (() => { const l = opt('levels', ''); if (!l) return { 3: 4, 6: 7, 9: 9, 12: 11, 15: 12 }; const v = l.split(',').map(Number); const o = {}; FLOORS.forEach((f, i) => { o[f] = v[i] || v[v.length - 1]; }); return o; })();

// ---------------------------------------------------------------- sandbox (same stubs as tools/smoke.js)
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
function canvasStub() { return { width: 1400, height: 820, style: {}, getContext: (t) => (t === '2d' ? ctx2d() : null), addEventListener: noop, removeEventListener: noop, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1400, height: 820 }), toDataURL: () => '' }; }
const storage = {};
const elements = { gl: canvasStub(), ui: canvasStub() };
let simNow = 0;
const sandbox = {
  console, Math, JSON, Date, Promise, Set, Map, WeakMap, Symbol, Proxy, Reflect, Error, TypeError, RangeError,
  Uint8Array, Uint8ClampedArray, Int16Array, Int32Array, Uint16Array, Uint32Array, Float32Array, Float64Array, ArrayBuffer, DataView,
  parseInt, parseFloat, isNaN, isFinite, Number, String, Boolean, Array, Object, Function, RegExp, encodeURIComponent, decodeURIComponent, escape, unescape,
  setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop, queueMicrotask: (fn) => Promise.resolve().then(fn),
  requestAnimationFrame: () => 0, cancelAnimationFrame: noop, performance: { now: () => simNow * 1000 },
  navigator: { getGamepads: () => [], userAgent: 'node-balance' },
  localStorage: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); }, removeItem: (k) => { delete storage[k]; }, clear: () => { for (const k in storage) delete storage[k]; } },
  document: { getElementById: (id) => elements[id] || null, createElement: (t) => (t === 'canvas' ? canvasStub() : { style: {}, click: noop, remove: noop, appendChild: noop, addEventListener: noop, setAttribute: noop }), body: { appendChild: noop, style: {} }, addEventListener: noop, removeEventListener: noop, hidden: false, fonts: { load: () => Promise.resolve(), ready: Promise.resolve() } },
  location: { search: '', href: 'http://balance/' }, innerWidth: 1400, innerHeight: 820, devicePixelRatio: 1, addEventListener: noop, removeEventListener: noop,
  Blob: function () {}, URL: { createObjectURL: () => 'blob:x', revokeObjectURL: noop }, FileReader: function () {}, AudioContext: undefined, webkitAudioContext: undefined,
  URLSearchParams, HM: { headless: true },
};
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
vm.createContext(sandbox);
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const errors = new Map();
function report(where, e) { const key = e && e.stack ? e.stack.split('\n').slice(0, 2).join(' | ') : String(e); if (!errors.has(key)) errors.set(key, { where, count: 0, stack: e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : String(e) }); errors.get(key).count++; }
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1])) {
  try { vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f }); }
  catch (e) { report('load ' + f, e); const st = path.join(ROOT, 'src/stubs', path.basename(f)); if (fs.existsSync(st)) { console.log('!! ' + f + ' failed to load — stub'); vm.runInContext(fs.readFileSync(st, 'utf8'), sandbox, { filename: 'stub:' + f }); } }
}
const HM = sandbox.HM, M = HM.M;
const consoleErrors = new Map();
sandbox.console = Object.assign({}, console, { error: (...a) => { const k = a.map(String).join(' ').slice(0, 160); consoleErrors.set(k, (consoleErrors.get(k) || 0) + 1); } });
function guard(where, fn) { try { return fn(); } catch (e) { report(where, e); return undefined; } }
guard('init', () => { HM.R.init(null, { headless: true, w: 1400, h: 820 }); HM.UI.init(elements.ui); HM.Save.use(1, 'Balance'); HM.Game.init(); });
// UI is not under test here: a UI exception (another module mid-edit) must not abort Game.update
const uiErr = new Map();
for (const k of ['update', 'draw']) { const f = HM.UI && HM.UI[k]; if (typeof f === 'function') HM.UI[k] = function () { try { return f.apply(this, arguments); } catch (e) { const m = String(e && e.message); uiErr.set(m, (uiErr.get(m) || 0) + 1); } }; }
// hints / dialogue must not pause the fight
guard('settings', () => { if (HM.Save.setSetting) HM.Save.setSetting('hints', false); });

const DT = 1 / 60;
function step() { simNow += DT; guard('beginFrame', () => HM.Input.beginFrame(HM.Game.realT + DT)); guard('update', () => HM.Game.update(DT)); guard('draw', () => HM.Game.draw()); }
function press(code) { HM.Input._pressedEdge.add(code); HM.Input.down.add(code); }
function hold(code) { HM.Input.down.add(code); }
function releaseAll() { for (const c of [...HM.Input.down]) { HM.Input.down.delete(c); HM.Input._releasedEdge.add(c); } }

// ---------------------------------------------------------------- deterministic bot rng
let seed = 1;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// ---------------------------------------------------------------- threat reading
const TAU = Math.PI * 2;
// Is p inside telegraph T (with margin)? Returns null or {ex, ey, d} = unit escape direction + distance to get out.
function teleInside(T, p, mg) {
  const dx = p.x - T.x, dy = p.y - T.y, d = Math.hypot(dx, dy) || 0.001;
  if (T.shape === 'circle' || T.shape === 'ring') {
    if (d > T.r + mg) return null;
    if (T.shape === 'ring' && d < (T.r0 || 0) - mg) return null;
    return { ex: dx / d, ey: dy / d, d: T.r + mg - d };
  }
  if (T.shape === 'cone') {
    const L = T.len || T.r || 120; if (d > L + mg) return null;
    const a = Math.atan2(dy, dx), da = M.angleDiff(T.ang, a);
    if (Math.abs(da) > (T.half || 0.5) + Math.asin(Math.min(1, mg / d))) return null;
    // sideways out of the cone (toward the nearer edge), or straight back if that is shorter
    const side = da >= 0 ? 1 : -1, sa = T.ang + side * (Math.PI / 2);
    const lat = Math.sin((T.half || 0.5) - Math.abs(da)) * d + mg;
    const back = L + mg - d;
    return lat < back ? { ex: Math.cos(sa), ey: Math.sin(sa), d: lat } : { ex: dx / d, ey: dy / d, d: back };
  }
  // line (from x,y) / rect (centred)
  const ca = Math.cos(T.ang), sa = Math.sin(T.ang), L = T.len || 120, hw = (T.w || 26) / 2;
  const ox = T.shape === 'rect' ? T.x - ca * L / 2 : T.x, oy = T.shape === 'rect' ? T.y - sa * L / 2 : T.y;
  const qx = p.x - ox, qy = p.y - oy, along = qx * ca + qy * sa, across = -qx * sa + qy * ca;
  if (along < -mg || along > L + mg || Math.abs(across) > hw + mg) return null;
  const s = across >= 0 ? 1 : -1;
  return { ex: -sa * s, ey: ca * s, d: hw + mg - Math.abs(across) };
}

function botStep(st) {
  const G = HM.Game, p = G.player, b = st.boss; if (!p || p.dead || !b) return;
  releaseAll();
  const now = G.t;
  const ranged = HERO === 'fp';
  const d = Math.hypot(b.x - p.x, b.y - p.y);
  const s = HM.R.worldToScreen(b.x, b.y, (b.height || 60) * 0.4); HM.Input.mouse.sx = s[0]; HM.Input.mouse.sy = s[1];
  // base intent: hold a ring around the boss (melee hugs it; ranged keeps ~210), strafing
  const want = ranged ? 210 : (b.radius || 16) + 34;
  const a = Math.atan2(p.y - b.y, p.x - b.x) + st.strafe * 0.5;
  let mx = (b.x + Math.cos(a) * want - p.x), my = (b.y + Math.sin(a) * want - p.y);
  { const l = Math.hypot(mx, my); if (l > 1) { mx /= l; my /= l; } else { mx = my = 0; } }
  if (now > st.strafeT) { st.strafe = -st.strafe; st.strafeT = now + 2 + rnd() * 3; }
  let ex = 0, ey = 0, danger = false, rollDir = null;
  const pr = p.radius + 4;
  // --- telegraphs
  const list = (HM.FX.telegraphList && HM.FX.telegraphList()) || [];
  for (const T of list) {
    if (T.dead || T.done) continue;
    if (T._seen === undefined) T._seen = rnd() < REACT;
    if (!T._seen || T.t < 0.22) continue;
    const q = teleInside(T, p, pr); if (!q) continue;
    danger = true;
    const left = T.dur - T.t;
    ex += q.ex * 3; ey += q.ey * 3;
    if (q.d / (p.speed * 0.9) > left - 0.04 && left < 0.17 && left > 0.04) rollDir = [q.ex, q.ey];
  }
  // --- boss hazards (zones)
  for (const z of G.zones) {
    if (z.dead || z.dying || z.team !== 1) continue;
    const zd = Math.hypot(p.x - z.x, p.y - z.y) || 0.001;
    if (z.rr !== undefined && z.band && z.spec && !z.ending) { // expanding ring: roll through as the band arrives
      if (z._seen === undefined) z._seen = rnd() < REACT;
      if (!z._seen || z.once.has(p.id) || zd < z.rr) continue;
      const tArr = (zd - z.rr - z.band * 0.5 - p.radius * 0.6) / z.speed;
      if (tArr < 0.45) danger = true;   // stop committing to swings: a roll is coming
      if (tArr < 0.15) rollDir = rollDir || [(z.x - p.x) / zd, (z.y - p.y) / zd];
      continue;
    }
    if (z.orbs) { // marching orb line
      if (z._seen === undefined) z._seen = rnd() < REACT;
      if (!z._seen || z.t < z.warm) continue;
      for (const ob of z.orbs) {
        if (!ob.alive) continue;
        const od = Math.hypot(p.x - ob.x, p.y - ob.y);
        const ahead = (p.x - ob.x) * z.dx + (p.y - ob.y) * z.dy;
        if (od < 26 + pr + z.speed * 0.2 && ahead > -10) { rollDir = rollDir || [z.dx, z.dy]; break; }
      }
      continue;
    }
    if (z.o && z.ex !== undefined && z.o.len) { // beam: step out sideways
      const dd = M.distToSeg(p.x, p.y, z.x, z.y, z.ex, z.ey);
      if (dd < z.o.w * 0.5 + 34) { const ang = Math.atan2(z.ey - z.y, z.ex - z.x); const side = ((p.x - z.x) * -Math.sin(ang) + (p.y - z.y) * Math.cos(ang)) >= 0 ? 1 : -1; ex += -Math.sin(ang) * side * 3; ey += Math.cos(ang) * side * 3; danger = true; }
      continue;
    }
    if (z.half !== undefined && z.range && z.owner) { // breath cone
      if (zd < z.range + 20 && Math.abs(M.angleDiff(z.ang, Math.atan2(p.y - z.y, p.x - z.x))) < z.half + 0.25) { const side = M.angleDiff(z.ang, Math.atan2(p.y - z.y, p.x - z.x)) >= 0 ? 1 : -1; ex += Math.cos(z.ang + side * 1.57) * 3; ey += Math.sin(z.ang + side * 1.57) * 3; danger = true; }
      continue;
    }
    if (z.spikes && z.o && z.o.persist) { for (const sp of z.spikes) if (sp.up && Math.hypot(p.x - sp.x, p.y - sp.y) < z.o.r + 14) { ex += (p.x - sp.x) / 20; ey += (p.y - sp.y) / 20; danger = true; } continue; }
    if (z.rx !== undefined && z.persist && z.shrink) { const u = Math.hypot((p.x - z.x) / z.rx, (p.y - z.y) / z.ry); if (u > 0.8) { ex += (z.x - p.x) / zd * 2; ey += (z.y - p.y) / zd * 2; danger = true; } continue; }
    if (z.onTick && z.r && !z.persist && zd < z.r + pr + 4 && z.r < 200) { ex += (p.x - z.x) / zd; ey += (p.y - z.y) / zd; danger = true; }
  }
  for (const z of G.zones) { // monster ground fire (enemies.js fireZone etc.) also counts
    if (z.dead || z.team !== 1 || z.owner || !z.onTick || z.r > 200) continue;
    const zd = Math.hypot(p.x - z.x, p.y - z.y) || 0.001; if (zd < z.r + pr) { ex += (p.x - z.x) / zd; ey += (p.y - z.y) / zd; danger = true; }
  }
  // incoming projectiles: roll across their path just before they arrive
  for (const q of G.projectiles) {
    if (q.dead || q.team !== 1 || !q.damage) continue;
    const rx = p.x - q.x, ry = p.y - q.y, v2 = q.vx * q.vx + q.vy * q.vy; if (v2 < 1) continue;
    const tc = (rx * q.vx + ry * q.vy) / v2; if (tc < 0 || tc > 0.5) continue;
    if (tc > 0.28) { if (Math.hypot(q.x + q.vx * tc - p.x, q.y + q.vy * tc - p.y) < pr + 14) danger = true; continue; }
    const cx = q.x + q.vx * tc - p.x, cy = q.y + q.vy * tc - p.y;
    if (Math.hypot(cx, cy) > pr + (q.r || 6) + 6) continue;
    if (q._seen === undefined) q._seen = rnd() < REACT;
    if (!q._seen) continue;
    const vl = Math.sqrt(v2); rollDir = rollDir || [-q.vy / vl, q.vx / vl];
  }
  // adds on top of us get cut down first (a reasonable player does not ignore them)
  let add = null, addD = 80;
  for (const e of G.entities) { if (e === b || e.dead || e.team !== 1 || e.hidden || e.neutral || e.state === 'dormant') continue; const ed = Math.hypot(e.x - p.x, e.y - p.y); if (ed < addD) { addD = ed; add = e; } }
  if (add && !ranged) { const s2 = HM.R.worldToScreen(add.x, add.y, (add.height || 40) * 0.4); HM.Input.mouse.sx = s2[0]; HM.Input.mouse.sy = s2[1]; mx = (add.x - p.x) / (addD || 1) * (addD > 40 ? 1 : 0); my = (add.y - p.y) / (addD || 1) * (addD > 40 ? 1 : 0); }
  let vx = mx, vy = my;
  if (danger) { const l = Math.hypot(ex, ey); if (l > 0.01) { vx = ex / l; vy = ey / l; } }
  if (rollDir && p.dodgeCharges >= 1 && now - st.lastRoll > 0.3) { vx = rollDir[0]; vy = rollDir[1]; press('Space'); st.lastRoll = now; DBG.lastRoll = now; st.rolls++; }
  if (vx > 0.3) hold('KeyD'); if (vx < -0.3) hold('KeyA'); if (vy > 0.3) hold('KeyS'); if (vy < -0.3) hold('KeyW');
  // attacks (a reasonable player keeps swinging unless busy escaping)
  const f = st.frame++;
  const inRange = ranged ? d < 330 : (d < want + 34 || !!add);
  if (inRange && !danger) {
    if (f % 6 === 0) press('Mouse0');
    if (f % 55 === 0) press('Mouse2');
    if (f % 97 === 0) press('KeyQ');
    if (f % 131 === 0) press('KeyE');
    if (f % 600 === 300 && p.ultCharge !== undefined) press('KeyR');
  }
  // pancakes
  if (p.hp < p.maxHp * 0.35 && now - st.lastPot > 2.5) { st.lastPot = now; st.pancakes++; HM.Combat.heal(p, p.maxHp * 0.35); }
}

// ---------------------------------------------------------------- run
const rows = [];
let taken = 0, byKey = {}, deaths = 0;
HM.Events.on('damage', (info) => {
  const p = HM.Game.player; if (!info.target || info.target !== p || !(info.dealt > 0)) return;
  taken += info.dealt;
  const b = curBoss, s = info.source;
  const tg = info.spec && info.spec.tags ? info.spec.tags.find((x) => typeof x === 'string' && x.indexOf('pat:') === 0) : null;
  let key = tg ? tg.slice(4) : s === b ? (b && b.main ? b.main.name : 'bg/' + ((b && b.state) || '?')) : s ? (s.summoned ? 'add:' : '') + (s.defId || s.kind || '?') : (info.isDot ? 'status' : 'env');
  if (info.isDot) key += '(dot)';
  byKey[key] = (byKey[key] || 0) + info.dealt;
  if (DEBUG && key.indexOf(DEBUG) === 0) {
    const z = HM.Game.zones.find((q) => q.rr !== undefined && q.pat === DEBUG && !q.dead);
    console.log(`  hit ${key} t=${HM.Game.t.toFixed(2)} amt=${info.dealt.toFixed(0)} act=${p.act ? p.act.kind + '@' + p.act.t.toFixed(2) : '-'} iframe=${(p.iframeT || 0).toFixed(2)} dBoss=${b ? Math.hypot(b.x - p.x, b.y - p.y).toFixed(0) : '-'} rr=${z ? z.rr.toFixed(0) : '-'} lastRoll=${(HM.Game.t - (DBG.lastRoll || 0)).toFixed(2)} charges=${p.dodgeCharges}`);
  }
  if (p.hp <= 0.5) { deaths++; p.hp = p.maxHp * 0.6; }
});
let curBoss = null;
guard('newRun', () => HM.Game.newRun(HERO, { seed: 4242 }));
const gearRng = () => new HM.RNG(9001);
for (const fl of FLOORS) {
  const res = { fl, trials: [] };
  for (let tr = 0; tr < TRIALS; tr++) {
    seed = 1000 + fl * 31 + tr * 7;
    const G = HM.Game, run = G.run;
    run.level = LEVELS[fl] || Math.max(1, fl - 1); run.hp = null; run.mp = null; run.seed = 4242 + tr * 101;
    const rg = gearRng();
    const roll = (slot, rar) => HM.Items.rollItem({ floorIndex: Math.max(1, fl - 1), slot, rarity: rar, heroId: HERO, rng: rg });
    run.inventory.equipped = { weapon: roll('weapon', 'magic'), armor: roll('armor', 'magic'), trinket: roll('trinket', 'magic') };
    guard('enterFloor', () => G.enterFloor(fl));
    const p = G.player;
    p.stats.dmgMul *= DMG; p.hp = p.maxHp;
    const boss = HM.Bosses.active(); curBoss = boss;
    if (!boss) { res.trials.push({ err: 'no boss' }); continue; }
    taken = 0; byKey = {}; deaths = 0;
    const st = { boss, strafe: 1, strafeT: 0, lastRoll: -9, rolls: 0, frame: 0, lastPot: -9, pancakes: 0 };
    // walk to the boss until it wakes
    let t = 0, start = null, end = null;
    const n = Math.round(SECONDS * 60);
    for (let k = 0; k < n; k++) {
      t += DT;
      guard('bot', () => botStep(st));
      step();
      if (start === null && boss.state === 'fight') start = t;
      if (boss.dead && end === null) { end = t; break; }
      if (G.state !== 'play') { if (G.state === 'dead') guard('revive', () => G.setState('play')); else break; }
    }
    const dur = (end === null ? t : end) - (start === null ? t : start);
    res.trials.push({ dur, killed: end !== null, phase: boss.phase, hpLeft: boss.hp / boss.maxHp, taken, maxHp: p.maxHp, pancakes: st.pancakes, deaths, rolls: st.rolls, byKey: Object.assign({}, byKey), dmgUnit: boss.dmgUnit, bossHp: boss.maxHp });
  }
  rows.push(res);
}
for (const r of rows) {
  for (const [i, x] of r.trials.entries()) {
    if (x.err) { console.log(`f${r.fl} trial ${i}: ${x.err}`); continue; }
    const top = Object.entries(x.byKey).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${Math.round(v)}`).join(', ');
    console.log(`f${String(r.fl).padStart(2)} L${LEVELS[r.fl]} ${HERO}#${i}: ${x.killed ? 'killed' : 'ALIVE p' + x.phase + ' ' + Math.round(x.hpLeft * 100) + '%'} in ${x.dur.toFixed(0)}s | took ${Math.round(x.taken)} = ${(x.taken / x.maxHp).toFixed(2)}x maxHp (${x.maxHp}) | ${(x.taken / Math.max(1, x.dur) * 60).toFixed(0)}/min | pancakes ${x.pancakes} deaths ${x.deaths} rolls ${x.rolls} | dmgUnit ${x.dmgUnit.toFixed(1)} bossHp ${x.bossHp}`);
    if (!QUIET) console.log('      top: ' + top);
  }
}
if (uiErr.size) { console.log('\nUI errors (ignored, not under test):'); for (const [k, v] of uiErr) console.log(`  x${v} ${k}`); }
if (consoleErrors.size) { console.log('\nconsole.error:'); for (const [k, v] of consoleErrors) console.log(`  x${v} ${k}`); }
if (errors.size) { console.log(`\n${errors.size} unique error(s):`); for (const [, e] of errors) console.log(`\n[${e.where}] x${e.count}\n${e.stack}`); process.exit(1); }
console.log('\nBALANCE DONE');
