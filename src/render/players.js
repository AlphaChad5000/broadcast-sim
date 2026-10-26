// Bodies: 22 players and 4 officials, posed procedurally from the clip.
//
// A body is built facing +x with its feet at the origin. `root` carries the
// field position and heading; `body` tilts about the feet (lean, dive, lie
// down); limbs swing about hips and shoulders. The home team wears its color,
// the visitors wear white with color numbers, as on Sundays.

import * as THREE from 'three';
import { POSE } from '../football/choreo.js';

function jerseyTexture(bg, fg, outline, number) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = bg;
  g.fillRect(0, 0, 256, 128);
  // shoulder stripes
  g.fillStyle = outline;
  g.fillRect(0, 8, 256, 6);
  g.font = '900 72px "Arial Black", Impact, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 8;
  g.strokeStyle = outline;
  g.fillStyle = fg;
  for (const x of [64, 192]) {
    g.strokeText(number, x, 72);
    g.fillText(number, x, 72);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function stripeTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 16;
  const g = c.getContext('2d');
  for (let k = 0; k < 16; k++) { g.fillStyle = k % 2 ? '#111' : '#f2f2f2'; g.fillRect(k * 8, 0, 8, 16); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const limb = (r, len, mat) => {
  const geo = new THREE.CylinderGeometry(r, r * 0.85, len, 8);
  geo.translate(0, -len / 2, 0); // pivot at the top
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  return m;
};

class Body {
  constructor(kind, colors) {
    this.kind = kind;
    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.body);
    const { jersey, pants, helmet, skin, sock } = colors;
    this.jerseyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: jersey, roughness: 0.75 });
    const pantsMat = new THREE.MeshStandardMaterial({ color: pants, roughness: 0.8 });
    const skinMat = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.8 });
    const sockMat = new THREE.MeshStandardMaterial({ color: sock, roughness: 0.8 });
    const helmetMat = new THREE.MeshStandardMaterial({ color: helmet, roughness: 0.3, metalness: 0.25 });

    // legs (hip pivot)
    this.hipY = 0.92;
    this.legs = [-0.12, 0.12].map(z => {
      const g = new THREE.Group();
      g.position.set(0, this.hipY, z);
      const thigh = limb(0.11, 0.48, pantsMat);
      const shin = limb(0.085, 0.46, sockMat);
      shin.position.y = -0.46;
      g.add(thigh, shin);
      this.body.add(g);
      return g;
    });
    // torso
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.22, 0.62, 16, 1, true), this.jerseyMat);
    torso.position.y = 1.24;
    torso.castShadow = true;
    const hips = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.12, 12), pantsMat);
    hips.position.y = 0.94;
    this.body.add(torso, hips);
    if (kind !== 'ref') {
      const pads = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.8), this.jerseyMat);
      pads.position.y = 1.56;
      pads.castShadow = true;
      this.body.add(pads);
    }
    // head
    const head = new THREE.Mesh(new THREE.SphereGeometry(kind === 'ref' ? 0.13 : 0.17, 16, 12), kind === 'ref' ? skinMat : helmetMat);
    head.position.y = 1.8;
    head.castShadow = true;
    this.body.add(head);
    if (kind === 'ref') {
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.07, 12), new THREE.MeshStandardMaterial({ color: 0xffffff }));
      cap.position.y = 1.9;
      const brim = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.02, 0.2), new THREE.MeshStandardMaterial({ color: 0x111111 }));
      brim.position.set(0.13, 1.87, 0);
      this.body.add(cap, brim);
    } else {
      const mask = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.018, 6, 12, Math.PI), new THREE.MeshStandardMaterial({ color: 0x9a9a9a, metalness: 0.6, roughness: 0.4 }));
      mask.rotation.set(0, Math.PI / 2, -Math.PI / 2);
      mask.position.set(0.16, 1.74, 0);
      this.body.add(mask);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.03, 0.06), new THREE.MeshStandardMaterial({ color: colors.stripe }));
      stripe.position.set(0, 1.97, 0);
      this.body.add(stripe);
    }
    // arms (shoulder pivot)
    this.arms = [-0.36, 0.36].map(z => {
      const g = new THREE.Group();
      g.position.set(0, 1.55, z);
      const upper = limb(0.075, 0.34, this.jerseyMat);
      const fore = limb(0.06, 0.32, skinMat);
      fore.position.y = -0.34;
      g.add(upper, fore);
      this.body.add(g);
      return g;
    });
    this.phase = Math.random() * 6;
    this.root.traverse(o => { if (o.isMesh) o.castShadow = true; });
  }

  setNumber(tex) {
    if (this.jerseyMat.map === tex) return;
    this.jerseyMat.map = tex;
    this.jerseyMat.needsUpdate = true;
  }

  // pose code + speed (yd/s), dt seconds
  pose(code, speed, dt) {
    const B = this.body, [legL, legR] = this.legs, [armL, armR] = this.arms;
    B.rotation.set(0, 0, 0);
    B.position.set(0, 0, 0);
    let swing = 0;
    if (code === POSE.RUN || code === POSE.STAND || code === POSE.BLOCK) {
      this.phase += dt * (2.2 + speed * 1.15);
      swing = Math.min(1, speed / 7) * 0.95;
    }
    const s = Math.sin(this.phase);
    legL.rotation.set(0, 0, s * swing);
    legR.rotation.set(0, 0, -s * swing);
    armL.rotation.set(0, 0, -s * swing * 0.9);
    armR.rotation.set(0, 0, s * swing * 0.9);
    // a little lean into speed and a bob
    if (speed > 0.5 && code === POSE.RUN) {
      B.rotation.z = -Math.min(0.32, speed * 0.035);
      B.position.y = Math.abs(Math.cos(this.phase)) * 0.05 * Math.min(1, speed / 6);
    }
    switch (code) {
      case POSE.STANCE:
        B.rotation.z = -0.75;
        B.position.y = -0.35;
        legL.rotation.z = 0.9; legR.rotation.z = 0.4;
        armL.rotation.z = 0.9; armR.rotation.z = 1.4;
        break;
      case POSE.BLOCK:
        B.rotation.z = -0.38;
        armL.rotation.z = 1.35; armR.rotation.z = 1.35;
        break;
      case POSE.DOWN:
        B.rotation.z = -Math.PI / 2 + 0.06;
        B.position.y = 0.22;
        armL.rotation.z = 2.6; armR.rotation.z = 2.2;
        legL.rotation.z = 0.15; legR.rotation.z = -0.2;
        break;
      case POSE.DIVE:
        B.rotation.z = -1.15;
        B.position.y = 0.15;
        armL.rotation.z = 2.7; armR.rotation.z = 2.7;
        legL.rotation.z = -0.5; legR.rotation.z = -0.3;
        break;
      case POSE.KNEEL:
        B.position.y = -0.42;
        legL.rotation.z = 1.3; legR.rotation.z = -0.4;
        armL.rotation.z = 0.3; armR.rotation.z = 0.5;
        break;
      case POSE.CATCH:
        armL.rotation.set(0.25, 0, 2.6); armR.rotation.set(-0.25, 0, 2.6);
        break;
      case POSE.THROW:
        armR.rotation.set(-0.3, 0, 2.5);
        armL.rotation.z = 1.0;
        B.rotation.y = 0.45;
        break;
      case POSE.CELEBRATE:
        armL.rotation.set(0.5, 0, Math.PI); armR.rotation.set(-0.5, 0, Math.PI);
        B.position.y = Math.max(0, Math.sin(this.phase * 1.6 + performance.now() / 160)) * 0.25;
        break;
      case POSE.KICK:
        legR.rotation.z = 1.5;
        legL.rotation.z = -0.2;
        armL.rotation.set(0.9, 0, 0.4);
        B.rotation.z = 0.2;
        break;
      case POSE.SIGNAL:
        armL.rotation.set(0, 0, Math.PI); armR.rotation.set(0, 0, Math.PI);
        break;
    }
  }
}

