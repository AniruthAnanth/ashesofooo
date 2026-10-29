// ui.js — the Canvas2D overlay (#ui), drawn after the WebGL frame.
// Owns ALL menu input (mouse + keyboard), every screen (title, slots, hero select, pause, inventory, boon draft,
// shop, note reader, death, victory, options w/ key remapping, codex, heirlooms), the in-game HUD (player frame,
// hotbar, XP, target frame, boss bar, name tags, damage numbers, pickup labels, barks, toasts, banners, crosshair)
// and achievement tracking. Look: black panels, 1px light-grey borders, small mono text, segmented tick bars.
//
// Widgets are immediate-mode: draw() registers hit regions; the next update() routes mouse/keyboard through them.
// Keyboard navigation is spatial (arrows/WASD move to the nearest focusable in that direction), Enter/Space
// activates, Esc goes back. Lists register off-screen rows as keyboard-only hits so focus can scroll them in.
(function () {
  'use strict';
  const Math = globalThis.Math; // lexical alias: hot loops skip the global-object lookup (big win in the Node smoke VM)
  const HM = (globalThis.window || globalThis).HM;
  const M = HM.M;
  const TAU = Math.PI * 2;

  // ======================================================================= style
  const FONT = 'Menlo, "SF Mono", Monaco, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';
  const COL = {
    panel: 'rgba(1,2,4,0.9)', solid: '#010204', border: '#b4b4b4', dimBorder: '#4b4b4b', hiBorder: '#f4f4f4',
    text: '#e8e8e8', dim: '#9a9a9a', faint: '#5f5f5f', ghost: '#2e2e2e',
    hp: '#ece6e1', hpLow: '#ff5544', mp: '#c3d0f2', xp: '#d8b15a', ember: '#ff8a3a', good: '#86e08f', bad: '#ff6a5a',
    gold: '#ffd36a', ice: '#9fd2ff', witch: '#8dffa0', boss: '#d2452b', elite: '#ffcf5a',
  };
  const RARITY = { common: '#d6d6d6', magic: '#6fa8ff', rare: '#ffd84a', legendary: '#ff8a2a', cursed: '#c06cff' };
  const RARITY_ORDER = { common: 0, magic: 1, rare: 2, legendary: 3, cursed: 3 };
  const TYPE_COL = { phys: '#f0f0f0', fire: '#ff9a3c', ice: '#9fdcff', poison: '#7dff6a', shadow: '#c08cff', holy: '#ffeea0', bleed: '#ff4545', heal: '#6dff8a', crit: '#ffe14a', gold: '#ffd36a', rot: '#ff7fb0', text: '#d8d8e0' };
  const STATUS_GLYPH = {
    burn: ['^', '#ff8a3a'], poison: ['o', '#7dff6a'], bleed: [',', '#ff4545'], chill: ['*', '#9fd2ff'], freeze: ['#', '#e0f4ff'],
    stun: ['@', '#ffe680'], weaken: ['v', '#b48cff'], rot: ['%', '#ff7fb0'], kindled: ['+', '#ffb050'], haste: ['>', '#f0f0ff'],
    shield: [']', '#a8c0ff'], doom: ['x', '#8dffa0'],
  };

  // ======================================================================= helpers
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const hex2 = (n) => { n = Math.max(0, Math.min(255, Math.round(n))); return (n < 16 ? '0' : '') + n.toString(16); };
  // color: css string or [r,g,b] floats 0..1 (may exceed 1)
  function css(c, fallback) {
    if (!c) return fallback || COL.text;
    if (typeof c === 'string') return c;
    if (Array.isArray(c) || c.length === 3) return '#' + hex2(c[0] * 255) + hex2(c[1] * 255) + hex2(c[2] * 255);
    return fallback || COL.text;
  }
  function rgba(c, a) {
    const s = css(c); if (s[0] !== '#' || s.length < 7) return s;
    return 'rgba(' + parseInt(s.slice(1, 3), 16) + ',' + parseInt(s.slice(3, 5), 16) + ',' + parseInt(s.slice(5, 7), 16) + ',' + a.toFixed(3) + ')';
  }
  function mixHex(a, b, t) {
    const A = M.hexToRgb(css(a)), B = M.hexToRgb(css(b));
    return css([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
  }
  function rarityColor(r) {
    const RR = HM.Items && HM.Items.RARITIES; const d = RR && RR[r];
    if (d && d.hex) return d.hex;
    if (d && d.color) return css(d.color);
    return RARITY[r] || RARITY.common;
  }
  function wrap(str, maxChars) {
    const out = []; if (!str) return out;
    for (const para of String(str).split('\n')) {
      const words = para.split(/\s+/); let line = '';
      for (const w of words) {
        if (!w) continue;
        if (!line) line = w; else if (line.length + 1 + w.length <= maxChars) line += ' ' + w; else { out.push(line); line = w; }
        while (line.length > maxChars) { out.push(line.slice(0, maxChars)); line = line.slice(maxChars); }
      }
      out.push(line);
    }
    return out;
  }
  // wrap into evenly filled lines (no dangling last word)
  function wrapBalanced(str, maxChars) {
    const n = wrap(str, maxChars).length; if (n <= 1) return wrap(str, maxChars);
    let w = Math.ceil(String(str).length / n) + 2;
    while (w < maxChars && wrap(str, w).length > n) w++;
    return wrap(str, w);
  }
  const fmtTime = (s) => (HM.Lore && HM.Lore.fmtTime ? HM.Lore.fmtTime(s || 0) : Math.floor((s || 0) / 60) + ':' + String(Math.floor(s || 0) % 60).padStart(2, '0'));
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso); if (isNaN(d.getTime())) return '—';
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now'; if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago'; if (diff < 86400 * 14) return Math.floor(diff / 86400) + 'd ago';
    return d.toISOString().slice(0, 10);
  }
  function fmtPlay(sec) { sec = Math.floor(sec || 0); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return h ? h + 'h ' + m + 'm' : m + 'm'; }
  const sfx = (n) => { try { HM.Audio && HM.Audio.play && HM.Audio.play(n); } catch (e) { /* audio is optional */ } };
  const G = () => HM.Game;
  const meta = () => (HM.Save && HM.Save.data ? HM.Save.data.meta : null);
  const setting = (k, d) => (HM.Save && HM.Save.setting ? HM.Save.setting(k, d) : d);
  function heroInfo(id) {
    const l = (HM.Heroes && HM.Heroes.list) || [];
    const h = l.find((x) => x.id === id);
    const fb = { finn: ['Finn', 'the Last Human'], marceline: ['Marceline', 'the Vampire Queen'], fp: ['Flame Princess', 'of the Fire Kingdom'] }[id] || [id || '?', ''];
    return h ? Object.assign({ name: fb[0], title: fb[1] }, h) : { id, name: fb[0], title: fb[1] };
  }
  const roman = (n) => ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][n] || String(n);

  // ======================================================================= canvas state
  let ctx = null, W = 1280, H = 720, S = 1, DPR = 1;
  let curFont = '';
  const cwCache = {};
  const fpx = (n) => Math.max(8, Math.round(n * S));
  function setFont(px, bold) { const f = (bold ? 'bold ' : '') + px + 'px ' + FONT; if (f !== curFont) { ctx.font = f; curFont = f; } }
  function cw(px) {
    let w = cwCache[px];
    if (w === undefined) { const f = curFont; ctx.font = px + 'px ' + FONT; const m = ctx.measureText('MMMMMMMMMM'); w = cwCache[px] = m && m.width ? m.width / 10 : px * 0.6; ctx.font = f || ctx.font; }
    return w;
  }
  const tw = (str, px) => String(str).length * cw(px);
  const snap = (v) => Math.round(v * DPR) / DPR;
  // text anchored at (x, y) (y = vertical middle). o: {bold, shadow, alpha}
  function text(str, x, y, color, px, align, o) {
    str = String(str); px = px || fpx(12);
    setFont(px, o && o.bold);
    const w = tw(str, px);
    const x0 = snap(align === 'center' ? x - w / 2 : align === 'right' ? x - w : x), y0 = snap(y);
    if (o && o.shadow) { ctx.fillStyle = o.shadow === true ? 'rgba(0,0,0,0.9)' : o.shadow; ctx.fillText(str, x0 + 1, y0 + 1); }
    ctx.fillStyle = color; ctx.fillText(str, x0, y0);
    return w;
  }
  // letter-spaced caps (headers like "SENJE · WARRIOR")
  function spaced(str, x, y, color, px, align, sp) {
    str = String(str); px = px || fpx(11); sp = sp === undefined ? 0.55 : sp;
    setFont(px); const c = cw(px), step = c * (1 + sp), w = str.length * step - c * sp;
    let x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    ctx.fillStyle = color;
    for (let i = 0; i < str.length; i++) if (str[i] !== ' ') ctx.fillText(str[i], snap(x0 + i * step), snap(y));
    return w;
  }
  function fill(x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); }
  function box(x, y, w, h, c) {
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    ctx.fillStyle = c; ctx.fillRect(x, y, w, 1); ctx.fillRect(x, y + h - 1, w, 1); ctx.fillRect(x, y, 1, h); ctx.fillRect(x + w - 1, y, 1, h);
  }
  function dashBox(x, y, w, h, c) {
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h); ctx.fillStyle = c;
    const d = Math.max(2, Math.round(3 * S));
    for (let i = 0; i < w; i += d * 2) { const l = Math.min(d, w - i); ctx.fillRect(x + i, y, l, 1); ctx.fillRect(x + i, y + h - 1, l, 1); }
    for (let i = 0; i < h; i += d * 2) { const l = Math.min(d, h - i); ctx.fillRect(x, y + i, 1, l); ctx.fillRect(x + w - 1, y + i, 1, l); }
  }
  function panel(x, y, w, h, o) {
    o = o || {};
    fill(x, y, w, h, o.bg || COL.panel);
    box(x, y, w, h, o.border || COL.border);
    if (o.inner) box(x + 3, y + 3, w - 6, h - 6, o.inner);
    if (o.title) {
      const th = Math.round(26 * S);
      spaced(o.title, x + 12 * S, y + th / 2 + 1, o.titleColor || COL.text, fpx(11));
      fill(x, y + th, w, 1, o.border || COL.border);
      return y + th;
    }
    return y;
  }
  // corner ornaments for big panels  +--  --+
  function corners(x, y, w, h, c, len) {
    len = len || Math.round(10 * S); fill(x - 2, y - 2, len, 1, c); fill(x - 2, y - 2, 1, len, c);
    fill(x + w + 1 - len, y - 2, len, 1, c); fill(x + w + 1, y - 2, 1, len, c);
    fill(x - 2, y + h + 1, len, 1, c); fill(x - 2, y + h + 2 - len, 1, len, c);
    fill(x + w + 1 - len, y + h + 1, len, 1, c); fill(x + w + 1, y + h + 2 - len, 1, len, c);
  }
  // segmented tick bar  [|||||||||     ]
  function tickBar(x, y, w, h, frac, color, o) {
    o = o || {};
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    if (!o.noBg) fill(x, y, w, h, '#000');
    box(x, y, w, h, o.border || '#a9a9a9');
    const pad = o.pad !== undefined ? o.pad : 2, ix = x + pad, iy = y + pad, iw = w - pad * 2, ih = h - pad * 2;
    if (iw <= 0 || ih <= 0) return;
    const step = Math.max(2, Math.round(3 * S * (o.step || 1))), tk = Math.max(1, step - 1);
    const n = Math.max(1, Math.floor((iw + 1) / step));
    const fN = Math.round(n * clamp01(frac)), gN = o.ghost !== undefined ? Math.round(n * clamp01(o.ghost)) : 0;
    ctx.fillStyle = color;
    for (let i = 0; i < fN; i++) ctx.fillRect(ix + i * step, iy, tk, ih);
    if (gN > fN) { ctx.fillStyle = o.ghostColor || '#fff1c4'; for (let i = fN; i < gN; i++) ctx.fillRect(ix + i * step, iy, tk, ih); }
    if (o.empty) { ctx.fillStyle = o.empty; for (let i = Math.max(fN, gN); i < n; i++) ctx.fillRect(ix + i * step, iy, tk, ih); }
  }
  // solid bar with notches (boss)
  function solidBar(x, y, w, h, frac, color, o) {
    o = o || {};
    fill(x, y, w, h, '#160404'); box(x, y, w, h, o.border || '#8a8a8a');
    const iw = w - 4;
    if (o.ghost > frac) fill(x + 2, y + 2, iw * clamp01(o.ghost), h - 4, o.ghostColor || '#f5d7a0');
    fill(x + 2, y + 2, iw * clamp01(frac), h - 4, color);
    fill(x + 2, y + 2, iw * clamp01(frac), Math.max(1, Math.round((h - 4) * 0.3)), 'rgba(255,255,255,0.18)');
    if (o.notches) for (const f of o.notches) fill(x + 2 + iw * f, y + 1, 1, h - 2, 'rgba(255,230,210,0.55)');
  }

  // ======================================================================= hit regions / focus
  let hits = [], building = [], hitsKey = '', layer = 'screen';
  function hit(id, x, y, w, h, o) {
    const r = { id, x, y, w, h, layer };
    if (o) Object.assign(r, o);
    if (r.focusable === undefined) r.focusable = !!(r.act || r.left || r.right);
    building.push(r); return r;
  }
  const isFocus = (id) => UI.focus === id;
  // Button with the reference look (1px border, mono label). Returns the hit.
  function button(id, x, y, w, h, label, act, o) {
    o = o || {};
    const dis = !!o.disabled, f = isFocus(id) && !dis;
    const flash = UI.flash && UI.flash.id === id ? 1 - Math.min(1, (UI.t - UI.flash.t) / 0.25) : 0;
    fill(x, y, w, h, f ? 'rgba(255,255,255,0.09)' : o.bg || 'rgba(0,0,0,0.88)');
    if (flash > 0) fill(x, y, w, h, 'rgba(255,255,255,' + (0.35 * flash).toFixed(3) + ')');
    box(x, y, w, h, dis ? COL.dimBorder : f ? (o.hiBorder || COL.hiBorder) : o.border || '#8c8c8c');
    const col = dis ? COL.faint : f ? (o.hiColor || '#ffffff') : o.color || '#cdcdcd';
    text(label, x + w / 2, y + h / 2 + 1, col, o.px || fpx(12), 'center', { bold: o.bold });
    return hit(id, x, y, w, h, { act: dis ? null : act, focusable: !dis && o.focusable !== false, alt: o.alt, left: o.left, right: o.right, tip: o.tip, hidden: o.hidden });
  }
  function activate(h) {
    if (!h || !h.act) return;
    UI.flash = { id: h.id, t: UI.t };
    sfx('ui_select');
    h.act(h);
  }
  function swallowMouse() {
    const I = HM.Input;
    for (const c of ['Mouse0', 'Mouse2']) { I.pressed.delete(c); I.down.delete(c); }
    I.clearBuffer && I.clearBuffer();
  }
  function swallowKeys() { const I = HM.Input; for (const c of ['Enter', 'NumpadEnter', 'Space', 'Escape']) I.pressed.delete(c); }
  function keys() {
    const I = HM.Input, P = I.pressed;
    const has = (a, b, c) => P.has(a) || (b && P.has(b)) || (c && P.has(c));
    return {
      up: has('ArrowUp', 'KeyW') || I.wasPressed('up'), down: has('ArrowDown', 'KeyS') || I.wasPressed('down'),
      left: has('ArrowLeft', 'KeyA') || I.wasPressed('left'), right: has('ArrowRight', 'KeyD') || I.wasPressed('right'),
      ok: has('Enter', 'NumpadEnter', 'Space'), back: has('Escape'),
    };
  }
  // spatial navigation between focusable hits
  function navigate(list, cur, dx, dy) {
    const fs = list.filter((h) => h.focusable);
    if (!fs.length) return;
    if (!cur) { UI.focus = fs[0].id; return; }
    const cx = cur.x + cur.w / 2, cy = cur.y + cur.h / 2;
    let best = null, bs = Infinity;
    for (const h of fs) {
      if (h === cur) continue;
      const hx = h.x + h.w / 2, hy = h.y + h.h / 2, ddx = hx - cx, ddy = hy - cy;
      const along = ddx * dx + ddy * dy; if (along <= 2) continue;
      // overlap on the perpendicular axis is preferred (rows/columns)
      const ov = dx ? Math.max(0, Math.min(cur.y + cur.h, h.y + h.h) - Math.max(cur.y, h.y)) : Math.max(0, Math.min(cur.x + cur.w, h.x + h.w) - Math.max(cur.x, h.x));
      const perp = Math.abs(ddx * dy - ddy * dx);
      const score = along + perp * (ov > 0 ? 0.6 : 2.6);
      if (score < bs) { bs = score; best = h; }
    }
    if (!best && dy) { // wrap vertically: farthest item on the other side with the most overlap
      let ws = -Infinity;
      for (const h of fs) {
        if (h === cur) continue;
        const hy = h.y + h.h / 2, hx = h.x + h.w / 2; const back = (cy - hy) * dy; if (back <= 2) continue;
        const sc = back - Math.abs(hx - cx) * 3; if (sc > ws) { ws = sc; best = h; }
      }
    }
    if (best) { UI.focus = best.id; sfx('ui_move'); }
  }
  // Route mouse + keyboard through the last frame's hits. o: {back, keyboard:false}
  function processNav(o) {
    o = o || {};
    const I = HM.Input;
    const key = HM.Game.state + '|' + (UI.modal ? 'm' : '') + '|' + (UI.pauseSub || '') + '|' + (UI.codexTab || '');
    if (hitsKey !== key) return false;
    const want = UI.modal ? 'modal' : 'screen';
    const list = hits.filter((h) => h.layer === want);
    const mx = I.mouse.sx, my = I.mouse.sy;
    const moved = Math.abs(mx - UI._mx) + Math.abs(my - UI._my) > 0.5; UI._mx = mx; UI._my = my;
    let hov = null;
    for (let i = list.length - 1; i >= 0; i--) { const h = list[i]; if (!h.hidden && mx >= h.x && mx < h.x + h.w && my >= h.y && my < h.y + h.h) { hov = h; break; } }
    UI.hover = hov;
    if (moved) UI.kbNav = false;
    if (moved && hov && hov.focusable && UI.focus !== hov.id) UI.focus = hov.id;
    // dragging (sliders)
    if (UI.drag) { const h = list.find((x) => x.id === UI.drag); if (I.down.has('Mouse0') && h && h.drag) h.drag(mx, my, h); else UI.drag = null; }
    if (I.pressed.has('Mouse0')) {
      swallowMouse();
      if (hov) { if (hov.drag) { UI.drag = hov.id; hov.drag(mx, my, hov); return true; } if (hov.act) { activate(hov); return true; } }
      else if (o.clickOutside) { o.clickOutside(); return true; }
    }
    if (I.pressed.has('Mouse2')) { swallowMouse(); if (hov && hov.alt) { hov.alt(hov); return true; } }
    if (I.mouse.wheel && o.wheel) o.wheel(I.mouse.wheel);
    if (o.keyboard === false) { if (I.pressed.has('Escape') && o.back) { o.back(); sfx('ui_back'); return true; } return false; }
    const k = keys();
    const fs = list.filter((h) => h.focusable);
    let cur = fs.find((h) => h.id === UI.focus) || null;
    if (!cur && fs.length && (k.up || k.down || k.left || k.right || k.ok)) { cur = fs[0]; UI.focus = cur.id; if (!k.ok) return false; }
    if (k.up || k.down || k.left || k.right) UI.kbNav = true;
    if (k.left && cur && cur.left) { cur.left(cur); sfx('ui_move'); }
    else if (k.right && cur && cur.right) { cur.right(cur); sfx('ui_move'); }
    else if (k.up) navigate(list, cur, 0, -1);
    else if (k.down) navigate(list, cur, 0, 1);
    else if (k.left) navigate(list, cur, -1, 0);
    else if (k.right) navigate(list, cur, 1, 0);
    if (k.ok && cur && cur.act) { swallowKeys(); activate(cur); return true; }
    if (k.back && o.back) { swallowKeys(); o.back(); sfx('ui_back'); return true; }
    return false;
  }

  // ======================================================================= ASCII figure renderer (portraits)
  // Figures are lists of shaded capsules in a [-w/2..w/2] x [0..2] space, rasterized to a glyph grid with the
  // same light direction as the world (moon top-right) and cached to offscreen canvases.
  const LDIR = (() => { const v = [0.5, -0.6, 0.62], l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; })();
  const RAMPS = {
    cloth: ' .,:;ox%&#', flesh: ' .,:;=oO0@', hair: " .'`;|/\\(%", fire: " .'`^\"*+#@", metal: ' .:-=+*#%@',
    solid: ' .,:;=+*#%@', bone: ' .:;+=xX$&#', feather: " .,:;~=o8@",
  };
  // shape: [ax, ay, bx, by, ra, rb, color, ramp, emissive]
  const FIG = {
    finn: (ph) => ({ w: 1.5, shapes: [
      [0, 0.8, 0, 1.12, 0.25, 0.25, '#3f8a4a', 'cloth'],                 // backpack
      [-0.1, 1.28, -0.12, 1.84, 0.075, 0.068, '#2a3d78', 'cloth'], [0.1, 1.28, 0.13, 1.84, 0.075, 0.068, '#2a3d78', 'cloth'],
      [-0.13, 1.9, -0.19, 1.91, 0.06, 0.05, '#2b2b2b', 'solid'], [0.14, 1.9, 0.2, 1.91, 0.06, 0.05, '#2b2b2b', 'solid'],
      [0, 1.16, 0, 1.3, 0.18, 0.19, '#2f4fa0', 'cloth'],                  // shorts
      [0, 0.74, 0, 1.16, 0.2, 0.18, '#63a8ea', 'cloth'],                  // shirt
      [-0.23, 0.8, -0.31, 1.18, 0.062, 0.055, '#efc6a6', 'flesh'], [0.23, 0.8, 0.33, 1.1, 0.062, 0.055, '#efc6a6', 'flesh'],
      [0.35, 1.12, 0.6 + Math.sin(ph * TAU) * 0.01, 0.36, 0.04, 0.022, '#9be27a', 'metal', 0.35], // grass sword
      [0.27, 1.1, 0.43, 1.06, 0.035, 0.035, '#c9a24a', 'metal'],         // crossguard
      [0, 0.44, 0, 0.5, 0.28, 0.28, '#f4f4f4', 'cloth'],                  // hood
      [-0.17, 0.28, -0.21, 0.1, 0.075, 0.05, '#f4f4f4', 'cloth'], [0.17, 0.28, 0.21, 0.1, 0.075, 0.05, '#f4f4f4', 'cloth'],
      [0, 0.51, 0, 0.53, 0.17, 0.17, '#f2caa9', 'flesh'],                 // face
    ], dots: [[-0.07, 0.49, '#151515', 'o'], [0.07, 0.49, '#151515', 'o'], [0, 0.58, '#7a2a20', '-']] }),
    marceline: (ph) => { const sw = Math.sin(ph * TAU) * 0.03; return { w: 1.5, shapes: [
      [0, 0.34, 0.04 + sw, 1.42, 0.31, 0.2, '#433c5c', 'hair'],          // long hair
      [-0.08, 1.24, -0.15, 1.76, 0.068, 0.056, '#38507f', 'cloth'], [0.09, 1.24, 0.06, 1.72, 0.068, 0.056, '#38507f', 'cloth'],
      [-0.16, 1.8, -0.21, 1.83, 0.06, 0.05, '#5e1f22', 'solid'], [0.06, 1.76, 0.11, 1.79, 0.06, 0.05, '#5e1f22', 'solid'],
      [0, 0.7, 0, 1.24, 0.15, 0.165, '#4a4a55', 'cloth'],                 // shirt
      [-0.18, 0.76, -0.26, 1.16, 0.052, 0.046, '#a9babf', 'flesh'], [0.18, 0.76, 0.3, 1.02, 0.052, 0.046, '#a9babf', 'flesh'],
      [0.32, 1.06, 0.58, 0.24, 0.032, 0.026, '#5b2a1c', 'solid'],        // bass neck
      [0.16, 1.32, 0.3, 1.12, 0.14, 0.12, '#b3202c', 'metal'],           // axe-bass body
      [0.56, 0.3, 0.68, 0.18, 0.06, 0.03, '#c9c9d4', 'metal'],           // axe blade tip
      [0, 0.44, 0, 0.47, 0.155, 0.155, '#aebfc4', 'flesh'],               // face
      [0, 0.28, 0, 0.31, 0.17, 0.15, '#433c5c', 'hair'],                 // bangs
    ], dots: [[-0.06, 0.44, '#ff3030', '.'], [0.06, 0.44, '#ff3030', '.'], [0.02, 0.53, '#e8e8e8', "'"]] }; },
    fp: (ph) => { const f = (k) => Math.sin(ph * TAU + k) * 0.05; return { w: 1.5, shapes: [
      [0, 0.52, f(0) * 0.6, 0.06 + f(1), 0.26, 0.04, '#ff6a12', 'fire', 0.9],     // flame hair
      [-0.17, 0.5, -0.33 + f(2) * 0.5, 0.18 + f(3), 0.12, 0.03, '#ffa830', 'fire', 0.9],
      [0.17, 0.5, 0.34 + f(4) * 0.5, 0.16 + f(5), 0.12, 0.03, '#ffa830', 'fire', 0.9],
      [0, 0.44, -0.04 + f(6) * 0.4, 0.14 + f(1), 0.11, 0.02, '#ffe58a', 'fire', 1.1],
      [0, 0.76, 0, 1.6, 0.14, 0.34, '#c8381e', 'cloth'],                  // dress
      [-0.08, 1.62, -0.1, 1.88, 0.05, 0.045, '#ff9a55', 'flesh'], [0.08, 1.62, 0.1, 1.88, 0.05, 0.045, '#ff9a55', 'flesh'],
      [-0.17, 0.78, -0.31, 1.1, 0.05, 0.045, '#ff9a55', 'flesh'], [0.17, 0.78, 0.31, 1.1, 0.05, 0.045, '#ff9a55', 'flesh'],
      [0.33, 1.14, 0.33, 1.15, 0.075 + f(2) * 0.3, 0.075, '#ffd060', 'fire', 1.0], [-0.33, 1.14, -0.33, 1.15, 0.07 + f(4) * 0.3, 0.07, '#ffd060', 'fire', 1.0],
      [0, 0.5, 0, 0.53, 0.16, 0.16, '#ff9f5e', 'flesh'],                  // face
    ], dots: [[0, 0.38, '#5dff8a', '*'], [-0.06, 0.5, '#3a0800', 'o'], [0.06, 0.5, '#3a0800', 'o']] }; },
    goose: (ph) => ({ w: 1.6, shapes: [
      [-0.06, 1.5, -0.08, 1.9, 0.03, 0.028, '#e08a2a', 'solid'], [0.1, 1.5, 0.12, 1.9, 0.03, 0.028, '#e08a2a', 'solid'],
      [-0.12, 1.25, 0.28, 1.32, 0.32, 0.22, '#e6e6df', 'feather'],        // body
      [0.02, 1.18, 0.34, 1.28, 0.19, 0.13, '#a9a9a2', 'feather'],         // wing
      [-0.22, 1.1, -0.17, 0.56, 0.09, 0.07, '#ececec', 'feather'],        // neck
      [-0.16, 0.5, -0.14, 0.52, 0.13, 0.13, '#f2f2f2', 'feather'],        // head
      [-0.27, 0.54, -0.46, 0.57, 0.05, 0.025, '#f09a30', 'solid'],       // beak
      [-0.33, 0.37, 0.03, 0.37, 0.028, 0.028, '#2e2219', 'cloth'],       // hat brim
      [-0.15, 0.36, -0.15, 0.2, 0.1, 0.1, '#2e2219', 'cloth'],           // hat top
      [0.42, 1.06, 0.42, 1.08, 0.07, 0.07, '#ffcf6a', 'fire', 0.6 + Math.sin(ph * TAU) * 0.2], // lantern
    ], dots: [[-0.2, 0.49, '#111', 'o']] }),
  };
  const figCache = new Map();
  // rows: grid rows; fontPx: glyph size (cells are 0.6 x 0.96 of it, like the world's 5x8 grid). Returns {canvas, w, h} css px.
  function figure(id, rows, fontPx, phase) {
    fontPx = Math.round(fontPx * 4) / 4;
    const cellW = fontPx * 0.6, cellH = fontPx * 0.96;
    const key = id + ':' + rows + ':' + fontPx + ':' + (phase || 0) + ':' + DPR;
    let c = figCache.get(key); if (c) return c;
    const build = FIG[id] || FIG.finn; const def = build(phase || 0);
    const cols = Math.max(4, Math.round((rows * cellH * def.w) / (2 * cellW)));
    const su = def.w / cols, sv = 2 / rows;
    const grid = new Array(cols * rows).fill(null);
    for (let r = 0; r < rows; r++) {
      const v = (r + 0.5) * sv;
      for (let q = 0; q < cols; q++) {
        const u = -def.w / 2 + (q + 0.5) * su;
        for (let k = def.shapes.length - 1; k >= 0; k--) {
          const s = def.shapes[k]; const ax = s[0], ay = s[1], bx = s[2], by = s[3];
          const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9;
          let t = ((u - ax) * dx + (v - ay) * dy) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = u - (ax + dx * t), ey = v - (ay + dy * t), rr = s[4] + (s[5] - s[4]) * t + su * 0.35;
          const d2 = ex * ex + ey * ey; if (d2 > rr * rr) continue;
          const nx = ex / rr, ny = ey / rr, nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
          let sh = Math.max(0, nx * LDIR[0] + ny * LDIR[1] + nz * LDIR[2]);
          const em = s[8] || 0;
          const ramp = RAMPS[s[7]] || RAMPS.solid; const n = ramp.length - 1;
          const jitter = (M.hash2(q * 7 + 3, r * 13 + 1) - 0.5) * 0.18;
          let lv = em ? 0.55 + 0.45 * sh + jitter : 0.3 + 0.7 * sh + jitter;
          const gi = Math.max(1, Math.min(n, Math.round(lv * n)));
          const base = M.hexToRgb(s[6]); const k2 = em ? 0.85 + 0.45 * lv : 0.28 + 0.9 * lv;
          grid[r * cols + q] = [ramp[gi], css([base[0] * k2, base[1] * k2, base[2] * k2]), em];
          break;
        }
      }
    }
    for (const d of def.dots || []) {
      const q = Math.floor((d[0] + def.w / 2) / su), r = Math.floor(d[1] / sv);
      if (q >= 0 && q < cols && r >= 0 && r < rows) grid[r * cols + q] = [d[3], d[2], 0];
    }
    const cvs = mkCanvas(cols * cellW, rows * cellH);
    if (cvs) {
      const g = cvs.getContext('2d'); g.setTransform(DPR, 0, 0, DPR, 0, 0);
      g.font = fontPx + 'px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < grid.length; i++) {
          const e = grid[i]; if (!e || e[0] === ' ') continue;
          if (pass === 0 && e[2]) { g.shadowColor = e[1]; g.shadowBlur = 6 * DPR; } else if (pass === 0) g.shadowBlur = 0;
          if (pass === 1 && !e[2]) continue;
          g.fillStyle = e[1]; g.fillText(e[0], (i % cols) * cellW + cellW / 2, Math.floor(i / cols) * cellH + cellH / 2 + 0.5);
        }
        g.shadowBlur = 0;
      }
    }
    c = { canvas: cvs, w: cols * cellW, h: rows * cellH };
    if (figCache.size > 80) figCache.clear();
    figCache.set(key, c); return c;
  }
  function mkCanvas(w, h) {
    if (typeof document === 'undefined' || !document.createElement) return null;
    const c = document.createElement('canvas'); if (!c || !c.getContext) return null;
    c.width = Math.max(1, Math.ceil(w * DPR)); c.height = Math.max(1, Math.ceil(h * DPR));
    return c;
  }
  function drawFigure(id, x, y, rows, fontPx, o) {
    o = o || {};
    const frames = o.still ? 1 : id === 'fp' || id === 'goose' ? 4 : id === 'marceline' ? 3 : 1;
    const ph = frames > 1 ? (Math.floor(UI.t * (id === 'fp' ? 7 : 2.5)) % frames) / frames : 0;
    const f = figure(id, rows, fontPx, ph);
    if (!f.canvas) return f;
    if (o.alpha !== undefined) ctx.globalAlpha = o.alpha;
    ctx.drawImage(f.canvas, Math.round(x - f.w / 2), Math.round(y - f.h), f.w, f.h);
    ctx.globalAlpha = 1;
    return f;
  }

  // ======================================================================= title logo
  const LOGO_FONT = {
    A: ['.####.', '##..##', '##..##', '######', '##..##', '##..##', '##..##'],
    S: ['.#####', '##....', '##....', '.####.', '....##', '....##', '#####.'],
    H: ['##..##', '##..##', '##..##', '######', '##..##', '##..##', '##..##'],
    E: ['######', '##....', '##....', '#####.', '##....', '##....', '######'],
    O: ['.####.', '##..##', '##..##', '##..##', '##..##', '##..##', '.####.'],
    F: ['######', '##....', '##....', '#####.', '##....', '##....', '##....'],
  };
  let logoCache = null;
  function buildLogo(targetW) {
    const word = 'ASHES OF OOO', PX = 3, PY = 3, GAP = 4, SPACE = 12, DEPTH = 4, BW = 6;
    let cols = 0; for (const ch of word) cols += ch === ' ' ? SPACE : BW * PX + GAP;
    cols += DEPTH + 2; const rows = 7 * PY + DEPTH + 1;
    const grid = new Uint8Array(cols * rows); // 1 face, 2.. side
    let cx = 1;
    for (const ch of word) {
      if (ch === ' ') { cx += SPACE; continue; }
      const bm = LOGO_FONT[ch];
      for (let by = 0; by < 7; by++) for (let bx = 0; bx < BW; bx++) if (bm[by][bx] === '#') {
        for (let py = 0; py < PY; py++) for (let px = 0; px < PX; px++) grid[(by * PY + py) * cols + cx + bx * PX + px] = 1;
      }
      cx += BW * PX + GAP;
    }
    for (let d = 1; d <= DEPTH; d++) for (let r = rows - 1; r >= 0; r--) for (let q = cols - 1; q >= 0; q--) {
      if (grid[r * cols + q] !== 1) continue; const r2 = r + d, q2 = q + d;
      if (r2 < rows && q2 < cols && grid[r2 * cols + q2] === 0) grid[r2 * cols + q2] = 1 + d;
    }
    const fontPx = Math.max(5, Math.min(14, targetW / (cols * 0.6)));
    const cW = fontPx * 0.6, cH = fontPx * 1.04;
    const w = cols * cW, h = rows * cH;
    const base = mkCanvas(w, h), glow = mkCanvas(w + 60, h + 60);
    const FACE = '$&@WM#Q8B%', SIDE = ['', '', '#%', ';:', ':.', '.,'];
    const paint = (g, ox, oy, glowPass) => {
      g.setTransform(DPR, 0, 0, DPR, 0, 0); g.font = Math.round(fontPx) + 'px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
      if (glowPass) { g.shadowColor = 'rgba(255,110,30,0.9)'; g.shadowBlur = 14 * S; }
      else { // solid backing so each letter reads as a carved block, not loose glyphs on grass
        for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
          const v = grid[r * cols + q]; if (!v) continue;
          g.fillStyle = v === 1 ? '#1a120d' : '#05060a';
          g.fillRect(ox + q * cW - 0.5, oy + r * cH - 0.5, cW + 1, cH + 1);
        }
      }
      for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
        const v = grid[r * cols + q]; if (!v) continue;
        const hv = M.hash2(q * 3 + 11, r * 7 + 5);
        let ch, col;
        if (v === 1) {
          if (glowPass && r < rows * 0.35) continue;
          const tt = r / (7 * PY - 1); // 0 top .. 1 bottom (ash cooling into ember)
          const ash = [0.93, 0.9, 0.84], emb = [1.0, 0.45, 0.16];
          const k = Math.pow(tt, 2.2), br = 0.82 + hv * 0.3;
          col = css([(ash[0] + (emb[0] - ash[0]) * k) * br, (ash[1] + (emb[1] - ash[1]) * k) * br, (ash[2] + (emb[2] - ash[2]) * k) * br]);
          const top = r === 0 || grid[(r - 1) * cols + q] !== 1;
          ch = top ? (hv < 0.5 ? '=' : '"') : FACE[Math.floor(hv * FACE.length)];
        } else {
          if (glowPass) continue;
          const s = SIDE[v] || '.'; ch = s[Math.floor(hv * s.length)];
          const dk = v === 2 ? 0.5 : v === 3 ? 0.38 : v === 4 ? 0.27 : 0.18;
          col = css([0.4 * dk + 0.08, 0.45 * dk + 0.06, 0.6 * dk + 0.08]);
        }
        g.fillStyle = col; g.fillText(ch, ox + q * cW + cW / 2, oy + r * cH + cH / 2);
      }
      g.shadowBlur = 0;
    };
    if (base) paint(base.getContext('2d'), 0, 0, false);
    if (glow) paint(glow.getContext('2d'), 30, 30, true);
    return { base, glow, w, h, cols, rows, cW, cH, grid, targetW, dpr: DPR };
  }

  // ======================================================================= the UI object
  const UI = (HM.UI = {
    canvas: null, ctx: null, dpr: 1, W: 1280, H: 720, S: 1, t: 0,
    state: null, stateT: 0, focus: null, focusMem: {}, hover: null, flash: null, drag: null, _mx: -1, _my: -1,
    modal: null, pauseSub: null, codexTab: 'pages', scroll: {}, capture: null,
    toasts: [], banners: [], barks: [], parts: [], saveT: -9, goldPulse: 0, goldGain: 0,
    hoverEnemy: null, hoverInteract: null, lastHit: null, lastHitT: -9, ghosts: new Map(),
    invSel: null, socketRune: null, heroIdx: 0, ascension: 0,
    noteEntry: null, noteT: 0, deadInfo: null, errors: {},
    prompts: [], dlg: null, dialogueOpen: false, card: null, actCardOpen: false, skillFlash: null,

    init(canvas) {
      UI.canvas = canvas || null;
      UI.ctx = ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
      UI.resize();
      if (!UI._wired) { UI._wired = true; wireEvents(); }
    },

    resize() {
      const win = globalThis.window || globalThis;
      W = UI.W = (win && win.innerWidth) || 1280; H = UI.H = (win && win.innerHeight) || 720;
      DPR = UI.dpr = Math.min(2, (win && win.devicePixelRatio) || 1);
      S = UI.S = M.clamp(Math.min(W / 1280, H / 760), 0.8, 2.4);
      if (UI.canvas) {
        UI.canvas.width = Math.round(W * DPR); UI.canvas.height = Math.round(H * DPR);
        if (UI.canvas.style) { UI.canvas.style.width = W + 'px'; UI.canvas.style.height = H + 'px'; }
      }
      for (const k in cwCache) delete cwCache[k];
      figCache.clear(); logoCache = null; curFont = '';
    },

    // ------------------------------------------------------------------ public helpers
    banner(title, sub, dur, kicker) {
      const b = { title: String(title || ''), sub: sub ? String(sub) : '', kicker: kicker || '', dur: dur || 3.5, t: 0, intro: null };
      if (typeof kicker === 'object' && kicker) { b.kicker = kicker.kicker || ''; b.intro = kicker.intro || null; b.color = kicker.color; }
      // a fallen lair guardian's banner carries its defeat line (Lore.bossDefeat) unless the caller supplied lines
      if (!b.intro && /VANQUISH/i.test(b.kicker) && HM.Lore && HM.Lore.bossDefeat) {
        const B = HM.Lore.BOSSES || {}, Gm = G();
        const boss = Gm && Gm.entities ? Gm.entities.find((e) => e.isBoss && (e.displayName === b.title || e.name === b.title)) : null;
        const id = boss ? boss.defId : Object.keys(B).find((k) => B[k].name === b.title);
        const line = id && HM.Lore.bossDefeat[id];
        if (line) { b.intro = wrapBalanced(line, 84); b.dur = Math.max(b.dur, 6.5); }
      }
      const cur = UI.banners[0];
      if (cur && cur.t < cur.dur - 0.6) { // newer banners win: let the current one finish its entrance, then fade
        const out = Math.max(cur.t, 1.1);
        cur.dur = Math.min(cur.dur, out + 0.6); if (cur.t > out) cur.t = out;
      }
      if (UI.banners.length > 3) UI.banners.splice(1, UI.banners.length - 3);
      UI.banners.push(b);
    },
    toast(txt, color, dur, kind) {
      const t = { text: String(txt || ''), color: css(color, COL.text), dur: dur || 3, t: 0, kind: kind || '' };
      t.lines = []; for (const para of t.text.split('\n')) for (const l of wrap(para, 54)) t.lines.push(l);
      for (const o of UI.toasts) if (o.text === t.text && o.t < o.dur - 0.5) { o.t = Math.min(o.t, 0.2); return o; } // no duplicate spam
      UI.toasts.push(t); if (UI.toasts.length > 6) UI.toasts.shift();
      return t;
    },
    bark(actor, txt, dur) {
      if (!actor) return;
      if (!txt) txt = HM.Lore && HM.Lore.bark ? HM.Lore.bark(actor.defId) : null;
      if (!txt) return;
      UI.barks = UI.barks.filter((b) => b.actor !== actor);
      UI.barks.push({ actor, text: String(txt), t: 0, dur: dur || M.clamp(1.6 + String(txt).length * 0.05, 1.8, 4.2) });
      if (UI.barks.length > 6) UI.barks.shift();
    },
    showNote(entry) {
      if (!entry) return;
      const Gm = G();
      if (Gm && Gm.state === 'play') { UI.noteEntry = entry; UI.noteT = 0; Gm.setState('note'); }
      else openModal({ kind: 'note', entry, t: 0 });
    },
    // o: {yes, no, danger, onCancel} — Esc calls onCancel when given (else onNo)
    confirm(txt, onYes, onNo, o) {
      openModal(Object.assign({ kind: 'confirm', text: txt, onYes, onNo, yes: 'accept', no: 'decline' }, o || {}));
    },
    alert(title, txt, color) { openModal({ kind: 'alert', title, text: txt, color: color || COL.bad }); },
    // text-entry modal (profile names)
    inputPrompt(title, value, onOk, o) { openModal(Object.assign({ kind: 'input', title, value: value || '', max: 16, onOk }, o || {})); },
    // Two shapes share this name:
    //   prompt(id, {keys:[actions], text, sub, pos:'bottom'|'center'}) — tutorial keycap prompt (screen space, fades in/out)
    //   prompt(title, value, onOk, o)                                    — legacy text-entry modal (= inputPrompt)
    prompt(a, b, c, d) {
      if (typeof b === 'string' || typeof c === 'function') return UI.inputPrompt(a, b, c, d);
      return tutPrompt(a, b || {});
    },
    clearPrompt(id) { clearTutPrompt(id); },
    promptActive(id) { return UI.prompts.some((p) => p.id === id && p.out === null); },
    // dialogue box: {speaker, title, lines:[...], onDone, npc?, color?}. Player verbs are suppressed while open.
    dialogue(o) { return openDialogue(o || {}); },
    closeDialogue(callDone) { closeDialogue(!!callDone); }, // force-close; true also runs its onDone
    // full-screen act card (typewriter lines from Lore.acts[act].card); any key skips; the world is frozen meanwhile
    actCard(act, onDone) {
      if (!autoActCards()) { if (onDone) try { onDone(); } catch (e) { console.error('[UI] actCard onDone', e); } return false; }
      return openActCard(act, onDone);
    },
    // skill name flashes above the player for its first ~3 uses (per profile)
    flashSkill(name) { flashSkill(name); },

    // ------------------------------------------------------------------ update (input)
    update(dt) {
      restoreInput();
      UI.t += dt; UI.stateT += dt;
      const Gm = G(); if (!Gm) return;
      if (Gm.state !== UI.state) onState(Gm.state, UI.state);
      tickTimers(dt);
      if (Gm.state === 'play') trackPlay(dt);
      if (UI.capture) return; // waiting for a key (remap) — Input.capturing handles it
      if (UI.modal) { if (Gm.state === 'play' && (UI.dlg || UI.card)) suppressPlayInput(); updateModal(); return; }
      const st = Gm.state;
      const I = HM.Input;
      switch (st) {
        case 'play': if (!updateOverlays(dt)) updatePlayInput(); break;
        case 'title': if (!processNav({})) maybeFirstLaunch(); break;
        case 'slots': processNav({ back: () => Gm.setState('title') }); break;
        case 'heroSelect': processNav({ back: () => Gm.setState('title') }); break;
        case 'options': processNav({ back: () => Gm.setState('title'), wheel: (d) => scrollBy('opt', d) }); break;
        case 'codex': {
          if (I.pressed.has('KeyQ') || I.pressed.has('PageUp')) { codexTabStep(-1); break; }
          if (I.pressed.has('KeyE') || I.pressed.has('PageDown')) { codexTabStep(1); break; }
          processNav({ back: () => Gm.setState('title'), wheel: (d) => scrollBy('codex', d) }); break;
        }
        case 'heirlooms': processNav({ back: () => Gm.setState('title') }); break;
        case 'pause': {
          if (UI.pauseSub === 'options') { processNav({ back: () => { UI.pauseSub = null; UI.focus = 'p:options'; }, wheel: (d) => scrollBy('opt', d) }); break; }
          if (UI.pauseSub === 'moves') {
            if (I.wasPressed('pause') && !I.pressed.has('Escape')) { swallowKeys(); UI.pauseSub = null; UI.focus = 'p:moves'; sfx('ui_back'); break; }
            processNav({ back: () => { UI.pauseSub = null; UI.focus = 'p:moves'; } }); break;
          }
          if (I.pressed.has('Escape') || I.wasPressed('pause')) { swallowKeys(); Gm.setState('play'); sfx('ui_back'); break; }
          processNav({ back: () => Gm.setState('play') }); break;
        }
        case 'inventory': {
          if ((I.wasPressed('inventory') || I.pressed.has('Escape')) && !UI.socketRune) { swallowKeys(); Gm.setState('play'); sfx('ui_back'); break; }
          if (I.pressed.has('Escape') && UI.socketRune) { UI.socketRune = null; break; }
          if ((I.pressed.has('KeyX') || I.pressed.has('Delete')) && UI.focus && UI.focus.startsWith('bag:')) { const it = findItemByUid(UI.focus.slice(4)); if (it) discardItem(it); break; }
          if (I.pressed.has('KeyC') && UI.focus && UI.focus.startsWith('bag:')) { const it = findItemByUid(UI.focus.slice(4)); if (it) salvageItem(it); break; }
          processNav({ back: () => Gm.setState('play') }); break;
        }
        case 'boon': {
          const d = (Gm.menuData && Gm.menuData.draft) || [];
          for (let i = 0; i < 3; i++) if (I.pressed.has('Digit' + (i + 1)) && d[i]) { chooseBoon(d[i]); return; }
          if (I.pressed.has('KeyR') && Gm.run && Gm.run.rerolls > 0) { sfx('ui_select'); Gm.rerollBoons(); return; }
          processNav({}); break;
        }
        case 'shop': processNav({ back: () => Gm.setState('play') }); break;
        case 'note': {
          const k = keys();
          if (k.ok || k.back || I.pressed.has('Mouse0') || I.wasPressed('interact')) {
            const full = noteReveal() >= ((UI.noteEntry && UI.noteEntry.text) || '').length;
            swallowMouse(); swallowKeys();
            if (!full && !k.back) UI.noteT = 99; else { Gm.setState('play'); sfx('ui_back'); }
          }
          break;
        }
        case 'dead': case 'victory': processNav({ back: () => toTitle() }); break;
        default: processNav({});
      }
    },

    // ------------------------------------------------------------------ draw
    draw() {
      restoreInput(); // player input suppressed during this frame's game update (dialogue / act card) is live again
      if (!ctx) return;
      const Gm = G(); if (!Gm) return;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.globalAlpha = 1; curFont = ''; ctx.font = '12px ' + FONT;
      building = []; layer = 'screen';
      const st = Gm.state;
      const inRun = !!(Gm.run && Gm.player && Gm.floor);
      const playish = st === 'play' || st === 'pause' || st === 'inventory' || st === 'note' || st === 'shop' || st === 'boon';
      const cardCovers = !!(UI.card && UI.card.t > 0.35 && UI.card.out === null && st === 'play');
      if (inRun && (playish || st === 'dead') && !cardCovers) safe('world', drawWorldOverlays);
      if (inRun && playish) safe('hud', () => drawHUD(st !== 'play'));
      if (inRun && st === 'play') safe('story', drawStoryOverlays);
      switch (st) {
        case 'title': safe('title', drawTitle); break;
        case 'slots': safe('slots', drawSlots); break;
        case 'heroSelect': safe('heroSelect', drawHeroSelect); break;
        case 'options': safe('options', () => { backdropDim(0.55); drawOptions(); }); break;
        case 'codex': safe('codex', drawCodex); break;
        case 'heirlooms': safe('heirlooms', drawHeirlooms); break;
        case 'pause': safe('pause', drawPause); break;
        case 'inventory': safe('inventory', drawInventory); break;
        case 'boon': safe('boon', drawBoon); break;
        case 'shop': safe('shop', drawShop); break;
        case 'note': safe('note', drawNoteState); break;
        case 'dead': safe('dead', drawDead); break;
        case 'victory': safe('victory', drawVictory); break;
      }
      if (!UI.card) safe('banner', drawBanner);
      safe('toasts', drawToasts);
      if (UI.card && inRun && st === 'play') safe('actCard', drawActCard);
      if (UI.capture) safe('capture', drawCapture);
      if (UI.modal) { layer = 'modal'; safe('modal', drawModal); layer = 'screen'; }
      safe('misc', drawMisc);
      safe('cursor', drawCursor);
      hits = building;
      hitsKey = st + '|' + (UI.modal ? 'm' : '') + '|' + (UI.pauseSub || '') + '|' + (UI.codexTab || '');
      // keep focus valid
      const want = UI.modal ? 'modal' : 'screen';
      if (UI.focus && !hits.some((h) => h.layer === want && h.focusable && h.id === UI.focus)) {
        const f = hits.find((h) => h.layer === want && h.focusable && h.def) || hits.find((h) => h.layer === want && h.focusable);
        UI.focus = f ? f.id : null;
      } else if (!UI.focus) {
        const f = hits.find((h) => h.layer === want && h.focusable && h.def) || hits.find((h) => h.layer === want && h.focusable);
        if (f) UI.focus = f.id;
      }
    },
  });

  function safe(name, fn) {
    try { fn(); } catch (e) {
      ctx.globalAlpha = 1; ctx.shadowBlur = 0;
      if (HM.headless) throw e;
      if (!UI.errors[name]) { UI.errors[name] = 1; console.error('[UI ' + name + ']', e); }
    }
  }

  // ======================================================================= events / achievements
  function ach(id) { if (HM.Save && HM.Save.unlockAchievement) HM.Save.unlockAchievement(id); }
  function tally(k, n) {
    const m = meta(); if (!m) return 0;
    m.tally = m.tally || {}; m.tally[k] = (m.tally[k] || 0) + (n || 1); return m.tally[k];
  }
  function wireEvents() {
    const E = HM.Events; if (!E) return;
    E.on('state', (e) => onState(e.state, e.prev));
    E.on('floorStart', (e) => {
      const f = e.floor || (G() && G().floor) || {};
      UI.ghosts.clear(); UI.lastHit = null; UI.barks = []; UI._chestSeen = new Set(); UI._bossSeen = new Map(); UI.bigMap = false; UI._hits = [];
      UI.banners = [];
      // a new floor clears the previous floor's scripted overlays (tutorial prompts, an unfinished conversation)
      UI.prompts.length = 0; if (UI.dlg) closeDialogue(false); UI.skillFlash = null; UI._lastAct = null;
      if (f.isPrologue) {
        const P = (HM.Lore && HM.Lore.prologue) || {};
        UI.banner(P.title || 'The Tree Fort Clearing', P.sub || 'before the descent', 4.2, { kicker: 'PROLOGUE', color: '#7fd6c0' });
        UI.objFlash = 0; return;
      }
      const intro = HM.Lore && HM.Lore.floorIntro ? HM.Lore.floorIntro(f.act || 1, f.inAct || 1) : { title: f.actName || 'Ooo', sub: '' };
      const kick = 'ACT ' + roman(f.act || 1) + ' · ' + String(f.actName || intro.act || '').toUpperCase() + ' · FLOOR ' + (f.index || 1);
      // each act opens with its act card (DESIGN §9D); the floor banner then plays without repeating the intro lines
      const card = (f.inAct || 1) === 1 && !e.resumed && autoActCards() && openActCard(f.act || 1, null, true);
      UI.banner(intro.title, e.resumed ? 'returned to the start of this floor' : intro.sub, intro.intro && !card ? 6 : 4.2, { kicker: kick, intro: card ? null : intro.intro, color: intro.color });
      if ((f.act || 1) >= 2) ach('act_' + f.act);
      UI.objFlash = 0;
    });
    E.on('bossIntro', (e) => {
      const b = e && e.boss; if (!b) return;
      for (const bn of UI.banners) if (bn.title === (b.displayName || b.name)) { bn.kicker = 'LAIR GUARDIAN · ACT ' + roman((G().floor && G().floor.act) || 1); bn.color = '#e0644a'; bn.dur = Math.max(bn.dur, 4.2); }
      UI.bossFlash = { t: UI.t, boss: b, text: '' };
    });
    E.on('bossPhase', (e) => { if (e && e.boss) UI.bossFlash = { t: UI.t, boss: e.boss, text: 'PHASE ' + roman(e.phase || e.boss.phase || 2) }; });
    E.on('exitOpen', () => { UI.toast('THE DUNGEON DOOR IS OPEN', COL.witch, 3.2); UI.objFlash = UI.t; hint('exit'); });
    E.on('bossIntro', () => hint('boss'));
    E.on('itemPickup', () => hintVerb('itemPickup'));
    E.on('damage', (e) => { const Gm = G(); if (e && e.target && Gm && e.target === Gm.player && !e.isDot && e.dealt > 0) (UI._hits = UI._hits || []).push(Gm.t); });
    E.on('evade', (e) => { const Gm = G(); if (e && Gm && e.target === Gm.player) { UI._hits = []; hintVerb('dodge'); } });
    E.on('levelup', (e) => {
      UI.toast('LEVEL ' + e.level + '\n+1 boon point', COL.xp, 2.6);
      UI.xpFlash = UI.t;
      if (e.level >= 10) ach('level_10');
      const p = G() && G().player;
      if (p && Math.random() < 0.45) UI.bark(p, HM.Lore && HM.Lore.bark(p.heroId || (G().run && G().run.heroId)));
    });
    E.on('gold', (e) => { if (e && e.amount > 0) { UI.goldPulse = UI.t; UI.goldGain = (UI.t - (UI._goldT || -9) < 1.5 ? UI.goldGain : 0) + e.amount; UI._goldT = UI.t; } });
    E.on('saved', () => { UI.saveT = UI.t; });
    E.on('itemPickup', (e) => {
      const it = e && e.item; if (!it) return;
      const run = e.run || (G() && G().run); const eq = run && run.inventory && run.inventory.equipped;
      UI.toast('+ ' + (it.name || 'item') + (eq && eq[it.slot] === it ? '  (equipped)' : ''), rarityColor(it.rarity), 2.4);
    });
    E.on('saveError', (msg) => UI.toast('SAVE FAILED\n' + (msg || 'storage error'), COL.bad, 5));
    E.on('achievement', (id) => {
      const a = HM.Lore && HM.Lore.achievement ? HM.Lore.achievement(id) : null;
      UI.toast('ACHIEVEMENT\n' + (a ? a.name : id) + (a ? '\n' + a.desc : ''), COL.gold, 4.8, 'ach');
      sfx('boon');
    });
    E.on('noteRead', () => { const m = meta(); if (m && Object.keys(m.codex || {}).filter((k) => k.indexOf('remnant_') !== 0).length >= 5) ach('notes_5'); });
    E.on('damage', (info) => {
      if (!info || !info.target) return;
      if (info.source && info.source.kind === 'player' && info.target.team === 1 && !info.isDot) { UI.lastHit = info.target; UI.lastHitT = UI.t; }
      if (info.target.kind === 'player' && info.dealt > 0) {
        UI.hurtT = UI.t;
        // the hero cannot act while talking, so a real hit cuts the conversation short (its onDone still runs)
        if (UI.dlg && !info.isDot && UI.dlg.t > 0.3) { closeDialogue(true); UI.toast('the conversation is cut short', COL.bad, 2); }
      }
    });
    E.on('kill', (e) => {
      const t = e && e.target, Gm = G(); if (!t || !Gm || !Gm.run || t.kind === 'player' || t.team !== 1) return;
      ach('first_blood');
      if (t.isElite) { ach('elite_slayer'); UI.toast('ELITE SLAIN\n' + (t.displayName || t.name || 'elite') + ' · +1 boon point', COL.elite, 2.8); }
      if (t.isBoss) { ach(t.defId === 'lich' ? 'slay_lich' : 'boss_' + t.defId); const p = Gm.player; if (p && !p.dead) UI.bark(p, HM.Lore && HM.Lore.bark(Gm.run.heroId)); }
      const m = meta(); const total = (m ? m.kills || 0 : 0) + (Gm.run.kills || 0) + 1;
      if (total >= 100) ach('kills_100'); if (total >= 500) ach('kills_500');
    });
  }

  function onState(st, prev) {
    if (st === UI.state && prev === undefined) return;
    if (UI.state && UI.state !== st) UI.focusMem[UI.state] = UI.focus;
    const sameState = st === UI.state;
    UI.state = st; UI.stateT = 0;
    if (!(UI.modal && UI.modal.keep)) UI.modal = null;
    if (UI.capture && HM.Input.capturing) HM.Input.capturing = null;
    UI.capture = null; UI.drag = null; UI.hover = null;
    UI.focus = sameState ? null : (st === 'title' || st === 'slots' || st === 'codex' || st === 'options' || st === 'heirlooms') ? UI.focusMem[st] || null : null;
    if (st !== 'pause') UI.pauseSub = null;
    if (st !== 'inventory') UI.socketRune = null;
    if (st === 'play') swallowMouse();
    const Gm = G();
    // leaving the run drops its scripted overlays (no onDone: the run they belonged to is over)
    if (!RUN_STATES[st]) { if (UI.card) closeActCard(false); if (UI.dlg) closeDialogue(false); UI.prompts.length = 0; UI.skillFlash = null; }
    if (st === 'title') UI._forcePrologue = false;
    if (st === 'heroSelect') { const m = meta(); UI.ascension = m ? M.clamp(m.ascension || 0, 0, m.maxAscension || 0) : 0; }
    if (st === 'dead') {
      const d = (Gm && Gm.menuData) || {}; const run = d.run || (Gm && Gm.run) || {};
      const killer = d.killer;
      const kName = d.killedBy || (killer && (killer.displayName || killer.name)) || 'the dark';
      UI.deadInfo = {
        run, ashes: d.ashes || 0, killedBy: kName,
        epitaph: HM.Lore && HM.Lore.epitaph ? HM.Lore.epitaph(run, kName, Gm && Gm.player ? { name: heroInfo(run.heroId).name, title: heroInfo(run.heroId).title } : null) : 'Here lies a hero.',
        tip: HM.Lore && HM.Lore.tips ? HM.Lore.tips[Math.floor(Math.random() * HM.Lore.tips.length)] : '',
      };
      if ((killer && killer.defId === 'snail') || /snail/i.test(kName)) ach('snail_death');
    }
    if (st === 'victory') {
      const d = (Gm && Gm.menuData) || {}; const run = d.run || (Gm && Gm.run) || {};
      if (!run.usedPotion) ach('no_potions');
      if ((run.ascension || 0) >= 1) ach('ascendant');
      UI.victoryInfo = { run, ashes: d.ashes || 0 };
    }
    if (st === 'note') UI.noteT = 0;
  }

  // per-frame bookkeeping during play: potion use, pickups collected, chests opened
  // ======================================================================= just-in-time hints (DESIGN §9B)
  // One small prompt at a time, above the XP bar; each is shown once per profile (meta.hintsSeen) and fades
  // early once its verb is performed. Options → Hints turns them off.
  const HINTS = {
    move: { text: () => K('up') + K('left') + K('down') + K('right') + ' move   ' + K('attack') + ' attack   ' + K('dodge') + ' roll through attacks', done: () => (UI._movedT || 0) > 2.2 },
    loot: { text: () => K('interact') + ' take loot · label colour shows rarity', done: (e) => e === 'itemPickup' },
    gold: { text: () => 'walk over gold and it jumps into your purse' },
    bagfull: { text: () => 'your pack is full · ' + K('inventory') + ' to salvage (C) or drop (RMB)' },
    elite: { text: () => 'an ELITE · its affixes glow above the name · slay it to wake the Dungeon Door' },
    status: { text: (id) => (id === 'poison' || id === 'rot' ? 'poisoned · it ticks while it lasts — a pancake outheals it' : id === 'burn' ? 'burning · step out of the fire, it refreshes while you stand in it' : id === 'chill' || id === 'freeze' ? 'chilled · you are slowed; frozen foes shatter, so do you' : id === 'bleed' ? 'bleeding · it hurts more while you move' : id === 'doom' ? 'doomed · the Lich\'s curse — keep fighting, it fades' : 'afflicted') },
    lowhp: { text: () => K('potion1') + ' Bacon Pancakes heal 35% over 2 s', done: (e) => e === 'potion' },
    ult: { text: () => K('ult') + ' your ultimate is ready', done: (e) => e === 'ult' },
    dodge: { text: () => K('dodge') + ' rolls THROUGH attacks · you are untouchable mid-roll', done: (e) => e === 'dodge' },
    shrine: { text: () => K('interact') + ' shrines grant one blessing each floor' },
    chest: { text: () => K('interact') + ' open the chest' },
    note: { text: () => K('interact') + ' read the page · it is kept in the Codex' },
    merchant: { text: () => K('interact') + ' Choose Goose trades gold for gear, runes and pancakes' },
    exit: { text: () => 'the Dungeon Door is open · find it on the map ' + K('map') + ' then ' + K('interact') + ' to descend' },
    boss: { text: () => 'dotted rings fill, then strike · roll out before they close' },
    runes: { text: () => K('inventory') + ' socket runes: pick a rune chip, then click a weapon' },
    story: { text: () => K('interact') + ' speak · the remnants of Ooo remember what happened here' },
    moves: { text: () => K('pause') + ' pause · the Moves page lists every verb, cost and combo' },
  };
  function K(a) { return '[' + (HM.Input && HM.Input.actionLabel ? HM.Input.actionLabel(a) : a) + '] '; }
  function hintSeen(id) { const m = HM.Save && HM.Save.data && HM.Save.data.meta; return !!(m && m.hintsSeen && m.hintsSeen[id]); }
  function hint(id, arg) {
    if (setting('hints', true) === false || hintSeen(id) || !HINTS[id]) return false;
    if (UI.hint && UI.hint.t < UI.hint.dur - 0.5) { if (!UI.hintQ.some((h) => h.id === id)) UI.hintQ.push({ id, arg }); return false; }
    const m = HM.Save && HM.Save.data && HM.Save.data.meta; if (m) { m.hintsSeen = m.hintsSeen || {}; m.hintsSeen[id] = 1; }
    UI.hint = { id, text: HINTS[id].text(arg), t: 0, dur: id === 'move' ? 9 : 6 };
    return true;
  }
  function hintVerb(e) { const h = UI.hint; if (h && HINTS[h.id].done && HINTS[h.id].done(e) && h.t < h.dur - 0.6) h.dur = h.t + 0.6; }
  UI.hintQ = []; UI.hint = null;
  function pollHints(dt) {
    const Gm = G(), p = Gm.player, run = Gm.run, f = Gm.floor; if (!p || !run || !f || p.dead) return;
    const I = HM.Input;
    if (p.moving) UI._movedT = (UI._movedT || 0) + dt;
    if (I.wasPressed('ult')) hintVerb('ult'); if (I.wasPressed('potion1')) hintVerb('potion'); if (I.wasPressed('dodge')) hintVerb('dodge');
    if (UI.hint) { UI.hint.t += dt; if (HINTS[UI.hint.id].done && HINTS[UI.hint.id].done()) hintVerb(); if (UI.hint.t >= UI.hint.dur) { UI.hint = null; const q = UI.hintQ.shift(); if (q) hint(q.id, q.arg); } }
    if (setting('hints', true) === false) return;
    if (f.isPrologue || UI.dlg || UI.card) return; // the prologue teaches with its own prompts; never talk over a conversation
    UI._hintT = (UI._hintT || 0) - dt; if (UI._hintT > 0) return; UI._hintT = 0.25;
    if (Gm.stateT > 1.2 && run.floorIndex === 1) hint('move');
    if (Gm.stateT > 40 && run.floorIndex === 1) hint('moves');
    if (Gm.interactTarget) {
      const t = Gm.interactTarget;
      if (Gm.pickups.indexOf(t) >= 0 && t.kind === 'item') hint('loot');
      else if (HINTS[t.kind] && t.kind !== 'portal') hint(t.kind);
    }
    for (const o of Gm.pickups) if (o.kind === 'gold' && M.dist(o.x, o.y, p.x, p.y) < 150) { hint('gold'); break; }
    const inv = run.inventory;
    if (inv && inv.bag && HM.Items && inv.bag.length >= (HM.Items.BAG_CAP || 20)) hint('bagfull');
    if (inv && inv.runes) { for (const k in inv.runes) if (inv.runes[k] > 0) { hint('runes'); break; } }
    for (const a of Gm.entities) if (a.isElite && !a.dead && a.team === 1 && M.dist(a.x, a.y, p.x, p.y) < 420) { hint('elite'); break; }
    for (const st of p.statuses || []) if (st.id === 'poison' || st.id === 'burn' || st.id === 'chill' || st.id === 'bleed' || st.id === 'rot' || st.id === 'doom') { hint('status', st.id); break; }
    if (p.hp01 < 0.4 && run.consumables && run.consumables.pancake > 0) hint('lowhp');
    const ult = (p.skills || []).find((k) => k.slot === 'ult');
    if (ult && ult.cdLeft <= 0 && Gm.stateT > 20) hint('ult');
    // repeatedly hit without rolling
    const now = Gm.t; UI._hits = (UI._hits || []).filter((x) => now - x < 6);
    if (UI._hits.length >= 4) hint('dodge');
  }
  function trackPlay(dt) {
    const Gm = G(), run = Gm.run, p = Gm.player; if (!run || !p) return;
    safe('hints', () => pollHints(dt || 1 / 60));
    const c = run.consumables || {};
    if (UI._potRun === run) {
      if ((c.pancake || 0) < UI._potP || (c.tonic || 0) < UI._potT) run.usedPotion = true;
    }
    UI._potRun = run; UI._potP = c.pancake || 0; UI._potT = c.tonic || 0;
    // a new heavy / skill / ult action → flash its name above the hero (first ~3 uses per profile)
    const act = p.act;
    if (act && act !== UI._lastAct && FLASH_SLOTS[act.slot]) {
      const sk = (p.skills || []).find((s) => s.slot === act.slot);
      if (sk && sk.name) flashSkill(sk.name);
    }
    UI._lastAct = act || null;
    // chests
    const f = Gm.floor; if (f && f.interactables) {
      UI._chestSeen = UI._chestSeen || new Set();
      for (const o of f.interactables) if (o.kind === 'chest' && (o.used || o.opened) && !UI._chestSeen.has(o)) {
        UI._chestSeen.add(o);
        if (tally('chests') >= 10) ach('chests_10');
      }
    }
  }

  const TOAST_HOLD = { inventory: 1, shop: 1, boon: 1, note: 1 }; // big panels: toasts wait (frozen) until the panel closes
  function tickTimers(dt) {
    const hold = TOAST_HOLD[G() && G().state] || !!UI.card; // toasts wait under big panels and act cards
    if (!hold) for (const t of UI.toasts) t.t += dt;
    UI.toasts = UI.toasts.filter((t) => t.t < t.dur);
    const b = UI.banners[0]; if (b && !UI.card) { b.t += dt; if (b.t >= b.dur) UI.banners.shift(); }
    tickStory(dt);
    for (const b2 of UI.barks) b2.t += dt;
    UI.barks = UI.barks.filter((b2) => b2.t < b2.dur && b2.actor && !b2.actor.removeMe);
    // ghost hp trails
    for (const [id, g] of UI.ghosts) { g.v = M.damp(g.v, g.a.hp, g.v > g.a.hp ? 3.2 : 30, dt); if (g.a.removeMe || g.a.dead && g.v < 1) UI.ghosts.delete(id); }
    UI.noteT += dt;
  }
  function ghostOf(a) {
    let g = UI.ghosts.get(a.id);
    if (!g) { g = { a, v: a.hp }; UI.ghosts.set(a.id, g); }
    return Math.max(a.hp, g.v);
  }

  // ======================================================================= modals
  function openModal(m) {
    if (!UI.modal) UI._screenFocus = UI.focus;
    if (m.t === undefined) m.t = 0; UI.modal = m; UI.focus = null;
  }
  function closeModal() { UI.modal = null; UI.focus = UI._screenFocus || null; swallowMouse(); swallowKeys(); }
  function updateModal() {
    const m = UI.modal; const I = HM.Input;
    m.t = (m.t || 0) + (HM.Game.realT - (m._rt || HM.Game.realT)); m._rt = HM.Game.realT;
    if (m.kind === 'input') {
      for (const ch of I.typed) {
        if (ch === 'Backspace') m.value = m.value.slice(0, -1);
        else if (ch === 'Enter') { const v = m.value.trim(); if (v) { closeModal(); sfx('ui_select'); m.onOk && m.onOk(v); } else sfx('ui_error'); return; }
        else if (ch.length === 1 && /[A-Za-z0-9 _\-'.!?]/.test(ch) && m.value.length < (m.max || 16)) { m.value += ch; sfx('ui_move'); }
      }
      processNav({ keyboard: false, back: () => { closeModal(); m.onCancel && m.onCancel(); } });
      return;
    }
    if (m.kind === 'note') {
      const k = keys();
      if (k.back || k.ok) { swallowKeys(); const full = (m.t || 0) * 90 >= m.entry.text.length; if (!full && k.ok) m.t = 99; else { closeModal(); sfx('ui_back'); } }
      else processNav({ keyboard: false });
      return;
    }
    if (m.kind === 'alert') { processNav({ back: () => closeModal() }); return; }
    if (m.kind === 'confirm') { processNav({ back: () => { closeModal(); if (m.onCancel) m.onCancel(); else if (m.onNo) m.onNo(); } }); return; }
    processNav({ back: () => closeModal() });
  }
  function drawModal() {
    const m = UI.modal;
    fill(0, 0, W, H, 'rgba(0,0,0,0.55)');
    if (m.kind === 'note') return drawNoteReader(m.entry, (m.t || 0), false);
    const pxT = fpx(12);
    const lines = [];
    if (m.kind === 'input') lines.push(m.title || 'Enter a name');
    else for (const para of String(m.text || '').split('\n')) for (const l of wrap(para, 62)) lines.push(l);
    let maxLen = 0; for (const l of lines) maxLen = Math.max(maxLen, l.length);
    const w = Math.max(360 * S, Math.min(W - 40, tw('M'.repeat(maxLen), pxT) + 56 * S));
    const lh = 18 * S, bh = 26 * S;
    const extra = m.kind === 'input' ? 40 * S : 0;
    const titleH = m.kind === 'alert' && m.title ? 26 * S : 0;
    const h = 34 * S + titleH + lines.length * lh + extra + bh + 24 * S;
    const x = (W - w) / 2, y = (H - h) / 2;
    panel(x, y, w, h, { border: m.kind === 'alert' ? m.color : m.danger ? '#d07a6a' : COL.border, bg: '#020203' });
    let cy = y + 24 * S;
    if (titleH) { spaced(m.title, x + w / 2, cy, m.color || COL.bad, fpx(12), 'center'); cy += titleH; }
    for (let i = 0; i < lines.length; i++) text(lines[i], x + w / 2, cy + i * lh, i === 0 && m.kind === 'input' ? COL.dim : COL.text, pxT, 'center');
    cy += lines.length * lh;
    if (m.kind === 'input') {
      const fw = Math.min(w - 60 * S, 300 * S), fx = x + (w - fw) / 2, fy = cy + 2 * S, fh = 26 * S;
      fill(fx, fy, fw, fh, '#000'); box(fx, fy, fw, fh, COL.hiBorder);
      const caret = Math.floor(UI.t * 2) % 2 ? '_' : ' ';
      text(m.value + caret, fx + 10 * S, fy + fh / 2 + 1, '#fff', fpx(13));
      text(m.value.length + '/' + (m.max || 16), fx + fw - 8 * S, fy + fh / 2 + 1, COL.faint, fpx(10), 'right');
      cy += extra;
    }
    const by = cy + 12 * S;
    if (m.kind === 'alert') {
      button('m:ok', x + w / 2 - 50 * S, by, 100 * S, bh, 'ok', () => closeModal());
    } else if (m.kind === 'input') {
      button('m:ok', x + w / 2 - 110 * S, by, 100 * S, bh, 'confirm', () => { const v = m.value.trim(); if (v) { closeModal(); m.onOk && m.onOk(v); } });
      button('m:no', x + w / 2 + 10 * S, by, 100 * S, bh, 'cancel', () => { closeModal(); m.onCancel && m.onCancel(); });
    } else {
      const bw = Math.max(100 * S, tw(m.yes, fpx(12)) + 30 * S);
      const yes = button('m:yes', x + w / 2 - bw - 8 * S, by, bw, bh, m.yes, () => { closeModal(); m.onYes && m.onYes(); }, { hiBorder: m.danger ? '#ff8a7a' : undefined });
      const no = button('m:no', x + w / 2 + 8 * S, by, bw, bh, m.no, () => { closeModal(); m.onNo && m.onNo(); });
      (m.danger ? no : yes).def = true;
    }
  }

  // ======================================================================= scrolling lists
  function scrollBy(key, d) { UI.scroll[key] = Math.max(0, (UI.scroll[key] || 0) + d * 3); }
  // Ensure the focused row (index fi) is visible; returns the first visible row index.
  function listScroll(key, n, visible, fi) {
    let s = UI.scroll[key] || 0;
    if (fi >= 0) { if (fi < s) s = fi; if (fi >= s + visible) s = fi - visible + 1; }
    s = M.clamp(s, 0, Math.max(0, n - visible)); UI.scroll[key] = s; return s;
  }
  function scrollbar(x, y, h, first, visible, n) {
    if (n <= visible) return;
    fill(x, y, 1, h, COL.dimBorder);
    const th = Math.max(10 * S, (h * visible) / n), ty = y + ((h - th) * first) / Math.max(1, n - visible);
    fill(x - 1, ty, 3, th, COL.border);
  }

  // ======================================================================= backdrop helpers
  function backdropDim(a) {
    fill(0, 0, W, H, 'rgba(0,0,0,' + a + ')');
    if (ctx.createRadialGradient) {
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.75);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.6)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
  }
  function header(title, sub) {
    spaced(title, W / 2, 34 * S, COL.text, fpx(15), 'center', 0.6);
    const w = tw(title, fpx(15)) * 1.6;
    text('-=<', W / 2 - w / 2 - 22 * S, 34 * S, COL.faint, fpx(12), 'right');
    text('>=-', W / 2 + w / 2 + 22 * S, 34 * S, COL.faint, fpx(12));
    if (sub) text(sub, W / 2, 56 * S, COL.dim, fpx(11), 'center');
  }
  function footerHint(str) {
    const st = HM.Game.state, hud = HM.Game.run && (st === 'pause' || st === 'inventory' || st === 'boon' || st === 'shop' || st === 'note');
    text(str, W / 2, hud && UI._hudTop ? UI._hudTop - 12 * S : H - 16 * S, COL.faint, fpx(10), 'center', { shadow: true });
  }

  // ======================================================================= ambient particles (title / death)
  function updateParts(kind, dt, spawnFn) {
    const P = UI.parts;
    spawnFn && spawnFn(P);
    for (const p of P) { p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx += Math.sin(UI.t * 2 + p.s * 9) * 6 * dt; }
    UI.parts = P.filter((p) => p.t < p.life && p.y > -20 && p.y < H + 20);
  }
  function drawParts() {
    const px = fpx(11); setFont(px);
    for (const p of UI.parts) {
      const a = Math.sin(Math.PI * clamp01(p.t / p.life));
      ctx.globalAlpha = a * (p.a || 1);
      ctx.fillStyle = p.c; ctx.fillText(p.ch, snap(p.x), snap(p.y));
    }
    ctx.globalAlpha = 1;
  }

  // ======================================================================= TITLE
  const TITLE_ITEMS = [
    { id: 'continue', label: 'Continue' }, { id: 'new', label: 'New Run' }, { id: 'profiles', label: 'Profiles' },
    { id: 'options', label: 'Options' }, { id: 'codex', label: 'Codex' }, { id: 'heirlooms', label: 'Heirlooms' },
  ];
  function maybeFirstLaunch() {
    if (UI._firstAsked || UI.modal || (HM.Save && HM.Save.data) || HM.Game.stateT < 0.3) return;
    UI._firstAsked = true;
    const list = HM.Save && HM.Save.list ? HM.Save.list() : [];
    if (list.some((s) => s.exists)) return;
    newProfileFlow(1, true);
  }
  function newProfileFlow(slot, first) {
    UI.inputPrompt(first ? 'The grass has grown over every name. What was yours?' : 'Name this wanderer (slot ' + slot + ')', '', (name) => {
      const d = HM.Save.use(slot, name); dirtySlots();
      if (d) { UI.toast('Welcome to Ooo, ' + name + '.', COL.witch, 3); sfx('ui_select'); if (HM.Game.state !== 'title') HM.Game.setState('title'); }
      else UI.alert('PROFILE ERROR', HM.Save.lastError || 'Could not create the profile.');
    }, { max: 16, value: first ? 'Wanderer' : '' });
  }
  function titleAction(id) {
    const Gm = HM.Game, d = HM.Save.data;
    if (id === 'continue') { if (d && d.run) { if (!Gm.resumeRun()) UI.alert('CANNOT CONTINUE', 'The saved run could not be restored.'); } return; }
    if (id === 'new') { if (!d) { newProfileFlow(firstFreeSlot(), false); return; } Gm.setState('heroSelect'); return; }
    if (id === 'newprofile') { newProfileFlow(firstFreeSlot(), false); return; }
    if (id === 'profiles') { Gm.setState('slots'); return; }
    if (id === 'options') { Gm.setState('options'); return; }
    if (id === 'codex') { Gm.setState('codex'); return; }
    if (id === 'heirlooms') { Gm.setState('heirlooms'); return; }
    if (id === 'prologue') { Gm.setState('heroSelect'); UI._forcePrologue = true; return; } // hero select → newRun({prologue:true})
  }
  function firstFreeSlot() { const l = HM.Save.list ? HM.Save.list() : []; const f = l.find((s) => !s.exists); return f ? f.slot : 1; }
  function drawTitle() {
    const dt = Math.min(0.05, HM.Game.realT - (UI._titleRT || HM.Game.realT)); UI._titleRT = HM.Game.realT;
    // atmosphere: darken top & bottom bands
    if (ctx.createLinearGradient) {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, 'rgba(0,0,0,0.78)'); g.addColorStop(0.4, 'rgba(0,0,0,0.42)'); g.addColorStop(0.7, 'rgba(0,0,0,0.5)'); g.addColorStop(1, 'rgba(0,0,0,0.88)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    // logo
    const targetW = Math.min(W * 0.78, 1040 * S);
    if (!logoCache || Math.abs(logoCache.targetW - targetW) > 2 || logoCache.dpr !== DPR) logoCache = buildLogo(targetW);
    const L = logoCache, lx = Math.round((W - L.w) / 2), ly = Math.round(H * 0.25 - L.h / 2);
    if (ctx.createRadialGradient) { // shade the world behind the logo
      ctx.save(); ctx.translate(W / 2, ly + L.h / 2); ctx.scale((L.w * 0.62) / (L.h * 0.9), 1);
      const g3 = ctx.createRadialGradient(0, 0, 0, 0, 0, L.h * 0.9);
      g3.addColorStop(0, 'rgba(0,0,0,0.7)'); g3.addColorStop(0.7, 'rgba(0,0,0,0.5)'); g3.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g3; ctx.fillRect(-L.h * 0.9, -L.h * 0.9, L.h * 1.8, L.h * 1.8); ctx.restore(); curFont = '';
    }
    const pulse = 0.55 + 0.25 * Math.sin(UI.t * 1.7) + 0.1 * Math.sin(UI.t * 5.3);
    if (L.glow) { ctx.globalAlpha = clamp01(pulse); ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(L.glow, lx - 30, ly - 30, L.w + 60, L.h + 60); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; }
    if (L.base) ctx.drawImage(L.base, lx, ly, L.w, L.h);
    // embers rising from the letters + ash falling
    updateParts('title', dt, (P) => {
      if (P.length < 70 && Math.random() < 0.7) {
        const fromLogo = Math.random() < 0.6;
        P.push(fromLogo
          ? { x: lx + Math.random() * L.w, y: ly + L.h * (0.55 + Math.random() * 0.4), vx: (Math.random() - 0.5) * 10, vy: -18 - Math.random() * 26, t: 0, life: 1.5 + Math.random() * 2.2, ch: ".'*+`"[Math.floor(Math.random() * 5)], c: Math.random() < 0.5 ? '#ff9a3c' : '#ff5a22', s: Math.random() }
          : { x: Math.random() * W, y: -10, vx: (Math.random() - 0.5) * 8, vy: 10 + Math.random() * 14, t: 0, life: 9 + Math.random() * 8, ch: ".,'"[Math.floor(Math.random() * 3)], c: '#8b8f96', s: Math.random(), a: 0.6 });
      }
    });
    drawParts();
    // subtitle
    const subY = ly + L.h + 22 * S;
    if (ctx.createLinearGradient) {
      const g2 = ctx.createLinearGradient(W / 2 - 360 * S, 0, W / 2 + 360 * S, 0);
      g2.addColorStop(0, 'rgba(0,0,0,0)'); g2.addColorStop(0.2, 'rgba(0,0,0,0.7)'); g2.addColorStop(0.8, 'rgba(0,0,0,0.7)'); g2.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g2; ctx.fillRect(W / 2 - 360 * S, subY - 12 * S, 720 * S, 40 * S);
    }
    spaced('THE LAND OF OOO IS DYING FROM THE EDGES IN', W / 2, subY, '#a59e94', fpx(11), 'center', 0.5);
    text('-------  *  -------', W / 2, subY + 18 * S, '#4d4a46', fpx(10), 'center');
    // menu
    const d = HM.Save && HM.Save.data;
    let items;
    if (!d) items = [{ id: 'newprofile', label: 'New Profile' }, { id: 'profiles', label: 'Profiles' }, { id: 'options', label: 'Options' }];
    else {
      items = TITLE_ITEMS.filter((it) => it.id !== 'continue' || d.run);
      // once the prologue has been played (or declined), it can be replayed from here
      if (d.meta && (d.meta.prologueDone || d.meta.prologueDeclined)) items.splice(items.findIndex((it) => it.id === 'profiles'), 0, { id: 'prologue', label: 'Replay Prologue' });
    }
    const iw = 250 * S, ih = 26 * S, gap = 6 * S;
    let y = Math.max(subY + 40 * S, H * 0.5);
    const totalH = items.length * (ih + gap) - gap;
    if (y + totalH > H - 84 * S) y = H - 84 * S - totalH;
    const mx0 = W / 2 - iw / 2 - 14 * S, my0 = y - 14 * S, mw = iw + 28 * S, mh = totalH + 28 * S;
    fill(mx0, my0, mw, mh, 'rgba(0,0,0,0.8)'); box(mx0, my0, mw, mh, '#8f8f8f');
    corners(mx0, my0, mw, mh, '#5a5550');
    let note = '';
    for (const it of items) {
      const id = 't:' + it.id, f = isFocus(id);
      const x = W / 2 - iw / 2;
      if (f) {
        fill(x, y, iw, ih, 'rgba(255,255,255,0.07)'); box(x, y, iw, ih, COL.hiBorder);
        text('>', x + 12 * S, y + ih / 2 + 1, COL.ember, fpx(12)); text('<', x + iw - 12 * S, y + ih / 2 + 1, COL.ember, fpx(12), 'right');
      }
      text(it.label, W / 2, y + ih / 2 + 1, f ? '#fff' : '#a9a9a9', fpx(13), 'center');
      const h = hit(id, x, y, iw, ih, { act: () => titleAction(it.id) });
      if (it.id === 'continue' || (it.id === 'new' && !d.run) || it.id === 'newprofile') h.def = true;
      if (f) {
        if (it.id === 'continue' && d.run) { const hi = heroInfo(d.run.heroId); note = hi.name + ' · floor ' + d.run.floorIndex + ' · act ' + roman(Math.ceil(d.run.floorIndex / 3)); }
        else if (it.id === 'new') note = d && d.run ? 'abandons the run in progress' : 'choose a hero and descend';
        else if (it.id === 'profiles') note = 'save slots · export · import';
        else if (it.id === 'options') note = 'sound · display · controls';
        else if (it.id === 'codex') note = Object.keys(d.meta.codex || {}).length + ' pages · ' + Object.keys(d.meta.achievements || {}).length + ' feats';
        else if (it.id === 'heirlooms') note = d.meta.ashes + ' ashes to spend';
        else if (it.id === 'newprofile') note = 'begin a new legend';
        else if (it.id === 'prologue') note = 'the Tree Fort clearing · every move, one at a time';
      }
      y += ih + gap;
    }
    if (note) text(note, W / 2, my0 + mh + 14 * S, COL.dim, fpx(11), 'center', { shadow: true });
    // footer
    const fy = H - 18 * S;
    if (d) {
      const m = d.meta;
      text('profile  ' + d.profileName + '  ·  slot ' + HM.Save.slot, 16 * S, fy, COL.dim, fpx(11), 'left', { shadow: true });
      text('ashes ' + m.ashes + '  ·  best floor ' + (m.bestFloor || 0) + '  ·  runs ' + (m.runs || 0) + '  ·  wins ' + (m.wins || 0), 16 * S, fy - 16 * S, COL.faint, fpx(10), 'left', { shadow: true });
    } else text(HM.Save && HM.Save.storageOk === false ? 'storage unavailable — progress will not persist' : 'no profile loaded', 16 * S, fy, HM.Save && HM.Save.storageOk === false ? COL.bad : COL.dim, fpx(11), 'left', { shadow: true });
    text('v' + (HM.cfg.VERSION || '1.0'), W - 16 * S, fy, COL.faint, fpx(10), 'right');
    text('arrows / wasd  ·  enter  ·  esc', W / 2, fy, COL.faint, fpx(10), 'center');
  }

  // ======================================================================= SLOTS
  function drawSlots() {
    backdropDim(0.6);
    header('PROFILES', 'three slots · saved in this browser · export to keep them safe');
    const list = slotList();
    const n = list.length, pw = Math.min(330 * S, (W - 80 * S) / n - 16 * S), ph = 330 * S, gap = 18 * S;
    const x0 = (W - (pw * n + gap * (n - 1))) / 2, y0 = Math.max(80 * S, (H - ph) / 2 - 10 * S);
    list.forEach((s, i) => {
      const x = x0 + i * (pw + gap), y = y0, active = HM.Save.slot === s.slot && !!HM.Save.data;
      const hasFocus = UI.focus && UI.focus.startsWith('s' + s.slot + ':');
      panel(x, y, pw, ph, { border: hasFocus || active ? COL.hiBorder : '#7a7a7a', bg: 'rgba(1,2,4,0.92)' });
      spaced('SLOT ' + s.slot, x + 12 * S, y + 14 * S, COL.dim, fpx(11));
      if (active) text('ACTIVE', x + pw - 12 * S, y + 14 * S, COL.witch, fpx(10), 'right');
      fill(x, y + 28 * S, pw, 1, COL.dimBorder);
      const bx = x + 12 * S, bw = (pw - 24 * S - 8 * S) / 2, bh = 24 * S;
      let cy = y + 52 * S;
      const row = (k, v, c) => { text(k, bx, cy, COL.faint, fpx(11)); text(v, x + pw - 12 * S, cy, c || COL.text, fpx(11), 'right'); cy += 18 * S; };
      if (!s.exists) {
        text('— empty —', x + pw / 2, y + 120 * S, COL.faint, fpx(13), 'center');
        text('a slot for a new legend', x + pw / 2, y + 142 * S, COL.ghost, fpx(10), 'center');
        const by = y + ph - 2 * (bh + 8 * S) - 4 * S;
        button('s' + s.slot + ':new', bx, by, pw - 24 * S, bh, 'new profile', () => newProfileFlow(s.slot, false));
        button('s' + s.slot + ':import', bx, by + bh + 8 * S, pw - 24 * S, bh, 'import save file', () => importFlow(s.slot));
        return;
      }
      if (s.corrupt) {
        text('CORRUPTED', x + pw / 2, y + 100 * S, COL.bad, fpx(13), 'center');
        wrap(s.error || 'unreadable', 32).forEach((l, k) => text(l, x + pw / 2, y + 124 * S + k * 16 * S, '#c98a80', fpx(10), 'center'));
        text('the data was left untouched', x + pw / 2, y + 180 * S, COL.faint, fpx(10), 'center');
        const by = y + ph - 2 * (bh + 8 * S) - 4 * S;
        button('s' + s.slot + ':import', bx, by, pw - 24 * S, bh, 'import over it', () => importFlow(s.slot));
        button('s' + s.slot + ':del', bx, by + bh + 8 * S, pw - 24 * S, bh, 'erase slot', () => deleteFlow(s), { hiBorder: '#ff8a7a' });
        return;
      }
      text(s.profileName || 'Wanderer', bx, y + 46 * S, '#fff', fpx(16), 'left', { bold: true });
      cy = y + 74 * S;
      row('last played', fmtDate(s.updatedAt)); row('play time', fmtPlay(s.playTime));
      row('runs · wins', (s.runs || 0) + ' · ' + (s.wins || 0)); row('best floor', String(s.bestFloor || 0));
      row('ashes', String(s.ashes || 0), COL.ember);
      cy += 4 * S;
      if (s.hasRun) { const hi = heroInfo(s.runHero); text('run in progress', bx, cy, COL.faint, fpx(10)); cy += 16 * S; text(hi.name + ' · floor ' + s.runFloor, bx, cy, COL.gold, fpx(11)); }
      else { text('no run in progress', bx, cy, COL.ghost, fpx(10)); }
      const by = y + ph - 2 * (bh + 8 * S) - 4 * S;
      button('s' + s.slot + ':load', bx, by, bw, bh, active ? 'play' : 'load', () => loadSlot(s.slot)).def = active;
      button('s' + s.slot + ':ren', bx + bw + 8 * S, by, bw, bh, 'rename', () => renameFlow(s));
      const b3 = (pw - 24 * S - 16 * S) / 3, by2 = by + bh + 8 * S;
      button('s' + s.slot + ':exp', bx, by2, b3, bh, 'export', () => exportSlot(s.slot), { px: fpx(11) });
      button('s' + s.slot + ':import', bx + b3 + 8 * S, by2, b3, bh, 'import', () => importFlow(s.slot), { px: fpx(11) });
      button('s' + s.slot + ':del', bx + 2 * (b3 + 8 * S), by2, b3, bh, 'delete', () => deleteFlow(s), { px: fpx(11), hiBorder: '#ff8a7a', color: '#d9a49c' });
    });
    button('s:back', W / 2 - 70 * S, y0 + ph + 26 * S, 140 * S, 26 * S, 'back', () => HM.Game.setState('title'));
    if (HM.Save.storageOk === false) text('Browser storage is unavailable — saves only last this session. Export to keep them.', W / 2, y0 + ph + 70 * S, COL.bad, fpx(11), 'center');
    footerHint('export downloads a .json save file  ·  import validates it before anything is overwritten');
  }
  function slotList() {
    if (!UI._slots || HM.Game.realT - UI._slotsT > 0.75 || UI._slotsSave !== HM.Save.data) { UI._slots = HM.Save.list(); UI._slotsT = HM.Game.realT; UI._slotsSave = HM.Save.data; }
    return UI._slots;
  }
  const dirtySlots = () => { UI._slots = null; };
  function loadSlot(slot) {
    const d = HM.Save.use(slot);
    if (!d) { UI.alert('CANNOT LOAD', HM.Save.lastError || 'Slot ' + slot + ' could not be read.'); return; }
    UI.toast('Profile loaded · ' + d.profileName, COL.text, 2);
    HM.Game.setState('title');
  }
  function renameFlow(s) {
    UI.inputPrompt('Rename slot ' + s.slot, s.profileName || '', (name) => {
      if (HM.Save.slot === s.slot && HM.Save.data) { HM.Save.data.profileName = name; HM.Save.write(); }
      else { const d = HM.Save.read(s.slot); if (d && !d.corrupt) { d.profileName = name; const r = HM.Save.commitImport(s.slot, d); if (!r.ok) UI.alert('RENAME FAILED', r.error); } }
      dirtySlots(); UI.toast('Renamed to ' + name, COL.text, 2);
    });
  }
  function deleteFlow(s) {
    UI.confirm('Erase slot ' + s.slot + (s.profileName ? ' (' + s.profileName + ')' : '') + '?\nAll runs, ashes, heirlooms and codex pages in it will be lost. This cannot be undone.', () => {
      HM.Save.erase(s.slot); dirtySlots(); UI.toast('Slot ' + s.slot + ' erased', COL.bad, 2.5); sfx('ui_back');
    }, null, { yes: 'erase', no: 'keep it', danger: true });
  }
  function exportSlot(slot) {
    const r = HM.Save.exportSlot(slot);
    if (r && r.ok) UI.toast('Exported\n' + r.name, COL.good, 3.5); else UI.alert('EXPORT FAILED', (r && r.error) || 'Unknown error.');
  }
  function importFlow(slot) {
    if (!HM.Save.pickImportFile) return;
    HM.Save.pickImportFile().then((res) => {
      if (!res || !res.ok) { UI.alert('IMPORT FAILED', (res && res.fileName ? res.fileName + '\n\n' : '') + ((res && res.error) || 'The file could not be read.')); sfx('ui_error'); return; }
      const d = res.data, m = d.meta || {};
      const cur = HM.Save.list().find((s) => s.slot === slot);
      const over = cur && cur.exists ? '\nThis will OVERWRITE slot ' + slot + (cur.profileName ? ' (' + cur.profileName + ')' : '') + '.' : '\nIt will be placed in empty slot ' + slot + '.';
      UI.confirm('Import "' + (d.profileName || 'Wanderer') + '" from ' + (res.fileName || 'file') + '?\n' +
        'runs ' + (m.runs || 0) + ' · wins ' + (m.wins || 0) + ' · best floor ' + (m.bestFloor || 0) + ' · ashes ' + (m.ashes || 0) + '\n' +
        'last saved ' + fmtDate(d.updatedAt) + (d.run ? ' · has a run in progress' : '') + over, () => {
        const r = HM.Save.commitImport(slot, d);
        dirtySlots();
        if (r && r.ok) { UI.toast('Imported into slot ' + slot, COL.good, 3); sfx('ui_select'); }
        else UI.alert('IMPORT FAILED', (r && r.error) || 'Could not write the save.');
      }, null, { yes: cur && cur.exists ? 'overwrite' : 'import', no: 'cancel', danger: !!(cur && cur.exists) });
    }).catch((e) => UI.alert('IMPORT FAILED', String(e && e.message || e)));
  }

  // ======================================================================= HERO SELECT
  function drawHeroSelect() {
    backdropDim(0.62);
    header(UI._forcePrologue ? 'THE PROLOGUE' : 'CHOOSE YOUR HERO', UI._forcePrologue ? 'who walks the Tree Fort clearing? · every move, one at a time' : 'one life · fifteen floors · the Lich waits at the bottom');
    const heroes = (HM.Heroes && HM.Heroes.list && HM.Heroes.list.length ? HM.Heroes.list : [{ id: 'finn' }, { id: 'marceline' }, { id: 'fp' }]).map((h) => heroInfo(h.id));
    const m = meta();
    const n = heroes.length, gap = 18 * S;
    const cwid = Math.min(330 * S, (W - 60 * S - gap * (n - 1)) / n), ch = Math.min(H - 190 * S, 540 * S);
    const x0 = (W - (cwid * n + gap * (n - 1))) / 2, y0 = 76 * S;
    heroes.forEach((h, i) => {
      const x = x0 + i * (cwid + gap), y = y0, id = 'h:' + h.id, f = isFocus(id);
      const unlocked = !m || !m.heroesUnlocked || m.heroesUnlocked.indexOf(h.id) >= 0;
      const hc = h.color ? css(h.color) : { finn: '#7fb8ff', marceline: '#d0485a', fp: '#ff8a3a' }[h.id] || '#ddd';
      panel(x, y, cwid, ch, { border: f ? COL.hiBorder : '#6a6a6a', bg: f ? 'rgba(8,8,10,0.94)' : 'rgba(1,2,4,0.9)' });
      if (f) corners(x, y, cwid, ch, hc);
      // portrait on a faint ground
      const py = y + 14 * S + 190 * S;
      if (ctx.createRadialGradient) {
        const g = ctx.createRadialGradient(x + cwid / 2, py - 70 * S, 4, x + cwid / 2, py - 70 * S, 120 * S);
        g.addColorStop(0, rgba(hc, f ? 0.22 : 0.1)); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fillRect(x + 1, y + 1, cwid - 2, 210 * S);
      }
      text('_.,-~"~-.,_', x + cwid / 2, py + 4 * S, '#2c2c2c', fpx(10), 'center');
      drawFigure(h.id, x + cwid / 2, py + Math.sin(UI.t * 2 + i) * 2 * S * (h.id === 'marceline' ? 1.5 : 0.4), 26, 7.4 * S, { alpha: unlocked ? 1 : 0.25 });
      let cy = py + 24 * S;
      text(h.name, x + cwid / 2, cy, f ? '#fff' : COL.text, fpx(16), 'center', { bold: true }); cy += 18 * S;
      text(h.title || '', x + cwid / 2, cy, hc, fpx(11), 'center'); cy += 18 * S;
      const diff = typeof h.difficulty === 'number' ? h.difficulty : { easy: 1, normal: 2, medium: 2, hard: 3 }[String(h.difficulty || '').toLowerCase()] || 2;
      text('difficulty ' + '■'.repeat(diff) + '□'.repeat(Math.max(0, 3 - diff)), x + cwid / 2, cy, COL.dim, fpx(10), 'center'); cy += 20 * S;
      const blurb = h.blurb || (HM.Lore && HM.Lore.heroBlurbs && HM.Lore.heroBlurbs[h.id]) || '';
      const maxC = Math.floor((cwid - 24 * S) / cw(fpx(11)));
      for (const l of wrap(blurb, maxC).slice(0, 4)) { text(l, x + 12 * S, cy, '#b9b9b9', fpx(11)); cy += 15 * S; }
      const kitRoom = (y + ch - 30 * S) - (cy + 18 * S);
      cy += 6 * S; fill(x + 12 * S, cy, cwid - 24 * S, 1, COL.dimBorder); cy += 12 * S;
      const kit = h.kit || [];
      const slotKey = { attack: 'attack', heavy: 'heavy', skill1: 'skill1', skill2: 'skill2', ult: 'ult', dodge: 'dodge', passive: null };
      const kitN = Math.min(6, kit.length), withDesc = f && kitRoom >= kitN * 31 * S;
      const dmaxC = Math.floor((cwid - 70 * S) / cw(fpx(10)));
      for (const k of kit.slice(0, 6)) {
        if (cy > y + ch - 34 * S) break;
        const act = slotKey[k.slot]; const kl = act ? HM.Input.actionLabel(act) : k.slot ? String(k.slot).toUpperCase().slice(0, 4) : '';
        text(kl, x + 12 * S, cy, f ? COL.dim : COL.faint, fpx(10)); text(k.name || '', x + 56 * S, cy, '#e0e0e0', fpx(11)); cy += 14 * S;
        if (withDesc && k.desc) { const l = wrap(k.desc, dmaxC); text(l[0] + (l.length > 1 ? '…' : ''), x + 56 * S, cy, COL.dim, fpx(10)); cy += 17 * S; }
      }
      const hs = m && m.heroStats && m.heroStats[h.id];
      text(hs ? 'runs ' + hs.runs + ' · wins ' + hs.wins + ' · best floor ' + hs.bestFloor : 'untested', x + cwid / 2, y + ch - 14 * S, COL.faint, fpx(10), 'center');
      const hh = hit(id, x, y, cwid, ch, { act: unlocked ? () => beginRun(h.id) : null, focusable: true });
      if (i === UI.heroIdx) hh.def = true;
      if (f) UI.heroIdx = i;
    });
    // ascension + buttons
    const by = y0 + ch + 18 * S;
    if (m && (m.maxAscension || 0) > 0) {
      const aw = 260 * S, ax = W / 2 - aw / 2;
      const set = (v) => { UI.ascension = M.clamp(v, 0, m.maxAscension); m.ascension = UI.ascension; };
      button('h:asc', ax, by, aw, 24 * S, '<  ASCENSION ' + UI.ascension + '  >', () => set(UI.ascension >= m.maxAscension ? 0 : UI.ascension + 1), { left: () => set(UI.ascension - 1), right: () => set(UI.ascension + 1), color: UI.ascension ? COL.ember : '#cdcdcd' });
      const note = HM.Lore && HM.Lore.ascensionNotes ? HM.Lore.ascensionNotes[Math.min(UI.ascension, HM.Lore.ascensionNotes.length - 1)] : '';
      text(note, W / 2, by + 38 * S, COL.dim, fpx(10), 'center');
      button('h:back', 20 * S, H - 40 * S, 110 * S, 24 * S, 'back', () => HM.Game.setState('title'));
    } else button('h:back', W / 2 - 55 * S, by, 110 * S, 24 * S, 'back', () => HM.Game.setState('title'));
    footerHint('←/→ choose  ·  enter descend  ·  esc back');
  }
  // New-run flow (DESIGN §9A): a profile that has not played the prologue is asked first (default: yes).
  function beginRun(heroId) {
    const d = HM.Save.data;
    const go = (prologue) => { UI._forcePrologue = false; if (d) { d.meta.ascension = UI.ascension; } HM.Game.newRun(heroId, { ascension: UI.ascension, prologue: !!prologue }); };
    const ask = () => {
      if (UI._forcePrologue) { go(true); return; }
      const m = d && d.meta;
      if (m && !m.prologueDone && !m.prologueDeclined) {
        UI.confirm('Play the prologue? (recommended)\nA short walk through the old Tree Fort clearing that teaches every move.\nYou can replay it any time from the title screen.',
          () => go(true), () => { m.prologueDeclined = true; go(false); }, { yes: 'play the prologue', no: 'skip to floor 1', onCancel: () => {} });
      } else go(false);
    };
    if (d && d.run) {
      const hi = heroInfo(d.run.heroId);
      UI.confirm('Abandon the run in progress?\n' + hi.name + ' on floor ' + d.run.floorIndex + ' will be recorded as fallen.', () => {
        const r = d.run;
        HM.Save.recordRunEnd({ heroId: r.heroId, floorIndex: r.floorIndex, act: Math.ceil(r.floorIndex / 3), killedBy: 'abandoned', kills: r.kills, time: r.time, gold: r.gold, level: r.level, victory: false, ascension: r.ascension || 0 });
        ask();
      }, null, { yes: 'abandon it', no: 'cancel', danger: true });
    } else ask();
  }

  // ======================================================================= OPTIONS
  const BIND_ACTIONS = [
    ['up', 'Move up'], ['down', 'Move down'], ['left', 'Move left'], ['right', 'Move right'],
    ['attack', 'Attack'], ['heavy', 'Heavy attack'], ['dodge', 'Dodge roll'], ['skill1', 'Skill 1'], ['skill2', 'Skill 2'],
    ['ult', 'Ultimate'], ['interact', 'Interact'], ['potion1', 'Bacon Pancake'], ['potion2', 'Tonic'], ['inventory', 'Inventory'], ['map', 'Map'],
  ];
  const localSettings = { master: 0.8, sfx: 0.9, music: 0.55, shake: 1, glyphSize: 'medium', damageNumbers: true, aimAssist: true, showFps: false, minimap: true, hints: true };
  function getS(k) { return HM.Save && HM.Save.data ? HM.Save.setting(k, localSettings[k]) : localSettings[k]; }
  function setS(k, v) {
    if (HM.Save && HM.Save.data) HM.Save.setSetting(k, v);
    else {
      localSettings[k] = v;
      if (k === 'glyphSize' && HM.R && HM.R.setGlyphSize) HM.R.setGlyphSize(v);
      if (/master|sfx|music/.test(k) && HM.Audio && HM.Audio.setVolumes) HM.Audio.setVolumes({ master: localSettings.master, sfx: localSettings.sfx, music: localSettings.music });
      if (k === 'binds') HM.Input.setBinds(v);
    }
  }
  function startCapture(action) {
    UI.capture = { action, t: 0 };
    HM.Input.capturing = (code) => {
      UI.capture = null; swallowMouse();
      if (!code || code === 'Escape') { sfx('ui_back'); return; }
      const binds = JSON.parse(JSON.stringify(HM.Input.binds));
      const old = (binds[action] || [])[0];
      let swapped = null;
      for (const other in binds) {
        if (other === action) continue;
        const i = binds[other].indexOf(code);
        if (i >= 0) { if (old && binds[other].indexOf(old) < 0) binds[other][i] = old; else binds[other].splice(i, 1); swapped = other; }
      }
      binds[action] = [code].concat((binds[action] || []).slice(1).filter((c) => c !== code));
      setS('binds', binds);
      const nm = (a) => (BIND_ACTIONS.find((b) => b[0] === a) || [a, a])[1];
      UI.toast(nm(action) + ' → ' + HM.Input.codeLabel(code) + (swapped ? '\nswapped with ' + nm(swapped) : ''), swapped ? COL.gold : COL.text, 2.6);
      sfx('ui_select');
    };
  }
  function drawCapture() {
    fill(0, 0, W, H, 'rgba(0,0,0,0.6)');
    const w = 380 * S, h = 96 * S, x = (W - w) / 2, y = (H - h) / 2;
    panel(x, y, w, h, { border: COL.hiBorder, bg: '#020203' });
    const nm = (BIND_ACTIONS.find((b) => b[0] === UI.capture.action) || ['', UI.capture.action])[1];
    spaced('REBIND · ' + nm.toUpperCase(), x + w / 2, y + 26 * S, COL.text, fpx(12), 'center');
    text('press a key or mouse button' + (Math.floor(UI.t * 2) % 2 ? ' _' : '  '), x + w / 2, y + 52 * S, COL.gold, fpx(12), 'center');
    text('esc cancels · conflicts are swapped', x + w / 2, y + 74 * S, COL.faint, fpx(10), 'center');
  }
  function drawOptions() {
    header('OPTIONS', HM.Save && HM.Save.data ? 'saved to ' + HM.Save.data.profileName + ' · slot ' + HM.Save.slot : 'no profile loaded — changes last this session only');
    const pw = Math.min(W - 40 * S, 900 * S), ph = Math.min(H - 130 * S, 560 * S);
    const px = (W - pw) / 2, py = 74 * S;
    panel(px, py, pw, ph, { bg: 'rgba(1,2,4,0.93)' });
    const colW = (pw - 48 * S) / 2, lx = px + 16 * S, rx = px + 32 * S + colW;
    const rh = 26 * S;
    let y = py + 18 * S;
    const section = (t, x, yy) => { spaced(t, x, yy, COL.dim, fpx(10)); fill(x, yy + 10 * S, colW, 1, COL.ghost); };
    const slider = (id, label, k, step) => {
      const v = Number(getS(k)); const f = isFocus(id);
      const bx = lx + colW * 0.42, bw = colW * 0.42, bh = 12 * S;
      text(label, lx + 8 * S, y + rh / 2, f ? '#fff' : COL.text, fpx(12));
      if (f) text('>', lx - 2 * S, y + rh / 2, COL.ember, fpx(12));
      tickBar(bx, y + (rh - bh) / 2, bw, bh, v, f ? '#ffffff' : '#bdbdbd', { border: f ? COL.hiBorder : '#8a8a8a' });
      text(Math.round(v * 100) + '%', lx + colW - 4 * S, y + rh / 2, COL.dim, fpx(11), 'right');
      const set = (nv) => { nv = Math.round(M.clamp(nv, 0, 1) / step) * step; if (Math.abs(nv - getS(k)) > 1e-6) { setS(k, +nv.toFixed(3)); sfx('ui_move'); } };
      hit(id, lx, y, colW, rh, { left: () => set(v - step), right: () => set(v + step), act: () => set(v + step > 1.0001 ? 0 : v + step), drag: (mx) => set((mx - bx) / bw), focusable: true });
      y += rh;
    };
    const choice = (id, label, k, opts) => {
      const v = getS(k); const f = isFocus(id); const i = Math.max(0, opts.indexOf(v));
      text(label, lx + 8 * S, y + rh / 2, f ? '#fff' : COL.text, fpx(12));
      if (f) text('>', lx - 2 * S, y + rh / 2, COL.ember, fpx(12));
      const vx = lx + colW * 0.42;
      let xx = vx;
      opts.forEach((o, j) => { const lab = typeof o === 'boolean' ? (o ? 'on' : 'off') : String(o); const c = j === i ? (f ? '#fff' : COL.text) : COL.faint; const w2 = tw(lab, fpx(11)); if (j === i) box(xx - 5 * S, y + 5 * S, w2 + 10 * S, rh - 10 * S, f ? COL.hiBorder : '#777'); text(lab, xx, y + rh / 2, c, fpx(11)); xx += w2 + 18 * S; });
      const set = (j) => { const nv = opts[(j + opts.length) % opts.length]; setS(k, nv); sfx('ui_move'); };
      hit(id, lx, y, colW, rh, { left: () => set(i - 1), right: () => set(i + 1), act: () => set(i + 1), focusable: true });
      y += rh;
    };
    section('AUDIO', lx, y); y += 20 * S;
    slider('o:master', 'Master volume', 'master', 0.05);
    slider('o:sfx', 'Effects', 'sfx', 0.05);
    slider('o:music', 'Music & ambience', 'music', 0.05);
    y += 10 * S; section('DISPLAY', lx, y); y += 20 * S;
    choice('o:glyph', 'Glyph size', 'glyphSize', ['small', 'medium', 'large']);
    slider('o:shake', 'Screen shake', 'shake', 0.25);
    choice('o:dmg', 'Damage numbers', 'damageNumbers', [true, false]);
    choice('o:fps', 'Show FPS', 'showFps', [false, true]);
    choice('o:map', 'Minimap', 'minimap', [true, false]);
    choice('o:hints', 'Hints', 'hints', [true, false]);
    y += 10 * S; section('GAMEPLAY', lx, y); y += 20 * S;
    choice('o:aim', 'Melee aim assist', 'aimAssist', [true, false]);
    y += 6 * S;
    text('aim assist bends melee swings up to 15° toward', lx + 8 * S, y + 6 * S, COL.faint, fpx(10)); y += 14 * S;
    text('the nearest foe. Projectiles are never assisted.', lx + 8 * S, y + 6 * S, COL.faint, fpx(10));
    // controls column (scrollable)
    let ry = py + 18 * S;
    section('CONTROLS', rx, ry); ry += 20 * S;
    const listTop = ry, listH = ph - (ry - py) - 56 * S, rowH = 22 * S;
    const visible = Math.max(3, Math.floor(listH / rowH));
    const fi = BIND_ACTIONS.findIndex((b) => UI.focus === 'o:bind:' + b[0]);
    const first = listScroll('opt', BIND_ACTIONS.length, visible, fi);
    BIND_ACTIONS.forEach((b, i) => {
      const id = 'o:bind:' + b[0], f = isFocus(id);
      const vis = i >= first && i < first + visible, yy = listTop + (i - first) * rowH;
      hit(id, rx, vis ? yy : listTop + (i < first ? -1 : visible) * rowH, colW, rowH, { act: () => startCapture(b[0]), hidden: !vis, focusable: true, alt: () => { const bb = JSON.parse(JSON.stringify(HM.Input.binds)); bb[b[0]] = (HM.Input.DEFAULT_BINDS[b[0]] || []).slice(); setS('binds', bb); } });
      if (!vis) return;
      if (f) fill(rx, yy, colW, rowH, 'rgba(255,255,255,0.06)');
      text(b[1], rx + 8 * S, yy + rowH / 2, f ? '#fff' : COL.text, fpx(11));
      const codes = HM.Input.binds[b[0]] || [];
      const k1 = HM.Input.codeLabel(codes[0]), kx = rx + colW * 0.56, kw = Math.max(46 * S, tw(k1, fpx(11)) + 14 * S);
      fill(kx, yy + 3 * S, kw, rowH - 6 * S, '#000'); box(kx, yy + 3 * S, kw, rowH - 6 * S, f ? COL.hiBorder : '#8a8a8a');
      text(k1, kx + kw / 2, yy + rowH / 2, f ? '#fff' : '#d8d8d8', fpx(11), 'center');
      if (codes[1]) text(HM.Input.codeLabel(codes[1]), kx + kw + 10 * S, yy + rowH / 2, COL.faint, fpx(10));
    });
    scrollbar(rx + colW + 6 * S, listTop, visible * rowH, first, visible, BIND_ACTIONS.length);
    const fixedY = listTop + visible * rowH + 6 * S;
    text('Pause / back', rx + 8 * S, fixedY + 8 * S, COL.faint, fpx(11)); text('ESC (fixed)', rx + colW * 0.56, fixedY + 8 * S, COL.faint, fpx(11));
    button('o:reset', rx, py + ph - 38 * S, colW / 2 - 6 * S, 24 * S, 'reset controls', () => UI.confirm('Restore the default key bindings?', () => { setS('binds', {}); UI.toast('Controls reset', COL.text, 2); }), { px: fpx(11) });
    const backFn = HM.Game.state === 'pause' ? () => { UI.pauseSub = null; UI.focus = 'p:options'; } : () => HM.Game.setState('title');
    button('o:back', px + pw / 2 - 60 * S, py + ph + 14 * S, 120 * S, 24 * S, 'back', backFn);
    footerHint('←/→ adjust  ·  enter rebind  ·  right-click a binding to restore its default');
  }

  // ======================================================================= CODEX
  const CODEX_TABS = [['pages', 'PAGES'], ['bestiary', 'BESTIARY'], ['feats', 'FEATS'], ['chronicle', 'CHRONICLE']];
  function codexTabStep(d) { const i = CODEX_TABS.findIndex((t) => t[0] === UI.codexTab); UI.codexTab = CODEX_TABS[(i + d + CODEX_TABS.length) % CODEX_TABS.length][0]; UI.focus = null; UI.scroll.codex = 0; sfx('ui_move'); }
  function bestiaryIds() {
    const ids = [];
    const add = (id) => { if (id && ids.indexOf(id) < 0 && id !== 'boss') ids.push(id); };
    if (HM.Lore && HM.Lore.bestiary) for (const k in HM.Lore.bestiary) add(k);
    if (HM.Enemies && HM.Enemies.defs) for (const k in HM.Enemies.defs) add(k);
    if (HM.Bosses && HM.Bosses.defs) for (const k in HM.Bosses.defs) add(k);
    return ids;
  }
  function enemyName(id) {
    const d = (HM.Enemies && HM.Enemies.defs && HM.Enemies.defs[id]) || (HM.Bosses && HM.Bosses.defs && HM.Bosses.defs[id]);
    return (d && (d.displayName || d.name)) || (HM.Lore && HM.Lore.bestiary && HM.Lore.bestiary[id] && HM.Lore.bestiary[id].name) || id;
  }
  function drawCodex() {
    backdropDim(0.62);
    const m = meta() || { codex: {}, bestiary: {}, achievements: {} };
    header('CODEX', HM.Save && HM.Save.data ? HM.Save.data.profileName + "'s record of a dying world" : 'no profile loaded');
    const pw = Math.min(W - 40 * S, 980 * S), ph = Math.min(H - 120 * S, 580 * S), px = (W - pw) / 2, py = 70 * S;
    // tabs
    let tx = px;
    for (const [id, lab] of CODEX_TABS) {
      const w = tw(lab, fpx(11)) * 1.55 + 26 * S, on = UI.codexTab === id;
      fill(tx, py, w, 24 * S, on ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.85)'); box(tx, py, w, 24 * S, on ? COL.hiBorder : '#5a5a5a');
      spaced(lab, tx + w / 2, py + 12 * S + 1, on ? '#fff' : COL.dim, fpx(11), 'center');
      hit('c:tab:' + id, tx, py, w, 24 * S, { act: () => { UI.codexTab = id; UI.focus = null; UI.scroll.codex = 0; }, focusable: false });
      tx += w + 6 * S;
    }
    text('Q / E switch tabs', px + pw, py + 12 * S, COL.faint, fpx(10), 'right');
    const by = py + 32 * S, bh = ph - 32 * S;
    panel(px, by, pw, bh, { bg: 'rgba(1,2,4,0.93)' });
    const lw = Math.round(pw * 0.42), lx = px + 12 * S, ly = by + 14 * S, rowH = 22 * S;
    const visible = Math.floor((bh - 28 * S) / rowH);
    fill(px + lw, by + 10 * S, 1, bh - 20 * S, COL.ghost);
    const dx = px + lw + 18 * S, dw = pw - lw - 36 * S, dmax = Math.floor(dw / cw(fpx(11)));
    let rows = [];
    UI._codexCount = '';
    if (UI.codexTab === 'pages') {
      const notes = (HM.Lore && HM.Lore.notes) || [];
      let act = 0;
      for (const n of notes) {
        if (n.act !== act) { act = n.act; rows.push({ kind: 'head', label: 'ACT ' + roman(act) + ' · ' + ((HM.Lore.acts[act] && HM.Lore.acts[act].name) || '').toUpperCase() }); }
        const found = !!(m.codex && m.codex[n.id]);
        rows.push({ id: 'c:n:' + n.id, label: found ? (n.remnant ? '\u201c ' : '') + n.title : n.remnant ? '· · ·  a voice not yet heard' : '· · ·  undiscovered page', color: found ? (n.remnant ? '#cdbcf0' : COL.text) : COL.faint, found, n, act: found ? () => openModal({ kind: 'note', entry: n, t: 99 }) : null });
      }
      UI._codexCount = Object.keys(m.codex || {}).length + ' / ' + notes.length + ' pages found';
    } else if (UI.codexTab === 'bestiary') {
      const ids = bestiaryIds();
      for (const id of ids) {
        const n = (m.bestiary && m.bestiary[id]) || 0, info = HM.Lore && HM.Lore.bestiary && HM.Lore.bestiary[id];
        rows.push({ id: 'c:b:' + id, label: n ? enemyName(id) : '???', right: n ? '×' + n : '', color: n ? (info && info.boss ? COL.ember : COL.text) : COL.faint, eid: id, kills: n, info });
      }
      UI._codexCount = ids.filter((id) => m.bestiary && m.bestiary[id]).length + ' / ' + ids.length + ' creatures known';
    } else if (UI.codexTab === 'feats') {
      const list = (HM.Lore && HM.Lore.achievements) || [];
      for (const a of list) {
        const got = m.achievements && m.achievements[a.id];
        rows.push({ id: 'c:a:' + a.id, label: got || !a.hidden ? a.name : '???', right: got ? '✓' : '', color: got ? COL.gold : COL.faint, a, got });
      }
      UI._codexCount = Object.keys(m.achievements || {}).length + ' / ' + list.length + ' feats earned';
    } else {
      const hist = (HM.Save && HM.Save.data && HM.Save.data.history) || [];
      if (!hist.length) rows.push({ kind: 'head', label: 'NO RUNS RECORDED YET' });
      hist.forEach((r, i) => {
        const hi = heroInfo(r.heroId);
        rows.push({ id: 'c:h:' + i, label: (r.victory ? '* ' : '  ') + hi.name + ' · floor ' + (r.floorIndex || 0), right: fmtDate(r.date), color: r.victory ? COL.gold : COL.text, r });
      });
    }
    const focusRows = rows.filter((r) => r.id);
    const fi = rows.findIndex((r) => r.id && r.id === UI.focus);
    const first = listScroll('codex', rows.length, visible, fi);
    let detail = null;
    rows.forEach((r, i) => {
      const vis = i >= first && i < first + visible, yy = ly + (i - first) * rowH;
      if (r.id) hit(r.id, lx - 4 * S, vis ? yy : ly + (i < first ? -1 : visible) * rowH, lw - 18 * S, rowH, { act: r.act || (() => {}), hidden: !vis, focusable: true });
      if (r.id === UI.focus) detail = r;
      if (!vis) return;
      if (r.kind === 'head') { spaced(r.label, lx, yy + rowH / 2 + 2 * S, COL.faint, fpx(10)); return; }
      const f = r.id === UI.focus;
      if (f) { fill(lx - 4 * S, yy, lw - 18 * S, rowH, 'rgba(255,255,255,0.07)'); text('>', lx - 2 * S, yy + rowH / 2, COL.ember, fpx(11)); }
      text(r.label, lx + 10 * S, yy + rowH / 2, f && r.color !== COL.faint ? '#fff' : r.color, fpx(11));
      if (r.right) text(r.right, lx + lw - 30 * S, yy + rowH / 2, COL.dim, fpx(10), 'right');
    });
    scrollbar(px + lw - 8 * S, ly, visible * rowH, first, visible, rows.length);
    if (UI._codexCount) text(UI._codexCount, px + lw + 18 * S, by + bh - 14 * S, COL.faint, fpx(10));
    if (!detail && focusRows.length) detail = focusRows[0];
    // detail pane
    let y = by + 26 * S;
    const para = (str, col, px2) => { for (const l of wrap(str, dmax)) { if (y > by + bh - 20 * S) return; text(l, dx, y, col || '#c8c8c8', px2 || fpx(11)); y += 16 * S; } };
    if (UI.codexTab === 'pages') {
      if (detail && detail.found) {
        spaced(String(detail.n.source || 'Enchiridion').toUpperCase(), dx, y, COL.faint, fpx(9), 'left', 0.35); y += 22 * S;
        text(detail.n.title, dx, y, '#fff', fpx(15), 'left', { bold: true }); y += 24 * S;
        para(detail.n.text, '#c8c3b8'); y += 8 * S;
        text('enter to read', dx, y, COL.faint, fpx(10));
      } else if (detail && detail.n && detail.n.remnant) { para('Someone lingers on the first floor of this act, remembering what happened. Find them, and listen.', COL.dim); }
      else { para('This page has not been found. Pages lie glowing on the ground of every floor that is not a lair.', COL.dim); }
    } else if (UI.codexTab === 'bestiary') {
      if (detail) {
        text(detail.kills ? enemyName(detail.eid) : '???', dx, y, '#fff', fpx(15), 'left', { bold: true }); y += 22 * S;
        if (detail.info && detail.kills) { text('ACT ' + roman(detail.info.act || 1) + (detail.info.boss ? ' · LAIR GUARDIAN' : ''), dx, y, COL.faint, fpx(10)); y += 22 * S; }
        para(detail.kills ? (detail.info && detail.info.desc) || 'A creature of the dying world.' : 'Slay one to learn what it is.', '#c8c3b8');
        y += 10 * S; if (detail.kills) text('defeated ' + detail.kills + ' time' + (detail.kills === 1 ? '' : 's'), dx, y, COL.dim, fpx(11));
      }
    } else if (UI.codexTab === 'feats') {
      if (detail) {
        text(detail.got || !detail.a.hidden ? detail.a.name : '???', dx, y, detail.got ? COL.gold : '#fff', fpx(15), 'left', { bold: true }); y += 24 * S;
        para(detail.got || !detail.a.hidden ? detail.a.desc : 'A hidden feat. Some things in Ooo are better discovered.', '#c8c3b8');
        y += 10 * S; text(detail.got ? 'earned ' + fmtDate(detail.got) : 'not yet earned', dx, y, detail.got ? COL.dim : COL.faint, fpx(11));
      }
    } else {
      // profile summary + selected run
      const mm = m;
      text('PROFILE', dx, y, COL.faint, fpx(10)); y += 20 * S;
      const kv = (k, v) => { text(k, dx, y, COL.dim, fpx(11)); text(String(v), dx + dw, y, COL.text, fpx(11), 'right'); y += 17 * S; };
      kv('runs · wins · deaths', (mm.runs || 0) + ' · ' + (mm.wins || 0) + ' · ' + (mm.deaths || 0));
      kv('foes defeated', mm.kills || 0); kv('best floor', mm.bestFloor || 0); kv('fastest victory', mm.bestTime ? fmtTime(mm.bestTime) : '—');
      kv('ashes earned (total)', mm.ashesTotal || 0); kv('highest ascension', mm.maxAscension || 0);
      kv('time in Ooo', fmtPlay(HM.Save && HM.Save.data ? HM.Save.data.playTime : 0));
      if (detail && detail.r) {
        const r = detail.r; y += 12 * S; fill(dx, y - 6 * S, dw, 1, COL.ghost); y += 8 * S;
        text(r.victory ? 'VICTORY' : 'FALLEN', dx, y, r.victory ? COL.gold : COL.bad, fpx(12)); text(fmtDate(r.date), dx + dw, y, COL.faint, fpx(10), 'right'); y += 20 * S;
        kv('hero', heroInfo(r.heroId).name); kv('floor reached', (r.floorIndex || 0) + ' (act ' + roman(r.act || Math.ceil((r.floorIndex || 1) / 3)) + ')');
        if (!r.victory) kv('undone by', r.killedBy || 'the dark');
        kv('level · kills', (r.level || 1) + ' · ' + (r.kills || 0)); kv('time', fmtTime(r.time || 0)); kv('ashes', r.ashes || 0);
        if (r.ascension) kv('ascension', r.ascension);
      }
    }
    button('c:back', px + pw / 2 - 60 * S, py + ph + 14 * S, 120 * S, 24 * S, 'back', () => HM.Game.setState('title'));
  }

  // ======================================================================= HEIRLOOMS
  function drawHeirlooms() {
    backdropDim(0.62);
    const m = meta();
    header('HEIRLOOMS', 'what the dead leave behind for the next one');
    const pw = Math.min(W - 40 * S, 760 * S), px = (W - pw) / 2, py = 74 * S;
    const list = (HM.Meta && HM.Meta.list) || [];
    const rowH = 46 * S, visible = Math.max(3, Math.floor((H - py - 120 * S) / rowH));
    const ph = Math.min(list.length || 1, visible) * rowH + 56 * S;
    panel(px, py, pw, ph, { bg: 'rgba(1,2,4,0.93)' });
    text('ASHES', px + 16 * S, py + 18 * S, COL.dim, fpx(11)); text(String(m ? m.ashes : 0), px + 70 * S, py + 18 * S, COL.ember, fpx(14), 'left', { bold: true });
    text('earned when a run ends · deeper and bloodier runs earn more', px + pw - 16 * S, py + 18 * S, COL.faint, fpx(10), 'right');
    fill(px, py + 36 * S, pw, 1, COL.dimBorder);
    if (!list.length) { text('No heirlooms exist yet.', px + pw / 2, py + 64 * S, COL.faint, fpx(12), 'center'); }
    const fi = list.findIndex((h) => UI.focus === 'hl:' + h.id);
    const first = listScroll('heir', list.length, visible, fi);
    list.forEach((h, i) => {
      const vis = i >= first && i < first + visible, y = py + 44 * S + (i - first) * rowH, id = 'hl:' + h.id;
      const lv = HM.Meta.level ? HM.Meta.level(h.id) : 0, max = h.maxLevel || 1, maxed = lv >= max;
      let cost = 0; try { cost = maxed ? 0 : (typeof h.cost === 'function' ? h.cost(lv) : h.cost || 0); } catch (e) { cost = 0; }
      const afford = m && m.ashes >= cost && !maxed;
      hit(id, px + 8 * S, vis ? y : py + (i < first ? -rowH : ph), pw - 16 * S, rowH - 4 * S, { act: () => buyHeirloom(h, cost, maxed), hidden: !vis, focusable: true });
      if (!vis) return;
      const f = isFocus(id);
      if (f) { fill(px + 8 * S, y, pw - 16 * S, rowH - 4 * S, 'rgba(255,255,255,0.06)'); box(px + 8 * S, y, pw - 16 * S, rowH - 4 * S, '#8a8a8a'); }
      fill(px + 16 * S, y + 5 * S, 26 * S, rowH - 14 * S, '#000'); box(px + 16 * S, y + 5 * S, 26 * S, rowH - 14 * S, lv ? COL.ember : '#555');
      text(h.glyph || '*', px + 29 * S, y + (rowH - 4 * S) / 2, lv ? COL.ember : COL.dim, fpx(14), 'center');
      text(h.name, px + 52 * S, y + 13 * S, f ? '#fff' : COL.text, fpx(12), 'left', { bold: true });
      let pips = ''; for (let k = 0; k < max; k++) pips += k < lv ? '■' : '□';
      text(pips, px + 52 * S + tw(h.name, fpx(12)) + 12 * S, y + 13 * S, maxed ? COL.gold : COL.dim, fpx(10));
      text(h.desc || '', px + 52 * S, y + 30 * S, COL.dim, fpx(10));
      const label = maxed ? 'MAXED' : cost + ' ashes';
      text(label, px + pw - 22 * S, y + 20 * S, maxed ? COL.gold : afford ? COL.ember : COL.faint, fpx(12), 'right');
    });
    scrollbar(px + pw - 5 * S, py + 44 * S, visible * rowH, first, visible, list.length);
    button('hl:back', W / 2 - 60 * S, py + ph + 16 * S, 120 * S, 24 * S, 'back', () => HM.Game.setState('title'));
    footerHint('enter to buy · heirlooms apply at the start of every run');
  }
  function buyHeirloom(h, cost, maxed) {
    if (maxed) { sfx('ui_error'); return; }
    const m = meta(); if (!m) { UI.alert('NO PROFILE', 'Load a profile to spend ashes.'); return; }
    if (m.ashes < cost) { sfx('ui_error'); UI.toast('Not enough ashes (' + cost + ' needed)', COL.bad, 2); return; }
    const r = HM.Meta.buy(h.id);
    const ok = r === true || (r && r.ok !== false && r !== false);
    if (ok) { UI.toast(h.name + ' · level ' + HM.Meta.level(h.id), COL.ember, 2.4); sfx('boon'); HM.Save.write(); }
    else { UI.toast((r && r.error) || 'Could not buy that.', COL.bad, 2); sfx('ui_error'); }
  }

  // ======================================================================= PAUSE
  function drawPause() {
    backdropDim(0.55);
    if (UI.pauseSub === 'options') { drawOptions(); return; }
    if (UI.pauseSub === 'moves') { drawMoves(); return; }
    const Gm = HM.Game, run = Gm.run || {}, p = Gm.player;
    const nb = (run.boons || []).length;
    const prologue = inPrologue();
    const pw = Math.min(W - 40 * S, 640 * S), ph = ((nb > 6 ? 300 : 270) + 38 + (prologue ? 38 : 0)) * S, px = (W - pw) / 2, py = (H - ph) / 2 - 30 * S;
    panel(px, py, pw, ph, { title: 'PAUSED', bg: '#020203' });
    corners(px, py, pw, ph, '#8a8a8a');
    const bx = px + 18 * S, bw = 200 * S, bh = 28 * S;
    let y = py + 46 * S;
    const items = [
      ['p:resume', 'Resume', () => Gm.setState('play')],
      ['p:moves', 'Moves', () => { UI.pauseSub = 'moves'; UI.focus = null; }],
      ['p:options', 'Options', () => { UI.pauseSub = 'options'; UI.focus = null; }],
    ];
    if (prologue) items.push(['p:skipPro', 'Skip Prologue', () => UI.confirm('Skip the rest of the prologue?\nYou go straight to floor 1. Pause \u2192 Moves still lists every verb.', () => skipPrologue(), null, { yes: 'skip it', no: 'keep learning' })]);
    items.push(
      ['p:abandon', 'Abandon Run', () => UI.confirm('Abandon this run?\nIt ends here and counts as a death. Ashes are still earned.', () => Gm.abandonRun(), null, { yes: 'abandon', no: 'keep going', danger: true })],
      ['p:quit', 'Save & Quit to Title', () => Gm.quitToTitle()]);
    for (const [id, lab, fn] of items) { const h = button(id, bx, y, bw, bh, lab, fn); if (id === 'p:resume') h.def = true; y += bh + 10 * S; }
    text('quitting keeps your run;', bx, y + 6 * S, COL.faint, fpx(10)); text('you resume at the start of this floor.', bx, y + 20 * S, COL.faint, fpx(10));
    // run summary
    const sx = px + 250 * S, sw = pw - 268 * S;
    let sy = py + 50 * S;
    const hi = heroInfo(run.heroId);
    text(hi.name, sx, sy, '#fff', fpx(14), 'left', { bold: true }); text(hi.title || '', sx + tw(hi.name, fpx(14)) + 10 * S, sy, COL.dim, fpx(11)); sy += 24 * S;
    const fl = Gm.floor || {};
    const kv = (k, v, c) => { text(k, sx, sy, COL.dim, fpx(11)); text(String(v), sx + sw, sy, c || COL.text, fpx(11), 'right'); sy += 17 * S; };
    if (prologue) kv('floor', 'prologue · the Tree Fort clearing'); else kv('floor', (run.floorIndex || 1) + ' · act ' + roman(fl.act || 1) + ' · ' + (fl.actName || ''));
    kv('level', run.level || 1); kv('time', fmtTime(run.time || 0)); kv('foes defeated', run.kills || 0); kv('gold', (run.gold || 0) + 'g', COL.gold);
    if (run.ascension) kv('ascension', run.ascension, COL.ember);
    if (p) kv('health', Math.ceil(p.hp) + ' / ' + Math.ceil(p.maxHp));
    sy += 8 * S; text('BOONS', sx, sy, COL.faint, fpx(10)); sy += 16 * S;
    const boons = (run.boons || []).map(boonInfo);
    if (!boons.length) text('none yet', sx, sy, COL.ghost, fpx(10));
    let bxx = sx;
    for (const b of boons) {
      const w2 = tw(b.name, fpx(10)) + 14 * S;
      if (bxx + w2 > sx + sw) { bxx = sx; sy += 18 * S; if (sy > py + ph - 14 * S) break; }
      box(bxx, sy - 8 * S, w2 - 4 * S, 16 * S, rgba(rarityColor(b.rarity), 0.6)); text(b.name, bxx + 5 * S, sy, rarityColor(b.rarity), fpx(10));
      bxx += w2;
    }
    drawDescentTrack(W / 2, py + ph + 26 * S, run.floorIndex || 0);
    footerHint('esc resume  ·  Moves lists every verb, its cost and its combos');
  }
  // Descent track (DESIGN §9D): 5 acts × 3 floors, boss floors marked, your floor lit.
  function drawDescentTrack(cx, y, cur) {
    const acts = (HM.Game.ACTS || []), cwp = 13 * S, gap = 26 * S, total = 15 * cwp + 4 * gap;
    let x = cx - total / 2;
    fill(x - 16 * S, y - 26 * S, total + 32 * S, 50 * S, 'rgba(0,0,0,0.88)'); box(x - 16 * S, y - 26 * S, total + 32 * S, 50 * S, '#4a4a4a');
    if (cur <= 0) { text('@', x - 8 * S, y, COL.gold, fpx(13), 'center', { bold: true }); text('prologue', x - 8 * S, y + 14 * S, COL.dim, fpx(9), 'center'); }
    for (let a = 0; a < 5; a++) {
      const nm = (acts[a] && acts[a].name) || ('Act ' + (a + 1));
      text(roman(a + 1), x + 1.5 * cwp, y - 14 * S, a + 1 === Math.ceil(cur / 3) ? '#e8e0d0' : COL.faint, fpx(9), 'center');
      for (let k = 0; k < 3; k++) {
        const f = a * 3 + k + 1, boss = k === 2;
        const g = f < cur ? (boss ? '#' : '+') : f === cur ? '@' : boss ? 'B' : '.';
        const col = f === cur ? COL.gold : f < cur ? '#8a8a8a' : boss ? '#9a4a3a' : '#5a5a5a';
        text(g, x + k * cwp + cwp / 2, y, col, fpx(f === cur ? 13 : 11), 'center', { bold: f === cur });
      }
      if (a === Math.ceil(cur / 3) - 1) text(nm, x + 1.5 * cwp, y + 14 * S, COL.dim, fpx(9), 'center');
      x += 3 * cwp + gap;
    }
  }

  // ======================================================================= BOONS
  function boonInfo(b) {
    if (!b) return { id: '?', name: '?', desc: '' };
    if (typeof b === 'string') {
      const pool = (HM.Boons && HM.Boons.pool) || [];
      const f = pool.find((x) => x.id === b);
      if (f) return f;
      const d = HM.Boons && HM.Boons.describe ? HM.Boons.describe(b) : null;
      if (d && typeof d === 'object') return Object.assign({ id: b }, d);
      return { id: b, name: typeof d === 'string' ? d : b, desc: '' };
    }
    if (b.id && !b.name && HM.Boons && HM.Boons.pool) { const f = HM.Boons.pool.find((x) => x.id === b.id); if (f) return Object.assign({}, f, b); }
    return b;
  }
  const SIGILS = {
    prismo: ['.-----.', '| [=] |', "'-----'"], owl: [' (o,o) ', ' {`"`} ', ' -"-"- '], billy: [' _/^\\_ ', ' (o o) ', ' /|||\\ '],
    gunter: ['  _   ', ' (o>  ', ' /|\\  '], hunson: ['\\ /\\ /', ' (oo) ', ' /\\/\\ '], bubblegum: [' .-^-. ', ' (o o) ', ' )~~~( '],
    peppermint: ['  @@  ', ' (..) ', '  ][  '], death: ['  .-.  ', ' (x x) ', '  |=|  '], jake: [' _____ ', '( o o )', ' \\_v_/ '],
    lich: [' .|||. ', ' (O O) ', '  vvv  '], marceline: [' /\\ /\\ ', ' (o o) ', '  ^ ^  '], default: ['   *   ', ' *-+-* ', '   *   '],
  };
  function sigil(giver) {
    const g = String(giver || '').toLowerCase();
    for (const k in SIGILS) if (k !== 'default' && g.indexOf(k) >= 0) return SIGILS[k];
    if (g.indexOf('cosmic') >= 0) return SIGILS.owl; if (g.indexOf('butler') >= 0) return SIGILS.peppermint; if (g.indexOf('pb') >= 0 || g.indexOf('princess') >= 0) return SIGILS.bubblegum;
    return SIGILS.default;
  }
  function chooseBoon(b) {
    const info = boonInfo(b); const id = typeof b === 'string' ? b : info.id;
    UI.toast('Boon · ' + (info.name || id), rarityColor(info.rarity), 2.2);
    HM.Game.chooseBoon(id);
  }
  function drawBoon() {
    backdropDim(0.62);
    const Gm = HM.Game, run = Gm.run || {};
    const draft = ((Gm.menuData && Gm.menuData.draft) || []).map((b) => ({ raw: b, b: boonInfo(b) }));
    header('A BOON IS OFFERED', 'the powers of Ooo take an interest in you · choose one');
    const n = draft.length || 1, gap = 22 * S, cwid = Math.min(270 * S, (W - 80 * S - gap * (n - 1)) / n), ch = 330 * S;
    const x0 = (W - (cwid * n + gap * (n - 1))) / 2, y0 = Math.max(84 * S, H / 2 - ch / 2 - 20 * S);
    draft.forEach(({ raw, b }, i) => {
      const x = x0 + i * (cwid + gap), id = 'b:' + i, f = isFocus(id);
      const rc = rarityColor(b.rarity || 'common');
      const rise = f ? -6 * S : 0, y = y0 + rise;
      panel(x, y, cwid, ch, { border: f ? rc : '#6b6b6b', bg: f ? 'rgba(10,9,8,0.95)' : 'rgba(1,2,4,0.92)' });
      if (f) corners(x, y, cwid, ch, rc);
      fill(x + 10 * S, y + 10 * S, 22 * S, 18 * S, '#000'); box(x + 10 * S, y + 10 * S, 22 * S, 18 * S, '#8a8a8a'); text(String(i + 1), x + 21 * S, y + 19 * S + 1, '#fff', fpx(11), 'center');
      spaced(String(b.rarity || 'common').toUpperCase(), x + cwid - 12 * S, y + 19 * S, rc, fpx(9), 'right', 0.4);
      const sg = sigil(b.giver);
      sg.forEach((l, k) => text(l, x + cwid / 2, y + 52 * S + k * 15 * S, f ? mixHex(rc, '#ffffff', 0.4) : COL.dim, fpx(13), 'center'));
      let cy = y + 116 * S;
      spaced(String(b.giver || 'a stranger').toUpperCase(), x + cwid / 2, cy, COL.faint, fpx(9), 'center', 0.4); cy += 22 * S;
      text(b.name || b.id, x + cwid / 2, cy, rc, fpx(15), 'center', { bold: true }); cy += 14 * S;
      text('~ · ~', x + cwid / 2, cy, COL.ghost, fpx(10), 'center'); cy += 18 * S;
      const maxC = Math.floor((cwid - 28 * S) / cw(fpx(11)));
      for (const l of wrap(b.desc || '', maxC).slice(0, 6)) { text(l, x + cwid / 2, cy, '#cfcfcf', fpx(11), 'center'); cy += 16 * S; }
      if (b.quote) { cy += 8 * S; for (const l of wrap('"' + String(b.quote).replace(/^["\u201c]+|["\u201d]+$/g, '') + '"', maxC + 2).slice(0, 3)) { text(l, x + cwid / 2, cy, '#7f7a72', fpx(10), 'center'); cy += 14 * S; } }
      if ((b.max || 1) > 1) { const have = HM.Boons && HM.Boons.count ? HM.Boons.count(run, b.id) : 0; text('rank ' + (have + 1) + ' / ' + b.max, x + cwid / 2, y + ch - 32 * S, COL.dim, fpx(10), 'center'); }
      if (b.tags && b.tags.length) text(b.tags.slice(0, 3).join(' · '), x + cwid / 2, y + ch - 16 * S, COL.faint, fpx(9), 'center');
      const h = hit(id, x, y, cwid, ch, { act: () => chooseBoon(raw) }); if (i === 0) h.def = true;
    });
    const by = y0 + ch + 18 * S;
    text('boon points ' + (run.boonPoints || 0), W / 2 - 150 * S, by + 12 * S, COL.dim, fpx(11), 'center');
    if (run.rerolls > 0) button('b:reroll', W / 2 - 70 * S, by, 140 * S, 26 * S, 'reroll (' + run.rerolls + ')  [R]', () => Gm.rerollBoons(), { color: COL.gold });
    else text('no rerolls', W / 2, by + 13 * S, COL.ghost, fpx(11), 'center');
    text('floor ' + ((run.floorIndex || 1) + 1) + ' awaits', W / 2 + 150 * S, by + 12 * S, COL.dim, fpx(11), 'center');
    drawDescentTrack(W / 2, by + 66 * S, (run.floorIndex || 1) + 1);
    footerHint('1 · 2 · 3 or click to choose');
  }

  // ======================================================================= SHOP (Choose Goose)
  function drawShop() {
    backdropDim(0.6);
    const Gm = HM.Game, run = Gm.run || {};
    const stock = (Gm.menuData && Gm.menuData.stock) || [];
    const pw = Math.min(W - 40 * S, 860 * S), ph = Math.min(H - 80 * S, 500 * S), px = (W - pw) / 2, py = (H - ph) / 2;
    panel(px, py, pw, ph, { title: 'CHOOSE GOOSE · TRAVELLING MERCHANT', bg: '#020203' });
    text('close (ESC)', px + pw - 12 * S, py + 13 * S, COL.dim, fpx(10), 'right');
    hit('sh:close', px + pw - 90 * S, py, 90 * S, 26 * S, { act: () => Gm.setState('play'), focusable: false });
    // goose
    const gx = px + 110 * S, gy = py + 26 * S + 210 * S;
    drawFigure('goose', gx, gy, 26, 7.4 * S);
    if (!UI._gooseLine || UI._gooseFor !== Gm.menuData) { UI._gooseFor = Gm.menuData; UI._gooseLine = (Gm.menuData && Gm.menuData.greeting) || '"' + ((HM.Lore && HM.Lore.bark('goose')) || 'Choose wisely.') + '"'; }
    const ql = wrap(UI._gooseLine.replace(/^Choose Goose:\s*/, ''), 28).slice(0, 6);
    ql.forEach((l, k) => text(l, gx, gy + 20 * S + k * 15 * S, '#cfc6b0', fpx(11), 'center'));
    text('GOLD', gx - 40 * S, py + ph - 26 * S, COL.dim, fpx(11)); text((run.gold || 0) + 'g', gx + 40 * S, py + ph - 26 * S, COL.gold, fpx(14), 'right', { bold: true });
    // stock
    const lx = px + 230 * S, lw = pw - 246 * S, rowH = 40 * S;
    let y = py + 40 * S;
    let tipItem = null, tipY = 0;
    if (!stock.length) text('"Sold out. The end of the world is good for business."', lx + lw / 2, y + 60 * S, COL.dim, fpx(12), 'center');
    stock.forEach((e, i) => {
      if (y + rowH > py + ph - 10 * S) return;
      const id = 'sh:' + i, f = isFocus(id), it = e.item || null;
      const name = ((it && it.name) || e.name || e.label || (e.kind === 'pancake' ? 'Bacon Pancake' : e.kind === 'tonic' ? 'Tonic' : e.kind) || 'Curio') + (e.qty > 1 && !e.sold ? '  ×' + e.qty : '');
      const price = e.price !== undefined ? e.price : e.cost !== undefined ? e.cost : it && it.value || 0;
      const sold = !!(e.sold || e.bought);
      const afford = (run.gold || 0) >= price;
      const rc = it ? rarityColor(it.rarity) : e.color ? css(e.color) : e.kind === 'pancake' ? '#e8b080' : e.kind === 'tonic' ? '#8ab0ff' : COL.text;
      if (f) fill(lx, y, lw, rowH - 4 * S, 'rgba(255,255,255,0.06)');
      box(lx, y, lw, rowH - 4 * S, f ? COL.hiBorder : '#4a4a4a');
      // icon cell
      fill(lx + 6 * S, y + 5 * S, 26 * S, rowH - 14 * S, '#000'); box(lx + 6 * S, y + 5 * S, 26 * S, rowH - 14 * S, '#6a6a6a');
      const glyph = e.kind === 'rune' ? runeDef(e.runeId).glyph : e.kind === 'boon' ? '0' : itemGlyph(it, e.kind);
      text(glyph, lx + 19 * S, y + (rowH - 4 * S) / 2, sold ? COL.faint : rc, fpx(13), 'center');
      text(name, lx + 42 * S, y + 12 * S, sold ? COL.faint : rc, fpx(12));
      let sub = it ? (it.rarity || '') + (it.slot ? ' ' + it.slot : '') + (it.level ? ' · item level ' + it.level : '') + (it.heroes && it.heroes.length && run.heroId && it.heroes.indexOf(run.heroId) < 0 ? ' · not for you' : '') : (e.desc || (e.kind === 'pancake' ? 'heals · eat with key ' + HM.Input.actionLabel('potion1') : e.kind === 'tonic' ? 'restores your resource · key ' + HM.Input.actionLabel('potion2') : ''));
      const smax = Math.floor((lw - 120 * S) / cw(fpx(10))); if (sub.length > smax) sub = sub.slice(0, smax - 1) + '…';
      text(sub, lx + 42 * S, y + 26 * S, COL.faint, fpx(10));
      text(sold ? 'SOLD' : price + 'g', lx + lw - 12 * S, y + (rowH - 4 * S) / 2, sold ? COL.faint : afford ? COL.gold : COL.bad, fpx(12), 'right');
      hit(id, lx, y, lw, rowH - 4 * S, { act: sold ? null : () => buyStock(i, price, name), focusable: true }).def = i === 0;
      if (f && it && showTip(id)) { tipItem = it; tipY = y; }
      y += rowH;
    });
    if (tipItem) drawItemTooltip(tipItem, Math.min(px + pw + 8 * S, W - 300 * S), tipY, { compare: true, side: 'left', anchorX: lx, showEquipped: false });
    footerHint('enter / click to buy  ·  esc to leave');
  }
  function buyStock(i, price, name) {
    const Gm = HM.Game, run = Gm.run; if (!run || !HM.Items || !HM.Items.buy) return;
    if ((run.gold || 0) < price) { sfx('ui_error'); UI.toast('Not enough gold', COL.bad, 1.8); UI._gooseLine = '"Coins first. Then the shiny. Honk."'; return; }
    const g0 = run.gold;
    let r; try { r = HM.Items.buy(run, i); } catch (e) { console.error(e); r = { ok: false, error: 'The goose looks confused.' }; }
    const ok = r === true || (r && typeof r === 'object' && r.ok !== false && !r.error) || run.gold < g0;
    if (ok) {
      sfx('gold'); UI.toast('Bought · ' + name.replace(/\s+×\d+$/, ''), COL.gold, 2.2); ach('goose_buy');
      UI._gooseLine = (r && r.line) || '"' + ((HM.Lore && HM.Lore.bark('goose')) || 'Pleasure.') + '"';
      if (HM.Heroes && HM.Heroes.recompute && Gm.player) HM.Heroes.recompute(Gm.player);
    } else { sfx('ui_error'); UI.toast((r && r.error) || 'Cannot buy that.', COL.bad, 2); if (r && r.error) UI._gooseLine = '"' + r.error + '"'; }
  }

  // ======================================================================= ITEMS (inventory + tooltips)
  const KIND_GLYPH = { sword: '/', axe: 'P', bass: 'Y', staff: '|', wand: '!', bow: ')', spear: '^', claws: 'w', fists: 'm', armor: ']', trinket: 'o', rune: '◊', pancake: '@', tonic: '&' };
  function itemGlyph(it, kind) {
    if (!it) return KIND_GLYPH[kind] || '?';
    if (it.glyph && String(it.glyph).length <= 2) return String(it.glyph);
    return KIND_GLYPH[it.kind] || KIND_GLYPH[it.slot] || '*';
  }
  const ICON_ART = {
    sword: ['      /#', '     /#/', '\\   /#/ ', ' \\=/#/  ', '  X#/   ', ' / \\    '],
    axe: ['  _##_ ', ' (###/ ', '  `\\|  ', '    |  ', '    |  ', '    |  '],
    bass: ['   _#_  ', '  /#|#\\ ', '  \\#|#/ ', '    |   ', '  /=#=\\ ', '  \\###/ '],
    staff: ['  \\#/  ', '  -@-  ', '  /|\\  ', '   |   ', '   |   ', '   |   '],
    wand: ['    *  ', '   #   ', '  #    ', ' #     ', '#      '],
    armor: [' _   _ ', '|#\\_/#|', '|#####|', ' |###| ', ' |###| ', ' \'---\' '],
    trinket: ['  .-.  ', ' ( # ) ', '  \\#/  ', '  (@)  ', '   v   '],
    rune: ['  /\\  ', ' /##\\ ', ' \\##/ ', '  \\/  '],
  };
  function materialOf(it) { const mats = HM.Items && HM.Items.MATERIALS; return (mats && it && mats[it.material]) || null; }
  function drawItemArt(it, cx, cy, maxW, maxH, dim, cap) {
    if (!it) return;
    let art = ICON_ART[it.kind] || ICON_ART[it.slot] || ICON_ART.trinket;
    const mat = materialOf(it); const mg = (mat && mat.glyphs) || '#%:';
    let col = mat ? mat.hex || css(mat.color) : rarityColor(it.rarity);
    if (HM.Items && HM.Items.icon) { try { const ic = HM.Items.icon(it); if (ic && ic.lines && ic.lines.length) { art = ic.lines; col = ic.hex || col; } } catch (e) { /* fall back to our art */ } }
    const rows = art.length; let cols = 1; for (const l of art) cols = Math.max(cols, l.length);
    const px = Math.max(5, Math.min(Math.floor(maxH / rows / 1.05), Math.floor(maxW / cols / 0.62), cap || 16));
    setFont(px); const c = cw(px), lh = px * 1.02;
    const x0 = cx - (cols * c) / 2, y0 = cy - (rows * lh) / 2 + lh / 2;
    for (let r = 0; r < rows; r++) for (let q = 0; q < art[r].length; q++) {
      let ch = art[r][q]; if (ch === ' ') continue;
      if (ch === '#') ch = mg[(r * 3 + q) % mg.length];
      ctx.fillStyle = dim ? '#555' : ch === '@' || ch === '*' ? mixHex(col, '#ffffff', 0.5) : col;
      ctx.fillText(ch, snap(x0 + q * c), snap(y0 + r * lh));
    }
  }
  function describe(it, cmp) {
    let lines = null;
    try { if (HM.Items && HM.Items.describe) lines = HM.Items.describe(it, cmp || undefined); } catch (e) { lines = null; }
    if (!lines || !lines.length) {
      lines = [{ text: it.name || 'Item', color: rarityColor(it.rarity) }, { text: (it.rarity || 'common') + (it.material ? ', ' + it.material : '') + (it.slot ? ' ' + it.slot : ''), color: COL.dim }];
      if (it.dmg) lines.push({ text: 'damage ' + it.dmg[0] + '-' + it.dmg[1] + (it.speed ? ' · ' + it.speed + 's' : ''), color: COL.text });
      for (const md of it.mods || []) lines.push({ text: (md.value > 0 ? '+' : '') + md.value + ' ' + md.stat, color: '#9fc3ff' });
      if (it.sockets) lines.push({ text: 'sockets ' + (it.runes || []).length + '/' + it.sockets, color: COL.dim });
    }
    return lines.map((l) => (typeof l === 'string' ? { text: l, color: COL.text } : { text: String(l.text || ''), color: css(l.color, COL.text) }));
  }
  function modsOf(it) {
    const o = {};
    if (!it) return o;
    for (const md of it.mods || []) o[md.stat] = (o[md.stat] || 0) + (Number(md.value) || 0);
    if (it.dmg) o['avg damage'] = (it.dmg[0] + it.dmg[1]) / 2;
    return o;
  }
  function fmtStat(k, v) { const pct = /chance|leech|cdr|mul|speed|crit|res|%/i.test(k) && Math.abs(v) < 5; return (v > 0 ? '+' : '') + (pct ? Math.round(v * 100) + '%' : (Math.round(v * 10) / 10)) + ' ' + k; }
  function drawItemTooltip(it, x, y, o) {
    o = o || {};
    let eq = null;
    if (o.compare) { const run = HM.Game.run; const e2 = run && run.inventory && run.inventory.equipped; if (e2 && it.slot && e2[it.slot] && e2[it.slot] !== it && e2[it.slot].uid !== it.uid) eq = e2[it.slot]; }
    const native = !!(HM.Items && HM.Items.describe);
    const lines = describe(it, eq);
    const flav = it.flavor || (HM.Lore && HM.Lore.itemFlavor ? HM.Lore.itemFlavor(it) : '');
    const pxT = fpx(11), maxC = 40;
    const all = [];
    lines.forEach((l, i) => { for (const w2 of wrap(l.text, maxC)) all.push({ text: w2, color: l.color, bold: i === 0 }); });
    if (!native && it.runes && it.runes.length) for (const rid of it.runes) { const rn = HM.Items && HM.Items.RUNES && HM.Items.RUNES[rid]; all.push({ text: '◊ ' + ((rn && rn.name) || rid), color: rn && rn.color ? css(rn.color) : '#b8a0ff' }); }
    if (flav && !lines.some((l) => l.text === flav)) { all.push({ text: '', color: COL.dim }); for (const w2 of wrap(flav, maxC)) all.push({ text: w2, color: '#8f887c' }); }
    if (eq && !native) {
      const a = modsOf(it), b = modsOf(eq); const keysAll = {}; for (const k in a) keysAll[k] = 1; for (const k in b) keysAll[k] = 1;
      const diffs = []; for (const k in keysAll) { const d = (a[k] || 0) - (b[k] || 0); if (Math.abs(d) > 1e-6) diffs.push({ text: fmtStat(k, d), color: d > 0 ? COL.good : COL.bad }); }
      all.push({ text: '', color: COL.dim }); all.push({ text: 'vs equipped:', color: COL.faint });
      if (!diffs.length) all.push({ text: 'no difference', color: COL.faint }); else for (const d of diffs.slice(0, 8)) all.push(d);
    } else if (eq && !lines.some((l) => /vs\. equipped/.test(l.text))) { all.push({ text: 'no difference vs. equipped', color: COL.faint }); }
    if (o.hint) { all.push({ text: '', color: COL.dim }); all.push({ text: o.hint, color: COL.faint }); }
    let mc = 0; for (const l of all) mc = Math.max(mc, l.text.length);
    const w = Math.max(180 * S, mc * cw(pxT) + 24 * S), lh = 15 * S, h = all.length * lh + 18 * S;
    if (o.side === 'left' && o.anchorX !== undefined) x = Math.max(8, o.anchorX - w - 10 * S);
    x = M.clamp(x, 6, W - w - 6); y = M.clamp(y, 6, H - h - 6);
    panel(x, y, w, h, { bg: 'rgba(0,0,0,0.96)', border: rgba(rarityColor(it.rarity), 0.9) });
    all.forEach((l, i) => text(l.text, x + 12 * S, y + 12 * S + i * lh, l.color, pxT, 'left', { bold: l.bold }));
    if (eq && o.showEquipped !== false) drawEquippedSide(eq, x, y, w);
    return { x, y, w, h };
  }
  function drawEquippedSide(eq, x, y, w) {
    const lines = describe(eq);
    const pxT = fpx(10), lh = 14 * S;
    let mc = 8; for (const l of lines) mc = Math.max(mc, Math.min(40, l.text.length));
    const w2 = Math.max(150 * S, mc * cw(pxT) + 22 * S), h2 = (lines.length + 1) * lh + 16 * S;
    let x2 = x + w + 6 * S; if (x2 + w2 > W - 6) x2 = x - w2 - 6 * S;
    panel(x2, y, w2, h2, { bg: 'rgba(0,0,0,0.92)', border: '#5a5a5a' });
    text('EQUIPPED', x2 + 10 * S, y + 11 * S, COL.faint, pxT);
    lines.forEach((l, i) => text(l.text.slice(0, 40), x2 + 10 * S, y + 11 * S + (i + 1) * lh, l.color, pxT));
  }
  const showTip = (id) => (UI.hover && UI.hover.id === id) || (UI.kbNav && UI.focus === id);
  function findItemByUid(uid) {
    const run = HM.Game.run; const inv = run && run.inventory; if (!inv) return null;
    for (const it of inv.bag || []) if (it && String(it.uid) === String(uid)) return it;
    const eq = inv.equipped || {}; for (const k in eq) if (eq[k] && String(eq[k].uid) === String(uid)) return eq[k];
    return null;
  }
  function isRune(it) { return it && (it.slot === 'rune' || it.kind === 'rune'); }
  function recompute() { const p = HM.Game.player; if (p && HM.Heroes && HM.Heroes.recompute) { try { HM.Heroes.recompute(p); } catch (e) { console.error(e); } } }
  function runeDef(id) { return (HM.Items && HM.Items.RUNES && HM.Items.RUNES[id]) || { name: id + ' rune', glyph: '◊', hex: '#b8a0ff', desc: '' }; }
  function pickRune(id) {
    if (UI.socketRune && UI.socketRune.id === id) { UI.socketRune = null; sfx('ui_back'); return; }
    const d = runeDef(id); UI.socketRune = { id, name: d.name }; sfx('ui_select');
  }
  function equipItem(it) {
    const run = HM.Game.run; if (!run || !it || !HM.Items) return;
    if (isRune(it)) { UI.socketRune = { id: it.runeId || it.baseId || it.id, uid: it.uid, name: it.name }; sfx('ui_select'); return; }
    if (UI.socketRune) { socketInto(it); return; }
    if (it.heroes && it.heroes.length && it.heroes.indexOf(run.heroId) < 0) { sfx('ui_error'); UI.toast('Your hero cannot use that.', COL.bad, 2); return; }
    let r; try { r = HM.Items.equip(run, it.uid); } catch (e) { console.error(e); r = false; }
    if (r === false || (r && r.ok === false)) { sfx('ui_error'); UI.toast((r && r.error) || 'Cannot equip that.', COL.bad, 2); return; }
    recompute(); sfx('pickup');
  }
  function unequipSlot(slot) {
    const run = HM.Game.run; if (!run || !HM.Items || !HM.Items.unequip) return;
    if (UI.socketRune) { const it = run.inventory.equipped[slot]; if (it) socketInto(it); return; }
    let r; try { r = HM.Items.unequip(run, slot); } catch (e) { console.error(e); r = false; }
    if (r === false || (r && r.ok === false)) { sfx('ui_error'); UI.toast((r && r.error) || 'Cannot take that off.', COL.bad, 2); return; }
    recompute(); sfx('ui_back');
  }
  function socketInto(it) {
    const run = HM.Game.run, sr = UI.socketRune; if (!sr || !it) return;
    if (!(it.sockets > (it.runes || []).length)) { sfx('ui_error'); UI.toast('No open socket on ' + (it.name || 'that item'), COL.bad, 2); return; }
    let r; try { r = HM.Items.socketRune(run, it.uid, sr.id); } catch (e) { console.error(e); r = false; }
    if (r === false || (r && r.ok === false)) { sfx('ui_error'); UI.toast((r && r.error) || 'The rune will not take.', COL.bad, 2); }
    else { sfx('shrine'); UI.toast((sr.name || 'Rune') + ' set into ' + (it.name || 'item'), '#b8a0ff', 2.4); recompute(); }
    UI.socketRune = null;
  }
  function discardItem(it) {
    const run = HM.Game.run; if (!run || !it || !HM.Items || !HM.Items.discard) return;
    const go = () => {
      let r = null; try { r = HM.Items.discard(run, it.uid); } catch (e) { console.error(e); }
      recompute(); sfx('ui_back');
      UI.toast((r && r.dropped ? 'Dropped ' : 'Discarded ') + (it.name || 'item'), COL.dim, 1.6);
    };
    if ((RARITY_ORDER[it.rarity] || 0) >= 2) UI.confirm('Drop ' + (it.name || 'this item') + '?\nIt falls at your feet; leave the floor and it is gone.', go, null, { yes: 'drop it', no: 'keep', danger: true });
    else go();
  }
  function salvageItem(it) {
    const run = HM.Game.run; if (!run || !it || !HM.Items || !HM.Items.salvage) return;
    const go = () => {
      let r = null; try { r = HM.Items.salvage(run, it.uid); } catch (e) { console.error(e); }
      recompute();
      if (r && r.ok) UI.toast('Salvaged ' + (it.name || 'item') + ' · +' + r.gold + 'g', COL.gold, 1.8); else UI.toast((r && r.error) || 'Cannot salvage that.', COL.bad, 1.8);
    };
    if ((RARITY_ORDER[it.rarity] || 0) >= 2) UI.confirm('Salvage ' + (it.name || 'this item') + ' for gold?\nIt is destroyed.', go, null, { yes: 'salvage', no: 'keep', danger: true });
    else go();
  }
  function drawInventory() {
    backdropDim(0.55);
    const Gm = HM.Game, run = Gm.run, p = Gm.player; if (!run || !p) return;
    const inv = run.inventory || { equipped: {}, bag: [] }, eq = inv.equipped || {}, bag = inv.bag || [];
    const hi = heroInfo(run.heroId);
    const pw = Math.min(W - 24 * S, 940 * S), ph = Math.min(H - 24 * S, 640 * S), px = (W - pw) / 2, py = (H - ph) / 2;
    panel(px, py, pw, ph, { title: (hi.name + ' · ' + (hi.title || '').replace(/^the /i, '')).toUpperCase(), bg: '#010203' });
    const cl = 'close (' + HM.Input.actionLabel('inventory') + ')', clw = tw(cl, fpx(11)) + 16 * S;
    box(px + pw - clw - 8 * S, py + 4 * S, clw, 18 * S, '#a8a8a8'); text(cl, px + pw - clw / 2 - 8 * S, py + 13 * S + 1, COL.text, fpx(11), 'center');
    hit('i:close', px + pw - clw - 8 * S, py + 4 * S, clw, 18 * S, { act: () => Gm.setState('play'), focusable: false });
    const top = py + 26 * S, upH = Math.round(ph * 0.42);
    // --- equipment slots
    let tip = null;
    const slotBox = (slot, x, y, w, h, label) => {
      const it = eq[slot], id = 'eq:' + slot, f = isFocus(id);
      fill(x, y, w, h, '#000');
      if (it) box(x, y, w, h, f ? COL.hiBorder : rgba(rarityColor(it.rarity), 0.85)); else dashBox(x, y, w, h, f ? COL.hiBorder : '#555');
      text(label, x + 6 * S, y + 9 * S, COL.faint, fpx(9));
      if (it) {
        drawItemArt(it, x + w / 2, y + h / 2 + 4 * S, w - 20 * S, h - 30 * S, false, Math.round(26 * S));
        if (it.sockets) { let sx2 = x + w - 6 * S; for (let k = it.sockets - 1; k >= 0; k--) { const rid = (it.runes || [])[k]; const d = rid ? runeDef(rid) : null; const lab = '[' + (d ? d.glyph : ' ') + ']'; text(lab, sx2, y + 9 * S, d ? d.hex || '#b8a0ff' : COL.faint, fpx(9), 'right'); sx2 -= tw(lab, fpx(9)) + 2 * S; } }
        if (f && showTip(id)) tip = { it, x: x + w + 8 * S, y, compare: false, hint: UI.socketRune ? 'click to set the rune here' : 'click to take off' };
      } else text('empty', x + w / 2, y + h / 2, COL.ghost, fpx(10), 'center');
      if (UI.socketRune && it && it.sockets > (it.runes || []).length) box(x - 2, y - 2, w + 4, h + 4, '#b8a0ff');
      hit(id, x, y, w, h, { act: it ? () => unequipSlot(slot) : null, focusable: true });
    };
    const ex = px + 16 * S, ey = top + 14 * S;
    const bigW = 110 * S, bigH = upH - 24 * S;
    slotBox('weapon', ex, ey, bigW, bigH, 'weapon');
    slotBox('armor', ex + bigW + 10 * S, ey, bigW, bigH * 0.58, 'armor');
    slotBox('trinket', ex + bigW + 10 * S, ey + bigH * 0.58 + 10 * S, bigW, bigH * 0.42 - 10 * S, 'trinket');
    // portrait
    const pcx = ex + bigW * 2 + 20 * S + 70 * S;
    drawFigure(run.heroId, pcx, ey + bigH - 4 * S, 28, Math.min(7 * S, (bigH - 10 * S) / 28 / 0.96));
    // --- stats panel (right of portrait)
    const sx = pcx + 82 * S, sw = px + pw - 16 * S - sx;
    let sy = ey + 6 * S;
    const st = p.stats || {};
    const pct = (v) => Math.round((v || 0) * 100) + '%';
    const wd = p.weaponDmg || (eq.weapon && eq.weapon.dmg);
    const pairs = [
      ['damage', wd ? Math.round(wd[0] * (st.dmgMul || 1)) + '-' + Math.round(wd[1] * (st.dmgMul || 1)) : '—'], ['crit', pct(st.critChance) + ' ×' + (st.critMult || 1.5).toFixed(1)],
      ['attack spd', (st.atkSpeed || 1).toFixed(2) + '×'], ['cast spd', (st.castSpeed || 1).toFixed(2) + '×'],
      ['armor', Math.round(st.armor || 0)], ['move', pct(st.moveMul || 1)],
      ['cooldowns', st.cdr ? '-' + pct(st.cdr) : '0%'], ['life leech', pct(st.leech)],
      ['regen', (Math.round((st.regen || 0) * 10) / 10) + '/s'], ['thorns', Math.round(st.thorns || 0)],
    ];
    const res = st.res || {};
    for (const k of ['fire', 'ice', 'poison', 'shadow', 'holy']) pairs.push([k + ' res', pct(res[k])]);
    const colW2 = sw / 2;
    pairs.forEach((pr, i) => {
      const cx2 = sx + (i % 2) * colW2, cy2 = sy + Math.floor(i / 2) * 16 * S;
      if (cy2 > ey + bigH - 54 * S) return;
      text(pr[0], cx2, cy2, COL.faint, fpx(10)); text(String(pr[1]), cx2 + colW2 - 12 * S, cy2, COL.text, fpx(10), 'right');
    });
    // boons
    const boons = (run.boons || []).map(boonInfo);
    let by2 = ey + bigH - 40 * S;
    text('BOONS', sx, by2, COL.faint, fpx(9)); by2 += 14 * S;
    let bx2 = sx;
    if (!boons.length) text('none', sx, by2, COL.ghost, fpx(10));
    boons.forEach((b, i) => {
      const w2 = tw(b.name || b.id, fpx(10)) + 12 * S;
      if (bx2 + w2 > sx + sw) { bx2 = sx; by2 += 17 * S; }
      if (by2 > ey + bigH + 6 * S) return;
      const id = 'boon:' + i, f = UI.hover && UI.hover.id === id;
      box(bx2, by2 - 7 * S, w2 - 4 * S, 15 * S, f ? '#fff' : rgba(rarityColor(b.rarity), 0.55)); text(b.name || b.id, bx2 + 4 * S, by2 + 1, rarityColor(b.rarity), fpx(10));
      hit(id, bx2, by2 - 7 * S, w2 - 4 * S, 15 * S, { focusable: false });
      if (f) tip = { boon: b, x: bx2, y: by2 + 12 * S };
      bx2 += w2;
    });
    // --- character strip (like the reference)
    const sy2 = top + upH;
    fill(px, sy2, pw, 1, COL.border);
    const xpN = Gm.xpToNext ? Gm.xpToNext(run.level || 1) : 100;
    let lx = px + 14 * S; const ly = sy2 + 16 * S;
    lx += text('level ' + (run.level || 1), lx, ly, COL.text, fpx(11)) + 14 * S;
    lx += text('XP', lx, ly, COL.text, fpx(11)) + 8 * S;
    tickBar(lx, ly - 5 * S, 120 * S, 10 * S, (run.xp || 0) / xpN, '#ececec', { step: 0.7, pad: 2 }); lx += 128 * S;
    lx += text(Math.floor(run.xp || 0) + '/' + xpN, lx, ly, COL.text, fpx(11)) + 16 * S;
    lx += text('HP ' + Math.ceil(p.hp) + '/' + Math.ceil(p.maxHp), lx, ly, COL.text, fpx(11)) + 16 * S;
    const rs = resourceOf(p);
    lx += text(rs.short + ' ' + Math.floor(rs.value) + '/' + Math.floor(rs.max), lx, ly, COL.text, fpx(11)) + 16 * S;
    text('gold ' + (run.gold || 0), lx, ly, COL.gold, fpx(11));
    const cons = run.consumables || {};
    text('pancakes ' + (cons.pancake || 0) + ' · tonics ' + (cons.tonic || 0), px + pw - 14 * S, ly, COL.dim, fpx(11), 'right');
    fill(px, sy2 + 32 * S, pw, 1, COL.border);
    // --- bag grid
    const gy = sy2 + 32 * S;
    const cap = Math.max(inv.bagSize || inv.capacity || (HM.Items && HM.Items.BAG_CAP) || 20, bag.length);
    text('Bag ' + bag.length + '/' + cap, px + 14 * S, gy + 14 * S, bag.length >= cap ? COL.bad : COL.text, fpx(11));
    // rune pouch: {runeId: count}
    const pouch = inv.runes && !Array.isArray(inv.runes) ? inv.runes : {};
    let rx = px + 110 * S;
    const rids = Object.keys(pouch).filter((k) => pouch[k] > 0);
    if (rids.length) { text('RUNES', rx, gy + 14 * S, COL.faint, fpx(9)); rx += 44 * S; }
    for (const rid of rids) {
      const d = runeDef(rid), id = 'rune:' + rid, f = isFocus(id), sel = UI.socketRune && UI.socketRune.id === rid;
      const lab = d.glyph + ' ' + d.name.replace(/ Rune$/, '') + ' ×' + pouch[rid], w2 = tw(lab, fpx(10)) + 12 * S;
      fill(rx, gy + 6 * S, w2, 17 * S, sel ? rgba(d.hex || '#b8a0ff', 0.25) : '#000'); box(rx, gy + 6 * S, w2, 17 * S, f || sel ? '#fff' : rgba(d.hex || '#b8a0ff', 0.7));
      text(lab, rx + 6 * S, gy + 14.5 * S, d.hex || '#b8a0ff', fpx(10));
      hit(id, rx, gy + 6 * S, w2, 17 * S, { act: () => pickRune(rid), focusable: true });
      if (f && showTip(id)) tip = { rune: d, x: rx, y: gy + 26 * S };
      rx += w2 + 6 * S;
    }
    const help = UI.socketRune ? 'setting ' + (UI.socketRune.name || 'rune') + ' · click an item with an open [ ] slot · esc cancels' : 'LMB equip / take off  ·  RMB drop  ·  C salvage for gold  ·  click a rune, then an item to socket it';
    text(help, px + pw / 2, py + ph - 11 * S, UI.socketRune ? '#c8b0ff' : COL.faint, fpx(10), 'center');
    const cell = Math.round(46 * S), gx0 = px + 14 * S, gy0 = gy + 28 * S;
    const colsN = Math.max(1, Math.floor((pw - 28 * S + 4 * S) / (cell + 4 * S)));
    const rowsVis = Math.max(1, Math.floor((py + ph - 24 * S - gy0) / (cell + 4 * S)));
    const totalCells = Math.max(cap, Math.ceil(bag.length / colsN) * colsN);
    const rowsTot = Math.ceil(totalCells / colsN);
    const fi = bag.findIndex((it) => it && UI.focus === 'bag:' + it.uid);
    const firstRow = listScroll('bag', rowsTot, rowsVis, fi >= 0 ? Math.floor(fi / colsN) : -1);
    for (let i = firstRow * colsN; i < Math.min(totalCells, (firstRow + rowsVis) * colsN); i++) {
      const c = i % colsN, r = Math.floor(i / colsN) - firstRow;
      const x = gx0 + c * (cell + 4 * S), y = gy0 + r * (cell + 4 * S);
      const it = bag[i];
      if (!it) { box(x, y, cell, cell, '#262626'); continue; }
      const id = 'bag:' + it.uid, f = isFocus(id);
      const rc = rarityColor(it.rarity);
      fill(x, y, cell, cell, f ? 'rgba(255,255,255,0.08)' : '#000');
      box(x, y, cell, cell, f ? COL.hiBorder : rgba(rc, 0.7));
      const mat = materialOf(it);
      if (isRune(it)) text('◊', x + cell / 2, y + cell / 2, it.color ? css(it.color) : '#b8a0ff', fpx(20), 'center');
      else drawItemArt(it, x + cell / 2, y + cell / 2 + 1, cell - 8 * S, cell - 10 * S);
      if (it.level) text(String(it.level), x + cell - 4 * S, y + cell - 7 * S, COL.faint, fpx(8), 'right');
      if (mat && mat.color && !isRune(it)) fill(x + 3 * S, y + 3 * S, 3 * S, 3 * S, css(mat.color));
      const usable = !(it.heroes && it.heroes.length && it.heroes.indexOf(run.heroId) < 0);
      if (!usable) fill(x + 1, y + 1, cell - 2, cell - 2, 'rgba(90,0,0,0.35)');
      if (UI.socketRune && it.sockets > (it.runes || []).length) box(x - 2, y - 2, cell + 4, cell + 4, '#b8a0ff');
      hit(id, x, y, cell, cell, { act: () => equipItem(it), alt: () => (HM.Input.down.has('ShiftLeft') || HM.Input.down.has('ShiftRight') ? salvageItem(it) : discardItem(it)), focusable: true });
      if (f && showTip(id)) tip = { it, x: x + cell + 8 * S, y: y - 20 * S, compare: !isRune(it), hint: UI.socketRune ? (it.sockets > (it.runes || []).length ? 'click to set ' + UI.socketRune.name : 'no open rune slot') : usable ? 'LMB equip · RMB drop · C salvage' : 'not for ' + hi.name + ' · C salvage' };
    }
    // keyboard-only hits for bag items scrolled out of view
    bag.forEach((it, i) => {
      if (!it) return; const r = Math.floor(i / colsN);
      if (r >= firstRow && r < firstRow + rowsVis) return;
      const c = i % colsN; hit('bag:' + it.uid, gx0 + c * (cell + 4 * S), gy0 + (r < firstRow ? -1 : rowsVis) * (cell + 4 * S), cell, cell, { act: () => equipItem(it), hidden: true, focusable: true });
    });
    scrollbar(px + pw - 8 * S, gy0, rowsVis * (cell + 4 * S), firstRow, rowsVis, rowsTot);
    // tooltip last (on top)
    if (tip && tip.it) drawItemTooltip(tip.it, tip.x, tip.y, { compare: tip.compare, hint: tip.hint });
    else if (tip && tip.rune) {
      const d = tip.rune, lines = [d.glyph + '  ' + d.name].concat(wrap(d.desc || '', 36)).concat(['', 'click, then an item with an open slot']);
      const w = Math.max(160 * S, 38 * cw(fpx(10)) + 20 * S), h = lines.length * 14 * S + 16 * S;
      const x = M.clamp(tip.x, 6, W - w - 6), y = M.clamp(tip.y, 6, H - h - 6);
      panel(x, y, w, h, { bg: 'rgba(0,0,0,0.96)', border: d.hex || '#b8a0ff' });
      lines.forEach((l, i) => text(l, x + 10 * S, y + 11 * S + i * 14 * S, i === 0 ? d.hex || '#fff' : i === lines.length - 1 ? COL.faint : '#cfcfcf', fpx(10)));
    }
    else if (tip && tip.boon) {
      const b = tip.boon, lines = [b.name || b.id].concat(wrap(b.desc || '', 36));
      const w = Math.max(160 * S, 38 * cw(fpx(10)) + 20 * S), h = lines.length * 14 * S + 16 * S;
      const x = M.clamp(tip.x, 6, W - w - 6), y = M.clamp(tip.y, 6, H - h - 6);
      panel(x, y, w, h, { bg: 'rgba(0,0,0,0.96)', border: rarityColor(b.rarity) });
      lines.forEach((l, i) => text(l, x + 10 * S, y + 11 * S + i * 14 * S, i === 0 ? rarityColor(b.rarity) : '#cfcfcf', fpx(10)));
    }
  }

  // ======================================================================= NOTE reader
  function noteReveal() { return Math.floor(UI.noteT * 90); }
  function drawNoteState() { backdropDim(0.5); if (UI.noteEntry) drawNoteReader(UI.noteEntry, UI.noteT, true); }
  function drawNoteReader(e, t, inPlay) {
    const pw = Math.min(W - 40 * S, 600 * S), maxC = Math.floor((pw - 60 * S) / cw(fpx(12)));
    const body = wrap(e.text || '', maxC);
    const ph = Math.min(H - 40 * S, 150 * S + body.length * 19 * S), px = (W - pw) / 2, py = (H - ph) / 2;
    panel(px, py, pw, ph, { bg: '#030303', border: '#cfc6b0', inner: '#2a2722' });
    corners(px, py, pw, ph, '#cfc6b0');
    spaced(String(e.source || 'Enchiridion').toUpperCase(), px + pw / 2, py + 26 * S, '#8a8170', fpx(9), 'center', 0.35);
    text(e.title || '', px + pw / 2, py + 50 * S, '#f3ead8', fpx(17), 'center', { bold: true });
    text('·  ~  ·  ~  ·', px + pw / 2, py + 70 * S, '#5a5348', fpx(11), 'center');
    let n = Math.floor(t * 90);
    let y = py + 96 * S;
    for (const l of body) {
      if (n <= 0) break;
      text(l.slice(0, n), px + 30 * S, y, '#d6cdb9', fpx(12)); n -= l.length + 1; y += 19 * S;
    }
    if (e.isNew) text('NEW · added to the codex', px + 16 * S, py + ph - 16 * S, COL.witch, fpx(10));
    const done = Math.floor(t * 90) >= (e.text || '').length;
    text(done ? (inPlay ? '[' + HM.Input.actionLabel('interact') + '] / [ENTER] close' : '[ENTER] close') : '[ENTER] reveal', px + pw - 16 * S, py + ph - 16 * S, COL.dim, fpx(10), 'right');
    if (!inPlay) hit('n:close', px, py, pw, ph, { act: () => closeModal(), focusable: true, def: true });
  }

  // ======================================================================= DEATH / VICTORY
  function toTitle() { HM.Game.quitToTitle(); }
  function drawDead() {
    const Gm = HM.Game, info = UI.deadInfo || {}; const run = info.run || {};
    const k = clamp01(UI.stateT / 1.6);
    fill(0, 0, W, H, 'rgba(0,0,0,' + (0.25 + 0.6 * k).toFixed(3) + ')');
    if (ctx.createRadialGradient) {
      const g = ctx.createRadialGradient(W / 2, H * 0.45, 10, W / 2, H * 0.45, Math.max(W, H) * 0.7);
      g.addColorStop(0, 'rgba(60,0,0,' + (0.18 * k).toFixed(3) + ')'); g.addColorStop(1, 'rgba(0,0,0,' + (0.5 * k).toFixed(3) + ')');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    if (UI.stateT < 0.4) return;
    ctx.globalAlpha = clamp01((UI.stateT - 0.4) / 0.8);
    const hi = heroInfo(run.heroId);
    // tombstone
    const ts = [
      '        ___________________        ',
      '      .\'                   \'.      ',
      '     /                       \\     ',
      '    |                         |    ',
      '    |                         |    ',
      '    |                         |    ',
      '    |                         |    ',
      '    |                         |    ',
      '    |_________________________|    ',
      ' ,;\'"\';,;"\'",;\';"\',;\'";,\'";,\'",;\'; ',
    ];
    const tpx = fpx(13), tlh = tpx * 1.12, tcw = cw(tpx), tw0 = ts[0].length * tcw;
    const tx = W / 2 - tw0 / 2, ty = H * 0.1;
    setFont(tpx);
    ts.forEach((l, i) => { ctx.fillStyle = i === ts.length - 1 ? '#2e4a2c' : '#6d7280'; ctx.fillText(l, snap(tx), snap(ty + i * tlh)); });
    spaced('HERE LIES', W / 2, ty + 2.6 * tlh, '#a9adb8', fpx(11), 'center', 0.6);
    text(hi.name, W / 2, ty + 4.1 * tlh, '#e9e9ee', fpx(17), 'center', { bold: true });
    text(hi.title || '', W / 2, ty + 5.3 * tlh, '#8f94a0', fpx(11), 'center');
    text('fell on floor ' + (run.floorIndex || 1), W / 2, ty + 6.6 * tlh, '#8f94a0', fpx(11), 'center');
    // epitaph
    let y = ty + ts.length * tlh + 24 * S;
    for (const l of wrapBalanced(info.epitaph || '', 64)) { text(l, W / 2, y, '#d8cfc4', fpx(13), 'center'); y += 19 * S; }
    y += 14 * S;
    // stats
    const kills = run.kills || 0;
    const ashesShown = Math.min(info.ashes || 0, Math.floor(Math.max(0, UI.stateT - 1.4) * Math.max(30, (info.ashes || 0) / 1.2)));
    const act = Math.ceil((run.floorIndex || 1) / 3);
    const cols = [
      ['UNDONE BY', String(info.killedBy || 'the dark')], ['FLOOR', (run.floorIndex || 1) + ' · act ' + roman(act)],
      ['FOES', String(kills)], ['TIME', fmtTime(run.time || 0)], ['LEVEL', String(run.level || 1)], ['ASHES', '+' + ashesShown],
    ];
    const cwid = Math.min(150 * S, (W - 80 * S) / cols.length);
    const sx0 = W / 2 - (cwid * cols.length) / 2;
    cols.forEach((c, i) => {
      const cx = sx0 + i * cwid + cwid / 2;
      spaced(c[0], cx, y, COL.faint, fpx(9), 'center', 0.4);
      text(c[1].length > 18 ? c[1].slice(0, 17) + '…' : c[1], cx, y + 20 * S, i === 5 ? COL.ember : COL.text, fpx(13), 'center');
    });
    y += 54 * S;
    if (info.tip) text(info.tip, W / 2, y, COL.dim, fpx(11), 'center');
    y += 30 * S;
    const bw = 170 * S;
    button('d:title', W / 2 - bw - 8 * S, y, bw, 28 * S, 'return to title', () => toTitle()).def = true;
    button('d:again', W / 2 + 8 * S, y, bw, 28 * S, 'descend again', () => { toTitle(); HM.Game.setState('heroSelect'); });
    ctx.globalAlpha = 1;
    footerHint('enter · the grass will keep your name');
  }
  function drawVictory() {
    const info = UI.victoryInfo || {}; const run = info.run || {};
    const k = clamp01(UI.stateT / 2.5);
    fill(0, 0, W, H, 'rgba(0,0,0,' + (0.35 + 0.45 * k).toFixed(3) + ')');
    if (ctx.createLinearGradient) {
      const g = ctx.createLinearGradient(0, H, 0, 0);
      g.addColorStop(0, 'rgba(255,170,90,' + (0.22 * k).toFixed(3) + ')'); g.addColorStop(0.5, 'rgba(120,90,140,' + (0.08 * k).toFixed(3) + ')'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    const V = (HM.Lore && HM.Lore.victory) || { title: 'VICTORY', lines: [] };
    spaced(V.title || 'VICTORY', W / 2, H * 0.12, '#ffe7c0', fpx(20), 'center', 0.6);
    text('-=<  *  >=-', W / 2, H * 0.12 + 26 * S, '#8a7458', fpx(12), 'center');
    let y = H * 0.12 + 60 * S;
    const per = 2.4; // seconds per line
    (V.lines || []).forEach((l, i) => {
      const a = clamp01((UI.stateT - 0.8 - i * per) / 1.2); if (a <= 0) return;
      ctx.globalAlpha = a;
      for (const w2 of wrapBalanced(l, 78)) { text(w2, W / 2, y, i === (V.lines.length - 1) ? '#ffe2b0' : '#d9d2c4', fpx(13), 'center'); y += 19 * S; }
      y += 6 * S; ctx.globalAlpha = 1;
    });
    const statsA = clamp01((UI.stateT - 1.5) / 1.0);
    ctx.globalAlpha = statsA;
    const hi = heroInfo(run.heroId);
    const yy = H - 150 * S;
    text(hi.name + ' · ' + (hi.title || ''), W / 2, yy, '#fff', fpx(14), 'center', { bold: true });
    text('level ' + (run.level || 1) + '  ·  ' + (run.kills || 0) + ' foes  ·  ' + fmtTime(run.time || 0) + '  ·  ' + (run.gold || 0) + 'g' + (run.ascension ? '  ·  ascension ' + run.ascension : ''), W / 2, yy + 22 * S, COL.dim, fpx(12), 'center');
    text('+' + (info.ashes || 0) + ' ashes', W / 2, yy + 44 * S, COL.ember, fpx(13), 'center');
    const m = meta();
    if (m && m.maxAscension) text('ASCENSION ' + m.maxAscension + ' UNLOCKED · ' + ((HM.Lore && HM.Lore.victory && HM.Lore.victory.ascension) || ''), W / 2, yy + 66 * S, COL.gold, fpx(11), 'center');
    button('v:title', W / 2 - 80 * S, yy + 88 * S, 160 * S, 26 * S, 'return to title', () => toTitle()).def = true;
    ctx.globalAlpha = 1;
  }

  // ======================================================================= STORY LAYER (DESIGN §9)
  // Tutorial keycap prompts, the dialogue box, act cards, skill-name flashes, the Moves reference, remnant NPCs
  // and the prologue flow. While a dialogue or an act card is open, player verbs are suppressed: UI.update runs
  // before the game update, so it strips verb presses + the input buffer and parks `Input.down` for that one
  // synchronous frame (restored at the top of UI.draw / the next UI.update).
  const RUN_STATES = { play: 1, pause: 1, inventory: 1, note: 1, shop: 1, boon: 1 };
  const FLASH_SLOTS = { heavy: 1, skill1: 1, skill2: 1, ult: 1 };
  const VERBS = ['up', 'down', 'left', 'right', 'attack', 'heavy', 'dodge', 'skill1', 'skill2', 'ult', 'interact', 'potion1', 'potion2', 'inventory', 'map'];
  const PROMPT_FADE = 0.35, DLG_CPS = 46, CARD_CPS = 38, CARD_FADE = 0.45, CARD_HOLD = 3.2, SKILL_FLASH_USES = 3;
  const TUT_COL = '#7fd6c0';

  function inPrologue() { const f = G() && G().floor; return !!(f && f.isPrologue) || !!(HM.Tutorial && HM.Tutorial.active); }
  function skipPrologue() {
    const Gm = G();
    if (HM.Tutorial && typeof HM.Tutorial.skip === 'function') { try { HM.Tutorial.skip(); } catch (e) { console.error('[UI] Tutorial.skip', e); } }
    else {
      const m = meta(); if (m) { m.prologueDone = true; if (HM.Save.write) HM.Save.write(); }
      if (Gm && Gm.run) Gm.enterFloor(1);
    }
    if (Gm && Gm.state === 'pause') Gm.setState('play');
  }
  // Act cards play on real runs. Quick-start test URLs (?hero=…) and headless harnesses skip them (they would freeze
  // staged shots / scripted input) unless ?actcard=1 (HM.params.actcard = '1'); ?actcard=0 turns them off everywhere.
  function autoActCards() {
    const P = HM.params || {};
    if (P.actcard === '1') return true; if (P.actcard === '0') return false;
    return !P.hero && !HM.headless;
  }

  function suppressPlayInput() {
    const I = HM.Input; if (!I) return;
    if (I.clearBuffer) I.clearBuffer();
    for (let k = 0; k < VERBS.length; k++) { const b = I.binds[VERBS[k]]; if (b) for (const c of b) I.pressed.delete(c); }
    if (!UI._downStash) { UI._downStash = I.down; I.down = new Set(); }
  }
  function restoreInput() {
    const st = UI._downStash; if (!st) return;
    const I = HM.Input; for (const c of I.down) st.add(c);
    I.down = st; UI._downStash = null;
  }

  // ---------------------------------------------------------------- per-frame (play) — returns true when it ate the frame's input
  function updateOverlays() {
    const I = HM.Input;
    if (UI.card) {
      const c = UI.card;
      const any = I.pressed.size > 0;
      suppressPlayInput(); swallowKeys(); swallowMouse();
      if (c.out === null && any && c.t > 0.35) closeActCard(true);
      return true;
    }
    if (UI.dlg) {
      const d = UI.dlg;
      const adv = I.pressed.has('Enter') || I.pressed.has('NumpadEnter') || I.pressed.has('Space') || I.pressed.has('Mouse0') || I.wasPressed('interact');
      suppressPlayInput(); // strips verbs (incl. map/inventory); Esc still reaches updatePlayInput → pause
      if (adv && d.t > 0.12) advanceDialogue();
      return false;
    }
    return false;
  }
  function tickStory(dt) {
    const st = G() && G().state;
    if (UI.prompts.length) {
      for (const p of UI.prompts) { p.t += dt; if (p.out !== null) p.out += dt; }
      UI.prompts = UI.prompts.filter((p) => p.out === null || p.out < PROMPT_FADE);
    }
    if (st === 'play') {
      if (UI.dlg) { UI.dlg.t += dt; UI.dlg.lt += dt; }
      if (UI.card) {
        const c = UI.card; c.t += dt;
        if (c.out !== null) { c.out += dt; if (c.out >= CARD_FADE) finishActCard(true); }
        else if (c.t > c.total + CARD_HOLD) closeActCard(true);
      }
    }
    if (UI._dlgFade) { UI._dlgFade.t += dt; if (UI._dlgFade.t > 0.25) UI._dlgFade = null; }
    if (UI.skillFlash) { UI.skillFlash.t += dt; if (UI.skillFlash.t >= UI.skillFlash.dur) UI.skillFlash = null; }
  }
  function drawStoryOverlays() {
    drawSkillFlash();
    if (!UI.card) { drawPrompts(); drawDialogue(); }
  }

  // ---------------------------------------------------------------- tutorial prompts
  function tutPrompt(id, o) {
    id = String(id === undefined || id === null ? 'prompt' : id);
    let p = UI.prompts.find((q) => q.id === id);
    if (!p) { p = { id, t: 0, out: null }; UI.prompts.push(p); if (UI.prompts.length > 4) UI.prompts.shift(); }
    else if (p.out !== null) { p.t = (1 - clamp01(p.out / PROMPT_FADE)) * 0.3; p.out = null; } // fade back in from where it was
    p.keys = Array.isArray(o.keys) ? o.keys.slice() : o.keys ? [String(o.keys)] : [];
    p.text = o.text !== undefined && o.text !== null ? String(o.text) : '';
    p.sub = o.sub !== undefined && o.sub !== null ? String(o.sub) : '';
    p.pos = o.pos === 'center' ? 'center' : 'bottom';
    return p;
  }
  function clearTutPrompt(id) {
    const all = id === undefined || id === null || id === '*';
    for (const p of UI.prompts) if ((all || p.id === String(id)) && p.out === null) p.out = 0;
  }
  const isCluster = (keys) => keys.indexOf('up') >= 0 && keys.indexOf('down') >= 0 && keys.indexOf('left') >= 0 && keys.indexOf('right') >= 0;
  const keyLabel = (a) => (HM.Input && HM.Input.binds && HM.Input.binds[a] ? HM.Input.actionLabel(a) : String(a).toUpperCase());
  function keycapW(label, ks) { return Math.max(ks, tw(label, fpx(label.length > 3 ? 10 : 12)) + 12 * S); }
  // a keycap in the hotbar's style: black cap, 1px light border, a darker lip; lit (white) while held
  function keycap(x, y, label, ks, lit) {
    const px = fpx(label.length > 3 ? 10 : ks < 20 * S ? 10 : 12), w = keycapW(label, ks);
    fill(x, y, w, ks, lit ? '#ececec' : '#0a0a0a'); box(x, y, w, ks, lit ? '#ffffff' : '#d4d4d4');
    fill(x + 1, y + ks - 3, w - 2, 2, lit ? '#9a9a9a' : '#3c3c3c');
    text(label, x + w / 2, y + ks / 2 - 1, lit ? '#000' : '#ffffff', px, 'center', { bold: true });
    return w;
  }
  // keys group: WASD (all four move actions) draws as an inverted-T cluster; others sit side by side
  function keysSize(keys, ks) {
    if (!keys.length) return [0, 0];
    const gap = 4 * S; let w = 0, h = ks;
    const rest = isCluster(keys) ? keys.filter((k) => k !== 'up' && k !== 'down' && k !== 'left' && k !== 'right') : keys;
    if (isCluster(keys)) { const c = Math.round(ks * 0.8); w = 3 * c + 2 * 3 * S; h = 2 * c + 3 * S; }
    for (const k of rest) w += (w ? gap * 2 : 0) + keycapW(keyLabel(k), ks);
    return [w, h];
  }
  function drawKeys(keys, x, cy, ks) {
    const I = HM.Input; let cx = x; const gap = 4 * S;
    const lit = (a) => !!(I && I.binds && I.binds[a] && I.isDown(a));
    let rest = keys;
    if (isCluster(keys)) {
      const c = Math.round(ks * 0.8), g = 3 * S, top = cy - c - g / 2;
      keycap(cx + c + g, top, keyLabel('up'), c, lit('up'));
      keycap(cx, top + c + g, keyLabel('left'), c, lit('left'));
      keycap(cx + c + g, top + c + g, keyLabel('down'), c, lit('down'));
      keycap(cx + 2 * (c + g), top + c + g, keyLabel('right'), c, lit('right'));
      cx += 3 * c + 2 * g;
      rest = keys.filter((k) => k !== 'up' && k !== 'down' && k !== 'left' && k !== 'right');
    }
    for (const k of rest) { if (cx > x) cx += gap * 2; cx += keycap(cx, cy - ks / 2, keyLabel(k), ks, lit(k)); }
    return cx - x;
  }
  function drawPrompts() {
    if (!UI.prompts.length || UI.dlg || UI.bigMap) return;
    const ks = Math.round(24 * S);
    let yb = (UI._hintTop !== null && UI._hintTop !== undefined ? UI._hintTop : (UI._hudTop || H - 70 * S) - 30 * S) - 10 * S;
    let yc = H / 2 + 104 * S;
    for (let i = UI.prompts.length - 1; i >= 0; i--) { // newest prompt sits closest to the action
      const p = UI.prompts[i];
      const a = clamp01(p.t / 0.3) * (p.out === null ? 1 : 1 - clamp01(p.out / PROMPT_FADE)); if (a <= 0.01) continue;
      const pxT = fpx(14), pxS = fpx(11);
      const [kw, kh] = keysSize(p.keys, ks);
      const tW = Math.max(tw(p.text, pxT), p.sub ? tw(p.sub, pxS) : 0);
      const h = Math.max(kh + 18 * S, p.sub ? 52 * S : 38 * S), w = 18 * S + kw + (kw ? 16 * S : 0) + tW + 20 * S;
      const rise = (1 - a) * 6 * S;
      let y; if (p.pos === 'center') { y = yc + rise; yc += h + 8 * S; } else { y = yb - h + rise; yb -= h + 8 * S; }
      const x = Math.round(W / 2 - w / 2);
      ctx.globalAlpha = a;
      fill(x, y, w, h, 'rgba(0,0,0,0.9)'); box(x, y, w, h, '#cfcfcf');
      fill(x + 1, y + 1, 3 * S, h - 2, TUT_COL);
      if (kw) drawKeys(p.keys, x + 18 * S, y + h / 2, ks);
      const tx = x + 18 * S + kw + (kw ? 16 * S : 0);
      if (p.sub) { text(p.text, tx, y + h / 2 - 9 * S, '#ffffff', pxT, 'left', { bold: true }); text(p.sub, tx, y + h / 2 + 11 * S, '#b9b3a8', pxS); }
      else text(p.text, tx, y + h / 2 + 0.5, '#ffffff', pxT, 'left', { bold: true });
    }
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- dialogue
  const PORTRAITS = {
    bmo: [' .-----. ', ' |[o o]| ', ' | \\_/ | ', ' |=+=.=| ', " '-----' ", '  /   \\  '],
    billy: ['  .-^-.  ', ' ( o o ) ', ' /)~~~(\\ ', ' \\|WWW|/ ', '  |   |  ', '  ~ ~ ~  '],
    pepbut: ['  .@@.   ', ' (@  @)  ', '  \\--/   ', '  /][\\   ', ' / || \\  ', '   ||    '],
    simon: [' /\\/\\/\\  ', ' |____|  ', ' (o-o)   ', ' /|WW|\\  ', '  |  |   ', '  ~~~~   '],
    herald: ['  ,^,^,  ', ' ( o o ) ', '  \\ = /  ', ' /|###|\\ ', '  |   |  ', '  /   \\  '],
    prismo: ['  .--.   ', ' ( ^^ )  ', ' |    |  ', ' |    |  ', ' |    |  ', "  `--'   "],
    default: ['  .---.  ', ' ( . . ) ', '  \\ - /  ', ' /|   |\\ ', '  |   |  ', '  /   \\  '],
  };
  const NPC_COL = { bmo: '#7fd6c0', billy: '#bcd6ff', pepbut: '#ff8a9a', simon: '#9fd2ff', herald: '#ffb050', prismo: '#d8b0ff', default: '#d8d8d8' };
  const GHOSTLY = { billy: 1, simon: 1 };
  function guessNpc(speaker) {
    const s = String(speaker || '').toLowerCase();
    if (/bmo/.test(s)) return 'bmo'; if (/billy/.test(s)) return 'billy'; if (/pepper|butler/.test(s)) return 'pepbut';
    if (/simon/.test(s)) return 'simon'; if (/herald|flame king/.test(s)) return 'herald'; if (/prismo/.test(s)) return 'prismo';
    return 'default';
  }
  function openDialogue(o) {
    const lines = (Array.isArray(o.lines) ? o.lines : o.lines ? [o.lines] : []).map(String).filter((l) => l.length);
    if (UI.dlg) closeDialogue(false);
    if (!lines.length) { if (o.onDone) try { o.onDone(); } catch (e) { console.error('[UI] dialogue onDone', e); } return null; }
    const npc = o.npc || o.portrait || guessNpc(o.speaker);
    UI.dlg = { speaker: String(o.speaker || ''), title: String(o.title || ''), lines, i: 0, t: 0, lt: 0, onDone: o.onDone || null, npc, color: o.color ? css(o.color) : NPC_COL[npc] || NPC_COL.default };
    UI.dialogueOpen = true; UI.bigMap = false; UI._dlgFade = null;
    sfx('note');
    return UI.dlg;
  }
  function advanceDialogue() {
    const d = UI.dlg; if (!d) return;
    const line = d.lines[d.i] || '';
    if (Math.floor(d.lt * DLG_CPS) < line.length) { d.lt = 999; return; } // first press: finish the line
    d.i++; d.lt = 0;
    if (d.i >= d.lines.length) { closeDialogue(true); sfx('ui_back'); } else sfx('ui_move');
  }
  function closeDialogue(callDone) {
    const d = UI.dlg; if (!d) return;
    UI.dlg = null; UI.dialogueOpen = false;
    d.i = Math.min(d.i, d.lines.length - 1); d.lt = 999; UI._dlgFade = { d, t: 0 };
    if (callDone && d.onDone) { try { d.onDone(); } catch (e) { console.error('[UI] dialogue onDone', e); } }
  }
  function drawDialogue() {
    const d = UI.dlg || (UI._dlgFade && UI._dlgFade.d); if (!d) return;
    const a = clamp01(UI.dlg ? d.t / 0.2 : 1 - UI._dlgFade.t / 0.25); if (a <= 0.01) return;
    const w = Math.min(W - 40 * S, 740 * S), x = Math.round((W - w) / 2);
    const portW = 104 * S, tx = x + portW + 26 * S, tWid = x + w - 22 * S - tx;
    const pxT = fpx(13), maxC = Math.max(20, Math.floor(tWid / cw(pxT))), lh = 19 * S;
    if (d._maxC !== maxC) { d._maxC = maxC; d._maxL = 1; for (const l of d.lines) d._maxL = Math.max(d._maxL, wrap(l, maxC).length); }
    const h = Math.round(Math.max(124 * S, 62 * S + d._maxL * lh + 26 * S));
    const y = Math.round((UI._hudTop || H - 80 * S) - h - 24 * S + (1 - a) * 8 * S);
    ctx.globalAlpha = a;
    fill(x, y, w, h, 'rgba(0,0,0,0.94)'); box(x, y, w, h, '#c8c8c8'); corners(x, y, w, h, '#6a6a6a');
    // portrait: a tiny ASCII bust in the speaker's colour (ghosts flicker)
    const bx = x + 12 * S, by = y + 12 * S, bh = h - 24 * S;
    fill(bx, by, portW, bh, '#030405'); box(bx, by, portW, bh, '#3e3e3e');
    if (ctx.createRadialGradient) {
      const g = ctx.createRadialGradient(bx + portW / 2, by + bh / 2, 2, bx + portW / 2, by + bh / 2, portW * 0.7);
      g.addColorStop(0, rgba(d.color, 0.16)); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fillRect(bx + 1, by + 1, portW - 2, bh - 2);
    }
    const art = PORTRAITS[d.npc] || PORTRAITS.default, ppx = fpx(11), plh = Math.min(13 * S, (bh - 8 * S) / art.length);
    const fl = GHOSTLY[d.npc] ? 0.62 + 0.38 * Math.abs(Math.sin(UI.t * 2.3) * Math.sin(UI.t * 0.9 + 1)) : 1;
    ctx.globalAlpha = a * fl;
    for (let i = 0; i < art.length; i++) text(art[i], bx + portW / 2, by + bh / 2 + (i - (art.length - 1) / 2) * plh, d.color, ppx, 'center', { bold: true });
    ctx.globalAlpha = a;
    // speaker · title
    text(d.speaker, tx, y + 21 * S, '#ffffff', fpx(13), 'left', { bold: true });
    if (d.title) text(d.title, tx + tw(d.speaker, fpx(13)) + 12 * S, y + 21 * S + 1, COL.dim, fpx(10));
    fill(tx, y + 35 * S, x + w - 22 * S - tx, 1, '#3a3a3a');
    // typewriter body
    const line = d.lines[d.i] || '';
    let n = Math.floor(d.lt * DLG_CPS), yy = y + 55 * S;
    for (const l of wrap(line, maxC)) { if (n <= 0) break; text(l.slice(0, n), tx, yy, '#ebe5d9', pxT); n -= l.length + 1; yy += lh; }
    // footer: page count + what the key does now
    const done = Math.floor(d.lt * DLG_CPS) >= line.length, last = d.i >= d.lines.length - 1, kl = HM.Input.actionLabel('interact');
    if (d.lines.length > 1) text((d.i + 1) + ' / ' + d.lines.length, tx, y + h - 14 * S, COL.faint, fpx(10));
    const ft = '[' + kl + '] ' + (done ? (last ? 'close' : 'next') : 'reveal');
    text(ft + (done ? (Math.floor(UI.t * 2.4) % 2 ? '  \u25bc' : '   ') : ''), x + w - 16 * S, y + h - 14 * S, done ? '#e0e0e0' : COL.dim, fpx(10), 'right');
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- act cards
  function openActCard(act, onDone, auto) {
    const Gm = G(), run = Gm ? Gm.run : null;
    const acts = (HM.Lore && HM.Lore.acts) || [];
    const A = acts[act];
    const done = () => { if (onDone) try { onDone(); } catch (e) { console.error('[UI] actCard onDone', e); } };
    if (!A) { done(); return false; }
    if (UI.card && UI.card.act === act) { if (onDone) UI.card.done.push(onDone); return true; }
    if (UI._cardRun === run && UI._cardActs && UI._cardActs[act]) { done(); return true; } // already shown this run
    if (UI.card) finishActCard(true);
    if (UI._cardRun !== run) { UI._cardRun = run; UI._cardActs = {}; }
    UI._cardActs[act] = true;
    const lines = (A.card || A.intro || []).slice(0, 3);
    let total = 0.9; for (const l of lines) total += l.length / CARD_CPS + 0.45;
    // horizon strip: three rows of the act's glyphs, built once per card
    const g = A.glyphs || '.', rows = [];
    for (let k = 0; k < 3; k++) { let s2 = ''; for (let i = 0; i < 420; i++) { const h2 = ((i * 2654435761) ^ (k * 40503 + act * 97)) >>> 0; s2 += h2 % 5 === 0 ? ' ' : g[(h2 >>> 8) % g.length]; } rows.push(s2); }
    UI.card = { act, A, lines, t: 0, out: null, total, rows, auto: !!auto, done: onDone ? [onDone] : [] };
    UI.actCardOpen = true; UI.bigMap = false;
    if (Gm) { if (Gm.timeScale !== 0) UI._tsSaved = Gm.timeScale; Gm.timeScale = 0; } // the world holds its breath under the card
    sfx('door');
    return true;
  }
  function closeActCard(callDone) {
    const c = UI.card; if (!c) return;
    if (callDone === false) { finishActCard(false); return; }
    if (c.out === null) { c.out = 0; sfx('ui_back'); }
  }
  function finishActCard(callDone) {
    const c = UI.card; if (!c) return;
    UI.card = null; UI.actCardOpen = false;
    const Gm = G(); if (Gm && Gm.timeScale === 0) Gm.timeScale = UI._tsSaved > 0 ? UI._tsSaved : 1;
    if (callDone) for (const fn of c.done) { try { fn(); } catch (e) { console.error('[UI] actCard onDone', e); } }
  }
  function drawActCard() {
    const c = UI.card, A = c.A, col = A.color || '#cccccc';
    const a = clamp01(c.t / 0.35) * (c.out === null ? 1 : 1 - clamp01(c.out / CARD_FADE));
    ctx.globalAlpha = a;
    fill(0, 0, W, H, 'rgba(1,1,2,0.965)');
    if (ctx.createRadialGradient) {
      const g = ctx.createRadialGradient(W / 2, H * 0.42, 10, W / 2, H * 0.42, Math.max(W, H) * 0.6);
      g.addColorStop(0, rgba(col, 0.07)); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    // drifting horizon of the act's glyphs
    const gpx = fpx(12), gcw = cw(gpx);
    setFont(gpx);
    for (let k = 0; k < 3; k++) {
      const off = (UI.t * (5 + k * 3)) % (gcw * 60);
      ctx.fillStyle = rgba(col, 0.2 - k * 0.055);
      ctx.fillText(c.rows[k], snap(-off), snap(H * 0.78 + k * 16 * S));
    }
    const cy = H * 0.34;
    const rule = M.easeOutCubic(clamp01((c.t - 0.1) / 0.9));
    spaced('ACT ' + (A.numeral || roman(c.act)), W / 2, cy - 44 * S, rgba(col, 0.95), fpx(13), 'center', 0.9);
    const npx = fpx(32), nw = tw(A.name, npx);
    text(A.name, W / 2, cy, '#f4efe6', npx, 'center', { bold: true, shadow: 'rgba(0,0,0,0.9)' });
    fill(W / 2 - nw / 2 - 24 * S - 64 * S * rule, cy, 64 * S * rule, 1, rgba(col, 0.7));
    fill(W / 2 + nw / 2 + 24 * S, cy, 64 * S * rule, 1, rgba(col, 0.7));
    text('-=<  *  >=-', W / 2, cy + 34 * S, '#57524b', fpx(11), 'center');
    let tt = c.t - 0.9, y = cy + 78 * S;
    for (const l of c.lines) {
      const parts = wrapBalanced(l, 76);
      let n = Math.floor(tt * CARD_CPS); if (n <= 0) break;
      for (const part of parts) { if (n > 0) text(part.slice(0, n), W / 2 - tw(part, fpx(14)) / 2, y, '#d9d2c4', fpx(14)); n -= part.length + 1; y += 22 * S; }
      y += 8 * S; tt -= l.length / CARD_CPS + 0.45;
    }
    if (c.t > 1.2) { ctx.globalAlpha = a * (0.45 + 0.25 * Math.sin(UI.t * 2.2)); text('any key', W / 2, H - 34 * S, COL.dim, fpx(10), 'center'); }
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- skill-name flash (first ~3 uses per profile)
  function flashSkill(name) {
    if (!name) return; name = String(name);
    const f0 = UI.skillFlash; if (f0 && f0.name === name && UI.t - f0.at < 0.8) return; // the hero and the auto-detector both call this
    const m = meta(), store = m ? (m.skillFlash = m.skillFlash || {}) : (UI._flashLocal = UI._flashLocal || {});
    const n = store[name] || 0; if (n >= SKILL_FLASH_USES) return;
    store[name] = n + 1;
    UI.skillFlash = { name, t: 0, dur: 1.5, at: UI.t };
  }
  function drawSkillFlash() {
    const f = UI.skillFlash, p = G().player; if (!f || !p || p.dead || !HM.R) return;
    const a = clamp01(Math.min(f.t / 0.12, (f.dur - f.t) / 0.45)); if (a <= 0.01) return;
    const q = HM.R.worldToScreen(p.x, p.y, (p.height || 60) + (p.z || 0) + 8);
    const y = q[1] - 30 * S - Math.min(1, f.t * 5) * 6 * S;
    const hc = heroInfo(p.heroId).color, col = hc ? mixHex(css(hc), '#ffffff', 0.45) : '#ffffff';
    const label = f.name.toUpperCase(), pxF = fpx(12), w = label.length * cw(pxF) * 1.35 + 16 * S;
    ctx.globalAlpha = a;
    fill(q[0] - w / 2, y - 10 * S, w, 20 * S, 'rgba(0,0,0,0.6)');
    fill(q[0] - w / 2, y + 9 * S, w, 1, rgba(col, 0.7));
    spaced(label, q[0], y + 0.5, col, pxF, 'center', 0.35);
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- move reference (Pause → Moves, hotbar tooltips)
  const MOVE_ORDER = ['move', 'dodge', 'attack', 'heavy', 'skill1', 'skill2', 'ult', 'passive', 'potion1', 'potion2', 'interact', 'map'];
  const fmtCd = (v) => (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + 's';
  function kitSkill(heroId, slot) {
    const h = HM.Heroes && HM.Heroes.list && HM.Heroes.list.find((x) => x.id === heroId);
    return (h && h.kit && h.kit.find((k) => k.slot === slot)) || null;
  }
  function moveInfo(p, id) {
    const L = (HM.Lore && HM.Lore.moves) || {}, C = L.common || {};
    const heroId = (p && p.heroId) || (G().run && G().run.heroId) || 'finn', Hm = L[heroId] || {};
    const temper = !!(p && p.def && p.def.temper) || heroId === 'fp';
    const c = (k) => C[k] || { name: k, desc: '', tips: [] };
    if (id === 'move') return { id, keys: ['up', 'left', 'down', 'right'], name: c('move').name, desc: c('move').desc, meta: '', tips: c('move').tips || [] };
    if (id === 'dodge') {
      const ch = p && p.dodgeMax > 1 ? ' · ' + p.dodgeMax + ' charges' : '';
      return { id, keys: ['dodge'], name: c('dodge').name, desc: c('dodge').desc, meta: 'recharge 0.75s' + ch, tips: c('dodge').tips || [] };
    }
    if (id === 'passive') {
      const ps = (p && p.passive) || kitSkill(heroId, 'passive') || { name: 'Passive', desc: '' };
      return { id, keys: [], cap: 'PASSIVE', name: ps.name, desc: ps.desc, meta: 'always on', tips: Hm.passive || [] };
    }
    if (id === 'potion1' || id === 'potion2') {
      const k = c(id), kind = id === 'potion1' ? 'pancake' : 'tonic', run = G().run;
      const have = run && run.consumables ? run.consumables[kind] || 0 : 0;
      return { id, keys: [id], name: k.name, desc: temper && k.descFp ? k.descFp : k.desc, meta: have + ' carried', tips: (temper && k.tipsFp) || k.tips || [] };
    }
    if (id === 'interact') return { id, keys: ['interact'], name: c('interact').name, desc: c('interact').desc, meta: 'contextual', tips: c('interact').tips || [] };
    if (id === 'map' || id === 'inventory') return { id, keys: ['map', 'inventory'], name: c('map').name, desc: c('map').desc, meta: '', tips: c('map').tips || [] };
    // attack / heavy / skill1 / skill2 / ult
    const sk = (p && p.skills && p.skills.find((s) => s.slot === id)) || kitSkill(heroId, id) || { name: id, desc: '' };
    const parts = [];
    if (sk.cost > 0) parts.push(temper ? '+' + sk.cost + ' Temper' : sk.cost + ' MP');
    if (sk.cd > 0) parts.push('cd ' + fmtCd(sk.cd));
    return { id, keys: [id], name: sk.name || id, desc: sk.desc || '', meta: parts.length ? parts.join(' · ') : 'free', tips: Hm[id] || [] };
  }
  function drawMoves() {
    const Gm = G(), p = Gm.player, run = Gm.run || {}, hi = heroInfo(run.heroId);
    header('MOVES', hi.name + (hi.title ? ' · ' + hi.title : '') + '  ·  every verb, what it costs, and what it combos with');
    const pw = Math.min(W - 32 * S, 1100 * S), px = Math.round((W - pw) / 2), py = Math.round(70 * S);
    const pad = 10 * S, gap = 6 * S, colW = (pw - pad * 2 - 12 * S) / 2, cardH = Math.round(66 * S);
    const nRows = Math.ceil(MOVE_ORDER.length / 2), synH = 78 * S;
    const ph = pad + nRows * (cardH + gap) - gap + 10 * S + synH + pad;
    panel(px, py, pw, ph, { bg: 'rgba(1,2,4,0.95)' });
    const hc = hi.color ? css(hi.color) : COL.ember;
    const pxD = fpx(10), descC = Math.max(24, Math.floor((colW - 96 * S) / cw(pxD)));
    MOVE_ORDER.forEach((mid, i) => {
      const mi = moveInfo(p, mid), col = i % 2, row = Math.floor(i / 2);
      const x = px + pad + col * (colW + 12 * S), y = py + pad + row * (cardH + gap), id = 'mv:' + mid, f = isFocus(id);
      fill(x, y, colW, cardH, f ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.55)'); box(x, y, colW, cardH, f ? COL.hiBorder : '#454545');
      if (f) fill(x + 1, y + 1, 2 * S, cardH - 2, hc);
      // keycaps column
      const kx = x + 10 * S, kcol = 78 * S;
      if (mi.keys.length) {
        const ks = Math.round((mid === 'move' ? 19 : 22) * S);
        if (mid === 'map') { keycap(kx, y + 8 * S, keyLabel('map'), ks, false); keycap(kx, y + 12 * S + ks, keyLabel('inventory'), ks, false); }
        else drawKeys(mi.keys, kx, y + cardH / 2, ks);
      } else { box(kx, y + cardH / 2 - 11 * S, 58 * S, 22 * S, '#5a5a5a'); text(mi.cap || '', kx + 29 * S, y + cardH / 2, COL.dim, fpx(9), 'center'); }
      const tx = x + 10 * S + kcol;
      text(mi.name, tx, y + 13 * S, f ? '#ffffff' : '#f0f0f0', fpx(12), 'left', { bold: true });
      if (mi.meta) text(mi.meta, x + colW - 10 * S, y + 13 * S, COL.dim, fpx(10), 'right');
      const dl = wrap(mi.desc, descC);
      for (let k = 0; k < Math.min(2, dl.length); k++) text(k === 1 && dl.length > 2 ? dl[1].replace(/\s*\S*$/, '') + '\u2026' : dl[k], tx, y + 29 * S + k * 13 * S, '#bdbab4', pxD);
      if (mi.tips && mi.tips[0]) {
        const tp = mi.tips[f && mi.tips[1] && Math.floor(UI.t / 3.5) % 2 ? 1 : 0], tl = wrap(tp, descC - 2);
        text('\u203a ' + tl[0] + (tl.length > 1 ? '\u2026' : ''), tx, y + cardH - 11 * S, '#cdb57c', pxD);
      }
      hit(id, x, y, colW, cardH, { focusable: true, act: () => {} });
    });
    // synergies (expression space): this hero's combos + the world's rules
    const L = (HM.Lore && HM.Lore.moves) || {}, Hm = L[run.heroId] || {};
    const sy = py + pad + nRows * (cardH + gap) - gap + 10 * S, sx = px + pad, sw = pw - pad * 2;
    box(sx, sy, sw, synH, '#3c3c3c');
    spaced('COMBOS & SYNERGIES', sx + 10 * S, sy + 13 * S, COL.dim, fpx(10), 'left', 0.45);
    const left = Hm.synergies || [], right = L.synergies || [], half = (sw - 30 * S) / 2, sc = Math.floor(half / cw(pxD)) - 2;
    left.slice(0, 3).forEach((l, k) => { text('+', sx + 10 * S, sy + 30 * S + k * 15 * S, hc, pxD, 'left', { bold: true }); text(wrap(l, sc)[0], sx + 24 * S, sy + 30 * S + k * 15 * S, '#d6d0c4', pxD); });
    right.slice(0, 3).forEach((l, k) => { text('*', sx + 20 * S + half, sy + 30 * S + k * 15 * S, COL.ember, pxD, 'left', { bold: true }); text(wrap(l, sc)[0], sx + 34 * S + half, sy + 30 * S + k * 15 * S, '#bcb6aa', pxD); });
    button('mv:back', W / 2 - 60 * S, py + ph + 10 * S, 120 * S, 24 * S, 'back', () => { UI.pauseSub = null; UI.focus = 'p:moves'; });
    footerHint('esc back  ·  hover a hotbar slot in play for the same notes');
  }
  // hotbar hover tooltip — the same notes as the Moves page
  function drawMoveTip(mi, cx, bottom) {
    const pxB = fpx(10), maxC = 48, lines = [];
    for (const l of wrap(mi.desc, maxC)) lines.push([l, '#c8c8c8']);
    for (const tp of (mi.tips || []).slice(0, 2)) wrap(tp, maxC - 2).forEach((l, k) => lines.push([(k ? '  ' : '\u203a ') + l, '#cdb57c']));
    const w = Math.max(tw(mi.name, fpx(11)) + tw(mi.meta || '', pxB) + 40 * S, maxC * cw(pxB) + 22 * S), h = 30 * S + lines.length * 14 * S + 6 * S;
    const x = M.clamp(cx - w / 2, 6, W - w - 6), y = bottom - h;
    panel(x, y, w, h, { bg: 'rgba(0,0,0,0.95)' });
    text(mi.name, x + 10 * S, y + 13 * S, '#ffffff', fpx(11), 'left', { bold: true });
    if (mi.meta) text(mi.meta, x + w - 10 * S, y + 13 * S, COL.dim, pxB, 'right');
    fill(x + 6 * S, y + 24 * S, w - 12 * S, 1, '#333');
    lines.forEach((l, i) => text(l[0], x + 10 * S, y + 35 * S + i * 14 * S, l[1], pxB));
  }

  // ---------------------------------------------------------------- remnant NPCs (story interactables)
  function remnantOf(o) { const R = HM.Lore && HM.Lore.remnants; return (R && o && R[o.npc]) || null; }
  HM.Interact = HM.Interact || {};
  HM.Interact.story = function (obj, player) {
    const r = remnantOf(obj); if (!r) return;
    obj.used = true; obj.talking = true;
    const cid = 'remnant_' + obj.npc;
    const isNew = HM.Save && HM.Save.unlockCodex ? !!HM.Save.unlockCodex(cid) : false;
    const run = G() && G().run;
    if (run) { run.codexThisRun = run.codexThisRun || []; if (run.codexThisRun.indexOf(cid) < 0) run.codexThisRun.push(cid); }
    if (HM.Events) HM.Events.emit('story', { npc: obj.npc, obj, player, isNew });
    UI.dialogue({ speaker: r.name, title: r.title, npc: obj.npc, color: r.color, lines: r.lines, onDone: () => {
      obj.talking = false; obj.talked = true;
      UI.toast((isNew ? 'REMNANT · ' : '') + r.name + (isNew ? '\nremembered in the codex' : ''), r.color || COL.witch, 3);
      if (HM.Events) HM.Events.emit('storyDone', { npc: obj.npc, obj, player });
    } });
  };

  // ======================================================================= HUD
  function resourceOf(p) {
    const r = p.resource;
    if (r && r.max) {
      const n = String(r.name || 'MP'); const short = /^mana$|^mp$/i.test(n) ? 'MP' : n.length <= 3 ? n.toUpperCase() : n.slice(0, 3).toUpperCase();
      return { short, name: n, value: r.value || 0, max: r.max || 1, color: r.color ? css(r.color) : COL.mp };
    }
    return { short: 'MP', name: 'Mana', value: p.mp || 0, max: p.maxMp || 1, color: COL.mp };
  }
  function drawHUD(frozen) {
    const Gm = HM.Game, p = Gm.player, run = Gm.run;
    drawPlayerFrame(p, run);
    drawHotbar(p, run);
    drawBossBars();
    drawTargetFrame();
    drawObjective();
    if (Gm.state === 'play' || Gm.state === 'pause') safe('minimap', () => drawMinimap(false));
    if (!frozen && !UI.dlg) { drawInteractPrompt(); drawExitArrow(); }
    if (UI.bigMap && Gm.state === 'play') safe('bigmap', () => drawMinimap(true));
    UI._hintTop = null;
    if (UI.hint && Gm.state === 'play' && !UI.dlg && !UI.card) safe('hint', drawHint);
  }
  function drawHint() {
    const h = UI.hint, a = clamp01(Math.min(h.t / 0.35, (h.dur - h.t) / 0.6)); if (a <= 0) return;
    const pxH = fpx(11), w = tw(h.text, pxH) + 28 * S, hh = 22 * S;
    const x = W / 2 - w / 2, y = (UI._hudTop || H - 90 * S) - hh - 30 * S - (1 - a) * 6 * S;
    ctx.globalAlpha = a; UI._hintTop = y;
    fill(x, y, w, hh, 'rgba(0,0,0,0.86)'); box(x, y, w, hh, '#b8b8b8');
    fill(x + 1, y + 1, 3 * S, hh - 2, COL.gold);
    text(h.text, W / 2 + 2 * S, y + hh / 2 + 0.5, '#f0ead8', pxH, 'center');
    ctx.globalAlpha = 1;
  }

  // ======================================================================= minimap (DESIGN §8)
  // Terrain is baked once per floor into a tiny image (downsampled from World.groundAt / isWall); a fog-of-war mask is
  // revealed around the hero as they explore (per floor, not saved). Markers are drawn live on top.
  const MAP = { F: null, img: null, fog: null, fctx: null, rev: null, gw: 0, gh: 0, cs: 40, mw: 0, mh: 0, lx: -1e9, ly: -1e9 };
  const MAP_PAL = {
    grass: { ground: [24, 44, 28], stone: [40, 48, 62], road: [44, 44, 46], pool: [30, 36, 34], crack: [40, 40, 40], water: [14, 30, 62], wall: [70, 84, 72], void: [4, 4, 6] },
    candy: { ground: [52, 28, 36], stone: [64, 46, 54], road: [70, 52, 58], pool: [82, 30, 56], crack: [60, 40, 46], water: [40, 20, 30], wall: [110, 78, 88], void: [4, 3, 4] },
    ice: { ground: [46, 56, 74], stone: [60, 68, 84], road: [56, 64, 80], pool: [70, 96, 128], crack: [60, 70, 86], water: [18, 34, 70], wall: [120, 134, 156], void: [3, 4, 8] },
    fire: { ground: [26, 20, 24], stone: [40, 30, 36], road: [36, 28, 30], pool: [40, 30, 30], crack: [150, 60, 20], water: [170, 70, 16], wall: [70, 56, 52], void: [6, 3, 2] },
    well: { ground: [36, 38, 32], stone: [30, 34, 34], road: [40, 42, 36], pool: [24, 50, 30], crack: [40, 110, 56], water: [6, 14, 8], wall: [80, 86, 76], void: [2, 5, 3] },
  };
  function mapBuild(F) {
    const Wd = HM.World; MAP.F = F; MAP.lx = MAP.ly = -1e9;
    const TILT = HM.cfg.TILT, mw = 200, mh = Math.max(40, Math.round(mw * (F.h * TILT) / F.w));
    MAP.mw = mw; MAP.mh = mh;
    MAP.gw = Math.ceil(F.w / MAP.cs); MAP.gh = Math.ceil(F.h / MAP.cs); MAP.rev = new Uint8Array(MAP.gw * MAP.gh);
    MAP.img = null; MAP.fog = null; MAP.fctx = null;
    if (typeof document === 'undefined' || !document.createElement) return;
    const c = document.createElement('canvas'); c.width = mw; c.height = mh;
    const g = c.getContext && c.getContext('2d'); if (!g) return;
    const id = g.createImageData ? g.createImageData(mw, mh) : g.getImageData ? g.getImageData(0, 0, mw, mh) : null;
    if (id && id.data && Wd && Wd.groundAt) {
      const P = MAP_PAL[F.biomeId] || MAP_PAL.grass, d = id.data;
      for (let j = 0; j < mh; j++) for (let i = 0; i < mw; i++) {
        const x = (i + 0.5) * F.w / mw, y = (j + 0.5) * F.h / mh;
        let k = Wd.groundAt(x, y); if (k !== 'wall' && Wd.isWall && Wd.isWall(x, y)) k = 'wall';
        const cc = P[k] || P.ground, q = (j * mw + i) * 4, n = ((i * 7 + j * 13) % 5) * 2; // faint dither
        d[q] = Math.min(255, cc[0] * 1.45 + n); d[q + 1] = Math.min(255, cc[1] * 1.45 + n); d[q + 2] = Math.min(255, cc[2] * 1.45 + n); d[q + 3] = 255;
      }
      if (g.putImageData) g.putImageData(id, 0, 0);
    }
    MAP.img = c;
    const fc = document.createElement('canvas'); fc.width = mw; fc.height = mh;
    const fg = fc.getContext && fc.getContext('2d');
    if (fg) { fg.fillStyle = '#000'; fg.fillRect(0, 0, mw, mh); MAP.fog = fc; MAP.fctx = fg; }
  }
  function mapReveal(x, y) {
    const F = MAP.F, R0 = 380, cs = MAP.cs;
    if (M.dist(x, y, MAP.lx, MAP.ly) < 14) return;
    MAP.lx = x; MAP.ly = y;
    const i0 = Math.max(0, Math.floor((x - R0) / cs)), i1 = Math.min(MAP.gw - 1, Math.floor((x + R0) / cs));
    const j0 = Math.max(0, Math.floor((y - R0) / cs)), j1 = Math.min(MAP.gh - 1, Math.floor((y + R0) / cs));
    const sx = MAP.mw / F.w, sy = MAP.mh / F.h;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * MAP.gw + i; if (MAP.rev[k]) continue;
      const cx = (i + 0.5) * cs, cy = (j + 0.5) * cs; if (M.dist(cx, cy, x, y) > R0) continue;
      MAP.rev[k] = 1;
      if (MAP.fctx && MAP.fctx.clearRect) MAP.fctx.clearRect(Math.floor(i * cs * sx), Math.floor(j * cs * sy), Math.ceil(cs * sx) + 1, Math.ceil(cs * sy) + 1);
    }
  }
  function mapSeen(x, y) { const i = Math.floor(x / MAP.cs), j = Math.floor(y / MAP.cs); return i >= 0 && j >= 0 && i < MAP.gw && j < MAP.gh && MAP.rev[j * MAP.gw + i] === 1; }
  function drawMinimap(big) {
    const Gm = HM.Game, F = Gm.floor, p = Gm.player; if (!F || !p) return;
    if (!big && setting('minimap', true) === false) return;
    if (MAP.F !== F) mapBuild(F);
    mapReveal(p.x, p.y);
    const ar = MAP.mh / MAP.mw;
    let w, h, x, y;
    if (big) { w = Math.min(W * 0.72, (H * 0.7) / ar); h = w * ar; x = (W - w) / 2; y = (H - h) / 2 - 10 * S; fill(0, 0, W, H, 'rgba(0,0,0,0.55)'); }
    else { w = Math.max(UI._objW || 230 * S, 200 * S); h = w * ar; x = W - 14 * S - w; y = (UI._objBottom || 82 * S) + 6 * S; }
    fill(x - 1, y - 1, w + 2, h + 2, 'rgba(0,0,0,0.92)');
    if (MAP.img && ctx.drawImage) {
      const sm = ctx.imageSmoothingEnabled; ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = big ? 0.95 : 0.85; ctx.drawImage(MAP.img, x, y, w, h);
      ctx.globalAlpha = 0.94; if (MAP.fog) ctx.drawImage(MAP.fog, x, y, w, h);
      ctx.globalAlpha = 1; ctx.imageSmoothingEnabled = sm;
    }
    box(x - 1, y - 1, w + 2, h + 2, '#8a8a8a');
    const kx = w / F.w, ky = h / F.h, dot = Math.max(2, Math.round(2 * S * (big ? 1.4 : 1)));
    const mark = (wx, wy, col, r) => { const mx = x + wx * kx, my = y + wy * ky; if (mx < x || my < y || mx > x + w || my > y + h) return; fill(Math.round(mx - r / 2), Math.round(my - r / 2), r, r, col); };
    // interactables (once seen)
    for (const o of F.interactables || []) {
      if (o.hidden) continue;
      if (!o._mapSeen) { if (mapSeen(o.x, o.y)) o._mapSeen = true; else continue; }
      let col = null, r = dot + 1;
      if (o.kind === 'portal') { col = F.exitOpen ? rgba('#66e0ff', 0.6 + 0.4 * Math.sin(UI.t * 5)) : '#3c7a8c'; r = dot + 3; }
      else if (o.kind === 'shrine') col = o.used || o.spent ? '#7a6a3a' : '#ffd84a';
      else if (o.kind === 'chest') col = o.used || o.open ? '#6a5a2a' : '#e8b33a';
      else if (o.kind === 'note') { if (o.used) continue; col = '#f0f0f0'; }
      else if (o.kind === 'merchant') col = '#6ee07a';
      else if (o.kind === 'story') col = o.used ? '#6a5a80' : rgba('#c7a8ff', 0.7 + 0.3 * Math.sin(UI.t * 3));
      if (col) mark(o.x, o.y, col, r);
    }
    // monsters: only those near the hero (what you could plausibly see); the boss always once engaged
    for (const a of Gm.entities) {
      if (a.dead || a.team !== 1 || a.hidden) continue;
      if (a.defId === 'snail') { if (!a._mapSeen) { if (M.dist(a.x, a.y, p.x, p.y) < 240) a._mapSeen = true; else continue; } mark(a.x, a.y, '#ff9ad0', Math.max(2, dot - 1)); continue; }
      const d = M.dist(a.x, a.y, p.x, p.y);
      if (a.isBoss) { if (a.engaged || d < 700) mark(a.x, a.y, '#ff3b2a', dot + 4); continue; }
      if (d > 560) continue;
      mark(a.x, a.y, a.isElite ? '#ff9a3a' : '#e0453a', a.isElite ? dot + 1 : dot);
    }
    // hero arrow (screen-projected facing)
    const px = x + p.x * kx, py = y + p.y * ky, fa = Math.atan2(Math.sin(p.facing || 0) * HM.cfg.TILT, Math.cos(p.facing || 0)), L = (big ? 9 : 6) * S;
    if (ctx.beginPath) {
      ctx.fillStyle = '#ffffff'; ctx.beginPath();
      ctx.moveTo(px + Math.cos(fa) * L, py + Math.sin(fa) * L);
      ctx.lineTo(px + Math.cos(fa + 2.5) * L * 0.7, py + Math.sin(fa + 2.5) * L * 0.7);
      ctx.lineTo(px + Math.cos(fa - 2.5) * L * 0.7, py + Math.sin(fa - 2.5) * L * 0.7);
      ctx.closePath(); ctx.fill();
    }
    if (big) {
      spaced(((F.actName || '') + '  ·  floor ' + ((Gm.run && Gm.run.floorIndex) || F.index || 1)).toUpperCase(), x + w / 2, y - 14 * S, COL.dim, fpx(10), 'center', 0.4);
      text(HM.Input.actionLabel('map') + ' / ESC close   ·   white you   ·   red foes   ·   cyan door   ·   gold chest   ·   yellow shrine   ·   green goose   ·   violet remnant', x + w / 2, y + h + 16 * S, COL.faint, fpx(10), 'center');
    } else {
      UI._objBottom = y + h + 1; // toasts stack below the minimap
      text(HM.Input.actionLabel('map'), x + w - 4 * S, y + h - 7 * S, '#6a6a6a', fpx(9), 'right');
    }
  }
  function drawPlayerFrame(p, run) {
    const x = 14 * S, y = 14 * S, w = 272 * S, h = 84 * S;
    fill(x, y, w, h, 'rgba(0,0,0,0.95)'); box(x, y, w, h, '#bdbdbd');
    // tiny figure portrait
    drawFigure(run.heroId, x + 30 * S, y + h - 7 * S, 17, 4.2 * S, { still: true });
    const hi = heroInfo(run.heroId);
    const tx = x + 62 * S;
    text(hi.name, tx, y + 14 * S, '#f2f2f2', fpx(12), 'left', { bold: true });
    if (run.boonPoints > 0) text('◆' + run.boonPoints, x + w - 10 * S, y + 14 * S, COL.gold, fpx(10), 'right');
    const bw = 124 * S, bh = 11 * S;
    const hp01 = p.maxHp ? p.hp / p.maxHp : 0;
    const low = hp01 < 0.3 && !p.dead;
    const hpCol = low ? (Math.sin(UI.t * 8) > 0 ? COL.hpLow : '#c23a2c') : COL.hp;
    text('HP', tx, y + 33 * S, COL.text, fpx(11));
    tickBar(tx + 24 * S, y + 33 * S - bh / 2, bw, bh, hp01, hpCol, { ghost: p.maxHp ? ghostOf(p) / p.maxHp : 0, ghostColor: '#a03020' });
    text(Math.ceil(Math.max(0, p.hp)) + '/' + Math.ceil(p.maxHp), tx + 24 * S + bw + 8 * S, y + 33 * S, low ? COL.hpLow : COL.text, fpx(11));
    const rs = resourceOf(p);
    const wild = !!p.wildfire;
    const rsCol = wild ? mixHex('#ffd27a', '#ffffff', 0.5 + 0.5 * Math.sin(UI.t * 14)) : rs.color;
    text(wild ? 'WLD' : rs.short, tx, y + 50 * S, wild ? '#ffcf6a' : COL.text, fpx(11));
    tickBar(tx + 24 * S, y + 50 * S - bh / 2, bw, bh, wild && p.wildfireDur ? p.wildfireT / p.wildfireDur : rs.value / rs.max, rsCol, { border: wild ? '#ffb050' : undefined });
    text(Math.floor(rs.value) + '/' + Math.floor(rs.max), tx + 24 * S + bw + 8 * S, y + 50 * S, COL.text, fpx(11));
    const gp = clamp01(1 - (UI.t - UI.goldPulse) / 0.6);
    const lw = text('LV ' + (run.level || 1) + ' · ', tx, y + 68 * S, COL.text, fpx(11));
    text((run.gold || 0) + 'g', tx + lw, y + 68 * S, gp > 0 ? mixHex(COL.text, COL.gold, gp) : COL.text, fpx(11));
    if (UI.t - (UI._goldT || -9) < 1.5 && UI.goldGain) text('+' + UI.goldGain, tx + lw + tw((run.gold || 0) + 'g', fpx(11)) + 6 * S, y + 68 * S - gp * 3 * S, rgba(COL.gold, clamp01(1.5 - (UI.t - UI._goldT))), fpx(10));
    // statuses below the frame
    let sx = x, sy = y + h + 6 * S;
    for (const s of p.statuses || []) {
      const g = STATUS_GLYPH[s.id] || ['?', '#ccc']; const sw = 22 * S, sh = 22 * S;
      fill(sx, sy, sw, sh, 'rgba(0,0,0,0.85)'); box(sx, sy, sw, sh, rgba(g[1], 0.8));
      text(g[0], sx + sw / 2, sy + sh / 2 - 1, g[1], fpx(12), 'center');
      if (s.stacks > 1) text(String(s.stacks), sx + sw - 2 * S, sy + sh - 5 * S, '#fff', fpx(8), 'right');
      if (s.dur) fill(sx + 1, sy + sh - 2, (sw - 2) * clamp01(1 - s.t / s.dur), 1, g[1]);
      sx += sw + 4 * S;
    }
  }
  const HOTBAR = [
    { a: 'attack', slot: 'attack', icon: '/' }, { a: 'heavy', slot: 'heavy', icon: '\\\\' }, { a: 'skill1', slot: 'skill1', icon: '*' },
    { a: 'skill2', slot: 'skill2', icon: '@' }, { a: 'ult', slot: 'ult', icon: '!!' }, { a: 'dodge', slot: 'dodge', icon: '))' },
    { a: 'potion1', pot: 'pancake', icon: '=@=' }, { a: 'potion2', pot: 'tonic', icon: '[~]' }, { a: 'interact', icon: 'F', special: 'interact' },
    { a: 'inventory', icon: '[#]', special: 'bag' },
  ];
  function drawHotbar(p, run) {
    const n = HOTBAR.length, sw = Math.round(52 * S), sh = Math.round(44 * S);
    const w = n * sw, x0 = Math.round(W / 2 - w / 2), y0 = Math.round(H - sh - 12 * S);
    // XP bar above
    const xpN = HM.Game.xpToNext ? HM.Game.xpToNext(run.level || 1) : 100;
    const xb = y0 - 16 * S; UI._hudTop = xb;
    const xf = clamp01(1 - (UI.t - (UI.xpFlash || -9)) / 0.8);
    fill(x0, xb, w, 13 * S, '#000');
    tickBar(x0, xb, w, 13 * S, (run.xp || 0) / xpN, xf > 0 ? mixHex(COL.xp, '#fff6d0', xf) : COL.xp, { border: '#a9a9a9', pad: 2, step: 0.8 });
    const xs = 'LV ' + (run.level || 1) + ' · ' + Math.floor(run.xp || 0) + ' / ' + xpN + ' XP';
    const xtw = tw(xs, fpx(10));
    fill(x0 + w / 2 - xtw / 2 - 6 * S, xb + 2, xtw + 12 * S, 13 * S - 4, 'rgba(0,0,0,0.75)');
    text(xs, x0 + w / 2, xb + 6.5 * S + 0.5, '#f0e8d8', fpx(10), 'center');
    // slots
    fill(x0, y0, w, sh, 'rgba(0,0,0,0.95)');
    const skills = p.skills || [];
    const rs = resourceOf(p);
    let tipSlot = null;
    HOTBAR.forEach((hb, i) => {
      const x = x0 + i * sw;
      box(x, y0, sw + 1, sh, '#b0b0b0');
      fill(x, y0 + 15 * S, sw, 1, '#6a6a6a');
      const label = HM.Input.actionLabel(hb.a);
      text(label, x + sw / 2, y0 + 8 * S, '#e8e8e8', fpx(label.length > 3 ? 9 : 11), 'center');
      const bodyY = y0 + 16 * S, bodyH = sh - 17 * S;
      let icon = hb.icon, col = '#d8d8d8', cdFrac = 0, cdLeft = 0, starved = false, count = null, ready = false, name = '';
      const sk = hb.slot ? skills.find((s) => s.slot === hb.slot || s.action === hb.a) : null;
      if (sk) {
        icon = sk.icon || icon; name = sk.name || '';
        col = sk.color ? css(sk.color) : col;
        if (sk.cd > 0 && sk.cdLeft > 0) { cdFrac = clamp01(sk.cdLeft / sk.cd); cdLeft = sk.cdLeft; }
        if (sk.cost > 0 && sk.costType !== 'temper' && sk.costType !== 'none') { const have = sk.costType === 'hp' ? p.hp : rs.value; starved = have < sk.cost; }
        if (hb.slot === 'ult') ready = cdFrac <= 0 && !starved;
      } else if (hb.slot === 'dodge') {
        name = 'Dodge roll';
        if (p.dodgeCd01 !== undefined) { cdFrac = clamp01(p.dodgeCd01); cdLeft = p.dodgeRecharge || 0; if (p.dodgeMax > 1) count = p.dodgeCharges || 0; }
        else { const cd = p.dodgeCd || 0; UI._dodgeMax = Math.max(UI._dodgeMax || 0.5, cd); if (cd > 0) { cdFrac = clamp01(cd / UI._dodgeMax); cdLeft = cd; } }
        if (count !== null && count > 0) cdFrac = 0;
      } else if (hb.slot) { if (!skills.length) col = '#8a8a8a'; }
      if (hb.pot) {
        count = (run.consumables && run.consumables[hb.pot]) || 0; name = hb.pot === 'pancake' ? 'Bacon Pancake' : 'Tonic';
        col = hb.pot === 'pancake' ? '#f0b880' : '#8eb2ff';
        const cd = p.potionCd || 0; UI._potMax = Math.max(UI._potMax || 0.9, cd);
        if (cd > 0) { cdFrac = clamp01(cd / UI._potMax); cdLeft = cd; }
        if (!count) starved = true;
      }
      if (hb.special === 'interact') { const it = HM.Game.interactTarget; col = it ? '#ffffff' : '#555'; ready = !!it; name = it ? interactLabel(it) : 'Interact'; }
      if (hb.special === 'bag') { const b = (run.inventory && run.inventory.bag) || []; count = b.length; col = '#a8a8a8'; name = 'Inventory'; }
      // press flash
      const pressed = HM.Input.isDown(hb.a);
      if (pressed && !hb.special) fill(x + 1, bodyY, sw - 1, bodyH, 'rgba(255,255,255,0.12)');
      if (ready && hb.slot === 'ult') { const pu = 0.5 + 0.5 * Math.sin(UI.t * 5); box(x + 2, bodyY + 1, sw - 3, bodyH - 2, rgba(COL.ember, 0.4 + 0.5 * pu)); }
      const iconCol = starved ? '#5a6aa8' : cdFrac > 0 ? '#777' : col;
      text(icon, x + sw / 2, bodyY + bodyH / 2, iconCol, fpx(icon.length > 2 ? 11 : 14), 'center', { bold: true });
      if (starved && !hb.pot) fill(x + 1, bodyY, sw - 1, bodyH, 'rgba(30,50,140,0.28)');
      if (cdFrac > 0) {
        ctx.save(); ctx.beginPath(); ctx.rect(x + 1, bodyY, sw - 1, bodyH); ctx.clip();
        const cx = x + sw / 2, cy = bodyY + bodyH / 2, rr = sw;
        ctx.fillStyle = 'rgba(0,0,0,0.68)'; ctx.beginPath(); ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, rr, -Math.PI / 2, -Math.PI / 2 + TAU * cdFrac, false); ctx.closePath(); ctx.fill();
        ctx.restore(); curFont = '';
        text(cdLeft >= 1 ? String(Math.ceil(cdLeft)) : cdLeft.toFixed(1), x + sw / 2, bodyY + bodyH / 2, '#ffffff', fpx(11), 'center', { shadow: true });
      }
      if (count !== null) text(String(count), x + sw - 4 * S, y0 + sh - 7 * S, count || !hb.pot ? '#fff' : COL.bad, fpx(10), 'right', { shadow: true });
      const mx = HM.Input.mouse.sx, my = HM.Input.mouse.sy;
      if (mx >= x && mx < x + sw && my >= y0 && my < y0 + sh) tipSlot = { sk, name, x, hb };
    });
    if (tipSlot && (tipSlot.sk || tipSlot.name)) {
      const mi = moveInfo(p, tipSlot.hb.a);
      if (tipSlot.hb.special === 'interact' && HM.Game.interactTarget) mi.meta = interactLabel(HM.Game.interactTarget);
      drawMoveTip(mi, tipSlot.x + sw / 2, y0 - 22 * S);
    }
  }
  function drawBossBars() {
    const bosses = HM.Game.bossesAlive ? HM.Game.bossesAlive() : [];
    let y = 8 * S;
    for (const b of bosses.slice(0, 2)) {
      if (b.hidden || b.introT > 0 && b.hideBar) continue;
      const leftLim = 14 * S + 272 * S + 18 * S, rightLim = W - 14 * S - (UI._objW || 260 * S) - 18 * S;
      const w = Math.max(220 * S, Math.min(720 * S, 2 * Math.min(W / 2 - leftLim, rightLim - W / 2))), x = W / 2 - w / 2, h = 12 * S;
      const name = b.displayName || b.name || 'Boss';
      const ph = b.phaseCount > 1 ? '  —  phase ' + (b.phase || 1) : '';
      // black backing like the reference's panels: the boss name and numbers must read over a busy arena
      fill(x - 8 * S, y - 3 * S, w + 16 * S, 16 * S + h + 18 * S, 'rgba(0,0,0,0.72)');
      text(name + ph, W / 2, y + 7 * S, '#f2e6e0', fpx(12), 'center', { shadow: true, bold: true });
      const notches = []; if ((b.phaseCount || 3) > 1) { const pc = b.phaseCount || 3; for (let k = 1; k < pc; k++) notches.push(k / pc); }
      // first reveal: the bar fills left-to-right like a drawn breath
      UI._bossSeen = UI._bossSeen || new Map();
      if (!UI._bossSeen.has(b)) UI._bossSeen.set(b, UI.t);
      const rv = M.easeOutCubic(clamp01((UI.t - UI._bossSeen.get(b)) / 1.3));
      const f01 = b.maxHp ? b.hp / b.maxHp : 0;
      solidBar(x, y + 16 * S, w, h, Math.min(f01, rv), b.enraged ? '#ff3b1f' : COL.boss, { ghost: rv < 1 ? 0 : b.maxHp ? ghostOf(b) / b.maxHp : 0, notches });
      const bf = UI.bossFlash && UI.bossFlash.boss === b ? clamp01(1 - (UI.t - UI.bossFlash.t) / 1.8) : 0;
      if (bf > 0) {
        box(x - 2, y + 14 * S, w + 4, h + 4 * S, rgba('#ffd0b0', bf));
        if (UI.bossFlash.text) { ctx.globalAlpha = bf; spaced('-  ' + UI.bossFlash.text + '  -', W / 2, y + 16 * S + h + 22 * S, '#ffb090', fpx(12), 'center', 0.5); ctx.globalAlpha = 1; }
      }
      if (b.title) text(b.title, x + w, y + 16 * S + h + 8 * S, COL.dim, fpx(10), 'right', { shadow: true });
      text(Math.ceil(Math.max(0, b.hp)) + ' / ' + Math.ceil(b.maxHp), x, y + 16 * S + h + 8 * S, COL.dim, fpx(10), 'left', { shadow: true });
      y += 48 * S;
    }
    UI._bossBarsH = y;
  }
  function drawTargetFrame() {
    let t = UI.hoverEnemy;
    if (!t && UI.lastHit && !UI.lastHit.dead && UI.t - UI.lastHitT < 4) t = UI.lastHit;
    if (!t || t.isBoss || t.dead) return;
    const w = 250 * S, h = 40 * S, x = W / 2 - w / 2, y = (UI._bossBarsH || 8 * S) + 2 * S;
    fill(x, y, w, h, 'rgba(0,0,0,0.94)'); box(x, y, w, h, '#bdbdbd');
    const name = t.displayName || t.name || 'Foe';
    const s = name + '  ' + Math.ceil(Math.max(0, t.hp)) + '/' + Math.ceil(t.maxHp);
    text(s, W / 2, y + 13 * S, t.isElite ? COL.elite : '#f0f0f0', fpx(12), 'center', { bold: true });
    tickBar(x + 12 * S, y + 23 * S, w - 24 * S, 9 * S, t.maxHp ? t.hp / t.maxHp : 0, t.isElite ? COL.elite : '#ececec', { ghost: t.maxHp ? ghostOf(t) / t.maxHp : 0, ghostColor: '#8a3a2a', step: 0.8, pad: 2 });
    const aff = affixNames(t);
    if (aff) text(aff, W / 2, y + h + 9 * S, '#d9a35a', fpx(10), 'center', { shadow: true });
  }
  function affixNames(a) {
    if (!a.affixes || !a.affixes.length) return '';
    const T = HM.Enemies && HM.Enemies.AFFIXES;
    return a.affixes.map((x) => (typeof x === 'string' ? (T && T[x] && T[x].name) || x : x.name || x.id || '')).filter(Boolean).map((s) => s[0].toUpperCase() + s.slice(1)).join(' · ');
  }
  function drawObjective() {
    const Gm = HM.Game, f = Gm.floor, run = Gm.run; if (!f) return;
    const obj = HM.Lore && HM.Lore.objectiveText ? HM.Lore.objectiveText(f) : f.exitOpen ? 'The Dungeon Door is open' : 'Find the Dungeon Door';
    let sub;
    if (f.objectiveSub) sub = f.objectiveSub;
    else if (f.isPrologue && !f.exitOpen) sub = 'BMO is waiting at the Tree Fort';
    else if (f.exitOpen) sub = Gm.state === 'play' && Gm.interactTarget && Gm.interactTarget.kind === 'portal' ? 'press ' + HM.Input.actionLabel('interact') + ' to descend' : 'walk to the door · ' + HM.Input.actionLabel('interact') + ' to descend';
    else if (f.objective && f.objective.type === 'boss') sub = 'the way down opens when it falls';
    else { const n = Gm.enemiesAlive ? Gm.enemiesAlive() : 0; sub = n + ' foe' + (n === 1 ? '' : 's') + ' remain on this floor'; }
    const head = f.isPrologue ? 'PROLOGUE  ·  THE TREE FORT' : (f.actName || '').toUpperCase() + '  ·  FLOOR ' + (run.floorIndex || f.index || 1);
    const foot = fmtTime(run.time || 0) + '  ·  ' + (run.kills || 0) + ' slain';
    const pxO = fpx(11), w = Math.max(tw(obj, pxO) + 34 * S, tw(head, fpx(9)) * 1.45 + 24 * S, 230 * S), h = 68 * S;
    const x = W - 14 * S - w, y = 14 * S; UI._objW = w;
    fill(x, y, w, h, 'rgba(0,0,0,0.9)'); box(x, y, w, h, '#9a9a9a');
    spaced(head, x + 10 * S, y + 11 * S, COL.dim, fpx(9), 'left', 0.45);
    fill(x, y + 21 * S, w, 1, '#3a3a3a');
    const fl = clamp01(1 - (UI.t - (UI.objFlash || -9)) / 1.5);
    const col = f.exitOpen ? mixHex(COL.witch, '#ffffff', fl * 0.8) : '#ececec';
    text(f.exitOpen ? '>' : '◆', x + 12 * S, y + 33 * S, f.exitOpen ? COL.witch : COL.ember, pxO);
    text(obj, x + 26 * S, y + 33 * S, col, pxO);
    text(sub, x + 26 * S, y + 47 * S, COL.faint, fpx(10));
    text(foot, x + w - 10 * S, y + 59 * S, '#6a6a6a', fpx(9), 'right');
    if (fl > 0 && f.exitOpen) box(x - 1, y - 1, w + 2, h + 2, rgba(COL.witch, fl));
    UI._objBottom = y + h;
  }
  function interactLabel(t) {
    if (!t) return '';
    if (t.prompt) return typeof t.prompt === 'function' ? t.prompt() : t.prompt;
    const isPickup = HM.Game.pickups && HM.Game.pickups.indexOf(t) >= 0;
    if (isPickup) return 'Take ' + ((t.item && t.item.name) || t.label || t.kind);
    if (t.kind === 'story') { const r = remnantOf(t); return 'Speak with ' + (r ? r.name : 'the stranger'); }
    const L = { portal: 'Descend', chest: 'Open chest', shrine: 'Pray at the shrine', merchant: 'Trade with Choose Goose', note: 'Read the page' };
    return t.label && t.label !== t.kind ? t.label : L[t.kind] || t.label || 'Interact';
  }
  function drawInteractPrompt() {
    const Gm = HM.Game, t = Gm.interactTarget; if (!t || !HM.R) return;
    const isPickup = Gm.pickups && Gm.pickups.indexOf(t) >= 0;
    const [sx, sy0] = HM.R.worldToScreen(t.x, t.y, 0);
    const sy = sy0 + (isPickup ? 34 : 40) * S;
    const key = HM.Input.actionLabel('interact'), lab = interactLabel(t);
    const pxT = fpx(11), kw = tw(key, pxT) + 10 * S, lw = tw(lab, pxT);
    const w = kw + lw + 18 * S, h = 20 * S;
    const x = M.clamp(sx - w / 2, 6, W - w - 6), y = M.clamp(sy - Math.sin(UI.t * 4) * 1.5 * S, 6, (UI._hudTop || H) - h - 8 * S);
    fill(x, y, w, h, 'rgba(0,0,0,0.88)'); box(x, y, w, h, '#d0d0d0');
    fill(x + 4 * S, y + 3 * S, kw, h - 6 * S, '#e8e8e8'); text(key, x + 4 * S + kw / 2, y + h / 2 + 0.5, '#000', pxT, 'center', { bold: true });
    const col = isPickup && t.item ? rarityColor(t.item.rarity) : t.labelColor ? css(t.labelColor) : '#f0f0f0';
    text(lab, x + kw + 11 * S, y + h / 2 + 0.5, col, pxT);
  }
  function drawExitArrow() {
    const f = HM.Game.floor; if (!f || !f.exitOpen || !f.exit || !HM.R) return;
    const [sx, sy] = HM.R.worldToScreen(f.exit.x, f.exit.y, 30);
    const m = 46 * S;
    if (sx > m && sx < W - m && sy > m && sy < H - m) return;
    const cx = W / 2, cy = H / 2, dx = sx - cx, dy = sy - cy;
    const k = Math.min((W / 2 - m) / Math.max(1e-3, Math.abs(dx)), (H / 2 - m) / Math.max(1e-3, Math.abs(dy)));
    const ax = cx + dx * k, ay = cy + dy * k, ang = Math.atan2(dy, dx);
    const pu = 0.6 + 0.4 * Math.sin(UI.t * 4);
    ctx.save(); ctx.translate(ax, ay); ctx.rotate(ang);
    ctx.fillStyle = rgba(COL.witch, pu); ctx.beginPath(); ctx.moveTo(12 * S, 0); ctx.lineTo(-6 * S, -7 * S); ctx.lineTo(-2 * S, 0); ctx.lineTo(-6 * S, 7 * S); ctx.closePath(); ctx.fill();
    ctx.restore(); curFont = '';
    const p = HM.Game.player; const d = p ? Math.round(M.dist(p.x, p.y, f.exit.x, f.exit.y) / 10) : 0;
    text('DOOR ' + d + 'm', ax - Math.cos(ang) * 26 * S, ay - Math.sin(ang) * 18 * S, rgba(COL.witch, 0.9), fpx(10), 'center', { shadow: true });
  }

  // ======================================================================= world-anchored overlays
  function drawWorldOverlays() {
    const Gm = HM.Game, R = HM.R; if (!R || !Gm.floor) return;
    const p = Gm.player, I = HM.Input;
    const mx = I.mouse.sx, my = I.mouse.sy;
    const showTags = Gm.state !== 'dead';
    // hovered enemy (for crosshair + target frame)
    let hov = null, hd = Infinity;
    for (const a of Gm.entities) {
      if (a.dead || a.team !== 1 || a.neutral || a.hidden || !R.inViewWorld(a.x, a.y, 60)) continue; // the unpossessed Waving Snail is not a foe
      const hgt = (a.height || 50) + (a.z || 0);
      const mid = R.worldToScreen(a.x, a.y, hgt * 0.5);
      const rx = Math.max(12 * S, (a.radius || 9) * R.zoomX * 1.5), ry = Math.max(14 * S, hgt * 0.55 * R.zoomY);
      const dx = (mx - mid[0]) / rx, dy = (my - mid[1]) / ry, d = dx * dx + dy * dy;
      if (d < 1 && d < hd) { hd = d; hov = a; }
    }
    UI.hoverEnemy = Gm.state === 'play' ? hov : null;
    // hovered interactable / pickup
    let hi = null, hdi = 24 * S;
    const consider = (o) => { if (!o || o.used || o.hidden) return; const s = R.worldToScreen(o.x, o.y, (o.z || 0) + 12); const d = Math.hypot(mx - s[0], my - s[1]); if (d < hdi) { hdi = d; hi = o; } };
    for (const o of Gm.floor.interactables || []) consider(o);
    for (const o of Gm.pickups) if (o.kind !== 'gold') consider(o);
    UI.hoverInteract = hi;
    drawPickupLabels();
    if (showTags) drawNameTags(p);
    drawFloaters();
    drawBarks();
  }
  const tagRects = [];
  function tagFree(x, y, w, h) {
    for (let i = 0; i < tagRects.length; i += 4) { const rx = tagRects[i], ry = tagRects[i + 1]; if (x < rx + tagRects[i + 2] && x + w > rx && y < ry + tagRects[i + 3] && y + h > ry) return false; }
    tagRects.push(x, y, w, h); return true;
  }
  // Name tags in a scrum (user feedback: labels piled into the fight): full tags (name + bar + statuses) only for the
  // hovered / last-hit target and elites (bosses use the top bar), at most MAX_TAG_NAMES of them; ordinary foes get a
  // thin nameless HP bar once they are hurt and near; nothing is nudged into towers — a tag with no room is skipped.
  const MAX_TAG_NAMES = 3, MAX_THIN_BARS = 8;
  function drawNameTags(p) {
    const Gm = HM.Game, R = HM.R;
    const pxN = fpx(10);
    tagRects.length = 0;
    const target = UI.hoverEnemy || (UI.lastHit && !UI.lastHit.dead && UI.t - UI.lastHitT < 3 ? UI.lastHit : null);
    // the hero's own tag dims while foes crowd them, so it never sits on top of the melee
    let scrum = false;
    if (p && !p.dead) for (const a of Gm.entities) if (a.team === 1 && !a.dead && !a.neutral && Math.abs(a.x - p.x) < 130 && Math.abs(a.y - p.y) < 100) { scrum = true; break; }
    const sdt = Math.min(0.1, Math.max(0, UI.t - (UI._tagT || UI.t))); UI._tagT = UI.t;
    UI._scrumA = M.damp(UI._scrumA === undefined ? 1 : UI._scrumA, scrum ? 0.3 : 1, 5, sdt);
    if (p && !p.dead) { const q = R.worldToScreen(p.x, p.y, (p.height || 50) + (p.z || 0) + 8); tagFree(q[0] - 30 * S, q[1] - 12 * S, 60 * S, 14 * S); }
    const foes = tagFoes; foes.length = 0;
    for (const a of Gm.entities) {
      if (a.dead || a.noTag || !R.inViewWorld(a.x, a.y, 40)) continue;
      const hgt = (a.height || 50) + (a.z || 0);
      const [sx, sy0] = R.worldToScreen(a.x, a.y, hgt + 8);
      const sy = sy0 - 4 * S;
      if (a === p) { ctx.globalAlpha = UI._scrumA; text(a.name || 'Hero', sx, sy, '#f4f4f4', pxN, 'center', { shadow: true }); ctx.globalAlpha = 1; continue; }
      if (a.isBoss) continue;
      if (a.team === 2) { if (a.name && p && M.dist(a.x, a.y, p.x, p.y) < 220) text(a.displayName || a.name, sx, sy, '#cfc6b0', pxN, 'center', { shadow: true }); continue; }
      if (a.team !== 1) { if (a.name) text(a.name, sx, sy, '#a8d8a8', pxN, 'center', { shadow: true }); continue; }
      const d = p ? M.dist(a.x, a.y, p.x, p.y) : 0;
      const vip = a === target || a.isElite;
      const hurt = a.hp < a.maxHp - 0.5;
      if (!vip && !(hurt && d < 520)) continue;
      foes.push({ a, sx, sy, vip, pri: (a === UI.hoverEnemy ? -3e4 : 0) + (a === target ? -2e4 : 0) + (a.isElite ? -1e4 : 0) + d });
    }
    foes.sort((u, v) => u.pri - v.pri);
    let names = 0, bars = 0;
    for (const f of foes) {
      if (f.vip && names < MAX_TAG_NAMES && fullTag(f, pxN, f.a === target)) { names++; continue; }
      if (bars < MAX_THIN_BARS && thinBar(f)) bars++;
    }
  }
  function fullTag(f, pxN, isTarget) {
    const a = f.a, sx = f.sx; let sy = f.sy;
    const name = a.displayName || a.name || '';
    const col = a.isElite ? COL.elite : isTarget ? '#ffffff' : '#e6e6e6';
    const nw = tw(name, pxN);
    const bw = Math.max(44 * S, Math.min(90 * S, nw)), bh = Math.max(3, Math.round(4 * S)), bx = sx - bw / 2;
    let ok = tagFree(bx - 1, sy - 1, bw + 2, bh + 2);
    if (!ok) { sy -= bh + 5 * S; ok = tagFree(bx - 1, sy - 1, bw + 2, bh + 2); } // one nudge at most
    if (!ok) { if (!isTarget) return false; sy = f.sy; tagRects.push(bx - 1, sy - 1, bw + 2, bh + 2); } // the target always shows, and claims its space
    if (tagFree(sx - nw / 2, sy - 12 * S, nw, 11 * S) || isTarget) { if (isTarget) tagRects.push(sx - nw / 2, sy - 12 * S, nw, 11 * S); text(name, sx, sy - 6 * S, col, pxN, 'center', { shadow: true }); }
    fill(bx - 1, sy - 1, bw + 2, bh + 2, 'rgba(0,0,0,0.7)'); box(bx - 1, sy - 1, bw + 2, bh + 2, '#8a8a8a');
    const f01 = a.maxHp ? clamp01(a.hp / a.maxHp) : 0, g01 = a.maxHp ? clamp01(ghostOf(a) / a.maxHp) : 0;
    if (g01 > f01) fill(bx + bw * f01, sy, bw * (g01 - f01), bh, '#9a3a2a');
    fill(bx, sy, bw * f01, bh, a.isElite ? COL.elite : '#e8e8e8');
    let gx = bx + bw + 5 * S;
    for (const st of (a.statuses || []).slice(0, 4)) { const g = STATUS_GLYPH[st.id]; if (!g) continue; text(g[0], gx, sy + bh / 2, g[1], fpx(9), 'left', { shadow: true }); gx += 7 * S; }
    if (a.isElite) { const aff = affixNames(a); if (aff) text(aff, sx, sy - 18 * S, '#d9a35a', fpx(9), 'center', { shadow: true }); }
    return true;
  }
  function thinBar(f) {
    const a = f.a, R = HM.R;
    const bw = Math.round(M.clamp((a.radius || 9) * 2.6 * (R.zoomX || 1), 22 * S, 40 * S)), bh = Math.max(2, Math.round(2.5 * S));
    const bx = Math.round(f.sx - bw / 2); let by = Math.round(f.sy);
    if (!tagFree(bx - 1, by - 1, bw + 2, bh + 2)) { by -= bh + 3 * S; if (!tagFree(bx - 1, by - 1, bw + 2, bh + 2)) return false; }
    const f01 = a.maxHp ? clamp01(a.hp / a.maxHp) : 0, g01 = a.maxHp ? clamp01(ghostOf(a) / a.maxHp) : 0;
    fill(bx - 1, by - 1, bw + 2, bh + 2, 'rgba(0,0,0,0.72)');
    if (g01 > f01) fill(bx + bw * f01, by, bw * (g01 - f01), bh, '#8a3426');
    fill(bx, by, bw * f01, bh, f01 < 0.3 ? '#e8826e' : '#e4ded4');
    return true;
  }
  const tagFoes = [];
  function drawPickupLabels() {
    const Gm = HM.Game, R = HM.R; const list = [];
    for (const o of Gm.pickups) {
      if (!o.label || !R.inViewWorld(o.x, o.y, 30)) continue;
      const [sx, sy] = R.worldToScreen(o.x, o.y, (o.z || 0) + 16);
      const rar = o.item ? RARITY_ORDER[o.item.rarity] || 0 : o.kind === 'gold' ? -1 : 0;
      list.push({ o, sx, sy, rar, col: o.labelColor ? css(o.labelColor) : o.item ? rarityColor(o.item.rarity) : o.kind === 'gold' ? COL.gold : '#e0e0e0' });
    }
    if (!list.length) return;
    list.sort((a, b) => b.rar - a.rar || a.sy - b.sy);
    const placed = [], pxL = fpx(10), lh = 14 * S;
    for (const L of list) {
      const w = tw(L.o.label, pxL) + 8 * S;
      let x = L.sx - w / 2, y = L.sy - lh, tries = 0;
      while (tries++ < 12 && placed.some((r) => x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + lh > r.y)) y -= lh;
      placed.push({ x, y, w, h: lh });
      const isT = HM.Game.interactTarget === L.o || UI.hoverInteract === L.o;
      if (isT || L.rar >= 2) fill(x, y + 1, w, lh - 2, 'rgba(0,0,0,0.6)');
      if (isT) box(x, y + 1, w, lh - 2, L.col);
      text(L.o.label, x + 4 * S, y + lh / 2, L.col, pxL, 'left', { shadow: !isT });
      if (y < L.sy - lh - 1) fill(L.sx, y + lh, 1, L.sy - lh - y, rgba(L.col, 0.35));
    }
  }
  function drawFloaters() {
    const FX = HM.FX, R = HM.R; if (!FX || !FX.floaters) return;
    const showNums = setting('damageNumbers', true) !== false;
    for (const f of FX.floaters) {
      const numeric = /^[+\-]?[\d.,]+[kM]?!?$/.test(String(f.text));
      if (numeric && !showNums) continue;
      // FX animates the pop/punch into f.size (a font multiplier) and the fade into f.alpha — draw exactly that,
      // with half-pixel font steps so the settle after the overshoot is smooth instead of a second visible pop
      const a = f.alpha !== undefined ? f.alpha : 1 - clamp01(((f.t || 0) / (f.life || 1) - 0.6) / 0.4);
      if (a <= 0.01) continue;
      const [sx, sy] = R.worldToScreen(f.x, f.y, f.z || 0);
      if (sx < -40 || sx > W + 40 || sy < -40 || sy > H + 40) continue;
      const kind = f.type || f.kind || (f.crit ? 'crit' : 'phys');
      const col = f.rgb ? css(f.rgb) : f.crit ? TYPE_COL.crit : TYPE_COL[kind] || TYPE_COL.phys;
      const mul = f.size !== undefined ? f.size : f.crit ? 1.25 : 1;
      const size = Math.max(7, Math.round(fpx(numeric ? 13 : 11) * mul * 2) / 2);
      ctx.globalAlpha = clamp01(a);
      text(String(f.text) + (f.crit && numeric && !/!$/.test(f.text) ? '!' : ''), sx, sy, col, size, 'center', { shadow: true, bold: !!f.crit });
    }
    ctx.globalAlpha = 1;
  }
  function drawBarks() {
    const R = HM.R;
    const yMinBark = (HM.Game.bossesAlive && HM.Game.bossesAlive().some((b) => !(b.introT > 0 && b.hideBar)) ? 64 : 8) * S;
    for (const b of UI.barks) {
      const a = b.actor; if (!a || a.removeMe || !R.inViewWorld(a.x, a.y, 80)) continue;
      const hgt = (a.height || 50) + (a.z || 0);
      const [sx, sy0] = R.worldToScreen(a.x, a.y, hgt + 8);
      const lift = (a.isElite ? 34 : a.kind === 'player' ? 14 : 22) * S + Math.min(1, b.t * 6) * 4 * S;
      const n = Math.min(b.text.length, Math.floor(b.t * 45) + 1), s = b.text.slice(0, n);
      const alpha = b.t > b.dur - 0.5 ? (b.dur - b.t) / 0.5 : 1;
      ctx.globalAlpha = clamp01(alpha);
      const pxB = fpx(10), w = tw(b.text, pxB) + 12 * S, h = 16 * S;
      const x = M.clamp(sx - w / 2, 4, W - w - 4), y = Math.max(yMinBark, sy0 - lift - h); // never under the boss bar
      fill(x, y, w, h, 'rgba(0,0,0,0.78)'); box(x, y, w, h, a.kind === 'player' ? '#cfcfcf' : a.isBoss ? '#d06a4a' : '#7a7a7a');
      fill(M.clamp(sx, x + 4, x + w - 5), y + h - 1, 3, 3 * S, a.kind === 'player' ? '#cfcfcf' : '#7a7a7a');
      text(s, x + 6 * S, y + h / 2 + 0.5, a.kind === 'player' ? '#ffffff' : a.isBoss ? '#ffd9c8' : '#e2ddd2', pxB, 'left', { bold: a.isBoss });
    }
    ctx.globalAlpha = 1;
  }

  // ======================================================================= banner / toasts / misc / cursor
  function drawBanner() {
    const b = UI.banners[0]; if (!b) return;
    const st = HM.Game.state; if (st !== 'play') return;
    const a = b.t < 0.5 ? b.t / 0.5 : b.t > b.dur - 0.8 ? (b.dur - b.t) / 0.8 : 1;
    ctx.globalAlpha = clamp01(a);
    const y = H * 0.24;
    const accent = b.color || '#c9b89a';
    if (ctx.createRadialGradient) { // soft elliptical shade so the text reads over busy grass
      const top = y - 50 * S, bot = y + (b.intro ? 96 : b.sub ? 46 : 30) * S;
      const cy = (top + bot) / 2, rh = (bot - top) / 2 + 10 * S, rw = 440 * S;
      ctx.save(); ctx.translate(W / 2, cy); ctx.scale(rw / rh, 1);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rh);
      g.addColorStop(0, 'rgba(0,0,0,0.62)'); g.addColorStop(0.65, 'rgba(0,0,0,0.42)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(-rh, -rh, rh * 2, rh * 2);
      ctx.restore(); curFont = '';
    }
    if (b.kicker) spaced(b.kicker, W / 2, y - 30 * S, accent, fpx(10), 'center', 0.45);
    const tpx = fpx(26), ttw = tw(b.title, tpx);
    const spread = (1 - clamp01(b.t / 0.9)) * 30 * S;
    fill(W / 2 - ttw / 2 - 60 * S - spread, y, 44 * S, 1, rgba(accent, 0.7)); fill(W / 2 + ttw / 2 + 16 * S + spread, y, 44 * S, 1, rgba(accent, 0.7));
    text(b.title, W / 2, y, '#f4efe6', tpx, 'center', { shadow: 'rgba(0,0,0,0.9)', bold: true });
    if (b.sub) text(b.sub, W / 2, y + 26 * S, '#b9b2a6', fpx(12), 'center', { shadow: true });
    if (b.intro) {
      const ia = clamp01((b.t - 1.1) / 0.8); ctx.globalAlpha = clamp01(a) * ia;
      b.intro.forEach((l, i) => text(l, W / 2, y + 56 * S + i * 17 * S, '#9d978c', fpx(11), 'center', { shadow: true }));
    }
    ctx.globalAlpha = 1;
  }
  function drawToasts() {
    if (TOAST_HOLD[HM.Game.state] || (UI.card && HM.Game.state === 'play')) return;
    const x = W - 16 * S; let y = Math.max(UI._objBottom || 80 * S, 80 * S) + 8 * S;
    if (HM.Game.state !== 'play' && HM.Game.state !== 'pause') y = 70 * S;
    for (const t of UI.toasts) {
      const pxT = fpx(11), lh = 15 * S;
      let mc = 0; for (const l of t.lines) mc = Math.max(mc, l.length);
      const w = mc * cw(pxT) + 22 * S, h = t.lines.length * lh + 12 * S;
      const slide = t.t < 0.18 ? (1 - t.t / 0.18) * 40 * S : 0;
      const a = t.t > t.dur - 0.4 ? (t.dur - t.t) / 0.4 : 1;
      ctx.globalAlpha = clamp01(a);
      const tx = x - w + slide;
      fill(tx, y, w, h, 'rgba(0,0,0,0.88)'); box(tx, y, w, h, t.kind === 'ach' ? t.color : rgba(t.color, 0.7));
      if (t.kind === 'ach') fill(tx + 1, y + 1, 3 * S, h - 2, t.color);
      t.lines.forEach((l, i) => text(l, tx + 11 * S, y + 6 * S + lh / 2 + i * lh, i === 0 ? t.color : t.kind === 'ach' && i === 1 ? '#fff' : '#cfcfcf', pxT, 'left', { bold: t.kind === 'ach' && i <= 1 }));
      y += h + 6 * S;
    }
    ctx.globalAlpha = 1;
  }
  function drawMisc() {
    const Gm = HM.Game;
    // saving indicator
    const st = UI.t - UI.saveT;
    if (st < 1.4) {
      ctx.globalAlpha = clamp01(1.4 - st);
      text('saved ' + '|/-\\'[Math.floor(UI.t * 10) % 4], W - 14 * S, H - (HM.Game.state === 'title' ? 34 : 14) * S, COL.dim, fpx(10), 'right', { shadow: true });
      ctx.globalAlpha = 1;
    }
    if (setting('showFps', false)) text(Math.round(Gm.fps || 0) + ' fps', 14 * S, H - 14 * S, '#8f8', fpx(10), 'left', { shadow: true });
    if (HM.debug) drawDebug();
  }
  function drawCursor() {
    const I = HM.Input; if (!I.mouse.inside && !HM.headless) return; // pointer left the window (or has not moved yet)
    const x = Math.round(I.mouse.sx) + 0.5, y = Math.round(I.mouse.sy) + 0.5;
    const st = HM.Game.state;
    if (st === 'play' && !UI.modal && !UI.dlg && !UI.card) {
      const e = UI.hoverEnemy, it = UI.hoverInteract;
      const col = e ? '#ff5a4a' : '#f2f2f2';
      const arm = Math.round(6 * S), gap = Math.round(2 * S);
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(x - arm - gap - 1, y - 1.5, arm + 2, 3); ctx.fillRect(x + gap - 1, y - 1.5, arm + 2, 3);
      ctx.fillRect(x - 1.5, y - arm - gap - 1, 3, arm + 2); ctx.fillRect(x - 1.5, y + gap - 1, 3, arm + 2);
      ctx.fillStyle = col;
      ctx.fillRect(x - arm - gap, y - 0.5, arm, 1); ctx.fillRect(x + gap, y - 0.5, arm, 1);
      ctx.fillRect(x - 0.5, y - arm - gap, 1, arm); ctx.fillRect(x - 0.5, y + gap, 1, arm);
      if (e && HM.R) {
        const R = HM.R, hgt = (e.height || 50) + (e.z || 0);
        const top = R.worldToScreen(e.x, e.y, hgt + 4), bot = R.worldToScreen(e.x, e.y, -2);
        const hw = Math.max(10 * S, (e.radius || 9) * R.zoomX * 1.6);
        const bx = top[0] - hw, by = top[1], bw = hw * 2, bh = bot[1] - top[1];
        const l = Math.round(6 * S), pu = Math.sin(UI.t * 10) * 1.5 * S;
        const c2 = '#ff5040';
        const br = (xx, yy, sx2, sy2) => { fill(xx, yy, l * sx2, 1, c2); fill(xx, yy, 1, l * sy2, c2); };
        br(bx - pu, by - pu, 1, 1); br(bx + bw + pu, by - pu, -1, 1); br(bx - pu, by + bh + pu, 1, -1); br(bx + bw + pu, by + bh + pu, -1, -1);
      } else if (it) {
        text('[' + HM.Input.actionLabel('interact') + ']', x + 10 * S, y - 10 * S, '#ffffff', fpx(10), 'left', { shadow: true });
      }
      return;
    }
    // menu pointer: small arrow
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.moveTo(x - 1, y - 1); ctx.lineTo(x - 1, y + 15 * S); ctx.lineTo(x + 4.5 * S, y + 10.5 * S); ctx.lineTo(x + 11 * S, y + 11 * S); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#f2f2f2';
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 12.5 * S); ctx.lineTo(x + 4 * S, y + 9 * S); ctx.lineTo(x + 9 * S, y + 9.5 * S); ctx.closePath(); ctx.fill();
  }

  // ======================================================================= play input + debug cheats
  function updatePlayInput() {
    const I = HM.Input, Gm = HM.Game;
    if (I.wasPressed('map')) { UI.bigMap = !UI.bigMap; sfx(UI.bigMap ? 'ui_select' : 'ui_back'); }
    if (UI.bigMap && I.pressed.has('Escape')) { swallowKeys(); UI.bigMap = false; sfx('ui_back'); return; }
    if (I.pressed.has('Escape') || I.wasPressed('pause')) { swallowKeys(); Gm.setState('pause'); sfx('ui_back'); return; }
    if (I.wasPressed('inventory')) { Gm.setState('inventory'); sfx('ui_select'); return; }
    if (HM.debug) debugKeys();
  }
  function debugKeys() {
    const I = HM.Input, Gm = HM.Game, p = Gm.player, run = Gm.run; if (!p || !run) return;
    const P = I.pressed;
    if (P.has('KeyG')) { p.invuln = !p.invuln; UI.toast('god mode ' + (p.invuln ? 'ON' : 'off'), COL.gold, 1.5); }
    if (P.has('KeyK')) { let n = 0; for (const a of Gm.entities.slice()) if (a.team === 1 && !a.dead) { HM.Combat.damage(a, { amount: 1e9, type: 'phys', source: p, ignoreIframes: true, noNumber: true }); n++; } UI.toast('killed ' + n, COL.bad, 1.5); }
    if (P.has('KeyN')) { Gm.openExit('debug'); Gm.descend(); }
    if (P.has('KeyL')) { Gm.grantXP(Math.max(1, Gm.xpToNext(run.level) - run.xp)); }
    if (P.has('KeyP') && HM.Items && HM.Items.rollItem && HM.Items.dropItem) {
      for (let k = 0; k < 3; k++) {
        try { const it = HM.Items.rollItem({ floorIndex: run.floorIndex, heroId: run.heroId, rarityBias: 1 + k, rng: HM.rng }); if (it) HM.Items.dropItem(p.x + Math.cos(k * 2.1) * 30, p.y + Math.sin(k * 2.1) * 30, it); } catch (e) { console.error(e); }
      }
      UI.toast('loot spawned', COL.gold, 1.5);
    }
  }
  function drawDebug() {
    const Gm = HM.Game, R = HM.R;
    const lines = [
      'DEBUG  state ' + Gm.state + '  fps ' + Math.round(Gm.fps || 0),
      'ents ' + Gm.entities.length + '  proj ' + Gm.projectiles.length + '  zones ' + Gm.zones.length + '  pickups ' + Gm.pickups.length + '  lights ' + (R && R.stats ? R.stats.lights : 0),
      Gm.player ? 'player ' + Math.round(Gm.player.x) + ',' + Math.round(Gm.player.y) + (Gm.player.invuln ? '  [GOD]' : '') : '',
      'G god · K kill all · N next floor · L level · P loot',
    ];
    const y0 = H - 130 * S;
    lines.forEach((l, i) => text(l, 14 * S, y0 + i * 14 * S, '#9f9', fpx(10), 'left', { shadow: true }));
  }
})();
