// transferBiciWidgets.js — Show a saved set of BICI widget cards in VR on a
// fixed virtual screen. Self-contained: the card layout is embedded (DEFAULT_CARDS)
// and the pane pose is hardcoded, so no calibration and no save file are needed.
//
// Cards map onto the pane from their BICI `lo`/`hi` box: x ∈ [-1,1] across the
// width, y up, scaled by 1/aspect → paneX = bici.x, paneY = bici.y * (halfX/halfY).
// Pinch to grab a card and toss it off to float in the room. The webgl card shows
// a 2D screenshot until grabbed, then becomes the live 3D robot.
import { ControllerBeam } from "../render/core/controllerInput.js";
import * as cg from "../render/core/cg.js";
import { Matrix } from "../render/core/cg.js";
import { G2 } from "../util/g2.js";

// Embedded card layout (exported from a BICI saved state). Only the fields the
// scene needs: card_type + lo/hi per card, plus the editor's .cg code and the
// sliders' output values so the 3D robot can be rebuilt. Override via window.BICI_CARDS.
const DEFAULT_CARDS = [
   { id: 3, card_type: 'webgl',
     lo: [ 0.578935, -0.055672 ], hi: [ 1.023906, 0.389299 ] },
   { id: 4, card_type: 'editor',
     lo: [ -0.437831, -0.55306 ], hi: [ 0.597555, 0.60694 ],
     state: { text: "cg.move(.4,-.83,0)\n  .push()\n     .draw(tubeY,[1,1,1],[.2,.1,.2])\n  .pop()\n  .move(0,.24,0).turnY(@0)\n  .push()\n     .draw(tube,[0,.5,1],.14)\n  .pop()\n  .turnZ(@1)\n  .push()\n     .move(0,.33,0)\n     .draw(cube,[.5,.5,.5],[.04,.2,.04])\n  .pop()\n  .push()\n     .move(0,.65,0).turnZ(@2+1.5)\n     .push()\n        .draw(tube,[.5,.4,0],.13)\n     .pop()\n     .push()\n        .move(0,.41,0)\n        .draw(cube,[.5,.5,.5],[.04,.3,.04])\n     .pop()\n     .push()\n        .move(0,.8,0)\n        .draw(ball,[1,0,0],.12)\n     .pop()\n  .pop()\n;\n" } },
   { id: 7, card_type: 'sliders',
     lo: [ -0.879733, 0.395489 ], hi: [ -0.603287, 0.478423 ],
     state: { _O: [ 1.021795, 0.151463 ] } },
   { id: 8, card_type: 'curve',
     lo: [ -0.949373, 0.051865 ], hi: [ -0.532652, 0.135209 ] },
   { id: 11, card_type: 'timeline',
     lo: [ -0.92454, -0.31661 ], hi: [ -0.525396, -0.236781 ] },
];

