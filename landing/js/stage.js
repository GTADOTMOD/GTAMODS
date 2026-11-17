import * as THREE from "../vendor/three.module.min.js";

/*
 * The 3D phone and its coins, on one see-through canvas fixed over the page: dark titanium, a worn rose-gold
 * edge, real glass, a streetlight on one side and neon on the other, and its reflection on the wet ground below.
 * main.js decides where it goes for the current scroll position, as a pose, and this draws it.
 */
const PHONE_W = 3.72;
const PHONE_H = 7.08;
const SCREEN_W = 3.5;
const SCREEN_H = 6.65; // the app's screen is 360 by 684
const FOV = 22;
const CAMERA_Z = 28;
const GROUND_GAP = 0.08; // between the phone and its reflection, in phone units
const COIN_R = 0.72;
const COIN_FIELD_R = 0.6; // the picture sits inside the raised rim
const COIN_FIELD_Z = 0.05;
const COIN_RIM_Z = 0.075;

/*
 * Where the coins rest, a different arrangement for each part of the story, so they compose with the phone like
 * things in a photograph and never line up like a chart. In phone units, from the phone's centre:
 *   side  "out" is the room between the phone and the edge of the view, "in" the room towards the words;
 *   u     how far into that room, 0 against the phone and 1 as far as it goes;
 *   y     up from the phone's centre; z, towards the camera, so nearer coins look bigger; d, how wide;
 *   yaw   how far the face turns towards the phone; pitch, tipped back or forward.
 * Never more than three to a side, with room between them, so they never stack into a column.
 * The seventh coin is the one made from the in-game photo. It waits inside the screen (d 0) until the last step.
 */
