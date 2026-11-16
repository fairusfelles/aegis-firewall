# AEGIS demo — public screening page

The live demo at
**https://fairusfelles.github.io/aegis-firewall/** is served by GitHub
Pages from the repo's `/docs` folder. It runs the screening engine
entirely in the visitor's browser — there is no AEGIS server.

## Layout

| File | Role |
|---|---|
| `index.html` | Page markup (copied to `docs/index.html`) |
| `style.css` | Page styles (copied to `docs/assets/style.css`) |
| `app.js` | Page UI logic (copied to `docs/assets/app.js`) |
| `src/entry.js` | Bundle entry: re-exports the unmodified engine (`engine/screen.js`, `engine/lib/fields.js`) and embeds the committed replay cases + recorded reports from `engine/replays/` |
| `build.mjs` | esbuild bundling + site assembly into `../docs` |
| `test-bundle.cjs` | Headless verification of the bundle (below) |

## Build

```bash
cd demo
npm install        # esbuild + the assert/events polyfills (dev only)
node build.mjs     # bundle + assemble the site into ../docs
```

Browser adaptations are build-time only; **no engine file is
modified**:

- `process.env` is defined as `{}` — the engine falls back to its
  built-in defaults (public BSC RPC endpoints, Sourcify base URL).
  Both were verified CORS-accessible (`Access-Control-Allow-Origin: *`)
  from the Pages origin.
- `fs` / `path` (used only by the engine CLI's `main()`, never invoked
  here) are stubbed with empty modules.
- `assert` / `events`, required by circomlibjs's CJS build and
  readable-stream, are aliased to their standard browser polyfill
  packages.
- circomlibjs is bundled via its published pure-JS CJS build, so the
  in-browser Poseidon is the exact implementation that sealed the
  committed replay reports (the package's ESM entry swaps in a Wasm
  Poseidon variant; it is deliberately not used).

## Verify the bundle headlessly

```bash
node build.mjs --test-bundle   # writes /tmp/aegis-test-bundle.cjs
node test-bundle.cjs
```

Test 1 recomputes the Poseidon commitment from each committed replay
report's fields with the bundled circomlibjs and requires an exact
match. Test 2 runs the bundled `screenPreview` live on the FEG replay
preview and requires verdict BLOCK with the same triggered rules as
recorded (the recorded block itself is pruned by the public endpoints
by now, so fields[5] and the commitment are expected to differ;
fields[0..4] and the rule set are not).
