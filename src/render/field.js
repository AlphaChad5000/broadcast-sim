// The field, the stadium around it, and the things painted on the grass.
//
// Three.js space: one unit = one yard, y up. Field x (0 = home goal line,
// 100 = away goal line) maps to three x = fieldX - 50; field y (across) maps
// to three z = -fieldY, so a camera on the +z sideline sees the home end
// zone on the left, like a broadcast from the press box side.

import * as THREE from 'three';

export const toThree = (x, y, z = 0) => new THREE.Vector3(x - 50, z, -y);
const W = 53.333;

function fieldTexture(home, away, maxAniso) {
  const PX = 24; // pixels per yard
  const c = document.createElement('canvas');
  c.width = 120 * PX; c.height = Math.round(W * PX);
  const g = c.getContext('2d');
  const X = yd => (yd + 10) * PX; // canvas x for field x
  const Y = yd => c.height / 2 - yd * PX; // canvas y for field y (y up)
  // mowed stripes, 5 yards each
  for (let k = 0; k < 24; k++) {
    g.fillStyle = k % 2 ? '#2f6b2a' : '#367a30';
    g.fillRect(k * 5 * PX, 0, 5 * PX, c.height);
  }
  // end zones
  const endZone = (x0, team, flip) => {
    g.fillStyle = team.color;
    g.globalAlpha = 0.92;
    g.fillRect(X(x0), 0, 10 * PX, c.height);
    g.globalAlpha = 1;
    g.save();
    g.translate(X(x0 + 5), c.height / 2);
    g.rotate(flip ? Math.PI / 2 : -Math.PI / 2);
    g.fillStyle = '#ffffff';
    g.strokeStyle = team.alt;
    g.lineWidth = PX * 0.25;
    g.font = `900 ${PX * 6.2}px "Arial Black", Impact, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const word = (team.name || team.abbr).toUpperCase();
    const s = Math.min(1, (W * PX * 0.82) / g.measureText(word).width);
    g.scale(s, 1);
    g.strokeText(word, 0, 0);
    g.fillText(word, 0, 0);
    g.restore();
  };
  endZone(-10, home, false);
  endZone(100, away, true);
  // lines
  g.fillStyle = '#f4f4ef';
  const line = (x, w = 0.12) => g.fillRect(X(x) - (w * PX) / 2, Y(W / 2), w * PX, W * PX);
  for (let x = 0; x <= 100; x += 5) line(x, x === 0 || x === 100 ? 0.22 : 0.12);
  line(-10, 0.22); line(110, 0.22);
  g.fillRect(X(-10), Y(W / 2), 120 * PX, 0.22 * PX); // sidelines
  g.fillRect(X(-10), Y(-W / 2) - 0.22 * PX, 120 * PX, 0.22 * PX);
  // hash marks and the sideline ticks every yard
  for (let x = 1; x < 100; x++) {
    if (x % 5 === 0) continue;
    for (const hy of [3.08, -3.08]) g.fillRect(X(x) - 1, Y(hy) - 0.33 * PX, 2, 0.67 * PX);
    for (const sy of [W / 2 - 0.3, -W / 2 + 0.3]) g.fillRect(X(x) - 1, Y(sy) - 0.33 * PX, 2, 0.67 * PX);
    for (const sy of [W / 2 - 9, -W / 2 + 9]) g.fillRect(X(x) - 1, Y(sy) - 0.33 * PX, 2, 0.33 * PX);
  }
  // two-point tries
  g.fillRect(X(2) - 0.5 * PX, Y(0) - 1, PX, 3);
  g.fillRect(X(98) - 0.5 * PX, Y(0) - 1, PX, 3);
  // numbers
  g.font = `bold ${PX * 2}px "Clarendon", "Rockwell", Georgia, serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let x = 10; x <= 90; x += 10) {
    const n = String(x <= 50 ? x : 100 - x);
    for (const [ny, rot] of [[-W / 2 + 12, 0], [W / 2 - 12, Math.PI]]) {
      g.save();
      g.translate(X(x), Y(ny));
      g.rotate(rot);
      g.fillText(n[0] + '  ' + (n[1] || ''), 0, 0);
      // direction arrows toward the nearer goal
      if (x !== 50) {
        const ax = (x < 50 ? -1 : 1) * (rot ? -1 : 1) * PX * 1.9;
        g.beginPath();
        g.moveTo(ax + (x < 50 ? -1 : 1) * (rot ? -1 : 1) * PX * 0.45, -PX * 0.35);
        g.lineTo(ax, -PX * 0.65);
        g.lineTo(ax, -PX * 0.05);
        g.closePath();
        g.fill();
      }
      g.restore();
    }
  }
  // midfield logo: the home team's mark
  g.save();
  g.translate(X(50), Y(0));
  g.beginPath();
  g.arc(0, 0, PX * 4.6, 0, Math.PI * 2);
  g.fillStyle = home.color;
  g.fill();
  g.lineWidth = PX * 0.35;
  g.strokeStyle = home.alt;
  g.stroke();
  g.fillStyle = '#fff';
  g.font = `900 ${PX * 3}px "Arial Black", Impact, sans-serif`;
  g.fillText(home.abbr, 0, PX * 0.15);
  g.restore();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  return tex;
}

