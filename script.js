import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* =============================================================================
   BIRTHDAY FLIGHT
   Fly a toy biplane through deep space along a glowing guide tube, dive into
   a black hole that erupts as you arrive, and land in a cloud-sea sky world
   with a birthday cake to blow out — set to a birthday song with synced
   lyric subtitles during the flight.
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
    low:    { cloudSea: 500,  pixelRatio: 1.25 },
    medium: { cloudSea: 900,  pixelRatio: 1.5 },
    high:   { cloudSea: 1400, pixelRatio: 1.75 },
  };
  return { tier, ...table[tier] };
})();

const BASE_SPEED = 9;                 // world units / second the plane "flies"
const MOVE_BOUNDS = { x: 6.2, y: 4.3 };
const MAX_ROLL = THREE.MathUtils.degToRad(32);
const MAX_PITCH = THREE.MathUtils.degToRad(18);
const PORTAL_TOTAL_DISTANCE = 1300;   // distance travelled before reaching the black hole (~144s @ BASE_SPEED)
const ASSIST_RANGE = 140;             // auto-assist begins this far from the black hole
const TRIGGER_RANGE = 22;             // hard transition (explosion) begins this far from the black hole
const CANDLE_COUNT = 5;

const ASSET_URLS = {
  music: 'assets/audio/music.mp3',
  plane: 'assets/audio/plane.mp3',
  gameover: 'assets/audio/gameover.mp3',
};

const PHASE = {
  FLIGHT: 'flight',
  TRANSITION: 'transition',
  ARRIVAL: 'arrival',
  CANDLES: 'candles',
  CELEBRATION: 'celebration',
  GAMEOVER: 'gameover',
};

/* -------------------------- Lyric subtitles ------------------------------- */
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
let bgScene, bgCamera, bgMaterial, bgUniforms;
let activeScene;
let clock = { last: null, elapsed: 0 };

let plane, bankPivot, pitchPivot, propeller, wingL, wingR;
const planePos = new THREE.Vector3(0, 0, 0);
const PLANE_FULL_SCALE = 1;
const PLANE_TOY_SCALE = 0.34;

let inputX = 0, inputY = 0;
let rawTargetX = 0, rawTargetY = 0;
let pointerActive = false;
let pointerStart = { x: 0, y: 0 };
const keys = {};

let totalDistance = 0;
let phase = PHASE.FLIGHT;

let blackHoleGroup, diskMaterial, glowMaterial, lensingMaterial, photonSphereMaterial;
let flightWorldGroup;
let blackHoleEcho = { active: false, startTime: 0, duration: 1.3 };
let shockwaves = [];
let smokePuffs = [];
let offPathTimer = 0;
const PATH_TOLERANCE = 2.15; // world-space distance from the path before it counts as "off path"
const PATH_GRACE = 0.7;

let cloudWorldBuilt = false;
let islandGroup, cakeGroup, candles = [];
let cameraMode = 'follow';
let cinematic = null;
let orbitAngle = 0;

let planeOrbit = { active: false, angle: 0, radius: 2.6, center: new THREE.Vector3(0, 0.4, -14), height: 2.8 };

let camPos = new THREE.Vector3(0, 2.6, 9);
let camLookAt = new THREE.Vector3(0, 0.5, -20);

let audioCtx, analyser, micData, micReady = false;
let lastBlowTime = 0;

let bgm, planeSfx, gameoverSfx;

/* play()/pause() on <audio> are async under the hood — calling pause()
   right after play() (e.g. spam-clicking "Coba Lagi") can race with the
   browser still resolving the play request, and the sound ends up playing
   anyway. These helpers track the in-flight play() promise and only touch
   playback once it has actually settled, so stop/replay always wins. */
function playAudioSafe(el) {
  if (!el) return;
  const p = el.play();
  el._playPromise = p;
  if (p && typeof p.catch === 'function') p.catch(() => { /* autoplay blocked or file missing */ });
}
function stopAudioSafe(el) {
  if (!el) return;
  const doStop = () => { el.pause(); el.currentTime = 0; };
  if (el._playPromise && typeof el._playPromise.then === 'function') {
    el._playPromise.then(doStop, doStop);
  } else {
    doStop();
  }
}
/* Fades an <audio> element's volume down to 0, then stops it — used so the
   plane engine loop doesn't just cut or keep running once the flight phase
   ends (e.g. entering the portal into the cake scene). */
function fadeAudioOutAndStop(el, duration = 1.0) {
  if (!el) return;
  const startVol = el.volume;
  if (window.gsap) {
    gsap.to(el, {
      volume: 0,
      duration,
      ease: 'power1.out',
      onComplete: () => { stopAudioSafe(el); el.volume = startVol; },
    });
  } else {
    const startTime = performance.now();
    const step = (now) => {
      const t = clamp01((now - startTime) / (duration * 1000));
      el.volume = startVol * (1 - t);
      if (t < 1) requestAnimationFrame(step);
      else { stopAudioSafe(el); el.volume = startVol; }
    };
    requestAnimationFrame(step);
  }
}
let musicStarted = false, musicClockStart = null;
let subtitleEl, subtitleTextEl;
let currentLyricIndex = -1;

// Sub-steps inside PHASE.CANDLES: 'light' (user must light each candle) ->
// 'wish' (brief "Make a Wish" beat) -> 'music' (song + lyrics play, no
// interaction) -> 'blow' (user blows the candles out one by one).
let candleStage = 'idle';
// Fallback so the flow still reaches the blow-candles step even if
// music.mp3 is missing or its 'ended' event never fires (last lyric ends at
// ~143.9s; the source track runs a little past that into its outro).
const SONG_FALLBACK_DURATION = 156;

/* Dev/shortcut entry: a PIN-gated button that jumps straight past the
   flight into the cake scene. */
const CAKE_SKIP_PIN = '0309';
let pinEntry = '';

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

const goldGlowTex = makeRadialTexture('rgba(255,224,150,1)', 'rgba(255,180,90,0)');
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
  renderer.autoClear = true;

  camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 1600);
  camera.position.copy(camPos);

  window.addEventListener('resize', onResize, { passive: true });
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY.pixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  if (bgUniforms) {
    bgUniforms.u_resolution.value.set(renderer.domElement.width, renderer.domElement.height);
  }
}

/* =============================================================================
   SPACE BACKGROUND  (ported from "snowfall" — a full-screen warp-tunnel shader,
   used as the flight world's outer-space backdrop, rendered behind everything)
   ============================================================================= */

