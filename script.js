import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js';

/* =============================================================================
   BIRTHDAY FLIGHT
   A non-competitive 3D flight journey: fly a toy biplane through a magical
   sky full of puffy clouds, pass through a glowing stone portal, and arrive
   at a cloud world with a birthday cake to blow out — set to a birthday song
   with synced lyric subtitles during the flight.
   ============================================================================= */

/* ----------------------------- Config ----------------------------------- */

const isMobileUA = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || window.innerWidth < 860;
const CORES = navigator.hardwareConcurrency || 4;

const QUALITY = (() => {
  const dpr = window.devicePixelRatio || 1;
  let tier = 'high';
  if (isMobileUA && (CORES <= 4 || dpr > 2.2)) tier = 'low';
  else if (isMobileUA) tier = 'medium';
  const table = {
    low:    { cloudsFar: 7,  cloudsNear: 5,  dust: 70,  fireflies: 24, guides: 36, pixelRatio: 1.25 },
    medium: { cloudsFar: 11, cloudsNear: 7,  dust: 130, fireflies: 34, guides: 56, pixelRatio: 1.5 },
    high:   { cloudsFar: 15, cloudsNear: 10, dust: 190, fireflies: 40, guides: 76, pixelRatio: 1.75 },
  };
  return { tier, ...table[tier] };
})();

const BASE_SPEED = 9;                 // world units / second the plane "flies"
const MOVE_BOUNDS = { x: 6.2, y: 4.3 };
const MAX_ROLL = THREE.MathUtils.degToRad(32);
const MAX_PITCH = THREE.MathUtils.degToRad(18);
const PORTAL_TOTAL_DISTANCE = 1300;   // distance travelled before reaching the portal (~144s @ BASE_SPEED)
const ASSIST_RANGE = 140;             // auto-assist begins this far from the portal
const TRIGGER_RANGE = 20;             // hard transition begins this far from the portal
const CANDLE_COUNT = 5;

const ASSET_URLS = {
  portalModel: 'assets/portal/portal.glb',
  portalTexture: 'assets/portal/baked.jpg',
  music: 'assets/audio/music.mp3',
};

const PHASE = {
  FLIGHT: 'flight',
  TRANSITION: 'transition',
  ARRIVAL: 'arrival',
  CANDLES: 'candles',
  CELEBRATION: 'celebration',
};

/* -------------------------- Lyric subtitles ------------------------------- */
/* Sentence-level timing derived from the provided transcript JSON. */
const LYRICS = [
  { start: 28.46,  end: 34.52,  text: "Hari ini hari ulang tahunmu." },
  { start: 35.76,  end: 41.18,  text: "Bertambah satu tahun usiamu." },
  { start: 43.36,  end: 49.30,  text: "Kudoakan bahagia selalu untukmu." },
  { start: 50.52,  end: 55.28,  text: "Tercapai segala cita-citamu." },
  { start: 57.04,  end: 64.46,  text: "Selamat ulang tahun ku ucapkan untukmu." },
  { start: 65.00,  end: 71.48,  text: "Semoga bahagia kan mengiringi langkahmu." },
  { start: 71.94,  end: 84.60,  text: "Tiada yang bisa kuberi, hanyalah doa dan rasa cinta yang tulus dariku 'tuk dirimu." },
  { start: 105.10, end: 112.40, text: "Selamat ulang tahun ku ucapkan untukmu." },
  { start: 113.08, end: 119.44, text: "Semoga bahagia kan mengiringi langkahmu." },
  { start: 119.90, end: 132.58, text: "Tiada yang bisa kuberi, hanyalah doa dan rasa cinta yang tulus dariku 'tuk dirimu." },
  { start: 138.64, end: 143.88, text: "Hanyalah doa dan cinta 'tuk dirimu." },
];

/* ----------------------------- Globals ----------------------------------- */

let renderer, camera;
let flightScene, cloudScene;
let activeScene;
let clock = { last: null, elapsed: 0 };

let plane, bankPivot, pitchPivot, propeller, wingL, wingR;
const planePos = new THREE.Vector3(0, 0, 0);

let inputX = 0, inputY = 0;
let rawTargetX = 0, rawTargetY = 0;
let pointerActive = false;
let pointerStart = { x: 0, y: 0 };
const keys = {};

let totalDistance = 0;
let phase = PHASE.FLIGHT;

let portalGroup, portalDisc, portalLight, portalFireflies;
let flightPools = [];
let smokePuffs = [];

let cloudWorldBuilt = false;
let islandGroup, cakeGroup, candles = [];
let cameraMode = 'follow';
let cinematic = null;
let orbitAngle = 0;

let planeOrbit = { active: false, angle: 0, radius: 3.3, center: new THREE.Vector3(0, 0.4, -14), height: 1.7 };

let camPos = new THREE.Vector3(0, 2.6, 9);
let camLookAt = new THREE.Vector3(0, 0.5, -20);

let audioCtx, analyser, micData, micReady = false;
let lastBlowTime = 0;

let bgm, flightClockStart = null;
let subtitleEl, subtitleTextEl;
let currentLyricIndex = -1;

/* ----------------------------- Small utils -------------------------------- */

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const lerp = THREE.MathUtils.lerp;
const expAlpha = (rate, delta) => 1 - Math.exp(-rate * delta);

function makeRadialTexture(inner, outer, size = 64) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

const glowTex = makeRadialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)');
const goldGlowTex = makeRadialTexture('rgba(255,224,150,1)', 'rgba(255,180,90,0)');
const blueGlowTex = makeRadialTexture('rgba(190,225,255,1)', 'rgba(120,170,255,0)');
const smokeTex = makeRadialTexture('rgba(230,230,230,0.9)', 'rgba(230,230,230,0)');

function buildSkyDome(topHex, bottomHex, radius = 480) {
  const geo = new THREE.SphereGeometry(radius, 20, 16);
  const pos = geo.attributes.position;
  const colorsArr = new Float32Array(pos.count * 3);
  const top = new THREE.Color(topHex);
  const bottom = new THREE.Color(bottomHex);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = clamp01((pos.getY(i) / radius) * 0.55 + 0.48);
    c.copy(bottom).lerp(top, t);
    colorsArr[i * 3] = c.r; colorsArr[i * 3 + 1] = c.g; colorsArr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colorsArr, 3));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false });
  return new THREE.Mesh(geo, mat);
}

/* =============================================================================
   RENDERER / CAMERA
   ============================================================================= */

function setupRenderer() {
  const canvas = document.querySelector('#scene');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY.pixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 900);
  camera.position.copy(camPos);

  window.addEventListener('resize', onResize, { passive: true });
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY.pixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
}

/* =============================================================================
   PUFFY CLOUDS  (ported from the provided "3D Cloud Gallery" reference)
   ============================================================================= */

const PUFF_GEO = new THREE.SphereGeometry(1, 14, 10);

