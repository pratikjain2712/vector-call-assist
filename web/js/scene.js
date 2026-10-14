/* 3D visuals for the home page, built on three.js r160 from jsDelivr (exact version pinned).
   - heroScene: a phone and a laptop in the hero's stage card. The visitor picks what the lead said
     (home.js sends 'vca:objection'); the laptop shows the answer and the phone is on the call. Drag to turn
     them; clicking a device asks home.js for the next objection ('vca:pick'); a drag sends 'vca:grab'.
   - demoScene: the rep's phone beside the live demo. It rings, times and logs the call ('vca:demo').
   - seatScene: a grid of seats; the number lit follows the seat count in the pricing calculator.
   If WebGL or the module fails, nothing is added to the page and the hero card shows the answer alone.
/* three.js is loaded only on wide screens (961px and up). Phones and small tablets never download it and see the
   static page instead. The URL is pinned to r160. */
const WIDE = window.matchMedia('(min-width: 961px)').matches;
const THREE = WIDE ? await import('https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js') : null;

const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const C = { ink: 0x0e1628, blue: 0x2456e6, amber: 0xf5a524, mint: 0x0b8f6a, idle: 0xd3dbea, bodyDark: 0x1b2437 };

function renderer(canvas) {
  try {
    const r = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.setClearColor(0x000000, 0);
    return r;
  } catch (e) {
    return null;
  }
}

function sizeTo(r, cam, canvas) {
  const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
  r.setSize(w, h, false);
  cam.aspect = w / h;
  cam.updateProjectionMatrix();
}

function roundedShape(w, h, rad) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + rad, y);
  s.lineTo(x + w - rad, y); s.quadraticCurveTo(x + w, y, x + w, y + rad);
  s.lineTo(x + w, y + h - rad); s.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  s.lineTo(x + rad, y + h); s.quadraticCurveTo(x, y + h, x, y + h - rad);
  s.lineTo(x, y + rad); s.quadraticCurveTo(x, y, x + rad, y);
  return s;
}

function slab(w, h, depth, rad) {
  return new THREE.ExtrudeGeometry(roundedShape(w, h, rad), {
    depth: depth, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 4, curveSegments: 12
  });
}

function screen(draw) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  draw(c.getContext('2d'), c.width, c.height);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ---------- hero: what the lead said, on the laptop; the phone on the call. ---------- */
const PHONE_W = 386, PHONE_H = 846, PHONE_S = 2, LAP_W = 640, LAP_H = 405, LAP_S = 2;
const INK = '#0e1628', MUTED = '#56617a', BLUE = '#2456e6', BLUE_DEEP = '#1a42b8', MINT_HEX = '#0b8f6a', PALE = '#e6edff';
/* The pose the devices ease to: phone in front on the left, laptop open on the right, the call beam on. */
const POSE = { phone: [-2.1, 0.5, 1.2], phoneR: [0, -0.38, 0.05], phoneS: [1], laptop: [1.15, -0.55, 0], laptopR: [0.16, -0.28, 0], lid: [-0.45], beam: [1] };

function rr(g, x, y, w, h, r, fill) { g.fillStyle = fill; g.beginPath(); g.roundRect(x, y, w, h, r); g.fill(); }
function tx(g, s, x, y, font, fill, align) { g.font = font; g.fillStyle = fill; g.textAlign = align || 'left'; g.fillText(s, x, y); g.textAlign = 'left'; }
function dot(g, x, y, r, fill) { g.fillStyle = fill; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); }
// Draws text wrapped to a width, line by line from y; returns the y after the last line.
function wrap(g, s, x, y, w, lh, font, fill, maxLines) {
  g.font = font; g.fillStyle = fill;
  const words = String(s).split(' ');
  let line = '', n = 0;
  for (let i = 0; i < words.length; i++) {
    const t = line ? line + ' ' + words[i] : words[i];
    if (g.measureText(t).width > w && line) {
      if (++n === maxLines) { g.fillText(line + '…', x, y); return y + lh; }
      g.fillText(line, x, y); y += lh; line = words[i];
    } else line = t;
  }
  if (line) { g.fillText(line, x, y); y += lh; }
  return y;
}