const SPACE_VERT = `
  void main() { gl_Position = vec4( position, 1.0 ); }
`;
const SPACE_FRAG = `
  uniform vec2 u_resolution;
  uniform float u_time;
  uniform sampler2D u_noise;

  #define TAU 6.
  const float multiplier = 25.5;
  const float zoomSpeed = 10.;
  const int layers = 10;
  const int octaves = 5;

  vec2 hash2(vec2 p) { return texture2D(u_noise, (p + 0.5) / 256.0).xy; }
  float hash(vec2 p) { return texture2D(u_noise, (p + 0.5) / 256.0).x; }
  mat2 rotate2d(float a) { return mat2(cos(a), sin(a), -sin(a), cos(a)); }
  vec3 hsb2rgb(vec3 c) {
    vec3 rgb = clamp(abs(mod(c.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    rgb = rgb * rgb * (3.0 - 2.0 * rgb);
    return c.z * mix(vec3(1.0), rgb, c.y);
  }
  float noise(vec2 uv) {
    vec2 id = floor(uv);
    vec2 subuv = fract(uv);
    vec2 u = subuv * subuv * (3. - 2. * subuv);
    float a = hash(id), b = hash(id + vec2(1., 0.)), c = hash(id + vec2(0., 1.)), d = hash(id + vec2(1., 1.));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  float fbm(vec2 uv) {
    float s = .0, m = .0, a = .5;
    for (int i = 0; i < octaves; i++) { s += a * noise(uv); m += a; a *= .5; uv *= 2.; }
    return s / m;
  }
  vec3 render(vec2 uv, float scale) {
    vec2 id = floor(uv);
    vec2 subuv = fract(uv);
    vec2 rnd = hash2(id);
    float bokeh = abs(scale);
    float particle = 0.;
    if (length(rnd) > 1.3) {
      vec2 pos = subuv - .5;
      float field = length(pos);
      particle = smoothstep(.3, 0., field);
      particle += smoothstep(.4, 0.34 * bokeh, field);
    }
    return vec3(particle * 2.);
  }
  vec3 renderLayer(int layer, vec2 uv) {
    float scale = mod((u_time + zoomSpeed / float(layers) * float(layer)) / zoomSpeed, -1.);
    uv *= 20.;
    uv *= scale * scale;
    uv = rotate2d(u_time / 10.) * uv;
    uv += vec2(25. + sin(u_time * .1)) * float(layer);
    vec3 pass = render(uv * multiplier, scale) * .2;
    float opacity = 1. + scale;
    float endOpacity = smoothstep(0., 0.4, scale * -1.);
    return pass * opacity * endOpacity;
  }
  void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy);
    uv /= min(u_resolution.x, u_resolution.y);
    float n = fbm((uv + vec2(sin(u_time * .1), u_time * .1)) * 2. - 2.);
    vec3 colour = n * mix(vec3(0.02, .12, .32), clamp(vec3(.55, .3, .85) * 1.4, 0., 1.), n);
    float opacitySum = 1.;
    for (int i = 1; i <= layers; i++) { colour += renderLayer(i, uv); }
    colour /= opacitySum + float(layers);
    gl_FragColor = vec4(clamp(colour * 20., 0., 1.), 1.0);
  }
`;

