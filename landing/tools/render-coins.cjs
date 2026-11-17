// Draws each 3D coin once, with the desktop's own metal and lights, and saves it as a flat picture for
// the phone version, which turns those pictures in CSS and never loads the 3D.
// Needs the site served locally.
//   node render-coins.cjs [address of the local site]
const fs = require("node:fs");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const sharp = require("sharp");

const SITE = process.argv[2] || "http://127.0.0.1:47700/";
const OUT = path.join(__dirname, "..", "assets", "mobile");
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const FACES = ["dog", "whale", "flamingo", "cat", "gator", "coconut"];
const SIZE = 200;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage();
  // Wide enough to count as a desktop, so the site doesn't start its phone version around this.
  await page.setViewport({ width: 960, height: 960 });
  await page.goto(SITE, { waitUntil: "load" });
  const pictures = await page.evaluate(async (faces) => {
    const { Stage } = await import("/js/stage.js");
    const canvas = document.createElement("canvas");
    const stage = new Stage(canvas, {
      screens: [],
      coinFaces: faces.map((name) => `assets/coins/${name}.webp`),
      coinReverse: "assets/coins/palm.webp",
    });
    await new Promise((resolve) => setTimeout(resolve, 2500)); // the textures
    stage.screenLight.intensity = 0;
    // Square on, a mirror-bright rim reflects only the dark behind the camera, so it's made duller and catches more.
    const gold = stage.floating[0].coin.children[0].material;
    gold.color.set("#ffd27a");
    gold.roughness = 0.42;
    gold.envMapIntensity = 3.4;
    const shoot = (d, turn) => {
      for (const other of stage.floating) other.coin.visible = other === d;
      d.coin.position.set(0, 0, 0);
      d.coin.scale.setScalar(7.2);
      d.coin.rotation.set(-0.05, turn, 0); // a little off square, so the rim catches the light
      stage.renderer.clear();
      stage.renderer.render(stage.coinScene, stage.camera);
      return canvas.toDataURL("image/png");
    };
    const out = {};
    faces.forEach((name, i) => { out[name] = shoot(stage.floating[i], 0.1); });
    out.palm = shoot(stage.floating[0], Math.PI + 0.1);
    return out;
  }, FACES);
  for (const [name, url] of Object.entries(pictures)) {
    const png = Buffer.from(url.split(",")[1], "base64");
    await sharp(await sharp(png).trim().toBuffer()).resize(SIZE, SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 78, alphaQuality: 90 }).toFile(path.join(OUT, `coin-${name}.webp`));
  }
  await browser.close();
  console.log("coins drawn");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
