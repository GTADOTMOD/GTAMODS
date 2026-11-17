/*
 * The phone version's moving parts. There's no 3D and nothing hijacks the scroll: the page scrolls natively, the
 * swipes are the browser's own, and whatever moves is a transform or an opacity the graphics chip can run by itself.
 * Most of this only works out how far along a swipe is, and leaves how that looks to mobile.css.
 */
const root = document.documentElement;
const $ = (id) => document.getElementById(id);
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
const span = (v, a, b) => clamp((v - a) / (b - a));
const inView = (el, run, options) => {
  const watch = new IntersectionObserver((entries) => entries.forEach((e) => run(e, watch)), options);
  watch.observe(el);
  return watch;
};

const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
// Slow phones and data-saver get everything except the coins' endless float.
const lite = calm || navigator.connection?.saveData || navigator.deviceMemory <= 2;
root.classList.add("mob");
if (lite) root.classList.add("lite");

// ---- coins: flat pictures of the desktop's 3D coins, turned in CSS -------------

/**
 * look: how this coin differs from the others, so they sit like coins that landed and not like a chart. s, its size;
 * dy, up or down in coin widths; dx, how much further out; t and k, where it starts its float and how slowly;
 * lean and tip, how it's turned.
 */
function coin(token, side, row, arc = 0, loading = "eager", look = {}) {
  const el = document.createElement("div");
  el.className = "coin";
  const { s = 1, dy = 0, dx = 0, t = 0, k = 1, lean = 0, tip = 0 } = look;
  el.style.cssText = `--side:${side};--row:${row};--arc:${arc};--s:${s};--dy:${dy};--dx:${dx};--t:${t}s;--k:${k};--lean:${lean}deg;--tip:${tip}deg`;
  // The front comes last, so that it's the face showing in a browser that can't do the 3D.
  el.innerHTML =
    '<div class="coin-float"><div class="coin-spin"><div class="coin-body"><i class="coin-edge"></i>' +
    `<img class="coin-back" src="assets/mobile/coin-palm.webp" alt="" width="200" height="200" decoding="async" loading="${loading}">` +
    `<img class="coin-front" src="assets/mobile/coin-${token}.webp" alt="" width="200" height="200" decoding="async" loading="${loading}">` +
    '<i class="coin-glint"></i></div></div></div>';
  return el;
}

/** Stops a set of coins floating while they're off the screen, to save the battery. */
function restWhenAway(area, coins) {
  inView(area, (e) => coins.classList.toggle("idle", !e.isIntersecting), { rootMargin: "20% 0px" });
}

// ---- the opening: the name, with the city inside it, flown through in a second ---

function buildHeroRig() {
  const rig = document.createElement("div");
  rig.className = "m-rig";
  rig.setAttribute("aria-hidden", "true");
  rig.innerHTML = '<div class="m-phone"><img src="assets/mobile/phone-home.webp" alt="" width="640" height="1197" decoding="async"><i class="m-sheen"></i></div>';
  rig.append(
    coin("dog", 1, 0, 0, "eager", { s: 0.84, dy: -0.4, dx: 0.5, t: -1.3, k: 1.12, lean: 6, tip: 4 }),
    coin("whale", -1, 0, 0, "eager", { s: 1.06, dy: 0.25, t: -3.1, k: 0.92, lean: -4, tip: -3 }),
    coin("gator", 1, 1, 0, "eager", { s: 1.08, dy: 0.15, t: -0.4, k: 1.04, lean: -6, tip: -5 }),
    coin("coconut", -1, 1, 0, "eager", { s: 0.8, dy: 0.55, dx: 0.6, t: -2.2, k: 1.18, lean: 8, tip: 5 }),
  );
  $("heroCopy").after(rig);
  restWhenAway(document.querySelector(".intro"), rig);
}

function land(withCopy) {
  root.classList.remove("opening", "drawing");
  if (calm) return;
  root.classList.add("landing");
  if (withCopy) root.classList.add("landing-copy");
  window.setTimeout(() => root.classList.remove("landing", "landing-copy"), 2400);
}