function makeNoiseTexture(size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = Math.random() * 255;
    img.data[i + 1] = Math.random() * 255;
    img.data[i + 2] = Math.random() * 255;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function buildSpaceBackground() {
  bgScene = new THREE.Scene();
  bgCamera = new THREE.Camera();
  bgCamera.position.z = 1;

  bgUniforms = {
    u_time: { value: 0 },
    u_resolution: { value: new THREE.Vector2(renderer.domElement.width, renderer.domElement.height) },
    u_noise: { value: makeNoiseTexture() },
  };
  bgMaterial = new THREE.ShaderMaterial({
    uniforms: bgUniforms, vertexShader: SPACE_VERT, fragmentShader: SPACE_FRAG,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMaterial);
  bgScene.add(mesh);
}

/* =============================================================================
   GUIDE TUBE  (inspired by "tubes-cursor" — a colourful glowing tube marking
   the flight corridor, built with Three.js's own TubeGeometry since the
   source is a minified third-party bundle with no portable geometry code)
   ============================================================================= */

/* Shared path formula: given how far the plane has travelled, returns the
   lateral (x) and vertical (y) offset the guide corridor sits at there.
   Starts at (0,0) so a stationary plane begins exactly on the path. */
function pathTargetAt(distanceAlong) {
  const z = -distanceAlong;
  return {
    x: Math.sin(z * 0.045) * 3.2,
    y: Math.sin(z * 0.025) * 1.8,
  };
}

/* Off-path is judged by real distance from where the guide path actually is
   right now — not by whether a look-ahead point is still inside the camera
   frustum. That screen-space check turned out far too forgiving in
   practice: the camera only pans half as far as the plane does, and at the
   look-ahead depth the frustum is wide enough that even a full hard-left
   or hard-right deviation still projected as "on screen", so game over
   almost never fired no matter how far off the path the player drifted. */
const OFF_PATH_TOLERANCE = PATH_TOLERANCE;

function checkOffPath(delta) {
  if (phase !== PHASE.FLIGHT) { offPathTimer = 0; return; }
  const here = pathTargetAt(totalDistance);
  const deviation = Math.hypot(planePos.x - here.x, planePos.y - here.y);
  if (deviation > OFF_PATH_TOLERANCE) {
    offPathTimer += delta;
    if (offPathTimer > PATH_GRACE) triggerGameOver();
  } else {
    offPathTimer = Math.max(0, offPathTimer - delta * 2);
  }
}

function buildGuideTube() {
  const segments = 260;
  const totalLen = PORTAL_TOTAL_DISTANCE + 30;
  const points = [];
  for (let i = 0; i <= segments; i++) {
    const distanceAlong = (i / segments) * totalLen;
    const p = pathTargetAt(distanceAlong);
    points.push(new THREE.Vector3(p.x, p.y, -distanceAlong));
  }
  const curve = new THREE.CatmullRomCurve3(points);

  const palette = [0xf967fb, 0x53bc28, 0x6958d5, 0x83f36e, 0xfe8a2e, 0xff008a, 0x60aed5].map((c) => new THREE.Color(c));
  const paintTube = (geo) => {
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const t = i / pos.count;
      const idxF = t * (palette.length - 1);
      const idx = Math.floor(idxF);
      const frac = idxF - idx;
      const c = palette[idx].clone().lerp(palette[Math.min(idx + 1, palette.length - 1)], frac);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  };

  const coreGeo = new THREE.TubeGeometry(curve, 480, 0.045, 8, false);
  paintTube(coreGeo);
  const coreMat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  const core = new THREE.Mesh(coreGeo, coreMat);

  const glowGeo = new THREE.TubeGeometry(curve, 480, 0.15, 8, false);
  paintTube(glowGeo);
  const glowMat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  const glow = new THREE.Mesh(glowGeo, glowMat);

  const group = new THREE.Group();
  group.add(glow, core);
  flightWorldGroup.add(group);
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
  plane.scale.setScalar(PLANE_FULL_SCALE);
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
  const controlWeight = phase === PHASE.FLIGHT ? 1 : 0;
  if (phase === PHASE.FLIGHT && remaining < TRIGGER_RANGE) {
    beginPortalTransition();
  }

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

/* Continuous circling flight beside the cake, shrunk down like a toy so it
   never blocks the camera's view of the cake.

   Direction note: the plane arrives from the portal heading roughly toward
   -Z (its nose faces local -Z). The orbit's start point sits at angle = 0
   (cos 0 = 1, sin 0 = 0), so the very first frame of the orbit must also
   point toward -Z there, or the nose visibly snaps around and the plane
   reads as flying backward the instant the orbit takes over. Advancing the
   angle with a NEGATIVE rate (instead of positive) makes the velocity at
   angle = 0 come out to (0, 0, -1) — continuous with the arrival heading —
   so the orbit reads as forward flight from the first frame. */
function updatePlaneOrbit(delta, elapsed) {
  if (!planeOrbit.active) return;
  planeOrbit.angle -= delta * 0.55;
  const cx = planeOrbit.center.x + Math.cos(planeOrbit.angle) * planeOrbit.radius;
  const cz = planeOrbit.center.z + Math.sin(planeOrbit.angle) * planeOrbit.radius;
  const cy = planeOrbit.center.y + planeOrbit.height + Math.sin(elapsed * 1.3) * 0.06;

  plane.position.set(cx, cy, cz);
  // Velocity = d(position)/dt, matching the negative angular rate above.
  const tangent = new THREE.Vector3(Math.sin(planeOrbit.angle), 0, -Math.cos(planeOrbit.angle));
  plane.lookAt(cx + tangent.x, cy, cz + tangent.z);

  bankPivot.rotation.z = lerp(bankPivot.rotation.z, 0.4, expAlpha(3, delta));
  pitchPivot.rotation.x = lerp(pitchPivot.rotation.x, 0, expAlpha(3, delta));
  propeller.rotation.z += delta * 34;
  wingL.rotation.x = Math.sin(elapsed * 3.1) * 0.02;
  wingR.rotation.x = Math.sin(elapsed * 3.1 + 1) * 0.02;
}

/* =============================================================================
   FLIGHT WORLD (deep space)
   ============================================================================= */

function buildFlightWorld() {
  flightScene = new THREE.Scene();

  const hemi = new THREE.HemisphereLight(0xbcd8ff, 0x1c2c55, 1.3);
  flightScene.add(hemi);
  const key = new THREE.DirectionalLight(0xcfe6ff, 1.3);
  key.position.set(-6, 10, 4);
  flightScene.add(key);
  const rim = new THREE.DirectionalLight(0x9fd0ff, 0.6);
  rim.position.set(5, -2, -6);
  flightScene.add(rim);

  // Everything the plane flies past (guide tube + black hole) lives inside
  // this group. Its position.z is driven by how far the plane has travelled,
  // so the whole corridor slides toward the (stationary) plane each frame —
  // this is what actually creates the sensation of forward motion.
  flightWorldGroup = new THREE.Group();
  flightScene.add(flightWorldGroup);

  buildGuideTube();
  buildBlackHole();
}

function updateFlightWorld(delta, elapsed) {
  flightWorldGroup.position.z = totalDistance;
  flightWorldGroup.updateMatrixWorld(true);
  updateSmokePuffs(delta);
  updateShockwaves(delta);
}

/* --------------------------------- Black hole -------------------------------
   Disk / glow / lensing / photon-sphere shaders ported from
   "galactic-black-hole-simulation" (inferno theme). The disk's own "disk
   echo" ripple system is reused as the arrival explosion.
   ------------------------------------------------------------------------- */

const EVENT_HORIZON_RADIUS = 1.4;
const DISK_INNER_RADIUS = EVENT_HORIZON_RADIUS + 0.15;
const DISK_OUTER_RADIUS = 5.2;
const LENSING_RADIUS = EVENT_HORIZON_RADIUS + 0.07;
const GLOW_RADIUS_FACTOR = 1.07;
const PHOTON_SPHERE_RADIUS = EVENT_HORIZON_RADIUS * 1.5;

const THEME = {
  diskHot: new THREE.Color(0xffffff), diskMid: new THREE.Color(0xffaa33),
  diskEdge: new THREE.Color(0xcc331a), diskDeep: new THREE.Color(0x661a00),
  lensing: new THREE.Color(0xffcc66), glow: new THREE.Color(0xff8833),
  photonSphere: new THREE.Color(0xffbb44),
  primaryWave: new THREE.Color(0xffaa33), secondaryWave: new THREE.Color(0xff5500), tertiaryWave: new THREE.Color(0xffdd22),
};

function buildBlackHole() {
  blackHoleGroup = new THREE.Group();
  blackHoleGroup.position.set(0, 0.4, -PORTAL_TOTAL_DISTANCE);

  const core = new THREE.Mesh(new THREE.SphereGeometry(EVENT_HORIZON_RADIUS, 48, 32), new THREE.MeshBasicMaterial({ color: 0x000000 }));
  core.renderOrder = 0;
  blackHoleGroup.add(core);

  const diskGeometry = new THREE.RingGeometry(DISK_INNER_RADIUS, DISK_OUTER_RADIUS, 100, 48);
  diskMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColorHot: { value: THEME.diskHot.clone() }, uColorMid: { value: THEME.diskMid.clone() },
      uColorEdge: { value: THEME.diskEdge.clone() }, uColorDeep: { value: THEME.diskDeep.clone() },
      uCameraPosition: { value: new THREE.Vector3() },
      uRippleActive: { value: 0.0 }, uRippleStartTime: { value: 0.0 }, uRippleDuration: { value: blackHoleEcho.duration },
      uPrimaryWaveColor: { value: THEME.primaryWave.clone().multiplyScalar(3.0) },
      uSecondaryWaveColor: { value: THEME.secondaryWave.clone().multiplyScalar(2.7) },
      uTertiaryWaveColor: { value: THEME.tertiaryWave.clone().multiplyScalar(2.4) },
      uRippleMaxRadius: { value: DISK_OUTER_RADIUS }, uRippleThickness: { value: DISK_OUTER_RADIUS * 0.12 },
      uRippleIntensity: { value: 0.0 }, uRippleDistortionStrength: { value: 0.0 },
    },
    vertexShader: `
      varying vec2 vUv; varying vec3 vPosition; varying float vRadius;
      uniform float uRippleDistortionStrength; uniform float uTime;
      void main() {
        vUv = uv; vPosition = position; vRadius = length(position.xy);
        vec3 adjustedPosition = position;
        if (uRippleDistortionStrength > 0.0) {
          float angle = atan(position.y, position.x);
          float distortionAmount = sin(angle * 10.0 + uTime * 7.0 + vRadius * 2.0) * 0.08 * uRippleDistortionStrength;
          adjustedPosition.z += distortionAmount;
        }
        gl_Position = projectionMatrix * modelViewMatrix * vec4(adjustedPosition, 1.0);
      }`,
    fragmentShader: `
      uniform float uTime; uniform vec3 uColorHot; uniform vec3 uColorMid; uniform vec3 uColorEdge; uniform vec3 uColorDeep;
      uniform vec3 uCameraPosition; varying vec2 vUv; varying vec3 vPosition; varying float vRadius;
      uniform float uRippleActive; uniform float uRippleStartTime; uniform float uRippleDuration;
      uniform vec3 uPrimaryWaveColor; uniform vec3 uSecondaryWaveColor; uniform vec3 uTertiaryWaveColor;
      uniform float uRippleMaxRadius; uniform float uRippleThickness; uniform float uRippleIntensity;
      float rand(vec2 n){return fract(sin(dot(n,vec2(12.9898,4.1414)))*43758.5453);}
      float noise(vec2 p){vec2 ip=floor(p);vec2 u=fract(p);u=u*u*(3.0-2.0*u);float res=mix(mix(rand(ip),rand(ip+vec2(1.0,0.0)),u.x),mix(rand(ip+vec2(0.0,1.0)),rand(ip+vec2(1.0,1.0)),u.x),u.y);return res*res;}
      float fbm(vec2 p, float timeOffset, float freq, int octaves) {
        float total=0.0; float amplitude=0.65; float persistence=0.5;
        for(int i=0;i<octaves;i++){
          float timeScale=0.6+0.12*float(i);
          float noiseVal = noise(p*freq+vec2(timeOffset*timeScale*0.45,timeOffset*timeScale*0.3));
          total+=amplitude*noiseVal;
          vec2 warpOffset=vec2(noiseVal*0.18,-noiseVal*0.12);
          p+=warpOffset*amplitude*0.5; freq*=2.0; amplitude*=persistence;
        }
        return total;
      }
      float vortexPattern(float dist, float angle, float time){
        float spiral=sin(angle*2.3+dist*0.28+dist*5.8-time*0.6);
        return smoothstep(-0.38,0.68,spiral)*0.32;
      }
      float calculateRippleIntensity(float dist, float rippleProgress, float currentRippleRadius, float thickness, float speedFactor) {
        if (rippleProgress <= 0.0 || rippleProgress >= 1.0) return 0.0;
        float distToRippleCenter = abs(dist - currentRippleRadius);
        float halfThickness = thickness * 0.5 * mix(1.0, 0.25, rippleProgress);
        float waveEnergyFactor = pow(1.0 - rippleProgress, 0.8 * speedFactor);
        float waveShape = smoothstep(halfThickness, halfThickness - (thickness * 0.25), distToRippleCenter);
        float angle = atan(vPosition.y, vPosition.x);
        float angleMod = sin(angle * 10.0 + rippleProgress * 15.0) * 0.15 + 0.9;
        return waveShape * waveEnergyFactor * angleMod;
      }
      void main(){
        float dist = vRadius;
        float innerEdge = ${DISK_INNER_RADIUS.toFixed(2)}; float outerEdge = ${DISK_OUTER_RADIUS.toFixed(2)};
        float normalizedPos = clamp((dist - innerEdge) / (outerEdge - innerEdge), 0.0, 1.0);
        float angle = atan(vPosition.y, vPosition.x);
        float orbitalVelocity = 1.0 / sqrt(max(dist, 0.1));
        float dopplerFactor = 0.0; float beamingFactor = 1.0;
        if (length(uCameraPosition) > 0.01) {
          vec3 tangentialDirection = normalize(vec3(-vPosition.y, vPosition.x, 0.0));
          vec3 toCamera = normalize(uCameraPosition - vPosition);
          dopplerFactor = dot(toCamera, tangentialDirection) * orbitalVelocity * 0.3;
          beamingFactor = clamp(1.0 + dopplerFactor * 0.4, 0.5, 2.0);
        }
        float rotationSpeedFactor = 4.8/(pow(dist,1.6)+1.1);
        float rotatedAngle = angle-uTime*rotationSpeedFactor*0.52;
        vec2 baseCoord = vec2(dist*1.9, rotatedAngle*3.6);
        float evolvingTime = uTime*0.17;
        float noiseValueFast = fbm(baseCoord, evolvingTime * 1.2, 2.2, 6);
        float noiseValueSlow = fbm(baseCoord * 0.6, evolvingTime * 0.5, 1.5, 4);
        float noiseValue = noiseValueFast * 0.7 + noiseValueSlow * 0.4;
        float vortexValue = vortexPattern(dist, angle, uTime);
        float finalPattern = noiseValue*0.8 + vortexValue*1.1;
        float temperature = clamp(orbitalVelocity * (1.0 + finalPattern * 0.3), 0.0, 2.0);
        vec3 colorInner = mix(uColorHot, uColorMid, smoothstep(0.0, 0.40, normalizedPos) * (1.0 - temperature * 0.3));
        vec3 colorOuterBlend = mix(uColorMid, uColorEdge, smoothstep(0.40, 0.80, normalizedPos));
        vec3 colorDeepBlend = mix(uColorEdge, uColorDeep, smoothstep(0.80, 1.0, normalizedPos));
        vec3 color = mix(colorInner, colorOuterBlend, smoothstep(0.40, 0.80, normalizedPos));
        color = mix(color, colorDeepBlend, smoothstep(0.80, 1.0, normalizedPos));
        float redshiftFactor = dopplerFactor * 0.15;
        color *= vec3(1.0 + redshiftFactor, 1.0, 1.0 - redshiftFactor);
        float patternBrightness = (finalPattern+0.5)*1.15 + pow(max(0.0,finalPattern-0.5),1.3)*0.6;
        float radialBrightness = pow(1.0-smoothstep(0.0,0.8,normalizedPos),1.9)*3.0+0.25;
        float finalBrightness = patternBrightness*radialBrightness*beamingFactor;
        float combinedRippleIntensity = 0.0; vec3 rippleColorContribution = vec3(0.0);
        if (uRippleActive > 0.5) {
          float rippleTime = uTime - uRippleStartTime;
          float rippleProgress = clamp(rippleTime / uRippleDuration, 0.0, 1.0);
          float primaryRadius = mix(innerEdge, uRippleMaxRadius, rippleProgress);
          float primaryIntensity = calculateRippleIntensity(dist, rippleProgress, primaryRadius, uRippleThickness, 1.0);
          float secondaryProgress = max(0.0, rippleProgress - 0.1) * 0.75;
          float secondaryRadius = mix(innerEdge, uRippleMaxRadius * 0.85, secondaryProgress);
          float secondaryIntensity = calculateRippleIntensity(dist, secondaryProgress, secondaryRadius, uRippleThickness * 0.8, 0.75) * 0.8;
          float tertiaryProgress = max(0.0, rippleProgress - 0.2) * 0.5;
          float tertiaryRadius = mix(innerEdge, uRippleMaxRadius * 0.7, tertiaryProgress);
          float tertiaryIntensity = calculateRippleIntensity(dist, tertiaryProgress, tertiaryRadius, uRippleThickness * 0.6, 0.5) * 0.6;
          combinedRippleIntensity = primaryIntensity + secondaryIntensity + tertiaryIntensity;
          rippleColorContribution = uPrimaryWaveColor * primaryIntensity + uSecondaryWaveColor * secondaryIntensity + uTertiaryWaveColor * tertiaryIntensity;
          float afterglowPulse = sin(rippleProgress * 15.0) * 0.5 + 0.5;
          float afterglowIntensity = smoothstep(0.0, 0.3, rippleProgress) * (1.0 - rippleProgress) * 0.4 * afterglowPulse;
          combinedRippleIntensity += afterglowIntensity * smoothstep(innerEdge, innerEdge + 1.5, dist);
        }
        float rippleBoost = combinedRippleIntensity * 9.0 * uRippleIntensity;
        color *= (finalBrightness + rippleBoost);
        if (combinedRippleIntensity * uRippleIntensity > 0.01) {
          float shimmerEffect = sin(angle * 20.0 + uTime * 10.0 + dist * 5.0) * 0.15 + 0.9;
          color = mix(color, rippleColorContribution * shimmerEffect * 1.8, min(1.0, combinedRippleIntensity * uRippleIntensity * 1.5));
        }
        float hotBoost = smoothstep(3.0, 5.0, finalBrightness + rippleBoost) * smoothstep(0.0, 0.1, normalizedPos);
        color = mix(color, vec3(1.0), hotBoost * 0.45);
        float innerAlpha = smoothstep(0.0, 0.06, normalizedPos);
        float outerAlpha = 1.0 - smoothstep(0.85, 1.0, normalizedPos);
        float noiseAlphaFactor = clamp(finalPattern * 0.35 + 0.75, 0.65, 1.0);
        float alpha = innerAlpha * outerAlpha * noiseAlphaFactor;
        float rippleAlphaBoost = combinedRippleIntensity * 0.9 * uRippleIntensity;
        color = clamp(color, 0.0, 8.0);
        gl_FragColor = vec4(color, clamp(alpha + rippleAlphaBoost, 0.0, 1.0));
      }`,
    transparent: true, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const accretionDisk = new THREE.Mesh(diskGeometry, diskMaterial);
  accretionDisk.rotation.x = Math.PI / 2.6;
  accretionDisk.renderOrder = 1;
  blackHoleGroup.add(accretionDisk);

  photonSphereMaterial = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: THEME.photonSphere.clone() }, uDiskEchoActive: { value: 0.0 }, uDiskEchoIntensity: { value: 0.0 } },
    vertexShader: `varying vec3 vNormal; varying vec3 vViewPosition;
      void main() { vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); vViewPosition = -mvPosition.xyz; vNormal = normalize(normalMatrix * normal); gl_Position = projectionMatrix * mvPosition; }`,
    fragmentShader: `uniform float uTime; uniform vec3 uColor; uniform float uDiskEchoActive; uniform float uDiskEchoIntensity;
      varying vec3 vNormal; varying vec3 vViewPosition;
      void main() {
        vec3 viewDir = normalize(vViewPosition);
        float fresnel = pow(1.0 - abs(dot(viewDir, vNormal)), 3.0);
        float pulse = sin(uTime * (2.0 + uDiskEchoIntensity * 8.0)) * (0.1 + uDiskEchoIntensity * 0.5) + 0.9;
        float alpha = fresnel * (0.3 + uDiskEchoIntensity * 0.6) * pulse;
        vec3 finalColor = uColor;
        if (uDiskEchoActive > 0.5) {
          float colorPulse = sin(uTime * 4.0 + dot(vNormal, vec3(1.0)) * 5.0) * 0.5 + 0.5;
          finalColor = mix(finalColor, finalColor * vec3(1.4, 1.2, 0.8), colorPulse * uDiskEchoIntensity * 1.2);
          finalColor *= (1.0 + uDiskEchoIntensity * 0.7);
        }
        gl_FragColor = vec4(finalColor, alpha);
      }`,
    transparent: true, side: THREE.FrontSide, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const photonSphere = new THREE.Mesh(new THREE.SphereGeometry(PHOTON_SPHERE_RADIUS, 48, 32), photonSphereMaterial);
  photonSphere.renderOrder = 4;
  blackHoleGroup.add(photonSphere);

  lensingMaterial = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uLensingColor: { value: THEME.lensing.clone() }, uDiskEchoActive: { value: 0.0 }, uDiskEchoIntensity: { value: 0.0 } },
    vertexShader: `varying vec3 vNormal; varying vec3 vViewPosition;
      void main() { vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); vViewPosition = -mvPosition.xyz; vNormal = normalize(normalMatrix * normal); gl_Position = projectionMatrix * mvPosition; }`,
    fragmentShader: `uniform float uTime; uniform vec3 uLensingColor; uniform float uDiskEchoActive; uniform float uDiskEchoIntensity;
      varying vec3 vNormal; varying vec3 vViewPosition;
      float rand(vec2 n){return fract(sin(dot(n,vec2(12.9898,4.1414)))*43758.5453);}
      float noise(vec2 p){vec2 ip=floor(p);vec2 u=fract(p);u=u*u*(3.0-2.0*u);float res=mix(mix(rand(ip),rand(ip+vec2(1.0,0.0)),u.x),mix(rand(ip+vec2(0.0,1.0)),rand(ip+vec2(1.0,1.0)),u.x),u.y);return res*res;}
      void main(){
        vec3 viewDir=normalize(vViewPosition);
        float fresnelPower = 5.2 - uDiskEchoIntensity * 1.5;
        float fF=pow(1.0-abs(dot(viewDir,vNormal)),fresnelPower);
        float p=(sin(uTime*(0.55+uDiskEchoIntensity*3.0)+length(vViewPosition)*0.12)*(0.12+uDiskEchoIntensity*0.4)+0.95);
        float noiseScale = 7.0 + uDiskEchoIntensity * 5.0;
        vec2 nC=vNormal.xy*noiseScale+uTime*(0.35+uDiskEchoIntensity*1.2);
        float nV=noise(nC)*(0.12 + uDiskEchoIntensity * 0.15);
        vec3 dN=normalize(vNormal+vec3(nV,nV*0.6,0.0));
        float a=fF*(0.68 + uDiskEchoIntensity * 0.5)*p;
        float edgePower = 8.5 - uDiskEchoIntensity * 3.5;
        a+=pow(1.0-abs(dot(viewDir,dN)),edgePower)*(0.38 + uDiskEchoIntensity * 0.6);
        vec3 finalColor = uLensingColor;
        if (uDiskEchoActive > 0.5) {
          float colorShift = dot(viewDir, vNormal) * 0.5 + 0.5;
          finalColor = mix(finalColor, finalColor * vec3(1.3, 1.1, 0.9), colorShift * uDiskEchoIntensity);
          finalColor *= (1.0 + uDiskEchoIntensity * 0.4);
        }
        gl_FragColor=vec4(finalColor, clamp(a,0.0,1.0)*0.90);
      }`,
    transparent: true, side: THREE.FrontSide, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const lensingSphere = new THREE.Mesh(new THREE.SphereGeometry(LENSING_RADIUS, 48, 32), lensingMaterial);
  lensingSphere.scale.multiplyScalar(1.62);
  lensingSphere.renderOrder = 2;
  blackHoleGroup.add(lensingSphere);

  glowMaterial = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uGlowColor: { value: THEME.glow.clone() }, uDiskEchoActive: { value: 0.0 }, uDiskEchoIntensity: { value: 0.0 }, uDiskEchoColor: { value: THEME.primaryWave.clone() } },
    vertexShader: `varying vec3 vNormal; varying vec3 vViewPosition;
      void main() { vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); vViewPosition = -mvPosition.xyz; vNormal = normalize(normalMatrix * normal); gl_Position = projectionMatrix * mvPosition; }`,
    fragmentShader: `uniform float uTime; uniform vec3 uGlowColor; uniform float uDiskEchoActive; uniform float uDiskEchoIntensity; uniform vec3 uDiskEchoColor;
      varying vec3 vNormal; varying vec3 vViewPosition;
      float rand(vec2 n){return fract(sin(dot(n,vec2(12.9898,4.1414)))*43758.5453);}
      float noise(vec2 p){vec2 ip=floor(p);vec2 u=fract(p);u=u*u*(3.0-2.0*u);float res=mix(mix(rand(ip),rand(ip+vec2(1.0,0.0)),u.x),mix(rand(ip+vec2(0.0,1.0)),rand(ip+vec2(1.0,1.0)),u.x),u.y);return res*res;}
      void main(){
        float glowPower = 2.6 - uDiskEchoIntensity * 1.2;
        float i=pow(0.68-dot(vNormal,normalize(vViewPosition)), glowPower);
        float p=sin(uTime*(0.7+uDiskEchoIntensity*7.0)+vNormal.y*1.8)*(0.18+uDiskEchoIntensity*0.5)+0.88;
        float noiseScale = 9.0 + uDiskEchoIntensity * 8.0;
        float f=noise(vNormal.xz*noiseScale+uTime*(1.8+uDiskEchoIntensity*6.0))*(0.35 + uDiskEchoIntensity * 0.25)+0.75;
        float fI=clamp(i*p*f,0.0,1.0)*(0.92 + uDiskEchoIntensity * 0.5);
        vec3 finalColor = uGlowColor;
        if (uDiskEchoActive > 0.5) {
          float flarePattern = noise(vNormal.xy * 15.0 + uTime * 3.0) * noise(vNormal.yz * 12.0 + uTime * 2.0);
          float flarePulse = sin(uTime * 8.0 + flarePattern * 10.0) * 0.5 + 0.5;
          vec3 flareColor = mix(uGlowColor, uDiskEchoColor, flarePulse);
          finalColor = mix(uGlowColor, flareColor * 1.8, uDiskEchoIntensity * flarePulse * 1.2);
          finalColor *= (1.0 + uDiskEchoIntensity * 0.8);
        }
        gl_FragColor=vec4(finalColor, fI);
      }`,
    transparent: true, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const glowSphere = new THREE.Mesh(new THREE.SphereGeometry(EVENT_HORIZON_RADIUS, 48, 32), glowMaterial);
  glowSphere.scale.multiplyScalar(GLOW_RADIUS_FACTOR * 1.16);
  glowSphere.renderOrder = 3;
  blackHoleGroup.add(glowSphere);

  const pointLight = new THREE.PointLight(0xffb35c, 3.5, 30);
  pointLight.position.set(0, 0, 3);
  blackHoleGroup.add(pointLight);
  blackHoleGroup.userData.light = pointLight;

  flightWorldGroup.add(blackHoleGroup);
}

