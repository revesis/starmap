(() => {
  'use strict';

  const canvas = document.getElementById('cosmos');
  const ctx = canvas.getContext('2d');
  const panel = document.getElementById('panel');
  const panelTitle = document.getElementById('panelTitle');
  const panelMeta = document.getElementById('panelMeta');
  const panelBody = document.getElementById('panelBody');
  const rootLabel = document.getElementById('rootLabel');
  const statsEl = document.getElementById('stats');
  const legendEl = document.getElementById('legend');
  const searchEl = document.getElementById('search');
  const soundToggleEl = document.getElementById('soundToggle');
  const handToggleEl = document.getElementById('handToggle');
  const handPreviewEl = document.getElementById('handPreview');
  const handCanvasEl = document.getElementById('handCanvas');
  let handsEnabled = false;
  let handCursor = null; // { x, y } normalized 0..1, from camera hand tracking
  let handLandmarks = []; // 21 key points per hand (mirrored, normalized 0..1), drawn on the main canvas

  let audioEnabled = false;
  // Fraction of files touched by the latest commit — a continuous 0..1 aggregate even though each
  // file's own `touched` is a boolean. Drives both audio.js's ambient drone and the wave-ripple
  // strength in draw(); recomputed on load and again after every refreshTouchedFiles poll.
  let avgEntropy = 0;
  function recomputeAvgEntropy() {
    return nodes.length ? nodes.reduce((s, n) => s + (n.touched ? 1 : 0), 0) / nodes.length : 0;
  }

  // ---- Mobile onboarding: prompt touch devices to go landscape + fullscreen ----
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  // Re-enterable: a native permission dialog (e.g. the camera prompt for gestures) can kick
  // the page out of fullscreen/landscape on some mobile browsers, so this gets called again
  // after such prompts resolve, not just once from the onboarding gate.
  async function enterImmersiveMode() {
    if (!isTouch) return;
    const el = document.documentElement;
    try {
      if (el.requestFullscreen) await el.requestFullscreen();
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    } catch {
      // some browsers (e.g. iOS Safari) don't support the Fullscreen API — safe to ignore
    }
    try {
      if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape');
    } catch {
      // some browsers don't support locking orientation — safe to ignore
    }
  }

  (function setupMobileGate() {
    const gate = document.getElementById('mobileGate');
    if (!gate || !isTouch) return;
    gate.classList.add('show');

    const hide = () => gate.classList.remove('show');
    document.getElementById('gateSkip').addEventListener('click', hide);
    document.getElementById('gateEnter').addEventListener('click', async () => {
      await enterImmersiveMode();
      hide();
    });
  })();

  let nodes = [];
  let edges = [];
  let gitRepo = false;
  let nodeById = new Map();
  let edgeKeys = new Set(); // "source=>target" for edges already added, so refresh-time merges can dedupe cheaply
  let clusterCenters = new Map(); // dir -> {x, y}, persisted across refreshes so new files in a known dir join it
  let clusterR = 260;

  // View transform: world coords <-> screen coords (CSS pixel space, matching mouse events and canvas size units)
  // rotation: view rotation angle (radians), 0 = normal orientation
  const view = { x: 0, y: 0, scale: 1, rotation: 0 };
  let cssW = window.innerWidth;
  let cssH = window.innerHeight;

  function resize() {
    cssW = window.innerWidth;
    cssH = window.innerHeight;
    canvas.width = cssW * devicePixelRatio;
    canvas.height = cssH * devicePixelRatio;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
  }
  window.addEventListener('resize', resize);
  resize();

  function worldToScreen(x, y) {
    const dx = x - view.x;
    const dy = y - view.y;
    const cos = Math.cos(view.rotation);
    const sin = Math.sin(view.rotation);
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    return [rx * view.scale + cssW / 2, ry * view.scale + cssH / 2];
  }
  function screenToWorld(sx, sy) {
    const dx = (sx - cssW / 2) / view.scale;
    const dy = (sy - cssH / 2) / view.scale;
    const cos = Math.cos(view.rotation);
    const sin = Math.sin(view.rotation);
    // inverse rotation (rotate by -rotation)
    const rx = dx * cos + dy * sin;
    const ry = -dx * sin + dy * cos;
    return [rx + view.x, ry + view.y];
  }
  // Given a world point and the screen position it should appear at under the CURRENT
  // scale/rotation, solve for the view.x/y that makes that true. Used by two-finger/two-hand
  // gestures: anchor a world point (captured at gesture start) to the moving screen midpoint,
  // so spreading/rotating zooms+rotates around it AND dragging both points together pans.
  function solveViewOffsetForAnchor(worldX, worldY, screenX, screenY) {
    const dx = (screenX - cssW / 2) / view.scale;
    const dy = (screenY - cssH / 2) / view.scale;
    const cos = Math.cos(view.rotation);
    const sin = Math.sin(view.rotation);
    const rx = dx * cos + dy * sin;
    const ry = -dx * sin + dy * cos;
    return [worldX - rx, worldY - ry];
  }
  // Convert a "screen pixel offset" into the corresponding world-coordinate offset,
  // used for drag-panning (accounts for rotation)
  function screenDeltaToWorld(ddx, ddy) {
    const cos = Math.cos(view.rotation);
    const sin = Math.sin(view.rotation);
    return [
      (ddx * cos + ddy * sin) / view.scale,
      (-ddx * sin + ddy * cos) / view.scale,
    ];
  }

  // 0..1 render scale for a particle's spawn-in/despawn-out animation (see spawnIncomingNodes and
  // despawnNode); 0 means "don't draw it at all". A plain existing particle always returns 1.
  function nodePresence(n, tMs) {
    if (n.spawnAt && tMs < n.spawnAt) return 0;
    if (n.spawnDoneAt && tMs < n.spawnDoneAt) {
      return Math.max(0, Math.min(1, (tMs - n.spawnAt) / NEW_FILE_SPAWN_MS));
    }
    if (n.removeStartAt) {
      return Math.max(0, Math.min(1, 1 - (tMs - n.removeStartAt) / REMOVE_FADE_MS));
    }
    return 1;
  }

  // Periodically re-scans (via /api/refresh) and checks whether each particle just entered or
  // left "touched by the latest commit" (a plain boolean now — see computeTouchedByLastCommit in
  // src/graph.js — not a graded score, so there's no level to bucket, just a flip to flash on).
  // Any file the current node list doesn't know about yet is handed to spawnIncomingNodes as a
  // batch, since new files tend to arrive in bursts (a save-all, a generated batch of files, etc.)
  // rather than one at a time; anything that dropped out of the fresh scan is despawned the same way.
  const REFRESH_INTERVAL_MS = 20000;
  const TOUCH_FLASH_MS = 700;
  const MAX_BATCH_PLUCKS = 6; // cap concurrent arrival/touch sounds so a burst of files isn't a chord
  let plucksThisBatch = 0;
  function throttledPluck(n) {
    if (!audioEnabled || plucksThisBatch >= MAX_BATCH_PLUCKS) return;
    plucksThisBatch++;
    window.CosmosAudio && window.CosmosAudio.pluck(n);
  }
  async function refreshTouchedFiles() {
    try {
      const res = await fetch('/api/refresh', { method: 'POST' });
      const data = await res.json();
      plucksThisBatch = 0;
      const freshIds = new Set(data.nodes.map((raw) => raw.id));
      const incoming = [];
      for (const updated of data.nodes) {
        const n = nodeById.get(updated.id);
        if (!n) { incoming.push(updated); continue; }
        if (updated.touched !== n.touched) {
          n.touched = updated.touched;
          n.flashUntil = performance.now() + TOUCH_FLASH_MS;
          throttledPluck(n);
        }
      }
      if (incoming.length) spawnIncomingNodes(incoming, data.edges);
      for (const n of nodes) {
        if (!n.removeStartAt && !freshIds.has(n.id)) despawnNode(n);
      }
      avgEntropy = recomputeAvgEntropy();
      if (audioEnabled) window.CosmosAudio && window.CosmosAudio.updateEntropy(avgEntropy);
    } catch {
      // a failed refresh just means we try again next interval
    }
  }

  // New files arrive as a batch: give each a staggered entrance (grows in over NEW_FILE_SPAWN_MS,
  // starting NEW_FILE_STAGGER_MS after the previous one) instead of popping in all at once, and
  // wire up any edges that now connect two known nodes. Existing-node edges were already added at
  // load time, so only edges touching the new batch can possibly be missing.
  const NEW_FILE_STAGGER_MS = 60;
  const NEW_FILE_SPAWN_MS = 900;
  function spawnIncomingNodes(rawNodes, allEdges) {
    const now = performance.now();
    rawNodes.forEach((raw, i) => {
      const c = clusterCenterFor(raw.dir);
      const jitter = 120;
      const spawnAt = now + i * NEW_FILE_STAGGER_MS;
      const n = {
        ...raw,
        x: c.x + (Math.random() - 0.5) * jitter,
        y: c.y + (Math.random() - 0.5) * jitter,
        vx: 0,
        vy: 0,
        cx: c.x,
        cy: c.y,
        fixed: false,
        phase: Math.random() * Math.PI * 2,
        twinkleSpeed: 0.6 + Math.random() * 1.2 + (raw.touched ? 2 : 0),
        mass: raw.radius + raw.degree * 6,
        flashUntil: 0,
        spawnAt,
        spawnDoneAt: spawnAt + NEW_FILE_SPAWN_MS,
      };
      nodes.push(n);
      nodeById.set(n.id, n);
      setTimeout(() => throttledPluck(n), i * NEW_FILE_STAGGER_MS);
    });

    for (const e of allEdges) {
      const key = e.source + '=>' + e.target;
      if (edgeKeys.has(key)) continue;
      const s = nodeById.get(e.source);
      const t = nodeById.get(e.target);
      if (!s || !t) continue;
      edgeKeys.add(key);
      edges.push(e);
      s.degree += 1;
      t.degree += 1;
    }

    rootLabel.textContent = `${nodes.length} particles · ${edges.length} strings${gitRepo ? ' · git connected' : ''}`;
  }

  // A file no longer in the scan (deleted, or moved so its old path vanished) shrinks out over
  // REMOVE_FADE_MS — the mirror image of spawnIncomingNodes' grow-in — then is actually removed
  // from nodes/edges. It keeps taking part in the physics simulation while shrinking so it
  // doesn't visually "freeze" mid-collapse.
  const REMOVE_FADE_MS = 700;
  function despawnNode(n) {
    n.removeStartAt = performance.now();
    n.removeDoneAt = n.removeStartAt + REMOVE_FADE_MS;
    setTimeout(() => removeNode(n.id), REMOVE_FADE_MS);
  }
  function removeNode(id) {
    const idx = nodes.findIndex((n) => n.id === id);
    if (idx === -1) return;
    nodes.splice(idx, 1);
    nodeById.delete(id);
    for (let i = edges.length - 1; i >= 0; i--) {
      const e = edges[i];
      if (e.source !== id && e.target !== id) continue;
      edgeKeys.delete(e.source + '=>' + e.target);
      const s = nodeById.get(e.source);
      const t = nodeById.get(e.target);
      if (s) s.degree -= 1;
      if (t) t.degree -= 1;
      edges.splice(i, 1);
    }
    if (selectedId === id) {
      selectedId = null;
      panel.classList.remove('open');
    }
    if (hoveredId === id) hoveredId = null;
    rootLabel.textContent = `${nodes.length} particles · ${edges.length} strings${gitRepo ? ' · git connected' : ''}`;
  }

  // A dir's cluster center is created once and kept for the life of the page, so a file arriving
  // later in the same directory (see spawnIncomingNodes) joins its existing nebula instead of
  // getting a brand-new one.
  function clusterCenterFor(dir) {
    if (!clusterCenters.has(dir)) {
      const angle = Math.random() * Math.PI * 2;
      clusterCenters.set(dir, { x: Math.cos(angle) * clusterR, y: Math.sin(angle) * clusterR });
    }
    return clusterCenters.get(dir);
  }

  // ---- Layout: cluster into per-directory "nebulae", force-directed within each cluster ----
  function initLayout() {
    const dirs = [...new Set(nodes.map((n) => n.dir))];
    clusterCenters = new Map();
    clusterR = 260 * Math.max(1, Math.sqrt(dirs.length));
    dirs.forEach((d, i) => {
      const angle = (i / dirs.length) * Math.PI * 2;
      clusterCenters.set(d, { x: Math.cos(angle) * clusterR, y: Math.sin(angle) * clusterR });
    });

    for (const n of nodes) {
      const c = clusterCenterFor(n.dir);
      const jitter = 120;
      n.x = c.x + (Math.random() - 0.5) * jitter;
      n.y = c.y + (Math.random() - 0.5) * jitter;
      n.vx = 0;
      n.vy = 0;
      n.cx = c.x;
      n.cy = c.y;
      n.fixed = false;
      n.phase = Math.random() * Math.PI * 2;
      // files touched by the latest commit twinkle a bit faster/more "restless"
      n.twinkleSpeed = 0.6 + Math.random() * 1.2 + (n.touched ? 2 : 0);
      // gravity mass: the bigger the file and the more it's depended on, the more it warps the spacetime grid around it
      n.mass = n.radius + n.degree * 6;
      n.flashUntil = 0;
    }
  }

  // Uniform grid for approximate inter-particle repulsion (avoids O(n^2))
  function buildGrid(cellSize) {
    const grid = new Map();
    for (const n of nodes) {
      const gx = Math.floor(n.x / cellSize);
      const gy = Math.floor(n.y / cellSize);
      const key = gx + ',' + gy;
      let arr = grid.get(key);
      if (!arr) grid.set(key, (arr = []));
      arr.push(n);
    }
    return grid;
  }

  function step() {
    const cellSize = 80;
    const grid = buildGrid(cellSize);
    const REPULSE = 900;
    const SPRING = 0.02;
    const SPRING_LEN = 70;
    const CENTER_PULL = 0.004;
    const DAMPING = 0.82;

    // Repulsion: only compare within the same cell and neighboring cells
    for (const n of nodes) {
      if (n.fixed) continue;
      const gx = Math.floor(n.x / cellSize);
      const gy = Math.floor(n.y / cellSize);
      let fx = 0, fy = 0;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const arr = grid.get((gx + dx) + ',' + (gy + dy));
          if (!arr) continue;
          for (const other of arr) {
            if (other === n) continue;
            let ddx = n.x - other.x;
            let ddy = n.y - other.y;
            let distSq = ddx * ddx + ddy * ddy;
            if (distSq < 1) distSq = 1;
            const dist = Math.sqrt(distSq);
            if (dist > cellSize * 1.5) continue;
            const force = REPULSE / distSq;
            fx += (ddx / dist) * force;
            fy += (ddy / dist) * force;
          }
        }
      }
      // pull back toward the center of its own nebula
      fx += (n.cx - n.x) * CENTER_PULL;
      fy += (n.cy - n.y) * CENTER_PULL;
      // a file touched by the latest commit gets a visible random "thermal motion"
      if (n.touched) {
        const heat = 2.2;
        fx += (Math.random() - 0.5) * heat;
        fy += (Math.random() - 0.5) * heat;
      }
      n.vx = (n.vx + fx) * DAMPING;
      n.vy = (n.vy + fy) * DAMPING;
    }

    // Springs: pull dependency-connected nodes closer together
    for (const e of edges) {
      const s = nodeById.get(e.source);
      const t = nodeById.get(e.target);
      if (!s || !t) continue;
      let dx = t.x - s.x;
      let dy = t.y - s.y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const diff = (dist - SPRING_LEN) * SPRING;
      const fx = (dx / dist) * diff;
      const fy = (dy / dist) * diff;
      if (!s.fixed) { s.vx += fx; s.vy += fy; }
      if (!t.fixed) { t.vx -= fx; t.vy -= fy; }
    }

    for (const n of nodes) {
      if (n.fixed) continue;
      n.x += n.vx;
      n.y += n.vy;
    }
  }

  // ---- Rendering: draw particles as "photons" ----
  // intensity 0..1: the more calls, the brighter/more saturated the color (particle side: higher energy = brighter)
  function intensityRGB(hex, intensity) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const t = 0.35 + intensity * 0.65;
    const mix = (c) => Math.round(c * t + 255 * (1 - t) * 0.15);
    return [mix(r), mix(g), mix(b)];
  }
  function colorWithIntensity(hex, intensity) {
    const [r, g, b] = intensityRGB(hex, intensity);
    return `rgb(${r}, ${g}, ${b})`;
  }
  // Photon core: mix in some white light — the "heavier" (more-called) a particle, the whiter-hot its core
  function coreColor(hex, intensity) {
    const [r, g, b] = intensityRGB(hex, intensity);
    const w = 0.35 + intensity * 0.35;
    const mix = (c) => Math.round(c * (1 - w) + 255 * w);
    return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
  }

  let selectedId = null;
  let hoveredId = null;

  // Pluck the string when a photon reaches its target particle along a dependency edge;
  // throttled so a dense call graph doesn't get noisy
  const lastArrivalPluck = new Map();
  function triggerArrivalPluck(node) {
    const now = performance.now();
    const last = lastArrivalPluck.get(node.id) || 0;
    if (now - last < 220) return;
    lastArrivalPluck.set(node.id, now);
    window.CosmosAudio && window.CosmosAudio.pluck(node);
  }

  // ---- Gravity wells: a background spacetime grid that warps toward high-mass/dense areas ----
  let gravityWells = [];
  let gravityWellsTick = 0;
  function updateGravityWells() {
    // Re-pick the "gravity sources" (the highest-mass particles) every 30 frames instead of every frame
    if (gravityWellsTick % 30 === 0) {
      gravityWells = [...nodes].sort((a, b) => b.mass - a.mass).slice(0, 40);
    }
    gravityWellsTick++;
  }

  // Returns the warped world point plus a "depth" scalar (how deep this point sits inside a
  // gravity well). Depth has no real coordinate behind it — see drawGravityGrid — it's only used
  // to fake a funnel by nudging the drawn point down the screen afterward.
  function warpPoint(px, py) {
    let dx = 0, dy = 0, depth = 0;
    for (const w of gravityWells) {
      const ddx = w.x - px;
      const ddy = w.y - py;
      const distSq = ddx * ddx + ddy * ddy + 500;
      const pull = Math.min((w.mass * 1400) / distSq, 60);
      const dist = Math.sqrt(distSq);
      dx += (ddx / dist) * pull;
      dy += (ddy / dist) * pull;
      depth += pull;
    }
    return [px + dx, py + dy, Math.min(depth, 220)];
  }

  function drawGravityGrid() {
    updateGravityWells();
    if (!gravityWells.length) return;

    // Grid spacing in world coordinates adjusts with zoom, keeping on-screen density roughly constant
    const spacing = Math.max(24, 150 / view.scale);
    const segStep = spacing / 6;
    const [wxMin, wyMin] = screenToWorld(-40, -40);
    const [wxMax, wyMax] = screenToWorld(cssW + 40, cssH + 40);
    const startX = Math.floor(wxMin / spacing) * spacing;
    const startY = Math.floor(wyMin / spacing) * spacing;

    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(120,175,255,0.10)';

    // Pseudo-3D funnel: push points down the screen in proportion to how deep they sit inside a
    // gravity well, purely for the drawn line — this never touches world/particle coordinates.
    const FUNNEL_DEPTH = 0.8;

    for (let x = startX; x <= wxMax; x += spacing) {
      ctx.beginPath();
      let first = true;
      for (let y = startY; y <= wyMax; y += segStep) {
        const [wx, wy, depth] = warpPoint(x, y);
        const [sx, sy] = worldToScreen(wx, wy);
        const dsy = sy + depth * FUNNEL_DEPTH;
        if (first) { ctx.moveTo(sx, dsy); first = false; } else ctx.lineTo(sx, dsy);
      }
      ctx.stroke();
    }
    for (let y = startY; y <= wyMax; y += spacing) {
      ctx.beginPath();
      let first = true;
      for (let x = startX; x <= wxMax; x += segStep) {
        const [wx, wy, depth] = warpPoint(x, y);
        const [sx, sy] = worldToScreen(wx, wy);
        const dsy = sy + depth * FUNNEL_DEPTH;
        if (first) { ctx.moveTo(sx, dsy); first = false; } else ctx.lineTo(sx, dsy);
      }
      ctx.stroke();
    }
  }

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#05060d';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

    const dense = nodes.length > 1500;
    const t = performance.now() / 1000;

    if (!dense) drawGravityGrid();

    // Strings (dependencies): the line itself + a photon pulse traveling along it (particle side: energy transfers along the string)
    ctx.lineWidth = 1;
    for (const e of edges) {
      const s = nodeById.get(e.source);
      const tt = nodeById.get(e.target);
      if (!s || !tt) continue;
      const [sx, sy] = worldToScreen(s.x, s.y);
      const [tx, ty] = worldToScreen(tt.x, tt.y);
      ctx.strokeStyle = dense ? 'rgba(120,140,255,0.06)' : 'rgba(120,140,255,0.12)';
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(tx, ty);
      ctx.stroke();

      if (!dense) {
        if (e._phase === undefined) e._phase = Math.random();
        const p = (t * 0.15 + e._phase) % 1;
        const px = sx + (tx - sx) * p;
        const py = sy + (ty - sy) * p;
        ctx.beginPath();
        ctx.arc(px, py, 1.6, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(200,210,255,0.75)';
        ctx.fill();

        // Give the string a light pluck when the photon "arrives" at the target particle (sparse trigger, avoids noise)
        if (audioEnabled && e._prevP !== undefined && p < e._prevP) {
          triggerArrivalPluck(tt);
        }
        e._prevP = p;
      }
    }

    // Particles (files): drawn as "photons" — wave (touched files only) + halo + white-hot core
    for (const n of nodes) {
      // Skip entirely before a spawn-in starts or after a despawn-out finishes; otherwise scale
      // toward/away from zero radius rather than popping to full size or vanishing instantly.
      const presence = nodePresence(n, t * 1000);
      if (presence <= 0) continue;

      const [sx, sy] = worldToScreen(n.x, n.y);
      const r = Math.max(n.radius * view.scale, 1.4) * presence;
      if (sx < -50 || sy < -50 || sx > cssW + 50 || sy > cssH + 50) continue;

      const rgb = intensityRGB(n.color, n.intensity);
      const rgbStr = rgb.join(',');
      const twinkle = 0.85 + 0.15 * Math.sin(t * n.twinkleSpeed + n.phase);
      const emphasize = n.id === selectedId || n.id === hoveredId;

      if (!dense) {
        // Wave: a persistent "still part of the latest commit" indicator, shown only on touched
        // particles — strength tracks avgEntropy (what fraction of the repo the latest commit
        // touched), not this particle's own properties, so a big commit reads as a wave of
        // strong ripples and a one-file commit barely shows anything.
        if (n.touched) {
          for (let i = 0; i < 2; i++) {
            const wave = ((t * 0.5 + n.phase / (Math.PI * 2) + i * 0.5) % 1);
            const waveR = r + wave * r * 3.2;
            const waveAlpha = (1 - wave) * 0.3 * avgEntropy;
            if (waveAlpha <= 0.005) continue;
            ctx.beginPath();
            ctx.arc(sx, sy, waveR, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(${rgbStr},${waveAlpha.toFixed(3)})`;
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }

        // Halo: radial gradient, the brighter the particle the bigger its glow
        const haloR = r * (3 + n.intensity * 2.5);
        const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, haloR);
        grad.addColorStop(0, `rgba(${rgbStr},${(0.55 * twinkle).toFixed(3)})`);
        grad.addColorStop(0.4, `rgba(${rgbStr},${(0.18 * twinkle).toFixed(3)})`);
        grad.addColorStop(1, `rgba(${rgbStr},0)`);
        ctx.beginPath();
        ctx.arc(sx, sy, haloR, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
      }

      if (emphasize && !dense) {
        ctx.shadowBlur = 20;
        ctx.shadowColor = `rgb(${rgbStr})`;
      } else {
        ctx.shadowBlur = 0;
      }

      // Particle side: the white-hot core highlight
      ctx.beginPath();
      ctx.arc(sx, sy, r * twinkle, 0, Math.PI * 2);
      ctx.fillStyle = coreColor(n.color, n.intensity);
      ctx.fill();

      // Touched-state flip: a discrete event (see refreshTouchedFiles), so it flashes as an
      // expanding ring rather than blending in with the continuous twinkle/glow above
      if (n.flashUntil && t * 1000 < n.flashUntil) {
        const remain = (n.flashUntil - t * 1000) / TOUCH_FLASH_MS; // 1 -> 0
        ctx.beginPath();
        ctx.arc(sx, sy, r * (1 + (1 - remain) * 5), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,255,255,${(remain * 0.8).toFixed(3)})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      if (n.id === selectedId) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#ffffff';
        ctx.shadowBlur = 0;
        ctx.stroke();
      }
    }
    ctx.shadowBlur = 0;

    // Labels: show filenames once zoomed in far enough
    if (view.scale > 1.6) {
      ctx.font = '11px sans-serif';
      ctx.fillStyle = 'rgba(230,230,240,0.85)';
      for (const n of nodes) {
        if (nodePresence(n, t * 1000) <= 0) continue;
        const [sx, sy] = worldToScreen(n.x, n.y);
        const r = n.radius * view.scale;
        if (sx < -50 || sy < -50 || sx > canvas.width / devicePixelRatio + 50) continue;
        ctx.fillText(n.label, sx + r + 3, sy + 3);
      }
    }

    // Hand skeleton: overlay the detected hands directly onto the starmap, hovering over the canvas like AR
    if (handLandmarks.length && window.CosmosHands) {
      const connections = window.CosmosHands.HAND_CONNECTIONS || [];
      for (const landmarks of handLandmarks) {
        ctx.strokeStyle = 'rgba(109,240,255,0.45)';
        ctx.lineWidth = 1.5;
        ctx.shadowBlur = 8;
        ctx.shadowColor = 'rgba(109,240,255,0.6)';
        for (const [a, b] of connections) {
          const pa = landmarks[a];
          const pb = landmarks[b];
          ctx.beginPath();
          ctx.moveTo(pa.x * cssW, pa.y * cssH);
          ctx.lineTo(pb.x * cssW, pb.y * cssH);
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(180,230,255,0.85)';
        for (const p of landmarks) {
          ctx.beginPath();
          ctx.arc(p.x * cssW, p.y * cssH, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Hand cursor: map the camera-detected hand straight onto the canvas, giving visual feedback on where it's pointing
    if (handCursor) {
      const hx = handCursor.x * cssW;
      const hy = handCursor.y * cssH;
      ctx.strokeStyle = 'rgba(109,240,255,0.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(hx, hy, 14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(hx - 20, hy);
      ctx.lineTo(hx - 8, hy);
      ctx.moveTo(hx + 8, hy);
      ctx.lineTo(hx + 20, hy);
      ctx.moveTo(hx, hy - 20);
      ctx.lineTo(hx, hy - 8);
      ctx.moveTo(hx, hy + 8);
      ctx.lineTo(hx, hy + 20);
      ctx.stroke();
    }

    drawRulers();
    drawCompassDial();
  }

  // ---- Reference rulers: fixed in screen space, follow pan/zoom, unaffected by rotation (measures "distance from screen center") ----
  function niceStep(target) {
    const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(target, 1e-6))));
    const residual = target / magnitude;
    let niceResidual;
    if (residual > 5) niceResidual = 10;
    else if (residual > 2) niceResidual = 5;
    else if (residual > 1) niceResidual = 2;
    else niceResidual = 1;
    return niceResidual * magnitude;
  }

  function drawRulers() {
    const step = niceStep(60 / view.scale);
    const pxStep = step * view.scale;
    if (!(pxStep > 0) || !isFinite(pxStep)) return;

    ctx.strokeStyle = 'rgba(109,240,255,0.22)';
    ctx.fillStyle = 'rgba(143,184,194,0.75)';
    ctx.font = '9px sans-serif';
    ctx.lineWidth = 1;

    const centerX = cssW / 2;
    for (let k = Math.ceil(-centerX / pxStep); centerX + k * pxStep <= cssW; k++) {
      const x = centerX + k * pxStep;
      if (x < 0) continue;
      const tickH = k === 0 ? 14 : 8;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, tickH);
      ctx.stroke();
      if (k !== 0) ctx.fillText(String(Math.round(k * step)), x + 2, tickH + 8);
    }

    const centerY = cssH / 2;
    for (let k = Math.ceil(-centerY / pxStep); centerY + k * pxStep <= cssH; k++) {
      const y = centerY + k * pxStep;
      if (y < 0) continue;
      const tickW = k === 0 ? 14 : 8;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(tickW, y);
      ctx.stroke();
      if (k !== 0) ctx.fillText(String(Math.round(k * step)), tickW + 2, y - 2);
    }
  }

  // ---- Circular compass: the outer ring counter-rotates to show the current view heading; the
  // center shows zoom%/rotation angle; click to reset rotation ----
  function compassCenter() {
    return [cssW / 2, cssH - 58];
  }
  const COMPASS_RADIUS = 34;
  function isInCompassDial(sx, sy) {
    const [cx, cy] = compassCenter();
    return Math.hypot(sx - cx, sy - cy) <= COMPASS_RADIUS;
  }

  function drawCompassDial() {
    const [cx, cy] = compassCenter();
    const R = COMPASS_RADIUS;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-view.rotation);
    ctx.strokeStyle = 'rgba(109,240,255,0.5)';
    ctx.lineWidth = 1;
    for (let deg = 0; deg < 360; deg += 30) {
      const a = (deg * Math.PI) / 180;
      const inner = deg % 90 === 0 ? R - 8 : R - 5;
      ctx.beginPath();
      ctx.moveTo(Math.sin(a) * inner, -Math.cos(a) * inner);
      ctx.lineTo(Math.sin(a) * R, -Math.cos(a) * R);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(109,240,255,0.9)';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', 0, -R + 12);
    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(109,240,255,0.25)';
    ctx.stroke();

    // A fixed small triangle at the top: the reference point for the current screen orientation
    ctx.beginPath();
    ctx.moveTo(cx, cy - R - 8);
    ctx.lineTo(cx - 4, cy - R + 2);
    ctx.lineTo(cx + 4, cy - R + 2);
    ctx.closePath();
    ctx.fillStyle = 'rgba(109,240,255,0.9)';
    ctx.fill();

    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(214,245,255,0.9)';
    ctx.font = '10px sans-serif';
    ctx.fillText(Math.round(view.scale * 100) + '%', cx, cy - 2);
    ctx.fillStyle = 'rgba(143,184,194,0.85)';
    ctx.font = '9px sans-serif';
    const deg = Math.round(((-view.rotation * 180) / Math.PI + 360) % 360);
    ctx.fillText(deg + '°', cx, cy + 10);
    ctx.textAlign = 'left';
  }

  // Ambient sound field: every particle can sustain a tone, but only the batch nearest the
  // screen center gets picked (bounded voices), throttled to recompute every ~200ms instead
  // of sorting all particles every frame
  const AMBIENT_VOICES = 24;
  let ambientTickCounter = 0;
  function updateAmbientField() {
    if (!audioEnabled || !nodes.length) return;
    const maxListenR = Math.max(cssW, cssH) * 0.55;
    const near = [];
    for (const n of nodes) {
      const [sx, sy] = worldToScreen(n.x, n.y);
      const dx = sx - cssW / 2;
      const dy = sy - cssH / 2;
      const dist = Math.hypot(dx, dy);
      if (dist > maxListenR) continue;
      near.push({ n, dx, dist });
    }
    near.sort((a, b) => a.dist - b.dist);
    const candidates = near.slice(0, AMBIENT_VOICES).map(({ n, dx, dist }) => {
      const proximity = 1 - dist / maxListenR;
      return {
        id: n.id,
        ext: n.ext,
        label: n.label,
        radius: n.radius,
        intensity: n.intensity,
        gain: proximity * proximity * 0.12,
        pan: Math.max(-1, Math.min(1, dx / (cssW / 2))),
      };
    });
    window.CosmosAudio && window.CosmosAudio.updateAmbient(candidates);
  }

  function loop() {
    step();
    draw();
    ambientTickCounter++;
    if (ambientTickCounter % 12 === 0) updateAmbientField();
    requestAnimationFrame(loop);
  }

  // ---- Interaction: drag to pan / zoom / drag a particle / click to select ----
  let dragging = false;
  let dragNode = null;
  let dragMoved = false;
  let lastMouse = [0, 0];

  function pickNode(sx, sy) {
    const [wx, wy] = screenToWorld(sx, sy);
    let best = null;
    let bestDist = Infinity;
    for (const n of nodes) {
      const dx = n.x - wx;
      const dy = n.y - wy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const hitR = Math.max(n.radius, 6);
      if (d <= hitR && d < bestDist) {
        best = n;
        bestDist = d;
      }
    }
    return best;
  }

  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    if (isInCompassDial(sx, sy)) {
      view.rotation = 0;
      return;
    }
    const hit = pickNode(sx, sy);
    dragMoved = false;
    if (hit) {
      dragNode = hit;
      hit.fixed = true;
    } else {
      dragging = true;
      canvas.classList.add('dragging');
    }
    lastMouse = [e.clientX, e.clientY];
  });

  window.addEventListener('mousemove', (e) => {
    const ddx = e.clientX - lastMouse[0];
    const ddy = e.clientY - lastMouse[1];
    if (Math.abs(ddx) > 2 || Math.abs(ddy) > 2) dragMoved = true;

    if (dragNode) {
      const rect = canvas.getBoundingClientRect();
      const [wx, wy] = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      dragNode.x = wx;
      dragNode.y = wy;
      dragNode.vx = 0;
      dragNode.vy = 0;
    } else if (dragging && e.shiftKey) {
      // Shift+drag = rotate the view around the point under the mouse (that world point stays under the cursor)
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const [wx, wy] = screenToWorld(sx, sy);
      view.rotation += ddx * 0.006;
      const [nwx, nwy] = screenToWorld(sx, sy);
      view.x += wx - nwx;
      view.y += wy - nwy;
    } else if (dragging) {
      const [worldDx, worldDy] = screenDeltaToWorld(ddx, ddy);
      view.x -= worldDx;
      view.y -= worldDy;
    } else {
      const rect = canvas.getBoundingClientRect();
      const hit = pickNode(e.clientX - rect.left, e.clientY - rect.top);
      hoveredId = hit ? hit.id : null;
      canvas.style.cursor = hit ? 'pointer' : 'grab';
    }
    lastMouse = [e.clientX, e.clientY];
  });

  window.addEventListener('mouseup', (e) => {
    if (dragNode && !dragMoved) {
      selectNode(dragNode);
    } else if (!dragNode && !dragging) {
      // no-op
    } else if (dragging && !dragMoved) {
      const rect = canvas.getBoundingClientRect();
      const hit = pickNode(e.clientX - rect.left, e.clientY - rect.top);
      if (hit) selectNode(hit);
    }
    dragNode = null;
    dragging = false;
    canvas.classList.remove('dragging');
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const [wx, wy] = screenToWorld(sx, sy);
    const factor = Math.exp(-e.deltaY * 0.001);
    view.scale = Math.min(20, Math.max(0.05, view.scale * factor));
    const [nwx, nwy] = screenToWorld(sx, sy);
    view.x += wx - nwx;
    view.y += wy - nwy;
  }, { passive: false });

  // ---- Touch: one finger drag to pan/move a particle/select, two fingers to pinch-zoom ----
  let pinch = null;

  function touchScreenPoint(t) {
    const rect = canvas.getBoundingClientRect();
    return [t.clientX - rect.left, t.clientY - rect.top];
  }

  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (e.touches.length === 1) {
      const t = e.touches[0];
      const [sx, sy] = touchScreenPoint(t);
      if (isInCompassDial(sx, sy)) {
        view.rotation = 0;
        return;
      }
      const hit = pickNode(sx, sy);
      dragMoved = false;
      if (hit) {
        dragNode = hit;
        hit.fixed = true;
      } else {
        dragging = true;
        canvas.classList.add('dragging');
      }
      lastMouse = [t.clientX, t.clientY];
    } else if (e.touches.length >= 2) {
      dragNode = null;
      dragging = false;
      const [x1, y1] = touchScreenPoint(e.touches[0]);
      const [x2, y2] = touchScreenPoint(e.touches[1]);
      pinch = {
        startDist: Math.hypot(x2 - x1, y2 - y1) || 1,
        startAngle: Math.atan2(y2 - y1, x2 - x1),
        startScale: view.scale,
        startRotation: view.rotation,
        anchorWorld: screenToWorld((x1 + x2) / 2, (y1 + y2) / 2),
      };
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (e.touches.length === 1 && !pinch) {
      const t = e.touches[0];
      const ddx = t.clientX - lastMouse[0];
      const ddy = t.clientY - lastMouse[1];
      if (Math.abs(ddx) > 2 || Math.abs(ddy) > 2) dragMoved = true;

      if (dragNode) {
        const [wx, wy] = screenToWorld(...touchScreenPoint(t));
        dragNode.x = wx;
        dragNode.y = wy;
        dragNode.vx = 0;
        dragNode.vy = 0;
      } else if (dragging) {
        const [worldDx, worldDy] = screenDeltaToWorld(ddx, ddy);
        view.x -= worldDx;
        view.y -= worldDy;
      }
      lastMouse = [t.clientX, t.clientY];
    } else if (e.touches.length >= 2 && pinch) {
      // Standard two-finger gesture: midpoint movement = pan, distance change = zoom,
      // angle change of the line between them = rotate — all three apply at once
      const [x1, y1] = touchScreenPoint(e.touches[0]);
      const [x2, y2] = touchScreenPoint(e.touches[1]);
      const midX = (x1 + x2) / 2;
      const midY = (y1 + y2) / 2;
      const dist = Math.hypot(x2 - x1, y2 - y1) || 1;
      const angle = Math.atan2(y2 - y1, x2 - x1);
      view.scale = Math.min(20, Math.max(0.05, pinch.startScale * (dist / pinch.startDist)));
      view.rotation = pinch.startRotation + (angle - pinch.startAngle);
      const [ax, ay] = pinch.anchorWorld;
      [view.x, view.y] = solveViewOffsetForAnchor(ax, ay, midX, midY);
    }
  }, { passive: false });

  canvas.addEventListener('touchend', (e) => {
    if (e.touches.length === 0) {
      if (dragNode && !dragMoved) {
        selectNode(dragNode);
      } else if (dragging && !dragMoved) {
        const rect = canvas.getBoundingClientRect();
        const hit = pickNode(lastMouse[0] - rect.left, lastMouse[1] - rect.top);
        if (hit) selectNode(hit);
      }
      dragNode = null;
      dragging = false;
      pinch = null;
      canvas.classList.remove('dragging');
    } else if (e.touches.length === 1) {
      // Went from two fingers to one: reset the baseline to avoid a position jump
      pinch = null;
      lastMouse = [e.touches[0].clientX, e.touches[0].clientY];
    }
  }, { passive: false });

  // ---- Detail panel / diff ----
  function escapeHtml(s) {
    return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  function renderDiff(text) {
    if (!text) return '<p class="sub">No uncommitted changes</p>';
    return '<pre>' + text.split('\n').map((line) => {
      const esc = escapeHtml(line);
      if (line.startsWith('+') && !line.startsWith('+++')) return `<span class="diff-add">${esc}</span>`;
      if (line.startsWith('-') && !line.startsWith('---')) return `<span class="diff-del">${esc}</span>`;
      if (line.startsWith('@@')) return `<span class="diff-hunk">${esc}</span>`;
      return esc;
    }).join('\n') + '</pre>';
  }

  async function selectNode(n) {
    selectedId = n.id;
    if (audioEnabled) window.CosmosAudio && window.CosmosAudio.pluck(n);
    panelTitle.textContent = n.label;
    panelMeta.textContent = `${n.id} · ${(n.size / 1024).toFixed(1)} KB · degree ${n.degree}${gitRepo ? (n.touched ? ' · touched by the latest commit' : ' · not in the latest commit') : ''}`;
    panelBody.innerHTML = '<p class="sub">Loading…</p>';
    panel.classList.add('open');

    if (!gitRepo) {
      const res = await fetch('/api/file?file=' + encodeURIComponent(n.id));
      const data = await res.json();
      panelBody.innerHTML = data.content
        ? '<h3>File preview</h3><pre>' + escapeHtml(data.content) + '</pre>'
        : '<p class="sub">Could not read this file (may be binary)</p>';
      return;
    }

    const res = await fetch('/api/diff?file=' + encodeURIComponent(n.id));
    const data = await res.json();
    let html = '';
    html += '<h3>Uncommitted changes</h3>' + renderDiff(data.diff);
    html += '<h3>Recent commits</h3><pre>' + escapeHtml(data.log || '(no history)') + '</pre>';
    panelBody.innerHTML = html;
  }

  document.getElementById('closePanel').addEventListener('click', () => {
    panel.classList.remove('open');
    selectedId = null;
  });

  searchEl.addEventListener('input', () => {
    const q = searchEl.value.trim().toLowerCase();
    if (!q) { selectedId = null; return; }
    const hit = nodes.find((n) => n.id.toLowerCase().includes(q));
    if (hit) {
      selectedId = hit.id;
      view.x = hit.x;
      view.y = hit.y;
    }
  });

  // ---- Init: fetch data ----
  async function main() {
    const res = await fetch('/api/graph');
    const data = await res.json();
    nodes = data.nodes;
    edges = data.edges;
    gitRepo = data.gitRepo;
    nodeById = new Map(nodes.map((n) => [n.id, n]));
    edgeKeys = new Set(edges.map((e) => e.source + '=>' + e.target));

    rootLabel.textContent = `${nodes.length} particles · ${edges.length} strings${gitRepo ? ' · git connected' : ''}`;
    statsEl.textContent = `Max degree: ${data.maxDegree}`;

    const seen = new Map();
    for (const n of nodes) if (!seen.has(n.ext)) seen.set(n.ext, n.color);
    legendEl.innerHTML = [...seen.entries()]
      .sort()
      .map(([ext, color]) => `<span class="legend-item"><span class="dot" style="background:${color}"></span>${ext || '(no extension)'}</span>`)
      .join('');

    avgEntropy = recomputeAvgEntropy();

    initLayout();
    loop();
    setInterval(refreshTouchedFiles, REFRESH_INTERVAL_MS);
  }

  main().catch((err) => {
    rootLabel.textContent = 'Failed to load: ' + err.message;
  });

  // ---- Music: off by default, only requests audio permission on click (browsers require a user gesture) ----
  soundToggleEl.addEventListener('click', async () => {
    if (!audioEnabled) {
      soundToggleEl.textContent = '…starting audio';
      try {
        await window.CosmosAudio.init();
        audioEnabled = true;
        window.CosmosAudio.setEnabled(true);
        window.CosmosAudio.updateEntropy(avgEntropy);
        soundToggleEl.textContent = '🔊 Music: on';
        soundToggleEl.classList.add('on');
      } catch {
        soundToggleEl.textContent = '🔈 Music: off (unavailable)';
      }
    } else {
      audioEnabled = false;
      window.CosmosAudio.setEnabled(false);
      soundToggleEl.textContent = '🔈 Music: off';
      soundToggleEl.classList.remove('on');
    }
  });

  // ---- Gestures: camera-based two-hand tracking, mapped onto the canvas ----
  // one-hand fist = grab the canvas, then move = pan; open the fingers = release and stop;
  // both hands fisted = grab the canvas, spread/close = zoom, angle change of the line
  // between them = rotate, moving both hands = pan — all three apply at once; release
  // either hand = stop;
  // thumb-index pinch = select the nearest particle there.
  let twoHandGrabStart = null; // { dist, angle, scale, rotation }, the baseline state when the two-hand grab began
  let lastPinchId = null; // the particle id the last pinch hit, used to detect a "double pinch"
  let lastPinchTime = 0;
  const DOUBLE_PINCH_WINDOW = 450; // two pinches count as a double pinch if closer together than this (ms)
  handToggleEl.addEventListener('click', async () => {
    if (!handsEnabled) {
      handToggleEl.textContent = '…starting camera';
      try {
        await window.CosmosHands.start({
          overlayCanvas: handCanvasEl,
          onCursor: (x, y) => {
            handCursor = x === null ? null : { x, y };
          },
          onLandmarks: (hands) => {
            handLandmarks = hands;
          },
          onOneHandPan: (dxNorm, dyNorm) => {
            const pixelDx = dxNorm * cssW * 1.6;
            const pixelDy = dyNorm * cssH * 1.6;
            const [worldDx, worldDy] = screenDeltaToWorld(pixelDx, pixelDy);
            view.x -= worldDx;
            view.y -= worldDy;
          },
          onTwoHandTransform: (d, angle, midXNorm, midYNorm, phase) => {
            const sx = midXNorm * cssW;
            const sy = midYNorm * cssH;
            if (phase === 'start') {
              twoHandGrabStart = {
                dist: d, angle, scale: view.scale, rotation: view.rotation,
                anchorWorld: screenToWorld(sx, sy),
              };
              return;
            }
            if (!twoHandGrabStart) return;
            view.scale = Math.min(20, Math.max(0.05, twoHandGrabStart.scale * (d / twoHandGrabStart.dist)));
            view.rotation = twoHandGrabStart.rotation + (angle - twoHandGrabStart.angle);
            const [ax, ay] = twoHandGrabStart.anchorWorld;
            [view.x, view.y] = solveViewOffsetForAnchor(ax, ay, sx, sy);
          },
          onGrabState: (state) => {
            canvas.classList.toggle('dragging', state !== 'idle');
            if (state === 'idle') twoHandGrabStart = null;
          },
          onPinch: (xNorm, yNorm) => {
            // A single pinch is too easy to trigger by accident, so it only lightly highlights;
            // pinching the same particle again within the window (a double pinch) is what actually opens the detail panel
            const hit = pickNode(xNorm * cssW, yNorm * cssH);
            if (!hit) {
              lastPinchId = null;
              return;
            }
            const now = performance.now();
            const isDoublePinch = hit.id === lastPinchId && now - lastPinchTime < DOUBLE_PINCH_WINDOW;
            if (isDoublePinch) {
              selectNode(hit);
              lastPinchId = null;
            } else {
              selectedId = hit.id;
              if (audioEnabled) window.CosmosAudio && window.CosmosAudio.pluck(hit);
              lastPinchId = hit.id;
              lastPinchTime = now;
            }
          },
        });
        handsEnabled = true;
        handPreviewEl.classList.add('show');
        handToggleEl.textContent = '🖐️ Gestures: on';
        handToggleEl.classList.add('on');
      } catch {
        handToggleEl.textContent = '🖐️ Gestures: off (unavailable)';
      }
      // The camera permission dialog can drop the page out of fullscreen/landscape on mobile
      // browsers, whether or not permission was granted — re-apply it either way.
      await enterImmersiveMode();
    } else {
      window.CosmosHands.stop();
      handsEnabled = false;
      handCursor = null;
      handLandmarks = [];
      handPreviewEl.classList.remove('show');
      handToggleEl.textContent = '🖐️ Gestures: off';
      handToggleEl.classList.remove('on');
    }
  });

  // ---- VR HUD feel: auto-fades out after a period of inactivity, brightens instantly on approach/interaction ----
  const hudEl = document.getElementById('hud');
  const hintEl = document.getElementById('hint');
  let idleTimer = null;
  function wake() {
    hudEl.classList.remove('idle');
    hintEl.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      hudEl.classList.add('idle');
      hintEl.classList.add('idle');
    }, 3200);
  }
  ['mousemove', 'mousedown', 'wheel', 'keydown'].forEach((evt) =>
    window.addEventListener(evt, wake, { passive: true })
  );
  wake();
})();
