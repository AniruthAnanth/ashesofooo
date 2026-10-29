#!/usr/bin/env node
// Prologue harness (DESIGN §9A): loads the game headless (same sandbox as tools/smoke.js), then for each hero plays
// "The Tree Fort Clearing" with a scripted bot and asserts that every beat completes, in order, by the player's own
// actions (no timeout fallbacks), and that it ends on floor 1 with a fresh run. Also checks Skip Prologue (API + pause
// menu), resume-mid-prologue, the sandbox rules (no kills/bestiary), and the fallback layout when World has no prologue.
//
// usage: node tools/tests/prologue.js [--heroes finn,marceline,fp] [--max 300] [--shots] [--verbose]
//   --shots   also renders one screenshot per beat with tools/shot.sh into the scratchpad shots/prologue/ folder
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const VERBOSE = args.includes('--verbose');
const MAX_T = parseFloat(opt('max', '300'));
const SHOTS = args.includes('--shots');
const SHOT_DIR = opt('shotdir', require('os').tmpdir() + '/ashes-shots/prologue');

// ---- sandbox: reuse tools/smoke.js's stubs + script loading (everything above its "boot" section)
let src = fs.readFileSync(path.join(ROOT, 'tools/smoke.js'), 'utf8').replace(/^#!.*\n/, '');
const head = src.slice(0, src.indexOf('// ---------------------------------------------------------------- boot'));
const H = new Function('require', '__dirname', 'process', 'module', head.replace("'use strict';", '') +
  '\nreturn { sandbox, elements, storage, HM: sandbox.HM, setNow: (v) => { simNow = v; }, getNow: () => simNow, errors };')(
  require, path.join(ROOT, 'tools'), { argv: ['', ''], hrtime: process.hrtime, exit: process.exit }, {});
const HM = H.HM, I = HM.Input, G = () => HM.Game, T = () => HM.Tutorial;
HM.R.init(null, { headless: true, w: 1400, h: 820 }); HM.UI.init(H.elements.ui); HM.Save.use(1, 'Prologue'); HM.Game.init();

const DT = 1 / 60;
let frames = 0, frameMs = 0;
function step(n) {
  for (let k = 0; k < (n || 1); k++) {
    H.setNow(H.getNow() + DT);
    const t0 = process.hrtime.bigint();
    try { I.beginFrame(G().realT + DT); G().update(DT); G().draw(); } catch (e) { report('frame', e); }
    frameMs += Number(process.hrtime.bigint() - t0) / 1e6; frames++;
  }
}
const errs = new Map();
function report(where, e) { const k = (e && e.stack ? e.stack.split('\n').slice(0, 2).join(' | ') : String(e)); if (!errs.has(k)) errs.set(k, { where, n: 0, stack: e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : String(e) }); errs.get(k).n++; }
const press = (c) => { I._pressedEdge.add(c); I.down.add(c); };
const release = (c) => { I.down.delete(c); I._releasedEdge.add(c); };
const releaseAll = () => { for (const c of [...I.down]) release(c); };
const key = (c, n) => { press(c); step(1); release(c); step(n === undefined ? 2 : n); };
let fails = 0, passes = 0, warns = 0;
function ok(c, msg) { if (c) { passes++; console.log('  ok   ' + msg); } else { fails++; console.log('  FAIL ' + msg); } }
function warn(msg) { warns++; console.log('  warn ' + msg); }
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function aimAt(x, y, z) { const s = HM.R.worldToScreen(x, y, z || 0); I.mouse.sx = s[0]; I.mouse.sy = s[1]; }

// ---- coarse BFS path planner on World.isSolid (16-unit grid), so the bot walks around walls and through gaps
const GS = 16;
const plan = { goal: null, t: -9, path: [], gw: 0, gh: 0, walk: null };
function cellFree(x, y) { const W = HM.World; if (!W.isSolid) return true; if (W.isSolid(x, y)) return false; for (let a = 0; a < 12; a++) { const c = Math.cos(a * 0.5236), s = Math.sin(a * 0.5236); if (W.isSolid(x + c * 11, y + s * 11) || W.isSolid(x + c * 6, y + s * 6)) return false; } return true; }
function replan(p, goal) {
  const F = G().floor; const gw = Math.ceil(F.w / GS), gh = Math.ceil(F.h / GS);
  const walk = new Uint8Array(gw * gh); for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) walk[j * gw + i] = cellFree((i + 0.5) * GS, (j + 0.5) * GS) ? 1 : 0;
  const ci = (x, y) => Math.max(0, Math.min(gh - 1, Math.floor(y / GS))) * gw + Math.max(0, Math.min(gw - 1, Math.floor(x / GS)));
  const s = ci(p.x, p.y); let g = ci(goal.x, goal.y);
  walk[s] = 1;
  // BFS over everything reachable; if the goal cell itself is blocked/unreachable, head for the reachable cell nearest it
  const prev = new Int32Array(gw * gh).fill(-1); const q = [s]; prev[s] = s;
  const gx0 = goal.x / GS, gy0 = goal.y / GS; let best = s, bd = 1e18;
  for (let h = 0; h < q.length; h++) {
    const c = q[h]; const cx = c % gw, cy = (c / gw) | 0;
    const dd = (cx + 0.5 - gx0) ** 2 + (cy + 0.5 - gy0) ** 2; if (dd < bd) { bd = dd; best = c; }
    if (c === g) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const nx = cx + dx, ny = cy + dy; if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const n = ny * gw + nx; if (!walk[n] || prev[n] >= 0) continue;
      if (dx && dy && (!walk[cy * gw + nx] || !walk[ny * gw + cx])) continue;
      prev[n] = c; q.push(n);
    }
  }
  if (prev[g] < 0) g = best;
  const out = [];
  for (let c = g; c !== s; c = prev[c]) out.push({ x: (c % gw + 0.5) * GS, y: (((c / gw) | 0) + 0.5) * GS });
  out.reverse(); if (g === ci(goal.x, goal.y)) out.push({ x: goal.x, y: goal.y }); plan.path = out.length ? out : [{ x: goal.x, y: goal.y }];
}
function walkTo(p, goal, stopAt) {
  if (!goal) return true;
  const d = dist(p, goal); if (d <= (stopAt || 10)) return true;
  const now = G().t;
  if (!plan.goal || dist(plan.goal, goal) > 24 || now - plan.t > 0.6) { plan.goal = { x: goal.x, y: goal.y }; plan.t = now; replan(p, goal); }
  while (plan.path.length > 1 && dist(p, plan.path[0]) < 12) plan.path.shift();
  const wp = plan.path[0] || goal;
  let dx = wp.x - p.x, dy = wp.y - p.y; const l = Math.hypot(dx, dy) || 1;
  // unstick: no progress for half a second → sidestep for a moment
  if (!plan.chk || now - plan.chk.t > 0.5) { plan.stuck = plan.chk && dist(p, plan.chk) < 3 ? now : plan.stuck; plan.chk = { x: p.x, y: p.y, t: now }; }
  if (plan.stuck && now - plan.stuck < 0.35) { const sx = -dy, sy = dx; dx = sx; dy = sy; plan.t = -9; }
  if (dx / l > 0.38) press('KeyD'); if (dx / l < -0.38) press('KeyA'); if (dy / l > 0.38) press('KeyS'); if (dy / l < -0.38) press('KeyW');
  return false;
}