const PHOTO_WAITS = { screen: true, d: 0 };
const FORMS = {
  // Loose and uneven, the way coins land: big and near low on one side, small and far high on the other.
  hero: [
    { side: "out", u: 0.6, y: 2.35, z: 0.6, d: 1.12, yaw: 0.38, pitch: -0.1 },
    { side: "in", u: 0.35, y: 1.8, z: 0.25, d: 0.88, yaw: 0.5, pitch: 0.06 },
    { side: "out", u: 0.12, y: 0.1, z: 1.5, d: 1.45, yaw: 0.22, pitch: 0.08 },
    { side: "in", u: 0.9, y: -0.45, z: 0.9, d: 1.2, yaw: 0.3, pitch: -0.05 },
    { side: "out", u: 0.8, y: -2.25, z: 0.35, d: 0.96, yaw: 0.42, pitch: 0.1 },
    { side: "in", u: 0.1, y: -2.6, z: 1.9, d: 1.5, yaw: 0.2, pitch: 0.14 },
    PHOTO_WAITS,
  ],
  // Climbing towards the words and growing as they go, like the chart of a coin taking off; across the phone, a loose few.
  trending: [
    { side: "in", u: 0.1, y: -2.4, z: 0.5, d: 0.82, yaw: 0.3, pitch: 0.1 },
    { side: "in", u: 0.55, y: -0.15, z: 0.9, d: 0.98, yaw: 0.34, pitch: 0 },
    { side: "in", u: 0.95, y: 2.2, z: 1.3, d: 1.16, yaw: 0.4, pitch: -0.1 },
    { side: "out", u: 0.35, y: 2.55, z: 0.6, d: 0.86, yaw: 0.44, pitch: -0.08 },
    { side: "out", u: 0.85, y: 0.6, z: 1.1, d: 1.04, yaw: 0.36, pitch: 0 },
    { side: "out", u: 0.3, y: -1.9, z: 0.7, d: 0.9, yaw: 0.4, pitch: 0.08 },
    PHOTO_WAITS,
  ],
  // Thrown out of the screen towards you, the nearest ones big.
  trade: [
    { side: "out", u: 0.85, y: 2.3, z: 4.2, d: 1.1, yaw: 0.5, pitch: -0.16 },
    { side: "out", u: 0.2, y: -0.1, z: 1.2, d: 0.82, yaw: 0.32, pitch: 0 },
    { side: "out", u: 0.6, y: -2.5, z: 2.8, d: 1.0, yaw: 0.44, pitch: 0.1 },
    { side: "in", u: 0.3, y: 2.6, z: 2.0, d: 0.84, yaw: 0.36, pitch: -0.1 },
    { side: "in", u: 0.8, y: 0.4, z: 0.9, d: 0.76, yaw: 0.4, pitch: 0 },
    { side: "in", u: 0.4, y: -2.2, z: 3.4, d: 1.12, yaw: 0.34, pitch: 0.12 },
    PHOTO_WAITS,
  ],
  // Swap: they circle the phone, passing behind it and out in front again.
  swap: "orbit",
  // Wallet: one big and near beside the screen, the rest spread round it at different depths.
  wallet: [
    { side: "in", u: 0.6, y: 2.5, z: 0.7, d: 0.9, yaw: 0.36, pitch: -0.08 },
    { side: "in", u: 0.15, y: 0.25, z: 1.5, d: 1.15, yaw: 0.3, pitch: 0 },
    { side: "in", u: 0.75, y: -2.15, z: 0.6, d: 0.86, yaw: 0.4, pitch: 0.08 },
    { side: "out", u: 0.4, y: 1.7, z: 1.0, d: 1.0, yaw: 0.38, pitch: -0.05 },
    { side: "out", u: 0.85, y: -0.7, z: 0.4, d: 0.8, yaw: 0.44, pitch: 0 },
    { side: "out", u: 0.25, y: -2.75, z: 1.6, d: 1.1, yaw: 0.32, pitch: 0.1 },
    PHOTO_WAITS,
  ],
  // Create: the photo becomes a coin, big and near; the others stand back, small and far.
  create: [
    { side: "out", u: 0.55, y: 2.6, z: -0.5, d: 0.78, yaw: 0.4, pitch: -0.1 },
    { side: "out", u: 0.9, y: 0.85, z: -0.8, d: 0.7, yaw: 0.4, pitch: 0 },
    { side: "out", u: 0.35, y: -0.85, z: -0.4, d: 0.82, yaw: 0.36, pitch: 0.05 },
    { side: "out", u: 0.75, y: -2.55, z: -0.7, d: 0.74, yaw: 0.4, pitch: 0.1 },
    { side: "in", u: 0.7, y: 2.4, z: -0.6, d: 0.72, yaw: 0.44, pitch: -0.06 },
    { side: "in", u: 0.3, y: 0.75, z: -0.8, d: 0.66, yaw: 0.44, pitch: 0 },
    { side: "in", u: 0, y: -1.6, z: 3.2, d: 1.9, yaw: 0.26, pitch: 0.06 }, // the photo
  ],
};
// The circle in "swap": its height and depth in phone units, how much of the room it reaches into, and its speed.
// It tips steeply: beside the phone at its middle, under its foot on the way round in front, and behind its top going back,
// so a coin never crosses the screen.
const ORBIT = { y: -0.55, ry: 3.55, rz: 2.4, reach: 0.95, d: 0.92, speed: 0.18 };
// Each coin's own slow drift and wobble, never two alike, and how late it comes out of the screen.
const IDLE = [
  { w: 0.47, a: 0.09, p: 0.0, at: 2.0 },
  { w: 0.61, a: 0.07, p: 1.7, at: 7.1 },
  { w: 0.39, a: 0.11, p: 3.1, at: 4.4 },
  { w: 0.55, a: 0.08, p: 4.6, at: 10.2 },
  { w: 0.43, a: 0.1, p: 2.4, at: 0.6 },
  { w: 0.66, a: 0.06, p: 5.5, at: 5.8 },
  { w: 0.35, a: 0.05, p: 0.9, at: 0 },
];
// In phone units: the gap a coin keeps from the phone, and from the edge or the words.
const COIN_GAP = 0.14;
const COIN_MARGIN = 0.3;

const easeOut = (t) => 1 - (1 - t) ** 3;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

