import * as global from "../global.js";
import { Gltf2Node } from "../render/nodes/gltf2.js";

window.mandarinState = {
   status: 'empty',
   character: null
};

export const init = async model => {

   global.scene().addNode(new Gltf2Node({ url: "" })).name = "backGround";

   let sphere = model.add('sphere');
   sphere.move([0, 1.5, -0.6]).scale(0.1);

   if (clientID == clients[0]) {

      let canvas = document.createElement('canvas');
      let ctx = canvas.getContext('2d', { willReadFrequently: true });

      // debug preview
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

      // button to start capture
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

      // ── POLL THE PYTHON SERVER EVERY 2 SECONDS ──────────────────────
      async function pollServer() {
         if (canvas.width <= 300 || canvas.height <= 150) return; // not ready yet

         try {
            // grab current canvas frame as base64 PNG
            const base64 = canvas.toDataURL('image/png').split(',')[1];

            const response = await fetch('http://localhost:1111/predict', {
               method: 'POST',
               headers: { 'Content-Type': 'application/json' },
               body: JSON.stringify({ image: base64 })
            });

            const result = await response.json();

            if (result.character) {
               console.log('recognized:', result.character, '(confidence:', result.confidence + ')');
               mandarinState.status    = 'drawn';
               mandarinState.character = result.character;
            } else {
               mandarinState.status    = 'empty';
               mandarinState.character = null;
            }

         } catch(err) {
            console.error('server error:', err);
         }
      }

      // start polling loop
      setInterval(pollServer, 2000);

      // ── ANIMATION LOOP — MASTER CLIENT ──────────────────────────────
      model.animate(() => {
         mandarinState = server.synchronize('mandarinState');
         server.broadcastGlobal('mandarinState');
         sphere.color(mandarinState.status === 'drawn' ? 'green' : 'grey');
      });

   } else {

      // ── ANIMATION LOOP — HEADSET ─────────────────────────────────────
      model.animate(() => {
         mandarinState = server.synchronize('mandarinState');
         sphere.color(mandarinState.status === 'drawn' ? 'green' : 'grey');
      });

   }
}