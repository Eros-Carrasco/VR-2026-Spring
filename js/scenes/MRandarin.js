import * as global from "../global.js";
import { Gltf2Node } from "../render/nodes/gltf2.js";
import { G2 } from "../util/g2.js";
import { askAI } from "../util/aiquery.js";
import { computeCameraPose } from "../util/computeCameraPose.js";
import { mxm, transform } from "../util/matrix.js";
import HanziWriter from "../util/hanzi-writer.esm.js";

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
   // Pokédex state — populated by the PC master from periodic GET /hanzi.
   // Shape: { discovered: {char: {pinyin, meaning, ...}}, top100: [chars] }
   // Synchronized to all clients so the headset can render the pokédex panel
   // without doing its own backend fetch.
   pokedex: { discovered: {}, top100: [] },
   // Learn-mode target — when non-null, the HanziWriter stroke-order panel
   // appears in the zone and the OCR uses strict matching against this char
   // (other recognitions are ignored, no positive feedback). Cleared by
   // pollServer when the backend responds with target_match=true.
   //   shape: { char, pinyin, meaning } | null
   learnTarget: null,
   // Bumped by any client when the user taps "LEARN A NEW HANZI" in the
   // pokédex panel. The PC master watches it and fetches a fresh target
   // from /hanzi/learn_target, then publishes via mandarinState.learnTarget.
   learnNewCounter: 0,
   // True when the PC is currently seeing all 4 ArUco markers in the cast
   // image. Updated only on transitions (see pollServer) so other clients
   // don't get spammed with re-broadcasts. The headset shows it in the left
   // info panel as a diagnostic — if the user writes a hanzi and nothing
   // happens, this tells them whether the problem is "I'm not detecting
   // your markers" vs "your character was not recognized as a known hanzi".
   fourMarkersDetected: false,
};

