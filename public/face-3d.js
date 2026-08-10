// Greg's face in 3D: a real gold helmet floating in the dark.
//
// The shell and visor are solids of revolution built from one shared profile,
// so the glass sits exactly on the gold surface. Everything metallic is lit by a
// generated studio environment — chrome without an environment to reflect just
// looks black, so that map is doing most of the work here, not the lights.

import * as THREE from "/vendor/three/three.module.js";
import { COLS, ROWS, paintLedTexture } from "./led-panel.js";

const MOODS = {
  idle:      { hue: 42,  sat: 92, glow: 0.34, spin: 0.1,  led: 0.16 },
  listening: { hue: 187, sat: 95, glow: 0.85, spin: 0.3,  led: 0.95 },
  thinking:  { hue: 33,  sat: 96, glow: 0.7,  spin: 1.35, led: 0.8 },
  speaking:  { hue: 46,  sat: 96, glow: 1.0,  spin: 0.45, led: 1.0 },
  error:     { hue: 356, sat: 90, glow: 0.75, spin: 0.08, led: 0.7 },
};

const lerp = (a, b, t) => a + (b - a) * t;

// The helmet silhouette, as a half-profile revolved around Y.
// x is the radius, y the height: wide at the brow, narrowing to a rounded jaw.
const PROFILE = [
  [0.0, 1.0], [0.16, 0.995], [0.33, 0.965], [0.5, 0.9], [0.63, 0.8],
  [0.72, 0.66], [0.775, 0.48], [0.8, 0.28], [0.805, 0.06], [0.79, -0.16],
  [0.755, -0.37], [0.7, -0.56], [0.62, -0.72], [0.5, -0.85], [0.35, -0.94],
  [0.19, -0.985], [0.0, -1.0],
];