// ---- the bot: one decision per frame, by beat
const B = { lastF: -99, frame: 0 };
function every(n) { return B.frame % n === 0; }
function bot() {
  B.frame++;
  const Gm = G(), p = Gm.player, Tu = T();
  releaseAll();
  if (!p) return;
  if (HM.UI.dialogueOpen || HM.UI.actCardOpen) { if (every(14)) press('Enter'); return; }
  if (Gm.state === 'note') { if (every(16)) press('Enter'); return; }
  if (Gm.state !== 'play' || !Tu.active) return;
  const id = Tu.beatId, st = Tu.st || {}, E = Tu.ents, Bt = Tu.B;
  const aim = (a) => aimAt(a.x, a.y, (a.height || 40) * 0.5);
  switch (id) {
    case 'intro': return;
    case 'move': walkTo(p, Bt.lanterns[Math.min(1, Bt.lanterns.length - 1)], 20); return;
    case 'interact': { const s = E.sword; walkTo(p, s, 14); if (Gm.interactTarget === s && every(10)) press('KeyF'); return; }
    case 'attack': {
      const d = E.dummies.filter((a) => !a.dead).sort((a, b) => dist(a, p) - dist(b, p))[0]; if (!d) return;
      aim(d); const reach = p.heroId === 'fp' ? 150 : 34;
      if (walkTo(p, d, reach)) press('Mouse0');
      return;
    }
    case 'dodge': {
      const s = E.sentinel; if (!s || s.dead) return;
      // stand inside the slam zone's near end and roll toward the Sentinel just before it lands
      const c = Math.cos(s.dir), sn = Math.sin(s.dir), back = s.len / 2 - 22;
      const A = { x: s.c.x - c * back, y: s.c.y - sn * back };
      aimAt(s.c.x, s.c.y, 20);
      const inZone = s.contains(p, -4);
      if (s.phase === 'tele' && s.nextSlamIn <= 0.2 && s.nextSlamIn > 0.1 && p.dodgeCharges >= 1 && inZone) { releaseAll(); press('Space'); }
      else if (!(inZone && s.phase === 'tele' && s.nextSlamIn < 0.45)) walkTo(p, A, 10);
      return;
    }
    case 'heavy': {
      const b = E.barricade; if (!b || b.broken) return;
      const stand = p.heroId === 'fp' ? 110 : p.heroId === 'marceline' ? 60 : 34;
      aimAt(b.x, b.y, 20);
      walkTo(p, b, stand + b.radius);
      if (dist(p, b) < stand + b.radius + 30) { B.hv = (B.hv || 0) + 1; if (B.hv % 50 < 20) press('Mouse2'); }
      return;
    }
    case 'skills': {
      const e = E.pack.filter((a) => a && !a.dead).sort((a, b) => dist(a, p) - dist(b, p))[0];
      if (!e) return;
      aim(e);
      const near = walkTo(p, e, p.heroId === 'fp' ? 130 : 40);
      if (dist(p, e) < 200) {
        const s1 = p.skills.find((s) => s.slot === 'skill1'), s2 = p.skills.find((s) => s.slot === 'skill2');
        if (!st.used1 && s1.cdLeft <= 0 && every(8)) press('KeyQ');
        else if (st.used1 && !st.used2 && s2.cdLeft <= 0 && !(p.act && p.act.kind === 'channel') && every(8)) press('KeyE');
        else if (p.act && p.act.kind === 'channel' && p.act.t > 0.8 && every(8)) press('KeyQ'); // stop Drain
        else if (near && every(3)) press('Mouse0');
      }
      return;
    }
    case 'potion': {
      if (!st.sprung) { walkTo(p, Bt.trap, 6); return; }
      if (every(20)) press('Digit1');
      return;
    }
    case 'ult': {
      const c = E.captain; if (!c || c.dead) return;
      aim(c);
      const near = walkTo(p, c, p.heroId === 'fp' ? 140 : 40);
      if (dist(p, c) < 220 && !c.hidden && c.state !== 'rising') {
        const u = p.skills.find((s) => s.slot === 'ult');
        if (u.cdLeft <= 0 && every(10)) press('KeyR');
        else if (near && every(3)) press('Mouse0');
      }
      return;
    }
    case 'read': { if (st.phase !== 'wait') return; walkTo(p, E.page || Bt.page, 14); if (Gm.interactTarget && Gm.interactTarget === E.page && every(10)) press('KeyF'); return; }
    case 'door': { const d = Gm.floor.exit || Bt.door; walkTo(p, d, 14); if (Gm.interactTarget && Gm.interactTarget.kind === 'portal' && every(10)) press('KeyF'); return; }
    default: return;
  }
}