function updateBlackHole(delta, elapsed, remaining) {
  const localCam = camera.position.clone();
  blackHoleGroup.worldToLocal(localCam);
  diskMaterial.uniforms.uCameraPosition.value.copy(localCam);
  diskMaterial.uniforms.uTime.value = elapsed;
  glowMaterial.uniforms.uTime.value = elapsed;
  lensingMaterial.uniforms.uTime.value = elapsed;
  photonSphereMaterial.uniforms.uTime.value = elapsed;

  const closeT = clamp01(1 - remaining / ASSIST_RANGE);
  blackHoleGroup.scale.setScalar(1 + closeT * 0.3);
  blackHoleGroup.userData.light.intensity = 3.5 + closeT * 7;
  blackHoleGroup.rotation.z += delta * 0.03;

  if (blackHoleEcho.active) {
    const et = elapsed - blackHoleEcho.startTime;
    const p = clamp01(et / blackHoleEcho.duration);
    const intensity = p < 0.12 ? p / 0.12 : Math.pow(1 - (p - 0.12) / 0.88, 1.7);
    diskMaterial.uniforms.uRippleIntensity.value = intensity;
    diskMaterial.uniforms.uRippleDistortionStrength.value = p < 0.45 ? intensity : 0;
    glowMaterial.uniforms.uDiskEchoActive.value = 1;
    glowMaterial.uniforms.uDiskEchoIntensity.value = intensity;
    lensingMaterial.uniforms.uDiskEchoActive.value = 1;
    lensingMaterial.uniforms.uDiskEchoIntensity.value = intensity;
    photonSphereMaterial.uniforms.uDiskEchoActive.value = 1;
    photonSphereMaterial.uniforms.uDiskEchoIntensity.value = intensity;
    if (et >= blackHoleEcho.duration) {
      blackHoleEcho.active = false;
      diskMaterial.uniforms.uRippleActive.value = 0;
      diskMaterial.uniforms.uRippleIntensity.value = 0;
      glowMaterial.uniforms.uDiskEchoActive.value = 0;
      lensingMaterial.uniforms.uDiskEchoActive.value = 0;
      photonSphereMaterial.uniforms.uDiskEchoActive.value = 0;
    }
  }
}

