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
};

export const init = async model => {

   global.scene().addNode(new Gltf2Node({ url: "" })).name = "backGround";

   // ── Debug HUD ─────────────────────────────────────────────────────────────
   const DEBUG_HUD = false;
   const DEBUG_HUD_DISTANCE = 1;
   const DEBUG_HUD_DOWN = 0.45;
   const DEBUG_HUD_RIGHT = 0.45;
   const DEBUG_HUD_SIZE = 0.08;

   // ── Panel layout constants ────────────────────────────────────────────────
   const PANEL_DISTANCE = 1.5;
   const PANEL_SIZE = 0.07;
   const PANEL_UP = 0.6;
   const PANEL_RIGHT = 0.6;

   // ── Marker square pose constants (TUNE THESE) ─────────────────────────────
   const SQUARE_FL = 0.5;   // focal length in normalized image units; tweak if depth feels off
   const SQUARE_SIZE = 0.5;   // physical side of the marker square, in meters
   const PANEL_SPREAD = 1.0;   // 1.0 = panels exactly on marker corners; >1.0 pushes them outward
   const ARUCO_SIZE = 0.03;  // physical side of each ArUco hologram, in meters (TUNE)

   let g2Debug = new G2();
   let frameCounter = 0;

   // ── Four G2 panels ────────────────────────────────────────────────────────
   let g2Char = new G2();
   let g2Pinyin = new G2();
   let g2Image = new G2();
   let g2AI = new G2();

   // ── ArUco marker textures (slots 0-3) ─────────────────────────────────────
   // Persisted as holograms over the 4 physical red dots so OpenCV can keep
   // tracking the workspace in the cast even when the user's hand occludes
   // the dots underneath. Mapping: 0=TL, 1=TR, 2=BR, 3=BL.
   model.txtrSrc(0, '../media/mrandarin/ArUco_0.png');
   model.txtrSrc(1, '../media/mrandarin/ArUco_1.png');
   model.txtrSrc(2, '../media/mrandarin/ArUco_2.png');
   model.txtrSrc(3, '../media/mrandarin/ArUco_3.png');

   model.txtrSrc(4, g2Char.getCanvas());
   model.txtrSrc(5, g2Pinyin.getCanvas());
   model.txtrSrc(6, g2Image.getCanvas());
   model.txtrSrc(7, g2AI.getCanvas());
   model.txtrSrc(8, g2Debug.getCanvas());

   let panelChar = model.add('square').txtr(4).dull();
   let panelPinyin = model.add('square').txtr(5).dull();
   let panelImage = model.add('square').txtr(6).dull();
   let panelAI = model.add('square').txtr(7).dull();
   let panelDebug = model.add('square').txtr(8).scale(DEBUG_HUD_SIZE).dull();
   if (!DEBUG_HUD) panelDebug.move(0, -999, 0);

   // ── ArUco hologram panels (TL, TR, BR, BL) ────────────────────────────────
   // These persist across erase/relock cycles. They get positioned the first
   // time mandarinState.srcCorners is valid and stay there until /reset.
   let arucoTL = model.add('square').txtr(0).dull();
   let arucoTR = model.add('square').txtr(1).dull();
   let arucoBR = model.add('square').txtr(2).dull();
   let arucoBL = model.add('square').txtr(3).dull();
   // Hide off-screen until first zone capture.
   arucoTL.move(0, -999, 0);
   arucoTR.move(0, -999, 0);
   arucoBR.move(0, -999, 0);
   arucoBL.move(0, -999, 0);

   // ── Display state ─────────────────────────────────────────────────────────
   let displayChar = null;
   let displayPinyin = null;
   let displayMeaning = null;
   let displayImage = null;
   let displayAI = null;

   // ── PC-only debug overlay (created later if we are master) ────────────────
   let debugDiv = null;                  // HTML <div> shown on the PC window
   let lastServerResult = null;          // last raw response from /predict

   // ── G2 render functions ───────────────────────────────────────────────────
   g2Char.render = function () {
      this.setColor([0.05, 0.05, 0.05, 0.92]);
      this.fillRect(-1, -1, 2, 2);
      if (!displayChar) return;
      this.setColor([1, 1, 1, 1]);
      this.textHeight(0.65);
      this.text(displayChar, 0, 0.05, 'center');
   };

   g2Pinyin.render = function () {
      this.setColor([0.05, 0.05, 0.05, 0.92]);
      this.fillRect(-1, -1, 2, 2);
      if (!displayChar) return;
      this.setColor([0.6, 0.85, 1, 1]);
      this.textHeight(0.22);
      this.text(displayPinyin || '', 0, 0.35, 'center');
      this.setColor([0.6, 0.6, 0.6, 1]);
      this.textHeight(0.14);
      this.text(displayMeaning || '', 0, -0.1, 'center');
   };

   g2Image.render = function () {
      this.setColor([0.05, 0.05, 0.05, 0.92]);
      this.fillRect(-1, -1, 2, 2);
      if (!displayChar) return;
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
         else { dh = ph; dw = ph * imgAspect; }
         const dx = margin + (pw - dw) / 2;
         const dy = margin + (ph - dh) / 2;
         ctx.drawImage(displayImage, dx, dy, dw, dh);
      } else {
         this.setColor([0.15, 0.15, 0.15, 1]);
         this.fillRect(-0.9, -0.9, 1.8, 1.8);
         this.setColor([0.3, 0.3, 0.3, 1]);
         this.textHeight(0.12);
         this.text('loading image...', 0, 0, 'center');
      }
   };

   g2AI.render = function () {
      this.setColor([0.05, 0.05, 0.05, 0.92]);
      this.fillRect(-1, -1, 2, 2);
      if (!displayChar) return;
      if (displayAI) {
         this.setColor([0.85, 0.85, 0.85, 1]);
         this.textHeight(0.13);
         let words = displayAI.split(' ');
         let lines = [], line = '';
         for (let w of words) {
            if ((line + w).length > 20) { lines.push(line.trim()); line = ''; }
            line += w + ' ';
         }
         if (line.trim()) lines.push(line.trim());
         this.text(lines.join('\n'), 0, 0, 'center');
      } else {
         this.setColor([0.3, 0.3, 0.3, 1]);
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

   // ── FETCH WIKIPEDIA IMAGE + AI SENTENCE ──────────────────────────────────
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
         const prompt = `In 10 words or less, give one factual and memorable sentence about "${wikiTerm}". No metaphors, just a clear memorable fact.`;
         displayAI = await askAI(prompt);
      } catch (e) {
         console.warn('AI fetch failed:', e);
         displayAI = '';
      }
   }

   function hidePanels() {
      displayChar = displayPinyin = displayMeaning = displayImage = displayAI = null;
      lastFetchedMeaning = null;
   }

   // ── Manual lock trigger (headset controller button) ───────────────────────
   // Fires on whichever client receives the input — typically the headset,
   // since that's where the controllers are. Bumps lockCounter and broadcasts
   // so the PC Master can pick it up via synchronize at the top of animate.
   // The PC also broadcasts mandarinState every frame, but the headset does
   // NOT — so this explicit broadcast is essential for headset-originated
   // state changes to ever reach the server.
   inputEvents.onPress = hand => {
      mandarinState.lockCounter = (mandarinState.lockCounter || 0) + 1;
      server.broadcastGlobal('mandarinState');
      console.log('[MRandarin] lock pressed (' + hand + ')');
   };

   // ── MASTER CLIENT (PC) ONLY ──────────────────────────────────────────────
   if (clientID == clients[0]) {

      mandarinState.status = 'empty';
      mandarinState.character = null;
      mandarinState.pinyin = null;
      mandarinState.meaning = null;
      mandarinState.erased = false;
      mandarinState.srcCorners = null;
      mandarinState.frameW = 0;
      mandarinState.frameH = 0;

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
               mandarinState.status = 'drawn';
               mandarinState.character = result.character;
               mandarinState.pinyin = result.pinyin;
               mandarinState.meaning = result.meaning;
               mandarinState.erased = false;
            }

            else if (result.erased === true) {
               mandarinState.status = 'empty';
               mandarinState.character = null;
               mandarinState.pinyin = null;
               mandarinState.meaning = null;
               mandarinState.erased = true;
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
      // Bumping resetCounter triggers F3's clear logic on every client (via the
      // mandarinState broadcast). The /reset call reverts the server from
      // TRACKING_ARUCO back to SEARCHING_RED so the next valid red-dot frame
      // re-establishes the workspace.
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
         fetch('http://localhost:1111/reset', { method: 'POST' })
            .catch(err => console.warn('[MRandarin] /reset failed:', err));
      });
   }

   // ── ALL CLIENTS ───────────────────────────────────────────────────────────
   let lastCharacter = undefined;
   let lastFetchedMeaning = null;
   let lastViewMatrix = null;          // refreshed every animate tick
   let localPanelMatrix = null;        // computed locally on this client (uses LOCAL viewMatrix)
   let activeZone = null;        // captured ONCE on first valid srcCorners; persists through erase
   let lastResetCounter = 0;           // tracks mandarinState.resetCounter to detect resets across clients
   let lastLockCounter  = 0;           // tracks mandarinState.lockCounter to detect manual lock presses across clients

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
   // Used for both info panels (localPanelMatrix) and ArUco panels (activeZone).
   function placePanelAt(panel, pos, mat, size) {
      panel.setMatrix([
         mat[0] * size, mat[1] * size, mat[2] * size, 0,
         mat[4] * size, mat[5] * size, mat[6] * size, 0,
         mat[8], mat[9], mat[10], 0,
         pos[0], pos[1], pos[2], 1,
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
      // Handled here (not just in the keydown listener) so the headset picks
      // it up too via the broadcasted resetCounter, not only the PC where the
      // key was actually pressed. Animate hides the panels on the next tick.
      const currentResetCounter = mandarinState.resetCounter || 0;
      if (currentResetCounter !== lastResetCounter) {
         lastResetCounter = currentResetCounter;
         activeZone = null;
         hidePanels();
      }

      // ── Lock signal — capture activeZone (all clients) + switch backend (PC only) ──
      // Bulletproof gate against spurious triggers on page load:
      //   1. Strict monotonic check (>) — only ADVANCING the counter triggers,
      //      never going backward or syncing a stale value from the server.
      //   2. lastLockCounter is claimed FIRST, before any work, so even if we
      //      bail out below we never re-enter on the same value.
      //   3. activeZone capture AND the /lock fetch are BOTH gated on
      //      srcCorners — without it we'd be telling the backend to track
      //      ArUcos that haven't been rendered yet (the bug that caused the
      //      "Markers not found" spam loop on page load).
      const currentLock = mandarinState.lockCounter || 0;
      if (currentLock > lastLockCounter) {
         lastLockCounter = currentLock;   // claim it IMMEDIATELY
         if (mandarinState.srcCorners && mandarinState.frameW && mandarinState.frameH) {
            activeZone = computeLocalPanelMatrix(
               mandarinState.srcCorners, mandarinState.frameW, mandarinState.frameH
            );
            console.log('[MRandarin] zone locked');
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
            displayChar = mandarinState.character;
            displayPinyin = mandarinState.pinyin;
            displayMeaning = mandarinState.meaning;
            displayImage = null;
            displayAI = null;
            // ── Compute the panel pose LOCALLY using this client's viewMatrix ──
            // On the headset, this means panels anchor to where the user's head
            // actually is right now (not where the PC's static view says it is).
            // On the PC master, this still runs but the result is mostly meaningless
            // because the PC has no real XR view — its panels stay invisible because
            // they're in screen-space rather than the user's view anyway.
            localPanelMatrix = computeLocalPanelMatrix(
               mandarinState.srcCorners, mandarinState.frameW, mandarinState.frameH
            );
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

      // ── Place the 4 ArUco hologram panels on the saved zone corners ───────
      if (activeZone) {
         const Mz = activeZone;
         const halfZ = (SQUARE_SIZE / 2) * PANEL_SPREAD;
         const aTL = transform(Mz, [-halfZ, halfZ, 0]);
         const aTR = transform(Mz, [halfZ, halfZ, 0]);
         const aBR = transform(Mz, [halfZ, -halfZ, 0]);
         const aBL = transform(Mz, [-halfZ, -halfZ, 0]);

         placePanelAt(arucoTL, aTL, Mz, ARUCO_SIZE);
         placePanelAt(arucoTR, aTR, Mz, ARUCO_SIZE);
         placePanelAt(arucoBR, aBR, Mz, ARUCO_SIZE);
         placePanelAt(arucoBL, aBL, Mz, ARUCO_SIZE);
      } else {
         const hidden = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -999, 0, 1];
         arucoTL.setMatrix(hidden);
         arucoTR.setMatrix(hidden);
         arucoBR.setMatrix(hidden);
         arucoBL.setMatrix(hidden);
      }

      // ── Place the 4 info panels in the world, anchored to the marker square ──
      const M = localPanelMatrix;
      if (M && displayChar) {
         const half = (SQUARE_SIZE / 2) * PANEL_SPREAD;
         const cornerTL = transform(M, [-half, half, 0]);
         const cornerTR = transform(M, [half, half, 0]);
         const cornerBL = transform(M, [-half, -half, 0]);
         const cornerBR = transform(M, [half, -half, 0]);

         placePanelAt(panelChar, cornerTL, M, PANEL_SIZE);
         placePanelAt(panelPinyin, cornerTR, M, PANEL_SIZE);
         placePanelAt(panelImage, cornerBL, M, PANEL_SIZE);
         placePanelAt(panelAI, cornerBR, M, PANEL_SIZE);
      } else {
         const hidden = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -999, 0, 1];
         panelChar.setMatrix(hidden);
         panelPinyin.setMatrix(hidden);
         panelImage.setMatrix(hidden);
         panelAI.setMatrix(hidden);
      }

      g2Char.update();
      g2Pinyin.update();
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
         ];

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