import * as global from "../global.js";
import { Gltf2Node } from "../render/nodes/gltf2.js";

window.mandarinState = {
   status: 'empty',
   character: null,
   pinyin: null,
   meaning: null
};

export const init = async model => {

   global.scene().addNode(new Gltf2Node({ url: "" })).name = "backGround";

   // ── SHARED PANEL ─────────────────────────────────────────────────────────

   const inch = 0.0254;
   const panelScale = 4;

   let panel = model.add().move(0, 1.7, -0.6).scale(panelScale);
   panel.add('square').move(0, 0, 0).scale(6 * inch, 3 * inch, 1).color(0, 0, 0).opacity(0.9);
   let currentText = panel.add(clay.text('Write a character')).move(0, 0, 0.001).color(1, 1, 1);
   let lastCharacter = undefined;

   function updatePanel(character, pinyin, meaning) {
      currentText.opacity(0);
      if (character) {
         let group = panel.add().move(0, 0, 0.001);
         group.add(clay.text(character)).move(-0.08, 0.01, 0).scale(2.5).color(1, 1, 1);
         group.add(clay.text(pinyin || '')).move(0.06, 0.03, 0).scale(1).color(0.7, 0.9, 1);
         group.add(clay.text(meaning || '')).move(0.06, -0.01, 0).scale(0.7).color(0.6, 0.6, 0.6);
         currentText = group;
      } else {
         currentText = panel.add(clay.text('Write a character')).move(0, 0, 0.001).color(0.6, 0.6, 0.6);
      }
   }

   // ── MASTER CLIENT (PC) ONLY ──────────────────────────────────────────────

   if (clientID == clients[0]) {

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
            if (result.character) {
               mandarinState.status = 'drawn';
               mandarinState.character = result.character;
               mandarinState.pinyin = result.pinyin;
               mandarinState.meaning = result.meaning;
            } else {
               mandarinState.status = 'empty';
               mandarinState.character = null;
               mandarinState.pinyin = null;
               mandarinState.meaning = null;
            }
         } catch (err) {
            console.error('server error:', err);
         } finally {
            isPolling = false;
         }
      }

      setInterval(pollServer, 500);
   }

   // ── ALL CLIENTS ───────────────────────────────────────────────────────────

   model.animate(() => {
      mandarinState = server.synchronize('mandarinState');

      if (clientID == clients[0])
         server.broadcastGlobal('mandarinState');

      if (mandarinState.character !== lastCharacter) {
         lastCharacter = mandarinState.character;
         updatePanel(mandarinState.character, mandarinState.pinyin, mandarinState.meaning);
      }
   });
}