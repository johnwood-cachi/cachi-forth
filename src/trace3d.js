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

    // Points container
    pointsGroup = new THREE.Group();
    scene.add(pointsGroup);

    // Animation loop
    let animId = 0;
    function animate() {
      animId = requestAnimationFrame(animate);
      sphere.rotation.y += 0.01;
      sphere.rotation.x += 0.005;
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
  }

  function setup(executionTrace) {
    if (!scene || !pointsGroup || !Array.isArray(executionTrace)) return;

    clearPoints();

    const count = executionTrace.length | 0;
    if (count <= 0) return;

    // Create shared geometry for tiny spheres
    if (!sharedPointGeometry) sharedPointGeometry = new THREE.SphereGeometry(0.02, 8, 6);

    // Pre-compute positions
    const positions = layoutPoints(count);

    // Optional: map thread ids to consistent colors
    const tidSet = new Map();
    let nextHue = 0;
    const getColorForTid = (tid) => {
      if (!tidSet.has(tid)) {
        tidSet.set(tid, nextHue);
        nextHue = (nextHue + 47) % 360; // hop hues for variety
      }
      const hue = tidSet.get(tid);
      const color = new THREE.Color();
      color.setHSL(hue / 360, 0.6, 0.6);
      return color;
    };

    for (let i = 0; i < count; i++) {
      const pos = positions[i];
      const entry = executionTrace[i] || {};
      const color = getColorForTid(entry.tid == null ? i : entry.tid);
      const mat = new THREE.MeshStandardMaterial({ color, emissive: color.clone().multiplyScalar(0.2) });
      const m = new THREE.Mesh(sharedPointGeometry, mat);
      m.position.copy(pos);
      pointsGroup.add(m);
      traceIndexToObject.set(i, m);
    }
  }

  // expose API
  window.Trace3D = {
    setup,
    layoutPoints,
    getObjectForTraceIndex: (idx) => traceIndexToObject.get(idx) || null
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTrace3D, { once: true });
  } else {
    initTrace3D();
  }
})();