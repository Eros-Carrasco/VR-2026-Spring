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
   // PnP from a single image needs ONE of two things to recover metric depth:
   //   (a) the physical size of the model square, or
   //   (b) the depth from camera to plane.
   // Earlier versions of this file went with (b), pinning depth to the Quest 3S
   // optical focal distance (~1.3 m). That made image-space alignment work but
   // only landed the zone on the actual whiteboard if you happened to be standing
   // exactly 1.3 m away — closer or farther and the zone slid behind or in front
   // of the wall. We now use (a): the user measures the side of their dot
   // square, plugs it into ZONE_SIDE, and PnP returns metrically correct depth
   // regardless of where the user stands. ZONE_SIDE can be tuned live with
   // , and . keys on the PC.
   //
   // SQUARE_FL — pinhole focal length of the cast camera, in image-WIDTH-relative
   // units (i.e. the image is 1.0 unit wide). Drives both the per-dot ray-cast
   // preview AND the metric homography. Relation to horizontal FOV:
   //     SQUARE_FL = 0.5 / tan(H_FOV / 2)
   //
   //   0.32 → 115° H FOV   ← measured empirically on Quest 3S "wide" cast
   //   0.5  → 90°  H FOV
   //   0.68 → 73°  H FOV
   //   0.75 → 67°  H FOV
   //
   // The right value is whatever makes the cyan reticles land EXACTLY on the
   // physical red dots in PREVIEW mode. If they're pushed outward from center,
   // SQUARE_FL is too small; if pulled inward, it's too big. Adjust live with
   // the [ and ] keys on the PC (see keyboard handler farther down). The
   // value is broadcast via mandarinState.squareFL so both clients agree.
   //
   // Both SQUARE_FL and ZONE_SIDE are declared with `let` rather than `const`
   // so the keyboard tuners can update them at runtime without a page reload.
   //
   // Calibration order is FL first, then SIDE:
   //   1. [/]  → adjust SQUARE_FL until reticles align with dots in cast
   //             (image-space alignment is independent of physical scale)
   //   2. ,/.  → adjust ZONE_SIDE until reticles sit ON the whiteboard in 3D
   //             (this only adjusts depth, not image-space alignment)
   let   SQUARE_FL       = 0.32;   // ≈ 115° H FOV — typical Quest 3S "wide" cast
   const SQUARE_FL_STEP  = 0.02;
   const SQUARE_FL_MIN   = 0.20;   // ≈ 136° H FOV — sanity floor
   const SQUARE_FL_MAX   = 1.20;   // ≈ 45°  H FOV — sanity ceiling

   let   ZONE_SIDE       = 0.30;   // meters — side length of the dot square (defaults
                                   // to 30 cm; measure your actual setup with a ruler
                                   // and tune in 2 cm steps with , / . on the PC)
   const ZONE_SIDE_STEP  = 0.02;
   const ZONE_SIDE_MIN   = 0.05;   // 5 cm  — sanity floor
   const ZONE_SIDE_MAX   = 3.00;   // 3 m   — sanity ceiling

   const ARUCO_SIZE      = 0.03;   // physical side of each ArUco hologram, in meters

   // Forward lift along the zone's local Z so the ArUcos and side plaques
   // win the depth-buffer fight against the coplanar surface VFX. The sign
   // here was determined empirically: in the locked screenshot, the surface
   // VFX (mint green border + fill) was OCCLUDING the ArUco holograms,
   // proving that the +Z of the PnP-recovered plane points TOWARD THE WALL,
   // not toward the viewer. So a negative offset on Z lifts visuals toward
   // the user.
   //
   // 1.5 cm is generous on purpose — small offsets like 5 mm risk losing the
   // depth-fight under floating-point noise, and the lift is cheap visually
   // (the user almost never looks at the zone edge-on, where the offset
   // would become visible).
   const ARUCO_Z_LIFT    = -0.015;  // 1.5 cm toward the viewer (negative because
                                    // PnP +Z points toward the wall in this scene)

   // Always-on side plaques (above & below the zone). Sized in absolute meters
   // rather than as fractions of the zone — the zone (your dot square) might
   // be quite small, but the plaques should stay readable. Adjust freely.
   const TITLE_HALF_W    = 0.18;   // 36 cm wide
   const TITLE_HALF_H    = 0.045;  //  9 cm tall
   const COURSE_HALF_W   = 0.18;
   const COURSE_HALF_H   = 0.07;   // 14 cm tall (4 lines of text)
   const PLAQUE_GAP      = 0.025;  // 2.5 cm gap between plaque and zone edge

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
   // Cyan target reticle placed at the corresponding corner of the metric PnP
   // plane recovered from the LIVE srcCorners — recomputed every frame. Lets
   // the user see the math working in real time BEFORE committing the zone
   // with the trigger.
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

   // ── G2 canvases for the always-on info plaques (above & below the zone) ──
   //    Static — drawn once at init, then just blitted onto their panels each
   //    frame at whatever world pose the zone matrix dictates.
   let g2Title      = new G2();   // "MR-andarin" header above the zone
   let g2CourseInfo = new G2();   // course / instructor / date plaque below

   // ── Texture slot assignments ──────────────────────────────────────────────
   // 0-3 = ArUco PNGs (TL, TR, BR, BL)
   // 4   = panelChar (currently hidden, kept for future use)
   // 5   = panelPinyin
   // 6   = panelImage
   // 7   = panelAI
   // 8   = panelDebug
   // 9   = g2Surface (LIDAR + perimeter + intro animation)
   // 10  = g2HanziFX (sparks + lines)
   // 11  = panelMeaning
   // 12  = g2DotIndicator (per-dot live reticle, shared by all 4 indicators)
   // 13  = g2Title (always-on "MR-andarin" header above the zone)
   // 14  = g2CourseInfo (always-on course-info plaque below the zone)
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
   model.txtrSrc(13, g2Title.getCanvas());
   model.txtrSrc(14, g2CourseInfo.getCanvas());

   // ── Render order matters: later .add() calls draw ON TOP of earlier ones ──
   // Stack (bottom → top):
   //   1. Surface VFX & Hanzi VFX (coplanar with the workspace, z=0)
   //   2. Info panels (z=0, hidden until characters are detected)
   //   3. Always-on plaques: Title above, Course-info below (z = ARUCO_Z_LIFT)
   //   4. ArUco holograms — slightly lifted (z = ARUCO_Z_LIFT) so they always
   //      render IN FRONT OF the surface VFX. This was a real visual bug:
   //      coplanar surfaces with equal z fight in the depth buffer, and the
   //      surface VFX (drawn first, but with the same z) was occluding the
   //      ArUcos in some frames, hurting OpenCV's ability to lock onto them
   //      from the cast feed.
   //   5. Dot indicators (topmost — pre-lock visual feedback only; hidden after lock)

   // 1. VFX layers (deepest)
   let surfaceObj = model.add('square').txtr(9).dull();
   let hanziFXObj = model.add('square').txtr(10).dull();

   // 2. Info panels (transient — show on character detection)
   let panelChar    = model.add('square').txtr(4).dull();
   let panelPinyin  = model.add('square').txtr(5).dull();
   let panelImage   = model.add('square').txtr(6).dull();
   let panelAI      = model.add('square').txtr(7).dull();
   let panelMeaning = model.add('square').txtr(11).dull();
   let panelDebug   = model.add('square').txtr(8).scale(DEBUG_HUD_SIZE).dull();
   if (!DEBUG_HUD) panelDebug.move(0, -999, 0);

   // 3. Always-on plaques
   let panelTitle      = model.add('square').txtr(13).dull();
   let panelCourseInfo = model.add('square').txtr(14).dull();

   // 4. ArUco holograms
   let arucoTL = model.add('square').txtr(0).dull();
   let arucoTR = model.add('square').txtr(1).dull();
   let arucoBR = model.add('square').txtr(2).dull();
   let arucoBL = model.add('square').txtr(3).dull();

   // 5. Per-dot live indicators — one cyan reticle per detected red dot,
   //    placed at the corresponding corner of the LIVE PnP plane (so they
   //    track the dots in 2D AND sit at the correct 3D depth, given properly
   //    calibrated SQUARE_FL and ZONE_SIDE). Shown in PREVIEW; hidden after lock.
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
   panelTitle.setMatrix(HIDDEN_MATRIX);
   panelCourseInfo.setMatrix(HIDDEN_MATRIX);
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
   let surfacePreviewActive = false;// true while in PREVIEW (4 dots detected, no lock yet);
                                    // makes the surface canvas draw a translucent ghost outline
                                    // showing where the zone WILL be locked
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

      // Bright center dot (filled) — kept small on purpose. A bigger dot
      // would cover the physical red dot it's supposed to align with,
      // making fine calibration harder.
      this.setColor([0.7, 1.0, 1.0, 1.0]);
      this.fillOval(-0.08, -0.08, 0.16, 0.16);
   };
   // Render the canvas once at init — its content never changes (no animation).
   g2DotIndicator.update();

   // ─────────────────────────────────────────────────────────────────────────
   // TITLE PLAQUE  ("MR-andarin" header)
   // ─────────────────────────────────────────────────────────────────────────
   // Static — drawn once at init. Sits above the zone in world space; the
   // panel matrix is computed from the zone matrix every frame in scene
   // placement so it stays attached.
   g2Title.render = function () {
      const ctx = this.getContext(), canvas = this.getCanvas();
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Dark translucent background so the text reads against bright passthrough
      this.setColor([0.02, 0.05, 0.10, 0.78]);
      this.fillRect(-1, -1, 2, 2);

      // Cyan border (matches the surface VFX accent color)
      this.setColor([0.0, 1.0, 0.9, 0.7]);
      this.lineWidth(0.04);
      this.drawPath([[-0.97, -0.93], [0.97, -0.93], [0.97, 0.93], [-0.97, 0.93], [-0.97, -0.93]]);

      // Title text. textHeight is in canvas-units where 2.0 = full canvas
      // height — using values around 0.25–0.4 matches the other info panels
      // and keeps the text readable rather than gigantic.
      this.setColor([0.85, 1.0, 1.0, 1.0]);
      this.textHeight(0.40);
      this.text('MR-andarin', 0, 0, 'center');
   };
   g2Title.update();

   // ─────────────────────────────────────────────────────────────────────────
   // COURSE-INFO PLAQUE
   // ─────────────────────────────────────────────────────────────────────────
   // Static. Sits below the zone. Same chrome as the title plaque.
   g2CourseInfo.render = function () {
      const ctx = this.getContext(), canvas = this.getCanvas();
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Background
      this.setColor([0.02, 0.05, 0.10, 0.78]);
      this.fillRect(-1, -1, 2, 2);

      // Border
      this.setColor([0.0, 1.0, 0.9, 0.7]);
      this.lineWidth(0.04);
      this.drawPath([[-0.97, -0.95], [0.97, -0.95], [0.97, 0.95], [-0.97, 0.95], [-0.97, -0.95]]);

      // Body text (4 lines)
      const lines = [
         'Student:    Eros Carrasco',
         'Course:     CSCI-GA 3033 — Virtual Reality',
         'Instructor: Kenneth Perlin',
         'Date:       May 5, 2026',
      ];
      this.setColor([0.85, 0.92, 1.0, 1.0]);
      this.textHeight(0.18);
      const topY = 0.55, lineSpacing = 0.32;
      for (let i = 0; i < lines.length; i++) {
         this.text(lines[i], -0.85, topY - i * lineSpacing, 'left');
      }
   };
   g2CourseInfo.update();

   // ─────────────────────────────────────────────────────────────────────────
   // SURFACE VFX RENDER
   // ─────────────────────────────────────────────────────────────────────────
   // The G2 canvas spans [-1..1] which maps to the full marker zone (corner
   // ArUcos sit at ±1, ±1 in this canvas's space). All drawing happens in
   // this normalized space.
   //
   // Three operating modes, in priority order:
   //   1. surfaceActive    → LOCKED: full intro animation (scan + "MR-andarin"
   //                          fade in/out), then persistent perimeter only
   //   2. surfacePreviewActive (and not surfaceActive) → PREVIEW: just a
   //                          translucent dashed-feel outline that shows where
   //                          the zone WILL lock when the trigger fires.
   //                          Lets the user calibrate fully before committing.
   //   3. neither           → blank canvas, panel is invisible.
   //
   // Intro-animation timeline (relative to surfaceStartTime):
   //   0.0 – 0.4 s   border fades in to full alpha
   //                 LIDAR ring expands from center
   //                 "MR-andarin" text fades in
   //   0.4 – 1.0 s   text holds at peak
   //   1.0 – 1.4 s   ring continues until it leaves the canvas
   //   1.0 – 1.7 s   text fades out
   //   1.7 s onward  persistent border only
   const T_TEXT_FADE_IN  = 0.4;
   const T_TEXT_HOLD_END = 1.0;
   const T_TEXT_FADE_OUT_DUR = 0.7;
   g2Surface.render = function () {
      const ctx = this.getContext(), canvas = this.getCanvas();
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // ── PREVIEW MODE (no lock yet, but 4 dots tracked) ─────────────────────
      // Draw a tinted fill between the 4 corners so the user can SEE the
      // calibration plane in 3D as a solid surface, not 4 floating reticles.
      // If the fill sits ON the whiteboard, ZONE_SIDE is right; if it floats
      // in front of or behind the wall, , / . to fix.
      //
      // Alpha tuned for depth perception: too transparent and the plane
      // disappears against busy passthrough; too opaque and it occludes the
      // physical dots you're trying to align with. ~0.35 is the sweet spot.
      if (surfacePreviewActive && !surfaceActive) {
         this.setColor([0.0, 0.85, 0.95, 0.35]);
         this.fillRect(-0.96, -0.96, 1.92, 1.92);
         // Bright solid perimeter on top so the plane edges read clearly.
         this.setColor([0.0, 1.0, 0.95, 0.85]);
         this.lineWidth(0.03);
         this.drawPath([[-0.96, -0.96], [0.96, -0.96], [0.96, 0.96], [-0.96, 0.96], [-0.96, -0.96]]);
         return;
      }

      if (!surfaceActive) return;

      const t = model.time - surfaceStartTime;
      if (t < 0) return;

      // ── Persistent perimeter ──────────────────────────────────────────────
      // Brighter than the preview outline. Fades in fast and stays forever.
      const borderAlpha = Math.min(0.85, t * 2.5);
      this.setColor([0.0, 1.0, 0.9, borderAlpha]);
      this.lineWidth(0.022);
      this.drawPath([[-0.96, -0.96], [0.96, -0.96], [0.96, 0.96], [-0.96, 0.96], [-0.96, -0.96]]);

      // ── LIDAR scan ────────────────────────────────────────────────────────
      if (t <= T_SURFACE_SCAN) {
         let pulseAlpha = 1.0;
         if (t > 1.0) pulseAlpha = Math.max(0, 1.0 - ((t - 1.0) * 2.0));

         const maxRadius    = t * 2.8;
         const waveGlowSize = 0.4;

         // Cross-pattern dots that light up as the wave passes through
         const step = 0.15, crossSize = 0.015;
         this.lineWidth(0.01);
         for (let x = -0.9; x <= 0.9; x += step) {
            for (let y = -0.9; y <= 0.9; y += step) {
               const dist = Math.sqrt(x * x + y * y);
               const distanceToWave = maxRadius - dist;
               if (distanceToWave > 0 && distanceToWave < waveGlowSize) {
                  const dotAlpha = (1.0 - (distanceToWave / waveGlowSize)) * pulseAlpha;
                  this.setColor([0.4, 1.0, 1.0, dotAlpha * 0.9]);
                  this.drawPath([[x - crossSize, y], [x + crossSize, y]]);
                  this.drawPath([[x, y - crossSize], [x, y + crossSize]]);
               }
            }
         }

         // Expanding ring
         this.setColor([0.0, 1.0, 0.9, 0.7 * pulseAlpha]);
         this.lineWidth(0.025);
         this.drawOval(-maxRadius, -maxRadius, maxRadius * 2, maxRadius * 2);
      }

      // ── "MR-andarin" centered intro text — fades in, holds, fades out ─────
      const textTotalDur = T_TEXT_HOLD_END + T_TEXT_FADE_OUT_DUR;
      if (t <= textTotalDur) {
         let textAlpha;
         if (t < T_TEXT_FADE_IN) {
            textAlpha = t / T_TEXT_FADE_IN;          // ease-in (linear is fine)
         } else if (t < T_TEXT_HOLD_END) {
            textAlpha = 1.0;                         // hold at peak
         } else {
            textAlpha = 1.0 - (t - T_TEXT_HOLD_END) / T_TEXT_FADE_OUT_DUR;
         }
         textAlpha = Math.max(0, Math.min(1, textAlpha));

         // Soft glow halo behind the text
         this.setColor([0.0, 1.0, 0.9, textAlpha * 0.4]);
         this.textHeight(0.55);
         this.text('MR-andarin', 0, 0, 'center');

         // Bright main text on top
         this.setColor([0.85, 1.0, 1.0, textAlpha]);
         this.textHeight(0.5);
         this.text('MR-andarin', 0, 0, 'center');
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

   // ── Manual lock trigger (controller trigger button) ──────────────────────
   // Fires on whichever client receives the input — typically the headset.
   // Bumps lockCounter and broadcasts so the PC Master picks it up via
   // synchronize at the top of animate().
   //
   // **Why we gate on !window.handtracking:**
   // clay's `inputEvents.onPress` fires on `L0_press` / `R0_press`, which the
   // runtime treats as the same event whether it came from the controller's
   // index-finger trigger OR from a thumb-to-index pinch gesture in
   // hand-tracking mode. That means simply moving your head with your fingers
   // anywhere near each other accidentally registers as a "trigger press" and
   // accumulates lockCounter without any conscious action — which is what was
   // making the zone lock spontaneously.
   //
   // Since the intent is "lock with the controller trigger, deliberately",
   // we ignore presses while in hand-tracking mode entirely. If the user puts
   // down the controllers (the runtime auto-switches to hand-tracking per the
   // API docs), they'll need to pick the controllers back up to lock.
   inputEvents.onPress = hand => {
      if (window.handtracking) {
         console.log('[MRandarin] press ignored (hand-tracking mode — pinch gestures must not lock the zone). Use the controller trigger.');
         return;
      }
      mandarinState.lockCounter = (mandarinState.lockCounter || 0) + 1;
      server.broadcastGlobal('mandarinState');
      console.log('[MRandarin] lock pressed (' + hand + ') → counter=' + mandarinState.lockCounter);
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

      // ── ZONE_SIDE tuner ( , / . )  ────────────────────────────────────────
      // Live calibration of the physical side of the dot square. Works the
      // same way as SQUARE_FL — published via mandarinState.zoneSide, picked
      // up by both clients in animate().
      //
      // Workflow: AFTER calibrating SQUARE_FL (so reticles align in 2D), tap
      // , or . to adjust ZONE_SIDE. The reticles will move IN/OUT in 3D
      // along the rays from the headset to the dots. Stop when they sit
      // ON the surface of your whiteboard.
      //
      //   "."  → bigger square assumed → recovered depth FARTHER from you
      //   ","  → smaller square assumed → recovered depth CLOSER to you
      window.addEventListener('keydown', (e) => {
         if (e.key !== ',' && e.key !== '.') return;
         const sign = (e.key === '.') ? +1 : -1;
         const next = Math.max(
            ZONE_SIDE_MIN,
            Math.min(ZONE_SIDE_MAX, ZONE_SIDE + sign * ZONE_SIDE_STEP)
         );
         ZONE_SIDE = next;
         mandarinState.zoneSide = next;
         server.broadcastGlobal('mandarinState');
         console.log('[MRandarin] ZONE_SIDE = ' + next.toFixed(3) + ' m  (' +
                     (next * 100).toFixed(0) + ' cm)');
      });
   }

   // ── ALL CLIENTS ───────────────────────────────────────────────────────────
   let lastCharacter = undefined;
   let lastFetchedMeaning = null;
   let lastViewMatrix = null;
   let localPanelMatrix = null;       // recomputed when a new character is detected (uses LOCAL viewMatrix)
   let activeZone = null;             // { matrix, halfX, halfY } captured ONCE on first valid srcCorners; persists through erase
   // Reset/lock counters: initialize from whatever the server already has so
   // we don't replay stale events on first animate. If lockCounter is at e.g.
   // 9 from a previous session and we initialized to 0, the > comparison would
   // fire instantly on frame one and lock without any controller press —
   // which is exactly the "ArUcos appear without pressing the trigger" bug.
   let lastResetCounter = (typeof mandarinState.resetCounter === 'number') ? mandarinState.resetCounter : 0;
   let lastLockCounter  = (typeof mandarinState.lockCounter  === 'number') ? mandarinState.lockCounter  : 0;
   let lastFrameTime    = 0;          // for joystick dt

   // Build a square→model-space pose from the four image-space corners returned
   // by the server. Uses THIS client's current inverseViewMatrix(0), so when run
   // on the headset the result is anchored to the user's actual head pose.
   //
   // Returns { matrix, halfExtent } or null:
   //   matrix     — 4×4 column-major, basis vectors are UNIT, translation in meters
   //   halfExtent — meters from zone center to a corner along an axis. Equal to
   //                ZONE_SIDE / 2 — i.e. the user-supplied physical half-side of
   //                the dot square. The joystick may later stretch the zone
   //                non-uniformly (halfX/halfY); halfExtent is the symmetric
   //                starting value at lock time.
   //
   // PHYSICAL-SCALE PnP. The third argument to computeCameraPose is the model
   // square's side length in METERS — i.e. how far apart your physical red dots
   // are in the real world. Passing the true distance here produces a metrically
   // correct camera-space pose: the recovered translation magnitude IS the
   // distance from the headset to the dot plane, in meters.
   //
   // (The previous version of this code passed an arbitrary side length and
   // then forced the recovered depth to QUEST_FOCAL_DISTANCE = 1.3 m along the
   // camera ray. That worked image-space — the ArUcos still projected onto the
   // red dots — but only landed on the actual whiteboard if the user happened
   // to be standing exactly 1.3 m away. Closer than that and the zone ended up
   // deep behind the wall; farther and it floated in front. Trusting the PnP
   // depth removes that constraint as long as ZONE_SIDE is calibrated correctly.)
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

      // ZONE_SIDE is the real-world side of the dot square in meters. PnP
      // recovers the camera-space pose at that scale.
      const squareToCameraCV = computeCameraPose(C, SQUARE_FL, ZONE_SIDE);
      // CV convention (camera looks +z) → GL/WebXR convention (camera looks -z).
      const flipZ = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];
      const squareToCamera = mxm(flipZ, squareToCameraCV);

      // Sanity-check the recovered translation. A finite, in-front-of-camera
      // depth (negative z in GL convention, since camera looks -z) is required.
      const tz = squareToCamera[14];
      if (!isFinite(tz) || tz === 0) return null;

      const halfExtent = ZONE_SIDE / 2;

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

      // ── FL & ZONE_SIDE sync (all clients) ──────────────────────────────────
      // The PC's [ / ] and , / . keys mutate mandarinState.squareFL and
      // mandarinState.zoneSide and broadcast. Pick them up here on every frame
      // so the headset uses the same calibration as the PC.
      if (typeof mandarinState.squareFL === 'number' &&
          isFinite(mandarinState.squareFL) &&
          mandarinState.squareFL > 0) {
         SQUARE_FL = mandarinState.squareFL;
      }
      if (typeof mandarinState.zoneSide === 'number' &&
          isFinite(mandarinState.zoneSide) &&
          mandarinState.zoneSide > 0) {
         ZONE_SIDE = mandarinState.zoneSide;
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
         activeZone           = null;
         surfaceActive        = false;        // wipe the surface VFX too
         surfacePreviewActive = false;        // and the preview ghost
         hanziActive          = false;
         hidePanels();
         // Indicators and plaques are repositioned per-frame from srcCorners,
         // but if the reset clears srcCorners on the PC and the headset hasn't
         // received the fresh state yet, they could briefly show stale poses.
         // Hide explicitly so the visual reset is instantaneous.
         dotInd0.setMatrix(HIDDEN_MATRIX);
         dotInd1.setMatrix(HIDDEN_MATRIX);
         dotInd2.setMatrix(HIDDEN_MATRIX);
         dotInd3.setMatrix(HIDDEN_MATRIX);
         panelTitle.setMatrix(HIDDEN_MATRIX);
         panelCourseInfo.setMatrix(HIDDEN_MATRIX);
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
      //   1. LOCKED (activeZone set): full intro VFX, ArUcos, plaques. Per-dot
      //      reticles hidden — once locked, srcCorners switches to ArUco
      //      tracking and would be confusing to display as red-dot markers.
      //   2. PREVIEW (no zone yet, srcCorners fresh): translucent ghost of the
      //      eventual zone — surface outline + title plaque + course plaque +
      //      4 cyan reticles, ALL positioned via the LIVE PnP matrix that
      //      tracks the dots every frame. Lets the user calibrate SQUARE_FL
      //      and ZONE_SIDE while seeing the full layout, before committing
      //      with the trigger:
      //         reticles drift in 2D  → SQUARE_FL wrong  → tune with [ / ]
      //         reticles aligned in 2D but at wrong 3D depth (in front of /
      //                                  behind the wall)
      //                               → ZONE_SIDE wrong → tune with , / .
      //   3. NONE (no detection): everything hidden.
      //
      // ArUcos and plaques are lifted forward by ARUCO_Z_LIFT along the zone's
      // local +Z axis (toward the viewer). Without that, they fight the
      // surface VFX in the depth buffer and the surface VFX can briefly
      // occlude the ArUcos — bad for OpenCV's track.
      // ─────────────────────────────────────────────────────────────────────

      // The intro animation runs from surfaceStartTime for T_INTRO_TOTAL
      // seconds (LIDAR scan + "MR-andarin" text fade). Plaques (title,
      // course info) only enter AFTER the intro is done — bringing them in
      // earlier competes with the intro for attention and clutters a phase
      // where the user is just confirming "yes, the zone is in the right
      // place". They also stay hidden during PREVIEW for the same reason:
      // calibration is about lining up the plane, not reading metadata.
      const T_INTRO_TOTAL = T_TEXT_HOLD_END + T_TEXT_FADE_OUT_DUR;   // ≈1.7 s

      // Local helper: position the side plaques using a zone matrix + half-sizes.
      // Used only in LOCKED, after the intro animation completes.
      const placePlaques = (Mz, hX, hY) => {
         const zL = ARUCO_Z_LIFT;
         // Title above the top edge
         const titleY = hY + PLAQUE_GAP + TITLE_HALF_H;
         placePanelAt(panelTitle,
                      transform(Mz, [0, titleY, zL]),
                      Mz, TITLE_HALF_W, TITLE_HALF_H);
         // Course-info below the bottom edge
         const courseY = -hY - PLAQUE_GAP - COURSE_HALF_H;
         placePanelAt(panelCourseInfo,
                      transform(Mz, [0, courseY, zL]),
                      Mz, COURSE_HALF_W, COURSE_HALF_H);
      };

      if (activeZone) {
         const Mz = activeZone.matrix;
         const hX = activeZone.halfX;
         const hY = activeZone.halfY;

         // We're past PREVIEW — turn its ghost outline off; the surface canvas
         // is now driven by the lock-time intro animation.
         surfacePreviewActive = false;

         // Surface VFX panel: covers the entire zone, coplanar with the wall
         const zoneCenter = transform(Mz, [0, 0, 0]);
         placePanelAt(surfaceObj, zoneCenter, Mz, hX, hY);

         // ArUco hologram panels at the 4 corners — z-lifted forward
         const zL = ARUCO_Z_LIFT;
         placePanelAt(arucoTL, transform(Mz, [-hX,  hY, zL]), Mz, ARUCO_SIZE);
         placePanelAt(arucoTR, transform(Mz, [ hX,  hY, zL]), Mz, ARUCO_SIZE);
         placePanelAt(arucoBR, transform(Mz, [ hX, -hY, zL]), Mz, ARUCO_SIZE);
         placePanelAt(arucoBL, transform(Mz, [-hX, -hY, zL]), Mz, ARUCO_SIZE);

         // Plaques wait for the intro to finish, then appear.
         const introT = surfaceActive ? (model.time - surfaceStartTime) : Infinity;
         if (introT >= T_INTRO_TOTAL) {
            placePlaques(Mz, hX, hY);
         } else {
            panelTitle.setMatrix(HIDDEN_MATRIX);
            panelCourseInfo.setMatrix(HIDDEN_MATRIX);
         }

         // Hide per-dot indicators — they belong to the pre-lock phase only.
         dotInd0.setMatrix(HIDDEN_MATRIX);
         dotInd1.setMatrix(HIDDEN_MATRIX);
         dotInd2.setMatrix(HIDDEN_MATRIX);
         dotInd3.setMatrix(HIDDEN_MATRIX);
      } else if (mandarinState.srcCorners && mandarinState.frameW && mandarinState.frameH) {
         // PREVIEW — recompute the live PnP zone every frame and lay out the
         // calibration view. This phase is INTENTIONALLY MINIMAL: tinted
         // square between the 4 reticles + the reticles themselves. No plaques,
         // no chrome — the user is calibrating, not reading.
         const previewPose = computeLocalPanelMatrix(
            mandarinState.srcCorners, mandarinState.frameW, mandarinState.frameH
         );

         // ArUco textures stay hidden in preview — the cyan reticles take
         // their place at the same 4 corner positions.
         arucoTL.setMatrix(HIDDEN_MATRIX);
         arucoTR.setMatrix(HIDDEN_MATRIX);
         arucoBR.setMatrix(HIDDEN_MATRIX);
         arucoBL.setMatrix(HIDDEN_MATRIX);
         // Plaques never show in preview.
         panelTitle.setMatrix(HIDDEN_MATRIX);
         panelCourseInfo.setMatrix(HIDDEN_MATRIX);

         if (!previewPose) {
            // PnP failed (degenerate quad, NaN, …). Hide all preview visuals
            // until detection recovers.
            surfacePreviewActive = false;
            surfaceObj.setMatrix(HIDDEN_MATRIX);
            dotInd0.setMatrix(HIDDEN_MATRIX);
            dotInd1.setMatrix(HIDDEN_MATRIX);
            dotInd2.setMatrix(HIDDEN_MATRIX);
            dotInd3.setMatrix(HIDDEN_MATRIX);
         } else {
            const Mz = previewPose.matrix;
            const h  = previewPose.halfExtent;

            // Tinted-fill square between the 4 corners — surface canvas is
            // in PREVIEW mode and draws the fill that visualizes the plane.
            surfacePreviewActive = true;
            const zoneCenter = transform(Mz, [0, 0, 0]);
            placePanelAt(surfaceObj, zoneCenter, Mz, h, h);

            // 4 cyan reticles billboard toward the camera at the 4 corners.
            // Same corner order as the locked branch (TL, TR, BR, BL).
            const corners = [
               transform(Mz, [-h,  h, 0]),
               transform(Mz, [ h,  h, 0]),
               transform(Mz, [ h, -h, 0]),
               transform(Mz, [-h, -h, 0]),
            ];
            const inv     = clay.root().inverseViewMatrix(0);
            const cRight  = [inv[0], inv[1], inv[2]];
            const cUp     = [inv[4], inv[5], inv[6]];
            const cBack   = [inv[8], inv[9], inv[10]];
            const indicators = [dotInd0, dotInd1, dotInd2, dotInd3];
            const s = DOT_INDICATOR_HALF;

            for (let i = 0; i < 4; i++) {
               const p = corners[i];
               if (!p || !isFinite(p[0]) || !isFinite(p[1]) || !isFinite(p[2])) {
                  indicators[i].setMatrix(HIDDEN_MATRIX);
                  continue;
               }
               indicators[i].setMatrix([
                  cRight[0] * s, cRight[1] * s, cRight[2] * s, 0,
                  cUp[0]    * s, cUp[1]    * s, cUp[2]    * s, 0,
                  cBack[0],      cBack[1],      cBack[2],      0,
                  p[0],          p[1],          p[2],          1,
               ]);
            }
         }
      } else {
         // No zone, no corners — hide everything.
         surfacePreviewActive = false;
         surfaceObj.setMatrix(HIDDEN_MATRIX);
         panelTitle.setMatrix(HIDDEN_MATRIX);
         panelCourseInfo.setMatrix(HIDDEN_MATRIX);
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
            'ZONE_SIDE: ' + ZONE_SIDE.toFixed(3) + ' m   (' + (ZONE_SIDE * 100).toFixed(0) + ' cm)',
            '   tune live with  ,   and   .   keys',
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