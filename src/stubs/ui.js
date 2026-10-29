// ui.js — STUB. UI agent replaces with HUD + menus + save slots/export/import + options.
(function () {
  const HM = (globalThis.window || globalThis).HM;
  const UI = (HM.UI = {
    ctx: null, canvas: null, dpr: 1,
    init(canvas) { UI.canvas = canvas; UI.ctx = canvas ? canvas.getContext('2d') : null; UI.resize(); },
    resize() { if (!UI.canvas) return; UI.dpr = Math.min(2, window.devicePixelRatio || 1); UI.canvas.width = innerWidth * UI.dpr; UI.canvas.height = innerHeight * UI.dpr; UI.canvas.style.width = innerWidth + 'px'; UI.canvas.style.height = innerHeight + 'px'; },
    update() {
      const G = HM.Game, I = HM.Input;
      if (G.state === 'title' && (I.pressed.has('Enter') || I.pressed.has('Mouse0'))) { if (!HM.Save.data) HM.Save.use(1); G.newRun('finn'); }
      if ((G.state === 'dead' || G.state === 'victory') && I.pressed.has('Enter')) G.quitToTitle();
      if (G.state === 'boon' && I.pressed.has('Enter')) G.chooseBoon(G.menuData.draft[0].id);
    },
    draw() {
      const c = UI.ctx; if (!c) return; const G = HM.Game;
      c.setTransform(UI.dpr, 0, 0, UI.dpr, 0, 0); c.clearRect(0, 0, innerWidth, innerHeight);
      c.font = '12px Menlo, monospace'; c.fillStyle = '#ddd';
      if (G.state === 'title') { c.font = '28px Menlo, monospace'; c.textAlign = 'center'; c.fillText('ASHES OF OOO', innerWidth / 2, innerHeight / 2); c.font = '12px Menlo, monospace'; c.fillText('press Enter', innerWidth / 2, innerHeight / 2 + 30); c.textAlign = 'left'; }
      if (G.player) { c.fillText('HP ' + Math.ceil(G.player.hp) + '/' + G.player.maxHp + '   floor ' + G.run.floorIndex + '   fps ' + Math.round(G.fps), 14, 20); }
      for (const f of HM.FX.floaters) { const [sx, sy] = HM.R.worldToScreen(f.x, f.y, f.z); c.fillText(f.text, sx, sy); }
      for (const a of G.entities) if (a.name && !a.dead) { const [sx, sy] = HM.R.worldToScreen(a.x, a.y, a.height + 14); c.textAlign = 'center'; c.fillText(a.name, sx, sy); c.textAlign = 'left'; }
      const m = HM.Input.mouse; c.fillText('+', m.sx - 4, m.sy + 4);
      if (G.state !== 'play' && G.state !== 'title') c.fillText('state: ' + G.state + ' (Enter)', 14, 40);
    },
  });
})();
