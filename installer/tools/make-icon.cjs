// Makes assets/rugr.ico, the setup's icon, from RUGR's logo: one PNG per size, which Windows 10 and 11 read.
//   node tools/make-icon.cjs            (needs sharp: npm install sharp, or NODE_PATH pointing at a node_modules with it)
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const root = path.join(__dirname, "..");
const source = path.join(root, "..", "companion", "tools", "art", "logo.png");
const out = path.join(root, "assets", "rugr.ico");
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];

(async () => {
  const images = [];
  for (const size of sizes) {
    let img = sharp(source).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: "lanczos3" });
    if (size <= 48) img = img.sharpen({ sigma: 0.6 });
    images.push(await img.png({ compressionLevel: 9 }).toBuffer());
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const entries = sizes.map((size, i) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(images[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += images[i].length;
    return e;
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.concat([header, ...entries, ...images]));
  console.log(`${out}: ${sizes.join(", ")} px, ${fs.statSync(out).size} bytes`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
