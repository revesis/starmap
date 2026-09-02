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
- Click a particle: the side panel shows file info; if the directory is a git repo it shows that file's uncommitted diff and recent commit history; otherwise it shows a file content preview
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

- Dependency resolution currently only handles **relative-path import/require** (JS/JSX/TS/TSX/MJS/CJS/Python);
  it doesn't resolve `node_modules`/third-party packages, and it isn't a real function-level call graph.
- Diff/log come from shelling out to `git diff` / `git log` locally, and only work when the directory is a git repo.
- Large directories (thousands of files) use a grid approximation for inter-particle repulsion to avoid O(n²), but there's no further optimization beyond viewport culling (e.g. WebGL), so very large file counts may still drop frames.

## Possible future directions

- Wire up tree-sitter for a primary language to get a real function-call graph (more expensive, add if needed)
- Switch to WebGL rendering once file counts get too large
- Highlight a particle's full dependency chain when it's clicked