function roundedRect(w, h, r) {
  const x = -w / 2;
  const y = -h / 2;
  const s = new THREE.Shape();
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0);
  s.lineTo(x + w, y + h - r);
  s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2);
  s.lineTo(x + r, y + h);
  s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
  s.lineTo(x, y + r);
  s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
  return s;
}

/** A flat rounded rectangle whose texture coordinates run 0 to 1 across it. */
function plate(w, h, r) {
  const g = new THREE.ShapeGeometry(roundedRect(w, h, r), 18);
  const p = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / w + 0.5, p.getY(i) / h + 0.5);
  return g;
}

/** A thin rounded ring, for the metal edge around the glass. */
function ring(w, h, r, thickness) {
  const shape = roundedRect(w, h, r);
  shape.holes.push(roundedRect(w - thickness * 2, h - thickness * 2, r - thickness));
  return new THREE.ShapeGeometry(shape, 24);
}

/** The coin's metal: a raised rim on both faces and a rounded edge, turned on a lathe. */
function coinBody() {
  const top = [
    [COIN_FIELD_R, COIN_FIELD_Z],
    [COIN_FIELD_R + 0.022, COIN_RIM_Z - 0.006],
    [COIN_FIELD_R + 0.04, COIN_RIM_Z],
    [COIN_R - 0.03, COIN_RIM_Z],
    [COIN_R - 0.008, COIN_RIM_Z - 0.01],
    [COIN_R, COIN_RIM_Z - 0.03],
  ];
  const bottom = top.map(([r, z]) => [r, -z]);
  const profile = [...bottom, ...top.reverse()].map(([r, z]) => new THREE.Vector2(r, z));
  return new THREE.LatheGeometry(profile, 96).rotateX(Math.PI / 2);
}

/** Fine ridges around the coin's edge, and nowhere else. */
function coinReeding() {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = "#808080";
  g.fillRect(0, 0, 1024, 256);
  const from = (256 * 5) / 11; // the profile has 12 points, and the edge is the middle stretch
  const reeds = 128;
  for (let i = 0; i < reeds; i++) {
    g.fillStyle = i % 2 ? "#303030" : "#d0d0d0";
    g.fillRect((i * 1024) / reeds, from, 1024 / reeds, 256 / 11);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** A dark wet night to reflect in the metal, with bright strips for crisp edges of light. */
function nightEnvironment(renderer) {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(
    new THREE.SphereGeometry(20, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      vertexShader: "varying vec3 p; void main(){ p = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }",
      fragmentShader: `varying vec3 p;
        void main(){
          float t = normalize(p).y;
          vec3 low = vec3(.02,.025,.05);
          vec3 glow = vec3(.5,.2,.09);
          vec3 top = vec3(.03,.02,.06);
          vec3 c = t < 0. ? mix(glow, low, smoothstep(0.,-.4,t)) : mix(glow, top, smoothstep(0.,.5,t));
          gl_FragColor = vec4(c,1.);
        }`,
    }),
  ));
  const strip = (color, intensity, x, y, z, w, h) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }));
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    scene.add(m);
  };
  strip("#ffc48a", 9, -9, 7, 8, 2.4, 15); // the streetlight
  strip("#ff5a9a", 2.2, 11, 1, 4, 1.6, 15); // the neon
  strip("#4f7dff", 2.5, 0, -11, 6, 14, 1.6); // the city from below
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(scene, 0.02).texture;
  pmrem.dispose();
  return env;
}

/** What the coins reflect: soft warm lamps, so gold looks like gold and not like the neon around it. */
function coinEnvironment(renderer) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0.13, 0.09, 0.055);
  const lamp = (color, intensity, x, y, z, w, h) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }));
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    scene.add(m);
  };
  lamp("#fff0d8", 7, -8, 9, 7, 10, 7); // the big soft one, up and to the left
  lamp("#ffe2b8", 4, 10, 2, 6, 3, 14);
  lamp("#ffd9a0", 1.6, 0, -11, 4, 16, 3);
  lamp("#fff6e8", 12, 3, 12, -2, 7, 1.2); // a hard line of light across the rim
  lamp("#7fd8ff", 1.2, -12, -3, -4, 2, 12);
  lamp("#ff6aa8", 1.1, 12, -2, 1, 1.2, 10); // a thin touch of the neon, on the rim only
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(scene, 0.015).texture;
  pmrem.dispose();
  return env;
}

