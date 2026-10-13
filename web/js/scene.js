/* 3D visuals for the home page, built on three.js r160 from jsDelivr (exact version pinned).
   - heroScene: a phone and a laptop. Drag to turn them, hover to lift one, click one to show its feature.
     The dock in home.js picks the feature ('vca:chapter'); a click on a device sends 'vca:pick'.
   - demoScene: the rep's phone beside the live demo. It rings, times and logs the call ('vca:demo').
   - seatScene: a grid of seats; the number lit follows the seat count in the pricing calculator.
   If WebGL or the module fails, nothing is added to the page and the static fallback stays visible. */
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

/* ---------- hero: the dock or a click picks the chapter; the devices move and the screens change. ---------- */
const PHONE_W = 386, PHONE_H = 846, PHONE_S = 2, LAP_W = 640, LAP_H = 405, LAP_S = 2;
const INK = '#0e1628', MUTED = '#56617a', BLUE = '#2456e6', BLUE_DEEP = '#1a42b8', MINT_HEX = '#0b8f6a', PALE = '#e6edff';
/* Each chapter is a target pose. Arrays so they can be eased one by one. */
const CHAPTERS = [
  { phone: [-2.2, 0.6, 1.2], phoneR: [0, -0.4, 0.06], phoneS: [1], laptop: [1.2, -0.6, 0], laptopR: [0.2, -0.35, 0], lid: [-0.45], beam: [0], team: [0] },
  { phone: [-0.4, 0.3, 2.2], phoneR: [0, 0.25, 0], phoneS: [1.15], laptop: [1.2, -0.9, -1.2], laptopR: [0.1, -0.7, 0], lid: [-0.5], beam: [0], team: [0] },
  { phone: [-0.2, 0.5, 1.6], phoneR: [0, -0.3, 0.05], phoneS: [1.1], laptop: [1.4, -0.7, -0.2], laptopR: [0.15, -0.4, 0], lid: [-0.5], beam: [1], team: [0] },
  { phone: [-1.2, -1.2, 0.2], phoneR: [0, 0.4, 0], phoneS: [0.7], laptop: [0.5, -0.4, 1.0], laptopR: [0.05, -0.1, 0], lid: [-0.3], beam: [0], team: [0] },
  { phone: [-1.6, -1.4, -0.6], phoneR: [0, 0.5, 0], phoneS: [0.6], laptop: [0.4, -0.3, 0.6], laptopR: [0.05, -0.05, 0], lid: [-0.25], beam: [0], team: [0] },
  { phone: [-1.6, -1.9, -1], phoneR: [0, 0.6, 0], phoneS: [0.4], laptop: [0.0, 0.6, -2.5], laptopR: [0.1, 0, 0], lid: [-0.2], beam: [0], team: [1] }
];