const cloudMaterials = {
  white: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, transparent: true, opacity: 0.95, flatShading: false }),
  soft:  new THREE.MeshStandardMaterial({ color: 0xfafcff, roughness: 1, transparent: true, opacity: 0.82, depthWrite: false }),
  dusk:  new THREE.MeshStandardMaterial({ color: 0xdfeeff, roughness: 0.95, transparent: true, opacity: 0.9, emissive: 0x2a3f73, emissiveIntensity: 0.16 }),
};

function puff(group, x, y, z, sx, sy, sz, material) {
  const mesh = new THREE.Mesh(PUFF_GEO, material);
  mesh.position.set(x, y, z);
  mesh.scale.set(sx, sy, sz);
  group.add(mesh);
  return mesh;
}

function createCumulus(material, scale = 1) {
  const group = new THREE.Group();
  puff(group, -7, 0, 0, 7, 5, 5, material);
  puff(group, 0, 1, 0, 9, 6, 6, material);
  puff(group, 8, 0, 0, 7, 5, 5, material);
  puff(group, -3, 5, 0, 5, 6, 5, material);
  puff(group, 3, 6, 0, 6, 7, 6, material);
  puff(group, 8, 4, 1, 4, 4, 4, material);
  group.scale.setScalar(scale);
  return group;
}

function createGiantCloud(material, scale = 1) {
  const group = new THREE.Group();
  const parts = [
    [-15, 0, 0, 9, 5, 6], [-9, 2, 0, 10, 7, 7], [0, 4, 0, 13, 9, 8],
    [10, 2, 0, 11, 7, 7], [17, 0, 0, 8, 5, 6], [-3, 10, 0, 9, 8, 7],
    [7, 9, 1, 8, 7, 6], [0, 14, 0, 6, 6, 5],
  ];
  for (const p of parts) puff(group, p[0], p[1], p[2], p[3], p[4], p[5], material);
  group.scale.setScalar(scale);
  return group;
}

function createLongCloud(material, scale = 1) {
  const group = new THREE.Group();
  for (let i = 0; i < 12; i++) {
    const x = (i - 5.5) * 5;
    const y = Math.sin(i * 0.8) * 1.5;
    const s = 3 + Math.sin(i * 1.7) * 1;
    puff(group, x, y, Math.sin(i) * 1, s * 1.7, s, s, material);
  }
  group.scale.setScalar(scale);
  return group;
}

const CLOUD_VARIANTS = [createCumulus, createGiantCloud, createLongCloud];

function randomCloud(material, scale) {
  const fn = CLOUD_VARIANTS[Math.floor(Math.random() * CLOUD_VARIANTS.length)];
  return fn(material, scale);
}

/* Recyclable pool of whole cloud groups (position-only recycling). */
function createCloudPool(count, opts) {
  const { material, scaleRange, xRange, yRange, poolDepth, wrapAt, speedScale = 1 } = opts;
  const items = [];
  const scene = opts.scene;
  for (let i = 0; i < count; i++) {
    const scale = THREE.MathUtils.randFloat(scaleRange[0], scaleRange[1]);
    const group = randomCloud(material, scale);
    group.rotation.y = Math.random() * Math.PI * 2;
    group.position.set(
      THREE.MathUtils.randFloatSpread(xRange),
      THREE.MathUtils.randFloat(yRange[0], yRange[1]),
      -Math.random() * poolDepth,
    );
    scene.add(group);
    items.push({ group, baseY: group.position.y, phase: Math.random() * Math.PI * 2 });
  }
  return {
    items, poolDepth, wrapAt,
    update(delta, speed, elapsed) {
      for (const it of items) {
        it.group.position.z += speed * delta * speedScale;
        if (it.group.position.z > wrapAt) {
          it.group.position.z -= poolDepth;
          it.group.position.x = THREE.MathUtils.randFloatSpread(xRange);
          it.baseY = THREE.MathUtils.randFloat(yRange[0], yRange[1]);
        }
        it.group.position.y = it.baseY + Math.sin(elapsed * 0.3 + it.phase) * 0.4;
        it.group.rotation.y += delta * 0.01;
      }
    },
  };
}

/* =============================================================================
   PLANE  (toy biplane in the visual language of the reference project)
   ============================================================================= */

function buildPlane() {
  const red = new THREE.MeshStandardMaterial({ color: 0xe83c31, roughness: 0.55, flatShading: true });
  const darkRed = new THREE.MeshStandardMaterial({ color: 0xb92625, roughness: 0.62, flatShading: true });
  const cockpitMat = new THREE.MeshStandardMaterial({ color: 0xd9f1f3, roughness: 0.3, metalness: 0.05, flatShading: true });
  const graphite = new THREE.MeshStandardMaterial({ color: 0x22282f, roughness: 0.65, flatShading: true });

  plane = new THREE.Group();
  bankPivot = new THREE.Group();
  pitchPivot = new THREE.Group();
  const visual = new THREE.Group();

  plane.add(bankPivot);
  bankPivot.add(pitchPivot);
  pitchPivot.add(visual);

  const fuselage = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 1.6, 3, 8), red);
  fuselage.rotation.z = Math.PI / 2;
  visual.add(fuselage);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.6, 8), red);
  nose.position.z = -1.1;
  nose.rotation.x = -Math.PI / 2;
  visual.add(nose);

  const tailCone = new THREE.Mesh(new THREE.ConeGeometry(0.3, 1.2, 7), darkRed);
  tailCone.position.z = 1.05;
  tailCone.rotation.x = Math.PI / 2;
  visual.add(tailCone);

  const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.42, 8, 6), cockpitMat);
  cockpit.position.set(0, 0.34, -0.1);
  cockpit.scale.set(1, 0.7, 1.05);
  visual.add(cockpit);

  const wingGeo = new THREE.CapsuleGeometry(0.5, 3.1, 2, 8);
  const upperWing = new THREE.Mesh(wingGeo, red);
  upperWing.position.set(0, 0.62, 0);
  upperWing.rotation.z = Math.PI / 2;
  upperWing.scale.set(0.15, 1, 1.3);
  visual.add(upperWing);
  wingL = upperWing;

  const lowerWing = new THREE.Mesh(wingGeo, darkRed);
  lowerWing.position.set(0, -0.42, 0);
  lowerWing.rotation.z = Math.PI / 2;
  lowerWing.scale.set(0.14, 0.9, 1.2);
  visual.add(lowerWing);
  wingR = lowerWing;

  const strutGeo = new THREE.CylinderGeometry(0.026, 0.026, 1.0, 6);
  const steel = new THREE.MeshStandardMaterial({ color: 0x98a2a6, roughness: 0.55, metalness: 0.2, flatShading: true });
  for (const x of [-0.35, 0.35]) {
    for (const z of [-1.15, 1.15]) {
      const strut = new THREE.Mesh(strutGeo, steel);
      strut.position.set(x, 0.08, z);
      visual.add(strut);
    }
  }

  const tailWing = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 1.05, 2, 7), red);
  tailWing.position.set(0, 0.05, 1.25);
  tailWing.rotation.z = Math.PI / 2;
  tailWing.scale.set(0.14, 1, 1.05);
  visual.add(tailWing);

  const finShape = new THREE.Shape();
  finShape.moveTo(-0.35, 0);
  finShape.lineTo(0.3, 0);
  finShape.lineTo(-0.22, 0.72);
  finShape.closePath();
  const finGeo = new THREE.ExtrudeGeometry(finShape, { depth: 0.1, bevelEnabled: false, steps: 1 });
  finGeo.center();
  finGeo.rotateY(Math.PI / 2);
  const fin = new THREE.Mesh(finGeo, darkRed);
  fin.position.set(0, 0.4, 1.3);
  visual.add(fin);

  propeller = new THREE.Group();
  propeller.position.z = -1.42;
  visual.add(propeller);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.24, 8), graphite);
  hub.rotation.x = Math.PI / 2;
  propeller.add(hub);
  const bladeGeo = new THREE.CapsuleGeometry(0.1, 1.1, 2, 6);
  const bladeA = new THREE.Mesh(bladeGeo, graphite);
  bladeA.scale.set(0.4, 1, 0.16);
  propeller.add(bladeA);
  const bladeB = new THREE.Mesh(bladeGeo, graphite);
  bladeB.rotation.z = Math.PI / 2;
  bladeB.scale.set(0.4, 1, 0.16);
  propeller.add(bladeB);

  visual.scale.setScalar(0.85);
  plane.position.copy(planePos);
  flightScene.add(plane);
}

