// The broadcast: renderer, lights, ball, flag, cameras.
//
// Cameras, by key:
//   1 broadcast  high on the press-box sideline, tracking the ball, widening
//                for kicks and long throws -- the default TV angle
//   2 all-22     high behind the offense, the whole field of play
//   3 sky        a wire cam trailing the ball
//   4 free       orbit with the mouse

import * as THREE from 'three';
import { OrbitControls } from '../../vendor/OrbitControls.js';
import { buildStadium } from './field.js';
import { Players } from './players.js';

export class Broadcast {
  constructor(canvas, game) {
    this.canvas = canvas;
    this.game = game;
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.outputColorSpace = THREE.SRGBColorSpace;

    const scene = this.scene = new THREE.Scene();
    scene.background = skyTexture();
    scene.fog = new THREE.Fog(0x0d1626, 160, 420);

    const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x2a3a20, 0.75);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xfff4e0, 2.3);
    key.position.set(-30, 80, 40);
    key.castShadow = true;
    key.shadow.mapSize.set(4096, 4096);
    const sc = key.shadow.camera;
    sc.left = -75; sc.right = 75; sc.top = 45; sc.bottom = -45; sc.near = 10; sc.far = 200;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xd8e6ff, 0.6);
    fill.position.set(40, 50, -40);
    scene.add(fill);

    this.stadium = buildStadium(scene, game, r);
    this.players = new Players(scene, game);

    // the ball
    const ball = new THREE.Group();
    const skin = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshStandardMaterial({ color: 0x7a3b1c, roughness: 0.55 }));
    skin.scale.set(0.2, 0.125, 0.125); // a touch over life size so it reads on TV
    skin.castShadow = true;
    const laces = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.012, 0.02), new THREE.MeshStandardMaterial({ color: 0xffffff }));
    laces.position.y = 0.1;
    ball.add(skin, laces);
    scene.add(ball);
    this.ball = ball;
    this.ballSpin = 0;
    // a soft marker under a ball in the air, so its flight reads from above
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.35, 20), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.02;
    scene.add(shadow);
    this.ballShadow = shadow;
    // a faint trail behind a ball in the air
    this.trailN = 40;
    this.trail = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.trailN * 3), 3)), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }));
    this.trail.frustumCulled = false;
    this.trailPts = [];
    scene.add(this.trail);

    // the flag
    const flag = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.05, 0.35), new THREE.MeshStandardMaterial({ color: 0xffd400, emissive: 0x332a00 }));
    flag.castShadow = true;
    flag.visible = false;
    scene.add(flag);
    this.flag = flag;

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.5, 900);
    this.camera.position.set(0, 26, 64);
    this.mode = 'broadcast';
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enabled = false;
    this.controls.target.set(0, 0, 0);
    this.focus = new THREE.Vector3();
    this.lookAt = new THREE.Vector3();
    this.zoom = 30;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setMode(mode) {
    this.mode = mode;
    this.controls.enabled = mode === 'free';
    if (mode === 'free') this.controls.target.copy(this.lookAt);
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // a panel over the right edge: shift the picture so the action is
    // centred in what is left visible
    if (this.inset) this.camera.setViewOffset(w, h, this.inset / 2, 0, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  setInset(px) { this.inset = px; this.resize(); }

  // s: director.sample(); dt seconds of real time
  update(s, dt) {
    if (!s) { this.renderer.render(this.scene, this.camera); return; }
    const f = s.frame;
    this.players.update(f, dt);
    // ball
    if (f) {
      const [bx, by, bz] = f.ball;
      this.ball.position.set(bx - 50, bz, -by);
      const v = f.ballVel || [0, 0, 0];
      const sp = Math.hypot(v[0], v[1]);
      const spin = f.ball[3];
      if (spin >= 1 && sp > 2) {
        // nose along the flight
        const dir = new THREE.Vector3(v[0], v[2], -v[1]).normalize();
        this.ball.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
        this.ballSpin += dt * (spin >= 2 ? 0 : 30);
        if (spin >= 2) this.ball.rotateZ(performance.now() / 90); // end over end
        else this.ball.rotateX(this.ballSpin);
      } else if (spin >= 3) {
        this.ball.rotation.set(performance.now() / 120, performance.now() / 70, 0);
      } else {
        this.ball.rotation.set(0, Math.atan2(-v[1], v[0]) || 0, bz < 0.3 ? 0 : -0.2);
      }
      // trail: only while the ball is flying
      if (spin >= 1 && spin < 3 && bz > 0.8) this.trailPts.push([bx - 50, bz, -by]);
      else if (this.trailPts.length) this.trailPts.shift();
      if (this.trailPts.length > this.trailN) this.trailPts.shift();
      const tp = this.trail.geometry.attributes.position;
      for (let k = 0; k < this.trailN; k++) {
        const q = this.trailPts[Math.min(k, this.trailPts.length - 1)] || [bx - 50, bz, -by];
        tp.setXYZ(k, q[0], q[1], q[2]);
      }
      tp.needsUpdate = true;
      this.trail.visible = this.trailPts.length > 1;
      this.ballShadow.position.set(bx - 50, 0.02, -by);
      this.ballShadow.material.opacity = bz > 1.6 ? 0.28 : 0;
      // flag
      if (f.flag) {
        this.flag.visible = true;
        this.flag.position.set(f.flag.x - 50, f.flag.z, -f.flag.y);
        if (!f.flag.landed) this.flag.rotation.set(performance.now() / 80, performance.now() / 110, 0);
        else this.flag.rotation.set(0, 0.6, 0);
      } else if (s.phase === 'pre' || s.phase === 'between') this.flag.visible = false;
    }
    // broadcast lines and the chains
    const L = this.stadium.lines, C = this.stadium.chains;
    const showLines = s.los != null && s.action.kind !== 'kickoff' && s.phase !== 'post';
    L.los.visible = showLines;
    L.fd.visible = showLines && s.firstDownX != null;
    if (s.los != null) { L.los.position.x = s.los - 50; C.los.position.x = s.los - 50; }
    if (s.firstDownX != null) { L.fd.position.x = s.firstDownX - 50; C.fd.position.x = s.firstDownX - 50; }
    C.fd.visible = s.firstDownX != null;
    this._camera(s, dt);
    this.renderer.render(this.scene, this.camera);
  }

  _camera(s, dt) {
    if (this.mode === 'free') { this.controls.update(); return; }
    const f = s.frame;
    const bx = f ? f.ball[0] : 50, by = f ? f.ball[1] : 0, bz = f ? f.ball[2] : 0;
    const v = f?.ballVel || [0, 0, 0];
    const kick = s.action.kind === 'kickoff' || s.action.kind === 'punt';
    const fg = s.action.kind === 'fg' || s.action.kind === 'xp';
    // target focus: the ball, led a little in its direction of travel; the
    // camera's focus eases toward it so cuts do not jitter
    const lead = Math.max(-8, Math.min(8, v[0] * 0.35));
    const want = new THREE.Vector3(bx - 50 + lead, 0, -by * 0.35);
    const k = 1 - Math.exp(-dt * (s.phase === 'play' ? 2.6 : 1.2));
    this.focus.lerp(want, k);
    // zoom: wider for kicks, deep throws, and between plays
    let fov = 34;
    if (s.phase === 'between') fov = 38;
    if (kick && s.phase === 'play') fov = 50;
    if (fg) fov = 44;
    if (bz > 4) fov = Math.max(fov, 38 + Math.min(16, bz * 0.9));
    this.zoom += (fov - this.zoom) * (1 - Math.exp(-dt * 1.4));
    const cam = this.camera;
    if (this.mode === 'broadcast') {
      cam.position.set(this.focus.x * 0.9, 19, 50);
      this.lookAt.set(this.focus.x, 0.5, this.focus.z * 0.7 - 2.5);
    } else if (this.mode === 'all22') {
      const d = s.dir || 1;
      const los = (s.los ?? 50) - 50;
      cam.position.set(los - d * 32, 46, 0.01);
      this.lookAt.set(los + d * 12, 0, 0);
      this.zoom = 52;
    } else if (this.mode === 'sky') {
      const d = s.dir || 1;
      cam.position.lerp(new THREE.Vector3(this.focus.x - d * 16, 11, this.focus.z + 6), k);
      this.lookAt.set(this.focus.x + d * 6, 0.8, this.focus.z);
      this.zoom = 55;
    }
    cam.fov = this.zoom;
    cam.updateProjectionMatrix();
    cam.lookAt(this.lookAt);
  }
}

function skyTexture() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#050a16');
  grad.addColorStop(0.55, '#14254a');
  grad.addColorStop(0.85, '#3a4a6e');
  grad.addColorStop(1, '#6d6a7a');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