export class Face3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.state = "idle";
    this.target = { ...MOODS.idle };
    this.current = { ...MOODS.idle };

    this.level = 0;
    this.rawLevel = 0;
    this.spectrum = null;

    this.spin = 0;
    this.time = 0;
    this.blink = 0;
    this.nextBlinkAt = 3 + Math.random() * 4;

    this.pointer = { x: 0, y: 0 };
    this.pointerTarget = { x: 0, y: 0 };
    this.size = 0;
  }

  async init() {
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(27, 1, 0.1, 100);
    this.camera.position.set(0, 0, 5.1);

    this.scene.environment = buildStudioEnvironment(renderer);

    this.helmet = new THREE.Group();
    // Narrower than it is tall, as in the reference.
    this.helmet.scale.set(0.89, 1.02, 0.9);
    this.scene.add(this.helmet);

    this.buildShell();
    this.buildVisor();
    this.buildEarPods();
    this.buildLedPanel();
    this.buildLights();
    this.buildBloom();

    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
    window.addEventListener("resize", () => this.resize());

    // Gentle parallax — the helmet turns a little toward the pointer.
    window.addEventListener("pointermove", (event) => {
      this.pointerTarget.x = (event.clientX / window.innerWidth) * 2 - 1;
      this.pointerTarget.y = (event.clientY / window.innerHeight) * 2 - 1;
    });

    return this;
  }

  buildShell() {
    const points = PROFILE.map(([x, y]) => new THREE.Vector2(x, y));
    const geometry = new THREE.LatheGeometry(points, 160);
    geometry.computeVertexNormals();

    this.goldMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xd6a03a,
      metalness: 1,
      roughness: 0.075,
      envMapIntensity: 2.5,
      clearcoat: 0.5,
      clearcoatRoughness: 0.06,
    });

    const shell = new THREE.Mesh(geometry, this.goldMaterial);
    shell.scale.set(1, 1, 0.92); // slightly flattened front to back
    this.helmet.add(shell);
  }

  buildVisor() {
    // Same profile, pushed marginally outward and trimmed on all sides. It must
    // stop short of the apex, or the visor caps the whole dome and no gold brow
    // is left — which is most of what makes the silhouette readable.
    // A lathe can only be trimmed by horizontal cuts, which would leave the
    // glass with straight top and bottom edges like a letterbox. So the band is
    // cut generously and its real outline comes from an alpha mask — that's what
    // gives the rounded visor with gold all the way around it.
    const points = PROFILE.filter(([, y]) => y < 0.9 && y > -0.6).map(
      ([x, y]) => new THREE.Vector2(x * 1.014, y)
    );

    const phiLength = 2.6;
    const geometry = new THREE.LatheGeometry(points, 150, -phiLength / 2, phiLength);
    geometry.computeVertexNormals();

    this.visorMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x04040a,
      metalness: 0.35,
      roughness: 0.025,
      envMapIntensity: 1.35,
      clearcoat: 1,
      clearcoatRoughness: 0.015,
      side: THREE.DoubleSide,
      alphaMap: buildVisorMask(),
      transparent: true,
      depthWrite: false,
    });

    this.visor = new THREE.Mesh(geometry, this.visorMaterial);
    this.visor.scale.set(1, 1, 0.92);
    this.visor.renderOrder = 1;
    this.helmet.add(this.visor);
  }

  buildEarPods() {
    // Chunky enough to read as part of the helmet rather than a stuck-on ring,
    // and set inboard so the dome overlaps their inner edge.
    const geometry = new THREE.CapsuleGeometry(0.17, 0.32, 10, 40);
    for (const side of [-1, 1]) {
      const pod = new THREE.Mesh(geometry, this.goldMaterial);
      pod.position.set(side * 0.73, -0.03, 0.0);
      pod.scale.set(0.85, 1, 0.78);
      this.helmet.add(pod);
    }
  }

  buildLedPanel() {
    const canvas = document.createElement("canvas");
    canvas.width = COLS * 34;
    canvas.height = ROWS * 34;
    this.ledCanvas = canvas;
    this.ledCtx = canvas.getContext("2d");

    this.ledTexture = new THREE.CanvasTexture(canvas);
    this.ledTexture.colorSpace = THREE.SRGBColorSpace;

    // A curved band just inside the glass, so the LEDs follow the visor.
    const band = PROFILE.filter(([, y]) => y < 0.58 && y > -0.14).map(
      ([x, y]) => new THREE.Vector2(x * 0.968, y)
    );
    const phiLength = 1.35;
    const geometry = new THREE.LatheGeometry(band, 80, -phiLength / 2, phiLength);

    const material = new THREE.MeshBasicMaterial({
      map: this.ledTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false, // glow reads as shining through the glass
      side: THREE.DoubleSide,
    });

    this.ledMesh = new THREE.Mesh(geometry, material);
    this.ledMesh.scale.set(1, 1, 0.92);
    this.ledMesh.renderOrder = 3;
    this.helmet.add(this.ledMesh);
  }

  buildLights() {
    const key = new THREE.DirectionalLight(0xfff2d8, 2.1);
    key.position.set(-2.4, 3, 3.4);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.5);
    fill.position.set(3, -1.4, 2);
    this.scene.add(fill);

    // Tinted by mood, from behind — separates the helmet from the background.
    this.rimLight = new THREE.PointLight(0xffd27a, 14, 12, 2);
    this.rimLight.position.set(1.6, 1.2, -2.6);
    this.scene.add(this.rimLight);
  }

  buildBloom() {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext("2d");
    const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    gradient.addColorStop(0, "rgba(255,255,255,0.5)");
    gradient.addColorStop(0.35, "rgba(255,255,255,0.16)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 256, 256);

    this.bloom = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(canvas),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        transparent: true,
      })
    );
    this.bloom.position.set(0, 0, -1.4);
    this.bloom.scale.set(5.2, 5.2, 1);
    this.bloom.renderOrder = -1;
    this.scene.add(this.bloom);
  }

  // ---- public API, matching the 2D renderer -------------------------------

  setState(state) {
    if (!MOODS[state] || state === this.state) return;
    this.state = state;
    this.target = MOODS[state];
    if (state !== "speaking") this.spectrum = null;
  }

  setLevel(level) {
    this.rawLevel = Math.max(0, Math.min(1, level || 0));
  }

  setSpectrum(data) {
    this.spectrum = data;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const size = Math.floor(Math.min(rect.width, rect.height));
    if (!size || size === this.size) return;
    this.size = size;
    this.renderer.setSize(size, size, false);
    this.camera.aspect = 1;
    this.camera.updateProjectionMatrix();
  }

  start() {
    const frame = () => {
      this.frameHandle = requestAnimationFrame(frame);
      const now = performance.now();
      const dt = Math.min((now - (this.lastFrame ?? now)) / 1000, 0.1);
      this.lastFrame = now;
      this.update(dt);
      this.render();
    };
    frame();
  }

  update(dt) {
    this.time += dt;

    const ease = 1 - Math.pow(0.003, dt);
    for (const key of Object.keys(this.target)) {
      if (key === "hue") {
        const delta = ((this.target.hue - this.current.hue + 540) % 360) - 180;
        this.current.hue = (this.current.hue + delta * ease + 360) % 360;
      } else {
        this.current[key] = lerp(this.current[key], this.target[key], ease);
      }
    }

    this.level =
      this.rawLevel > this.level
        ? lerp(this.level, this.rawLevel, 1 - Math.pow(0.001, dt))
        : lerp(this.level, this.rawLevel, 1 - Math.pow(0.2, dt));

    this.spin += this.current.spin * dt;

    this.nextBlinkAt -= dt;
    if (this.nextBlinkAt <= 0 && this.state !== "speaking") {
      this.blink = 1;
      this.nextBlinkAt = 4 + Math.random() * 6;
    }
    this.blink = Math.max(0, this.blink - dt * 5);

    this.pointer.x = lerp(this.pointer.x, this.pointerTarget.x, 1 - Math.pow(0.02, dt));
    this.pointer.y = lerp(this.pointer.y, this.pointerTarget.y, 1 - Math.pow(0.02, dt));
  }

  render() {
    if (!this.size) return;
    const t = this.time;

    // Floating: a slow drift, plus a lean toward the pointer.
    const bob = Math.sin(t * 0.85) * 0.042 + Math.sin(t * 1.9) * 0.012;
    this.helmet.position.y = bob + this.level * 0.02;
    this.helmet.position.x = Math.sin(t * 0.5) * 0.022;
    this.helmet.rotation.y = Math.sin(t * 0.42) * 0.14 + this.pointer.x * 0.38;
    this.helmet.rotation.x = Math.sin(t * 0.63) * 0.05 + this.pointer.y * 0.22;
    this.helmet.rotation.z = Math.sin(t * 0.33) * 0.025;

    // Mood colour drives the rim light and the halo.
    const colour = new THREE.Color().setHSL(
      this.current.hue / 360,
      this.current.sat / 100,
      0.55
    );
    this.rimLight.color.copy(colour);
    this.rimLight.intensity = 9 + this.current.glow * 10 + this.level * 6;
    this.bloom.material.color.copy(colour);
    this.bloom.material.opacity = 0.16 + this.current.glow * 0.2 + this.level * 0.12;

    // Repaint the LED array.
    paintLedTexture(
      this.ledCtx,
      this.ledCanvas.width,
      this.ledCanvas.height,
      {
        state: this.state,
        time: this.time,
        spin: this.spin,
        level: this.level,
        spectrum: this.spectrum,
        hue: this.current.hue,
        sat: this.current.sat,
      },
      this.current.led * (1 - this.blink * 0.85)
    );
    this.ledTexture.needsUpdate = true;

    this.renderer.render(this.scene, this.camera);
  }
}

