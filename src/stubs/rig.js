// rig.js — procedural skeletal rigs drawn as shaded glyph capsules.
// FIRST PASS (by lead): one generic humanoid to validate the look. Rig agent replaces with the full roster.
(function () {
  'use strict';
  const HM = (globalThis.window || globalThis).HM;
  const M = HM.M, R = HM.R;
  const { TILT } = HM.cfg;

  const Rig = (HM.Rig = {
    defs: {},
    create(a, rigId, opts) { a.rig = Object.assign({ id: rigId, walkPh: 0, lastX: a.x, lastY: a.y, colors: {} }, opts || {}); return a.rig; },
    setAnim(a, state, o) { a.anim.state = state; a.anim.t = 0; a.anim.dur = (o && o.dur) || 0.3; a.anim.variant = o && o.variant; },
    trigger() {},
    update(a, dt) {
      if (!a.rig) Rig.create(a, a.defId || 'humanoid');
      const r = a.rig; a.anim.t += dt;
      const d = M.dist(r.lastX, r.lastY, a.x, a.y); r.lastX = a.x; r.lastY = a.y;
      r.walkPh += d * 0.11;
      a.anim.speed01 = M.damp(a.anim.speed01 || 0, Math.min(1, d / Math.max(1e-4, dt) / 90), 12, dt);
    },
    onDeath(a) { a.anim.state = 'dead'; a.anim.t = 0; },
    weaponTip(a) { return [a.x + Math.cos(a.aim) * 22, a.y + Math.sin(a.aim) * 22, 30]; },

    draw(a) {
      if (!a.rig) Rig.create(a, a.defId || 'humanoid');
      const r = a.rig, an = a.anim;
      const C = Object.assign({ skin: [0.9, 0.75, 0.62], top: [0.55, 0.6, 0.7], legs: [0.3, 0.32, 0.4], head: [0.9, 0.9, 0.92], blade: [0.85, 0.88, 0.95] }, r.colors);
      if (a.flashT > 0) for (const k in C) C[k] = [1.6, 1.6, 1.6];
      const f = a.facing, fx = Math.cos(f), fy = Math.sin(f), rx = -fy, ry = fx;
      const sc = r.scale || 1.35;
      let dead = an.state === 'dead' ? Math.min(1, an.t / 0.45) : 0;
      if (dead && an.t > 18) { a.removeMe = a.kind !== 'player'; }
      const P = (lx, ly, lz) => { // local (right, forward, up) -> projected px + key
        lx *= sc; ly *= sc; lz *= sc;
        if (dead) { const k = M.easeOutCubic(dead); const nz = lz * (1 - k) + 2 * k; ly = ly + lz * k * 0.9; lz = nz; }
        const wx = a.x + rx * lx + fx * ly, wy = a.y + ry * lx + fy * ly;
        return [wx, wy * TILT - (lz + a.z), wy];
      };
      const sp = an.speed01 || 0, ph = r.walkPh;
      const bob = Math.abs(Math.sin(ph)) * 1.5 * sp + Math.sin(a.t * 2) * 0.4;
      let roll = 0;
      if (an.state === 'dodge') roll = M.clamp(an.t / (an.dur || 0.32), 0, 1);
      const hipZ = 26 - bob * 0.5 - (roll ? Math.sin(roll * Math.PI) * 12 : 0);
      // shadow
      R.shadowEllipse(a.x, a.y, 11 * sc, 7 * sc, 0.75);
      const ramp = R.RAMPS.solid, rc = R.RAMPS.cloth;
      if (roll) { // tucked ball
        const p = P(0, 0, 14); R.ball(p[0], p[1], 11 * sc, p[2] + 2, ramp, ...C.top, 0); const h = P(0, 3, 18); R.ball(h[0], h[1], 6 * sc, p[2] + 3, ramp, ...C.head, 0); return;
      }
      // legs
      for (const s of [-1, 1]) {
        const swing = Math.sin(ph + (s > 0 ? 0 : Math.PI)) * 9 * sp;
        const lift = Math.max(0, Math.cos(ph + (s > 0 ? 0 : Math.PI))) * 5 * sp;
        const hip = P(s * 4, 0, hipZ), knee = P(s * 4.2, swing * 0.6 + 2, 13 + lift * 0.6), foot = P(s * 4.4, swing, 1.5 + lift);
        R.capsule(hip[0], hip[1], knee[0], knee[1], 3.4, 3, hip[2], knee[2], rc, ...C.legs, 0);
        R.capsule(knee[0], knee[1], foot[0], foot[1], 3, 2.6, knee[2], foot[2], rc, ...C.legs, 0);
      }
      // torso
      const hip = P(0, 0, hipZ), chest = P(0, 0.5, hipZ + 17);
      R.capsule(hip[0], hip[1], chest[0], chest[1], 6, 7, hip[2], chest[2], rc, ...C.top, 0);
      // arms + weapon
      let swingA = 0;
      if (an.state === 'attack') { const tt = M.clamp(an.t / (an.dur || 0.3), 0, 1); swingA = tt < 0.3 ? -1.3 * M.easeOutCubic(tt / 0.3) : -1.3 + 2.8 * M.easeOutCubic((tt - 0.3) / 0.7); }
      for (const s of [-1, 1]) {
        const armSwing = -Math.sin(ph + (s > 0 ? 0 : Math.PI)) * 6 * sp;
        const sh = P(s * 7.5, 0, hipZ + 15);
        let hand;
        if (s > 0 && an.state === 'attack') { const [lx, ly] = M.rot(10, 9, swingA); hand = P(lx, ly, hipZ + 11); }
        else hand = P(s * 9, armSwing + 2, hipZ + 3);
        R.capsule(sh[0], sh[1], hand[0], hand[1], 2.6, 2.2, sh[2], hand[2], rc, ...C.skin, 0);
        if (s > 0) { // weapon
          const ang = an.state === 'attack' ? swingA : 0.2;
          const [tx, ty] = M.rot(4, 26, ang * 1.1);
          const tip = an.state === 'attack' ? P(tx + 3, ty, hipZ + 13) : P(11, 12, hipZ + 20);
          R.seg(hand[0], hand[1], tip[0], tip[1], null, ...C.blade, Math.max(hand[2], tip[2]) + 0.5, 0);
        }
      }
      // head
      const head = P(0, 1, hipZ + 26);
      R.ball(head[0], head[1], 6.2 * sc, head[2] + 1, ramp, ...C.head, 0);
    },
  });
})();
