// auraVideo.js — Load a saved BICI state and rebuild its "cards" inside VR.
//
// Each card is placed on the ArUco-calibrated screen pane at the exact position
// and size from its `lo`/`hi` bounding box. BICI normalises coords so x ∈ [-1,1]
// across the width (origin at center, y up, scaled by 1/aspect), which maps 1:1
// onto the pane's local frame:  paneX = bici.x ,  paneY = bici.y * (halfX/halfY)
//
// Card faces (see CARD_RENDER):
//   • editor / sliders → BICI screenshots textured on a quad (image mode, the
//                        default), or reconstructed from data with G2 (buildCardG2).
//   • webgl            → its screenshot in 2D, then the live 3D robot once grabbed
//                        (runs the editor's .cg code with the slider values — the
//                        same interpreter as robot.js).
//
// Cards start docked on the screen; pinch to grab and toss them off to float in
// the room. This only LOADS a saved state — no data flows back to BICI.
import { ControllerBeam } from "../render/core/controllerInput.js";
import { initScreenAnchor, getAnchorMatrix, getHalfExtents } from "../util/screenAnchor.js";
import * as cg from "../render/core/cg.js";
import { Matrix } from "../render/core/cg.js";
import { G2 } from "../util/g2.js";

// Which saved BICI file to reconstruct. Change this (or set window.AURA_FILE
// before the scene loads) to pick a different saved state, e.g. 'bici/saved/r1.json'.
const SAVED_FILE = (typeof window !== 'undefined' && window.AURA_FILE) || 'bici/saved/r2.json';

