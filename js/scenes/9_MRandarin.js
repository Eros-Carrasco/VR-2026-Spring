import * as global from "../global.js";
import { Gltf2Node } from "../render/nodes/gltf2.js";
import { G2 } from "../util/g2.js";
import { askAI } from "../util/aiquery.js";

window.mandarinState = {
   status:    'empty',
   character: null,
   pinyin:    null,
   meaning:   null,
   bbox:      null,
   erased:    false
};

export const init = async model => {

   global.scene().addNode(new Gltf2Node({ url: "" })).name = "backGround";

   // ── G2 PANEL ─────────────────────────────────────────────────────────────
   // A 2D canvas applied as a texture to a 3D plane.
   // G2 canvas spans [-1..+1, -1..+1].
   // This renders: character, pinyin, meaning, wiki image, AI sentence.

   let g2 = new G2();
   model.txtrSrc(4, g2.getCanvas());
   let panelObj = model.add('square').txtr(4).move(0, 1.7, -0.6).scale(0.4).dull();

   // State for what to draw
   let displayChar    = null;
   let displayPinyin  = null;
   let displayMeaning = null;
   let displayImage   = null;   // Image object from Wikipedia
   let displayAI      = null;   // AI sentence string

   g2.render = function() {
      // Background
      this.setColor([0.05, 0.05, 0.05, 0.92]);
      this.fillRect(-1, -1, 2, 2);

      if (!displayChar) {
         // Idle state
         this.setColor([0.5, 0.5, 0.5, 1]);
         this.textHeight(0.12);
         this.text('Write a character', 0, 0.1, 'center');
         this.textHeight(0.07);
         this.text('on the whiteboard', 0, -0.1, 'center');
         return;
      }

      // ── Left side: character, pinyin, meaning ──────────────────────────
      // Character — large
      this.setColor([1, 1, 1, 1]);
      this.textHeight(0.45);
      this.text(displayChar, -0.55, 0.25, 'center');

      // Pinyin
      this.setColor([0.6, 0.85, 1, 1]);
      this.textHeight(0.13);
      this.text(displayPinyin || '', -0.55, -0.22, 'center');

      // Meaning
      this.setColor([0.6, 0.6, 0.6, 1]);
      this.textHeight(0.09);
      this.text(displayMeaning || '', -0.55, -0.42, 'center');

      // Divider line
      this.setColor([0.3, 0.3, 0.3, 1]);
      this.lineWidth(0.01);
      this.line([-0.05, -0.9], [-0.05, 0.9]);

      // ── Right side: Wikipedia image + AI sentence ──────────────────────
      if (displayImage) {
         // Draw image using the raw 2D context
         const ctx = this.getContext();
         const canvas = this.getCanvas();
         const W = canvas.width;
         const H = canvas.height;

         // Map G2 coords to pixel coords
         // G2: x in [-1,1] → pixel x in [0, W], y in [-1,1] → pixel y in [H, 0]
         // Right panel: x from 0.05 to 0.95, y from -0.1 to 0.85
         const px = (W / 2) + 0.05 * (W / 2);         // left edge of image area
         const py = (H / 2) - 0.85 * (H / 2);          // top edge
         const pw = 0.9 * (W / 2);                      // width
         const ph = 0.85 * (H / 2);                     // height

         // Draw image fitted in box while preserving aspect ratio
         const imgAspect = displayImage.width / displayImage.height;
         const boxAspect = pw / ph;
         let dw, dh;
         if (imgAspect > boxAspect) {
            dw = pw;
            dh = pw / imgAspect;
         } else {
            dh = ph;
            dw = ph * imgAspect;
         }
         const dx = px + (pw - dw) / 2;
         const dy = py + (ph - dh) / 2;
         ctx.drawImage(displayImage, dx, dy, dw, dh);
      } else {
         // Placeholder while image loads
         this.setColor([0.15, 0.15, 0.15, 1]);
         this.fillRect(0.1, -0.1, 0.85, 0.9);
         this.setColor([0.3, 0.3, 0.3, 1]);
         this.textHeight(0.08);
         this.text('loading image...', 0.52, 0.35, 'center');
      }

      // AI sentence below the image
      if (displayAI) {
         this.setColor([0.85, 0.85, 0.85, 1]);
         this.textHeight(0.075);
         // Wrap at ~28 chars
         let words = displayAI.split(' ');
         let lines = [], line = '';
         for (let w of words) {
            if ((line + w).length > 28) { lines.push(line.trim()); line = ''; }
            line += w + ' ';
         }
         if (line.trim()) lines.push(line.trim());
         this.text(lines.join('\n'), 0.52, -0.25, 'center');
      } else if (displayChar) {
         this.setColor([0.3, 0.3, 0.3, 1]);
         this.textHeight(0.07);
         this.text('asking AI...', 0.52, -0.25, 'center');
      }
   };

   // ── FETCH WIKIPEDIA IMAGE + AI SENTENCE ──────────────────────────────────
   async function fetchWikiAndAI(meaning) {
      if (!meaning) return;
      const wikiTerm = meaning.split('/')[0].trim();

      // Wikipedia thumbnail
      try {
         const res  = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(wikiTerm)}`);
         const data = await res.json();
         if (data.thumbnail && data.thumbnail.source) {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.src = data.thumbnail.source;
            img.onload = () => { displayImage = img; };
         }
      } catch(e) {
         console.warn('Wikipedia fetch failed:', e);
      }

      // AI memorable sentence
      try {
         const prompt = `In 10 words or less, give one factual and memorable sentence about "${wikiTerm}". No metaphors, just a clear memorable fact.`;
         displayAI = await askAI(prompt);
      } catch(e) {
         console.warn('AI fetch failed:', e);
         displayAI = '';
      }
   }

   // ── MASTER CLIENT (PC) ONLY ──────────────────────────────────────────────
   if (clientID == clients[0]) {

      let canvas = document.createElement('canvas');
      let ctx    = canvas.getContext('2d', { willReadFrequently: true });

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
            const video  = document.createElement('video');
            video.srcObject = stream;
            video.play();
            video.onloadedmetadata = () => {
               canvas.width  = video.videoWidth;
               canvas.height = video.videoHeight;
               setInterval(() => ctx.drawImage(video, 0, 0), 30);
               btn.innerText = '✅ Capturing';
            };
         } catch(err) {
            console.error(err);
            btn.disabled  = false;
            btn.innerText = '📷 Start Capture';
         }
      });

      let isPolling = false;

      async function pollServer() {
         if (isPolling) return;
         if (canvas.width <= 300 || canvas.height <= 150) return;
         isPolling = true;
         try {
            const base64   = canvas.toDataURL('image/png').split(',')[1];
            const response = await fetch('http://localhost:1111/predict', {
               method:  'POST',
               headers: { 'Content-Type': 'application/json' },
               body:    JSON.stringify({ image: base64 })
            });
            const result = await response.json();
            if (result.character) {
               mandarinState.status    = 'drawn';
               mandarinState.character = result.character;
               mandarinState.pinyin    = result.pinyin;
               mandarinState.meaning   = result.meaning;
               mandarinState.bbox      = result.bbox ?? null;
               mandarinState.erased    = false;
            } else if (result.erased === true) {
               mandarinState.status    = 'empty';
               mandarinState.character = null;
               mandarinState.pinyin    = null;
               mandarinState.meaning   = null;
               mandarinState.bbox      = null;
               mandarinState.erased    = true;
            }
            // else: server is locked — character still present, don't touch state
         } catch(err) {
            console.error('server error:', err);
         } finally {
            isPolling = false;
         }
      }

      setInterval(pollServer, 500);
   }

   // ── ALL CLIENTS ───────────────────────────────────────────────────────────
   let lastCharacter = undefined;

   model.animate(() => {
      mandarinState = server.synchronize('mandarinState');

      if (clientID == clients[0])
         server.broadcastGlobal('mandarinState');

      // When character changes, update display state and fetch wiki + AI.
      // Only clear the display when status is explicitly 'empty' — not when
      // character is null during locked state (server returns null no-ops).
      if (mandarinState.character !== lastCharacter ||
          (mandarinState.status === 'empty' && displayChar !== null)) {
         lastCharacter  = mandarinState.character;
         displayChar    = mandarinState.character;
         displayPinyin  = mandarinState.pinyin;
         displayMeaning = mandarinState.meaning;
         displayImage   = null;
         displayAI      = null;

         if (mandarinState.character && mandarinState.meaning) {
            fetchWikiAndAI(mandarinState.meaning);
         }
      }

      g2.update();
   });
};