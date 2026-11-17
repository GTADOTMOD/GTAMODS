// Turns the raw art and in-game captures into what the site serves: sized WebP images, GTAMOD's logo at the
// sizes the page uses, the favicon, the social preview image, and the opening's wordmark as vector paths.
//   node build-assets.cjs [--shots folder with in-game screenshots] [--photo the coin photo]
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(__dirname, "art-source");
const ART = path.join(ROOT, "assets", "art");
const BRAND = path.join(ROOT, "assets", "brand");
const SCREENS = path.join(ROOT, "assets", "screens");

const option = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};

async function webp(file, out, width, quality = 80) {
  await sharp(path.join(SRC, file)).resize({ width, withoutEnlargement: true }).webp({ quality }).toFile(path.join(ART, out));
}

async function art() {
  const plates = ["plate-hero", "plate-company", "plate-dash", "plate-sidewalk", "plate-asphalt", "plate-forecourt", "plate-room", "plate-corner", "plate-alley", "plate-wall", "plate-garage", "plate-windshield", "plate-blinds", "plate-den", "dusk-blvd", "night-skyline"];
  for (const [name, width] of [["hero-city", 2560], ...plates.map((p) => [p, 2200])]) {
    await webp(`${name}.png`, `${name}.webp`, width, 82);
    await webp(`${name}.png`, `${name}-900.webp`, 900, 76);
  }
  for (const name of ["panel-car", "panel-phone", "panel-alley", "panel-motel", "panel-marsh"]) {
    await webp(`${name}.png`, `${name}.webp`, 1200, 80);
  }
  await sharp(path.join(ROOT, "..", "brand", "rugr-logo.png")).resize({ width: 640 }).webp({ quality: 86, alphaQuality: 90 }).toFile(path.join(BRAND, "rugr.webp"));
}

/** The faces of the 3D coins: the sample tokens from the phone, and the gold palm on the other side of each. */
async function coins() {
  const out = path.join(ROOT, "assets", "coins");
  fs.mkdirSync(out, { recursive: true });
  for (const name of ["dog", "whale", "flamingo", "cat", "gator", "coconut"]) {
    await sharp(path.join(SRC, `coin-${name}.png`)).resize(512, 512).webp({ quality: 86 }).toFile(path.join(out, `${name}.webp`));
  }
  // The photo's own rim is cut away, because the 3D coin has a real one.
  const source = sharp(path.join(SRC, "coin-face.png"));
  const { width, height } = await source.metadata();
  const side = Math.round(Math.min(width, height) * 0.88);
  await source.extract({ left: Math.round((width - side) / 2), top: Math.round((height - side) / 2), width: side, height: side })
    .resize(512, 512).webp({ quality: 86 }).toFile(path.join(out, "palm.webp"));
}

/** The icons, trimmed to the object and sized for the page, see-through around it. */
async function icons() {
  const out = path.join(ROOT, "assets", "icons");
  fs.mkdirSync(out, { recursive: true });
  for (const file of fs.readdirSync(path.join(SRC, "icons")).filter((f) => f.endsWith(".png"))) {
    const object = await sharp(path.join(SRC, "icons", file)).trim({ threshold: 10 }).toBuffer();
    await sharp(object).resize(192, 192, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 84, alphaQuality: 90 }).toFile(path.join(out, file.replace(".png", ".webp")));
  }
}

/**
 * What a phone gets instead of the desktop's files: art composed or cropped for a tall screen, at a phone's
 * size. The number beside each plate is where across it the crop sits, from 0 at the left to 1 at the right.
 */
