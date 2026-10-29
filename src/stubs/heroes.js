// heroes.js — STUB. Heroes agent replaces with Finn / Marceline / Flame Princess kits + controller.
(function () {
  const HM = (globalThis.window || globalThis).HM;
  const M = HM.M, Input = HM.Input;
  class Player extends HM.Actor {
    constructor(o) { super(Object.assign({ kind: 'player', team: 0, name: 'Finn', radius: 8, hp: 120, maxHp: 120, mp: 50, maxMp: 50, speed: 115, height: 62 }, o)); this.atkCd = 0; this.dodgeCd = 0; this.mvx = 0; this.mvy = 0; }
    update(dt) {
      const [mx, my] = HM.R.screenToWorld(Input.mouse.sx, Input.mouse.sy);
      this.aim = M.angle(this.x, this.y, mx, my);
      this.atkCd -= dt; this.dodgeCd -= dt;
      let [ix, iy] = Input.moveVec(); const l = Math.hypot(ix, iy); if (l > 1) { ix /= l; iy /= l; }
      this.mvx = M.damp(this.mvx, ix, 16, dt); this.mvy = M.damp(this.mvy, iy, 16, dt);
      const st = this.anim.state;
      if (st === 'dodge') { if (this.anim.t > 0.32) HM.Rig.setAnim(this, 'idle'); }
      else if (st === 'attack') { if (this.anim.t > this.anim.dur) HM.Rig.setAnim(this, 'idle'); }
      if (this.anim.state !== 'dodge') { this.vx = this.mvx * this.speed; this.vy = this.mvy * this.speed; if (l > 0.1) this.facing = Math.atan2(iy, ix); }
      if (this.anim.state !== 'dodge' && this.dodgeCd <= 0 && Input.consume('dodge')) {
        const a = l > 0.1 ? Math.atan2(iy, ix) : this.aim; this.facing = a; this.vx = Math.cos(a) * 340; this.vy = Math.sin(a) * 340; this.iframeT = 0.26; this.dodgeCd = 0.55; HM.Rig.setAnim(this, 'dodge', { dur: 0.32 });
      }
      if (this.anim.state !== 'dodge' && this.atkCd <= 0 && (Input.consume('attack') || Input.isDown('attack'))) {
        this.atkCd = 0.38; this.facing = this.aim; HM.Rig.setAnim(this, 'attack', { dur: 0.3 });
        HM.Game.after(0.09, () => HM.Combat.hitArc(this.x, this.y, this.aim, 1.0, 46, 0, { amount: 10, type: 'phys', source: this, knock: 160 }));
      }
      HM.Combat.baseUpdate(this, dt);
    }
  }
  HM.Heroes = {
    list: [{ id: 'finn', name: 'Finn', title: 'the Last Human' }, { id: 'marceline', name: 'Marceline', title: 'the Vampire Queen' }, { id: 'fp', name: 'Flame Princess', title: 'of the Fire Kingdom' }],
    Player,
    createPlayer(run) { const p = new Player({ name: 'Finn', defId: run.heroId }); HM.Rig.create(p, 'finn', { colors: { head: [0.92, 0.92, 0.95], top: [0.35, 0.55, 0.85], legs: [0.18, 0.3, 0.65], skin: [0.93, 0.76, 0.64] } }); if (run.hp) p.hp = run.hp; return p; },
    recompute() {}, onLevelUp(p) { p.maxHp += 8; p.hp = Math.min(p.maxHp, p.hp + 20); },
  };
})();
