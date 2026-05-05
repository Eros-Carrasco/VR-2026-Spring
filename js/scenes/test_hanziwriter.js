import { G2 } from "../util/g2.js";
import HanziWriter from "../util/hanzi-writer.esm.js";

// Minimal test scene: spins up HanziWriter on a hidden canvas and blits it
// onto a G2 panel using the same save/setTransform/restore pattern that
// MRandarin.js uses. If the stroke-order animation of 你 appears on the
// panel, the library + the blit pipeline both work.

export const init = async model => {
   // Visible G2 panel
   let g2 = new G2();
   model.txtrSrc(2, g2.getCanvas());
   model.add('square').txtr(2).move(0, 1.5, 0).scale(0.4);

   // Hidden DOM canvas where HanziWriter does its drawing
   const HW_PX = 512;
   const hwCanvas = document.createElement('canvas');
   hwCanvas.width  = HW_PX;
   hwCanvas.height = HW_PX;

   // Spin up HanziWriter on the hidden canvas
   const writer = HanziWriter.create(hwCanvas, '你', {
      renderer: 'canvas',
      width:  HW_PX,
      height: HW_PX,
      showOutline:    true,
      showCharacter:  false,
      strokeColor:    '#90c2ff',
      outlineColor:   '#0b0b0b',
      strokeAnimationSpeed: .55,
      delayBetweenStrokes:  600,
      delayBetweenLoops:    900,
   });
   writer.loopCharacterAnimation();

   // Same blit pattern as MRandarin.js — translucent BG via G2, then
   // drawImage of the hidden canvas after resetting the transform.
   g2.render = function () {
      const ctx = this.getContext(), canvas = this.getCanvas();
      const cw = canvas.width, ch = canvas.height;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      ctx.restore();

      this.setColor([0.15, 0.15, 0.20, 0.9]);
      this.fillRect(-0.98, -0.98, 1.96, 1.96, 0.05);

      const margin = 0.0 * cw;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      try {
         ctx.drawImage(hwCanvas, margin, margin, cw - 2*margin, ch - 2*margin);
      } catch (e) {}
      ctx.restore();
   };

   model.animate(() => {
      g2.update();
   });
};
