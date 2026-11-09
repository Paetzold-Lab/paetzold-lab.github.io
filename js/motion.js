/* Subtle depth motion, purely decorative:
   - a slow contour-line field in the dark half of the homepage banner (WebGL);
   - a gentle 3D tilt toward the mouse on the banner figure and on portraits.
   Nothing changes at rest. Reduced motion, touch-only devices and (for the
   field) phone layouts, low-power devices or missing WebGL keep the static look. */

(() => {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
  const wideLayout = window.matchMedia("(min-width: 769px)");
  if (reducedMotion.matches) return;

  const stopHandlers = [];
  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches) stopHandlers.forEach(stop => stop());
  });

  document.addEventListener("DOMContentLoaded", () => {
    initTilt({ container: ".team-card", target: "img", maxDeg: 5, depth: "700px" });
    initTilt({ container: ".profile-image", target: "img", maxDeg: 3, depth: "1000px" });
    initTilt({
      container: ".hero-carousel",
      target: ".carousel-slide.active .paper-collage, .carousel-slide.active .lab-intro-photo",
      maxDeg: 2,
      depth: "1400px"
    });
    initHeroField();
  });

  /* --- pointer tilt --- */

  function initTilt({ container, target, maxDeg, depth }) {
    if (!finePointer.matches) return;
    document.querySelectorAll(container).forEach(box => {
      let element = null;
      let pointer = null;
      let frame = 0;
      const releaseTimers = new Map();

      const settle = el => {
        el.style.setProperty("--tilt-x", "0deg");
        el.style.setProperty("--tilt-y", "0deg");
        clearTimeout(releaseTimers.get(el));
        // Drop the transform once it has eased back, so the element is untouched at rest.
        releaseTimers.set(el, setTimeout(() => {
          releaseTimers.delete(el);
          if (el !== element) el.classList.remove("motion-tilt");
        }, 500));
      };

      const apply = () => {
        frame = 0;
        const current = box.querySelector(target);
        if (current !== element) {
          if (element) settle(element);
          element = current;
          if (!element) return;
          clearTimeout(releaseTimers.get(element));
          releaseTimers.delete(element);
          element.style.setProperty("--tilt-depth", depth);
          element.classList.add("motion-tilt");
        }
        if (!element || !pointer) return;
        const rect = box.getBoundingClientRect();
        const x = Math.min(Math.max((pointer.x - rect.left) / rect.width, 0), 1) - 0.5;
        const y = Math.min(Math.max((pointer.y - rect.top) / rect.height, 0), 1) - 0.5;
        element.style.setProperty("--tilt-x", `${(-y * 2 * maxDeg).toFixed(2)}deg`);
        element.style.setProperty("--tilt-y", `${(x * 2 * maxDeg).toFixed(2)}deg`);
      };

      const release = () => {
        pointer = null;
        cancelAnimationFrame(frame);
        frame = 0;
        if (element) {
          const el = element;
          element = null;
          settle(el);
        }
      };

      box.addEventListener("pointermove", event => {
        if (event.pointerType !== "mouse") return;
        pointer = { x: event.clientX, y: event.clientY };
        if (!frame) frame = requestAnimationFrame(apply);
      }, { passive: true });
      box.addEventListener("pointerleave", release);
      stopHandlers.push(release);
    });
  }

  /* --- banner contour field --- */

  function lowPowerDevice() {
    const connection = navigator.connection;
    return Boolean(connection?.saveData) ||
      (navigator.deviceMemory && navigator.deviceMemory < 4) ||
      (navigator.hardwareConcurrency && navigator.hardwareConcurrency < 4);
  }

  function initHeroField() {
    const hero = document.querySelector(".hero-carousel");
    if (!hero || lowPowerDevice() || !("IntersectionObserver" in window)) return;

    let field = null;
    let disabled = false;
    let inView = false;
    const sync = () => {
      // A field that failed or could not keep up stays off for this page view.
      if (field?.failed) {
        field = null;
        disabled = true;
      }
      const wanted = inView && wideLayout.matches && !document.hidden && !reducedMotion.matches;
      if (wanted && !field && !disabled) field = createHeroField(hero);
      if (field) wanted ? field.start() : field.stop();
      if (field?.failed) {
        field = null;
        disabled = true;
      }
    };
    const observer = new IntersectionObserver(entries => {
      inView = entries[0].isIntersecting;
      sync();
    });
    // Start after the page has settled so the banner images load first.
    const begin = () => observer.observe(hero);
    if (document.readyState === "complete") setTimeout(begin, 400);
    else window.addEventListener("load", () => setTimeout(begin, 400), { once: true });
    document.addEventListener("visibilitychange", sync);
    wideLayout.addEventListener("change", sync);
    stopHandlers.push(() => {
      observer.disconnect();
      field?.destroy();
      field = null;
    });
  }

  const VERTEX_SHADER = `
attribute vec2 aPosition;
void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }`;

  /* Contour lines of a slowly evolving 3D simplex-noise height field.
     Simplex noise: Ashima Arts / Stefan Gustavson, MIT License. */
  const FRAGMENT_SHADER = `
#extension GL_OES_standard_derivatives : enable
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uResolution;
uniform float uTime;
uniform float uScale;
uniform vec2 uPointer;
uniform float uPointerMix;
uniform vec4 uCalm;
uniform float uIntensity;

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0)) +
    i.y + vec4(0.0, i1.y, i2.y, 1.0)) +
    i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / uResolution;
  vec2 pointerOffset = (uPointer / uResolution - 0.5) * uPointerMix;
  vec2 p = frag / uResolution.y * 1.25 + pointerOffset * 0.06;
  float t = uTime * 0.035;
  float height = snoise(vec3(p, t)) * 0.72 + snoise(vec3(p * 2.1 + 7.3, t * 1.4)) * 0.28;
  float level = height * 6.0;
  float distancePx = abs(fract(level + 0.5) - 0.5) / max(fwidth(level), 1e-4);
  float line = 1.0 - smoothstep(0.45 * uScale, 1.2 * uScale, distancePx);

  float r = length((frag - uPointer) / uResolution.y);
  float alpha = line * (0.075 + 0.075 * uPointerMix * exp(-r * r / 0.03));

  // Stay inside the dark half and away from the edges.
  alpha *= 1.0 - smoothstep(0.52, 0.84, uv.x);
  alpha *= smoothstep(0.0, 0.1, uv.y) * (1.0 - smoothstep(0.9, 1.0, uv.y));
  // Keep the space under the slide text calm.
  vec2 outsideBy = max(max(uCalm.xy - frag, frag - uCalm.zw), 0.0);
  alpha *= mix(0.22, 1.0, smoothstep(0.0, 32.0 * uScale, length(outsideBy)));

  alpha *= uIntensity;
  gl_FragColor = vec4(vec3(alpha), alpha);
}`;

  function createHeroField(hero) {
    const canvas = document.createElement("canvas");
    canvas.className = "hero-field";
    canvas.setAttribute("aria-hidden", "true");
    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      powerPreference: "low-power",
      // Software rendering (no GPU) would spend the CPU on decoration; keep the static banner.
      failIfMajorPerformanceCaveat: true
    });
    const rendererInfo = gl?.getExtension("WEBGL_debug_renderer_info");
    const renderer = rendererInfo ? String(gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL)) : "";
    if (!gl || /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer) ||
      !gl.getExtension("OES_standard_derivatives")) {
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      return { failed: true, start() {}, stop() {}, destroy() {} };
    }

    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
    };
    const vertex = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const program = gl.createProgram();
    if (vertex && fragment) {
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
    }
    if (!vertex || !fragment || !gl.getProgramParameter(program, gl.LINK_STATUS)) {
      return { failed: true, start() {}, stop() {}, destroy() {} };
    }
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "aPosition");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const uniform = name => gl.getUniformLocation(program, name);
    const u = {
      resolution: uniform("uResolution"),
      time: uniform("uTime"),
      scale: uniform("uScale"),
      pointer: uniform("uPointer"),
      pointerMix: uniform("uPointerMix"),
      calm: uniform("uCalm"),
      intensity: uniform("uIntensity")
    };

    hero.appendChild(canvas);

    const FRAME_MS = 1000 / 30;
    let scale = 1;
    let running = false;
    let frame = 0;
    let lastFrame = 0;
    let elapsed = 0;
    let intensity = 0;
    let slowFrames = 0;
    let shown = false;
    const pointer = { x: 0, y: 0, mix: 0, targetX: 0, targetY: 0, targetMix: 0 };

    const resize = () => {
      scale = Math.min(window.devicePixelRatio || 1, 1.5);
      const width = Math.max(1, Math.round(canvas.clientWidth * scale));
      const height = Math.max(1, Math.round(canvas.clientHeight * scale));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);

    const onPointerMove = event => {
      if (event.pointerType !== "mouse") return;
      const rect = canvas.getBoundingClientRect();
      pointer.targetX = (event.clientX - rect.left) * scale;
      pointer.targetY = (rect.bottom - event.clientY) * scale;
      pointer.targetMix = 1;
      // Start the glow where the mouse enters rather than sweeping in from a corner.
      if (pointer.mix < 0.01) {
        pointer.x = pointer.targetX;
        pointer.y = pointer.targetY;
      }
    };
    const onPointerLeave = () => { pointer.targetMix = 0; };
    hero.addEventListener("pointermove", onPointerMove, { passive: true });
    hero.addEventListener("pointerleave", onPointerLeave);

    const calmBox = () => {
      const text = hero.querySelector(".carousel-slide.active .slide-content");
      if (!text) return [0, 0, 0, 0];
      const c = canvas.getBoundingClientRect();
      const r = text.getBoundingClientRect();
      return [(r.left - c.left) * scale, (c.bottom - r.bottom) * scale, (r.right - c.left) * scale, (c.bottom - r.top) * scale];
    };

    const render = now => {
      frame = requestAnimationFrame(render);
      const delta = now - lastFrame;
      if (delta < FRAME_MS - 2) return;
      // Fall back to the static banner if this device cannot keep up.
      slowFrames = delta > 90 ? slowFrames + 1 : Math.max(0, slowFrames - 1);
      if (slowFrames > 12) {
        destroy();
        return;
      }
      lastFrame = now;
      elapsed += Math.min(delta, 100) / 1000;
      intensity = Math.min(1, intensity + 0.04);
      pointer.x += (pointer.targetX - pointer.x) * 0.08;
      pointer.y += (pointer.targetY - pointer.y) * 0.08;
      pointer.mix += (pointer.targetMix - pointer.mix) * 0.05;

      gl.uniform2f(u.resolution, canvas.width, canvas.height);
      gl.uniform1f(u.time, elapsed);
      gl.uniform1f(u.scale, scale);
      gl.uniform2f(u.pointer, pointer.x, pointer.y);
      gl.uniform1f(u.pointerMix, pointer.mix);
      gl.uniform4fv(u.calm, calmBox());
      gl.uniform1f(u.intensity, intensity);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!shown) {
        shown = true;
        canvas.classList.add("is-visible");
      }
    };

    const start = () => {
      if (running || api.failed) return;
      running = true;
      resize();
      lastFrame = performance.now() - FRAME_MS;
      frame = requestAnimationFrame(render);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(frame);
    };
    const destroy = () => {
      stop();
      api.failed = true;
      resizeObserver.disconnect();
      hero.removeEventListener("pointermove", onPointerMove);
      hero.removeEventListener("pointerleave", onPointerLeave);
      canvas.remove();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
    canvas.addEventListener("webglcontextlost", event => {
      event.preventDefault();
      destroy();
    });

    const api = { failed: false, start, stop, destroy };
    return api;
  }
})();
