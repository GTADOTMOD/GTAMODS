// Draws RUGR's real phone page with sample data, at three times the size, for the site's 3D phone
// and its still images. Uses the same page the game shows, so the screens stay true to the app.
//   node capture-screens.cjs <folder with the companion's fixtures>
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const sharp = require("sharp");

const REPO = path.join(__dirname, "..", "..");
const PAGE_DIR = path.join(REPO, "companion", "tools");
const ART = path.join(__dirname, "art-source");
const OUT = path.join(__dirname, "..", "assets", "screens");
const FX = process.argv[2];
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PHOTO = process.env.COIN_PHOTO;

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FX, `${name}.json`), "utf8")).screen;
const open = { kind: "open" };

const coinRow = (mint, name, symbol, marketCap, detail, change, up, image, progressPct, graduated = false) => ({
  text: `${symbol} ${marketCap}`,
  icon: 13,
  enabled: true,
  action: open,
  style: { kind: "coin", mint, name, symbol, marketCap, detail, change, up, image, progressPct, graduated },
});

function trending() {
  return {
    header: "Trending",
    path: "/ui/list?kind=trending",
    rows: [
      coinRow("sample1", "Sunset Dog", "$SDOG", "$48.2K", "Vol $12.4K · 214 traders", "+38.12%", true, "coin-dog.png", 62),
      coinRow("sample2", "Palm Whale", "$PWHL", "$1.24M", "Vol $31.7K · 180 traders", "+6.40%", true, "coin-whale.png", undefined, true),
      coinRow("sample3", "Captain Cat", "$CAPT", "$17.9K", "Vol $4.1K · 96 traders", "-4.75%", false, "coin-cat.png", 34),
      coinRow("sample4", "Flamingo Shirt", "$FLMG", "$356K", "Vol $18.2K · 88 traders", "+12.03%", true, "coin-flamingo.png", undefined, true),
      coinRow("sample5", "Toothpick Gator", "$GATR", "$9.6K", "Vol $2.2K · 51 traders", "+21.88%", true, "coin-gator.png", 18),
      coinRow("sample6", "Coco Loco", "$COCO", "$26.3K", "Vol $3.9K · 40 traders", "-1.31%", false, "coin-coconut.png", 47),
    ],
    selected: 0,
  };
}

function coinPage() {
  const s = fixture("token");
  const hero = s.rows[0].style;
  Object.assign(hero, { mint: "sample1", name: "Sunset Dog", symbol: "$SDOG", marketCap: "$48.2K", address: "9sD0..sDog", image: "coin-dog.png" });
  s.header = "$SDOG";
  s.rows[1].style.pct = 62;
  s.rows[2].style.value = "$0.0000482";
  s.rows[3].style.value = "25M = $1.2K";
  return s;
}

function wallet() {
  const s = fixture("wallet");
  const balance = s.rows[0].style;
  Object.assign(balance, { value: "$1,407.62", address: "9sD0..w4Lt", change: "+$40.89", detail: "+2.99%", up: true });
  const coin = s.rows[7];
  coin.action = open;
  Object.assign(coin.style, { mint: "sample1", name: "Sunset Dog", symbol: "$SDOG", detail: "25M $SDOG", value: "$1,201.78", change: "+$32.49", up: true, image: "coin-dog.png" });
  const another = JSON.parse(JSON.stringify(coin));
  Object.assign(another.style, { mint: "sample2", name: "Palm Whale", symbol: "$PWHL", detail: "1.1K $PWHL", value: "$0.00", change: undefined, image: "coin-whale.png" });
  another.style.value = "$14.20";
  another.style.change = "-$0.31";
  another.style.up = false;
  s.rows.splice(6, 2, coin, s.rows[6], another);
  return s;
}

function createCoin() {
  const s = fixture("launchReady");
  Object.assign(s.rows[0].style, { name: "Corner Boys", symbol: "$CRNR", detail: "Two guys, one corner. Shot on the phone's camera.", image: "coin-photo.png" });
  s.rows[2].style.value = "Corner Boys";
  s.rows[3].style.value = "CRNR";
  s.rows[4].style.value = "Two guys, one co..";
  s.rows = s.rows.filter((r) => !/newest image/.test(r.text));
  return s;
}