// ---------------------------------------------------------------------------
// A small studio, rendered to an environment map.
//
// This is what the gold and the glass actually reflect: a few bright softboxes
// in a dark room, which is exactly the lighting in the reference photographs.
// ---------------------------------------------------------------------------

/**
 * The visor's outline, painted in the lathe's UV space: u runs across the front
 * arc, v from the brow down to the jaw. White is glass, black is cut away, and
 * the soft edge keeps the boundary from looking jagged.
 */
function buildVisorMask() {
  const w = 512;
  const h = 512;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);

  // A rounded shape sitting inside the band, leaving a gold margin all round —
  // narrower at the top (thin brow) and deeper at the bottom (broad chin).
  const left = w * 0.13;
  const right = w * 0.87;
  const top = h * 0.14;
  const bottom = h * 0.74;

  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.moveTo((left + right) / 2, top);
  ctx.bezierCurveTo(right - (right - left) * 0.1, top, right, h * 0.34, right, h * 0.44);
  ctx.bezierCurveTo(right, h * 0.62, right - (right - left) * 0.16, bottom, (left + right) / 2, bottom);
  ctx.bezierCurveTo(left + (right - left) * 0.16, bottom, left, h * 0.62, left, h * 0.44);
  ctx.bezierCurveTo(left, h * 0.34, left + (right - left) * 0.1, top, (left + right) / 2, top);
  ctx.closePath();
  ctx.filter = "blur(3px)"; // soften so the silhouette isn't stair-stepped
  ctx.fill();
  ctx.filter = "none";

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

function buildStudioEnvironment(renderer) {
  const studio = new THREE.Scene();
  // Not black. Whatever the background is, the metal reflects it in every
  // direction the panels don't cover — leave it dark and the gold reads as
  // black plastic no matter how bright the key lights are.
  studio.background = new THREE.Color(0x24262e);

  const panel = (w, h, colour, intensity, position, rotation) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(colour).multiplyScalar(intensity),
        side: THREE.DoubleSide,
      })
    );
    mesh.position.set(...position);
    if (rotation) mesh.rotation.set(...rotation);
    studio.add(mesh);
  };

  // Big key softbox, upper left.
  panel(8, 12, 0xffffff, 5.5, [-8, 4, 3], [0, Math.PI / 2, 0]);
  // Narrow strip light, right — gives the long vertical glint.
  panel(1.8, 13, 0xdfeaff, 6.5, [8, 1, 0], [0, -Math.PI / 2, 0]);
  // Second strip, front right.
  panel(1.2, 9, 0xffffff, 4.2, [4.5, 0, 7], [0, Math.PI, 0]);
  // Broad warm bounce from below — this is what fills the gold in.
  panel(16, 16, 0xffc98a, 1.9, [0, -8, 0], [-Math.PI / 2, 0, 0]);
  // Ceiling, so the crown of the dome isn't dead.
  panel(16, 16, 0xbccbe8, 1.5, [0, 9, 0], [Math.PI / 2, 0, 0]);
  // Cool rear fill to catch the edges.
  panel(12, 12, 0x8ea3d0, 1.2, [0, 0, -9], []);
  // Warm side bounce, left — keeps the flank from going black.
  panel(10, 12, 0xffdcae, 1.4, [-7, -1, -4], [0, Math.PI / 2, 0]);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(studio, 0.03);
  pmrem.dispose();
  studio.traverse((object) => {
    object.geometry?.dispose();
    object.material?.dispose();
  });

  return target.texture;
}

