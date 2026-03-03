import * as cg from "../render/core/cg.js";
import { loadSound, playSoundAtPosition } from "../util/positional-audio.js";

let soundBuffer = [], loadSounds = [];
for (let i = 0; i < 6; i++)
   loadSounds.push(loadSound('../../media/sound/bounce/' + i + '.wav', buffer => soundBuffer[i] = buffer));
Promise.all(loadSounds);

let N = 20;
let r = 0.2;
let balls = [];

for (let i = 0; i < N; i++) {
   balls.push({
      active: false, spawnTime: 0, startPos: [0, 0, 0], targetPos: [0, 0, 0], pos: [0, 0, 0], color: [1, 1, 1]
   });
}

let unlit = [[1, .0, .0], [.8, .0, .4], [.8, .8, .0], [0., .4, .8]];

let beats = [];
let currentBeatIndex = 0;
let travelTime = 2.0;
let spawnZ = -8.0;
let targetZ = 0.0;

let audio;
let isPlaying = false;

// --- NUEVO: 1. LA PLAYLIST ---
// Agrega aquí los nombres exactos de tus archivos
let playlist = [
   { json: '../../media/eros/songdata/hiphop_bigpoppa.json', audio: '../../media/eros/songdata/hiphop_bigpoppa.wav' },
   { json: '../../media/eros/songdata/salsa_supremacorte_unamantecomoyo.json', audio: '../../media/eros/songdata/salsa_supremacorte_unamantecomoyo.mp3' },
   { json: '../../media/eros/songdata/Luis Miguel - La Mentira.json', audio: '../../media/eros/songdata/Luis Miguel - La Mentira.mp3' }
];
let currentSongIndex = 0;
let prevLeftTrigger = false; // Para evitar que salte múltiples canciones de un golpe

// --- NUEVO: 2. FUNCIÓN PARA CARGAR Y RESETEAR ---
async function loadSong(index) {
   // Si hay audio sonando, lo detenemos
   if (audio) {
      audio.pause();
      audio.currentTime = 0;
   }
   
   // Reseteamos el estado del juego
   isPlaying = false;
   currentBeatIndex = 0;
   for (let b of balls) b.active = false;

   try {
      console.log("Cargando canción " + (index + 1) + "...");
      const response = await fetch(playlist[index].json);
      const data = await response.json();
      beats = data.beats;
      audio = new Audio(playlist[index].audio);
      console.log("¡Canción cargada! Presiona gatillo derecho para iniciar.");
   } catch (e) {
      console.error("Error cargando los archivos", e);
   }
}

export const init = async model => {
   let playSound = pos => playSoundAtPosition(soundBuffer[6 * Math.random() >> 0], pos);

   for (let i = 0; i < N; i++)
      model.add('sphere');

   // Cargamos la primera canción al iniciar
   await loadSong(currentSongIndex);

   model.animate(() => {
      // --- NUEVO: 3. CONTROL DE PLAYLIST (GATILLO IZQUIERDO) ---
      let currentLeftTrigger = clientState.button(clientID, 'left', 0);
      
      // Solo cambiamos si lo acabas de presionar (no si lo mantienes apretado)
      if (currentLeftTrigger && !prevLeftTrigger) {
         currentSongIndex++;
         if (currentSongIndex >= playlist.length) {
            currentSongIndex = 0; // Regresamos a la primera si llegamos al final
         }
         loadSong(currentSongIndex);
      }
      prevLeftTrigger = currentLeftTrigger; // Guardamos el estado para el siguiente frame

      // --- INICIAR CANCIÓN (GATILLO DERECHO) ---
      if (!isPlaying && clientState.button(clientID, 'right', 0) && audio) {
         isPlaying = true;
         audio.play();
         console.log("¡Rutina iniciada!");
      }

      if (!isPlaying || !audio) return;

      let currentTime = audio.currentTime;

      // (Todo el código del SPAWNER, MOVIMIENTO, COLISIONES y RENDER va exactamente igual aquí)
      
      // FASE 1: APARECER OBJETOS
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

      // FASE 2, 3 y 4 (Mover, Colisiones, Render...)
      for (let i = 0; i < N; i++) {
         let b = balls[i];
         if (!b.active) {
            model.child(i).scale(0);
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
               hit = true;
               break;
            }
         }

         if (hit) {
            playSound(b.pos);
            b.active = false;
         }

         if (b.active) {
            model.child(i).color(b.color).identity().move(b.pos).scale(r);
         }
      }
   });
}