function triggerBlackHoleExplosion() {
  blackHoleEcho.active = true;
  blackHoleEcho.startTime = clock.elapsed;
  diskMaterial.uniforms.uRippleActive.value = 1;
  diskMaterial.uniforms.uRippleStartTime.value = clock.elapsed;
  spawnShockwave(blackHoleGroup.getWorldPosition(new THREE.Vector3()));
}

function spawnShockwave(worldPos) {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.15, 1, 40),
    new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.95, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  ring.position.copy(worldPos);
  ring.lookAt(camera.position);
  ring.userData.life = 0;
  flightScene.add(ring);
  shockwaves.push(ring);

  const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: goldGlowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 1 }));
  flash.position.copy(worldPos);
  flash.scale.setScalar(0.5);
  flash.userData.life = 0;
  flash.userData.isFlash = true;
  flightScene.add(flash);
  shockwaves.push(flash);
}

function updateShockwaves(delta) {
  for (let i = shockwaves.length - 1; i >= 0; i--) {
    const s = shockwaves[i];
    s.userData.life += delta;
    if (s.userData.isFlash) {
      const t = s.userData.life / 0.55;
      s.scale.setScalar(0.5 + t * 9);
      s.material.opacity = 1 * (1 - t);
      if (t >= 1) { flightScene.remove(s); shockwaves.splice(i, 1); }
    } else {
      const t = s.userData.life / 1.0;
      const scale = 1 + t * 16;
      s.scale.set(scale, scale, scale);
      s.material.opacity = 0.95 * (1 - t);
      if (t >= 1) { flightScene.remove(s); shockwaves.splice(i, 1); }
    }
  }
}

