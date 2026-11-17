// The desktop version: the opening flown through by scrolling, the pinned story and the 3D phone. Phones get mobile.js.
import { WORDMARK } from "./wordmark.js";

const root = document.documentElement;
const $ = (id) => document.getElementById(id);
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
/** How far v is from a to b, as 0 to 1. */
const span = (v, a, b) => clamp((v - a) / (b - a));

const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---- things appearing as they come into view --------------------------------

const seen = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    e.target.classList.add("in");
    seen.unobserve(e.target);
  }
}, { rootMargin: "0px 0px -8% 0px" });
document.querySelectorAll(".reveal").forEach((el) => seen.observe(el));

// ---- layout measurements, redone on resize -----------------------------------

const intro = document.querySelector(".intro");
const story = $("story");
const strip = $("strip");
const stepsList = [...document.querySelectorAll(".step")];
const storyPlates = [...document.querySelectorAll(".story-plates img")];
const dots = [...$("storyDots").children];
const storyShade = document.querySelector(".story-shade");
const storyShadeRight = document.querySelector(".story-shade-right");
const timed = [...document.querySelectorAll("[data-time]")];
const parallax = [...document.querySelectorAll("[data-parallax]")];
const STEP_HOLD = 0.72; // how much of each step's scroll the screen just sits there

let m = {};
function measure() {
  const y = window.scrollY;
  const top = (el) => el.getBoundingClientRect().top + y;
  const vh = window.innerHeight;
  m = {
    vh,
    introTop: top(intro),
    introTravel: intro.offsetHeight - vh,
    storyTop: top(story),
    storyTravel: story.offsetHeight - vh,
    stripTop: top(strip),
    heroWords: { ...wordsBox(document.querySelectorAll(".hero-copy h1, .hero-copy .lede")), l: -0.5 },
    stepWords: stepsList.map((el) => restingWords(el)),
    times: timed.map((el) => ({ at: top(el), minutes: toMinutes(el.dataset.time) })),
  };
}

/** A step's words where they rest, not where they are while sliding in or out. */
function restingWords(step) {
  const moved = step.style.transform;
  step.style.transform = "none";
  const box = wordsBox(step.querySelectorAll(".step-copy > *"));
  step.style.transform = moved;
  return box;
}

/** Where some words start and end across the view, as fractions from its centre, so the coins can stay off them. */
function wordsBox(elements) {
  const range = document.createRange();
  let left = Infinity;
  let right = -Infinity;
  for (const el of elements) {
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
  }
  return { l: left / window.innerWidth - 0.5, r: right / window.innerWidth - 0.5 };
}

function toMinutes(text) {
  const [h, min] = text.split(":").map(Number);
  return (h < 12 ? h + 24 : h) * 60 + min; // the night runs past midnight
}

// ---- the opening: the name, with the city inside it, flown through ------------

const mask = $("introMask");
const maskContext = mask.getContext("2d");
const wordmarkPath = new Path2D(WORDMARK.d);
let maskSize = { w: 0, h: 0 };

function sizeMask() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const w = window.innerWidth;
  const h = window.innerHeight;
  mask.width = Math.round(w * dpr);
  mask.height = Math.round(h * dpr);
  maskSize = { w, h, dpr };
}

function drawMask(t) {
  const { w, h, dpr } = maskSize;
  const g = maskContext;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.globalCompositeOperation = "source-over";
  g.clearRect(0, 0, w, h);
  const ink = g.createLinearGradient(0, 0, 0, h);
  ink.addColorStop(0, "#07050a");
  ink.addColorStop(1, "#0d0910");
  g.fillStyle = ink;
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = "destination-out";
  const base = Math.min((w * 0.9) / WORDMARK.w, (h * 0.62) / WORDMARK.h);
  const most = (Math.max(w, h) / (WORDMARK.stem.width * base)) * 1.5;
  const zoom = Math.exp(t * t * Math.log(most)); // an even feeling of speed, starting gently
  const towardStem = smooth(span(t, 0.02, 0.5));
  const fx = lerp(WORDMARK.x + WORDMARK.w / 2, WORDMARK.stem.x, towardStem);
  const fy = lerp(WORDMARK.y + WORDMARK.h / 2, WORDMARK.stem.y, towardStem);
  g.translate(w / 2, h * 0.47 + (h * 0.03) * towardStem);
  g.scale(base * zoom, base * zoom);
  g.translate(-fx, -fy);
  g.fill(wordmarkPath);
  // A thin neon edge, so the letters read even where the night inside them is dark.
  const edge = 1 - span(t, 0, 0.16);
  if (edge > 0) {
    g.globalCompositeOperation = "source-over";
    g.strokeStyle = `rgba(255, 177, 90, ${(0.8 * edge).toFixed(3)})`;
    g.lineWidth = 1.4 / (base * zoom);
    g.stroke(wordmarkPath);
  }
}