function startPrologue(hero, seed) {
  for (const c of [...I.down]) release(c);
  plan.goal = null; B.hv = 0;
  G().newRun(hero, { seed: seed || 7, prologue: true });
  step(2);
}

// ---- 1. play through, per hero
const heroes = (opt('heroes', '') ? opt('heroes').split(',') : HM.Heroes.list.map((h) => h.id));
const timings = {};
for (const hero of heroes) {
  console.log(`\n[${hero}] play the prologue`);
  HM.Save.data.meta.prologueDone = false;
  const best0 = JSON.stringify(HM.Save.data.meta.bestiary || {});
  HM.Save.data.meta.achievements = {}; HM.Save.data.meta.tally = {};
  startPrologue(hero, 7);
  const F0 = G().floor;
  ok(F0 && F0.isPrologue && G().run.floorIndex === 0, 'newRun(hero, {prologue:true}) enters floor 0 (isPrologue)');
  ok(T().active && T().beatId === 'intro', 'HM.Tutorial active on the intro beat');
  if (!(F0 && F0.beats)) warn('World has no prologue map yet (F.beats missing) — running on the Tutorial fallback layout');
  const p0 = G().player;
  ok(p0.weapon && (p0.weapon.kind === 'fists' || p0.weapon.kind === 'none'), 'hero starts unarmed (weapon waits at the door): ' + (p0.weapon && p0.weapon.kind));
  // locked verbs before their beats
  step(70);
  const sk1 = p0.skills.find((s) => s.slot === 'skill1');
  key('KeyQ', 3); ok(!(p0.act && p0.act.slot === 'skill1') && sk1.cdLeft === 0, 'skills are locked before their beat');
  key('Space', 3); ok(!(p0.act && p0.act.kind === 'dodge'), 'dodge is locked before its beat');
  const seen = []; let lastId = null; const t0 = G().t, beatT = {};
  let tFloor1 = -1;
  while (G().t - t0 < MAX_T) {
    bot(); step(1);
    const Tu = T();
    if (Tu.beatId && Tu.beatId !== lastId) { lastId = Tu.beatId; seen.push(lastId); beatT[lastId] = G().t - t0; if (VERBOSE) console.log(`    t=${(G().t - t0).toFixed(1)}s → ${lastId}`); }
    if (process.env.PDBG && Tu.beatId === process.env.PDBG && B.frame % 60 === 0) { const pp = G().player, a = pp.act; console.log('     dbg', Tu.beatId, 'p', pp.x.toFixed(0), pp.y.toFixed(0), 'act', a && a.slot, a && a.t.toFixed(2), 'st', JSON.stringify(Tu.st).slice(0, 160)); }
    if (G().run && G().run.floorIndex === 1 && G().floor && !G().floor.isPrologue) { tFloor1 = G().t - t0; break; }
    if (G().player && G().player.dead) { ok(false, 'hero died in the prologue'); break; }
  }
  timings[hero] = beatT;
  const log = T().log.map((e) => e.id);
  const forced = T().log.filter((e) => e.forced).map((e) => e.id);
  ok(JSON.stringify(log) === JSON.stringify(T().BEAT_IDS), 'every beat completed in order: ' + log.join(' → '));
  ok(forced.length === 0, 'no beat needed its timeout fallback' + (forced.length ? ' (forced: ' + forced.join(', ') + ')' : ''));
  const info = (id) => (T().log.find((e) => e.id === id) || {}).info || {};
  ok(info('dodge').evaded === true && !info('dodge').slipped, 'dodge beat passed by rolling THROUGH the slam (evade), hits taken: ' + (info('dodge').hits || 0));
  ok(info('attack').hit === true, 'attack beat: combo hint shown after the first hit');
  ok(info('skills').used1 === true && info('skills').used2 === true, 'skills beat: both skills used');
  ok(info('potion').sprung === true && info('potion').ate === true, 'potion beat: trap sprung, pancake eaten');
  ok(info('ult').used === true, 'ult beat: ultimate used on the Bone Captain');
  if (VERBOSE) for (const e of T().log) console.log('    ' + e.id.padEnd(9) + ' ' + (e.dur || 0).toFixed(1) + 's ' + JSON.stringify(e.info || {}));
  ok(tFloor1 > 0, `descended to floor 1 after ${tFloor1.toFixed(1)} s of play`);
  const Gm = G(), p = Gm.player;
  ok(Gm.floor && Gm.floor.index === 1 && !Gm.floor.isPrologue && !T().active, 'floor 1 is a normal floor, tutorial inactive');
  ok(HM.Save.data.meta.prologueDone === true, 'meta.prologueDone = true');
  ok(p && Math.abs(p.hp - p.maxHp) < 0.5, 'hp restored on floor 1');
  ok(Gm.run.kills === 0 && Gm.run.level === 1 && Gm.run.xp === 0, 'prologue kills/xp did not carry over (fresh run)');
  ok(JSON.stringify(HM.Save.data.meta.bestiary || {}) === best0, 'prologue kills did not touch the bestiary');
  ok(Object.keys(HM.Save.data.meta.achievements || {}).length === 0, 'no achievements from prologue kills (' + Object.keys(HM.Save.data.meta.achievements || {}).join(',') + ')');
  ok(Gm.run.inventory.equipped.weapon && Gm.run.inventory.equipped.weapon.starter, 'floor 1 run has its starter weapon equipped');
  ok(Gm.run.consumables.pancake >= 2, 'fresh pancakes on floor 1 (' + Gm.run.consumables.pancake + ')');
  ok(HM.Save.data.run && HM.Save.data.run.floorIndex === 1, 'checkpoint saved at floor 1');
  step(30);
  if (VERBOSE) console.log('    beat start times', JSON.stringify(Object.fromEntries(Object.entries(beatT).map(([k, v]) => [k, +v.toFixed(1)]))));
}