function updatePlane(delta, elapsed) {
  let kbX = 0, kbY = 0;
  if (keys['ArrowLeft'] || keys['a'] || keys['A']) kbX -= 1;
  if (keys['ArrowRight'] || keys['d'] || keys['D']) kbX += 1;
  if (keys['ArrowUp'] || keys['w'] || keys['W']) kbY += 1;
  if (keys['ArrowDown'] || keys['s'] || keys['S']) kbY -= 1;

  let targetX = 0, targetY = 0;
  if (pointerActive) {
    targetX = rawTargetX;
    targetY = rawTargetY;
  } else if (kbX !== 0 || kbY !== 0) {
    targetX = kbX;
    targetY = kbY;
  }

  inputX = lerp(inputX, targetX, expAlpha(6, delta));
  inputY = lerp(inputY, targetY, expAlpha(6, delta));

  const remaining = PORTAL_TOTAL_DISTANCE - totalDistance;
  let controlWeight = 1;
  if (phase === PHASE.FLIGHT && remaining < ASSIST_RANGE) {
    const assistT = clamp01(1 - remaining / ASSIST_RANGE);
    controlWeight = 1 - assistT * 0.92;
    if (remaining < TRIGGER_RANGE) {
      beginPortalTransition();
    }
  }
  if (phase !== PHASE.FLIGHT) controlWeight = 0;

  const targetOffX = inputX * MOVE_BOUNDS.x * controlWeight;
  const targetOffY = inputY * MOVE_BOUNDS.y * controlWeight;

  planePos.x = lerp(planePos.x, targetOffX, expAlpha(3.4, delta));
  planePos.y = lerp(planePos.y, targetOffY, expAlpha(3.4, delta));
  plane.position.x = planePos.x;
  plane.position.y = planePos.y + Math.sin(elapsed * 1.6) * 0.06;

  const roll = -inputX * MAX_ROLL * controlWeight;
  const pitch = inputY * MAX_PITCH * controlWeight;
  bankPivot.rotation.z = lerp(bankPivot.rotation.z, roll, expAlpha(6, delta));
  pitchPivot.rotation.x = lerp(pitchPivot.rotation.x, pitch, expAlpha(6, delta));

  propeller.rotation.z += delta * 34;
  wingL.rotation.x = Math.sin(elapsed * 3.1) * 0.02;
  wingR.rotation.x = Math.sin(elapsed * 3.1 + 1) * 0.02;

  if (phase === PHASE.FLIGHT) {
    totalDistance += BASE_SPEED * delta;
  }

  return { remaining };
}

/* Continuous circling flight beside the cake once the plane arrives. */
function updatePlaneOrbit(delta, elapsed) {
  if (!planeOrbit.active) return;
  planeOrbit.angle += delta * 0.5;
  const cx = planeOrbit.center.x + Math.cos(planeOrbit.angle) * planeOrbit.radius;
  const cz = planeOrbit.center.z + Math.sin(planeOrbit.angle) * planeOrbit.radius;
  const cy = planeOrbit.center.y + planeOrbit.height + Math.sin(elapsed * 1.3) * 0.08;

  plane.position.set(cx, cy, cz);
  const tangent = new THREE.Vector3(-Math.sin(planeOrbit.angle), 0, Math.cos(planeOrbit.angle));
  plane.lookAt(cx + tangent.x, cy, cz + tangent.z);

  bankPivot.rotation.z = lerp(bankPivot.rotation.z, -0.4, expAlpha(3, delta));
  pitchPivot.rotation.x = lerp(pitchPivot.rotation.x, 0, expAlpha(3, delta));
  propeller.rotation.z += delta * 34;
  wingL.rotation.x = Math.sin(elapsed * 3.1) * 0.02;
  wingR.rotation.x = Math.sin(elapsed * 3.1 + 1) * 0.02;
}

/* =============================================================================
   RECYCLABLE POINT POOLS (dust / guiding sparkles)
   ============================================================================= */

function createPointPool(count, material, spawn, opts = {}) {
  const positions = new Float32Array(count * 3);
  const items = [];
  for (let i = 0; i < count; i++) {
    const item = { x: 0, y: 0, z: 0 };
    spawn(item, true);
    items.push(item);
    positions[i * 3] = item.x; positions[i * 3 + 1] = item.y; positions[i * 3 + 2] = item.z;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  const pool = {
    points, items,
    poolDepth: opts.poolDepth || 160,
    wrapAt: opts.wrapAt ?? 6,
    update(delta, speed) {
      const pos = geo.attributes.position;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        it.z += speed * delta * (opts.speedScale ?? 1);
        if (it.z > this.wrapAt) {
          it.z -= this.poolDepth;
          spawn(it, false);
        }
        pos.setXYZ(i, it.x, it.y, it.z);
      }
      pos.needsUpdate = true;
    },
  };
  return pool;
}

/* =============================================================================
   FLIGHT WORLD (portal-journey sky)
   ============================================================================= */

