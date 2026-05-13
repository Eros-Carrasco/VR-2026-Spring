import { G2 } from "../util/g2.js";
import HanziWriter from "../util/hanzi-writer.esm.js";

// Minimal test scene: spins up HanziWriter on a hidden canvas and blits it
// onto a G2 panel using the same save/setTransform/restore pattern that
// MRandarin.js uses. If the stroke-order animation of 你 appears on the
// panel, the library + the blit pipeline both work.

export const init = async model => {

   // ── window.requestAnimationFrame shim para WebXR ──────────────────────
   // window.rAF queda pausado en sesiones XR inmersivas en Quest. Cualquier
   // librería que dependa de él (HanziWriter, etc.) se congela. Encolamos
   // sus callbacks y las drenamos desde model.animate, que sí tickea via
   // xrSession.requestAnimationFrame.
   const _rafQueue   = new Set();
   const _origRAF    = window.requestAnimationFrame.bind(window);
   const _origCAF    = window.cancelAnimationFrame.bind(window);
   const _origIds    = new Map();
   let   _rafCounter = 0;

   window.requestAnimationFrame = (cb) => {
      const id = ++_rafCounter;
      let fired = false;
      const wrapper = (t) => {
         if (fired) return;
         fired = true;
         _rafQueue.delete(entry);
         _origIds.delete(id);
         try { cb(t); } catch (e) { console.warn('[rAF shim] callback threw:', e); }
      };
      const entry = { id, wrapper };
      _rafQueue.add(entry);
      _origIds.set(id, _origRAF(wrapper));
      return id;
   };

   window.cancelAnimationFrame = (id) => {
      for (const e of _rafQueue) if (e.id === id) { _rafQueue.delete(e); break; }
      const origId = _origIds.get(id);
      if (origId !== undefined) { _origCAF(origId); _origIds.delete(id); }
   };

   let _draining = false;
   const drainRaf = () => {
      // En desktop/web mode, native window.rAF ya maneja todo (incluido el
      // WebXR polyfill, que lo usa como driver de frames). Drenar acá causa
      // recursión: drainRaf → polyfill onDeviceFrame → model.animate → drainRaf.
      // Solo drenamos cuando hay sesión XR real activa.
      if (typeof isXR !== 'function' || !isXR()) return;
      // Belt-and-suspenders: aunque el gate de isXR debería bastar, si por
      // alguna razón nos re-entran (drainRaf → cb → ... → drainRaf), cortamos.
      if (_draining) return;
      if (_rafQueue.size === 0) return;
      _draining = true;
      try {
         const t = performance.now();
         for (const entry of Array.from(_rafQueue)) entry.wrapper(t);
      } finally {
         _draining = false;
      }
   };

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
      drainRaf();
      g2.update();
   });
};