const SCREENS = {
  home: { screen: () => fixture("home"), clock: "18:42" },
  trending: { screen: trending, clock: "18:44", back: "Back" },
  coin: { screen: coinPage, clock: "18:45", back: "Back" },
  swap: { screen: () => fixture("swapQuoted"), clock: "18:51" },
  wallet: { screen: wallet, clock: "19:02" },
  create: { screen: createCoin, clock: "19:10", back: "Back" },
};

const TYPES = { ".html": "text/html", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };

function serve() {
  const server = http.createServer((req, res) => {
    const file = path.join(PAGE_DIR, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!file.startsWith(PAGE_DIR) || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function main() {
  if (!FX) throw new Error("Give the folder with the companion's fixtures.");
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve();
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--hide-scrollbars"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 372, height: 696, deviceScaleFactor: 3 });
  await page.evaluateOnNewDocument(() => {
    window.chrome = window.chrome || {};
    window.chrome.webview = { addEventListener: (_type, fn) => { window.__message = fn; } };
  });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    if (!url.startsWith("https://pump.images/")) return req.continue();
    const name = decodeURIComponent(url.slice("https://pump.images/".length));
    const file = name === "coin-photo.png" ? PHOTO : path.join(ART, name);
    return req.respond({ status: 200, contentType: "image/png", body: fs.readFileSync(file) });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/phone-sim.html`, { waitUntil: "networkidle2" });
  // For marketing shots: the screens as a player looks at them, with no key hints and no status banner.
  await page.addStyleTag({ content: "#splash,.softkeys,.tabbar kbd{display:none!important} html,body{background:transparent!important} .tabbar{grid-template-columns:repeat(4,1fr)!important;padding-bottom:14px!important}" });

  for (const [name, { screen, clock, back }] of Object.entries(SCREENS)) {
    const s = screen();
    s.rows = s.rows.filter((r) => !/^PRACTICE/.test(r.text)); // real-money mode shows no banner
    await page.evaluate((m) => {
      window.__message({ data: { type: "clock", time: m.clock } });
      window.__message({ data: { type: "view", screen: m.screen, selected: m.selected, back: m.back, depth: 1 } });
    }, { screen: s, selected: s.selected, clock, back: back ?? (s.tab && s.path !== "/ui/home" ? "Home" : "Close") });
    await page.waitForNetworkIdle({ idleTime: 400, timeout: 15_000 }).catch(() => undefined);
    await page.evaluate(() => document.fonts.ready);
    await new Promise((r) => setTimeout(r, 500));

    const framed = await page.$(".phone");
    // The in-game picture keeps the app's own frame. The page's stills share the 3D phone's dark body.
    fs.writeFileSync(path.join(OUT, `${name}-framed.png`), await framed.screenshot({ omitBackground: true }));
    await page.addStyleTag({ content: ".phone{background:linear-gradient(160deg,#3a363c,#17151a 40%,#2b282e)!important;box-shadow:inset 0 0 0 1px rgb(160 138 124 / 62%)!important}" });
    const framedShot = await framed.screenshot({ omitBackground: true });
    await page.evaluate(() => [...document.querySelectorAll("style")].at(-1).remove());

    await page.addStyleTag({ content: ".screen{border-radius:0!important}" });
    const inner = await page.$(".screen");
    const shot = await inner.screenshot();
    await sharp(shot).webp({ quality: 88 }).toFile(path.join(OUT, `${name}.webp`));
    await page.evaluate(() => [...document.querySelectorAll("style")].at(-1).remove());
    await sharp(framedShot).resize({ width: 640 }).webp({ quality: 88 }).toFile(path.join(OUT, `${name}-framed.webp`));
    console.log(`${name}: done`);
  }
  await browser.close();
  server.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