async function mobile() {
  const out = path.join(ROOT, "assets", "mobile");
  fs.mkdirSync(out, { recursive: true });
  const crop = async (name, width, height, focus, quality, saved = name) => {
    const source = sharp(path.join(SRC, `${name}.png`));
    const meta = await source.metadata();
    const side = Math.min(meta.width, Math.round((meta.height * width) / height));
    const tall = Math.min(meta.height, Math.round((side * height) / width));
    await source
      .extract({ left: Math.round((meta.width - side) * focus), top: Math.round((meta.height - tall) / 2), width: side, height: tall })
      .resize(width, height).webp({ quality }).toFile(path.join(out, `${saved}.webp`));
  };
  // Made for this shape, so they're only sized.
  await crop("m-hero-city", 720, 1280, 0.5, 58, "hero-city");
  await crop("m-hero-street", 780, 1387, 0.5, 66, "hero-street");
  await crop("m-access", 720, 1280, 0.5, 62, "access");
  const plates = {
    "plate-company": 0.86, "plate-dash": 0.92, "plate-asphalt": 0.72, "plate-sidewalk": 0.92, "dusk-blvd": 0.76, "plate-forecourt": 0.92, "plate-room": 0.92,
    "plate-corner": 0.86, "plate-wall": 0.96, "plate-den": 0.7, "plate-alley": 0.6, "plate-garage": 0.96, "plate-windshield": 0.55, "plate-blinds": 0.6,
  };
  for (const [name, focus] of Object.entries(plates)) await crop(name, 640, 1138, focus, 58);
  // The film strip, all one shape, so it swipes evenly.
  for (const [name, focus] of Object.entries({ "panel-car": 0.5, "panel-alley": 0.5, "panel-phone": 0.6, "panel-motel": 0.5, "panel-marsh": 0.5 })) await crop(name, 800, 1000, focus, 66);
  for (const name of ["home", "trending", "coin", "swap", "wallet", "create"]) {
    await sharp(path.join(SCREENS, `${name}-framed.webp`)).webp({ quality: 74, alphaQuality: 80 }).toFile(path.join(out, `phone-${name}.webp`));
  }
  // Official game logos are optional and not in the repository: smaller copies are made only for the ones present.
  for (const [file, width] of [["gta-v.png", 340], ["gta-v-line.png", 340], ["gta-vi.png", 340], ["rockstar.png", 96]]) {
    if (!fs.existsSync(path.join(BRAND, file))) continue;
    await sharp(path.join(BRAND, file)).resize({ width }).webp({ quality: 86, alphaQuality: 90 }).toFile(path.join(out, `brand-${file.replace(".png", ".webp")}`));
  }
  await sharp(path.join(BRAND, "rugr.webp")).resize({ width: 280 }).webp({ quality: 80, alphaQuality: 88 }).toFile(path.join(out, "brand-rugr.webp"));
  await sharp(path.join(ART, "coin-photo.webp")).resize({ width: 400 }).webp({ quality: 72 }).toFile(path.join(out, "coin-photo.webp"));
  await sharp(path.join(ART, "ingame-golden.webp")).resize({ height: 880 }).webp({ quality: 72 }).toFile(path.join(out, "ingame.webp"));
}

/** GTAMOD's logo, the company's own PNG in the repo's root, trimmed to the badge. */
const logoBadge = () => sharp(path.join(ROOT, "..", "brand", "gtamod-logo.png")).trim({ threshold: 10 }).toBuffer();

