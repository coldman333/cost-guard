import * as THREE from 'three';

// ============================================================
// BALANCE — всі ручки тюнінгу зосереджені тут
// ============================================================
const BALANCE = {
  gravity: 18,
  projectileSpeed: 40,
  projectileLifetime: 7,
  projectileRadius: 0.25,
  worldHalfWidth: 80,

  cannon: {
    minPitch: 3  * Math.PI / 180,
    maxPitch: 45 * Math.PI / 180,
    maxYaw:   70 * Math.PI / 180,
    aimSpeed: 1.4,
    cooldown: 0.5,
    mouseSmoothing: 12,
  },

  ship: {
    baseSpeed: 6,
    waveSpeedMultiplier: 1.12,
    spawnIntervalBase: 2.8,
    spawnIntervalMin: 0.9,
    spawnIntervalShrink: 0.93,
    zLanes: [32, 46, 62, 78],
  },

  wave: {
    shipsBase: 3,
    shipsPerWave: 1,
    breakDuration: 2.5,
  },

  player: { startLives: 3 },
};

const SHIP_TYPES = {
  cutter:    { length: 4, beam: 1.2, height: 1.0, color: 0x8a8a8a, speedMul: 1.4, score: 150, radius: 2.0 },
  cruiser:   { length: 6, beam: 1.8, height: 1.4, color: 0x556070, speedMul: 1.0, score: 100, radius: 3.0 },
  freighter: { length: 9, beam: 2.6, height: 1.8, color: 0x6e5840, speedMul: 0.7, score: 70,  radius: 4.5 },
};

// ============================================================
// helpers
// ============================================================
const clamp   = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp    = (a, b, t) => a + (b - a) * t;
const rand    = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));

const _UP    = new THREE.Vector3(0, 1, 0);
const _RIGHT = new THREE.Vector3(1, 0, 0);
const _tmp   = new THREE.Vector3();

// Ітеративно знаходить точку перехоплення для цілі, що рухається
// з постійною швидкістю. Гравітація ігнорується — це лише підказка
// "куди дивитись", не точне рішення балістики.
function predictIntercept(cannonPos, v0, shipPos, shipVel) {
  let t = cannonPos.distanceTo(shipPos) / v0;
  for (let i = 0; i < 6; i++) {
    const tgt = shipPos.clone().addScaledVector(shipVel, t);
    const nt  = cannonPos.distanceTo(tgt) / v0;
    if (Math.abs(nt - t) < 0.01) { t = nt; break; }
    t = nt;
  }
  return shipPos.clone().addScaledVector(shipVel, t);
}

// ============================================================
// AudioFX — синтез через WebAudio, без зовнішніх ассетів
// ============================================================
class AudioFX {
  constructor() { this.ctx = null; this.enabled = true; }

  _ensure() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  _noiseSource(seconds, decay = 1.5) {
    const sr  = this.ctx.sampleRate;
    const len = Math.floor(sr * seconds);
    const buf = this.ctx.createBuffer(1, len, sr);
    const d   = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    return src;
  }

  shot() {
    if (!this.enabled) return;
    this._ensure();
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.18);
    g.gain.setValueAtTime(0.2, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    o.connect(g).connect(this.ctx.destination);
    o.start(t); o.stop(t + 0.22);
  }

  boom() {
    if (!this.enabled) return;
    this._ensure();
    const t = this.ctx.currentTime;
    const n = this._noiseSource(0.45, 2.0);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(1200, t);
    f.frequency.exponentialRampToValueAtTime(120, t + 0.4);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.45, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    n.connect(f).connect(g).connect(this.ctx.destination);
    n.start(t);
  }

  splash() {
    if (!this.enabled) return;
    this._ensure();
    const t = this.ctx.currentTime;
    const n = this._noiseSource(0.22, 1.0);
    const f = this.ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 1800;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.14, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    n.connect(f).connect(g).connect(this.ctx.destination);
    n.start(t);
  }
}