export function buildStadium(scene, game, renderer) {
  const group = new THREE.Group();
  scene.add(group);
  const aniso = renderer.capabilities.getMaxAnisotropy();

  // surround: the turf around the field, then a wall, then stands
  const surround = new THREE.Mesh(new THREE.PlaneGeometry(150, 88), new THREE.MeshStandardMaterial({ color: 0x2a5a26, roughness: 1 }));
  surround.rotation.x = -Math.PI / 2;
  surround.position.y = -0.02;
  surround.receiveShadow = true;
  group.add(surround);

  const field = new THREE.Mesh(new THREE.PlaneGeometry(120, W), new THREE.MeshStandardMaterial({ map: fieldTexture(game.home, game.away, aniso), roughness: 0.95 }));
  field.rotation.x = -Math.PI / 2;
  field.receiveShadow = true;
  group.add(field);

  // team benches areas: a painted box on each sideline
  for (const [z, team] of [[-W / 2 - 6, game.home], [W / 2 + 6, game.away]]) {
    const box = new THREE.Mesh(new THREE.PlaneGeometry(40, 5), new THREE.MeshStandardMaterial({ color: new THREE.Color(team.color).lerp(new THREE.Color(0x2a5a26), 0.55), roughness: 1 }));
    box.rotation.x = -Math.PI / 2;
    box.position.set(0, -0.01, z);
    box.receiveShadow = true;
    group.add(box);
  }

  // goalposts: single standard, crossbar at 10 ft, uprights 18'6" apart
  const postMat = new THREE.MeshStandardMaterial({ color: 0xf2d22e, roughness: 0.5, metalness: 0.2 });
  for (const gx of [-10, 110]) {
    const g = new THREE.Group();
    const s = gx < 0 ? -1 : 1;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 3.33, 12), postMat);
    base.position.set(s * 2, 1.66, 0);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 2, 12), postMat);
    neck.rotation.z = Math.PI / 2;
    neck.position.set(s * 1, 3.33, 0);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 6.17, 12), postMat);
    bar.rotation.x = Math.PI / 2;
    bar.position.set(0, 3.33, 0);
    g.add(base, neck, bar);
    for (const uz of [-3.08, 3.08]) {
      const up = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 10, 10), postMat);
      up.position.set(0, 3.33 + 5, uz);
      g.add(up);
      const ribbon = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 1.3), new THREE.MeshBasicMaterial({ color: 0xff3b1f, side: THREE.DoubleSide }));
      ribbon.position.set(0.05, 13.0, uz);
      g.add(ribbon);
    }
    g.position.set(gx - 50, 0, 0);
    g.traverse(o => { o.castShadow = true; });
    group.add(g);
  }

  // pylons at the eight corners of the end zones
  const pylonMat = new THREE.MeshStandardMaterial({ color: 0xff6a00, roughness: 0.6 });
  for (const px of [-10, 0, 100, 110]) for (const pz of [-W / 2, W / 2]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.5, 0.11), pylonMat);
    p.position.set(px - 50, 0.25, pz);
    group.add(p);
  }

  // stands: tiered bowls on all four sides with an instanced crowd
  const standMat = new THREE.MeshStandardMaterial({ color: 0x2c2f36, roughness: 0.9 });
  // mostly the home colors, some visitors, a lot of plain clothes; kept dim
  // so the field stays the brightest thing in the picture
  const crowdColors = [game.home.color, game.home.color, game.home.color, game.home.alt, game.away.color, '#c9c9c4', '#2a2a2a', '#3b3f48', '#7b6a58', '#5a4a3c'].map(c => new THREE.Color(c));
  const seats = [];
  const tiers = 26;
  const addSide = (cx, cz, len, rot, near) => {
    for (let r = 0; r < tiers; r++) {
      const depth = near + r * 1.0;
      const h = 1.2 + r * 0.62;
      const step = new THREE.Mesh(new THREE.BoxGeometry(len + r * 2.1, 0.62, 1.0), standMat);
      const ox = Math.sin(rot) * depth, oz = Math.cos(rot) * depth;
      step.position.set(cx + ox, h - 0.31, cz + oz);
      step.rotation.y = rot;
      step.receiveShadow = true;
      group.add(step);
      for (let k = 0; k < (len + r * 2.1) / 0.55; k++) {
        if (Math.random() < 0.08) continue;
        const along = -((len + r * 2.1) / 2) + k * 0.55 + Math.random() * 0.1;
        seats.push([cx + ox + Math.cos(rot) * along, h + 0.25, cz + oz - Math.sin(rot) * along]);
      }
    }
  };
  addSide(0, W / 2 + 13, 128, 0, 0);            // near sideline, under the camera
  addSide(0, -(W / 2 + 13), 128, Math.PI, 0);   // far sideline, the backdrop
  addSide(-(60 + 11), 0, 58, -Math.PI / 2, 0);  // home end
  addSide(60 + 11, 0, 58, Math.PI / 2, 0);      // away end
  const crowd = new THREE.InstancedMesh(new THREE.BoxGeometry(0.42, 0.62, 0.36), new THREE.MeshStandardMaterial({ roughness: 1 }), seats.length);
  const m = new THREE.Matrix4();
  seats.forEach((s, i) => {
    m.makeTranslation(s[0], s[1], s[2]);
    crowd.setMatrixAt(i, m);
    crowd.setColorAt(i, crowdColors[Math.floor(Math.random() * crowdColors.length)].clone().multiplyScalar(0.32 + Math.random() * 0.38));
  });
  crowd.userData.base = seats;
  group.add(crowd);

  // light towers
  const towerMat = new THREE.MeshStandardMaterial({ color: 0x555a63, roughness: 0.7 });
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xfffbe8 });
  for (const tx of [-55, 55]) for (const tz of [-58, 58]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.8, 46, 8), towerMat);
    pole.position.set(tx, 23, tz);
    const bank = new THREE.Mesh(new THREE.BoxGeometry(9, 4, 0.6), lampMat);
    bank.position.set(tx, 46, tz);
    bank.lookAt(0, 0, 0);
    group.add(pole, bank);
  }

  // first-down chains on the far sideline
  const chainMat = new THREE.MeshStandardMaterial({ color: 0xff7a00, emissive: 0x331500 });
  const stick = () => {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.6, 8), new THREE.MeshStandardMaterial({ color: 0x222222 }));
    pole.position.y = 1.3;
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.08), chainMat);
    top.position.y = 2.75;
    g.add(pole, top);
    g.traverse(o => { o.castShadow = true; });
    return g;
  };
  const chains = { los: stick(), fd: stick() };
  chains.los.position.z = -(W / 2 + 2.2);
  chains.fd.position.z = -(W / 2 + 2.2);
  group.add(chains.los, chains.fd);

  // broadcast lines: line of scrimmage (blue) and the line to gain (yellow)
  const mkLine = color => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.22, W), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.015;
    mesh.renderOrder = 2;
    group.add(mesh);
    return mesh;
  };
  const lines = { los: mkLine(0x2f7bff), fd: mkLine(0xffd400) };

  return { group, crowd, chains, lines };
}
