// Builds dist-exe/pumpv-companion.exe: the companion and Node in one file, so players
// install nothing else. It uses the Node running this script: npm run package
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");
const postject = require("postject");

const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

async function main() {
  const root = path.join(__dirname, "..");
  const out = path.join(root, "dist-exe");
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out);

  const bundle = path.join(out, "companion.cjs");
  const blob = path.join(out, "companion.blob");
  const exe = path.join(out, "pumpv-companion.exe");
  esbuild.buildSync({
    entryPoints: [path.join(root, "src", "cli.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: `node${process.versions.node.split(".")[0]}`,
    // Optional speed-ups that ws and bigint-buffer do without. They're native
    // files, which can't live inside a single exe.
    external: ["bufferutil", "utf-8-validate", "bindings"],
    legalComments: "none",
    logLevel: "warning",
  });

  const seaConfig = path.join(out, "sea-config.json");
  fs.writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: true }));
  execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });

  fs.copyFileSync(process.execPath, exe);
  await postject.inject(exe, "NODE_SEA_BLOB", fs.readFileSync(blob), { sentinelFuse: SEA_FUSE });

  for (const f of [bundle, blob, seaConfig]) fs.rmSync(f);
  console.log(`wrote ${exe} (${Math.round(fs.statSync(exe).size / 1024 / 1024)} MB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