// ============================================================
// Input — миша і клавіатура. Активний той, що останній використано.
// ============================================================
class Input {
  constructor(canvas) {
    this.canvas    = canvas;
    this.keys      = {};
    this.mouseNDC  = { x: 0, y: 0 };
    this.lastInput = 'mouse';
    this._fireOnce  = false;
    this._mouseHeld = false;

    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.mouseNDC.x =  ((e.clientX - r.left) / r.width)  * 2 - 1;
      this.mouseNDC.y = -((e.clientY - r.top)  / r.height) * 2 + 1;
      this.lastInput = 'mouse';
    });
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) { this._fireOnce = true; this._mouseHeld = true; }
    });
    canvas.addEventListener('mouseup', (e) => {
      if (e.button === 0) this._mouseHeld = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      this.keys[e.code] = true;
      if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.code)) {
        this.lastInput = 'keys';
        e.preventDefault();
      }
      if (e.code === 'Space') { this._fireOnce = true; e.preventDefault(); }
    });
    window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });
  }

  consumeFire() {
    const fire = this._fireOnce || this.keys['Space'] || this._mouseHeld;
    this._fireOnce = false;
    return fire;
  }
}

// ============================================================
// Cannon
// ============================================================
class Cannon {
  constructor(scene) {
    this.position     = new THREE.Vector3(0, 1.2, 0);
    this.yaw          = 0;
    this.pitch        = THREE.MathUtils.degToRad(45);
    this.cooldown     = 0;
    this.barrelLength = 2.2;

    const group = new THREE.Group();
    group.position.copy(this.position);

    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 1.9, 0.6, 16),
      new THREE.MeshLambertMaterial({ color: 0x4a5b40 })
    );
    group.add(base);

    this.yawPivot = new THREE.Group();
    this.yawPivot.position.y = 0.35;
    group.add(this.yawPivot);

    const turret = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 0.7, 1.6),
      new THREE.MeshLambertMaterial({ color: 0x6a7a55 })
    );
    turret.position.y = 0.35;
    this.yawPivot.add(turret);

    this.pitchPivot = new THREE.Group();
    this.pitchPivot.position.set(0, 0.6, 0.4);
    this.yawPivot.add(this.pitchPivot);

    const barrelGeo = new THREE.CylinderGeometry(0.16, 0.20, this.barrelLength, 12);
    barrelGeo.rotateX(Math.PI / 2);
    barrelGeo.translate(0, 0, this.barrelLength / 2);
    this.barrel = new THREE.Mesh(
      barrelGeo,
      new THREE.MeshLambertMaterial({ color: 0x2a2a2a })
    );
    this.pitchPivot.add(this.barrel);

    scene.add(group);
    this.group = group;
  }

  update(dt) {
    this.yawPivot.rotation.y   = this.yaw;
    this.pitchPivot.rotation.x = -this.pitch; // від'ємне обертання навколо X = ствол вгору
    this.cooldown = Math.max(0, this.cooldown - dt);
  }

  aimDirection(out = new THREE.Vector3()) {
    out.set(0, 0, 1);
    out.applyAxisAngle(_RIGHT, -this.pitch);
    out.applyAxisAngle(_UP, this.yaw);
    return out;
  }

  muzzlePosition(out = new THREE.Vector3()) {
    out.set(0, 0, this.barrelLength);
    out.applyAxisAngle(_RIGHT, -this.pitch);
    out.applyAxisAngle(_UP, this.yaw);
    this.pitchPivot.getWorldPosition(_tmp);
    return out.add(_tmp);
  }

  canFire() { return this.cooldown <= 0; }

  fire() {
    if (!this.canFire()) return null;
    this.cooldown = BALANCE.cannon.cooldown;
    return {
      position: this.muzzlePosition(),
      velocity: this.aimDirection().multiplyScalar(BALANCE.projectileSpeed),
    };
  }
}

// ============================================================
// Projectile — суто фізика; мережа не впливає на колізії.
// ============================================================
class Projectile {
  constructor(scene, position, velocity) {
    this.scene    = scene;
    this.position = position.clone();
    this.velocity = velocity.clone();
    this.alive    = true;
    this.age      = 0;
    this.radius   = BALANCE.projectileRadius;

    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(this.radius, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xffe06b })
    );
    this.mesh.position.copy(this.position);
    scene.add(this.mesh);

    this.trailMax = 24;
    this.trailPts = [];
    this.trailGeo = new THREE.BufferGeometry();
    this.trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.trailMax * 3), 3));
    this.trail = new THREE.Line(
      this.trailGeo,
      new THREE.LineBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.55 })
    );
    scene.add(this.trail);
  }

  update(dt) {
    this.velocity.y -= BALANCE.gravity * dt;
    this.position.addScaledVector(this.velocity, dt);
    this.age += dt;
    this.mesh.position.copy(this.position);

    this.trailPts.push(this.position.clone());
    if (this.trailPts.length > this.trailMax) this.trailPts.shift();
    const arr = this.trailGeo.attributes.position.array;
    for (let i = 0; i < this.trailPts.length; i++) {
      arr[i*3]     = this.trailPts[i].x;
      arr[i*3 + 1] = this.trailPts[i].y;
      arr[i*3 + 2] = this.trailPts[i].z;
    }
    this.trailGeo.setDrawRange(0, this.trailPts.length);
    this.trailGeo.attributes.position.needsUpdate = true;

    if (this.position.y <= 0 || this.age >= BALANCE.projectileLifetime) {
      this.alive = false;
    }
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.scene.remove(this.trail);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.trailGeo.dispose();
    this.trail.material.dispose();
  }
}

