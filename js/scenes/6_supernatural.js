import * as cg from "../render/core/cg.js";
import { loadSound, playSoundAtPosition } from "../util/positional-audio.js";

// 1. CARGAMOS LOS SONIDOS (Igual que antes)
let soundBuffer = [], loadSounds = [];
for (let i = 0; i < 6; i++)
   loadSounds.push(loadSound('../../media/sound/bounce/' + i + '.wav', buffer => soundBuffer[i] = buffer));
Promise.all(loadSounds);

// 2. CONFIGURACIÓN DEL SISTEMA RÍTMICO
let N = 20; // Redujimos las bolas simultáneas. ¡No necesitamos 100 si las reciclamos!
let r = 0.2;
let balls = []; // Pool de objetos reciclables

// Inicializamos nuestro "Pool" de bolas apagadas
for (let i = 0; i < N; i++) {
   balls.push({
      active: false,
      spawnTime: 0,
      startPos: [0, 0, 0],
      targetPos: [0, 0, 0],
      pos: [0, 0, 0],
      color: [1, 1, 1]
   });
}

let unlit = [[1, .0, .0], [.8, .0, .4], [.8, .8, .0], [0., .4, .8]];

// Variables de la "Banda Transportadora"
let beats = []; // Aquí guardaremos los tiempos del JSON
let currentBeatIndex = 0;
let travelTime = 2.0; // Segundos que tarda la bola en llegar a ti
let spawnZ = -8.0;    // Dónde aparece (lejos)
let targetZ = 0.0;    // Dónde la golpeas (tu posición)

let audio;
let isPlaying = false;

export const init = async model => {
   let playSound = pos => playSoundAtPosition(soundBuffer[6 * Math.random() >> 0], pos);

   for (let i = 0; i < N; i++)
      model.add('sphere');

   // 3. CARGAR DATOS Y AUDIO (Simulado para que cambies las rutas reales)
   // Suponiendo que tu JSON y MP3 están en la carpeta correcta:
   try {
      const response = await fetch('../../media/eros/songdata/hiphop_bigpoppa.json'); // Cambia esta ruta
      const data = await response.json();
      beats = data.beats;

      audio = new Audio('../../media/eros/songdata/hiphop_bigpoppa.wav'); // Cambia esta ruta
   } catch (e) {
      console.error("Error cargando los archivos rítmicos", e);
   }

   model.animate(() => {
      // PRECAUCIÓN DE WEB: Los navegadores no dejan auto-reproducir audio.
      // Usamos el gatillo derecho del control VR para empezar la rutina.
      if (!isPlaying && clientState.button(clientID, 'right', 0)) {
         isPlaying = true;
         audio.play();
         console.log("¡Rutina iniciada!");
      }

      if (!isPlaying || !audio) return; // Si no ha empezado, no hacemos nada

      let currentTime = audio.currentTime; // EL RELOJ MAESTRO

      // --- FASE 1: APARECER OBJETOS (SPAWNER) ---
      // Si el tiempo actual cruzó el momento en que debemos lanzar el siguiente beat...
      while (currentBeatIndex < beats.length && currentTime >= beats[currentBeatIndex] - travelTime) {

         // Buscamos una bola inactiva en nuestro pool para reciclarla
         let ball = balls.find(b => !b.active);

         if (ball) {
            ball.active = true;
            ball.spawnTime = beats[currentBeatIndex] - travelTime; // Cuándo salió

            // Posición aleatoria en X (izquierda/derecha) y Y (arriba/abajo) para que te muevas
            let randomX = (Math.random() - 0.5) * 1.5;
            let randomY = 1.0 + (Math.random() * 0.8); // Altura entre 1.0 y 1.8 metros

            ball.startPos = [randomX, randomY, spawnZ];
            ball.targetPos = [randomX, randomY, targetZ];
            ball.pos = [...ball.startPos];
            ball.color = unlit[currentBeatIndex % 4];
         }
         currentBeatIndex++; // Avanzamos al siguiente beat en la lista
      }

      // --- FASE 2: MOVER OBJETOS Y COLISIONES ---
      for (let i = 0; i < N; i++) {
         let b = balls[i];

         // Si la bola no está activa, la escondemos encogiéndola a escala 0
         if (!b.active) {
            model.child(i).scale(0);
            continue;
         }

         // Calculamos el % de viaje (0.0 es salida, 1.0 es cuando llega a tus manos)
         let progress = (currentTime - b.spawnTime) / travelTime;

         // Interpolación lineal (Lerp) para moverla hacia ti
         // Usamos cg.mix si soporta arrays, o calculamos manualmente el eje Z:
         b.pos[0] = b.startPos[0];
         b.pos[1] = b.startPos[1];
         b.pos[2] = spawnZ + (targetZ - spawnZ) * progress;

         // Si la bola se pasó de largo (ej. 20% más allá de ti), se recicla
         if (progress > 1.2) {
            b.active = false;
         }

         // --- FASE 3: COLISIÓN CON LAS MANOS ---
         let hit = false;
         for (let hand in { left: 0, right: 0 }) {
            let handPos = clientState.finger(clientID, hand, 1);
            if (handPos && cg.distance(b.pos, handPos) < r + 0.05) { // 0.05 de margen de error
               hit = true;
               break;
            }
         }

         if (hit) {
            playSound(b.pos); // ¡Sonido de acierto!
            b.active = false; // La apagamos/reciclamos
         }

         // --- FASE 4: RENDER ---
         if (b.active) {
            model.child(i).color(b.color).identity().move(b.pos).scale(r);
         }
      }
   });
}