export class Players {
  constructor(scene, game) {
    this.scene = scene;
    this.game = game;
    this.bodies = [];
    this.numberCache = new Map();
    const homeColors = { jersey: null, pants: new THREE.Color(game.home.alt).lerp(new THREE.Color('#ffffff'), 0.35), helmet: game.home.color, skin: 0x8d5a3b, sock: game.home.color, stripe: game.home.alt };
    const awayColors = { jersey: null, pants: new THREE.Color(game.away.color).lerp(new THREE.Color('#ffffff'), 0.15), helmet: game.away.color, skin: 0x8d5a3b, sock: game.away.color, stripe: game.away.alt };
    const skins = [0x5a3825, 0x8d5a3b, 0xc68863, 0xe0ac8a, 0x3d2516];
    this.jersey = {
      [game.home.id]: n => this._num(`h${n}`, () => jerseyTexture(game.home.color, '#ffffff', game.home.alt, n)),
      [game.away.id]: n => this._num(`a${n}`, () => jerseyTexture('#f5f5f2', game.away.color, game.away.alt, n)),
    };
    for (let i = 0; i < 22; i++) {
      const team = i < 11 ? game.home : game.away;
      const colors = { ...(i < 11 ? homeColors : awayColors), skin: skins[(i * 7) % skins.length] };
      colors.jersey = this.jersey[team.id]('');
      const b = new Body('player', colors);
      b.team = team.id;
      scene.add(b.root);
      this.bodies.push(b);
    }
    const stripes = stripeTexture();
    stripes.wrapS = THREE.RepeatWrapping;
    for (let k = 0; k < 4; k++) {
      const b = new Body('ref', { jersey: stripes, pants: 0x1a1a1a, helmet: 0xffffff, skin: skins[(k * 3 + 1) % skins.length], sock: 0x111111 });
      b.team = 'ref';
      scene.add(b.root);
      this.bodies.push(b);
    }
    // name tags
    this.tags = new Map(); // actor -> sprite
  }