// ============================================================
// Ship
// ============================================================
class Ship {
  constructor(scene, typeKey, lane, direction, speed) {
    this.scene = scene;
    this.type  = typeKey;
    this.def   = SHIP_TYPES[typeKey];
    this.position = new THREE.Vector3(
      direction > 0 ? -BALANCE.worldHalfWidth : BALANCE.worldHalfWidth,
      0, lane
    );
    this.velocity  = new THREE.Vector3(direction * speed, 0, 0);
    this.alive     = true;
    this.escaped   = false;
    this.bobPhase  = Math.random() * Math.PI * 2;

    const d = this.def;
    const group = new THREE.Group();

    const hullMat = new THREE.MeshLambertMaterial({ color: d.color });
    const hull = new THREE.Mesh(new THREE.BoxGeometry(d.length, d.height, d.beam), hullMat);
    hull.position.y = d.height / 2;
    group.add(hull);

    const sup = new THREE.Mesh(
      new THREE.BoxGeometry(d.length * 0.45, d.height * 0.8, d.beam * 0.75),
      new THREE.MeshLambertMaterial({ color: 0xdedfd2 })
    );
    sup.position.set(-d.length * 0.1, d.height + d.height * 0.4, 0);
    group.add(sup);

    const funnel = new THREE.Mesh(
      new THREE.CylinderGeometry(d.beam * 0.2, d.beam * 0.25, d.height * 0.9, 8),
      new THREE.MeshLambertMaterial({ color: 0x3a2a22 })
    );
    funnel.position.set(-d.length * 0.2, d.height * 2.0, 0);
    group.add(funnel);

    this.mesh = group;
    this.mesh.position.copy(this.position);
    if (direction < 0) this.mesh.rotation.y = Math.PI;
    scene.add(this.mesh);
  }

  update(dt) {
    this.position.addScaledVector(this.velocity, dt);
    this.bobPhase += dt * 1.8;

    this.mesh.position.set(
      this.position.x,
      Math.sin(this.bobPhase) * 0.08,
      this.position.z
    );
    this.mesh.rotation.z = Math.sin(this.bobPhase * 0.65) * 0.03;

    const limit = BALANCE.worldHalfWidth + this.def.length;
    if (Math.abs(this.position.x) > limit) {
      this.escaped = true;
      this.alive   = false;
    }
  }

  collisionCenter(out = new THREE.Vector3()) {
    return out.set(this.position.x, this.def.height * 0.5, this.position.z);
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
}

// ============================================================
// FX — Explosion + Splash. Власна "фізика" частинок.
// ============================================================
class Explosion {
  constructor(scene, position, scale = 1) {
    this.scene = scene; this.alive = true; this.age = 0;
    this.duration = 0.7;

    this.group = new THREE.Group();
    this.group.position.copy(position);

    const palette = [0xff8833, 0xffd166, 0xc94020];
    this.bits = [];
    for (let i = 0; i < 14; i++) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.3 * scale, 6, 4),
        new THREE.MeshBasicMaterial({ color: palette[i % palette.length], transparent: true, opacity: 1 })
      );
      m.userData.vel = new THREE.Vector3(rand(-1, 1), rand(0.2, 1.2), rand(-1, 1))
        .normalize().multiplyScalar(rand(4, 10) * scale);
      this.group.add(m);
      this.bits.push(m);
    }
    this.flash = new THREE.Mesh(
      new THREE.SphereGeometry(scale * 1.6, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffaa, transparent: true, opacity: 0.9 })
    );
    this.group.add(this.flash);
    scene.add(this.group);
  }

  update(dt) {
    this.age += dt;
    const t = this.age / this.duration;
    for (const b of this.bits) {
      b.position.addScaledVector(b.userData.vel, dt);
      b.userData.vel.y -= 10 * dt;
      if (b.position.y < 0) {
        b.position.y = 0;
        b.userData.vel.y *= -0.2;
        b.userData.vel.x *= 0.6;
        b.userData.vel.z *= 0.6;
      }
      b.material.opacity = Math.max(0, 1 - t);
    }
    this.flash.scale.setScalar(1 + t * 3);
    this.flash.material.opacity = Math.max(0, 0.9 - t * 1.5);
    if (this.age >= this.duration) this.alive = false;
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
}

