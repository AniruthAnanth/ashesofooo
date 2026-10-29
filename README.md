# Ashes of Ooo

A single-player ASCII action-roguelike that runs in the browser. Everything you see is drawn with monospace glyphs:
grass, ruins, water, fire, characters and bosses. It uses real lighting, bloom, fog and dithered shading.

The setting is a dark-fantasy take on the Land of Ooo, a thousand years after the Mushroom War. The Lich has drunk from the
Well of Power and Ooo is dying from the edges inward. Play as **Finn**, **Marceline** or **Flame Princess** and descend through
five fallen realms: the Grasslands, the Candy Necropolis, the Ice Kingdom, the Fire Kingdom and the Lich's Well. Each realm ends in a boss.

**Play:** open `index.html` in a modern browser (needs WebGL2). There is no build step, server or install.

## Controls

| Key | Action |
|---|---|
| W A S D | Move |
| Mouse | Aim |
| Left click | Attack (combo) |
| Right click | Heavy / secondary |
| Space | Dodge roll (you're untouchable mid-roll) |
| Q / E | Skills |
| R | Ultimate |
| F | Interact: take loot, read, shrines, descend |
| 1 / 2 | Bacon Pancakes (heal) / Tonic |
| Tab / I | Inventory |
| M | Map |
| Esc | Pause: moves list, options, key remapping |

## Saves

There are three save slots, stored in your browser's `localStorage`. Use **Profiles → Export** to download a slot as a `.json` file,
and **Import** to load one back. Imported files are checked before anything is overwritten.

## Credits

- The art direction and combat feel are inspired by [@ansenjeo](https://www.instagram.com/ansenjeo/)'s "ASCII MMORPG" devlog reels.
- The water dithering is inspired by ya_demidov's "Sinking into dither".
- Controls were designed with Andrew Dotsenko's [*Designing Game Controls*](https://www.gamedeveloper.com/design/designing-game-controls) in mind.

This is a non-commercial fan project. *Adventure Time* and its characters belong to Cartoon Network, and this project is not
affiliated with or endorsed by them. All game code and written lore are original.

## Development

- `node tools/smoke.js --seconds 6 --floors 1-15` runs every hero through every floor headless.
- `tools/tests/*.js` hold the feature harnesses.
- `tools/shot.sh` takes headless-Chrome screenshots (pass `sim=SECONDS`).
- `docs/DESIGN.md` and `docs/CONTRACT.md` describe the design and the module API.
