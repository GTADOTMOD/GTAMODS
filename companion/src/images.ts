import fs from "node:fs";
import path from "node:path";
import { files } from "./paths.js";
import { UserError } from "./solana.js";

const ALLOWED = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * Launch images may only come from the companion's own images folder. The
 * phone sends a file name, never a path: otherwise anything that can talk to
 * the local API could have us upload an arbitrary file to IPFS.
 */
export function resolveImage(fileName: string, dir = files.imagesDir()): { path: string; mime: string; name: string } {
  if (typeof fileName !== "string" || fileName.length === 0 || fileName.length > 128) {
    throw new UserError("No image chosen.");
  }
  if (fileName !== path.basename(fileName) || fileName.startsWith(".")) {
    throw new UserError("Image must be a file name inside the RUGR images folder.");
  }
  const mime = ALLOWED.get(path.extname(fileName).toLowerCase());
  if (!mime) throw new UserError("Image must be .png, .jpg, .gif or .webp.");
  const full = path.join(dir, fileName);
  if (!fs.existsSync(full)) throw new UserError("Image not found in the RUGR images folder.");
  // A symlink in the folder must not lead outside it.
  const real = fs.realpathSync.native(full);
  if (path.dirname(real) !== fs.realpathSync.native(dir)) {
    throw new UserError("Image must be inside the RUGR images folder.");
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new UserError("Image not found.");
  if (stat.size > MAX_IMAGE_BYTES) throw new UserError("Image is larger than 4 MB.");
  return { path: real, mime, name: fileName };
}

/** The newest usable image in the folder, for "use latest image". */
export function latestImage(dir = files.imagesDir()): string | null {
  let best: { name: string; mtime: number } | null = null;
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!ALLOWED.has(path.extname(name).toLowerCase()) || name.startsWith(".")) continue;
    const st = fs.statSync(path.join(dir, name));
    if (st.isFile() && st.size <= MAX_IMAGE_BYTES && (!best || st.mtimeMs > best.mtime)) {
      best = { name, mtime: st.mtimeMs };
    }
  }
  return best?.name ?? null;
}