class Splash {
  constructor(scene, position) {
    this.scene = scene; this.alive = true; this.age = 0;
    this.duration = 0.5;

    this.group = new THREE.Group();
    this.group.position.set(position.x, 0, position.z);

    this.bits = [];
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.2, 5, 4),
        new THREE.MeshBasicMaterial({ color: 0xaad6ff, transparent: true, opacity: 0.85 })
      );
      const a = (i / 8) * Math.PI * 2;
      m.userData.vel = new THREE.Vector3(
        Math.cos(a) * rand(2, 4),
        rand(3, 6),
        Math.sin(a) * rand(2, 4)
      );
      this.group.add(m);
      this.bits.push(m);
    }
    scene.add(this.group);
  }

  update(dt) {
    this.age += dt;
    const t = this.age / this.duration;
    for (const b of this.bits) {
      b.position.addScaledVector(b.userData.vel, dt);
      b.userData.vel.y -= 14 * dt;
      b.material.opacity = Math.max(0, 1 - t);
    }
    if (this.age >= this.duration) this.alive = false;
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
}

// ============================================================
// WaveManager — спавн, темп, прогрес складності
// ============================================================
class WaveManager {
  constructor(game) {
    this.game = game;
    this.wave = 0;
    this.state = 'idle';
    this.toSpawn = 0;
    this.spawnTimer = 0;
    this.spawnInterval = BALANCE.ship.spawnIntervalBase;
    this.breakTimer = 0;
    this.activeCount = 0;
  }

  start() { this._beginNextWave(); }

  _beginNextWave() {
    this.wave += 1;
    this.toSpawn = BALANCE.wave.shipsBase + (this.wave - 1) * BALANCE.wave.shipsPerWave;
    const shrink = Math.pow(BALANCE.ship.spawnIntervalShrink, this.wave - 1);
    this.spawnInterval = Math.max(
      BALANCE.ship.spawnIntervalMin,
      BALANCE.ship.spawnIntervalBase * shrink
    );
    this.spawnTimer = 0;
    this.state = 'spawning';
    this.game.onWaveStart(this.wave);
  }

  currentSpeedMultiplier() {
    return Math.pow(BALANCE.ship.waveSpeedMultiplier, this.wave - 1);
  }

  _spawnShip() {
    const lanes     = BALANCE.ship.zLanes;
    const lane      = lanes[randInt(0, lanes.length - 1)];
    const direction = Math.random() < 0.5 ? 1 : -1;
    const types     = Object.keys(SHIP_TYPES);
    const type      = types[randInt(0, types.length - 1)];
    const def       = SHIP_TYPES[type];
    const speed     = BALANCE.ship.baseSpeed * def.speedMul * this.currentSpeedMultiplier();
    this.game.ships.push(new Ship(this.game.scene, type, lane, direction, speed));
    this.activeCount++;
  }

  onShipRemoved() {
    this.activeCount = Math.max(0, this.activeCount - 1);
    if (this.state === 'spawning' && this.toSpawn === 0 && this.activeCount === 0) {
      this.state = 'breaking';
      this.breakTimer = BALANCE.wave.breakDuration;
    }
  }

  update(dt) {
    if (this.state === 'spawning' && this.toSpawn > 0) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this._spawnShip();
        this.toSpawn--;
        this.spawnTimer = this.spawnInterval;
      }
    } else if (this.state === 'breaking') {
      this.breakTimer -= dt;
      if (this.breakTimer <= 0) this._beginNextWave();
    }
  }
}

// ============================================================
// HUD
// ============================================================
class HUD {
  constructor() {
    this.score = document.getElementById('hud-score');
    this.wave  = document.getElementById('hud-wave');
    this.lives = document.getElementById('hud-lives');
    this.speed = document.getElementById('hud-speed');
    this.msg   = document.getElementById('hud-message');
    this._msgT = null;
  }