async function opening() {
  if (!root.classList.contains("opening")) return land(false);
  try {
    window.sessionStorage.setItem("seen", "1");
  } catch {
    // Private windows can refuse this. It only means the opening plays again.
  }
  // It never makes anyone wait: if the city isn't here soon, the page just appears.
  const city = document.querySelector(".intro-city");
  const late = new Promise((resolve) => window.setTimeout(() => resolve("late"), 1300));
  const [{ WORDMARK }, ready] = await Promise.all([import("./wordmark.js"), Promise.race([city.decode().catch(() => "late"), late])]);
  if (ready === "late") return land(true);

  const mask = $("introMask");
  const g = mask.getContext("2d");
  const path = new Path2D(WORDMARK.d);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  mask.width = Math.round(w * dpr);
  mask.height = Math.round(h * dpr);
  const base = Math.min((w * 0.86) / WORDMARK.w, (h * 0.6) / WORDMARK.h);
  const most = (Math.max(w, h) / (WORDMARK.stem.width * base)) * 1.5;

  const draw = (t) => {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, w, h);
    g.fillStyle = "#07050a";
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = "destination-out";
    const zoom = Math.exp(t * t * Math.log(most));
    const toStem = smooth(span(t, 0.02, 0.5));
    g.translate(w / 2, h * 0.47);
    g.scale(base * zoom, base * zoom);
    g.translate(-lerp(WORDMARK.x + WORDMARK.w / 2, WORDMARK.stem.x, toStem), -lerp(WORDMARK.y + WORDMARK.h / 2, WORDMARK.stem.y, toStem));
    g.fill(path);
    const edge = 1 - span(t, 0, 0.18);
    if (edge > 0) {
      g.globalCompositeOperation = "source-over";
      g.strokeStyle = `rgba(255, 177, 90, ${(0.85 * edge).toFixed(3)})`;
      g.lineWidth = 1.4 / (base * zoom);
      g.stroke(path);
    }
  };

  draw(0);
  root.classList.add("drawing");
  const HOLD = 280;
  const FLY = 860;
  const start = performance.now();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    land(true);
  };
  // A touch skips it.
  window.addEventListener("touchstart", finish, { once: true, passive: true });
  const fly = (now) => {
    if (done) return;
    const t = (now - start - HOLD) / FLY;
    if (t >= 1) return finish();
    draw(clamp(t));
    requestAnimationFrame(fly);
  };
  requestAnimationFrame(fly);
}

// ---- the story: swipe through the app, and the coins follow your finger --------

