// tutorial.js — the Prologue, "The Tree Fort Clearing" (floor 0). DESIGN §9A.
// One verb per beat, learned by doing, gated by the level; just-in-time keycap prompts (HM.UI.prompt, by ACTION name so
// remapped keys show correctly) that fade once performed. Every beat has a hint timeout and a hard fallback, so the
// prologue can never softlock; pause → "Skip Prologue" (UI) calls HM.Tutorial.skip().
//
//   intro → move → interact → attack → dodge → heavy → skills → potion → ult → read → door → (descend) floor 1
//
// World supplies the hand-authored map: World.generate({prologue:true}) → F.isPrologue, F.beats{start, lanterns[], sword,
// dummies[3], sentinel, gap{x,y,w}, barricade, pack[3], trap, captain, page, door}. If World lacks it, Game hands us an
// ordinary grass floor and we lay the beats out along the start→exit line ourselves (fallback; it never crashes).
// The prologue is a sandbox: kills give no XP/loot/bestiary, the player cannot die, and the run is rebuilt fresh for floor 1.
(function () {
  'use strict';
  const Math = globalThis.Math;
  const HM = (globalThis.window || globalThis).HM;
  const M = HM.M;
  const G = () => HM.Game;
  const TAU = Math.PI * 2;

  // ------------------------------------------------------------------------------------------- text (fallbacks)
  // Lore (ui-story) owns the real text: HM.Lore.prologue + HM.Lore.beat(id, heroId). These are only used if it is missing.
  const FB = {
    title: 'The Tree Fort Clearing', sub: 'before the descent', speaker: 'BMO', speakerTitle: 'the last little console',
    bmo: [
      'You are awake! Good. BMO has been keeping the lanterns lit.',
      'The Lich drank from the Well of Power. Now Ooo is going dark from the edges inward.',
      'Your weapon is waiting by the Tree Fort door. Then: down. All the way down.',
    ],
    bmoEnd: ['The door is open now. Go down. BMO will leave the porch light on.'],
    beats: {
      move: { text: 'Move', sub: 'follow the lanterns to the Tree Fort' },
      interact: { text: 'Interact', sub: 'take your weapon from the Tree Fort door' },
      attack: { text: 'Attack', sub: 'break the three training husks' },
      combo: { text: 'Keep swinging: hits chain into a combo', sub: 'hold the button to keep going' },
      dodge: { text: 'Roll THROUGH the attack', sub: 'you are untouchable mid-roll · wait for the ring to fill, then go' },
      heavy: { text: 'Heavy attack', sub: 'shatter the bone barricade' },
      skills: { text: 'Skills', sub: 'they cost MP and recharge · watch the hotbar sweep' },
      skill1: { text: 'Skill', sub: 'your first trick' },
      skill2: { text: 'Skill', sub: 'your second trick' },
      potion: { text: 'Bacon Pancakes', sub: 'eat one to heal · you carry only a few' },
      ult: { text: 'Ultimate', sub: 'your biggest move · it charges slowly' },
      read: { text: 'Read the page', sub: 'the Enchiridion keeps whatever it is given' },
      door: { text: 'Descend', sub: 'the Dungeon Door is open · floor 1 waits below' },
    },
    page: { id: 'ench_prologue', source: 'Enchiridion, the first page', title: 'For Whoever Holds This Next',
      text: 'The Lich has drunk from the Well, and the world drains toward him from the edges in. There is no army left to send, so the book sends you. Go down.' },
  };
  // hero-specific expression-space tip after both skills have been used (Lore may override via prologue.synergy[heroId])
  const SYNERGY = {
    finn: { text: 'Synergy', sub: 'root a crowd with Grass Vines, then Leap Slam into it · rooted foes cannot dodge the landing' },
    marceline: { text: 'Synergy', sub: 'Bat Swarm through the pack to scatter it, then Drain the straggler · what you drink, you keep' },
    fp: { text: 'Synergy', sub: 'roll through your own Flame Ring to become Kindled · your attacks burn hotter while it lasts' },
  };
  const OBJ = {
    intro: ['Wake up', 'BMO has something to tell you'],
    move: ['Follow the lanterns to the Tree Fort', 'the lit path leads to the door'],
    interact: ['Take your weapon from the Tree Fort door', 'walk up to it and interact'],
    attack: ['Break the training husks', 'three bramble-bound dummies'],
    dodge: ['Get past the Bone Sentinel', 'roll through its slam — mid-roll you are untouchable'],
    heavy: ['Shatter the bone barricade', 'light hits only chip it'],
    skills: ['Destroy the risen thralls', 'use your skills'],
    potion: ['Press on toward the old camp', 'mind your footing'],
    ult: ['Defeat the Bone Captain', 'it is too strong to face alone'],
    read: ['Read the Enchiridion page', 'it lies near the Dungeon Door'],
    door: ['Descend through the Dungeon Door', 'floor 1 waits below'],
  };

  function lore() { return (HM.Lore && HM.Lore.prologue) || FB; }
  function heroId() { const p = G().player; return (p && p.heroId) || (G().run && G().run.heroId) || 'finn'; }
  function beatText(id) {
    if (HM.Lore && typeof HM.Lore.beat === 'function') { const b = HM.Lore.beat(id, heroId()); if (b && b.text && b.text !== id) return b; }
    const P = lore(); const b = (P.beats && P.beats[id]) || FB.beats[id] || { text: id, sub: '' };
    const o = (b.byHero && b.byHero[heroId()]) || {};
    return { text: o.text || b.text, sub: o.sub !== undefined ? o.sub : b.sub };
  }

  // ------------------------------------------------------------------------------------------- small helpers
  function fx(name, a, b, c, d, e, f, g) { const F = HM.FX; if (F && typeof F[name] === 'function') return F[name](a, b, c, d, e, f, g); return null; }
  function sfx(name, x, y, vol, pitch) { if (HM.Audio && HM.Audio.play) HM.Audio.play(name, { x, y, vol, pitch }); }
  function ui(name, a, b, c, d) { const U = HM.UI; if (U && typeof U[name] === 'function') return U[name](a, b, c, d); return undefined; }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const pt = (o) => (o && typeof o.x === 'number' && typeof o.y === 'number' ? { x: o.x, y: o.y } : null);
  function pts(arr, n) { if (!Array.isArray(arr)) return null; const out = arr.map(pt).filter(Boolean); return out.length >= (n || 1) ? out : null; }
  function dialogueOpen() { const U = HM.UI; return !!(U && (U.dialogueOpen || U.actCardOpen)); }
  function promptAPI() { const U = HM.UI; return !!(U && typeof U.prompt === 'function' && typeof U.clearPrompt === 'function'); }
  function recompute(p) { if (HM.Heroes && HM.Heroes.recompute) HM.Heroes.recompute(p); else if (HM.Items && HM.Items.applyStats) HM.Items.applyStats(p); }
  function skill(p, slot) { return p && p.skills ? p.skills.find((s) => s.slot === slot) || null : null; }
  function affordable(p, sk) { return !!sk && (sk.costType === 'temper' || !sk.cost || p.mp >= sk.cost); }
  function usable(p, sk) { return !!sk && sk.cdLeft <= 0 && affordable(p, sk); }
  function alive(list) { let n = 0; for (const a of list) if (a && !a.dead) n++; return n; }
  function nearestAlive(list, p) { let best = null, bd = 1e9; for (const a of list) if (a && !a.dead) { const d = dist(a, p); if (d < bd) { bd = d; best = a; } } return best; }
  function openNear(F, x, y, minR, maxR, rng) {
    const W = HM.World;
    if (W && W.randomOpenPoint) { const q = W.randomOpenPoint(rng || HM.rng, F, x, y, minR || 0, maxR || 60); if (q) return { x: q[0], y: q[1] }; }
    return { x, y };
  }

  // Prologue foes die without credit: just before death they leave team 1 (and lose elite status), so neither Game nor
  // the UI's kill handler counts them (no First Blood / ELITE SLAIN toast for a straw dummy).
  function noCredit(a) {
    if (!a || a._noCredit) return a; a._noCredit = true;
    const ob = a.onBeforeDeath;
    a.onBeforeDeath = function (info) { if (typeof ob === 'function' && ob.call(this, info) === false) return false; this.team = 3; this.isElite = false; return undefined; };
    return a;
  }

  const LOCKABLE = ['attack', 'heavy', 'dodge', 'skill1', 'skill2', 'ult', 'potion1', 'potion2'];
  // verbs unlocked when each beat begins (cumulative)
  const UNLOCK = { attack: ['attack'], dodge: ['dodge'], heavy: ['heavy'], skills: ['skill1', 'skill2'], potion: ['potion1', 'potion2'], ult: ['ult'] };
  const BEAT_IDS = ['intro', 'move', 'interact', 'attack', 'dodge', 'heavy', 'skills', 'potion', 'ult', 'read', 'door'];
  const STRAW = { candy: [0.86, 0.7, 0.36], mint: [0.98, 0.88, 0.56], rot: [0.44, 0.3, 0.13], body: [0.8, 0.62, 0.3], legs: [0.5, 0.35, 0.16], drip: [0.95, 0.82, 0.46] };
  const SENTINEL_PAL = { bone: [0.95, 0.92, 0.82], metal: [0.38, 0.4, 0.46], banner: [0.42, 0.06, 0.05], banner2: [0.2, 0.03, 0.02], eye: [1.4, 0.4, 0.12], eyeE: 1.3, emblem: [1.2, 0.35, 0.1] };
  const TEAL = [0.5, 0.95, 0.85];

  // ============================================================================================ actors
  // Training husk: straw dummy on the husk rig. Immobile, harmless, team 1 so it gets a name tag / target frame /
  // minimap dot (prologue kills never count — Game._onKill skips the prologue floor).
  class Dummy extends HM.Actor {
    constructor(x, y, hp) {
      super({ kind: 'enemy', team: 1, defId: 'dummy', name: 'Training Husk', x, y, radius: 10, mass: 60, height: 70, hp, maxHp: hp, speed: 0 });
      this.anchored = true; this.isDummy = true; this.xpValue = 0; this.goldDrop = [0, 0]; this.level = 1; this.prologue = true;
      this.facing = Math.PI / 2; this.aim = this.facing;
      if (HM.Rig && HM.Rig.create) HM.Rig.create(this, 'husk', { colors: STRAW, weapon: { kind: 'none' } });
      this.weapon = { kind: 'none' };
    }
    update(dt) {
      this.vx = 0; this.vy = 0; this.kx *= 0.3; this.ky *= 0.3;
      const p = G().player; if (p && !this.dead) { this.facing += M.angleDiff(this.facing, M.angle(this.x, this.y, p.x, p.y)) * Math.min(1, dt * 2); this.aim = this.facing; }
      HM.Combat.baseUpdate(this, dt);
    }
    onDamaged(info) { if (!info.isDot && HM.FX) fx('burst', this.x, this.y, 30, 'dust', 4, { color: STRAW.drip }); }
    onDeath() { fx('burst', this.x, this.y, 26, 'dust', 16, { color: STRAW.mint }); fx('burst', this.x, this.y, 10, 'dust', 10, { color: STRAW.legs }); sfx('bone_break', this.x, this.y, 0.5, 1.3); }
    draw() {
      HM.Actor.prototype.draw.call(this);
      if (this.dead) return;
      // brambles binding the feet (sparse dark stroke glyphs, so the straw body keeps its own dense texture)
      const R = HM.R, py = this.y * HM.cfg.TILT;
      const g1 = R.gi('%'), g2 = R.gi('&'), g3 = R.gi('\\'), g4 = R.gi('/');
      R.set(this.x - 9, py - 1, g4, 0.22, 0.3, 0.12, this.y + 1, R.F_PROP);
      R.set(this.x - 4, py + 2, g1, 0.26, 0.34, 0.14, this.y + 1.5, R.F_PROP);
      R.set(this.x + 5, py + 2, g2, 0.24, 0.32, 0.12, this.y + 1.5, R.F_PROP);
      R.set(this.x + 10, py - 1, g3, 0.22, 0.3, 0.12, this.y + 1, R.F_PROP);
    }
  }

  // Bone Sentinel: a huge, slow knight that slams the gap on a fixed rhythm with a long line telegraph along the passage.
  // Invulnerable; crumbles when the player rolls through a slam (Tutorial._slam decides).
  class Sentinel extends HM.Actor {
    constructor(x, y, gap, dir) {
      // it stands IN the gap's choke, its body filling the opening: nobody walks past it; it must be rolled under
      const R0 = M.clamp((gap.w || 60) / 2 - 3, 18, 44);
      super({ kind: 'enemy', team: 1, defId: 'sentinel', name: 'Bone Sentinel', x, y, radius: R0, mass: 999, height: 150, hp: 999, maxHp: 999, speed: 0 });
      this.invuln = true; this.anchored = true; this.isSentinel = true; this.xpValue = 0; this.goldDrop = [0, 0]; this.level = 3; this.prologue = true;
      this.gap = gap; this.dir = dir; this.phase = 'idle'; this.cycleT = 0; this.teleDur = 1.8; this.restDur = 0.7; this.swung = false; this.slams = 0;
      this.len = 190; this.w = Math.max(64, Math.min(130, (gap.w || 90) * 0.9 + 14));
      // the slam zone: the approach in front of it, back the way you came, reaching in under its feet (so anyone
      // pressed against its body is inside)
      const c = Math.cos(dir), s = Math.sin(dir), front = (x - gap.x) * c + (y - gap.y) * s + this.radius * 0.4;
      this.c = { x: gap.x + c * (front - this.len / 2), y: gap.y + s * (front - this.len / 2) };
      this.title = 'it guards the gap';
      this.facing = M.angle(x, y, this.c.x, this.c.y); this.aim = this.facing;
      this.weapon = { kind: 'sword', material: 'bloodiron' };
      if (HM.Rig && HM.Rig.create) HM.Rig.create(this, 'knight', { scale: 1.32, colors: SENTINEL_PAL, weapon: this.weapon });
    }
    // seconds until the next detonation (the harness bot and the prompt read this)
    get nextSlamIn() { return this.phase === 'tele' ? this.teleDur - this.cycleT : this.phase === 'rest' ? this.restDur - this.cycleT + this.teleDur : 99; }
    line() { const c = Math.cos(this.dir), s = Math.sin(this.dir), h = this.len / 2; return [this.c.x - c * h, this.c.y - s * h, this.c.x + c * h, this.c.y + s * h]; }
    contains(a, pad) {
      const c = Math.cos(this.dir), s = Math.sin(this.dir), dx = a.x - this.c.x, dy = a.y - this.c.y;
      const along = dx * c + dy * s, perp = -dx * s + dy * c;
      return Math.abs(along) <= this.len / 2 + (pad || 0) && Math.abs(perp) <= this.w / 2 + (a.radius || 8) + (pad || 0);
    }
    update(dt) {
      this.vx = 0; this.vy = 0; this.kx = 0; this.ky = 0;
      if (!this.dead) {
        const p = G().player, T = HM.Tutorial;
        const armed = T.active && T.beatId === 'dodge' && p && !p.dead;
        if (this.phase === 'idle') { if (armed && dist(p, this.gap) < 380) this._tele(); }
        else {
          this.cycleT += dt;
          if (this.phase === 'tele') {
            if (!this.swung && this.cycleT >= this.teleDur - 0.34) { this.swung = true; if (HM.Rig && HM.Rig.setAnim) HM.Rig.setAnim(this, 'attack', { dur: 0.95, variant: 'overhead' }); sfx('swing_heavy', this.x, this.y, 0.8, 0.6); }
            if (this.cycleT >= this.teleDur) { this.phase = 'rest'; this.cycleT = 0; this.slams++; T._slam(this); }
          } else if (this.phase === 'rest' && this.cycleT >= this.restDur) {
            if (armed && dist(p, this.gap) < 460) this._tele(); else this.phase = 'idle';
          }
        }
        this.aim = this.facing = M.angle(this.x, this.y, this.c.x, this.c.y);
      }
      HM.Combat.baseUpdate(this, dt);
    }
    _tele() {
      this.phase = 'tele'; this.cycleT = 0; this.swung = false;
      const L = this.line();
      this.tele = fx('telegraph', { shape: 'line', x: L[0], y: L[1], x1: L[2], y1: L[3], w: this.w, dur: this.teleDur, color: [1, 0.32, 0.12] });
      if (HM.Rig && HM.Rig.setAnim) HM.Rig.setAnim(this, 'cast', { dur: this.teleDur - 0.34, variant: 'raise' });
      if (this.slams % 2 === 0) sfx('bone_break', this.x, this.y, 0.35, 0.55);
    }
    crumble() {
      if (this.dead) return;
      if (this.tele && this.tele.cancel) this.tele.cancel();
      this.invuln = false;
      fx('burst', this.x, this.y, 60, 'bone', 34); fx('burst', this.x, this.y, 10, 'dust', 30, { r: 20 });
      sfx('bone_break', this.x, this.y, 1, 0.7); sfx('death_big', this.x, this.y, 0.6, 1.2);
      HM.Combat.kill(this, { source: null, dir: this.dir + Math.PI, collapse: true });
    }
  }

  // Bone barricade proxy: an anchored, hittable stand-in for the World's barricade prop (or our own drawing in the
  // fallback). Light hits only chip it; any player damage within ~1.8 s of a heavy (or a heavy aimed at it from close)
  // shatters it.
  class Barricade extends HM.Actor {
    constructor(x, y, r, worldDrawn) {
      super({ kind: 'enemy', team: 1, defId: 'barricade', name: 'Bone Barricade', x, y, radius: r, mass: 9999, height: 44, hp: 100, maxHp: 100, speed: 0 });
      this.anchored = true; this.rig = false; this.worldDrawn = worldDrawn; this.isBarricade = true; this.prologue = true;
      this.xpValue = 0; this.goldDrop = [0, 0]; this.broken = false; this.chipT = 0; this.chips = 0; this.title = 'blades only chip it';
    }
    update(dt) { this.vx = 0; this.vy = 0; this.kx = 0; this.ky = 0; this.chipT -= dt; this.statuses.length = 0; HM.Combat.baseUpdate(this, dt); }
    onDamaged(info) { info.amount = 0; HM.Tutorial._barricadeHit(this, info); }
    draw() {
      if (this.worldDrawn || this.broken || this.dead) return;
      const R = HM.R, px = this.x, py = this.y * HM.cfg.TILT;
      const lines = ['  \\ |  / ', ' =O=#=O= ', '/%#@B@#%\\', '#8%=@=%8#'];
      R.sprite(px, py, lines, (c, ch) => { const hi = ch === 'O' || ch === '@'; const k = hi ? 1.0 : ch === '=' || ch === '|' ? 0.75 : 0.62; c[0] = 0.92 * k; c[1] = 0.88 * k; c[2] = 0.76 * k; }, this.y, R.F_PROP);
      R.shadowEllipse && R.shadowEllipse(this.x, this.y + 2, this.radius + 6, 7, 0.4);
    }
  }

  // ============================================================================================ beats
  // Each beat: enter(st), update(st, dt) → true when done, goal(st) → {x,y}|null, force(st) (hard fallback), hintT / autoT.
  const BEATS = {
    intro: {
      autoT: 75,
      enter(st) { st.openAt = 0.9; },
      update(st) {
        if (!st.opened && T.bt >= st.openAt) {
          st.opened = true; st.openedT = T.bt;
          const P = lore(); const lines = P.bmo && P.bmo.length ? P.bmo : FB.bmo;
          if (HM.UI && typeof HM.UI.dialogue === 'function') {
            T.dlgPending = true;
            ui('dialogue', { speaker: P.speaker || 'BMO', title: P.speakerTitle || '', lines: lines.slice(), npc: 'bmo', color: '#7fd6c0', onDone: () => { st.done = true; T.dlgPending = false; } });
          } else { T._toastLines(lines); st.done = true; }
        }
        // safety: dialogue closed without calling onDone
        if (st.opened && !st.done && T.bt - st.openedT > 1 && HM.UI && HM.UI.dialogueOpen === false && !HM.UI.dlg) st.done = true;
        return !!st.done;
      },
      force(st) { if (HM.UI && HM.UI.dialogueOpen && HM.UI.closeDialogue) HM.UI.closeDialogue(true); st.done = true; T.dlgPending = false; },
      goal() { return null; },
    },

    move: {
      hintT: 18, autoT: 60,
      enter(st) { st.moveT = 0; T._prompt('tut', ['up', 'left', 'down', 'right'], beatText('move'), 'bottom'); T._bmo('move'); },
      update(st, dt) {
        const p = G().player; if (!p) return false;
        if (Math.hypot(p.vx, p.vy) > 25) st.moveT += dt;
        const L = T.B.lanterns, l2 = L[Math.min(1, L.length - 1)];
        return st.moveT >= 2 || dist(p, l2) < 60;
      },
      hint() { T._prompt('tut', ['up', 'left', 'down', 'right'], { text: 'Move', sub: 'walk along the lantern path · the minimap shows the way' }, 'bottom'); },
      force() {},
      goal() { const p = G().player, L = T.B.lanterns; for (const l of L) if (p && dist(p, l) > 70 && l.y < p.y + 20) return l; return T.B.sword; },
    },

    interact: {
      hintT: 35, autoT: 160,
      enter(st) { T._spawnSword(); T._bmo('interact'); st.shown = false; },
      update(st) {
        const p = G().player, run = G().run; if (!p || !run) return false;
        const I = run.inventory, eq = I && I.equipped;
        if (eq && eq.weapon) return true;
        const pk = T.ents.sword;
        if (pk && (pk.dead || pk.used)) { T._equipStash(); return true; }
        const near = pk && dist(p, pk) < 150;
        if (near && !st.shown) { st.shown = true; const b = beatText('interact'); T._prompt('tut', ['interact'], { text: b.text, sub: T.weaponName ? 'take ' + T.weaponName : b.sub }, 'bottom'); }
        else if (!near && st.shown && pk && dist(p, pk) > 230) { st.shown = false; T._clear('tut'); }
        return false;
      },
      hint() { T._prompt('tut', ['interact'], { text: 'Take your weapon', sub: 'it glows by the Tree Fort door · walk up and interact' }, 'bottom'); },
      force() { const pk = T.ents.sword; if (pk) { pk.dead = true; pk.used = true; } T._equipStash(); },
      goal() { return T.ents.sword && !T.ents.sword.dead ? T.ents.sword : T.B.sword; },
    },

    attack: {
      hintT: 45, autoT: 170,
      enter(st) { st.hit = false; T._prompt('tut', ['attack'], beatText('attack'), 'bottom'); T._bmo('attack'); },
      update(st) {
        const D = T.ents.dummies;
        if (!st.hit && D.some((d) => d.hp < d.maxHp - 0.01 || d.dead)) {
          st.hit = true; T._clear('tut');
          T._prompt('tut2', ['attack'], beatText('combo'), 'bottom'); st.comboAt = T.bt;
        }
        if (st.hit && st.comboAt !== undefined && T.bt - st.comboAt > 7) { T._clear('tut2'); st.comboAt = undefined; }
        return alive(D) === 0;
      },
      hint() { T._prompt('tut', ['attack'], { text: 'Attack', sub: 'aim with the mouse at a husk and click · hold to keep swinging' }, 'bottom'); },
      force() { for (const d of T.ents.dummies) if (!d.dead) HM.Combat.kill(d, { source: null }); },
      goal() { const p = G().player; return (p && nearestAlive(T.ents.dummies, p)) || T.B.dummies[0]; },
    },

    dodge: {
      hintT: 50, autoT: 130,
      enter(st) { st.hits = 0; st.shown = false; T._bmo('dodge'); },
      update(st) {
        const p = G().player, s = T.ents.sentinel; if (!p) return false;
        if (!s || s.dead) return true;
        if (st.evaded) { if (!st.crumbleT) { st.crumbleT = T.bt; T._clear('tut'); T._clear('tut2'); fx('text', p.x, p.y, (p.height || 60) + 22, 'UNTOUCHABLE', [0.75, 1, 0.95], 1.5); sfx('boon', p.x, p.y, 0.8, 1.2); if (G().slowmo) G().slowmo(0.45, 0.35); } if (T.bt - st.crumbleT > 0.55) { s.crumble(); return true; } return false; }
        const near = dist(p, s.gap) < 300;
        if (near && !st.shown) { st.shown = true; T._prompt('tut', ['dodge'], beatText('dodge'), 'bottom'); }
        // slipped past without rolling (no wall in a fallback map, or a hit-and-push) — count it, but say how
        const c = Math.cos(s.dir), sn = Math.sin(s.dir), along = (p.x - s.c.x) * c + (p.y - s.c.y) * sn;
        if (along > s.len / 2 + 40) { st.slipped = true; ui('toast', 'You slipped past. Next time, ROLL through the slam: ' + HM.Input.actionLabel('dodge') + '.', '#9fe0d0', 3.6); s.crumble(); return true; }
        return false;
      },
      hint(st) { T._prompt('tut2', ['dodge'], { text: 'Timing', sub: 'stand at the edge · when the ring is nearly full, roll INTO it' }, 'center'); st.hinted = true; },
      force() { const s = T.ents.sentinel; if (s && !s.dead) s.crumble(); },
      goal() { return T.ents.sentinel && !T.ents.sentinel.dead ? T.ents.sentinel.c : T.B.gap; },
    },

    heavy: {
      hintT: 40, autoT: 130,
      enter(st) { st.shown = false; T._bmo('heavy'); },
      update(st) {
        const p = G().player, b = T.ents.barricade; if (!p) return false;
        if (!b || b.broken) return true;
        if (!st.shown && dist(p, b) < 220) { st.shown = true; T._prompt('tut', ['heavy'], beatText('heavy'), 'bottom'); }
        // a heavy aimed at the barricade from close range shatters it, even if the hit lands on the World prop first
        const a = p.act;
        if (a && a.slot === 'heavy' && !a.charging && a.t >= (a.dur || 0.4) * 0.3) {
          const d = dist(p, b), reach = p.heroId === 'fp' ? 300 : p.heroId === 'marceline' ? 170 : 120;
          if (d < reach + b.radius && Math.abs(M.angleDiff(p.aim, M.angle(p.x, p.y, b.x, b.y))) < 0.75) T._shatter(b);
        }
        if (b.chips >= 14 && T.bt > 30) T._shatter(b); // never softlock on a hero whose heavy misses
        return !!b.broken;
      },
      hint() { T._prompt('tut', ['heavy'], { text: 'Heavy attack', sub: 'face the barricade, then press (or hold and release) ' + HM.Input.actionLabel('heavy') }, 'bottom'); },
      force() { const b = T.ents.barricade; if (b && !b.broken) T._shatter(b); },
      goal() { return T.ents.barricade && !T.ents.barricade.broken ? T.ents.barricade : T.B.barricade; },
    },

    skills: {
      hintT: 60, autoT: 200,
      enter(st) {
        st.used1 = false; st.used2 = false; st.respawns = 0; st.tipAt = -1; st.shown = 0;
        const p = G().player; if (p) { if (p.maxMp > 0) p.mp = p.maxMp; for (const s of p.skills || []) if (s.slot === 'skill1' || s.slot === 'skill2') s.cdLeft = 0; }
        T.ents.pack = T.B.pack.map((q, k) => T._spawnThrall(q.x, q.y, k));
        T._bmo('skills');
      },
      update(st) {
        const p = G().player; if (!p) return false;
        const a = p.act;
        if (a && a.slot === 'skill1' && !st.used1) { st.used1 = true; T._clear('tut'); }
        if (a && a.slot === 'skill2' && !st.used2) { st.used2 = true; T._clear('tut'); }
        const s1 = skill(p, 'skill1'), s2 = skill(p, 'skill2');
        const foe = nearestAlive(T.ents.pack, p), close = foe && dist(foe, p) < 320;
        if (!st.used1 && st.shown !== 1 && close && usable(p, s1)) { st.shown = 1; T._prompt('tut', ['skill1'], T._skillText('skill1', s1), 'bottom'); }
        else if (st.used1 && !st.used2 && st.shown !== 2 && close && usable(p, s2)) { st.shown = 2; T._prompt('tut', ['skill2'], T._skillText('skill2', s2), 'bottom'); }
        if (st.used1 && st.used2 && st.tipAt < 0) { st.tipAt = T.bt; T._clear('tut'); T._prompt('tut2', [], T._synergy(), 'center'); }
        if (st.tipAt >= 0 && T.bt - st.tipAt > 7) T._clear('tut2');
        // keep MP flowing for the lesson
        if (p.maxMp > 0 && (!st.used1 || !st.used2)) p.mp = Math.max(p.mp, Math.min(p.maxMp, 40));
        if (alive(T.ents.pack) === 0) {
          if ((st.used1 && st.used2) || st.respawns >= 3) return st.tipAt < 0 || T.bt - st.tipAt > 1.2;
          // the lesson isn't done: another one claws its way up
          if (!st.respawnAt) st.respawnAt = T.bt + 0.8;
          else if (T.bt >= st.respawnAt) { st.respawnAt = 0; st.respawns++; const q = openNear(T.F, p.x + Math.cos(p.aim) * 110, p.y + Math.sin(p.aim) * 110, 0, 60); T.ents.pack.push(T._spawnThrall(q.x, q.y, 9)); }
        }
        return false;
      },
      hint() { const p = G().player; T._prompt('tut', ['skill1', 'skill2'], { text: 'Skills', sub: 'press ' + HM.Input.actionLabel('skill1') + ' and ' + HM.Input.actionLabel('skill2') + ' near the thralls · the hotbar shows when they are ready' }, 'bottom'); void p; },
      force() { for (const e of T.ents.pack) if (e && !e.dead) HM.Combat.kill(e, { source: null }); },
      goal() { const p = G().player; return (p && nearestAlive(T.ents.pack, p)) || T.B.pack[0]; },
    },

    potion: {
      hintT: 999, autoT: 150,
      enter(st) { st.sprung = false; },
      update(st, dt) {
        const p = G().player, run = G().run; if (!p || !run) return false;
        const trap = T.B.trap, d = dist(p, trap);
        if (!st.sprung && (d < 52 || (T.bt > 25 && d < 280) || T.bt > 70)) { T._springTrap(trap); st.sprung = true; st.sprungAt = T.bt; st.cnt = (run.consumables && run.consumables.pancake) || 0; st.hp0 = p.hp; T._prompt('tut', ['potion1'], beatText('potion'), 'bottom'); T._bmo('potion'); }
        if (!st.sprung) return false;
        const cnt = (run.consumables && run.consumables.pancake) || 0;
        if (cnt < st.cnt) st.ate = true;
        if (st.ate) { st.eatT = (st.eatT || 0) + dt; return st.eatT > 0.6; }
        if (T.bt - st.sprungAt > 22 && !st.hinted2) { st.hinted2 = true; T._prompt('tut', ['potion1'], { text: 'Bacon Pancakes', sub: 'press ' + HM.Input.actionLabel('potion1') + ' to eat one · it heals over two seconds' }, 'center'); }
        return false;
      },
      force() { const p = G().player; if (p) HM.Combat.heal(p, p.maxHp); },
      goal(st) { return st.sprung ? null : T.B.trap; },
    },

    ult: {
      hintT: 45, autoT: 210,
      enter(st) {
        st.used = false; st.shown = false; st.capHits = 0;
        T.ents.captain = T._spawnCaptain(T.B.captain);
        T._chargeUlt();
        T._bmo('ult');
      },
      update(st) {
        const p = G().player, c = T.ents.captain; if (!p) return false;
        const a = p.act;
        if (!st.used && a && a.slot === 'ult') { st.used = true; T._clear('tut'); T._clear('tut2'); if (c && !c.dead) c.stats.dmgTakenMul = 2.2; }
        if (!st.used) {
          T._chargeUlt();
          if (!st.shown && c && !c.dead && dist(c, p) < 330) { st.shown = true; T._prompt('tut', ['ult'], beatText('ult'), 'bottom'); }
          if (st.capHits >= 5 && !st.toldHits) { st.toldHits = true; T._prompt('tut2', ['ult'], { text: 'Its bones are too thick', sub: 'call for help · press ' + HM.Input.actionLabel('ult') }, 'center'); }
        }
        return !c || c.dead;
      },
      hint(st) { if (!st.used) T._prompt('tut', ['ult'], { text: beatText('ult').text, sub: 'aim at the Bone Captain and press ' + HM.Input.actionLabel('ult') }, 'bottom'); },
      force() { const c = T.ents.captain; if (c && !c.dead) HM.Combat.kill(c, { source: null }); },
      goal() { const c = T.ents.captain; return c && !c.dead ? c : T.B.captain; },
    },

    read: {
      hintT: 45, autoT: 260,
      enter(st) { st.phase = 'wait'; st.shown = false; T._spawnPage(); T._bmo('read'); },
      update(st) {
        const p = G().player; if (!p) return false;
        const pg = T.ents.page;
        if (st.phase === 'wait') {
          if (pg && !st.shown && dist(p, pg) < 150) { st.shown = true; T._prompt('tut', ['interact'], beatText('read'), 'bottom'); }
          if (T.pageRead) { st.phase = 'bmo'; st.bmoAt = T.bt + 0.35; T._clear('tut'); }
          return false;
        }
        if (st.phase === 'bmo' && T.bt >= st.bmoAt) {
          st.phase = 'talk';
          const P = lore(); const lines = P.bmoEnd && P.bmoEnd.length ? P.bmoEnd : FB.bmoEnd;
          if (HM.UI && typeof HM.UI.dialogue === 'function') { st.talkT = T.bt; ui('dialogue', { speaker: P.speaker || 'BMO', title: P.speakerTitle || '', lines: lines.slice(), npc: 'bmo', color: '#7fd6c0', onDone: () => { st.talked = true; } }); }
          else { T._toastLines(lines); st.talked = true; }
        }
        if (st.phase === 'talk') {
          if (!st.talked && T.bt - st.talkT > 1 && HM.UI && HM.UI.dialogueOpen === false && !HM.UI.dlg) st.talked = true;
          if (!st.talked && T.bt - st.talkT > 90) { if (HM.UI && HM.UI.closeDialogue) HM.UI.closeDialogue(true); st.talked = true; }
          if (st.talked) { G().openExit('prologue'); return true; }
        }
        return false;
      },
      hint(st) { if (st.phase === 'wait') T._prompt('tut', ['interact'], { text: 'Read the page', sub: 'the glowing page near the door · walk up and interact' }, 'bottom'); },
      force() { T.pageRead = true; if (T.ents.page) T.ents.page.used = true; if (HM.UI && HM.UI.dialogueOpen && HM.UI.closeDialogue) HM.UI.closeDialogue(true); G().openExit('prologue'); },
      goal(st) { return st.phase === 'wait' ? T.ents.page || T.B.page : null; },
    },

    door: {
      hintT: 60,
      enter(st) { st.shown = false; if (T.F && !T.F.exitOpen) G().openExit('prologue'); },
      update(st) {
        const p = G().player, d = T.B.door; if (!p) return false;
        if (T.F && !T.F.exitOpen) G().openExit('prologue');
        if (!st.shown && dist(p, d) < 160) { st.shown = true; T._prompt('tut', ['interact'], beatText('door'), 'bottom'); }
        return false; // completes in Game.descend → Tutorial.finish
      },
      hint() { T._prompt('tut', ['interact'], { text: 'Descend', sub: 'the Dungeon Door is open · find it on the map (' + HM.Input.actionLabel('map') + ')' }, 'bottom'); },
      force() {},
      goal() { return T.B.door; },
    },
  };

  // ============================================================================================ Tutorial
  const T = (HM.Tutorial = {
    BEAT_IDS, Dummy, Sentinel, Barricade,
    active: false, finished: false, skipped: false,
    i: -1, beatId: null, beat: null, st: null, bt: 0, t: 0, log: [],
    F: null, B: null, run: null, ents: null, unlocked: new Set(),
    weaponItem: null, weaponName: '', pageRead: false, lastHeavyT: -9, denyT: 0, dlgPending: false,

    // Called by Game.enterPrologue after the floor, the player and the camera exist.
    start(run) {
      T.stop();
      const Gm = G(), F = Gm.floor, p = Gm.player;
      if (!F || !p) return false;
      T.active = true; T.finished = false; T.skipped = false; T.run = run; T.F = F;
      T.i = -1; T.beatId = null; T.beat = null; T.st = null; T.bt = 0; T.t = 0; T.log = [];
      T.unlocked = new Set(); T.pageRead = false; T.lastHeavyT = -9; T.denyT = 0; T.dlgPending = false; T._toasted = {};
      T.ents = { dummies: [], pack: [], sentinel: null, barricade: null, captain: null, sword: null, page: null };
      T.B = T._layout(F, p);
      F.isPrologue = true;
      F.objective = { type: 'tutorial', remaining: 1, done: false };
      // the weapon waits at the Tree Fort door: take it off the hero (fists until it is picked up)
      const I = run && run.inventory, eq = I && I.equipped;
      T.weaponItem = eq && eq.weapon ? eq.weapon : null;
      T.weaponName = T.weaponItem ? T.weaponItem.name || '' : '';
      if (T.weaponItem) { eq.weapon = null; recompute(p); }
      T._wrapPlayer(p);
      T._wire();
      // the cast stands in place from the start, so the path ahead reads before you reach it
      T.ents.dummies = T.B.dummies.slice(0, 3).map((q) => Gm.spawn(noCredit(new Dummy(q.x, q.y, 28))));
      T.ents.sentinel = Gm.spawn(noCredit(new Sentinel(T.B.sentinel.x, T.B.sentinel.y, T.B.gap, T.B.dir)));
      T.ents.barricade = Gm.spawn(new Barricade(T.B.barricade.x, T.B.barricade.y, T.B.barricadeR, T.B.worldBarricade));
      if (HM.Enemies && HM.Enemies.spawnSnail && T.B.snail) { try { HM.Enemies.spawnSnail(T.B.snail.x, T.B.snail.y, 1, 1, 0); } catch (e) { console.error(e); } }
      T._next();
      return true;
    },

    stop() {
      if (T.active) { T._clear('tut'); T._clear('tut2'); }
      T.active = false; T.beat = null; T.beatId = null;
      if (T.F) { T.F.objectiveText = null; T.F.objectiveSub = null; T.F.tutorialGoal = null; }
    },

    // Player reached the open Dungeon Door (Game.descend) or chose Skip Prologue.
    finish(skipped) {
      if (!T.active && T.finished) return;
      const id = T.beatId;
      if (!skipped && id) T.log.push({ id, t: T.t, done: true });
      T.skipped = !!skipped; T.finished = true;
      T.stop();
      const S = HM.Save;
      if (S && S.data && S.data.meta) { S.data.meta.prologueDone = true; if (skipped) S.data.meta.prologueSkipped = true; S.write(); }
      HM.Events.emit('tutorialDone', { skipped: !!skipped, log: T.log.slice() });
      const Gm = G();
      if (Gm && Gm.finishPrologue) Gm.finishPrologue();
    },
    skip() { if (T.active) T.finish(true); },

    isLocked(action) {
      if (!T.active) return false;
      if (dialogueOpen()) return true;
      return LOCKABLE.indexOf(action) >= 0 && !T.unlocked.has(action);
    },

    // ------------------------------------------------------------------------------------- frame
    update(dt) {
      if (!T.active || !T.beat) return;
      const Gm = G(), p = Gm.player; if (!p) return;
      T.t += dt; T.bt += dt; T.denyT = Math.max(0, T.denyT - dt);
      T._applyLocks();
      if (p.act && p.act.slot === 'heavy') T.lastHeavyT = Gm.t;
      // the hero cannot die here
      if (!p.dead && p.hp < p.maxHp * 0.22 && T.beatId !== 'potion') p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.25 * dt);
      const b = T.beat, st = T.st;
      if (b.hintT && !st._hinted && T.bt > b.hintT && b.hint) { st._hinted = true; b.hint(st); }
      let done = false;
      try { done = b.update(st, dt); } catch (e) { console.error(e); done = false; }
      if (!done && b.autoT && T.bt > b.autoT) { b.force(st); done = true; T.log.push({ id: T.beatId, t: T.t, forced: true }); }
      if (done) T._next();
      if (T.active && T.F) {
        const o = OBJ[T.beatId];
        if (o) { T.F.objectiveText = o[0]; T.F.objectiveSub = o[1]; }
        const g = T.beat && T.beat.goal ? T.beat.goal(T.st) : null;
        T.F.tutorialGoal = g ? { x: g.x, y: g.y } : null;
      }
    },

    // world-space guidance: a soft teal light where the current beat wants you (only when it is off at a distance),
    // plus our own lanterns in the fallback layout
    draw() {
      if (!T.active || !T.B) return;
      const R = HM.R, Gm = G(), p = Gm.player, t = Gm.t;
      if (T.B.fallback) {
        const gL = R.gi('*'), gP = R.gi('|'), gT = R.gi('^');
        for (const l of T.B.lanterns) {
          if (!R.inViewWorld(l.x, l.y, 80)) continue;
          const px = l.x, py = l.y * HM.cfg.TILT, f = 0.85 + 0.15 * Math.sin(t * 7 + l.x);
          R.set(px, py, gP, 0.35, 0.28, 0.2, l.y, R.F_PROP); R.set(px, py - 8, gP, 0.35, 0.28, 0.2, l.y, R.F_PROP);
          R.glowGlyph(px, py - 16, gL, 1.6 * f, 1.0 * f, 0.4 * f, l.y + 0.2, 0.9);
          R.set(px, py - 24, gT, 0.4, 0.32, 0.22, l.y, R.F_PROP);
          R.light(l.x, l.y, 22, 120, 1.0, 0.62, 0.28, 0.95 * f);
        }
      }
      const g = T.F && T.F.tutorialGoal;
      if (g && p && Math.hypot(g.x - p.x, g.y - p.y) > 150 && R.inViewWorld(g.x, g.y, 60)) {
        const k = 0.55 + 0.35 * Math.sin(t * 2.6);
        R.light(g.x, g.y, 18, 85, TEAL[0], TEAL[1], TEAL[2], 0.55 * k);
        const gd = R.gi('.'), py = g.y * HM.cfg.TILT;
        for (let m = 0; m < 8; m++) {
          const a = t * 0.9 + (m / 8) * TAU, rr = 22 + 3 * Math.sin(t * 3 + m);
          R.glowGlyph(g.x + Math.cos(a) * rr, py + Math.sin(a) * rr * HM.cfg.TILT - 2, gd, TEAL[0] * k, TEAL[1] * k, TEAL[2] * k, g.y - 0.5, 0.35);
        }
      }
    },

    // Game._onKill hands prologue kills here (nothing is counted; just a little feedback).
    onKill(e) { const a = e && e.target; if (a && a.isDummy) sfx('hit', a.x, a.y, 0.5, 0.7); },

    // ------------------------------------------------------------------------------------- testing
    // Jump straight to beat n (index into BEAT_IDS or an id): forces every beat before it and moves the hero there.
    debugJump(n) {
      if (!T.active) return false;
      const target = typeof n === 'string' ? BEAT_IDS.indexOf(n) : n | 0;
      if (target < 0) return false;
      let guard = 0;
      T._jumping = true;
      while (T.active && T.i < target && guard++ < 20) {
        if (T.i === target - 1) T._jumping = false; // only the beat we land on gets its BMO line
        T.beat.force(T.st); T.log.push({ id: T.beatId, t: T.t, forced: true, jump: true }); T._next();
      }
      T._jumping = false;
      const p = G().player, g = T.beat && T.beat.goal ? T.beat.goal(T.st) : null;
      const sen = T.ents && T.ents.sentinel;
      const at = T.beatId === 'dodge' && sen ? T._onLine(sen.c, sen.dir + Math.PI, sen.len / 2 + 26) : T.beatId === 'potion' ? T._approach(T.B.trap, 90) : g ? T._approach(g, 95) : null;
      if (p && at) { p.x = at.x; p.y = at.y; p.vx = p.vy = p.kx = p.ky = 0; G().cam.x = p.x; G().cam.y = p.y - 10; }
      return true;
    },
    // first open point from q along angle a at distance ≥ d (falls back to openNear)
    _onLine(q, a, d) {
      const W = HM.World;
      for (let k = 0; k < 12; k++) {
        const r = d + k * 8 * (k % 2 ? -1 : 1) * Math.ceil(k / 2) / Math.max(1, k), x = q.x + Math.cos(a) * r, y = q.y + Math.sin(a) * r;
        if (!W || !W.isSolid || !(W.isSolid(x, y) || W.isSolid(x + 9, y) || W.isSolid(x - 9, y) || W.isSolid(x, y + 9) || W.isSolid(x, y - 9))) return { x, y };
      }
      return openNear(T.F, q.x + Math.cos(a) * d, q.y + Math.sin(a) * d, 0, 30);
    },
    // a reachable open point ~`d` from `q`, on the side the previous beat lies (walls/forest are skipped)
    _approach(q, d) {
      const F = T.F, prev = T._prevPoint(), W = HM.World, nav = F && F.nav;
      let best = null, bs = 1e18;
      for (const dd of [d, d * 0.7, d * 1.4, d * 0.45]) {
        for (let k = 0; k < 24; k++) {
          const a = (k / 24) * TAU, x = q.x + Math.cos(a) * dd, y = q.y + Math.sin(a) * dd;
          if (!F || x < 20 || y < 20 || x > F.w - 20 || y > F.h - 20) continue;
          if (W && W.isSolid && (W.isSolid(x, y) || W.isSolid(x + 9, y) || W.isSolid(x - 9, y) || W.isSolid(x, y + 9) || W.isSolid(x, y - 9))) continue;
          if (nav && nav.dist) { const c = Math.floor(y / nav.gs) * nav.gw + Math.floor(x / nav.gs); if (!(nav.dist[c] >= 0)) continue; }
          const s = Math.hypot(x - prev.x, y - prev.y); if (s < bs) { bs = s; best = { x, y }; }
        }
        if (best) return best;
      }
      const a = M.angle(q.x, q.y, prev.x, prev.y);
      return openNear(F, q.x + Math.cos(a) * d, q.y + Math.sin(a) * d, 0, 40);
    },
    _prevPoint() {
      const B = T.B, id = T.beatId;
      const order = { move: B.start, interact: B.lanterns[B.lanterns.length - 1] || B.start, attack: B.sword, dodge: B.dummies[1] || B.sword, heavy: B.gap, skills: B.barricade, potion: B.pack[0] || B.barricade, ult: B.trap, read: B.captain, door: B.page };
      return order[id] || B.start;
    },

    // ------------------------------------------------------------------------------------- internals
    _next() {
      const Gm = G();
      if (T.beatId) {
        if (!T.log.length || T.log[T.log.length - 1].id !== T.beatId) {
          const info = {}; for (const k in T.st) { const v = T.st[k]; if (typeof v === 'boolean' || typeof v === 'number') info[k] = v; }
          T.log.push({ id: T.beatId, t: T.t, done: true, dur: T.bt, info });
        }
        HM.Events.emit('tutorialBeat', { id: T.beatId, index: T.i, done: true });
        T._clear('tut'); T._clear('tut2');
        const p = Gm.player;
        if (p && T.beatId !== 'intro' && T.beatId !== 'move') sfx('ui_select', p.x, p.y, 0.45, 1.25);
      }
      T.i++;
      if (T.i >= BEAT_IDS.length) { T.beat = null; T.beatId = null; return; }
      T.beatId = BEAT_IDS[T.i]; T.beat = BEATS[T.beatId]; T.st = {}; T.bt = 0;
      for (const a of UNLOCK[T.beatId] || []) T.unlocked.add(a);
      T.beat.enter(T.st);
      HM.Events.emit('tutorialBeat', { id: T.beatId, index: T.i, done: false });
    },

    _applyLocks() {
      const I = HM.Input; if (!I) return;
      for (const a of LOCKABLE) {
        if (!T.isLocked(a)) continue;
        if (I.wasPressed(a) && !dialogueOpen()) T._deny(a);
        delete I.lastPress[a];
      }
    },
    _deny(a) {
      if (T.denyT > 0) return; T.denyT = 0.9;
      const p = G().player; if (!p) return;
      const txt = (a === 'attack' || a === 'heavy') && !T.unlocked.has('attack') ? 'no weapon yet' : 'not yet';
      fx('text', p.x, p.y, (p.height || 60) + 16, txt, [0.7, 0.72, 0.78], 0.75);
      sfx('ui_error', p.x, p.y, 0.25);
    },

    // instance-level hooks on the prologue player (heroes.js stays untouched): verb locks run right before the
    // controller reads input, a held attack button can't punch before the weapon, and the hero cannot die.
    _wrapPlayer(p) {
      if (!p || p._tutWrapped) return; p._tutWrapped = true;
      if (typeof p._verbs === 'function') { const v = p._verbs; p._verbs = function () { if (T.active) T._applyLocks(); return v.call(this); }; }
      if (typeof p._startAttack === 'function') { const sa = p._startAttack; p._startAttack = function () { if (T.isLocked('attack')) return undefined; return sa.call(this); }; }
      if (typeof p._moveUpdate === 'function') { const mu = p._moveUpdate; p._moveUpdate = function (dt) { if (T.active && dialogueOpen()) { this.mvx *= 0.6; this.mvy *= 0.6; this.vx = this.mvx * this.speed; this.vy = this.mvy * this.speed; return undefined; } return mu.call(this, dt); }; }
      const obd = p.onBeforeDeath;
      p.onBeforeDeath = function (info) {
        if (typeof obd === 'function' && obd.call(this, info) === false) return false;
        if (!T.active) return undefined;
        this.hp = Math.max(1, Math.round(this.maxHp * 0.5)); this.iframeT = Math.max(this.iframeT || 0, 1.2);
        fx('text', this.x, this.y, (this.height || 60) + 22, 'BMO: up you get!', TEAL, 1.1);
        return false;
      };
    },

    _wire() {
      if (T._wired) return; T._wired = true;
      HM.Events.on('evade', (e) => {
        if (!T.active || T.beatId !== 'dodge' || !e) return;
        const p = G().player, s = T.ents && T.ents.sentinel;
        if (p && e.target === p && s && e.source === s) T.st.evaded = true;
      });
      HM.Events.on('damage', (e) => {
        if (!T.active || !e || T.beatId !== 'ult') return;
        const c = T.ents && T.ents.captain, p = G().player;
        if (c && e.target === c && e.source === p && !e.isDot) T.st.capHits = (T.st.capHits || 0) + 1;
      });
    },

    // detonation of the Sentinel's slam
    _slam(s) {
      const Gm = G(), p = Gm.player; if (!p || p.dead) return;
      const L = s.line();
      const C = s.c;
      fx('burst', C.x, C.y, 4, 'bone', 16, { r: s.w * 0.4 }); fx('burst', C.x, C.y, 2, 'dust', 26, { r: s.w * 0.5 });
      for (let k = 0; k <= 4; k++) { const u = k / 4; fx('burst', L[0] + (L[2] - L[0]) * u, L[1] + (L[3] - L[1]) * u, 2, 'dust', 4); }
      fx('ring', C.x, C.y, 10, s.w * 0.9, 0.35, [1, 0.8, 0.6]);
      fx('decal', C.x, C.y, 'crack', s.w * 0.55, 6);
      fx('light', C.x, C.y, 10, 160, [1, 0.5, 0.25], 1.4, 0.25);
      sfx('explode', C.x, C.y, 0.7, 0.6); sfx('bone_break', C.x, C.y, 0.6, 0.8);
      if (!s.contains(p, 0)) { fx('shake', dist(p, C) < 260 ? 3 : 1); return; }
      // generous: mid-roll counts even in the roll's last frames
      if (p.act && p.act.kind === 'dodge') p.iframeT = Math.max(p.iframeT || 0, 0.06);
      const back = s.dir + Math.PI;
      const r = HM.Combat.damage(p, { amount: p.maxHp * 0.14, type: 'phys', source: s, knock: 420, dir: back, hitstop: 0.08, shake: 7, canCrit: false, tags: ['tutorial'] });
      if (r && r.evaded) T.st.evaded = true;
      else if (r) {
        T.st.hits = (T.st.hits || 0) + 1;
        p.kx += Math.cos(back) * 160; p.ky += Math.sin(back) * 160;
        if (T.st.hits === 2 && !T.st._hinted) { T.st._hinted = true; BEATS.dodge.hint(T.st); }
      }
    },

    _barricadeHit(b, info) {
      if (b.broken) return;
      const Gm = G(), p = Gm.player;
      const heavy = info.source === p && (Gm.t - T.lastHeavyT < 1.8 || (p.act && p.act.slot === 'heavy'));
      if (heavy && T.unlocked.has('heavy')) { T._shatter(b); return; }
      b.chips++;
      if (b.chipT <= 0 && info.source === p) {
        b.chipT = 1.2;
        fx('text', b.x, b.y, b.height + 14, T.unlocked.has('heavy') ? 'too sturdy · ' + HM.Input.actionLabel('heavy') : 'too sturdy', [0.85, 0.82, 0.72], 0.8);
        fx('burst', b.x, b.y, 18, 'bone', 4);
      }
    },
    _shatter(b) {
      if (!b || b.broken) return;
      b.broken = true; b.dead = true; b.removeMe = true;
      fx('burst', b.x, b.y, 16, 'bone', 42, { r: b.radius }); fx('burst', b.x, b.y, 6, 'dust', 34, { r: b.radius * 1.2 });
      fx('ring', b.x, b.y, 8, b.radius * 3, 0.4, [1, 0.92, 0.8]); fx('shake', 7); fx('decal', b.x, b.y, 'bones', b.radius * 1.3, 18);
      sfx('bone_break', b.x, b.y, 1, 0.8); sfx('explode', b.x, b.y, 0.6, 1.1);
      if (G().hitstop) G().hitstop(0.08);
      T._openBarricade(b);
    },
    // World owns the barricade prop and its solidity. Preferred: World.setBarricade(broken=true). Fallback: drop props
    // named like a barricade near it and clear the solid cells under its footprint.
    _openBarricade(b) {
      const W = HM.World, F = T.F;
      if (W && typeof W.breakBarricade === 'function') { W.breakBarricade(); return; }
      if (W && typeof W.setBarricade === 'function') { W.setBarricade(true); return; }
      if (!F) return;
      if (Array.isArray(F.props)) F.props = F.props.filter((pr) => !(pr && /barric/i.test(String(pr.kind || '')) && Math.hypot(pr.x - b.x, pr.y - b.y) < 140));
      if (F.solid && F.cols) {
        const CW = HM.cfg.CW || 5, RW = (HM.cfg.CH || 8) / (HM.cfg.TILT || 0.75), rad = Math.max(30, T.B.barricadeR + 18);
        for (let y = b.y - rad; y <= b.y + rad; y += RW) for (let x = b.x - rad; x <= b.x + rad; x += CW) {
          if (Math.hypot(x - b.x, y - b.y) > rad) continue;
          const i = Math.floor(x / CW), j = Math.floor(y / RW); if (i < 0 || j < 0 || i >= F.cols) continue;
          const k = j * F.cols + i; if (k < F.solid.length) F.solid[k] = 0;
        }
      }
    },

    _spawnSword() {
      const Gm = G(), q = T.B.sword;
      if (T.ents.sword && !T.ents.sword.dead) return;
      if (T.weaponItem && HM.Items && HM.Items.dropItem) {
        const pk = HM.Items.dropItem(q.x, q.y, T.weaponItem, { pop: 0 });
        if (pk) { pk.tutorial = true; T.ents.sword = pk; return; }
      }
      // fallback: a plain interactable (World draws nothing for it; the prompt and the goal light guide you)
      const W = HM.World;
      const o = W && W.makeInteractable ? W.makeInteractable('tut_weapon', q.x, q.y, { r: 40, label: 'Take ' + (T.weaponName || 'your weapon') }) : { kind: 'tut_weapon', x: q.x, y: q.y, r: 40, label: 'Take your weapon', used: false };
      o.interact = () => { o.used = true; o.dead = true; T._equipStash(); sfx('pickup', o.x, o.y, 0.8, 1); };
      if (Gm.floor && Gm.floor.interactables) Gm.floor.interactables.push(o);
      T.ents.sword = o;
    },
    _equipStash() {
      const run = G().run, p = G().player; if (!run || !p) return;
      const I = run.inventory; if (!I || !I.equipped) return;
      if (!I.equipped.weapon) {
        const it = T.weaponItem; if (!it) return;
        const bi = I.bag ? I.bag.indexOf(it) : -1; if (bi >= 0) I.bag.splice(bi, 1);
        I.equipped.weapon = it; recompute(p);
      }
    },

    _spawnThrall(x, y, k) {
      if (!HM.Enemies || !HM.Enemies.spawn) return null;
      const e = HM.Enemies.spawn('thrall', x, y, { floorIndex: 1, ascension: 0, act: 1, hpMul: 0.55, dmgMul: 0.35, rise: true });
      if (e) { e.prologue = true; e.xpValue = 0; e.goldDrop = [0, 0]; e.cdMulV = (e.cdMulV || 1) * 1.25; noCredit(e); void k; }
      return e;
    },
    _spawnCaptain(q) {
      if (!HM.Enemies || !HM.Enemies.spawn) return null;
      const c = HM.Enemies.spawn('thrall', q.x, q.y, { elite: true, affixes: ['frenzied'], affixCount: 1, floorIndex: 1, ascension: 0, act: 1, hpMul: 1.3, dmgMul: 0.45, rise: true });
      if (!c) return null;
      c.prologue = true; c.xpValue = 0; c.goldDrop = [0, 0];
      c.name = c.baseName = 'Bone Captain'; c.fullName = 'Bone Captain';
      c.stats.dmgTakenMul = 0.3; // its bones are too thick until the ultimate lands
      return noCredit(c); // (the UI would otherwise toast "ELITE SLAIN · +1 boon point" — not true here)
    },
    _chargeUlt() {
      const p = G().player, u = skill(p, 'ult'); if (!p || !u) return;
      u.cdLeft = 0;
      if (u.costType !== 'temper' && u.cost && p.maxMp > 0) p.mp = Math.max(p.mp, Math.min(p.maxMp, u.cost + 1));
    },

    _springTrap(q) {
      const Gm = G(), p = Gm.player, run = Gm.run; if (!p) return;
      const c = run && (run.consumables || (run.consumables = { pancake: 0, tonic: 0 }));
      if (c && !(c.pancake >= 1)) c.pancake = 1;
      // bone spikes burst up under the hero: scripted chip damage down to ~55% (never lethal)
      const at = dist(p, q) < 90 ? p : q;
      fx('burst', at.x, at.y, 2, 'bone', 26, { r: 22, up: 1.6 }); fx('burst', at.x, at.y, 2, 'dust', 14, { r: 26 });
      fx('decal', at.x, at.y, 'crack', 26, 10);
      sfx('bone_break', at.x, at.y, 1, 1.4); sfx('hit', at.x, at.y, 0.8, 0.8);
      const want = Math.max(p.maxHp * 0.3, p.hp - p.maxHp * 0.55);
      HM.Combat.damage(p, { amount: want, type: 'phys', source: null, ignoreIframes: true, knock: 140, dir: p.facing + Math.PI, hitstop: 0.07, shake: 6, canCrit: false, tags: ['trap', 'tutorial'] });
      if (!p.dead) p.hp = M.clamp(Math.min(p.hp, p.maxHp * 0.6), p.maxHp * 0.3, p.maxHp);
      fx('text', p.x, p.y, (p.height || 60) + 20, 'TRAP!', [1, 0.55, 0.4], 1.1);
    },

    _spawnPage() {
      const F = T.F, q = T.B.page; if (!F) return;
      if (T.ents.page) return;
      let o = (F.interactables || []).find((it) => it && it.kind === 'note' && Math.hypot(it.x - q.x, it.y - q.y) < 60) || null;
      if (!o) { o = HM.World && HM.World.makeInteractable ? HM.World.makeInteractable('note', q.x, q.y, { r: 34, act: 1 }) : { kind: 'note', x: q.x, y: q.y, r: 34, used: false }; F.interactables.push(o); }
      o.label = 'Read the Enchiridion page'; o.tutorial = true;
      o.canInteract = () => T.active && T.beatId === 'read' && !T.pageRead;
      o.interact = () => T._readPage(o);
      T.ents.page = o;
    },
    _readPage(o) {
      if (T.pageRead) return;
      T.pageRead = true; o.used = true;
      const P = lore(), pg = (HM.Lore && HM.Lore.note && HM.Lore.note((P.page && P.page.id) || 'ench_prologue')) || P.page || FB.page;
      sfx('note', o.x, o.y, 0.9, 1);
      if (HM.Save && HM.Save.unlockCodex && pg.id) HM.Save.unlockCodex(pg.id);
      if (HM.UI && typeof HM.UI.showNote === 'function') HM.UI.showNote(pg);
      else T._toastLines([pg.title || 'Enchiridion', pg.text || '']);
    },

    // ------------------------------------------------------------------------------------- layout
    // Use World's hand-authored beats when present; otherwise lay them out along the start → exit line.
    _layout(F, p) {
      const W = F.beats || {}, real = !!(F.isPrologue && F.beats);
      const start = pt(W.start) || pt(F.start) || { x: p.x, y: p.y };
      const door = pt(W.door) || pt(F.exit) || { x: start.x, y: start.y - 700 };
      const rng = new HM.RNG(((F.seed || 7) ^ 0x7e57) >>> 0);
      const along = (u, spread) => openNear(F, M.lerp(start.x, door.x, u), M.lerp(start.y, door.y, u), 0, spread || 50, rng);
      const B = { fallback: !real, start, door };
      B.lanterns = pts(W.lanterns, 2) || [along(0.05, 30), along(0.1, 30), along(0.15, 30)];
      B.sword = pt(W.sword) || along(0.2);
      B.dummies = pts(W.dummies, 3) || [along(0.3, 70), along(0.31, 70), along(0.32, 70)];
      const g = W.gap && pt(W.gap);
      B.gap = g ? { x: g.x, y: g.y, w: W.gap.w || 90 } : Object.assign(along(0.42, 20), { w: 90 });
      B.sentinelSpot = pt(W.sentinel);
      B.barricade = pt(W.barricade) || along(0.53, 20);
      B.pack = pts(W.pack, 1) || [along(0.62, 70), along(0.64, 70), along(0.66, 70)];
      B.trap = pt(W.trap) || along(0.74, 20);
      B.captain = pt(W.captain) || along(0.83, 40);
      B.page = pt(W.page) || along(0.93, 30);
      B.snail = !real ? openNear(F, start.x - 160, start.y + 40, 0, 120, rng) : pt(W.snail);
      // passage direction through the gap: from where you come (the training yard) through the gap
      const from = { x: (B.dummies[0].x + B.dummies[1].x + B.dummies[2].x) / 3, y: (B.dummies[0].y + B.dummies[1].y + B.dummies[2].y) / 3 }, to = B.barricade;
      let dir = M.angle(from.x, from.y, B.gap.x, B.gap.y);
      if (Math.hypot(from.x - B.gap.x, from.y - B.gap.y) < 30) dir = M.angle(B.gap.x, B.gap.y, to.x, to.y);
      if (typeof W.gap === 'object' && typeof W.gap.dir === 'number') dir = W.gap.dir;
      B.dir = dir;
      // the Sentinel stands in the choke itself (a hair past its centre), so its body closes the gap until it crumbles
      B.sentinel = { x: B.gap.x + Math.cos(dir) * 6, y: B.gap.y + Math.sin(dir) * 6 };
      B.barricadeR = (W.barricade && W.barricade.r) || 24;
      B.worldBarricade = real && !!(HM.World && (typeof HM.World.setBarricade === 'function' || typeof HM.World.breakBarricade === 'function'));
      if (!real) {
        // a borrowed ordinary floor: no packs, no loot, just the lesson
        F.spawns = [];
        if (Array.isArray(F.interactables)) F.interactables = F.interactables.filter((o) => o.kind === 'portal');
      }
      return B;
    },

    // ------------------------------------------------------------------------------------- UI glue (all guarded)
    _prompt(id, keys, txt, pos) {
      txt = txt || {};
      if (promptAPI()) { HM.UI.prompt(id, { keys: keys || [], text: txt.text || '', sub: txt.sub || '', pos: pos || 'bottom' }); return; }
      const k = id + '|' + txt.text; if (T._toasted[k]) return; T._toasted[k] = true;
      const keyStr = (keys || []).map((a) => '[' + (HM.Input && HM.Input.actionLabel ? HM.Input.actionLabel(a) : a) + ']').join(' ');
      ui('toast', (keyStr ? keyStr + '  ' : '') + (txt.text || '') + (txt.sub ? '\n' + txt.sub : ''), '#9fe0d0', 5);
    },
    _clear(id) { if (promptAPI()) HM.UI.clearPrompt(id); },
    _bmo(id) {
      if (T._jumping) return;
      const P = lore(), line = P.bmoBeats && P.bmoBeats[id]; if (!line) return;
      if (HM.UI && HM.UI.dialogueOpen) return;
      ui('toast', 'BMO · ' + line, '#7fd6c0', 3.8);
    },
    _toastLines(lines) { let d = 0; for (const l of lines) { const s = l; G().after(d, () => ui('toast', 'BMO · ' + s, '#7fd6c0', 3.4)); d += 2.4; } },
    _skillText(slot, sk) {
      const b = beatText(slot);
      const name = sk && sk.name ? sk.name : b.text;
      return { text: b.text && b.text !== 'Skill' ? b.text : name, sub: b.sub || (sk && sk.desc) || '' };
    },
    _synergy() {
      const P = lore(), h = heroId();
      const s = (P.synergy && P.synergy[h]) || SYNERGY[h] || SYNERGY.finn;
      return typeof s === 'string' ? { text: 'Synergy', sub: s } : s;
    },
  });
})();