/* =============================================================================
   PORTAL/EXPLOSION TRANSITION
   ============================================================================= */

let transitionStage = 0;
let transitionTimer = 0;

function beginPortalTransition() {
  if (phase !== PHASE.FLIGHT) return;
  phase = PHASE.TRANSITION;
  transitionStage = 0;
  transitionTimer = 0;
  document.getElementById('flight-hud').classList.add('hidden');
  triggerBlackHoleExplosion();
  fadeAudioOutAndStop(planeSfx, 1.0);
}

function updateTransition(delta) {
  transitionTimer += delta;

  if (transitionStage === 0) {
    planePos.x = lerp(planePos.x, 0, expAlpha(3, delta));
    planePos.y = lerp(planePos.y, 1.2, expAlpha(3, delta));
    if (transitionTimer > 1.1) { transitionStage = 1; transitionTimer = 0; }
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
   Sky below the cake uses a cloud-sea of merged billboard sprites, in the
   style of the "live-clouds" reference (mrdoob-style flying-through-clouds).
   ============================================================================= */

function makeCloudSpriteTexture(size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const blobs = [
    [0.5, 0.55, 0.5], [0.3, 0.5, 0.34], [0.7, 0.5, 0.34], [0.42, 0.34, 0.3], [0.6, 0.37, 0.28],
  ];
  for (const [bx, by, br] of blobs) {
    const g = ctx.createRadialGradient(bx * size, by * size, 0, bx * size, by * size, br * size);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(bx * size, by * size, br * size, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function buildCloudSea() {
  const tex = makeCloudSpriteTexture(128);
  const count = QUALITY.cloudSea;
  const planeGeo = new THREE.PlaneGeometry(9, 9);
  const dummy = new THREE.Object3D();
  const geometries = [];
  for (let i = 0; i < count; i++) {
    dummy.position.set(
      THREE.MathUtils.randFloatSpread(300),
      -22 - Math.random() * Math.random() * 22,
      -14 + THREE.MathUtils.randFloatSpread(300),
    );
    dummy.rotation.z = Math.random() * Math.PI;
    const s = Math.random() * Math.random() * 1.6 + 0.7;
    dummy.scale.set(s, s, 1);
    dummy.updateMatrix();
    const g = planeGeo.clone();
    g.applyMatrix4(dummy.matrix);
    geometries.push(g);
  }
  const merged = mergeGeometries(geometries);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true });
  const cloudSea = new THREE.Mesh(merged, mat);
  cloudScene.add(cloudSea);
}

function buildCloudWorld() {
  cloudScene = new THREE.Scene();
  cloudScene.fog = new THREE.FogExp2(0xbfe0ff, 0.008);
  cloudScene.add(buildSkyDome(0x4fa6e8, 0xffe3b0, 480));

  const hemi = new THREE.HemisphereLight(0xffffff, 0x89b6d8, 1.5);
  cloudScene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3d6, 2.2);
  sun.position.set(-8, 14, 6);
  cloudScene.add(sun);

  buildCloudSea();
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

    flameGroup.visible = false;
    light.intensity = 0;
    candles.push({ group, flameGroup, flame, glow, light, lit: false, phase: Math.random() * 10 });
  }
}

/* Lights the next unlit candle (one tap = one candle), with a small spark
   flash. Once every candle is lit, hands off to the wish/music sequence. */
function igniteNextCandle() {
  const c = candles.find((c) => !c.lit);
  if (!c) return false;
  c.lit = true;
  c.flameGroup.visible = true;
  c.flameGroup.scale.setScalar(0.001);
  c.light.intensity = 0;
  const igniteStart = clock.elapsed;
  const dur = 0.35;
  const grow = () => {
    const t = clamp01((clock.elapsed - igniteStart) / dur);
    const s = 1 - Math.pow(1 - t, 3);
    c.flameGroup.scale.setScalar(Math.max(0.001, s));
    c.light.intensity = 0.9 * s;
    if (t < 1) requestAnimationFrame(grow);
  };
  grow();
  spawnIgniteSpark(c.group.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.1, 0)));

  if (!candles.some((x) => !x.lit)) {
    setTimeout(finishLightingCandles, 500);
  }
  return true;
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
  if (candleStage !== 'blow') return false;
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