const SCREEN_VERTEX = "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }";

const SCREEN_SHARED = `
  uniform sampler2D a;
  uniform sampler2D b;
  uniform float mixAmount;
  uniform float reveal;
  varying vec2 vUv;
  vec3 app(float blur){
    float m = smoothstep(0., 1., mixAmount);
    vec3 ca = texture2D(a, vUv + vec2(0., m * .05), blur).rgb;
    vec3 cb = texture2D(b, vUv + vec2(0., (m - 1.) * .05), blur).rgb;
    return mix(ca, cb, m);
  }`;

// The app, a little under full brightness like a real screen in the dark, under real glass:
// one soft streak of light that moves as the phone turns, and faint smudges.
const SCREEN_FRAGMENT = `${SCREEN_SHARED}
  uniform float sheen;
  float noise(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  float smudge(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3. - 2. * f);
    return mix(mix(noise(i), noise(i + vec2(1., 0.)), u.x), mix(noise(i + vec2(0., 1.)), noise(i + vec2(1., 1.)), u.x), u.y);
  }
  void main(){
    vec3 c = app(-.75) * .96; // a little sharper than the mipmaps, so small type stays crisp
    float d = vUv.x * .85 + vUv.y * .55 - sheen;
    float streak = smoothstep(0., .3, d) * (1. - smoothstep(.3, .8, d));
    float marks = smudge(vUv * vec2(9., 17.)) * smudge(vUv * vec2(31., 53.));
    c += vec3(.0055, .005, .0065) * streak * (.55 + marks); // in linear light, where this is plenty over black
    gl_FragColor = vec4(c * reveal, 1.);
    #include <colorspace_fragment>
  }`;

// The same screen, blurred and fading out, as a reflection on wet ground.
const REFLECTION_FRAGMENT = `${SCREEN_SHARED}
  uniform float strength;
  void main(){
    float fade = (1. - smoothstep(0., .34, vUv.y)) * strength;
    vec3 c = app(3.2);
    gl_FragColor = vec4(c, fade * reveal);
    #include <colorspace_fragment>
  }`;

