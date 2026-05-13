import { G2 } from "../util/g2.js";
import HanziWriter from "../util/hanzi-writer.esm.js";

// Test scene that replicates MRandarin's lazy HanziWriter lifecycle:
// HanziWriter.create() is NOT called at init — instead it's called inside
// the animate loop the first time a "target" appears, just like MRandarin
// reacts to mandarinState.learnTarget changing from null to a value.
//
// Two clickable areas (top half / bottom half of the panel) cycle the
// "target" between null → '你' → null → '好' → null. Click anywhere on
// the panel via mouse to advance. Run from the PC, no headset needed.
// If the strokes animate visibly, the lazy lifecycle works. If the panel
// stays blank, that confirms the lazy create is the bug.

export const init = async model => {
   let g2 = new G2();
   model.txtrSrc(2, g2.getCanvas());
   model.add('square').txtr(2).move(0, 1.5, 0).scale(0.4);

   const HW_PX = 512;
   const hwCanvas = document.createElement('canvas');
   hwCanvas.width  = HW_PX;
   hwCanvas.height = HW_PX;

   // Mimic MRandarin's lazy state: NO instance at init.
   let hanziWriterInstance = null;
   let hanziWriterLastChar = null;

   // Cycle of "targets" — advance with the keyboard key 'n'.
   const cycle = [null, '你', null, '好', null, '是'];
   let cycleIdx = 0;
   let target = cycle[cycleIdx];

   document.addEventListener('keydown', (e) => {
      if (e.key === 'n' || e.key === 'N') {
         cycleIdx = (cycleIdx + 1) % cycle.length;
         target = cycle[cycleIdx];
         console.log('[test_hanziwriter_lazy] target →', target);
      }
   });

   g2.render = function () {
      const ctx = this.getContext(), canvas = this.getCanvas();
      const cw = canvas.width, ch = canvas.height;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      ctx.restore();

      this.setColor([0.04, 0.06, 0.10, 0.55]);
      this.fillRect(-0.98, -0.98, 1.96, 1.96, 0.16);

      this.setColor('white');
      this.textHeight(0.07);
      this.text('Press N to cycle target', 0, 0.92, 'center');
      this.text('current: ' + (target || 'null'), 0, 0.83, 'center');

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      try {
         ctx.drawImage(hwCanvas, 0, 0, cw, ch);
      } catch (e) {}
      ctx.restore();
   };

   model.animate(() => {
      // ── Lazy lifecycle — IDENTICAL pattern to MRandarin ──────────────────
      if (target !== hanziWriterLastChar) {
         hanziWriterLastChar = target;
         if (target) {
            try {
               if (!hanziWriterInstance) {
                  hanziWriterInstance = HanziWriter.create(hwCanvas, target, {
                     renderer:             'canvas',
                     width:                HW_PX,
                     height:               HW_PX,
                     showOutline:          true,
                     showCharacter:        false,
                     strokeColor:          '#90c2ff',
                     outlineColor:         '#0b0b0b',
                     strokeAnimationSpeed: 0.55,
                     delayBetweenStrokes:  600,
                     delayBetweenLoops:    900,
                  });
               } else {
                  hanziWriterInstance.setCharacter(target);
               }
               hanziWriterInstance.loopCharacterAnimation();
            } catch (err) {
               console.warn('[test_hanziwriter_lazy] setup failed:', err);
            }
         } else {
            if (hanziWriterInstance) {
               try { hanziWriterInstance.cancelAnimation(); }
               catch (err) {}
            }
            const cctx = hwCanvas.getContext('2d');
            if (cctx) cctx.clearRect(0, 0, hwCanvas.width, hwCanvas.height);
         }
      }

      g2.update();
   });
};
