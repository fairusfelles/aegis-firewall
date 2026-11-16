// AEGIS demo build.
//
// Bundles the unmodified Node engine (../engine) for the browser with
// esbuild and assembles the GitHub Pages site into ../docs (Pages is
// enabled on the /docs folder of main):
//
//   docs/index.html        <- demo/index.html
//   docs/assets/style.css  <- demo/style.css
//   docs/assets/app.js     <- demo/app.js        (page UI logic)
//   docs/assets/aegis.js   <- esbuild bundle of demo/src/entry.js
//   docs/.nojekyll         (serve everything as-is, no Jekyll)
//
// Browser adaptations are build-time only; no engine file is modified:
//   * `process.env` is defined as {} so the engine falls back to its
//     built-in defaults (public BSC RPC endpoints, Sourcify base URL).
//   * The CLI-only `fs` / `path` imports of engine/screen.js are
//     stubbed with empty modules. They are used solely inside its
//     main(), which the browser entry never invokes.
//   * `assert` and `events` (required by circomlibjs's CJS build and
//     by readable-stream) are aliased to their standard browser
//     polyfill packages, installed as demo devDependencies.
//
// Usage:
//   node build.mjs               build the site into ../docs
//   node build.mjs --test-bundle build a Node CJS bundle at
//                                /tmp/aegis-test-bundle.cjs (for the
//                                headless verification in test-bundle.cjs)

import { build } from "esbuild";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const demoDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(demoDir, "..");
const testBundle = process.argv.includes("--test-bundle");

const nodeBuiltins = {
  name: "node-builtins",
  setup(b) {
    // CLI-only imports of engine/screen.js: never exercised in the
    // browser (its main() is not invoked), so an empty module is safe.
    b.onResolve({ filter: /^(fs|path)$/ }, (args) => ({
      path: args.path,
      namespace: "aegis-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "aegis-stub" }, () => ({
      contents: "module.exports = {};",
      loader: "js",
    }));
    // Real polyfills for builtins the bundled libraries actually use.
    const polyfills = {
      assert: resolve(demoDir, "node_modules/assert/build/assert.js"),
      events: resolve(demoDir, "node_modules/events/events.js"),
    };
    b.onResolve({ filter: /^(assert|events)$/ }, (args) => ({
      path: polyfills[args.path],
    }));
  },
};

const shared = {
  entryPoints: [resolve(demoDir, "src/entry.js")],
  bundle: true,
  platform: "browser",
  target: "es2020",
  define: { "process.env": "{}" },
  plugins: [nodeBuiltins],
  logLevel: "info",
};

if (testBundle) {
  await build({
    ...shared,
    format: "cjs",
    outfile: "/tmp/aegis-test-bundle.cjs",
  });
  console.log("test bundle written to /tmp/aegis-test-bundle.cjs");
} else {
  const docsDir = resolve(repoRoot, "docs");
  const assetsDir = resolve(docsDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  await build({
    ...shared,
    format: "iife",
    minify: true,
    outfile: resolve(assetsDir, "aegis.js"),
  });
  copyFileSync(resolve(demoDir, "index.html"), resolve(docsDir, "index.html"));
  copyFileSync(resolve(demoDir, "style.css"), resolve(assetsDir, "style.css"));
  copyFileSync(resolve(demoDir, "app.js"), resolve(assetsDir, "app.js"));
  writeFileSync(resolve(docsDir, ".nojekyll"), "");
  console.log("site assembled into docs/");
}
