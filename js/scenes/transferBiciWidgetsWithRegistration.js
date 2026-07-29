// transferBiciWidgetsWithRegistration.js — Show a saved set of BICI widget cards
// in VR, registered onto the physical screen via ArUco calibration (the PC master
// runs the calibration popup; the headset reads the resulting pane pose).
// Self-contained: the card layout is embedded below, no save file.
//
// Cards map from their BICI `lo`/`hi` box: x ∈ [-1,1] across the width, y up,
// scaled by 1/aspect → paneX = bici.x, paneY = bici.y * (halfX/halfY). Pinch to
// grab a card and toss it off to float in the room. The robot card is a flat
// screenshot until grabbed, then becomes the live 3D IK robot from robotIK.js.
import { initScreenAnchor, getAnchorMatrix, getHalfExtents } from "../util/screenAnchor.js";
import * as cg from "../render/core/cg.js";

// Embedded card layout (BICI save "k1"): card_type + image + lo/hi per card.
// The 3 curve cards share a type but each has its own image. Override via
// window.BICI_CARDS.
const DEFAULT_CARDS = [
   { id:  3, card_type: 'editor',   img: 'boxcode.png',        lo: [-0.9569, -0.3456], hi: [ 0.0551,  0.5744] },
   { id:  4, card_type: 'webgl',    img: 'robot.png',          lo: [ 0.3051,  0.01  ], hi: [ 0.8876,  0.5924] },
   { id:  5, card_type: 'timeline', img: 'timeline.png',       lo: [-0.5684, -0.5515], hi: [ 0.0562, -0.4266] },
   { id:  7, card_type: 'curve',    img: 'curve editor 1.png', lo: [ 0.3224, -0.1803], hi: [ 0.8863, -0.0675] },
   { id:  8, card_type: 'curve',    img: 'curve editor 2.png', lo: [ 0.3198, -0.3507], hi: [ 0.8836, -0.2379] },
   { id: 10, card_type: 'curve',    img: 'curve editor 3.png', lo: [ 0.3251, -0.5531], hi: [ 0.8889, -0.4403] },
];

