// main.js — bootstrap + main loop. Query params for testing:
//   ?debug=1              debug overlay & cheats (see UI)
//   ?hero=finn&floor=4    quick-start a run (uses slot 3 if no slot is active) — handy for testing
//   ?seed=123             fixed run seed
//   ?nosave=1             don't touch localStorage slots (in-memory profile)
//   ?do=0.5:code|2:code   run JS at game real-time t (seconds) — for staged screenshots/tests (tools/shot.sh)
//   ?freeze=3             stop advancing the simulation after t seconds (keeps rendering) — stable screenshots
//   ?sim=1.5              fast-forward 1.5 s deterministically (60 Hz) at boot, running `do` actions, then freeze — USE FOR SCREENSHOTS
(function () {
  'use strict';
  const HM = (globalThis.window || globalThis).HM;

  function showFatal(err) {
    console.error(err);
    if (typeof document === 'undefined') return;
    let el = document.getElementById('fatal');
    if (!el) { el = document.createElement('pre'); el.id = 'fatal'; document.body.appendChild(el); }
    el.textContent = 'ASHES OF OOO hit an error:\n\n' + (err && err.stack ? err.stack : String(err)) + '\n\nYour save data is safe in localStorage. Reload to try again.';
    el.style.display = 'block';
  }
  HM.showFatal = showFatal;

  HM.params = {};
  try { new URLSearchParams(location.search).forEach((v, k) => (HM.params[k] = v)); } catch (e) { /* headless */ }
  HM.debug = HM.params.debug === '1';

  HM.boot = function () {
    const gl = document.getElementById('gl'), ui = document.getElementById('ui');
    HM.R.init(gl);
    if (HM.R.glError) showFatal(new Error(HM.R.glError + ' — this game needs a WebGL2-capable browser.'));
    HM.Input.attach(window);
    HM.UI.init(ui);
    // Restore the last used slot (if any)
    if (HM.params.nosave !== '1') { const last = HM.Save.lastSlot(); if (last) HM.Save.use(last); }
    HM.Game.init();
    // Audio needs a user gesture
    const unlock = () => { HM.Audio && HM.Audio.init && HM.Audio.init(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
    window.addEventListener('pointerdown', unlock); window.addEventListener('keydown', unlock);
    window.addEventListener('resize', () => { HM.R.resize(); HM.UI.resize && HM.UI.resize(); });
    // Save on tab close / hide
    const persist = () => { try { if (HM.Save.data) HM.Save.write(); } catch (e) { /* ignore */ } };
    window.addEventListener('beforeunload', persist);
    document.addEventListener('visibilitychange', () => { if (document.hidden) { persist(); if (HM.Game.state === 'play') HM.Game.setState('pause'); } });

    // Quick start for testing
    if (HM.params.hero) {
      if (!HM.Save.data) HM.Save.use(3, 'Tester');
      HM.Game.newRun(HM.params.hero, { seed: HM.params.seed ? parseInt(HM.params.seed, 10) : undefined });
      const f = parseInt(HM.params.floor || '1', 10);
      if (f > 1) HM.Game.enterFloor(Math.min(15, f));
    }

    const actions = (HM.params.do || '').split('|').filter(Boolean).map((s) => { const k = s.indexOf(':'); return { t: parseFloat(s.slice(0, k)), code: s.slice(k + 1), done: false }; });
    const runActions = () => { for (const a of actions) if (!a.done && HM.Game.realT >= a.t) { a.done = true; try { (0, eval)(a.code); } catch (e) { console.error('do:', e); } } };
    // ?sim=T: deterministically fast-forward T seconds at 60 Hz before the first real frame, then freeze there.
    // (Headless Chrome barely ticks requestAnimationFrame, so staged screenshots use this.)
    const simT = HM.params.sim ? parseFloat(HM.params.sim) : 0;
    if (simT > 0) {
      const step = 1 / 60;
      HM.R.skipGPU = true;
      try {
        while (HM.Game.realT < simT) { HM.Input.beginFrame(HM.Game.realT + step); runActions(); HM.Game.update(step); HM.Game.draw(); }
      } catch (e) { showFatal(e); }
      HM.R.skipGPU = false;
    }
    const freezeAt = HM.params.freeze ? parseFloat(HM.params.freeze) : simT > 0 ? simT : Infinity;
    let last = HM.now();
    function frame() {
      const now = HM.now();
      let dt = Math.min(HM.cfg.MAX_DT, Math.max(0, now - last)); last = now;
      if (HM.Game.realT >= freezeAt) dt = 0;
      try {
        HM.Input.beginFrame(HM.Game.realT + dt);
        runActions();
        HM.Game.update(dt);
        HM.Game.draw();
      } catch (e) { showFatal(e); return; }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  };

  if (typeof window !== 'undefined' && window.addEventListener && !HM.headless) {
    window.addEventListener('load', () => { try { HM.boot(); } catch (e) { showFatal(e); } });
  }
})();