export class Stage {
  constructor(canvas, { screens, coinFaces, coinReverse, photoFace }) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "high-performance" });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
    this.camera.position.z = CAMERA_Z;
    this.scene = new THREE.Scene();
    this.scene.environment = nightEnvironment(this.renderer);
    this.pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    this.textures = new Map();
    this.screenCount = screens.length;
    this.groundMirror = new THREE.Matrix4();

    const lamp = new THREE.DirectionalLight("#ffb06a", 1.8);
    lamp.position.set(-8, 10, 10);
    const neon = new THREE.DirectionalLight("#ff5a9a", 0.8);
    neon.position.set(10, 0, -2);
    const city = new THREE.DirectionalLight("#4a78ff", 0.7);
    city.position.set(0, -10, 6);
    this.scene.add(lamp, neon, city);

    // The coins are drawn in a second pass with their own light, because these lamps would turn gold red.
    this.coinScene = new THREE.Scene();
    this.coinScene.environment = coinEnvironment(this.renderer);
    const coinKey = new THREE.DirectionalLight("#fff1dc", 1.3);
    coinKey.position.set(-6, 8, 10);
    this.screenLight = new THREE.PointLight("#ffe6da", 0, 16, 1.6); // the phone's screen, on whatever is near it
    this.coinScene.add(coinKey, this.screenLight);
    this.renderer.autoClear = false;

    this.buildPhone();
    this.buildCoins([...coinFaces, photoFace], coinReverse);
    this.buildGlow();
    this.buildDust();
    this.loadScreens(screens);
    this.resize();
    window.addEventListener("resize", () => this.resize());
    window.addEventListener("pointermove", (e) => {
      this.pointer.tx = (e.clientX / window.innerWidth) * 2 - 1;
      this.pointer.ty = (e.clientY / window.innerHeight) * 2 - 1;
    }, { passive: true });
  }

  buildPhone() {
    const phone = new THREE.Group();
    const titanium = new THREE.MeshPhysicalMaterial({ color: "#2c2a30", metalness: 0.9, roughness: 0.4, clearcoat: 0.35, clearcoatRoughness: 0.4, envMapIntensity: 1.1 });
    const depth = 0.42;
    const bevel = 0.06;
    const r = 0.56;
    const body = new THREE.Mesh(
      new THREE.ExtrudeGeometry(roundedRect(PHONE_W - bevel * 2, PHONE_H - bevel * 2, r), { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 6, curveSegments: 28 }),
      titanium,
    );
    body.position.z = -depth / 2;
    phone.add(body);
    const front = depth / 2 + bevel;

    // A thin line of worn rose gold around the glass, and nothing louder.
    const edge = new THREE.Mesh(ring(PHONE_W - 0.03, PHONE_H - 0.03, r + 0.04, 0.035), new THREE.MeshStandardMaterial({ color: "#a08a7c", metalness: 1, roughness: 0.42, envMapIntensity: 1 }));
    edge.position.z = front + 0.001;
    phone.add(edge);

    const glass = new THREE.Mesh(plate(PHONE_W - 0.1, PHONE_H - 0.1, r), new THREE.MeshPhysicalMaterial({ color: "#040307", metalness: 0, roughness: 0.1, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 0.9 }));
    glass.position.z = front + 0.002;
    phone.add(glass);

    this.uniforms = { a: { value: null }, b: { value: null }, mixAmount: { value: 0 }, reveal: { value: 0 } };
    this.screenMaterial = new THREE.ShaderMaterial({
      toneMapped: false,
      uniforms: { ...this.uniforms, sheen: { value: 0 } },
      vertexShader: SCREEN_VERTEX,
      fragmentShader: SCREEN_FRAGMENT,
    });
    const screen = new THREE.Mesh(plate(SCREEN_W, SCREEN_H, 0.4), this.screenMaterial);
    screen.position.z = front + 0.004;
    phone.add(screen);

    const button = (x, y, h) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.06, h, 0.17), titanium);
      m.position.set(x, y, 0);
      phone.add(m);
    };
    button(PHONE_W / 2 + 0.012, 1.45, 1);
    button(-PHONE_W / 2 - 0.012, 1.75, 0.46);
    button(-PHONE_W / 2 - 0.012, 1.05, 0.46);

    this.phone = phone;
    this.scene.add(phone);

    // Its reflection: the same screen, mirrored below the ground line.
    this.reflectionMaterial = new THREE.ShaderMaterial({
      toneMapped: false,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: { ...this.uniforms, strength: { value: 0.3 } },
      vertexShader: SCREEN_VERTEX,
      fragmentShader: REFLECTION_FRAGMENT,
    });
    const reflection = new THREE.Mesh(plate(SCREEN_W, SCREEN_H, 0.4), this.reflectionMaterial);
    reflection.matrixAutoUpdate = false;
    this.reflection = reflection;
    this.scene.add(reflection);
  }

  /** Heavy gold coins that come out of the screen: a sample token enamelled on one side, a palm in relief on the other. */
  buildCoins(faces, reverse) {
    const loader = new THREE.TextureLoader();
    const picture = (src) => {
      const t = loader.load(src);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      return t;
    };
    const gold = new THREE.MeshPhysicalMaterial({ color: "#ffc964", metalness: 1, roughness: 0.2, envMapIntensity: 1.25, bumpMap: coinReeding(), bumpScale: 1.2 });
    const palm = picture(reverse);
    const tails = new THREE.MeshPhysicalMaterial({ color: "#fff0d0", map: palm, bumpMap: palm, bumpScale: 0.7, emissive: "#ffffff", emissiveMap: palm, emissiveIntensity: 0.1, metalness: 1, roughness: 0.3, envMapIntensity: 1.5 });
    const heads = faces.map((src) => {
      const map = picture(src);
      return new THREE.MeshPhysicalMaterial({ map, emissive: "#ffffff", emissiveMap: map, emissiveIntensity: 0.34, metalness: 0, roughness: 0.55, clearcoat: 0.18, clearcoatRoughness: 0.3, envMapIntensity: 0.22 });
    });
    const body = coinBody();
    const field = new THREE.CircleGeometry(COIN_FIELD_R + 0.002, 64);

    const make = (i) => {
      const coin = new THREE.Group();
      const front = new THREE.Mesh(field, heads[i % heads.length]);
      front.position.z = COIN_FIELD_Z + 0.001;
      const back = new THREE.Mesh(field, tails);
      back.position.z = -COIN_FIELD_Z - 0.001;
      back.rotation.y = Math.PI;
      coin.add(new THREE.Mesh(body, gold), front, back);
      coin.visible = false;
      this.coinScene.add(coin);
      return coin;
    };

    this.floating = faces.map((_, i) => ({ coin: make(i), idle: IDLE[i] }));
  }

  /**
   * Where each coin of a formation rests, in the view's units, with the phone at anchor ({x, y, h}, as in a pose)
   * and the words between words.l and words.r, as fractions of the view. A coin that doesn't fit gets smaller,
   * and then overlaps the edge of the phone rather than the words.
   */
  resolve(name, anchor, words, time) {
    const scale = (anchor.h * this.viewH) / PHONE_H;
    const px = anchor.x * this.viewW;
    const py = anchor.y * this.viewH;
    const half = PHONE_W / 2;
    const out = px >= 0 ? 1 : -1; // the phone's own side of the view, where its outer room is
    const roomOut = (this.viewW / 2 - px * out) / scale - half;
    const limit = words ? (out > 0 ? words.r : words.l) * this.viewW : (-out * this.viewW) / 2;
    const roomIn = Math.abs(px - limit) / scale - half;
    const place = (x, y, z, d) => ({ x: px + x * scale, y: py + y * scale, z: z * scale, d: d * scale });
    const last = this.floating.length - 1;

    if (FORMS[name] === "orbit") {
      const reach = half + COIN_GAP + ORBIT.d / 2 + Math.max(0, Math.min(roomOut, roomIn) - COIN_GAP - COIN_MARGIN - ORBIT.d) * ORBIT.reach;
      return this.floating.map((_, i) => {
        if (i === last) return place(0, 0, 0.3, 0);
        const a = time * ORBIT.speed + (i / last) * Math.PI * 2;
        return { ...place(Math.cos(a) * reach, ORBIT.y - Math.sin(a) * ORBIT.ry + Math.cos(a) * 0.3, Math.sin(a) * ORBIT.rz, ORBIT.d), yaw: 0.3, pitch: 0 };
      });
    }

    return FORMS[name].map((s) => {
      if (s.screen) return place(0, 0, 0.3, 0);
      const room = s.side === "out" ? roomOut : roomIn;
      const dir = s.side === "out" ? out : -out;
      // Coins nearer the camera look bigger, so they need more room.
      const seenAs = s.d / ((CAMERA_Z - s.z * scale) / CAMERA_Z);
      const fit = THREE.MathUtils.clamp((room - COIN_GAP - COIN_MARGIN) / seenAs, 0.6, 1);
      const seen = seenAs * fit;
      const spare = Math.max(0, room - COIN_GAP - COIN_MARGIN - seen);
      const x = Math.min(half + COIN_GAP + seen / 2 + s.u * spare, half + room - COIN_MARGIN - seen / 2);
      return { ...place(dir * Math.max(x, half * 0.45), s.y, s.z, s.d * fit), yaw: s.yaw, pitch: s.pitch };
    });
  }

  /**
   * pose.coins, how far they've come out of the screen (0 is all inside). pose.formA and pose.formB, the
   * formations they move between, with the phone at pose.anchorA and pose.anchorB and the words at pose.wordsA
   * and pose.wordsB; pose.formT, how far along (0 is all formA).
   */
  placeCoins(pose, time, x, y, scale) {
    const out = pose.coins ?? 0;
    const k = pose.formT ?? 0;
    const a = this.resolve(pose.formA, pose.anchorA, pose.wordsA, time);
    const b = k > 0 ? this.resolve(pose.formB, pose.anchorB, pose.wordsB, time) : a;
    const front = 0.3 * scale;
    const p = this.pointer;
    const lerp = THREE.MathUtils.lerp;
    const count = this.floating.length;

    this.floating.forEach(({ coin, idle }, i) => {
      // Out of the screen one after another, never all at once.
      const t = easeOut(clamp01((out - idle.at * 0.025) / 0.72));
      // Between formations each one sets off a little after the one before, and turns over once on the way.
      const along = easeInOut(clamp01((k - i * 0.05) / (1 - (count - 1) * 0.05)));
      const A = a[i];
      const B = b[i];
      const d = lerp(A.d, B.d, along) * (0.3 + 0.7 * t);
      coin.visible = d > 0.01 * scale;
      if (!coin.visible) return;
      const travel = Math.sin(along * Math.PI);
      const drift = idle.a * scale;
      const restX = lerp(A.x, B.x, along) + Math.sin(time * idle.w * 0.7 + idle.p * 1.3) * drift * 0.5;
      const restY = lerp(A.y, B.y, along) + Math.sin(time * idle.w + idle.p) * drift;
      const restZ = lerp(A.z, B.z, along) + travel * 1.4 * scale;
      const z = lerp(front, restZ, t);
      // Nearer the camera things look farther out from the middle, so this puts each coin exactly where it was
      // placed; its size isn't corrected, so nearer coins do look bigger.
      const near = (CAMERA_Z - z) / CAMERA_Z;
      const lean = 0.05 + (z / scale) * 0.03;
      const cx = (lerp(x, restX, t) + p.x * lean * scale) * near;
      const cy = (lerp(y, restY, t) - p.y * lean * 0.7 * scale) * near;
      coin.position.set(cx, cy, z);
      coin.scale.setScalar(d / (COIN_R * 2));

      const side = Math.sign(cx - x * near) || 1; // which side of the phone it's on, so it turns towards it
      const yaw = lerp(A.yaw ?? 0.3, B.yaw ?? 0.3, along) + Math.sin(time * idle.w * 0.9 + idle.p) * 0.16;
      const pitch = lerp(A.pitch ?? 0, B.pitch ?? 0, along) + Math.sin(time * idle.w * 0.8 + idle.p * 2) * 0.07;
      // Only on the way between formations and out of the screen do they turn over; at rest they just sway.
      const spin = (travel > 0 ? along : 0) * (i % 2 ? 1 : -1) + (1 - t);
      coin.rotation.set(
        Math.atan2(cy, CAMERA_Z - z) + pitch,
        Math.atan2(-cx, CAMERA_Z - z) - side * yaw + spin * Math.PI * 2,
        0,
      );
    });

    this.screenLight.intensity = 9 * scale * out;
    this.screenLight.position.set(x, y, front + 2.4);
  }

  /** The screen's light on the humid air behind it. */
  buildGlow() {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const g = c.getContext("2d");
    const glow = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    glow.addColorStop(0, "rgba(255,70,130,.42)");
    glow.addColorStop(0.45, "rgba(255,90,70,.13)");
    glow.addColorStop(1, "rgba(255,90,70,0)");
    g.fillStyle = glow;
    g.fillRect(0, 0, 256, 256);
    this.glow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
    );
    this.scene.add(this.glow);
  }

  /** Dust hanging in the light. */
  buildDust() {
    const count = window.innerWidth < 900 ? 50 : 120;
    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < count * 3; i++) seeds[i] = Math.random();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const c = document.createElement("canvas");
    c.width = c.height = 32;
    const g = c.getContext("2d");
    const dot = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    dot.addColorStop(0, "rgba(255,226,190,.9)");
    dot.addColorStop(1, "rgba(255,226,190,0)");
    g.fillStyle = dot;
    g.fillRect(0, 0, 32, 32);
    this.dust = new THREE.Points(geometry, new THREE.PointsMaterial({ map: new THREE.CanvasTexture(c), size: 0.07, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    this.dustSeeds = seeds;
    this.scene.add(this.dust);
  }

  loadScreens(screens) {
    const loader = new THREE.TextureLoader();
    const max = this.renderer.capabilities.getMaxAnisotropy();
    screens.forEach(({ src }, i) => {
      // One at a time after the first, so the page never stalls on them.
      window.setTimeout(() => {
        loader.load(src, (t) => {
          t.colorSpace = THREE.SRGBColorSpace;
          t.anisotropy = max;
          t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
          this.renderer.initTexture(t);
          this.textures.set(i, t);
        });
      }, i * 160);
    });
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, w < 900 ? 1.5 : 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewH = 2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * CAMERA_Z;
    this.viewW = this.viewH * this.camera.aspect;
  }

  /**
   * Draws one frame. pose: x, y as fractions of the view from its centre; h, the phone's height as a
   * fraction of the view; rx, ry, rz, its turn; screen, which screen, with fractions between two;
   * ground, how much the wet ground reflects it (0 is none).
   */
  draw(pose, time) {
    const p = this.pointer;
    p.x += (p.tx - p.x) * 0.04;
    p.y += (p.ty - p.y) * 0.04;

    const scale = (pose.h * this.viewH) / PHONE_H;
    const x = pose.x * this.viewW;
    const y = pose.y * this.viewH;
    this.phone.position.set(x, y, 0);
    this.phone.scale.setScalar(scale);
    this.phone.rotation.set(pose.rx + p.y * 0.03, pose.ry + p.x * 0.05 + Math.sin(time * 0.4) * 0.012, pose.rz);
    this.phone.updateMatrix();

    const u = this.uniforms;
    const low = Math.floor(pose.screen);
    const a = this.textures.get(low);
    const b = this.textures.get(Math.min(low + 1, this.screenCount - 1));
    if (a) {
      u.a.value = a;
      u.b.value = b ?? a;
      u.mixAmount.value = b ? pose.screen - low : 0;
      u.reveal.value = Math.min(1, u.reveal.value + 0.05);
    }
    this.screenMaterial.uniforms.sheen.value = -0.5 + (this.phone.rotation.y + 0.6) * 0.9;

    // Mirror the screen across the ground line just under the phone.
    const ground = y - (PHONE_H / 2 + GROUND_GAP) * scale;
    this.groundMirror.makeTranslation(0, ground, 0)
      .multiply(new THREE.Matrix4().makeScale(1, -1, 1))
      .multiply(new THREE.Matrix4().makeTranslation(0, -ground, 0))
      .multiply(this.phone.matrix)
      .multiply(new THREE.Matrix4().makeTranslation(0, 0, 0.3));
    this.reflection.matrix.copy(this.groundMirror);
    this.reflection.matrixWorldNeedsUpdate = true;
    this.reflection.visible = pose.ground > 0.01;
    this.reflectionMaterial.uniforms.strength.value = 0.42 * pose.ground;

    this.glow.position.set(x, y, -1.2);
    this.glow.scale.set(PHONE_W * scale * 3.1, PHONE_H * scale * 2, 1);

    this.placeCoins(pose, time, x, y, scale);

    const dust = this.dust.geometry.attributes.position;
    const s = this.dustSeeds;
    for (let i = 0; i < dust.count; i++) {
      const drift = (time * (0.01 + s[i * 3 + 2] * 0.015) + s[i * 3 + 1]) % 1;
      dust.setXYZ(i,
        x + (s[i * 3] - 0.5) * this.viewW * 0.8 + Math.sin(time * 0.2 + i) * 0.2,
        (drift - 0.5) * this.viewH * 1.1,
        (s[i * 3 + 2] - 0.5) * 7);
    }
    dust.needsUpdate = true;

    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.render(this.coinScene, this.camera);
  }
}
