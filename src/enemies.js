// enemies.js — HM.Enemies: the dead and the damned of Ooo.
//  • defs: 15 foes across the five acts + the Waving Snail (rig, palette, stats, attack list, death effects)
//  • Enemy: AI framework — dormant → rising → idle/wander → alert → chase|kite → windup → strike → recover,
//    stagger (poise), stun, leash/return; LOS-gated perception; cheap obstacle steering
//  • pack play: angle slots so packs surround instead of stacking; attack tokens so only ~3 commit at once
//  • fairness: big attacks telegraph ≥0.45 s (FX.telegraph + rig anticipation), small ones ≥0.25 s; damage
//    lands at strike time; telegraphed attacks lock their aim when the telegraph appears
//  • elites with affixes, floor/ascension scaling, population (packs rise from the soil as you approach),
//    boss hand-off to HM.Bosses, and the quiet cast that stands guard behind the title screen.
(function () {
  'use strict';
  const Math = globalThis.Math; // lexical alias: hot loops skip the global-object lookup (big win in the Node smoke VM)
  const HM = (globalThis.window || globalThis).HM;
  const M = HM.M;
  const TAU = Math.PI * 2;

  // ------------------------------------------------------------------ guarded cross-module helpers
  const G = () => HM.Game;
  const CB = () => HM.Combat;
  function fx(fn, a, b, c, d, e, f, g) { const F = HM.FX; return F && typeof F[fn] === 'function' ? F[fn](a, b, c, d, e, f, g) : null; }
  function sfx(name, x, y, vol, pitch) {
    if (!HM.Audio || !HM.Audio.play) return;
    const o = { x, y }; if (vol !== undefined) o.vol = vol; if (pitch !== undefined) o.pitch = pitch;
    HM.Audio.play(name, o);
  }
  const rnd = () => HM.rng.next();
  const rr = (a, b) => a + (b - a) * HM.rng.next();
  const pick = (arr) => arr[Math.floor(HM.rng.next() * arr.length)];
  const turn = (a, b, max) => a + M.clamp(M.angleDiff(a, b), -max, max);
  function setAnim(a, state, o) {
    if (HM.Rig && HM.Rig.setAnim) HM.Rig.setAnim(a, state, o);
    else { a.anim.state = state; a.anim.t = 0; a.anim.dur = (o && o.dur) || 0.3; a.anim.variant = o && o.variant; }
  }
  // Drive the rig's attack timeline in segments so its poses line up with our timing:
  // anticipation 0–.3, strike .3–.5, recovery .5–1 of anim.dur (CONTRACT convention).
  function animSeg(a, state, variant, f0, f1, segDur) {
    const dur = Math.max(0.04, segDur / Math.max(0.05, f1 - f0));
    setAnim(a, state, { dur, variant });
    a.anim.t = f0 * dur;
  }
  function telegraph(o) { return fx('telegraph', o) || null; }
  function cancelTele(h) { if (h && typeof h.cancel === 'function') h.cancel(); }
  function los(x0, y0, x1, y1) { const W = HM.World; return !(W && W.los) || W.los(x0, y0, x1, y1); }
  function solid(x, y) { const W = HM.World; return !!(W && W.isSolid && W.isSolid(x, y)); }
  function shakeNear(x, y, amt) {
    const p = G() && G().player; if (!p) return;
    const d = M.dist(x, y, p.x, p.y); if (d < 420) fx('shake', amt * (1 - d / 420));
  }
  // Find a walkable point near (x,y) (rings outward); falls back to the input.
  function openNear(x, y, r, rng) {
    const R = rng || HM.rng;
    for (let k = 0; k < 14; k++) {
      const a = R.next() * TAU, d = k === 0 ? 0 : (r || 30) * (0.4 + (k / 14) * 1.2);
      const px = x + Math.cos(a) * d, py = y + Math.sin(a) * d;
      if (!solid(px, py) && !solid(px + 8, py) && !solid(px - 8, py) && !solid(px, py + 8) && !solid(px, py - 8)) return [px, py];
    }
    return [x, y];
  }

  const TELE = {
    red: [1, 0.22, 0.12], orange: [1, 0.55, 0.15], ice: [0.55, 0.85, 1], witch: [0.4, 1, 0.5],
    rot: [0.95, 0.45, 0.65], void: [0.7, 0.4, 1], bone: [0.95, 0.9, 0.75],
  };

  // ------------------------------------------------------------------ barks (fallbacks if HM.Lore has none)
  // All original lines. Lore's HM.Lore.barks[key] wins when present.
  const BARKS = {
    thrall: ['Clk... clk...', 'Back into the dirt with you.', 'The Lich is counting us.', 'Warm one. Warm one.'],
    archer: ['Hold still, meat.', 'One more for the bone-yard.', 'Draw... loose...'],
    hound: ['*wet snarl*', '*a howl with no breath in it*', '*teeth*'],
    snail: ['...', '*waves*', 'hi.'],
    snail_cursed: ['*waves slowly*', '...hi...', '*its eyes are the wrong colour*'],
    snail_possessed: ['THANK YOU FOR THE DOOR.', 'EVERY SHELL IS A WINDOW.', 'I SEE YOU, LITTLE HERO.'],
    husk: ['Sweeeet...', 'Share the rot...', 'So... sticky...'],
    bloater: ['*gurgle*', 'Full... so full...'],
    banana: ['Halt. Forever.', 'Still guarding... still...', 'The princess is not at home.'],
    penguin: ['wenk.', 'wenk?', 'WENK.'],
    gunter: ['wenk.', '...Wenk.', 'WENK. WENK.'],
    golem: ['Cold keeps.', 'Nothing melts. Nothing.'],
    wisp: ['(a whisper of frost)', 'Stay. Freeze. Stay.', 'So quiet down here.'],
    elemental: ['Burn bright!', 'Ash! All of it, ash!', 'Hotter!'],
    cinder: ['*crackle*', '*hiss of cooling glass*'],
    brute: ['CRUSH.', 'Stone remembers fire.'],
    brute_enrage: ['MOLTEN!', 'YOU CRACKED ME. NOW BURN.'],
    knight: ['Kneel to the Well.', 'My oath rotted. My blade did not.'],
    priest: ['Rise, little bones.', 'The Lich provides.', 'Down, into the green.'],
    wraith: ['Behind you.', 'You are already hollow.', 'Shhh...'],
    elite: ['You will not leave this field.', 'Kneel.'],
  };
  let lastBarkT = -99;
  function bark(a, key, chance, force) {
    if (!a || a.dead || !HM.UI || !HM.UI.bark) return;
    if (chance !== undefined && rnd() > chance) return;
    const now = G() ? G().t : 0;
    if (!force && now - lastBarkT < 1.4) return;
    const L = HM.Lore && HM.Lore.barks; let list = L && L[key];
    if (!list || !list.length) list = BARKS[key];
    if (!list || !list.length) return;
    lastBarkT = now;
    HM.UI.bark(a, pick(list));
  }

  // ------------------------------------------------------------------ attack tokens
  // Only a few foes may commit to an attack at a time (melee and ranged budgets are separate). Heavy attacks
  // cost 2. Holders release on recover end, interrupt or death; stale holders are purged lazily.
  const Tokens = {
    melee: new Set(), ranged: new Set(), lastStart: -9,
    cap() { const r = G() && G().run; const a = (r && r.ascension) || 0; return a >= 4 ? 4 : 3; },
    used(set) { let n = 0; for (const e of set) { if (e.dead || e.removeMe || !e._tok) { set.delete(e); continue; } n += e._tok; } return n; },
    take(e, cost, ranged) {
      if (!cost) return true;
      if (e._tokSet) return true;
      const set = ranged ? Tokens.ranged : Tokens.melee;
      const now = G() ? G().t : 0;
      if (!ranged && now - Tokens.lastStart < 0.16) return false; // never two melee commits on the same beat
      if (Tokens.used(set) + cost > Tokens.cap()) return false;
      e._tok = cost; e._tokSet = set; set.add(e);
      if (!ranged) Tokens.lastStart = now;
      return true;
    },
    give(e) { if (e._tokSet) e._tokSet.delete(e); e._tok = 0; e._tokSet = null; },
    reset() { Tokens.melee.clear(); Tokens.ranged.clear(); Tokens.lastStart = -9; },
  };

  // ------------------------------------------------------------------ pack coordination (surround slots)
  // Once per frame: engaged melee foes near the player are sorted by bearing and relaxed apart so each gets
  // its own angle slot. Foes without a token orbit their slot at a waiting radius; holders close in from it.
  let coordStamp = -1;
  const SLOT_LIST = [], SLOT_ANG = new Float64Array(64);
  function coordinate() {
    const g = G(); if (!g) return;
    if (g.t === coordStamp) return; coordStamp = g.t;
    const p = g.player; if (!p || p.dead) return;
    const list = SLOT_LIST; list.length = 0;
    for (const e of g.entities) {
      if (!(e instanceof Enemy) || e.dead || !e.engaged || !e.def.melee || e.target !== p) continue;
      if (M.dist2(e.x, e.y, p.x, p.y) > 300 * 300 || list.length >= 64) continue;
      e._bear = Math.atan2(e.y - p.y, e.x - p.x); list.push(e);
    }
    const n = list.length; if (!n) return;
    if (n === 1) { list[0].slotAng = list[0]._bear; return; }
    list.sort((a, b) => a._bear - b._bear);
    const gap = Math.min(TAU / n, 1.4);
    for (let i = 0; i < n; i++) SLOT_ANG[i] = list[i]._bear;
    for (let it = 0; it < 5; it++) {
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        let d = SLOT_ANG[j] - SLOT_ANG[i]; if (j === 0) d += TAU;
        if (d < gap) { const push = (gap - d) * 0.5; SLOT_ANG[i] -= push; SLOT_ANG[j] += push; }
      }
    }
    for (let i = 0; i < n; i++) list[i].slotAng = SLOT_ANG[i];
  }

  const CHOICE = [];
  const AVOID = [0.55, -0.55, 1.1, -1.1, 1.7, -1.7, 2.4, -2.4];

  // ==================================================================================================
  // Enemy — base class. Per-type behaviour lives in DEFS (attacks, ai, brain, tick, onDeath hooks).
  // ==================================================================================================
  class Enemy extends HM.Actor {
    initAI() {
      this.state = 'idle'; this.stateT = 0;
      this.cd = {}; this.gapT = rr(0.4, 1.1); this.cdMulV = 1;
      this.home = { x: this.x, y: this.y };
      this.target = null; this.engaged = false; this.slotAng = null;
      this.orbitDir = rnd() < 0.5 ? -1 : 1; this.orbitT = rr(1.4, 3);
      this.wanderT = rr(0.3, 2.5); this.wx = this.x; this.wy = this.y;
      this.seeT = 0; this.seeOk = false; this.seeTarget = null; this.tgtT = 0;
      this.detourT = 0; this.detourA = 0; this.progT = 0.5; this.progX = this.x; this.progY = this.y;
      this.poiseAcc = 0; this.plan = null; this.planT = 0;
      this.atk = null; this.atkPhase = null; this.atkT = 0; this.tele = null; this.dash = null;
      this.animUntil = 0; this.barkCd = rr(5, 12); this.blockTextT = 0;
      this.affixT = {}; this.moveFace = this.facing;
    }
    setState(s) { this.state = s; this.stateT = 0; }
    atkSpeed() { return this.stats.atkSpeed || 1; }
    cdMul() { return this.cdMulV; }
    // Damage spec for this foe's attacks (amount scaled by its floor/elite damage).
    spec(mul, type, knock, status) {
      return { amount: this.dmg * (mul || 1) * rr(0.9, 1.1), type: type || 'phys', source: this, knock: knock || 0, status: status || null };
    }
    oneShot(state, dur, variant) { setAnim(this, state, { dur, variant }); this.animUntil = this.t + dur; }

    // ------------------------------------------------------------------ frame
    update(dt) {
      const C = CB();
      if (this.dead) { C.baseUpdate(this, dt); return; }
      coordinate();
      this.stateT += dt; this.gapT -= dt; this.seeT -= dt; this.tgtT -= dt; this.detourT -= dt; this.blockTextT -= dt;
      this.barkCd -= dt; this.poiseAcc *= Math.exp(-0.9 * dt);
      for (const k in this.cd) this.cd[k] -= dt;
      const D = this.def;
      if (this.titleMode) this.titleAI(dt);
      else if (this.state === 'dormant') this.dormantAI(dt);
      else if (this.state === 'rising') this.risingAI(dt);
      else if (this._stunned || this.stunT > 0) this.stunnedAI(dt);
      else if (this.fearT > 0 && !this.def.neutral) this.fearAI(dt);
      else if (D.brain) D.brain(this, dt);
      else this.think(dt);
      if (this.isElite && !this.titleMode && this.state !== 'dormant' && this.state !== 'rising') this.affixAI(dt);
      if (D.tick && !this.titleMode && this.state !== 'dormant') D.tick(this, dt);
      // facing: toward the target while engaged, else along the path
      if (!this.atk && !this.titleMode && this.state !== 'dormant') {
        const t = this.target;
        if (this.engaged && t && !t.dead && this.state !== 'flee' && this.state !== 'return') this.facing = turn(this.facing, M.angle(this.x, this.y, t.x, t.y), 9 * dt);
        else if (Math.abs(this.vx) + Math.abs(this.vy) > 4) this.facing = turn(this.facing, this.moveFace, 8 * dt);
        this.aim = this.facing;
      }
      if (this.animUntil && this.t >= this.animUntil && !this.atk) { this.animUntil = 0; if (!this.dead) setAnim(this, 'idle'); }
      this.trackProgress(dt);
      C.baseUpdate(this, dt);
      if (this.hover) this.z = this.hover + Math.sin(this.t * 2.3 + this.id) * 2.5;
    }

    // ------------------------------------------------------------------ perception
    pickTarget() {
      if (this.tgtT > 0 && this.target && !this.target.dead) return this.target;
      this.tgtT = 0.3 + rnd() * 0.15;
      const g = G(); const p = g && g.player;
      let best = p && !p.dead && p.team !== this.team ? p : null;
      let bd = best ? M.dist(this.x, this.y, best.x, best.y) : 1e9;
      // allies of the player (summons) can draw aggro when much closer
      const near = CB().nearestHostile(this.x, this.y, this.team, Math.min(bd * 0.6, 400));
      if (near && near !== best && near.team !== 2) { best = near; bd = 0; }
      this.target = best;
      return best;
    }
    sees(t) {
      if (this.seeT > 0 && this.seeTarget === t) return this.seeOk;
      this.seeT = 0.18 + rnd() * 0.12; this.seeTarget = t;
      this.seeOk = this.ghost || los(this.x, this.y, t.x, t.y);
      return this.seeOk;
    }
    notices(t) {
      const d = M.dist(this.x, this.y, t.x, t.y);
      if (d < 70) return true;
      return d < this.aggro && this.sees(t);
    }
    alert(t, propagate) {
      if (this.dead || this.titleMode) return;
      if (this.state === 'dormant') { if (this.pack) this.pack.wake(t); else this.rise(true); return; }
      if (this.state === 'rising' || this.atk) return;
      if (this.state !== 'idle' && this.state !== 'wander' && this.state !== 'return') return;
      this.target = t || this.target; this.engaged = true;
      this.setState('alert'); this.alertDur = rr(0.22, 0.5); this.vx = this.vy = 0;
      if (propagate && this.pack) this.pack.wake(t, this);
    }

    // ------------------------------------------------------------------ movement
    moveTo(tx, ty, spd) {
      const dx = tx - this.x, dy = ty - this.y; const d = Math.hypot(dx, dy);
      if (d < 3) { this.vx = this.vy = 0; return; }
      let a = Math.atan2(dy, dx);
      if (!this.ghost) a = this.avoid(a);
      const s = spd * Math.min(1, d / 22 + 0.3);
      this.vx = Math.cos(a) * s; this.vy = Math.sin(a) * s; this.moveFace = a;
    }
    avoid(a) {
      if (this.detourT > 0) return a + this.detourA;
      const look = this.radius + 14;
      if (!solid(this.x + Math.cos(a) * look, this.y + Math.sin(a) * look)) return a;
      for (const off of AVOID) { const b = a + off * this.orbitDir; if (!solid(this.x + Math.cos(b) * look, this.y + Math.sin(b) * look)) return b; }
      return a;
    }
    // Stuck detection: if we wanted to move but barely did, commit to a detour for a moment.
    trackProgress(dt) {
      this.progT -= dt; if (this.progT > 0) return;
      this.progT = 0.5;
      const want = Math.hypot(this.vx, this.vy) > 12 && !this.atk;
      if (want && M.dist(this.x, this.y, this.progX, this.progY) < 5 && !this.ghost) { this.detourT = rr(0.5, 0.9); this.detourA = (rnd() < 0.5 ? -1 : 1) * rr(1.1, 1.6); }
      this.progX = this.x; this.progY = this.y;
    }
    faceToward(x, y, dt, rate) { this.facing = turn(this.facing, M.angle(this.x, this.y, x, y), (rate || 9) * dt); }
    moveSpeed() { return this.speed * (this.def.lurch ? 0.55 + 0.45 * Math.abs(Math.sin(this.t * 2.6 + this.id)) : 1); }

    // ------------------------------------------------------------------ states
    titleAI(dt) {
      this.vx = this.vy = 0;
      this.wanderT -= dt;
      if (this.wanderT <= 0) {
        this.wanderT = rr(3, 7);
        this.lookA = (this.guardFacing !== undefined ? this.guardFacing : Math.PI / 2) + rr(-0.7, 0.7);
        if (this.def.titleIdle) this.def.titleIdle(this);
      }
      if (this.lookA !== undefined) this.facing = turn(this.facing, this.lookA, 1.2 * dt);
      this.aim = this.facing;
    }
    dormantAI(dt) {
      this.vx = this.vy = 0;
      if (this.riseDelay !== undefined) { this.riseDelay -= dt; if (this.riseDelay <= 0) this.rise(false); return; }
      const g = G(); const p = g && g.player; if (!p || p.dead) return;
      const pk = this.pack; const hx = pk ? pk.x : this.x, hy = pk ? pk.y : this.y;
      const d = M.dist(p.x, p.y, hx, hy), trig = pk ? pk.trigR : 220;
      if (pk) pk.stir = M.clamp(1 - (d - trig) / 170, 0, 1);
      if (d < trig) { if (pk) pk.wake(p); else this.riseDelay = 0.05; }
    }
    rise(fast) {
      delete this.riseDelay;
      this.state = 'rising'; this.stateT = 0; this.hidden = false; this.team = 1; this.name = this.baseName;
      this.noCollide = false; this.invuln = true;
      this.riseDur = fast ? 0.5 : rr(0.8, 1.0);
      setAnim(this, 'spawn', { dur: this.riseDur });
      const D = this.def;
      fx('burst', this.x, this.y, 2, D.riseBurst || 'dust', 12);
      fx('burst', this.x, this.y, 2, 'dust', 8);
      fx('decal', this.x, this.y, 'crack', 12 * this.sc, 14);
      sfx(D.riseSfx || 'bone_break', this.x, this.y, 0.55, rr(0.8, 1.1));
    }
    risingAI(dt) {
      this.vx = this.vy = 0;
      if (this.stateT > this.riseDur * 0.55) this.invuln = false;
      if (this.stateT >= this.riseDur) {
        this.invuln = false; setAnim(this, 'idle');
        const t = this.pickTarget();
        this.state = 'idle';
        if (t) this.alert(t, false); else this.setState('idle');
      }
    }
    stunnedAI(dt) {
      if (this.atk) this.endAttack(true);
      this.plan = null; Tokens.give(this);
      this.vx = this.vy = 0;
      if (this.anim.state !== 'stun') setAnim(this, 'stun', { dur: 0.6 });
      this.animUntil = this.t + 0.05;
    }
    // Feared (Marceline's Shadow Queen sets fearT/fearFrom): drop the attack and scramble away from the source.
    fearAI(dt) {
      this.fearT -= dt;
      if (this.atk && (!this.atk.hyper || this.atkPhase === 'recover')) this.endAttack(true);
      if (this.atk) { this.runAttack(dt); return; }
      this.plan = null; Tokens.give(this);
      if (this.state !== 'flee') this.setState('flee');
      const f = this.fearFrom && !this.fearFrom.dead ? this.fearFrom : (G() && G().player);
      if (!f) { this.vx = this.vy = 0; return; }
      const a = M.angle(f.x, f.y, this.x, this.y) + Math.sin(this.t * 3 + this.id) * 0.35;
      this.moveTo(this.x + Math.cos(a) * 90, this.y + Math.sin(a) * 90, this.speed * 0.95);
      if (this.fearT <= 0) { this.fearT = 0; this.setState('chase'); }
    }
    stagger(dur) {
      if (this.dead || this.state === 'dormant' || this.state === 'rising') return;
      if (this.atk) { if (this.atk.hyper && this.atkPhase !== 'recover') return; this.endAttack(true); }
      this.plan = null; Tokens.give(this);
      this.setState('stagger'); this.staggerDur = dur; this.vx = this.vy = 0;
      this.oneShot('hit', dur);
    }
    wanderAI(dt) {
      this.wanderT -= dt;
      if (this.wanderT <= 0) {
        this.wanderT = rr(1.6, 4.2);
        if (rnd() < 0.55) {
          const a = rnd() * TAU, r = rr(8, this.def.wanderR || 55);
          this.wx = this.home.x + Math.cos(a) * r; this.wy = this.home.y + Math.sin(a) * r; this.state = 'wander';
        } else this.state = 'idle';
      }
      if (this.state === 'wander') {
        if (M.dist(this.x, this.y, this.wx, this.wy) < 6) { this.state = 'idle'; this.vx = this.vy = 0; }
        else this.moveTo(this.wx, this.wy, this.speed * 0.32);
      } else { this.vx = this.vy = 0; }
    }
    think(dt) {
      if (this.atk) { this.runAttack(dt); return; }
      const st = this.state;
      if (st === 'stagger') { this.vx = this.vy = 0; if (this.stateT >= this.staggerDur) this.setState('chase'); return; }
      const t = this.pickTarget();
      if (st === 'idle' || st === 'wander') { this.engaged = false; this.wanderAI(dt); if (t && this.notices(t)) this.alert(t, true); return; }
      if (st === 'alert') {
        this.vx = this.vy = 0; if (t) this.faceToward(t.x, t.y, dt, 14);
        if (this.stateT >= this.alertDur) this.setState('chase');
        return;
      }
      if (st === 'return') {
        this.engaged = false; this.plan = null; Tokens.give(this);
        this.moveTo(this.home.x, this.home.y, this.speed * 1.1);
        this.hp = Math.min(this.maxHp, this.hp + this.maxHp * 0.3 * dt);
        if (M.dist(this.x, this.y, this.home.x, this.home.y) < 14) { this.hp = this.maxHp; this.setState('idle'); }
        else if (t && this.stateT > 1.2 && M.dist(this.x, this.y, t.x, t.y) < this.aggro * 0.5 && this.sees(t)) { this.state = 'idle'; this.alert(t, false); }
        return;
      }
      if (!t) { this.engaged = false; this.plan = null; Tokens.give(this); this.setState('wander'); return; }
      this.target = t; this.engaged = true;
      // leash: don't chase forever across the map
      if (M.dist(this.x, this.y, this.home.x, this.home.y) > this.leash && M.dist(t.x, t.y, this.home.x, this.home.y) > this.leash * 0.75) { this.setState('return'); return; }
      // occasional combat chatter
      if (this.barkCd <= 0) { this.barkCd = rr(9, 18); bark(this, this.barkKey(), 0.35); }
      this.orbitT -= dt; if (this.orbitT <= 0) { this.orbitT = rr(1.4, 3.2); this.orbitDir = -this.orbitDir; }
      (this.def.ai || AI.melee)(this, dt, t);
    }
    barkKey() { return this.isElite && this.defId === 'penguin' ? 'gunter' : this.defId; }

    // ------------------------------------------------------------------ attacks
    // Choose a ready attack (weighted). anyRange: ignore the max range (used to plan an approach).
    chooseAttack(d, t, anyRange) {
      const c = CHOICE; c.length = 0; let tot = 0;
      for (const a of this.def.attacks) {
        if ((this.cd[a.id] || 0) > 0) continue;
        if (a.when && !a.when(this, t, d)) continue;
        if (d < a.range[0]) continue;
        if (!anyRange && d > a.range[1] + t.radius) continue;
        if (a.needLos && !this.sees(t)) continue;
        c.push(a); tot += a.weight || 1;
      }
      if (!c.length) return null;
      let r = rnd() * tot;
      for (const a of c) { r -= a.weight || 1; if (r <= 0) return a; }
      return c[c.length - 1];
    }
    startAttack(a, t) {
      const as = this.atkSpeed();
      let wu = a.windup / as; wu = Math.max(wu, a.big ? 0.45 : 0.25);
      this.atk = a; this.atkPhase = 'windup'; this.atkT = 0; this.atkWU = wu; this.atkTarget = t; this.plan = null;
      this.aim = M.angle(this.x, this.y, t.x, t.y);
      if (a.lead) { const tt = M.dist(this.x, this.y, t.x, t.y) / (a.speed || 400); this.aim = M.angle(this.x, this.y, t.x + (t.vx || 0) * tt * a.lead, t.y + (t.vy || 0) * tt * a.lead); }
      this.facing = this.aim; this.atkX = t.x; this.atkY = t.y;
      this.cd[a.id] = a.cd * rr(0.85, 1.15) * this.cdMul();
      this.setState('attack'); this.vx = this.vy = 0;
      animSeg(this, a.anim || 'attack', a.variant, 0, 0.3, wu);
      if (a.tele) { const o = a.tele(this, t, wu, a); if (o) { if (!o.dur) o.dur = wu; this.tele = telegraph(o); } }
      if (a.onStart) a.onStart(this, t, a, wu);
      if (a.startSfx) sfx(a.startSfx, this.x, this.y, 0.5);
    }
    runAttack(dt) {
      const a = this.atk, t = this.atkTarget; this.atkT += dt;
      if (this.atkPhase === 'windup') {
        this.vx = this.vy = 0;
        const lock = a.lock !== undefined ? a.lock : 0.16;
        if (a.track !== 0 && t && !t.dead && this.atkT < this.atkWU - lock) {
          let tx = t.x, ty = t.y;
          if (a.lead) { const tt = M.dist(this.x, this.y, tx, ty) / (a.speed || 400); tx += (t.vx || 0) * tt * a.lead; ty += (t.vy || 0) * tt * a.lead; }
          this.aim = turn(this.aim, M.angle(this.x, this.y, tx, ty), (a.track || 5) * dt); this.facing = this.aim;
          this.atkX = t.x; this.atkY = t.y;
        }
        if (a.onWindup) a.onWindup(this, dt, M.clamp(this.atkT / this.atkWU, 0, 1), a);
        if (this.atkT >= this.atkWU) {
          this.atkPhase = 'strike'; this.atkT = 0; this.atkSD = a.strike || 0.1; this.tele = null;
          if (a.strikeAnim) setAnim(this, a.strikeAnim, { dur: this.atkSD, variant: a.strikeVariant });
          else animSeg(this, a.anim || 'attack', a.variant, 0.3, 0.5, this.atkSD);
          a.exec(this, t, a);
          if (this.dead || !this.atk) return;
        }
      } else if (this.atkPhase === 'strike') {
        if (a.during) a.during(this, dt, t, a); else this.vx = this.vy = 0;
        if (this.atkT >= this.atkSD) {
          this.atkPhase = 'recover'; this.atkT = 0; this.dash = null;
          this.atkRC = (a.recover !== undefined ? a.recover : 0.4) / Math.sqrt(this.atkSpeed());
          animSeg(this, a.anim || 'attack', a.variant, 0.5, 1, Math.max(0.05, this.atkRC));
          if (a.onRecover) a.onRecover(this, t, a);
        }
      } else {
        this.vx = this.vy = 0;
        if (a.recoverMove) a.recoverMove(this, dt, t, a);
        if (this.atkT >= this.atkRC) this.endAttack(false);
      }
    }
    endAttack(interrupted) {
      const a = this.atk;
      if (a && a.onEnd) a.onEnd(this, interrupted, a);
      cancelTele(this.tele); this.tele = null;
      this.atk = null; this.atkPhase = null; this.dash = null; this.shots = null;
      Tokens.give(this); this.gapT = rr(0.3, 0.8) * this.cdMul();
      if (this.dead) return;
      this.setState('chase');
      // chained follow-ups (e.g. wraith reappears and rakes) skip the token queue — they are one move
      if (!interrupted && a && a.next && this.atkTarget && !this.atkTarget.dead) {
        const nx = this.def.attacks.find((q) => q.id === a.next) || ATTACK_LIB[a.next];
        if (nx) { this.startAttack(nx, this.atkTarget); return; }
      }
      setAnim(this, 'idle');
    }

    // ------------------------------------------------------------------ elites
    affixAI(dt) {
      for (const id of this.affixes) { const A = AFFIXES[id]; if (A && A.tick) A.tick(this, dt); }
    }

    // ------------------------------------------------------------------ combat hooks
    onDealDamage(info) {
      if (!this.isElite || info.isDot) return;
      if (this.affixes.indexOf('frostbound') >= 0) {
        const s = info.spec; const st = s.status ? (Array.isArray(s.status) ? s.status.slice() : [s.status]) : [];
        st.push({ id: 'chill', dur: 1.6 }); s.status = st;
      }
      if (this.affixes.indexOf('vampiric') >= 0 && rnd() < 0.6) fx('burst', this.x, this.y, this.height * 0.6, 'blood', 5);
    }
    tryBlock(info) {
      const B = this.def.block; if (!B || info.isDot || info.amount <= 0) return false;
      if (info.type !== 'phys' && !B.all) return false;
      if (this.atkPhase === 'strike' || this.atkPhase === 'recover' || this.state === 'stagger' || this._stunned) return false;
      if (B.idleOnly && this.atk) return false;
      const s = info.source; if (!s || s === this) return false;
      if (Math.abs(M.angleDiff(this.facing, M.angle(this.x, this.y, s.x, s.y))) > (B.half || 0.9)) return false;
      info.amount *= B.mul; info.blocked = true;
      const hx = this.x + Math.cos(this.facing) * this.radius, hy = this.y + Math.sin(this.facing) * this.radius;
      fx('burst', hx, hy, this.height * 0.5, 'spark', 6);
      sfx('hit', hx, hy, 0.7, 1.7);
      if (this.blockTextT <= 0) { this.blockTextT = 0.6; fx('text', this.x, this.y, this.height + 8, 'block', [0.75, 0.82, 1], 0.85); }
      return true;
    }
    onDamaged(info) {
      if (this.titleMode) return;
      const D = this.def;
      if (D.onDamaged && D.onDamaged(this, info) === false) return;
      const blocked = this.tryBlock(info);
      const src = info.source;
      if ((this.state === 'idle' || this.state === 'wander' || this.state === 'return') && !this.dead) {
        this.state = 'idle';
        this.alert(src && src.team !== this.team && src.team !== 2 ? src : this.pickTarget(), true);
      }
      if (!info.isDot && D.poise !== undefined && !this.isBoss) {
        this.poiseAcc += info.amount * (blocked ? 0.35 : 1);
        const thr = this.maxHp * D.poise * (this.isElite ? 1.7 : 1);
        if (this.poiseAcc > thr) { this.poiseAcc = 0; this.stagger(blocked ? 0.45 : 0.32); }
      }
    }
    onDeath(info) {
      if (this.atk) this.endAttack(true);
      cancelTele(this.tele); this.tele = null; Tokens.give(this);
      this.plan = null; this.hidden = false; this.engaged = false;
      if (this.pack) this.pack.onMemberDeath(this);
      if (this.summoner) this.summoner.summons = Math.max(0, (this.summoner.summons || 1) - 1);
      const D = this.def;
      if (D.onDeath) D.onDeath(this, info);
      if (this.isElite) for (const id of this.affixes) { const A = AFFIXES[id]; if (A && A.onDeath) A.onDeath(this, info); }
      sfx(D.deathSfx || 'death', this.x, this.y, this.isElite ? 1 : 0.7);
    }

    // ------------------------------------------------------------------ draw
    draw() {
      if (this.state === 'dormant') { drawMound(this); return; }
      if (this.hidden) return;
      const R = HM.R;
      if (!this.dead) {
        const L = this.lightOverride || this.def.light;
        if (L) R.light(this.x, this.y, (this.z || 0) + 20, L[0] * this.sc, L[1], L[2], L[3], L[4] * (0.85 + 0.15 * Math.sin(this.t * 9 + this.id)));
        if (this.isElite) { const c = this.eliteColor; R.light(this.x, this.y, 20, 64 * this.sc, c[0], c[1], c[2], 0.5 + 0.15 * Math.sin(this.t * 4)); }
        if (this.enraged) R.light(this.x, this.y, 30, 90, 1, 0.3, 0.08, 0.8);
        if (this.atk && this.atkPhase === 'windup' && this.atk.aimLine) drawAimLine(this);
      }
      if (HM.Rig && HM.Rig.draw && this.rig) HM.Rig.draw(this);
      else super.draw();
    }
  }

  // ==================================================================================================
  // Behaviours (def.ai): called each frame while engaged & not mid-attack.
  // ==================================================================================================
  const AI = {
    // Surround & commit: reserve a token + plan an attack, approach along our slot, strike when in range.
    // Without a token we orbit the slot at a waiting radius (feinting in and out) so packs ring the player.
    melee(e, dt, t) {
      const d = M.dist(e.x, e.y, t.x, t.y);
      if (!e.plan && e.gapT <= 0) {
        const a = e.chooseAttack(d, t, true);
        if (a && Tokens.take(e, a.token === undefined ? 1 : a.token, !!a.ranged)) { e.plan = a; e.planT = 0; }
      }
      const bear = e.slotAng !== null && e.slotAng !== undefined ? e.slotAng : Math.atan2(e.y - t.y, e.x - t.x);
      if (e.plan) {
        const a = e.plan; e.planT += dt;
        if (d <= a.range[1] + t.radius * 0.6 && d >= a.range[0] && (!a.needLos || e.sees(t))) { e.startAttack(a, t); return; }
        if (e.planT > 3.2) { Tokens.give(e); e.plan = null; e.gapT = rr(0.6, 1.2); return; }
        // approach along our slot; once close, cut straight in
        const want = Math.max(a.range[0] + 6, a.range[1] * 0.6) + t.radius;
        const ang = d < want + 40 ? Math.atan2(e.y - t.y, e.x - t.x) : bear;
        e.moveTo(t.x + Math.cos(ang) * want, t.y + Math.sin(ang) * want, e.moveSpeed() * (a.ranged ? 0.8 : 1.05));
        return;
      }
      // waiting ring with a lazy orbit + small breathing in/out
      const ring = Math.max(e.reach + 30, 58) + e.radius + t.radius + Math.sin(e.t * 1.7 + e.id) * 8;
      const ang = bear + e.orbitDir * 0.32;
      const far = d > ring + 80;
      e.moveTo(t.x + Math.cos(ang) * ring, t.y + Math.sin(ang) * ring, e.moveSpeed() * (far ? 1 : 0.55));
    },
    // Keep a distance band, strafe, shoot when the ranged budget allows; back-pedal if crowded.
    kite(e, dt, t) {
      const D = e.def, d = M.dist(e.x, e.y, t.x, t.y), sees = e.sees(t);
      if (e.gapT <= 0) {
        const a = e.chooseAttack(d, t, false);
        if (a && (a.needLos === false || sees) && Tokens.take(e, a.token === undefined ? 1 : a.token, !!a.ranged)) { e.startAttack(a, t); return; }
      }
      const mn = D.keep[0], mx = D.keep[1];
      let ang = Math.atan2(e.y - t.y, e.x - t.x), rad, spd = e.moveSpeed();
      if (d < mn) { ang += e.orbitDir * 0.45; rad = mn + 50; spd *= 0.95; e.setStateQuiet('kite'); }
      else if (d > mx || !sees) { ang += e.orbitDir * (sees ? 0.15 : 0.85); rad = Math.min(d, mx) * 0.8; }
      else { ang += e.orbitDir * 0.55; rad = d; spd *= 0.42; }
      if (D.erratic) { ang += Math.sin(e.t * 3.1 + e.id) * 0.9; spd *= 1 + 0.35 * Math.sin(e.t * 5.3 + e.id * 2); }
      e.moveTo(t.x + Math.cos(ang) * rad, t.y + Math.sin(ang) * rad, spd);
    },
  };
  Enemy.prototype.setStateQuiet = function (s) { if (this.state !== s) { this.state = s; this.stateT = 0; } };
  Object.defineProperty(Enemy.prototype, 'reach', { get() { return this._reach || 30; } });

  // ==================================================================================================
  // Drawing helpers
  // ==================================================================================================
  const MOUND = ['.', ',', '~', '_', "'", '`', ';'];
  let MOUND_G = null;
  function drawMound(e) {
    const R = HM.R; if (!R.inViewWorld(e.x, e.y, 30)) return;
    if (!MOUND_G) MOUND_G = MOUND.map((c) => R.gi(c));
    const pk = e.pack, stir = pk ? pk.stir || 0 : 0, t = G() ? G().t : 0;
    const c = e.moundColor, py0 = e.y * HM.cfg.TILT;
    for (let k = 0; k < 7; k++) {
      const h = M.hash2(e.id * 7 + k, 3), h2 = M.hash2(e.id, k * 11 + 5);
      const jit = stir > 0 ? Math.sin(t * 23 + k * 1.7 + e.id) * stir * 1.6 : 0;
      const b = 0.75 + 0.5 * stir * (0.5 + 0.5 * Math.sin(t * 9 + k));
      R.set(e.x + (h - 0.5) * 20 + jit, py0 + (h2 - 0.5) * 7, MOUND_G[k], c[0] * b, c[1] * b, c[2] * b, R.KEY_DECAL + 2, 0);
    }
    // something underneath is waking: a faint, sick glow and loose soil
    if (stir > 0.35) {
      const g = e.def.stirGlow; if (g) R.emit(e.x, py0, g[0] * stir * 0.25, g[1] * stir * 0.25, g[2] * stir * 0.25);
      if (rnd() < stir * 0.04) fx('burst', e.x + rr(-8, 8), e.y + rr(-4, 4), 1, 'dust', 1);
    }
  }
  // Tracking aim line for archers/wisps: grows during the windup, freezes and brightens at lock.
  function drawAimLine(e) {
    const R = HM.R, a = e.atk, TILT = HM.cfg.TILT;
    const f = M.clamp(e.atkT / e.atkWU, 0, 1);
    const locked = e.atkT >= e.atkWU - (a.lock !== undefined ? a.lock : 0.16);
    const len = (a.aimLen || 260) * (0.3 + 0.7 * M.easeOutCubic(f));
    const c = a.aimColor || TELE.red, k = locked ? 1.5 : 0.35 + 0.6 * f;
    const ca = Math.cos(e.aim), sa = Math.sin(e.aim);
    const g = locked ? R.dirGlyph(ca, sa * TILT) : R.gi('.');
    for (let s = e.radius + 8; s < len; s += 6) {
      const x = e.x + ca * s, y = e.y + sa * s;
      if (solid(x, y)) break;
      const fade = 1 - (s / len) * 0.6;
      R.glowGlyph(x, y * TILT, g, c[0] * k * fade, c[1] * k * fade, c[2] * k * fade, R.KEY_DECAL + 6, locked ? 0.5 : 0.2);
    }
  }

  // ==================================================================================================
  // Zones (persistent ground effects) — all drawn by HM.FX.drawZone(z) by kind.
  // ==================================================================================================
  function fireZone(x, y, r, life, src, dps) {
    return CB().zone({
      x, y, r, life, team: 1, tick: 0.5, kind: 'fire', source: src, tags: ['fire'],
      onTick(z, inside) { for (const a of inside) CB().damage(a, { amount: dps * 0.5, type: 'fire', source: z.source, isDot: true, canCrit: false, tags: ['zone'], status: { id: 'burn', dur: 1.5, dps: dps * 0.3 } }); },
    });
  }
  function rotZone(x, y, r, life, src, dps, big) {
    return CB().zone({
      x, y, r, life, team: 1, tick: 0.5, kind: 'rot', source: src, tags: ['flammable', 'rot'], big: !!big,
      onTick(z, inside) { for (const a of inside) CB().applyStatus(a, 'rot', { dur: 2, dps, stacks: 1, src: z.source }); },
    });
  }
  function iceZone(x, y, r, life, src) {
    return CB().zone({
      x, y, r, life, team: 1, tick: 0.4, kind: 'ice', source: src, tags: ['ice'],
      onTick(z, inside) { for (const a of inside) CB().applyStatus(a, 'chill', { dur: 1.2, src: z.source }); },
    });
  }

  // ==================================================================================================
  // Attack builders. Every attack: {id, range:[min,max], cd, windup, strike, recover, anim, variant, weight,
  // token (0 = free, 1, 2 = heavy), ranged, big (≥.45 s + telegraph), track (turn rate; 0 = lock at start),
  // tele(e,t,wu,a) → FX.telegraph opts, exec(e,t,a) at strike, during(e,dt,t,a) while striking, hooks...}
  // ==================================================================================================
  function swing(o) {
    const a = Object.assign({
      reach: 30, half: 0.85, cd: 1.5, windup: 0.3, strike: 0.1, recover: 0.42, anim: 'attack', variant: 'slash1', weight: 1, token: 1,
      mul: 1, type: 'phys', knock: 90,
      exec(e, t, a) {
        const reach = a.reach * e.sc + 6;
        const hits = CB().hitArc(e.x, e.y, e.aim, a.half, reach, e.team, e.spec(a.mul, a.type, a.knock, a.status));
        const col = a.color || e.def.swingColor || [0.9, 0.88, 0.8];
        fx('swing', { actor: e, x: e.x, y: e.y, z: e.height * 0.45, a0: e.aim - a.half * 1.1, a1: e.aim + a.half * 1.1, r0: 6 * e.sc, r1: reach, dur: 0.1, life: 0.16, color: col, glyphs: a.glyphs || e.def.swingGlyphs, emissive: a.type !== 'phys' ? 0.6 : 0.15, width: a.big ? 1.4 : 1 });
        sfx(a.big ? 'swing_heavy' : 'swing', e.x, e.y, 0.55, rr(0.85, 1.15));
        if (a.onHit) for (const h of hits) a.onHit(e, h, a);
      },
    }, o);
    a.range = o.range || [0, a.reach];
    if (a.big && !o.tele) a.tele = (e, t, wu, q) => ({ shape: 'cone', x: e.x, y: e.y, ang: e.aim, r: q.reach * e.sc + 10, half: q.half, color: q.teleColor || TELE.red });
    if (a.big && a.track === undefined) a.track = 0;
    return a;
  }
  function slamPoint(e, a) { return [e.x + Math.cos(e.aim) * a.ahead * e.sc, e.y + Math.sin(e.aim) * a.ahead * e.sc]; }
  function slam(o) {
    const a = Object.assign({
      reach: 40, r: 60, ahead: 0, cd: 4, windup: 0.6, strike: 0.12, recover: 0.6, anim: 'attack', variant: 'slam', big: true, token: 2, track: 0,
      mul: 1.6, type: 'phys', knock: 220, burst: 'dust', weight: 1,
      tele(e, t, wu, a) { const p = slamPoint(e, a); return { shape: 'circle', x: p[0], y: p[1], r: a.r * e.sc, color: a.teleColor || TELE.red }; },
      exec(e, t, a) {
        const p = slamPoint(e, a), r = a.r * e.sc;
        CB().hitCircle(p[0], p[1], r, e.team, e.spec(a.mul, a.type, a.knock, a.status));
        fx('ring', p[0], p[1], 6, r * 1.1, 0.35, a.ringColor || [0.9, 0.85, 0.7]);
        fx('burst', p[0], p[1], 3, a.burst, 22); fx('burst', p[0], p[1], 2, 'dust', 10);
        fx('decal', p[0], p[1], a.decal || 'crack', r * 0.85, 10);
        if (a.light) fx('light', p[0], p[1], 10, r * 2, a.light, 1.4, 0.35);
        shakeNear(p[0], p[1], 5);
        sfx(a.sound || 'explode', p[0], p[1], 0.75, 0.7);
        if (a.onSlam) a.onSlam(e, p, a);
      },
    }, o);
    a.range = o.range || [0, a.reach + a.ahead];
    return a;
  }
  // Dash attacks (lunge, belly-slide, charge): hits along the path once per target.
  function lunge(o) {
    const a = Object.assign({
      range: [40, 130], cd: 3, windup: 0.4, strike: 0.24, recover: 0.5, anim: 'attack', variant: 'bite', token: 1, dist: 110, w: 6, track: 0,
      mul: 1.3, type: 'phys', knock: 160, weight: 1,
      exec(e, t, a) {
        e.dash = { ang: e.aim, spd: (a.dist * Math.sqrt(e.sc)) / a.strike, once: new Set(), px: e.x, py: e.y, t: 0, trailT: 0 };
        fx('ghost', e, 0.22); fx('burst', e.x, e.y, 2, 'dust', 6);
        sfx(a.sound || 'swing_heavy', e.x, e.y, 0.6, a.pitch || 1);
        if (a.onDash) a.onDash(e, t, a);
      },
      during(e, dt, t, a) { dashStep(e, dt, a); },
    }, o);
    if (a.big && !o.tele) a.tele = (e, t, wu, q) => ({ shape: 'line', x: e.x, y: e.y, ang: e.aim, len: q.dist * Math.sqrt(e.sc) + e.radius + 12, w: (e.radius + q.w) * 2, color: q.teleColor || TELE.red });
    return a;
  }
  function dashStep(e, dt, a) {
    const d = e.dash; if (!d) { e.vx = e.vy = 0; return; }
    if (dt <= 0) return; // hitstop: hold the dash, don't sample movement
    // wall check: if the last moving frame barely moved us, we hit something solid
    if (d.t > 0.04 && d.lastDt > 0 && M.dist(e.x, e.y, d.px, d.py) < d.spd * d.lastDt * 0.2) {
      e.dash = null; e.vx = e.vy = 0;
      if (a.onWall) a.onWall(e, a);
      return;
    }
    d.t += dt; d.px = e.x; d.py = e.y; d.lastDt = dt;
    const c = Math.cos(d.ang), s = Math.sin(d.ang);
    e.vx = c * d.spd; e.vy = s * d.spd; e.facing = d.ang;
    const hits = CB().hitCircle(e.x + c * e.radius * 0.6, e.y + s * e.radius * 0.6, e.radius + a.w, e.team, e.spec(a.mul, a.type, a.knock, a.status), { once: d.once });
    if (hits.length) { if (a.onHit) for (const h of hits) a.onHit(e, h, a); if (a.stopOnHit) { e.dash = null; e.vx = e.vy = 0; return; } }
    if (a.trail) { d.trailT -= dt; if (d.trailT <= 0) { d.trailT = a.trailEvery || 0.05; a.trail(e, a); } }
  }
  // Projectile attacks. count>1 → fan (spread) or a timed volley (volley:true, fired across the strike).
  function fireOne(e, ang, a) {
    const sp = a.speed, z = (e.z || 0) + a.z * e.sc;
    return CB().projectile(Object.assign({
      x: e.x + Math.cos(ang) * (e.radius + 4), y: e.y + Math.sin(ang) * (e.radius + 4), z,
      vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, r: a.r, team: e.team, life: a.life,
      damage: e.spec(a.mul, a.type, a.knock, a.status), look: a.look, color: a.color || [1, 1, 1], source: e,
      light: a.light || null, homing: a.homing && e.atkTarget ? { target: e.atkTarget, turn: a.homing } : null,
      onExpire: a.onImpact ? (p) => a.onImpact(e, p, a) : null,
    }, a.proj ? a.proj(e, a) : null));
  }
  function shoot(o) {
    const a = Object.assign({
      range: [50, 300], cd: 2.2, windup: 0.5, strike: 0.08, recover: 0.35, anim: 'attack', variant: 'shoot', token: 1, ranged: true, needLos: true,
      speed: 380, count: 1, spread: 0.18, look: 'arrow', z: 24, life: 1.4, r: 5, mul: 1, type: 'phys', knock: 40, weight: 1, track: 5, lead: 0.5,
      exec(e, t, a) {
        if (a.volley) { e.shots = { n: a.count, i: 1, t: 0 }; fireOne(e, e.aim - ((a.count - 1) / 2) * a.spread, a); }
        else for (let k = 0; k < a.count; k++) fireOne(e, e.aim + (k - (a.count - 1) / 2) * a.spread, a);
        if (a.flash) fx('light', e.x, e.y, 24, 50, a.flash, 1.2, 0.18);
        sfx(a.sound || 'swing', e.x, e.y, 0.5, a.pitch || 1.3);
      },
      during(e, dt, t, a) {
        e.vx = e.vy = 0; const s = e.shots; if (!s || s.i >= s.n) return;
        s.t += dt; const every = a.strike / a.count;
        while (s.i < s.n && s.t >= every * s.i) { fireOne(e, e.aim + (s.i - (a.count - 1) / 2) * a.spread, a); sfx(a.sound || 'swing', e.x, e.y, 0.35, (a.pitch || 1.3) + s.i * 0.08); s.i++; }
      },
    }, o);
    return a;
  }
  // Lobbed projectile with a landing telegraph (golem snowball). Flies over walls, splashes on landing.
  function lob(o) {
    const a = Object.assign({
      range: [100, 320], cd: 3.6, windup: 0.6, strike: 0.1, recover: 0.45, anim: 'attack', variant: 'overhead', token: 1, ranged: true, needLos: false,
      track: 0, speed: 250, splash: 34, look: 'ice', mul: 1, type: 'ice', knock: 90, weight: 1,
      exec(e, t, a) {
        const tx = e.atkX + (t ? (t.vx || 0) * 0.25 : 0), ty = e.atkY + (t ? (t.vy || 0) * 0.25 : 0);
        const d = M.dist(e.x, e.y, tx, ty), T = M.clamp(d / a.speed, 0.5, 1.4), g = 600, z0 = 40 * e.sc;
        const vz = (0.5 * g * T * T - z0) / T, ang = M.angle(e.x, e.y, tx, ty);
        telegraph({ shape: 'circle', x: tx, y: ty, r: a.splash, dur: T, color: a.teleColor || TELE.ice });
        CB().projectile({
          x: e.x, y: e.y, z: z0, vx: Math.cos(ang) * d / T, vy: Math.sin(ang) * d / T, vz, gravity: g, r: 7, team: e.team, life: T + 0.4,
          look: a.look, color: a.color || [0.85, 0.92, 1], source: e, damage: null, ghost: true, pierce: 99,
          onExpire(p) {
            CB().hitCircle(p.x, p.y, a.splash, e.team, e.spec(a.mul, a.type, a.knock, a.status));
            fx('burst', p.x, p.y, 4, a.burst || 'ice', 16); fx('ring', p.x, p.y, 4, a.splash, 0.25, a.ringColor || [0.75, 0.9, 1]);
            if (a.onLand) a.onLand(e, p, a);
            sfx(a.landSound || 'ice', p.x, p.y, 0.6);
          },
        });
        sfx('swing_heavy', e.x, e.y, 0.5, 0.8);
      },
    }, o);
    return a;
  }
  // Short-range teleport (wisps, Blinking elites). Free of tokens; repositions to a flank or away.
  function blinkTo(e, t, minR, maxR, behind) {
    for (let k = 0; k < 10; k++) {
      let ang = behind && t ? (t.facing || 0) + Math.PI + rr(-0.6, 0.6) : rnd() * TAU;
      const r = rr(minR, maxR);
      const x = (t ? t.x : e.x) + Math.cos(ang) * r, y = (t ? t.y : e.y) + Math.sin(ang) * r;
      if (solid(x, y) || solid(x + 8, y) || solid(x - 8, y)) continue;
      if (t && !e.ghost && !los(x, y, t.x, t.y)) continue;
      fx('ghost', e, 0.35); fx('burst', e.x, e.y, e.height * 0.5, e.def.blinkBurst || 'shadow', 12);
      e.x = x; e.y = y; e.kx = e.ky = 0;
      fx('burst', e.x, e.y, e.height * 0.5, e.def.blinkBurst || 'shadow', 12);
      sfx(e.def.blinkSound || 'shriek', e.x, e.y, 0.35, 1.6);
      return true;
    }
    return false;
  }
  function blink(o) {
    return Object.assign({
      range: [0, 999], cd: 4.5, windup: 0.3, strike: 0.05, recover: 0.2, anim: 'cast', variant: 'channel', token: 0, track: 0, minR: 140, maxR: 210, weight: 6,
      when: (e, t, d) => d < 110 || e.hp01 < 0.5,
      exec(e, t, a) { blinkTo(e, t, a.minR, a.maxR, false); },
    }, o);
  }
  const ATTACK_LIB = {};

  // ==================================================================================================
  // Packs: wake together (rise from the ground in a staggered wave, or snap to alert).
  // ==================================================================================================
  class Pack {
    constructor(x, y, act) { this.x = x; this.y = y; this.act = act; this.members = []; this.awake = false; this.stir = 0; this.trigR = 230; this.leader = null; }
    add(e) { this.members.push(e); e.pack = this; }
    wake(t, by) {
      if (this.awake) { for (const m of this.members) if (!m.dead && (m.state === 'idle' || m.state === 'wander')) m.alert(t, false); return; }
      this.awake = true; this.stir = 0;
      let k = 0;
      const order = this.members.slice().sort((a, b) => M.dist2(a.x, a.y, t ? t.x : this.x, t ? t.y : this.y) - M.dist2(b.x, b.y, t ? t.x : this.x, t ? t.y : this.y));
      for (const m of order) {
        if (m.dead) continue;
        if (m.state === 'dormant') m.riseDelay = 0.08 + k++ * rr(0.14, 0.26);
        else if (m !== by) m.alert(t, false);
      }
      // first one to notice says something (leader preferred) and flags it
      const sp = this.leader && !this.leader.dead && this.leader.state !== 'dormant' ? this.leader : by;
      if (sp) {
        bark(sp, sp.isElite ? (sp.defId === 'penguin' ? 'gunter' : BARKS[sp.defId] ? sp.defId : 'elite') : sp.barkKey(), sp.isElite ? 1 : 0.6, sp.isElite);
        fx('text', sp.x, sp.y, sp.height + 18, '!', [1, 0.8, 0.3], 1.2);
      }
      if (k > 0) sfx(this.members[0].def.riseSfx || 'zombie', this.x, this.y, 0.6, 0.9);
    }
    // When the leader falls the bond breaks: survivors reel for a moment (a reward for focusing the elite).
    onMemberDeath(e) {
      if (e !== this.leader) return;
      for (const m of this.members) {
        if (m.dead || m.state === 'dormant' || m.state === 'rising' || !m.engaged) continue;
        m.stagger(0.6); fx('text', m.x, m.y, m.height + 6, '?', [0.8, 0.8, 0.9], 0.8);
      }
    }
  }

  // ==================================================================================================
  // Death effects
  // ==================================================================================================
  // Delayed blast with a fair fuse ring (bloater, cinder). team -1 hits everyone but neutrals: lure them!
  function fuseBlast(e, r, dur, color, fn) {
    const x = e.x, y = e.y;
    telegraph({ shape: 'circle', x, y, r, dur, color });
    const g = G(); if (g && g.after) g.after(dur, () => fn(x, y)); else fn(x, y);
  }
  function bloaterBurst(e, x, y, full) {
    const r = 70 * e.sc;
    if (full) {
      CB().hitCircle(x, y, r, -1, { amount: e.dmg * 1.6, type: 'poison', source: e, knock: 200, status: { id: 'rot', dur: 3, dps: 2.5 * e.dmgK, stacks: 2 } }, { filter: (a) => a !== e });
    }
    fx('explosion', x, y, r, 'poison');
    fx('burst', x, y, 10, 'sugar', 26); fx('burst', x, y, 8, 'rot', 22);
    fx('decal', x, y, 'rot', r * 0.9, 14);
    rotZone(x, y, r * 0.8, 6.5, e, 2.2 * e.dmgK, true);
    sfx('explode', x, y, 0.85, 1.25); sfx('poison', x, y, 0.7);
  }
  function cinderBlast(e, x, y) {
    const r = 56 * e.sc;
    CB().hitCircle(x, y, r, -1, { amount: e.dmg * 1.5, type: 'fire', source: e, knock: 220, status: { id: 'burn', dur: 3, dps: 3 * e.dmgK } }, { filter: (a) => a !== e });
    fx('explosion', x, y, r, 'fire');
    fx('burst', x, y, 8, 'ember', 30); fx('burst', x, y, 6, 'ash', 10);
    fx('light', x, y, 16, r * 2.6, [1, 0.5, 0.15], 2.2, 0.45);
    fx('decal', x, y, 'scorch', r * 0.8, 16);
    fireZone(x, y, r * 0.6, 3.2, e, 5 * e.dmgK);
    CB().igniteAt(x, y, r, e);
    sfx('explode', x, y, 0.9, 1.1);
  }

  // ==================================================================================================
  // The roster. Base stats are for floor 1; scale() grows them per floor/ascension.
  // colors: generic keys (head top legs skin) + semantic keys (bone cloth metal eye accent glow shell body)
  // ==================================================================================================
  const BONE = [0.86, 0.84, 0.74], BONE_D = [0.62, 0.6, 0.52], GREEN_EYE = [0.45, 1, 0.55];
  const DEFS = {
    // ---------------------------------------------------------------- Act I — the Grasslands
    thrall: {
      name: 'Bone Thrall', eliteName: 'Bone Captain', act: 1, rig: 'thrall',
      hp: 34, dmg: 8, speed: 62, radius: 8, height: 58, mass: 1, xp: 6, gold: [0, 3], aggro: 250, melee: true, rises: true, poise: 0.3,
      block: { half: 0.95, mul: 0.45, idleOnly: true },
      colors: { head: BONE, top: BONE_D, legs: BONE, skin: BONE, bone: BONE, cloth: [0.28, 0.26, 0.24], metal: [0.58, 0.6, 0.64], eye: [0.55, 0.9, 0.6] },
      weapon: { kind: 'sword', material: 'iron' }, shield: true,
      swingColor: [0.85, 0.86, 0.9], riseBurst: 'bone', riseSfx: 'bone_break', deathSfx: 'bone_break', stirGlow: [0.4, 1, 0.5],
      attacks: [
        swing({ id: 'slash', reach: 30, cd: 1.5, windup: 0.3, strike: 0.1, recover: 0.45, variant: 'slash1', mul: 1, knock: 90, weight: 3 }),
        swing({ id: 'cleave', reach: 38, half: 1.15, cd: 4.5, windup: 0.55, strike: 0.12, recover: 0.7, variant: 'overhead', mul: 1.7, knock: 210, big: true, weight: 1 }),
      ],
    },
    archer: {
      name: 'Bone Archer', eliteName: 'Deadeye', act: 1, rig: 'archer',
      hp: 24, dmg: 8, speed: 68, radius: 7, height: 56, mass: 0.9, xp: 7, gold: [0, 3], aggro: 300, rises: true, poise: 0.2,
      ai: AI.kite, keep: [150, 250],
      colors: { head: BONE, top: [0.2, 0.25, 0.2], legs: BONE_D, skin: BONE, bone: BONE, cloth: [0.2, 0.26, 0.2], eye: [0.55, 0.9, 0.6], accent: [0.45, 0.35, 0.22] },
      weapon: { kind: 'bow', material: 'ossite' },
      riseBurst: 'bone', riseSfx: 'bone_break', deathSfx: 'bone_break', stirGlow: [0.4, 1, 0.5],
      attacks: [
        shoot({ id: 'arrow', range: [45, 330], cd: 2.3, windup: 0.62, strike: 0.08, recover: 0.38, look: 'arrow', speed: 440, mul: 1, knock: 50, lock: 0.18, track: 4, lead: 0.6, aimLine: true, aimLen: 300, sound: 'swing', pitch: 1.6 }),
        swing({ id: 'stab', reach: 24, half: 0.5, cd: 1.6, windup: 0.28, variant: 'thrust', mul: 0.7, knock: 120, weight: 3 }),
      ],
    },
    hound: {
      name: 'Ghoul Hound', eliteName: 'Alpha Ghoul', act: 1, rig: 'hound',
      hp: 22, dmg: 6, speed: 138, radius: 8, height: 28, mass: 0.8, xp: 5, gold: [0, 1], aggro: 290, melee: true, poise: 0.2, wanderR: 90,
      colors: { head: [0.5, 0.47, 0.42], top: [0.42, 0.4, 0.36], legs: [0.36, 0.34, 0.3], skin: [0.42, 0.4, 0.36], bone: BONE, eye: [1, 0.25, 0.15], accent: [0.55, 0.12, 0.1] },
      weapon: { kind: 'claws', material: 'ossite' }, swingColor: [0.85, 0.3, 0.25], riseSfx: 'zombie',
      attacks: [
        swing({ id: 'bite', reach: 24, half: 0.7, cd: 1.1, windup: 0.25, strike: 0.08, recover: 0.35, variant: 'bite', mul: 1, knock: 40, weight: 2, status: { id: 'bleed', dur: 3, dps: 1.2 } }),
        lunge({ id: 'lunge', range: [45, 125], cd: 3.2, windup: 0.45, strike: 0.22, recover: 0.45, dist: 105, variant: 'bite', mul: 1.4, knock: 120, stopOnHit: true, big: true, weight: 3, sound: 'zombie', pitch: 1.4 }),
      ],
    },
    snail: {
      name: 'The Waving Snail', act: 0, rig: 'snail',
      hp: 40, dmg: 6, speed: 9, radius: 7, height: 18, mass: 3, xp: 30, gold: [8, 24], aggro: 150, leash: 1e9, neutral: true, poise: 99,
      colors: { shell: [0.78, 0.58, 0.36], body: [0.78, 0.82, 0.66], head: [0.78, 0.82, 0.66], top: [0.78, 0.58, 0.36], legs: [0.7, 0.75, 0.6], skin: [0.78, 0.82, 0.66], eye: [0.08, 0.08, 0.08] },
      attacks: [], deathSfx: 'death',
      brain: (e, dt) => snailBrain(e, dt),
      onDamaged: (e, info) => snailHit(e, info),
      titleIdle: (e) => { e.oneShot('special', 1.4, 'wave'); },
    },

    // ---------------------------------------------------------------- Act II — the Candy Necropolis
    husk: {
      name: 'Sugar Husk', eliteName: 'Rot Matriarch', act: 2, rig: 'husk',
      hp: 46, dmg: 9, speed: 46, radius: 9, height: 56, mass: 1.3, xp: 8, gold: [0, 3], aggro: 230, melee: true, rises: true, poise: 0.4, lurch: true,
      colors: { head: [0.86, 0.5, 0.62], top: [0.7, 0.32, 0.45], legs: [0.5, 0.25, 0.35], skin: [0.86, 0.5, 0.62], body: [0.86, 0.5, 0.62], accent: [0.95, 0.9, 0.92], eye: [0.7, 1, 0.4] },
      weapon: { kind: 'claws', material: 'candy' }, swingColor: [0.95, 0.5, 0.65],
      riseBurst: 'sugar', riseSfx: 'zombie', deathSfx: 'zombie', stirGlow: [1, 0.4, 0.6],
      attacks: [
        swing({ id: 'grab', reach: 30, half: 0.8, cd: 1.8, windup: 0.42, strike: 0.14, recover: 0.55, variant: 'claw', mul: 1, knock: 0, weight: 1,
          status: { id: 'rot', dur: 3, dps: 2, stacks: 2 }, color: [0.95, 0.5, 0.65],
          onHit(e, h) { const a = M.angle(h.x, h.y, e.x, e.y); h.kx += Math.cos(a) * 110; h.ky += Math.sin(a) * 110; fx('burst', h.x, h.y, 20, 'sugar', 6); } }),
      ],
      onDeath(e) {
        fx('burst', e.x, e.y, 16, 'sugar', 14);
        if (rnd() < 0.3) { rotZone(e.x, e.y, 30 * e.sc, 7, e, 1.6 * e.dmgK); fx('decal', e.x, e.y, 'rot', 28 * e.sc, 12); }
      },
    },
    bloater: {
      name: 'Gumdrop Bloater', eliteName: 'Great Gumdrop', act: 2, rig: 'bloater',
      hp: 40, dmg: 13, speed: 50, radius: 11, height: 40, mass: 1.6, xp: 9, gold: [0, 2], aggro: 240, melee: true, poise: 0.7,
      colors: { body: [0.95, 0.35, 0.52], head: [0.95, 0.35, 0.52], top: [0.95, 0.35, 0.52], legs: [0.7, 0.22, 0.38], skin: [0.95, 0.35, 0.52], accent: [0.55, 0.85, 0.3], eye: [0.15, 0.05, 0.08] },
      deathSfx: 'poison', riseSfx: 'zombie',
      attacks: [{
        id: 'swell', range: [0, 64], cd: 99, windup: 1.0, strike: 0.04, recover: 0.05, anim: 'special', variant: 'swell', big: true, token: 1, track: 0, weight: 1,
        tele: (e) => ({ shape: 'circle', x: e.x, y: e.y, r: 70 * e.sc, color: TELE.rot, follow: e }),
        onStart(e) { bark(e, 'bloater', 0.5); sfx('poison', e.x, e.y, 0.6, 0.6); },
        onWindup(e, dt, f) { if (e.rig) e.rig.swell = f; if (rnd() < 0.3) fx('burst', e.x, e.y, 18, 'rot', 1); },
        onEnd(e, interrupted) { if (interrupted && e.rig && !e.dead) e.rig.swell = 0; },
        exec(e) { e._burst = true; e.xpValue = Math.round(e.xpValue * 0.5); bloaterBurst(e, e.x, e.y, true); CB().kill(e, { source: e, selfDestruct: true }); },
      }],
      onDeath(e, info) {
        if (e._burst) return;
        e._burst = true;
        fuseBlast(e, 70 * e.sc, 0.5, TELE.rot, (x, y) => bloaterBurst(e, x, y, true));
      },
    },
    banana: {
      name: 'Banana Guard Revenant', eliteName: 'Banana Sergeant', act: 2, rig: 'banana',
      hp: 52, dmg: 10, speed: 72, radius: 9, height: 62, mass: 1.2, xp: 10, gold: [0, 4], aggro: 260, melee: true, rises: true, poise: 0.35,
      block: { half: 1.0, mul: 0.2 },
      colors: { head: [0.95, 0.84, 0.32], top: [0.92, 0.8, 0.3], legs: [0.45, 0.38, 0.16], skin: [0.95, 0.84, 0.32], body: [0.95, 0.84, 0.32], accent: [0.42, 0.34, 0.14], metal: [0.62, 0.64, 0.68], eye: [0.15, 0.1, 0.05] },
      weapon: { kind: 'spear', material: 'iron' }, swingColor: [0.95, 0.9, 0.6],
      riseBurst: 'sugar', riseSfx: 'zombie', stirGlow: [1, 0.85, 0.3],
      attacks: [
        swing({ id: 'poke', reach: 40, half: 0.35, cd: 1.6, windup: 0.3, variant: 'thrust', mul: 0.9, knock: 110, weight: 2 }),
        lunge({ id: 'lunge', range: [55, 135], cd: 3.6, windup: 0.55, strike: 0.2, recover: 0.7, dist: 112, w: 5, variant: 'thrust', mul: 1.6, knock: 220, big: true, weight: 2, teleColor: TELE.orange, stopOnHit: true }),
      ],
      onDeath(e) { fx('burst', e.x, e.y, 30, 'sugar', 8); },
    },

    // ---------------------------------------------------------------- Act III — the Ice Kingdom
    penguin: {
      name: 'Cursed Penguin', eliteName: 'Gunter, Who Was', act: 3, rig: 'penguin',
      hp: 30, dmg: 8, speed: 80, radius: 7, height: 30, mass: 0.9, xp: 9, gold: [0, 2], aggro: 270, melee: true, poise: 0.25, wanderR: 70,
      colors: { head: [0.12, 0.13, 0.18], top: [0.12, 0.13, 0.18], legs: [0.95, 0.6, 0.15], skin: [0.88, 0.9, 0.95], body: [0.88, 0.9, 0.95], accent: [0.95, 0.6, 0.15], eye: [0.6, 0.9, 1] },
      swingColor: [0.7, 0.9, 1], riseSfx: 'wenk', deathSfx: 'wenk',
      attacks: [
        swing({ id: 'peck', reach: 22, half: 0.6, cd: 1.2, windup: 0.26, variant: 'bite', mul: 0.8, knock: 50, weight: 2 }),
        lunge({ id: 'slide', range: [60, 230], cd: 4, windup: 0.5, strike: 0.55, recover: 0.6, dist: 240, w: 6, variant: 'thrust', strikeAnim: 'dodge', strikeVariant: 'slide',
          mul: 1.2, type: 'phys', knock: 170, big: true, weight: 3, teleColor: TELE.ice, status: { id: 'chill', dur: 2 }, sound: 'ice',
          onStart(e) { sfx('wenk', e.x, e.y, 0.8, rr(0.9, 1.2)); bark(e, e.barkKey(), 0.4); },
          trail(e) { fx('burst', e.x, e.y, 2, 'ice', 2); if (e.isElite && e.defId === 'penguin') iceZone(e.x, e.y, 16, 3, e); },
          onWall(e) { e.stunT = 0.6; fx('burst', e.x, e.y, 10, 'ice', 10); sfx('hit', e.x, e.y, 0.6, 0.7); } }),
      ],
      onDeath(e) { fx('burst', e.x, e.y, 10, 'ice', 10); },
    },
    golem: {
      name: 'Snow Golem', eliteName: 'Glacier Heart', act: 3, rig: 'golem',
      hp: 95, dmg: 13, speed: 40, radius: 13, height: 72, mass: 3, xp: 18, gold: [1, 5], aggro: 260, melee: true, rises: true, poise: 0.5,
      res: { ice: 0.6, fire: -0.3 },
      colors: { head: [0.88, 0.92, 1], top: [0.85, 0.9, 1], legs: [0.7, 0.8, 0.95], skin: [0.85, 0.9, 1], body: [0.85, 0.9, 1], accent: [0.55, 0.75, 0.95], eye: [0.08, 0.08, 0.1] },
      weapon: { kind: 'fists', material: 'glacial' }, swingColor: [0.75, 0.9, 1],
      riseBurst: 'ice', riseSfx: 'ice', deathSfx: 'shatter', stirGlow: [0.5, 0.8, 1],
      attacks: [
        slam({ id: 'slam', reach: 44, r: 72, ahead: 18, cd: 4.2, windup: 0.75, mul: 1.5, knock: 230, status: { id: 'chill', dur: 2.2 }, burst: 'ice', decal: 'frost', teleColor: TELE.ice, ringColor: [0.7, 0.9, 1], light: [0.5, 0.8, 1], weight: 2,
          onSlam(e, p) { iceZone(p[0], p[1], 40 * e.sc, 3, e); } }),
        swing({ id: 'swipe', reach: 36, half: 1.0, cd: 2, windup: 0.4, variant: 'punch', mul: 1, knock: 180, weight: 2 }),
        lob({ id: 'snowball', range: [110, 320], cd: 3.6, windup: 0.6, mul: 0.9, status: { id: 'chill', dur: 1.8 }, splash: 34, weight: 2 }),
      ],
      onDeath(e) { fx('burst', e.x, e.y, 30, 'ice', 24); fx('decal', e.x, e.y, 'frost', 30, 18); },
    },
    wisp: {
      name: 'Frost Wisp', eliteName: 'Hoarfrost Will', act: 3, rig: 'wisp',
      hp: 26, dmg: 7, speed: 74, radius: 7, height: 34, mass: 0.5, xp: 12, gold: [0, 3], aggro: 300, poise: 0.15,
      ai: AI.kite, keep: [150, 260], res: { ice: 0.8, fire: -0.4 },
      colors: { head: [0.6, 0.85, 1], top: [0.45, 0.7, 1], legs: [0.3, 0.5, 0.9], skin: [0.6, 0.85, 1], glow: [0.6, 0.85, 1], eye: [1, 1, 1] },
      light: [70, 0.4, 0.7, 1, 0.6], blinkBurst: 'ice', blinkSound: 'ice', deathSfx: 'shatter',
      attacks: [
        shoot({ id: 'volley', range: [60, 320], cd: 3.0, windup: 0.55, strike: 0.32, recover: 0.4, anim: 'cast', variant: 'forward', look: 'ice', speed: 250, count: 3, spread: 0.2, volley: true,
          mul: 0.8, type: 'ice', status: { id: 'chill', dur: 1.5 }, light: [40, 0.4, 0.7, 1], aimLine: true, aimLen: 240, aimColor: TELE.ice, track: 3, sound: 'ice', pitch: 1.5, flash: [0.5, 0.8, 1] }),
        blink({ id: 'blink', cd: 4.5, minR: 150, maxR: 220 }),
      ],
      onDeath(e) { fx('burst', e.x, e.y, 20, 'ice', 20); fx('light', e.x, e.y, 20, 90, [0.5, 0.8, 1], 1.6, 0.3); },
    },

    // ---------------------------------------------------------------- Act IV — the Fire Kingdom
    elemental: {
      name: 'Flame Elemental', eliteName: 'Wildfire Heart', act: 4, rig: 'elemental',
      hp: 34, dmg: 9, speed: 88, radius: 8, height: 44, mass: 0.6, xp: 15, gold: [1, 4], aggro: 300, poise: 0.2,
      ai: AI.kite, keep: [110, 230], erratic: true, res: { fire: 0.8, ice: -0.3 },
      colors: { head: [1, 0.8, 0.4], top: [1, 0.55, 0.15], legs: [0.9, 0.3, 0.08], skin: [1, 0.7, 0.3], glow: [1, 0.55, 0.15], eye: [1, 1, 0.8] },
      light: [90, 1, 0.5, 0.15, 0.9], deathSfx: 'fire',
      attacks: [
        shoot({ id: 'fireball', range: [50, 300], cd: 2.4, windup: 0.5, strike: 0.08, recover: 0.4, anim: 'cast', variant: 'forward', look: 'fireball', type: 'fire', speed: 230, mul: 1.1, r: 7,
          status: { id: 'burn', dur: 2, dps: 2 }, light: [60, 1, 0.5, 0.15], sound: 'fireball', pitch: 1, flash: [1, 0.55, 0.2], lead: 0.4,
          onImpact(e, p) { fx('burst', p.x, p.y, p.z, 'ember', 12); fx('explosion', p.x, p.y, 22, 'fire'); fireZone(p.x, p.y, 20, 2.4, e, 4 * e.dmgK); CB().igniteAt(p.x, p.y, 24, e); } }),
      ],
      tick(e, dt) {
        if (!e.engaged) return;
        e.trailT = (e.trailT || 2) - dt;
        if (e.trailT <= 0 && Math.hypot(e.vx, e.vy) > 20) { e.trailT = rr(2.2, 3.2); fireZone(e.x, e.y, 18, 3, e, 4 * e.dmgK); fx('burst', e.x, e.y, 6, 'ember', 6); }
        if (rnd() < dt * 8) fx('burst', e.x, e.y, (e.z || 0) + 22, 'ember', 1);
      },
      onDeath(e) { fx('explosion', e.x, e.y, 34, 'fire'); fx('burst', e.x, e.y, 20, 'ember', 22); fireZone(e.x, e.y, 26, 2.5, e, 4 * e.dmgK); },
    },
    cinder: {
      name: 'Cinder Hound', eliteName: 'Pyre Alpha', act: 4, rig: 'cinder',
      hp: 26, dmg: 8, speed: 150, radius: 8, height: 28, mass: 0.8, xp: 12, gold: [0, 2], aggro: 290, melee: true, poise: 0.2, wanderR: 90,
      res: { fire: 0.6, ice: -0.2 },
      colors: { head: [0.18, 0.14, 0.13], top: [0.16, 0.12, 0.12], legs: [0.14, 0.1, 0.1], skin: [0.18, 0.14, 0.13], accent: [1, 0.42, 0.1], glow: [1, 0.42, 0.1], eye: [1, 0.75, 0.2] },
      weapon: { kind: 'claws', material: 'emberstone' }, swingColor: [1, 0.55, 0.2],
      light: [45, 1, 0.4, 0.1, 0.5], deathSfx: 'fire',
      attacks: [
        swing({ id: 'bite', reach: 24, half: 0.7, cd: 1.1, windup: 0.25, strike: 0.08, recover: 0.35, variant: 'bite', mul: 1, type: 'fire', knock: 40, weight: 2, status: { id: 'burn', dur: 2, dps: 2 } }),
        lunge({ id: 'lunge', range: [45, 125], cd: 3, windup: 0.45, strike: 0.2, recover: 0.4, dist: 110, variant: 'bite', mul: 1.3, type: 'fire', knock: 120, stopOnHit: true, big: true, weight: 3, teleColor: TELE.orange,
          trail(e) { fx('burst', e.x, e.y, 6, 'ember', 2); } }),
      ],
      onDeath(e) { fuseBlast(e, 56 * e.sc, 0.5, TELE.orange, (x, y) => cinderBlast(e, x, y)); fx('burst', e.x, e.y, 10, 'ember', 10); },
    },
    brute: {
      name: 'Magma Brute', eliteName: 'Caldera King', act: 4, rig: 'brute',
      hp: 120, dmg: 14, speed: 54, radius: 14, height: 76, mass: 3.5, xp: 24, gold: [2, 6], aggro: 260, melee: true, rises: true, poise: 0.45, armor: 20,
      res: { fire: 0.7, ice: -0.2 },
      colors: { head: [0.32, 0.24, 0.22], top: [0.3, 0.22, 0.2], legs: [0.26, 0.2, 0.18], skin: [0.3, 0.22, 0.2], accent: [1, 0.45, 0.1], glow: [1, 0.45, 0.1], eye: [1, 0.8, 0.3] },
      weapon: { kind: 'fists', material: 'emberstone' }, swingColor: [1, 0.55, 0.2],
      light: [70, 1, 0.4, 0.1, 0.5], riseBurst: 'ember', riseSfx: 'fire', deathSfx: 'death_big', stirGlow: [1, 0.4, 0.1],
      attacks: [
        lunge({ id: 'charge', range: [70, 270], cd: 5.5, windup: 0.65, strike: 0.6, recover: 0.9, dist: 300, w: 8, variant: 'heavy', strikeAnim: 'dodge', strikeVariant: 'dash',
          mul: 1.8, knock: 340, big: true, token: 2, weight: 2, teleColor: TELE.orange, hyper: true, sound: 'swing_heavy', pitch: 0.6, stopOnHit: true,
          onHit(e, h) { shakeNear(h.x, h.y, 6); fx('burst', h.x, h.y, 20, 'ember', 12); },
          onStart(e) { bark(e, 'brute', 0.3); },
          trail(e) { fx('burst', e.x, e.y, 4, 'ember', 3); fx('burst', e.x, e.y, 2, 'dust', 2); },
          onWall(e) { e.stunT = 1.1; shakeNear(e.x, e.y, 7); fx('burst', e.x, e.y, 30, 'ember', 18); fx('text', e.x, e.y, e.height + 10, 'stunned', [1, 0.9, 0.5], 0.9); sfx('explode', e.x, e.y, 0.7, 0.6); } }),
        slam({ id: 'slam', reach: 44, r: 66, ahead: 16, cd: 4, windup: 0.62, mul: 1.6, status: { id: 'burn', dur: 3, dps: 3 }, burst: 'ember', decal: 'scorch', teleColor: TELE.orange, ringColor: [1, 0.5, 0.15], light: [1, 0.45, 0.1], weight: 2 }),
        swing({ id: 'smash', reach: 38, half: 1.0, cd: 1.9, windup: 0.38, variant: 'punch', mul: 1.1, knock: 230, weight: 2 }),
      ],
      tick(e) {
        if (!e.enraged && e.hp01 < 0.3 && !e.dead && e.state !== 'dormant') {
          e.enraged = true; e.stats.atkSpeed *= 1.3; e.stats.moveMul *= 1.35; e.cdMulV *= 0.75;
          const pal = e.rig && (e.rig.pal || e.rig.colors);
          if (pal) for (const k in pal) { const c = pal[k]; if (Array.isArray(c) && c.length >= 3) pal[k] = [Math.min(1.4, c[0] * 1.35 + 0.12), c[1] * 0.85, c[2] * 0.6]; }
          e.rig && (e.rig.enraged = true);
          bark(e, 'brute_enrage', 1, true); fx('burst', e.x, e.y, 30, 'ember', 30); fx('ring', e.x, e.y, 8, 80, 0.4, [1, 0.4, 0.1]);
          sfx('bossRoar', e.x, e.y, 0.5, 1.4); shakeNear(e.x, e.y, 4);
          if (HM.Rig && HM.Rig.trigger) HM.Rig.trigger(e, 'roar');
        }
      },
      onDeath(e) { fx('burst', e.x, e.y, 30, 'ember', 26); fx('decal', e.x, e.y, 'scorch', 34, 18); fireZone(e.x, e.y, 30, 2.5, e, 4 * e.dmgK); },
    },

    // ---------------------------------------------------------------- Act V — the Lich's Well
    knight: {
      name: 'Lich Thrall Knight', eliteName: 'Oathbroken Champion', act: 5, rig: 'knight',
      hp: 110, dmg: 13, speed: 52, radius: 11, height: 70, mass: 2.5, xp: 22, gold: [2, 6], aggro: 260, melee: true, rises: true, poise: 0.55, armor: 35,
      res: { phys: 0.3, shadow: 0.5, holy: -0.3 }, block: { half: 0.9, mul: 0.35 },
      colors: { head: [0.36, 0.38, 0.42], top: [0.34, 0.36, 0.4], legs: [0.3, 0.32, 0.36], skin: BONE, bone: BONE, metal: [0.4, 0.42, 0.48], cloth: [0.16, 0.2, 0.16], eye: GREEN_EYE, glow: GREEN_EYE },
      weapon: { kind: 'sword', material: 'bloodiron' }, shield: true, swingColor: [0.55, 1, 0.6],
      riseBurst: 'witchfire', riseSfx: 'bone_break', deathSfx: 'bone_break', stirGlow: [0.4, 1, 0.5],
      attacks: [
        swing({ id: 'slash', reach: 38, half: 1.0, cd: 1.8, windup: 0.36, variant: 'slash2', mul: 1.1, knock: 140, weight: 3 }),
        slam({ id: 'overhead', reach: 50, r: 50, ahead: 36, cd: 4.5, windup: 0.8, strike: 0.12, recover: 0.85, variant: 'overhead', mul: 2.2, knock: 270,
          status: { id: 'weaken', dur: 3 }, burst: 'witchfire', decal: 'witch', teleColor: TELE.witch, ringColor: [0.4, 1, 0.5], light: [0.4, 1, 0.5], weight: 2 }),
      ],
      onDeath(e) { fx('burst', e.x, e.y, 30, 'witchfire', 14); },
    },
    priest: {
      name: 'Bone Priest', eliteName: 'Hierophant of the Well', act: 5, rig: 'priest',
      hp: 48, dmg: 9, speed: 56, radius: 8, height: 62, mass: 1, xp: 20, gold: [1, 5], aggro: 300, rises: true, poise: 0.25,
      ai: AI.kite, keep: [170, 280], res: { shadow: 0.5, holy: -0.4 },
      colors: { head: BONE, top: [0.2, 0.24, 0.19], legs: [0.16, 0.2, 0.16], skin: BONE, bone: BONE, cloth: [0.2, 0.24, 0.19], eye: GREEN_EYE, glow: GREEN_EYE, accent: [0.4, 1, 0.5] },
      weapon: { kind: 'staff', material: 'ossite' },
      light: [50, 0.3, 1, 0.4, 0.5], riseBurst: 'witchfire', riseSfx: 'bone_break', deathSfx: 'bone_break', stirGlow: [0.4, 1, 0.5],
      attacks: [
        shoot({ id: 'witchfire', range: [60, 330], cd: 2.4, windup: 0.5, strike: 0.08, recover: 0.4, anim: 'cast', variant: 'forward', look: 'witchfire', type: 'shadow', speed: 210, homing: 1.3,
          mul: 1.1, r: 6, light: [50, 0.3, 1, 0.4], sound: 'fireball', pitch: 1.6, flash: [0.4, 1, 0.5], lead: 0 }),
        {
          id: 'summon', range: [0, 420], cd: 11, windup: 1.0, strike: 0.1, recover: 0.5, anim: 'cast', variant: 'summon', token: 0, track: 0, weight: 4, big: true,
          when: (e) => (e.summons || 0) < 3,
          onStart(e, t, a) {
            e.summonPts = [];
            for (let k = 0; k < 2; k++) { const p = openNear(e.x + Math.cos(e.aim + (k ? 0.9 : -0.9)) * 40, e.y + Math.sin(e.aim + (k ? 0.9 : -0.9)) * 40, 20); e.summonPts.push(p); telegraph({ shape: 'circle', x: p[0], y: p[1], r: 16, dur: 1.0, color: TELE.witch }); }
            bark(e, 'priest', 0.7); sfx('lich_laugh', e.x, e.y, 0.35, 1.5);
          },
          onWindup(e) { if (rnd() < 0.4) fx('burst', e.x, e.y, e.height, 'witchfire', 1); },
          exec(e) {
            for (const p of e.summonPts || []) {
              const m = Enemies.spawn('thrall', p[0], p[1], { rise: true, summoned: true });
              if (m) { m.summoner = e; e.summons = (e.summons || 0) + 1; m.home = { x: e.home.x, y: e.home.y }; }
              fx('burst', p[0], p[1], 4, 'witchfire', 10);
            }
            fx('light', e.x, e.y, 30, 90, [0.4, 1, 0.5], 1.6, 0.4);
          },
        },
        {
          id: 'mend', range: [0, 999], cd: 6, windup: 0.7, strike: 0.1, recover: 0.4, anim: 'cast', variant: 'raise', token: 0, track: 0, weight: 8,
          when: (e) => !!(e.mendTarget = woundedAlly(e, 230)),
          onStart(e) { const m = e.mendTarget; if (m) telegraph({ shape: 'circle', x: m.x, y: m.y, r: m.radius + 10, dur: 0.7, color: TELE.witch }); },
          exec(e) {
            const m = e.mendTarget; if (!m || m.dead) return;
            CB().heal(m, m.maxHp * 0.3);
            fx('beam', e.x, e.y, m.x, m.y, { w: 1, color: [0.4, 1, 0.5], dur: 0.35, glyphs: "+'." });
            fx('burst', m.x, m.y, m.height * 0.5, 'witchfire', 12);
            sfx('shrine', m.x, m.y, 0.4, 0.7);
          },
        },
      ],
      onDeath(e) {
        fx('burst', e.x, e.y, 40, 'witchfire', 18);
        // the bound collapse when their priest falls (no XP — reward for picking the priest)
        const g = G(); if (!g) return;
        for (const m of g.entities) if (m.summoner === e && !m.dead) { const mm = m; g.after(rr(0.2, 0.6), () => { if (!mm.dead) { mm.xpValue = 0; mm.goldDrop = [0, 0]; CB().kill(mm, { source: null, collapse: true }); } }); }
      },
    },
    wraith: {
      name: 'Void Wraith', eliteName: 'The Hollow Choir', act: 5, rig: 'wraith',
      hp: 60, dmg: 11, speed: 92, radius: 9, height: 60, mass: 0.7, xp: 20, gold: [1, 5], aggro: 320, melee: true, poise: 0.3, ghost: true,
      res: { phys: 0.25, shadow: 0.8, holy: -0.5 },
      colors: { head: [0.28, 0.22, 0.38], top: [0.22, 0.18, 0.32], legs: [0.12, 0.1, 0.2], skin: [0.3, 0.25, 0.4], cloth: [0.18, 0.14, 0.28], eye: GREEN_EYE, glow: [0.6, 0.4, 1] },
      weapon: { kind: 'claws', material: 'nightglass' }, swingColor: [0.7, 0.45, 1],
      light: [50, 0.5, 0.3, 0.9, 0.4], blinkBurst: 'shadow', deathSfx: 'shriek',
      attacks: [
        swing({ id: 'rake', reach: 32, half: 0.9, cd: 1.5, windup: 0.32, variant: 'claw', mul: 1, type: 'shadow', knock: 60, weight: 3, status: { id: 'doom', dur: 4, dps: 2.5 } }),
        {
          id: 'phase', range: [70, 360], cd: 6, windup: 0.4, strike: 0.45, recover: 0.02, anim: 'cast', variant: 'channel', token: 1, track: 0, weight: 3, next: 'ambush',
          onStart(e) { fx('burst', e.x, e.y, e.height * 0.5, 'shadow', 10); sfx('shriek', e.x, e.y, 0.4, 0.8); },
          exec(e) { fx('ghost', e, 0.4); fx('burst', e.x, e.y, e.height * 0.5, 'shadow', 16); e.hidden = true; e.invuln = true; e.noCollide = true; },
          during(e) { e.vx = e.vy = 0; },
          onRecover(e, t) {
            if (t && !t.dead) {
              const back = (t.facing !== undefined ? t.facing : 0) + Math.PI;
              let ok = false;
              for (let k = 0; k < 6 && !ok; k++) { const a = back + (k ? (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.5 : 0); const x = t.x + Math.cos(a) * 34, y = t.y + Math.sin(a) * 34; if (!solid(x, y)) { e.x = x; e.y = y; ok = true; } }
            }
            e.hidden = false; e.invuln = false; e.noCollide = false; e.kx = e.ky = 0;
            fx('burst', e.x, e.y, e.height * 0.5, 'shadow', 16); sfx('shriek', e.x, e.y, 0.5, 1.2);
            if (t) e.facing = e.aim = M.angle(e.x, e.y, t.x, t.y);
            bark(e, 'wraith', 0.5);
          },
          onEnd(e, interrupted) { if (interrupted || e.dead) { e.hidden = false; e.invuln = false; e.noCollide = false; } },
        },
      ],
      onDeath(e) { fx('burst', e.x, e.y, 30, 'shadow', 22); fx('burst', e.x, e.y, 30, 'witchfire', 8); },
    },
  };
  // The wraith's reappearance strike: a fair 0.45 s telegraphed rake from behind.
  ATTACK_LIB.ambush = swing({ id: 'ambush', reach: 36, half: 1.0, cd: 0, windup: 0.45, strike: 0.1, recover: 0.5, variant: 'claw', mul: 1.3, type: 'shadow', knock: 120, big: true, teleColor: TELE.void, status: { id: 'doom', dur: 5, dps: 3 } });
  for (const id in DEFS) DEFS[id].id = id;

  function woundedAlly(e, r) {
    let best = null, bh = 0.6;
    for (const a of G().entities) {
      if (a === e || a.dead || a.team !== e.team || a.isBoss || a.state === 'dormant' || a.hidden) continue;
      if (a.hp01 < bh && M.dist(e.x, e.y, a.x, a.y) < r) { bh = a.hp01; best = a; }
    }
    return best;
  }

  // ==================================================================================================
  // The Waving Snail. Team 1 so it can be struck (hitting it is the point), but it never attacks.
  // ==================================================================================================
  function snailBrain(e, dt) {
    const g = G(), p = g && g.player;
    if (e.possessed) { possessedBrain(e, dt, p); return; }
    e.engaged = false; e.vx = e.vy = 0;
    if (!p || p.dead) return;
    const d = M.dist(e.x, e.y, p.x, p.y);
    if (d < 160 && e.sees(p)) {
      e.faceToward(p.x, p.y, dt, 2.5);
      e.waveT = (e.waveT === undefined ? 0.5 : e.waveT) - dt;
      if (e.waveT <= 0) { e.waveT = rr(3, 4.6); e.oneShot('special', 1.4, 'wave'); bark(e, e.greenEyes ? 'snail_cursed' : 'snail', 0.4); }
    } else e.wanderAI(dt);
  }
  function snailHit(e, info) {
    if (e.possessed) return false;
    info.amount = Math.min(info.amount, e.hp * 0.35);
    e.possessed = true; e.greenEyes = true; e.possT = 0; e.possPhase = 'laugh';
    e.name = e.baseName = 'The Possessed Snail'; e.invuln = true; e.vx = e.vy = 0;
    if (e.rig) e.rig.possessed = true;
    setPal(e, 'eye', GREEN_EYE);
    e.lightOverride = [90, 0.35, 1, 0.45, 0.9];
    e.oneShot('special', 1.2, 'laugh');
    sfx('lich_laugh', e.x, e.y, 1); bark(e, 'snail_possessed', 1, true);
    fx('burst', e.x, e.y, 14, 'witchfire', 26); fx('ring', e.x, e.y, 6, 110, 0.6, GREEN_EYE);
    fx('light', e.x, e.y, 20, 160, GREEN_EYE, 2.2, 0.9);
    if (HM.R && HM.R.flash) HM.R.flash(0.2, 1, 0.35, 0.14);
    shakeNear(e.x, e.y, 4);
    return false;
  }
  function possessedBrain(e, dt, p) {
    e.possT += dt; e.engaged = false;
    if (e.possPhase === 'laugh') {
      e.vx = e.vy = 0; if (p) e.faceToward(p.x, p.y, dt, 6);
      if (rnd() < dt * 20) fx('burst', e.x, e.y, 12, 'witchfire', 1);
      if (e.possT >= 1.2) {
        e.possPhase = 'flee'; e.possT = 0; e.invuln = false; e.speed = 74;
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * TAU + rr(-0.3, 0.3); const q = openNear(e.x + Math.cos(a) * 46, e.y + Math.sin(a) * 46, 18);
          const m = Enemies.spawn('thrall', q[0], q[1], { rise: true, act: 5 });
          if (m) { m.home = { x: q[0], y: q[1] }; m.leash = 1200; }
        }
        sfx('bone_break', e.x, e.y, 0.9, 0.7);
      }
      return;
    }
    // flee, leaving witch-green slime, then burrow away
    if (p && !p.dead) {
      const a = M.angle(p.x, p.y, e.x, e.y) + Math.sin(e.t * 1.3) * 0.5;
      e.moveTo(e.x + Math.cos(a) * 80, e.y + Math.sin(a) * 80, e.speed);
    } else e.vx = e.vy = 0;
    if (rnd() < dt * 6) fx('burst', e.x, e.y, 4, 'witchfire', 1);
    if (e.possT > 9) {
      fx('burst', e.x, e.y, 6, 'dust', 16); fx('burst', e.x, e.y, 6, 'witchfire', 14);
      sfx('lich_laugh', e.x, e.y, 0.5, 1.4);
      e.removeMe = true; e.hidden = true; e.team = 2;
    }
  }

  // ==================================================================================================
  // Elites
  // ==================================================================================================
  const ACT_FODDER = ['thrall', 'thrall', 'husk', 'penguin', 'cinder', 'thrall'];
  const AFFIXES = {
    frenzied: { name: 'Frenzied', color: [1, 0.35, 0.25], apply(e) { e.stats.atkSpeed *= 1.3; e.stats.moveMul *= 1.2; e.cdMulV *= 0.75; } },
    burning: {
      name: 'Burning', color: [1, 0.5, 0.12], apply(e) { e.stats.res.fire = Math.max(e.stats.res.fire, 0.5); },
      tick(e, dt) {
        const T = e.affixT; T.burn = (T.burn || 0) - dt;
        if (T.burn <= 0 && e.engaged && Math.hypot(e.vx, e.vy) > 15) { T.burn = 0.42; fireZone(e.x, e.y, 15, 2.6, e, 4 * e.dmgK); }
        if (rnd() < dt * 6) fx('burst', e.x, e.y, e.height * 0.6, 'ember', 1);
      },
    },
    vampiric: { name: 'Vampiric', color: [0.85, 0.12, 0.2], apply(e) { e.stats.leech = 0.4; } },
    frostbound: {
      name: 'Frostbound', color: [0.55, 0.85, 1], apply(e) { e.stats.res.ice = Math.max(e.stats.res.ice, 0.5); },
      onDeath(e) {
        // a chilling (not damaging) nova, so no telegraph needed
        CB().hitCircle(e.x, e.y, 70, e.team, { amount: 0.01, type: 'ice', source: e, noNumber: true, status: { id: 'chill', dur: 2.5 } });
        fx('ring', e.x, e.y, 6, 70, 0.4, [0.6, 0.9, 1]); fx('burst', e.x, e.y, 10, 'ice', 20); iceZone(e.x, e.y, 46, 3, e);
      },
    },
    shielded: {
      name: 'Shielded', color: [0.7, 0.8, 1],
      tick(e, dt) {
        const T = e.affixT; T.sh = (T.sh === undefined ? 1.5 : T.sh) - dt;
        if (T.sh <= 0 && e.engaged) {
          T.sh = 8; CB().applyStatus(e, 'shield', { dur: 5, amount: e.maxHp * 0.25 });
          fx('ring', e.x, e.y, e.radius, e.radius + 26, 0.4, [0.7, 0.8, 1]); sfx('shrine', e.x, e.y, 0.4, 1.4);
        }
      },
    },
    splitting: {
      name: 'Splitting', color: [0.9, 0.6, 1],
      onDeath(e) {
        for (let k = 0; k < 2; k++) {
          const q = openNear(e.x + (k ? 14 : -14), e.y + rr(-8, 8), 14);
          const m = Enemies.spawn(e.def.id, q[0], q[1], { rise: true, fast: true, sizeMul: 0.85, hpMul: 0.45, summoned: true, act: e.act });
          if (m) { m.home = { x: e.home.x, y: e.home.y }; m.xpValue = Math.round(e.xpValue / 8); }
        }
        fx('burst', e.x, e.y, 20, 'shadow', 14);
      },
    },
    blinking: {
      name: 'Blinking', color: [0.6, 0.4, 1],
      tick(e, dt) {
        const T = e.affixT; T.bl = (T.bl === undefined ? rr(2, 4) : T.bl) - dt;
        if (T.bl <= 0 && e.engaged && !e.atk && e.target && !e.target.dead && !e._stunned) { T.bl = rr(4, 6.5); blinkTo(e, e.target, 55, 95, rnd() < 0.5); }
      },
    },
    summoner: {
      name: 'Summoning', color: [0.4, 1, 0.5],
      tick(e, dt) {
        const T = e.affixT; T.su = (T.su === undefined ? 3 : T.su) - dt;
        if (T.su > 0 || !e.engaged || e.atk || (e.summons || 0) >= 4) return;
        T.su = rr(8, 10.5);
        const id = ACT_FODDER[e.act] || 'thrall', pts = [];
        for (let k = 0; k < 2; k++) { const q = openNear(e.x + rr(-50, 50), e.y + rr(-40, 40), 16); pts.push(q); telegraph({ shape: 'circle', x: q[0], y: q[1], r: 15, dur: 0.8, color: TELE.witch }); }
        e.oneShot('cast', 0.8, 'summon'); sfx('lich_laugh', e.x, e.y, 0.3, 1.7);
        G().after(0.8, () => {
          if (e.dead) return;
          for (const q of pts) { const m = Enemies.spawn(id, q[0], q[1], { rise: true, summoned: true, act: e.act }); if (m) { m.summoner = e; e.summons = (e.summons || 0) + 1; } }
        });
      },
    },
  };
  // affixes that make no sense (or are degenerate) on a type
  const ELITE_BAN = { wisp: ['blinking'], wraith: ['blinking'], priest: ['summoner'], bloater: ['blinking', 'shielded', 'splitting'], cinder: ['splitting'] };

  function makeElite(e, rng, nAff, forced) {
    const ban = ELITE_BAN[e.def.id] || [];
    const pool = rng.shuffle(Object.keys(AFFIXES).filter((id) => ban.indexOf(id) < 0 && !(forced && forced.indexOf(id) >= 0)));
    const ids = (forced || []).concat(pool).slice(0, M.clamp(nAff || 1, 1, 3));
    const D = e.def;
    e.isElite = true; e.affixes = ids;
    e.affixNames = ids.map((id) => AFFIXES[id].name);
    // The UI prints the affix line (from e.affixes) above an elite's tag, so the name is the elite's own title;
    // fullName carries the prefixed form for text that has no affix line (epitaphs, logs).
    e.name = e.baseName = D.eliteName || D.name;
    e.fullName = D.id === 'penguin' ? e.name : AFFIXES[ids[0]].name + ' ' + e.name;
    e.title = e.affixNames.join(' · ');
    const c = [0, 0, 0]; for (const id of ids) { const a = AFFIXES[id].color; c[0] += a[0] / ids.length; c[1] += a[1] / ids.length; c[2] += a[2] / ids.length; }
    e.eliteColor = c;
    e.rarityBias = 1;
    for (const id of ids) if (AFFIXES[id].apply) AFFIXES[id].apply(e);
  }

  // ==================================================================================================
  // Population tables
  // ==================================================================================================
  const PACKS = {
    1: [{ w: 3, m: ['thrall', 'thrall', 'archer', 'thrall', 'archer'] }, { w: 2, m: ['hound', 'hound', 'hound', 'hound'] }, { w: 2, m: ['thrall', 'archer', 'archer', 'thrall'] }, { w: 1, m: ['hound', 'thrall', 'hound', 'archer'] }],
    2: [{ w: 3, m: ['husk', 'husk', 'bloater', 'husk', 'husk'] }, { w: 2, m: ['banana', 'banana', 'husk', 'husk'] }, { w: 2, m: ['bloater', 'husk', 'bloater', 'husk'] }, { w: 1, m: ['banana', 'bloater', 'banana', 'husk'] }],
    3: [{ w: 3, m: ['penguin', 'penguin', 'wisp', 'penguin', 'penguin'] }, { w: 2, m: ['golem', 'penguin', 'penguin', 'wisp'] }, { w: 2, m: ['wisp', 'penguin', 'wisp', 'penguin'] }, { w: 1, m: ['golem', 'wisp', 'golem'] }],
    4: [{ w: 3, m: ['cinder', 'cinder', 'elemental', 'cinder', 'cinder'] }, { w: 2, m: ['brute', 'cinder', 'cinder', 'elemental'] }, { w: 2, m: ['elemental', 'cinder', 'elemental', 'cinder'] }, { w: 1, m: ['brute', 'elemental', 'brute'] }],
    5: [{ w: 3, m: ['knight', 'thrall', 'priest', 'thrall', 'thrall'] }, { w: 2, m: ['wraith', 'thrall', 'wraith', 'thrall'] }, { w: 2, m: ['knight', 'priest', 'knight', 'thrall'] }, { w: 1, m: ['wraith', 'priest', 'thrall', 'wraith'] }],
  };
  const ELITE_LEADERS = { 1: ['thrall', 'thrall', 'archer', 'hound'], 2: ['husk', 'banana', 'banana', 'husk'], 3: ['penguin', 'penguin', 'golem', 'wisp'], 4: ['brute', 'brute', 'elemental', 'cinder'], 5: ['knight', 'knight', 'priest', 'wraith'] };
  const MOUND_COLORS = { 0: [0.34, 0.31, 0.25], 1: [0.36, 0.33, 0.26], 2: [0.56, 0.32, 0.42], 3: [0.62, 0.7, 0.86], 4: [0.32, 0.2, 0.15], 5: [0.64, 0.62, 0.52] };
  const STAND_IN = ['thrall', 'banana', 'golem', 'brute', 'knight'];
  const BOSS_NAMES = { boneDragon: 'The Bone Dragon', lemongrab: 'Earl of Lemongrab', iceKing: 'The Ice King', flameKing: 'The Flame King', lich: 'The Lich' };

  // Rig palette overrides. The rig owns each figure's palette (HM.Rig.defs[id].pal); we only tint elites
  // toward their affix colour. With a rig that lacks the def (stub/fallback) we hand over our own colours.
  function rigColors(D, e) {
    const RD = HM.Rig && HM.Rig.defs && HM.Rig.defs[D.rig];
    const src = RD && RD.pal ? RD.pal : D.colors || {};
    if (RD && RD.pal && !e.isElite) return null;
    const out = {}, k0 = e.isElite ? 0.22 : 0, c1 = e.eliteColor || [1, 1, 1];
    for (const k in src) {
      const c = src[k];
      if (!Array.isArray(c) || c.length < 3) continue;
      out[k] = [c[0] * (1 - k0) + c1[0] * k0 * 1.2, c[1] * (1 - k0) + c1[1] * k0 * 1.2, c[2] * (1 - k0) + c1[2] * k0 * 1.2];
    }
    return out;
  }
  function setPal(e, key, rgb) { const r = e.rig; if (!r) return; if (r.pal) r.pal[key] = rgb.slice(); if (r.colors) r.colors[key] = rgb.slice(); }

  function spawnPack(s, rng, act, fi, asc) {
    const elite = s.kind === 'elite';
    let n = M.clamp(s.size || rng.int(3, 5), 3, 6);
    if (asc >= 2) n = Math.min(7, n + 1);
    const tpl = rng.weighted(PACKS[act], (p) => p.w).m;
    const ids = [];
    for (let k = 0; k < n; k++) ids.push(k < tpl.length ? tpl[k] : rng.chance(0.65) ? tpl[0] : rng.pick(tpl));
    const pack = new Pack(s.x, s.y, act);
    pack.trigR = 190 + n * 14;
    const dormantPack = rng.chance(elite ? 0.5 : 0.7);
    if (elite) {
      const lid = s.id && DEFS[s.id] ? s.id : rng.pick(ELITE_LEADERS[act]);
      const L = Enemies.spawn(lid, s.x, s.y, { elite: true, affixCount: (fi >= 7 ? 2 : 1) + (asc >= 3 ? 1 : 0), rng, floorIndex: fi, ascension: asc, act });
      pack.add(L); pack.leader = L; ids.pop();
    }
    const n2 = ids.length;
    for (let k = 0; k < n2; k++) {
      const id = ids[k];
      const ang = (k / n2) * TAU + rng.range(-0.4, 0.4), r = rng.range(26, 34 + n2 * 7);
      const q = openNear(s.x + Math.cos(ang) * r, s.y + Math.sin(ang) * r * 0.8, 20, rng);
      const m = Enemies.spawn(id, q[0], q[1], { dormant: dormantPack && !!DEFS[id].rises, floorIndex: fi, ascension: asc, act, rng });
      pack.add(m);
    }
    return pack;
  }
  function spawnSnail(x, y, act, fi, asc) {
    const e = Enemies.spawn('snail', x, y, { floorIndex: fi, ascension: asc, act });
    if (act >= 4) {
      e.greenEyes = true; e.lightOverride = [26, 0.35, 1, 0.45, 0.3];
      if (e.rig) e.rig.greenEyes = true;
      setPal(e, 'eye', GREEN_EYE);
    }
    return e;
  }
  function spawnBoss(s, floor, act, fi, asc) {
    const id = s.id || floor.bossId, g = G();
    let b = null;
    if (HM.Bosses && typeof HM.Bosses.spawn === 'function') b = HM.Bosses.spawn(id, s.x, s.y, floor);
    if (b) { if (g && g.entities.indexOf(b) < 0) g.spawn(b); return b; }
    // HM.Bosses missing: a grand elite stands in so the floor can still be finished
    const e = Enemies.spawn(STAND_IN[act - 1] || 'knight', s.x, s.y, { elite: true, affixCount: 2, sizeMul: 1.45, hpMul: 3.2, dmgMul: 1.15, floorIndex: fi, ascension: asc, act });
    const intro = HM.Lore && HM.Lore.bossIntro ? HM.Lore.bossIntro(id) : null;
    e.isElite = false; e.isBoss = true; e.kind = 'boss'; e.defId = id || e.defId;
    e.name = e.baseName = e.displayName = (intro && intro.name && intro.name !== id ? intro.name : BOSS_NAMES[id]) || 'The Nameless';
    e.title = (intro && intro.title) || ''; e.phase = 1; e.phaseCount = 1;
    e.aggro = 800; e.leash = 1e9; e.xpValue *= 2;
    return e;
  }

  // ==================================================================================================
  // Public API
  // ==================================================================================================
  const Enemies = (HM.Enemies = {
    Enemy, Pack, AI, Tokens, defs: DEFS, AFFIXES, PACKS, ELITE_LEADERS, BARKS, TELE,
    builders: { swing, slam, lunge, shoot, lob, blink }, zones: { fire: fireZone, rot: rotZone, ice: iceZone },

    // hp/dmg/speed/xp/gold multipliers for a def on a floor (+ ascension).
    scale(def, floorIndex, ascension) {
      const f = Math.max(1, floorIndex || 1), a = Math.max(0, ascension || 0);
      return {
        hp: (1 + 0.22 * (f - 1)) * (1 + 0.12 * a), dmg: (1 + 0.15 * (f - 1)) * (1 + 0.08 * a), speed: 1 + Math.min(0.15, 0.03 * a),
        xp: 1 + 0.12 * (f - 1), gold: 1 + 0.1 * (f - 1), level: f + Math.floor(a / 2),
      };
    },

    // opts: {elite, affixCount, affixes[], rng, floorIndex, ascension, act, dormant, rise, fast, summoned, title, facing,
    //        sizeMul, hpMul, dmgMul, add:false (don't push into Game.entities)}
    spawn(defId, x, y, opts) {
      opts = opts || {};
      const D = DEFS[defId] || DEFS.thrall;
      const g = G(), run = g && g.run;
      const fi = opts.floorIndex || (run && run.floorIndex) || 1;
      const asc = opts.ascension !== undefined ? opts.ascension : (run && run.ascension) || 0;
      const S = Enemies.scale(D, fi, asc);
      const elite = !!opts.elite;
      const size = (D.scale || 1) * (elite ? 1.28 : 1) * (opts.sizeMul || 1);
      const e = new Enemy({ defId: D.id, kind: 'enemy', team: 1, name: D.name, x, y });
      e.def = D; e.sc = size; e.act = opts.act || (g && g.floor && g.floor.act) || D.act || 1;
      e.initAI();
      e.maxHp = e.hp = Math.max(1, Math.round(D.hp * S.hp * (elite ? 2.5 : 1) * (opts.hpMul || 1)));
      e.dmgK = S.dmg * (elite ? 1.3 : 1) * (opts.dmgMul || 1);
      e.dmg = D.dmg * e.dmgK;
      e.speed = D.speed * S.speed;
      e.radius = D.radius * Math.sqrt(size); e.height = D.height * size; e.mass = (D.mass || 1) * size;
      e.xpValue = Math.round(D.xp * S.xp * (elite ? 4 : 1) * (opts.summoned ? 0.25 : 1));
      const gm = S.gold * (elite ? 3 : 1);
      e.goldDrop = opts.summoned ? [0, 0] : [Math.round(D.gold[0] * gm), Math.round(D.gold[1] * gm)];
      e.level = S.level + (elite ? 2 : 0);
      e.aggro = (D.aggro || 250) * (elite ? 1.15 : 1); e.leash = D.leash || (elite ? 900 : 760);
      e.stats.armor = D.armor || 0; if (D.res) Object.assign(e.stats.res, D.res);
      e.stats.critChance = 0.04;
      e.ghost = !!D.ghost; e.hover = D.hover || 0; e.z = e.hover;
      e.summoned = !!opts.summoned; e.baseName = D.name; e.neutral = !!D.neutral;
      e.moundColor = MOUND_COLORS[e.act] || MOUND_COLORS[0];
      let reach = 0; for (const a of D.attacks) if (!a.ranged && a.reach) reach = Math.max(reach, a.reach * size); e._reach = reach || 30;
      if (elite) makeElite(e, opts.rng || HM.rng, opts.affixCount || 1, opts.affixes);
      // rig
      const ropts = {}; const cols = rigColors(D, e); if (cols) ropts.colors = cols;
      if (size !== 1) ropts.scale = size;
      if (D.weapon) ropts.weapon = Object.assign({}, D.weapon);
      e.weapon = D.weapon ? Object.assign({}, D.weapon) : { kind: 'none' };
      if (HM.Rig && HM.Rig.create) HM.Rig.create(e, D.rig, ropts);
      if (e.rig) { e.rig.swell = 0; if (D.shield) e.rig.shield = true; if (e.isElite) e.rig.elite = true; }
      // initial state
      if (opts.title) { e.titleMode = true; e.team = 2; e.name = ''; e.guardFacing = opts.facing; e.facing = opts.facing !== undefined ? opts.facing : rr(0, TAU); }
      else if (opts.dormant) { e.state = 'dormant'; e.team = 2; e.hidden = true; e.name = ''; e.noCollide = true; e.facing = rr(0, TAU); }
      else if (opts.rise) { e.facing = rr(0, TAU); e.rise(!!opts.fast); }
      else e.facing = rr(0, TAU);
      e.aim = e.facing; e.moveFace = e.facing;
      if (D.init) D.init(e, opts);
      if (opts.add !== false && g && g.spawn) g.spawn(e);
      return e;
    },

    // Fill a floor from floor.spawns: packs (some lie dormant and rise as you near), the elite pack,
    // the Waving Snail (placed by us if the world didn't), and the boss (handed to HM.Bosses).
    populate(floor, run) {
      Tokens.reset();
      const fi = (run && run.floorIndex) || floor.index || 1;
      const asc = (run && run.ascension) || 0;
      const act = M.clamp(floor.act || Math.ceil(fi / 3), 1, 5);
      const rng = new HM.RNG((((floor.seed || 1) >>> 0) ^ 0x51ed27) >>> 0);
      let snail = false;
      for (const s of floor.spawns || []) {
        if (s.kind === 'boss') spawnBoss(s, floor, act, fi, asc);
        else if (s.kind === 'snail') { spawnSnail(s.x, s.y, act, fi, asc); snail = true; }
        else spawnPack(s, rng, act, fi, asc);
      }
      if (!snail && !floor.isBoss && HM.World && HM.World.randomOpenPoint && floor.start) {
        const p = HM.World.randomOpenPoint(rng, floor, floor.start.x, floor.start.y, 260, 1100);
        if (p) spawnSnail(p[0], p[1], act, fi, asc);
      }
    },

    // Idle cast for the title backdrop: a few thralls standing guard, and the snail, waving at you.
    titleDressing(floor) {
      Tokens.reset();
      if (!floor || !floor.start) return;
      const sx = floor.start.x, sy = floor.start.y, rng = new HM.RNG(9001);
      const spots = [[-230, -40, 0.5], [-175, 34, 0.2], [-290, 70, 0.9], [205, -60, -0.4], [262, 22, -0.2], [430, -30, -0.6], [600, 50, -0.3]];
      for (const [dx, dy, f] of spots) {
        const q = openNear(sx + dx, sy + dy, 30, rng);
        Enemies.spawn(rng.chance(0.25) ? 'archer' : 'thrall', q[0], q[1], { title: true, floorIndex: 1, act: 1, facing: Math.PI / 2 + f });
      }
      const q = openNear(sx + 120, sy + 120, 30, rng);
      Enemies.spawn('snail', q[0], q[1], { title: true, floorIndex: 1, act: 1, facing: Math.PI / 2 + 0.5 });
    },
  });
  Enemies.spawnPack = spawnPack; Enemies.spawnSnail = spawnSnail; Enemies.makeElite = makeElite;
})();
