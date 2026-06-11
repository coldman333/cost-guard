# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser arcade game ("Берегова охорона" — Coast Guard) inspired by Soviet handheld electronic games, written in vanilla ES modules + Three.js loaded via importmap. No build step, no package manager, no backend, no tests.

## Run

Needs a static server because `<script type="module">` won't load from `file://`:

```bash
python3 -m http.server 8080
# or: npx serve .
# or: npx http-server -p 8080
```

Then open `http://localhost:8080`. Three.js is pulled from `unpkg.com` at runtime via the importmap in [index.html](index.html); there's no install step and no offline mode.

## Architecture

Everything lives in [main.js](main.js) as a single ES module. The classes are organized top-to-bottom by dependency, not split into files — keep it that way unless the file grows past readability.

### Tuning surface

All gameplay balance is in the `BALANCE` constant at the top of `main.js`. Touch this before touching class internals when adjusting feel (gravity, projectile speed, wave scaling, cannon pitch/yaw limits, cooldown, lane Z-distances, lives). Ship variants live in `SHIP_TYPES` next to it — each entry sets length/beam/height (visual + collision radius), color, speed multiplier, score.

### Game loop

`Game._loop()` drives a fixed-update structure:

1. `dt = clock.getDelta()` clamped to `0.05s` to survive tab-switch hitches.
2. If not paused/gameOver: `update(dt)`.
3. Always `render()`.

`Game.update(dt)` is the contract for "one tick of simulation": aim → fire intake → cannon/projectile/ship/fx physics → collisions → cleanup → wave manager → debug/aim markers → HUD sync. Physics is deliberately decoupled from rendering: each entity has its own `position`/`velocity` that gets copied into `mesh.position` after the physics step. Collision uses the logical `position`, never the visual mesh (ships bob purely cosmetically).

### Coordinate gotcha

The camera sits at `(+18, 14, -16)` looking toward `+Z`, which means **world `+X` appears on the LEFT of the screen**. The yaw input mapping in `Game._aim()` therefore negates `mouseNDC.x` and inverts arrow keys. If you reposition the camera (e.g. to look down `-Z`), reverse that inversion or you'll re-introduce the bug.

### Cannon math

`Cannon.aimDirection()` and `Cannon.muzzlePosition()` compute world-space vectors from `yaw` + `pitch` analytically (axis-angle rotations on `(0,0,1)` and `(0,0,barrelLength)` respectively). Three.js scene-graph rotations on `yawPivot`/`pitchPivot` are only for rendering — never read mesh transforms back into physics.

### Wave manager

`WaveManager` is a tiny FSM: `idle → spawning → breaking`. Difficulty grows by:
- `currentSpeedMultiplier() = pow(waveSpeedMultiplier, wave-1)` applied to every spawn's velocity,
- `spawnInterval = max(min, base * pow(shrink, wave-1))`,
- `shipsBase + (wave-1) * shipsPerWave` ships per wave.

`onShipRemoved()` must be called for **both** kills and escapes — kills fire it from `Game._checkCollisions()`, escapes from `Game._cleanup()`. Without that the wave never advances.

### Game-over delay

Game over is two-stage:
1. When `lives` drops to 0, `Game._cleanup()` flips `_pendingGameOver = true` and stops `waveManager.update()` from running (no new spawns).
2. `_onGameOver()` only fires when `ships.length === 0 && projectiles.length === 0`, so the player can finish off whatever was already on screen and watch their last shells land.

Restart resets both `gameOver` and `_pendingGameOver`.

### Debug toggles

Two independent toggles, intentionally separate:
- **Aim helper (`A`, ✛ button)** — `_updateAimHelper()` simulates the current shot's ballistic until `y ≤ 0` and parks a yellow crosshair there. Default off.
- **Debug (`D`, 🎯 button)** — `_updateInterceptMarkers()` runs `predictIntercept()` (a fixed-point iteration that ignores gravity — it's a visual hint, not an aimbot) for every live ship.

Both clear their meshes on toggle-off; don't piggyback unrelated visualizations on either flag.

### Disposal

Every entity that owns geometries/materials has `dispose()` that removes from scene + frees GPU buffers. `Game.restart()` and `Game._cleanup()` are the only places that should call it. If you add a new entity, replicate the pattern — Three.js does not garbage-collect GL resources.