// ---- where the phone goes ----------------------------------------------------

// On very wide screens the phone stays with the content's column.
const inColumn = (x) => x * Math.min(1, 1456 / window.innerWidth);
const HIDDEN_LOW = () => ({ x: inColumn(0.25), y: -1.1, h: 0.76, rx: 0.2, ry: -0.5, rz: 0.03, ground: 0 });
const HERO = () => ({ x: inColumn(0.25), y: -0.03, h: 0.76, rx: 0.07, ry: -0.25, rz: 0.018, ground: 1 });
const GONE_UP = () => ({ x: inColumn(0.28), y: 1.1, h: 0.76, rx: -0.2, ry: 0.3, rz: -0.03, ground: 0 });

// Each screen of the story is its own shot: where the phone stands and how near, which way it's turned, and how the
// coins are arranged around it (FORMS in stage.js). A phone on the left means the words are on the right, as the
// step's data-side says. Between two screens the phone travels across to the next shot.
const SHOTS = [
  { x: 0.24, y: -0.025, h: 0.76, rx: 0.05, ry: -0.15, rz: 0, form: "hero" }, // home
  { x: -0.23, y: -0.01, h: 0.74, rx: 0.04, ry: 0.27, rz: -0.015, form: "trending" },
  { x: 0.22, y: -0.045, h: 0.84, rx: 0.1, ry: -0.32, rz: 0.025, form: "trade" },
  { x: 0.25, y: 0, h: 0.66, rx: 0.02, ry: -0.06, rz: -0.05, form: "swap" },
  { x: -0.22, y: -0.02, h: 0.76, rx: 0.06, ry: 0.22, rz: 0.03, form: "wallet" },
  { x: 0.2, y: -0.03, h: 0.78, rx: 0.05, ry: -0.24, rz: -0.02, form: "create" },
];

/** A story shot, held: over the hold (held, 0 to 1) the phone keeps turning slowly into its angle. */
function shot(i, held) {
  const s = SHOTS[i];
  const drift = held - 0.4;
  return { x: inColumn(s.x), y: s.y, h: s.h * (1 + drift * 0.035), rx: s.rx, ry: s.ry + drift * 0.09 * Math.sign(s.ry), rz: s.rz, ground: 1 };
}

function mixPose(a, b, t) {
  const out = {};
  for (const k of Object.keys(a)) out[k] = lerp(a[k], b[k], t);
  return out;
}

/** The same formation from start to end, around the phone wherever it is. */
const holding = (pose, form, words) => ({ ...pose, formA: form, formB: form, formT: 0, anchorA: pose, anchorB: pose, wordsA: words, wordsB: words });

/** Where the phone is at this scroll position, which screen it shows, and where the coins are. The coins only leave it once it's nearly there. */
function poseAt(y) {
  const { vh, introTop, introTravel, storyTop, storyTravel, heroWords, stepWords } = m;
  const introEnd = introTop + introTravel;
  const inIntro = span(y, introTop + introTravel * 0.46, introTop + introTravel * 0.86);
  if (y <= introEnd) return { ...holding(mixPose(HIDDEN_LOW(), HERO(), smooth(inIntro)), "hero", heroWords), coins: span(inIntro, 0.55, 1), screen: 0, on: inIntro > 0 };

  const leaving = span(y, introEnd, introEnd + vh * 0.8);
  const entering = span(y, storyTop - vh * 0.85, storyTop);
  if (y < storyTop) {
    if (leaving < 1) return { ...holding(mixPose(HERO(), GONE_UP(), smooth(leaving)), "hero", heroWords), coins: 1 - span(leaving, 0, 0.45), screen: 0, on: true };
    return { ...holding(mixPose(HIDDEN_LOW(), shot(0, 0), smooth(entering)), SHOTS[0].form, stepWords[0]), coins: span(entering, 0.55, 1), screen: 0, on: entering > 0 };
  }

  const count = stepsList.length;
  const along = clamp((y - storyTop) / storyTravel) * count;
  const step = Math.min(count - 1, Math.floor(along));
  const within = along - step;
  const end = storyTop + storyTravel;
  if (y > end) {
    const out = span(y, end, end + vh * 0.8);
    return { ...holding(mixPose(shot(count - 1, 1), GONE_UP(), smooth(out)), SHOTS[count - 1].form, stepWords[count - 1]), coins: 1 - span(out, 0, 0.45), screen: count - 1, on: out < 1 };
  }
  const moving = step === count - 1 ? 0 : smooth(span(within, STEP_HOLD, 1));
  const next = Math.min(step + 1, count - 1);
  const from = shot(step, clamp(within / STEP_HOLD));
  const to = shot(next, 0);
  // On its way across it pulls back a little and leans into the turn.
  const travel = Math.sin(moving * Math.PI);
  const pose = mixPose(from, to, moving);
  pose.h *= 1 - travel * 0.07;
  pose.rz += travel * 0.05 * Math.sign(to.x - from.x);
  return {
    ...pose,
    screen: step + moving,
    on: true,
    coins: 1,
    formA: SHOTS[step].form,
    formB: SHOTS[next].form,
    formT: moving,
    anchorA: from,
    anchorB: to,
    wordsA: stepWords[step],
    wordsB: stepWords[next],
  };
}

