import { G2 } from "../util/g2.js";
import { transform } from "../util/matrix.js";

export const init = async model => {
   // ── Configuración de Dimensiones ─────────────────────────────────────────
   const CENTRAL_SIZE   = 0.45;  // Área reservada para el Hanzi (bbox)
   const PANEL_SIZE     = 0.50;
   const PANEL_HALF     = PANEL_SIZE / 2;
   const OFFSET         = 0.75;  // Distancia del centro a los paneles

   // ── Coreografía Secuencial ───────────────────────────────────────────────
   // Fase 1: Chispas       → 0.0s a 0.3s
   // Fase 2: Líneas        → 0.3s a 0.7s
   // Fase 3: Paneles       → 0.7s a 1.1s
   const T_SPARK_DUR    = 0.3;
   const T_LINE_START   = T_SPARK_DUR;                 // 0.3 — empiezan cuando terminan las chispas
   const T_LINE_DUR     = 0.4;
   const T_PANEL_START  = T_LINE_START + T_LINE_DUR;   // 0.7 — empiezan cuando terminan las líneas
   const T_PANEL_DUR    = 0.4;

   let isShowing       = false;
   let appearStartTime = 9999.0;
   let mockData = { char: '月', pinyin: 'yuè', meaning: 'moon / month' };

   // ── Interfaz ──────────────────────────────────────────────────────────────
   let btn = document.createElement('button');
   btn.innerText = 'Detectar Hanzi (Espacio)';
   btn.style.cssText = `position:fixed; bottom:20px; left:50%; transform:translateX(-50%); z-index:9999; padding:12px 24px; background:#00cecc; color:white; border:none; border-radius:8px; font-weight:bold; cursor:pointer;`;
   document.body.appendChild(btn);

   const toggleSystem = () => {
      isShowing = !isShowing;
      appearStartTime = isShowing ? model.time : 9999.0;
      btn.innerText = isShowing ? 'Limpiar' : 'Detectar Hanzi (Espacio)';
   };
   btn.onclick = toggleSystem;
   document.addEventListener('keydown', (e) => { if (e.code === 'Space') toggleSystem(); });

   // ── Capas G2 ──────────────────────────────────────────────────────────────
   let g2FX     = new G2(); // Partículas y Líneas
   let g2Top    = new G2(); // Pinyin
   let g2Bottom = new G2(); // AI/Descripción
   let g2Left   = new G2(); // Imagen/Icono
   let g2Right  = new G2(); // Significado

   model.txtrSrc(1, g2FX.getCanvas());
   model.txtrSrc(2, g2Top.getCanvas());
   model.txtrSrc(3, g2Bottom.getCanvas());
   model.txtrSrc(4, g2Left.getCanvas());
   model.txtrSrc(5, g2Right.getCanvas());

   let objFX     = model.add('square').txtr(1).dull();
   let panelTop    = model.add('square').txtr(2).dull();
   let panelBottom = model.add('square').txtr(3).dull();
   let panelLeft   = model.add('square').txtr(4).dull();
   let panelRight  = model.add('square').txtr(5).dull();

   // ── Renderizado de Efectos (Cruz y Partículas) ───────────────────────────
   g2FX.render = function() {
      let ctx = this.getContext(), canvas = this.getCanvas();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let t = model.time - appearStartTime;
      if (t < 0) return;

      // 1. PARTÍCULAS FUGAZES (Salen del Hanzi)
      if (t < T_SPARK_DUR) {
         let p = t / T_SPARK_DUR;
         this.setColor([0.5, 1.0, 1.0, 1.0 - p]);
         for(let i=0; i<8; i++) {
            let angle = i * Math.PI / 4;
            let r = p * 0.4;
            this.fillOval(Math.cos(angle)*r - 0.01, Math.sin(angle)*r - 0.01, 0.02, 0.02);
         }
      }

      // 2. LÍNEAS EN CRUZ (Nacen del borde del CENTRAL_SIZE) — sólo durante su fase
      if (t >= T_LINE_START && t <= T_PANEL_START + 0.05) {
         let lp = Math.min(1, (t - T_LINE_START) / T_LINE_DUR);
         this.setColor([0.0, 1.0, 0.9, 0.8]);
         this.lineWidth(0.015);

         const inner = CENTRAL_SIZE / 2;
         const outer = OFFSET - PANEL_HALF;
         const target = inner + (outer - inner) * lp;

         // Dibujar las 4 líneas cardinales
         this.drawPath([[0, inner], [0, target]]);   // Arriba
         this.drawPath([[0, -inner], [0, -target]]); // Abajo
         this.drawPath([[-inner, 0], [-target, 0]]); // Izquierda
         this.drawPath([[inner, 0], [target, 0]]);   // Derecha
      }
   };

   const drawPanel = (g2, title, content, alpha) => {
      let ctx = g2.getContext(), canvas = g2.getCanvas();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      alpha = Math.max(0, Math.min(1, alpha));
      if (alpha <= 0) return;

      g2.setColor([0.02, 0.05, 0.1, 0.8 * alpha]);
      g2.fillRect(-1, -1, 2, 2);
      g2.setColor([0.0, 1.0, 0.9, 0.5 * alpha]);
      g2.lineWidth(0.04);
      g2.drawPath([[-1,-1],[1,-1],[1,1],[-1,1],[-1,-1]]);

      g2.setColor([1, 1, 1, alpha]);
      g2.textHeight(0.2);
      g2.text(title, 0, 0.3, 'center');
      g2.textHeight(0.15);
      g2.setColor([0.7, 0.8, 0.9, alpha]);
      g2.text(content, 0, -0.2, 'center');
   };

   // Progreso normalizado [0..1] de la fase de paneles
   const panelProgress = () => {
      let t = model.time - appearStartTime;
      return Math.max(0, Math.min(1, (t - T_PANEL_START) / T_PANEL_DUR));
   };

   g2Top.render    = function() { drawPanel(this, "PINYIN",  mockData.pinyin,  panelProgress()); };
   g2Bottom.render = function() { drawPanel(this, "DETAILS", "Moon Phase",     panelProgress()); };
   g2Left.render   = function() { drawPanel(this, "VISUAL",  "🌙",             panelProgress()); };
   g2Right.render  = function() { drawPanel(this, "MEANING", mockData.meaning, panelProgress()); };

   // ── Animación Espacial ────────────────────────────────────────────────────
   const HIDE = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,-99,0,1];

   model.animate(() => {
      g2FX.update(); g2Top.update(); g2Bottom.update(); g2Left.update(); g2Right.update();

      const M = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,1.5,-1.5,1]; // Centro frente al usuario
      const rx = [M[0], M[1], M[2]], uy = [M[4], M[5], M[6]], nz = [M[8], M[9], M[10]];

      function place(obj, pos, size) {
         obj.setMatrix([
            rx[0]*size, rx[1]*size, rx[2]*size, 0,
            uy[0]*size, uy[1]*size, uy[2]*size, 0,
            nz[0],      nz[1],      nz[2],      0,
            pos[0],     pos[1],     pos[2],     1
         ]);
      }

      const c = [M[12], M[13], M[14]];
      place(objFX, c, 1.0); // La capa de efectos cubre toda el área

      if (isShowing) {
         // Animación de tamaño con ease-out cubic, sincronizada con el alpha
         let pp = panelProgress();
         let ease = 1 - Math.pow(1 - pp, 3);
         let pSize = PANEL_HALF * ease;

         if (pSize > 0.001) {
            place(panelTop,    transform(M, [0,  OFFSET, 0]), pSize);
            place(panelBottom, transform(M, [0, -OFFSET, 0]), pSize);
            place(panelLeft,   transform(M, [-OFFSET, 0, 0]), pSize);
            place(panelRight,  transform(M, [ OFFSET, 0, 0]), pSize);
         } else {
            // Aún no toca: ocultos hasta que termine la fase de líneas
            [panelTop, panelBottom, panelLeft, panelRight].forEach(p => p.setMatrix(HIDE));
         }
      } else {
         [panelTop, panelBottom, panelLeft, panelRight].forEach(p => p.setMatrix(HIDE));
      }
   });
};