/** The logo at the sizes the page uses (the footer, the nav), and as the favicon and an iPhone home-screen icon on the site's ink. */
async function logo() {
  const badge = await logoBadge();
  for (const [name, width, quality] of [["gtamod-logo-600.webp", 600, 86], ["gtamod-logo-160.webp", 160, 90]]) {
    await sharp(badge).resize({ width, withoutEnlargement: true }).webp({ quality, alphaQuality: 100 }).toFile(path.join(BRAND, name));
  }
  const { width, height } = await sharp(badge).metadata();
  const side = Math.max(width, height);
  const square = await sharp(badge).resize(side, side, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  await sharp(square).resize(64, 64).png().toFile(path.join(BRAND, "favicon.png"));
  const icon = await sharp(square).resize(156, 156).png().toBuffer();
  await sharp({ create: { width: 180, height: 180, channels: 4, background: "#07050a" } })
    .composite([{ input: icon, left: 12, top: 12 }])
    .png()
    .toFile(path.join(ROOT, "assets", "mobile", "touch-icon.png")); // iPhones put a black square behind a see-through icon
}

/** The preview shown when the site is shared: the city at night, darker at the edges, with the logo over it. */
async function socialImage() {
  const W = 1200;
  const H = 630;
  const shade = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><radialGradient id="v" cx=".5" cy=".5" r=".75">` +
    `<stop offset="0" stop-color="#0b0512" stop-opacity=".35"/><stop offset="1" stop-color="#0b0512" stop-opacity=".88"/></radialGradient></defs>` +
    `<rect width="${W}" height="${H}" fill="url(#v)"/></svg>`);
  const mark = await sharp(await logoBadge()).resize({ height: 520 }).png().toBuffer({ resolveWithObject: true });
  await sharp(path.join(SRC, "hero-city.png")).resize(W, H, { fit: "cover" })
    .composite([{ input: shade }, { input: mark.data, left: Math.round((W - mark.info.width) / 2), top: Math.round((H - mark.info.height) / 2) }])
    .png({ palette: true, quality: 82 })
    .toFile(path.join(ROOT, "assets", "og.png"));
}

/**
 * The opening's wordmark: GTAMOD in Barlow Condensed 900 as one vector path, and the stem of its T that the opening
 * zooms through, written to js/wordmark.js. Needs WORDMARK_FONT pointing at the font's .woff file.
 */
function wordmark() {
  const opentype = require("opentype.js");
  const font = opentype.loadSync(process.env.WORDMARK_FONT);
  const size = 1000;
  const all = font.getPath("GTAMOD", 0, 0, size);
  const box = all.getBoundingBox();
  const w = box.x2 - box.x1;
  const h = box.y2 - box.y1;
  const gWidth = font.getAdvanceWidth("G", size);
  const tWidth = font.getAdvanceWidth("T", size);
  const stem = { x: gWidth + tWidth / 2, y: box.y1 + h * 0.62, width: tWidth * 0.24 };
  fs.writeFileSync(path.join(ROOT, "js", "wordmark.js"),
    "// Generated by tools/build-assets.cjs: the GTAMOD wordmark, and the stem of its T that the opening zooms through.\n" +
    `export const WORDMARK = ${JSON.stringify({ d: all.toPathData(1), x: box.x1, y: box.y1, w, h, stem })};\n`);
}

/** Puts the current phone on a real in-game frame, over the older phone, and tidies the Windows notice. */
async function inGameFrame(source, out) {
  const left = 1967;
  const top = 119;
  const width = 484;
  const height = 907;
  const phone = await sharp(path.join(SCREENS, "home-framed.png")).resize(width, height, { fit: "fill" }).png().toBuffer();
  const meta = await sharp(source).metadata();
  // The notice runs a little past the phone's right edge; cover that bit with the wall just above it.
  const patch = await sharp(source).extract({ left: left + width - 2, top: 918, width: 26, height: 30 }).png().toBuffer();
  const framed = await sharp(source)
    .composite([{ input: patch, left: left + width - 2, top: 958 }, { input: phone, left, top }])
    .png()
    .toBuffer();
  await sharp(framed).resize({ width: Math.min(2400, meta.width) }).webp({ quality: 84 }).toFile(path.join(ART, out));
  await sharp(framed).extract({ left: 1040, top: 0, width: 1540, height: 1080 }).resize({ width: 1000 }).webp({ quality: 80 }).toFile(path.join(ART, out.replace(".webp", "-900.webp")));
}

async function main() {
  fs.mkdirSync(ART, { recursive: true });
  fs.mkdirSync(BRAND, { recursive: true });
  const only = option("--only");
  if (!only || only === "art") await art();
  if (!only || only === "coins") await coins();
  if (only === "coins") return;
  if (!only || only === "icons") await icons();
  if (only === "icons") return;
  if (!only || only === "logo") await logo();
  if (only === "logo") return;
  if (only === "wordmark") return wordmark();
  if (!only || only === "mobile") await mobile();
  if (only === "mobile") return;
  if (!only || only === "art" || only === "social") await socialImage();
  const shots = option("--shots");
  if (shots && (!only || only === "ingame")) {
    await inGameFrame(path.join(shots, "pump-20261104-193837.png"), "ingame-golden.webp");
    const photo = option("--photo");
    if (photo) await sharp(photo).resize({ width: 512 }).webp({ quality: 88 }).toFile(path.join(ART, "coin-photo.webp"));
  }
  console.log("assets built");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
