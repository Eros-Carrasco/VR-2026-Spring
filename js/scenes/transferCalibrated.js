import { ControllerBeam } from "../render/core/controllerInput.js";
import { initScreenAnchor, getAnchorMatrix, getHalfExtents } from "../util/screenAnchor.js";

// Shared input state with the calibration popup-popup. Both windows are PCs,
// but only the master writes; the headset reads via server.synchronize.
window.P = { left : { x:1, y:-1 }, right: { x:1, y:-1 } };
window.S = [];

export const init = async model => {

   let isHeadset = navigator.userAgent.indexOf('OculusBrowser') >= 0;
   let w = screen.width, h = screen.height - 80;
   let beams, pane, shapes, inputs, states, selectedRegion = null;
   let colors = '#ff0000,#ff8000,#ffff00,#30d030,#0080ff,#a000ff,#e800a0,#c0c0c0'.split(',');
   let rgb = [[1,0,0],[1,.3,0],[1,1,0],[.2,.8,.1],[0,.4,1],[.3,0,1],[.9,0,.8],[.7,.7,.7]];

   // Boot the screen-anchor util. On the PC master this opens the
   // calibration popup, builds the control panel, and starts polling the
   // backend. The returned object exposes tick(), which MUST be called at
   // the top of model.animate so anchorState stays in sync between PC and
   // headset (window.requestAnimationFrame is paused in immersive WebXR,
   // so we piggyback on model.animate's XR-driven frame loop instead).
   const anchor = initScreenAnchor(model);

   // ERROR CAPTURE — visible in XR via debugNode, and logged to console
   let errorMsg = '';
   let debugNode = null;
   window.addEventListener('error', event => {
      errorMsg = (event.message || 'Unknown error') + '\n' +
                 (event.filename || '').split('/').pop() + ':' + (event.lineno || '?');
   });

   if (isHeadset) {

      // VR CLIENT SETS UP THE CONTROLLER BEAMS AND THE TARGET WINDOW PANE.
      //
      // Unlike transfer.js, we DO NOT hardcode the pane's pose with chained
      // .move().turnX().scale() calls. The pane is created as a transform
      // node with the 4 border squares as children, then parked far below
      // the floor (y = -999) until calibration produces an anchor matrix.
      // Each frame thereafter we setMatrix() it to the calibrated pose.
      beams = { left : new ControllerBeam(model, 'left' ),
                right: new ControllerBeam(model, 'right') };

      pane = model.add();
      pane.add('square').move( 0, 1,0).scale(1,.005,1);
      pane.add('square').move( 0,-1,0).scale(1,.005,1);
      pane.add('square').move(-1, 0,0).scale(.003,1,1);
      pane.add('square').move( 1, 0,0).scale(.003,1,1);
      // Park out of sight until we have a calibration matrix to apply.
      pane.setMatrix([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,-999,0,1]);

      shapes    = pane.add();
      debugNode = model.add();
   }
   else {

      // 2D CLIENT (PC master) DEFINES THE SHAPES AND COLOR PALETTE.
      // The calibration popup is owned by screenAnchor.js; the content
      // popup below is only opened AFTER calibration completes, since
      // before that there's no useful pane to interact with.

      if (S.length == 0)
         S.push({ type:0, x:w/8, y:h/3  , c: 7 },
                { type:1, x:w/8, y:2*h/3, c: 7 });

      inputs = { left: {}, right: {}, mouse: {} };
      states = { left: {}, right: {}, mouse: {} };

      // The content popup is created LAZILY by the animate loop, once
      // calibration has completed. See the `setupPopup` definition and
      // the gating check inside the 2D branch of the animate body.
   }

   // The content popup (popup B) is built on demand by this helper. It's
   // identical to transfer.js's setupPopup logic — only the trigger has
   // changed: in transfer.js it ran unconditionally during init(); here it
   // runs once anchorState.calibrated is true.
   let setupContentPopup = () => {
      window.popup = window.open('', 'CanvasWindow', 'width=' + w + ',height=' + h);
      if (!window.popup) {
         errorMsg = 'Popup blocked by browser — allow popups and reload.';
         return;
      }

      let canvas = popup.document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;

      canvas.addEventListener('mousedown', event => inputs.mouse = { pressed: true , x: event.x, y: event.y });
      canvas.addEventListener('mouseup'  , event => inputs.mouse = { pressed: false, x: event.x, y: event.y });
      canvas.addEventListener('mousemove', event => { inputs.mouse.x = event.x ; inputs.mouse.y = event.y ; });

      popup.document.body.style.margin = '0';
      popup.document.body.appendChild(canvas);
      popup.canvas = canvas;
      popup.ctx = canvas.getContext('2d');
   };

   model.animate(() => {
      try {
         // Sync anchorState first — must run on every client every frame so
         // the headset sees the corners broadcast from the master and runs
         // its solve. Same pattern as the P/S syncs below; same pattern
         // MRandarin.js uses for mandarinState at the top of its animate.
         anchor.tick();

         let cr = h / 32;
         let cx = () => w - h/9;
         let cy = n => (n+.75) * h/9;

         P = server.synchronize('P') || P;
         S = server.synchronize('S') || S;

         if (isHeadset) {

            // VR CLIENT: DISPLAY ANY CAPTURED ERROR AS 3D TEXT

            while (debugNode.nChildren() > 0)
               debugNode.remove(0);

            if (errorMsg) {
               debugNode.add('square').move(0,2.1,-.3).scale(.55,.07,1).color(0,0,0).opacity(.85);
               debugNode.add(clay.text('ERR: ' + errorMsg)).move(-.5,2.14,-.29).color(1,.2,.2).scale(.035);
            }

            // Apply the calibrated anchor matrix to the pane. The pose is
            // recovered once by screenAnchor.js (in WORLD space) and stays
            // fixed thereafter — moving your head no longer moves the pane.
            //
            // The setMatrix composition multiplies the anchor matrix's X
            // and Y basis vectors by the rectangle's half-extents, leaving
            // Z and translation untouched. This is the same pattern used by
            // MRandarin's placePanelAt: it produces a non-uniformly-scaled
            // rectangle aligned with the screen plane.
            const M = getAnchorMatrix();
            if (M) {
               const ext = getHalfExtents();
               const hX  = ext.halfX;
               const hY  = ext.halfY;
               pane.setMatrix([
                  M[0]*hX, M[1]*hX, M[2]*hX, 0,
                  M[4]*hY, M[5]*hY, M[6]*hY, 0,
                  M[8],    M[9],    M[10],   0,
                  M[12],   M[13],   M[14],   1,
               ]);
            }

            // VR CLIENT SENDS CONTROLLER STATE DATA TO THE 2D CLIENT.
            // We only do this once we have a pane to point at — before
            // calibration, beam.hitRect would be testing against the
            // hidden far-below pane and reporting nonsense.

            if (M) {
               for (let hand in beams) {
                  beams[hand].update();
                  let hit = beams[hand].hitRect(pane.getGlobalMatrix(), true);
                  if (hit)
                     P[hand] = { x:hit[0], y:hit[1], pressed:inputEvents.isPressed(hand) };
               }
               server.broadcastGlobal('P');
            }

            // Shapes dragged outside the screen rectangle appear as 3D objects
            // in the room at the corresponding world position. Shapes inside
            // [-1, +1] in both axes are on-screen and handled by the 2D canvas.

            while (shapes.nChildren() > 0)
               shapes.remove(0);

            // Shapes are children of pane, so coords are pane-local:
            // x,y ∈ [-1, +1] map to the screen's physical edges (halfX/halfY
            // are already baked into pane's matrix rows). Z is unscaled so
            // 0.15 = 15 cm in front of the screen surface.
            if (M) {
               const ext = getHalfExtents();
               // Pane's matrix has non-uniform scale: X column × halfX, Y column × halfY,
               // Z column unscaled. A uniform .scale(s) would inherit that stretch.
               // Dividing each axis by the parent's scale gives a uniform sphere/cube
               // of radius r in world space.
               const r  = 0.08;
               const sx = r / ext.halfX;
               const sy = r / ext.halfY;
               for (let n = 0 ; n < S.length ; n++) {
                  let s = S[n];
                  let x =  (s.x - w/2) / (w/2);
                  let y = -(s.y - h/2) / (h/2);
                  if (x < -1 || x > 1 || y < -1 || y > 1)
                     shapes.add(s.type == 0 ? 'cube' : 'sphere')
                           .move(x, y, 0.15)
                           .scale(sx, sy, r)
                           .color(rgb[s.c]);
               }
            }
         }
         else {

            // 2D CLIENT: don't open the content popup until calibration is
            // complete. Trying to open it earlier would either compete with
            // the calibration popup (browsers limit concurrent popups) or
            // confuse the user about which window to interact with.
            if (!anchorState.calibrated) return;

            // 2D CLIENT: RECREATE POPUP IF IT WAS CLOSED BY THE USER, OR
            // CREATE IT FOR THE FIRST TIME NOW THAT WE'RE CALIBRATED.
            if (!window.popup || window.popup.closed) {
               setupContentPopup();
            }
            if (!window.popup || !popup.canvas) return;

            // REMAP HANDS INPUT COORDS TO SCREEN PIXELS

            for (let hand in P)
               inputs[hand] = { pressed: P[hand].pressed,
                                x: w/2 + w/2 * P[hand].x,
                                y: h/2 - h/2 * P[hand].y - 50 };

            // 2D CLIENT RESPONDS TO INPUT FROM EITHER MOUSE OR HANDS

            let findShape = (x,y) => {
               for (let n = S.length-1 ; n >= 0 ; n--)
                  if ( Math.abs(S[n].x - x) < 50 &&
                       Math.abs(S[n].y - y) < 50 )
                     return n;
            }

            let findColor = (x,y) => {
               for (let c = 0 ; c < colors.length ; c++)
                  if (Math.abs(cx(c) - x) < cr && Math.abs(cy(c) - y) < cr)
                     return c;
            }

            let moveShape = (n,x,y) => {
               if (n !== undefined) {
                  S[n].x = x;
                  S[n].y = y;
               }
            }

            for (let id in inputs) {
               let input = inputs[id];
               let state = states[id];

               // PRESS TO SELECT A SHAPE

               if (input.pressed && ! state.pressed) {
                  state.n = findShape(input.x, input.y);
                  if (state.n !== undefined)
                     selectedRegion = null;
                  else if (! selectedRegion)
                     selectedRegion = { a: { x: input.x, y: input.y },
                                        b: { x: input.x, y: input.y } };
               }

               // DRAG TO MODIFY SELECTED REGION OR TO MOVE A SHAPE

               if (input.pressed) {

                  if (selectedRegion) {
                     selectedRegion.b.x = input.x;
                     selectedRegion.b.y = input.y;
                  }

                  moveShape(state.n, input.x, input.y);

                  // AND MAYBE SET ITS COLOR

                  if (state.n !== undefined)
                     for (let id in states)
                        if (states[id].c !== undefined)
                           S[state.n].c = states[id].c;
               }

               // RELEASE TO UNSELECT

               if (state.pressed && ! input.pressed) {
                  delete state.n;
                  selectedRegion = null;
               }

               state.pressed = input.pressed;
               state.c = findColor(input.x, input.y);
            }

            // 2D CLIENT CLEARS THE SCREEN

            popup.canvas.focus();
            let ctx = popup.ctx;
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, w, h);

            // 2D CLIENT DRAWS THE SHAPES

            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 2;
            for (let n = 0 ; n < S.length ; n++) {
               let shape = S[n];
               ctx.fillStyle = colors[shape.c];
               switch (shape.type) {
               case 0:
                  ctx.fillRect  (shape.x - 50, shape.y - 50, 100, 100);
                  ctx.strokeRect(shape.x - 50, shape.y - 50, 100, 100);
                  break;
               case 1:
                  ctx.beginPath();
                  ctx.arc(shape.x, shape.y, 50, 0, 2 * Math.PI);
                  ctx.fill();
                  ctx.stroke();
                  break;
               }
            }

            // 2D CLIENT DRAWS THE COLOR PALETTE

            for (let c = 0 ; c < colors.length ; c++) {

               ctx.lineWidth = 2;
               for (let id in states)
                  if (states[id].c == c)
                     ctx.lineWidth = 6;

               ctx.fillStyle = colors[c];
               ctx.fillRect  (cx(c) - cr, cy(c) - cr, 2*cr, 2*cr);
               ctx.strokeRect(cx(c) - cr, cy(c) - cr, 2*cr, 2*cr);
            }

            if (selectedRegion) {
               ctx.fillStyle = '#00000020';
               let x0 = Math.min(selectedRegion.a.x, selectedRegion.b.x);
               let y0 = Math.min(selectedRegion.a.y, selectedRegion.b.y);
               let x1 = Math.max(selectedRegion.a.x, selectedRegion.b.x);
               let y1 = Math.max(selectedRegion.a.y, selectedRegion.b.y);
               ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
            }

            // 2D CLIENT DRAWS THE CURSORS FOR THE TWO VR HANDS

            ctx.strokeStyle = 'red';
            for (let id in P) {
               let input = inputs[id];
               ctx.lineWidth = input.pressed ? 9 : 3;
               for (let s = -10 ; s <= 10 ; s += 20) {
                  ctx.beginPath();
                  ctx.moveTo(input.x - 10, input.y - s);
                  ctx.lineTo(input.x + 10, input.y + s);
                  ctx.stroke();
               }
            }

            server.broadcastGlobal('S');
         }
      } catch(e) {
         errorMsg = e.message || String(e);
         console.error('transferCalibrated.js animate error:', e);
      }
   });
}