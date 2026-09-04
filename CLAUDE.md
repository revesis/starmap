# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Starmap: a zero-dependency Node.js CLI that renders the current directory's codebase as an explorable
particle cosmos in the browser. Files are particles (radius = file size, color = extension), import/require
edges are connecting "strings," and top-level directories cluster into nebulae. Includes photon-style
canvas rendering, jitter for files touched by the latest commit, gravity-well grid warping, Tone.js-based sonification,
and camera-based two-hand gesture control (MediaPipe Hands) as an alternative to mouse/touch.

There are no external runtime dependencies (backend is pure Node built-ins); frontend libraries (Tone.js,
MediaPipe Hands) are loaded from CDN in `public/index.html`, not npm-installed.

## Commands

```bash
node bin/cli.js [dir] [--port 4550] [--https]
# or, if installed as a package:
starmap [dir] [--port 4550] [--https]
```

- No build step, no bundler, no test suite, no lint config — plain scripts served as-is.
- `--https` requires `openssl` on the system PATH; it generates/caches a self-signed cert under
  `~/.cache/starmap/`. Needed for camera access (`getUserMedia`) from any origin other than
  `localhost`, e.g. testing gestures on a phone over LAN.
- To smoke-test packaging: `npm pack` then `npm install -g ./starmap-*.tgz` in a scratch prefix.

## Architecture

**Backend** (`src/`, `bin/cli.js`) — scans the repo, builds a dependency graph, serves it + static assets.

- `bin/cli.js` — CLI arg parsing, picks `http` or `https` server based on `--https`, prints LAN addresses.
- `src/scan.js` — lists files via `git ls-files --cached --others --exclude-standard` (respects
  `.gitignore` automatically) when the target dir is a git repo, else falls back to a manual recursive
  walk skipping `.git`/`node_modules`/etc.
- `src/graph.js` — the core model builder (`build(rootDir, files, gitRepo)`):
  - `COLOR_TABLE` maps extension → color; `sizeToRadius` linearly maps file size → particle radius (clamped).
  - Dependency resolution is regex-based (`IMPORT_PATTERNS`) and only handles **relative-path**
    import/require in JS/JSX/TS/TSX/MJS/CJS/Python — no `node_modules`/package resolution, no real
    call graph. This is a known/accepted scope limit (see README "Current scope").
  - `computeTouchedByLastCommit` shells out to `git log -n 1 --name-only` to get a per-file boolean
    (`n.touched`, not a graded score) used for jitter and as an ambient sound intensity input.
- `src/server.js` — `createRequestHandler(rootDir)` is shared by both HTTP and HTTPS servers. Routes:
  `/api/graph` (the built graph), `/api/refresh` (POST, rescans — polled every 20s by the frontend to
  spawn/despawn particles for files that appeared/disappeared and to catch `touched` flipping), `/api/diff`
  (runs `git diff`/`git log`/`git status` via `execFile` for a given file), `/api/file` (content preview), plus static serving from
  `public/`. `safeResolveRel` guards against path traversal on all file-path-taking routes.
- `src/certs.js` — self-signed cert generation/caching (shells out to `openssl`), and LAN IP enumeration
  for the "open on your phone" print at startup.

**Frontend** (`public/`) — single-page canvas app, no framework, no module bundler (plain `<script>` tags
loaded in dependency order in `index.html`: Tone.js → `audio.js` → MediaPipe Hands → `hands.js` → `app.js`).

- `public/app.js` — the largest file; owns almost everything: physics layout (`initLayout`/`step`, using
  spatial-grid bucketing for O(n) approximate repulsion + spring edges + per-directory cluster centers),
  rendering (`draw`, photon-style particles/edges, gravity-grid warping, hand skeleton overlay, rulers,
  compass dial), the coordinate transform system, and all mouse/touch/gesture input handling.
  - **Coordinate transforms are centralized**: `worldToScreen` / `screenToWorld` / `screenDeltaToWorld`
    implement a full 2D rotation (`view = {x, y, scale, rotation}`) in CSS-pixel space (not device-pixel —
    `cssW`/`cssH` module vars, updated in `resize()`). Every consumer (picking, dragging, grid warp,
    rulers, compass) goes through these functions, so any future view-transform change should stay
    inside them rather than special-casing callers.
  - Gesture design constraints (deliberate, from user iteration): pan/zoom via camera requires an explicit
    fist "grab" gesture (not continuous hand-position tracking); the pinch cursor/reticle only renders
    during an active pinch; a single pinch on a particle just highlights it, a **double pinch** (same
    particle, within `DOUBLE_PINCH_WINDOW` = 450ms) opens the detail panel — this mirrors mouse
    click vs. double-click intentionally, to avoid accidental panel-opens from touch/gesture noise.
  - Touch and camera-hand-tracking gesture code paths are kept parallel by design: two-finger touch
    pan/zoom/rotate and two-hand camera pan/zoom/rotate both resolve to the same `onTwoHandTransform`-
    shaped update path.
- `public/audio.js` — `window.CosmosAudio`: click-to-pluck (`PluckSynth`) on selection, an entropy-driven
  ambient drone (`Noise` + `Filter`), and a **bounded 24-voice** persistent ambient sound field
  (`Oscillator`+`Gain`+`Panner` per voice, with voice-stealing assignment) — intentionally capped rather
  than one voice per particle, for performance.
- `public/hands.js` — `window.CosmosHands`: wraps MediaPipe Hands for two-hand landmark tracking.
  Fist detection (`isFist`) is fingertip-to-wrist distance normalized by palm size, not a MediaPipe
  built-in. Requires a secure context (`https://` or `http://localhost`) for `getUserMedia` — this is
  why `--https` exists.

## Notes for future changes

- Keep all comments, log/console output, and UI-facing strings in English (established convention;
  the codebase was fully translated from Chinese for distribution).
- `123.txt` and `big-bang-symphony.html` at the repo root are unrelated scratch files, not part of the
  project — leave them untracked/uncommitted.
- The `IMPORT_PATTERNS`/relative-import-only resolution in `src/graph.js` and the "MVP" limitations in
  README.md's "Current scope" section are known, accepted gaps — don't treat them as bugs to silently fix
  without checking in first, since they trade off real complexity (e.g. full module resolution, a real
  call graph) against staying dependency-free.
