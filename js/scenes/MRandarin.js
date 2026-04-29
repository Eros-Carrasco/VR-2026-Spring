import * as global from "../global.js";
import { Gltf2Node } from "../render/nodes/gltf2.js";
import { G2 } from "../util/g2.js";
import { askAI } from "../util/aiquery.js";
import { computeCameraPose } from "../util/computeCameraPose.js";
import { mxm, transform } from "../util/matrix.js";

window.mandarinState = {
   status: 'empty',
   character: null,
   pinyin: null,
   meaning: null,
   erased: false,
   // Source corners + frame dimensions used to compute the pose locally on each
   // client (so the headset uses ITS OWN viewMatrix, not the PC's static one).
   srcCorners: null,
   frameW: 0,
   frameH: 0,
   resetCounter: 0,   // bumped by the PC's reset key; all clients clear local zone state in response
   lockCounter:  0,   // bumped by the headset's controller button; captures activeZone & switches backend to TRACKING_ARUCO
   // Bbox of the detected character WITHIN the 800×800 zone, normalized [0..1].
   // char_x_pct/char_y_pct = bbox center; bbox_w_pct/bbox_h_pct = bbox size.
   // Used to anchor the hanzi VFX (sparks, lines, info panels) to the actual
   // character location on the surface, not to the zone's geometric center.
   char_x_pct: null,
   char_y_pct: null,
   bbox_w_pct: null,
   bbox_h_pct: null,
};

