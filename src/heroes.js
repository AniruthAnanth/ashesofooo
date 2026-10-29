// heroes.js — the three playable heroes (Finn, Marceline, Flame Princess) and the player controller.
//
// The controller IS the game feel (DESIGN §3, after Dotsenko's "Designing Game Controls"):
//   * ADSR movement: ~70 ms to full speed, ~90 ms to stop, fast reversals. Facing follows movement unless acting.
//   * Every verb goes through Input.consume (150 ms buffer): a press made during a locked animation fires on the
//     first legal frame. Every verb starts its pose on the very next frame.
//   * Actions are anticipation → strike → recovery (rig convention: damage at ≈35% of dur). Recovery is cancellable
//     by dodge and by skills; light attacks chain inside a combo window and lunge a little; aim tracks the mouse
//     through the anticipation, then a weak melee aim assist (≤0.26 rad) bends the swing.
//   * Dodge: 0.32 s ease-out roll, i-frames 0.05–0.26 s, charges + recharge, afterimages.
//   * Feedback for every verb: rig pose, weapon trail (material / element colored), particles, light, sound.
// Kits, passives and the shared boon/heirloom flags (player.mods[flag] = level) are implemented here.
(function () {
  'use strict';
  const Math = globalThis.Math; // lexical alias: hot loops skip the global-object lookup (big win in the Node smoke VM)
  const HM = (globalThis.window || globalThis).HM;
  const M = HM.M, Input = HM.Input, C = HM.Combat;
  const TAU = Math.PI * 2;

  // ------------------------------------------------------------------ safe calls into sibling modules
  const warned = new Set();
  function call(mod, fn, args) {
    const m = HM[mod], f = m && m[fn];
    if (typeof f !== 'function') return undefined;
    try { return f.apply(m, args); } catch (e) {
      const k = mod + '.' + fn;
      if (!warned.has(k)) { warned.add(k); console.error('[heroes] ' + k + ' threw:', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e); }
      return undefined;
    }
  }
  const fx = (fn, ...a) => call('FX', fn, a);
  const sfx = (name, x, y, vol, pitch) => call('Audio', 'play', [name, { x, y, vol, pitch }]);
  const bark = (actor, text, dur) => call('UI', 'bark', [actor, text, dur || 1.6]);
  const rnd = (a, b) => a + (b - a) * HM.rng.next();
  function setAnim(a, state, o) {
    if (HM.Rig && typeof HM.Rig.setAnim === 'function') { call('Rig', 'setAnim', [a, state, o]); return; }
    a.anim.state = state; a.anim.t = 0; a.anim.dur = (o && o.dur) || 0.3; a.anim.variant = o && o.variant;
  }
  const realRig = (a) => !!(a && a.rig && typeof a.rig === 'object' && a.rig.def); // full HM.Rig (not the stub)
  function joint(a, name, fb) {
    if (realRig(a) && HM.Rig.joint) { const j = call('Rig', 'joint', [a, name]); if (j && isFinite(j[0])) return j; }
    return fb;
  }
  const solid = (x, y) => !!(HM.World && HM.World.isSolid && HM.World.isSolid(x, y));
  // Effect heights follow the figure (HM.cfg.FIG_SCALE makes bodies taller): a fraction of the actor's height above its
  // feet, or a real rig joint — never hard-coded z values.
  const bodyZ = (a, k) => (a.z || 0) + (a.height || 60) * k;
  const jointZ = (a, name, k) => { const j = joint(a, name, null); return j && isFinite(j[2]) ? j[2] : bodyZ(a, k); };
  const game = () => HM.Game || {};
  const GI = {};
  const gi = (ch) => (GI[ch] !== undefined ? GI[ch] : (GI[ch] = HM.R ? HM.R.gi(ch) : 0));
  const atkSpeed = (p) => M.clamp(p.stats.atkSpeed || 1, 0.5, 2.5);
  const castSpeed = (p) => M.clamp(p.stats.castSpeed || 1, 0.5, 2.5);
  const AIM_Z = 18;          // the cursor is read on a plane at chest height, so clicking a body hits the body
  const DODGE_T = 0.32, DODGE_DIST = 112, DODGE_RECHARGE = 0.75;

  const COL = {
    fire: [1, 0.5, 0.14], fireHot: [1, 0.86, 0.5], ember: [0.85, 0.28, 0.06],
    grass: [0.24, 0.6, 0.22], grassTip: [0.58, 0.95, 0.42], grassDark: [0.1, 0.3, 0.12],
    blood: [0.9, 0.08, 0.16], bloodHot: [1, 0.35, 0.35], shadow: [0.42, 0.2, 0.58], batBody: [0.3, 0.12, 0.3],
    sonic: [0.82, 0.72, 1], jake: [0.96, 0.66, 0.22], jakeDark: [0.7, 0.42, 0.12], dust: [0.62, 0.6, 0.54],
    holy: [1, 0.92, 0.6], deny: [0.62, 0.64, 0.7], gold: [1, 0.85, 0.35],
  };
  // HDR tints for FX rings/lights/trails (FX's own palette runs ~2x hot)
  const HOT = {
    fire: [1.9, 0.8, 0.22], dust: [1.15, 1.08, 0.95], grass: [0.6, 1.7, 0.5], blood: [1.7, 0.16, 0.26], shadow: [1.1, 0.35, 1.5],
    holy: [2.2, 2.0, 1.3], gold: [2.1, 1.6, 0.55], jake: [1.9, 1.3, 0.45], sonic: [1.4, 1.2, 2.1], queen: [1.6, 0.1, 0.3],
  };

  // Weapon materials (fallback when Items.MATERIALS is not there yet) — glyphs + color tint the swing trail.
  const MAT_FALLBACK = {
    iron: { glyphs: '#%:', color: [0.62, 0.64, 0.7] }, steel: { glyphs: '@%.', color: [0.8, 0.84, 0.92] },
    bronze: { glyphs: '&o,', color: [0.8, 0.55, 0.3] }, silver: { glyphs: '$s.', color: [0.88, 0.9, 0.96] },
    gold: { glyphs: '0o.', color: [1, 0.82, 0.35] }, moonsteel: { glyphs: 'O*.', color: [0.7, 0.85, 1], emissive: 0.4 },
    nightglass: { glyphs: "N/'", color: [0.45, 0.4, 0.75], emissive: 0.3 }, bloodiron: { glyphs: 'B8:', color: [0.75, 0.18, 0.18] },
    ossite: { glyphs: '=-.', color: [0.9, 0.87, 0.78] }, emberstone: { glyphs: '*+.', color: [1, 0.5, 0.18], emissive: 0.8 },
    grass: { glyphs: '"|;', color: [0.35, 0.85, 0.35], emissive: 0.3 }, demonblood: { glyphs: '%&;', color: [0.85, 0.1, 0.22], emissive: 0.35 },
    crystal: { glyphs: '<>^', color: [0.45, 0.95, 1], emissive: 0.5 }, candy: { glyphs: '@o*', color: [1, 0.55, 0.8] },
    glacial: { glyphs: "*+'", color: [0.65, 0.88, 1], emissive: 0.4 },
  };
  function material(id) {
    const T = HM.Items && HM.Items.MATERIALS;
    return (T && T[id]) || MAT_FALLBACK[id] || MAT_FALLBACK.iron;
  }

  // ==================================================================================================
  // Hero definitions (UI reads `list`; the controller reads `defs`)
  // ==================================================================================================
  const HEROES = {
    finn: {
      id: 'finn', name: 'Finn', title: 'the Last Human', rig: 'finn', difficulty: 1, color: [0.55, 0.78, 1],
      blurb: 'The last human in Ooo still answers the dark with a sword. He is braver than he is wise, and the Grass-curse coiled in his arm grows hungrier with every swing.',
      base: { hp: 135, hpLv: 12, mp: 60, mpLv: 2, speed: 120, armor: 12, crit: 0.06, mpRegen: 4.5, regen: 0 },
      dmg: [8, 12], weapon: { kind: 'sword', material: 'iron' }, height: 58,
      resource: { name: 'MP', color: [0.3, 0.55, 1] },
      passive: { name: "Hero's Heart", desc: 'Every kill restores 2 HP. He has never once walked away.' },
      skills: [
        { slot: 'attack', name: 'Sword Combo', icon: '/', cd: 0, cost: 0, desc: 'Two quick cuts and a thrust that hurls foes back. Hold to keep swinging.' },
        { slot: 'heavy', name: 'Heavy Cleave', icon: ')', cd: 2.2, cost: 0, desc: 'A wide 180° cleave with brutal knockback. Hold to charge it.' },
        { slot: 'skill1', name: 'Grass Vines', icon: '"', cd: 7, cost: 18, desc: 'The Grass-curse answers: vines burst along a line, rooting for 1s and making foes bleed.' },
        { slot: 'skill2', name: 'Leap Slam', icon: '^', cd: 6, cost: 14, desc: 'Leap to the cursor, untouchable in the air. The landing knocks everything flat.' },
        { slot: 'ult', name: 'JAKE!', icon: '&', cd: 30, cost: 40, desc: 'Your brother comes running: a giant fist from the sky, then a stretchy whirlwind.' },
      ],
      portrait: [' /\\_/\\ ', '( o.o )', ' \\_-_/ ', ' /|#|\\ ', '  / \\  '],
    },
    marceline: {
      id: 'marceline', name: 'Marceline', title: 'the Vampire Queen', rig: 'marceline', difficulty: 2, color: [0.85, 0.25, 0.4],
      blurb: 'A thousand years old and tired of most of them. Marceline drifts through the ruin with an axe that is also a bass, drinking the red out of anything foolish enough to get close.',
      base: { hp: 120, hpLv: 10, mp: 80, mpLv: 3, speed: 112, armor: 6, crit: 0.05, mpRegen: 4, regen: 0, leech: 0.04 },
      dmg: [10, 15], weapon: { kind: 'bass', material: 'demonblood' }, height: 62, floats: true,
      resource: { name: 'MP', color: [0.75, 0.2, 0.38] },
      passive: { name: 'Old Blood', desc: '4% lifesteal. She floats: ground hazards deal 50% less damage.' },
      skills: [
        { slot: 'attack', name: 'Axe-Bass Sweep', icon: '%', cd: 0, cost: 0, desc: 'Two wide, heavy arcs of the axe-bass.' },
        { slot: 'heavy', name: 'Sonic Chord', icon: '}', cd: 3, cost: 12, desc: 'One distorted chord: a cone of sound that hurls foes back, weakens them and shatters missiles.' },
        { slot: 'skill1', name: 'Drain', icon: '~', cd: 5, cost: 10, cdOnEnd: true, desc: 'Channel a red beam into the foe nearest your cursor, healing yourself. Costs 5 MP/s. Press again to stop.' },
        { slot: 'skill2', name: 'Bat Swarm', icon: 'v', cd: 5, cost: 16, desc: 'Come apart into bats and tear through a line of foes, untouchable.' },
        { slot: 'ult', name: 'Shadow Queen', icon: 'M', cd: 32, cost: 45, desc: 'For 6s: grow huge, +40% damage, 25% lifesteal. The living flee from you.' },
      ],
      portrait: [' _/^\\_ ', '/(o o)\\', '|| v ||', '|/|#|\\|', '  / \\  '],
    },
    fp: {
      id: 'fp', name: 'Flame Princess', title: 'of the Fire Kingdom', rig: 'fp', difficulty: 3, color: [1, 0.5, 0.15],
      blurb: 'Fire that learned to think. Her temper is a weapon and a wound. Every spell stokes it; push it to the brink and she burns brighter than her own body can bear.',
      base: { hp: 100, hpLv: 9, mp: 0, mpLv: 0, speed: 116, armor: 4, crit: 0.07, mpRegen: 0, regen: 0, fireRes: 0.5 },
      dmg: [7, 10], weapon: { kind: 'wand', material: 'emberstone' }, height: 56, temper: true,
      resource: { name: 'Temper', color: [1, 0.45, 0.1] },
      passive: { name: 'Elemental Temper', desc: 'Skills raise Temper; it cools when idle. At 100 she becomes Wildfire: no cooldowns, but she burns. 50% fire resist; burning foes take +15% damage from her.' },
      skills: [
        { slot: 'attack', name: 'Flame Bolt', icon: '*', cd: 0, cost: 1, desc: 'Fast bolts of fire. Every third bolt splits into three.' },
        { slot: 'heavy', name: 'Fireball Volley', icon: 'o', cd: 2.6, cost: 14, desc: 'Three fireballs in a fan. Each bursts on impact and sets the ground alight.' },
        { slot: 'skill1', name: 'Fire Fissure', icon: 'Y', cd: 6.5, cost: 22, desc: 'Split the earth in a three-pronged crack that erupts into columns of flame.' },
        { slot: 'skill2', name: 'Flame Ring', icon: 'O', cd: 10, cost: 18, desc: 'A ring of fire orbits you for 6s, burning all within. Roll inside it to become Kindled: your attacks burn hotter.' },
        { slot: 'ult', name: 'Cinder Rain', icon: '@', cd: 26, cost: 30, desc: 'Call burning stones down around the cursor. Each one leaves the ground on fire.' },
      ],
      portrait: [' ,^^^, ', '(^o o^)', ' \\ ~ / ', ' /|*|\\ ', '  / \\  '],
    },
  };
  for (const id in HEROES) for (const s of HEROES[id].skills) s.action = s.slot;

  // ==================================================================================================
  // Player
  // ==================================================================================================
  class Player extends HM.Actor {
    constructor(heroId, run) {
      const def = HEROES[heroId] || HEROES.finn;
      super({ kind: 'player', team: 0, defId: def.id, name: def.name, radius: 8, mass: 1.6, height: def.height || 60, speed: def.base.speed, hp: def.base.hp, maxHp: def.base.hp, mp: def.base.mp, maxMp: def.base.mp });
      this.heroId = def.id; this.def = def; this.title = def.title; this.run = run || null;
      this.kit = KITS[def.id];
      this.mods = {};
      this.mvx = 0; this.mvy = 0;                 // ADSR-smoothed move vector (0..1)
      this.act = null;                            // current action (see _act)
      this.combo = 0; this.comboWindow = 0;
      this.dodgeMax = 1; this.dodgeCharges = 1; this.dodgeRecharge = 0;
      this.potionCd = 0; this.denyT = 0; this.heartT = 0;
      this.aimX = 0; this.aimY = 0; this.hover = null; this._padAim = false; this._msx = -1; this._msy = -1;
      this.skills = def.skills.map((s) => Object.assign({}, s, { baseCd: s.cd, cdLeft: 0, costType: def.temper ? 'temper' : (s.cost ? 'mp' : 'none') }));
      this.resource = { name: def.resource.name, value: def.base.mp, max: def.base.mp, color: def.resource.color.slice() };
      this.passive = def.passive;
      this.fxl = [];                              // player-attached effects: {update(dt)->alive, draw()}
      this.rigHidden = false; this.sizeMul = 1; this.floats = !!def.floats;
      // hero state
      this.temper = 0; this.temperIdle = 0; this.wildfireT = 0; this.wildfireDur = 0; this.boltCount = 0; this.ring = null;
      this.queenT = 0; this.queenTick = 0; this.jake = null;
      this._sx = 0; this._sy = 0; this._emberT = 0; this._wasStunned = false; this._actEndT = -9;
    }

    get wildfire() { return this.wildfireT > 0; }

    // Damage base for every skill: a weapon roll plus a little per level.
    power() {
      const w = this.weaponDmg !== undefined ? this.weaponDmg : (this.weapon && this.weapon.dmg) || this.def.dmg;
      let v;
      if (Array.isArray(w)) v = w[0] + (w[1] - w[0]) * HM.rng.next();
      else if (typeof w === 'number') v = w;
      else if (w && typeof w.min === 'number') v = w.min + ((w.max || w.min) - w.min) * HM.rng.next();
      else v = this.def.dmg[0] + (this.def.dmg[1] - this.def.dmg[0]) * HM.rng.next();
      const lvl = (this.run && this.run.level) || 1;
      return Math.max(1, v + (lvl - 1) * 0.8 + (this.stats.power || 0));
    }
    get kindled() { return !!this.hasStatus('kindled'); }
    _element() { const w = this.weapon; const e = w && w.element; return e && e !== 'phys' ? e : null; }

    // Melee damage spec (rune adds/procs are applied by Items' damage hook; kindled adds a burn here).
    _meleeSpec(mul, o) {
      const pw = this.power();
      const s = Object.assign({ amount: pw * mul, type: 'phys', source: this, knock: 0 }, o || {});
      if (this.kindled || this.wildfire) s.status = (s.status ? [].concat(s.status) : []).concat([{ id: 'burn', dur: 3, dps: pw * 0.35 }]);
      return s;
    }
    // Fire spell spec (Flame Princess).
    _fireSpec(mul, o) {
      const pw = this.power();
      const s = Object.assign({ amount: pw * mul, type: 'fire', source: this, knock: 0 }, o || {});
      const burn = { id: 'burn', dur: 3, dps: pw * (this.kindled ? 0.45 : 0.22) };
      s.status = s.status ? [].concat(s.status, burn) : [burn];
      return s;
    }
    // Weapon trail style: material glyphs/colors, tinted by element, burning when kindled.
    _trail() {
      const w = this.weapon || {}; const m = material(w.material);
      let color = (w.trail || w.color || m.color || [0.85, 0.88, 0.95]).slice(), glyphs = w.glyphs || m.glyphs || '-~=';
      const me = w.emissive !== undefined ? w.emissive : m.emissive || 0;
      let emissive = 0.22 + me * 0.5, k = 0.85;
      const el = this._element();
      if (this.kindled || this.wildfire) { color = [1.9, 0.75, 0.2]; glyphs = "*+'"; emissive = 0.7; k = 1; }
      else if (el) { emissive = Math.max(emissive, 0.55); k = 1; }
      return { color: [color[0] * k, color[1] * k, color[2] * k], glyphs, emissive };
    }
    // Crescent weapon trail (FX.swing): r0..r1 is the radial band the blade sweeps.
    _swing(a0, a1, r1, o) {
      o = o || {}; const st = this._trail();
      fx('swing', { actor: this, x: this.x, y: this.y, z: (o.z !== undefined ? o.z : Math.round((this.height || 82) * 0.32)) + this.z, a0, a1, r0: o.r0 !== undefined ? o.r0 : r1 - 12, r1, dur: o.dur || 0.07, life: o.life || 0.17, color: o.color || st.color, glyphs: o.glyphs || st.glyphs, emissive: o.emissive !== undefined ? o.emissive : st.emissive });
    }
    _assist(ang, range) {
      if (HM.Save && HM.Save.setting && HM.Save.setting('aimAssist', true) === false) return ang;
      return C.assistAim(this.x, this.y, ang, range + 12, this.team, 0.26);
    }
    _deny(reason) {
      if (this.denyT > 0) return;
      this.denyT = 0.35;
      const txt = { mana: 'no mana', target: 'no target', potion: 'none left', full: 'already full' }[reason] || 'not ready';
      fx('text', this.x, this.y, this.height + 18, txt, COL.deny, 0.75);
      sfx('ui_error', this.x, this.y, 0.35);
    }

    // -------------------------------------------------------------- frame
    update(dt) {
      if (this.dead) { if (this.act) { this.act = null; } this.rigHidden = false; C.baseUpdate(this, dt); return; }
      this._tick(dt);
      this._aimUpdate();
      this._moveUpdate(dt);
      if (this._stunned) this._stunUpdate();
      else if (this._wasStunned) { this._wasStunned = false; if (!this.act) setAnim(this, 'idle'); }
      if (this.act) this._actUpdate(dt);
      if (!this._stunned) this._verbs();
      if (this.kit.update) this.kit.update(this, dt);
      this._fxUpdate(dt);
      if (this.anim.state === 'hit' && this.anim.t >= (this.anim.dur || 0.16) && !this.act) setAnim(this, 'idle');
      C.baseUpdate(this, dt);
      this._steps();
    }

    _tick(dt) {
      for (const s of this.skills) if (s.cdLeft > 0) s.cdLeft = Math.max(0, s.cdLeft - dt);
      this.potionCd = Math.max(0, this.potionCd - dt);
      this.denyT = Math.max(0, this.denyT - dt);
      this.comboWindow = Math.max(0, this.comboWindow - dt);
      if (this.dodgeCharges < this.dodgeMax) {
        this.dodgeRecharge -= dt;
        if (this.dodgeRecharge <= 0) { this.dodgeCharges++; this.dodgeRecharge = this.dodgeCharges < this.dodgeMax ? DODGE_RECHARGE : 0; }
      }
      this.dodgeCd01 = this.dodgeCharges >= this.dodgeMax ? 0 : M.clamp(this.dodgeRecharge / DODGE_RECHARGE, 0, 1);
      // resource mirror for the HUD
      if (!this.def.temper) { this.resource.value = this.mp; this.resource.max = this.maxMp; }
      // (the low-HP heartbeat is scheduled by HM.Audio.tick — one source, so beats never double up)
    }

    _aimUpdate() {
      const G = Input.gamepad, ms = Input.mouse;
      if (ms.sx !== this._msx || ms.sy !== this._msy) { this._msx = ms.sx; this._msy = ms.sy; this._padAim = false; }
      if (G && G.connected && Math.hypot(G.ax, G.ay) > 0.3) {
        this._padAim = true; this.hover = null; this.aim = Math.atan2(G.ay, G.ax);
        const r = 70 + 110 * Math.min(1, Math.hypot(G.ax, G.ay));
        this.aimX = this.x + Math.cos(this.aim) * r; this.aimY = this.y + Math.sin(this.aim) * r; return;
      }
      if (this._padAim) { this.aimX = this.x + Math.cos(this.aim) * 120; this.aimY = this.y + Math.sin(this.aim) * 120; return; }
      if (HM.R && HM.R.screenToWorld) {
        const w = HM.R.screenToWorld(ms.sx, ms.sy), TILT = HM.cfg.TILT;
        // cursor over a foe's body → aim exactly at that foe; otherwise read the cursor on a chest-height plane
        const px = w[0], py = w[1] * TILT;
        let hov = null, best = 1e9;
        for (const e of C.actors()) {
          if (!C.hostile(e, this.team)) continue;
          const ex = e.x, ey = e.y * TILT, h = e.height || 50, rx = (e.radius || 8) + 5;
          if (Math.abs(px - ex) > rx || py > ey + 5 || py < ey - h) continue;
          const d = Math.abs(px - ex) + Math.abs(py - (ey - h * 0.45)) * 0.4;
          if (d < best) { best = d; hov = e; }
        }
        this.hover = hov;
        if (hov) { this.aimX = hov.x; this.aimY = hov.y; } else { this.aimX = w[0]; this.aimY = w[1] + AIM_Z / TILT; }
        if (Math.abs(this.aimX - this.x) + Math.abs(this.aimY - this.y) > 0.5) this.aim = M.angle(this.x, this.y, this.aimX, this.aimY);
      }
    }
    aimDist(max, min) { return M.clamp(M.dist(this.x, this.y, this.aimX, this.aimY), min || 0, max); }

    // ADSR movement (attack ≈70 ms, release ≈90 ms, quick reversals), scaled by the current action's move lock.
    _moveUpdate(dt) {
      let mv = Input.moveVec(); let ix = mv[0], iy = mv[1];
      const l = Math.hypot(ix, iy); if (l > 1) { ix /= l; iy /= l; }
      const a = this.act;
      let mm = 1;
      if (a) mm = a.t < a.cancelAt ? a.move[0] : a.move[1];
      const tx = ix * mm, ty = iy * mm;
      const dx = tx - this.mvx, dy = ty - this.mvy, d = Math.hypot(dx, dy);
      if (d > 1e-5) {
        const pushing = l > 0.05;
        const reverse = pushing && this.mvx * tx + this.mvy * ty < 0;
        const rate = !pushing ? 1 / 0.09 : reverse ? 1 / 0.05 : 1 / 0.07;
        const step = rate * dt;
        if (d <= step) { this.mvx = tx; this.mvy = ty; } else { this.mvx += (dx / d) * step; this.mvy += (dy / d) * step; }
      }
      this.vx = this.mvx * this.speed; this.vy = this.mvy * this.speed;
      // facing follows movement when not acting
      if (!a && Math.hypot(this.mvx, this.mvy) > 0.08) {
        const want = Math.atan2(this.mvy, this.mvx);
        this.facing += M.clamp(M.angleDiff(this.facing, want), -16 * dt, 16 * dt);
      }
    }

    _stunUpdate() {
      if (!this._wasStunned) {
        this._wasStunned = true;
        if (this.act && this.act.kind !== 'dodge' && this.act.lockUntil === undefined) this._endAct(true, true);
        if (!this.act) setAnim(this, 'stun', { dur: 1 });
      }
      this.mvx *= 0.5; this.mvy *= 0.5;
    }

    // -------------------------------------------------------------- actions
    // o: {kind:'attack'|'heavy'|'skill'|'channel'|'dodge', slot, dur, cancelAt, chainAt, lockUntil, ang,
    //     move:[duringLock, recovery], anim:[state, variant], events:[[t, fn(a)]], iframes:[t0, t1],
    //     update(a, dt), end(a, cancelled), toggle, noHoldCancel}
    _act(o) {
      if (this.act) this._endAct(true, true);
      const a = Object.assign({ t: 0, ei: 0, cancelAt: o.dur, chainAt: o.dur, move: [0.25, 0.6] }, o);
      if (a.events) a.events.sort((p, q) => p[0] - q[0]);
      this.act = a; this._actT0 = Input.now;
      if (a.ang !== undefined) this.facing = a.ang;
      if (a.anim) setAnim(this, a.anim[0], { dur: a.animDur || a.dur, variant: a.anim[1] });
      if (a.kind !== 'attack') this.comboWindow = 0;
      if (a.iframes && a.iframes[0] <= 0) { a._if = true; this.iframeT = Math.max(this.iframeT, a.iframes[1]); }
      return a;
    }
    _actUpdate(dt) {
      const a = this.act;
      a.t += dt;
      if (a.update) a.update(a, dt);
      if (this.act !== a) return;
      while (a.events && a.ei < a.events.length && a.t >= a.events[a.ei][0]) { const ev = a.events[a.ei++]; ev[1](a); if (this.act !== a) return; }
      if (a.iframes && !a._if && a.t >= a.iframes[0]) { a._if = true; this.iframeT = Math.max(this.iframeT, a.iframes[1] - a.iframes[0]); }
      if (a.ang !== undefined) this.facing = a.ang;
      if (a.t >= a.dur) this._endAct(false);
    }
    _endAct(cancelled, replaced) {
      const a = this.act; if (!a) return;
      this.act = null; this._actEndT = Input.now;
      if (a.end) a.end(a, cancelled);
      if (a.kind === 'attack') this.comboWindow = 0.42;
      if (!replaced && !this.dead) setAnim(this, 'idle');
    }
    // Is `verb` legal right now? (the input buffer holds the press until it is)
    _can(verb) {
      if (this._stunned) return false;
      const a = this.act; if (!a) return true;
      if (a.lockUntil !== undefined && a.t < a.lockUntil) return false;
      if (a.kind === 'dodge') return verb === 'dodge' ? a.t >= a.dur * 0.6 : a.t >= a.dur * 0.75;
      if (verb === 'dodge') return a.t >= a.cancelAt || !!a.charging; // a held charge can always be rolled out of
      if (verb === 'attack') return a.kind === 'attack' ? a.t >= a.chainAt : a.t >= a.cancelAt;
      return a.t >= a.cancelAt;
    }

    // Buffer window: 150 ms normally; a press made while an action is locked stays queued until that action
    // allows it (≤0.4 s), so e.g. an attack tapped early in a roll still fires the moment the roll can be cancelled.
    _win() {
      const B = HM.cfg.BUFFER_WINDOW || 0.15;
      if (this._actT0 === undefined || !(this.act || Input.now - this._actEndT < 0.1)) return B;
      return M.clamp(Input.now - this._actT0 + 0.02, B, 0.4);
    }
    _verbs() {
      const w = this._win();
      // Dodge first: it is the panic button and cancels recovery of everything.
      if (this.dodgeCharges >= 1 && this._can('dodge') && Input.consume('dodge', w)) this._dodge();
      // Potions are free actions (they never interrupt).
      if (Input.peek('potion1')) this._potion('potion1', 'pancake');
      if (Input.peek('potion2')) this._potion('potion2', 'tonic');
      for (let i = 4; i >= 1; i--) this._trySkill(this.skills[i], w);
      if (this._can('attack')) {
        const a = this.act;
        const held = Input.isDown('attack') && !(a && a.noHoldCancel);
        if (Input.consume('attack', w) || held) this._startAttack();
      }
    }
    _trySkill(sk, w) {
      if (!sk) return;
      const a = this.act;
      if (a && a.toggle && a.slot === sk.slot) { if (Input.consume(sk.action)) this._endAct(false); return; }
      if (!Input.peek(sk.action, w)) return;
      // a press that can't happen is rejected with feedback (and dropped), unless it's ready within the buffer
      if (sk.cdLeft > 0) { if (sk.cdLeft > 0.15 && Input.wasPressed(sk.action)) { Input.consume(sk.action); this._deny('cooldown'); } return; }
      if (!this._afford(sk)) { if (Input.wasPressed(sk.action)) { Input.consume(sk.action); this._deny('mana'); } return; }
      if (!this._can('skill')) return;
      const K = this.kit;
      if (K.can && K.can[sk.slot] && !K.can[sk.slot](this, sk)) { Input.consume(sk.action); this._deny('target'); return; }
      Input.consume(sk.action, w);
      this._pay(sk);
      K[sk.slot](this, sk);
    }
    _afford(sk) { return this.def.temper || !sk.cost || this.mp >= sk.cost; }
    _pay(sk) {
      if (this.def.temper) this.addTemper(sk.cost);
      else if (sk.cost) this.mp = Math.max(0, this.mp - sk.cost);
      if (sk.cdOnEnd) { sk.cdLeft = 0; return; }
      sk.cdLeft = this.wildfire && sk.slot !== 'ult' ? 0 : sk.cd;
    }
    _startAttack() {
      const n = this.kit.comboLen ? this.kit.comboLen(this) : 1;
      const chaining = (this.act && this.act.kind === 'attack') || this.comboWindow > 0;
      this.combo = chaining ? (this.combo + 1) % n : 0;
      this.comboWindow = 0;
      this.kit.attack(this, this.combo);
    }

    // -------------------------------------------------------------- dodge
    _dodge() {
      const mv = Input.moveVec(); const l = Math.hypot(mv[0], mv[1]);
      const ang = l > 0.2 ? Math.atan2(mv[1], mv[0]) : this.aim;
      this.dodgeCharges -= 1; if (this.dodgeRecharge <= 0) this.dodgeRecharge = DODGE_RECHARGE;
      this.kx = 0; this.ky = 0;
      const variant = this.heroId === 'marceline' ? 'bat' : 'roll';
      let ghosts = 0, trailAcc = 0, lx = this.x, ly = this.y;
      const ringed = this.ring && !this.ring.dead;
      if (ringed) this._kindle();
      fx('burst', this.x - Math.cos(ang) * 6, this.y - Math.sin(ang) * 6, 2, this.heroId === 'fp' ? 'ember' : 'dust', 7);
      if (variant === 'bat') {
        fx('burst', this.x, this.y, bodyZ(this, 0.4), 'shadow', 10); sfx('bat', this.x, this.y, 0.5, 1.2);
        if (!realRig(this)) this.fxl.push(batCloud(this, 8, DODGE_T + 0.08, 0.55)); // the full rig dissolves her into bats itself
      }
      sfx('dodge', this.x, this.y, 0.7, rnd(0.95, 1.08));
      this._act({
        kind: 'dodge', slot: 'dodge', dur: DODGE_T, ang, cancelAt: DODGE_T, move: [0, 0], anim: ['dodge', variant], iframes: [0.05, 0.26],
        update: (a) => {
          const u = M.clamp(a.t / DODGE_T, 0, 1);
          const sp = (2 * DODGE_DIST / DODGE_T) * (1 - u) / Math.max(0.5, this.stats.moveMul || 1); // ease-out (quad)
          this.vx = Math.cos(ang) * sp; this.vy = Math.sin(ang) * sp; this.kx = 0; this.ky = 0;
          if (ghosts < 3 && a.t >= 0.05 + ghosts * 0.08) { ghosts++; fx('ghost', this, 0.22); }
          if (this.mods.dodge_fire_trail) {
            trailAcc += M.dist(lx, ly, this.x, this.y); lx = this.x; ly = this.y;
            if (trailAcc >= 24) { trailAcc = 0; fireZone(this, this.x, this.y, 20, 2.5 + 0.5 * this.mods.dodge_fire_trail, 0.18 * this.mods.dodge_fire_trail); }
          }
          if (ringed && this.ring && !this.ring.dead) this._kindle();
        },
        end: (a, cancelled) => {
          const mv2 = Input.moveVec(); const l2 = Math.hypot(mv2[0], mv2[1]);
          if (l2 > 0.2) { this.mvx = mv2[0] / Math.max(1, l2); this.mvy = mv2[1] / Math.max(1, l2); } // carry momentum out of the roll
          if (!cancelled) fx('burst', this.x, this.y, 2, 'dust', 5);
        },
      });
      this.facing = ang;
      this.vx = Math.cos(ang) * (2 * DODGE_DIST / DODGE_T); this.vy = Math.sin(ang) * (2 * DODGE_DIST / DODGE_T);
      this._perfect = false;
    }
    _kindle() {
      if (!this.hasStatus('kindled')) { fx('burst', this.x, this.y, bodyZ(this, 0.3), 'ember', 14); sfx('fire', this.x, this.y, 0.5, 1.4); fx('text', this.x, this.y, this.height + 16, 'kindled', COL.fire, 0.8); }
      C.applyStatus(this, 'kindled', { dur: 5 });
    }

    // -------------------------------------------------------------- potions
    _potion(action, kind) {
      if (this.potionCd > 0) { if (Input.wasPressed(action) && this.potionCd > 0.15) { Input.consume(action); this._deny('cooldown'); } return; }
      Input.consume(action);
      if (HM.Items && typeof HM.Items.useConsumable === 'function') {
        // Items plays the sound, shows the heal and toasts "none left" itself
        if (call('Items', 'useConsumable', [this, kind]) !== false) this.potionCd = 0.9;
        return;
      }
      if (fallbackConsumable(this, kind)) { this.potionCd = 0.9; fx('burst', this.x, this.y, bodyZ(this, 0.4), kind === 'pancake' ? 'gold' : 'holy', 10); }
      else this._deny(kind === 'pancake' && this.hp >= this.maxHp ? 'full' : 'potion');
    }
    // Items' Tonic calls this: MP heroes regain 60% MP; Flame Princess vents 60 Temper instead.
    onTonic() { this.restoreResource(0.6); }
    restoreResource(frac) {
      if (this.def.temper) { this.temper = Math.max(0, this.temper - 100 * frac); this.resource.value = this.temper; return true; }
      if (this.mp >= this.maxMp) return false;
      this.mp = Math.min(this.maxMp, this.mp + this.maxMp * frac); return true;
    }

    // -------------------------------------------------------------- Flame Princess: Temper / Wildfire
    addTemper(n) {
      if (!this.def.temper || this.wildfire || !(n > 0)) return;
      this.temper = Math.min(100, this.temper + n);
      if (n >= 5) this.temperIdle = 0;
      if (this.temper >= 100) this._enterWildfire();
    }
    _enterWildfire() {
      const lv = this.mods.fp_temper_cool || 0;
      this.wildfireDur = this.wildfireT = 4 * (1 + 0.5 * Math.min(1, lv));
      for (const s of this.skills) if (s.slot !== 'ult') s.cdLeft = 0;
      const pw = this.power();
      C.hitCircle(this.x, this.y, 70, 0, (t) => ({ amount: pw * 1.2, type: 'fire', source: this, knock: 320, status: { id: 'burn', dur: 3, dps: pw * 0.3 }, hitstop: 0.05, shake: 5 }));
      C.igniteAt(this.x, this.y, 80, this);
      fx('explosion', this.x, this.y, 70, 'fire'); fx('ring', this.x, this.y, 10, 90, 0.4, HOT.fire);
      fx('light', this.x, this.y, 20, 180, COL.fire, 2.2, 0.5); fx('shake', 6);
      fx('text', this.x, this.y, this.height + 24, 'WILDFIRE', COL.fireHot, 1.6);
      if (HM.R && HM.R.flash) HM.R.flash(1, 0.45, 0.1, 0.35);
      sfx('explode', this.x, this.y, 0.9, 0.8); sfx('fire', this.x, this.y, 0.9, 0.7);
      bark(this, ['Burn with me!', 'I am the fire now.', 'Too much? NOT ENOUGH.'][Math.floor(rnd(0, 3))], 1.4);
      if (game().slowmo) game().slowmo(0.25, 0.45);
    }

    // -------------------------------------------------------------- footsteps
    _steps() {
      if (this.floats || this.z > 1 || this.act && (this.act.kind === 'dodge')) { this._sx = this.x; this._sy = this.y; return; }
      const d = Math.abs(this.x - this._sx) + Math.abs(this.y - this._sy);
      if (d > 120) { this._sx = this.x; this._sy = this.y; return; }
      if (d >= 34 && this.moving) {
        this._sx = this.x; this._sy = this.y;
        sfx('step', this.x, this.y, 0.18, rnd(0.88, 1.12));
        fx('burst', this.x + rnd(-3, 3), this.y + 2, 1, this.def.temper ? 'ember' : 'dust', this.def.temper ? 2 : 1);
      }
    }

    _fxUpdate(dt) {
      if (!this.fxl.length) return;
      let w = 0;
      for (let i = 0; i < this.fxl.length; i++) { const e = this.fxl[i]; if (e.update(dt) !== false) this.fxl[w++] = e; }
      this.fxl.length = w;
    }

    // -------------------------------------------------------------- hooks
    onDealDamage(info) {
      if (this.heroId === 'fp') {
        if (info.target && info.target.hasStatus && info.target.hasStatus('burn')) info.amount *= 1.15;
        if (this.wildfire && info.type === 'fire') info.amount *= 1.2;
      }
    }
    onDamaged(info) {
      if (this.floats) {
        const tg = info.tags || [], sp = info.spec || {};
        // ground hazards: tagged zone damage, or any damage-over-time taken while hovering inside a hostile zone
        if (sp.zone || sp.ground || tg.includes('zone') || tg.includes('ground') || tg.includes('hazard') || (info.isDot && inHostileZone(this))) info.amount *= 0.5;
      }
      // the full rig flinches on its own (it watches flashT); the stub needs the 'hit' state
      if (!realRig(this) && !info.isDot && info.amount > 0 && !this.act && !this._stunned && this.anim.state !== 'hit') setAnim(this, 'hit', { dur: 0.16 });
    }
    onBeforeDeath(info) {
      const run = this.run || game().run;
      if (this.mods.second_wind && run && !run.secondWindUsed) {
        run.secondWindUsed = true;
        this.hp = Math.max(1, Math.round(this.maxHp * 0.3)); this.iframeT = Math.max(this.iframeT, 1.5);
        this.statuses = this.statuses.filter((s) => s.id === 'kindled' || s.id === 'haste' || s.id === 'shield');
        fx('burst', this.x, this.y, bodyZ(this, 0.4), 'holy', 40); fx('ring', this.x, this.y, 10, 110, 0.6, HOT.holy);
        fx('text', this.x, this.y, this.height + 24, 'SECOND WIND', COL.holy, 1.5);
        if (HM.R && HM.R.flash) HM.R.flash(1, 0.95, 0.8, 0.5);
        sfx('levelup', this.x, this.y, 0.9, 0.8);
        C.hitCircle(this.x, this.y, 80, 0, { amount: 1, type: 'holy', source: this, knock: 420, noNumber: true, hitstop: 0.08, shake: 6 });
        if (game().slowmo) game().slowmo(0.6, 0.35);
        return false;
      }
      return true;
    }
    onDeath() {
      if (this.act) { const a = this.act; this.act = null; if (a.end) a.end(a, true); }
      this.rigHidden = false; this.fxl.length = 0;
      if (this.ring) this.ring.life = 0;
      sfx('death_big', this.x, this.y, 0.8);
    }
    onKill(target) {
      if (!target || target.team !== 1) return;
      if (this.heroId === 'finn') C.heal(this, 2);
      if (this.mods.kill_heal) C.heal(this, this.maxHp * 0.03 * this.mods.kill_heal);
    }

    // -------------------------------------------------------------- draw
    draw() {
      if (!this.rigHidden) {
        if (HM.Rig && typeof HM.Rig.draw === 'function') call('Rig', 'draw', [this]);
        else super.draw();
      }
      if (this.kit.draw) this.kit.draw(this);
      for (const e of this.fxl) if (e.draw) e.draw();
    }
  }

  function inHostileZone(p) {
    const Z = game().zones; if (!Z) return false;
    for (const z of Z) if (!z.dead && z.team !== p.team && M.dist(z.x, z.y, p.x, p.y) <= (z.r || 0) + p.radius * 0.5) return true;
    return false;
  }

  // Items fallback for potions (only when HM.Items.useConsumable is missing).
  function fallbackConsumable(p, kind) {
    const run = p.run || game().run; const c = run && run.consumables;
    if (!c || !(c[kind] > 0)) return false;
    if (kind === 'pancake') { if (p.hp >= p.maxHp) return false; c[kind]--; C.heal(p, p.maxHp * 0.35); }
    else { if (!p.restoreResource(0.5)) return false; c[kind]--; }
    sfx('potion', p.x, p.y, 0.7);
    return true;
  }

  // ==================================================================================================
  // Shared skill helpers
  // ==================================================================================================
  // Generic combo swing (Finn / Marceline). c: {v, dur, half, range, mul, knock, sweep, thrust, spin, lunge, hitstop, shake, bleed, width, heavy}
  function meleeAttack(p, c, idx) {
    const D = c.dur / atkSpeed(p);
    const tSwing = D * 0.28, tStrike = D * 0.35;
    const lungeV = c.lunge || 0;
    p._act({
      kind: 'attack', slot: 'attack', dur: D, ang: p.aim, cancelAt: D * 0.42, chainAt: D * 0.55, move: [0.18, 0.55], anim: ['attack', c.v],
      update: (a) => {
        if (a.t < tSwing) a.ang = p.aim; // aim tracks the mouse through the anticipation
        if (lungeV && a.t >= D * 0.22 && a.t < D * 0.46 && !C.queryArc(p.x, p.y, a.ang, 0.55, 20, 0).length) {
          p.vx += Math.cos(a.ang) * lungeV; p.vy += Math.sin(a.ang) * lungeV;
        }
      },
      events: [
        [tSwing, (a) => {
          a.ang = p._assist(a.ang, c.range);
          const h = c.half * 1.05;
          const r0 = c.range - (c.wide ? 16 : 11);
          if (c.spin) p._swing(a.ang, a.ang + TAU * 0.98, c.range, { dur: D * 0.3, life: 0.2, r0: c.range - 13 });
          else if (c.thrust) p._swing(a.ang - 0.05, a.ang + 0.05, c.range + 6, { r0: 18, dur: 0.05, life: 0.15 });
          else if (c.sweep > 0) p._swing(a.ang - h, a.ang + h, c.range, { dur: D * 0.22, r0 });
          else p._swing(a.ang + h, a.ang - h, c.range, { dur: D * 0.22, r0 });
          if (c.echo) { // a darker inner echo gives heavy weapons their weight
            const e0 = c.sweep > 0 ? a.ang - h * 0.9 : a.ang + h * 0.9, e1 = c.sweep > 0 ? a.ang + h * 0.9 : a.ang - h * 0.9;
            p._swing(e0, e1, r0 - 2, { r0: r0 - 12, dur: D * 0.26, life: 0.22, color: c.echo, glyphs: "%;:.", emissive: 0.35 });
          }
          sfx(c.heavy || c.thrust || c.spin ? 'swing_heavy' : 'swing', p.x, p.y, 0.6, 0.94 + idx * 0.07 + rnd(-0.03, 0.03));
        }],
        [tStrike, (a) => {
          const pw = p.power();
          const hits = C.hitArc(p.x, p.y, a.ang, c.half, c.range, 0, () => p._meleeSpec(c.mul, {
            knock: c.knock, dir: c.thrust ? a.ang : undefined, hitstop: c.hitstop, shake: c.shake, tags: ['melee'],
            status: c.bleed ? { id: 'bleed', dur: 3, dps: pw * 0.1, stacks: 1 } : null,
          }));
          if (hits.length) {
            if (c.thrust) fx('burst', hits[0].x, hits[0].y, bodyZ(hits[0], 0.5), 'spark', 8);
          } else if (c.thrust || c.spin) fx('burst', p.x + Math.cos(a.ang) * c.range * 0.8, p.y + Math.sin(a.ang) * c.range * 0.8, 4, 'dust', 4);
          if (p.kit.onMelee) p.kit.onMelee(p, hits, a.ang, c);
        }],
      ],
    });
  }

  // Burning ground (Cinder Rain craters, fire-trail dodge boon).
  function fireZone(p, x, y, r, life, dpsMul) {
    const pw = p.power();
    return C.zone({
      x, y, r, team: 0, life, tick: 0.5, kind: 'fire', source: p,
      onTick: (z, inside) => { for (const a of inside) C.damage(a, { amount: pw * dpsMul, type: 'fire', source: p, canCrit: false, hitstop: 0, shake: 0, status: { id: 'burn', dur: 2, dps: pw * 0.12 } }); },
    });
  }

  // Flatten whatever FX.fissure hands to onErupt into [[x,y],...]
  function flatPoints(pts, out) {
    out = out || [];
    if (!pts) return out;
    if (Array.isArray(pts)) {
      if (pts.length >= 2 && typeof pts[0] === 'number' && typeof pts[1] === 'number') { out.push([pts[0], pts[1]]); return out; }
      for (const q of pts) flatPoints(q, out);
    } else if (typeof pts === 'object') {
      if (typeof pts.x === 'number' && typeof pts.y === 'number') out.push([pts.x, pts.y]);
      else if (pts.points) flatPoints(pts.points, out);
    }
    return out;
  }

  // Polyline glyph drawer for organic shapes (vines, arms): world points with z.
  function wpLine(R, x0, y0, z0, x1, y1, z1, g, r, gg, b, key, flags) {
    const A = R.proj(x0, y0, z0), B = R.proj(x1, y1, z1);
    R.seg(A[0], A[1], B[0], B[1], g, r, gg, b, key, flags || 0);
  }

  // ---------------------------------------------------------------- vines (Finn Q, Leap Slam boon)
  function vinesZone(p, pts, o) {
    o = o || {};
    const pw = p.power(), once = new Set();
    let maxT = 0;
    for (const q of pts) {
      q.done = false; maxT = Math.max(maxT, q.t0);
      q.strands = [];
      const n = 3 + (HM.rng.next() < 0.5 ? 1 : 0);
      for (let k = 0; k < n; k++) q.strands.push({ ox: rnd(-8, 8), oy: rnd(-5, 5), h: rnd(16, 32) * (o.scale || 1), ph: rnd(0, TAU), lean: rnd(-0.8, 0.8), tip: '"*;\'%}{'[Math.floor(rnd(0, 7))] });
    }
    const life = maxT + (o.life || 1.35);
    return C.zone({
      x: pts[0].x, y: pts[0].y, r: 1, team: 0, life, tick: 99, kind: 'vines', source: p, pts,
      update: (z) => {
        for (const q of pts) {
          if (q.done || z.t < q.t0) continue;
          q.done = true;
          C.hitCircle(q.x, q.y, 20, 0, () => ({
            amount: pw * (o.mul || 1.1), type: 'phys', source: p, knock: 30, hitstop: 0.03, shake: 1.2, tags: ['vines'],
            status: [{ id: 'stun', dur: o.root || 1 }, { id: 'bleed', dur: 3, dps: pw * 0.12, stacks: 1 }],
          }), { once });
          if (HM.rng.next() < 0.5) fx('burst', q.x, q.y, 3, 'dust', 2);
        }
      },
      draw: drawVines,
    });
  }
  function drawVines(z) {
    const R = HM.R; if (!R) return;
    const t = z.t, end = z.maxLife;
    const wither = M.clamp((end - t) / 0.4, 0, 1);
    for (const q of z.pts) {
      const age = t - q.t0; if (age < 0) continue;
      if (!R.inViewWorld(q.x, q.y, 40)) continue;
      const grow = M.clamp(age / 0.13, 0, 1);
      const gk = (grow < 1 ? M.easeOutBack(grow) : 1) * wither;
      // ground scar: torn earth that glows with the curse while it is fresh
      const gp = R.proj(q.x, q.y, 0), fresh = Math.max(0, 1 - age / 0.5);
      for (let k = -1; k <= 1; k++) {
        const i = R.idxP(gp[0] + k * 5, gp[1]);
        if (R.setI(i, gi(k ? ',' : (age < 0.25 ? '*' : ';')), 0.1 + 0.25 * fresh, 0.3 * wither + 0.45 * fresh, 0.08, R.KEY_DECAL + 12, R.F_UNLIT)) R.emitI(i, 0.02, 0.18 * fresh, 0.02);
      }
      if (gk <= 0.02) continue;
      const dim = (0.55 + 0.45 * wither) * (0.85 + 0.3 * fresh);
      for (const s of q.strands) {
        const bx = q.x + s.ox, by = q.y + s.oy, h = s.h * gk;
        let px = bx, pz = 0;
        for (let k = 1; k <= 4; k++) {
          const u = k / 4;
          const nx = bx + (Math.sin(t * 6 + s.ph + u * 2.4) * 2.5 + s.lean * h * 0.5) * u;
          const nz = h * u;
          const c = k < 3 ? COL.grass : COL.grassTip;
          wpLine(R, px, by, pz, nx, by, nz, null, c[0] * dim, c[1] * dim, c[2] * dim, by + 0.4 + u * 0.1, R.F_UNLIT);
          px = nx; pz = nz;
        }
        const tp = R.proj(px, by, pz + 2);
        R.glowGlyph(tp[0], tp[1], gi(s.tip), 0.7 * dim, 1.25 * dim, 0.5 * dim, by + 0.6, 0.5 * wither);
      }
      if (age < 0.6 && (q.t0 * 100 | 0) % 3 === 0) R.light(q.x, q.y, 10, 50, 0.3, 1, 0.25, 0.9 * (1 - age / 0.6));
    }
  }
  function vineLine(p, x, y, ang, len, spacing, dt0) {
    const pts = [];
    const ca = Math.cos(ang), sa = Math.sin(ang);
    for (let d = 0, i = 0; d <= len; d += spacing, i++) {
      const vx = x + ca * d + rnd(-3, 3), vy = y + sa * d + rnd(-3, 3);
      if (solid(vx, vy)) break;
      pts.push({ x: vx, y: vy, t0: i * dt0 });
    }
    return pts;
  }

  // ---------------------------------------------------------------- bats (Marceline)
  // A cloud of flapping bat glyphs that follows the player's recent path.
  function batCloud(p, n, life, scale) {
    const bats = [], hist = [];
    for (let i = 0; i < n; i++) bats.push({ ph: rnd(0, TAU), r: rnd(4, 16) * (scale || 1), w: rnd(5, 9) * (rnd(0, 1) < 0.5 ? -1 : 1), z: rnd(10, 40), lag: rnd(0, 0.09), flap: rnd(14, 22) });
    let t = 0;
    return {
      update(dt) {
        t += dt; hist.push(t, p.x, p.y);
        while (hist.length > 3 && hist[0] < t - 0.15) hist.splice(0, 3);
        return t < life && !p.dead;
      },
      draw() {
        const R = HM.R; if (!R) return;
        const fade = M.clamp((life - t) / 0.12, 0, 1);
        for (const b of bats) {
          // position along history at time t - lag
          let hx = p.x, hy = p.y; const want = t - b.lag;
          for (let i = hist.length - 3; i >= 0; i -= 3) { if (hist[i] <= want) { hx = hist[i + 1]; hy = hist[i + 2]; break; } }
          const a = b.ph + t * b.w;
          const x = hx + Math.cos(a) * b.r, y = hy + Math.sin(a) * b.r * 0.7, z = b.z + Math.sin(t * 7 + b.ph) * 5 + p.z;
          const q = R.proj(x, y, z);
          const up = Math.sin(t * b.flap + b.ph) > 0;
          const k = y + 6;
          const wc = 0.42 * fade + 0.08;
          R.set(q[0] - 5, q[1], gi(up ? '\\' : '/'), wc, wc * 0.45, wc * 0.75, k, 0);
          R.set(q[0] + 5, q[1], gi(up ? '/' : '\\'), wc, wc * 0.45, wc * 0.75, k, 0);
          R.glowGlyph(q[0], q[1], gi(up ? 'v' : 'w'), 0.75 * fade, 0.08, 0.12, k + 0.1, 0.35);
        }
      },
    };
  }

  // ==================================================================================================
  // FINN
  // ==================================================================================================
  const FINN_COMBO = [
    { v: 'slash1', dur: 0.25, half: 1.0, range: 50, mul: 1.0, knock: 150, sweep: 1, lunge: 150 },
    { v: 'slash2', dur: 0.25, half: 1.0, range: 50, mul: 1.1, knock: 170, sweep: -1, lunge: 150 },
    { v: 'thrust', dur: 0.36, half: 0.45, range: 68, mul: 1.75, knock: 360, thrust: true, lunge: 240, hitstop: 0.07, shake: 3 },
    { v: 'spin', dur: 0.42, half: Math.PI, range: 58, mul: 1.5, knock: 280, spin: true, lunge: 60, hitstop: 0.06, shake: 2.5, bleed: true },
  ];

  const Finn = {
    comboLen: (p) => (p.mods.finn_combo4 ? 4 : 3),
    attack(p, i) { meleeAttack(p, FINN_COMBO[i % FINN_COMBO.length], i); },

    // RMB — Heavy Cleave: 180° arc; hold to charge (up to +0.6 s), auto-releases after holding at full.
    heavy(p) {
      const D = 0.52 / atkSpeed(p), holdAt = D * 0.26;
      let sparkT = 0;
      p._act({
        kind: 'heavy', slot: 'heavy', dur: D, ang: p.aim, cancelAt: D * 0.62, move: [0.3, 0.5], anim: ['attack', 'heavy'],
        charge: 0, charging: true, fullT: 0,
        update: (a, dt) => {
          if (a.t <= holdAt + 1e-4) a.ang = p.aim;
          if (a.charging && a.t >= holdAt) {
            const held = Input.isDown('heavy');
            if (held && a.fullT < 0.5) {
              a.t = holdAt; p.anim.t = Math.min(p.anim.t, holdAt);
              a.ang = p.aim;
              if (a.charge < 1) {
                a.charge = Math.min(1, a.charge + dt / 0.6);
                if (a.charge >= 1) { fx('ring', p.x, p.y, 4, 34, 0.25, HOT.grass); fx('burst', p.x, p.y, bodyZ(p, 0.4), 'spark', 10); sfx('swing', p.x, p.y, 0.5, 1.6); fx('shake', 1.5); }
              } else a.fullT += dt;
              sparkT -= dt;
              if (sparkT <= 0) { sparkT = 0.06; const tip = tipOf(p); fx('burst', tip[0], tip[1], tip[2], 'spark', 1 + Math.round(a.charge * 2)); }
            } else a.charging = false;
          }
        },
        events: [
          [D * 0.3, (a) => {
            const c = a.charge, half = Math.PI / 2, range = 64 + 24 * c;
            const st = p._trail();
            p._swing(a.ang + half * 1.08, a.ang - half * 1.08, range, { dur: D * 0.16, life: 0.26, r0: range - 16 - 8 * c, emissive: st.emissive + 0.25 + c * 0.45 });
            sfx('swing_heavy', p.x, p.y, 0.8 + 0.2 * c, 0.85 - 0.15 * c);
          }],
          [D * 0.35, (a) => {
            const c = a.charge, half = Math.PI / 2, range = 64 + 24 * c;
            const hits = C.hitArc(p.x, p.y, a.ang, half, range, 0, () => p._meleeSpec(1.9 + 1.6 * c, { knock: 380 + 300 * c, hitstop: 0.07 + 0.035 * c, shake: 4 + 4 * c, tags: ['melee', 'heavy'] }));
            for (let k = -2; k <= 2; k++) { const aa = a.ang + k * 0.6; fx('burst', p.x + Math.cos(aa) * range * 0.7, p.y + Math.sin(aa) * range * 0.7, 3, 'dust', 3); }
            if (!hits.length) fx('shake', 1.5 + 2 * c);
            if (c >= 1) { fx('ring', p.x, p.y, 10, range + 10, 0.3, HOT.grass); fx('light', p.x, p.y, 20, 110, COL.grassTip, 1.2, 0.2); }
            if (p.mods.finn_cleave_wave) grassWave(p, a.ang, c);
          }],
        ],
      });
    },

    // Q — Grass Vines along a line toward the cursor.
    skill1(p) {
      const D = 0.42 / castSpeed(p);
      p._act({
        kind: 'skill', slot: 'skill1', dur: D, ang: p.aim, cancelAt: D * 0.55, move: [0.2, 0.6], anim: ['cast', 'forward'],
        update: (a) => { if (a.t < D * 0.3) a.ang = p.aim; },
        events: [[D * 0.3, (a) => {
          const pts = vineLine(p, p.x + Math.cos(a.ang) * 14, p.y + Math.sin(a.ang) * 14, a.ang, 230, 16, 0.024);
          if (pts.length) vinesZone(p, pts, { mul: 1.1, root: 1 });
          fx('burst', p.x + Math.cos(a.ang) * 12, p.y + Math.sin(a.ang) * 12, 4, 'dust', 6);
          fx('light', p.x + Math.cos(a.ang) * 60, p.y + Math.sin(a.ang) * 60, 10, 120, COL.grass, 0.9, 0.5);
          fx('shake', 2);
          sfx('swing_heavy', p.x, p.y, 0.7, 0.6); sfx('bone_break', p.x, p.y, 0.4, 1.5);
        }]],
      });
    },

    // E — Leap Slam: crouch → air (i-frames) → landing AoE + dust ring.
    skill2(p) {
      const crouch = 0.08, air = 0.36, rec = 0.22, D = crouch + air + rec;
      const sx = p.x, sy = p.y;
      let tx, ty;
      {
        const d = p.aimDist(150, 30), ang = p.aim;
        tx = sx + Math.cos(ang) * d; ty = sy + Math.sin(ang) * d;
        for (let k = 0; k < 8 && solid(tx, ty); k++) { tx = M.lerp(sx, tx, 0.8); ty = M.lerp(sy, ty, 0.8); }
      }
      p._act({
        kind: 'skill', slot: 'skill2', dur: D, ang: M.angle(sx, sy, tx, ty), lockUntil: crouch + air, cancelAt: crouch + air + 0.06, move: [0, 0.5], anim: ['attack', 'slam'],
        iframes: [crouch, crouch + air + 0.06], st: 0,
        update: (a) => {
          if (a.t < crouch) return;
          if (a.st === 0) { a.st = 1; p.noCollide = true; fx('burst', p.x, p.y, 2, 'dust', 8); sfx('swing_heavy', p.x, p.y, 0.7, 0.7); }
          if (a.st !== 1) return;
          const u = M.clamp((a.t - crouch) / air, 0, 1), e = M.easeInOut(u);
          C.move(p, M.lerp(sx, tx, e) - p.x, M.lerp(sy, ty, e) - p.y);
          p.vx = 0; p.vy = 0; p.kx = 0; p.ky = 0;
          p.z = Math.sin(u * Math.PI) * 46;
          if (u >= 1) { a.st = 2; Finn._land(p); }
        },
        end: () => { p.z = 0; p.noCollide = false; },
      });
    },
    _land(p) {
      p.z = 0; p.noCollide = false;
      const R0 = 62;
      C.hitCircle(p.x, p.y, R0, 0, () => p._meleeSpec(1.7, { knock: 360, hitstop: 0.08, shake: 7, tags: ['slam'], status: { id: 'stun', dur: 0.45 } }));
      fx('ring', p.x, p.y, 8, R0 + 14, 0.35, HOT.dust, { glyph: 'o' });
      fx('burst', p.x, p.y, 2, 'dust', 26);
      fx('decal', p.x, p.y, 'crack', 40, 6);
      fx('light', p.x, p.y, 10, 90, [0.9, 0.85, 0.7], 0.6, 0.15);
      fx('shake', 5);
      sfx('explode', p.x, p.y, 0.6, 0.55); sfx('hit', p.x, p.y, 0.8, 0.6);
      if (p.mods.finn_leap_vines) {
        const pts = [];
        const n = 7, base = rnd(0, TAU);
        for (let k = 0; k < n; k++) {
          const ang = base + (k / n) * TAU;
          const line = vineLine(p, p.x + Math.cos(ang) * 12, p.y + Math.sin(ang) * 12, ang, 44 + 10 * p.mods.finn_leap_vines, 15, 0.03);
          for (const q of line) pts.push(q);
        }
        if (pts.length) vinesZone(p, pts, { mul: 0.6, root: 0.8 + 0.2 * p.mods.finn_leap_vines, scale: 0.8 });
      }
    },

    // R — JAKE!
    ult(p) {
      const D = 0.5;
      const d = p.aimDist(230, 40);
      let tx = p.x + Math.cos(p.aim) * d, ty = p.y + Math.sin(p.aim) * d;
      for (let k = 0; k < 8 && solid(tx, ty); k++) { tx = M.lerp(p.x, tx, 0.8); ty = M.lerp(p.y, ty, 0.8); }
      p._act({
        kind: 'skill', slot: 'ult', dur: D, ang: p.aim, cancelAt: 0.3, move: [0.2, 0.6], anim: ['cast', 'summon'],
        events: [[0.1, () => {
          if (p.jake && !p.jake.removeMe) p.jake.phase = 'leave';
          const j = new Jake(p, tx, ty, p.mods.finn_jake_long ? 1 + 0.5 * p.mods.finn_jake_long : 1);
          p.jake = j;
          if (game().spawn) game().spawn(j); else if (game().entities) game().entities.push(j);
          bark(p, 'JAKE!', 1.0);
          sfx('jake_stretch', p.x, p.y, 0.9, 1);
        }]],
      });
    },

    draw(p) {
      const a = p.act; const R = HM.R; if (!R) return;
      if (a && a.kind === 'heavy' && a.charging && a.charge > 0) {
        const tip = tipOf(p), c = a.charge;
        R.light(tip[0], tip[1], tip[2], 30 + 50 * c, 0.55, 1, 0.5, 0.4 + 0.9 * c);
        const q = R.proj(tip[0], tip[1], tip[2]);
        for (let k = 0; k < 3; k++) {
          const ang = HM.Game.t * 9 + k * 2.1, rr = 6 + 10 * (1 - c);
          R.glowGlyph(q[0] + Math.cos(ang) * rr, q[1] + Math.sin(ang) * rr * 0.6, gi(c >= 1 ? '*' : '+'), 0.6 + 0.4 * c, 1, 0.55, p.y + 3, 0.6 + c);
        }
      }
    },
  };

  function tipOf(p) {
    const t = HM.Rig && typeof HM.Rig.weaponTip === 'function' ? call('Rig', 'weaponTip', [p]) : null;
    if (t && isFinite(t[0])) return t;
    return [p.x + Math.cos(p.facing) * 18, p.y + Math.sin(p.facing) * 18, bodyZ(p, 0.45)];
  }

  // Heavy Cleave boon: a crescent wave of grass that rolls forward.
  function grassWave(p, ang, c) {
    const pw = p.power(), sp = 380, lvl = p.mods.finn_cleave_wave || 1;
    C.projectile({
      x: p.x + Math.cos(ang) * 20, y: p.y + Math.sin(ang) * 20, z: 6, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, r: 18, team: 0, life: 0.5 + 0.1 * lvl,
      pierce: 99, source: p, look: 'bolt', color: COL.grassTip, ang,
      damage: () => p._meleeSpec(0.9 + 0.3 * lvl + 0.6 * c, { knock: 220, tags: ['wave'], status: { id: 'bleed', dur: 3, dps: pw * 0.1, stacks: 1 } }),
      draw: (q) => {
        const R = HM.R; if (!R) return;
        const fade = M.clamp(q.life / 0.15, 0, 1), px = -Math.sin(ang), py = Math.cos(ang);
        for (let k = -5; k <= 5; k++) {
          const off = k * 4.5, bend = (1 - (k * k) / 25) * 8;
          const x = q.x + px * off + Math.cos(ang) * bend, y = q.y + py * off + Math.sin(ang) * bend;
          const a = R.proj(x, y, 0), b = R.proj(x + Math.cos(ang) * 3, y + Math.sin(ang) * 3, 9 + (1 - Math.abs(k) / 5) * 8);
          R.seg(a[0], a[1], b[0], b[1], null, 0.3 * fade, 0.85 * fade, 0.3 * fade, y + 0.5, 0);
          R.glowGlyph(b[0], b[1], gi(k & 1 ? '"' : ';'), 0.5 * fade, 1 * fade, 0.4 * fade, y + 0.6, 0.4);
        }
        R.light(q.x, q.y, 6, 60, 0.3, 0.9, 0.3, 0.6 * fade);
      },
    });
  }

  // ---------------------------------------------------------------- Jake (Finn's ultimate)
  const JAKE_BARKS = ['Big paw, comin\' down!', 'Hold my sandwich, bro.', 'Stretchy time!', 'Mathematical!', 'Nobody touches my brother.'];
  const JAKE_BYE = ['Nap time.', 'Later, buddy.', 'Gonna go eat a bagel.'];
  class Jake extends HM.Actor {
    constructor(owner, tx, ty, durMul) {
      const side = owner.facing + Math.PI / 2;
      super({ kind: 'ally', team: 0, defId: 'jake', name: 'Jake', radius: 10, mass: 4, height: 46, invuln: true, noCollide: true, hp: 999, maxHp: 999, speed: 90, xpValue: 0 });
      this.owner = owner;
      this.x = owner.x + Math.cos(side) * 20; this.y = owner.y + Math.sin(side) * 20;
      this.tx = tx; this.ty = ty; this.phase = 'pop'; this.pt = 0;
      this.spinDur = 2.0 * (durMul || 1);
      this.facing = M.angle(this.x, this.y, tx, ty); this.aim = this.facing;
      this.fist = { x: this.x, y: this.y, z: bodyZ(this, 0.55), r: 4 };
      this.spinA = 0; this.hitT = 0; this.trailT = 0;
      if (HM.Rig && HM.Rig.create) call('Rig', 'create', [this, 'jake', {}]);
      fx('burst', this.x, this.y, bodyZ(this, 0.25), 'smoke', 14); fx('burst', this.x, this.y, bodyZ(this, 0.25), 'dust', 8);
      setAnim(this, 'spawn', { dur: 0.25 });
    }
    onKill(t, info) { if (this.owner && this.owner.onKill) this.owner.onKill(t, info); }
    update(dt) {
      this.pt += dt;
      const o = this.owner;
      if (!o || o.dead) { if (this.phase !== 'leave') { this.phase = 'leave'; this.pt = 0; } }
      const pw = o ? o.power() : 10;
      const st = this.phase;
      this.vx = 0; this.vy = 0;
      if (st === 'pop') {
        if (this.pt >= 0.22) {
          this.phase = 'stretch'; this.pt = 0;
          this.facing = this.aim = M.angle(this.x, this.y, this.tx, this.ty);
          setAnim(this, 'attack', { dur: 0.5, variant: 'stretch' });
          this.stretchTo = { x: this.tx, y: this.ty };
          bark(this, JAKE_BARKS[Math.floor(rnd(0, JAKE_BARKS.length))], 1.4);
          fx('telegraph', { shape: 'circle', x: this.tx, y: this.ty, r: 72, dur: 0.42, color: COL.jake });
          sfx('jake_stretch', this.x, this.y, 0.8, 0.8);
        }
      } else if (st === 'stretch') {
        // the arm shoots out and the fist balloons above the target, then slams down
        const u = M.clamp(this.pt / 0.42, 0, 1);
        const reach = M.easeOutCubic(Math.min(1, u * 1.6));
        this.fist.x = M.lerp(this.x, this.tx, reach); this.fist.y = M.lerp(this.y, this.ty, reach);
        this.fist.r = 4 + 13 * M.easeOutBack(Math.min(1, u * 1.3));
        // shoulder height → a balloon arc ~0.7 body-heights above it → slam into the ground
        const sz = jointZ(this, 'chest', 0.55), top = sz + (this.height || 60) * 0.72;
        this.fist.z = u < 0.75 ? sz + (top - sz) * M.easeOutCubic(u / 0.75) : top * (1 - M.easeInCubic((u - 0.75) / 0.25));
        if (this.rig && typeof this.rig === 'object') this.rig.stretch = Math.max(0.05, reach);
        if (u >= 1) {
          this.phase = 'retract'; this.pt = 0;
          const tx = this.tx, ty = this.ty;
          C.hitCircle(tx, ty, 74, 0, () => ({ amount: pw * 3.2, type: 'phys', source: this, knock: 460, status: { id: 'stun', dur: 0.9 }, hitstop: 0, shake: 0, tags: ['jake'] }));
          if (game().hitstop) game().hitstop(0.1);
          fx('shake', 9); fx('ring', tx, ty, 10, 90, 0.4, HOT.jake); fx('burst', tx, ty, 2, 'dust', 34);
          fx('decal', tx, ty, 'crack', 56, 8); fx('light', tx, ty, 20, 140, [1, 0.8, 0.5], 1.2, 0.2);
          sfx('explode', tx, ty, 1, 0.5); sfx('hit', tx, ty, 1, 0.5);
        }
      } else if (st === 'retract') {
        // zip to the impact point while the arm snaps back
        const u = M.clamp(this.pt / 0.24, 0, 1), e = M.easeInOut(u);
        if (!this._from) this._from = [this.x, this.y];
        this.x = M.lerp(this._from[0], this.tx, e); this.y = M.lerp(this._from[1], this.ty, e);
        this.fist.x = this.tx; this.fist.y = this.ty; this.fist.z = M.lerp(bodyZ(this, 0.12), jointZ(this, 'chest', 0.55), u); this.fist.r = 17 - 11 * u;
        if (this.rig && typeof this.rig === 'object') this.rig.stretch = Math.max(0.05, 1 - u);
        if (u >= 1) {
          if (this.rig && typeof this.rig === 'object') this.rig.stretch = 0;
          this.phase = 'spin'; this.pt = 0;
          setAnim(this, 'attack', { dur: 0.3, variant: 'spin' });
          sfx('swing_heavy', this.x, this.y, 0.8, 0.7);
        }
      } else if (st === 'spin') {
        // stretchy whirlwind that drifts toward the nearest foe (the rig draws the whirling arms from this.spinArm)
        this.spinA += dt * TAU * 2.6;
        this.facing = this.spinA;
        this.spinArm = { ang: this.spinA, reach: 54 };
        if (this.anim.t >= (this.anim.dur || 0.3)) setAnim(this, 'attack', { dur: 0.3, variant: 'spin' });
        const n = C.nearestHostile(this.x, this.y, 0, 260);
        if (n) { const a = M.angle(this.x, this.y, n.x, n.y), d = M.dist(this.x, this.y, n.x, n.y); if (d > 16) { this.vx = Math.cos(a) * 85; this.vy = Math.sin(a) * 85; } }
        this.hitT -= dt; this.trailT -= dt;
        if (this.hitT <= 0) {
          this.hitT = 0.22;
          C.hitCircle(this.x, this.y, 70, 0, (t) => ({ amount: pw * 0.55, type: 'phys', source: this, knock: 240, hitstop: 0, shake: 0, tags: ['jake'] }));
        }
        if (this.trailT <= 0) {
          this.trailT = 0.12;
          fx('swing', { actor: this, x: this.x, y: this.y, z: bodyZ(this, 0.4), a0: this.spinA, a1: this.spinA + 2.4, r0: 36, r1: 66, dur: 0.1, life: 0.18, color: [1.9, 1.25, 0.45], glyphs: '~=-', emissive: 0.5 });
          fx('burst', this.x + rnd(-40, 40), this.y + rnd(-30, 30), 2, 'dust', 2);
        }
        if (this.pt >= this.spinDur) { this.phase = 'leave'; this.pt = 0; this.spinArm = null; }
      } else if (st === 'leave') {
        if (!this._bye) { this._bye = true; this.pt = 0; bark(this, JAKE_BYE[Math.floor(rnd(0, JAKE_BYE.length))], 1.2); setAnim(this, 'idle'); }
        this.z = Math.sin(M.clamp(this.pt / 0.35, 0, 1) * Math.PI) * 14; // a little hop, then poof
        if (this.pt >= 0.35 && !this.removeMe) {
          fx('burst', this.x, this.y, bodyZ(this, 0.25), 'smoke', 16); fx('burst', this.x, this.y, bodyZ(this, 0.12), 'dust', 6);
          this.removeMe = true;
          if (o && o.jake === this) o.jake = null;
        }
      }
      C.baseUpdate(this, dt);
    }
    draw() {
      const R = HM.R; if (!R) return;
      const st = this.phase;
      if (HM.Rig && typeof HM.Rig.draw === 'function') call('Rig', 'draw', [this]); else super.draw();
      const ramp = R.RAMPS.flesh || R.RAMPS.solid;
      const shoulderZ = bodyZ(this, 0.55);
      if (st !== 'spin') this.spinArm = null;
      if ((st === 'stretch' || st === 'retract') && !realRig(this)) { // the full rig draws the stretchy arm from this.fist
        const f = this.fist;
        const A = R.proj(this.x, this.y, shoulderZ), B = R.proj(f.x, f.y, f.z);
        const ka = this.y + 2, kb = f.y + 2;
        R.capsule(A[0], A[1], B[0], B[1], 3.2, 3.8, ka, kb, ramp, COL.jake[0], COL.jake[1], COL.jake[2], 0);
        R.ball(B[0], B[1], f.r, kb + 1, ramp, COL.jake[0], COL.jake[1], COL.jake[2], 0);
        R.shadowEllipse(f.x, f.y, f.r * 1.4, f.r * 1.0, M.clamp(f.z / 90, 0.2, 0.8));
        R.light(f.x, f.y, f.z, 50, 1, 0.75, 0.35, 0.4);
      } else if (st === 'spin') {
        if (!realRig(this)) { // the full rig draws the whirling arms itself (from this.spinArm) — no duplicate capsules
          for (let k = 0; k < 2; k++) {
            const a = this.spinA + k * Math.PI;
            const hx = this.x + Math.cos(a) * 54, hy = this.y + Math.sin(a) * 54;
            const A = R.proj(this.x, this.y, bodyZ(this, 0.45)), B = R.proj(hx, hy, bodyZ(this, 0.35));
            R.capsule(A[0], A[1], B[0], B[1], 2.8, 3.2, this.y + 1, hy + 1, ramp, COL.jake[0], COL.jake[1], COL.jake[2], 0);
            R.ball(B[0], B[1], 6.5, hy + 2, ramp, COL.jake[0], COL.jake[1], COL.jake[2], 0);
          }
        }
        R.light(this.x, this.y, bodyZ(this, 0.35), 70, 1, 0.7, 0.3, 0.35);
      }
    }
  }

  // ==================================================================================================
  // MARCELINE
  // ==================================================================================================
  const MARCY_COMBO = [
    { v: 'slash1', dur: 0.38, half: 1.2, range: 60, mul: 1.3, knock: 230, sweep: 1, lunge: 110, wide: true, echo: [0.9, 0.08, 0.2] },
    { v: 'slash2', dur: 0.44, half: 1.3, range: 64, mul: 1.6, knock: 330, sweep: -1, lunge: 130, hitstop: 0.06, shake: 2.5, wide: true, heavy: true, echo: [0.9, 0.08, 0.2] },
  ];

  function drainTarget(p, exclude) {
    const ax = p.aimX, ay = p.aimY;
    let best = null, bs = 1e9;
    for (const a of C.actors()) {
      if (!C.hostile(a, 0) || a === exclude) continue;
      const dp = M.dist(p.x, p.y, a.x, a.y); if (dp > 240) continue;
      const dc = M.dist(ax, ay, a.x, a.y);
      const score = dc < 110 ? dc : 110 + dp; // prefer what's under the cursor, else what's nearest to her
      if (score < bs) { bs = score; best = a; }
    }
    return best;
  }
  const alive = (a) => a && !a.dead && !a.removeMe;

  const Marceline = {
    comboLen: () => 2,
    attack(p, i) { meleeAttack(p, MARCY_COMBO[i % 2], i); },
    can: { skill1: (p) => !!drainTarget(p) },

    // RMB — Sonic Chord: an expanding cone of sound.
    heavy(p) {
      const D = 0.44 / castSpeed(p);
      p._act({
        kind: 'skill', slot: 'heavy', dur: D, ang: p.aim, cancelAt: D * 0.5, move: [0.25, 0.6], anim: ['cast', 'forward'],
        update: (a) => { if (a.t < D * 0.3) a.ang = p.aim; },
        events: [[D * 0.3, (a) => sonicWave(p, a.ang)]],
      });
    },

    // Q — Drain: channelled beam, heals her.
    skill1(p, sk) {
      const DUR = 2.4;
      const tgt = drainTarget(p);
      sfx('hit_shadow', p.x, p.y, 0.6, 0.6);
      p._act({
        kind: 'channel', slot: 'skill1', toggle: true, noHoldCancel: true, dur: DUR, ang: tgt ? M.angle(p.x, p.y, tgt.x, tgt.y) : p.aim,
        cancelAt: 0.1, move: [0.45, 0.45], anim: ['channel', 'channel'], tgt, links: [], tickT: 0.12, healAcc: 0, healShowT: 0, lost: 0,
        update: (a, dt) => {
          if (!alive(a.tgt) || M.dist(p.x, p.y, a.tgt.x, a.tgt.y) > 280) a.tgt = drainTarget(p);
          if (!a.tgt) { a.lost += dt; if (a.lost > 0.3) p._endAct(false); return; }
          a.lost = 0;
          a.ang = M.angle(p.x, p.y, a.tgt.x, a.tgt.y);
          p.mp -= 5 * dt; if (p.mp <= 0) { p.mp = 0; p._endAct(false); return; }
          a.tickT -= dt;
          while (a.tickT <= 0 && p.act === a) { a.tickT += 0.2; drainTick(p, a); }
          a.healShowT -= dt;
          if (a.healShowT <= 0 && a.healAcc >= 1) { a.healShowT = 0.6; fx('number', p, a.healAcc, 'heal', false, false); a.healAcc = 0; }
        },
        end: (a) => {
          sk.cdLeft = sk.cd;
          if (a.healAcc >= 1) fx('number', p, a.healAcc, 'heal', false, false);
        },
      });
    },

    // E — Bat Swarm: dissolve and tear through a line.
    skill2(p) {
      const T = 0.3, D = T + 0.14;
      const ang = p.aim, dist = p.aimDist(175, 90);
      const sx = p.x, sy = p.y, ex = sx + Math.cos(ang) * dist, ey = sy + Math.sin(ang) * dist;
      const once = new Set(), pw = p.power(), lvl = p.mods.marcy_bat_bleed || 0;
      let px = sx, py = sy;
      p.noCollide = true; p.kx = 0; p.ky = 0;
      fx('burst', p.x, p.y, bodyZ(p, 0.4), 'shadow', 24);
      sfx('bat', p.x, p.y, 0.9, 1); sfx('dodge', p.x, p.y, 0.5, 0.8);
      p.fxl.push(batCloud(p, 16, T + 0.12, 1));
      p._act({
        kind: 'skill', slot: 'skill2', dur: D, ang, lockUntil: T, cancelAt: T, move: [0, 0.6], anim: ['dodge', 'bat'], iframes: [0, T + 0.06],
        update: (a) => {
          if (a.t <= T) {
            if (!realRig(p)) p.rigHidden = true;
            const u = M.clamp(a.t / T, 0, 1), e = 1 - (1 - u) * (1 - u);
            C.move(p, M.lerp(sx, ex, e) - p.x, M.lerp(sy, ey, e) - p.y);
            p.vx = 0; p.vy = 0; p.kx = 0; p.ky = 0;
            C.hitLine(px, py, p.x, p.y, 18, 0, (t) => ({
              amount: pw * 1.15, type: 'shadow', source: p, knock: 140, dir: ang + (M.angleDiff(ang, M.angle(px, py, t.x, t.y)) > 0 ? 0.9 : -0.9), hitstop: 0.03, shake: 1.5,
              status: lvl ? { id: 'bleed', dur: 3, dps: pw * 0.12 * lvl, stacks: 2 } : null, tags: ['bats'],
            }), { once });
            px = p.x; py = p.y;
          } else if (!a.reformed) { a.reformed = true; Marceline._reform(p); }
        },
        end: (a) => { if (!a.reformed) Marceline._reform(p); p.noCollide = false; },
      });
    },
    _reform(p) { p.rigHidden = false; p.noCollide = false; fx('burst', p.x, p.y, bodyZ(p, 0.4), 'shadow', 14); sfx('bat', p.x, p.y, 0.4, 0.8); },

    // R — Shadow Queen
    ult(p) {
      const D = 0.7;
      p._act({
        kind: 'skill', slot: 'ult', dur: D, ang: p.aim, lockUntil: 0.4, cancelAt: 0.45, move: [0, 0.5], anim: ['cast', 'summon'], iframes: [0, 0.5],
        events: [[0.25, () => {
          p.queenT = 6; p.queenTick = 0;
          if (p.mods.marcy_queen_heal) C.heal(p, p.maxHp * 0.3);
          HM.Heroes.recompute(p);
          fx('burst', p.x, p.y, bodyZ(p, 0.4), 'shadow', 50); fx('ring', p.x, p.y, 10, 150, 0.5, HOT.queen);
          fx('light', p.x, p.y, 20, 160, [0.8, 0.1, 0.25], 1.5, 0.4); fx('shake', 6);
          if (HM.R && HM.R.flash) HM.R.flash(0.35, 0, 0.08, 0.4);
          sfx('shriek', p.x, p.y, 1, 0.7); sfx('bossRoar', p.x, p.y, 0.5, 1.5);
          bark(p, ['Kneel, little things.', 'Run. It helps.', 'The night was always mine.'][Math.floor(rnd(0, 3))], 1.6);
          Marceline._fear(p, true);
        }]],
      });
    },
    _fear(p, burst) {
      const pw = p.power();
      for (const a of C.queryCircle(p.x, p.y, 150, 0)) {
        a.fearT = Math.max(a.fearT || 0, 1.2); a.fearFrom = p;
        C.applyStatus(a, 'weaken', { dur: 2, src: p });
        if (!a.isBoss) { const ang = M.angle(p.x, p.y, a.x, a.y); const k = (burst ? 320 : 110) / Math.max(0.5, a.mass || 1); a.kx += Math.cos(ang) * k; a.ky += Math.sin(ang) * k; }
        if (burst) C.damage(a, { amount: pw * 0.8, type: 'shadow', source: p, hitstop: 0.04, shake: 0, knock: 0 });
      }
    },

    update(p, dt) {
      // she floats: the full rig lifts her (def.float); on the stub rig we lift her ourselves
      if (!realRig(p)) p.z = M.damp(p.z, 7 + Math.sin(p.t * 2.3) * 1.8, 8, dt);
      if (p.queenT > 0) {
        p.queenT -= dt;
        p.sizeMul = M.damp(p.sizeMul, 1.35, 8, dt);
        p.queenTick -= dt;
        if (p.queenTick <= 0) { p.queenTick = 0.4; Marceline._fear(p, false); fx('burst', p.x + rnd(-10, 10), p.y + rnd(-6, 6), rnd(10, 50), 'shadow', 3); }
        if (p.queenT <= 0) { p.queenT = 0; HM.Heroes.recompute(p); fx('burst', p.x, p.y, bodyZ(p, 0.4), 'shadow', 20); sfx('bat', p.x, p.y, 0.5, 0.7); }
      } else if (p.sizeMul !== 1) p.sizeMul = Math.abs(p.sizeMul - 1) < 0.01 ? 1 : M.damp(p.sizeMul, 1, 8, dt);
      applyRigScale(p);
    },

    draw(p) {
      const R = HM.R; if (!R) return;
      const a = p.act;
      if (a && a.kind === 'channel' && alive(a.tgt)) {
        const h = joint(p, 'handR', [p.x + Math.cos(a.ang) * 9, p.y + Math.sin(a.ang) * 9, bodyZ(p, 0.5)]);
        drawDrainBeam(R, h[0], h[1], h[2], a.tgt.x, a.tgt.y, (a.tgt.height || 40) * 0.55, 1);
        for (const l of a.links) if (alive(l)) drawDrainBeam(R, a.tgt.x, a.tgt.y, (a.tgt.height || 40) * 0.55, l.x, l.y, (l.height || 40) * 0.55, 0.65);
      }
      if (p.queenT > 0) {
        const t = HM.Game.t || 0, k = M.clamp(p.queenT / 0.4, 0, 1);
        R.ring(p.x, p.y, 30, 10, (i, u, ci, cj) => {
          if (((ci * 3 + cj * 7 + Math.floor(t * 14)) % 4) !== 0) return;
          if (R.setI(i, gi(((ci + cj) & 1) ? '~' : '-'), 0.55 * k, 0.04, 0.12 * k, R.KEY_DECAL + 30, R.F_UNLIT)) R.emitI(i, 0.22 * k, 0.01, 0.05 * k);
        });
        R.light(p.x, p.y, 20, 90, 0.7, 0.05, 0.18, 0.75 * k);
      }
    },
  };

  // The rig owns its scale; we only multiply it while Shadow Queen is active.
  function applyRigScale(p) {
    const r = p.rig; if (!r || typeof r !== 'object') return;
    if (p._rigScale0 === undefined) p._rigScale0 = typeof r.scale === 'number' ? r.scale : null;
    if (p._rigScale0 !== null) r.scale = p._rigScale0 * p.sizeMul;
  }

  function drainTick(p, a) {
    const pw = p.power();
    const hit = (t, mul) => {
      const info = C.damage(t, { amount: pw * 0.34 * mul, type: 'shadow', source: p, isDot: true, canCrit: false, numColor: 'shadow', tags: ['drain'] });
      if (info && info.dealt > 0) { t.flashT = Math.max(t.flashT, 0.05); const h = C.heal(p, info.dealt * 0.75, { silent: true }); a.healAcc += h; }
      fx('burst', t.x, t.y, (t.height || 40) * 0.5, 'blood', 2);
    };
    hit(a.tgt, 1);
    a.links = [];
    if (p.mods.marcy_drain_chain && alive(a.tgt)) {
      const near = C.queryCircle(a.tgt.x, a.tgt.y, 120, 0).filter((t) => t !== a.tgt).sort((u, v) => M.dist2(u.x, u.y, a.tgt.x, a.tgt.y) - M.dist2(v.x, v.y, a.tgt.x, a.tgt.y));
      a.links = near.slice(0, 2);
      for (const l of a.links) hit(l, 0.6);
    }
  }
  function drawDrainBeam(R, x0, y0, z0, x1, y1, z1, k) {
    const t = HM.Game.t || 0;
    const d = M.dist(x0, y0, x1, y1), n = Math.max(4, Math.ceil(d / 4));
    const nx = -(y1 - y0) / (d || 1), ny = (x1 - x0) / (d || 1);
    const chars = '~-=~*';
    for (let s = 0; s <= n; s++) {
      const u = s / n, taper = Math.sin(u * Math.PI);
      const w = Math.sin(u * 22 - t * 16) * 3.2 * taper;
      const x = M.lerp(x0, x1, u) + nx * w, y = M.lerp(y0, y1, u) + ny * w, z = M.lerp(z0, z1, u) + Math.sin(u * 13 + t * 11) * 2 * taper;
      const q = R.proj(x, y, z);
      const pulse = 0.65 + 0.35 * Math.sin(u * 30 + t * 24);
      R.glowGlyph(q[0], q[1], gi(chars[(s + Math.floor(t * 20)) % chars.length]), 0.95 * k * pulse, 0.08 * k, 0.16 * k, y + 4, 0.55 * k);
    }
    // blood motes flowing back toward her
    for (let m = 0; m < 5; m++) {
      const u = 1 - ((t * 1.7 + m / 5) % 1);
      const x = M.lerp(x0, x1, u), y = M.lerp(y0, y1, u), z = M.lerp(z0, z1, u) + 3;
      const q = R.proj(x, y, z);
      R.glowGlyph(q[0], q[1], gi(m & 1 ? 'o' : '*'), 1.2 * k, 0.25 * k, 0.25 * k, y + 5, 0.9 * k);
    }
    R.light(x1, y1, z1, 46, 0.9, 0.05, 0.12, 0.6 * k);
    R.light(x0, y0, z0, 34, 0.9, 0.05, 0.12, 0.4 * k);
  }

  function sonicWave(p, ang) {
    const once = new Set(), pw = p.power();
    const R0 = 14, R1 = 182, T = 0.34, half = 0.6;
    const ox = p.x + Math.cos(ang) * 6, oy = p.y + Math.sin(ang) * 6;
    const stun = p.mods.marcy_chord_stun ? { id: 'stun', dur: 0.8 } : null;
    sfx('sonic', p.x, p.y, 1, 1); fx('shake', 2.5);
    fx('burst', ox + Math.cos(ang) * 10, oy + Math.sin(ang) * 10, bodyZ(p, 0.4), 'shadow', 6);
    C.zone({
      x: ox, y: oy, r: 1, team: 0, life: T + 0.22, tick: 99, kind: 'sonic', source: p, ang, half, rad: R0,
      update: (z) => {
        const u = Math.min(1, z.t / T);
        z.rad = R0 + (R1 - R0) * M.easeOutCubic(u);
        if (z.t > T + 0.02) return;
        C.hitArc(ox, oy, ang, half, z.rad, 0, (t) => ({
          amount: pw * 1.0, type: 'phys', source: p, knock: 400 * (1 - 0.4 * u), dir: M.angle(ox, oy, t.x, t.y), hitstop: 0.03, shake: 1.5, numColor: 'shadow', tags: ['sonic'],
          status: stun ? [{ id: 'weaken', dur: 4 }, stun] : [{ id: 'weaken', dur: 4 }],
        }), { once });
        const P = game().projectiles;
        if (P) for (const pr of P) {
          if (pr.dead || pr.team === 0) continue;
          const d = M.dist(ox, oy, pr.x, pr.y);
          if (d <= z.rad && Math.abs(M.angleDiff(ang, M.angle(ox, oy, pr.x, pr.y))) <= half + 0.1) { C.expire(pr); fx('burst', pr.x, pr.y, pr.z || 20, 'spark', 5); }
        }
      },
      draw: drawSonic,
    });
  }
  function drawSonic(z) {
    const R = HM.R; if (!R) return;
    const fade = M.clamp(1 - (z.t - 0.25) / 0.3, 0, 1);
    const t = z.t;
    const C0 = HOT.sonic;
    for (let b = 0; b < 4; b++) {
      const rr = z.rad - b * 9; if (rr < 10) continue;
      const k = (1 - b * 0.24) * fade;
      const span = z.half * (1 - b * 0.06), step = 4.2 / rr;
      for (let a = z.ang - span; a <= z.ang + span; a += step) {
        const x = z.x + Math.cos(a) * rr, y = z.y + Math.sin(a) * rr, h = 12 + Math.sin(a * 9 + t * 30 + b) * 3.5;
        const q = R.proj(x, y, h), ca = Math.cos(a);
        let g;
        if (b === 0 && Math.abs(ca) > 0.45) g = gi(ca > 0 ? ')' : '(');           // the leading edge reads as sound
        else if (b === 2 && ((a * 40) | 0) % 3 === 0) g = gi('°');
        else g = R.dirGlyph(-Math.sin(a), ca * HM.cfg.TILT);
        R.glowGlyph(q[0], q[1], g, C0[0] * k, C0[1] * k, C0[2] * k, y + 3, 0.7 * k);
      }
    }
    if (fade > 0) R.light(z.x + Math.cos(z.ang) * z.rad * 0.6, z.y + Math.sin(z.ang) * z.rad * 0.6, 10, 70, 0.6, 0.45, 1, 0.5 * fade);
  }

  // ==================================================================================================
  // FLAME PRINCESS
  // ==================================================================================================
  // the wand tip's height (clamped to the body) — bolts leave the wand, not the knees
  function castZ(p) { const t = tipOf(p); const z = t && isFinite(t[2]) ? t[2] : bodyZ(p, 0.55); return M.clamp(z, bodyZ(p, 0.3), bodyZ(p, 0.85)); }
  function fireBolt(p, ang, o) {
    o = o || {};
    const split = !o.child && ++p.boltCount % 3 === 0;
    const sp = 540, x = o.x !== undefined ? o.x : p.x + Math.cos(ang) * 12, y = o.y !== undefined ? o.y : p.y + Math.sin(ang) * 12;
    C.projectile({
      x, y, z: o.z !== undefined ? o.z : castZ(p), vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, r: 5, team: 0, life: o.life || 0.72,
      look: 'ember', scale: o.child ? 0.45 : 0.6, color: COL.fire, light: [46, 1, 0.5, 0.15], source: p,
      damage: () => p._fireSpec(o.child ? 0.6 : 0.85, { knock: 70, hitstop: 0.025, shake: 0.8, tags: ['bolt'] }),
      update: split ? (q) => {
        if (q.t >= 0.11 && !q.dead) {
          C.expire(q);
          for (const da of [-0.28, 0, 0.28]) fireBolt(p, ang + da, { child: true, x: q.x, y: q.y, z: q.z, life: 0.5 });
          fx('burst', q.x, q.y, q.z, 'ember', 8); fx('light', q.x, q.y, q.z, 60, COL.fire, 1.2, 0.12);
          sfx('fire', q.x, q.y, 0.4, 1.6);
        }
      } : undefined,
      onHit: (t, q) => { fx('burst', q.x, q.y, q.z, 'ember', 6); C.igniteAt(q.x, q.y, 14, p); },
      onWall: (q) => fx('burst', q.x, q.y, q.z, 'ember', 5),
    });
  }

  function volleyOrb(p, ang) {
    const sp = 320;
    C.projectile({
      x: p.x + Math.cos(ang) * 14, y: p.y + Math.sin(ang) * 14, z: jointZ(p, 'handR', 0.55), vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, r: 8, team: 0, life: 1.05,
      look: 'fireball', scale: 1, color: COL.fire, light: [80, 1, 0.55, 0.18], source: p,
      damage: () => p._fireSpec(1.2, { knock: 160, hitstop: 0.04, shake: 2, tags: ['fireball'] }),
      onExpire: (q) => {
        C.hitCircle(q.x, q.y, 38, 0, () => p._fireSpec(0.7, { knock: 200, hitstop: 0.02, shake: 0, tags: ['fireball', 'aoe'] }));
        C.igniteAt(q.x, q.y, 42, p);
        fx('explosion', q.x, q.y, 38, 'fire'); fx('ring', q.x, q.y, 6, 44, 0.3, HOT.fire);
        fx('light', q.x, q.y, 10, 100, COL.fire, 1.6, 0.25); fx('decal', q.x, q.y, 'scorch', 20, 6);
        fx('shake', 2); sfx('explode', q.x, q.y, 0.6, 1.1 + rnd(-0.08, 0.08));
      },
    });
  }

  function meteor(p, tx, ty, pw, wild) {
    const T = 0.55, H = 300;
    fx('telegraph', { shape: 'circle', x: tx, y: ty, r: 38, dur: T, color: COL.fire });
    const ox = 80, oy = -50;
    C.projectile({
      x: tx + ox, y: ty + oy, z: H, vx: -ox / T, vy: -oy / T, vz: -H / T, gravity: 1e-4, r: 0, team: 0, life: T + 0.6, pierce: 1e9, ghost: true,
      damage: null, source: p, look: 'fireball', color: COL.fire,
      onGround: () => {
        C.hitCircle(tx, ty, 42, 0, () => p._fireSpec(2.4, { knock: 240, hitstop: 0.04, shake: 3, tags: ['meteor'] }));
        C.igniteAt(tx, ty, 46, p);
        fx('explosion', tx, ty, 42, 'fire'); fx('decal', tx, ty, 'scorch', 32, 9); fx('ring', tx, ty, 6, 50, 0.3, HOT.fire);
        fx('light', tx, ty, 10, 130, COL.fire, 2, 0.3); fx('burst', tx, ty, 4, 'ember', 16); fx('shake', 3.5);
        sfx('explode', tx, ty, 0.8, 0.8 + rnd(-0.1, 0.1));
        fireZone(p, tx, ty, 28, wild ? 4 : 3, 0.3);
      },
      draw: (q) => {
        const R = HM.R; if (!R) return;
        const P0 = R.proj(q.x, q.y, q.z);
        const vx = q.vx, vyp = q.vy * HM.cfg.TILT - q.vz; const vl = Math.hypot(vx, vyp) || 1;
        const ux = -vx / vl, uy = -vyp / vl;
        const trail = '@#*+:\'..';
        for (let k = 0; k < trail.length; k++) {
          const f = 1 - k / trail.length;
          const c = k < 2 ? COL.fireHot : COL.fire;
          R.glowGlyph(P0[0] + ux * k * 5.5, P0[1] + uy * k * 5.5, gi(trail[k]), c[0] * (0.5 + f), c[1] * f, c[2] * f, q.y + 60, 0.9 * f);
        }
        R.light(q.x, q.y, q.z, 70, 1, 0.5, 0.15, 0.8);
      },
    });
  }

  const FlamePrincess = {
    comboLen: () => 3,
    // LMB — Flame Bolt (hold to keep casting)
    attack(p) {
      const D = 0.25 / atkSpeed(p);
      p.addTemper(1);
      p._act({
        kind: 'attack', slot: 'attack', dur: D, ang: p.aim, cancelAt: D * 0.4, chainAt: D * 0.62, move: [0.55, 0.8], anim: ['attack', 'shoot'],
        update: (a) => { if (a.t < D * 0.35) a.ang = p.aim; },
        events: [[D * 0.35, (a) => { a.ang = p.aim; fireBolt(p, a.ang); sfx('fire', p.x, p.y, 0.35, 1.4 + rnd(-0.1, 0.1)); fx('burst', p.x + Math.cos(a.ang) * 12, p.y + Math.sin(a.ang) * 12, castZ(p), 'ember', 3); }]],
      });
    },
    // RMB — Fireball Volley
    heavy(p) {
      const D = 0.46 / castSpeed(p);
      const five = !!p.mods.fp_volley5, n = five ? 5 : 3, spread = five ? 0.5 : 0.3;
      const events = [];
      const order = five ? [2, 1, 3, 0, 4] : [1, 0, 2];
      order.forEach((k, j) => events.push([D * 0.3 + j * 0.035, (a) => { volleyOrb(p, a.ang + (k / (n - 1) - 0.5) * 2 * spread); if (j === 0) { sfx('fireball', p.x, p.y, 0.9, 1); fx('light', p.x, p.y, bodyZ(p, 0.4), 90, COL.fire, 1.2, 0.15); } }]));
      p._act({
        kind: 'skill', slot: 'heavy', dur: D + n * 0.035, ang: p.aim, cancelAt: D * 0.3 + n * 0.035 + 0.02, move: [0.3, 0.7], anim: ['cast', 'forward'],
        update: (a) => { if (a.t < D * 0.3) a.ang = p.aim; },
        events,
      });
    },
    // Q — Fire Fissure (FX.fissure draws it; damage lands on onErupt, with a fallback if FX never calls back).
    skill1(p) {
      const D = 0.5 / castSpeed(p);
      p._act({
        kind: 'skill', slot: 'skill1', dur: D, ang: p.aim, cancelAt: D * 0.5, move: [0.15, 0.6], anim: ['cast', 'forward'],
        update: (a) => { if (a.t < D * 0.34) a.ang = p.aim; },
        events: [[D * 0.34, (a) => fissure(p, a.ang)]],
      });
    },
    // E — Flame Ring aura (zone kind 'flamering', drawn by FX.drawZone)
    skill2(p) {
      const D = 0.36 / castSpeed(p);
      p._act({
        kind: 'skill', slot: 'skill2', dur: D, ang: p.aim, cancelAt: D * 0.5, move: [0.4, 0.8], anim: ['cast', 'raise'],
        events: [[D * 0.3, () => {
          if (p.ring && !p.ring.dead) p.ring.life = 0;
          const lvl = p.mods.fp_ring_bigger || 0;
          const r = 70 * (1 + 0.4 * Math.min(1, lvl) + 0.15 * Math.max(0, lvl - 1));
          p.ring = C.zone({
            x: p.x, y: p.y, r, team: 0, life: 6, tick: 0.33, kind: 'flamering', source: p, owner: p,
            update: (z) => { z.x = p.x; z.y = p.y; if (p.dead) z.life = 0; },
            onTick: (z, inside) => {
              const pw = p.power();
              for (const a of inside) C.damage(a, { amount: pw * 0.32, type: 'fire', source: p, canCrit: true, hitstop: 0, shake: 0, knock: 30, dir: M.angle(z.x, z.y, a.x, a.y), status: { id: 'burn', dur: 2, dps: pw * 0.2 }, tags: ['ring'] });
              C.igniteAt(z.x, z.y, z.r, p);
            },
          });
          fx('ring', p.x, p.y, 10, r, 0.35, HOT.fire); fx('burst', p.x, p.y, 10, 'ember', 24);
          fx('light', p.x, p.y, 20, r * 1.8, COL.fire, 1.4, 0.3);
          sfx('fire', p.x, p.y, 0.9, 0.8); sfx('fireball', p.x, p.y, 0.4, 0.6);
        }]],
      });
    },
    // R — Cinder Rain
    ult(p) {
      const D = 0.62;
      const cx = p.x + Math.cos(p.aim) * p.aimDist(260, 0), cy = p.y + Math.sin(p.aim) * p.aimDist(260, 0);
      p._act({
        kind: 'skill', slot: 'ult', dur: D, ang: p.aim, lockUntil: 0.3, cancelAt: 0.34, move: [0, 0.6], anim: ['cast', 'raise'],
        events: [[0.2, () => {
          const pw = p.power(), wild = p.wildfire, n = wild ? 12 : 10;
          sfx('fire', p.x, p.y, 1, 0.6); fx('burst', p.x, p.y, bodyZ(p, 0.5), 'ember', 30); fx('light', p.x, p.y, bodyZ(p, 0.4), 120, COL.fire, 1.5, 0.4);
          bark(p, ['Fall, stars of my house.', 'Burn it all down.', 'Let the sky catch fire.'][Math.floor(rnd(0, 3))], 1.4);
          for (let i = 0; i < n; i++) {
            const delay = i === 0 ? 0 : 0.08 + (i / n) * 1.5 + rnd(-0.05, 0.05);
            const rr = i === 0 ? 0 : Math.sqrt(HM.rng.next()) * 120, aa = rnd(0, TAU);
            const tx = cx + Math.cos(aa) * rr, ty = cy + Math.sin(aa) * rr;
            const go = () => meteor(p, tx, ty, pw, wild);
            if (delay <= 0) go(); else if (game().after) game().after(delay, go); else go();
          }
        }]],
      });
    },

    update(p, dt) {
      // Temper cools when idle; Wildfire burns her.
      if (p.wildfireT > 0) {
        p.wildfireT -= dt;
        p.hp = Math.max(1, p.hp - p.maxHp * 0.03 * dt);
        p.resource.value = 100 * M.clamp(p.wildfireT / p.wildfireDur, 0, 1);
        p.resource.name = 'WILDFIRE'; p.resource.color[0] = 1; p.resource.color[1] = 0.8; p.resource.color[2] = 0.3;
        p._emberT -= dt;
        if (p._emberT <= 0) { p._emberT = 0.05; fx('burst', p.x + rnd(-8, 8), p.y + rnd(-5, 5), rnd(10, 50), 'ember', 2); }
        if (p.wildfireT <= 0) {
          p.wildfireT = 0; p.temper = 0; p.temperIdle = 0;
          fx('burst', p.x, p.y, bodyZ(p, 0.4), 'smoke', 14); sfx('fire', p.x, p.y, 0.5, 0.5);
          fx('text', p.x, p.y, p.height + 16, 'smoldering', [0.7, 0.5, 0.4], 0.8);
        }
      } else {
        p.temperIdle += dt;
        if (p.temperIdle > 1.2 && p.temper > 0) {
          const cool = 8 * (1 + 0.5 * Math.min(1, p.mods.fp_temper_cool || 0));
          p.temper = Math.max(0, p.temper - cool * dt);
        }
        p.resource.value = p.temper; p.resource.name = 'Temper';
        p.resource.color[0] = 1; p.resource.color[1] = 0.3 + 0.25 * (p.temper / 100); p.resource.color[2] = 0.08;
        p._emberT -= dt;
        if (p._emberT <= 0) { p._emberT = 0.22 - 0.15 * (p.temper / 100); fx('burst', p.x + rnd(-4, 4), p.y + rnd(-3, 3), p.height - 6 + rnd(0, 8), 'ember', 1); }
      }
      p.resource.max = 100;
    },

    draw(p) {
      const R = HM.R; if (!R) return;
      const t = HM.Game.t || 0;
      const heat = p.wildfire ? 1 : p.temper / 100;
      const flick = 0.85 + 0.15 * Math.sin(t * 17) * Math.sin(t * 7.3);
      const base = realRig(p) ? 0 : 0.55; // the full rig already lights her; Temper makes her burn brighter
      if (base + heat > 0.02) R.light(p.x, p.y, bodyZ(p, 0.35), (60 + 70 * heat + (p.wildfire ? 50 : 0)) * flick, 1, 0.48, 0.14, (base + 0.55 * heat + (p.wildfire ? 0.4 : 0)) * flick);
      if (p.wildfire) {
        for (let k = 0; k < 16; k++) {
          const life = (t * 1.6 + k * 0.137) % 1;
          const ang = (k / 16) * TAU + t * 1.3;
          const rr = 11 - life * 5;
          const x = p.x + Math.cos(ang) * rr, y = p.y + Math.sin(ang) * rr * 0.75, z = 4 + life * 54 + p.z;
          const q = R.proj(x, y, z);
          const g = life < 0.25 ? '#' : life < 0.5 ? '*' : life < 0.75 ? '+' : "'";
          const c = life < 0.35 ? COL.fireHot : COL.fire, f = 1 - life * 0.7;
          R.glowGlyph(q[0], q[1], gi(g), c[0] * f, c[1] * f, c[2] * f, y + (Math.sin(ang) > 0 ? 2 : -2), 0.9 * f);
        }
      }
      if (p.kindled) {
        const tip = tipOf(p), q = R.proj(tip[0], tip[1], tip[2]);
        R.glowGlyph(q[0], q[1], gi('*'), COL.fireHot[0], COL.fireHot[1], COL.fireHot[2], tip[1] + 3, 0.8);
      }
    },
  };

  function fissure(p, ang) {
    const five = !!p.mods.fp_fissure5;
    const prongs = five ? 5 : 3, spread = five ? 0.82 : 0.52, len = 215;
    const x = p.x + Math.cos(ang) * 14, y = p.y + Math.sin(ang) * 14;
    const pw = p.power(), once = new Set();
    let erupted = false, igniteN = 0;
    const erupt = (pts) => {
      const list = flatPoints(pts);
      if (!list.length) return;
      erupted = true;
      for (let i = 0; i < list.length; i++) {
        const q = list[i];
        C.hitCircle(q[0], q[1], 22, 0, () => p._fireSpec(2.0, { knock: 110, dir: M.angle(x, y, q[0], q[1]), hitstop: 0.05, shake: 2.5, tags: ['fissure'] }), { once });
        if ((igniteN++ & 1) === 0) C.igniteAt(q[0], q[1], 24, p);
      }
    };
    fx('fissure', { x, y, ang, prongs, spread, len, color: COL.fire, onErupt: erupt });
    sfx('fire', p.x, p.y, 0.8, 0.6); sfx('bone_break', x, y, 0.4, 0.5); fx('shake', 2);
    fx('light', x + Math.cos(ang) * 80, y + Math.sin(ang) * 80, 10, 160, COL.fire, 0.6, 0.3);
    // Fallback: if FX never erupts (stub / missing), erupt along our own prong lines.
    const fallback = () => {
      if (erupted || p.dead) return;
      const pts = [];
      for (let k = 0; k < prongs; k++) {
        const a = ang + (prongs === 1 ? 0 : (k / (prongs - 1) - 0.5) * 2 * spread);
        for (let d = 24; d <= len; d += 22) { const qx = x + Math.cos(a) * d, qy = y + Math.sin(a) * d; if (solid(qx, qy)) break; pts.push([qx, qy]); }
      }
      erupt(pts);
      for (let i = 0; i < pts.length; i += 2) fx('burst', pts[i][0], pts[i][1], 6, 'ember', 6);
      sfx('explode', x, y, 0.6, 0.9); fx('shake', 4);
    };
    if (game().after) game().after(0.9, fallback); else fallback();
  }

  const KITS = { finn: Finn, marceline: Marceline, fp: FlamePrincess };

  // ==================================================================================================
  // Global listeners: crit explosions, perfect dodges
  // ==================================================================================================
  if (HM.Events && HM.Events.on) {
    HM.Events.on('damage', (info) => {
      const p = game().player;
      if (!p || p.dead || !info || !info.crit || info.isDot) return;
      if (info.source !== p && !(info.source && info.source.owner === p)) return;
      const lvl = p.mods && p.mods.crit_explode; if (!lvl) return;
      if (info.tags && info.tags.includes('critx')) return;
      const t = info.target, r = 30 + 8 * lvl, pw = p.power();
      C.hitCircle(t.x, t.y, r, 0, (a) => (a === t ? null : { amount: pw * 0.45 * lvl, type: 'fire', source: p, canCrit: false, knock: 140, hitstop: 0, shake: 0, tags: ['critx'] }));
      C.igniteAt(t.x, t.y, r, p);
      fx('explosion', t.x, t.y, r, 'fire'); fx('light', t.x, t.y, 10, 80, COL.fire, 1.2, 0.15);
      sfx('explode', t.x, t.y, 0.45, 1.3);
    });
    HM.Events.on('evade', (e) => {
      const p = game().player;
      if (!p || e.target !== p || !p.act || p.act.kind !== 'dodge' || p._perfect) return;
      if (!e.spec || e.spec.isDot) return;
      p._perfect = true;
      // perfect dodge: a beat of slow motion and a refunded charge
      if (game().slowmo) game().slowmo(0.22, 0.5);
      if (p.dodgeCharges < p.dodgeMax) p.dodgeRecharge = Math.min(p.dodgeRecharge, 0.15);
      fx('text', p.x, p.y, p.height + 22, 'perfect', [0.85, 0.95, 1], 0.9);
      fx('ring', p.x, p.y, 6, 30, 0.2, [1.4, 1.6, 2]);
      sfx('ui_select', p.x, p.y, 0.4, 1.6);
    });
  }

  // ==================================================================================================
  // Public API
  // ==================================================================================================
  const list = ['finn', 'marceline', 'fp'].map((id) => {
    const d = HEROES[id];
    return {
      id, name: d.name, title: d.title, blurb: d.blurb, color: d.color.slice(), difficulty: d.difficulty, portrait: d.portrait.slice(),
      resource: d.resource.name, stats: { hp: d.base.hp, mp: d.base.mp, speed: d.base.speed },
      passive: Object.assign({}, d.passive),
      kit: d.skills.map((s) => ({ slot: s.slot, name: s.name, icon: s.icon, desc: s.desc, cd: s.cd, cost: s.cost })).concat([{ slot: 'passive', name: d.passive.name, icon: '+', desc: d.passive.desc }]),
    };
  });

  function heirloomsApply(p, run) {
    const Meta = HM.Meta; if (!Meta) return;
    if (typeof Meta.applyToPlayer === 'function') { call('Meta', 'applyToPlayer', [p, run]); return; }
    if (typeof Meta.applyPlayer === 'function') { call('Meta', 'applyPlayer', [p, run]); return; }
    if (!Array.isArray(Meta.list) || typeof Meta.level !== 'function') return;
    for (const h of Meta.list) {
      const scope = h.scope || h.target || h.applies || 'player';
      if (scope !== 'player' || typeof h.apply !== 'function') continue;
      let lv = 0; try { lv = Meta.level(h.id) || 0; } catch (e) { lv = 0; }
      if (lv > 0) { try { h.apply(p, lv, run); } catch (e) { if (!warned.has('heir' + h.id)) { warned.add('heir' + h.id); console.error('[heroes] heirloom ' + h.id, e); } } }
    }
  }

  function applyHeroBase(p, s) {
    const b = p.def.base;
    s.armor = (s.armor || 0) + b.armor;
    s.critChance = Math.max(s.critChance || 0, 0) + (b.crit - 0.05);
    s.mpRegen = (s.mpRegen || 0) + b.mpRegen;
    s.regen = (s.regen || 0) + (b.regen || 0);
    s.leech = (s.leech || 0) + (b.leech || 0);
    if (!s.res) s.res = { phys: 0, fire: 0, ice: 0, poison: 0, shadow: 0, holy: 0 };
    s.res.fire = (s.res.fire || 0) + (b.fireRes || 0);
    if (!s.elemMul) s.elemMul = { phys: 1, fire: 1, ice: 1, poison: 1, shadow: 1, holy: 1 };
    if (s.maxHp === undefined) s.maxHp = 0;
    if (s.maxMp === undefined) s.maxMp = 0;
    if (s.maxHpMul === undefined) s.maxHpMul = 1;
    if (s.power === undefined) s.power = 0;
  }

  const Heroes = (HM.Heroes = {
    list, defs: HEROES, kits: KITS, Player, Jake,
    get: (id) => HEROES[id] || null,

    createPlayer(run) {
      run = run || {};
      const p = new Player(run.heroId, run);
      p.weapon = Object.assign({}, p.def.weapon);
      if (HM.Rig && HM.Rig.create) call('Rig', 'create', [p, p.def.rig, { weapon: p.weapon }]);
      Heroes.recompute(p);
      p.hp = run.hp !== null && run.hp !== undefined && isFinite(run.hp) ? M.clamp(run.hp, 1, p.maxHp) : p.maxHp;
      p.mp = p.def.temper ? 0 : run.mp !== null && run.mp !== undefined && isFinite(run.mp) ? M.clamp(run.mp, 0, p.maxMp) : p.maxMp;
      p.resource.value = p.def.temper ? 0 : p.mp; p.resource.max = p.def.temper ? 100 : p.maxMp;
      p.facing = -Math.PI / 2 + 0.6; p.aim = p.facing;
      return p;
    },

    // base hero stats + level growth + items + boons + heirlooms + temporary buffs. Keeps hp/mp proportion.
    recompute(p) {
      if (!p || !p.def) return;
      const def = p.def, b = def.base;
      const run = p.run || game().run || null;
      const lvl = (run && run.level) || 1;
      const hp01 = p.maxHp > 0 ? M.clamp(p.hp / p.maxHp, 0, 1) : 1;
      const mp01 = p.maxMp > 0 ? M.clamp(p.mp / p.maxMp, 0, 1) : 1;
      p.stats = HM.Actor.baseStats();
      applyHeroBase(p, p.stats);
      p.maxHp = b.hp + b.hpLv * (lvl - 1);
      p.maxMp = b.mp + b.mpLv * (lvl - 1);
      p.speed = b.speed;
      p.mods = {};
      p.weapon = Object.assign({}, def.weapon); p.weaponDmg = def.dmg.slice(); p.weaponElement = null;
      const s0 = p.stats;
      call('Items', 'applyStats', [p]);
      if (p.stats !== s0) applyHeroBase(p, p.stats); // Items replaced the stats object: re-apply hero innate stats
      call('Boons', 'apply', [p, run]);
      heirloomsApply(p, run);
      const s = p.stats;
      // temporary buffs
      if (p.queenT > 0) { s.dmgMul *= 1.4; s.leech += 0.25; }
      // clamps
      s.cdr = M.clamp(s.cdr || 0, 0, 0.6);
      s.critChance = M.clamp(s.critChance, 0, 0.9);
      s.moveMul = M.clamp(s.moveMul || 1, 0.5, 2);
      s.leech = M.clamp(s.leech || 0, 0, 0.6);
      s.res.fire = Math.min(0.85, s.res.fire || 0);
      p.maxHp = Math.max(1, Math.round((p.maxHp + (s.maxHp || 0)) * (s.maxHpMul || 1)));
      p.maxMp = def.temper ? 0 : Math.max(0, Math.round(p.maxMp + (s.maxMp || 0)));
      p.hp = Math.max(p.dead ? 0 : 1, Math.min(p.maxHp, p.maxHp * hp01));
      p.mp = def.temper ? 0 : p.maxMp * mp01;
      for (const sk of p.skills) sk.cd = sk.baseCd * (1 - s.cdr);
      p.dodgeMax = p.mods.dodge_charges2 ? 2 : 1;
      if (p.dodgeCharges > p.dodgeMax) p.dodgeCharges = p.dodgeMax;
      if (p.dodgeCharges < p.dodgeMax && p.dodgeRecharge <= 0) p.dodgeRecharge = DODGE_RECHARGE;
      if (!def.temper) { p.resource.value = p.mp; p.resource.max = p.maxMp; }
      if (p.rig && typeof p.rig === 'object') p.rig.weapon = p.weapon;
      return p;
    },

    onLevelUp(p, run) {
      if (!p) return;
      if (run) p.run = run;
      Heroes.recompute(p);
      C.heal(p, p.maxHp * 0.25);
      if (!p.def.temper) p.mp = p.maxMp;
      // (FX's own 'levelup' listener draws the gold ring / holy burst / light; UI toasts — only the floater lives here)
      fx('text', p.x, p.y, p.height + 26, 'LEVEL ' + ((run && run.level) || ''), COL.gold, 1.3);
    },
  });
})();
