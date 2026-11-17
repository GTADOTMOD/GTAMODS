// Makes the site's images with OpenAI's image models, using OPENAI_API_KEY from the environment.
// Finished images are kept, so a failed run only retries what's missing; delete an image to make
// it again. Everything here is original: invented people and an invented city, in no game.
//   node generate-art.cjs                  everything missing
//   node generate-art.cjs hero-city plate-hero  only these
const fs = require("node:fs");
const path = require("node:path");

const MODEL = process.env.ART_MODEL || "gpt-image-2.6-sunburst";
const ENDPOINT = "https://api.openai.com/v1/images/generations";
const OUT = process.env.ART_OUT || path.join(__dirname, "art-source");
const AT_ONCE = 3;

const LOOK =
  "Photorealistic in-engine screenshot from a next-generation open-world game, framed like a still from a crime film. Path-traced " +
  "global illumination, physically accurate materials and true reflections. People have real skin with pores, sweat and stubble, and " +
  "worn, creased clothes. Close, low camera, often looking past something dark and out of focus in the foreground, with shallow depth " +
  "of field, soft bloom and highlights that blow out naturally in humid, hazy air. Low-key exposure with deep blacks and most of the " +
  "frame in shadow, lit only by real sources in the scene: sodium lamps, neon, headlights, phone screens, the last light of dusk. " +
  "Natural grade with inky shadows and warm amber, and small accents of magenta and teal. Set in an invented subtropical American " +
  "coastal city. Not a painting, not an illustration, no cel shading, no outlines, no oversaturation. ";
const CLEAN =
  " No text, letters, numbers, logos, readable signs, watermarks, borders or interface anywhere; any sign is an abstract glowing " +
  "shape. Any person is an original invented adult with natural skin texture, not a real person or an existing game character. No real brands.";
const NOBODY = " No people anywhere in the picture.";
const ONE = " Only this one person in the picture, and no other people.";

const photo = (file, size, prompt) => ({ file, size, quality: "high", prompt: LOOK + prompt + CLEAN });
const scene = (file, size, prompt) => photo(file, size, prompt + NOBODY);
const person = (file, size, prompt) => photo(file, size, prompt + ONE);