// ---- 2. skip via API
console.log('\n[skip prologue]');
{
  HM.Save.data.meta.prologueDone = false;
  startPrologue('finn', 11); step(120);
  ok(T().active, 'prologue running');
  T().skip(); step(3);
  ok(G().floor.index === 1 && !G().floor.isPrologue && G().state === 'play', 'HM.Tutorial.skip() → floor 1');
  ok(HM.Save.data.meta.prologueDone === true, 'skip also sets prologueDone');
  ok(!T().active && G().player.weapon && G().player.weapon.kind !== 'fists', 'fresh hero on floor 1 has a weapon');
}
// ---- 2b. skip via the pause menu (UI)
{
  startPrologue('marceline', 12); step(90);
  key('Escape', 3);
  ok(G().state === 'pause', 'Esc pauses the prologue');
  HM.UI.focus = 'p:skipPro'; key('Enter', 3);
  if (HM.UI.modal && HM.UI.modal.kind === 'confirm') {
    // pick the "skip it" button: the modal's yes button
    HM.UI.focus = 'm:yes'; key('Enter', 4);
    ok(G().floor && G().floor.index === 1 && !G().floor.isPrologue && G().state === 'play', 'pause → Skip Prologue → confirm → floor 1');
  } else warn('pause menu has no "Skip Prologue" confirm (UI not wired yet?) — state ' + G().state);
  if (G().state !== 'play') { G().setState('play'); step(2); }
}
// ---- 3. resume mid-prologue: quit to title, Continue → the prologue restarts
console.log('\n[resume]');
{
  startPrologue('fp', 13); step(60); T().debugJump('attack'); step(20);
  G().quitToTitle(); step(5);
  ok(HM.Save.data.run && HM.Save.data.run.floorIndex === 0, 'checkpoint holds floor 0');
  ok(G().resumeRun(), 'resumeRun()'); step(5);
  ok(G().floor.isPrologue && T().active && T().beatId === 'intro', 'resuming restarts the prologue from the top');
  ok(G().run.inventory.equipped.weapon === null && T().weaponItem, 'weapon is back at the door after resume');
  // abandon in the prologue records nothing
  const runs0 = HM.Save.data.meta.runs; G().abandonRun(); step(3);
  ok(G().state === 'title' && HM.Save.data.meta.runs === runs0 && !HM.Save.data.run, 'abandoning the prologue records no run and clears the checkpoint');
}
// ---- 4. debug jumps (used for screenshots) + sandbox safety
console.log('\n[jumps + safety]');
{
  startPrologue('finn', 14);
  for (const id of ['dodge', 'heavy', 'skills', 'potion', 'ult', 'read', 'door']) {
    T().debugJump(id); step(30);
    ok(T().beatId === id, 'debugJump → ' + id);
  }
  const p = G().player; HM.Combat.damage(p, { amount: 1e6, ignoreIframes: true }); step(2);
  ok(!p.dead && p.hp > 0, 'the hero cannot die in the prologue');
  T().skip(); step(2);
}
// ---- 4b. the lessons can't be skipped by accident
console.log('\n[gating]');
{
  startPrologue('finn', 16); step(70);
  const p = G().player;
  press('Mouse0'); step(40); release('Mouse0'); step(2);
  ok(!(p.act && p.act.kind === 'attack') && T().beatId !== 'attack', 'holding attack before taking the weapon does nothing');
  T().debugJump('dodge'); step(2);
  const s = T().ents.sentinel; const hp0 = p.hp;
  // walk straight through the gap without rolling, for 8 s
  plan.goal = null;
  const beyond = { x: s.x + Math.cos(s.dir) * 60, y: s.y + Math.sin(s.dir) * 60 };
  for (let k = 0; k < 480; k++) { releaseAll(); walkTo(p, beyond, 6); step(1); if (process.env.PDBG === 'gating' && k % 30 === 0) console.log('     dbg', k, p.x.toFixed(0), p.y.toFixed(0), s.phase, s.contains(p, 0), T().st.hits, 'path0', plan.path[0] && plan.path[0].x.toFixed(0), plan.path[0] && plan.path[0].y.toFixed(0)); }
  releaseAll(); step(2);
  ok(T().beatId === 'dodge' && !s.dead, 'walking into the slam without rolling does not pass the Sentinel');
  ok((T().st.hits || 0) >= 1 && p.hp < hp0, 'the slam hits a walker (' + (T().st.hits || 0) + ' hits) and knocks them back');
  T().skip(); step(2);
}
// ---- 5. camera clamp
console.log('\n[camera]');
{
  G().newRun('finn', { seed: 15 }); step(3);
  const F = G().floor, p = G().player, R = HM.R;
  p.x = 30; p.y = 30; for (let k = 0; k < 90; k++) step(1);
  const voidX = Math.max(0, -(G().cam.x - R.viewW / 2)) / R.viewW, voidY = Math.max(0, -(G().cam.y * HM.cfg.TILT - R.viewH / 2)) / R.viewH;
  ok(voidX <= 0.31 && voidX > 0.05, 'left edge: void is ' + (voidX * 100).toFixed(0) + '% of the view (≤30%, still visible)');
  ok(voidY <= 0.31 && voidY > 0.05, 'top edge: void is ' + (voidY * 100).toFixed(0) + '% of the view');
  p.x = F.w - 30; p.y = F.h - 30; for (let k = 0; k < 90; k++) step(1);
  const vR = Math.max(0, G().cam.x + R.viewW / 2 - F.w) / R.viewW;
  ok(vR <= 0.31 && vR > 0.05, 'right edge: void is ' + (vR * 100).toFixed(0) + '% of the view');
  G().quitToTitle(); step(2);
}