/* --------------------------- ignite spark (one-shot) ------------------------ */

function spawnIgniteSpark(worldPos) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: goldGlowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 1 }));
  sprite.position.copy(worldPos);
  sprite.scale.setScalar(0.05);
  sprite.userData.life = 0;
  cloudScene.add(sprite);
  smokePuffs.push(sprite);
  sprite.userData.isSpark = true;
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
    if (s.userData.isSpark) {
      const t = s.userData.life / 0.4;
      s.scale.setScalar(0.05 + t * 0.5);
      s.material.opacity = 1 * (1 - t);
      if (t >= 1) { s.parent && s.parent.remove(s); smokePuffs.splice(i, 1); }
      continue;
    }
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
  plane.rotation.set(0, 0, 0);
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

  // fly the plane into its shrunken circling orbit beside the island/cake
  planeOrbit.center.set(0, 0.4, -14);
  const start = plane.position.clone();
  const orbitStart = new THREE.Vector3(
    planeOrbit.center.x + Math.cos(0) * planeOrbit.radius,
    planeOrbit.center.y + planeOrbit.height,
    planeOrbit.center.z + Math.sin(0) * planeOrbit.radius,
  );
  plane.lookAt(orbitStart);
  const dur = 3.2;
  let t = 0;
  const step = () => {
    t += 1 / 60;
    const a = clamp01(t / dur);
    const eased = 1 - Math.pow(1 - a, 3);
    plane.position.lerpVectors(start, orbitStart, eased);
    const scale = lerp(PLANE_FULL_SCALE, PLANE_TOY_SCALE, eased);
    plane.scale.setScalar(scale);
    if (a < 1) {
      requestAnimationFrame(step);
    } else {
      planeOrbit.angle = 0;
      planeOrbit.active = true;
    }
  };
  step();
}

/* =============================================================================
   SKIP-TO-CAKE (PIN shortcut)
   ============================================================================= */

function openPinModal() {
  pinEntry = '';
  updatePinDots();
  document.getElementById('pin-dots').classList.remove('pin-error');
  document.getElementById('pin-modal').classList.remove('hidden');
}

function closePinModal() {
  document.getElementById('pin-modal').classList.add('hidden');
  pinEntry = '';
  updatePinDots();
}

function updatePinDots() {
  document.querySelectorAll('#pin-dots .pin-dot').forEach((dot, i) => {
    dot.classList.toggle('filled', i < pinEntry.length);
  });
}

function pinBackspace() {
  pinEntry = pinEntry.slice(0, -1);
  updatePinDots();
}

function pinEnterDigit(digit) {
  if (pinEntry.length >= 4) return;
  pinEntry += digit;
  updatePinDots();
  if (pinEntry.length < 4) return;

  setTimeout(() => {
    if (pinEntry === CAKE_SKIP_PIN) {
      closePinModal();
      skipToCakePhase();
    } else {
      const dotsEl = document.getElementById('pin-dots');
      dotsEl.classList.add('pin-error');
      setTimeout(() => {
        dotsEl.classList.remove('pin-error');
        pinEntry = '';
        updatePinDots();
      }, 400);
    }
  }, 120);
}

/* Jumps straight from wherever the flight currently is into the cake scene,
   reusing the same orbit/candle setup the normal arrival cinematic ends
   on — just computed instantly instead of animated into. */
function skipToCakePhase() {
  if (phase === PHASE.CANDLES || phase === PHASE.CELEBRATION) return;

  document.getElementById('start-screen').classList.add('hidden');
  document.getElementById('flight-hud').classList.add('hidden');
  document.getElementById('gameover-ui').classList.add('hidden');
  document.getElementById('skip-btn').classList.add('hidden');
  document.getElementById('flash-overlay').style.opacity = '0';

  stopAudioSafe(planeSfx);
  stopAudioSafe(gameoverSfx);
  stopAudioSafe(bgm);

  offPathTimer = 0;
  transitionStage = 0;
  transitionTimer = 0;
  cinematic = null;

  switchToCloudWorld();

  planeOrbit.center.set(0, 0.4, -14);
  const orbitStart = new THREE.Vector3(
    planeOrbit.center.x + Math.cos(0) * planeOrbit.radius,
    planeOrbit.center.y + planeOrbit.height,
    planeOrbit.center.z + Math.sin(0) * planeOrbit.radius,
  );
  plane.position.copy(orbitStart);
  plane.scale.setScalar(PLANE_TOY_SCALE);
  plane.lookAt(new THREE.Vector3(orbitStart.x, orbitStart.y, orbitStart.z - 1));
  planeOrbit.angle = 0;
  planeOrbit.active = true;

  startCandlePhase();
}

/* Step 1 of the cake phase: ask the user to light each candle themselves
   before anything else happens. */