/* Phone screens: design size PHONE_W x PHONE_H, drawn at PHONE_S. */
const PHONE_BG = '#f3f6fc';
function phoneFrame(g, title) {
  g.fillStyle = PHONE_BG; g.fillRect(0, 0, PHONE_W, PHONE_H);
  g.fillStyle = BLUE; g.fillRect(0, 0, PHONE_W, 150);
  rr(g, PHONE_W / 2 - 52, 12, 104, 26, 13, INK);             // camera notch
  tx(g, '9:41', 26, 34, '600 15px sans-serif', '#dbe6ff');
  tx(g, title, 24, 100, 'bold 30px sans-serif', '#ffffff');
}
// The phone during the call.
function drawPhoneCall(g) {
  phoneFrame(g, 'On call');
  dot(g, PHONE_W / 2, 300, 66, '#e6edff');
  tx(g, 'AR', PHONE_W / 2, 314, 'bold 40px sans-serif', BLUE_DEEP, 'center');
  tx(g, 'Ananya Rao', PHONE_W / 2, 412, 'bold 30px sans-serif', INK, 'center');
  tx(g, '00:42', PHONE_W / 2, 486, 'bold 58px sans-serif', INK, 'center');
  rr(g, 110, 510, 166, 40, 20, MINT_HEX); tx(g, 'On your SIM', PHONE_W / 2, 537, 'bold 18px sans-serif', '#ffffff', 'center');
  tx(g, 'The lead sees your number', PHONE_W / 2, 580, '17px sans-serif', MUTED, 'center');
  rr(g, 40, 720, 306, 76, 38, '#d6453d'); tx(g, 'Hang up', PHONE_W / 2, 767, 'bold 22px sans-serif', '#ffffff', 'center');
}

/* Laptop screens: design size LAP_W x LAP_H, drawn at LAP_S. */
function lapFrame(g, active) {
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, LAP_W, LAP_H);
  g.fillStyle = INK; g.fillRect(0, 0, 150, LAP_H);
  tx(g, 'Vector', 22, 40, 'bold 19px sans-serif', '#ffffff');
  const items = ['Today', 'Script', 'Callbacks', 'Results'];
  for (let i = 0; i < items.length; i++) {
    const y = 74 + i * 42, on = items[i] === active;
    if (on) rr(g, 12, y - 22, 126, 34, 10, BLUE);
    tx(g, items[i], 26, y, '16px sans-serif', on ? '#ffffff' : '#9fb0cc');
  }
  tx(g, 'Rep: Ravi', 22, LAP_H - 20, '14px sans-serif', '#9fb0cc');
}
// The laptop when the lead raises an objection: what they said, then what to say.
function drawLaptopAnswer(g, said, answer) {
  lapFrame(g, 'Today');
  tx(g, 'STEP 3 OF 4 · OFFER', 176, 40, 'bold 13px monospace', MUTED);
  rr(g, 176, 56, 84, 8, 4, BLUE); rr(g, 266, 56, 84, 8, 4, BLUE); rr(g, 356, 56, 84, 8, 4, BLUE); rr(g, 446, 56, 84, 8, 4, PALE);
  tx(g, 'THE LEAD SAYS', 176, 102, 'bold 13px monospace', MUTED);
  rr(g, 176, 114, 20 + Math.min(420, said.length * 15), 44, 22, INK);
  tx(g, said, 196, 143, 'bold 21px sans-serif', '#ffffff');
  rr(g, 176, 176, 440, 196, 18, '#fff4dc');
  rr(g, 176, 176, 8, 196, 4, '#f5a524');
  tx(g, 'SAY', 202, 210, 'bold 13px monospace', '#8a5a00');
  wrap(g, answer, 202, 246, 396, 34, 'bold 25px sans-serif', INK, 4);
}

function makeScreen(w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { c: c, g: c.getContext('2d'), tex: tex };
}
function paint(scr, fn, s) {
  const g = scr.g;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, scr.c.width, scr.c.height);
  g.setTransform(s, 0, 0, s, 0, 0);
  fn(g);
  scr.tex.needsUpdate = true;
}
function ease(a, b, k) { for (let i = 0; i < a.length; i++) a[i] += (b[i] - a[i]) * k; }

