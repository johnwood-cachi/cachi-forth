(function(){
  if (typeof THREE === 'undefined') {
    console.warn('THREE not found; trace3d will not initialize.');
    return;
  }

  // shared state for the widget
  let container, renderer, scene, camera, sphere;
  let pointsGroup;
  const traceIndexToObject = new Map();
  let sharedPointGeometry = null;
  // New: per-instruction map and positions
  const instructionIndexToObject = new Map();
  let instructionIndexToPosition = [];
  
  // Target highlight state
  const instructionIndexToHighlightTime = new Map(); // seconds since last hit (0..duration)
  const TARGET_HIGHLIGHT_DURATION = 1.0; // seconds
  const TARGET_HIGHLIGHT_COLOR = new THREE.Color(0xff8800); // bright orange
  // Add: lights for highlighted targets
  const instructionIndexToHighlightLight = new Map();
  const TARGET_LIGHT_MAX_INTENSITY = 2.4;
  const TARGET_LIGHT_DISTANCE = 1.5;
  const TARGET_LIGHT_DECAY = 2.0;

  // Snake animation state (multi-thread)
  let snakeGroup = null;
  const snakesByTid = new Map();
  let globalTrace = [];
  let globalTraceIndex = 0;
  let lastActiveTid = null;
  const SNAKE_MIN_TRAIL_PX = 50;
  const SNAKE_PX_PER_STACK = 5;
  const SNAKE_SPEED_UNITS_PER_SEC = 3.6; // movement speed in world units (3x faster)

  const SNAKE_LIGHT_MAX_INTENSITY = 5.0;
  const SNAKE_LIGHT_DECAY_SECONDS = 2.0;

  // Parallel animation scheduling
  let eventAccumulator = 0;
  const EVENTS_PER_SECOND = 60;

  function initTrace3D() {
    container = document.getElementById('trace3d');
    if (!container) return;

    // Create renderer
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(container.clientWidth, container.clientHeight, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    container.appendChild(renderer.domElement);

    // Scene and camera
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(
      45,
      Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
      0.1,
      100
    );
    camera.position.set(0, 0, 3);

    // Lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.01));
    const dir = new THREE.DirectionalLight(0xffffff, 0.3);
    dir.position.set(5, 8, 6);
    scene.add(dir);

    // Translucent sphere
    const geom = new THREE.SphereGeometry(1, 48, 32);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x06164d,
      transparent: true,
      opacity: 0.08,
      metalness: 0.2,
      roughness: 0.35,
      depthWrite: false,
      side: THREE.BackSide
    });
    sphere = new THREE.Mesh(geom, mat);
    scene.add(sphere);

    // Lit wireframe that responds to interior lights
    const wireMesh = new THREE.Mesh(
      geom,
      new THREE.MeshStandardMaterial({
        color: 0x88ccff,
        transparent: true,
        opacity: 0.25,
        metalness: 0.6,
        roughness: 0.2,
        wireframe: true,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    );
    sphere.add(wireMesh);

    // Points container (tethered to sphere so it rotates together)
    pointsGroup = new THREE.Group();
    sphere.add(pointsGroup);

    // Snake container
    snakeGroup = new THREE.Group();
    sphere.add(snakeGroup);

    // Animation loop
    let animId = 0;
    let prevTimeMs = performance.now();
    function animate() {
      animId = requestAnimationFrame(animate);
      const now = performance.now();
      const dt = Math.max(0, (now - prevTimeMs) / 1000);
      prevTimeMs = now;
      sphere.rotation.y += 0.01;
      sphere.rotation.x += 0.005;
      updateSnakes(dt);
      renderer.render(scene, camera);
    }

    // Resizing
    function resize() {
      const w = Math.max(1, container.clientWidth);
      const h = Math.max(1, container.clientHeight);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }

    const ro = new ResizeObserver(resize);
    ro.observe(container);

    // Start
    resize();
    animate();

    // Cleanup on unload
    window.addEventListener('beforeunload', () => {
      cancelAnimationFrame(animId);
      ro.disconnect();
      renderer.dispose();
      geom.dispose();
      mat.dispose();
    });
  }

  // Generate a random unit vector and radius with uniform volume distribution
  function randomPointInUnitSphere() {
    // Uniform on sphere surface
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const z = 2 * v - 1; // in [-1,1]
    const rXY = Math.sqrt(Math.max(0, 1 - z * z));
    const x = rXY * Math.cos(theta);
    const y = rXY * Math.sin(theta);
    // Uniform radius in volume
    const r = Math.cbrt(Math.random());
    return new THREE.Vector3(x * r, y * r, z * r);
  }

  // Semi-random layout that progressively spreads points throughout the sphere interior
  function layoutPoints(count) {
    const positions = [];
    // Adjust candidate count to keep cost reasonable for large N
    const candidatesPerPoint = count > 1000 ? 3 : count > 300 ? 5 : 10;

    for (let i = 0; i < count; i++) {
      let bestVec = null;
      let bestScore = -Infinity;
      for (let c = 0; c < candidatesPerPoint; c++) {
        const candidate = randomPointInUnitSphere();
        // score = distance to nearest existing point (maximize to spread)
        let minDist = Infinity;
        for (let j = 0; j < positions.length; j++) {
          const d = candidate.distanceTo(positions[j]);
          if (d < minDist) minDist = d;
          if (minDist === 0) break;
        }
        const score = positions.length === 0 ? 1 : minDist;
        if (score > bestScore) {
          bestScore = score;
          bestVec = candidate;
        }
      }
      positions.push(bestVec || randomPointInUnitSphere());
    }

    return positions;
  }

  function clearPoints() {
    if (!pointsGroup) return;
    for (let i = pointsGroup.children.length - 1; i >= 0; i--) {
      const child = pointsGroup.children[i];
      pointsGroup.remove(child);
      if (child.material) child.material.dispose?.();
      // sharedPointGeometry is reused
    }
    traceIndexToObject.clear();
    instructionIndexToObject.clear();
    instructionIndexToPosition = [];
    clearSnakes();
    instructionIndexToHighlightTime.clear();
    // Remove any lingering highlight lights
    instructionIndexToHighlightLight.forEach((light) => {
      light.parent?.remove(light);
    });
    instructionIndexToHighlightLight.clear();
  }

  function clearSnakes() {
    if (!snakeGroup) return;
    for (let i = snakeGroup.children.length - 1; i >= 0; i--) {
      const child = snakeGroup.children[i];
      snakeGroup.remove(child);
      if (child.material) child.material.dispose?.();
      if (child.geometry) child.geometry.dispose?.();
    }
    snakesByTid.clear();
    globalTrace = [];
    globalTraceIndex = 0;
    lastActiveTid = null;
  }

  function getProgramTokens() {
    const ta = document.getElementById('program');
    if (!ta) return [];
    const txt = (ta.value || '').trim();
    if (!txt) return [];
    // Split identical to interpreter
    return txt.split(/\s+/).filter(Boolean);
  }

  function setup(executionTrace) {
    if (!scene || !pointsGroup) return;

    clearPoints();

    // Build points per PROGRAM token (instruction index)
    const tokens = getProgramTokens();
    const count = tokens.length | 0;
    if (count <= 0) return;

    // Create shared geometry for tiny spheres
    if (!sharedPointGeometry) sharedPointGeometry = new THREE.SphereGeometry(0.02, 8, 6);

    // Pre-compute positions
    const positions = layoutPoints(count);
    instructionIndexToPosition = positions.map(p => p.clone());

    // Neutral material color for program points
    for (let i = 0; i < count; i++) {
      const pos = positions[i];
      const color = new THREE.Color(0x66ccff);
      const mat = new THREE.MeshStandardMaterial({ color, emissive: color.clone().multiplyScalar(0.25) });
      // Store base visual parameters for highlight blending
      mat.userData.baseColor = color.clone();
      mat.userData.baseEmissiveMin = 0.07;
      const m = new THREE.Mesh(sharedPointGeometry, mat);
      m.position.copy(pos);
      pointsGroup.add(m);
      instructionIndexToObject.set(i, m);
    }

    // Start snake animation over the provided execution trace
    startSnakeAnimation(Array.isArray(executionTrace) ? executionTrace.slice() : []);
  }

  function worldUnitsPerPixelAtDepth(depth) {
    // depth in world units along view; approximate with camera distance to origin
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const viewHeightAtDepth = 2 * Math.tan(vFov / 2) * Math.max(0.0001, depth);
    const pixels = Math.max(1, container?.clientHeight || renderer.domElement.height || 1);
    return viewHeightAtDepth / pixels;
  }

  function getApproxDepthForTrail() {
    // Camera looks at origin; use distance to origin as depth approximation
    return camera.position.length();
  }

  function createSnake(tid, startPos, cloneFromSnake = null) {
    const group = new THREE.Group();
    snakeGroup.add(group);

    const headGeom = new THREE.SphereGeometry(0.03, 12, 8);
    const headMat = new THREE.MeshStandardMaterial({ color: 0xffee88, emissive: 0xffcc33, emissiveIntensity: 1.0 });
    const head = new THREE.Mesh(headGeom, headMat);
    head.position.copy(startPos);
    group.add(head);

    const pointLight = new THREE.PointLight(0xffcc88, 0.0, 3.0, 2.0);
    pointLight.castShadow = false;
    group.add(pointLight);

    let initialPath = [startPos.clone()];
    if (cloneFromSnake && Array.isArray(cloneFromSnake.pathPositions) && cloneFromSnake.pathPositions.length) {
      initialPath = cloneFromSnake.pathPositions.map(p => p.clone());
      const last = initialPath[initialPath.length - 1];
      if (!last || last.distanceToSquared(startPos) > 1e-6) initialPath.push(startPos.clone());
    }

    const snake = {
      tid,
      group,
      head,
      pointLight,
      trailSprites: [],
      pathPositions: initialPath,
      targetTrailPixels: SNAKE_MIN_TRAIL_PX,
      lightTimeSincePeak: Infinity,
      targetPos: startPos.clone(),
      pendingTargets: [],
      currentEvent: null
    };
    snakesByTid.set(tid, snake);
    return snake;
  }

  function getOrCreateSnake(tid, spawnPos, cloneFromSnake = null) {
    let s = snakesByTid.get(tid);
    if (!s) s = createSnake(tid, spawnPos, cloneFromSnake);
    return s;
  }

  function ensureTrailSpritesForSnake(snake, n) {
    while (snake.trailSprites.length < n) {
      const smat = new THREE.SpriteMaterial({ color: 0x88ddff, opacity: 0.8, transparent: true, depthWrite: false });
      const spr = new THREE.Sprite(smat);
      spr.scale.setScalar(0.06);
      snake.group.add(spr);
      snake.trailSprites.push(spr);
    }
    while (snake.trailSprites.length > n) {
      const spr = snake.trailSprites.pop();
      snake.group.remove(spr);
      spr.material.dispose?.();
    }
  }

  function startSnakeAnimation(trace) {
    clearSnakes();
    if (!Array.isArray(trace) || trace.length === 0) return;

    // Filter to entries that have a valid instruction index
    globalTrace = trace.filter(e => Number.isInteger(e?.ip) && instructionIndexToPosition[e.ip] != null);
    if (globalTrace.length === 0) return;

    // Reset parallel scheduler state
    globalTraceIndex = 0;
    eventAccumulator = 0;
    lastActiveTid = null;

    // Initialize first snake position if available
    const firstEntry = globalTrace[0];
    if (firstEntry && Number.isInteger(firstEntry.tid)) {
      const startPos = instructionIndexToPosition[firstEntry.ip].clone();
      const s = getOrCreateSnake(firstEntry.tid, startPos, null);
      lastActiveTid = firstEntry.tid;
      s.head.position.copy(startPos);
      s.pointLight.position.copy(startPos);
      s.pointLight.intensity = SNAKE_LIGHT_MAX_INTENSITY;
      s.lightTimeSincePeak = 0;
    }

    // Build per-thread pending target queues up-front for parallel movement

  }

  function getStackDepthFromTraceEntry(entry) {
    const s = entry?.stack;
    if (!s) return 0;
    // stack is "a|b|c"; number of items equals segments count
    return s.length ? s.split('|').filter(x => x.length || x === '').length : 0;
  }

  function updateSnakes(dt) {
    if (globalTrace.length === 0) return;

    // Compute target trail length in world units from pixels
    const depth = getApproxDepthForTrail();
    const wupp = worldUnitsPerPixelAtDepth(depth);
    const targetTrailWorldLen = Math.max(0.01, SNAKE_MIN_TRAIL_PX * wupp);

    // Inject new events from the global trace into per-thread queues at a steady cadence
    eventAccumulator += Math.max(0, dt);
    const injectEvery = 1 / Math.max(1, EVENTS_PER_SECOND);
    while (eventAccumulator >= injectEvery && globalTraceIndex < globalTrace.length) {
      eventAccumulator -= injectEvery;
      const currentEntry = globalTrace[globalTraceIndex++];
      const tid = currentEntry?.tid;
      const ip = currentEntry?.ip;
      if (!Number.isInteger(tid) || !Number.isInteger(ip)) continue;

      // Ensure snake exists and spawn at last active snake position for continuity
      const lastSnake = lastActiveTid != null ? snakesByTid.get(lastActiveTid) : null;
      const forkPos = lastSnake ? lastSnake.head.position.clone() : instructionIndexToPosition[ip].clone();
      const snake = getOrCreateSnake(tid, forkPos, lastSnake || null);
      lastActiveTid = tid;

      const depthPx = Math.max(SNAKE_MIN_TRAIL_PX, getStackDepthFromTraceEntry(currentEntry) * SNAKE_PX_PER_STACK);
      snake.pendingTargets.push({ ip, targetTrailPx: depthPx });
    }

    // Move all snakes independently toward their per-thread targets at fixed speed
    snakesByTid.forEach((snake) => {
      if (!snake.head) return;

      let remainingMove = Math.max(0, dt) * SNAKE_SPEED_UNITS_PER_SEC;

      while (remainingMove > 0.00001) {
        if (!snake.currentEvent) {
          if (snake.pendingTargets.length === 0) break;
          snake.currentEvent = snake.pendingTargets.shift();
          const pos = instructionIndexToPosition[snake.currentEvent.ip];
          if (!pos) { snake.currentEvent = null; break; }
          snake.targetPos.copy(pos);
        }

        const toTarget = new THREE.Vector3().copy(snake.targetPos).sub(snake.head.position);
        const dist = toTarget.length();
        if (dist <= remainingMove) {
          // Arrive at target
          snake.head.position.copy(snake.targetPos);
          pushPathPointForSnake(snake, snake.head.position);
          // Light and highlight
          snake.pointLight.intensity = SNAKE_LIGHT_MAX_INTENSITY;
          snake.lightTimeSincePeak = 0;
          triggerTargetHighlight(snake.currentEvent.ip);
          // Update trail target based on event's recorded stack depth
          snake.targetTrailPixels = snake.currentEvent.targetTrailPx;
          remainingMove -= dist;
          snake.currentEvent = null;
          // loop to consider next pending event within remainingMove
        } else {
          // Partial move toward current target
          const step = toTarget.normalize().multiplyScalar(remainingMove);
          snake.head.position.add(step);
          pushPathPointForSnake(snake, snake.head.position);
          remainingMove = 0;
        }
      }

      // Trim path to requested length for each snake
      trimPathByLengthForSnake(snake, Math.max(0.01, snake.targetTrailPixels * wupp));

      // Update light position and decay
      snake.pointLight.position.copy(snake.head.position);
      if (isFinite(snake.lightTimeSincePeak)) {
        snake.lightTimeSincePeak += Math.max(0, dt);
        const t = Math.min(1, snake.lightTimeSincePeak / Math.max(1e-6, SNAKE_LIGHT_DECAY_SECONDS));
        const factor = 1 - t;
        snake.pointLight.intensity = SNAKE_LIGHT_MAX_INTENSITY * factor;
      }
      if (snake.head.material) {
        const currentIntensity = snake.pointLight.intensity;
        const headFactor = Math.max(0, Math.min(1, currentIntensity / Math.max(1e-6, SNAKE_LIGHT_MAX_INTENSITY)));
        snake.head.material.emissiveIntensity = 0.2 + 0.8 * headFactor;
      }

      // Trail sprites
      updateTrailSpritesForSnake(snake, Math.max(0.01, snake.targetTrailPixels * wupp));
    });

    // Update target highlight fades
    updateTargetHighlights(dt);
  }

  function pushPathPointForSnake(snake, vec) {
    const last = snake.pathPositions[snake.pathPositions.length - 1];
    if (!last || last.distanceToSquared(vec) > 1e-6) {
      snake.pathPositions.push(vec.clone());
    }
  }

  function trimPathByLengthForSnake(snake, maxLen) {
    if (snake.pathPositions.length <= 1) return;
    let cumulative = 0;
    for (let i = snake.pathPositions.length - 1; i > 0; i--) {
      const a = snake.pathPositions[i];
      const b = snake.pathPositions[i - 1];
      const d = a.distanceTo(b);
      cumulative += d;
      if (cumulative >= maxLen) {
        const excess = cumulative - maxLen;
        if (d > 1e-6) {
          const t = Math.max(0, Math.min(1, (d - excess) / d));
          b.lerpVectors(b, a, t);
          snake.pathPositions.splice(0, i - 1);
        } else {
          snake.pathPositions.splice(0, i - 1);
        }
        return;
      }
    }
    const MAX_POINTS = 1000;
    if (snake.pathPositions.length > MAX_POINTS) {
      const drop = snake.pathPositions.length - MAX_POINTS;
      snake.pathPositions.splice(0, drop);
    }
  }

  function samplePointAtArcLengthFromHeadForSnake(snake, s) {
    if (snake.pathPositions.length === 0) return null;
    if (s <= 0) return snake.pathPositions[snake.pathPositions.length - 1].clone();
    let remaining = s;
    for (let i = snake.pathPositions.length - 1; i > 0; i--) {
      const a = snake.pathPositions[i];
      const b = snake.pathPositions[i - 1];
      const d = a.distanceTo(b);
      if (remaining <= d) {
        const t = Math.max(0, Math.min(1, 1 - remaining / Math.max(1e-6, d)));
        return new THREE.Vector3().lerpVectors(b, a, t);
      }
      remaining -= d;
    }
    return snake.pathPositions[0].clone();
  }

  function updateTrailSpritesForSnake(snake, targetLen) {
    const N = 40;
    ensureTrailSpritesForSnake(snake, N);
    for (let i = 0; i < N; i++) {
      const frac = i / (N - 1);
      const s = frac * targetLen;
      const p = samplePointAtArcLengthFromHeadForSnake(snake, s);
      const spr = snake.trailSprites[i];
      if (p && spr) {
        spr.position.copy(p);
        const alpha = Math.max(0, 1 - frac);
        spr.material.opacity = 0.85 * Math.pow(alpha, 1.5);
      }
    }
  }

  function triggerTargetHighlight(instructionIndex) {
    if (!Number.isInteger(instructionIndex)) return;
    instructionIndexToHighlightTime.set(instructionIndex, 0);
    // Create or refresh a point light at this instruction while it is highlighted
    const pos = instructionIndexToPosition[instructionIndex];
    if (!pos || !pointsGroup) return;
    let light = instructionIndexToHighlightLight.get(instructionIndex);
    if (!light) {
      light = new THREE.PointLight(TARGET_HIGHLIGHT_COLOR, TARGET_LIGHT_MAX_INTENSITY, TARGET_LIGHT_DISTANCE, TARGET_LIGHT_DECAY);
      light.castShadow = false;
      light.position.copy(pos);
      pointsGroup.add(light);
      instructionIndexToHighlightLight.set(instructionIndex, light);
    } else {
      light.intensity = TARGET_LIGHT_MAX_INTENSITY;
      light.position.copy(pos);
    }
  }

  function updateTargetHighlights(dt) {
    if (instructionIndexToHighlightTime.size === 0) return;
    const toDelete = [];
    instructionIndexToHighlightTime.forEach((elapsed, idx) => {
      const mesh = instructionIndexToObject.get(idx);
      if (!mesh || !mesh.material) {
        toDelete.push(idx);
        const lightOrphan = instructionIndexToHighlightLight.get(idx);
        if (lightOrphan) {
          lightOrphan.parent?.remove(lightOrphan);
          instructionIndexToHighlightLight.delete(idx);
        }
        return;
      }
      const mat = mesh.material;
      const baseColor = mat.userData?.baseColor || new THREE.Color(0x66ccff);
      const baseEmissiveMin = mat.userData?.baseEmissiveMin ?? 0.15;
      const newElapsed = elapsed + Math.max(0, dt);
      const t = Math.min(1, newElapsed / Math.max(1e-6, TARGET_HIGHLIGHT_DURATION));
      const f = 1 - t; // 1 at hit, 0 at end
      // Color fades from highlight to base
      mat.color.copy(baseColor).lerp(TARGET_HIGHLIGHT_COLOR, f);
      // Emissive brightness and hue fade from highlight to base
      const emissiveFactor = baseEmissiveMin + (1.0 - baseEmissiveMin) * f;
      mat.emissive.copy(baseColor).lerp(TARGET_HIGHLIGHT_COLOR, f).multiplyScalar(emissiveFactor);

      // Update accompanying light intensity and position while highlighted
      const light = instructionIndexToHighlightLight.get(idx);
      if (light) {
        light.position.copy(mesh.position);
        light.intensity = TARGET_LIGHT_MAX_INTENSITY * f;
      }

      if (t >= 1) {
        // Restore base and stop tracking
        mat.color.copy(baseColor);
        mat.emissive.copy(baseColor).multiplyScalar(baseEmissiveMin);
        toDelete.push(idx);
        // Remove and dispose the light
        if (light) {
          light.parent?.remove(light);
          instructionIndexToHighlightLight.delete(idx);
        }
      } else {
        instructionIndexToHighlightTime.set(idx, newElapsed);
      }
    });
    for (const idx of toDelete) instructionIndexToHighlightTime.delete(idx);
  }

  // expose API
  window.Trace3D = {
    setup,
    layoutPoints,
    getObjectForTraceIndex: (idx) => instructionIndexToObject.get(idx) || null,
    getObjectForInstructionIndex: (idx) => instructionIndexToObject.get(idx) || null
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTrace3D, { once: true });
  } else {
    initTrace3D();
  }
})();
