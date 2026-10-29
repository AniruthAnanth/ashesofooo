// fx.js — STUB. FX agent replaces with particles, telegraphs, trails, numbers, lights.
(function () {
  const HM = (globalThis.window || globalThis).HM;
  const FX = (HM.FX = {
    floaters: [], _shake: 0,
    clear() { FX.floaters = []; },
    update(dt) { FX._shake = Math.max(0, FX._shake - dt * 30); for (const f of FX.floaters) { f.t += dt; f.z += dt * 30; } FX.floaters = FX.floaters.filter((f) => f.t < f.life); },
    drawGround() {}, draw() {}, drawZone() {}, drawProjectile(p) { const R = HM.R; const q = R.proj(p.x, p.y, p.z); R.glowGlyph(q[0], q[1], R.gi('*'), 1, 0.6, 0.2, p.y, 1); },
    burst() {}, emit() {}, hitSpark() {}, statusAura() {}, swing() {}, telegraph() { return {}; }, explosion() {}, light() {}, decal() {}, ghost() {}, beam() {}, fissure() {},
    number(target, amount, type, crit) { FX.floaters.push({ x: target.x, y: target.y, z: target.height || 40, text: String(Math.round(amount)), type, crit, t: 0, life: 0.9 }); },
    text(x, y, z, text, rgb) { FX.floaters.push({ x, y, z, text, rgb, t: 0, life: 1 }); },
    shake(a) { FX._shake = Math.min(14, FX._shake + a); },
    shakeOffset() { const s = FX._shake; return [(Math.random() - 0.5) * s, (Math.random() - 0.5) * s]; },
  });
})();