  update(game) {
    this.score.textContent = String(game.score).padStart(6, '0');
    this.wave.textContent  = String(game.waveManager.wave);
    this.lives.textContent = '★'.repeat(Math.max(0, game.lives)) || '—';
    this.speed.textContent = '×' + game.waveManager.currentSpeedMultiplier().toFixed(2);
  }

  flash(text, duration = 1500) {
    this.msg.textContent = text;
    this.msg.classList.remove('hidden');
    clearTimeout(this._msgT);
    this._msgT = setTimeout(() => this.msg.classList.add('hidden'), duration);
  }
}

// ============================================================
// Game — оркеструє все
// ============================================================
class Game {
  constructor() {
    this.canvas   = document.getElementById('game-canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x9ec0d0);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x9ec0d0, 70, 200);

    this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 400);
    this.camera.position.set(18, 14, -16);
    this.camera.lookAt(0, 3, 35);

    this._setupLights();
    this._setupWorld();

    this.cannon      = new Cannon(this.scene);
    this.projectiles = [];
    this.ships       = [];
    this.fx          = [];

    this.audio       = new AudioFX();
    this.input       = new Input(this.canvas);
    this.hud         = new HUD();
    this.waveManager = new WaveManager(this);

    this.score             = 0;
    this.lives             = BALANCE.player.startLives;
    this.gameOver          = false;
    this._pendingGameOver  = false;
    this.paused            = false;
    this.debug             = false;
    this.aimHelper         = false;

    this._aimMarker = this._mkCrosshair(0xfff066);
    this._aimMarker.visible = false;
    this._interceptMarkers = [];

    this._bindUI();
    window.addEventListener('resize', () => this._onResize());

    this.clock = new THREE.Clock();
    this.waveManager.start();
    this.hud.update(this);

    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  // ---------- сетап сцени ----------
  _setupLights() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.45));
    const dir = new THREE.DirectionalLight(0xffffff, 0.85);
    dir.position.set(20, 40, -10);
    this.scene.add(dir);
    this.scene.add(new THREE.HemisphereLight(0xa0c8d8, 0x2a4a30, 0.45));
  }

  _setupWorld() {
    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400, 1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: 0x2d5e7a })
    );
    this.scene.add(sea);

    const shore = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 30).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: 0xc6ad75 })
    );
    shore.position.set(0, 0.05, -16);
    this.scene.add(shore);

    const mound = new THREE.Mesh(
      new THREE.CylinderGeometry(3, 4, 0.6, 18),
      new THREE.MeshLambertMaterial({ color: 0xa68c5a })
    );
    mound.position.set(0, 0.3, 0);
    this.scene.add(mound);

    this._buildBlindZoneLine();

    const hillMat = new THREE.MeshLambertMaterial({ color: 0x44603a });
    for (let i = -3; i <= 3; i++) {
      const h = new THREE.Mesh(
        new THREE.ConeGeometry(rand(10, 18), rand(8, 14), 6),
        hillMat
      );
      h.position.set(i * 28 + rand(-4, 4), 0, rand(110, 130));
      this.scene.add(h);
    }
  }

  // Computes where a shot fired at minPitch (flattest angle) lands for every yaw in [-maxYaw, +maxYaw].
  // The arc shows the minimum landing range — ships closer than this curve can only be hit
  // while the projectile is still in flight (it passes through them before landing).
  _buildBlindZoneLine() {
    const { maxYaw, minPitch } = BALANCE.cannon;
    const g  = BALANCE.gravity;
    const v0 = BALANCE.projectileSpeed;
    // Approximate muzzle height at low pitch (pitchPivot y≈2.15, barrel mostly forward)
    const y0 = 2.5;
    const N  = 64;

    const pts = [];
    for (let i = 0; i <= N; i++) {
      const yaw = lerp(-maxYaw, maxYaw, i / N);
      const vx  = v0 * Math.cos(minPitch) * Math.sin(yaw);
      const vy  = v0 * Math.sin(minPitch);
      const vz  = v0 * Math.cos(minPitch) * Math.cos(yaw);
      const t   = (vy + Math.sqrt(vy * vy + 2 * g * y0)) / g;
      pts.push(new THREE.Vector3(vx * t, 0.1, vz * t));
    }

    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineDashedMaterial({
      color: 0x00e040,
      dashSize: 2.5,
      gapSize: 1.5,
    });
    const line = new THREE.Line(geo, mat);
    line.computeLineDistances();
    this.scene.add(line);
  }

  _mkCrosshair(color) {
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color });
    const armX = new THREE.Mesh(new THREE.BoxGeometry(4.5, 0.06, 0.45), mat);
    const armZ = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.06, 4.5), mat);
    group.add(armX);
    group.add(armZ);
    this.scene.add(group);
    return group;
  }

  _bindUI() {
    document.getElementById('btn-pause')           .addEventListener('click', () => this.togglePause());
    document.getElementById('btn-aim')             .addEventListener('click', () => this.toggleAimHelper());
    document.getElementById('btn-debug')           .addEventListener('click', () => this.toggleDebug());
    document.getElementById('btn-restart')         .addEventListener('click', () => this.restart());
    document.getElementById('btn-resume')          .addEventListener('click', () => this.togglePause());
    document.getElementById('btn-restart-overlay') .addEventListener('click', () => this.restart());

    window.addEventListener('keydown', (e) => {
      if      (e.code === 'KeyP') this.togglePause();
      else if (e.code === 'KeyA') this.toggleAimHelper();
      else if (e.code === 'KeyD') this.toggleDebug();
      else if (e.code === 'KeyR') this.restart();
    });
  }

  // ---------- стани гри ----------
  togglePause() {
    if (this.gameOver) return;
    this.paused = !this.paused;
    document.getElementById('pause-overlay').classList.toggle('hidden', !this.paused);
  }

  toggleDebug() {
    this.debug = !this.debug;
    document.getElementById('btn-debug').classList.toggle('active', this.debug);
    if (!this.debug) this._clearInterceptMarkers();
  }

  toggleAimHelper() {
    this.aimHelper = !this.aimHelper;
    document.getElementById('btn-aim').classList.toggle('active', this.aimHelper);
    if (!this.aimHelper) this._aimMarker.visible = false;
  }

  restart() {
    for (const p of this.projectiles) p.dispose();
    for (const s of this.ships) s.dispose();
    for (const f of this.fx) f.dispose();
    this._clearInterceptMarkers();
    this.projectiles.length = 0;
    this.ships.length       = 0;
    this.fx.length          = 0;

    this.cannon.cooldown   = 0;
    this.score             = 0;
    this.lives             = BALANCE.player.startLives;
    this.gameOver          = false;
    this._pendingGameOver  = false;
    this.paused            = false;

    document.getElementById('pause-overlay').classList.add('hidden');
    document.getElementById('gameover-overlay').classList.add('hidden');

    this.waveManager = new WaveManager(this);
    this.waveManager.start();
    this.hud.update(this);
  }

  onWaveStart(wave) {
    this.hud.flash(`ХВИЛЯ ${wave}`);
    this.hud.update(this);
  }

  _onGameOver() {
    this.gameOver = true;
    document.getElementById('final-score').textContent = String(this.score);
    document.getElementById('final-wave').textContent  = String(this.waveManager.wave);
    document.getElementById('gameover-overlay').classList.remove('hidden');
  }

  // ---------- допоміжне ----------
  _clearInterceptMarkers() {
    for (const m of this._interceptMarkers) {
      this.scene.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    this._interceptMarkers.length = 0;
  }

  // ---------- update-блоки ----------
  _aim(dt) {
    if (this.input.lastInput === 'mouse') {
      const m = this.input.mouseNDC;
      // Камера дивиться в +Z, тому screen-right відповідає world -X.
      // Інвертуємо, щоб мишка вправо → ствол візуально вправо.
      const targetYaw = clamp(
        -m.x * BALANCE.cannon.maxYaw,
        -BALANCE.cannon.maxYaw, BALANCE.cannon.maxYaw
      );
      const targetPitch = lerp(
        BALANCE.cannon.minPitch, BALANCE.cannon.maxPitch,
        clamp(0.5 + m.y * 0.5, 0, 1)
      );
      const k = 1 - Math.exp(-dt * BALANCE.cannon.mouseSmoothing);
      this.cannon.yaw   = lerp(this.cannon.yaw,   targetYaw,   k);
      this.cannon.pitch = lerp(this.cannon.pitch, targetPitch, k);
    } else {
      const k = this.input.keys;
      let dyaw = 0, dpitch = 0;
      if (k['ArrowLeft'])  dyaw   += 1;
      if (k['ArrowRight']) dyaw   -= 1;
      if (k['ArrowUp'])    dpitch += 1;
      if (k['ArrowDown'])  dpitch -= 1;
      this.cannon.yaw = clamp(
        this.cannon.yaw + dyaw * BALANCE.cannon.aimSpeed * dt,
        -BALANCE.cannon.maxYaw, BALANCE.cannon.maxYaw
      );
      this.cannon.pitch = clamp(
        this.cannon.pitch + dpitch * BALANCE.cannon.aimSpeed * dt,
        BALANCE.cannon.minPitch, BALANCE.cannon.maxPitch
      );
    }
  }

  _tryFire() {
    if (this.gameOver || this.paused) return;
    const shot = this.cannon.fire();
    if (!shot) return;
    this.projectiles.push(new Projectile(this.scene, shot.position, shot.velocity));
    this.audio.shot();
  }

  _checkCollisions() {
    const center = new THREE.Vector3();
    for (const p of this.projectiles) {
      if (!p.alive) continue;
      for (const s of this.ships) {
        if (!s.alive) continue;
        s.collisionCenter(center);
        const r = s.def.radius + p.radius;
        if (center.distanceToSquared(p.position) <= r * r) {
          p.alive = false;
          s.alive = false;
          this.score += s.def.score;
          this.fx.push(new Explosion(this.scene, center, Math.max(1, s.def.radius / 3)));
          this.audio.boom();
          this.waveManager.onShipRemoved();
          break;
        }
      }
    }
  }

  _cleanup() {
    this.projectiles = this.projectiles.filter((p) => {
      if (p.alive) return true;
      if (p.position.y <= 0.2) {
        this.fx.push(new Splash(this.scene, p.position));
        this.audio.splash();
      }
      p.dispose();
      return false;
    });

    this.ships = this.ships.filter((s) => {
      if (s.alive) return true;
      if (s.escaped) {
        this.lives--;
        this.waveManager.onShipRemoved();
        this.hud.flash('УПУЩЕНО −1', 900);
        if (this.lives <= 0 && !this._pendingGameOver) {
          this._pendingGameOver = true;
          this.hud.flash('ОСТАННІ ЦІЛІ', 1800);
        }
      }
      s.dispose();
      return false;
    });

    this.fx = this.fx.filter((f) => {
      if (f.alive) return true;
      f.dispose();
      return false;
    });
  }

  // Хрестик на воді: куди впаде поточний постріл (симуляція балістики).
  _updateAimHelper() {
    if (!this.aimHelper) return;
    const pos = this.cannon.muzzlePosition();
    const vel = this.cannon.aimDirection().multiplyScalar(BALANCE.projectileSpeed);
    const step = 0.04;
    let landed = false;
    for (let t = 0; t < 8 && !landed; t += step) {
      vel.y -= BALANCE.gravity * step;
      pos.addScaledVector(vel, step);
      if (pos.y <= 0) landed = true;
    }
    this._aimMarker.position.set(pos.x, 0.06, pos.z);
    this._aimMarker.visible = landed;
  }

  // Маркери перехоплення для кожного корабля.
  _updateInterceptMarkers() {
    if (!this.debug) return;
    this._clearInterceptMarkers();
    for (const s of this.ships) {
      if (!s.alive) continue;
      const ip = predictIntercept(
        this.cannon.position, BALANCE.projectileSpeed, s.position, s.velocity
      );
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.45, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xff5599, transparent: true, opacity: 0.85 })
      );
      m.position.copy(ip);
      m.position.y = Math.max(0.4, ip.y);
      this.scene.add(m);
      this._interceptMarkers.push(m);
    }
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  update(dt) {
    this._aim(dt);
    if (this.input.consumeFire()) this._tryFire();
    this.cannon.update(dt);
    for (const p of this.projectiles) p.update(dt);
    for (const s of this.ships)       s.update(dt);
    for (const f of this.fx)          f.update(dt);
    this._checkCollisions();
    this._cleanup();
    // У pending-стані не спавнимо нових кораблів — даємо догратися поточним.
    if (!this._pendingGameOver) this.waveManager.update(dt);
    if (this._pendingGameOver && this.ships.length === 0 && this.projectiles.length === 0) {
      this._onGameOver();
    }
    this._updateAimHelper();
    this._updateInterceptMarkers();
    this.hud.update(this);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  _loop() {
    requestAnimationFrame(this._loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    if (!this.paused && !this.gameOver) this.update(dt);
    this.render();
  }
}

new Game();
