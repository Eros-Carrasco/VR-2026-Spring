import * as cg from "../render/core/cg.js";
import { loadSound, playSoundAtPosition } from "../util/positional-audio.js";
import { ControllerBeam } from "../render/core/controllerInput.js";

let soundBuffer = [], loadSounds = [];
for (let i = 0; i < 6; i++)
   loadSounds.push(loadSound('../../media/sound/bounce/' + i + '.wav', buffer => soundBuffer[i] = buffer));
Promise.all(loadSounds);

export const init = async model => {
   const inch = .0254, cw = .01271;
   const x0 = -1.0; 
   const y0 = 1.5;  
   const menuScale = 2.5; 
   const colorLeft = [1.0, 0.4, 0.1]; 
   const colorRight = [0.0, 1.0, 1.0];

   // --- CREACIÓN DEL MENÚ VISUAL ---
   let menuOptions = ["Song 1", "Song 2", "Song 3", "Play", "Pause", "Restart"];
   let buttons = [];
   let playLabels = []; 

   for (let i = 0; i < menuOptions.length; i++) {
      let btn = model.add().move(x0, y0 - (i * 1.5 * inch * menuScale), -0.5).scale(menuScale);
      let text = menuOptions[i];
      let nc = text.length;

      btn.add('square').move(nc*cw/2, -inch/2, .001).scale(nc*cw/2, inch/2, 1).opacity(.8).color(1,1,1);

      if (i === 3) { // BOTÓN PLAY/RESUME
         let opts = ["Play", "Play Song 1", "Play Song 2", "Play Song 3", "Resume Song 1", "Resume Song 2", "Resume Song 3"];
         for (let j = 0; j < opts.length; j++) {
            let pText = btn.add(clay.text(opts[j])).move(0,0,.002).color(0,0,0);
            pText.opacity(j === 0 ? 1 : 0); 
            playLabels.push(pText);
         }
      } else {
         btn.add(clay.text(text)).move(0,0,.002).color(0,0,0);
      }
      buttons.push(btn);
   }

   // --- CREACIÓN DEL SISTEMA DE SCORE ---
   let score = 0;
   // Ajustado para estar más pegado al menú
   let scoreNode = model.add().move(-0.7, y0, -0.5).scale(menuScale);
   let currentScoreText = scoreNode.add(clay.text("Score: 0")).color(1, 1, 0); 

   function updateScore(newScore) {
      score = newScore;
      currentScoreText.opacity(0); 
      currentScoreText = scoreNode.add(clay.text("Score: " + score)).color(1, 1, 0); 
   }

   // --- INDICADORES DE MANO (GUANTES) ---
   let leftIndicator = model.add('sphere').color(colorLeft).scale(0);
   let rightIndicator = model.add('sphere').color(colorRight).scale(0);

   // --- CONFIGURACIÓN DEL SISTEMA RÍTMICO ---
   let N = 20;
   let r = 0.10; // Esferas más pequeñas
   let balls = [];
   
   for (let i = 0; i < N; i++) {
      let sphereNode = model.add('sphere').scale(0); 
      balls.push({ 
         node: sphereNode, 
         active: false, spawnTime: 0, startPos: [0, 0, 0], targetPos: [0, 0, 0], pos: [0, 0, 0], 
         color: [1, 1, 1], targetHand: 'left' 
      });
   }

   let beats = [];
   let currentBeatIndex = 0;
   let travelTime = 2.0;
   let spawnZ = -8.0;
   let targetZ = 0.0;

   // --- ESTADO DEL AUDIO Y PLAYLIST ---
   let audio;
   let isPlaying = false;
   let playlist = [
      { json: '../../media/eros/songdata/hiphop_bigpoppa.json', audio: '../../media/eros/songdata/hiphop_bigpoppa.wav', name: 'Song 1' },
      { json: '../../media/eros/songdata/Luis Miguel - La Mentira.json', audio: '../../media/eros/songdata/Luis Miguel - La Mentira.mp3', name: 'Song 2' },
      { json: '../../media/eros/songdata/salsa_supremacorte_unamantecomoyo.json', audio: '../../media/eros/songdata/salsa_supremacorte_unamantecomoyo.mp3', name: 'Song 3' }
   ];
   let currentSongIndex = -1; 

   let playSound = pos => playSoundAtPosition(soundBuffer[6 * Math.random() >> 0], pos);

   let beam = {
      left:  new ControllerBeam(model, 'left'),
      right: new ControllerBeam(model, 'right')
   };

   // Función para actualizar el texto del botón de Play/Resume
   function updatePlayButtonUI(state) {
      if (currentSongIndex === -1) return;
      let playBtn = buttons[3];
      let activeIndex = state === 'play' ? (currentSongIndex + 1) : (currentSongIndex + 4); // 1-3 Play, 4-6 Resume
      
      for (let j = 0; j < playLabels.length; j++) {
         playLabels[j].opacity(j === activeIndex ? 1 : 0);
      }
      
      let textStr = (state === 'play' ? "Play " : "Resume ") + playlist[currentSongIndex].name;
      let nc = textStr.length;
      playBtn.child(0).identity().move(nc*cw/2, -inch/2, .001).scale(nc*cw/2, inch/2, 1).opacity(.8).color(1,1,1);
   }

   async function loadSong(index) {
      if (audio) { audio.pause(); audio.currentTime = 0; }
      isPlaying = false;
      currentBeatIndex = 0;
      updateScore(0); 
      
      for (let b of balls) b.active = false;
      currentSongIndex = index;

      updatePlayButtonUI('play');

      try {
         const response = await fetch(playlist[index].json);
         const data = await response.json();
         beats = data.beats;
         audio = new Audio(playlist[index].audio);
      } catch (e) { console.error("Error cargando", e); }
   }

   inputEvents.onPress = hand => {
      for (let i = 0; i < buttons.length; i++) {
         let m = buttons[i].child(0).getGlobalMatrix();
         if (beam[hand].hitRect(m)) {
            
            if (i === 0) loadSong(0);
            if (i === 1) loadSong(1);
            if (i === 2) loadSong(2);
            if (i === 3) { // PLAY / RESUME
               if (audio && !isPlaying) { 
                  isPlaying = true; 
                  audio.play(); 
                  updatePlayButtonUI('play'); // Se queda diciendo Play
               }
            }
            if (i === 4) { // PAUSE
               if (audio && isPlaying) { 
                  isPlaying = false; 
                  audio.pause(); 
                  updatePlayButtonUI('resume'); // Cambia a Resume
               }
            }
            if (i === 5) { // RESTART
               if (audio) { 
                  audio.currentTime = 0; 
                  currentBeatIndex = 0; 
                  updateScore(0); 
                  for (let b of balls) b.active = false; 
                  
                  // Forzar Play
                  isPlaying = true;
                  audio.play();
                  updatePlayButtonUI('play');
               }
            }
         }
      }
   };

   model.animate(() => {
      beam.left.update();
      beam.right.update();

      // EFECTO HOVER MENÚ
      for (let i = 0; i < buttons.length; i++) {
         let m = buttons[i].child(0).getGlobalMatrix();
         let isHit = beam.left.hitRect(m) || beam.right.hitRect(m);
         buttons[i].child(0).color(isHit ? [0,.5,1] : [1,1,1]); 
      }

      // ACTUALIZAR POSICIÓN DE LOS INDICADORES DE MANO
      let leftHandPos = clientState.finger(clientID, 'left', 1);
      if (leftHandPos) leftIndicator.identity().move(leftHandPos).scale(0.06);
      else leftIndicator.scale(0);

      let rightHandPos = clientState.finger(clientID, 'right', 1);
      if (rightHandPos) rightIndicator.identity().move(rightHandPos).scale(0.06);
      else rightIndicator.scale(0);

      // LÓGICA RÍTMICA
      if (!isPlaying || !audio) return;
      let currentTime = audio.currentTime;

      // FASE 1: SPAWNER 
      while (currentBeatIndex < beats.length && currentTime >= beats[currentBeatIndex] - travelTime) {
         let ball = balls.find(b => !b.active);
         if (ball) {
            ball.active = true;
            ball.spawnTime = beats[currentBeatIndex] - travelTime;
            
            // Dispersión reducida
            let randomX = (Math.random() - 0.5) * 1.2; 
            let randomY = 1.0 + (Math.random() * 0.6);
            
            ball.startPos = [randomX, randomY, spawnZ];
            ball.targetPos = [randomX, randomY, targetZ];
            ball.pos = [...ball.startPos];
            
            let isLeftNode = randomX < 0; 
            ball.targetHand = isLeftNode ? 'left' : 'right';
            ball.color = isLeftNode ? colorLeft : colorRight; 
         }
         currentBeatIndex++;
      }

      // FASE 2: MOVER Y COLISIONES
      for (let i = 0; i < N; i++) {
         let b = balls[i];
         
         if (!b.active) {
            b.node.scale(0); 
            continue;
         }

         let progress = (currentTime - b.spawnTime) / travelTime;
         b.pos[0] = b.startPos[0];
         b.pos[1] = b.startPos[1];
         b.pos[2] = spawnZ + (targetZ - spawnZ) * progress; 

         if (progress > 1.2) b.active = false;

         let hit = false;
         let handPos = clientState.finger(clientID, b.targetHand, 1);
         if (handPos && cg.distance(b.pos, handPos) < r + 0.05) {
            hit = true;
         }

         if (hit) {
            playSound(b.pos);
            b.active = false;
            updateScore(score + 100); 
         }

         if (b.active) {
            b.node.color(b.color).identity().move(b.pos).scale(r);
         }
      }
   });
}