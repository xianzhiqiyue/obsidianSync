import esbuild from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import process from "node:process";

const isWatch = process.argv.includes("--watch");

async function copyAssets() {
  await mkdir("dist", { recursive: true });
  await Promise.all([copyFile("manifest.json", "dist/manifest.json"), copyFile("styles.css", "dist/styles.css")]);
}

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  outfile: "dist/main.js",
  sourcemap: true,
  external: ["obsidian"],
  logLevel: "info"
});

if (isWatch) {
  await ctx.watch();
  await copyAssets();
  console.log("plugin build watcher started");
} else {
  await ctx.rebuild();
  await copyAssets();
  await ctx.dispose();
}