export const init = async model => {

   let isHeadset = navigator.userAgent.indexOf('OculusBrowser') >= 0;

   // Hide the framework's hand avatar ("ghost" hand) and controller cursors —
   // this is a hand-pinch tool, and they were rendering over the real hands.
   // Input (pinch / hand position) keeps working; only the visuals are hidden.
   window.suppress_vrWidgets = true;

   // Boot the screen-anchor util: opens the ArUco calibration popup on the PC
   // master and exposes the calibrated pane pose to the headset via tick().
   const anchor = initScreenAnchor(model);

   // Capture errors and show them in XR (via debugNode) and the console.
   let errorMsg = '';
   let debugNode = null;
   window.addEventListener('error', event => {
      errorMsg = (event.message || 'Unknown error') + '\n' +
                 (event.filename || '').split('/').pop() + ':' + (event.lineno || '?');
   });

   let source = (typeof window !== 'undefined' && window.BICI_CARDS) || DEFAULT_CARDS;
   let cards = source.filter(c => c && c.card_type && c.lo && c.hi);

   // One texture slot per card (the curves need distinct images).
   cards.forEach((c, i) => {
      c.slot = 1 + i;
      model.txtrSrc(c.slot, '../media/aura_video/' + c.img);
   });

   const CODE_BOX_OPACITY = 0.85;            // editor card transparency (1 = opaque)
   const CARD_TINT = [1.1, 1.1, 1.5];        // multiply tint on card faces (cools the warm lighting)

   const GRAB_R    = 0.16;  // reach within 16 cm and pinch to grab a card
   const DAMP      = 0.95;  // velocity kept per 1/60 s while flying (eases to rest)
   const THROW_GAIN= 0.3;   // release velocity multiplier (lower = cards fly less far)
   const MAX_SPD   = 2.5;   // cap throw speed (m/s)
   const MIN_SCALE = 0.25;  // two-handed scale clamp
   const MAX_SCALE = 8.0;

   const ROBOT_FILL    = 1.3;   // robot size: ~1 fills the card height
   const ROBOT_DX      = 0;     // robot x recenter (robot units)
   const ROBOT_DY      = -0.53; // robot y recenter (robot units; centers the arm)
   const ROBOT_OPACITY = 0.8;   // robot transparency, same as robotIK.js
   const FACE_SIGN     = -1;    // -1 flips card faces toward the viewer; set to 1 if they face away

   let floatLayer, items = [], lastTime = 0;
   let prevPinch = { left: false, right: false };

   // Keep `b`'s orientation, apply uniform scale `s`, park at world position `p`.
   let placeScaled = (b, p, s) => [ b[0]*s,b[1]*s,b[2]*s,0, b[4]*s,b[5]*s,b[6]*s,0,
                                    b[8]*s,b[9]*s,b[10]*s,0, p[0],p[1],p[2],1 ];

   if (isHeadset) {

      // Cards live in WORLD space so they can be pulled off the screen and float.
      // No visible pane/frame — the cards themselves show the layout.
      floatLayer = model.add();
      items = cards.map(c => ({
         card: c,
         node: floatLayer.add(),
         built: false,
         mode: 'docked',            // 'docked' | 'held' | 'flying'
         p: [0,0,0], v: [0,0,0],
         basis: null, grabHand: null, grabOffset: [0,0,0],
         wx: 0, wy: 0,              // card half-size in meters (set per frame)
         scale: 1, scaleHand: null, scaleD0: 0, scaleS0: 1,
         is3D: false,               // robot card: flat until first grab, then 3D
         animT: 0,                  // robot animation clock (advances only when released)
      }));

      debugNode = model.add();
   }

   // A textured quad filling the card box — the canonical scene-board recipe
   // (arrange.js): 'square' scaled to size, .dull() (unlit), tint, then .txtr().
   // The texture fills the quad, so each screenshot must match its card's aspect.
   let textureQuad = (it, slot) => {
      let q = it.node.add('square').scale(it.wx, it.wy, 1).dull().color(...CARD_TINT).txtr(slot);
      if (it.card.card_type === 'editor')
         q.opacity(CODE_BOX_OPACITY);
   };

   // A card's flat 2D face (its screenshot). The robot keeps this until grabbed.
   let buildCard = it => {
      textureQuad(it, it.card.slot);
      it.built = true;
   };

   // The 3D robot, once the robot card is grabbed. This is robotIK.js's arm:
   // IK-driven, semi-transparent, animated. Rebuilt into the card's container
   // every frame; the container handles grab/throw/scale placement.
   let buildRobot = it => {
      while (it.node.nChildren() > 0) it.node.remove(0);

      let L1 = .65, L2 = .8, t = it.animT;   // frozen while held → static; advances once released
      let W = [-.5 + .2*Math.cos(t), 1.1 + .2*Math.sin(t), .2*Math.sin(3*t)];
      let sgn = Math.sign(W[0]);
      let yaw = W[0] == 0 ? 0 : Math.atan2(W[2], sgn * W[0]);
      W = [sgn * Math.sqrt(W[0]*W[0] + W[2]*W[2]), W[1], 0];
      let E = cg.ik(L1, L2, W, [1,1,0]);

      // Fit into the card, recenter, undo the container's FACE_SIGN flip, and make
      // it transparent. opacity on the wrapper propagates to the whole arm.
      let S = ROBOT_FILL * it.wy;
      let r = it.node.add().opacity(ROBOT_OPACITY);
      r.identity().move(ROBOT_DX * S, ROBOT_DY * S, 0).turnY(yaw).scale(S, S, S * FACE_SIGN);

      r.add('tubeY').move(0,-.24,0).scale(.2,.1,.2);                                       // base
      r.add('tubeZ').scale(.14).color(0,.5,1);                                             // shoulder
      r.add('tubeZ').move(E).scale(.13).color(.5,.4,0);                                    // elbow
      r.add('sphere').move(W).scale(.12).color(1,0,0);                                     // wrist
      r.add('cube').move(cg.scale(E,.5)).aimZ(E).scale(.04,.04,L1/2).color(.5,.5,.5);      // upper arm
      r.add('cube').move(cg.mix(E,W,.5)).aimZ(cg.subtract(W,E)).scale(.04,.04,L2/2).color(.5,.5,.5); // lower arm
   };

   model.animate(() => {
      try {
         anchor.tick();                       // keep the calibrated pose in sync
         if (!isHeadset) return;

         while (debugNode.nChildren() > 0) debugNode.remove(0);
         if (errorMsg) {
            debugNode.add('square').move(0,2.1,-.3).scale(.55,.07,1).color(0,0,0).opacity(.85);
            debugNode.add(clay.text('ERR: ' + errorMsg)).move(-.5,2.14,-.29).color(1,.2,.2).scale(.035);
         }

         // Calibrated screen pose (unit axes) and physical half-extents.
         const A = getAnchorMatrix();
         if (!A) return;
         const ext = getHalfExtents();
         const halfX = ext.halfX, halfY = ext.halfY, aspect = halfX / halfY;

         // Unit-scaled world frame at the card's center on the pane. FACE_SIGN flips
         // Z so the card's front faces the viewer.
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
                  // Grab the nearest reachable card. Use getMatrix() — the card's
                  // ROOT-LOCAL matrix — not getGlobalMatrix() (world): inputEvents.pos()
                  // is also root-local, so the grab stays aligned after the world is
                  // re-oriented (the joystick gesture). worldCoords is applied to both
                  // the card and the hand at render time, so comparing in root-local is
                  // correct (and worldCoords-independent).
                  let best = null, bestD = GRAB_R;
                  for (let it of items) {
                     if (it.grabHand) continue;
                     let m = it.node.getMatrix();
                     let d = cg.distance([m[12],m[13],m[14]], hp);
                     if (d < bestD) { bestD = d; best = it; }
                  }
                  if (best) {
                     let m = best.node.getMatrix();   // root-local (see above)
                     best.basis = m.slice();
                     best.p = [m[12], m[13], m[14]];
                     best.grabOffset = cg.subtract(best.p, hp);
                     best.grabHand = hand;
                     best.mode = 'held';
                     best.is3D = true;          // robot card pops to 3D on first grab
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

            if (it.card.card_type === 'webgl' && it.is3D) {
               if (it.mode !== 'held') it.animT += dt;   // animate only once released onto the table
               buildRobot(it);
            } else if (!it.built)
               buildCard(it);
         }
      } catch (e) {
         errorMsg = e.message || String(e);
         console.error('transferBiciWidgetsWithRegistration.js animate error:', e);
      }
   });
}