function buildFlightWorld() {
  flightScene = new THREE.Scene();
  flightScene.fog = new THREE.FogExp2(0x24407a, 0.009);
  flightScene.add(buildSkyDome(0x11224f, 0x6fa9d8, 480));

  const hemi = new THREE.HemisphereLight(0xbcd8ff, 0x1c2c55, 1.6);
  flightScene.add(hemi);
  const key = new THREE.DirectionalLight(0xcfe6ff, 1.4);
  key.position.set(-6, 10, 4);
  flightScene.add(key);
  const rim = new THREE.DirectionalLight(0x9fd0ff, 0.7);
  rim.position.set(5, -2, -6);
  flightScene.add(rim);

  // wide sky "floor" far below, echoing the reference gallery's ground plane
  const floorMat = new THREE.MeshBasicMaterial({ color: 0x162a52, fog: true, transparent: true, opacity: 0.9 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -85;
  flightScene.add(floor);

  const poolDepth = 190;

  const farPool = createCloudPool(QUALITY.cloudsFar, {
    scene: flightScene, material: cloudMaterials.dusk,
    scaleRange: [0.55, 1.1], xRange: 70, yRange: [-38, -14],
    poolDepth, wrapAt: 10, speedScale: 0.55,
  });
  const nearPool = createCloudPool(QUALITY.cloudsNear, {
    scene: flightScene, material: cloudMaterials.white,
    scaleRange: [0.16, 0.34], xRange: 30, yRange: [-8, 8],
    poolDepth, wrapAt: 6, speedScale: 1,
  });

  const dustMat = new THREE.PointsMaterial({
    size: 0.32, map: glowTex, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, color: 0xbfe0ff, opacity: 0.8,
  });
  const dustPool = createPointPool(QUALITY.dust, dustMat, (it, init) => {
    it.x = THREE.MathUtils.randFloatSpread(30);
    it.y = THREE.MathUtils.randFloat(-14, 12);
    it.z = init ? -Math.random() * poolDepth : it.z;
  }, { poolDepth, wrapAt: 4 });

  const guideMat = new THREE.PointsMaterial({
    size: 0.5, map: goldGlowTex, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, color: 0xffe1a0, opacity: 0.95,
  });
  const guidePool = createPointPool(QUALITY.guides, guideMat, (it, init) => {
    it.z = init ? -Math.random() * poolDepth : it.z;
    it.x = Math.sin(it.z * 0.045) * 3.2;
    it.y = Math.cos(it.z * 0.03) * 1.6 + 0.6;
  }, { poolDepth, wrapAt: 4 });
  guidePool.isGuide = true;

  flightPools = [
    { update: (d, s, e) => farPool.update(d, s, e) },
    { update: (d, s, e) => nearPool.update(d, s, e) },
    dustPool,
    guidePool,
  ];
  flightScene.add(dustPool.points);
  flightScene.add(guidePool.points);
}

function updateFlightWorld(delta, elapsed, speed) {
  for (const p of flightPools) {
    if (!p.update) continue;
    p.update(delta, speed, elapsed);
    if (p.isGuide) {
      const pos = p.points.geometry.attributes.position;
      for (let i = 0; i < p.items.length; i++) {
        const it = p.items[i];
        it.x = Math.sin(it.z * 0.045 + elapsed * 0.15) * 3.2;
        it.y = Math.cos(it.z * 0.03) * 1.6 + 0.6;
        pos.setXYZ(i, it.x, it.y, it.z);
      }
      pos.needsUpdate = true;
    }
  }
  updateSmokePuffs(delta);
}

/* --------------------------------- Portal ----------------------------------
   Loaded directly from threejs-portal-master's own portal.glb + baked.jpg,
   using the project's exact portal + fireflies shaders so the shape, texture
   and glow match the source one-to-one.
   ---------------------------------------------------------------------------- */

const PORTAL_VERT = `
  varying vec2 vUv;
  void main() {
    vec4 modelPosition = modelMatrix * vec4(position, 1.0);
    vec4 viewPosition = viewMatrix * modelPosition;
    gl_Position = projectionMatrix * viewPosition;
    vUv = uv;
  }
`;
const PORTAL_FRAG = `
  uniform float uTime;
  uniform vec3 uInnerColor;
  uniform vec3 uOuterColor;
  uniform float uAlpha;
  uniform float uOffset;
  varying vec2 vUv;

  vec4 permute(vec4 x) { return mod(((x*34.0)+1.0)*x, 289.0); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
  vec3 fade(vec3 t) { return t*t*t*(t*(t*6.0-15.0)+10.0); }

  float cnoise(vec3 P) {
    vec3 Pi0 = floor(P);
    vec3 Pi1 = Pi0 + vec3(1.0);
    Pi0 = mod(Pi0, 289.0);
    Pi1 = mod(Pi1, 289.0);
    vec3 Pf0 = fract(P);
    vec3 Pf1 = Pf0 - vec3(1.0);
    vec4 ix = vec4(Pi0.x, Pi1.x, Pi0.x, Pi1.x);
    vec4 iy = vec4(Pi0.yy, Pi1.yy);
    vec4 iz0 = Pi0.zzzz;
    vec4 iz1 = Pi1.zzzz;

    vec4 ixy = permute(permute(ix) + iy);
    vec4 ixy0 = permute(ixy + iz0);
    vec4 ixy1 = permute(ixy + iz1);

    vec4 gx0 = ixy0 / 7.0;
    vec4 gy0 = fract(floor(gx0) / 7.0) - 0.5;
    gx0 = fract(gx0);
    vec4 gz0 = vec4(0.5) - abs(gx0) - abs(gy0);
    vec4 sz0 = step(gz0, vec4(0.0));
    gx0 -= sz0 * (step(0.0, gx0) - 0.5);
    gy0 -= sz0 * (step(0.0, gy0) - 0.5);

    vec4 gx1 = ixy1 / 7.0;
    vec4 gy1 = fract(floor(gx1) / 7.0) - 0.5;
    gx1 = fract(gx1);
    vec4 gz1 = vec4(0.5) - abs(gx1) - abs(gy1);
    vec4 sz1 = step(gz1, vec4(0.0));
    gx1 -= sz1 * (step(0.0, gx1) - 0.5);
    gy1 -= sz1 * (step(0.0, gy1) - 0.5);

    vec3 g000 = vec3(gx0.x,gy0.x,gz0.x);
    vec3 g100 = vec3(gx0.y,gy0.y,gz0.y);
    vec3 g010 = vec3(gx0.z,gy0.z,gz0.z);
    vec3 g110 = vec3(gx0.w,gy0.w,gz0.w);
    vec3 g001 = vec3(gx1.x,gy1.x,gz1.x);
    vec3 g101 = vec3(gx1.y,gy1.y,gz1.y);
    vec3 g011 = vec3(gx1.z,gy1.z,gz1.z);
    vec3 g111 = vec3(gx1.w,gy1.w,gz1.w);

    vec4 norm0 = taylorInvSqrt(vec4(dot(g000,g000), dot(g010,g010), dot(g100,g100), dot(g110,g110)));
    g000 *= norm0.x; g010 *= norm0.y; g100 *= norm0.z; g110 *= norm0.w;
    vec4 norm1 = taylorInvSqrt(vec4(dot(g001,g001), dot(g011,g011), dot(g101,g101), dot(g111,g111)));
    g001 *= norm1.x; g011 *= norm1.y; g101 *= norm1.z; g111 *= norm1.w;

    float n000 = dot(g000, Pf0);
    float n100 = dot(g100, vec3(Pf1.x, Pf0.yz));
    float n010 = dot(g010, vec3(Pf0.x, Pf1.y, Pf0.z));
    float n110 = dot(g110, vec3(Pf1.xy, Pf0.z));
    float n001 = dot(g001, vec3(Pf0.xy, Pf1.z));
    float n101 = dot(g101, vec3(Pf1.x, Pf0.y, Pf1.z));
    float n011 = dot(g011, vec3(Pf0.x, Pf1.yz));
    float n111 = dot(g111, Pf1);

    vec3 fade_xyz = fade(Pf0);
    vec4 n_z = mix(vec4(n000,n100,n010,n110), vec4(n001,n101,n011,n111), fade_xyz.z);
    vec2 n_yz = mix(n_z.xy, n_z.zw, fade_xyz.y);
    float n_xyz = mix(n_yz.x, n_yz.y, fade_xyz.x);
    return 2.2 * n_xyz;
  }

  void main() {
    vec2 displacedUv = vUv + cnoise(vec3(vUv * 5.0, uTime * 0.1));
    float strength = cnoise(vec3(displacedUv * 5.0, uTime * 0.2));
    float outerGlow = distance(vUv, vec2(0.5)) * 5.0 - uOffset;
    strength += outerGlow;
    strength += step(-0.2, strength) * 0.8;
    strength = clamp(strength, 0.0, 1.0);
    vec4 innerColor = vec4(uInnerColor, uAlpha);
    vec4 outerColor = vec4(uOuterColor, 1.0);
    gl_FragColor = mix(innerColor, outerColor, strength);
  }
`;

const FIREFLY_VERT = `
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uSize;
  attribute float aScale;
  void main() {
    vec4 modelPosition = modelMatrix * vec4(position, 1.0);
    modelPosition.y += sin(uTime + modelPosition.x * 100.0) * aScale * 0.2;
    vec4 viewPosition = viewMatrix * modelPosition;
    gl_Position = projectionMatrix * viewPosition;
    gl_PointSize = uSize * aScale * uPixelRatio;
    gl_PointSize *= (1.0 / -viewPosition.z);
  }
`;
const FIREFLY_FRAG = `
  void main() {
    float distanceToCenter = distance(gl_PointCoord, vec2(0.5));
    float strength = 0.05 / distanceToCenter - 0.1 * 2.0;
    gl_FragColor = vec4(1.0, 1.0, 1.0, strength);
  }
`;

function loadPortalAsset(onProgress) {
  return new Promise((resolve, reject) => {
    const manager = new THREE.LoadingManager();
    manager.onProgress = (_url, loaded, total) => onProgress?.(loaded / total);

    const textureLoader = new THREE.TextureLoader(manager);
    const gltfLoader = new GLTFLoader(manager);

    let bakedTexture, gltf;
    let pending = 2;
    const done = () => { if (--pending === 0) resolve({ bakedTexture, gltf }); };

    textureLoader.load(ASSET_URLS.portalTexture, (tex) => { bakedTexture = tex; done(); }, undefined, reject);
    gltfLoader.load(ASSET_URLS.portalModel, (g) => { gltf = g; done(); }, undefined, reject);
  });
}

function buildPortal(bakedTexture, gltf) {
  bakedTexture.flipY = false;
  bakedTexture.colorSpace = THREE.SRGBColorSpace;
  bakedTexture.generateMipmaps = false;
  bakedTexture.minFilter = THREE.NearestFilter;
  bakedTexture.magFilter = THREE.NearestFilter;
  bakedTexture.anisotropy = 8;

  const bakedMat = new THREE.MeshBasicMaterial({ map: bakedTexture });
  const poleLightMat = new THREE.MeshBasicMaterial({ color: 0xfefff0 });
  const portalMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uInnerColor: { value: new THREE.Color(0x000000) },
      uOuterColor: { value: new THREE.Color(0xffffff) },
      uAlpha: { value: 1 },
      uOffset: { value: 2.5 },
    },
    vertexShader: PORTAL_VERT,
    fragmentShader: PORTAL_FRAG,
    transparent: true,
  });

  const model = gltf.scene;
  const materialMap = { baked: bakedMat, poleLightA: poleLightMat, poleLightB: poleLightMat, portalLight: portalMat };
  let portalDiscMesh = null;
  for (const child of model.children) {
    if (materialMap[child.name]) {
      child.material = materialMap[child.name];
      if (child.name === 'portalLight') portalDiscMesh = child;
    }
  }

  model.scale.setScalar(4.6);

  portalGroup = new THREE.Group();
  portalGroup.add(model);
  portalGroup.position.set(0, 0.4, -PORTAL_TOTAL_DISTANCE);
  portalDisc = portalDiscMesh;

  // soft additive halo behind the stone arch to help it read against the sky
  const glowSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: blueGlowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.75,
  }));
  glowSprite.scale.set(16, 16, 1);
  glowSprite.position.y = 2.4;
  portalGroup.add(glowSprite);

  portalLight = new THREE.PointLight(0xfff2d0, 5, 45);
  portalLight.position.set(0, 2.6, 0);
  portalGroup.add(portalLight);

  // exact fireflies port from the reference project
  const count = QUALITY.fireflies;
  const posArr = new Float32Array(count * 3);
  const scaleArr = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    posArr[i * 3 + 0] = (Math.random() - 0.5) * 4;
    posArr[i * 3 + 1] = Math.random() * 0.75 + 0.5;
    posArr[i * 3 + 2] = (Math.random() - 0.5) * 3 + 0.25;
    scaleArr[i] = Math.random();
  }
  const fGeo = new THREE.BufferGeometry();
  fGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  fGeo.setAttribute('aScale', new THREE.BufferAttribute(scaleArr, 1));
  const fMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, QUALITY.pixelRatio) },
      uSize: { value: 180 },
    },
    vertexShader: FIREFLY_VERT,
    fragmentShader: FIREFLY_FRAG,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
  portalFireflies = new THREE.Points(fGeo, fMat);
  portalFireflies.position.y = 2.2;
  portalGroup.add(portalFireflies);

  flightScene.add(portalGroup);
}