function initHero(canvas) {
  const r = renderer(canvas);
  if (!r) return false;
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  cam.position.set(0, 0.2, 9.6);
  scene.add(new THREE.AmbientLight(0xffffff, 1.0));
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(4, 6, 8);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9db8ff, 0.8);
  rim.position.set(-6, 2, -4);
  scene.add(rim);

  const bodyMat = new THREE.MeshStandardMaterial({ color: C.bodyDark, metalness: 0.25, roughness: 0.4 });

  // Everything turns together when the visitor drags.
  const rig = new THREE.Group();
  scene.add(rig);

  // Phone
  const phone = new THREE.Group();
  phone.add(new THREE.Mesh(slab(1.5, 3.1, 0.18, 0.24), bodyMat));
  const phoneScr = makeScreen(PHONE_W * PHONE_S, PHONE_H * PHONE_S);
  const pScreen = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 2.85), new THREE.MeshBasicMaterial({ toneMapped: false, map: phoneScr.tex }));
  pScreen.position.z = 0.235;
  phone.add(pScreen);
  rig.add(phone);

  // Laptop
  const laptop = new THREE.Group();
  const base = new THREE.Mesh(slab(3.4, 2.2, 0.16, 0.14), bodyMat);
  base.rotation.x = -Math.PI / 2;
  base.position.set(0, -0.1, 0);
  laptop.add(base);
  const hinge = new THREE.Group();
  hinge.position.set(0, -0.02, -1.08);
  laptop.add(hinge);
  const lid = new THREE.Mesh(slab(3.4, 2.2, 0.12, 0.14), bodyMat);
  lid.position.set(0, 1.1, 0);
  hinge.add(lid);
  const lapScr = makeScreen(LAP_W * LAP_S, LAP_H * LAP_S);
  const lScreen = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 1.9), new THREE.MeshBasicMaterial({ toneMapped: false, map: lapScr.tex }));
  lScreen.position.set(0, 1.1, 0.175);
  hinge.add(lScreen);
  rig.add(laptop);

  // Beam between phone and laptop, shown while a call is placed
  const beamGeo = new THREE.BufferGeometry();
  beamGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const beamMat = new THREE.LineBasicMaterial({ color: C.amber, transparent: true, opacity: 0 });
  rig.add(new THREE.Line(beamGeo, beamMat));

  const ring = new THREE.Mesh(new THREE.TorusGeometry(4.6, 0.02, 8, 120), new THREE.MeshBasicMaterial({ color: C.blue, transparent: true, opacity: 0.35 }));
  ring.rotation.x = Math.PI / 2.4;
  ring.scale.setScalar(0.66);
  rig.add(ring);

  // Pose and screens. The first objection comes from the chip already pressed in the page.
  const cur = {
    phone: POSE.phone.slice(), phoneR: POSE.phoneR.slice(), phoneS: POSE.phoneS.slice(),
    laptop: POSE.laptop.slice(), laptopR: POSE.laptopR.slice(), lid: POSE.lid.slice(), beam: [0]
  };
  let hop = 0;
  paint(phoneScr, drawPhoneCall, PHONE_S);
  function showObjection(said, answer) {
    paint(lapScr, function (g) { drawLaptopAnswer(g, said, answer); }, LAP_S);
    hop = 1;
  }
  const pressed = document.querySelector('#saidChips [aria-pressed="true"]');
  const answerEl = document.getElementById('answerText');
  showObjection(pressed ? pressed.textContent : 'Too expensive', answerEl ? answerEl.textContent : '');
  document.addEventListener('vca:objection', function (e) {
    const d = e.detail || {};
    if (d.said && d.answer) showObjection(d.said, d.answer);
  });

  // Pointer: a gentle tilt toward the cursor, drag to turn, hover to lift a device, click for the next objection.
  let px = 0, py = 0;
  window.addEventListener('pointermove', function (e) {
    px = e.clientX / window.innerWidth - 0.5;
    py = e.clientY / window.innerHeight - 0.5;
  }, { passive: true });
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let hover = null, drag = null, yaw = 0, pitch = 0, dragYaw = 0, dragPitch = 0, liftP = 0, liftL = 0;
  function hit(e) {
    const b = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1);
    ray.setFromCamera(ndc, cam);
    const h = ray.intersectObjects([phone, laptop], true)[0];
    if (!h) return null;
    let o = h.object;
    while (o && o !== phone && o !== laptop) o = o.parent;
    return o;
  }
  function cursor() { canvas.style.cursor = drag && drag.moved ? 'grabbing' : hover ? 'pointer' : 'grab'; }
  canvas.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, yaw: dragYaw, pitch: dragPitch, moved: false, target: hit(e) };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', function (e) {
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 6) {
        drag.moved = true;
        document.dispatchEvent(new CustomEvent('vca:grab'));
      }
      if (drag.moved) {
        dragYaw = Math.max(-1.1, Math.min(1.1, drag.yaw + dx * 0.008));
        dragPitch = Math.max(-0.35, Math.min(0.35, drag.pitch + dy * 0.004));
      }
    } else {
      hover = hit(e);
    }
    cursor();
  });
  function release(e) {
    if (!drag) return;
    if (!drag.moved && drag.target) document.dispatchEvent(new CustomEvent('vca:pick'));
    drag = null;
    if (e && canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    cursor();
  }
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', function () { if (!drag) { hover = null; cursor(); } });
  cursor();

  let visible = true;
  new IntersectionObserver(function (en) { visible = en[0].isIntersecting; }).observe(canvas);
  // The canvas fills the stage card's visual area; size it whenever that box changes.
  if ('ResizeObserver' in window) new ResizeObserver(function () { sizeTo(r, cam, canvas); }).observe(canvas);
  else window.addEventListener('resize', function () { sizeTo(r, cam, canvas); });
  sizeTo(r, cam, canvas);

  function frame(now) {
    requestAnimationFrame(frame);
    if (!visible || document.hidden) return;
    const t = now / 1000;
    const k = reduce ? 1 : 0.08;
    // The devices are about 5.9 world units wide in their pose; shrink them when the stage is narrower.
    const halfW = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * cam.position.z * cam.aspect;
    const fit = Math.min(1, (2 * halfW * 0.86) / 5.9);

    ease(cur.phone, POSE.phone, k); ease(cur.phoneR, POSE.phoneR, k); ease(cur.phoneS, POSE.phoneS, k);
    ease(cur.laptop, POSE.laptop, k); ease(cur.laptopR, POSE.laptopR, k); ease(cur.lid, POSE.lid, k);
    ease(cur.beam, POSE.beam, k * 0.5);
    // A new objection makes the phone give a small hop.
    hop *= reduce ? 0 : 0.92;

    // Released devices spring back to their pose; the pointer adds a small tilt; a hovered device lifts.
    if (!drag) { dragYaw *= 0.93; dragPitch *= 0.93; }
    const tiltOn = !reduce && !drag;
    yaw += (dragYaw + (tiltOn ? px * 0.3 : 0) - yaw) * 0.12;
    pitch += (dragPitch + (tiltOn ? py * 0.12 : 0) - pitch) * 0.12;
    liftP += ((hover === phone && !drag ? 1 : 0) - liftP) * 0.15;
    liftL += ((hover === laptop && !drag ? 1 : 0) - liftL) * 0.15;
    const sway = reduce ? 0 : Math.sin(t * 1.1) * 0.06;

    rig.position.set(0, -0.1, 0);
    rig.rotation.set(pitch, yaw, 0);

    phone.position.set(cur.phone[0] * fit, cur.phone[1] + sway + liftP * 0.15 + Math.sin((1 - hop) * Math.PI) * hop * 0.35, cur.phone[2] + liftP * 0.3);
    phone.rotation.set(cur.phoneR[0], cur.phoneR[1], cur.phoneR[2]);
    phone.scale.setScalar(cur.phoneS[0] * fit * (1 + liftP * 0.05));

    laptop.position.set(cur.laptop[0] * fit, cur.laptop[1] - sway * 0.5 + liftL * 0.12, cur.laptop[2] + liftL * 0.3);
    laptop.rotation.set(cur.laptopR[0], cur.laptopR[1], cur.laptopR[2]);
    laptop.scale.setScalar(fit * (1 + liftL * 0.04));
    hinge.rotation.x = cur.lid[0];

    const bp = beamGeo.attributes.position.array;
    bp[0] = phone.position.x; bp[1] = phone.position.y; bp[2] = phone.position.z;
    bp[3] = laptop.position.x; bp[4] = laptop.position.y + 0.8; bp[5] = laptop.position.z;
    beamGeo.attributes.position.needsUpdate = true;
    beamMat.opacity = cur.beam[0] * (reduce ? 0.9 : 0.6 + 0.3 * Math.sin(t * 6));

    ring.rotation.z = reduce ? 0 : t * 0.05;
    r.render(scene, cam);
  }
  requestAnimationFrame(frame);
  return true;
}