export const init = async model => {

   let isHeadset = navigator.userAgent.indexOf('OculusBrowser') >= 0;

   // Boot the screen-anchor util (opens the ArUco calibration popup on the PC
   // master, exposes the calibrated pane pose to the headset via tick()).
   const anchor = initScreenAnchor(model);

   // ERROR CAPTURE — surfaced in XR via debugNode and to the console.
   let errorMsg = '';
   let debugNode = null;
   window.addEventListener('error', event => {
      errorMsg = (event.message || 'Unknown error') + '\n' +
                 (event.filename || '').split('/').pop() + ':' + (event.lineno || '?');
   });

   // LOAD THE SAVED BICI STATE. Keep only real cards (the ones with a bounding
   // box); the bare-stroke entries at the top of the file are ignored.
   let cards = [], byId = {};
   try {
      let resp = await fetch(SAVED_FILE);
      let data = await resp.json();
      cards = data.filter(c => c && c.card_type && c.lo && c.hi);
      for (let c of cards) byId[c.id] = c;
   } catch (e) {
      errorMsg = 'load ' + SAVED_FILE + ': ' + (e.message || e);
   }

   // CARD ARTWORK. Two render modes for the editor/sliders 2D faces:
   //   'image' — crisp BICI screenshots (best in VR right now).
   //   'g2'    — live reconstruction from data (buildCardG2). Looks identical to
   //             BICI but rasterizes at canvas resolution, so it's low-res up
   //             close in VR. Kept for when our VR rendering pipeline improves.
   // The webgl card always uses its screenshot in 2D, then goes live 3D on grab.
   const CARD_RENDER = 'image';
   model.txtrSrc(1, '../media/aura_video/code box.png');  // editor  2D face
   model.txtrSrc(2, '../media/aura_video/sliders.png');   // sliders 2D face
   model.txtrSrc(3, '../media/aura_video/robot.png');     // webgl   2D face
   const CARD_TXTR = { editor: 1, sliders: 2, webgl: 3 };
   const ROBOT_TXTR = 3;
   let nextSlot = 10;                        // G2 canvas texture slots (g2 mode, one per card)

   const CODE_BOX_OPACITY = 0.85;            // editor card transparency (1 = opaque, 0 = invisible)

   // ---- GRAB / THROW state -------------------------------------------------
   let beams, pane, floatLayer, items = [], lastTime = 0;
   let prevPinch = { left: false, right: false };

   const GRAB_R    = 0.16;  // reach within 16 cm and pinch to grab a card
   const DAMP      = 0.95;  // velocity kept per 1/60 s while flying (eases to rest)
   const THROW_GAIN= 0.3;   // release velocity multiplier (lower = cards fly less far)
   const MAX_SPD   = 2.5;   // cap throw speed (m/s)
   const MIN_SCALE = 0.25;  // two-handed scale clamp
   const MAX_SCALE = 8.0;

   // ---- ROBOT (webgl card) tuning knobs ------------------------------------
   // The .cg robot is authored around its own origin; these fit it into the
   // card box. Tune in VR if the robot sits off-center or wrong size.
   const ROBOT_FILL = 0.8;   // fraction of card height the robot should fill
   const ROBOT_DX   = -0.4;  // x recentering (cancels the .4 in robot.cg), in robot units
   const ROBOT_DY   = -0.3;  // y recentering, in robot units
   const FACE_SIGN  = -1;    // -1 flips each card to face the viewer (anchor normal points
                             //    away from you); set to 1 if content already faces you

   // A 4x4 (column-major) transform: keep `b`'s orientation, apply uniform
   // scale `s`, park at world position `p`.
   let placeScaled = (b, p, s) => [ b[0]*s,b[1]*s,b[2]*s,0, b[4]*s,b[5]*s,b[6]*s,0,
                                    b[8]*s,b[9]*s,b[10]*s,0, p[0],p[1],p[2],1 ];

   // Convert "@N" references in BICI code into I[N] array lookups.
   let replaceAtSigns = src => {
      let dst = '';
      for (let i = 0; i < src.length; i++)
         if (src[i] == '@') dst += 'I[' + src[++i] + ']';
         else               dst += src[i];
      return dst;
   };

   // Globals the .cg robot code expects (same set robot.js installs).
   window.PI = Math.PI;
   window.ball = 'sphere'; window.cube = 'cube';
   window.tube = 'tubeZ'; window.tubeX = 'tubeX'; window.tubeY = 'tubeY';
   window.tubeZ = 'tubeZ'; window.tubey = 'tubeY';
   if (window.zsgn === undefined)
      window.zsgn = (typeof clients !== 'undefined' && clientID == clients[0]) ? 1 : -1;

   if (isHeadset) {

      beams = { left : new ControllerBeam(model, 'left' ),
                right: new ControllerBeam(model, 'right') };

      // The pane: 4 thin border squares outlining the physical screen. Parked
      // below the floor until calibration delivers an anchor matrix.
      pane = model.add();
      pane.add('square').move( 0, 1,0).scale(1,.005,1);
      pane.add('square').move( 0,-1,0).scale(1,.005,1);
      pane.add('square').move(-1, 0,0).scale(.003,1,1);
      pane.add('square').move( 1, 0,0).scale(.003,1,1);
      pane.setMatrix([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,-999,0,1]);

      // Cards live in WORLD space (not parented to the pane) so they can be
      // pulled off the screen and float freely. Each frame a docked card is
      // re-placed onto the screen; grabbed/flying cards follow physics.
      floatLayer = model.add();
      items = cards.map(c => ({
         card: c,
         node: floatLayer.add(),     // container; content built into it
         built: false,               // editor/sliders content built once
         mode: 'docked',             // 'docked' | 'held' | 'flying'
         p: [0,0,0], v: [0,0,0],
         basis: null, grabHand: null, grabOffset: [0,0,0],
         wx: 0, wy: 0,               // card half-size in meters (set per frame)
         robotFn: null,              // compiled .cg function, for webgl cards
         scale: 1,                   // two-handed scale factor (applied off-screen)
         scaleHand: null, scaleD0: 0, scaleS0: 1,
         is3D: false,                // webgl card: flat until first grab, then 3D
         g2: null,                   // G2 canvas for editor/sliders cards
      }));

      debugNode = model.add();
   }

   // A textured quad filling the card box (image-mode face + the robot's 2D face).
   // Exactly how the scene boards do it (arrange.js / arrange2.js): a 'square'
   // scaled to size, .dull() for an unlit/flat material, then .txtr(). The texture
   // fills the quad, so the screenshot must be cropped to the card's aspect ratio.
   // The editor (code box) gets a touch of transparency via CODE_BOX_OPACITY.
   let textureQuad = (it, slot) => {
      let q = it.node.add('square').scale(it.wx, it.wy, 1).dull().txtr(slot);
      if (it.card.card_type === 'editor')
         q.opacity(CODE_BOX_OPACITY);
   };

   // Build a card's docked / 2D face.
   //   • webgl          → its screenshot (then live 3D on first grab)
   //   • editor/sliders → screenshot ('image' mode) or G2 reconstruction ('g2')
   let buildCard = it => {
      let c = it.card;
      if (c.card_type === 'webgl' || CARD_RENDER === 'image')
         textureQuad(it, c.card_type === 'webgl' ? ROBOT_TXTR : CARD_TXTR[c.card_type]);
      else
         buildCardG2(it);
      it.built = true;
   };

   // G2 RECONSTRUCTION — preserved for a higher-res VR pipeline later. Reproduces
   // BICI's exact editor/sliders rendering: both BICI dictionary functions return
   // a display list of {fill|draw|text} items in card-local [-1,1]; we replay it
   // onto a G2 canvas with BICI's diagram math (font px = size·w/2, text justify),
   // then texture it onto the card.
   let buildCardG2 = it => {
      let c = it.card;
      let cardW = c.hi[0]-c.lo[0], cardH = Math.max(1e-3, c.hi[1]-c.lo[1]);
      let cw = 1024, ch = Math.max(64, Math.round(cw / (cardW/cardH)));
      let g = new G2(true, cw, ch);
      let ctx = g.getContext();

      let X   = x => (0.5 + 0.5*x) * cw;     // card-local [-1,1] → canvas px (y up)
      let Y   = y => (0.5 - 0.5*y) * ch;
      let s   = 0.1 * cardW;                 // BICI default text-size unit
      let pxF = v => v * cw / cardW;         // BICI screen-unit → this canvas px
      let round2 = t => { let q = ''+(100*Math.abs(t)>>0), n = q.length;
         return (t<0?'-':'') + q.substring(0,n-2) + (n<2?'.0':'.') + q.substring(n-2); };
      let rect = (x0,y0,x1,y1) => [[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]];

      // --- build the display list (ported 1:1 from BICI's dictionary.js) ---
      let S = [];
      if (c.card_type === 'sliders') {
         let st = c.state || {}, _O = st._O || [];
         let N = st.N ?? (_O.length || 2), flip = st.flip ?? 1, h = 2/N;
         for (let n = 0; n < N-1; n++) {
            let y = 1 - (n+flip)*h;
            S.push({fill: rect(-1,y,1,y-h), color:'#b0b0b0'});               // track
            let x = Math.max(-1, Math.min(1, _O[n] ?? 0));
            S.push({fill: rect(-1,y,x,y-h), color:'#e0e0e0'});               // value fill
            S.push({draw: rect(-1,y,1,y-h), lineWidth:.002});                // border
            S.push({text:'@'+n,            pos:[-.98,y],        justify:[0,1.75], scale:.9});
            S.push({text: round2(_O[n] ?? 0), pos:[-.05,y-1.15*h],            scale:.9});
         }
         let y = flip ? 1 : 1-(N-1)*h;
         S.push({fill: rect(-1,y,0,y-h), color:'#ffa0a0'});                  // del (red)
         S.push({fill: rect(0,y,1,y-h),  color:'#a0c0ff'});                  // add (blue)
         if (N > 2) S.push({text:'del', pos:[-.5,y-h-.23/N], scale:.9});
         S.push({text:'add', pos:[.5,y-h-.23/N], scale:.9});
         S.push({draw: rect(-1,y,0,y-h), lineWidth:.002});
         S.push({draw: rect(0,y,1,y-h),  lineWidth:.002});
      } else { // editor
         let st = c.state || {};
         let lines = st.lines || (st.text||'').split('\n');
         let nLines = lines.length || 1, h = 2/Math.max(1,nLines);
         ctx.fillStyle = '#ffffff80'; ctx.fillRect(0,0,cw,ch);              // bgColor
         ctx.strokeStyle = '#000000'; ctx.lineWidth = Math.max(1, pxF(.004));
         ctx.strokeRect(0,0,cw,ch);                                         // frame
         for (let row = 0; row < nLines; row++)
            S.push({text: lines[row], pos:[-1, 1-(row+.6)*h], justify:[0,1], size:.04, color:'#000000'});
      }

      // --- replay the display list with BICI's diagram primitives ---
      let cur = '#000000';
      for (let item of S) {
         if (item.draw) {
            ctx.strokeStyle = item.color ?? cur;
            ctx.lineWidth = Math.max(1, pxF(item.lineWidth ?? .1*s));
            ctx.beginPath();
            item.draw.forEach((p,k) => (k ? ctx.lineTo : ctx.moveTo).call(ctx, X(p[0]), Y(p[1])));
            ctx.stroke();
         } else if (item.fill) {
            ctx.fillStyle = item.color ?? cur;
            ctx.beginPath();
            item.fill.forEach((p,k) => (k ? ctx.lineTo : ctx.moveTo).call(ctx, X(p[0]), Y(p[1])));
            ctx.fill();
         } else if (item.text != null) {
            ctx.fillStyle = item.color ?? cur;
            let lh = pxF(item.size ?? (item.scale ?? 1)*s);
            ctx.font = lh + 'px Courier';
            let j = item.justify ?? [.5,.5];
            let ax = X(item.pos[0]), ay = Y(item.pos[1]);
            let L = (''+item.text).split('\n'), nL = L.length;
            for (let i = 0; i < nL; i++) {
               let dx = ctx.measureText(L[i]).width * j[0];
               ctx.fillText(L[i], ax - dx, ay + (i - nL*(1-j[1]) + .1411)*lh);
            }
         } else if (item.color) cur = item.color;
      }

      let slot = nextSlot++;
      model.txtrSrc(slot, g.getCanvas());
      it.node.add('square').scale(it.wx, it.wy, 1).dull().txtr(slot);
      it.g2 = g;
      it.built = true;
   };

   // Rebuild the 3D robot for a webgl card into its container, every frame.
   let buildRobot = it => {
      let c = it.card;
      // Resolve the code (editor card it points at) and the input values
      // (the sliders card that editor points at).
      let editor  = c.srcId  ? byId[c.srcId[0]]  : null;
      let sliders = editor && editor.srcId ? byId[editor.srcId[0]] : null;
      let code = editor && editor.state && editor.state.text;
      if (!code) return;

      window.I = ((sliders && sliders.state && sliders.state._O) || []).slice();
      for (let i = window.I.length; i < 10; i++) window.I[i] = 0;

      if (!it.robotFn) {
         try { it.robotFn = new Function(replaceAtSigns(code)); }
         catch (e) { errorMsg = 'robot compile: ' + (e.message || e); return; }
      }

      // Fresh interpreter each frame, drawing into this card's container.
      let rc = new Matrix();
      rc.draw = (shape, color, scale) => {
         // Facing is handled by the card container (FACE_SIGN); the robot draws
         // in a plain frame so we don't flip it twice.
         it.node.add(shape).setMatrix(rc.getValue())
                .scale(scale ?? 1).color(color);
         return rc;
      };
      rc.move = rc.translate; rc.pop = rc.restore; rc.push = rc.save;
      rc.turnX = rc.rotateX; rc.turnY = rc.rotateY; rc.turnZ = rc.rotateZ;
      window.cg = rc;

      while (it.node.nChildren() > 0) it.node.remove(0);

      // Fit the robot into the card box, then run the code. Only called once the
      // card has been grabbed (is3D), so it's always full-depth 3D.
      let S = (ROBOT_FILL * it.wy);   // meters per robot-unit (robot ≈ 2 units tall)
      rc.identity().move(ROBOT_DX * S, ROBOT_DY * S, 0).scale(S, S, S);
      try { it.robotFn(); }
      catch (e) { errorMsg = 'robot run: ' + (e.message || e); }
   };

   model.animate(() => {
      try {
         anchor.tick();
         if (!isHeadset) return;

         // ERROR readout in XR.
         while (debugNode.nChildren() > 0) debugNode.remove(0);
         if (errorMsg) {
            debugNode.add('square').move(0,2.1,-.3).scale(.55,.07,1).color(0,0,0).opacity(.85);
            debugNode.add(clay.text('ERR: ' + errorMsg)).move(-.5,2.14,-.29).color(1,.2,.2).scale(.035);
         }

         const A = getAnchorMatrix();   // unit-axis pose of the screen (world)
         if (!A) return;
         const ext = getHalfExtents();
         const halfX = ext.halfX, halfY = ext.halfY, aspect = halfX / halfY;

         // Show the calibrated screen rectangle (same composition as before).
         pane.setMatrix([
            A[0]*halfX, A[1]*halfX, A[2]*halfX, 0,
            A[4]*halfY, A[5]*halfY, A[6]*halfY, 0,
            A[8],       A[9],       A[10],      0,
            A[12],      A[13],      A[14],      1,
         ]);

         // Per-card docked frame: a UNIT-scaled frame (no screen stretch) at
         // the card's center on the screen, so reconstructed content keeps
         // correct proportions. Also refresh each card's half-size in meters.
         let dockMatrix = it => {
            let c = it.card;
            let px = (c.lo[0] + c.hi[0]) / 2;                 // pane-local x  [-1,1]
            let py = (c.lo[1] + c.hi[1]) / 2 * aspect;        // pane-local y  [-1,1]
            it.wx = (c.hi[0] - c.lo[0]) / 2 * halfX;          // half-width  (m)
            it.wy = (c.hi[1] - c.lo[1]) / 2 * halfX;          // half-height (m)  (1 bici unit = halfX m)
            let ox = px * halfX, oy = py * halfY;             // center offset on screen (m)
            // X,Y axes keep the screen layout; Z is flipped by FACE_SIGN so the
            // card's front (text / robot) faces the viewer instead of away.
            return [ A[0],A[1],A[2],0,
                     A[4],A[5],A[6],0,
                     A[8]*FACE_SIGN, A[9]*FACE_SIGN, A[10]*FACE_SIGN, 0,
                     A[12] + A[0]*ox + A[4]*oy,
                     A[13] + A[1]*ox + A[5]*oy,
                     A[14] + A[2]*ox + A[6]*oy, 1 ];
         };

         let dt = Math.min(0.05, Math.max(0, model.time - lastTime));
         lastTime = model.time;

         // --- GRAB / THROW / TWO-HANDED SCALE input ---
         let held   = { left: null, right: null };   // item each hand is dragging
         let scaler = { left: null, right: null };   // item each hand is scaling
         for (let it of items) {
            if (it.grabHand)  held[it.grabHand]   = it;
            if (it.scaleHand) scaler[it.scaleHand] = it;
         }

         for (let hand in held) {
            let other = hand === 'left' ? 'right' : 'left';
            let pinching = inputEvents.isPressed(hand);
            let hp = inputEvents.pos(hand);

            // RISING EDGE
            if (pinching && !prevPinch[hand] && hp) {
               if (held[other] && !held[hand] && held[other].card.card_type === 'webgl') {
                  // Second hand pinches while the other holds the ROBOT → scale
                  // it relative to the hand distance right now (factor starts at
                  // 1, so no jump). Only the robot is scalable.
                  let it = held[other];
                  let op = inputEvents.pos(other);
                  it.scaleHand = hand;
                  it.scaleS0   = it.scale;
                  it.scaleD0   = Math.max(0.02, cg.distance(hp, op || hp));
                  scaler[hand] = it;
               } else if (!held[hand]) {
                  // Otherwise grab the nearest reachable card.
                  let best = null, bestD = GRAB_R;
                  for (let it of items) {
                     if (it.grabHand) continue;
                     let m = it.node.getGlobalMatrix();
                     let d = cg.distance([m[12],m[13],m[14]], hp);
                     if (d < bestD) { bestD = d; best = it; }
                  }
                  if (best) {
                     let m = best.node.getGlobalMatrix();
                     best.basis = m.slice();
                     best.p = [m[12], m[13], m[14]];
                     best.grabOffset = cg.subtract(best.p, hp);
                     best.grabHand = hand;
                     best.mode = 'held';
                     best.is3D = true;          // webgl card pops to 3D on first grab
                     held[hand] = best;
                  }
               }
            }

            // FALLING EDGE
            if (!pinching && prevPinch[hand]) {
               if (scaler[hand]) {             // stop scaling, keep the new size
                  scaler[hand].scaleHand = null;
                  scaler[hand] = null;
               } else if (held[hand]) {        // release
                  let it = held[hand];
                  it.grabHand = null;
                  it.mode = 'flying';
                  // Robot stays exactly where you drop it; cards keep a reduced
                  // throw so they drift a little and settle (not fly off).
                  it.v = it.card.card_type === 'webgl' ? [0,0,0]
                                                       : cg.scale(it.v, THROW_GAIN);
                  held[hand] = null;
               }
            }
            prevPinch[hand] = pinching;
         }

         // Update size for any item being scaled by a second hand.
         for (let it of items) {
            if (it.scaleHand && it.grabHand) {
               let pa = inputEvents.pos(it.grabHand);
               let pb = inputEvents.pos(it.scaleHand);
               if (pa && pb) {
                  let f = cg.distance(pa, pb) / it.scaleD0;
                  it.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, it.scaleS0 * f));
               }
            }
         }

         // --- Place + render every card ---
         for (let it of items) {
            // 1) Position the container.
            if (it.mode === 'docked') {
               it.node.setMatrix(dockMatrix(it));
            } else {
               // keep wx/wy fresh even while off-screen
               let c = it.card;
               it.wx = (c.hi[0]-c.lo[0])/2 * halfX;
               it.wy = (c.hi[1]-c.lo[1])/2 * halfX;
               if (it.mode === 'held') {
                  let hp = inputEvents.pos(it.grabHand);
                  if (hp) {
                     let np = cg.add(hp, it.grabOffset);
                     if (dt > 0) it.v = cg.mix(it.v, cg.scale(cg.subtract(np, it.p), 1/dt), 0.6);
                     it.p = np;
                  }
               } else { // flying
                  let spd = cg.norm(it.v);
                  if (spd > MAX_SPD) it.v = cg.scale(it.v, MAX_SPD / spd);
                  it.p = cg.add(it.p, cg.scale(it.v, dt));
                  it.v = cg.scale(it.v, Math.pow(DAMP, dt * 60));
               }
               it.node.setMatrix(placeScaled(it.basis, it.p, it.scale));
            }

            // 2) Render content. The robot becomes live 3D once grabbed;
            // everything else (and the robot's 2D state) is its screenshot.
            if (it.card.card_type === 'webgl' && it.is3D) {
               buildRobot(it);                 // live 3D robot, rebuilt every frame
            } else if (!it.built) {
               buildCard(it);                  // editor/sliders (G2) or robot 2D, built once
            }
         }
      } catch (e) {
         errorMsg = e.message || String(e);
         console.error('auraVideo.js animate error:', e);
      }
   });
}
