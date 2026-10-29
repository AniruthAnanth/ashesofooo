// combat.js — Actor base class, damage pipeline, status effects, area hits, projectiles, zones, movement.
(function () {
  'use strict';
  const Math = globalThis.Math; // lexical alias: hot loops skip the global-object lookup (big win in the Node smoke VM)
  const HM = (globalThis.window || globalThis).HM;
  const M = HM.M;

  // ---------------------------------------------------------------------------
  // Actor — base for player, enemies, bosses, npcs.
  // ---------------------------------------------------------------------------
  class Actor {
    constructor(o) {
      this.id = HM.uid();
      this.kind = 'enemy';        // 'player' | 'enemy' | 'boss' | 'npc'
      this.team = 1;              // 0 = player side, 1 = monsters, 2 = neutral (never hit)
      this.defId = '';
      this.name = '';
      this.x = 0; this.y = 0; this.z = 0;
      this.vx = 0; this.vy = 0;   // intended movement velocity (set by AI/controller), world units/s
      this.kx = 0; this.ky = 0;   // knockback velocity, decays
      this.radius = 9; this.mass = 1; this.height = 60;
      this.hp = 50; this.maxHp = 50; this.mp = 0; this.maxMp = 0;
      this.speed = 80;
      this.facing = 0;            // radians, direction body faces
      this.aim = 0;               // radians, direction attacks go
      this.dead = false; this.removeMe = false; this.deathT = 0;
      this.statuses = [];
      this.flashT = 0; this.iframeT = 0; this.stunT = 0; this.invuln = false;
      this.stats = Actor.baseStats();
      this.level = 1; this.xpValue = 8; this.goldDrop = [0, 2];
      this.isElite = false; this.isBoss = false; this.affixes = [];
      this.rig = null;            // owned by HM.Rig
      this.anim = { state: 'idle', t: 0, speed01: 0 }; // read by rigs; state names in CONTRACT.md
      this.moving = false;
      this.tags = [];
      this.t = 0;                 // age
      if (o) Object.assign(this, o);
      if (o && o.stats) this.stats = Object.assign(Actor.baseStats(), o.stats);
    }
    static baseStats() {
      return {
        armor: 0, res: { phys: 0, fire: 0, ice: 0, poison: 0, shadow: 0, holy: 0 },
        critChance: 0.05, critMult: 1.6, dmgMul: 1, moveMul: 1, atkSpeed: 1, castSpeed: 1, leech: 0, cdr: 0,
        thorns: 0, dmgTakenMul: 1, regen: 0, mpRegen: 0,
        elemMul: { phys: 1, fire: 1, ice: 1, poison: 1, shadow: 1, holy: 1 },
      };
    }
    get alive() { return !this.dead; }
    get hp01() { return this.maxHp > 0 ? this.hp / this.maxHp : 0; }
    hasStatus(id) { for (const s of this.statuses) if (s.id === id) return s; return null; }
    update(dt) { Combat.baseUpdate(this, dt); }
    draw() {
      if (HM.Rig && HM.Rig.draw && this.rig !== false) { HM.Rig.draw(this); return; }
      const R = HM.R; const p = R.proj(this.x, this.y, 18);
      R.ball(p[0], p[1], 9, this.y, R.RAMPS.solid, 0.8, 0.8, 0.8, 0);
    }
  }
  HM.Actor = Actor;

  // ---------------------------------------------------------------------------
  const Combat = (HM.Combat = {
    Actor,
    TYPE_COLORS: {
      phys: [1, 1, 1], fire: [1, 0.55, 0.15], ice: [0.6, 0.85, 1], poison: [0.45, 1, 0.3],
      shadow: [0.75, 0.45, 1], holy: [1, 0.95, 0.6], bleed: [0.95, 0.15, 0.15], heal: [0.4, 1, 0.5],
    },

    // ----------------------------------------------------------- statuses
    STATUS: {
      burn:   { type: 'fire',   stack: 'refresh', tick: 0.5, color: [1, 0.5, 0.1] },
      poison: { type: 'poison', stack: 'add',     tick: 0.5, maxStacks: 10, color: [0.45, 1, 0.3] },
      bleed:  { type: 'phys',   stack: 'add',     tick: 0.5, maxStacks: 8, movingMul: 2, color: [0.9, 0.1, 0.1], numColor: 'bleed' },
      chill:  { stack: 'refresh', slow: 0.4, color: [0.6, 0.85, 1] },
      freeze: { stack: 'refresh', stun: true, color: [0.8, 0.95, 1] },
      stun:   { stack: 'refresh', stun: true, color: [1, 1, 0.6] },
      weaken: { stack: 'refresh', dmgTaken: 1.25, color: [0.7, 0.4, 0.9] },
      rot:    { type: 'poison', stack: 'add', tick: 0.5, maxStacks: 6, slow: 0.15, color: [0.85, 0.35, 0.55] },
      kindled:{ stack: 'refresh', buff: true, color: [1, 0.6, 0.2] },   // next attacks burn
      haste:  { stack: 'refresh', buff: true, speed: 1.3, color: [0.9, 0.9, 1] },
      shield: { stack: 'refresh', buff: true, color: [0.7, 0.8, 1] },   // s.amount absorbs damage
      doom:   { type: 'shadow', stack: 'refresh', tick: 0.5, color: [0.4, 1, 0.5] }, // Lich curse
    },

    applyStatus(target, id, o) {
      if (!target || target.dead) return null;
      const def = Combat.STATUS[id]; if (!def) return null;
      o = o || {};
      if ((id === 'freeze' || id === 'stun') && (target.isBoss && target.ccImmuneT > 0)) return null;
      let s = target.hasStatus(id);
      const dur = o.dur || 2;
      if (s) {
        if (def.stack === 'add') { s.stacks = Math.min(def.maxStacks || 99, s.stacks + (o.stacks || 1)); s.dps = Math.max(s.dps, o.dps || 0); }
        else { s.dps = Math.max(s.dps, o.dps || 0); }
        s.dur = Math.max(s.dur - s.t, dur); s.t = 0; s.src = o.src || s.src;
        if (o.amount) s.amount = Math.max(s.amount || 0, o.amount);
      } else {
        s = { id, t: 0, dur, dps: o.dps || 0, stacks: o.stacks || 1, src: o.src || null, acc: 0, tickT: 0, amount: o.amount || 0 };
        target.statuses.push(s);
      }
      if (target.isBoss && (id === 'freeze' || id === 'stun')) { s.dur = Math.min(s.dur, 0.8); target.ccImmuneT = 6; }
      HM.Events.emit('status', { target, id, s });
      return s;
    },
    removeStatus(target, id) { target.statuses = target.statuses.filter((s) => s.id !== id); },

    updateStatuses(a, dt) {
      let slow = 0, stun = false, speedMul = 1, dmgTaken = 1;
      for (let k = a.statuses.length - 1; k >= 0; k--) {
        const s = a.statuses[k]; const def = Combat.STATUS[s.id];
        s.t += dt;
        if (def.slow) slow = Math.max(slow, def.slow);
        if (def.stun) stun = true;
        if (def.speed) speedMul *= def.speed;
        if (def.dmgTaken) dmgTaken *= def.dmgTaken;
        if (s.dps > 0 && def.type) {
          let dps = s.dps * (def.stack === 'add' ? s.stacks : 1);
          if (def.movingMul && a.moving) dps *= def.movingMul;
          s.acc += dps * dt; s.tickT += dt;
          if (s.tickT >= def.tick) {
            s.tickT -= def.tick;
            if (s.acc > 0) Combat.damage(a, { amount: s.acc, type: def.type, source: s.src, isDot: true, canCrit: false, numColor: def.numColor || def.type, status: null });
            s.acc = 0;
          }
        }
        if (HM.FX && HM.FX.statusAura) HM.FX.statusAura(a, s, dt);
        if (s.t >= s.dur) a.statuses.splice(k, 1);
        if (a.dead) return;
      }
      a._slow = slow; a._stunned = stun || a.stunT > 0; a._speedMul = speedMul; a._dmgTakenStatus = dmgTaken;
    },

    // ----------------------------------------------------------- damage
    // spec: { amount, type, source, canCrit, crit, knock, dir, status:[{id,dur,dps,stacks}], hitstop, shake,
    //         noNumber, numColor, isDot, ignoreIframes, tags:[] }
    damage(target, spec) {
      if (!target || target.dead || target.team === 2) return null;
      const src = spec.source || null;
      if (!spec.isDot && !spec.ignoreIframes && (target.invuln || target.iframeT > 0)) {
        if (target.kind === 'player' && HM.FX && HM.FX.text) HM.FX.text(target.x, target.y, target.height + 10, 'dodge', [0.8, 0.8, 0.9], 0.8);
        HM.Events.emit('evade', { target, source: src, spec });
        return { dealt: 0, evaded: true, target };
      }
      const type = spec.type || 'phys';
      const info = { target, source: src, type, amount: spec.amount || 0, crit: false, isDot: !!spec.isDot, tags: spec.tags || [], killed: false, spec, dealt: 0 };
      if (src && src.stats) { info.amount *= src.stats.dmgMul * (src.stats.elemMul[type] || 1); }
      if (src && src.onDealDamage) src.onDealDamage(info);
      HM.Events.emit('preDamage', info);
      // crit
      if (!info.isDot && spec.canCrit !== false) {
        const cc = spec.crit !== undefined ? (spec.crit ? 1 : 0) : (src && src.stats ? src.stats.critChance : 0);
        if (HM.rng.next() < cc) { info.crit = true; info.amount *= src && src.stats ? src.stats.critMult : 1.6; }
      }
      // shatter frozen
      if (!info.isDot && target.hasStatus('freeze') && type !== 'ice') {
        info.amount *= 1.6; info.shatter = true; Combat.removeStatus(target, 'freeze');
        if (HM.FX && HM.FX.burst) HM.FX.burst(target.x, target.y, 20, 'ice', 18);
        HM.Audio && HM.Audio.play('shatter', { x: target.x, y: target.y });
      }
      // mitigation
      const ts = target.stats;
      const res = M.clamp((ts.res && ts.res[type]) || 0, -1, 0.85);
      info.amount *= 1 - res;
      if (type === 'phys' && ts.armor > 0) info.amount *= 100 / (100 + ts.armor);
      info.amount *= (ts.dmgTakenMul || 1) * (target._dmgTakenStatus || 1);
      if (target.onDamaged) target.onDamaged(info);
      // shield absorbs
      const sh = target.hasStatus('shield');
      if (sh && sh.amount > 0) { const ab = Math.min(sh.amount, info.amount); sh.amount -= ab; info.amount -= ab; info.absorbed = ab; if (sh.amount <= 0) Combat.removeStatus(target, 'shield'); }
      info.amount = Math.max(0, info.amount);
      info.dealt = Math.min(info.amount, target.hp);
      target.hp -= info.amount;
      // leech
      if (src && src.stats && src.stats.leech > 0 && !info.isDot && !src.dead) src.hp = Math.min(src.maxHp, src.hp + info.amount * src.stats.leech);
      // thorns
      if (!info.isDot && src && src !== target && ts.thorns > 0 && !src.dead) Combat.damage(src, { amount: ts.thorns, type: 'phys', source: target, canCrit: false, noNumber: false, tags: ['thorns'] });
      // feedback
      if (!info.isDot) {
        target.flashT = 0.09;
        const knock = spec.knock || 0;
        if (knock > 0 && !target.isBoss) {
          const dir = spec.dir !== undefined ? spec.dir : src ? M.angle(src.x, src.y, target.x, target.y) : 0;
          const kv = knock / Math.max(0.3, target.mass);
          target.kx += Math.cos(dir) * kv; target.ky += Math.sin(dir) * kv;
        }
        const involvesPlayer = (src && src.kind === 'player') || target.kind === 'player';
        if (involvesPlayer && HM.Game && HM.Game.hitstop) HM.Game.hitstop(spec.hitstop !== undefined ? spec.hitstop : info.crit ? 0.06 : 0.035);
        if (HM.FX && HM.FX.shake && involvesPlayer) HM.FX.shake(spec.shake !== undefined ? spec.shake : target.kind === 'player' ? 5 : info.crit ? 3 : 1.5);
        if (HM.FX && HM.FX.hitSpark) HM.FX.hitSpark(target, info);
        HM.Audio && HM.Audio.play(info.crit ? 'crit' : type === 'phys' ? 'hit' : 'hit_' + type, { x: target.x, y: target.y });
      }
      if (!spec.noNumber && HM.FX && HM.FX.number && info.amount > 0.05) HM.FX.number(target, info.amount, spec.numColor || type, info.crit, info.isDot);
      // statuses
      if (spec.status && !target.dead) {
        const list = Array.isArray(spec.status) ? spec.status : [spec.status];
        for (const st of list) if (st) Combat.applyStatus(target, st.id, Object.assign({ src }, st));
      }
      HM.Events.emit('damage', info);
      if (target.hp <= 0 && !target.dead) { info.killed = true; Combat.kill(target, info); }
      return info;
    },

    heal(target, amount, opts) {
      if (!target || target.dead || amount <= 0) return 0;
      const h = Math.min(amount, target.maxHp - target.hp); target.hp += h;
      if (h > 0.5 && HM.FX && HM.FX.number && !(opts && opts.silent)) HM.FX.number(target, h, 'heal', false, false);
      return h;
    },

    kill(target, info) {
      if (target.dead) return;
      if (target.onBeforeDeath && target.onBeforeDeath(info) === false) { target.hp = Math.max(1, target.hp); return; } // e.g. boss phase gates
      target.dead = true; target.hp = 0; target.deathT = 0; target.statuses = [];
      if (target.onDeath) target.onDeath(info);
      if (info && info.source && info.source.onKill) info.source.onKill(target, info);
      if (HM.Rig && HM.Rig.onDeath) HM.Rig.onDeath(target, info);
      HM.Events.emit('kill', { target, source: info && info.source, info });
    },

    // ----------------------------------------------------------- queries
    actors() { return (HM.Game && HM.Game.entities) || []; },
    hostile(a, team) { return !a.dead && a.team !== team && a.team !== 2; },
    // spec may be a function(actor) => spec
    _hitList(list, team, spec, opts, sx, sy) {
      const out = [];
      for (const a of list) {
        if (opts && opts.once) { if (opts.once.has(a.id)) continue; opts.once.add(a.id); }
        const s = typeof spec === 'function' ? spec(a) : Object.assign({}, spec);
        if (!s) continue;
        if (s.dir === undefined) s.dir = M.angle(sx, sy, a.x, a.y);
        const r = Combat.damage(a, s); if (r) out.push(a);
      }
      return out;
    },
    queryCircle(x, y, r, team) { const out = []; for (const a of Combat.actors()) if (Combat.hostile(a, team) && M.dist(x, y, a.x, a.y) <= r + a.radius) out.push(a); return out; },
    hitCircle(x, y, r, team, spec, opts) {
      const list = Combat.queryCircle(x, y, r, team).filter((a) => !(opts && opts.filter) || opts.filter(a));
      return Combat._hitList(list, team, spec, opts, x, y);
    },
    // cone: origin, facing angle, half-angle, range
    queryArc(x, y, ang, half, range, team) {
      const out = [];
      for (const a of Combat.actors()) {
        if (!Combat.hostile(a, team)) continue;
        const d = M.dist(x, y, a.x, a.y); if (d > range + a.radius) continue;
        if (d < a.radius + 4) { out.push(a); continue; }
        const da = Math.abs(M.angleDiff(ang, M.angle(x, y, a.x, a.y)));
        if (da <= half + Math.asin(Math.min(1, a.radius / Math.max(d, 1)))) out.push(a);
      }
      return out;
    },
    hitArc(x, y, ang, half, range, team, spec, opts) {
      const list = Combat.queryArc(x, y, ang, half, range, team).filter((a) => !(opts && opts.filter) || opts.filter(a));
      return Combat._hitList(list, team, spec, opts, x, y);
    },
    queryLine(x0, y0, x1, y1, w, team) {
      const out = [];
      for (const a of Combat.actors()) if (Combat.hostile(a, team) && M.distToSeg(a.x, a.y, x0, y0, x1, y1) <= w + a.radius) out.push(a);
      return out;
    },
    hitLine(x0, y0, x1, y1, w, team, spec, opts) {
      const list = Combat.queryLine(x0, y0, x1, y1, w, team).filter((a) => !(opts && opts.filter) || opts.filter(a));
      return Combat._hitList(list, team, spec, opts, x0, y0);
    },
    nearestHostile(x, y, team, maxR, filter) {
      let best = null, bd = maxR || 1e9;
      for (const a of Combat.actors()) { if (!Combat.hostile(a, team) || a.neutral || a.hidden || (filter && !filter(a))) continue; const d = M.dist(x, y, a.x, a.y); if (d < bd) { bd = d; best = a; } }
      return best;
    },
    // Weak melee aim assist: bend `ang` up to maxBend toward the nearest hostile inside the cone.
    assistAim(x, y, ang, range, team, maxBend) {
      let best = null, bs = 1e9;
      for (const a of Combat.actors()) {
        if (!Combat.hostile(a, team) || a.neutral || a.hidden) continue; // never bend a swing toward the Waving Snail or hidden foes
        const d = M.dist(x, y, a.x, a.y); if (d > range + a.radius) continue;
        const da = M.angleDiff(ang, M.angle(x, y, a.x, a.y));
        if (Math.abs(da) > maxBend * 2.2) continue;
        const score = Math.abs(da) * 60 + d; if (score < bs) { bs = score; best = da; }
      }
      return best === null ? ang : ang + M.clamp(best, -maxBend, maxBend);
    },

    // ----------------------------------------------------------- movement
    // Move with world collision (slides along solids).
    move(a, dx, dy) {
      const W = HM.World;
      if (W && W.resolve) { const r = W.resolve(a.x + dx, a.y + dy, a.radius, a); a.x = r[0]; a.y = r[1]; }
      else { a.x += dx; a.y += dy; }
    },
    // Common per-frame actor update: timers, statuses, knockback, intended velocity.
    baseUpdate(a, dt) {
      a.t += dt;
      if (a.dead) { a.deathT += dt; return; }
      a.flashT = Math.max(0, a.flashT - dt); a.iframeT = Math.max(0, a.iframeT - dt); a.stunT = Math.max(0, a.stunT - dt);
      if (a.ccImmuneT) a.ccImmuneT = Math.max(0, a.ccImmuneT - dt);
      Combat.updateStatuses(a, dt); if (a.dead) return;
      if (a.stats.regen && a.hp < a.maxHp) a.hp = Math.min(a.maxHp, a.hp + a.stats.regen * dt);
      if (a.maxMp > 0 && a.stats.mpRegen) a.mp = Math.min(a.maxMp, a.mp + a.stats.mpRegen * dt);
      const mul = (a.stats.moveMul || 1) * (1 - (a._slow || 0)) * (a._speedMul || 1);
      let vx = a._stunned ? 0 : a.vx * mul, vy = a._stunned ? 0 : a.vy * mul;
      vx += a.kx; vy += a.ky;
      const decay = Math.exp(-9 * dt); a.kx *= decay; a.ky *= decay;
      if (Math.abs(a.kx) < 1) a.kx = 0; if (Math.abs(a.ky) < 1) a.ky = 0;
      if (vx || vy) Combat.move(a, vx * dt, vy * dt);
      a.moving = Math.hypot(a.vx, a.vy) > 5 && !a._stunned;
    },

    // ----------------------------------------------------------- projectiles
    // o: { x,y,z, vx,vy,vz, r, team, life, damage(spec or fn), pierce, look:'fireball'|..., color, onHit(target,p), onExpire(p),
    //      onWall(p), update(p,dt), draw(p), homing:{target,turn}, gravity, source, light:[radius,r,g,b] }
    projectile(o) {
      const p = Object.assign({ id: HM.uid(), x: 0, y: 0, z: 20, vx: 0, vy: 0, vz: 0, r: 6, team: 0, life: 2, t: 0, pierce: 0, hit: new Set(), dead: false, look: 'bolt', color: [1, 1, 1], trail: [] }, o);
      p.maxLife = p.life;
      if (HM.Game && HM.Game.projectiles) HM.Game.projectiles.push(p);
      return p;
    },
    updateProjectile(p, dt) {
      p.t += dt; p.life -= dt;
      if (p.homing && p.homing.target && !p.homing.target.dead) {
        const sp = Math.hypot(p.vx, p.vy); const cur = Math.atan2(p.vy, p.vx);
        const want = M.angle(p.x, p.y, p.homing.target.x, p.homing.target.y);
        const na = cur + M.clamp(M.angleDiff(cur, want), -p.homing.turn * dt, p.homing.turn * dt);
        p.vx = Math.cos(na) * sp; p.vy = Math.sin(na) * sp;
      }
      if (p.update) p.update(p, dt);
      if (p.dead) return;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.gravity) p.vz -= p.gravity * dt;
      p.trail.push(p.x, p.y, p.z); if (p.trail.length > 30) p.trail.splice(0, 3);
      // (p.light is added at draw time by FX.drawProjectile — lights added during update are cleared by R.beginFrame)
      // walls: shots fly over water / lava / void and stop only at walls & props (World.isWall); fall back to isSolid
      const W = HM.World;
      if (!p.ghost && W && (W.isWall ? W.isWall(p.x, p.y) : W.isSolid && W.isSolid(p.x, p.y))) { if (p.onWall) p.onWall(p); Combat.expire(p); return; }
      if (p.z < 0 && p.gravity) { if (p.onGround) p.onGround(p); Combat.expire(p); return; }
      // actors
      for (const a of Combat.actors()) {
        if (!Combat.hostile(a, p.team) || p.hit.has(a.id)) continue;
        if (M.dist(p.x, p.y, a.x, a.y) > p.r + a.radius) continue;
        p.hit.add(a.id);
        const spec = typeof p.damage === 'function' ? p.damage(a, p) : p.damage ? Object.assign({ dir: Math.atan2(p.vy, p.vx), source: p.source }, p.damage) : null;
        if (spec) Combat.damage(a, spec);
        if (p.onHit) p.onHit(a, p);
        if (p.pierce-- <= 0) { Combat.expire(p); return; }
      }
      if (p.life <= 0) Combat.expire(p);
    },
    expire(p) { if (p.dead) return; p.dead = true; if (p.onExpire) p.onExpire(p); },

    // ----------------------------------------------------------- zones (persistent ground effects)
    // o: { x,y,r, team, life, tick, onTick(z, actorsInside), onEnter, kind:'fire'|'poison'|'rot'|'ice'|..., tags:['flammable'],
    //      ignite(z), draw(z), source }
    zone(o) {
      const z = Object.assign({ id: HM.uid(), x: 0, y: 0, r: 40, team: 1, life: 4, t: 0, tick: 0.5, tickT: 0, dead: false, tags: [], kind: 'generic' }, o);
      z.maxLife = z.life;
      if (HM.Game && HM.Game.zones) HM.Game.zones.push(z);
      return z;
    },
    updateZone(z, dt) {
      z.t += dt; z.life -= dt; z.tickT += dt;
      if (z.update) z.update(z, dt);
      if (z.tickT >= z.tick) {
        z.tickT -= z.tick;
        const inside = Combat.actors().filter((a) => !a.dead && (z.hitsAll ? a.team !== 2 : Combat.hostile(a, z.team)) && M.dist(z.x, z.y, a.x, a.y) <= z.r + a.radius * 0.5);
        if (z.onTick) z.onTick(z, inside);
      }
      if (z.life <= 0) z.dead = true;
    },
    // Fire interacting with flammable zones (poison clouds, rot pools...) — expression space.
    igniteAt(x, y, r, source) {
      if (!HM.Game || !HM.Game.zones) return 0;
      let n = 0;
      for (const z of HM.Game.zones) {
        if (z.dead || !z.tags.includes('flammable')) continue;
        if (M.dist(x, y, z.x, z.y) > r + z.r) continue;
        n++;
        if (z.ignite) z.ignite(z, source);
        else {
          z.dead = true;
          Combat.hitCircle(z.x, z.y, z.r * 1.3, source ? source.team : 0, { amount: 25 + z.r * 0.6, type: 'fire', source, knock: 120, status: { id: 'burn', dur: 3, dps: 6 } });
          if (HM.FX && HM.FX.explosion) HM.FX.explosion(z.x, z.y, z.r * 1.3, 'fire');
          HM.Audio && HM.Audio.play('explode', { x: z.x, y: z.y });
        }
      }
      return n;
    },
  });
})();
