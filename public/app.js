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
  let handCursor = null; // { x, y } 归一化 0..1，来自摄像头手部识别
  let handLandmarks = []; // 每只手 21 个关键点（已镜像，归一化 0..1），画在主画布上

  let audioEnabled = false;
  let avgEntropy = 0;

  // ---- 移动端引导：触屏设备提示横屏 + 全屏 ----
  (function setupMobileGate() {
    const gate = document.getElementById('mobileGate');
    if (!gate) return;
    const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (!isTouch) return;
    gate.classList.add('show');

    const hide = () => gate.classList.remove('show');
    document.getElementById('gateSkip').addEventListener('click', hide);
    document.getElementById('gateEnter').addEventListener('click', async () => {
      const el = document.documentElement;
      try {
        if (el.requestFullscreen) await el.requestFullscreen();
        else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      } catch {
        // 部分浏览器（如 iOS Safari）不支持全屏 API，忽略即可
      }
      try {
        if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape');
      } catch {
        // 部分浏览器不支持锁定横屏，忽略即可
      }
      hide();
    });
  })();

  let nodes = [];
  let edges = [];
  let gitRepo = false;
  let nodeById = new Map();

  // 视图变换：世界坐标 <-> 屏幕坐标（CSS 像素空间，和鼠标事件、canvas 尺寸单位保持一致）
  // rotation：视角旋转角度（弧度），0 = 正常朝向
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
    // 逆旋转（旋转 -rotation）
    const rx = dx * cos + dy * sin;
    const ry = -dx * sin + dy * cos;
    return [rx + view.x, ry + view.y];
  }
  // 把一段"屏幕像素位移"换算成对应的世界坐标位移，用于拖拽平移（考虑旋转）
  function screenDeltaToWorld(ddx, ddy) {
    const cos = Math.cos(view.rotation);
    const sin = Math.sin(view.rotation);
    return [
      (ddx * cos + ddy * sin) / view.scale,
      (-ddx * sin + ddy * cos) / view.scale,
    ];
  }

  // ---- 布局：按目录分成"星云"团簇，簇内力导向 ----
  function initLayout() {
    const dirs = [...new Set(nodes.map((n) => n.dir))];
    const clusterCenters = new Map();
    const R = 260 * Math.max(1, Math.sqrt(dirs.length));
    dirs.forEach((d, i) => {
      const angle = (i / dirs.length) * Math.PI * 2;
      clusterCenters.set(d, { x: Math.cos(angle) * R, y: Math.sin(angle) * R });
    });

    for (const n of nodes) {
      const c = clusterCenters.get(n.dir) || { x: 0, y: 0 };
      const jitter = 120;
      n.x = c.x + (Math.random() - 0.5) * jitter;
      n.y = c.y + (Math.random() - 0.5) * jitter;
      n.vx = 0;
      n.vy = 0;
      n.cx = c.x;
      n.cy = c.y;
      n.fixed = false;
      n.phase = Math.random() * Math.PI * 2;
      // 熵越高（改动越频繁）闪烁越快，越"躁动"
      n.twinkleSpeed = 0.6 + Math.random() * 1.2 + (n.entropy || 0) * 2;
      // 引力质量：文件越大、被依赖越多，越能弯曲周围的时空网格
      n.mass = n.radius + n.degree * 6;
    }
  }

  // 均匀网格，做近似的粒子间斥力（避免 O(n^2)）
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

    // 斥力：只比较同格及相邻格
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
      // 回到自己所在星云的中心
      fx += (n.cx - n.x) * CENTER_PULL;
      fy += (n.cy - n.y) * CENTER_PULL;
      // 熵：改动越频繁的文件，随机的"热运动"越明显
      if (n.entropy) {
        const heat = n.entropy * 2.2;
        fx += (Math.random() - 0.5) * heat;
        fy += (Math.random() - 0.5) * heat;
      }
      n.vx = (n.vx + fx) * DAMPING;
      n.vy = (n.vy + fy) * DAMPING;
    }

    // 弹簧：调用关系拉近
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

  // ---- 渲染：粒子按"光子"来画 ----
  // intensity 0..1：调用越多，颜色越亮/越饱和（粒子性：能量越高越亮）
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
  // 光子核心：往白光混一点，越"重"(调用多)的粒子核心越白热
  function coreColor(hex, intensity) {
    const [r, g, b] = intensityRGB(hex, intensity);
    const w = 0.35 + intensity * 0.35;
    const mix = (c) => Math.round(c * (1 - w) + 255 * w);
    return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
  }

  let selectedId = null;
  let hoveredId = null;

  // 依赖弦上的光子抵达目标粒子时拨一下弦，节流避免密集调用图变得吵闹
  const lastArrivalPluck = new Map();
  function triggerArrivalPluck(node) {
    const now = performance.now();
    const last = lastArrivalPluck.get(node.id) || 0;
    if (now - last < 220) return;
    lastArrivalPluck.set(node.id, now);
    window.CosmosAudio && window.CosmosAudio.pluck(node);
  }

  // ---- 引力阱：背景时空网格，质量大/密集的地方网格会向粒子方向弯曲 ----
  let gravityWells = [];
  let gravityWellsTick = 0;
  function updateGravityWells() {
    // 每 30 帧重选一次"引力源"（质量最大的一批粒子），不用每帧重排序
    if (gravityWellsTick % 30 === 0) {
      gravityWells = [...nodes].sort((a, b) => b.mass - a.mass).slice(0, 40);
    }
    gravityWellsTick++;
  }

  function warpPoint(px, py) {
    let dx = 0, dy = 0;
    for (const w of gravityWells) {
      const ddx = w.x - px;
      const ddy = w.y - py;
      const distSq = ddx * ddx + ddy * ddy + 500;
      const pull = Math.min((w.mass * 1400) / distSq, 60);
      const dist = Math.sqrt(distSq);
      dx += (ddx / dist) * pull;
      dy += (ddy / dist) * pull;
    }
    return [px + dx, py + dy];
  }

  function drawGravityGrid() {
    updateGravityWells();
    if (!gravityWells.length) return;

    // 网格在世界坐标里的间距随缩放调整，保证屏幕上的疏密大致恒定
    const spacing = Math.max(24, 150 / view.scale);
    const segStep = spacing / 6;
    const [wxMin, wyMin] = screenToWorld(-40, -40);
    const [wxMax, wyMax] = screenToWorld(cssW + 40, cssH + 40);
    const startX = Math.floor(wxMin / spacing) * spacing;
    const startY = Math.floor(wyMin / spacing) * spacing;

    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(120,175,255,0.10)';

    for (let x = startX; x <= wxMax; x += spacing) {
      ctx.beginPath();
      let first = true;
      for (let y = startY; y <= wyMax; y += segStep) {
        const [wx, wy] = warpPoint(x, y);
        const [sx, sy] = worldToScreen(wx, wy);
        if (first) { ctx.moveTo(sx, sy); first = false; } else ctx.lineTo(sx, sy);
      }
      ctx.stroke();
    }
    for (let y = startY; y <= wyMax; y += spacing) {
      ctx.beginPath();
      let first = true;
      for (let x = startX; x <= wxMax; x += segStep) {
        const [wx, wy] = warpPoint(x, y);
        const [sx, sy] = worldToScreen(wx, wy);
        if (first) { ctx.moveTo(sx, sy); first = false; } else ctx.lineTo(sx, sy);
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

    // 弦（依赖关系）：线本身 + 沿线传播的光子脉冲（粒子性的一面：能量沿弦传递）
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

        // 光子沿弦"到达"目标粒子时，轻轻拨一下弦（稀疏触发，避免吵）
        if (audioEnabled && e._prevP !== undefined && p < e._prevP) {
          triggerArrivalPluck(tt);
        }
        e._prevP = p;
      }
    }

    // 粒子（文件）：画成"光子" —— 波纹(波动性) + 光晕 + 白热核心(粒子性)
    for (const n of nodes) {
      const [sx, sy] = worldToScreen(n.x, n.y);
      const r = Math.max(n.radius * view.scale, 1.4);
      if (sx < -50 || sy < -50 || sx > cssW + 50 || sy > cssH + 50) continue;

      const rgb = intensityRGB(n.color, n.intensity);
      const rgbStr = rgb.join(',');
      const twinkle = 0.85 + 0.15 * Math.sin(t * n.twinkleSpeed + n.phase);
      const emphasize = n.id === selectedId || n.id === hoveredId;

      if (!dense) {
        // 波动性：向外扩散、逐渐变淡的波前
        for (let i = 0; i < 2; i++) {
          const wave = ((t * 0.5 + n.phase / (Math.PI * 2) + i * 0.5) % 1);
          const waveR = r + wave * r * 3.2;
          const waveAlpha = (1 - wave) * 0.22 * (n.intensity * 0.6 + 0.4);
          if (waveAlpha <= 0.005) continue;
          ctx.beginPath();
          ctx.arc(sx, sy, waveR, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${rgbStr},${waveAlpha.toFixed(3)})`;
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        // 光晕：径向渐变，越亮的粒子晕越大
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

      // 粒子性：白热的核心亮点
      ctx.beginPath();
      ctx.arc(sx, sy, r * twinkle, 0, Math.PI * 2);
      ctx.fillStyle = coreColor(n.color, n.intensity);
      ctx.fill();

      if (n.id === selectedId) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#ffffff';
        ctx.shadowBlur = 0;
        ctx.stroke();
      }
    }
    ctx.shadowBlur = 0;

    // 标签：缩放够大时显示文件名
    if (view.scale > 1.6) {
      ctx.font = '11px sans-serif';
      ctx.fillStyle = 'rgba(230,230,240,0.85)';
      for (const n of nodes) {
        const [sx, sy] = worldToScreen(n.x, n.y);
        const r = n.radius * view.scale;
        if (sx < -50 || sy < -50 || sx > canvas.width / devicePixelRatio + 50) continue;
        ctx.fillText(n.label, sx + r + 3, sy + 3);
      }
    }

    // 手势骨架：把识别到的双手直接叠加画在星图上，像 AR 一样悬浮在画布里
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

    // 手势光标：把摄像头识别到的手直接映射到画布上，给出"手在哪、指哪"的视觉反馈
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

  // ---- 辅助标尺：固定在屏幕空间，跟平移/缩放联动，不受旋转影响（测的是"离屏幕中心多远"） ----
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

  // ---- 圆形罗盘：外圈刻度反向旋转显示当前视角朝向，中心显示缩放%/旋转角度，点击可重置旋转 ----
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

    // 顶部固定小三角：代表当前屏幕朝向的参照点
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

  // 环境声场：每颗粒子本身持续发声，但只挑离屏幕中心最近的一批（有限声部），
  // 节流成每 ~200ms 重算一次，避免每帧都排序全部粒子
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

  // ---- 交互：拖拽平移 / 缩放 / 拖动粒子 / 点击选中 ----
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
      // 按住 Shift 拖拽 = 绕鼠标当前点旋转视角（那个世界点会一直停在鼠标下面）
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

  // ---- 触屏：单指拖拽平移/拖粒子/点选，双指捏合缩放 ----
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
      // 标准双指手势：中点移动=平移，距离变化=缩放，连线角度变化=旋转，三者同时生效
      const [x1, y1] = touchScreenPoint(e.touches[0]);
      const [x2, y2] = touchScreenPoint(e.touches[1]);
      const midX = (x1 + x2) / 2;
      const midY = (y1 + y2) / 2;
      const dist = Math.hypot(x2 - x1, y2 - y1) || 1;
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const [wx, wy] = screenToWorld(midX, midY);
      view.scale = Math.min(20, Math.max(0.05, pinch.startScale * (dist / pinch.startDist)));
      view.rotation = pinch.startRotation + (angle - pinch.startAngle);
      const [nwx, nwy] = screenToWorld(midX, midY);
      view.x += wx - nwx;
      view.y += wy - nwy;
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
      // 双指变单指：重置基准，避免位置跳变
      pinch = null;
      lastMouse = [e.touches[0].clientX, e.touches[0].clientY];
    }
  }, { passive: false });

  // ---- 详情面板 / diff ----
  function escapeHtml(s) {
    return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  function renderDiff(text) {
    if (!text) return '<p class="sub">无未提交改动</p>';
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
    panelMeta.textContent = `${n.id} · ${(n.size / 1024).toFixed(1)} KB · 调用度 ${n.degree}${gitRepo ? ` · 熵 ${n.entropy}（${n.churn} 次提交触碰）` : ''}`;
    panelBody.innerHTML = '<p class="sub">加载中…</p>';
    panel.classList.add('open');

    if (!gitRepo) {
      const res = await fetch('/api/file?file=' + encodeURIComponent(n.id));
      const data = await res.json();
      panelBody.innerHTML = data.content
        ? '<h3>文件内容预览</h3><pre>' + escapeHtml(data.content) + '</pre>'
        : '<p class="sub">无法读取（可能是二进制文件）</p>';
      return;
    }

    const res = await fetch('/api/diff?file=' + encodeURIComponent(n.id));
    const data = await res.json();
    let html = '';
    html += '<h3>未提交改动</h3>' + renderDiff(data.diff);
    html += '<h3>最近提交</h3><pre>' + escapeHtml(data.log || '（无历史）') + '</pre>';
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

  // ---- 初始化：拉取数据 ----
  async function main() {
    const res = await fetch('/api/graph');
    const data = await res.json();
    nodes = data.nodes;
    edges = data.edges;
    gitRepo = data.gitRepo;
    nodeById = new Map(nodes.map((n) => [n.id, n]));

    rootLabel.textContent = `${nodes.length} 个粒子 · ${edges.length} 条弦${gitRepo ? ' · git 已连接' : ''}`;
    statsEl.textContent = `最大调用度: ${data.maxDegree}`;

    const seen = new Map();
    for (const n of nodes) if (!seen.has(n.ext)) seen.set(n.ext, n.color);
    legendEl.innerHTML = [...seen.entries()]
      .sort()
      .map(([ext, color]) => `<span class="legend-item"><span class="dot" style="background:${color}"></span>${ext || '(无扩展名)'}</span>`)
      .join('');

    avgEntropy = nodes.length ? nodes.reduce((s, n) => s + (n.entropy || 0), 0) / nodes.length : 0;

    initLayout();
    loop();
  }

  main().catch((err) => {
    rootLabel.textContent = '加载失败: ' + err.message;
  });

  // ---- 音乐：默认关闭，点击才申请音频权限（浏览器策略要求用户手势） ----
  soundToggleEl.addEventListener('click', async () => {
    if (!audioEnabled) {
      soundToggleEl.textContent = '…启动音频';
      try {
        await window.CosmosAudio.init();
        audioEnabled = true;
        window.CosmosAudio.setEnabled(true);
        window.CosmosAudio.updateEntropy(avgEntropy);
        soundToggleEl.textContent = '🔊 音乐: 开';
        soundToggleEl.classList.add('on');
      } catch {
        soundToggleEl.textContent = '🔈 音乐: 关（不可用）';
      }
    } else {
      audioEnabled = false;
      window.CosmosAudio.setEnabled(false);
      soundToggleEl.textContent = '🔈 音乐: 关';
      soundToggleEl.classList.remove('on');
    }
  });

  // ---- 手势：摄像头识别双手，映射到画布 ----
  // 单手握拳=抓住画布后移动=平移，张开手指=松手停止；
  // 双手同时握拳=抓住画布，开合=缩放/连线角度变化=旋转/双手一起移动=平移，三者同时生效，松开任一只手=停止；
  // 拇指食指捏合=选中该处最近的粒子。
  let twoHandGrabStart = null; // { dist, angle, scale, rotation }，双手抓取手势开始时的基准状态
  let lastPinchId = null; // 上一次捏合命中的粒子 id，用于判定"双击"
  let lastPinchTime = 0;
  const DOUBLE_PINCH_WINDOW = 450; // 两次捏合间隔小于这个值(ms)才算双击
  handToggleEl.addEventListener('click', async () => {
    if (!handsEnabled) {
      handToggleEl.textContent = '…启动摄像头';
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
            if (phase === 'start') {
              twoHandGrabStart = { dist: d, angle, scale: view.scale, rotation: view.rotation };
              return;
            }
            if (!twoHandGrabStart) return;
            const sx = midXNorm * cssW;
            const sy = midYNorm * cssH;
            const [wx, wy] = screenToWorld(sx, sy);
            view.scale = Math.min(20, Math.max(0.05, twoHandGrabStart.scale * (d / twoHandGrabStart.dist)));
            view.rotation = twoHandGrabStart.rotation + (angle - twoHandGrabStart.angle);
            const [nwx, nwy] = screenToWorld(sx, sy);
            view.x += wx - nwx;
            view.y += wy - nwy;
          },
          onGrabState: (state) => {
            canvas.classList.toggle('dragging', state !== 'idle');
            if (state === 'idle') twoHandGrabStart = null;
          },
          onPinch: (xNorm, yNorm) => {
            // 单次捏合太容易误触，先只轻量高亮；短时间内对同一个粒子再捏一次（双击）才真正打开详情面板
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
        handToggleEl.textContent = '🖐️ 手势: 开';
        handToggleEl.classList.add('on');
      } catch {
        handToggleEl.textContent = '🖐️ 手势: 关（不可用）';
      }
    } else {
      window.CosmosHands.stop();
      handsEnabled = false;
      handCursor = null;
      handLandmarks = [];
      handPreviewEl.classList.remove('show');
      handToggleEl.textContent = '🖐️ 手势: 关';
      handToggleEl.classList.remove('on');
    }
  });

  // ---- VR HUD 观感：无操作一段时间后自动淡出，靠近/操作时立刻亮起 ----
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