/* ---------- seats: a grid that lights up with the seat count ---------- */
function initSeats(canvas) {
  const r = renderer(canvas);
  if (!r) return false;
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  cam.position.set(0, 0, 11);
  scene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const key = new THREE.DirectionalLight(0xffffff, 1.0);
  key.position.set(3, 5, 8);
  scene.add(key);

  const COLS = 10, ROWS = 20, MAX = COLS * ROWS, GAP = 0.3, SIZE = 0.2;
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(SIZE, SIZE, SIZE),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.05 }), MAX);
  const idle = new THREE.Color(C.idle), blue = new THREE.Color(C.blue), amber = new THREE.Color(C.amber);
  const cur = new Float32Array(MAX), want = new Float32Array(MAX);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();
  const pos = [];
  for (let i = 0; i < MAX; i++) {
    const c = i % COLS, rw = Math.floor(i / COLS);
    const x = (c - (COLS - 1) / 2) * GAP;
    const y = ((ROWS - 1) / 2 - rw) * GAP;
    pos.push([x, y]);
    mesh.setColorAt(i, idle);
  }
  scene.add(mesh);
  let count = 5;
  function setCount(n) {
    count = Math.max(1, Math.min(MAX, n));
    for (let i = 0; i < MAX; i++) want[i] = i < count ? 1 : 0;
  }
  setCount(5);
  document.addEventListener('vca:seats', function (e) { setCount((e.detail && e.detail.count) || 1); });

  let visible = true;
  new IntersectionObserver(function (en) { visible = en[0].isIntersecting; }).observe(canvas);
  window.addEventListener('resize', function () { sizeTo(r, cam, canvas); });
  sizeTo(r, cam, canvas);

  function frame(now) {
    requestAnimationFrame(frame);
    if (!visible || document.hidden) return;
    const t = now / 1000;
    for (let i = 0; i < MAX; i++) {
      cur[i] += (want[i] - cur[i]) * 0.12;
      const k = 0.3 + cur[i] * 0.7;
      p.set(pos[i][0], pos[i][1] + (reduce ? 0 : Math.sin(t * 2 + i * 0.3) * 0.015 * cur[i]), 0);
      m.compose(p, q, s.set(k, k, k));
      mesh.setMatrixAt(i, m);
      col.copy(idle).lerp(i % 10 === 9 && cur[i] > 0.5 ? amber : blue, cur[i]);
      mesh.setColorAt(i, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    r.render(scene, cam);
  }
  requestAnimationFrame(frame);
  return true;
}

/* ---------- demo phone: rings, times and logs the call from the live demo console ---------- */
function initials(name) { return name.replace(/[^A-Za-z ]/g, '').split(' ').filter(Boolean).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase(); }
function mmss(n) { const m = Math.floor(n / 60), s = n % 60; return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s; }
function drawDemo(g, d) {
  const cx = PHONE_W / 2;
  if (d.state === 'ringing' || d.state === 'live') {
    phoneFrame(g, d.state === 'ringing' ? 'Calling…' : 'On call');
    dot(g, cx, 290, 70, PALE);
    tx(g, initials(d.name), cx, 306, 'bold 44px sans-serif', BLUE_DEEP, 'center');
    tx(g, d.name, cx, 410, 'bold 32px sans-serif', INK, 'center');
    if (d.state === 'ringing') {
      tx(g, 'Ringing…', cx, 480, 'bold 30px sans-serif', MUTED, 'center');
    } else {
      tx(g, mmss(d.secs), cx, 490, 'bold 60px sans-serif', INK, 'center');
    }
    rr(g, cx - 83, 518, 166, 40, 20, MINT_HEX); tx(g, 'On your SIM', cx, 545, 'bold 18px sans-serif', '#ffffff', 'center');
    tx(g, 'The lead sees your number', cx, 590, '17px sans-serif', MUTED, 'center');
    rr(g, 40, 720, 306, 76, 38, '#d6453d'); tx(g, 'Hang up', cx, 767, 'bold 22px sans-serif', '#ffffff', 'center');
  } else if (d.state === 'ended') {
    phoneFrame(g, 'Call ended');
    tx(g, d.name, cx, 300, 'bold 32px sans-serif', INK, 'center');
    tx(g, mmss(d.secs), cx, 370, 'bold 52px sans-serif', INK, 'center');
    tx(g, 'talk time', cx, 402, '17px sans-serif', MUTED, 'center');
    rr(g, 16, 470, 354, 120, 26, '#ffffff');
    tx(g, 'Log the outcome', cx, 520, 'bold 22px sans-serif', INK, 'center');
    tx(g, 'on the laptop', cx, 552, '18px sans-serif', MUTED, 'center');
  } else if (d.state === 'logged') {
    phoneFrame(g, 'Saved');
    dot(g, cx, 300, 74, MINT_HEX);
    g.strokeStyle = '#ffffff'; g.lineWidth = 12; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(cx - 32, 302); g.lineTo(cx - 8, 326); g.lineTo(cx + 36, 276); g.stroke();
    tx(g, d.name, cx, 430, 'bold 30px sans-serif', INK, 'center');
    tx(g, d.outcome || '', cx, 474, 'bold 26px sans-serif', MINT_HEX, 'center');
    tx(g, 'Synced to the admin page', cx, 520, '17px sans-serif', MUTED, 'center');
    rr(g, 16, 600, 354, 74, 37, BLUE); tx(g, 'Next lead is ready', cx, 645, 'bold 20px sans-serif', '#ffffff', 'center');
  } else {
    phoneFrame(g, 'Vector');
    rr(g, 16, 22, 96, 28, 14, 'rgba(255,255,255,.18)'); tx(g, 'Paired', 30, 42, 'bold 15px sans-serif', '#ffffff');
    rr(g, 16, 172, 354, 160, 26, '#ffffff');
    tx(g, 'Ready for calls', 36, 220, 'bold 26px sans-serif', INK);
    dot(g, 44, 262, 7, MINT_HEX); tx(g, 'Link is healthy', 62, 269, 'bold 17px sans-serif', MINT_HEX);
    tx(g, 'Calls ring on your SIM', 36, 306, '17px sans-serif', MUTED);
    rr(g, 16, 352, 354, 128, 26, '#ffffff');
    tx(g, 'Next call from laptop', 36, 394, '16px sans-serif', MUTED);
    tx(g, d.name, 36, 432, 'bold 28px sans-serif', INK);
    rr(g, 16, 506, 354, 74, 37, BLUE); tx(g, 'Press Dial on the laptop', cx, 552, 'bold 20px sans-serif', '#ffffff', 'center');
  }
}

function initDemo(canvas) {
  const r = renderer(canvas);
  if (!r) return false;
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  cam.position.set(0, 0, 7.4);
  scene.add(new THREE.AmbientLight(0xffffff, 1.0));
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(4, 6, 8);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9db8ff, 0.8);
  rim.position.set(-6, 2, -4);
  scene.add(rim);

  const phone = new THREE.Group();
  phone.add(new THREE.Mesh(slab(1.5, 3.1, 0.18, 0.24), new THREE.MeshStandardMaterial({ color: C.bodyDark, metalness: 0.25, roughness: 0.4 })));
  const scr = makeScreen(PHONE_W * PHONE_S, PHONE_H * PHONE_S);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 2.85), new THREE.MeshBasicMaterial({ toneMapped: false, map: scr.tex }));
  face.position.z = 0.235;
  phone.add(face);
  scene.add(phone);

  // Ripples behind the phone while it rings (amber) or while the call is live (mint, slower).
  const waves = [];
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Mesh(new THREE.TorusGeometry(1, 0.025, 8, 96), new THREE.MeshBasicMaterial({ color: C.amber, transparent: true, opacity: 0 }));
    m.position.z = -0.3;
    scene.add(m);
    waves.push(m);
  }

  const first = document.querySelector('.lead[aria-pressed="true"] b');
  const d = { state: 'idle', name: first ? first.textContent : 'Riya S.', secs: 0, outcome: '' };
  let since = 0;
  function repaint() { paint(scr, function (g) { drawDemo(g, d); }, PHONE_S); }
  repaint();
  document.addEventListener('vca:demo', function (e) {
    const n = e.detail || {};
    if (n.state && n.state !== d.state) since = performance.now() / 1000;
    for (const k in n) d[k] = n[k];
    repaint();
  });

  // Drag to turn; it springs back. Elsewhere on the page the pointer tilts it a little.
  let drag = null, dragYaw = 0, yaw = 0, px = 0;
  window.addEventListener('pointermove', function (e) { px = e.clientX / window.innerWidth - 0.5; }, { passive: true });
  canvas.style.cursor = 'grab';
  canvas.addEventListener('pointerdown', function (e) {
    drag = { x: e.clientX, yaw: dragYaw };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', function (e) {
    if (drag) dragYaw = Math.max(-1.3, Math.min(1.3, drag.yaw + (e.clientX - drag.x) * 0.01));
  });
  function release() { drag = null; canvas.style.cursor = 'grab'; }
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  let visible = true;
  new IntersectionObserver(function (en) { visible = en[0].isIntersecting; }).observe(canvas);
  // The figure is hidden until this scene starts, so size the canvas whenever its box changes.
  if ('ResizeObserver' in window) new ResizeObserver(function () { sizeTo(r, cam, canvas); }).observe(canvas);
  else window.addEventListener('resize', function () { sizeTo(r, cam, canvas); });
  sizeTo(r, cam, canvas);

  const amber = new THREE.Color(C.amber), mint = new THREE.Color(C.mint);
  function frame(now) {
    requestAnimationFrame(frame);
    if (!visible || document.hidden) return;
    const t = now / 1000;
    if (!drag) dragYaw *= 0.93;
    yaw += (dragYaw + (reduce ? 0 : px * 0.4) - yaw) * 0.12;
    const ringing = d.state === 'ringing', live = d.state === 'live';
    // A ringing phone buzzes in short bursts; a logged call gives one small hop.
    const buzz = ringing && !reduce && Math.sin(t * 5) > 0 ? Math.sin(t * 70) * 0.04 : 0;
    const hop = d.state === 'logged' && !reduce ? Math.max(0, Math.sin(Math.min(1, t - since) * Math.PI)) * 0.25 : 0;
    phone.rotation.set(-0.08, -0.35 + yaw, buzz);
    phone.position.y = (reduce ? 0 : Math.sin(t * 1.2) * 0.06) + hop;

    for (let i = 0; i < waves.length; i++) {
      const m = waves[i];
      if ((ringing || live) && !reduce) {
        const speed = ringing ? 0.9 : 0.35;
        const k = ((t * speed + i / waves.length) % 1);
        m.scale.set(0.95 + k * 0.8, 1.5 + k * 0.6, 1);
        m.material.opacity = (1 - k) * (ringing ? 0.7 : 0.35);
        m.material.color.copy(ringing ? amber : mint);
      } else {
        m.material.opacity *= 0.85;
      }
    }
    r.render(scene, cam);
  }
  requestAnimationFrame(frame);
  return true;
}

function start() {
  if (!THREE) return;
  const hero = document.getElementById('heroScene');
  const seats = document.getElementById('seatScene');
  if (hero && initHero(hero)) document.documentElement.classList.add('has-3d');
  if (seats) initSeats(seats);
  const demo = document.getElementById('demoScene');
  if (demo && initDemo(demo)) document.documentElement.classList.add('has-demo-3d');
}

start();
