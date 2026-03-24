import * as cg from "../render/core/cg.js";
import { G2 } from "../util/g2.js";
import { ControllerBeam } from "../render/core/controllerInput.js";

/*
How the multiplayer communication works in this scene:

   Each client's input events (press/drag/release/move)
   only compute the hit point and the current up/down
   state of that hand or controller. That info, attached
   to the unique id of this hand of this client, is sent
   to the master client. The master client then makes all
   actual scene changes, and broadcasts the new state to
   all clients.
*/

window.ss = {
   S: [],       // Current state of the scene
   cursors: {}  // Current state of all cursors of all clients
}

export const init = async model => {

   // DECLARE COLORS AND BOARD LOCATION AND DIMENSIONS

   const colors = '#ff0000,#ff4000,#ffff00,#20d020,#0080ff,#6000ff,#e800a0,#ffffff'.split(',');
   const X = .75, move = [0,1.5,0], scale = .3;

   // CREATE THE CONTROLLER BEAMS

   let beams = { left : new ControllerBeam(model, 'left' ),
                 right: new ControllerBeam(model, 'right') };

   // CREATE THE 2D CANVAS AND DECLARE IT TO BE A TEXTURE SOURCE

   let g2 = new G2();
   model.txtrSrc(2, g2.getCanvas());

   // ADD THE BOARD TO THE SCENE AND TEXTURE IT WITH THE 2D CANVAS

   let board = model.add('square').move(move).scale(scale).dull().txtr(2);

   // SOME USEFUL PROCEDURALLY DEFINED SHAPES

   let superquadric = (t, C, R) => {
      let x = Math.sin(2 * Math.PI * t);
      let y = Math.cos(2 * Math.PI * t);
      let r = Math.pow(x*x*x*x + y*y*y*y, 1/4);
      return [C[0] + R * x / r, C[1] + R * y / r];
   }

   let regularPolygon = (t, C, R, n, isStar) => {
      let x = Math.sin(2 * Math.PI * t);
      let y = Math.cos(2 * Math.PI * t);
      let r = isStar && n * t >> 0 & 1 ? R/2 : R;
      return [C[0] + r * x, C[1] + r * y];
   }

   let heart = (t, C, R) => {
      let x = Math.sin(2 * Math.PI * t);
      let y = Math.cos(2 * Math.PI * t);
      let r = R * (1 - Math.pow(2 * (t < .5 ? t : 1-t), .7));
      return [C[0] + 1.25 * r * x, C[1] + .4*R - r * y];
   }

   let circle = (t, C, R) => {
      let x = Math.sin(2 * Math.PI * t);
      let y = Math.cos(2 * Math.PI * t);
      return [ C[0] + R * x, C[1] + R * y ];
   }

   let cross = (x,y,a,b) => [ [x-a,y-b],[x-b,y-b],[x-b,y-a],
                              [x+b,y-a],[x+b,y-b],[x+a,y-b],
                              [x+a,y+b],[x+b,y+b],[x+b,y+a],
                              [x-b,y+a],[x-b,y+b],[x-a,y+b] ];

   let drawShape = (type, p, color) => {    // DRAW A SHAPE, GIVEN LOCATION AND COLOR
      g2.setColor(color);
      switch (type) {
      case 0: g2.fillCurve(10, t => regularPolygon(t, p, .09, 10, true)); break;
      case 1: g2.fillCurve( 3, t => regularPolygon(t, p, .075, 3)); break;
      case 2: g2.fillCurve( 4, t => regularPolygon(t, p, .075, 4)); break;
      case 3: g2.fillCurve(32, t => heart(t, p, .11)); break;
      case 4: g2.fillCurve(32, t => circle(t, p, .065)); break;
      case 5: g2.fillRect(p[0]-.058, p[1]-.058, .116, .116); break;
      case 6: g2.fillPath(cross(p[0], p[1], .06, .024)); break;
      }
   }

   let n2y = n => X-2*X/7*(n+.5);           // CONVERT BETWEEN Y and ICON INDEX
   let y2n = y => (X-y)/(2*X/7) >> 0;

   let hit = hand => {                      // COMPUTE WHERE HAND OR BEAM INTERSECTS BOARD
      if (isXR()) {
         if (window.handtracking) {
            let p = inputEvents.pos(hand);
            if (p)
               return [ (p[0] - move[0]) / scale,
                        (p[1] - move[1]) / scale ]; // IF USING HANDTRACKING
         }

         let h = beams[hand].hitRect(board.getGlobalMatrix());
         if (h)
            return [h[0],h[1]];                     // IF USING CONTROLLER BEAMS
      }
   }

   let findPiece = p => {                   // FIND THE FRONT-MOST PIECE AT THE CURSOR
      for (let n = ss.S.length-1 ; n >= 0 ; n--)
         if (Math.abs(ss.S[n].p[0] - p[0]) < .1 && Math.abs(ss.S[n].p[1] - p[1]) < .1)
            return n;
   }

   let setCursor = (hand, isPressed) => {
      let id = hand + clientID;
      if (! ss.cursors[id])
         ss.cursors[id] = {};
      ss.cursors[id].isPressed = isPressed;
      ss.cursors[id].p = hit(hand);
      server.broadcastGlobal('ss');
   }

   inputEvents.onPress   = hand => setCursor(hand, true);
   inputEvents.onDrag    = hand => setCursor(hand, true);
   inputEvents.onRelease = hand => setCursor(hand, false);
   inputEvents.onMove    = hand => setCursor(hand, false);

   let states = {};                         // CURSOR STATE THE MASTER CLIENT MAINTAINS

   model.animate(() => {

      ss = server.synchronize('ss');          // GET CURRENT STATE FROM MASTER CLIENT

      if (clientID == clients[0]) {           // IF I AM MASTER CLIENT, MODIFY SCENE STATE
         for (let id in ss.cursors) {         // BY RESPONDING TO THE CURRENT STATE OF
	    let cursor = ss.cursors[id];      // ALL CLIENT CURSORS
	    let p = cursor.p;

	    if (! states[id])
	       states[id] = {};
            let state = states[id];

	    // ON PRESS

	    if (! state.isPressed && cursor.isPressed) {
               if (p && p[0] < -X) {          // PRESS ON A SHAPE ICON TO CREATE A NEW PIECE
                  state.n = ss.S.length;
                  ss.S.push({ type: y2n(p[1]), p: p, c: 7 });
               }
               if (p && p[0] > X) {           // PRESS ON A COLOR ICON TO DRAG THAT COLOR
                  state.c = y2n(p[1]);
                  state.cp = p;
               }
               if (p)                         // PRESS ON A PIECE TO DRAG IT
                  state.n = findPiece(p);
            }

	    // ON DRAG

	    if (state.isPressed && cursor.isPressed) {
               if (state.n !== undefined) {  // DRAGGING A PIECE
                  if (p)
                     ss.S[state.n].p = p;
               }
               if (state.c !== undefined) {  // DRAGGING A COLOR
                  if (p)
                     state.cp = p;
               }
            }

	    // ON RELEASE

	    if (state.isPressed && ! cursor.isPressed) {
               let n = state.n; 
               if (n !== undefined && Math.abs(ss.S[n].p[0]) > X)
                  ss.S.splice(n, 1);
               delete state.n;               // DRAG A PIECE OFF THE BOARD TO DELETE IT

               if (state.c !== undefined) {
                  if (p) {                    // DROP A COLOR ON A PIECE TO CHANGE PIECE COLOR
                     let n = findPiece(p);
                     if (n !== undefined)
                        ss.S[n].c = state.c;
                  }
               }
               delete state.c;
            }

	    state.isPressed = cursor.isPressed;
         }
         server.broadcastGlobal('ss');       // MASTER CLIENT SENDS THE NEW STATE TO ALL CLIENTS
      }

      for (let hand in beams)                             // UPDATE THE CONTROLLER BEAMS
         beams[hand].update();

      g2.clear();                                         // CLEAR THE BOARD
      g2.lineWidth(.005);
      g2.setColor('#ffffff');
      g2.drawRect(-X,-X,2*X,2*X);                         // DRAW A FRAME AROUND THE BOARD

      for (let type = 0 ; type < 7 ; type++)              // DRAW THE SHAPE ICONS
         drawShape(type, [-X*1.12, n2y(type)], colors[7] + 'd0');

      for (let n = 0 ; n < 7 ; n++) {                     // DRAW THE COLOR ICONS
         g2.setColor(colors[n] + 'd0');
         g2.fillCurve(32, t => superquadric(t, [X*1.12,n2y(n)], .058));
      }

      for (let n = 0 ; n < ss.S.length ; n++)             // DRAW ALL THE PIECES ON THE BOARD
         drawShape(ss.S[n].type, ss.S[n].p, colors[ss.S[n].c]);

      for (let id in ss.cursors) { 
         let state = states[id];
         if (state.c !== undefined) {                     // IF COLOR DRAGGING, DRAW COLOR ICON
            g2.setColor(colors[state.c] + 'd0');
            g2.fillCurve(32, t => superquadric(t, state.cp, .058));
         }

         let cursor = ss.cursors[id];
         let p = cursor.p;                                // SHOW THE CURSOR ON THE BOARD
         if (p) {
            let x = p[0], y = p[1], r = .014;
            g2.lineWidth(cursor.isPressed ? .01 : .005);
            g2.setColor('#000000').line([x-r,y-r],[x+r,y+r]).line([x-r,y+r],[x+r,y-r]);
         }
      }
   });
}