function updatePortal(delta, elapsed, remaining) {
  portalGroup.position.z = -remaining;
  if (portalDisc?.material?.uniforms) portalDisc.material.uniforms.uTime.value = elapsed;
  if (portalFireflies) portalFireflies.material.uniforms.uTime.value = elapsed;
  portalGroup.rotation.y = Math.sin(elapsed * 0.05) * 0.05;

  const closeT = clamp01(1 - remaining / ASSIST_RANGE);
  const scale = 1 + closeT * 0.3;
  portalGroup.scale.setScalar(scale);
  if (portalLight) portalLight.intensity = 5 + closeT * 9;
}

/* =============================================================================
   PORTAL TRANSITION
   ============================================================================= */

let transitionStage = 0;
let transitionTimer = 0;

function beginPortalTransition() {
  if (phase !== PHASE.FLIGHT) return;
  phase = PHASE.TRANSITION;
  transitionStage = 0;
  transitionTimer = 0;
  document.getElementById('flight-hud').classList.add('hidden');
}

function updateTransition(delta) {
  transitionTimer += delta;

  if (transitionStage === 0) {
    planePos.x = lerp(planePos.x, 0, expAlpha(3, delta));
    planePos.y = lerp(planePos.y, 1.2, expAlpha(3, delta));
    if (transitionTimer > 1.0) { transitionStage = 1; transitionTimer = 0; }
  } else if (transitionStage === 1) {
    const t = clamp01(transitionTimer / 0.5);
    document.getElementById('flash-overlay').style.opacity = String(t);
    if (t >= 1) {
      switchToCloudWorld();
      transitionStage = 2; transitionTimer = 0;
    }
  } else if (transitionStage === 2) {
    const t = clamp01(transitionTimer / 0.9);
    document.getElementById('flash-overlay').style.opacity = String(1 - t);
    if (t >= 1) {
      transitionStage = 3; transitionTimer = 0;
      phase = PHASE.ARRIVAL;
      beginArrivalCinematic();
    }
  }
}