function rr(g, x, y, w, h, r, fill) { g.fillStyle = fill; g.beginPath(); g.roundRect(x, y, w, h, r); g.fill(); }
function tx(g, s, x, y, font, fill, align) { g.font = font; g.fillStyle = fill; g.textAlign = align || 'left'; g.fillText(s, x, y); g.textAlign = 'left'; }
function dot(g, x, y, r, fill) { g.fillStyle = fill; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); }
function qrCard(g, x, y, s, n) {
  // Decorative code art for the mock-up. It is not a scannable code.
  g.fillStyle = '#ffffff'; g.fillRect(x - 10, y - 10, n * s + 20, n * s + 20);
  g.fillStyle = INK;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const finder = (i < 3 && j < 3) || (i > n - 4 && j < 3) || (i < 3 && j > n - 4);
    if (finder || ((i * 7 + j * 13 + i * j) % 5) < 2) g.fillRect(x + i * s, y + j * s, s - 1.5, s - 1.5);
  }
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
const PHONE_DRAW = [
  // 0: paired and ready
  function (g) {
    phoneFrame(g, 'Vector');
    rr(g, 16, 22, 96, 28, 14, 'rgba(255,255,255,.18)'); tx(g, 'Paired', 30, 42, 'bold 15px sans-serif', '#ffffff');
    rr(g, 16, 172, 354, 206, 26, '#ffffff');
    tx(g, 'Connected to laptop', 36, 220, 'bold 26px sans-serif', INK);
    tx(g, 'Calls ring on your SIM', 36, 254, '18px sans-serif', MUTED);
    dot(g, 44, 290, 7, MINT_HEX); tx(g, 'Link is healthy', 62, 297, 'bold 17px sans-serif', MINT_HEX);
    rr(g, 16, 398, 354, 128, 26, '#ffffff');
    tx(g, 'Next call from laptop', 36, 440, '16px sans-serif', MUTED);
    tx(g, 'Ananya Rao', 36, 478, 'bold 26px sans-serif', INK);
    tx(g, 'Offer: September intake', 36, 506, '16px sans-serif', MUTED);
    rr(g, 16, 548, 354, 74, 37, BLUE); tx(g, 'Waiting for the laptop', PHONE_W / 2, 596, 'bold 20px sans-serif', '#ffffff', 'center');
    tx(g, 'Lead details stay on the laptop', PHONE_W / 2, 670, '16px sans-serif', MUTED, 'center');
  },
  // 1: pairing with the QR code
  function (g) {
    phoneFrame(g, 'Pair with laptop');
    rr(g, 16, 176, 354, 380, 26, '#ffffff');
    qrCard(g, PHONE_W / 2 - 115, 216, 14, 17);
    tx(g, 'Open Vector on the laptop', 36, 620, 'bold 22px sans-serif', INK);
    tx(g, 'Then scan the code shown there', 36, 652, '17px sans-serif', MUTED);
    rr(g, 16, 700, 354, 72, 36, BLUE); tx(g, 'Scan code', PHONE_W / 2, 744, 'bold 20px sans-serif', '#ffffff', 'center');
  },
  // 2: on a call
  function (g) {
    phoneFrame(g, 'On call');
    dot(g, PHONE_W / 2, 300, 66, '#e6edff');
    tx(g, 'AR', PHONE_W / 2, 314, 'bold 40px sans-serif', BLUE_DEEP, 'center');
    tx(g, 'Ananya Rao', PHONE_W / 2, 412, 'bold 30px sans-serif', INK, 'center');
    tx(g, '00:42', PHONE_W / 2, 486, 'bold 58px sans-serif', INK, 'center');
    rr(g, 110, 510, 166, 40, 20, MINT_HEX); tx(g, 'On your SIM', PHONE_W / 2, 537, 'bold 18px sans-serif', '#ffffff', 'center');
    tx(g, 'The lead sees your number', PHONE_W / 2, 580, '17px sans-serif', MUTED, 'center');
    rr(g, 40, 720, 306, 76, 38, '#d6453d'); tx(g, 'Hang up', PHONE_W / 2, 767, 'bold 22px sans-serif', '#ffffff', 'center');
  },
  // 3: the script, one step at a time
  function (g) {
    phoneFrame(g, 'Script');
    tx(g, 'Step 3 of 4', 24, 186, 'bold 16px sans-serif', MUTED);
    const steps = [['Greet', 'done'], ['Ask', 'done'], ['Offer', 'now'], ['Close', 'next']];
    for (let i = 0; i < 4; i++) {
      const y = 206 + i * 130, st = steps[i][1];
      rr(g, 16, y, 354, 110, 22, st === 'now' ? '#ffffff' : 'rgba(255,255,255,.7)');
      if (st === 'now') { g.strokeStyle = BLUE; g.lineWidth = 3; g.beginPath(); g.roundRect(18, y + 2, 350, 106, 20); g.stroke(); }
      dot(g, 56, y + 55, 18, st === 'done' ? MINT_HEX : st === 'now' ? BLUE : '#c9d3e6');
      tx(g, steps[i][0], 92, y + 64, 'bold 24px sans-serif', st === 'next' ? MUTED : INK);
    }
    tx(g, 'Next line: "The offer closes on the 14th."', 24, 760, '17px sans-serif', INK);
  },
  // 4: log the outcome
  function (g) {
    phoneFrame(g, 'Log outcome');
    const opts = [['Answered', '#0b8f6a', '#e5f5ef'], ['No answer', '#56617a', '#eef1f6'], ['Callback', BLUE, PALE], ['Won', '#b97a00', '#fff4dc']];
    for (let i = 0; i < 4; i++) {
      const x = 16 + (i % 2) * 180, y = 180 + Math.floor(i / 2) * 170;
      rr(g, x, y, 170, 150, 24, opts[i][2]);
      dot(g, x + 40, y + 50, 14, opts[i][1]);
      tx(g, opts[i][0], x + 24, y + 116, 'bold 21px sans-serif', INK);
    }
    tx(g, 'Saved on the laptop first.', 24, 606, 'bold 18px sans-serif', INK);
    tx(g, 'It uploads when the connection is back.', 24, 634, '16px sans-serif', MUTED);
    rr(g, 16, 668, 354, 60, 30, '#ffffff'); tx(g, 'Undo last outcome', PHONE_W / 2, 706, 'bold 18px sans-serif', BLUE_DEEP, 'center');
  },
  // 5: the team today
  function (g) {
    phoneFrame(g, 'Team today');
    const stats = [['62', 'calls'], ['18', 'connected'], ['4', 'callbacks']];
    for (let i = 0; i < 3; i++) {
      const x = 16 + i * 120;
      rr(g, x, 176, 110, 110, 22, '#ffffff');
      tx(g, stats[i][0], x + 18, 236, 'bold 36px sans-serif', INK);
      tx(g, stats[i][1], x + 18, 266, '15px sans-serif', MUTED);
    }
    const reps = [['Ravi', 0.9], ['Meera', 0.7], ['Arjun', 0.8], ['Nisha', 0.5]];
    for (let i = 0; i < 4; i++) {
      const y = 320 + i * 118;
      rr(g, 16, y, 354, 102, 22, '#ffffff');
      tx(g, reps[i][0], 36, y + 42, 'bold 21px sans-serif', INK);
      tx(g, 'connect rate', 36, y + 68, '15px sans-serif', MUTED);
      rr(g, 180, y + 36, 170, 14, 7, PALE); rr(g, 180, y + 36, 170 * reps[i][1], 14, 7, i === 2 ? '#f5a524' : BLUE);
    }
  }
];

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
const LAPTOP_DRAW = [
  // 0: the call, step 2 of 4
  function (g) {
    lapFrame(g, 'Today');
    tx(g, 'STEP 2 OF 4 · ASK', 176, 40, 'bold 13px monospace', MUTED);
    rr(g, 176, 56, 84, 8, 4, BLUE); rr(g, 266, 56, 84, 8, 4, BLUE); rr(g, 356, 56, 84, 8, 4, PALE); rr(g, 446, 56, 84, 8, 4, PALE);
    rr(g, 176, 92, 440, 176, 18, '#f3f6fc');
    tx(g, '"Is this a good time for two', 200, 146, 'bold 25px sans-serif', INK);
    tx(g, 'minutes about the offer you', 200, 182, 'bold 25px sans-serif', INK);
    tx(g, 'asked about?"', 200, 218, 'bold 25px sans-serif', INK);
    rr(g, 176, 290, 170, 46, 23, BLUE); tx(g, 'Next line', 261, 320, 'bold 17px sans-serif', '#ffffff', 'center');
    tx(g, 'Ananya Rao · +91 98•••• 210', 176, 388, '15px sans-serif', MUTED);
  },
  // 1: pairing
  function (g) {
    lapFrame(g, 'Today');
    tx(g, 'Pair your phone', 176, 96, 'bold 30px sans-serif', INK);
    tx(g, '1. Open Vector on the Android phone', 176, 146, '18px sans-serif', INK);
    tx(g, '2. Tap "Scan code"', 176, 180, '18px sans-serif', INK);
    tx(g, '3. Point the phone at the code', 176, 214, '18px sans-serif', INK);
    qrCard(g, 420, 96, 11, 17);
    tx(g, 'Calls will ring on the phone SIM', 176, 340, '16px sans-serif', MUTED);
  },
  // 2: dialing
  function (g) {
    lapFrame(g, 'Today');
    tx(g, 'Calling Ananya Rao', 176, 96, 'bold 30px sans-serif', INK);
    tx(g, 'Ringing on your SIM', 176, 134, '18px sans-serif', MUTED);
    rr(g, 176, 166, 440, 14, 7, PALE); rr(g, 176, 166, 250, 14, 7, BLUE);
    tx(g, '00:42', 176, 252, 'bold 56px sans-serif', INK);
    rr(g, 176, 280, 180, 40, 20, MINT_HEX); tx(g, 'Connected', 266, 306, 'bold 17px sans-serif', '#ffffff', 'center');
    rr(g, 380, 280, 130, 40, 20, '#d6453d'); tx(g, 'Hang up', 445, 306, 'bold 17px sans-serif', '#ffffff', 'center');
  },
  // 3: script, current step with objection branches
  function (g) {
    lapFrame(g, 'Script');
    tx(g, 'Step 3 of 4 · Offer', 176, 40, 'bold 13px monospace', MUTED);
    const steps = ['Greet', 'Ask', 'Offer', 'Close'];
    for (let i = 0; i < 4; i++) {
      const on = i === 2, y = 62 + i * 46;
      rr(g, 176, y, 440, 38, 10, on ? BLUE : '#eef2fb');
      tx(g, steps[i], 194, y + 25, 'bold 17px sans-serif', on ? '#ffffff' : INK);
    }
    tx(g, 'Say: "The offer closes on the 14th."', 176, 270, 'bold 20px sans-serif', INK);
    rr(g, 176, 296, 210, 36, 18, '#fff4dc'); tx(g, 'Too expensive', 281, 320, 'bold 15px sans-serif', INK, 'center');
    rr(g, 398, 296, 218, 36, 18, '#fff4dc'); tx(g, 'Need to ask parents', 507, 320, 'bold 15px sans-serif', INK, 'center');
  },
  // 4: outcome
  function (g) {
    lapFrame(g, 'Today');
    tx(g, 'Log the outcome', 176, 96, 'bold 30px sans-serif', INK);
    const labels = ['Answered', 'No answer', 'Callback', 'Won'];
    for (let i = 0; i < 4; i++) {
      const on = i === 2, x = 176 + i * 112;
      rr(g, x, 124, 102, 64, 14, on ? BLUE : '#eef2fb');
      tx(g, labels[i], x + 51, 162, 'bold 15px sans-serif', on ? '#ffffff' : INK, 'center');
    }
    tx(g, 'Callback on', 176, 236, 'bold 18px sans-serif', INK);
    rr(g, 176, 252, 240, 44, 12, '#f3f6fc'); tx(g, 'Tomorrow, 10:00', 196, 281, '17px sans-serif', INK);
    tx(g, 'Saved on this laptop first, then uploaded.', 176, 340, '15px sans-serif', MUTED);
    tx(g, 'Undo last outcome', 176, 370, 'bold 15px sans-serif', BLUE_DEEP);
  },
  // 5: the team this week
  function (g) {
    lapFrame(g, 'Results');
    tx(g, 'This week', 176, 96, 'bold 30px sans-serif', INK);
    const tiles = [['312', 'calls'], ['118', 'connected'], ['21', 'callbacks']];
    for (let i = 0; i < 3; i++) {
      const x = 176 + i * 152;
      rr(g, x, 118, 140, 80, 16, '#f3f6fc');
      tx(g, tiles[i][0], x + 18, 160, 'bold 30px sans-serif', INK);
      tx(g, tiles[i][1], x + 18, 186, '14px sans-serif', MUTED);
    }
    const reps = [['Ravi', 0.9, 22], ['Meera', 0.7, 17], ['Arjun', 0.8, 19], ['Nisha', 0.5, 12]];
    for (let i = 0; i < 4; i++) {
      const y = 232 + i * 40;
      tx(g, reps[i][0], 176, y + 22, 'bold 15px sans-serif', INK);
      rr(g, 280, y + 8, 260, 14, 7, PALE); rr(g, 280, y + 8, 260 * reps[i][1], 14, 7, i === 2 ? '#f5a524' : BLUE);
      tx(g, reps[i][2] + ' calls', 556, y + 22, 'bold 14px sans-serif', INK, 'right');
    }
  }
];

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
  cam.position.set(0, 0.2, 13);
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

  // Team: six seat cards in a row, shown in the Team chapter
  const team = new THREE.Group();
  rig.add(team);
  const cellGeo = slab(0.9, 0.6, 0.05, 0.08);
  const cells = [];
  for (let i = 0; i < 6; i++) {
    const m = new THREE.Mesh(cellGeo, new THREE.MeshStandardMaterial({ color: i === 2 ? C.amber : C.blue, roughness: 0.4 }));
    m.position.set((i - 2.5) * 1.2, 0, 0);
    m.scale.setScalar(0);
    team.add(m);
    cells.push(m);
  }

  const ring = new THREE.Mesh(new THREE.TorusGeometry(4.6, 0.02, 8, 120), new THREE.MeshBasicMaterial({ color: C.blue, transparent: true, opacity: 0.35 }));
  ring.rotation.x = Math.PI / 2.4;
  rig.add(ring);

  // Chapter state
  const cur = {
    phone: CHAPTERS[0].phone.slice(), phoneR: CHAPTERS[0].phoneR.slice(), phoneS: CHAPTERS[0].phoneS.slice(),
    laptop: CHAPTERS[0].laptop.slice(), laptopR: CHAPTERS[0].laptopR.slice(), lid: CHAPTERS[0].lid.slice(),
    beam: CHAPTERS[0].beam.slice(), team: CHAPTERS[0].team.slice()
  };
  let goal = CHAPTERS[0], painted = -1;
  function paintChapter(i) {
    paint(phoneScr, PHONE_DRAW[i], PHONE_S);
    paint(lapScr, LAPTOP_DRAW[i], LAP_S);
    painted = i;
  }
  paintChapter(0);
  let chapter = 0;
  document.addEventListener('vca:chapter', function (e) {
    const i = e.detail && e.detail.index;
    if (typeof i !== 'number' || !CHAPTERS[i]) return;
    chapter = i;
    goal = CHAPTERS[i];
    if (i !== painted) paintChapter(i);
  });

  // Pointer: a gentle tilt toward the cursor, drag to turn, hover to lift a device, click to pick its feature.
  // Phone: Call, then Outcome. Laptop: Script, then Team.
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
    if (!drag.moved && drag.target) {
      const onPhone = drag.target === phone;
      const first = onPhone ? 2 : 3, second = onPhone ? 4 : 5;
      document.dispatchEvent(new CustomEvent('vca:pick', { detail: { index: chapter === first ? second : first } }));
    }
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
  window.addEventListener('resize', function () { sizeTo(r, cam, canvas); });
  // Desktop: the free space for the devices runs from the text card's right edge to the screen's right gutter.
  // Measured in screen fractions on load and resize; the frame loop turns it into world units.
  const slot = document.querySelector('.slot');
  let freeL = 0.42, freeR = 0.96;
  function measure() {
    const cw = canvas.clientWidth || 1, cr = canvas.getBoundingClientRect();
    const sr = slot ? slot.getBoundingClientRect() : null;
    const gutter = parseFloat(getComputedStyle(slot || canvas).getPropertyValue('--gutter')) || 64;
    if (sr) freeL = (sr.right - cr.left + 24) / cw;
    freeR = (cw - gutter) / cw;
  }
  window.addEventListener('resize', measure);
  sizeTo(r, cam, canvas);
  measure();

  function frame(now) {
    requestAnimationFrame(frame);
    if (!visible || document.hidden) return;
    const t = now / 1000;
    const k = reduce ? 1 : 0.08;
    const narrow = window.innerWidth < 960;
    // Desktop: the devices sit on the right, the text on the left. Phone: devices sit above the text.
    // On a narrow (portrait) screen the camera pulls back far enough for both devices to fit the width,
    // and the devices are raised into the space above the text panel.
    const halfTan = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const camZ = narrow ? Math.min(26, Math.max(15, 2.85 / (halfTan * cam.aspect))) : 13;
    // Desktop: centre the devices in the free space and shrink them when it is narrower than the 6.4 world
    // units the chapter positions were drawn for (1440px wide with the card at the screen edge).
    const halfW = halfTan * camZ * cam.aspect;
    const fit = narrow ? 1 : Math.min(1, ((freeR - freeL) * 2 * halfW) / 6.4);
    const xs = narrow ? 0 : ((freeL + freeR) / 2 - 0.5) * 2 * halfW - 0.4 * fit;
    const xk = narrow ? 0.6 : fit, yo = narrow ? halfTan * camZ * 0.36 : 0;
    cam.position.z = camZ;

    ease(cur.phone, goal.phone, k); ease(cur.phoneR, goal.phoneR, k); ease(cur.phoneS, goal.phoneS, k);
    ease(cur.laptop, goal.laptop, k); ease(cur.laptopR, goal.laptopR, k); ease(cur.lid, goal.lid, k);
    ease(cur.beam, goal.beam, k); ease(cur.team, goal.team, k);

    // Released devices spring back to their pose; the pointer adds a small tilt; a hovered device lifts.
    if (!drag) { dragYaw *= 0.93; dragPitch *= 0.93; }
    const tiltOn = !reduce && !drag;
    yaw += (dragYaw + (tiltOn ? px * 0.3 : 0) - yaw) * 0.12;
    pitch += (dragPitch + (tiltOn ? py * 0.12 : 0) - pitch) * 0.12;
    liftP += ((hover === phone && !drag ? 1 : 0) - liftP) * 0.15;
    liftL += ((hover === laptop && !drag ? 1 : 0) - liftL) * 0.15;
    const sway = reduce ? 0 : Math.sin(t * 1.1) * 0.06;

    rig.position.set(xs, yo, 0);
    rig.rotation.set(pitch, yaw, 0);

    phone.position.set(cur.phone[0] * xk, cur.phone[1] + sway + liftP * 0.15, cur.phone[2] + liftP * 0.3);
    phone.rotation.set(cur.phoneR[0], cur.phoneR[1], cur.phoneR[2]);
    phone.scale.setScalar(cur.phoneS[0] * fit * (1 + liftP * 0.05));

    laptop.position.set(cur.laptop[0] * xk, cur.laptop[1] - sway * 0.5 + liftL * 0.12, cur.laptop[2] + liftL * 0.3);
    laptop.rotation.set(cur.laptopR[0], cur.laptopR[1], cur.laptopR[2]);
    laptop.scale.setScalar(fit * (1 + liftL * 0.04));
    hinge.rotation.x = cur.lid[0];

    const bp = beamGeo.attributes.position.array;
    bp[0] = phone.position.x; bp[1] = phone.position.y; bp[2] = phone.position.z;
    bp[3] = laptop.position.x; bp[4] = laptop.position.y + 0.8; bp[5] = laptop.position.z;
    beamGeo.attributes.position.needsUpdate = true;
    beamMat.opacity = cur.beam[0] * (reduce ? 0.9 : 0.6 + 0.3 * Math.sin(t * 6));

    team.position.set(0, -2.6, 0);
    team.scale.setScalar(fit);
    for (let i = 0; i < cells.length; i++) {
      cells[i].scale.setScalar(Math.max(0, cur.team[0]));
    }

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
    const label = document.getElementById('seatLabel');
    if (label) label.textContent = count + ' of ' + MAX;
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
