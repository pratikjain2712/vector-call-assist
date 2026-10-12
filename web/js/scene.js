/* The 3D scene behind the home page: a phone and a laptop that pair as you scroll, and a grid of seats that
   lights up as the seat count changes. Loaded as a module from a pinned three.js release (r160). If WebGL is
   missing the page keeps its plain background (the .no-gl class on <html>). */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

function start() {
  const canvas = document.getElementById('scene');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (e) {
    document.documentElement.classList.add('no-gl');
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(0, 0, 11);

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(3, 6, 7);
  scene.add(key);
  const ember = new THREE.PointLight(0xff6a3d, 2.2, 14);
  ember.position.set(-5, -2, 4);
  scene.add(ember);
  const mint = new THREE.PointLight(0x7af2d0, 1.6, 14);
  mint.position.set(5, 2, 2);
  scene.add(mint);

  /* ---------- helpers ---------- */
  function roundedShape(w, h, r) {
    const s = new THREE.Shape();
    const x = -w / 2, y = -h / 2;
    s.moveTo(x + r, y);
    s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
    s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
    s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
    return s;
  }
  function slab(w, h, depth, r) {
    return new THREE.ExtrudeGeometry(roundedShape(w, h, r), {
      depth: depth, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 4, curveSegments: 10
    });
  }
  function screenTexture(draw) {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 512;
    const g = c.getContext('2d');
    draw(g, c.width, c.height);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /* ---------- phone: a rounded slab with a call card on the screen ---------- */
  const phone = new THREE.Group();
  const phoneBody = new THREE.Mesh(slab(1.25, 2.55, 0.16, 0.2), new THREE.MeshStandardMaterial({ color: 0x161b26, metalness: 0.7, roughness: 0.28 }));
  phoneBody.position.z = 0;
  phone.add(phoneBody);
  const phoneScreen = new THREE.Mesh(new THREE.PlaneGeometry(1.08, 2.36), new THREE.MeshBasicMaterial({
    map: screenTexture(function (g, w, h) {
      g.fillStyle = '#0d121c'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#7af2d0'; g.font = 'bold 34px monospace'; g.fillText('LIVE CALL', 36, 70);
      g.fillStyle = '#eef1f7'; g.font = 'bold 56px sans-serif'; g.fillText('Lead 14', 36, 160);
      g.fillStyle = '#8b93a7'; g.font = '30px monospace'; g.fillText('Rep 3 · Batch A', 36, 210);
      g.fillStyle = '#ff6a3d'; g.beginPath(); g.roundRect(36, 300, 440, 150, 40); g.fill();
      g.fillStyle = '#140904'; g.font = 'bold 48px sans-serif'; g.fillText('CALL 00:42', 90, 395);
      g.fillStyle = '#1b2231'; g.beginPath(); g.roundRect(36, 490, 440, 120, 30); g.fill();
      g.fillStyle = '#8aa8ff'; g.font = '32px monospace'; g.fillText('OUTCOME: CALLBACK', 60, 560);
    }),
    toneMapped: false
  }));
  phoneScreen.position.z = 0.2;
  phone.add(phoneScreen);
  scene.add(phone);

  /* ---------- laptop: a base and a lid with the script on screen ---------- */
  const laptop = new THREE.Group();
  const base = new THREE.Mesh(slab(2.9, 1.9, 0.14, 0.12), new THREE.MeshStandardMaterial({ color: 0x161b26, metalness: 0.7, roughness: 0.3 }));
  base.rotation.x = -Math.PI / 2;
  base.position.set(0, -0.08, 0);
  laptop.add(base);
  const hinge = new THREE.Group();
  hinge.position.set(0, -0.02, -0.95);
  laptop.add(hinge);
  const lid = new THREE.Mesh(slab(2.9, 1.9, 0.1, 0.12), new THREE.MeshStandardMaterial({ color: 0x161b26, metalness: 0.7, roughness: 0.3 }));
  lid.position.set(0, 0.95, 0);
  hinge.add(lid);
  const laptopScreen = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.6), new THREE.MeshBasicMaterial({
    map: screenTexture(function (g, w, h) {
      g.fillStyle = '#0d121c'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#ff6a3d'; g.fillRect(0, 0, w, 14);
      g.fillStyle = '#8b93a7'; g.font = '28px monospace'; g.fillText('STEP 2 OF 4 · ASK', 40, 70);
      g.fillStyle = '#eef1f7'; g.font = '46px sans-serif';
      g.fillText('"Is this a good time for two', 40, 170);
      g.fillText('minutes about the batch?"', 40, 230);
      g.fillStyle = '#7af2d0'; g.font = '30px monospace'; g.fillText('NEXT LINE  →', 40, 380);
    }),
    toneMapped: false
  }));
  laptopScreen.position.set(0, 0.95, 0.07);
  laptopScreen.position.z = 0.14;
  hinge.add(laptopScreen);
  scene.add(laptop);

  /* ---------- the pairing beam between the two devices ---------- */
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1, 12),
    new THREE.MeshBasicMaterial({ color: 0x7af2d0, transparent: true, opacity: 0.9 }));
  beam.visible = false;
  scene.add(beam);
  const beamGlow = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1, 12),
    new THREE.MeshBasicMaterial({ color: 0x7af2d0, transparent: true, opacity: 0.15 }));
  beamGlow.visible = false;
  scene.add(beamGlow);

  /* ---------- the seat grid: 200 cells, the first N lit ---------- */
  const COLS = 10, ROWS = 20, MAX = COLS * ROWS;
  const seatGeo = new THREE.BoxGeometry(0.22, 0.22, 0.22);
  const seatMat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.2, roughness: 0.4, emissive: 0x000000 });
  const seats = new THREE.InstancedMesh(seatGeo, seatMat, MAX);
  const dim = new THREE.Color(0x222938), lit = new THREE.Color(0x7af2d0), warm = new THREE.Color(0xff6a3d);
  const cur = new Float32Array(MAX);      // 0..1 how lit each cell is right now
  const target = new Float32Array(MAX);   // 0 or 1
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  const seatBase = new THREE.Vector3(5.0, 0, -1);
  const colors = new THREE.Color();
  for (let i = 0; i < MAX; i++) {
    const col = i % COLS, row = Math.floor(i / COLS);
    p.set(seatBase.x + (col - (COLS - 1) / 2) * 0.28, seatBase.y + ((ROWS - 1) / 2 - row) * 0.28, seatBase.z);
    m.compose(p, q, s.set(1, 1, 1));
    seats.setMatrixAt(i, m);
    seats.setColorAt(i, dim);
  }
  seats.instanceMatrix.needsUpdate = true;
  seats.instanceColor.needsUpdate = true;
  scene.add(seats);
  let seatCount = 10;
  function setSeatTargets() {
    for (let i = 0; i < MAX; i++) target[i] = i < seatCount ? 1 : 0;
  }
  setSeatTargets();

  /* ---------- drifting particles ---------- */
  const PN = 520;
  const pos = new Float32Array(PN * 3);
  for (let i = 0; i < PN; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 26;
    pos[i * 3 + 1] = (Math.random() - 0.5) * 16;
    pos[i * 3 + 2] = -Math.random() * 14 + 3;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: 0x8b93a7, size: 0.035, transparent: true, opacity: 0.6, depthWrite: false }));
  scene.add(dust);

  /* ---------- scene modes: where things sit for each section ---------- */
  // Positions are per object: [x, y, z, scale]. "pair" brings the devices together with the beam on.
  const MODES = {
    hero:  { phone: [1.2, 0.35, 0, 1], laptop: [4.3, -0.55, 0, 1], beam: 0, seats: 0, dust: 1 },
    pair:  { phone: [3.4, 0.25, 0, 0.9], laptop: [5.3, -0.5, 0, 0.9], beam: 1, seats: 0, dust: 1 },
    seats: { phone: [-5.6, 1.6, -2, 0.55], laptop: [-5.6, -1.9, -2, 0.55], beam: 0, seats: 1, dust: 0.6 }
  };
  const obj = {
    phone: { x: MODES.hero.phone[0], y: MODES.hero.phone[1], z: 0, s: 1 },
    laptop: { x: MODES.hero.laptop[0], y: MODES.hero.laptop[1], z: 0, s: 1 },
    beam: 0, seats: 0, dust: 1
  };
  let mode = 'hero';
  let target3 = MODES.hero;
  let seatVis = 0;   // how far the seat grid is shown

  function setMode(name) {
    if (!MODES[name] || name === mode) return;
    mode = name;
    target3 = MODES[name];
    if (reduce) render();
  }

  /* ---------- sizing: keep the composition on screen on phones ---------- */
  let frameScale = 1;
  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    frameScale = w < 760 ? 0.62 : (w < 1100 ? 0.82 : 1);
    camera.updateProjectionMatrix();
    if (reduce) render();
  }
  window.addEventListener('resize', resize);

  /* ---------- pointer parallax ---------- */
  let px = 0, py = 0, tx = 0, ty = 0;
  window.addEventListener('pointermove', function (e) {
    px = (e.clientX / window.innerWidth - 0.5);
    py = (e.clientY / window.innerHeight - 0.5);
  }, { passive: true });

  /* ---------- seat count from the pricing calculator ---------- */
  document.addEventListener('vca:seats', function (e) {
    const n = Math.max(1, Math.min(MAX, (e.detail && e.detail.count) || 1));
    seatCount = n;
    setSeatTargets();
    if (reduce) render();
  });

  /* ---------- drawing ---------- */
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
  function lerp(a, b, t) { return a + (b - a) * t; }

  function step(t) {
    const k = reduce ? 1 : 0.075;
    const sc = frameScale;
    const ph = target3.phone, lp = target3.laptop;
    obj.phone.x = lerp(obj.phone.x, ph[0] * sc, k);
    obj.phone.y = lerp(obj.phone.y, ph[1] * sc, k);
    obj.phone.z = lerp(obj.phone.z, ph[2], k);
    obj.phone.s = lerp(obj.phone.s, ph[3] * sc, k);
    obj.laptop.x = lerp(obj.laptop.x, lp[0] * sc, k);
    obj.laptop.y = lerp(obj.laptop.y, lp[1] * sc, k);
    obj.laptop.z = lerp(obj.laptop.z, lp[2], k);
    obj.laptop.s = lerp(obj.laptop.s, lp[3] * sc, k);
    obj.beam = lerp(obj.beam, target3.beam, k);
    seatVis = lerp(seatVis, target3.seats, k);
    obj.dust = lerp(obj.dust, target3.dust, k);

    // gentle float, plus pointer tilt
    const float = reduce ? 0 : Math.sin(t * 0.7) * 0.08;
    tx = lerp(tx, py * 0.18, 0.05);
    ty = lerp(ty, px * 0.28, 0.05);

    phone.position.set(obj.phone.x, obj.phone.y + float, obj.phone.z);
    phone.scale.setScalar(obj.phone.s);
    phone.rotation.set(tx * 0.5, -0.35 + ty + (reduce ? 0 : Math.sin(t * 0.5) * 0.06), 0);

    laptop.position.set(obj.laptop.x, obj.laptop.y - float * 0.6, obj.laptop.z);
    laptop.scale.setScalar(obj.laptop.s);
    laptop.rotation.set(0.25 + tx * 0.4, 0.45 + ty * 0.8, 0);
    hinge.rotation.x = -0.35 - Math.max(0, 1 - obj.beam) * 0.25;

    // beam from phone (top edge) to laptop (lid)
    const beamOn = obj.beam > 0.02;
    beam.visible = beamOn;
    beamGlow.visible = beamOn;
    if (beamOn) {
      tmpA.set(obj.phone.x, obj.phone.y + 0.35 * obj.phone.s, 0.1);
      tmpB.set(obj.laptop.x, obj.laptop.y + 0.4 * obj.laptop.s, 0.1);
      const len = tmpA.distanceTo(tmpB);
      const mid = tmpA.clone().add(tmpB).multiplyScalar(0.5);
      beam.position.copy(mid);
      beamGlow.position.copy(mid);
      beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tmpB.clone().sub(tmpA).normalize());
      beamGlow.quaternion.copy(beam.quaternion);
      beam.scale.set(obj.beam, len, obj.beam);
      beamGlow.scale.set(obj.beam, len, obj.beam);
      const pulse = reduce ? 1 : 0.85 + Math.sin(t * 4) * 0.15;
      beam.material.opacity = 0.9 * pulse * obj.beam;
    }

    // seat grid: fade in and light cells toward their targets
    seats.visible = seatVis > 0.02;
    const shift = (1 - seatVis) * 3;
    seats.position.set(shift, 0, 0);
    for (let i = 0; i < MAX; i++) {
      cur[i] = lerp(cur[i], target[i], k);
      const col = i % COLS, row = Math.floor(i / COLS);
      const sizeNow = 0.25 + cur[i] * 0.75;
      p.set(seatBase.x + (col - (COLS - 1) / 2) * 0.28, seatBase.y + ((ROWS - 1) / 2 - row) * 0.28, seatBase.z);
      const wob = reduce ? 0 : Math.sin(t * 2 + i) * 0.02 * cur[i];
      m.compose(p, q, s.set(sizeNow, sizeNow, sizeNow + wob));
      seats.setMatrixAt(i, m);
      colors.copy(dim).lerp(i % 4 === 0 ? warm : lit, cur[i]);
      seats.setColorAt(i, colors);
    }
    seats.instanceMatrix.needsUpdate = true;
    seats.instanceColor.needsUpdate = true;

    dust.material.opacity = 0.6 * obj.dust;
    dust.rotation.y = reduce ? 0 : t * 0.02;
  }

  function render() {
    renderer.render(scene, camera);
  }

  let last = 0;
  function frame(now) {
    if (document.hidden) { requestAnimationFrame(frame); return; }
    const t = now / 1000;
    if (t - last < 1 / 60) { requestAnimationFrame(frame); return; }
    last = t;
    step(t);
    render();
    requestAnimationFrame(frame);
  }

  resize();
  setSeatTargets();
  // Follow the sections: each section with data-scene sets the mode when it is mostly in view.
  const io = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (en.isIntersecting) setMode(en.target.getAttribute('data-scene'));
    });
  }, { threshold: 0.45 });
  document.querySelectorAll('[data-scene]').forEach(function (el) { io.observe(el); });

  if (reduce) {
    for (let i = 0; i < 40; i++) step(0);
    render();
  } else {
    requestAnimationFrame(frame);
  }
  window.vcaScene = { setMode: setMode };
}

start();
