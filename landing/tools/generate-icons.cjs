// Makes the site's icons with OpenAI's image models, using OPENAI_API_KEY from the environment: small 3D objects in
// the coins' gold and the phone's titanium, on a see-through background. Finished icons are kept, so a failed run only
// retries what's missing; delete one to make it again. build-assets.cjs --only icons sizes them for the page.
//   node generate-icons.cjs              everything missing
//   node generate-icons.cjs lock key     only these
const fs = require("node:fs");
const path = require("node:path");

const MODEL = process.env.ART_MODEL || "gpt-image-2.6-sunburst";
const ENDPOINT = "https://api.openai.com/v1/images/generations";
const OUT = path.join(__dirname, "art-source", "icons");
const AT_ONCE = 4;

const LOOK =
  "One icon for a premium crime-game phone app, made as a small photoreal 3D object: dark brushed titanium and polished warm gold " +
  "(#ffc964), lit by a soft warm key light from the upper left, with a thin magenta neon rim light on its right edge and a faint amber one " +
  "below. Seen at a slight three-quarter angle, centred, filling about two thirds of the square, with a crisp silhouette that still reads " +
  "at 48 pixels. Isolated on a fully transparent background: no backdrop, no floor, no cast shadow, no glow filling the background. " +
  "No text, letters, numbers, logos or brand marks anywhere. The object: ";

const ICONS = {
  // RUGR, in three facts
  "live": "three stacked gold coins with a glowing magenta line chart rising steeply behind them, ending in an arrow pointing up and to the right.",
  "swap": "two gold coins standing on edge side by side, with two curved titanium arrows circling between them, one each way.",
  "key": "an ornate gold key lying across the front of a small dark titanium computer monitor whose screen glows faintly magenta.",
  // how it fits together
  "mod": "a modern smartphone standing upright, dark titanium with a thin gold edge, its screen glowing magenta and amber with abstract rounded app tiles.",
  "companion": "a compact dark titanium desktop PC tower seen from the front corner, with a glowing gold shield shape on its side panel.",
  "market": "four floating candlestick chart bars of different heights, two gold and two magenta, above a thin titanium disc.",
  // safety
  "lock": "a heavy padlock with a dark titanium body and a polished gold shackle, closed.",
  "practice": "a round archery target in titanium rings with a gold centre, and one gold dart stuck in the bullseye.",
  "cancel": "a round dark arcade push button with a glowing magenta X on its top, inside a thin gold ring like a countdown timer.",
  "limit": "a round gold speedometer gauge with a titanium needle held back below a short glowing magenta band near the top of the dial.",
  "exit": "a gold key flying out of a dark titanium open doorway, with a curved arrow trailing behind it.",
  "story": "a dark titanium game controller with gold buttons, next to a small gold globe crossed by one diagonal magenta bar.",
  // the road
  "testing": "a gold wrench crossed over a dark titanium smartphone, both floating at an angle.",
  "installer": "an open dark titanium box with a glowing gold arrow rising straight up out of it.",
  // the download page: what RUGR needs
  "download": "a shallow dark titanium tray with a thick glowing gold arrow pointing straight down into it.",
  "hook": "a polished gold crane hook hanging from two short dark titanium chain links, with a thin magenta neon ring around the hook's eye.",
  "gears": "a large dark titanium cog with gold-edged teeth meshed with a smaller polished gold cog, both floating at a slight angle.",
  "unlock": "a dark titanium smartphone standing upright, with a gold padlock floating in front of it whose shackle has swung open.",
};

async function makeIcon(key, name, prompt) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt: LOOK + prompt, size: "1024x1024", quality: "high", background: "transparent", output_format: "png", n: 1 }),
    signal: AbortSignal.timeout(600_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message ?? `OpenAI answered ${res.status}`);
  const data = body.data?.[0]?.b64_json;
  if (!data) throw new Error("OpenAI sent back no image");
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, "base64"));
}

async function main() {
  const key = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!key) throw new Error("OPENAI_API_KEY isn't set.");
  fs.mkdirSync(OUT, { recursive: true });
  const asked = process.argv.slice(2);
  const queue = Object.entries(ICONS)
    .filter(([name]) => (asked.length ? asked.includes(name) : true))
    .filter(([name]) => !fs.existsSync(path.join(OUT, `${name}.png`)));
  console.log(`${MODEL}: ${queue.length} to make`);
  let failed = 0;
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [name, prompt] = next;
      const started = Date.now();
      try {
        await makeIcon(key, name, prompt);
        console.log(`${name}: done in ${Math.round((Date.now() - started) / 1000)}s`);
      } catch (e) {
        failed++;
        console.log(`${name}: FAILED: ${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: AT_ONCE }, worker));
  console.log(failed ? `${failed} failed.` : "ALL DONE");
}

main().catch((e) => {
  console.log(`FAILED: ${e.message}`);
  process.exit(1);
});