export const init = async model => {

   // ── window.requestAnimationFrame shim para WebXR ──────────────────────
   // window.rAF queda pausado en sesiones XR inmersivas en Quest. Cualquier
   // librería que dependa de él (HanziWriter, etc.) se congela. Encolamos
   // sus callbacks y las drenamos desde model.animate, que sí tickea via
   // xrSession.requestAnimationFrame.
   const _rafQueue   = new Set();
   const _origRAF    = window.requestAnimationFrame.bind(window);
   const _origCAF    = window.cancelAnimationFrame.bind(window);
   const _origIds    = new Map();
   let   _rafCounter = 0;

   window.requestAnimationFrame = (cb) => {
      const id = ++_rafCounter;
      let fired = false;
      const wrapper = (t) => {
         if (fired) return;
         fired = true;
         _rafQueue.delete(entry);
         _origIds.delete(id);
         try { cb(t); } catch (e) { console.warn('[rAF shim] callback threw:', e); }
      };
      const entry = { id, wrapper };
      _rafQueue.add(entry);
      _origIds.set(id, _origRAF(wrapper));
      return id;
   };

   window.cancelAnimationFrame = (id) => {
      for (const e of _rafQueue) if (e.id === id) { _rafQueue.delete(e); break; }
      const origId = _origIds.get(id);
      if (origId !== undefined) { _origCAF(origId); _origIds.delete(id); }
   };

   let _draining = false;
   const drainRaf = () => {
      // En desktop/web mode, native window.rAF ya maneja todo (incluido el
      // WebXR polyfill, que lo usa como driver de frames). Drenar acá causa
      // recursión: drainRaf → polyfill onDeviceFrame → model.animate → drainRaf.
      // Solo drenamos cuando hay sesión XR real activa.
      if (typeof isXR !== 'function' || !isXR()) return;
      // Belt-and-suspenders: aunque el gate de isXR debería bastar, si por
      // alguna razón nos re-entran (drainRaf → cb → ... → drainRaf), cortamos.
      if (_draining) return;
      if (_rafQueue.size === 0) return;
      _draining = true;
      try {
         const t = performance.now();
         for (const entry of Array.from(_rafQueue)) entry.wrapper(t);
      } finally {
         _draining = false;
      }
   };

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

   // Always-on side plaques (above & to the left of the zone). Sized in
   // absolute meters rather than as fractions of the zone — the zone (your
   // dot square) might be quite small, but the plaques should stay readable.
   //
   // Title sits ABOVE the zone (horizontal banner).
   // Course info sits to the LEFT of the zone (vertical strip — taller than
   // wide, because the four lines stack vertically).
   const TITLE_HALF_W    = 0.18;   // 36 cm wide
   const TITLE_HALF_H    = 0.045;  //  9 cm tall
   const COURSE_HALF_W   = 0.085;  // 17 cm wide  — narrow vertical strip
   const COURSE_HALF_H   = 0.13;   // 26 cm tall  — fits 4 stacked lines
   // Pokédex plaque — same dimensions as COURSE for visual symmetry. Lives on
   // the RIGHT side of the zone, mirrored against the course-info on the LEFT.
   const POKEDEX_HALF_W  = 0.085;  // 17 cm wide
   const POKEDEX_HALF_H  = 0.13;   // 26 cm tall
   const PLAQUE_GAP      = 0.05;   // 5 cm gap between plaque and zone edge.
                                   // Previously 2.5 cm, but the corner ArUcos
                                   // (3 cm side) sit right at the zone corners
                                   // and visibly grazed the plaque edges.
                                   // Doubling the gap leaves a clear ~3.5 cm
                                   // air-gap between any ArUco and the
                                   // closest plaque edge.

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
   // Crosshair angular half-size, in radians. At distance d from the headset,
   // the crosshair renders at world-space half-size = DOT_INDICATOR_ANGULAR_HALF
   // × d, which keeps its apparent size on screen CONSTANT regardless of how
   // far the zone is.
   //
   // Why angular rather than fixed meters: with a fixed 8 cm crosshair, the
   // ring looked huge when ZONE_SIDE was small (zone close → reticle close
   // → big on screen) and tiny when ZONE_SIDE was large. That made it
   // ambiguous whether the user was seeing the wrong size because the
   // calibration was off, or just because the zone was at a different
   // distance. Angular sizing makes the reticle visually invariant to
   // calibration distance — only its position changes when the user tunes
   // ZONE_SIDE, which is exactly the signal needed.
   //
   // 0.04 rad ≈ 2.3° half-angle (≈ 4.6° full-angle). At 1 m this gives
   // 8 cm reticle in world space — same as the old fixed value at typical
   // working distance, so the visual is preserved at common distances.
   const DOT_INDICATOR_ANGULAR_HALF = 0.04;

   // ── Hanzi VFX constants (TUNE THESE) ──────────────────────────────────────
   // Both the line length and the panel size scale with the bbox of the
   // recognized character — bigger character → bigger lines and panels,
   // small character → smaller everything. This keeps the cardinal layout
   // visually balanced regardless of how big the user wrote the hanzi.
   //
   // HANZI_LINE_FACTOR — fraction of bboxSide for each cardinal line's
   //                     length. With factor 0.4 and a 7-cm hanzi, lines
   //                     are 2.8 cm long, which leaves room for the panel
   //                     just past the line.
   // HANZI_PANEL_MUL  — panel side as a multiple of the bbox side. 1.0
   //                     means the panel is the same size as the hanzi —
   //                     compact and proportional. (Was 1.5; that made
   //                     panels so big they didn't fit between the bbox
   //                     and the zone edge.)
   const HANZI_LINE_FACTOR = 0.4;
   const HANZI_PANEL_MUL   = 1.0;

   // ── UI palette ────────────────────────────────────────────────────────────
   // All UI chrome (zone outlines, panel borders, crosshair rings, connector
   // lines, plaque borders, title text) shares one accent color. Defined
   // ONCE here so the whole UI re-tints from a single edit. The chosen
   // accent #b9d9fa is a soft cool white-blue — distinct from the
   // whiteboard's pure white and the black/white of the ArUco markers, so
   // the AR overlays don't blend into the physical surface or the markers.
   //
   // Convention: each color array is [r, g, b] in 0-1. Alpha is applied
   // per-call via the helpers below (rgba) so a single accent can drive
   // bright lines, soft fills, and dim ghosts without duplicating the rgb.
   const UI_ACCENT       = [0.725, 0.851, 0.980]; // #b9d9fa  cool white-blue
   const UI_ACCENT_DIM   = [0.580, 0.680, 0.784]; // 80% mix toward dark for muted variant
   const UI_TEXT_PRIMARY = [1.0, 1.0, 1.0];        // pure white for max readability
   const UI_PANEL_BG     = [0.04, 0.06, 0.10];     // very dark blue-black, panel fill
   // Preview-mode plane fill: a gray mid-tone with low alpha so the user can
   // see the plane's depth in 3D without it occluding the physical dots or
   // the wall behind it. Per user's reference image, this is the actual
   // surface visualization (not just an outline).
   const UI_PLANE_FILL   = [0.45, 0.50, 0.55];     // neutral gray
   // Helper: pack [r,g,b] + alpha into the 4-element array g2.setColor wants.
   const rgba = (c, a) => [c[0], c[1], c[2], a];

   // Corner-radius for rounded panel/plaque outlines (in g2 canvas units,
   // [-1..1]). 0.16 ≈ 8% of the side, matching the reference image's
   // soft-rounded look without going full pill.
   const UI_CORNER_R     = 0.16;

   // Outline thickness for panel/plaque borders. Per the user's reference
   // images (Airbnb, IKEA, Apple Health), the outline is a SUBTLE accent,
   // not structural — thin enough to feel like a refined edge, not a frame.
   // 0.015 in canvas units is roughly 1-2 px on a 1024-px canvas.
   const UI_OUTLINE_W    = 0.015;

   // Auto-fit text helper: returns the largest textHeight at which `text`
   // fits within maxWidth (in g2 canvas units, where the panel spans 2.0
   // wide and 2.0 tall). Probes from `maxH` downward in 0.02 steps until
   // the text fits with a 90% safety margin.
   //
   // Why this exists: textHeight(h) scales font-size linearly, but the
   // rendered text width depends on glyph aspect, font, and string length.
   // A static textHeight that looks fine for "PINYIN" (6 chars) overflows
   // "MR-andarin" (10 chars) on the same panel size. Measuring at runtime
   // is the only way to keep all labels readable across panel sizes.
   //
   // Returns the textHeight already SET on the g2 instance (so the caller
   // can immediately call .text()), and additionally returns the value
   // for inspection.
   function fitText(g2, text, maxWidthG2, maxH = 0.6, minH = 0.08) {
      // Text width is queried via the g2's Canvas measureText. We probe
      // by setting textHeight (which sets font), measuring, comparing.
      const ctx = g2.getContext();
      const safe = maxWidthG2 * 0.90;
      for (let h = maxH; h >= minH; h -= 0.02) {
         g2.textHeight(h);
         const widthCanvasPx = ctx.measureText(text).width;
         // g2's coord system: width 2.0 corresponds to canvas.width pixels.
         // So text-width-in-g2-units = widthCanvasPx / canvas.width * 2.
         const widthG2 = widthCanvasPx / g2.getCanvas().width * 2;
         if (widthG2 <= safe) return h;
      }
      // Couldn't fit even at minH — return minH so SOMETHING draws.
      g2.textHeight(minH);
      return minH;
   }

   // Draw an outline with broken corners (4 separate segments, with a
   // visible gap at each corner). Per the WebXR-style reference image,
   // this is the "modern XR UI" look — outline as accent rather than
   // a continuous frame. Each segment terminates `gap` short of where
   // the corner would be, leaving a visible cutout at every corner.
   //
   // Coordinates: rectangle from (x, y) to (x+w, y+h). gap is in g2 units;
   // a value around 0.18 looks good against UI_CORNER_R = 0.16 (just a
   // bit larger so the gap visibly extends past where the rounded corner
   // would have been).
   function drawBrokenOutline(g2, x, y, w, h, gap) {
      const x0 = x, x1 = x + w;
      const y0 = y, y1 = y + h;
      // top edge — gap at both ends
      g2.drawPath([[x0 + gap, y1], [x1 - gap, y1]]);
      // bottom edge
      g2.drawPath([[x0 + gap, y0], [x1 - gap, y0]]);
      // left edge — gap at top and bottom
      g2.drawPath([[x0, y0 + gap], [x0, y1 - gap]]);
      // right edge
      g2.drawPath([[x1, y0 + gap], [x1, y1 - gap]]);
   }

   // ── VFX choreography (seconds, relative to event start) ───────────────────
   // Hanzi event (fires when a new character is detected):
   //
   //   0.0 - 0.6   sparks fly outward from bbox center
   //   0.6 - 1.6   cardinal lines extend from bbox edges (1.0 s, slower than
   //               before so the connection between character and panels
   //               feels deliberate, not like a quick crosshair pop)
   //   1.6 - 2.0   panel TOP    (meaning) grows in
   //   2.0 - 2.4   panel RIGHT  (pinyin) grows in
   //   2.4 - 2.8   panel LEFT   (image) grows in
   //   2.8 - 3.2   panel BOTTOM (sentence) grows in
   //
   // The four panels enter sequentially rather than simultaneously so the
   // user's eye can track each one as it appears. Each panel takes 0.4 s to
   // grow (T_PANEL_DUR), and each starts 0.4 s after the previous one
   // (T_PANEL_STAGGER = T_PANEL_DUR, so they don't overlap).
   const T_SPARK_DUR     = 0.6;
   const T_LINE_START    = T_SPARK_DUR;                         // 0.6
   const T_LINE_DUR      = 1.0;                                 // slower lines
   const T_PANELS_START  = T_LINE_START + T_LINE_DUR;           // 1.6
   const T_PANEL_DUR     = 0.4;                                 // per-panel grow time
   const T_PANEL_STAGGER = 0.4;                                 // delay between consecutive panels
   // Panel-specific start times (sequential):
   //   meaning  (TOP)    starts at 0 of the panels phase
   //   pinyin   (RIGHT)  starts at 1× stagger
   //   image    (LEFT)   starts at 2× stagger
   //   sentence (BOTTOM) starts at 3× stagger
   const T_PANEL_TOP_START    = T_PANELS_START + 0 * T_PANEL_STAGGER;
   const T_PANEL_RIGHT_START  = T_PANELS_START + 1 * T_PANEL_STAGGER;
   const T_PANEL_LEFT_START   = T_PANELS_START + 2 * T_PANEL_STAGGER;
   const T_PANEL_BOTTOM_START = T_PANELS_START + 3 * T_PANEL_STAGGER;
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
   //
   //    g2Title is created with an EXPLICIT 4:1 canvas (1024×256) to match
   //    the title plaque's aspect ratio (TITLE_HALF_W=0.18, TITLE_HALF_H=0.045).
   //    With G2's default 512×512 square canvas, anything drawn was stretched
   //    4× horizontally when projected onto the wide plaque, which made the
   //    title letters look squashed (vertically) and elongated (horizontally).
   //    Matching the canvas aspect to the panel aspect eliminates the
   //    distortion at its source — text drawn with normal proportions on a
   //    4:1 canvas maps onto a 4:1 panel with no stretch.
   let g2Title      = new G2(false, 1024, 256);   // "MR-andarin" header above the zone
   let g2CourseInfo = new G2();                    // course / instructor / date plaque below
   let g2Pokedex    = new G2();                    // discovered hanzi grid + "learn a new" button (right side)
   let g2HanziWriter = new G2();                   // HanziWriter stroke-order panel (top-left of the zone)

   // Hidden DOM canvas where the HanziWriter library does its drawing. We
   // do NOT add it to the document — it's just a rendering target. Each
   // animation frame, g2HanziWriter.render() blits this canvas onto the
   // visible MR panel via drawImage. This indirection avoids any conflict
   // between G2's per-frame clear-and-redraw cycle and HanziWriter's own
   // requestAnimationFrame-driven canvas updates.
   const HANZI_WRITER_CANVAS_PX = 512;
   const hanziWriterCanvas = document.createElement('canvas');
   hanziWriterCanvas.width  = HANZI_WRITER_CANVAS_PX;
   hanziWriterCanvas.height = HANZI_WRITER_CANVAS_PX;

   // The active HanziWriter instance. Created lazily the first time
   // mandarinState.learnTarget transitions to a non-null value, then reused
   // across target changes via setCharacter(). Stays alive (but not animating)
   // when learnTarget goes back to null.
   let hanziWriterInstance = null;
   let hanziWriterLastChar = null;

   // ── Axolotl intro image (replaces "MR-andarin" text in the lock animation) ──
   // Loaded once at init; rendered into g2Surface each frame during the intro
   // window after lock. Image fades in/out alongside the existing LIDAR scan.
   // We check both `complete` and `naturalWidth` before drawing — `complete`
   // alone is true even on load failure, but a failed load gives naturalWidth=0.
   let axolotlImage = null;
   {
      const _img = new Image();
      _img.onload  = () => { axolotlImage = _img; };
      _img.onerror = (e) => console.warn('[MRandarin] axolotl image failed to load:', e);
      _img.src = '../media/images/axolotl.png';
   }

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
   model.txtrSrc(4,  g2HanziWriter.getCanvas());  // slot 4 reused — g2Char is permanently hidden
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
   model.txtrSrc(15, g2Pokedex.getCanvas());

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
   let panelChar    = model.add('square').dull();           // permanently hidden, no texture slot needed
   let panelPinyin  = model.add('square').txtr(5).dull();
   let panelImage   = model.add('square').txtr(6).dull();
   let panelAI      = model.add('square').txtr(7).dull();
   let panelMeaning = model.add('square').txtr(11).dull();
   let panelDebug   = model.add('square').txtr(8).scale(DEBUG_HUD_SIZE).dull();
   if (!DEBUG_HUD) panelDebug.move(0, -999, 0);

   // 3. Always-on plaques
   let panelTitle      = model.add('square').txtr(13).dull();
   let panelCourseInfo = model.add('square').txtr(14).dull();
   let panelPokedex    = model.add('square').txtr(15).dull();
   let panelHanziWriter = model.add('square').txtr(4).dull();

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
   panelPokedex.setMatrix(HIDDEN_MATRIX);
   panelHanziWriter.setMatrix(HIDDEN_MATRIX);
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

   // ── Pokédex hit-test state ───────────────────────────────────────────────
   // Per-hand finger-touch state for the pokédex panel buttons. Each entry
   // tracks which button id (or -1 for "outside") the finger was over in the
   // PREVIOUS frame, plus a timestamp of the last triggered tap to enforce
   // a 300ms cooldown. A "tap" fires on the transition from -1 → button_id,
   // not on continuous presence inside the button — that way holding the
   // finger near the panel doesn't trigger repeat clicks.
   //
   // Button id convention:
   //   -1   = finger outside any button (or outside panel volume entirely)
   //    0   = "LEARN A NEW HANZI" button (always present)
   //    1+  = grid cell index + 1 (so id=1 is hanzi[0], id=2 is hanzi[1], …)
   // We avoid id=0 collision by reserving 0 for the always-on button.
   const POKEDEX_TAP_COOLDOWN = 0.3;          // seconds
   const POKEDEX_Z_TOUCH      = 0.10;         // meters — finger must be within
                                              // 10 cm of the panel's plane to
                                              // count as touching
   let pokedexHitState = {
      left:  { wasInside: -1, lastTap: -1 },
      right: { wasInside: -1, lastTap: -1 },
   };

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

   // The `alpha` driver is the per-panel progress eased value, so each panel
   // fades in alongside its own grow animation. With sequential reveals, each
   // panel has its own start time (T_PANEL_TOP_START, T_PANEL_RIGHT_START,
   // etc.) so they enter one at a time rather than all together.

   function panelAlphaFor(startTime) {
      if (!hanziActive) return 0;
      const t = model.time - hanziStartTime;
      const pp = Math.max(0, Math.min(1, (t - startTime) / T_PANEL_DUR));
      return pp;
   }
   // Convenience wrappers for each cardinal panel:
   const panelAlphaMeaning  = () => panelAlphaFor(T_PANEL_TOP_START);
   const panelAlphaPinyin   = () => panelAlphaFor(T_PANEL_RIGHT_START);
   const panelAlphaImage    = () => panelAlphaFor(T_PANEL_LEFT_START);
   const panelAlphaSentence = () => panelAlphaFor(T_PANEL_BOTTOM_START);

   function drawPanelChrome(g2, alpha) {
      const ctx = g2.getContext(), canvas = g2.getCanvas();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (alpha <= 0) return false;
      // Borderless panel: just a soft translucent fill so the wall reads
      // through. Per spec we removed the broken-corner outline entirely —
      // outline was busy and competed with the title/value text for visual
      // weight. Bg alpha lowered from 0.85 → 0.45 so the panel looks like
      // a tinted overlay rather than an opaque card.
      g2.setColor(rgba(UI_PANEL_BG, 0.45 * alpha));
      g2.fillRect(-0.98, -0.98, 1.96, 1.96, UI_CORNER_R);
      return true;
   }

   g2Char.render = function () {
      // Hidden by spec for now — never drawn.
      const ctx = this.getContext(), canvas = this.getCanvas();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
   };

   g2Pinyin.render = function () {
      const alpha = panelAlphaPinyin();
      if (!drawPanelChrome(this, alpha)) return;
      if (!displayPinyin) return;
      // Title row at top — small accent color label
      this.setColor(rgba(UI_ACCENT, alpha));
      fitText(this, 'PINYIN', 1.6, 0.18);   // narrow max height = small label
      this.text('PINYIN', 0, 0.62, 'center');
      // Pinyin reading — hero text, auto-fit. textHeight max 0.50 keeps
      // even long pinyin strings ("zhuàng" etc) from overflowing.
      this.setColor(rgba(UI_TEXT_PRIMARY, alpha));
      fitText(this, displayPinyin, 1.6, 0.50);
      this.text(displayPinyin, 0, -0.10, 'center');
   };

   g2Meaning.render = function () {
      const alpha = panelAlphaMeaning();
      if (!drawPanelChrome(this, alpha)) return;
      if (!displayMeaning) return;
      // Title row
      this.setColor(rgba(UI_ACCENT, alpha));
      fitText(this, 'MEANING', 1.6, 0.18);
      this.text('MEANING', 0, 0.62, 'center');
      // Meaning — capped to first '/' segment per spec ("máximo 1 meaning")
      const firstMeaning = displayMeaning.split('/')[0].trim();
      this.setColor(rgba(UI_TEXT_PRIMARY, alpha));
      fitText(this, firstMeaning, 1.6, 0.40);
      this.text(firstMeaning, 0, -0.10, 'center');
   };

   g2Image.render = function () {
      const alpha = panelAlphaImage();
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
      const alpha = panelAlphaSentence();
      if (!drawPanelChrome(this, alpha)) return;
      if (displayAI) {
         this.setColor(rgba(UI_TEXT_PRIMARY, alpha));
         // Wrap words into lines no wider than 18 chars (loose limit; the
         // real fit happens via fitText below).
         const words = displayAI.split(' ');
         const lines = [];
         let line = '';
         for (const w of words) {
            if ((line + w).length > 18) { lines.push(line.trim()); line = ''; }
            line += w + ' ';
         }
         if (line.trim()) lines.push(line.trim());
         // Auto-fit using the LONGEST line so all lines render at the same size.
         const longest = lines.reduce((a, b) => a.length > b.length ? a : b, '');
         fitText(this, longest, 1.6, 0.30);
         this.text(lines.join('\n'), 0, 0, 'center');
      } else {
         this.setColor(rgba(UI_ACCENT, alpha * 0.5));
         fitText(this, 'asking AI...', 1.6, 0.18);
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

      // Just an open ring. No crosshair lines, no filled center — those would
      // sit on top of the physical red dot the user is trying to align with,
      // and obscure the very target they need to see. The hollow center
      // means the dot is fully visible THROUGH the ring once aligned.
      //
      // Alpha lowered to 0.55 so that even when the ring momentarily passes
      // over a physical red dot during head movement, the dot is still
      // recognizable through it — the backend's HSV detector can still find
      // the dot beneath a translucent overlay.
      this.setColor(rgba(UI_ACCENT, 0.55));
      this.lineWidth(0.10);
      const segs = 32, r = 0.78;
      const ring = [];
      for (let i = 0; i <= segs; i++) {
         const a = (i / segs) * Math.PI * 2;
         ring.push([Math.cos(a) * r, Math.sin(a) * r]);
      }
      this.drawPath(ring);
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

      // Borderless: translucent fill only. Same alpha (0.45) as the hanzi
      // info panels so the whole UI reads as one consistent material —
      // tinted glass against the wall.
      //
      // Corner radius `r` here is in g2 X-units, and g2 converts via
      // w2c(r) = canvas.width/2 * r → on a 1024-px-wide canvas, r=0.04
      // gives a 20-px corner radius. That's ~16% of the canvas height
      // (256), matching the visual rounding ratio we'd get on a square
      // canvas with UI_CORNER_R=0.16. (UI_CORNER_R itself would give an
      // 82-px radius here, which would look almost pill-shaped on a 4:1
      // rectangle. Using 0.04 instead keeps the style consistent.)
      this.setColor(rgba(UI_PANEL_BG, 0.45));
      this.fillRect(-0.98, -0.98, 1.96, 1.96, 0.04);

      // Title text — now with natural proportions because the canvas
      // (1024×256) matches the plaque's 4:1 aspect ratio. fitText finds
      // the largest textHeight where "MR-andarin" still fits with
      // comfortable horizontal margin (10% safety baked in).
      this.setColor(rgba(UI_TEXT_PRIMARY, 1.0));
      fitText(this, 'MR-andarin', 1.7, 0.7);
      this.text('MR-andarin', 0, 0, 'center');
   };
   g2Title.update();

   // ─────────────────────────────────────────────────────────────────────────
   // COURSE-INFO PLAQUE
   // ─────────────────────────────────────────────────────────────────────────
   // Static. Sits to the LEFT of the zone as a vertical strip. The strip is
   // narrow horizontally and tall vertically, so we lay each label/value pair
   // as two stacked rows: tiny label, small value, blank gap, repeat.
   g2CourseInfo.render = function () {
      const ctx = this.getContext(), canvas = this.getCanvas();
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Borderless translucent fill — matches title plaque + hanzi panels.
      this.setColor(rgba(UI_PANEL_BG, 0.45));
      this.fillRect(-0.98, -0.98, 1.96, 1.96, UI_CORNER_R);

      // ── Live counters + diagnostic ────────────────────────────────────────
      // Two info rows + axolotl image. Replaces the old student/course/
      // instructor block which was static and irrelevant during the actual
      // experience. Counter is read from the synced pokédex map; the lock
      // diagnostic mirrors mandarinState.fourMarkersDetected (updated by
      // the PC master in pollServer on transitions only).
      const discoveredCount = ((mandarinState.pokedex && mandarinState.pokedex.discovered)
                              ? Object.keys(mandarinState.pokedex.discovered).length
                              : 0);
      const fourOK = !!mandarinState.fourMarkersDetected;

      // Row 1: hanzi count.
      this.setColor(rgba(UI_ACCENT, 0.95));
      this.textHeight(0.085);
      this.text('HANZI DISCOVERED', 0, 0.85, 'center');
      this.setColor(rgba(UI_TEXT_PRIMARY, 1.0));
      this.textHeight(0.20);
      this.text(String(discoveredCount), 0, 0.65, 'center');

      // Row 2: 4-aruco detection diagnostic.
      this.setColor(rgba(UI_ACCENT, 0.95));
      this.textHeight(0.075);
      this.text('AREA LOCKED IN', 0, 0.40, 'center');
      this.setColor(fourOK ? [0.4, 0.95, 0.5, 1.0] : [0.95, 0.45, 0.45, 1.0]);
      this.textHeight(0.13);
      this.text(fourOK ? 'TRUE' : 'FALSE', 0, 0.22, 'center');

      // Row 3: axolotl image. Reuses the asset already loaded for the intro
      // animation. We bypass G2's coord system (drawImage uses pixel coords),
      // resetting the transform exactly like the HanziWriter blit does.
      try {
         if (axolotlImage && axolotlImage.complete && axolotlImage.naturalWidth > 0) {
            const cw = canvas.width, ch = canvas.height;
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            // Bottom portion of the panel, centered. Square-ish region.
            const imgSize = cw * 0.72;
            const imgX = (cw - imgSize) / 2;
            const imgY = ch * 0.58;
            ctx.drawImage(axolotlImage, imgX, imgY, imgSize, imgSize);
            ctx.restore();
         }
      } catch (e) {
         // Image not loaded yet — try again next frame.
      }
   };
   // No g2CourseInfo.update() at init anymore — the panel is dynamic now
   // (live counter + lock indicator), so it must be redrawn every frame.
   // The update call lives in the animate loop below.

   // ─────────────────────────────────────────────────────────────────────────
   // POKÉDEX PLAQUE
   // ─────────────────────────────────────────────────────────────────────────
   // Mirror of COURSE-INFO but on the right side of the zone. Renders a grid
   // of hanzi the user has discovered, plus a "learn a new hanzi" button at
   // the bottom. Each grid cell shows the character on top and its pinyin
   // smaller below. Per the user's spec: meaning is NOT shown here — it lives
   // in the cardinal feedback panels.
   //
   // Re-rendered every frame (g2Pokedex.update() is in the animate loop) so
   // newly discovered hanzi appear without needing a manual refresh.
   //
   // Layout (g2 canvas units, [-1..+1] both axes, top is +1):
   //   y ∈ [+0.78, +0.92]   header  "POKÉDEX"
   //   y ∈ [-0.65, +0.70]   grid    2 cols × up to 7 rows  (max 14 cells visible)
   //   y ∈ [-0.95, -0.72]   button  "LEARN A NEW HANZI"  (rounded rect)
   //
   // Limit of 14 visible cells matches what the panel can comfortably hold at
   // this size. The user is aware they shouldn't exceed it during the demo.
   // (Scrolling is a future improvement, not Fase 3.)
   const POKEDEX_MAX_CELLS = 8;     // 2 cols × 4 rows — generous vertical spacing
   g2Pokedex.render = function () {
      const ctx = this.getContext(), canvas = this.getCanvas();
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Background — same translucent fill as the other plaques.
      this.setColor(rgba(UI_PANEL_BG, 0.45));
      this.fillRect(-0.98, -0.98, 1.96, 1.96, UI_CORNER_R);

      // Header
      this.setColor(rgba(UI_ACCENT, 0.95));
      fitText(this, 'POKÉDEX', 1.7, 0.13);
      this.text('POKÉDEX', 0, 0.75, 'center');

      // Pull discovered hanzi from synchronized state — both PC and headset
      // read the same source of truth.
      const discovered = (mandarinState.pokedex && mandarinState.pokedex.discovered) || {};
      const chars = Object.keys(discovered);
      const visible = chars.slice(0, POKEDEX_MAX_CELLS);

      // Grid layout — fewer cells with double the vertical spacing per cell.
      const gridTop    = 0.55;
      const gridBottom = -0.65;
      const cols       = 2;
      const rows       = Math.ceil(POKEDEX_MAX_CELLS / cols);  // 4
      const cellW      = 1.7 / cols;                            // ≈0.85
      const cellH      = (gridTop - gridBottom) / rows;         // 0.30
      const xCenters   = [-0.425, +0.425];                      // 2 columns centered

      for (let i = 0; i < visible.length; i++) {
         const ch = visible[i];
         const entry = discovered[ch] || {};
         const col = i % cols;
         const row = Math.floor(i / cols);
         const cx  = xCenters[col];
         const cyTop = gridTop - row * cellH;
         const charY   = cyTop - 0.04;
         const pinyinY = cyTop - 0.13;

         // Character — large
         this.setColor(rgba(UI_TEXT_PRIMARY, 1.0));
         this.textHeight(0.085);
         this.text(ch, cx, charY, 'center');

         // Pinyin — smaller, accent color
         const pyText = entry.pinyin || '';
         this.setColor(rgba(UI_ACCENT, 0.85));
         this.textHeight(0.045);
         this.text(pyText, cx, pinyinY, 'center');
      }

      // "LEARN A NEW HANZI" button — visual only in this phase. Filled
      // rounded rect with text on top. Hit-testing is added in Fase 4.
      const btnX = -0.78, btnY = -0.95, btnW = 1.56, btnH = 0.23;
      this.setColor(rgba(UI_ACCENT, 0.30));
      this.fillRect(btnX, btnY, btnW, btnH, 0.08);
      this.setColor(rgba(UI_TEXT_PRIMARY, 0.95));
      fitText(this, 'LEARN A NEW HANZI', btnW * 0.92, 0.085);
      this.text('LEARN A NEW HANZI', 0, btnY + btnH * 0.5, 'center');
   };

   // ─────────────────────────────────────────────────────────────────────────
   // HANZI WRITER PANEL
   // ─────────────────────────────────────────────────────────────────────────
   // Renders the stroke-order animation for the current learn-target hanzi.
   // Sits in the top-left corner of the active zone (30%×30% of zone). The
   // backend is told to white-out the same region (`erase_rects` payload in
   // pollServer) so the OCR ignores this area while the user is writing in
   // the rest of the zone.
   //
   // The HanziWriter library draws into the hidden DOM canvas
   // hanziWriterCanvas via its own animation loop. This render() copies that
   // canvas onto the visible g2 surface every frame plus a translucent
   // background.
   g2HanziWriter.render = function () {
      const ctx = this.getContext(), canvas = this.getCanvas();
      const cw = canvas.width, ch = canvas.height;
      // Save state + reset transform so clearRect operates in raw pixels
      // regardless of any transform G2 applied while drawing other panels.
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      ctx.restore();
      // Translucent background — drawn through G2's coordinate system [-1..+1].
      this.setColor(rgba(UI_PANEL_BG, 0.55));
      this.fillRect(-0.98, -0.98, 1.96, 1.96, UI_CORNER_R);
      // Blit HanziWriter's hidden canvas onto the visible one. We MUST reset
      // the transform first — G2's fillRect leaves a residual scale/translate
      // that would re-map our pixel coords and shrink the image to nothing.
      // No internal margin: HanziWriter has its own padding around the char,
      // adding more here just shrinks the stroke artwork unnecessarily.
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      try {
         ctx.drawImage(hanziWriterCanvas, 0, 0, cw, ch);
      } catch (e) {
         // Canvas might be in an inconsistent state for one frame after
         // setCharacter — drop the blit and retry next frame.
      }
      ctx.restore();
   };

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
   //                 axolotl image fades in
   //   0.4 – 3.4 s   image holds at peak (3 seconds — long enough for the
   //                 user to read the badge and feel like the zone is
   //                 deliberately framed by the mascot)
   //   1.0 – 1.4 s   ring continues until it leaves the canvas
   //   3.4 – 4.1 s   image fades out
   //   4.1 s onward  persistent border only
   const T_TEXT_FADE_IN  = 0.4;
   const T_TEXT_HOLD_END = 3.4;   // was 1.0 — extended to 3 s of hold
   const T_TEXT_FADE_OUT_DUR = 0.7;
   g2Surface.render = function () {
      const ctx = this.getContext(), canvas = this.getCanvas();
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // ── PREVIEW MODE (no lock yet, but 4 dots tracked) ─────────────────────
      // Fill a quadrilateral with soft gray so the user can SEE the
      // calibration plane in 3D as a solid surface. Per the user's
      // reference sketch, the gray fill IS the depth cue — outlines
      // are just an accent.
      //
      // Inset from (±1, ±1) — the four cyan reticles sit at exactly ±1
      // and the inset keeps the gray fill from creeping over the rings
      // themselves. The reticles are HOLLOW (just an open ring) so the
      // physical red dots remain visible through them; we only need a
      // tiny inset (a couple of pixels in canvas space) to keep the fill
      // from bleeding into the ring stroke. m=0.97 leaves the ring fully
      // visible while making the preview surface read as "the same area
      // as the four reticles" — earlier values like 0.78 felt detached
      // from the dots they were supposed to represent.
      if (surfacePreviewActive && !surfaceActive) {
         const m = 0.97;
         this.setColor(rgba(UI_PLANE_FILL, 0.30));
         this.fillRect(-m, -m, 2 * m, 2 * m, UI_CORNER_R * (m / 0.98));
         // Subtle accent outline with broken corners — only an accent, not
         // structure. Same treatment as the panel chrome.
         this.setColor(rgba(UI_ACCENT, 0.55));
         this.lineWidth(UI_OUTLINE_W);
         drawBrokenOutline(this, -m, -m, 2 * m, 2 * m, 0.18);
         return;
      }

      if (!surfaceActive) return;

      const t = model.time - surfaceStartTime;
      if (t < 0) return;

      // ── Persistent perimeter ──────────────────────────────────────────────
      // Thin accent outline with broken corners — fades in fast and stays
      // for the rest of the session. Same accent treatment as the panels,
      // for visual consistency across the whole UI.
      const borderAlpha = Math.min(0.85, t * 2.5);
      this.setColor(rgba(UI_ACCENT, borderAlpha));
      this.lineWidth(UI_OUTLINE_W);
      drawBrokenOutline(this, -0.98, -0.98, 1.96, 1.96, 0.22);

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
                  this.setColor(rgba(UI_ACCENT, dotAlpha * 0.9));
                  this.drawPath([[x - crossSize, y], [x + crossSize, y]]);
                  this.drawPath([[x, y - crossSize], [x, y + crossSize]]);
               }
            }
         }

         // Expanding ring
         this.setColor(rgba(UI_ACCENT, 0.7 * pulseAlpha));
         this.lineWidth(0.025);
         this.drawOval(-maxRadius, -maxRadius, maxRadius * 2, maxRadius * 2);
      }

      // ── Axolotl intro image — fades in, holds, fades out ─────
      // Replaces the previous "MR-andarin" text, which at the chosen
      // textHeight overflowed the canvas at typical zone sizes — only
      // "-and" was visible on a 30-cm zone. The image scales to fit
      // whatever zone size the user has, with aspect ratio preserved.
      const textTotalDur = T_TEXT_HOLD_END + T_TEXT_FADE_OUT_DUR;
      if (t <= textTotalDur && axolotlImage && axolotlImage.complete && axolotlImage.naturalWidth > 0) {
         let imgAlpha;
         if (t < T_TEXT_FADE_IN) {
            imgAlpha = t / T_TEXT_FADE_IN;          // ease-in (linear is fine)
         } else if (t < T_TEXT_HOLD_END) {
            imgAlpha = 1.0;                         // hold at peak
         } else {
            imgAlpha = 1.0 - (t - T_TEXT_HOLD_END) / T_TEXT_FADE_OUT_DUR;
         }
         imgAlpha = Math.max(0, Math.min(1, imgAlpha));

         // Image takes ~70% of the smaller canvas dimension, centered, with
         // aspect ratio preserved. The zone is square in default (no joystick
         // resize), so this lands as a square-ish region in the center of
         // the locked plate. drawImage uses canvas pixel coords directly.
         const W = canvas.width, H = canvas.height;
         const target = Math.min(W, H) * 0.70;
         const imgAspect = axolotlImage.naturalWidth / axolotlImage.naturalHeight;
         let dw, dh;
         if (imgAspect >= 1) { dw = target; dh = target / imgAspect; }
         else                { dh = target; dw = target * imgAspect; }
         const dx = (W - dw) / 2;
         const dy = (H - dh) / 2;

         ctx.globalAlpha = imgAlpha;
         ctx.drawImage(axolotlImage, dx, dy, dw, dh);
         ctx.globalAlpha = 1.0;
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
      // Was 8 small sparks (size 0.02), barely visible. Now 16 sparks of
      // 3× size in two staggered rings — outer ring travels farther, inner
      // ring smaller and brighter. Reads as a real burst.
      if (t < T_SPARK_DUR) {
         const p = t / T_SPARK_DUR;
         // Outer ring: 8 large sparks, fly far
         this.setColor(rgba(UI_ACCENT, 1.0 - p));
         for (let i = 0; i < 8; i++) {
            const angle = i * Math.PI / 4;
            const r = p * 0.55;
            const x = cx + Math.cos(angle) * r;
            const y = cy + Math.sin(angle) * r;
            const sz = 0.06 * (1 - p * 0.4);     // shrink slightly as they fade
            this.fillOval(x - sz/2, y - sz/2, sz, sz);
         }
         // Inner ring: 8 medium sparks, offset by half-angle, shorter range
         this.setColor(rgba(UI_TEXT_PRIMARY, 1.0 - p));
         for (let i = 0; i < 8; i++) {
            const angle = (i + 0.5) * Math.PI / 4;
            const r = p * 0.35;
            const x = cx + Math.cos(angle) * r;
            const y = cy + Math.sin(angle) * r;
            const sz = 0.04 * (1 - p * 0.4);
            this.fillOval(x - sz/2, y - sz/2, sz, sz);
         }
      }

      // ── Phase 2: CARDINAL LINES (extend from bbox edge midpoints) ─────────
      // Lines stay drawn after they finish extending (during panel phase).
      // Accent color so they're visible against any whiteboard, and thick
      // enough (0.03) to read as real connection lines, not accidental
      // crosshair tick marks.
      //
      // Line length is proportional to bbox size (HANZI_LINE_FACTOR ×
      // bboxSide_meters), so a small character gets short lines and a big
      // character gets longer lines — keeps the cardinal layout visually
      // balanced regardless of how big the user wrote the hanzi.
      if (t >= T_LINE_START) {
         const lp = Math.min(1, (t - T_LINE_START) / T_LINE_DUR);

         // Per-axis G2 line lengths — accounts for non-square zone after
         // joystick stretching. Falls back to a sensible default if the zone
         // hasn't been captured yet (shouldn't happen since hanziActive
         // implies a zone exists, but guards against initialization races).
         const hX = activeZone ? activeZone.halfX : 0.25;
         const hY = activeZone ? activeZone.halfY : 0.25;
         // Bbox size in meters → line length in meters → convert to g2
         // units per axis (g2 X-unit = hX meters; g2 Y-unit = hY meters).
         const bboxSideM   = Math.max(wp * 2 * hX, hp * 2 * hY);
         const lineLenM    = HANZI_LINE_FACTOR * bboxSideM;
         const lineLenG2_X = lineLenM / hX;
         const lineLenG2_Y = lineLenM / hY;
         const targetX = lineLenG2_X * lp;
         const targetY = lineLenG2_Y * lp;

         this.setColor(rgba(UI_ACCENT, 0.95));
         this.lineWidth(0.02);

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
         // Wikipedia returns BOTH `thumbnail` (small, ~320px) and
         // `originalimage` (full-resolution). Prefer `originalimage` for
         // visual quality; fall back to thumbnail if not present.
         const imgSrc = (data.originalimage && data.originalimage.source)
                     || (data.thumbnail     && data.thumbnail.source);
         if (imgSrc) {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.src = imgSrc;
            img.onload = () => { displayImage = img; };
         }
      } catch (e) {
         console.warn('Wikipedia fetch failed:', e);
      }

      try {
         // 5 words or fewer per spec — short enough that the bottom panel
         // doesn't need multi-line wrapping at the typical zone size.
         const prompt = `In 5 words or fewer, give one factual and memorable sentence about "${wikiTerm}". No metaphors, just a clear memorable fact. Output only the sentence, no quotes.`;
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
            // Build the predict body. If a learn-target is active, tell the
            // backend to (a) only accept that specific char, and (b) erase
            // the top-left 30%×30% of the zone where the HanziWriter panel
            // is rendered — otherwise OCR would see the animated guide as
            // a real handwritten character.
            const predictBody = { image: base64 };
            const _learnTarget = mandarinState.learnTarget;
            if (_learnTarget && _learnTarget.char) {
               predictBody.target_char = _learnTarget.char;
               // Erase rectangle mirrors the visible HanziWriter panel: top-right
               // corner of the zone, 30%×30%, with a 15% inset to stay clear of
               // the ArUco markers. Zone origin (0,0) is top-left in the warped
               // 800×800 image, so:
               //   x = 1 - 0.15 - 0.30 = 0.55
               //   y = 0.15            (15% from the top)
               predictBody.erase_rects = [{ x: 0.55, y: 0.15, w: 0.30, h: 0.30 }];
            }
            const response = await fetch('http://localhost:1111/predict', {
               method: 'POST',
               headers: { 'Content-Type': 'application/json' },
               body: JSON.stringify(predictBody)
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

            // Update fourMarkersDetected ONLY on transitions, so the headset
            // gets a single re-broadcast per state change instead of one
            // broadcast per /predict response. The backend sends src_corners
            // exactly when it sees a valid 4-marker quad, so its presence is
            // the truth signal we mirror.
            const seeingFour = !!result.src_corners;
            if (seeingFour !== mandarinState.fourMarkersDetected) {
               mandarinState.fourMarkersDetected = seeingFour;
               server.broadcastGlobal('mandarinState');
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
               // If this was a learn-target match, clear the target so the
               // HanziWriter panel disappears and the user can write freely
               // again. The cardinal feedback panels will fire normally
               // because mandarinState.character is set.
               if (result.target_match === true) {
                  mandarinState.learnTarget = null;
                  console.log('[MRandarin] learn target completed — clearing.');
               }
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

      // ── Periodic poll of GET /hanzi (PC master only) ─────────────────────
      // Every 2 seconds the PC fetches the pokédex contents from the backend
      // and broadcasts via mandarinState.pokedex. Other clients (the headset)
      // pick it up automatically through the existing synchronize/broadcast
      // pair at the top of the animate loop. Independent of /predict polling.
      async function pollPokedex() {
         try {
            const resp = await fetch('http://localhost:1111/hanzi');
            if (!resp.ok) return;
            const data = await resp.json();
            mandarinState.pokedex = {
               discovered: data.discovered || {},
               top100:     data.top100 || [],
            };
         } catch (err) {
            // Silent on network errors — the panel just won't update this tick.
         }
      }
      pollPokedex();                        // fire one immediately so the panel
                                            // populates on first show
      setInterval(pollPokedex, 2000);

      // ── Learn-new watcher (PC master only) ───────────────────────────────
      // Any client (typically the headset) that taps the "LEARN A NEW HANZI"
      // button bumps mandarinState.learnNewCounter. The PC master watches
      // for that bump and fetches a fresh target from /hanzi/learn_target,
      // then publishes via mandarinState.learnTarget. We use polling instead
      // of a callback because mandarinState changes propagate via the
      // synchronize/broadcast loop, not via direct listeners.
      let lastLearnNewCounter = mandarinState.learnNewCounter || 0;
      setInterval(async () => {
         const cur = mandarinState.learnNewCounter || 0;
         if (cur === lastLearnNewCounter) return;
         lastLearnNewCounter = cur;
         try {
            const exclude = (mandarinState.learnTarget && mandarinState.learnTarget.char) || '';
            const url = 'http://localhost:1111/hanzi/learn_target'
                      + (exclude ? '?exclude_char=' + encodeURIComponent(exclude) : '');
            const resp = await fetch(url);
            if (!resp.ok) return;
            const data = await resp.json();
            if (data && data.char) {
               mandarinState.learnTarget = {
                  char:    data.char,
                  pinyin:  data.pinyin  || '',
                  meaning: data.meaning || '',
               };
               console.log('[MRandarin] new learn target picked:', data.char);
            }
         } catch (err) {
            console.warn('[MRandarin] learn_target fetch failed:', err);
         }
      }, 200);

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
   // Initialize from current synced state, NOT from undefined. mandarinState
   // is persisted by the framework across PC restarts — when the scene reloads
   // there can be a stale character/pinyin/meaning from a previous session
   // sitting in mandarinState.* . Starting lastCharacter at undefined would
   // make the != check fire on frame one ("人" !== undefined → true), which
   // re-triggers hanziActive and replays the full feedback animation for a
   // character the user didn't actually write. Adopting the current value as
   // our baseline means we only react to FUTURE changes, not stale ones.
   let lastCharacter = (typeof mandarinState.character !== 'undefined')
                       ? mandarinState.character
                       : undefined;
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

   // ── Pokédex hit-test helper ──────────────────────────────────────────────
   // Given the active zone matrix Mz and the user's half-extents (hX, hY),
   // figure out for each hand which pokédex button (if any) the finger is
   // inside. Logs a tap event when a finger transitions from outside → a
   // button (with the cooldown gate). Hooked up in Fase 5 to actually drive
   // the learn-target state — for now this only logs to console.
   //
   // Math: the pokédex panel is positioned by placePanelAt with the same
   // structure each frame. We reconstruct its local frame on the fly:
   //   xAxis = Mz_x · POKEDEX_HALF_W      (column 0 of placePanelAt's matrix)
   //   yAxis = Mz_y · POKEDEX_HALF_H      (column 1)
   //   zAxis = Mz_z                       (column 2, unscaled)
   //   pos   = transform(Mz, [pokedexX, 0, ARUCO_Z_LIFT])
   // To invert (world→local) we project onto the orthonormal Mz_{x,y,z}:
   //   local.x = ((finger - pos) · Mz_x) / POKEDEX_HALF_W
   //   local.y = ((finger - pos) · Mz_y) / POKEDEX_HALF_H
   //   local.z = (finger - pos) · Mz_z          (unitary, no scale)
   // local.x and local.y end up in g2 canvas units [-1..+1] iff finger is
   // physically inside the panel rectangle. local.z is meters away from the
   // plane (sign depends on which side; we just check |z|).
   function pokedexHitTest(Mz, hX) {
      const pokedexX_world = +hX + PLAQUE_GAP + POKEDEX_HALF_W;
      const pos = transform(Mz, [pokedexX_world, 0, ARUCO_Z_LIFT]);
      // Mz columns 0/1/2 are x/y/z axes (Mz is row-major flat-16; column k
      // starts at index 4*k for k=0..3). Indices: x=0,1,2; y=4,5,6; z=8,9,10.
      const Mzx = [Mz[0], Mz[1], Mz[2]];
      const Mzy = [Mz[4], Mz[5], Mz[6]];
      const Mzz = [Mz[8], Mz[9], Mz[10]];

      // Geometry of the pokédex render — these MUST match what
      // g2Pokedex.render draws. If you change the layout in render,
      // change them here too.
      const POKEDEX_BTN_RECT = { x: -0.78, y: -0.95, w: 1.56, h: 0.23 };
      const POKEDEX_GRID_TOP = 0.65;
      const POKEDEX_GRID_COLS    = 2;
      const POKEDEX_GRID_ROWS    = 7;
      const POKEDEX_GRID_BOTTOM  = -0.60;
      const POKEDEX_GRID_CELL_W  = 1.7 / POKEDEX_GRID_COLS;          // ≈0.85
      const POKEDEX_GRID_CELL_H  = (POKEDEX_GRID_TOP - POKEDEX_GRID_BOTTOM)
                                 / POKEDEX_GRID_ROWS;                // ≈0.18
      const POKEDEX_GRID_X_CENTERS = [-0.425, +0.425];

      const inRect = (x, y, rx, ry, rw, rh) =>
         x >= rx && x <= rx + rw && y >= ry && y <= ry + rh;

      const discovered = (mandarinState.pokedex && mandarinState.pokedex.discovered) || {};
      const visibleChars = Object.keys(discovered).slice(0, 14);  // mirror POKEDEX_MAX_CELLS

      for (const hand of ['left', 'right']) {
         const fp = inputEvents.pos(hand);
         if (!fp) {
            pokedexHitState[hand].wasInside = -1;
            continue;
         }
         const dx = fp[0] - pos[0];
         const dy = fp[1] - pos[1];
         const dz = fp[2] - pos[2];
         const localX = (dx * Mzx[0] + dy * Mzx[1] + dz * Mzx[2]) / POKEDEX_HALF_W;
         const localY = (dx * Mzy[0] + dy * Mzy[1] + dz * Mzy[2]) / POKEDEX_HALF_H;
         const localZ = (dx * Mzz[0] + dy * Mzz[1] + dz * Mzz[2]);

         let buttonId = -1;

         if (Math.abs(localZ) <= POKEDEX_Z_TOUCH &&
             localX >= -1 && localX <= 1 && localY >= -1 && localY <= 1) {
            // Finger is in the panel's local volume. Check the buttons.
            // 1) Learn-new button
            if (inRect(localX, localY,
                       POKEDEX_BTN_RECT.x, POKEDEX_BTN_RECT.y,
                       POKEDEX_BTN_RECT.w, POKEDEX_BTN_RECT.h)) {
               buttonId = 0;
            } else {
               // 2) Grid cells (only those with a discovered hanzi)
               for (let i = 0; i < visibleChars.length; i++) {
                  const col = i % POKEDEX_GRID_COLS;
                  const row = Math.floor(i / POKEDEX_GRID_COLS);
                  const cx  = POKEDEX_GRID_X_CENTERS[col];
                  const cyTop = POKEDEX_GRID_TOP - row * POKEDEX_GRID_CELL_H;
                  const rx = cx - POKEDEX_GRID_CELL_W / 2;
                  const ry = cyTop - POKEDEX_GRID_CELL_H;
                  if (inRect(localX, localY,
                             rx, ry,
                             POKEDEX_GRID_CELL_W, POKEDEX_GRID_CELL_H)) {
                     buttonId = i + 1;   // reserve 0 for learn-new
                     break;
                  }
               }
            }
         }

         const prev = pokedexHitState[hand].wasInside;
         if (prev === -1 && buttonId !== -1) {
            // Outside → inside: this is a tap candidate.
            const now = model.time;
            if (now - pokedexHitState[hand].lastTap >= POKEDEX_TAP_COOLDOWN) {
               pokedexHitState[hand].lastTap = now;
               if (buttonId === 0) {
                  // "LEARN A NEW HANZI" — bump the counter; PC master will
                  // fetch a fresh target from /hanzi/learn_target and publish
                  // it via mandarinState.learnTarget.
                  console.log('[MRandarin] pokedex tap: button=learn-new (hand=' + hand + ')');
                  mandarinState.learnNewCounter = (mandarinState.learnNewCounter || 0) + 1;
                  server.broadcastGlobal('mandarinState');
               } else {
                  // Tapped on a discovered hanzi cell. Set it directly as
                  // the new learn-target — no backend round-trip needed
                  // since the pinyin/meaning are already in the pokédex.
                  const ch = visibleChars[buttonId - 1];
                  const entry = ch ? discovered[ch] : null;
                  if (ch && entry) {
                     console.log('[MRandarin] pokedex tap: button=hanzi[' + (buttonId - 1) + '] char=' + ch + ' (hand=' + hand + ')');
                     mandarinState.learnTarget = {
                        char:    ch,
                        pinyin:  entry.pinyin  || '',
                        meaning: entry.meaning || '',
                     };
                     server.broadcastGlobal('mandarinState');
                  }
               }
            }
         }
         pokedexHitState[hand].wasInside = buttonId;
      }
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
      drainRaf();
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
         panelPokedex.setMatrix(HIDDEN_MATRIX);
         panelHanziWriter.setMatrix(HIDDEN_MATRIX);
         pokedexHitState.left.wasInside  = -1;
         pokedexHitState.right.wasInside = -1;
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
      // seconds (LIDAR scan + axolotl image fade). Plaques (title, course
      // info) only enter AFTER the intro is done — bringing them in earlier
      // competes with the intro for attention and clutters a phase where the
      // user is just confirming "yes, the zone is in the right place". They
      // also stay hidden during PREVIEW for the same reason: calibration is
      // about lining up the plane, not reading metadata.
      const T_INTRO_TOTAL = T_TEXT_HOLD_END + T_TEXT_FADE_OUT_DUR;   // ≈4.1 s with the 3-s hold

      // Local helper: position the side plaques using a zone matrix + half-sizes.
      // Used only in LOCKED, after the intro animation completes.
      const placePlaques = (Mz, hX, hY) => {
         const zL = ARUCO_Z_LIFT;
         // Title above the top edge, horizontally centered.
         const titleY = hY + PLAQUE_GAP + TITLE_HALF_H;
         placePanelAt(panelTitle,
                      transform(Mz, [0, titleY, zL]),
                      Mz, TITLE_HALF_W, TITLE_HALF_H);
         // Course-info to the LEFT of the zone, vertically centered.
         const courseX = -hX - PLAQUE_GAP - COURSE_HALF_W;
         placePanelAt(panelCourseInfo,
                      transform(Mz, [courseX, 0, zL]),
                      Mz, COURSE_HALF_W, COURSE_HALF_H);
         // Pokédex to the RIGHT of the zone, vertically centered. Mirror
         // image of the course-info plaque.
         const pokedexX = +hX + PLAQUE_GAP + POKEDEX_HALF_W;
         placePanelAt(panelPokedex,
                      transform(Mz, [pokedexX, 0, zL]),
                      Mz, POKEDEX_HALF_W, POKEDEX_HALF_H);
         // HanziWriter panel — top-RIGHT corner of the zone, 30%×30% of the
         // zone, with a 3% inset from each edge so it doesn't touch the
         // ArUco markers. Only shown when a learn-target is active. The
         // erase_rect sent in pollServer mirrors this geometry so the OCR
         // ignores exactly the pixels we cover visually.
         if (mandarinState.learnTarget && mandarinState.learnTarget.char) {
            const hwHalfW = 0.30 * hX;            // 30% of full zone width × 0.5
            const hwHalfH = 0.30 * hY;
            // 15% inset on the top and right edges to keep clear distance
            // from the ArUco markers (which sit right at the corners). Center:
            //   x = +hX - 0.15 * hX - hwHalfW = (1 - 0.15 - 0.30) * hX = +0.55 * hX
            //   y = +hY - 0.15 * hY - hwHalfH = (1 - 0.15 - 0.30) * hY = +0.55 * hY
            const hwCx = +0.55 * hX;
            const hwCy = +0.55 * hY;
            placePanelAt(panelHanziWriter,
                         transform(Mz, [hwCx, hwCy, zL]),
                         Mz, hwHalfW, hwHalfH);
         } else {
            panelHanziWriter.setMatrix(HIDDEN_MATRIX);
         }
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
            // Pokédex finger hit-test (only when the panel is visible).
            // Logs taps; the actions are connected in Fase 5.
            pokedexHitTest(Mz, hX);
         } else {
            panelTitle.setMatrix(HIDDEN_MATRIX);
            panelCourseInfo.setMatrix(HIDDEN_MATRIX);
            panelPokedex.setMatrix(HIDDEN_MATRIX);
            panelHanziWriter.setMatrix(HIDDEN_MATRIX);
            // Reset hit-test state so a finger that happened to be inside
            // the panel volume during hidden frames doesn't fire a spurious
            // tap when the panel reappears next frame.
            pokedexHitState.left.wasInside  = -1;
            pokedexHitState.right.wasInside = -1;
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
         panelPokedex.setMatrix(HIDDEN_MATRIX);
         panelHanziWriter.setMatrix(HIDDEN_MATRIX);
         pokedexHitState.left.wasInside  = -1;
         pokedexHitState.right.wasInside = -1;

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
            // Headset world position — the [12..14] elements of the
            // inverseViewMatrix are the camera's world-space origin.
            // We need this to compute per-corner distance for angular
            // sizing of each crosshair.
            const cPos    = [inv[12], inv[13], inv[14]];
            const indicators = [dotInd0, dotInd1, dotInd2, dotInd3];

            for (let i = 0; i < 4; i++) {
               const p = corners[i];
               if (!p || !isFinite(p[0]) || !isFinite(p[1]) || !isFinite(p[2])) {
                  indicators[i].setMatrix(HIDDEN_MATRIX);
                  continue;
               }
               // Per-corner world half-size = angular_half × distance.
               // This keeps each reticle's apparent on-screen size
               // identical regardless of how far the corner is from
               // the user — so changing ZONE_SIDE only shifts where
               // the reticles sit, not how big they look.
               const dx = p[0] - cPos[0];
               const dy = p[1] - cPos[1];
               const dz = p[2] - cPos[2];
               const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
               const s = DOT_INDICATOR_ANGULAR_HALF * dist;
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
         panelPokedex.setMatrix(HIDDEN_MATRIX);
         panelHanziWriter.setMatrix(HIDDEN_MATRIX);
         pokedexHitState.left.wasInside  = -1;
         pokedexHitState.right.wasInside = -1;
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
      // Use the CACHED activeZone.matrix — captured once at lock time. The
      // alternative was localPanelMatrix, which gets recomputed from the
      // current viewMatrix every time a character is detected. With small
      // SQUARE_FL miscalibration and head movement between lock and detect,
      // localPanelMatrix points at slightly different world positions every
      // time, which manifested as panels spawning behind the user (in the
      // direction the user was facing during the most recent OCR frame
      // rather than on the original whiteboard).
      //
      // activeZone.matrix is the SAME matrix that anchors the surface VFX,
      // the title plaque, the course-info plaque, and the ArUco markers, so
      // anchoring the hanzi panels to it as well guarantees they all sit on
      // exactly the same plane in world space.
      const M = activeZone ? activeZone.matrix : null;
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
         const lineLen      = HANZI_LINE_FACTOR * bboxSide;          // proportional to bbox
         const offset       = halfBbox + lineLen + panelHalf;        // bbox edge → panel center

         // Hanzi VFX panel: same plane & extent as the surface VFX
         const zoneCenter = transform(M, [0, 0, 0]);
         placePanelAt(hanziFXObj, zoneCenter, M, hX, hY);

         // Per-panel grow animation. Each panel's size goes 0 → panelHalf
         // over its own T_PANEL_DUR window, with ease-out cubic. They start
         // staggered so the user sees them appear one at a time:
         //   meaning  (TOP)    first
         //   pinyin   (RIGHT)  second
         //   image    (LEFT)   third
         //   sentence (BOTTOM) fourth
         const t  = model.time - hanziStartTime;
         const grow = (startTime) => {
            const pp = Math.max(0, Math.min(1, (t - startTime) / T_PANEL_DUR));
            const ease = 1 - Math.pow(1 - pp, 3);
            return panelHalf * ease;
         };
         const halfMeaning  = grow(T_PANEL_TOP_START);
         const halfPinyin   = grow(T_PANEL_RIGHT_START);
         const halfImage    = grow(T_PANEL_LEFT_START);
         const halfSentence = grow(T_PANEL_BOTTOM_START);

         // Helper: place a panel if it has nonzero size, hide otherwise.
         //
         // No clamp: a previous version forced the panel center to stay
         // inside (zoneHalf − panelHalf − ARUCO_KEEPOUT), which for typical
         // bboxes pulled all four panels back to a tiny ~5 cm radius around
         // the zone center — exactly where the hanzi sits. Result: the
         // panels and lines piled up on top of the character instead of
         // appearing at the end of each cardinal line. The cardinal layout
         // (panel directly above / below / left / right of the bbox center)
         // never overlaps the corner ArUcos when the user writes near the
         // zone center, so the clamp was solving a problem that didn't
         // exist while creating the one we just fixed. Trust the math.
         const placeOrHide = (panel, cx, cy, ah) => {
            if (ah <= 0.001) {
               panel.setMatrix(HIDDEN_MATRIX);
               return;
            }
            placePanelAt(panel, transform(M, [cx, cy, 0]), M, ah);
         };

         // Cardinal positions: TOP=meaning, RIGHT=pinyin, LEFT=image, BOTTOM=AI/sentence
         placeOrHide(panelMeaning, localCenterX,          localCenterY + offset, halfMeaning);
         placeOrHide(panelPinyin,  localCenterX + offset, localCenterY,          halfPinyin);
         placeOrHide(panelImage,   localCenterX - offset, localCenterY,          halfImage);
         placeOrHide(panelAI,      localCenterX,          localCenterY - offset, halfSentence);
      } else {
         hanziFXObj.setMatrix(HIDDEN_MATRIX);
         panelMeaning.setMatrix(HIDDEN_MATRIX);
         panelAI.setMatrix(HIDDEN_MATRIX);
         panelImage.setMatrix(HIDDEN_MATRIX);
         panelPinyin.setMatrix(HIDDEN_MATRIX);
      }

      // panelChar stays hidden by spec
      panelChar.setMatrix(HIDDEN_MATRIX);

      // ── HanziWriter lifecycle ─────────────────────────────────────────────
      // React to changes in mandarinState.learnTarget. When it transitions to
      // a new char, point the writer at it (creating one on first use). When
      // it goes back to null, cancel the running animation. The actual canvas
      // copy onto the panel happens in g2HanziWriter.render every frame, so
      // we only need to react to char changes here, not to redraw on every
      // frame.
      {
         const target = mandarinState.learnTarget;
         const targetChar = (target && target.char) ? target.char : null;
         if (targetChar !== hanziWriterLastChar) {
            hanziWriterLastChar = targetChar;
            if (targetChar) {
               try {
                  if (!hanziWriterInstance) {
                     hanziWriterInstance = HanziWriter.create(hanziWriterCanvas, targetChar, {
                        renderer: 'canvas',
                        width:  HANZI_WRITER_CANVAS_PX,
                        height: HANZI_WRITER_CANVAS_PX,
                        showOutline:          true,
                        showCharacter:        false,
                        strokeColor:          '#90c2ff',
                        outlineColor:         '#0b0b0b',
                        strokeAnimationSpeed: 0.55,
                        delayBetweenStrokes:  600,
                        delayBetweenLoops:    900,
                        onLoadCharDataSuccess: () => {
                           try { hanziWriterInstance.loopCharacterAnimation(); }
                           catch (e) { console.warn('[MRandarin] loopCharacterAnimation failed:', e); }
                        },
                        onLoadCharDataError: (err) => {
                           console.warn('[MRandarin] HanziWriter data load failed for', targetChar, err);
                        },
                     });
                  } else {
                     hanziWriterInstance.setCharacter(targetChar)
                        .then(() => hanziWriterInstance.loopCharacterAnimation())
                        .catch(err => console.warn('[MRandarin] setCharacter failed:', err));
                  }
               } catch (err) {
                  console.warn('[MRandarin] HanziWriter setup failed for', targetChar, err);
               }
            } else {
               // Target cleared — cancel the loop. The instance stays alive
               // and ready to switch chars next time.
               if (hanziWriterInstance) {
                  try { hanziWriterInstance.cancelAnimation(); }
                  catch (err) { /* nothing useful to do */ }
               }
               // Also clear the hidden canvas so a stale frame doesn't show
               // through if the panel reopens before setCharacter completes.
               const cctx = hanziWriterCanvas.getContext('2d');
               if (cctx) cctx.clearRect(0, 0, hanziWriterCanvas.width, hanziWriterCanvas.height);
            }
         }
      }

      // ── Update G2 canvases ────────────────────────────────────────────────
      g2Surface.update();
      g2HanziFX.update();
      g2Pinyin.update();
      g2Meaning.update();
      g2Image.update();
      g2AI.update();
      g2CourseInfo.update();
      g2Pokedex.update();
      g2HanziWriter.update();

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