/* =============================================================================
   CLOUD WORLD (destination) + CAKE
   ============================================================================= */

function buildCloudWorld() {
  cloudScene = new THREE.Scene();
  cloudScene.fog = new THREE.FogExp2(0xbfe0ff, 0.008);
  cloudScene.add(buildSkyDome(0x4fa6e8, 0xffe3b0, 480));

  const hemi = new THREE.HemisphereLight(0xffffff, 0x89b6d8, 1.5);
  cloudScene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3d6, 2.2);
  sun.position.set(-8, 14, 6);
  cloudScene.add(sun);

  const floorMat = new THREE.MeshBasicMaterial({ color: 0x9bdcff, fog: true, transparent: true, opacity: 0.85 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -70;
  cloudScene.add(floor);

  for (let i = 0; i < 16; i++) {
    const scale = THREE.MathUtils.randFloat(0.7, 1.6);
    const cloud = randomCloud(cloudMaterials.white, scale);
    const a = Math.random() * Math.PI * 2;
    const r = 14 + Math.random() * 42;
    cloud.position.set(Math.cos(a) * r, THREE.MathUtils.randFloat(-8, 10), Math.sin(a) * r - 10);
    cloud.rotation.y = Math.random() * Math.PI;
    cloudScene.add(cloud);
  }

  buildIsland();
  buildCake();

  cloudWorldBuilt = true;
}

function buildIsland() {
  islandGroup = new THREE.Group();
  islandGroup.position.set(0, -1, -14);

  const rockMat = new THREE.MeshStandardMaterial({ color: 0x8b6f5c, roughness: 0.95, flatShading: true });
  const grassMat = new THREE.MeshStandardMaterial({ color: 0x7fd694, roughness: 0.85, flatShading: true });

  const rock = new THREE.Mesh(new THREE.ConeGeometry(4.4, 3, 8, 1, true), rockMat);
  rock.rotation.x = Math.PI;
  rock.position.y = -1.2;
  islandGroup.add(rock);

  const top = new THREE.Mesh(new THREE.CylinderGeometry(4.4, 4.6, 0.6, 24), grassMat);
  islandGroup.add(top);

  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const puffMesh = new THREE.Mesh(PUFF_GEO, cloudMaterials.white);
    puffMesh.position.set(Math.cos(a) * 4.2, -2.2 + Math.sin(i) * 0.3, Math.sin(a) * 4.2);
    puffMesh.scale.setScalar(THREE.MathUtils.randFloat(0.9, 1.6));
    islandGroup.add(puffMesh);
  }

  cloudScene.add(islandGroup);
}

function buildCake() {
  cakeGroup = new THREE.Group();
  cakeGroup.position.set(0, 0.35, 0);
  islandGroup.add(cakeGroup);

  const tierColors = [0xffc2d1, 0xffe3ec, 0xfff0f5];
  const radii = [1.9, 1.4, 0.95];
  const heights = [0.55, 0.5, 0.45];
  let y = 0;
  for (let i = 0; i < 3; i++) {
    const mat = new THREE.MeshStandardMaterial({ color: tierColors[i], roughness: 0.55 });
    const tier = new THREE.Mesh(new THREE.CylinderGeometry(radii[i], radii[i] * 1.03, heights[i], 28), mat);
    tier.position.y = y + heights[i] / 2;
    cakeGroup.add(tier);

    const dripMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
    const drip = new THREE.Mesh(new THREE.TorusGeometry(radii[i] * 0.98, 0.08, 8, 24), dripMat);
    drip.rotation.x = Math.PI / 2;
    drip.position.y = y + heights[i];
    cakeGroup.add(drip);

    y += heights[i];
  }

  const sprinkleGeo = new THREE.CapsuleGeometry(0.03, 0.09, 2, 4);
  const sprinkleColors = [0xff8fa3, 0x9fd8ff, 0xffe066, 0xb388eb];
  const sprinkles = new THREE.Group();
  for (let i = 0; i < 60; i++) {
    const mat = new THREE.MeshStandardMaterial({ color: sprinkleColors[i % 4], roughness: 0.5 });
    const s = new THREE.Mesh(sprinkleGeo, mat);
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * 1.8;
    s.position.set(Math.cos(a) * r, 0.02 + Math.random() * 1.5, Math.sin(a) * r);
    s.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    sprinkles.add(s);
  }
  cakeGroup.add(sprinkles);

  buildCandles(y);
}

function buildCandles(topY) {
  candles = [];
  const candleMat = new THREE.MeshStandardMaterial({ color: 0xfff7e0, roughness: 0.5 });
  const stripeMat = new THREE.MeshStandardMaterial({ color: 0xff8fa3, roughness: 0.5 });

  for (let i = 0; i < CANDLE_COUNT; i++) {
    const a = (i / CANDLE_COUNT) * Math.PI * 2;
    const r = 0.55;
    const group = new THREE.Group();
    group.position.set(Math.cos(a) * r, topY, Math.sin(a) * r);

    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.42, 10), i % 2 === 0 ? candleMat : stripeMat);
    body.position.y = 0.21;
    group.add(body);

    const flameGroup = new THREE.Group();
    flameGroup.position.y = 0.44;
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.055, 0.16, 8),
      new THREE.MeshStandardMaterial({ color: 0xffb347, emissive: 0xff9d2e, emissiveIntensity: 2.2, roughness: 0.3 }),
    );
    flame.position.y = 0.08;
    flameGroup.add(flame);

    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: goldGlowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.85 }));
    glow.scale.setScalar(0.4);
    glow.position.y = 0.08;
    flameGroup.add(glow);

    const light = new THREE.PointLight(0xffb15e, 0.9, 2.2);
    light.position.y = 0.08;
    flameGroup.add(light);

    group.add(flameGroup);
    cakeGroup.add(group);

    candles.push({ group, flameGroup, flame, glow, light, lit: true, phase: Math.random() * 10 });
  }
}

