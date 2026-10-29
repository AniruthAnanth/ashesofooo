// enemies.js — STUB. Enemies agent replaces with the full roster + AI.
(function () {
  const HM = (globalThis.window || globalThis).HM;
  const M = HM.M;
  class Enemy extends HM.Actor {
    update(dt) {
      const p = HM.Game.player; this.atkCd = (this.atkCd || 0) - dt;
      if (p && !p.dead && !this.dead) {
        const d = M.dist(this.x, this.y, p.x, p.y); const a = M.angle(this.x, this.y, p.x, p.y); this.facing = a; this.aim = a;
        if (d < 300 && d > 22) { this.vx = Math.cos(a) * this.speed; this.vy = Math.sin(a) * this.speed; } else { this.vx = this.vy = 0; }
        if (d < 26 && this.atkCd <= 0) { this.atkCd = 1.2; HM.Rig.setAnim(this, 'attack', { dur: 0.4 }); HM.Game.after(0.25, () => { if (!this.dead) HM.Combat.hitArc(this.x, this.y, this.aim, 0.9, 32, 1, { amount: 6, source: this, knock: 80 }); }); }
      } else { this.vx = this.vy = 0; }
      if (this.anim.state === 'attack' && this.anim.t > this.anim.dur) HM.Rig.setAnim(this, 'idle');
      HM.Combat.baseUpdate(this, dt);
    }
  }
  const Enemies = (HM.Enemies = {
    Enemy, defs: {},
    spawn(defId, x, y, o) {
      const e = new Enemy(Object.assign({ defId, name: 'Bone Thrall', x, y, hp: 30, maxHp: 30, speed: 60, radius: 8, height: 60, xpValue: 6 }, o));
      HM.Rig.create(e, 'thrall', { colors: { head: [0.85, 0.83, 0.75], top: [0.8, 0.78, 0.7], legs: [0.75, 0.72, 0.65], skin: [0.8, 0.78, 0.7] } });
      return HM.Game.spawn(e);
    },
    populate(floor, run) {
      const rng = new HM.RNG(floor.seed ^ 77);
      for (const s of floor.spawns) {
        if (s.kind === 'boss') { Enemies.spawn('boss', s.x, s.y, { name: 'Bone Dragon', isBoss: true, kind: 'boss', hp: 600, maxHp: 600, radius: 20 }); continue; }
        const n = s.size || 3;
        for (let k = 0; k < n; k++) Enemies.spawn('thrall', s.x + rng.range(-40, 40), s.y + rng.range(-30, 30), s.kind === 'elite' && k === 0 ? { isElite: true, name: 'Bone Captain', hp: 90, maxHp: 90 } : {});
      }
    },
  });
})();