export const init = async model => {

   let isHeadset = navigator.userAgent.indexOf('OculusBrowser') >= 0;

   // Capture errors and show them in XR (via debugNode) and the console.
   let errorMsg = '';
   let debugNode = null;
   window.addEventListener('error', event => {
      errorMsg = (event.message || 'Unknown error') + '\n' +
                 (event.filename || '').split('/').pop() + ':' + (event.lineno || '?');
   });

   let source = (typeof window !== 'undefined' && window.BICI_CARDS) || DEFAULT_CARDS;
   let cards = source.filter(c => c && c.card_type && c.lo && c.hi);
   let byId = {};
   for (let c of cards) byId[c.id] = c;

   // Fixed pane pose (no calibration). Physical screen size — same monitor for the
   // whole team — and a transfer.js-style tilt. `A` is the unit-axis pose matrix.
   const HALF_X = 0.305 / 2, HALF_Y = 0.195 / 2;     // screen half-size (m)
   const PANE_TILT   = -0.30;                        // tilt back (radians)
   const PANE_CENTER = [0, 0.91, 0.03];              // pane center in the room (tune to taste)
   const A = cg.mMultiply(cg.mTranslate(PANE_CENTER[0], PANE_CENTER[1], PANE_CENTER[2]),
                          cg.mRotateX(PANE_TILT));
   const halfX = HALF_X, halfY = HALF_Y, aspect = halfX / halfY;

   // Card 2D faces: 'image' = crisp BICI screenshots; 'g2' = data reconstruction
   // (buildCardG2, lower-res up close — kept for a future higher-res VR pipeline).
   const CARD_RENDER = 'image';
   model.txtrSrc(1, '../media/aura_video/codebox.png');     // editor
   model.txtrSrc(2, '../media/aura_video/sliders.png');     // sliders
   model.txtrSrc(3, '../media/aura_video/robot.png');       // webgl
   model.txtrSrc(4, '../media/aura_video/curveEditor.png'); // curve
   model.txtrSrc(5, '../media/aura_video/timeline.png');    // timeline
   const CARD_TXTR = { editor: 1, sliders: 2, webgl: 3, curve: 4, timeline: 5 };
   const ROBOT_TXTR = 3;
   let nextSlot = 10;                        // texture slots for g2 mode (one per card)

   const CODE_BOX_OPACITY = 0.85;            // editor transparency (1 = opaque)
   //const CARD_TINT = [.7, .7, 1.1];            // multiply tint on card faces (cools the warm lighting)
   const CARD_TINT = [1.1, 1.1, 1.5];            // multiply tint on card faces (cools the warm lighting)

   const GRAB_R    = 0.16;  // reach within 16 cm and pinch to grab a card
   const DAMP      = 0.95;  // velocity kept per 1/60 s while flying (eases to rest)
   const THROW_GAIN= 0.3;   // release velocity multiplier (lower = cards fly less far)
   const MAX_SPD   = 2.5;   // cap throw speed (m/s)
   const MIN_SCALE = 0.25;  // two-handed scale clamp
   const MAX_SCALE = 8.0;

   const ROBOT_FILL = 0.8;   // fraction of card height the robot fills
   const ROBOT_DX   = -0.4;  // robot x recentering (cancels the .4 in robot.cg)
   const ROBOT_DY   = -0.3;  // robot y recentering
   const FACE_SIGN  = -1;    // -1 flips card faces toward the viewer; set to 1 if they face away

   let beams, pane, floatLayer, items = [], lastTime = 0;
   let prevPinch = { left: false, right: false };

   // Keep `b`'s orientation, apply uniform scale `s`, park at world position `p`.
   let placeScaled = (b, p, s) => [ b[0]*s,b[1]*s,b[2]*s,0, b[4]*s,b[5]*s,b[6]*s,0,
                                    b[8]*s,b[9]*s,b[10]*s,0, p[0],p[1],p[2],1 ];

   // Unit-scaled world frame at the card's center on the pane (so content keeps its
   // proportions). Refreshes the card's half-size in meters. FACE_SIGN flips Z so
   // the card's front faces the viewer.
   let dockMatrix = it => {
      let c = it.card;
      let px = (c.lo[0] + c.hi[0]) / 2;
      let py = (c.lo[1] + c.hi[1]) / 2 * aspect;
      it.wx = (c.hi[0] - c.lo[0]) / 2 * halfX;          // 1 bici unit = halfX meters
      it.wy = (c.hi[1] - c.lo[1]) / 2 * halfX;
      let ox = px * halfX, oy = py * halfY;
      return [ A[0],A[1],A[2],0,
               A[4],A[5],A[6],0,
               A[8]*FACE_SIGN, A[9]*FACE_SIGN, A[10]*FACE_SIGN, 0,
               A[12] + A[0]*ox + A[4]*oy,
               A[13] + A[1]*ox + A[5]*oy,
               A[14] + A[2]*ox + A[6]*oy, 1 ];
   };

   // Turn "@N" references in BICI code into I[N] lookups.
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

      // Pane: 4 thin border squares at the fixed pose (A never changes, so set once).
      pane = model.add();
      pane.add('square').move( 0, 1,0).scale(1,.005,1);
      pane.add('square').move( 0,-1,0).scale(1,.005,1);
      pane.add('square').move(-1, 0,0).scale(.003,1,1);
      pane.add('square').move( 1, 0,0).scale(.003,1,1);
      pane.setMatrix([
         A[0]*halfX, A[1]*halfX, A[2]*halfX, 0,
         A[4]*halfY, A[5]*halfY, A[6]*halfY, 0,
         A[8],       A[9],       A[10],      0,
         A[12],      A[13],      A[14],      1,
      ]);

      // Cards live in WORLD space (not parented to the pane) so they can be pulled
      // off the screen and float. Each carries its own grab/throw/scale state.
      floatLayer = model.add();
      items = cards.map(c => ({
         card: c,
         node: floatLayer.add(),
         built: false,
         mode: 'docked',            // 'docked' | 'held' | 'flying'
         p: [0,0,0], v: [0,0,0],
         basis: null, grabHand: null, grabOffset: [0,0,0],
         wx: 0, wy: 0,              // card half-size in meters (set per frame)
         robotFn: null,             // compiled .cg function (webgl card)
         scale: 1, scaleHand: null, scaleD0: 0, scaleS0: 1,
         is3D: false,               // webgl card: flat until first grab, then 3D
         g2: null,
      }));

      debugNode = model.add();
   }

   // A textured quad filling the card box — the canonical scene-board recipe
   // (arrange.js): 'square' scaled to size, .dull() (unlit), tint, then .txtr().
   // The texture fills the quad, so a screenshot must match its card's aspect.
   let textureQuad = (it, slot) => {
      let q = it.node.add('square').scale(it.wx, it.wy, 1).dull().color(...CARD_TINT).txtr(slot);
      if (it.card.card_type === 'editor')
         q.opacity(CODE_BOX_OPACITY);
   };

   // Build a card's 2D face: webgl → screenshot (then 3D on grab); editor/sliders →
   // screenshot ('image') or G2 reconstruction ('g2').
   let buildCard = it => {
      let c = it.card;
      if (c.card_type === 'webgl' || CARD_RENDER === 'image')
         textureQuad(it, c.card_type === 'webgl' ? ROBOT_TXTR : CARD_TXTR[c.card_type]);
      else
         buildCardG2(it);
      it.built = true;
   };

   // Reconstruct editor/sliders from data, pixel-faithful to BICI: BICI's dictionary
   // functions return a display list of {fill|draw|text} items in card-local [-1,1];
   // we replay it onto a G2 canvas with BICI's diagram math, then texture it.
   let buildCardG2 = it => {
      let c = it.card;
      let cardW = c.hi[0]-c.lo[0], cardH = Math.max(1e-3, c.hi[1]-c.lo[1]);
      let cw = 1024, ch = Math.max(64, Math.round(cw / (cardW/cardH)));
      let g = new G2(true, cw, ch);
      let ctx = g.getContext();

      let X   = x => (0.5 + 0.5*x) * cw;     // card-local [-1,1] → canvas px (y up)
      let Y   = y => (0.5 - 0.5*y) * ch;
      let s   = 0.1 * cardW;                 // BICI default text-size unit
      let pxF = v => v * cw / cardW;         // BICI screen-unit → canvas px
      let round2 = t => { let q = ''+(100*Math.abs(t)>>0), n = q.length;
         return (t<0?'-':'') + q.substring(0,n-2) + (n<2?'.0':'.') + q.substring(n-2); };
      let rect = (x0,y0,x1,y1) => [[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]];

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
         S.push({fill: rect(-1,y,0,y-h), color:'#ffa0a0'});                  // del
         S.push({fill: rect(0,y,1,y-h),  color:'#a0c0ff'});                  // add
         if (N > 2) S.push({text:'del', pos:[-.5,y-h-.23/N], scale:.9});
         S.push({text:'add', pos:[.5,y-h-.23/N], scale:.9});
         S.push({draw: rect(-1,y,0,y-h), lineWidth:.002});
         S.push({draw: rect(0,y,1,y-h),  lineWidth:.002});
      } else { // editor
         let st = c.state || {};
         let lines = st.lines || (st.text||'').split('\n');
         let nLines = lines.length || 1, h = 2/Math.max(1,nLines);
         ctx.fillStyle = '#ffffff80'; ctx.fillRect(0,0,cw,ch);
         ctx.strokeStyle = '#000000'; ctx.lineWidth = Math.max(1, pxF(.004));
         ctx.strokeRect(0,0,cw,ch);
         for (let row = 0; row < nLines; row++)
            S.push({text: lines[row], pos:[-1, 1-(row+.6)*h], justify:[0,1], size:.04, color:'#000000'});
      }

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
      it.node.add('square').scale(it.wx, it.wy, 1).dull().color(...CARD_TINT).txtr(slot);
      it.g2 = g;
      it.built = true;
   };

   // Rebuild the 3D robot into its container every frame (webgl card, once grabbed).
   let buildRobot = it => {
      let c = it.card;
      // Code + input values: prefer srcId links, else fall back to the editor/sliders by type.
      let editor  = (c.srcId && byId[c.srcId[0]]) || cards.find(k => k.card_type === 'editor');
      let sliders = (editor && editor.srcId && byId[editor.srcId[0]]) || cards.find(k => k.card_type === 'sliders');
      let code = editor && editor.state && editor.state.text;
      if (!code) return;

      window.I = ((sliders && sliders.state && sliders.state._O) || []).slice();
      for (let i = window.I.length; i < 10; i++) window.I[i] = 0;

      if (!it.robotFn) {
         try { it.robotFn = new Function(replaceAtSigns(code)); }
         catch (e) { errorMsg = 'robot compile: ' + (e.message || e); return; }
      }

      let rc = new Matrix();
      rc.draw = (shape, color, scale) => {   // facing handled by the container, not here
         it.node.add(shape).setMatrix(rc.getValue()).scale(scale ?? 1).color(color);
         return rc;
      };
      rc.move = rc.translate; rc.pop = rc.restore; rc.push = rc.save;
      rc.turnX = rc.rotateX; rc.turnY = rc.rotateY; rc.turnZ = rc.rotateZ;
      window.cg = rc;

      while (it.node.nChildren() > 0) it.node.remove(0);

      let S = (ROBOT_FILL * it.wy);   // meters per robot-unit
      rc.identity().move(ROBOT_DX * S, ROBOT_DY * S, 0).scale(S, S, S);
      try { it.robotFn(); }
      catch (e) { errorMsg = 'robot run: ' + (e.message || e); }
   };

   model.animate(() => {
      try {
         if (!isHeadset) return;

         while (debugNode.nChildren() > 0) debugNode.remove(0);
         if (errorMsg) {
            debugNode.add('square').move(0,2.1,-.3).scale(.55,.07,1).color(0,0,0).opacity(.85);
            debugNode.add(clay.text('ERR: ' + errorMsg)).move(-.5,2.14,-.29).color(1,.2,.2).scale(.035);
         }

         let dt = Math.min(0.05, Math.max(0, model.time - lastTime));
         lastTime = model.time;

         // Which item each hand is dragging / scaling.
         let held   = { left: null, right: null };
         let scaler = { left: null, right: null };
         for (let it of items) {
            if (it.grabHand)  held[it.grabHand]   = it;
            if (it.scaleHand) scaler[it.scaleHand] = it;
         }

         for (let hand in held) {
            let other = hand === 'left' ? 'right' : 'left';
            let pinching = inputEvents.isPressed(hand);
            let hp = inputEvents.pos(hand);

            if (pinching && !prevPinch[hand] && hp) {
               if (held[other] && !held[hand] && held[other].card.card_type === 'webgl') {
                  // Second hand pinches while the other holds the robot → scale it by
                  // the current hand distance (factor starts at 1, so no jump). Robot only.
                  let it = held[other];
                  let op = inputEvents.pos(other);
                  it.scaleHand = hand;
                  it.scaleS0   = it.scale;
                  it.scaleD0   = Math.max(0.02, cg.distance(hp, op || hp));
                  scaler[hand] = it;
               } else if (!held[hand]) {
                  // Grab the nearest reachable card.
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

            if (!pinching && prevPinch[hand]) {
               if (scaler[hand]) {              // stop scaling, keep the size
                  scaler[hand].scaleHand = null;
                  scaler[hand] = null;
               } else if (held[hand]) {         // release: robot stays put, cards drift then settle
                  let it = held[hand];
                  it.grabHand = null;
                  it.mode = 'flying';
                  it.v = it.card.card_type === 'webgl' ? [0,0,0] : cg.scale(it.v, THROW_GAIN);
                  held[hand] = null;
               }
            }
            prevPinch[hand] = pinching;
         }

         // Apply two-handed scale.
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

         // Place + render every card.
         for (let it of items) {
            if (it.mode === 'docked') {
               it.node.setMatrix(dockMatrix(it));
            } else {
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

            if (it.card.card_type === 'webgl' && it.is3D)
               buildRobot(it);
            else if (!it.built)
               buildCard(it);
         }
      } catch (e) {
         errorMsg = e.message || String(e);
         console.error('transferBiciWidgets.js animate error:', e);
      }
   });
}