function updateCandles(delta, elapsed) {
  for (const c of candles) {
    if (!c.lit) continue;
    const flicker = 0.85 + Math.sin(elapsed * 12 + c.phase) * 0.1 + Math.sin(elapsed * 27 + c.phase) * 0.05;
    c.flame.scale.set(flicker, flicker * (0.9 + Math.random() * 0.15), flicker);
    c.flameGroup.position.x = Math.sin(elapsed * 8 + c.phase) * 0.01;
    c.light.intensity = 0.8 + Math.sin(elapsed * 14 + c.phase) * 0.25;
  }
}

function extinguishNextCandle() {
  const c = candles.find((c) => c.lit);
  if (!c) return false;
  c.lit = false;
  c.flameGroup.visible = false;
  c.light.intensity = 0;
  spawnSmokePuff(c.group.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.1, 0)));
  if (!candles.some((x) => x.lit)) {
    setTimeout(startCelebration, 500);
  }
  return true;
}

/* --------------------------- smoke puffs (one-shot) ------------------------ */

function spawnSmokePuff(worldPos) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, transparent: true, depthWrite: false, opacity: 0.7 }));
  sprite.position.copy(worldPos);
  sprite.scale.setScalar(0.1);
  sprite.userData.life = 0;
  activeSceneForPuffs().add(sprite);
  smokePuffs.push(sprite);
}
function activeSceneForPuffs() { return cloudWorldBuilt && phase !== PHASE.FLIGHT ? cloudScene : flightScene; }
function updateSmokePuffs(delta) {
  for (let i = smokePuffs.length - 1; i >= 0; i--) {
    const s = smokePuffs[i];
    s.userData.life += delta;
    const t = s.userData.life / 1.4;
    s.position.y += delta * 0.35;
    s.scale.setScalar(0.1 + t * 0.6);
    s.material.opacity = 0.7 * (1 - t);
    if (t >= 1) {
      s.parent && s.parent.remove(s);
      smokePuffs.splice(i, 1);
    }
  }
}

/* =============================================================================
   PHASE TRANSITIONS
   ============================================================================= */

function switchToCloudWorld() {
  if (!cloudWorldBuilt) buildCloudWorld();

  flightScene.remove(plane);
  cloudScene.add(plane);
  activeScene = cloudScene;

  planePos.set(0, 3.6, 6);
  plane.position.copy(planePos);
  plane.rotation.y = Math.PI;
  bankPivot.rotation.z = 0;
  pitchPivot.rotation.x = 0;
}

function beginArrivalCinematic() {
  cameraMode = 'cinematic';
  cinematic = {
    from: camera.position.clone(),
    to: new THREE.Vector3(2.6, 1.6, -6.5),
    lookFrom: camLookAt.clone(),
    lookTo: new THREE.Vector3(0, 1.1, -14),
    duration: 4.2,
    t: 0,
    onDone: () => startCandlePhase(),
  };

  // fly the plane into its circling orbit beside the island/cake
  planeOrbit.center.set(0, 0.4, -14);
  const start = plane.position.clone();
  const orbitStart = new THREE.Vector3(
    planeOrbit.center.x + Math.cos(0) * planeOrbit.radius,
    planeOrbit.center.y + planeOrbit.height,
    planeOrbit.center.z + Math.sin(0) * planeOrbit.radius,
  );
  const dur = 3.2;
  let t = 0;
  const step = () => {
    t += 1 / 60;
    const a = clamp01(t / dur);
    const eased = 1 - Math.pow(1 - a, 3);
    plane.position.lerpVectors(start, orbitStart, eased);
    plane.rotation.y = Math.PI - eased * (Math.PI / 2);
    if (a < 1) {
      requestAnimationFrame(step);
    } else {
      planeOrbit.angle = 0;
      planeOrbit.active = true;
    }
  };
  step();
}

function startCandlePhase() {
  phase = PHASE.CANDLES;
  cameraMode = 'candles';
  document.getElementById('candle-ui').classList.remove('hidden');
  const wish = document.getElementById('wish-title');
  const blow = document.getElementById('blow-title');
  const micBtn = document.getElementById('mic-btn');
  const blowBtn = document.getElementById('blow-btn');

  wish.classList.remove('hidden');
  setTimeout(() => {
    wish.classList.add('hidden');
    blow.classList.remove('hidden');
    micBtn.classList.remove('hidden');
    blowBtn.classList.remove('hidden');
    startMicListening();
  }, 1800);
}

function startCelebration() {
  phase = PHASE.CELEBRATION;
  cameraMode = 'orbit';
  document.getElementById('candle-ui').classList.add('hidden');
  const el = document.getElementById('celebration-ui');
  el.classList.remove('hidden');
  const lines = el.querySelectorAll('.celebrate-text');
  lines.forEach((line, i) => setTimeout(() => line.classList.add('show'), 300 + i * 900));
  spawnConfettiBurst(70);
  const interval = setInterval(() => spawnConfettiBurst(10), 1400);
  setTimeout(() => clearInterval(interval), 12000);
}

/* =============================================================================
   CAMERA
   ============================================================================= */

function updateCamera(delta, elapsed) {
  if (cameraMode === 'follow') {
    const desired = new THREE.Vector3(planePos.x * 0.5, planePos.y * 0.45 + 2.1, plane.position.z + 7.2);
    camPos.lerp(desired, expAlpha(4, delta));
    const lookDesired = new THREE.Vector3(planePos.x * 0.5, planePos.y * 0.4 + 0.6, plane.position.z - 18);
    camLookAt.lerp(lookDesired, expAlpha(4, delta));
    camera.position.copy(camPos);
    camera.lookAt(camLookAt);
  } else if (cameraMode === 'cinematic' && cinematic) {
    cinematic.t += delta;
    const a = clamp01(cinematic.t / cinematic.duration);
    const eased = a < 0.5 ? 2 * a * a : 1 - Math.pow(-2 * a + 2, 2) / 2;
    camera.position.lerpVectors(cinematic.from, cinematic.to, eased);
    const look = new THREE.Vector3().lerpVectors(cinematic.lookFrom, cinematic.lookTo, eased);
    camera.lookAt(look);
    if (a >= 1) {
      const done = cinematic.onDone;
      cinematic = null;
      if (done) done();
    }
  } else if (cameraMode === 'candles') {
    const target = new THREE.Vector3(1.6, 2.0, -10.5);
    camera.position.lerp(target, expAlpha(2, delta));
    const look = new THREE.Vector3(0, 1.55, -14);
    const cur = camera.userData.look || target.clone();
    cur.lerp(look, expAlpha(2, delta));
    camera.userData.look = cur;
    camera.lookAt(cur);
  } else if (cameraMode === 'orbit') {
    orbitAngle += delta * 0.18;
    const radius = 5.2;
    const center = new THREE.Vector3(0, 1.3, -14);
    camera.position.set(
      center.x + Math.sin(orbitAngle) * radius,
      center.y + 1.2 + Math.sin(elapsed * 0.3) * 0.2,
      center.z + Math.cos(orbitAngle) * radius,
    );
    camera.lookAt(center);
  }
}

/* =============================================================================
   MICROPHONE BLOW DETECTION
   ============================================================================= */