console.log(`\nframes ${frames}, avg ${(frameMs / Math.max(1, frames)).toFixed(2)} ms/frame`);
const all = new Map([...errs, ...H.errors]);
if (all.size) { console.log(`\n${all.size} unique error(s):`); for (const [, e] of all) console.log(`\n[${e.where}] x${e.n || e.count}\n${e.stack}`); }

// ---- optional: one screenshot per beat (headless Chrome via tools/shot.sh)
if (SHOTS) {
  const { execFileSync } = require('child_process');
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const enc = (s) => s.replace(/=/g, '%3D').replace(/\+/g, '%2B').replace(/&/g, '%26').replace(/ /g, '%20');
  // [name, beat to jump to, seconds after the jump to shoot, extra 'dt:js' actions relative to the jump]
  const J = 4.4; // after the PROLOGUE banner has faded
  const aimJs = (expr) => `var q=${expr},s=HM.R.worldToScreen(q.x,q.y,30);HM.Input.mouse.sx=s[0];HM.Input.mouse.sy=s[1]`;
  const beats = [
    ['intro', -1, 0, []],
    ['move', 1, 0.9, [[0.05, "HM.Input.down.add('KeyW')"]]],
    ['interact', 2, 1.2, []],
    ['attack', 3, 1.0, [[0.3, aimJs('HM.Tutorial.ents.dummies[1]')], [0.5, 'HM.Input.lastPress.attack=HM.Input.now'], [0.75, 'HM.Input.lastPress.attack=HM.Input.now']]],
    ['dodge', 4, 1.3, []],
    ['heavy', 5, 1.2, [[0.3, aimJs('HM.Tutorial.ents.barricade')]]],
    ['skills', 6, 2.0, [[1.2, aimJs('HM.Tutorial.ents.pack[0]')], [1.5, 'HM.Input.lastPress.skill1=HM.Input.now']]],
    ['potion', 7, 1.0, [[0.3, 'HM.Game.player.x=HM.Tutorial.B.trap.x;HM.Game.player.y=HM.Tutorial.B.trap.y+8']]],
    ['ult', 8, 2.4, [[1.6, aimJs('HM.Tutorial.ents.captain')]]],
    ['read', 9, 1.0, []],
    ['read_page', 9, 1.6, [[0.3, 'HM.Game.player.x=HM.Tutorial.ents.page.x;HM.Game.player.y=HM.Tutorial.ents.page.y+16'], [0.6, 'HM.Input.lastPress.interact=HM.Input.now']]],
    ['door', 10, 1.2, []],
  ];
  let n = 0;
  for (const [name, k, after, extra] of beats) {
    const acts = [`0.1:HM.Game.newRun('finn',{prologue:true,seed:7})`];
    let simT = 2.3;
    if (k >= 0) { acts.push(`${J}:HM.Tutorial.debugJump(${k})`); for (const [dt, js] of extra) acts.push(`${(J + dt).toFixed(2)}:${js}`); simT = J + after; }
    const q = acts.map(enc).join('|');
    const out = path.join(SHOT_DIR, String(n++).padStart(2, '0') + '_' + name + '.png');
    try { execFileSync(path.join(ROOT, 'tools/shot.sh'), [`hero=finn&nosave=1&seed=7&sim=${simT.toFixed(2)}&do=${q}`, out, '1400', '820', '3000'], { stdio: 'pipe' }); console.log('  shot ' + out); }
    catch (e) { console.log('  shot FAILED ' + name + ': ' + e.message); }
  }
}

console.log(`\n${passes} passed, ${fails} failed${warns ? ', ' + warns + ' warning(s)' : ''}`);
console.log(fails || all.size ? 'PROLOGUE FAIL' : 'PROLOGUE OK');
process.exit(fails || all.size ? 1 : 0);
