# Starmap 🌌

Renders the current directory's code as a particle cosmos: every file is a particle,
dependencies between files are "strings" connecting them, clustered into nebulae by
top-level directory. Drawn with Canvas — just open it in a browser, so it works fine
on a machine with no GUI.

## Usage

```bash
node bin/cli.js [dir] [--port 4550] [--https]
```

Once started, the terminal prints an `http://localhost:4550` link — open it in a browser.

- Scroll to zoom, drag empty space to pan the canvas; touch devices support one-finger drag/tap and two-finger zoom
- Drag a particle to pin it in place
- Click a particle to highlight it and show its full path; double-click (or double-pinch via camera gestures) to open the side panel with file info — if the directory is a git repo it shows that file's uncommitted diff and recent commit history, otherwise a file content preview
- If the directory is a git repo, drag the arch-shaped dial at the bottom of the screen to scrub back through commit history: it highlights which files that commit touched and hides particles for files that didn't exist yet as of that point in time
- The HUD lets you turn on music (click-to-pluck sound effects + an entropy-driven ambient noise floor + a bounded-voice ambient sound field) and camera gestures (one-hand pan, two-hand zoom/rotate, pinch to select)
- **Add `--https` for LAN/mobile access**: the camera (`getUserMedia`) only works in a secure context — `https://` or `http://localhost`. Accessing via a LAN IP from a phone or other device requires `--https` (needs `openssl` installed on the system; it generates a self-signed cert cached in `~/.cache/starmap/`, and the browser will warn it's "not secure" — just choose to continue). Plain `localhost` access is unaffected; the camera works fine without this flag in that case.

## Visual mapping rules

| Dimension | Mapping |
| --- | --- |
| Particle radius | Linear mapping to file size (clamped to a visible range so huge files don't blow up the canvas) |
| Particle color | Looked up by file extension (the `COLOR_TABLE` in `src/graph.js`) |
| Color depth | Linearly correlated with the file's degree (in + out edges) — the more it's called, the brighter |
| Nebula grouping | Clustered by the file's top-level directory |
| Ignore rules | Directly reuses `git ls-files --others --exclude-standard`, so anything git-ignored is ignored here too; falls back to skipping `node_modules`/`.git` etc. in non-git directories |

## Current scope (MVP)

- Dependency resolution covers JS/JSX/TS/TSX/MJS/CJS, Python, Dart, Java, Go, Rust, and HTML (one
  resolver module per language under `src/resolvers/`), but it's regex-based, not a real
  function-level call graph, and each language has its own accepted gaps: JS/Python/Dart/Rust only
  resolve **relative** import paths, not `node_modules`/`package:`/crate-external packages; Java
  also recognizes Spring/JSR-330 dependency injection (`@Autowired`/`@Inject`/`@Resource` fields and
  constructors) but skips `import static` and wildcard imports; Go resolves package imports by
  suffix-matching against the repo's own directories (no `go.mod` module-prefix reading); Rust only
  follows `mod name;` file-inclusion declarations, not `use` paths; HTML only follows
  `<script src="...">` tags (not `<link>`/`<img>`/etc.) and skips absolute/CDN URLs, which is how
  this project's own `public/index.html` -> `app.js`/`audio.js`/`hands.js` edges show up.
- Diff/log come from shelling out to `git diff` / `git log` locally, and only work when the directory is a git repo.
- Large directories (thousands of files) use a grid approximation for inter-particle repulsion to avoid O(n²), but there's no further optimization beyond viewport culling (e.g. WebGL), so very large file counts may still drop frames.

## Possible future directions

- Wire up tree-sitter for a primary language to get a real function-call graph (more expensive, add if needed)
- Switch to WebGL rendering once file counts get too large
- Highlight a particle's full dependency chain when it's clicked

## 💖 Support & Donations


| Coin | Network | Address |
| :--- | :--- | :--- |
| **SOL** | Solana | `GnXfjr5Kq4tpijwfeMbtnqicLFptXXP5rV79axB1M6F5` |
