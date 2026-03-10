import * as cg from "../render/core/cg.js";
import { loadSound, playSoundAtPosition } from "../util/positional-audio.js";
import { ControllerBeam } from "../render/core/controllerInput.js";

// 1. CARGAMOS LOS SONIDOS
let soundBuffer = [], loadSounds = [];
for (let i = 0; i < 6; i++)
   loadSounds.push(loadSound('../../media/sound/bounce/' + i + '.wav', buffer => soundBuffer[i] = buffer));
Promise.all(loadSounds);

export const init = async model => {
   // --- CONSTANTES VISUALES DE PARSE2.JS ---
   const inch = .0254, cw = .01271;
   const x0 = -1.0; // Posición X del menú (a tu izquierda)
   const y0 = 1.5;  // Altura del menú (pecho/ojos)
   const menuScale = 2.5; // Tamaño del texto del menú

   // --- CREACIÓN DEL MENÚ VISUAL (Estilo parse2.js) ---
   let menuOptions = ["Song 1", "Song 2", "Song 3", "Play", "Pause", "Restart"];
   let buttons = [];
   let playLabels = []; // Guardará las variaciones de texto del botón Play

   for (let i = 0; i < menuOptions.length; i++) {
      let btn = model.add().move(x0, y0 - (i * 1.5 * inch * menuScale), -0.5).scale(menuScale);
      let text = menuOptions[i];
      let nc = text.length;

      // Fondo del botón para colisión y hover
      btn.add('square').move(nc*cw/2, -inch/2, .001).scale(nc*cw/2, inch/2, 1).opacity(.8).color(1,1,1);

      if (i === 3) {
         // BOTÓN PLAY: Pre-creamos todos los textos posibles
         let opts = ["Play", "Play Song 1", "Play Song 2", "Play Song 3"];
         for (let j = 0; j < opts.length; j++) {
            let pText = btn.add(clay.text(opts[j])).move(0,0,.002).color(0,0,0);
            pText.opacity(j === 0 ? 1 : 0); // Solo mostramos el genérico al inicio
            playLabels.push(pText);
         }
      } else {
         // BOTONES NORMALES
         btn.add(clay.text(text)).move(0,0,.002).color(0,0,0);
      }
      buttons.push(btn);
   }

   // --- CONFIGURACIÓN DEL SISTEMA RÍTMICO ---
   let N = 20;
   let r = 0.15; // TUS AJUSTES: Radio más pequeño
   let balls = [];
   
   // TUS AJUSTES + MI CORRECCIÓN: 
   // Creamos la esfera escalada a 0 desde el inicio y guardamos la referencia (node)
   for (let i = 0; i < N; i++) {
      let sphereNode = model.add('sphere').scale(0); 
      balls.push({ 
         node: sphereNode, // Referencia directa para no borrar el menú
         active: false, spawnTime: 0, startPos: [0, 0, 0], targetPos: [0, 0, 0], pos: [0, 0, 0], color: [1, 1, 1] 
      });
   }

   let unlit = [[1, .0, .0], [.8, .0, .4], [.8, .8, .0], [0., .4, .8]];
   let beats = [];
   let currentBeatIndex = 0;
   let travelTime = 2.0;
   let spawnZ = -8.0;
   let targetZ = 0.0;

   // --- ESTADO DEL AUDIO Y PLAYLIST (TUS NUEVAS RUTAS) ---
   let audio;
   let isPlaying = false;
   let playlist = [
      { json: '../../media/eros/songdata/hiphop_bigpoppa.json', audio: '../../media/eros/songdata/hiphop_bigpoppa.wav', name: 'Song 1' },
      { json: '../../media/eros/songdata/Luis Miguel - La Mentira.json', audio: '../../media/eros/songdata/Luis Miguel - La Mentira.mp3', name: 'Song 2' },
      { json: '../../media/eros/songdata/salsa_supremacorte_unamantecomoyo.json', audio: '../../media/eros/songdata/salsa_supremacorte_unamantecomoyo.mp3', name: 'Song 3' }
   ];
   let currentSongIndex = -1; // -1 significa que no se ha elegido canción aún

   let playSound = pos => playSoundAtPosition(soundBuffer[6 * Math.random() >> 0], pos);

   // --- INICIAMOS LOS RAYOS LÁSER ---
   let beam = {
      left:  new ControllerBeam(model, 'left'),
      right: new ControllerBeam(model, 'right')
   };

   // --- FUNCIÓN PARA CARGAR CANCIÓN Y ACTUALIZAR UI ---
   async function loadSong(index) {
      if (audio) { audio.pause(); audio.currentTime = 0; }
      isPlaying = false;
      currentBeatIndex = 0;
      for (let b of balls) b.active = false;
      currentSongIndex = index;

      // Actualizamos visualmente el botón de Play
      let playBtn = buttons[3];
      for (let j = 0; j < playLabels.length; j++) {
         playLabels[j].opacity(j === (index + 1) ? 1 : 0);
      }
      
      // Ajustamos el tamaño del fondo blanco para que quepa el nuevo texto largo
      let textStr = "Play " + playlist[index].name;
      let nc = textStr.length;
      playBtn.child(0).identity().move(nc*cw/2, -inch/2, .001).scale(nc*cw/2, inch/2, 1).opacity(.8).color(1,1,1);

      try {
         const response = await fetch(playlist[index].json);
         const data = await response.json();
         beats = data.beats;
         audio = new Audio(playlist[index].audio);
      } catch (e) { console.error("Error cargando", e); }
   }

   // --- EVENTOS DE CLIC (Adaptado de parse2.js) ---
   inputEvents.onPress = hand => {
      // Revisamos si el láser intersecta con el fondo ('square') de algún botón
      for (let i = 0; i < buttons.length; i++) {
         let m = buttons[i].child(0).getGlobalMatrix();
         if (beam[hand].hitRect(m)) {
            
            // Lógica de cada botón
            if (i === 0) loadSong(0);
            if (i === 1) loadSong(1);
            if (i === 2) loadSong(2);
            if (i === 3) { // PLAY
               if (audio && !isPlaying) { isPlaying = true; audio.play(); }
            }
            if (i === 4) { // PAUSE
               if (audio && isPlaying) { isPlaying = false; audio.pause(); }
            }
            if (i === 5) { // RESTART
               if (audio) { 
                  audio.currentTime = 0; currentBeatIndex = 0; 
                  for (let b of balls) b.active = false; 
               }
            }
         }
      }
   };

   // --- CICLO DE ANIMACIÓN PRINCIPAL ---
   model.animate(() => {
      // Actualizamos los láseres (Vital para hitRect)
      beam.left.update();
      beam.right.update();

      // EFECTO HOVER EN EL MENÚ (Brilla azul cuando lo apuntas)
      for (let i = 0; i < buttons.length; i++) {
         let m = buttons[i].child(0).getGlobalMatrix();
         let isHit = beam.left.hitRect(m) || beam.right.hitRect(m);
         buttons[i].child(0).color(isHit ? [0,.5,1] : [1,1,1]); // Azul si lo tocas, blanco si no
      }

      // --- LÓGICA DEL JUEGO RÍTMICO ---
      if (!isPlaying || !audio) return;
      let currentTime = audio.currentTime;

      // FASE 1: SPAWNER
      while (currentBeatIndex < beats.length && currentTime >= beats[currentBeatIndex] - travelTime) {
         let ball = balls.find(b => !b.active);
         if (ball) {
            ball.active = true;
            ball.spawnTime = beats[currentBeatIndex] - travelTime;
            let randomX = (Math.random() - 0.5) * 1.5; 
            let randomY = 1.0 + (Math.random() * 0.8);
            ball.startPos = [randomX, randomY, spawnZ];
            ball.targetPos = [randomX, randomY, targetZ];
            ball.pos = [...ball.startPos];
            ball.color = unlit[currentBeatIndex % 4];
         }
         currentBeatIndex++;
      }

      // FASE 2: MOVER Y COLISIONES
      for (let i = 0; i < N; i++) {
         let b = balls[i];
         
         if (!b.active) {
            // CORRECCIÓN: Usamos el nodo guardado, garantizando que el menú quede intacto
            b.node.scale(0); 
            continue;
         }

         let progress = (currentTime - b.spawnTime) / travelTime;
         b.pos[0] = b.startPos[0];
         b.pos[1] = b.startPos[1];
         b.pos[2] = spawnZ + (targetZ - spawnZ) * progress; 

         if (progress > 1.2) b.active = false;

         let hit = false;
         for (let hand in { left: 0, right: 0 }) {
            let handPos = clientState.finger(clientID, hand, 1);
            if (handPos && cg.distance(b.pos, handPos) < r + 0.05) {
               hit = true; break;
            }
         }

         if (hit) {
            playSound(b.pos);
            b.active = false;
         }

         if (b.active) {
            // CORRECCIÓN: Aplicamos el nuevo radio (r = 0.15) directamente al nodo guardado
            b.node.color(b.color).identity().move(b.pos).scale(r);
         }
      }
   });
}