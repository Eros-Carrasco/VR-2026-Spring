import * as global from "../global.js";
import { Gltf2Node } from "../render/nodes/gltf2.js";
import { G2 } from "../util/g2.js";
import { askAI } from "../util/aiquery.js";

window.mandarinState = {
   status:    'empty',
   character: null,
   pinyin:    null,
   meaning:   null,
   erased:    false,
};

export const init = async model => {

   global.scene().addNode(new Gltf2Node({ url: "" })).name = "backGround";

   // ── Debug HUD ─────────────────────────────────────────────────────────────
   const DEBUG_HUD          = false;
   const DEBUG_HUD_DISTANCE = 1;
   const DEBUG_HUD_DOWN     = 0.45;
   const DEBUG_HUD_RIGHT    = 0.45;
   const DEBUG_HUD_SIZE     = 0.08;

   // ── Panel layout constants ────────────────────────────────────────────────
   const PANEL_DISTANCE = 1.5;
   const PANEL_SIZE     = 0.07;
   const PANEL_UP       = 0.6;
   const PANEL_RIGHT    = 0.6;

   let g2Debug = new G2();
   let frameCounter = 0;

   // ── Four G2 panels ────────────────────────────────────────────────────────
   let g2Char = new G2();
   let g2Pinyin = new G2();
   let g2Image = new G2();
   let g2AI = new G2();

   model.txtrSrc(4, g2Char.getCanvas());
   model.txtrSrc(5, g2Pinyin.getCanvas());
   model.txtrSrc(6, g2Image.getCanvas());
   model.txtrSrc(7, g2AI.getCanvas());
   model.txtrSrc(8, g2Debug.getCanvas());

   let panelChar   = model.add('square').txtr(4).dull();
   let panelPinyin = model.add('square').txtr(5).dull();
   let panelImage  = model.add('square').txtr(6).dull();
   let panelAI     = model.add('square').txtr(7).dull();
   let panelDebug = model.add('square').txtr(8).scale(DEBUG_HUD_SIZE).dull();
   if (!DEBUG_HUD) panelDebug.move(0, -999, 0);

   // ── Display state ─────────────────────────────────────────────────────────
   let displayChar = null;
   let displayPinyin = null;
   let displayMeaning = null;
   let displayImage = null;
   let displayAI = null;

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

      const role   = (typeof clientID !== 'undefined' && clients && clientID == clients[0]) ? 'PC' : 'HEADSET';
      const status = mandarinState.status || '—';
      const char   = mandarinState.character || '—';

      this.setColor([0.6, 0.85, 1, 1]);
      this.textHeight(0.13);
      this.text('MRandarin debug', 0, 0.85, 'center');

      this.setColor([0.85, 0.85, 0.85, 1]);
      this.textHeight(0.11);
      const lines = [
         'role: '   + role,
         'frame: '  + frameCounter,
         'status: ' + status,
         'char: '   + char,
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

   // ── MASTER CLIENT (PC) ONLY ──────────────────────────────────────────────
   if (clientID == clients[0]) {

      mandarinState.status    = 'empty';
      mandarinState.character = null;
      mandarinState.pinyin    = null;
      mandarinState.meaning   = null;
      mandarinState.erased    = false;

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
         try {
            const base64 = canvas.toDataURL('image/png').split(',')[1];
            const response = await fetch('http://localhost:1111/predict', {
               method: 'POST',
               headers: { 'Content-Type': 'application/json' },
               body: JSON.stringify({ image: base64 })
            });
            const result = await response.json();
            console.log('[MRandarin] server result:', JSON.stringify(result));
            if (result.character) {
               mandarinState.status    = 'drawn';
               mandarinState.character = result.character;
               mandarinState.pinyin    = result.pinyin;
               mandarinState.meaning   = result.meaning;
               mandarinState.erased    = false;
            } else if (result.erased === true) {
               mandarinState.status    = 'empty';
               mandarinState.character = null;
               mandarinState.pinyin    = null;
               mandarinState.meaning   = null;
               mandarinState.erased    = true;
            }
            // else: server is locked — no change
         } catch (err) {
            console.error('server error:', err);
         } finally {
            isPolling = false;
         }
      }

      setInterval(pollServer, 500);
   }

   // ── ALL CLIENTS ───────────────────────────────────────────────────────────
   let lastCharacter = undefined;
   let lastFetchedMeaning = null;

   model.animate(() => {
      mandarinState = server.synchronize('mandarinState');
      if (clientID == clients[0]) {
         server.broadcastGlobal('mandarinState');
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
            if (mandarinState.meaning !== lastFetchedMeaning) {
               lastFetchedMeaning = mandarinState.meaning;
               if (clientID != clients[0]) {
                  fetchWikiAndAI(mandarinState.meaning);
               }
            }
         } else {
            hidePanels();
         }
      }

      if (DEBUG_HUD) {
         frameCounter++;
         const inv     = clay.root().inverseViewMatrix(0);
         const headPos = [inv[12], inv[13], inv[14]];
         const right   = [inv[0],  inv[1],  inv[2]];
         const up      = [inv[4],  inv[5],  inv[6]];
         const forward = [-inv[8], -inv[9], -inv[10]];
         const p = [
            headPos[0] + forward[0] * DEBUG_HUD_DISTANCE - up[0] * DEBUG_HUD_DOWN + right[0] * DEBUG_HUD_RIGHT,
            headPos[1] + forward[1] * DEBUG_HUD_DISTANCE - up[1] * DEBUG_HUD_DOWN + right[1] * DEBUG_HUD_RIGHT,
            headPos[2] + forward[2] * DEBUG_HUD_DISTANCE - up[2] * DEBUG_HUD_DOWN + right[2] * DEBUG_HUD_RIGHT,
         ];
         panelDebug.setMatrix([
            right[0]   * DEBUG_HUD_SIZE, right[1]   * DEBUG_HUD_SIZE, right[2]   * DEBUG_HUD_SIZE, 0,
            up[0]      * DEBUG_HUD_SIZE, up[1]      * DEBUG_HUD_SIZE, up[2]      * DEBUG_HUD_SIZE, 0,
            -forward[0],                -forward[1],                  -forward[2],                 0,
            p[0], p[1], p[2], 1,
         ]);
         g2Debug.update();
      }

      {
         const inv     = clay.root().inverseViewMatrix(0);
         const headPos = [inv[12], inv[13], inv[14]];
         const right   = [inv[0],  inv[1],  inv[2]];
         const up      = [inv[4],  inv[5],  inv[6]];
         const forward = [-inv[8], -inv[9], -inv[10]];

         function placePanel(panel, rx, uy) {
            const p = [
               headPos[0] + forward[0] * PANEL_DISTANCE + up[0] * uy + right[0] * rx,
               headPos[1] + forward[1] * PANEL_DISTANCE + up[1] * uy + right[1] * rx,
               headPos[2] + forward[2] * PANEL_DISTANCE + up[2] * uy + right[2] * rx,
            ];
            panel.setMatrix([
               right[0] * PANEL_SIZE,  right[1] * PANEL_SIZE,  right[2] * PANEL_SIZE,  0,
               up[0]    * PANEL_SIZE,  up[1]    * PANEL_SIZE,  up[2]    * PANEL_SIZE,  0,
               -forward[0],           -forward[1],            -forward[2],            0,
               p[0], p[1], p[2], 1,
            ]);
         }

         placePanel(panelChar,   -PANEL_RIGHT,  PANEL_UP);
         placePanel(panelPinyin,  PANEL_RIGHT,  PANEL_UP);
         placePanel(panelImage,  -PANEL_RIGHT, -PANEL_UP);
         placePanel(panelAI,      PANEL_RIGHT, -PANEL_UP);
      }

      g2Char.update();
      g2Pinyin.update();
      g2Image.update();
      g2AI.update();
   });
};
