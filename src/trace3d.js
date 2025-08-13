(function(){
  if (typeof THREE === 'undefined') {
    console.warn('THREE not found; trace3d will not initialize.');
    return;
  }

  // shared state for the widget
  let container, renderer, scene, camera, sphere, backdropPlane;
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
  const SNAKE_MAX_TRAIL_PX = 250;
  const SNAKE_PX_PER_STACK = 5;
  const SNAKE_SPEED_UNITS_PER_SEC = 3.6; // movement speed in world units (3x faster)

  const SNAKE_LIGHT_MAX_INTENSITY = 5.0;
  const SNAKE_LIGHT_DECAY_SECONDS = 2.0;

  // Maximum allowed thread id; entries with larger TID are ignored for performance
  const MAX_TID = 20;

  // Lightning tail parameters
  const LIGHTNING_BASE_AMPLITUDE = 0.035; // world units
  const LIGHTNING_STEP_LENGTH = 0.06;     // approx spacing of jitter points per segment
  const LIGHTNING_MAX_SUBDIVISIONS = 5;
  const LIGHTNING_COLORS = [0x99ddff, 0x66aaff];
  const LIGHTNING_OPACITIES = [0.9, 0.6];

  // Parallel animation scheduling
  let eventAccumulator = 0;
  const EVENTS_PER_SECOND = 60;
  // Track remaining, unprocessed events per thread to know when a snake is truly finished
  const remainingEventsByTid = new Map();

  function isAnimationActive() {
    // Active if there are pending global events to inject or any snakes alive
    return (globalTraceIndex < globalTrace.length) || (snakesByTid.size > 0);
  }

  function initTrace3D() {
    container = document.getElementById('trace3d');
    if (!container) return;

    // Create renderer
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(container.clientWidth, container.clientHeight, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.touchAction = 'none';
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

    // Backdrop plane behind the sphere to catch light
    const BACKDROP_Z = -1.1;
    backdropPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({
        color: 0x000000,
        metalness: 0.0,
        roughness: 0.15
      })
    );
    backdropPlane.position.set(0, 0, BACKDROP_Z);
    backdropPlane.frustumCulled = false;
    scene.add(backdropPlane);

    function updateBackdropPlaneSize() {
      if (!backdropPlane || !camera) return;
      const distance = Math.max(0.001, camera.position.z - (backdropPlane.position.z || 0));
      const vFov = THREE.MathUtils.degToRad(camera.fov);
      const height = 2 * Math.tan(vFov / 2) * distance;
      const width = height * Math.max(1e-6, camera.aspect);
      backdropPlane.scale.set(width, height, 1);
    }

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

    // Interaction state and handlers (pan left/right, pinch-zoom)
    let isUserInteracting = false;
    const activePointers = new Map();
    let lastSinglePointerX = 0;
    let pinchStartDistance = 0;
    let pinchStartZ = 0;
    const MIN_Z = 1.4;
    const MAX_Z = 10.0;

    function onPointerDown(e) {
      isUserInteracting = true;
      try { renderer.domElement.setPointerCapture && renderer.domElement.setPointerCapture(e.pointerId); } catch (_) {}
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activePointers.size === 1) {
        lastSinglePointerX = e.clientX;
      } else if (activePointers.size === 2) {
        const pts = Array.from(activePointers.values());
        pinchStartDistance = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        pinchStartZ = camera.position.z;
      }
      e.preventDefault();
    }

    function onPointerMove(e) {
      const prev = activePointers.get(e.pointerId);
      if (!prev) return;
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (activePointers.size === 1) {
        const dx = e.clientX - lastSinglePointerX;
        lastSinglePointerX = e.clientX;
        const ROTATE_SPEED = 0.005;
        if (Number.isFinite(dx)) sphere.rotation.y += dx * ROTATE_SPEED;
        e.preventDefault();
      } else if (activePointers.size === 2) {
        const pts = Array.from(activePointers.values());
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (pinchStartDistance > 0) {
          const scale = d / pinchStartDistance;
          let z = pinchStartZ / Math.max(0.01, scale);
          z = Math.max(MIN_Z, Math.min(MAX_Z, z));
          camera.position.z = z;
          updateBackdropPlaneSize();
        }
        e.preventDefault();
      }
    }

    function onPointerUp(e) {
      try { renderer.domElement.releasePointerCapture && renderer.domElement.releasePointerCapture(e.pointerId); } catch (_) {}
      activePointers.delete(e.pointerId);
      if (activePointers.size < 2) {
        pinchStartDistance = 0;
      }
      if (activePointers.size === 1) {
        const remaining = Array.from(activePointers.values())[0];
        if (remaining) lastSinglePointerX = remaining.x;
      }
      if (activePointers.size === 0) {
        isUserInteracting = false;
      }
    }

    function onWheel(e) {
      e.preventDefault();
      const factor = Math.exp((e.deltaY || 0) * 0.001);
      let z = camera.position.z * factor;
      z = Math.max(MIN_Z, Math.min(MAX_Z, z));
      camera.position.z = z;
      updateBackdropPlaneSize();
    }

    // Animation loop
    let animId = 0;
    let prevTimeMs = performance.now();
    function animate() {
      animId = requestAnimationFrame(animate);
      const now = performance.now();
      const dt = Math.max(0, (now - prevTimeMs) / 1000);
      prevTimeMs = now;
      const autoY = isUserInteracting ? 0 : 0.01;
      const autoX = isUserInteracting ? 0 : 0.005;
      sphere.rotation.y += autoY;
      sphere.rotation.x += autoX;
      updateBackdropPlaneSize();
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
      updateBackdropPlaneSize();
    }

    const ro = new ResizeObserver(resize);
    ro.observe(container);

    // Start
    resize();
    animate();

    // Input listeners
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointercancel', onPointerUp);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

    // Cleanup on unload
    window.addEventListener('beforeunload', () => {
      cancelAnimationFrame(animId);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointercancel', onPointerUp);
      renderer.domElement.removeEventListener('wheel', onWheel);
      renderer.dispose();
      geom.dispose();
      mat.dispose();
      if (backdropPlane) {
        backdropPlane.geometry?.dispose?.();
        backdropPlane.material?.dispose?.();
      }
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

  // Lightning helper: produce a random unit vector perpendicular to normal
  function randomPerpendicularVectorTo(normal) {
    const n = new THREE.Vector3().copy(normal).normalize();
    let r = randomPointInUnitSphere();
    if (Math.abs(r.dot(n)) > 0.95) {
      r = new THREE.Vector3(1, 0, 0);
      if (Math.abs(n.x) > 0.9) r.set(0, 1, 0);
    }
    const v = r.sub(n.clone().multiplyScalar(r.dot(n)));
    if (v.lengthSq() < 1e-6) {
      if (Math.abs(n.x) < 0.9) v.set(1, 0, 0).sub(n.clone().multiplyScalar(n.x));
      else v.set(0, 1, 0).sub(n.clone().multiplyScalar(n.y));
    }
    v.normalize();
    return v;
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
    remainingEventsByTid.clear();
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

    // If an animation is already in progress, ignore this request and let it finish
    if (isAnimationActive()) return;

    // Build points per PROGRAM token (instruction index)
    const tokens = getProgramTokens();
    const count = tokens.length | 0;
    if (count <= 0) return;

    // Reuse the existing layout if the instruction count hasn't changed
    const canReuseLayout = (instructionIndexToPosition.length === count) && (instructionIndexToObject.size === count);

    if (!canReuseLayout) {
      // Clear previous points and state, then create a fresh layout
      clearPoints();

      // Create shared geometry for tiny spheres
      if (!sharedPointGeometry) sharedPointGeometry = new THREE.SphereGeometry(0.02, 8, 6);

      // Pre-compute positions
      const positions = layoutPoints(count);
      instructionIndexToPosition = positions.map(p => p.clone());

      // Neutral material color for program points
      for (let i = 0; i < count; i++) {
        const pos = positions[i];
        const color = new THREE.Color(0x03b9ad9);
        const mat = new THREE.MeshStandardMaterial({ color, emissive: color.clone().multiplyScalar(0.25) });
        // Store base visual parameters for highlight blending
        mat.userData.baseColor = color.clone();
        mat.userData.baseEmissiveMin = 0.01;
        const m = new THREE.Mesh(sharedPointGeometry, mat);
        m.position.copy(pos);
        pointsGroup.add(m);
        instructionIndexToObject.set(i, m);
      }
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
      lightningBolts: [],
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

  // Ensure the two lightning bolts exist on the snake
  function ensureLightningBoltsForSnake(snake) {
    if (Array.isArray(snake.lightningBolts) && snake.lightningBolts.length === 2) return;
    snake.lightningBolts = [];
    for (let i = 0; i < 2; i++) {
      const material = new THREE.LineBasicMaterial({
        color: LIGHTNING_COLORS[i] || 0x99ddff,
        transparent: true,
        opacity: LIGHTNING_OPACITIES[i] || 0.8,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      });
      const geometry = new THREE.BufferGeometry();
      const line = new THREE.Line(geometry, material);
      line.frustumCulled = false;
      snake.group.add(line);
      snake.lightningBolts.push(line);
    }
  }

  function startSnakeAnimation(trace) {
    clearSnakes();
    if (!Array.isArray(trace) || trace.length === 0) return;

    // Filter to entries that have a valid instruction index
    globalTrace = trace.filter((e) => {
      const ipValid = Number.isInteger(e?.ip) && instructionIndexToPosition[e.ip] != null;
      if (!ipValid) return false;
      const tid = e?.tid;
      if (Number.isInteger(tid) && tid > MAX_TID) return false;
      return true;
    });
    if (globalTrace.length === 0) return;

    // Reset parallel scheduler state
    globalTraceIndex = 0;
    eventAccumulator = 0;
    lastActiveTid = null;

    // Initialize remaining events per thread
    remainingEventsByTid.clear();
    for (let i = 0; i < globalTrace.length; i++) {
      const tid = globalTrace[i]?.tid;
      if (Number.isInteger(tid)) {
        remainingEventsByTid.set(tid, (remainingEventsByTid.get(tid) || 0) + 1);
      }
    }

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

      let depthPx = Math.max(SNAKE_MIN_TRAIL_PX, getStackDepthFromTraceEntry(currentEntry) * SNAKE_PX_PER_STACK);
      if (depthPx > SNAKE_MAX_TRAIL_PX) depthPx = SNAKE_MAX_TRAIL_PX;
      snake.pendingTargets.push({ tid, ip, targetTrailPx: depthPx });
    }

    // Move all snakes independently toward their per-thread targets at fixed speed
    const snakesToRemove = [];
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

          // Mark this event as processed for the owning thread
          if (Number.isInteger(snake.currentEvent.tid)) {
            const prev = remainingEventsByTid.get(snake.currentEvent.tid) || 0;
            remainingEventsByTid.set(snake.currentEvent.tid, Math.max(0, prev - 1));
          }

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

      // Lightning trail
      updateLightningBoltsForSnake(snake, Math.max(0.01, snake.targetTrailPixels * wupp));

      // If this snake has fully finished its events and has no more pending work, mark for removal
      const remainingForTid = remainingEventsByTid.get(snake.tid) || 0;
      if (!snake.currentEvent && snake.pendingTargets.length === 0 && remainingForTid === 0) {
        snakesToRemove.push(snake.tid);
      }
    });

    // Remove finished snakes now that iteration is complete
    for (const tid of snakesToRemove) removeSnakeByTid(tid);

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

  // Build a jagged lightning polyline that follows the snake path, with random
  // perpendicular offsets that always start and end exactly at each path segment's ends
  function buildLightningPointsForPath(pathPositions, amplitudeScale, stepLen) {
    const out = [];
    const n = pathPositions.length;
    if (n < 2) return out;
    for (let i = 0; i < n - 1; i++) {
      const p0 = pathPositions[i];
      const p1 = pathPositions[i + 1];
      const seg = new THREE.Vector3().subVectors(p1, p0);
      const segLen = seg.length();
      out.push(p0.clone());
      if (segLen > 1e-6) {
        const dir = seg.clone().divideScalar(segLen);
        const maxSubs = LIGHTNING_MAX_SUBDIVISIONS;
        const subs = Math.max(1, Math.min(maxSubs, Math.round(segLen / Math.max(1e-6, stepLen))));
        for (let s = 1; s < subs; s++) {
          const t = s / subs;
          const base = new THREE.Vector3().lerpVectors(p0, p1, t);
          const perp = randomPerpendicularVectorTo(dir);
          const headProximity = (i + t) / Math.max(1, n - 1);
          const amp = LIGHTNING_BASE_AMPLITUDE * amplitudeScale * (0.4 + 0.6 * headProximity) * (0.6 + 0.4 * Math.random());
          base.add(perp.multiplyScalar((Math.random() * 2 - 1) * amp));
          out.push(base);
        }
      }
      out.push(p1.clone());
    }
    return out;
  }

  function updateLightningBoltsForSnake(snake, targetLen) {
    ensureLightningBoltsForSnake(snake);
    const hasPath = Array.isArray(snake.pathPositions) && snake.pathPositions.length > 1;
    if (!hasPath) {
      if (snake.lightningBolts) snake.lightningBolts.forEach(l => { if (l) l.visible = false; });
      return;
    }
    const pts1 = buildLightningPointsForPath(snake.pathPositions, 4.0, LIGHTNING_STEP_LENGTH);
    const pts2 = buildLightningPointsForPath(snake.pathPositions, 3.00, LIGHTNING_STEP_LENGTH * 1.2);
    if (snake.lightningBolts[0]) {
      snake.lightningBolts[0].visible = pts1.length > 1;
      snake.lightningBolts[0].geometry.setFromPoints(pts1);
    }
    if (snake.lightningBolts[1]) {
      snake.lightningBolts[1].visible = pts2.length > 1;
      snake.lightningBolts[1].geometry.setFromPoints(pts2);
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

  function removeSnakeByTid(tid) {
    const snake = snakesByTid.get(tid);
    if (!snake) return;
    // Remove trail sprites and dispose materials
    if (Array.isArray(snake.trailSprites)) {
      for (let i = 0; i < snake.trailSprites.length; i++) {
        const spr = snake.trailSprites[i];
        if (spr) {
          snake.group.remove(spr);
          spr.material?.dispose?.();
        }
      }
      snake.trailSprites.length = 0;
    }
    // Remove lightning bolts
    if (Array.isArray(snake.lightningBolts)) {
      for (let i = 0; i < snake.lightningBolts.length; i++) {
        const line = snake.lightningBolts[i];
        if (line) {
          snake.group.remove(line);
          line.geometry?.dispose?.();
          line.material?.dispose?.();
        }
      }
      snake.lightningBolts.length = 0;
    }
    // Remove head
    if (snake.head) {
      snake.group.remove(snake.head);
      snake.head.material?.dispose?.();
      snake.head.geometry?.dispose?.();
    }
    // Remove light
    if (snake.pointLight) {
      snake.group.remove(snake.pointLight);
    }
    // Remove group from the scene
    if (snake.group) {
      snakeGroup.remove(snake.group);
    }
    snakesByTid.delete(tid);
  }

  function stopAnimation() {
    // Clear all snakes and pending events; leave points as-is
    clearSnakes();
    // Also clear any active highlights
    instructionIndexToHighlightTime.clear();
    instructionIndexToHighlightLight.forEach((light) => {
      light.parent?.remove(light);
    });
    instructionIndexToHighlightLight.clear();
  }

  // expose API
  window.Trace3D = {
    setup,
    layoutPoints,
    getObjectForTraceIndex: (idx) => instructionIndexToObject.get(idx) || null,
    getObjectForInstructionIndex: (idx) => instructionIndexToObject.get(idx) || null,
    stop: stopAnimation,
    isAnimating: isAnimationActive
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTrace3D, { once: true });
  } else {
    initTrace3D();
  }
})();