// ---- the clock in the corner --------------------------------------------------

const hudTime = $("hudTime");
let shownMinute = -1;

function updateClock(y) {
  const at = y + m.vh * 0.14; // so a section's hour shows when its heading comes up
  const t = m.times;
  let minutes = t[0].minutes;
  for (let i = 0; i < t.length - 1; i++) {
    if (at >= t[i].at) minutes = lerp(t[i].minutes, t[i + 1].minutes, span(at, t[i].at, t[i + 1].at));
  }
  if (at >= t.at(-1).at) minutes = t.at(-1).minutes;
  const whole = Math.round(minutes);
  if (whole === shownMinute) return;
  shownMinute = whole;
  const h = Math.floor(whole / 60) % 24;
  hudTime.textContent = `${String(h).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

// ---- cards that lean towards the pointer, through --px and --py ----------------

let pointer = null;
window.addEventListener("pointermove", (e) => {
  pointer = [(e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1];
}, { passive: true });

function updateLean() {
  if (!pointer) return;
  root.style.setProperty("--px", pointer[0].toFixed(3));
  root.style.setProperty("--py", pointer[1].toFixed(3));
  pointer = null;
}

// ---- running it -------------------------------------------------------------

let stage = null;
let lastStep = -1;
const heroCopy = $("heroCopy");
const city = document.querySelector(".intro-city");
const street = document.querySelector(".intro-street");
const cityGlow = document.querySelector(".intro-glow");
const shade = document.querySelector(".intro-shade");
const introFirst = document.querySelector(".intro-first");
const stageCanvas = $("stage");

function updateIntro(y) {
  const t = span(y, m.introTop, m.introTop + m.introTravel * 0.62);
  if (t < 1) {
    mask.hidden = false;
    drawMask(t);
  } else {
    mask.hidden = true;
  }
  city.style.transform = `scale(${lerp(1.22, 1, smooth(t)).toFixed(4)})`;
  cityGlow.style.opacity = (1 - smooth(span(t, 0.05, 0.5))).toFixed(3);
  // From the air down to the street, as the headline arrives.
  const landed = smooth(span(y, m.introTop + m.introTravel * 0.58, m.introTop + m.introTravel * 0.8));
  street.style.opacity = landed.toFixed(3);
  street.style.transform = `scale(${lerp(1.08, 1, landed).toFixed(4)})`;
  shade.style.opacity = smooth(span(t, 0.5, 1)).toFixed(3);
  introFirst.style.opacity = (1 - span(t, 0, 0.1)).toFixed(3);
  introFirst.style.visibility = t > 0.12 ? "hidden" : "visible";
  const copy = smooth(span(y, m.introTop + m.introTravel * 0.6, m.introTop + m.introTravel * 0.82));
  heroCopy.style.opacity = copy.toFixed(3);
  heroCopy.style.transform = `translateY(${((1 - copy) * 30).toFixed(1)}px)`;
  heroCopy.style.visibility = copy > 0 ? "visible" : "hidden";
}

const wordsRight = (i) => stepsList[i]?.dataset.side === "right";

function updateSteps(y) {
  const count = stepsList.length;
  const along = clamp((y - m.storyTop) / m.storyTravel) * count;
  const step = Math.min(count - 1, Math.floor(along));
  const within = along - step;
  stepsList.forEach((el, i) => {
    let o = 0;
    // Out before the phone sets off, and in once it has nearly arrived, so it never crosses words.
    if (i === step) o = i === count - 1 ? 1 : 1 - span(within, STEP_HOLD, STEP_HOLD + 0.08);
    else if (i === step + 1) o = span(within, STEP_HOLD + 0.2, 1);
    // The words go out the way they came, and the next ones come in from their own side of the view.
    const away = (1 - o) * (wordsRight(i) ? 1 : -1) * (i > step ? 1 : -0.6);
    el.style.opacity = o.toFixed(3);
    el.style.transform = `translate3d(${(away * 46).toFixed(1)}px, 0, 0)`;
    el.style.visibility = o > 0 ? "visible" : "hidden";
    // Each screen stands somewhere new, and the place dissolves as the screen changes. Each one is slowly pushed into,
    // and a place behind words on the right is seen mirrored, so its dark side is behind them.
    const place = i === step ? 1 : i === step + 1 ? smooth(span(within, STEP_HOLD, 1)) : 0;
    const plate = storyPlates[i];
    if (plate) {
      const zoom = 1.1 - 0.08 * clamp((along - i + 0.3) / 1.3);
      plate.style.opacity = place.toFixed(3);
      plate.style.zIndex = i === step + 1 ? 1 : 0;
      plate.style.transform = `scale(${(wordsRight(i) ? -zoom : zoom).toFixed(4)}, ${zoom.toFixed(4)})`;
    }
  });
  // The dark side of the view follows the words across.
  const shadeRight = lerp(wordsRight(step) ? 1 : 0, wordsRight(step + 1) ? 1 : 0, step === count - 1 ? 0 : smooth(span(within, STEP_HOLD, 1)));
  storyShadeRight.style.opacity = shadeRight.toFixed(3);
  storyShade.style.opacity = (1 - shadeRight).toFixed(3);
  if (step !== lastStep) {
    lastStep = step;
    dots.forEach((d, i) => d.classList.toggle("on", i === step));
  }
}

function updateParallax() {
  for (const el of parallax) {
    const r = el.getBoundingClientRect();
    if (r.bottom < -80 || r.top > m.vh + 80) continue;
    const shift = (r.top + r.height / 2 - m.vh / 2) * Number(el.dataset.parallax);
    el.style.transform = `translate3d(0, ${(-shift).toFixed(1)}px, 0)`;
  }
}

/** The film strip slides along as you pass it. */
function updateStrip(y) {
  const past = span(y, m.stripTop - m.vh, m.stripTop + m.vh * 0.5);
  const spare = Math.max(0, strip.scrollWidth - window.innerWidth + 40);
  strip.style.transform = `translate3d(${(-past * spare).toFixed(1)}px, 0, 0)`;
}

function frame(ms) {
  const y = window.scrollY;
  updateClock(y);
  if (!calm) {
    updateLean();
    updateIntro(y);
    updateParallax();
    updateStrip(y);
    if (root.classList.contains("has-stage")) {
      updateSteps(y);
      const pose = poseAt(y);
      stageCanvas.style.visibility = pose.on ? "visible" : "hidden";
      if (pose.on) stage.draw(pose, ms / 1000);
    }
  }
}

async function startStage() {
  try {
    const { Stage } = await import("./stage.js");
    stage = new Stage(stageCanvas, {
      screens: stepsList.map((el) => ({ name: el.dataset.screen, src: `assets/screens/${el.dataset.screen}.webp` })),
      coinFaces: ["dog", "whale", "flamingo", "cat", "gator", "coconut"].map((name) => `assets/coins/${name}.webp`),
      coinReverse: "assets/coins/palm.webp",
      photoFace: "assets/art/coin-photo.webp",
    });
    root.classList.add("has-stage");
    measure();
  } catch (e) {
    // No WebGL, or it failed: the page has still images of every screen instead.
    console.warn("No 3D phone on this device:", e.message);
    stageCanvas.hidden = true;
  }
}

async function startSmoothScroll() {
  await new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "vendor/lenis.min.js";
    s.onload = resolve;
    s.onerror = resolve;
    document.head.append(s);
  });
  if (!window.Lenis) return null;
  const lenis = new window.Lenis({ lerp: 0.11, wheelMultiplier: 0.9, smoothWheel: true });
  document.addEventListener("click", (e) => {
    const a = e.target.closest?.('a[href^="#"]');
    if (!a) return;
    const target = document.querySelector(a.getAttribute("href"));
    if (!target) return;
    e.preventDefault();
    lenis.scrollTo(target, { offset: 0, duration: 1.6 });
  });
  return lenis;
}

async function start() {
  if (calm) {
    root.classList.add("calm");
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", () => frame(0), { passive: true });
    frame(0);
    return;
  }
  root.classList.add("motion");
  measure();
  sizeMask();
  window.addEventListener("resize", () => {
    measure();
    sizeMask();
  });
  // Lazy images change the page's height as they arrive.
  window.addEventListener("load", measure);
  new ResizeObserver(measure).observe(document.body);

  const lenis = await startSmoothScroll();
  const tick = (ms) => {
    lenis?.raf(ms);
    frame(ms);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // After the first paint, so the opening shows at once.
  (window.requestIdleCallback ?? ((fn) => setTimeout(fn, 200)))(startStage);
}

start();
