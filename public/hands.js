(() => {
  'use strict';

  // 用 MediaPipe Hands（纯浏览器端 WASM，不上传画面）识别双手关键点，映射成：
  // 单手握拳(抓取)后移动=平移，张开手指=松手停止；
  // 双手同时握拳后开合/旋转/移动=缩放+旋转+平移三合一（松开任一只手=停止）；
  // 拇指食指捏合=选中该处最近的粒子。
  const HAND_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20],
    [0, 17],
  ];
  const PINCH_THRESHOLD = 0.055;
  const FIST_TIP_INDICES = [8, 12, 16, 20]; // 食指/中指/无名指/小指指尖
  const FIST_RATIO = 1.3; // 指尖到手腕的距离 < 手掌尺寸 * 这个比例，判定为握拳

  let hands = null;
  let stream = null;
  let video = null;
  let overlay = null;
  let overlayCtx = null;
  let running = false;
  let rafId = null;
  let callbacks = {};
  let pinchState = [false, false];
  let onePanPrev = null; // 单手抓取时，上一帧的掌心位置（已镜像，0..1）
  let twoGrabActive = false; // 是否处于"双手同时握拳"手势中
  let grabState = 'idle'; // 'idle' | 'pan' | 'zoom'，仅用于对外汇报状态

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  // 用手腕(0)和中指根部(9)的中点近似掌心；x 取镜像，符合"手往右移=画面往右"的直觉
  function palmCenter(landmarks) {
    const w = landmarks[0];
    const m = landmarks[9];
    return { x: 1 - (w.x + m.x) / 2, y: (w.y + m.y) / 2 };
  }

  function isPinching(landmarks) {
    return dist(landmarks[4], landmarks[8]) < PINCH_THRESHOLD;
  }

  // 用"指尖是否缩回到手腕附近"判定握拳，用手掌尺寸(手腕到中指根部)做尺度归一，
  // 这样手离摄像头远近不同也能用同一个阈值
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

  // 小窗只保留原始镜像画面，用来确认摄像头/光线是否正常；骨架改到主画布上画
  function drawCameraPreview() {
    if (!overlayCtx) return;
    const w = overlay.width;
    const h = overlay.height;
    overlayCtx.clearRect(0, 0, w, h);
    if (video && video.readyState >= 2) {
      overlayCtx.drawImage(video, w, 0, -w, h); // 负宽度=水平镜像绘制
    }
  }

  function onResults(results) {
    drawCameraPreview();
    const list = results.multiHandLandmarks || [];

    const mirroredHands = list.map((landmarks) => landmarks.map((p) => ({ x: 1 - p.x, y: p.y })));
    callbacks.onLandmarks && callbacks.onLandmarks(mirroredHands);

    // 准星只在捏合时出现：平时手在动（尤其是握拳平移/缩放时）不需要一直跟着一个点晃，
    // 只有真的要选中东西（捏合）才把它显出来，视觉上更干净、不容易觉得"抖"
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
        // 单帧识别失败忽略，继续下一帧
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
    if (hands) { try { hands.close(); } catch { /* 忽略关闭异常 */ } }
    hands = null;
    onePanPrev = null;
    twoGrabActive = false;
    grabState = 'idle';
    pinchState = [false, false];
    if (overlayCtx && overlay) overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  }

  window.CosmosHands = { start, stop, isSupported, HAND_CONNECTIONS };
})();