function buildStory() {
  const scroller = $("steps");
  const steps = [...scroller.children];
  const plates = [...document.querySelectorAll(".story-plates img")];
  const dots = [...$("storyDots").children];

  scroller.tabIndex = 0;
  scroller.setAttribute("aria-label", "RUGR's screens. Swipe or use the arrow keys.");

  for (const step of steps) {
    const shot = step.querySelector("picture");
    const phone = document.createElement("div");
    phone.className = "m-phone";
    shot.replaceWith(phone);
    phone.append(shot);
    phone.insertAdjacentHTML("beforeend", '<i class="m-sheen"></i>');
  }

  const coins = document.createElement("div");
  coins.className = "m-coins";
  coins.setAttribute("aria-hidden", "true");
  [
    ["dog", 1, 0, 0, { s: 0.84, dy: -0.35, dx: 0.5, t: -1.1, k: 1.1, lean: 6, tip: 4 }],
    ["whale", -1, 0, 0, { s: 1.06, dy: 0.22, t: -2.9, k: 0.94, lean: -4, tip: -3 }],
    ["flamingo", 1, 1, 1, { s: 1.08, dy: 0.12, t: -0.6, k: 1.02, lean: -6, tip: -4 }],
    ["cat", -1, 1, 1, { s: 0.82, dy: -0.42, dx: 0.3, t: -3.7, k: 1.16, lean: 7, tip: 5 }],
    ["gator", 1, 2, 0, { s: 0.9, dy: 0.32, dx: 0.6, t: -2.2, k: 1.08, lean: 4, tip: -4 }],
    ["coconut", -1, 2, 0, { s: 1.08, dy: -0.1, t: -0.2, k: 0.96, lean: -5, tip: 3 }],
  ].forEach(([token, side, row, arc, look]) => coins.append(coin(token, side, row, arc, "lazy", look)));
  scroller.before(coins);
  restWhenAway($("story"), coins);

  let queued = 0;
  let shown = -1;
  const position = () => clamp(scroller.scrollLeft / Math.max(1, scroller.clientWidth), 0, steps.length - 1);

  const paint = () => {
    queued = 0;
    const pos = position();
    steps.forEach((step, i) => {
      const d = i - pos;
      if (Math.abs(d) > 1.6) return;
      step.style.setProperty("--d", d.toFixed(3));
      step.style.setProperty("--a", Math.min(1, Math.abs(d)).toFixed(3));
    });
    // Halfway between screens they're all back inside the phone, and they come out again as the next one lands.
    const nearest = Math.round(pos);
    coins.style.setProperty("--out", (1 - smooth(span(Math.abs(pos - nearest), 0.02, 0.3))).toFixed(3));
    // The place behind dissolves into the next one. Only the ones nearby are ever downloaded.
    const low = Math.floor(pos);
    plates.forEach((plate, i) => {
      plate.parentElement.classList.toggle("near", Math.abs(i - pos) < 1.6);
      plate.style.opacity = i === low ? 1 : i === low + 1 ? (pos - low).toFixed(3) : 0;
    });
    dots.forEach((dot, i) => dot.style.setProperty("--f", clamp(pos - i + 1).toFixed(3)));
    if (nearest !== shown) {
      shown = nearest;
      steps.forEach((step, i) => step.setAttribute("aria-current", i === nearest ? "true" : "false"));
    }
  };
  const queue = () => {
    queued ||= requestAnimationFrame(paint);
  };
  scroller.addEventListener("scroll", queue, { passive: true });
  window.addEventListener("resize", queue, { passive: true });
  paint();

  // Tapping the phone moves on, the way a story does.
  scroller.addEventListener("click", (e) => {
    if (!e.target.closest(".m-phone")) return;
    const next = (Math.round(position()) + 1) % steps.length;
    scroller.scrollTo({ left: next * scroller.clientWidth, behavior: calm ? "auto" : "smooth" });
  });

  // The first time it comes into view it leans towards the next screen and back, so it's plain that it swipes.
  let touched = false;
  scroller.addEventListener("touchstart", () => { touched = true; }, { passive: true, once: true });
  if (!calm) {
    inView(scroller, (e, watch) => {
      if (!e.isIntersecting) return;
      watch.disconnect();
      window.setTimeout(() => {
        if (touched) return;
        scroller.style.scrollSnapType = "none";
        const start = performance.now();
        const lean = (now) => {
          const t = (now - start) / 1300;
          if (touched || t >= 1) {
            if (!touched) scroller.scrollLeft = 0;
            scroller.style.scrollSnapType = "";
            return;
          }
          scroller.scrollLeft = Math.sin(t * Math.PI) ** 2 * scroller.clientWidth * 0.24;
          requestAnimationFrame(lean);
        };
        requestAnimationFrame(lean);
      }, 450);
    }, { threshold: 0.55 });
  }
}

// ---- the bottom bar: it arrives once the opening's own buttons have gone ---------

function buildDock() {
  const dock = $("dock");
  const links = [...dock.querySelectorAll("a")];
  inView(document.querySelector(".hero-copy .actions"), (e) => dock.classList.toggle("on", !e.isIntersecting));
  const tabs = [["#top, #company", 0], ["#rugr, #story, .world, .ingame, .photo", 1], ["#how", 2], ["#road, #faq", 3], ["#access, .foot", 4]];
  const select = (tab) => {
    dock.style.setProperty("--tab", tab);
    links.forEach((link, i) => (i === tab ? link.setAttribute("aria-current", "true") : link.removeAttribute("aria-current")));
  };
  for (const [selector, tab] of tabs) {
    for (const el of document.querySelectorAll(selector)) {
      inView(el, (e) => e.isIntersecting && select(tab), { rootMargin: "-50% 0px -50% 0px" });
    }
  }
}