export const init = async model => {

   global.scene().addNode(new Gltf2Node({ url: "" })).name = "backGround";

   // Oculta el esqueleto de manos y desactiva el pinch-2 (pulgar-dedo medio) de teletransporte
   window.suppress_vrWidgets = true;
   const _origPinch = clientState.pinch;
   clientState.pinch = (id, hand, i) => i === 2 ? false : _origPinch(id, hand, i);

   // ── Debug HUD ─────────────────────────────────────────────────────────────
   const DEBUG_HUD = false;
   const DEBUG_HUD_DISTANCE = 1;
   const DEBUG_HUD_DOWN = 0.45;
   const DEBUG_HUD_RIGHT = 0.45;
   const DEBUG_HUD_SIZE = 0.08;

   // ── Marker square pose constants ──────────────────────────────────────────
   //
   // Why the depth is FORCED to QUEST_FOCAL_DISTANCE instead of being recovered
   // from the homography:
   //
   //   The PnP/homography solver has an inherent scale ambiguity — a 50 cm
   //   square at 1.3 m looks IDENTICAL in a single image to a 100 cm square at
   //   2.6 m. To get a metric depth, you have to know ONE of: the physical
   //   size of the model, OR the depth. We don't know the physical spacing of
   //   the user's red dots (it can be any size whiteboard), but we DO have
   //   a useful hint: the Meta Quest 3S has a fixed optical focal distance of
   //   ~1.3 m. The user is naturally going to stand at roughly that distance
   //   to read the writing comfortably.
   //
   //   So instead of trusting the recovered depth (which is wrong by an
   //   unknown factor), we anchor the zone center at exactly 1.3 m along the
   //   camera ray that points at the centroid of the four dots. Because a
   //   uniform scaling of the translation preserves the projections of all
   //   four corners onto the image plane, the four ArUco holograms end up
   //   projecting EXACTLY on top of the four red dots in the cast — and from
   //   the headset's own viewpoint they sit on the whiteboard.
   //
   const QUEST_FOCAL_DISTANCE = 1.3;   // meters — Quest 3S optical focal distance
   //
   // SQUARE_FL — pinhole focal length of the cast camera, in image-WIDTH-relative
   // units (i.e. the image is 1.0 unit wide). Drives both the per-dot ray-cast
   // for the live cyan reticles AND the homography-based pose recovery at lock
   // time. The relation to horizontal FOV:
   //     SQUARE_FL = 0.5 / tan(H_FOV / 2)
   //
   //   0.5  → 90° H FOV (a generic "wide" assumption — almost certainly wrong
   //                     for the Quest 3S cast)
   //   0.6  → 80° H FOV
   //   0.68 → 73° H FOV  ← measured empirically on Quest 3S cast (default)
   //   0.7  → 71° H FOV
   //   0.75 → 67° H FOV
   //
   // The right value is whatever makes the cyan reticles land EXACTLY on the
   // physical red dots in PREVIEW mode. If they're pushed outward from center,
   // SQUARE_FL is too small; if pulled inward, it's too big. Adjust live with
   // the [  and  ] keys on the PC (see keyboard handler farther down). The
   // value is broadcast via mandarinState.squareFL so both clients agree.
   //
   // Declared with `let` rather than `const` so the keyboard tuner can update
   // it at runtime without a page reload.
   let   SQUARE_FL            = 0.68;  // empirically calibrated for Quest 3S cast
   const SQUARE_FL_STEP       = 0.02;  // [ / ] increment when tuning
   const SQUARE_FL_MIN        = 0.30;  // ≈ 118° H FOV — sanity floor
   const SQUARE_FL_MAX        = 1.20;  // ≈ 45°  H FOV — sanity ceiling
   const SOLVE_SIZE           = 1.0;   // arbitrary unit for the solver — gets normalized
                                       // away by the depth-anchoring step below
   const ARUCO_SIZE           = 0.03;  // physical side of each ArUco hologram, in meters

   // ── Joystick zone-resize constants ────────────────────────────────────────
   //
   // DISABLED (JOYSTICK_RESIZE_ENABLED = false) by default because the
   // navigator.getGamepads() axis values on Quest 3S exhibit sub-deadzone drift
   // that, accumulated over a few seconds at 0.4 m/s, grows the zone to fill the
   // whole field of view even when the user isn't touching the stick. The exact
   // drift pattern is hardware-specific. To re-enable later, flip the flag and
   // bump JOYSTICK_DEADZONE to ≥0.4 — that typically clears the drift band.
   const JOYSTICK_RESIZE_ENABLED = false;
   const JOYSTICK_SPEED    = 0.4;     // meters per second at full deflection
   const JOYSTICK_DEADZONE = 0.15;    // ignore tiny stick noise
   const ZONE_HALF_MIN     = 0.05;    // 5 cm   — never let zone collapse to nothing
   const ZONE_HALF_MAX     = 3.0;     // 3 m    — generous upper bound

   // ── Per-dot live indicator (visual feedback for detected red dots) ────────
   // Cyan target reticle that floats at QUEST_FOCAL_DISTANCE on each red dot's
   // ray, recomputed every frame from the LIVE srcCorners. Lets the user see
   // the math working in real time BEFORE committing the zone with the trigger.
   //
   // Cyan (not red) on purpose — the backend's HSV detector hunts for red
   // blobs, and rendering 4 red holograms back into the casted view risks
   // creating false positives. A cyan reticle is invisible to the HSV pipeline
   // and visually distinct enough from the physical dot that the user can tell
   // them apart at a glance.
   const DOT_INDICATOR_HALF = 0.04;   // 4 cm half-side → 8 cm reticle

   // ── Hanzi VFX constants (TUNE THESE) ──────────────────────────────────────
   const HANZI_LINE_LEN  = 0.04;  // meters — length of cardinal lines from bbox edge to panel
   const HANZI_PANEL_MUL = 1.5;   // panel side = HANZI_PANEL_MUL × max(bbox_w, bbox_h)

   // ── VFX choreography (seconds, relative to event start) ───────────────────
   // Hanzi event (fires when a new character is detected):
   //   0.0 - 0.6   sparks fly outward from bbox center
   //   0.6 - 1.2   cardinal lines extend from bbox edges
   //   1.2 - 1.8   info panels grow + fade in
   const T_SPARK_DUR   = 0.6;
   const T_LINE_START  = T_SPARK_DUR;                   // 0.6
   const T_LINE_DUR    = 0.6;
   const T_PANEL_START = T_LINE_START + T_LINE_DUR;     // 1.2
   const T_PANEL_DUR   = 0.6;
   // Surface event (fires when lockCounter advances):
   //   0.0 - 1.5   LIDAR-style scan across the zone, then fades
   //   perimeter persists indefinitely after that
   const T_SURFACE_SCAN = 1.5;

   let frameCounter = 0;

   // ── G2 canvases for VFX (coplanar with the zone) ──────────────────────────
   let g2Surface = new G2();   // LIDAR scan + persistent perimeter
   let g2HanziFX = new G2();   // sparks + cardinal lines

   // ── G2 canvases for info panels ───────────────────────────────────────────
   let g2Char    = new G2();
   let g2Pinyin  = new G2();
   let g2Meaning = new G2();
   let g2Image   = new G2();
   let g2AI      = new G2();
   let g2Debug   = new G2();

   // ── G2 canvas for the per-dot live reticle ────────────────────────────────
   // Single canvas shared by all four indicator panels (they all look the same).
   let g2DotIndicator = new G2();

   // ── Texture slot assignments ──────────────────────────────────────────────
   // 0-3 = ArUco PNGs (TL, TR, BR, BL)
   // 4   = panelChar (currently hidden, kept for future use)
   // 5   = panelPinyin
   // 6   = panelImage
   // 7   = panelAI
   // 8   = panelDebug
   // 9   = g2Surface (LIDAR + perimeter)
   // 10  = g2HanziFX (sparks + lines)
   // 11  = panelMeaning
   // 12  = g2DotIndicator (per-dot live reticle, shared by all 4 indicators)
   model.txtrSrc(0, '../media/mrandarin/ArUco_0.png');
   model.txtrSrc(1, '../media/mrandarin/ArUco_1.png');
   model.txtrSrc(2, '../media/mrandarin/ArUco_2.png');
   model.txtrSrc(3, '../media/mrandarin/ArUco_3.png');
   model.txtrSrc(4,  g2Char.getCanvas());
   model.txtrSrc(5,  g2Pinyin.getCanvas());
   model.txtrSrc(6,  g2Image.getCanvas());
   model.txtrSrc(7,  g2AI.getCanvas());
   model.txtrSrc(8,  g2Debug.getCanvas());
   model.txtrSrc(9,  g2Surface.getCanvas());
   model.txtrSrc(10, g2HanziFX.getCanvas());
   model.txtrSrc(11, g2Meaning.getCanvas());
   model.txtrSrc(12, g2DotIndicator.getCanvas());

   // ── Render order matters: later .add() calls draw ON TOP of earlier ones ──
   // Stack (bottom → top):
   //   1. Surface VFX & Hanzi VFX (coplanar with the workspace)
   //   2. Info panels (above the VFX, below the ArUco holograms)
   //   3. ArUco holograms (always on top — they're the OpenCV tracking targets,
   //      they MUST remain visible to the headset's casted view at all times,
   //      especially during the VFX animation)
   //   4. Dot indicators (topmost — pre-lock visual feedback only; hidden after lock)

   // 1. VFX layers (deepest)
   let surfaceObj = model.add('square').txtr(9).dull();
   let hanziFXObj = model.add('square').txtr(10).dull();

   // 2. Info panels
   let panelChar    = model.add('square').txtr(4).dull();
   let panelPinyin  = model.add('square').txtr(5).dull();
   let panelImage   = model.add('square').txtr(6).dull();
   let panelAI      = model.add('square').txtr(7).dull();
   let panelMeaning = model.add('square').txtr(11).dull();
   let panelDebug   = model.add('square').txtr(8).scale(DEBUG_HUD_SIZE).dull();
   if (!DEBUG_HUD) panelDebug.move(0, -999, 0);

   // 3. ArUco holograms
   let arucoTL = model.add('square').txtr(0).dull();
   let arucoTR = model.add('square').txtr(1).dull();
   let arucoBR = model.add('square').txtr(2).dull();
   let arucoBL = model.add('square').txtr(3).dull();

   // 4. Per-dot live indicators — one cyan reticle per detected red dot,
   //    placed at QUEST_FOCAL_DISTANCE on each dot's individual camera ray and
   //    recomputed every frame. Shown in PREVIEW (no zone yet, srcCorners
   //    fresh) and hidden after lock.
   let dotInd0 = model.add('square').txtr(12).dull();
   let dotInd1 = model.add('square').txtr(12).dull();
   let dotInd2 = model.add('square').txtr(12).dull();
   let dotInd3 = model.add('square').txtr(12).dull();

   // Hide everything off-screen until first zone capture / character detection.
   const HIDDEN_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -999, 0, 1];
   surfaceObj.setMatrix(HIDDEN_MATRIX);
   hanziFXObj.setMatrix(HIDDEN_MATRIX);
   panelChar.setMatrix(HIDDEN_MATRIX);     // permanently hidden for now (per spec)
   panelPinyin.setMatrix(HIDDEN_MATRIX);
   panelImage.setMatrix(HIDDEN_MATRIX);
   panelAI.setMatrix(HIDDEN_MATRIX);
   panelMeaning.setMatrix(HIDDEN_MATRIX);
   arucoTL.setMatrix(HIDDEN_MATRIX);
   arucoTR.setMatrix(HIDDEN_MATRIX);
   arucoBR.setMatrix(HIDDEN_MATRIX);
   arucoBL.setMatrix(HIDDEN_MATRIX);
   dotInd0.setMatrix(HIDDEN_MATRIX);
   dotInd1.setMatrix(HIDDEN_MATRIX);
   dotInd2.setMatrix(HIDDEN_MATRIX);
   dotInd3.setMatrix(HIDDEN_MATRIX);

   // ── Display state ─────────────────────────────────────────────────────────
   let displayChar    = null;
   let displayPinyin  = null;
   let displayMeaning = null;
   let displayImage   = null;
   let displayAI      = null;

   // ── VFX state ─────────────────────────────────────────────────────────────
   let surfaceActive   = false;     // becomes true on first lock; stays true (perimeter persists)
   let surfaceStartTime = 9999.0;   // model.time when last lock fired (re-triggered each lock)
   let hanziActive     = false;     // true while a character is being shown
   let hanziStartTime  = 9999.0;    // model.time when current character first appeared

   // ── PC-only debug overlay (created later if we are master) ────────────────
   let debugDiv = null;             // HTML <div> shown on the PC window
   let lastServerResult = null;     // last raw response from /predict

   // ─────────────────────────────────────────────────────────────────────────
   // INFO PANEL RENDERS
   // ─────────────────────────────────────────────────────────────────────────
   // The panels share a common style: dark blue-tinted bg + cyan border + content.
   // panelMeaning and panelPinyin also get small uppercase titles; panelImage
   // and panelAI just show their content.
   // The `alpha` driver is the panel-progress eased value, so the panels fade
   // in alongside their grow animation (T_PANEL_START..T_PANEL_DUR).

   function panelAlpha() {
      if (!hanziActive) return 0;
      const t = model.time - hanziStartTime;
      const pp = Math.max(0, Math.min(1, (t - T_PANEL_START) / T_PANEL_DUR));
      return pp;
   }

   function drawPanelChrome(g2, alpha) {
      const ctx = g2.getContext(), canvas = g2.getCanvas();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (alpha <= 0) return false;
      // Background
      g2.setColor([0.02, 0.05, 0.1, 0.85 * alpha]);
      g2.fillRect(-1, -1, 2, 2);
      // Border
      g2.setColor([0.0, 1.0, 0.9, 0.5 * alpha]);
      g2.lineWidth(0.04);
      g2.drawPath([[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]);
      return true;
   }

   g2Char.render = function () {
      // Hidden by spec for now — never drawn.
      const ctx = this.getContext(), canvas = this.getCanvas();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
   };

   g2Pinyin.render = function () {
      const alpha = panelAlpha();
      if (!drawPanelChrome(this, alpha)) return;
      if (!displayPinyin) return;
      // Small title
      this.setColor([0.0, 1.0, 0.9, alpha]);
      this.textHeight(0.13);
      this.text('PINYIN', 0, 0.65, 'center');
      // Pinyin reading
      this.setColor([1, 1, 1, alpha]);
      this.textHeight(0.32);
      this.text(displayPinyin, 0, -0.05, 'center');
   };

   g2Meaning.render = function () {
      const alpha = panelAlpha();
      if (!drawPanelChrome(this, alpha)) return;
      if (!displayMeaning) return;
      // Small title
      this.setColor([0.0, 1.0, 0.9, alpha]);
      this.textHeight(0.13);
      this.text('MEANING', 0, 0.65, 'center');
      // Meaning — capped to first '/' segment per spec ("máximo 1 meaning")
      const firstMeaning = displayMeaning.split('/')[0].trim();
      this.setColor([1, 1, 1, alpha]);
      this.textHeight(0.22);
      this.text(firstMeaning, 0, -0.05, 'center');
   };

   g2Image.render = function () {
      const alpha = panelAlpha();
      if (!drawPanelChrome(this, alpha)) return;
      if (displayImage) {
         const ctx = this.getContext();
         const canvas = this.getCanvas();
         const W = canvas.width;
         const H = canvas.height;
         const margin = 0.05 * W;
         const pw = W - 2 * margin;
         const ph = H - 2 * margin;
         const imgAspect = displayImage.width / displayImage.height;
         const boxAspect = pw / ph;
         let dw, dh;
         if (imgAspect > boxAspect) { dw = pw; dh = pw / imgAspect; }
         else                       { dh = ph; dw = ph * imgAspect; }
         const dx = margin + (pw - dw) / 2;
         const dy = margin + (ph - dh) / 2;
         // Apply alpha to the image draw
         ctx.globalAlpha = alpha;
         ctx.drawImage(displayImage, dx, dy, dw, dh);
         ctx.globalAlpha = 1.0;
      } else {
         this.setColor([0.3, 0.3, 0.3, alpha]);
         this.textHeight(0.12);
         this.text('loading image...', 0, 0, 'center');
      }
   };

   g2AI.render = function () {
      const alpha = panelAlpha();
      if (!drawPanelChrome(this, alpha)) return;
      if (displayAI) {
         this.setColor([0.85, 0.85, 0.85, alpha]);
         this.textHeight(0.13);
         const words = displayAI.split(' ');
         const lines = [];
         let line = '';
         for (const w of words) {
            if ((line + w).length > 20) { lines.push(line.trim()); line = ''; }
            line += w + ' ';
         }
         if (line.trim()) lines.push(line.trim());
         this.text(lines.join('\n'), 0, 0, 'center');
      } else {
         this.setColor([0.3, 0.3, 0.3, alpha]);
         this.textHeight(0.12);
         this.text('asking AI...', 0, 0, 'center');
      }
   };

   g2Debug.render = function () {
      this.setColor([0.05, 0.05, 0.05, 0.85]);
      this.fillRect(-1, -1, 2, 2);

      const role = (typeof clientID !== 'undefined' && clients && clientID == clients[0]) ? 'PC' : 'HEADSET';
      const status = mandarinState.status || '—';
      const char = mandarinState.character || '—';

      this.setColor([0.6, 0.85, 1, 1]);
      this.textHeight(0.13);
      this.text('MRandarin debug', 0, 0.85, 'center');

      this.setColor([0.85, 0.85, 0.85, 1]);
      this.textHeight(0.11);
      const lines = [
         'role: ' + role,
         'frame: ' + frameCounter,
         'status: ' + status,
         'char: ' + char,
      ];
      for (let i = 0; i < lines.length; i++) {
         this.text(lines[i], -0.9, 0.55 - i * 0.22, 'left');
      }
   };

   // ─────────────────────────────────────────────────────────────────────────
   // DOT INDICATOR RENDER (static — drawn once, reused every frame)
   // ─────────────────────────────────────────────────────────────────────────
   // Cyan target reticle: outer ring + 4 tick crosshairs + inner filled dot.
   // The center is left clear so the user can see the physical red dot through
   // the reticle when they're aligned. Same drawing for all 4 indicator panels;
   // they share the texture and only differ in their world-space placement.
   g2DotIndicator.render = function () {
      const ctx = this.getContext(), canvas = this.getCanvas();
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Outer ring
      this.setColor([0.4, 0.95, 1.0, 0.95]);
      this.lineWidth(0.08);
      const segs = 32, r = 0.85;
      const ring = [];
      for (let i = 0; i <= segs; i++) {
         const a = (i / segs) * Math.PI * 2;
         ring.push([Math.cos(a) * r, Math.sin(a) * r]);
      }
      this.drawPath(ring);

      // 4 crosshair tick marks (with a gap in the middle for the dot)
      this.lineWidth(0.06);
      this.drawPath([[-0.55, 0],   [-0.20, 0]]);
      this.drawPath([[ 0.20, 0],   [ 0.55, 0]]);
      this.drawPath([[0, -0.55],   [0, -0.20]]);
      this.drawPath([[0,  0.20],   [0,  0.55]]);

      // Bright center dot (filled)
      this.setColor([0.7, 1.0, 1.0, 1.0]);
      this.fillOval(-0.08, -0.08, 0.16, 0.16);
   };
   // Render the canvas once at init — its content never changes (no animation).
   g2DotIndicator.update();

   // ─────────────────────────────────────────────────────────────────────────
   // SURFACE VFX RENDER (LIDAR scan + persistent perimeter)
   // ─────────────────────────────────────────────────────────────────────────
   // The G2 canvas spans [-1..1] which maps to the full marker zone (corner
   // ArUcos sit at ±1, ±1 in this canvas's space). All drawing happens in
   // this normalized space.
   g2Surface.render = function () {
      const ctx = this.getContext(), canvas = this.getCanvas();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!surfaceActive) return;

      const t = model.time - surfaceStartTime;
      if (t < 0) return;

      // Persistent perimeter — fades in linearly to alpha 0.5, stays there forever
      const borderAlpha = Math.min(0.5, t * 0.5);
      this.setColor([0.0, 1.0, 0.9, borderAlpha]);
      this.lineWidth(0.015);
      this.drawPath([[-0.98, -0.98], [0.98, -0.98], [0.98, 0.98], [-0.98, 0.98], [-0.98, -0.98]]);

      // Initial LIDAR scan — only during the first T_SURFACE_SCAN seconds after lock
      if (t <= T_SURFACE_SCAN) {
         let pulseAlpha = 1.0;
         if (t > 1.0) pulseAlpha = 1.0 - ((t - 1.0) * 2.0);

         const maxRadius    = t * 2.8;
         const waveGlowSize = 0.4;

         // Cross-pattern dots that light up as the wave passes through
         const step = 0.15, crossSize = 0.015;
         this.lineWidth(0.008);
         for (let x = -0.9; x <= 0.9; x += step) {
            for (let y = -0.9; y <= 0.9; y += step) {
               const dist = Math.sqrt(x * x + y * y);
               const distanceToWave = maxRadius - dist;
               if (distanceToWave > 0 && distanceToWave < waveGlowSize) {
                  const dotAlpha = (1.0 - (distanceToWave / waveGlowSize)) * pulseAlpha;
                  this.setColor([0.0, 1.0, 0.9, dotAlpha * 0.7]);
                  this.drawPath([[x - crossSize, y], [x + crossSize, y]]);
                  this.drawPath([[x, y - crossSize], [x, y + crossSize]]);
               }
            }
         }

         // Expanding ring
         this.setColor([0.0, 1.0, 0.9, 0.5 * pulseAlpha]);
         this.lineWidth(0.02);
         this.drawOval(-maxRadius, -maxRadius, maxRadius * 2, maxRadius * 2);
      }
   };

   // ─────────────────────────────────────────────────────────────────────────
   // HANZI VFX RENDER (sparks + cardinal lines, anchored to bbox)
   // ─────────────────────────────────────────────────────────────────────────
   // Same coordinate space as g2Surface: [-1..1] = full zone area.
   // The bbox (in zone-relative percentages) is converted to this space and
   // used as the origin for all the FX.
   //
   // Conversion image-pct → G2 space:
   //   gx = 2*char_x_pct - 1
   //   gy = 1 - 2*char_y_pct      (image Y goes down, G2/world Y goes up)
   //   half_w_g2 = bbox_w_pct     (half-width because pct→[-1..1] doubles)
   //   half_h_g2 = bbox_h_pct
   //
   // Line length in G2 space (post-resize):
   //   The G2 canvas spans the zone in BOTH axes, but the zone may be
   //   non-square after the joystick stretches it. So one meter is worth
   //   1/halfX G2 units horizontally and 1/halfY G2 units vertically.
   g2HanziFX.render = function () {
      const ctx = this.getContext(), canvas = this.getCanvas();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!hanziActive) return;

      const t = model.time - hanziStartTime;
      if (t < 0) return;

      const cxp = mandarinState.char_x_pct;
      const cyp = mandarinState.char_y_pct;
      const wp  = mandarinState.bbox_w_pct;
      const hp  = mandarinState.bbox_h_pct;
      if (cxp == null || cyp == null || wp == null || hp == null) return;

      const cx = 2 * cxp - 1;        // bbox center X in G2 [-1..1]
      const cy = 1 - 2 * cyp;        // bbox center Y in G2 [-1..1]
      const hw = wp;                 // bbox half-width in G2
      const hh = hp;                 // bbox half-height in G2

      // ── Phase 1: SPARKS (radial particles flying out from bbox center) ────
      if (t < T_SPARK_DUR) {
         const p = t / T_SPARK_DUR;
         this.setColor([0.5, 1.0, 1.0, 1.0 - p]);
         for (let i = 0; i < 8; i++) {
            const angle = i * Math.PI / 4;
            const r = p * 0.4;
            const x = cx + Math.cos(angle) * r - 0.01;
            const y = cy + Math.sin(angle) * r - 0.01;
            this.fillOval(x, y, 0.02, 0.02);
         }
      }

      // ── Phase 2: CARDINAL LINES (extend from bbox edge midpoints) ─────────
      // Lines stay drawn after they finish extending (during panel phase).
      if (t >= T_LINE_START) {
         const lp = Math.min(1, (t - T_LINE_START) / T_LINE_DUR);

         // Per-axis G2 line lengths — accounts for non-square zone after
         // joystick stretching. Falls back to a sensible default if the zone
         // hasn't been captured yet (shouldn't happen since hanziActive
         // implies a zone exists, but guards against initialization races).
         const hX = activeZone ? activeZone.halfX : 0.25;
         const hY = activeZone ? activeZone.halfY : 0.25;
         const lineLenG2_X = HANZI_LINE_LEN / hX;
         const lineLenG2_Y = HANZI_LINE_LEN / hY;
         const targetX = lineLenG2_X * lp;
         const targetY = lineLenG2_Y * lp;

         this.setColor([0.0, 1.0, 0.9, 0.8]);
         this.lineWidth(0.015);

         // TOP    — from (cx, cy + hh) upward
         this.drawPath([[cx, cy + hh], [cx, cy + hh + targetY]]);
         // BOTTOM — from (cx, cy - hh) downward
         this.drawPath([[cx, cy - hh], [cx, cy - hh - targetY]]);
         // LEFT   — from (cx - hw, cy) leftward
         this.drawPath([[cx - hw, cy], [cx - hw - targetX, cy]]);
         // RIGHT  — from (cx + hw, cy) rightward
         this.drawPath([[cx + hw, cy], [cx + hw + targetX, cy]]);
      }
   };

   // ─────────────────────────────────────────────────────────────────────────
   // FETCH WIKIPEDIA IMAGE + AI SENTENCE
   // ─────────────────────────────────────────────────────────────────────────
   async function fetchWikiAndAI(meaning) {
      if (!meaning) return;
      const wikiTerm = meaning.split('/')[0].trim();

      try {
         const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(wikiTerm)}`);
         const data = await res.json();
         if (data.thumbnail && data.thumbnail.source) {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.src = data.thumbnail.source;
            img.onload = () => { displayImage = img; };
         }
      } catch (e) {
         console.warn('Wikipedia fetch failed:', e);
      }

      try {
         const prompt = `In 6 words or less, give one factual and memorable sentence about "${wikiTerm}". No metaphors, just a clear memorable fact.`;
         displayAI = await askAI(prompt);
      } catch (e) {
         console.warn('AI fetch failed:', e);
         displayAI = '';
      }
   }

   function hidePanels() {
      displayChar = displayPinyin = displayMeaning = displayImage = displayAI = null;
      lastFetchedMeaning = null;
      hanziActive = false;
   }

   // ── Manual lock trigger (headset controller button) ───────────────────────
   // Fires on whichever client receives the input — typically the headset,
   // since that's where the controllers are. Bumps lockCounter and broadcasts
   // so the PC Master can pick it up via synchronize at the top of animate.
   inputEvents.onPress = hand => {
      mandarinState.lockCounter = (mandarinState.lockCounter || 0) + 1;
      server.broadcastGlobal('mandarinState');
      console.log('[MRandarin] lock pressed (' + hand + ')');
   };

   // ── MASTER CLIENT (PC) ONLY ──────────────────────────────────────────────
   if (clientID == clients[0]) {

      mandarinState.status     = 'empty';
      mandarinState.character  = null;
      mandarinState.pinyin     = null;
      mandarinState.meaning    = null;
      mandarinState.erased     = false;
      mandarinState.srcCorners = null;
      mandarinState.frameW     = 0;
      mandarinState.frameH     = 0;
      mandarinState.char_x_pct = null;
      mandarinState.char_y_pct = null;
      mandarinState.bbox_w_pct = null;
      mandarinState.bbox_h_pct = null;

      let canvas = document.createElement('canvas');
      let ctx = canvas.getContext('2d', { willReadFrequently: true });

      canvas.style.cssText = `
         position: fixed;
         bottom: 10px;
         right: 10px;
         width: 480px;
         height: auto;
         border: 3px solid lime;
         z-index: 99999;
         background: #000;
         display: block;
      `;
      document.body.appendChild(canvas);

      let btn = document.createElement('button');
      btn.innerText = '📷 Start Capture';
      btn.style.cssText = 'position:fixed;bottom:10px;left:10px;z-index:99999;padding:10px 20px;font-size:16px;cursor:pointer;';
      document.body.appendChild(btn);

      // ── PC debug overlay ───────────────────────────────────────────────────
      debugDiv = document.createElement('div');
      debugDiv.style.cssText = `
         position: fixed;
         top: 10px;
         right: 10px;
         width: 380px;
         padding: 12px 14px;
         background: rgba(0, 0, 0, 0.85);
         color: #ddd;
         font-family: 'Courier New', monospace;
         font-size: 12px;
         line-height: 1.45;
         z-index: 99999;
         border: 1px solid #555;
         white-space: pre;
         pointer-events: none;
         border-radius: 4px;
      `;
      debugDiv.textContent = 'MR debug — waiting for first server reply…';
      document.body.appendChild(debugDiv);

      btn.addEventListener('click', async () => {
         btn.disabled = true;
         btn.innerText = 'Capturing...';
         try {
            const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            const video = document.createElement('video');
            video.srcObject = stream;
            video.play();
            video.onloadedmetadata = () => {
               canvas.width = video.videoWidth;
               canvas.height = video.videoHeight;
               setInterval(() => ctx.drawImage(video, 0, 0), 30);
               btn.innerText = '✅ Capturing';
            };
         } catch (err) {
            console.error(err);
            btn.disabled = false;
            btn.innerText = '📷 Start Capture';
         }
      });

      let isPolling = false;

      async function pollServer() {
         if (isPolling) return;
         if (canvas.width <= 300 || canvas.height <= 150) return;
         isPolling = true;

         const frameW = canvas.width;
         const frameH = canvas.height;

         try {
            const base64 = canvas.toDataURL('image/png').split(',')[1];
            const response = await fetch('http://localhost:1111/predict', {
               method: 'POST',
               headers: { 'Content-Type': 'application/json' },
               body: JSON.stringify({ image: base64 })
            });
            const result = await response.json();
            lastServerResult = result;
            console.log('[MRandarin] server result:', JSON.stringify(result));

            // Always refresh corners + frame dims whenever the backend sends them
            // (now sent on ANY valid quad, even a blank whiteboard). This lets
            // activeZone capture on the very first poll — before the user writes
            // anything — and stops 'erased' from wiping the workspace pose.
            if (result.src_corners) {
               mandarinState.srcCorners = result.src_corners;
               mandarinState.frameW = frameW;
               mandarinState.frameH = frameH;
            }

            if (result.character) {
               mandarinState.status     = 'drawn';
               mandarinState.character  = result.character;
               mandarinState.pinyin     = result.pinyin;
               mandarinState.meaning    = result.meaning;
               mandarinState.erased     = false;
               // Bbox info — needed by the headset to anchor the hanzi VFX
               // around the actual character location on the surface.
               mandarinState.char_x_pct = result.char_x_pct ?? null;
               mandarinState.char_y_pct = result.char_y_pct ?? null;
               mandarinState.bbox_w_pct = result.bbox_w_pct ?? null;
               mandarinState.bbox_h_pct = result.bbox_h_pct ?? null;
            }

            else if (result.erased === true) {
               mandarinState.status     = 'empty';
               mandarinState.character  = null;
               mandarinState.pinyin     = null;
               mandarinState.meaning    = null;
               mandarinState.erased     = true;
               mandarinState.char_x_pct = null;
               mandarinState.char_y_pct = null;
               mandarinState.bbox_w_pct = null;
               mandarinState.bbox_h_pct = null;
               // srcCorners/frameW/frameH intentionally preserved — the physical
               // zone is still there, only the character was erased.
            }
            // else: server is locked — no change
         } catch (err) {
            console.error('server error:', err);
         } finally {
            isPolling = false;
         }
      }

      setInterval(pollServer, 500);

      // ── Reset key (R) — clears the current zone & reverts backend state ───
      window.addEventListener('keydown', (e) => {
         if (e.key !== 'r' && e.key !== 'R') return;
         console.log('[MRandarin] reset key pressed');
         mandarinState.resetCounter = (mandarinState.resetCounter || 0) + 1;
         mandarinState.srcCorners   = null;
         mandarinState.frameW       = 0;
         mandarinState.frameH       = 0;
         mandarinState.character    = null;
         mandarinState.pinyin       = null;
         mandarinState.meaning      = null;
         mandarinState.status       = 'empty';
         mandarinState.erased       = false;
         mandarinState.char_x_pct   = null;
         mandarinState.char_y_pct   = null;
         mandarinState.bbox_w_pct   = null;
         mandarinState.bbox_h_pct   = null;
         mandarinState.zoneHalfX    = null;   // joystick state cleared too
         mandarinState.zoneHalfY    = null;
         fetch('http://localhost:1111/reset', { method: 'POST' })
            .catch(err => console.warn('[MRandarin] /reset failed:', err));
      });

      // ── SQUARE_FL tuner ([ / ])  ───────────────────────────────────────────
      // Live calibration of the cast camera's focal length. PC-only. The new
      // value is published via mandarinState.squareFL; the headset reads that
      // every animation frame (see "FL sync" block in animate()) so both ends
      // use the same FL for ray-casting and homography.
      //
      // Workflow: stand in front of your 4 red dots so PREVIEW mode is active,
      // then tap [ or ] until the cyan reticles overlap the dots in the cast.
      // The reticles are recomputed every frame, so you'll see them move as
      // you adjust. Console logs the value each step so you can record it.
      window.addEventListener('keydown', (e) => {
         if (e.key !== '[' && e.key !== ']') return;
         const sign = (e.key === ']') ? +1 : -1;
         const next = Math.max(
            SQUARE_FL_MIN,
            Math.min(SQUARE_FL_MAX, SQUARE_FL + sign * SQUARE_FL_STEP)
         );
         SQUARE_FL = next;
         mandarinState.squareFL = next;
         server.broadcastGlobal('mandarinState');
         const fov = (2 * Math.atan(0.5 / next) * 180 / Math.PI).toFixed(1);
         console.log('[MRandarin] SQUARE_FL = ' + next.toFixed(3) +
                     '   (≈ ' + fov + '° H FOV)');
      });
   }

   // ── ALL CLIENTS ───────────────────────────────────────────────────────────
   let lastCharacter = undefined;
   let lastFetchedMeaning = null;
   let lastViewMatrix = null;
   let localPanelMatrix = null;       // recomputed when a new character is detected (uses LOCAL viewMatrix)
   let activeZone = null;             // { matrix, halfX, halfY } captured ONCE on first valid srcCorners; persists through erase
   let lastResetCounter = 0;
   let lastLockCounter  = 0;
   let lastFrameTime    = 0;          // for joystick dt

   // Build a square→model-space pose from the four image-space corners returned
   // by the server. Uses THIS client's current inverseViewMatrix(0), so when run
   // on the headset the result is anchored to the user's actual head pose.
   //
   // Returns { matrix, halfExtent } or null:
   //   matrix     — 4×4 column-major, basis vectors are UNIT, translation in meters
   //   halfExtent — meters from zone center to a corner along an axis. The
   //                initial zone is a square; the joystick may later stretch it
   //                non-uniformly (handled outside this fn via halfX/halfY).
   //
   // The depth is FORCED to QUEST_FOCAL_DISTANCE — see the long comment near
   // the constants for why. Net effect: regardless of how big the physical red
   // dot pattern actually is, the four ArUco holograms project onto the four
   // red dots in the cast image, and sit at 1.3 m depth along the camera ray.
   function computeLocalPanelMatrix(srcCorners, frameW, frameH) {
      if (!srcCorners || !frameW || !frameH) return null;

      // Server gives [TL, TR, BR, BL] (image, normalized 0..1).
      // computeCameraPose's model order is [BL, BR, TR, TL] (math convention, y up).
      const reordered = [srcCorners[3], srcCorners[2], srcCorners[1], srcCorners[0]];
      const aspect = frameH / frameW;
      const C = [];
      for (const [u, v] of reordered) {
         C.push(u - 0.5);
         C.push(-(v - 0.5) * aspect);   // image y is down; flip + aspect-correct
      }

      // SOLVE_SIZE is arbitrary — the depth-anchoring step below cancels its
      // effect on the final pose. Using 1.0 keeps the math readable.
      const squareToCameraCV = computeCameraPose(C, SQUARE_FL, SOLVE_SIZE);
      // CV convention (camera looks +z) → GL/WebXR convention (camera looks -z).
      const flipZ = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];
      const squareToCamera = mxm(flipZ, squareToCameraCV);

      // ── DEPTH ANCHORING ──────────────────────────────────────────────────
      // Recovered translation magnitude is in SOLVE_SIZE units, scaled by the
      // (unknown) ratio between SOLVE_SIZE and the real-world spacing. We
      // compute that magnitude and scale everything so the zone center sits
      // at exactly QUEST_FOCAL_DISTANCE along the camera ray.
      //
      // Scaling translation uniformly preserves the camera-space projections
      // of the four model corners (a model point M_i maps to image pixel f *
      // R*M_i / (R*M_i + t)·ẑ, and uniformly scaling t while ALSO uniformly
      // scaling M_i — which is what halfExtent does — preserves the ratio,
      // so projections are fixed). That's why ArUcos lock onto the red dots.
      const tx = squareToCamera[12];
      const ty = squareToCamera[13];
      const tz = squareToCamera[14];
      const currentDepth = Math.sqrt(tx*tx + ty*ty + tz*tz);
      if (!isFinite(currentDepth) || currentDepth <= 1e-6) return null;
      const scale = QUEST_FOCAL_DISTANCE / currentDepth;
      squareToCamera[12] = tx * scale;
      squareToCamera[13] = ty * scale;
      squareToCamera[14] = tz * scale;
      const halfExtent = (SOLVE_SIZE / 2) * scale;
      // ─────────────────────────────────────────────────────────────────────

      // Use THIS client's current camera→world transform.
      const captureView = clay.root().inverseViewMatrix(0);
      const M_world = mxm(captureView, squareToCamera);

      // Convert world space (system A) → model space (system B), where panel
      // nodes live. With worldCoords = identity these match; if the user has
      // pinched to move/rotate the world, this keeps panels anchored correctly.
      const inverseWC = (typeof clay !== 'undefined' && clay.inverseRootMatrix)
         ? clay.inverseRootMatrix
         : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      const M = mxm(inverseWC, M_world);

      if (M.some(n => !isFinite(n))) return null;
      return { matrix: M, halfExtent };
   }

   // Position `panel` at world point `pos`, oriented by `mat`'s basis, scaled
   // by sizeX and sizeY (HALF-extents because the unit square spans [-1..1]).
   // If sizeY is omitted, the panel is square (sizeY = sizeX).
   function placePanelAt(panel, pos, mat, sizeX, sizeY) {
      if (sizeY === undefined) sizeY = sizeX;
      panel.setMatrix([
         mat[0] * sizeX, mat[1] * sizeX, mat[2] * sizeX, 0,
         mat[4] * sizeY, mat[5] * sizeY, mat[6] * sizeY, 0,
         mat[8],         mat[9],         mat[10],        0,
         pos[0],         pos[1],         pos[2],         1,
      ]);
   }

   // ── Right-thumbstick reader ────────────────────────────────────────────
   // Returns [dx, dy] in [-1, 1] for the right Quest controller's stick.
   // dy is flipped so that "stick up" is positive. PC/desktop returns [0, 0].
   function readRightJoystick() {
      try {
         const pads = navigator.getGamepads ? navigator.getGamepads() : [];
         for (let i = 0; i < pads.length; i++) {
            const gp = pads[i];
            if (!gp) continue;
            const isRight = gp.hand === 'right'
                         || gp.handedness === 'right'
                         || (gp.id && /right/i.test(gp.id));
            if (!isRight) continue;
            // Quest controllers expose [touchpadX, touchpadY, stickX, stickY].
            // Some browsers/runtimes only expose [stickX, stickY] — fall back.
            const ax = gp.axes || [];
            let x = 0, y = 0;
            if (ax.length >= 4)      { x = ax[2]; y = ax[3]; }
            else if (ax.length >= 2) { x = ax[0]; y = ax[1]; }
            if (Math.abs(x) < JOYSTICK_DEADZONE) x = 0;
            if (Math.abs(y) < JOYSTICK_DEADZONE) y = 0;
            return [x, -y];   // flip so up = positive
         }
      } catch (e) { /* no gamepads available */ }
      return [0, 0];
   }

   model.animate(() => {
      mandarinState = server.synchronize('mandarinState');
      if (clientID == clients[0]) {
         server.broadcastGlobal('mandarinState');
      }

      // ── FL sync (all clients) ──────────────────────────────────────────────
      // The PC's [ / ] keys mutate mandarinState.squareFL and broadcast. Pick
      // it up here on every frame so the headset's ray-casts use the same FL
      // as the PC. If the PC hasn't published one yet, keep our own default.
      if (typeof mandarinState.squareFL === 'number' &&
          isFinite(mandarinState.squareFL) &&
          mandarinState.squareFL > 0) {
         SQUARE_FL = mandarinState.squareFL;
      }

      // Keep the latest view matrix around for diagnostics.
      const _inv = clay.root().inverseViewMatrix(0);
      lastViewMatrix = [
         _inv[0], _inv[1], _inv[2], _inv[3],
         _inv[4], _inv[5], _inv[6], _inv[7],
         _inv[8], _inv[9], _inv[10], _inv[11],
         _inv[12], _inv[13], _inv[14], _inv[15],
      ];

      // ── Reset signal — clear local zone state when counter advances ───────
      const currentResetCounter = mandarinState.resetCounter || 0;
      if (currentResetCounter !== lastResetCounter) {
         lastResetCounter = currentResetCounter;
         activeZone     = null;
         surfaceActive  = false;        // wipe the surface VFX too
         hanziActive    = false;
         hidePanels();
         // Indicators are repositioned per-frame from srcCorners, but if the
         // reset clears srcCorners on the PC and the headset hasn't received
         // the fresh state yet, the indicators could briefly show stale poses.
         // Hide them explicitly so the visual reset is instantaneous.
         dotInd0.setMatrix(HIDDEN_MATRIX);
         dotInd1.setMatrix(HIDDEN_MATRIX);
         dotInd2.setMatrix(HIDDEN_MATRIX);
         dotInd3.setMatrix(HIDDEN_MATRIX);
      }

      // ── Lock signal — capture activeZone (all clients) + switch backend (PC only) ──
      // Bulletproof gate against spurious / repeated triggers:
      //   1. Strict monotonic check (>) — only ADVANCING the counter triggers.
      //   2. lastLockCounter is claimed FIRST, before any work.
      //   3. activeZone capture AND the /lock fetch are BOTH gated on
      //      srcCorners.
      //   4. activeZone === null gate — once a zone is locked, ALL subsequent
      //      trigger presses are ignored. The zone is meant to be captured ONCE
      //      and stay put. Without this guard, holding the trigger or accidental
      //      presses would re-capture the zone with whatever srcCorners are
      //      current, causing the box to "drift" or "grow" between presses.
      //      To capture a new zone the user must reset (R) first.
      const currentLock = mandarinState.lockCounter || 0;
      if (currentLock > lastLockCounter) {
         lastLockCounter = currentLock;
         if (activeZone) {
            console.log('[MRandarin] lock ignored — zone already locked. Press R to reset before re-locking.');
         } else if (mandarinState.srcCorners && mandarinState.frameW && mandarinState.frameH) {
            const pose = computeLocalPanelMatrix(
               mandarinState.srcCorners, mandarinState.frameW, mandarinState.frameH
            );
            if (pose) {
               // Initial zone: square, with each half-extent matching the
               // depth-anchored homography. ArUcos sit on the four red dots.
               // The joystick can stretch halfX / halfY non-uniformly later.
               activeZone = {
                  matrix: pose.matrix,
                  halfX:  pose.halfExtent,
                  halfY:  pose.halfExtent,
               };
               // Seed shared state so other clients use the same dimensions.
               mandarinState.zoneHalfX = pose.halfExtent;
               mandarinState.zoneHalfY = pose.halfExtent;
               // Trigger surface VFX scan animation
               surfaceActive    = true;
               surfaceStartTime = model.time;
               console.log('[MRandarin] zone locked → surface VFX triggered');
               // PC Master only — and only after we know srcCorners is real.
               if (clientID == clients[0]) {
                  fetch('http://localhost:1111/lock', { method: 'POST' })
                     .catch(err => console.warn('[MRandarin] /lock failed:', err));
               }
            } else {
               console.warn('[MRandarin] lock pressed but pose computation failed — keep all 4 dots in view and try again');
            }
         } else {
            console.warn('[MRandarin] lock pressed but no srcCorners available — point camera at the 4 red dots first, then press again');
         }
      }

      // ── Right-stick zone resize ────────────────────────────────────────────
      // Up/down → grow/shrink halfY (vertical); right/left → grow/shrink
      // halfX (horizontal). Symmetric expansion: the zone center stays put,
      // both edges move outward (or inward) together.
      //
      // GATED on JOYSTICK_RESIZE_ENABLED (currently false). When false, the
      // entire block is skipped — including the mandarinState.zoneHalfX/Y
      // sync, since nobody's writing those values either, so reading them
      // would just be noise. activeZone.halfX/Y stay locked at the values
      // captured at lock time, which is the safe default.
      //
      // To re-enable: flip the flag and consider raising JOYSTICK_DEADZONE
      // to ≥0.4 to absorb hardware drift on Quest 3S sticks.
      if (JOYSTICK_RESIZE_ENABLED && activeZone) {
         // Pull in any updates broadcast by another client (e.g., headset's
         // joystick reaches the PC for the debug overlay).
         if (typeof mandarinState.zoneHalfX === 'number') activeZone.halfX = mandarinState.zoneHalfX;
         if (typeof mandarinState.zoneHalfY === 'number') activeZone.halfY = mandarinState.zoneHalfY;

         const [jx, jy] = readRightJoystick();
         if (jx !== 0 || jy !== 0) {
            const dt = Math.max(0, Math.min(0.1, model.time - lastFrameTime));
            const dx = jx * JOYSTICK_SPEED * dt;
            const dy = jy * JOYSTICK_SPEED * dt;
            activeZone.halfX = Math.max(ZONE_HALF_MIN, Math.min(ZONE_HALF_MAX, activeZone.halfX + dx));
            activeZone.halfY = Math.max(ZONE_HALF_MIN, Math.min(ZONE_HALF_MAX, activeZone.halfY + dy));
            mandarinState.zoneHalfX = activeZone.halfX;
            mandarinState.zoneHalfY = activeZone.halfY;
            // Headset-side broadcast — PC master broadcasts every frame already.
            if (clientID != clients[0]) {
               server.broadcastGlobal('mandarinState');
            }
         }
      }
      lastFrameTime = model.time;

      const shouldClear = mandarinState.status === 'empty' && displayChar !== null;

      if (mandarinState.character !== lastCharacter || shouldClear) {
         lastCharacter = mandarinState.character;

         if (mandarinState.character && mandarinState.meaning && !shouldClear) {
            displayChar    = mandarinState.character;
            displayPinyin  = mandarinState.pinyin;
            displayMeaning = mandarinState.meaning;
            displayImage   = null;
            displayAI      = null;
            // Compute the panel pose LOCALLY using this client's viewMatrix.
            // (On PC it's mostly a no-op since panels are out of view there;
            // on headset this is what anchors the panels to the user's view.)
            const _localPose = computeLocalPanelMatrix(
               mandarinState.srcCorners, mandarinState.frameW, mandarinState.frameH
            );
            localPanelMatrix = _localPose ? _localPose.matrix : null;
            // Trigger hanzi VFX (sparks → lines → panels)
            hanziActive    = true;
            hanziStartTime = model.time;
            if (mandarinState.meaning !== lastFetchedMeaning) {
               lastFetchedMeaning = mandarinState.meaning;
               if (clientID != clients[0]) {
                  fetchWikiAndAI(mandarinState.meaning);
               }
            }
         } else {
            hidePanels();
            localPanelMatrix = null;
         }
      }

      if (DEBUG_HUD) {
         frameCounter++;
         const inv = clay.root().inverseViewMatrix(0);
         const headPos = [inv[12], inv[13], inv[14]];
         const right = [inv[0], inv[1], inv[2]];
         const up = [inv[4], inv[5], inv[6]];
         const forward = [-inv[8], -inv[9], -inv[10]];
         const p = [
            headPos[0] + forward[0] * DEBUG_HUD_DISTANCE - up[0] * DEBUG_HUD_DOWN + right[0] * DEBUG_HUD_RIGHT,
            headPos[1] + forward[1] * DEBUG_HUD_DISTANCE - up[1] * DEBUG_HUD_DOWN + right[1] * DEBUG_HUD_RIGHT,
            headPos[2] + forward[2] * DEBUG_HUD_DISTANCE - up[2] * DEBUG_HUD_DOWN + right[2] * DEBUG_HUD_RIGHT,
         ];
         panelDebug.setMatrix([
            right[0] * DEBUG_HUD_SIZE, right[1] * DEBUG_HUD_SIZE, right[2] * DEBUG_HUD_SIZE, 0,
            up[0] * DEBUG_HUD_SIZE, up[1] * DEBUG_HUD_SIZE, up[2] * DEBUG_HUD_SIZE, 0,
            -forward[0], -forward[1], -forward[2], 0,
            p[0], p[1], p[2], 1,
         ]);
         g2Debug.update();
      }

      // ─────────────────────────────────────────────────────────────────────
      // SCENE PLACEMENT — three modes:
      //   1. LOCKED (activeZone set): ArUcos + surface VFX at the captured
      //      zone. Per-dot indicators hidden — their job is done, and after
      //      lock srcCorners no longer represents red dots (the backend has
      //      switched to TRACKING_ARUCO and is now reporting ArUco hologram
      //      positions instead, which would be confusing to display as "red
      //      dot detected" markers).
      //   2. PREVIEW (no zone yet, srcCorners fresh): four cyan reticles, one
      //      per detected red dot, each placed at QUEST_FOCAL_DISTANCE on its
      //      OWN camera ray and recomputed every frame. Because each indicator
      //      is computed independently from a single (u,v) plus the LIVE view
      //      matrix, it always projects exactly onto its red dot in the cast,
      //      regardless of whether the user has moved their head since the
      //      backend last published. This is the visual feedback for
      //      "we see your dot" — if the reticles aren't ON the physical dots,
      //      the SQUARE_FL constant is wrong, not the depth.
      //   3. NONE (no detection): everything hidden.
      // ─────────────────────────────────────────────────────────────────────
      if (activeZone) {
         const Mz = activeZone.matrix;
         const hX = activeZone.halfX;
         const hY = activeZone.halfY;

         // ── Surface VFX panel: covers the entire zone, coplanar ────────────
         const zoneCenter = transform(Mz, [0, 0, 0]);
         placePanelAt(surfaceObj, zoneCenter, Mz, hX, hY);

         // ── ArUco hologram panels at the 4 corners ─────────────────────────
         // At lock time hX === hY === halfExtent, so each ArUco sits exactly
         // on its red dot — viewed from the lock-time camera position. As the
         // user moves AWAY from that pose some parallax appears (this is the
         // cost of single-image depth anchoring), but at typical reading
         // distance (~1.3 m from the whiteboard) it stays acceptably tight.
         const aTL = transform(Mz, [-hX,  hY, 0]);
         const aTR = transform(Mz, [ hX,  hY, 0]);
         const aBR = transform(Mz, [ hX, -hY, 0]);
         const aBL = transform(Mz, [-hX, -hY, 0]);
         placePanelAt(arucoTL, aTL, Mz, ARUCO_SIZE);
         placePanelAt(arucoTR, aTR, Mz, ARUCO_SIZE);
         placePanelAt(arucoBR, aBR, Mz, ARUCO_SIZE);
         placePanelAt(arucoBL, aBL, Mz, ARUCO_SIZE);

         // Hide per-dot indicators — they belong to the pre-lock phase only.
         dotInd0.setMatrix(HIDDEN_MATRIX);
         dotInd1.setMatrix(HIDDEN_MATRIX);
         dotInd2.setMatrix(HIDDEN_MATRIX);
         dotInd3.setMatrix(HIDDEN_MATRIX);
      } else if (mandarinState.srcCorners && mandarinState.frameW && mandarinState.frameH) {
         // PREVIEW MODE — show one cyan reticle per detected red dot. Each
         // reticle is independent; we don't run the full 4-point homography
         // here, we just ray-cast each dot's image position out to
         // QUEST_FOCAL_DISTANCE. That has two important properties:
         //
         //   • Per-frame projection is exact. The reticle for dot i is
         //     guaranteed to land on dot i's image position from the CURRENT
         //     view matrix, because dir_world = inverseView · (xn, yn, -fl)
         //     and we're rendering with that same view → projection cancels.
         //
         //   • No plane-fit error. The full homography assumes the 4 dots are
         //     coplanar in world space; any noise in srcCorners pushes the
         //     plane around. Reticles don't share a plane, so each one is
         //     immune to the others' detection noise.
         //
         // What the user sees: 4 cyan crosshairs landing exactly on the 4 red
         // dots. If they DON'T land, the camera FOV constant SQUARE_FL is off.
         //
         // Surface VFX & ArUcos stay hidden until lock.
         surfaceObj.setMatrix(HIDDEN_MATRIX);
         arucoTL.setMatrix(HIDDEN_MATRIX);
         arucoTR.setMatrix(HIDDEN_MATRIX);
         arucoBR.setMatrix(HIDDEN_MATRIX);
         arucoBL.setMatrix(HIDDEN_MATRIX);

         const indicators = [dotInd0, dotInd1, dotInd2, dotInd3];
         const inv = clay.root().inverseViewMatrix(0);
         // Camera basis in world space (columns of inverseView).
         const cRight = [inv[0], inv[1], inv[2]];
         const cUp    = [inv[4], inv[5], inv[6]];
         const cBack  = [inv[8], inv[9], inv[10]];   // = -forward
         const headPos = [inv[12], inv[13], inv[14]];
         const aspect = mandarinState.frameH / mandarinState.frameW;

         for (let i = 0; i < 4; i++) {
            const corner = mandarinState.srcCorners[i];
            if (!corner) {
               indicators[i].setMatrix(HIDDEN_MATRIX);
               continue;
            }
            const u = corner[0];
            const v = corner[1];

            // Camera-space ray (GL convention: camera looks -z).
            //   xn = u - 0.5            in [-0.5, +0.5] horizontally
            //   yn = -(v - 0.5)*aspect  flip image-y, scale to match xn units
            //   zn = -SQUARE_FL         pointing forward (down -z)
            const xn = u - 0.5;
            const yn = -(v - 0.5) * aspect;
            const zn = -SQUARE_FL;
            const len = Math.sqrt(xn*xn + yn*yn + zn*zn);
            if (!isFinite(len) || len < 1e-6) {
               indicators[i].setMatrix(HIDDEN_MATRIX);
               continue;
            }
            // Camera-space point at exactly QUEST_FOCAL_DISTANCE along the ray.
            const k = QUEST_FOCAL_DISTANCE / len;
            const cx = xn * k;
            const cy = yn * k;
            const cz = zn * k;
            // Camera → world: P_w = headPos + cRight*cx + cUp*cy + cBack*cz
            const wx = headPos[0] + cRight[0]*cx + cUp[0]*cy + cBack[0]*cz;
            const wy = headPos[1] + cRight[1]*cx + cUp[1]*cy + cBack[1]*cz;
            const wz = headPos[2] + cRight[2]*cx + cUp[2]*cy + cBack[2]*cz;

            // Billboard the reticle: its X axis = cRight, Y axis = cUp, scaled
            // to DOT_INDICATOR_HALF (half of the panel's [-1..1] extent → 8 cm).
            const s = DOT_INDICATOR_HALF;
            indicators[i].setMatrix([
               cRight[0] * s, cRight[1] * s, cRight[2] * s, 0,
               cUp[0]    * s, cUp[1]    * s, cUp[2]    * s, 0,
               cBack[0],      cBack[1],      cBack[2],      0,
               wx,            wy,            wz,            1,
            ]);
         }
      } else {
         // No zone, no corners — hide everything.
         surfaceObj.setMatrix(HIDDEN_MATRIX);
         arucoTL.setMatrix(HIDDEN_MATRIX);
         arucoTR.setMatrix(HIDDEN_MATRIX);
         arucoBR.setMatrix(HIDDEN_MATRIX);
         arucoBL.setMatrix(HIDDEN_MATRIX);
         dotInd0.setMatrix(HIDDEN_MATRIX);
         dotInd1.setMatrix(HIDDEN_MATRIX);
         dotInd2.setMatrix(HIDDEN_MATRIX);
         dotInd3.setMatrix(HIDDEN_MATRIX);
      }

      // ── Hanzi VFX + info panels (anchored to bbox within activeZone) ──────
      const M = localPanelMatrix;
      const haveBbox =
         displayChar &&
         M &&
         activeZone &&
         mandarinState.char_x_pct != null &&
         mandarinState.char_y_pct != null &&
         mandarinState.bbox_w_pct != null &&
         mandarinState.bbox_h_pct != null;

      if (haveBbox) {
         // Bbox geometry in zone-local meters. The bbox percentages are
         // relative to the (now possibly non-square) zone, so we use the
         // current halfX / halfY to convert.
         const hX = activeZone.halfX;
         const hY = activeZone.halfY;
         const localCenterX = (mandarinState.char_x_pct - 0.5) * 2 * hX;
         const localCenterY = -(mandarinState.char_y_pct - 0.5) * 2 * hY;
         const localW       = mandarinState.bbox_w_pct * 2 * hX;
         const localH       = mandarinState.bbox_h_pct * 2 * hY;
         const bboxSide     = Math.max(localW, localH);             // square panels per spec
         const halfBbox     = bboxSide / 2;
         const panelHalf    = (HANZI_PANEL_MUL * bboxSide) / 2;
         const offset       = halfBbox + HANZI_LINE_LEN + panelHalf; // bbox edge → panel center

         // Hanzi VFX panel: same plane & extent as the surface VFX
         const zoneCenter = transform(M, [0, 0, 0]);
         placePanelAt(hanziFXObj, zoneCenter, M, hX, hY);

         // Panel grow animation (ease-out cubic, synced with alpha fade-in)
         const t  = model.time - hanziStartTime;
         const pp = Math.max(0, Math.min(1, (t - T_PANEL_START) / T_PANEL_DUR));
         const ease = 1 - Math.pow(1 - pp, 3);
         const animatedHalf = panelHalf * ease;

         if (animatedHalf > 0.001) {
            // Cardinal positions: TOP=meaning, BOTTOM=AI, LEFT=image, RIGHT=pinyin
            const topPos    = transform(M, [localCenterX, localCenterY + offset, 0]);
            const bottomPos = transform(M, [localCenterX, localCenterY - offset, 0]);
            const leftPos   = transform(M, [localCenterX - offset, localCenterY, 0]);
            const rightPos  = transform(M, [localCenterX + offset, localCenterY, 0]);

            placePanelAt(panelMeaning, topPos,    M, animatedHalf);
            placePanelAt(panelAI,      bottomPos, M, animatedHalf);
            placePanelAt(panelImage,   leftPos,   M, animatedHalf);
            placePanelAt(panelPinyin,  rightPos,  M, animatedHalf);
         } else {
            panelMeaning.setMatrix(HIDDEN_MATRIX);
            panelAI.setMatrix(HIDDEN_MATRIX);
            panelImage.setMatrix(HIDDEN_MATRIX);
            panelPinyin.setMatrix(HIDDEN_MATRIX);
         }
      } else {
         hanziFXObj.setMatrix(HIDDEN_MATRIX);
         panelMeaning.setMatrix(HIDDEN_MATRIX);
         panelAI.setMatrix(HIDDEN_MATRIX);
         panelImage.setMatrix(HIDDEN_MATRIX);
         panelPinyin.setMatrix(HIDDEN_MATRIX);
      }

      // panelChar stays hidden by spec
      panelChar.setMatrix(HIDDEN_MATRIX);

      // ── Update G2 canvases ────────────────────────────────────────────────
      g2Surface.update();
      g2HanziFX.update();
      g2Pinyin.update();
      g2Meaning.update();
      g2Image.update();
      g2AI.update();

      // ── PC debug overlay update ───────────────────────────────────────────
      if (debugDiv) {
         const fmt = n => (n >= 0 ? ' ' : '') + n.toFixed(2);
         const fmtVec = v => '[' + v.map(fmt).join(', ') + ']';
         const sc = mandarinState.srcCorners;

         const lines = [
            'MR debug — PC master',
            '─────────────────────────',
            'status:    ' + (mandarinState.status || '—'),
            'character: ' + (mandarinState.character || '—'),
            'pinyin:    ' + (mandarinState.pinyin || '—'),
            'erased:    ' + mandarinState.erased,
            '',
            'srcCorners sent: ' + (sc ? 'YES ✅' : 'no ❌'),
            'frameW × frameH: ' + mandarinState.frameW + ' × ' + mandarinState.frameH,
            '',
            'SQUARE_FL: ' + SQUARE_FL.toFixed(3) +
               '   (≈ ' + (2 * Math.atan(0.5 / SQUARE_FL) * 180 / Math.PI).toFixed(1) + '° H-FOV)',
            '   tune live with  [   and   ]   keys',
            '',
            'lockCounter:  ' + (mandarinState.lockCounter  || 0),
            'resetCounter: ' + (mandarinState.resetCounter || 0),
            'mode:         ' + (activeZone
                                  ? 'LOCKED ✅'
                                  : (sc ? 'PREVIEW (live tracking 4 dots)' : 'WAITING (need 4 dots in view)')),
            'activeZone:   ' + (activeZone ? 'YES ✅' : 'no ❌'),
            'surfaceVFX:   ' + (surfaceActive ? 'active' : 'idle'),
            'hanziVFX:     ' + (hanziActive ? 'active' : 'idle'),
         ];

         if (mandarinState.char_x_pct != null) {
            lines.push('');
            lines.push('bbox center:  (' + mandarinState.char_x_pct.toFixed(3) +
                                    ', ' + mandarinState.char_y_pct.toFixed(3) + ')');
            lines.push('bbox size:    (' + mandarinState.bbox_w_pct.toFixed(3) +
                                    ' × ' + mandarinState.bbox_h_pct.toFixed(3) + ')');
         }

         if (sc) {
            lines.push('');
            lines.push('TL (img): ' + fmtVec(sc[0]));
            lines.push('TR (img): ' + fmtVec(sc[1]));
            lines.push('BR (img): ' + fmtVec(sc[2]));
            lines.push('BL (img): ' + fmtVec(sc[3]));
         }

         lines.push('');
         lines.push('pose computed on: HEADSET');
         lines.push('  (uses headset\'s own viewMatrix)');

         lines.push('');
         lines.push('last server result:');
         lines.push(lastServerResult
            ? JSON.stringify(lastServerResult).slice(0, 200)
            : '— none yet —');

         debugDiv.textContent = lines.join('\n');
      }
   });
};