function startMicListening() {
  const micBtn = document.getElementById('mic-btn');
  navigator.mediaDevices?.getUserMedia({ audio: true })
    .then((stream) => {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      micData = new Uint8Array(analyser.frequencyBinCount);
      source.connect(analyser);
      micReady = true;
      micBtn.classList.add('hidden');
    })
    .catch(() => {
      micBtn.classList.add('hidden');
    });

  micBtn.addEventListener('click', () => {
    if (!micReady) startMicListening();
  }, { once: true });
}

function pollMicrophone(elapsed) {
  if (!micReady || phase !== PHASE.CANDLES) return;
  analyser.getByteTimeDomainData(micData);
  let sumSquares = 0;
  for (let i = 0; i < micData.length; i++) {
    const v = (micData[i] - 128) / 128;
    sumSquares += v * v;
  }
  const rms = Math.sqrt(sumSquares / micData.length);
  if (rms > 0.16 && elapsed - lastBlowTime > 0.45) {
    lastBlowTime = elapsed;
    extinguishNextCandle();
  }
}

/* =============================================================================
   CONFETTI (DOM)
   ============================================================================= */

const CONFETTI_COLORS = ['#ffd166', '#ff8fa3', '#9fd8ff', '#b388eb', '#7fd694', '#ffffff'];
function spawnConfettiBurst(count) {
  const layer = document.getElementById('confetti-layer');
  for (let i = 0; i < count; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    const left = Math.random() * 100;
    const drift = (Math.random() * 2 - 1) * 120;
    const duration = 2.6 + Math.random() * 2.2;
    const color = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    piece.style.left = left + 'vw';
    piece.style.background = color;
    piece.style.setProperty('--drift', drift + 'px');
    piece.style.animationDuration = duration + 's';
    piece.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
    layer.appendChild(piece);
    setTimeout(() => piece.remove(), duration * 1000 + 200);
  }
}

/* =============================================================================
   MUSIC + LYRIC SUBTITLES (shown while the plane is flying)
   ============================================================================= */

function updateSubtitles() {
  if (phase !== PHASE.FLIGHT && !(phase === PHASE.TRANSITION && transitionStage === 0)) {
    if (currentLyricIndex !== -1) {
      subtitleTextEl.classList.remove('show');
      currentLyricIndex = -1;
    }
    return;
  }
  if (flightClockStart === null) return;

  const t = (bgm && !bgm.paused && !bgm.ended && bgm.duration)
    ? bgm.currentTime
    : (clock.elapsed - flightClockStart);

  const idx = LYRICS.findIndex((l) => t >= l.start && t <= l.end);
  if (idx !== currentLyricIndex) {
    currentLyricIndex = idx;
    if (idx === -1) {
      subtitleTextEl.classList.remove('show');
    } else {
      subtitleTextEl.textContent = LYRICS[idx].text;
      subtitleTextEl.classList.add('show');
    }
  }
}

/* =============================================================================
   INPUT
   ============================================================================= */

function bindInput() {
  window.addEventListener('pointerdown', (e) => {
    if (e.target.closest && e.target.closest('button')) return;
    pointerActive = true;
    pointerStart = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('pointermove', (e) => {
    if (!pointerActive) return;
    if (e.cancelable) e.preventDefault();
    const dx = e.clientX - pointerStart.x;
    const dy = e.clientY - pointerStart.y;
    rawTargetX = THREE.MathUtils.clamp(dx / 110, -1, 1);
    rawTargetY = THREE.MathUtils.clamp(-dy / 110, -1, 1);
  }, { passive: false });
  const release = () => { pointerActive = false; rawTargetX = 0; rawTargetY = 0; };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  window.addEventListener('blur', release);

  window.addEventListener('keydown', (e) => { keys[e.key] = true; });
  window.addEventListener('keyup', (e) => { keys[e.key] = false; });

  document.getElementById('blow-btn').addEventListener('click', () => {
    if (phase === PHASE.CANDLES) extinguishNextCandle();
  });
}

/* =============================================================================
   MAIN LOOP
   ============================================================================= */

function animate(timestamp) {
  requestAnimationFrame(animate);
  if (clock.last === null) clock.last = timestamp;
  const delta = Math.min((timestamp - clock.last) / 1000, 1 / 30);
  clock.last = timestamp;
  clock.elapsed += delta;

  const inFlightWorld = phase === PHASE.FLIGHT || (phase === PHASE.TRANSITION && transitionStage < 2);
  if (inFlightWorld) {
    const { remaining } = updatePlane(delta, clock.elapsed);
    updateFlightWorld(delta, clock.elapsed, BASE_SPEED);
    updatePortal(delta, clock.elapsed, remaining);
    updateDistanceUI(remaining);
  }
  if (phase === PHASE.TRANSITION) {
    updateTransition(delta);
  }
  if (!inFlightWorld && phase !== PHASE.TRANSITION) {
    updateSmokePuffs(delta);
    if (candles.length) updateCandles(delta, clock.elapsed);
    pollMicrophone(clock.elapsed);
    updatePlaneOrbit(delta, clock.elapsed);
  }

  updateSubtitles();
  updateCamera(delta, clock.elapsed);
  renderer.render(activeScene, camera);
}

function updateDistanceUI(remaining) {
  const pct = clamp01(1 - remaining / PORTAL_TOTAL_DISTANCE) * 100;
  const fill = document.getElementById('distance-fill');
  if (fill) fill.style.width = pct + '%';
}

/* =============================================================================
   BOOTSTRAP
   ============================================================================= */

async function init() {
  setupRenderer();
  buildFlightWorld();
  activeScene = flightScene;
  buildPlane();
  bindInput();

  camera.position.copy(camPos);
  camera.lookAt(camLookAt);

  subtitleEl = document.getElementById('subtitle-box');
  subtitleTextEl = document.getElementById('subtitle-text');
  bgm = document.getElementById('bgm');

  const fill = document.getElementById('loading-fill');
  try {
    const { bakedTexture, gltf } = await loadPortalAsset((p) => {
      fill.style.width = Math.min(p * 100, 100) + '%';
    });
    buildPortal(bakedTexture, gltf);
  } catch (err) {
    console.warn('Portal assets failed to load, using fallback glow only.', err);
  }

  document.getElementById('loading-screen').classList.add('hidden');
  document.getElementById('start-screen').classList.remove('hidden');

  requestAnimationFrame(animate);
}

document.getElementById('start-btn')?.addEventListener('click', startGame);
function startGame() {
  document.getElementById('start-screen').classList.add('hidden');
  document.getElementById('flight-hud').classList.remove('hidden');
  flightClockStart = clock.elapsed;

  if (bgm) {
    bgm.currentTime = 0;
    bgm.volume = 0.85;
    bgm.play().catch(() => { /* music.mp3 not present yet — subtitles still run on their own clock */ });
  }

  setTimeout(() => {
    const hint = document.getElementById('hint-bubble');
    if (hint) hint.style.opacity = '0';
  }, 3200);
}

init();
