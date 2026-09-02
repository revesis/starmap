(() => {
  'use strict';

  // Uses MediaPipe Hands (pure browser-side WASM, no video is uploaded) to track both hands' key
  // points and maps them to:
  // one-hand fist (grab) then move = pan; opening the fingers = release and stop;
  // both hands fisted then spreading/rotating/moving = zoom + rotate + pan all at once
  // (releasing either hand = stop);
  // thumb-index pinch = select the nearest particle at that point.
  const HAND_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20],
    [0, 17],
  ];
  const PINCH_THRESHOLD = 0.055;
  const FIST_TIP_INDICES = [8, 12, 16, 20]; // index/middle/ring/pinky fingertips
  const FIST_RATIO = 1.3; // fist = fingertip-to-wrist distance < palm size * this ratio

  let hands = null;
  let stream = null;
  let video = null;
  let overlay = null;
  let overlayCtx = null;
  let running = false;
  let rafId = null;
  let callbacks = {};
  let pinchState = [false, false];
  let onePanPrev = null; // last frame's palm position during a one-hand grab (mirrored, 0..1)
  let twoGrabActive = false; // whether we're currently in a "both hands fisted" gesture
  let grabState = 'idle'; // 'idle' | 'pan' | 'zoom', only used to report state outward

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  // Approximate the palm center as the midpoint of the wrist (0) and middle-finger MCP (9);
  // x is mirrored to match the intuition "hand moves right = view moves right"
  function palmCenter(landmarks) {
    const w = landmarks[0];
    const m = landmarks[9];
    return { x: 1 - (w.x + m.x) / 2, y: (w.y + m.y) / 2 };
  }

  function isPinching(landmarks) {
    return dist(landmarks[4], landmarks[8]) < PINCH_THRESHOLD;
  }

  // Detect a fist by whether the fingertips have curled back near the wrist, normalized by
  // palm size (wrist to middle-finger MCP) so the same threshold works regardless of how far
  // the hand is from the camera
  function isFist(landmarks) {
    const size = dist(landmarks[0], landmarks[9]) || 0.0001;
    let curled = 0;
    for (const tip of FIST_TIP_INDICES) {
      if (dist(landmarks[tip], landmarks[0]) < size * FIST_RATIO) curled++;
    }
    return curled >= 3;
  }

  function setGrabState(next) {
    if (grabState === next) return;
    grabState = next;
    callbacks.onGrabState && callbacks.onGrabState(next);
  }

  // The small preview widget only shows the raw mirrored camera feed, so you can confirm the
  // camera/lighting is working; the skeleton itself is drawn on the main canvas instead
  function drawCameraPreview() {
    if (!overlayCtx) return;
    const w = overlay.width;
    const h = overlay.height;
    overlayCtx.clearRect(0, 0, w, h);
    if (video && video.readyState >= 2) {
      overlayCtx.drawImage(video, w, 0, -w, h); // negative width = draw horizontally mirrored
    }
  }

  function onResults(results) {
    drawCameraPreview();
    const list = results.multiHandLandmarks || [];

    const mirroredHands = list.map((landmarks) => landmarks.map((p) => ({ x: 1 - p.x, y: p.y })));
    callbacks.onLandmarks && callbacks.onLandmarks(mirroredHands);

    // The reticle only appears while pinching: when the hand is just moving around (especially
    // during a fist pan/zoom), there's no need for a point to keep jittering around; only show
    // it when you're actually about to select something (a pinch) — cleaner, less "shaky"
    if (list.length >= 1 && isPinching(list[0])) {
      const tip = list[0][8];
      callbacks.onCursor && callbacks.onCursor(1 - tip.x, tip.y);
    } else {
      callbacks.onCursor && callbacks.onCursor(null, null);
    }

    if (list.length === 1) {
      twoGrabActive = false;
      if (isFist(list[0])) {
        const palm = palmCenter(list[0]);
        if (onePanPrev) {
          const dx = palm.x - onePanPrev.x;
          const dy = palm.y - onePanPrev.y;
          if (Math.abs(dx) > 0.0005 || Math.abs(dy) > 0.0005) {
            callbacks.onOneHandPan && callbacks.onOneHandPan(dx, dy);
          }
        } else {
          setGrabState('pan');
        }
        onePanPrev = palm;
      } else {
        onePanPrev = null;
        if (grabState === 'pan') setGrabState('idle');
      }
    } else if (list.length >= 2) {
      onePanPrev = null;
      if (isFist(list[0]) && isFist(list[1])) {
        const p0 = palmCenter(list[0]);
        const p1 = palmCenter(list[1]);
        const d = dist(p0, p1) || 0.0001;
        const angle = Math.atan2(p1.y - p0.y, p1.x - p0.x);
        const midX = (p0.x + p1.x) / 2;
        const midY = (p0.y + p1.y) / 2;
        if (!twoGrabActive) {
          twoGrabActive = true;
          setGrabState('zoom');
          callbacks.onTwoHandTransform && callbacks.onTwoHandTransform(d, angle, midX, midY, 'start');
        } else {
          callbacks.onTwoHandTransform && callbacks.onTwoHandTransform(d, angle, midX, midY, 'move');
        }
      } else {
        if (twoGrabActive) setGrabState('idle');
        twoGrabActive = false;
      }
    } else {
      onePanPrev = null;
      if (twoGrabActive) setGrabState('idle');
      twoGrabActive = false;
    }

    list.forEach((landmarks, i) => {
      const pinch = isPinching(landmarks);
      if (pinch && !pinchState[i]) {
        const idx = landmarks[8];
        callbacks.onPinch && callbacks.onPinch(1 - idx.x, idx.y);
      }
      pinchState[i] = pinch;
    });
  }

  function isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && typeof Hands !== 'undefined';
  }

  async function start(opts) {
    if (running) return;
    if (!isSupported()) throw new Error('camera or MediaPipe Hands not available');
    callbacks = opts || {};

    video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;

    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, facingMode: 'user' } });
    video.srcObject = stream;
    await video.play();

    overlay = opts.overlayCanvas;
    overlayCtx = overlay ? overlay.getContext('2d') : null;

    hands = new Hands({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}` });
    hands.setOptions({
      maxNumHands: 2,
      modelComplexity: 0,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.5,
    });
    hands.onResults(onResults);

    running = true;
    const loop = async () => {
      if (!running) return;
      try {
        await hands.send({ image: video });
      } catch {
        // ignore a single failed detection frame and move on
      }
      rafId = requestAnimationFrame(loop);
    };
    loop();
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    if (hands) { try { hands.close(); } catch { /* ignore close errors */ } }
    hands = null;
    onePanPrev = null;
    twoGrabActive = false;
    grabState = 'idle';
    pinchState = [false, false];
    if (overlayCtx && overlay) overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  }

  window.CosmosHands = { start, stop, isSupported, HAND_CONNECTIONS };
})();
