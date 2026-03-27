import * as global from "../global.js";
import { Gltf2Node } from "../render/nodes/gltf2.js";

window.mandarinState = {
   status: 'empty',
   character: null
};

// ── CHARACTER LOOKUP: pinyin + meaning ──────────────────────────────────────
const characters = {
   '的': { pinyin: 'de',     meaning: 'Possessive particle' },
   '了': { pinyin: 'le',     meaning: 'Completed action' },
   '是': { pinyin: 'shi',    meaning: 'To be' },
   '不': { pinyin: 'bu',     meaning: 'No / Not' },
   '在': { pinyin: 'zai',    meaning: 'At / In / Exist' },
   '之': { pinyin: 'zhi',    meaning: 'Of / It' },
   '地': { pinyin: 'de',     meaning: 'Adverb particle' },
   '个': { pinyin: 'ge',     meaning: 'General measure word' },
   '我': { pinyin: 'wo',     meaning: 'I / Me' },
   '你': { pinyin: 'ni',     meaning: 'You' },
   '他': { pinyin: 'ta',     meaning: 'He / Him' },
   '她': { pinyin: 'ta',     meaning: 'She / Her' },
   '们': { pinyin: 'men',    meaning: 'Plural marker' },
   '有': { pinyin: 'you',    meaning: 'To have' },
   '来': { pinyin: 'lai',    meaning: 'To come' },
   '到': { pinyin: 'dao',    meaning: 'To arrive' },
   '想': { pinyin: 'xiang',  meaning: 'To think / Want' },
   '看': { pinyin: 'kan',    meaning: 'To see / Watch' },
   '会': { pinyin: 'hui',    meaning: 'Can / Will' },
   '去': { pinyin: 'qu',     meaning: 'To go' },
   '做': { pinyin: 'zuo',    meaning: 'To do / Make' },
   '要': { pinyin: 'yao',    meaning: 'To want / Need' },
   '说': { pinyin: 'shuo',   meaning: 'To say / Speak' },
   '上': { pinyin: 'shang',  meaning: 'Above / On' },
   '中': { pinyin: 'zhong',  meaning: 'Middle / Center' },
   '后': { pinyin: 'hou',    meaning: 'Behind / After' },
   '下': { pinyin: 'xia',    meaning: 'Below / Under' },
   '年': { pinyin: 'nian',   meaning: 'Year' },
   '天': { pinyin: 'tian',   meaning: 'Day / Sky' },
   '时': { pinyin: 'shi',    meaning: 'Time / Hour' },
   '人': { pinyin: 'ren',    meaning: 'Person / People' },
   '大': { pinyin: 'da',     meaning: 'Big / Large' },
   '这': { pinyin: 'zhe',    meaning: 'This' },
   '那': { pinyin: 'na',     meaning: 'That' },
   '国': { pinyin: 'guo',    meaning: 'Country / Nation' },
   '家': { pinyin: 'jia',    meaning: 'Family / Home' },
   '小': { pinyin: 'xiao',   meaning: 'Small' },
   '好': { pinyin: 'hao',    meaning: 'Good / Well' },
   '月': { pinyin: 'yue',    meaning: 'Moon / Month' },
   '水': { pinyin: 'shui',   meaning: 'Water' },
   '火': { pinyin: 'huo',    meaning: 'Fire' },
   '山': { pinyin: 'shan',   meaning: 'Mountain' },
   '丁': { pinyin: 'ding',   meaning: '4th heavenly stem' },
};

export const init = async model => {

   global.scene().addNode(new Gltf2Node({ url: "" })).name = "backGround";

   // ── MASTER CLIENT (PC) ONLY ──────────────────────────────────────────────
   if (clientID == clients[0]) {

      let sphere = model.add('sphere');
      sphere.move([0, 1.5, -0.6]).scale(0.1);

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

      async function pollServer() {
         if (canvas.width <= 300 || canvas.height <= 150) return;
         try {
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

      setInterval(pollServer, 2000);

      // PC only broadcasts — never synchronizes
      model.animate(() => {
         server.broadcastGlobal('mandarinState');
         sphere.color(mandarinState.status === 'drawn' ? 'green' : 'grey');
      });

   // ── HEADSET ONLY ─────────────────────────────────────────────────────────
   } else {

      const inch = 0.0254;
      const panelScale = 3;

      // panel node
      let panel = model.add().move(0, 1.7, -0.6).scale(panelScale);

      // background
      panel.add('square').move(0, 0, 0).scale(6*inch, 3*inch, 1).color(0,0,0).opacity(0.8);

      // current text node — same pattern as score example
      let currentText = panel.add(clay.text('Write a character')).move(0, 0, 0.001).color(1,1,1);
      let lastCharacter = undefined;

      function updatePanel(character) {
         // hide old text
         currentText.opacity(0);

         if (character && characters[character]) {
            const { pinyin, meaning } = characters[character];
            currentText = panel.add(clay.text(character + '  ' + pinyin + '\n' + meaning))
                               .move(0, 0, 0.001)
                               .color(1, 1, 1);
         } else if (character) {
            currentText = panel.add(clay.text(character))
                               .move(0, 0, 0.001)
                               .color(1, 1, 1);
         } else {
            currentText = panel.add(clay.text('Write a character'))
                               .move(0, 0, 0.001)
                               .color(0.6, 0.6, 0.6);
         }
      }

      // headset only synchronizes — never broadcasts
      model.animate(() => {
         mandarinState = server.synchronize('mandarinState');
         if (mandarinState.character !== lastCharacter) {
            lastCharacter = mandarinState.character;
            updatePanel(mandarinState.character);
         }
      });
   }
}