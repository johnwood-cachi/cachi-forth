(function(){
  if (typeof THREE === 'undefined') {
    console.warn('THREE not found; trace3d will not initialize.');
    return;
  }

  function initTrace3D() {
    const container = document.getElementById('trace3d');
    if (!container) return;

    // Create renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(container.clientWidth, container.clientHeight, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    container.appendChild(renderer.domElement);

    // Scene and camera
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
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
    const sphere = new THREE.Mesh(geom, mat);
    scene.add(sphere);

    // Optional subtle wireframe for shape definition
    const wire = new THREE.LineSegments(
      new THREE.WireframeGeometry(geom),
      new THREE.LineBasicMaterial({ color: 0x88ccff, opacity: 0.25, transparent: true })
    );
    sphere.add(wire);

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

    // Keep 3D view height in sync with graph height when it changes
    const graph = document.getElementById('graph');
    if (graph) {
      const sync = () => {
        const gh = graph.clientHeight;
        if (gh > 0) container.style.height = gh + 'px';
      };
      const gro = new ResizeObserver(sync);
      gro.observe(graph);
      // initial sync
      sync();
    }

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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTrace3D, { once: true });
  } else {
    initTrace3D();
  }
})();