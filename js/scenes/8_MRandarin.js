import * as global from "../global.js";
import { Gltf2Node } from "../render/nodes/gltf2.js";

window.mandarinState = {
   status: 'empty'
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

      let lastLog = 0;
      function hasDarkPixels() {
         if (canvas.width <= 300 || canvas.height <= 150) return false;
         const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
         let dark = 0;
         for (let i = 0; i < data.length; i += 4) {
            if ((data[i] + data[i+1] + data[i+2]) / 3 < 80) dark++;
         }
         const now = Date.now();
         if (now - lastLog > 1000) {
            lastLog = now;
            console.log('canvas:', canvas.width + 'x' + canvas.height, '| dark:', dark);
         }
         return dark >= 220000;
      }

      model.animate(() => {
         mandarinState = server.synchronize('mandarinState');
         mandarinState.status = hasDarkPixels() ? 'drawn' : 'empty';
         server.broadcastGlobal('mandarinState');
         sphere.color(mandarinState.status === 'drawn' ? 'green' : 'grey');
      });

   } else {

      model.animate(() => {
         mandarinState = server.synchronize('mandarinState');
         sphere.color(mandarinState.status === 'drawn' ? 'green' : 'grey');
      });

   }
}