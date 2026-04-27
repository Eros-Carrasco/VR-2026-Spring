import { G2 } from "../util/g2.js";

export const init = async model => {
   // ── 1. CONFIGURACIÓN DE TEXTURA Y OBJETO ─────────────────────────────────
   let g2Zone = new G2();
   model.txtrSrc(9, g2Zone.getCanvas());

   let zoneObj = model.add('square')
      .txtr(9)
      .move(0, 1.5, -1.0)
      .scale(0.5);

   // ── 2. ESTADO ─────────────────────────────────────────────────────────────
   let isDiscovered = false;
   let discoveryTime = 9999.0;

   // ── 3. INTERFAZ ───────────────────────────────────────────────────────────
   let btn = document.createElement('button');
   btn.innerText = 'Detectar Superficie (Espacio)';
   btn.style.cssText = `
      position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
      z-index: 9999; padding: 12px 24px; font-size: 16px; cursor: pointer;
      background: #00cecc; color: white; border: none; border-radius: 8px;
      font-weight: bold; font-family: sans-serif;
   `;
   document.body.appendChild(btn);

   const toggleDiscovery = () => {
      isDiscovered = !isDiscovered;
      if (isDiscovered) {
         discoveryTime = model.time;
         btn.innerText = 'Eliminar Zona (Espacio)';
         btn.style.background = '#666666';
      } else {
         discoveryTime = 9999.0;
         btn.innerText = 'Detectar Superficie (Espacio)';
         btn.style.background = '#00cecc';
      }
   };

   btn.onclick = toggleDiscovery;
   document.addEventListener('keydown', (e) => { if (e.code === 'Space') toggleDiscovery(); });

   // ── 4. RENDERIZADO DEL HUD (LIDAR + PERÍMETRO ESTÁTICO) ───────────────────
   g2Zone.render = function () {
      let ctx = this.getContext();
      let canvas = this.getCanvas();
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      let timeSince = model.time - discoveryTime;
      if (timeSince < 0) return; // No dibujar si no se ha activado

      // --- A. PERÍMETRO PERSISTENTE (ESTÁTICO Y SUTIL) ---
      // Alcanza un máximo de 0.3 de opacidad de forma lineal y ahí se queda para siempre.
      let borderAlpha = Math.min(0.5, timeSince * 0.5);

      this.setColor([0.0, 1.0, 0.9, borderAlpha]);
      this.lineWidth(0.015);
      this.drawPath([[-0.98, -0.98], [0.98, -0.98], [0.98, 0.98], [-0.98, 0.98], [-0.98, -0.98]]);

      // --- B. EFECTO DE ESCANEO INICIAL (Solo primeros 1.5s) ---
      if (timeSince <= 1.5) {
         let pulseAlpha = 1.0;
         if (timeSince > 1.0) pulseAlpha = 1.0 - ((timeSince - 1.0) * 2.0);

         let maxRadius = timeSince * 2.8;
         let waveGlowSize = 0.4;

         // Cruces de mapeo
         let step = 0.15, crossSize = 0.015;
         this.lineWidth(0.008);
         for (let x = -0.9; x <= 0.9; x += step) {
            for (let y = -0.9; y <= 0.9; y += step) {
               let dist = Math.sqrt(x * x + y * y);
               let distanceToWave = maxRadius - dist;

               if (distanceToWave > 0 && distanceToWave < waveGlowSize) {
                  let dotAlpha = (1.0 - (distanceToWave / waveGlowSize)) * pulseAlpha;
                  this.setColor([0.0, 1.0, 0.9, dotAlpha * 0.7]);
                  this.drawPath([[x - crossSize, y], [x + crossSize, y]]);
                  this.drawPath([[x, y - crossSize], [x, y + crossSize]]);
               }
            }
         }

         // Anillo de la onda expansiva
         this.setColor([0.0, 1.0, 0.9, 0.5 * pulseAlpha]);
         this.lineWidth(0.02);
         this.drawOval(-maxRadius, -maxRadius, maxRadius * 2, maxRadius * 2);
      }
   };

   // ── 5. ACTUALIZACIÓN ──────────────────────────────────────────────────────
   model.animate(() => {
      g2Zone.update();
   });
};