function startCandlePhase() {
  phase = PHASE.CANDLES;
  cameraMode = 'candles';
  candleStage = 'light';
  document.getElementById('skip-btn').classList.add('hidden');

  document.getElementById('candle-ui').classList.remove('hidden');
  const lightTitle = document.getElementById('light-title');
  const lightBtn = document.getElementById('light-btn');

  lightTitle.classList.remove('hidden');
  lightBtn.classList.remove('hidden');
  if (window.gsap) {
    gsap.fromTo([lightTitle, lightBtn], { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power2.out', stagger: 0.08 });
  }
}

/* Step 2: every candle is now lit — a short "Make a Wish" beat, then the
   song + lyrics start (step 3). No candle interaction happens during the
   song; blowing is only offered once the music finishes (step 4). */
function finishLightingCandles() {
  candleStage = 'wish';
  const lightTitle = document.getElementById('light-title');
  const lightBtn = document.getElementById('light-btn');
  const wish = document.getElementById('wish-title');

  const showWish = () => {
    lightTitle.classList.add('hidden');
    lightBtn.classList.add('hidden');
    wish.classList.remove('hidden');
    if (window.gsap) gsap.fromTo(wish, { opacity: 0 }, { opacity: 1, duration: 0.5, ease: 'power2.out' });

    setTimeout(() => {
      const hideWishThenPlayMusic = () => {
        wish.classList.add('hidden');
        wish.style.opacity = '';
        startMusicAndSubtitles();
      };
      if (window.gsap) {
        gsap.to(wish, { opacity: 0, duration: 0.35, ease: 'power2.in', onComplete: hideWishThenPlayMusic });
      } else {
        hideWishThenPlayMusic();
      }
    }, 1800);
  };

  if (window.gsap) {
    gsap.to([lightTitle, lightBtn], { opacity: 0, duration: 0.3, ease: 'power2.in', onComplete: showWish });
  } else {
    showWish();
  }
}

/* Step 3: play the birthday song with synced lyric subtitles. Nothing else
   in the candle UI is shown while this runs. Moves to step 4 when the
   track ends (or, if music.mp3 is missing/blocked, after a fallback
   timer sized to the song's known length). */
function startMusicAndSubtitles() {
  candleStage = 'music';
  musicStarted = true;
  musicClockStart = clock.elapsed;

  let advanced = false;
  const goToBlowPhase = () => {
    if (advanced) return;
    advanced = true;
    startBlowPhase();
  };

  if (bgm) {
    bgm.currentTime = 0;
    bgm.volume = 0.85;
    bgm.addEventListener('ended', goToBlowPhase, { once: true });
    playAudioSafe(bgm);
  }
  setTimeout(goToBlowPhase, SONG_FALLBACK_DURATION * 1000);
}

/* Step 4: the song has finished — now ask the user to blow the candles out. */
function startBlowPhase() {
  if (phase !== PHASE.CANDLES) return;
  candleStage = 'blow';

  const blow = document.getElementById('blow-title');
  const micBtn = document.getElementById('mic-btn');
  const blowBtn = document.getElementById('blow-btn');

  blow.classList.remove('hidden');
  micBtn.classList.remove('hidden');
  blowBtn.classList.remove('hidden');
  if (window.gsap) {
    gsap.fromTo(blow, { opacity: 0 }, { opacity: 1, duration: 0.5, ease: 'power2.out' });
    gsap.fromTo([micBtn, blowBtn], { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power2.out', stagger: 0.08 });
  }
  startMicListening();
}

function startCelebration() {
  phase = PHASE.CELEBRATION;
  cameraMode = 'orbit';
  document.getElementById('candle-ui').classList.add('hidden');
  const el = document.getElementById('celebration-ui');
  el.classList.remove('hidden');
  const lines = el.querySelectorAll('.celebrate-text');
  if (window.gsap) {
    gsap.timeline({ delay: 0.3 }).to(lines, {
      opacity: 1, y: 0, scale: 1, duration: 0.8, ease: 'power3.out', stagger: 0.9,
    });
  } else {
    lines.forEach((line) => { line.style.opacity = '1'; line.style.transform = 'none'; });
  }
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
  if (!micReady || phase !== PHASE.CANDLES || candleStage !== 'blow') return;
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
  if (!musicStarted || musicClockStart === null) {
    if (currentLyricIndex !== -1) {
      subtitleTextEl.classList.remove('show');
      currentLyricIndex = -1;
    }
    return;
  }

  const t = (bgm && !bgm.paused && !bgm.ended && bgm.duration)
    ? bgm.currentTime
    : (clock.elapsed - musicClockStart);

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

  document.getElementById('light-btn')?.addEventListener('click', () => {
    if (phase === PHASE.CANDLES && candleStage === 'light') igniteNextCandle();
  });
  document.getElementById('blow-btn').addEventListener('click', () => {
    if (phase === PHASE.CANDLES && candleStage === 'blow') extinguishNextCandle();
  });

  document.getElementById('skip-btn')?.addEventListener('click', openPinModal);
  document.getElementById('pin-close-btn')?.addEventListener('click', closePinModal);
  document.querySelectorAll('.pin-key[data-digit]').forEach((btn) => {
    btn.addEventListener('click', () => pinEnterDigit(btn.dataset.digit));
  });
  document.getElementById('pin-backspace')?.addEventListener('click', pinBackspace);
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
    updateFlightWorld(delta, clock.elapsed);
    updateBlackHole(delta, clock.elapsed, remaining);
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
  checkOffPath(delta);

  if (activeScene === flightScene) {
    bgUniforms.u_time.value = clock.elapsed * 0.5;
    renderer.autoClear = false;
    renderer.clear();
    renderer.render(bgScene, bgCamera);
    renderer.clearDepth();
    renderer.render(flightScene, camera);
  } else {
    renderer.autoClear = true;
    renderer.render(activeScene, camera);
  }
}

function updateDistanceUI(remaining) {
  const pct = clamp01(1 - remaining / PORTAL_TOTAL_DISTANCE) * 100;
  const fill = document.getElementById('distance-fill');
  if (fill) fill.style.width = pct + '%';
}

/* =============================================================================
   BOOTSTRAP
   ============================================================================= */

function init() {
  setupRenderer();
  buildSpaceBackground();
  buildFlightWorld();
  activeScene = flightScene;
  buildPlane();
  bindInput();

  camera.position.copy(camPos);
  camera.lookAt(camLookAt);

  subtitleEl = document.getElementById('subtitle-box');
  subtitleTextEl = document.getElementById('subtitle-text');
  bgm = document.getElementById('bgm');
  planeSfx = document.getElementById('plane-sfx');
  gameoverSfx = document.getElementById('gameover-sfx');

  document.getElementById('retry-btn')?.addEventListener('click', retryFlight);

  if (window.lucide) lucide.createIcons();

  requestAnimationFrame(animate);
  runLoadingSequence();
}

function runLoadingSequence() {
  const fill = document.getElementById('loading-fill');
  let p = 0;
  const timer = setInterval(() => {
    p += 18 + Math.random() * 22;
    fill.style.width = Math.min(p, 100) + '%';
    if (p >= 100) {
      clearInterval(timer);
      setTimeout(() => {
        document.getElementById('loading-screen').classList.add('hidden');
        document.getElementById('start-screen').classList.remove('hidden');
        document.getElementById('skip-btn').classList.remove('hidden');
        if (window.gsap) {
          gsap.fromTo('.start-card',
            { opacity: 0, y: 26, scale: 0.96 },
            { opacity: 1, y: 0, scale: 1, duration: 0.75, ease: 'power3.out' });
        }
      }, 200);
    }
  }, 140);
}

document.getElementById('start-btn')?.addEventListener('click', startGame);
function startGame() {
  document.getElementById('start-screen').classList.add('hidden');
  document.getElementById('flight-hud').classList.remove('hidden');

  if (planeSfx) {
    planeSfx.volume = 0.5;
    playAudioSafe(planeSfx);
  }

  setTimeout(() => {
    const hint = document.getElementById('hint-bubble');
    if (hint) hint.style.opacity = '0';
  }, 3200);
}

function triggerGameOver() {
  if (phase !== PHASE.FLIGHT) return;
  phase = PHASE.GAMEOVER;
  offPathTimer = 0;
  document.getElementById('flight-hud').classList.add('hidden');
  document.getElementById('gameover-ui').classList.remove('hidden');
  if (window.gsap) {
    gsap.fromTo('.gameover-card', { opacity: 0, y: 20, scale: 0.94 }, { opacity: 1, y: 0, scale: 1, duration: 0.6, ease: 'power3.out' });
  }
  if (planeSfx) stopAudioSafe(planeSfx);
  if (gameoverSfx) {
    gameoverSfx.currentTime = 0;
    playAudioSafe(gameoverSfx);
  }
}

function retryFlight() {
  document.getElementById('gameover-ui').classList.add('hidden');
  if (gameoverSfx) stopAudioSafe(gameoverSfx);

  totalDistance = 0;
  offPathTimer = 0;
  inputX = 0; inputY = 0; rawTargetX = 0; rawTargetY = 0;
  planePos.set(0, 0, 0);
  plane.position.set(0, 0, 0);
  plane.scale.setScalar(PLANE_FULL_SCALE);
  plane.rotation.set(0, 0, 0);
  bankPivot.rotation.z = 0;
  pitchPivot.rotation.x = 0;

  blackHoleEcho.active = false;
  diskMaterial.uniforms.uRippleActive.value = 0;
  diskMaterial.uniforms.uRippleIntensity.value = 0;
  diskMaterial.uniforms.uRippleDistortionStrength.value = 0;
  glowMaterial.uniforms.uDiskEchoActive.value = 0;
  lensingMaterial.uniforms.uDiskEchoActive.value = 0;
  photonSphereMaterial.uniforms.uDiskEchoActive.value = 0;

  document.getElementById('flash-overlay').style.opacity = '0';
  document.getElementById('flight-hud').classList.remove('hidden');
  document.getElementById('hint-bubble').style.opacity = '1';

  phase = PHASE.FLIGHT;

  if (planeSfx) { planeSfx.currentTime = 0; playAudioSafe(planeSfx); }

  setTimeout(() => {
    const hint = document.getElementById('hint-bubble');
    if (hint) hint.style.opacity = '0';
  }, 3200);
}

init();