  _num(key, make) {
    if (!this.numberCache.has(key)) this.numberCache.set(key, make());
    return this.numberCache.get(key);
  }

  update(frame, dt) {
    if (!frame) return;
    const { pos, numbers } = frame;
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      const x = pos[i * 4], y = pos[i * 4 + 1], h = pos[i * 4 + 2], code = pos[i * 4 + 3];
      const pose = Math.floor(code);
      let speed = (code - pose) * 10;
      if (b.last) speed = Math.max(speed * 0.5, Math.hypot(x - b.last[0], y - b.last[1]) / Math.max(1e-3, dt));
      speed = Math.min(speed, 11);
      b.last = [x, y];
      b.root.position.set(x - 50, 0, -y);
      b.root.rotation.y = h;
      b.pose(pose, speed, dt);
      if (i < 22 && numbers?.[i] != null) b.setNumber(this.jersey[b.team](numbers[i]));
    }
    this._tags(frame);
  }

  _tags(frame) {
    const live = new Set();
    for (const l of frame.labels || []) {
      live.add(l.actor);
      let s = this.tags.get(l.actor);
      const text = `${l.jersey ? l.jersey + ' ' : ''}${l.text}`;
      if (!s || s.userData.text !== text) {
        if (s) { this.scene.remove(s); s.material.map.dispose(); s.material.dispose(); }
        s = tagSprite(text, this.bodies[l.actor].team === this.game.home.id ? this.game.home : this.game.away);
        this.tags.set(l.actor, s);
        this.scene.add(s);
      }
      const b = this.bodies[l.actor];
      s.position.set(b.root.position.x, 2.75, b.root.position.z);
      s.material.opacity = Math.max(0, Math.min(1, l.alpha));
      s.visible = true;
    }
    for (const [a, s] of this.tags) if (!live.has(a)) s.visible = false;
  }
}

function tagSprite(text, team) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 112;
  const g = c.getContext('2d');
  g.font = '800 54px "Inter", "Segoe UI", system-ui, sans-serif';
  const w = Math.min(500, g.measureText(text).width + 56);
  const x0 = (512 - w) / 2;
  g.fillStyle = 'rgba(10,12,16,0.82)';
  g.beginPath();
  g.roundRect(x0, 14, w, 78, 14);
  g.fill();
  g.fillStyle = team.color;
  g.fillRect(x0, 14, 12, 78);
  g.fillStyle = '#fff';
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  g.fillText(text, 256 + 6, 55);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false }));
  s.scale.set(4.4, 0.96, 1);
  s.renderOrder = 10;
  s.userData.text = text;
  return s;
}
