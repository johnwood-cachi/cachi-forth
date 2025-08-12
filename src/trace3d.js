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

  // Snake animation state
  let snakeGroup = null;
  let snakeHead = null;
  let snakeTrailSprites = [];
  let snakePathPositions = [];
  let snakeTrace = [];
  let snakeTraceIndex = 0;
  let snakeHeadPos = null;
  let snakeNextPos = null;
  let snakeTargetTrailPixels = 50; // default min trail length in px
  const SNAKE_MIN_TRAIL_PX = 50;
  const SNAKE_PX_PER_STACK = 5;
  const SNAKE_SPEED_UNITS_PER_SEC = 3.6; // movement speed in world units (3x faster)

  // Light that follows the snake head
  let snakePointLight = null;
  const SNAKE_LIGHT_MAX_INTENSITY = 1.8;
  const SNAKE_LIGHT_DECAY_SECONDS = 2.0;
  let snakeLightTimeSincePeak = Infinity;

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
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(5, 8, 6);
    scene.add(dir);

    // Translucent sphere
    const geom = new THREE.SphereGeometry(1, 48, 32);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x44aaff,
      transparent: true,
      opacity: 0.35,
      metalness: 0.1,
      roughness: 0.2,
      depthWrite: false
    });
    sphere = new THREE.Mesh(geom, mat);
    scene.add(sphere);

    // Optional subtle wireframe for shape definition
    const wire = new THREE.LineSegments(
      new THREE.WireframeGeometry(geom),
      new THREE.LineBasicMaterial({ color: 0x88ccff, opacity: 0.25, transparent: true })
    );
    sphere.add(wire);

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
      updateSnake(dt);
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
    clearSnake();
  }

  function clearSnake() {
    if (!snakeGroup) return;
    for (let i = snakeGroup.children.length - 1; i >= 0; i--) {
      const child = snakeGroup.children[i];
      snakeGroup.remove(child);
      if (child.material) child.material.dispose?.();
      if (child.geometry) child.geometry.dispose?.();
    }
    snakeHead = null;
    snakeTrailSprites = [];
    snakePathPositions = [];
    snakeTrace = [];
    snakeTraceIndex = 0;
    snakeHeadPos = null;
    snakeNextPos = null;
    snakeTargetTrailPixels = SNAKE_MIN_TRAIL_PX;
    snakePointLight = null;
    snakeLightTimeSincePeak = Infinity;
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
      const mat = new THREE.MeshStandardMaterial({ color, emissive: color.clone().multiplyScalar(0.15) });
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

  function ensureSnakeHead() {
    if (snakeHead) return;
    const geom = new THREE.SphereGeometry(0.03, 12, 8);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffee88, emissive: 0xffcc33, emissiveIntensity: 1.0 });
    snakeHead = new THREE.Mesh(geom, mat);
    snakeGroup.add(snakeHead);
  }

  function ensureSnakeLight() {
    if (snakePointLight) return;
    // Warm point light that affects nearby objects; parent to snakeGroup so it rotates with the sphere
    snakePointLight = new THREE.PointLight(0xffcc88, 0.0, 3.0, 2.0);
    snakePointLight.castShadow = false;
    snakeGroup.add(snakePointLight);
  }

  function ensureTrailSprites(n) {
    // Create or remove sprites to match requested count upper bound
    const tex = null; // default circular sprite
    while (snakeTrailSprites.length < n) {
      const smat = new THREE.SpriteMaterial({ color: 0x88ddff, opacity: 0.8, transparent: true, depthWrite: false });
      const spr = new THREE.Sprite(smat);
      spr.scale.setScalar(0.06); // size in world units
      snakeGroup.add(spr);
      snakeTrailSprites.push(spr);
    }
    while (snakeTrailSprites.length > n) {
      const spr = snakeTrailSprites.pop();
      snakeGroup.remove(spr);
      spr.material.dispose?.();
    }
  }

  function startSnakeAnimation(trace) {
    clearSnake();
    if (!Array.isArray(trace) || trace.length === 0) return;

    // Filter to entries that have a valid instruction index
    snakeTrace = trace.filter(e => Number.isInteger(e?.ip) && instructionIndexToPosition[e.ip] != null);
    if (snakeTrace.length === 0) return;

    // Seed head and next positions
    snakeTraceIndex = 0;
    snakeHeadPos = instructionIndexToPosition[snakeTrace[0].ip].clone();
    const nextIdx = snakeTraceIndex + 1 < snakeTrace.length ? snakeTrace[snakeTraceIndex + 1].ip : snakeTrace[0].ip;
    snakeNextPos = instructionIndexToPosition[nextIdx].clone();

    // Initialize path with starting point
    snakePathPositions = [snakeHeadPos.clone()];

    // Initial trail target based on first stack size
    const depth = getStackDepthFromTraceEntry(snakeTrace[0]);
    snakeTargetTrailPixels = Math.max(SNAKE_MIN_TRAIL_PX, depth * SNAKE_PX_PER_STACK);

    ensureSnakeHead();
    ensureSnakeLight();
    snakeHead.position.copy(snakeHeadPos);
    if (snakePointLight) {
      snakePointLight.position.copy(snakeHeadPos);
      snakePointLight.intensity = SNAKE_LIGHT_MAX_INTENSITY;
      snakeLightTimeSincePeak = 0;
    }
  }

  function getStackDepthFromTraceEntry(entry) {
    const s = entry?.stack;
    if (!s) return 0;
    // stack is "a|b|c"; number of items equals segments count
    return s.length ? s.split('|').filter(x => x.length || x === '').length : 0;
  }

  function updateSnake(dt) {
    if (!snakeHead || snakeTrace.length === 0) return;

    // Compute target trail length in world units from pixels
    const depth = getApproxDepthForTrail();
    const wupp = worldUnitsPerPixelAtDepth(depth);
    const targetTrailWorldLen = Math.max(0.01, snakeTargetTrailPixels * wupp);

    // Move head toward next position at fixed speed
    let remainingMove = Math.max(0, dt) * SNAKE_SPEED_UNITS_PER_SEC;
    while (remainingMove > 0.00001 && snakeTraceIndex < snakeTrace.length) {
      const toTarget = new THREE.Vector3().copy(snakeNextPos).sub(snakeHeadPos);
      const dist = toTarget.length();
      if (dist <= remainingMove) {
        // Snap to target and advance to next trace point
        snakeHeadPos.copy(snakeNextPos);
        pushPathPoint(snakeHeadPos);
        // Peak the light when we arrive at a target point
        if (snakePointLight) {
          snakePointLight.intensity = SNAKE_LIGHT_MAX_INTENSITY;
          snakeLightTimeSincePeak = 0;
        }
        remainingMove -= dist;
        snakeTraceIndex++;
        if (snakeTraceIndex < snakeTrace.length - 1) {
          const e = snakeTrace[snakeTraceIndex];
          const eNext = snakeTrace[snakeTraceIndex + 1];
          snakeNextPos.copy(instructionIndexToPosition[eNext.ip]);
          // Update trail pixel length target based on current stack depth
          const d = getStackDepthFromTraceEntry(e);
          snakeTargetTrailPixels = Math.max(SNAKE_MIN_TRAIL_PX, d * SNAKE_PX_PER_STACK);
        } else {
          // Last entry: stop at its position
          if (snakeTraceIndex < snakeTrace.length) {
            const e = snakeTrace[snakeTraceIndex];
            snakeNextPos.copy(instructionIndexToPosition[e.ip]);
          }
          remainingMove = 0;
          break;
        }
      } else {
        // Move partially towards target
        const step = toTarget.normalize().multiplyScalar(remainingMove);
        snakeHeadPos.add(step);
        pushPathPoint(snakeHeadPos);
        remainingMove = 0;
        break;
      }
    }

    // Cull path to maintain target length
    trimPathByLength(targetTrailWorldLen);

    // Update visuals
    snakeHead.position.copy(snakeHeadPos);
    if (snakePointLight) {
      snakePointLight.position.copy(snakeHeadPos);
      // Exponential-like linear decay to zero over configured duration
      if (isFinite(snakeLightTimeSincePeak)) {
        snakeLightTimeSincePeak += Math.max(0, dt);
        const t = Math.min(1, snakeLightTimeSincePeak / Math.max(1e-6, SNAKE_LIGHT_DECAY_SECONDS));
        const factor = 1 - t;
        snakePointLight.intensity = SNAKE_LIGHT_MAX_INTENSITY * factor;
      }
    }
    if (snakeHead?.material) {
      // Keep the snake head glow in sync with the point light factor (min 0.2 to stay visible)
      const currentIntensity = snakePointLight ? snakePointLight.intensity : 0;
      const headFactor = Math.max(0, Math.min(1, currentIntensity / Math.max(1e-6, SNAKE_LIGHT_MAX_INTENSITY)));
      snakeHead.material.emissiveIntensity = 0.2 + 0.8 * headFactor;
    }
    updateTrailSprites(targetTrailWorldLen);
  }

  function pushPathPoint(vec) {
    const last = snakePathPositions[snakePathPositions.length - 1];
    if (!last || last.distanceToSquared(vec) > 1e-6) {
      snakePathPositions.push(vec.clone());
    }
  }

  function trimPathByLength(maxLen) {
    // Ensure cumulative length from head backwards does not exceed maxLen
    if (snakePathPositions.length <= 1) return;
    let cum = 0;
    for (let i = snakePathPositions.length - 1; i > 0; i--) {
      const a = snakePathPositions[i];
      const b = snakePathPositions[i - 1];
      const d = a.distanceTo(b);
      cum += d;
      if (cum >= maxLen) {
        // Trim beyond b, and optionally interpolate b->a to fit exactly
        const excess = cum - maxLen;
        if (d > 1e-6) {
          const t = Math.max(0, Math.min(1, (d - excess) / d));
          b.lerpVectors(b, a, t);
          snakePathPositions.splice(0, i - 1);
        } else {
          snakePathPositions.splice(0, i - 1);
        }
        return;
      }
    }
    // If here, whole path shorter than maxLen -> keep minimal
    // But avoid unbounded growth: cap to reasonable number of points
    const MAX_POINTS = 1000;
    if (snakePathPositions.length > MAX_POINTS) {
      const drop = snakePathPositions.length - MAX_POINTS;
      snakePathPositions.splice(0, drop);
    }
  }

  function samplePointAtArcLengthFromHead(s) {
    // s: distance from head backward along the path
    if (snakePathPositions.length === 0) return null;
    if (s <= 0) return snakePathPositions[snakePathPositions.length - 1].clone();
    let remaining = s;
    for (let i = snakePathPositions.length - 1; i > 0; i--) {
      const a = snakePathPositions[i];
      const b = snakePathPositions[i - 1];
      const d = a.distanceTo(b);
      if (remaining <= d) {
        // interpolate between a (closer to head) and b
        const t = Math.max(0, Math.min(1, 1 - remaining / Math.max(1e-6, d)));
        return new THREE.Vector3().lerpVectors(b, a, t);
      }
      remaining -= d;
    }
    return snakePathPositions[0].clone();
  }

  function updateTrailSprites(targetLen) {
    // Number of visual samples along trail
    const N = 40;
    ensureTrailSprites(N);

    for (let i = 0; i < N; i++) {
      const frac = i / (N - 1);
      const s = frac * targetLen;
      const p = samplePointAtArcLengthFromHead(s);
      const spr = snakeTrailSprites[i];
      if (p && spr) {
        spr.position.copy(p);
        const alpha = Math.max(0, 1 - frac);
        spr.material.opacity = 0.85 * Math.pow(alpha, 1.5);
      }
    }
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