const IMAGES = [
  scene("hero-city.png", "2560x1440",
    "Aerial shot from a helicopter over an oceanfront boulevard in the last minutes of dusk: a deep ember-orange band of light on the " +
    "horizon under heavy dark storm clouds, a dark sea with a long bridge of headlights, art-deco hotels with their first lights on, rows " +
    "of black palm silhouettes, a glittering downtown in the haze. The sky fills the centre, calm and dark, so a product can sit over it."),
  scene("plate-den.png", "2400x1344",
    "A dark apartment at night seen from inside. A wide rain-streaked window fills the upper half of the frame, with out-of-focus amber and magenta " +
    "city lights and palm silhouettes beyond it. In the lower half a desk with the faint glow of a gaming PC, mostly in black shadow. The left third is much darker."),
  scene("dusk-blvd.png", "2400x1344",
    "A rain-soaked neon boulevard at night seen from a low angle: a closed diner, a motel and a pawn shop with abstract pink and teal " +
    "glowing shapes, long reflections on black wet asphalt, steam from a grate, palm silhouettes against a near-black sky. " +
    "The left half is much darker and calmer, so text can sit over it."),
  scene("night-skyline.png", "2400x1344",
    "Late night across black water towards a downtown skyline with scattered lit windows and faint magenta and teal rooftop lights, " +
    "their reflections long and broken on the water, a few dark yachts at anchor, a thin moon, and a very dark empty sky filling the top half."),
  scene("panel-car.png", "1536x1024",
    "A fictional low dark grey 1980s sports coupe with no badges, parked on a wet causeway at night with its headlights on, the beams " +
    "cutting through humid haze, rain beading on the bodywork, a dark sea and a far skyline behind it. Low three-quarter angle."),
  person("panel-phone.png", "1536x1024",
    "Over-the-shoulder close-up of an invented man sitting in a dark parked car at night, his tattooed hands holding a modern smartphone with " +
    "the screen facing away from us and lighting his fingers, rain on the windscreen breaking street lights into soft pink and amber bokeh."),
  // A plate behind every section. Each keeps its left side dark, for text.
  scene("plate-hero.png", "2560x1440",
    "A very low camera on a wet oceanfront boulevard at night. Black rain-soaked asphalt and puddles fill the bottom third with long amber and magenta " +
    "reflections. Tall palm silhouettes, amber street lamps and the tail lights of a far-off car recede down the middle, a hazy downtown of lit towers " +
    "beyond them, and on the far right the edge of an art-deco hotel with magenta neon. The left half is very dark and calm, so text can sit there. " +
    "Keep the right-centre open, since a product stands there on the wet ground."),
  scene("plate-company.png", "2400x1344",
    "A rainy roadside outside a low motel at night. The left half is almost black wet asphalt and darkness. The right half is rich: power lines, " +
    "palm silhouettes, a sodium streetlight in haze, the glowing edge of the motel, and the dark wet hood of a parked car close in the foreground."),
  scene("plate-dash.png", "2400x1344",
    "From the back seat of a parked car at night, looking out through a rain-streaked windshield. The dashboard is barely visible in the dark " +
    "foreground, and a blurred magenta hotel sign shape and street lights glow through the water on the glass. The left side is darkest."),
  scene("plate-sidewalk.png", "2400x1344",
    "A wet sidewalk outside a neon storefront at night, seen from low down, the shop blurred far out of focus with teal and magenta glow, " +
    "long reflections in the pavement and palm shadows. The left half falls away into darkness."),
  scene("plate-asphalt.png", "2400x1344",
    "A very low camera on black wet asphalt in an empty car park at night, puddles carrying neon reflections, the horizon low in the frame, " +
    "a distant blurred street with amber lamps in humid haze and a lot of dark sky. The left half is near black."),
  scene("plate-room.png", "2400x1344",
    "A dark motel room at night: a table with a laptop's cold glow, car keys and a wet jacket, city lights slicing through window blinds onto the " +
    "wall, dust in the air. The left half is near black."),
  scene("plate-alley.png", "2400x1344",
    "A dark alley corner at night after rain, a puddle catching a burst of white light like a camera flash, wet brick, a fire escape and a soft " +
    "red neon leak. The left half is near black."),
  scene("plate-wall.png", "2400x1344",
    "A dark stucco wall at night streaked with rain, with a red neon glow leaking in from the right edge and the shadow of a palm across it. " +
    "Mostly black and almost abstract, with fine surface texture."),
  scene("plate-windshield.png", "2400x1344",
    "From a driver's seat at night, heading down a long wet causeway, a blurred dark dashboard and steering wheel edge in the foreground, rain on the " +
    "windshield, street lamps receding to a distant lit skyline. The left half is much darker."),
  scene("plate-blinds.png", "2400x1344",
    "A very dark close-up of closed window blinds in a motel room at night, magenta and amber neon bleeding through the slats, dust hanging in the " +
    "light. Almost abstract, with most of it near black."),
  scene("plate-forecourt.png", "2400x1344",
    "An empty petrol station forecourt at night with no branding, seen from low down on wet concrete, a harsh white canopy light on the right pooling on the ground, " +
    "blank dark pumps, rain in the air and black palms beyond. The left half is near black."),
  scene("plate-corner.png", "2400x1344",
    "A street corner at night after rain, a wet crossing with blank painted stripes, a shuttered corner shop with an abstract amber and magenta glow on the right, " +
    "one streetlight in humid haze, seen from low down. The left half falls away into darkness."),
  scene("plate-garage.png", "2400x1344",
    "A dim private garage at night with the roller door half open onto rain, a dark 1980s car with no badges and its hood up on the right, a single caged work lamp lighting " +
    "the engine bay, tools on a bench, oil-stained wet concrete catching the light. The left half is near black."),
  scene("panel-motel.png", "1536x1024",
    "A roadside motel sign shape glowing magenta and amber at night, seen only as a long reflection in a rippling black puddle, with the real sign blurred above."),
  scene("panel-alley.png", "1024x1536",
    "A narrow rainy alley at night, one vending machine with a blank glowing front lighting the wet ground, a fire escape, steam and deep shadows."),
  scene("panel-marsh.png", "1536x1024",
    "A narrow road on a low bridge through marsh at night, reeds and still black water, one distant pair of tail lights and the faint glow of a far city on the horizon."),
  // Composed for a tall phone screen, not cropped to one.
  scene("m-hero-city.png", "1440x2560",
    "Aerial shot from a helicopter over an oceanfront boulevard in the last minutes of dusk, in a tall vertical frame: a deep ember-orange band of " +
    "light across the upper third under heavy dark storm clouds, a coastal road full of headlights running from the bottom of the frame up towards a " +
    "glittering hazy downtown, art-deco hotels with their first lights on along it, rows of black palm silhouettes and a dark sea on one side."),
  scene("m-hero-street.png", "1440x2560",
    "A very low camera on a wet oceanfront boulevard at night, in a tall vertical frame. The upper half is calm and very dark: a near-black sky with only " +
    "the faint silhouettes of tall palms and a little haze, so text can sit over it. The lower half is rich: black rain-soaked asphalt and puddles carrying " +
    "long amber and magenta reflections, amber street lamps receding into the distance, the tail lights of a far-off car, and on the far right the edge of " +
    "an art-deco hotel with magenta neon. Keep the bottom centre simple, since a product stands there on the wet ground."),
  scene("m-access.png", "1440x2560",
    "Late night across black water towards a downtown skyline, in a tall vertical frame. The upper two thirds are a near-black empty sky with faint " +
    "clouds and a thin moon. The skyline sits low in the frame, with scattered lit windows and faint magenta and teal rooftop lights, and below it " +
    "the black water carries their long broken reflections right down to the bottom edge, with one dark yacht at anchor."),
  { file: "coin-face.png", size: "1024x1024", quality: "high",
    prompt:
      "Macro studio photograph of one side of a heavy old gold coin, seen straight on and filling the whole square frame edge to edge, " +
      "with a raised milled rim. In its centre is a deep relief of a single palm tree in front of a low sun over waves. Worn, slightly " +
      "dirty real metal with soft specular highlights, shot on black. A perfect circle, centred." + CLEAN },
];

async function makeImage(key, image) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt: image.prompt, size: image.size, quality: image.quality, n: 1 }),
    signal: AbortSignal.timeout(600_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message ?? `OpenAI answered ${res.status}`);
  const data = body.data?.[0]?.b64_json;
  if (!data) throw new Error("OpenAI sent back no image");
  fs.writeFileSync(path.join(OUT, image.file), Buffer.from(data, "base64"));
}

async function main() {
  const key = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!key) throw new Error("OPENAI_API_KEY isn't set.");
  fs.mkdirSync(OUT, { recursive: true });
  const asked = process.argv.slice(2);
  const queue = IMAGES.filter((i) => (asked.length ? asked.includes(i.file.replace(".png", "")) : true))
    .filter((i) => !fs.existsSync(path.join(OUT, i.file)));
  console.log(`${MODEL}: ${queue.length} to make`);
  let failed = 0;
  const worker = async () => {
    for (let image = queue.shift(); image; image = queue.shift()) {
      const started = Date.now();
      try {
        await makeImage(key, image);
        console.log(`${image.file}: done in ${Math.round((Date.now() - started) / 1000)}s`);
      } catch (e) {
        failed++;
        console.log(`${image.file}: FAILED: ${e.message}`);
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