// ---- smaller moments ---------------------------------------------------------

/** The in-game capture is too wide for a phone, so you look around it, and the camera shows you how once. */
function buildPan() {
  const pane = document.querySelector(".capture-pan");
  const spare = () => pane.scrollWidth - pane.clientWidth;
  let touched = false;
  let placed = false;
  pane.addEventListener("touchstart", () => { touched = true; }, { passive: true, once: true });
  inView(pane, (e, watch) => {
    if (!e.isIntersecting) return;
    // It comes into view on the player, or on the phone for anyone who'd rather nothing moved by itself.
    if (!placed) {
      placed = true;
      pane.scrollLeft = spare() * (calm ? 1 : 0.34);
    }
    if (calm) return watch.disconnect();
    if (e.intersectionRatio < 0.6) return;
    watch.disconnect();
    if (touched) return;
    const from = pane.scrollLeft;
    const began = performance.now();
    const move = (now) => {
      const t = clamp((now - began) / 2400);
      if (touched) return;
      pane.scrollLeft = lerp(from, spare(), smooth(t));
      if (t < 1) requestAnimationFrame(move);
    };
    requestAnimationFrame(move);
  }, { threshold: [0, 0.6] });
}

function buildReveals() {
  const items = document.querySelectorAll(".reveal");
  if (calm) return items.forEach((el) => el.classList.add("in"));
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      seen.unobserve(e.target);
    }
  }, { rootMargin: "0px 0px -6% 0px" });
  items.forEach((el) => seen.observe(el));
}

/** A phone can pass the page on from where it is. */
function buildShare() {
  if (!navigator.share && !navigator.clipboard) return;
  const share = document.createElement("button");
  share.type = "button";
  share.className = "btn btn-ghost";
  share.textContent = "Share GTAMOD";
  const url = window.location.origin + window.location.pathname;
  share.addEventListener("click", async () => {
    try {
      if (navigator.share) return await navigator.share({ title: "GTAMOD", text: "A launchpad and wallet on your in-game phone.", url });
      await navigator.clipboard.writeText(url);
      share.textContent = "Link copied";
    } catch {
      // Closing the share sheet counts as an error, and there's nothing to do about it.
    }
  });
  $("accessLinks").append(share);
}

// One answer open at a time, so the list doesn't grow past the thumb.
document.querySelectorAll(".faq details").forEach((details) => { details.name = "faq"; });

// Far-off sections only have an estimated height until they're laid out, so a jump lays out the whole page first and lands exactly.
document.addEventListener("click", (e) => {
  if (e.target.closest?.('a[href^="#"]')) root.classList.add("laid-out");
}, { capture: true });

// A link from elsewhere to a section: the browser heads there while the page is still settling, and Safari doesn't correct for what
// grows above it afterwards. So land again once it has settled, unless they've started moving. Reloading or coming back restores their place.
function arrive() {
  const spot = location.hash && $(location.hash.slice(1));
  if (!spot || performance.getEntriesByType("navigation")[0]?.type !== "navigate") return root.classList.remove("arriving");
  let moved = false;
  for (const kind of ["touchstart", "wheel", "keydown"]) addEventListener(kind, () => { moved = true; }, { once: true, passive: true });
  // Far from the section means they scrolled away before this script arrived.
  const settle = () => { if (!moved && Math.abs(spot.getBoundingClientRect().top) < 300) spot.scrollIntoView({ behavior: "instant" }); };
  const loaded = new Promise((done) => { if (document.readyState === "complete") done(); else addEventListener("load", done, { once: true }); });
  settle();
  loaded.then(() => document.fonts.ready).then(() => {
    settle();
    root.classList.remove("arriving");
  });
}

buildHeroRig();
buildStory();
buildDock();
buildPan();
buildReveals();
buildShare();
arrive();
opening();
