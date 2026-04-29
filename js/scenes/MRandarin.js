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

   // ── Marker square pose constants (TUNE THESE) ─────────────────────────────
   const SQUARE_FL    = 0.5;   // focal length in normalized image units; tweak if depth feels off
   const SQUARE_SIZE  = 0.5;   // physical side of the marker square, in meters
   const PANEL_SPREAD = 1.0;   // 1.0 = panels exactly on marker corners; >1.0 pushes them outward
   const ARUCO_SIZE   = 0.03;  // physical side of each ArUco hologram, in meters (TUNE)

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

   // ── Render order matters: later .add() calls draw ON TOP of earlier ones ──
   // Stack (bottom → top):
   //   1. Surface VFX & Hanzi VFX (coplanar with the workspace)
   //   2. Info panels (above the VFX, below the ArUco holograms)
   //   3. ArUco holograms (always on top — they're the OpenCV tracking targets,
   //      they MUST remain visible to the headset's casted view at all times,
   //      especially during the VFX animation)

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

   // 3. ArUco holograms (topmost — render last)
   let arucoTL = model.add('square').txtr(0).dull();
   let arucoTR = model.add('square').txtr(1).dull();
   let arucoBR = model.add('square').txtr(2).dull();
   let arucoBL = model.add('square').txtr(3).dull();

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
   // Line length in G2 space:
   //   line_g2 = 2 * HANZI_LINE_LEN / SQUARE_SIZE
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
         const lineLenG2 = 2 * HANZI_LINE_LEN / SQUARE_SIZE;
         const target = lineLenG2 * lp;

         this.setColor([0.0, 1.0, 0.9, 0.8]);
         this.lineWidth(0.015);

         // TOP    — from (cx, cy + hh) upward
         this.drawPath([[cx, cy + hh], [cx, cy + hh + target]]);
         // BOTTOM — from (cx, cy - hh) downward
         this.drawPath([[cx, cy - hh], [cx, cy - hh - target]]);
         // LEFT   — from (cx - hw, cy) leftward
         this.drawPath([[cx - hw, cy], [cx - hw - target, cy]]);
         // RIGHT  — from (cx + hw, cy) rightward
         this.drawPath([[cx + hw, cy], [cx + hw + target, cy]]);
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
         fetch('http://localhost:1111/reset', { method: 'POST' })
            .catch(err => console.warn('[MRandarin] /reset failed:', err));
      });
   }

   // ── ALL CLIENTS ───────────────────────────────────────────────────────────
   let lastCharacter = undefined;
   let lastFetchedMeaning = null;
   let lastViewMatrix = null;
   let localPanelMatrix = null;       // recomputed when a new character is detected (uses LOCAL viewMatrix)
   let activeZone = null;             // captured ONCE on first valid srcCorners; persists through erase
   let lastResetCounter = 0;
   let lastLockCounter  = 0;

   // Build a square→model-space pose from the four image-space corners returned
   // by the server. Uses THIS client's current inverseViewMatrix(0), so when run
   // on the headset the result is anchored to the user's actual head pose.
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

      const squareToCameraCV = computeCameraPose(C, SQUARE_FL, SQUARE_SIZE);
      // CV convention (camera looks +z) → GL/WebXR convention (camera looks -z).
      const flipZ = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];
      const squareToCamera = mxm(flipZ, squareToCameraCV);

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
      return M;
   }

   // Position `panel` at world point `pos`, oriented by `mat`'s basis, scaled by `size`.
   // size = HALF-extent (because the unit square spans [-1..1]).
   function placePanelAt(panel, pos, mat, size) {
      panel.setMatrix([
         mat[0] * size, mat[1] * size, mat[2] * size, 0,
         mat[4] * size, mat[5] * size, mat[6] * size, 0,
         mat[8],        mat[9],        mat[10],       0,
         pos[0],        pos[1],        pos[2],        1,
      ]);
   }

   model.animate(() => {
      mandarinState = server.synchronize('mandarinState');
      if (clientID == clients[0]) {
         server.broadcastGlobal('mandarinState');
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
      }

      // ── Lock signal — capture activeZone (all clients) + switch backend (PC only) ──
      // Bulletproof gate against spurious triggers on page load:
      //   1. Strict monotonic check (>) — only ADVANCING the counter triggers.
      //   2. lastLockCounter is claimed FIRST, before any work.
      //   3. activeZone capture AND the /lock fetch are BOTH gated on
      //      srcCorners.
      // Surface VFX re-triggers on every lock (per spec) — startTime is
      // updated regardless of whether activeZone is being captured for the
      // first time or refreshed.
      const currentLock = mandarinState.lockCounter || 0;
      if (currentLock > lastLockCounter) {
         lastLockCounter = currentLock;
         if (mandarinState.srcCorners && mandarinState.frameW && mandarinState.frameH) {
            activeZone = computeLocalPanelMatrix(
               mandarinState.srcCorners, mandarinState.frameW, mandarinState.frameH
            );
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
            console.warn('[MRandarin] lock pressed but no srcCorners available — point camera at the 4 red dots first, then press again');
         }
      }

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
            localPanelMatrix = computeLocalPanelMatrix(
               mandarinState.srcCorners, mandarinState.frameW, mandarinState.frameH
            );
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
      // SCENE PLACEMENT — based on activeZone & character state
      // ─────────────────────────────────────────────────────────────────────
      if (activeZone) {
         const Mz = activeZone;
         const halfZ = (SQUARE_SIZE / 2) * PANEL_SPREAD;

         // ── Surface VFX panel: covers the entire zone, coplanar ────────────
         const zoneCenter = transform(Mz, [0, 0, 0]);
         placePanelAt(surfaceObj, zoneCenter, Mz, SQUARE_SIZE / 2);

         // ── ArUco hologram panels at the 4 corners ─────────────────────────
         const aTL = transform(Mz, [-halfZ,  halfZ, 0]);
         const aTR = transform(Mz, [ halfZ,  halfZ, 0]);
         const aBR = transform(Mz, [ halfZ, -halfZ, 0]);
         const aBL = transform(Mz, [-halfZ, -halfZ, 0]);
         placePanelAt(arucoTL, aTL, Mz, ARUCO_SIZE);
         placePanelAt(arucoTR, aTR, Mz, ARUCO_SIZE);
         placePanelAt(arucoBR, aBR, Mz, ARUCO_SIZE);
         placePanelAt(arucoBL, aBL, Mz, ARUCO_SIZE);
      } else {
         surfaceObj.setMatrix(HIDDEN_MATRIX);
         arucoTL.setMatrix(HIDDEN_MATRIX);
         arucoTR.setMatrix(HIDDEN_MATRIX);
         arucoBR.setMatrix(HIDDEN_MATRIX);
         arucoBL.setMatrix(HIDDEN_MATRIX);
      }

      // ── Hanzi VFX + info panels (anchored to bbox within activeZone) ──────
      const M = localPanelMatrix;
      const haveBbox =
         displayChar &&
         M &&
         mandarinState.char_x_pct != null &&
         mandarinState.char_y_pct != null &&
         mandarinState.bbox_w_pct != null &&
         mandarinState.bbox_h_pct != null;

      if (haveBbox) {
         // Bbox geometry in zone-local meters
         const localCenterX = (mandarinState.char_x_pct - 0.5) * SQUARE_SIZE;
         const localCenterY = -(mandarinState.char_y_pct - 0.5) * SQUARE_SIZE;
         const localW       = mandarinState.bbox_w_pct * SQUARE_SIZE;
         const localH       = mandarinState.bbox_h_pct * SQUARE_SIZE;
         const bboxSide     = Math.max(localW, localH);             // square panels per spec
         const halfBbox     = bboxSide / 2;
         const panelHalf    = (HANZI_PANEL_MUL * bboxSide) / 2;
         const offset       = halfBbox + HANZI_LINE_LEN + panelHalf; // bbox edge → panel center

         // Hanzi VFX panel: same plane & extent as the surface VFX
         const zoneCenter = transform(M, [0, 0, 0]);
         placePanelAt(hanziFXObj, zoneCenter, M, SQUARE_SIZE / 2);

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
            'lockCounter:  ' + (mandarinState.lockCounter  || 0),
            'resetCounter: ' + (mandarinState.resetCounter || 0),
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