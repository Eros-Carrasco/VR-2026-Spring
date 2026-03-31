import * as cg from "../render/core/cg.js";
import { G2 } from "../util/g2.js";
import { ControllerBeam } from "../render/core/controllerInput.js";

window.sS = {length: 0}; // SHARED STATE OF THE BOARD
window.sC = [];          // SHARED INPUT CURSORS FROM ALL CLIENTS

export const init = async model => {

   // DECLARE COLORS AND BOARD LOCATION AND DIMENSIONS

   const colors = '#ff0000,#ff4000,#ffff00,#20d020,#0080ff,#6000ff,#e800a0,#ffffff'.split(',');
   const X = .75, move = [0,1.5,0], scale = .3;

   let cursorStates = [];                                     // CURSOR STATE IN THE MASTER CLIENT
   let s = p => clientID == clients[0] ? p : [-p[0],p[1]];    // FLIP X IF THIS IS THE SECOND CLIENT

   let beams = { left : new ControllerBeam(model, 'left' ),   // CREATE THE CONTROLLER BEAMS
                 right: new ControllerBeam(model, 'right') }; //

   let g2 = new G2();                                         // CREATE THE 2D CANVAS, AND
   model.txtrSrc(2, g2.getCanvas());                          // DECLARE IT TO BE A TEXTURE SOURCE

   let board = model.add('square').move(move).scale(scale)    // CREATE THE BOARD AND
                    .dull().txtr(2);                          // TEXTURE IT WITH THE 2D CANVAS

   // PROCEDURES THAT DEFINE SHAPES FOR PIECES

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

   let drawShape = (type, p, color) => {                // DRAW A SHAPE GIVEN ITS LOCATION AND COLOR
      g2.setColor(color);                               //
      switch (type) {                                   //
      case 0: g2.fillCurve(10, t => regularPolygon(t, p, .09, 10, true)); break;
      case 1: g2.fillCurve( 3, t => regularPolygon(t, p, .075, 3)); break;
      case 2: g2.fillCurve( 4, t => regularPolygon(t, p, .075, 4)); break;
      case 3: g2.fillCurve(32, t => heart(t, p, .11)); break;
      case 4: g2.fillCurve(32, t => circle(t, p, .065)); break;
      case 5: g2.fillRect(p[0]-.058, p[1]-.058, .116, .116); break;
      case 6: g2.fillPath(cross(p[0], p[1], .06, .024)); break;
      }
   }

   let n2y = n => X-2*X/7*(n+.5);                       // CONVERT BETWEEN Y and ICON INDEX
   let y2n = y => (X-y)/(2*X/7) >> 0;                   //

   let hit = hand => {                                  // COMPUTE WHERE HAND OR BEAM HITS THE BOARD
      if (isXR()) {
         if (window.handtracking) {                            // IF USING HANDTRACKING
            let p = inputEvents.pos(hand);                     //
            if (p)                                             //
               return s([ (p[0] - move[0]) / scale,            //
                          (p[1] - move[1]) / scale ]);         //
         }

         let h = beams[hand].hitRect(board.getGlobalMatrix()); // IF USING CONTROLLER BEAMS
         if (h)                                                //
            return s([h[0],h[1]]);                             //
      }
   }

   let findPiece = p => {                              // FIND THE FRONT-MOST PIECE AT THE CURSOR
      for (let n in sS)                                //
         if (! isNaN(Number.parseInt(n)))              //
            if (Math.abs(sS[n].p[0] - p[0]) < .1 && Math.abs(sS[n].p[1] - p[1]) < .1)
               return n;                               //
   }

   let setCursor = (hand, isPressed) => {              // RESPOND TO USER INPUT BY SENDING
      let id = 2 * clientID + (hand=='left' ? 0 : 1);  // CURSOR INFO TO THE MASTER CLIENT
      if (! sC[id])                                    //
         sC[id] = {};                                  //
      sC[id].isPressed = isPressed;                    //
      sC[id].p = hit(hand);                            //
      server.broadcastGlobalSlice('sC', id, id+1);     //
   }                                                   //
   inputEvents.onPress   = hand => setCursor(hand, true);
   inputEvents.onDrag    = hand => setCursor(hand, true);
   inputEvents.onRelease = hand => setCursor(hand, false);
   inputEvents.onMove    = hand => setCursor(hand, false);

   model.animate(() => {

      sC = server.synchronize('sC');
      sS = server.synchronize('sS');

      if (clientID == clients[0]) {                    // IF I AM MASTER CLIENT, MODIFY SCENE
         for (let nc in sC) {                          // BY RESPONDING TO THE CLIENT CURSORS
            let cursor = sC[nc];                       //
            let p = cursor.p;                          //
                                                       //
            let cursorID = 'cursor_' + nc;             //
            if (! cursorStates[cursorID])              //
               cursorStates[cursorID] = {};            //
            let cursorState = cursorStates[cursorID];  //

            // ON PRESS

            if (! cursorState.isPressed && cursor.isPressed) {
               if (p && p[0] < -X) {                   // PRESS ON A SHAPE TO CREATE A NEW PIECE
                  cursorState.n = sS.length++;         //
                  sS[cursorState.n] = { type: y2n(p[1]), p: p, c: 7 };
               }
               if (p && p[0] > X)                      // PRESS ON A COLOR TO DRAG THAT COLOR
                  sS[cursorID] = { c: y2n(p[1]), p: p };
               if (p)                                  // PRESS ON A PIECE TO DRAG IT
                  cursorState.n = findPiece(p);        //
            }

            if (cursorState.isPressed && cursor.isPressed) {

               if (p && cursorState.n !== undefined)   // DRAGGING A PIECE
                  sS[cursorState.n].p = p;             //

               if (p && sS[cursorID] !== undefined)    // DRAGGING A COLOR
                  sS[cursorID].p = p;                  //
            }

            // ON RELEASE

            if (cursorState.isPressed && ! cursor.isPressed) {
               let n = cursorState.n;                  // DRAG A PIECE OFF THE BOARD TO DELETE IT
               if (n !== undefined && Math.abs(sS[n].p[0]) > X)
                  delete sS[n];                        //
               delete cursorState.n;                   //

               if (p && sS[cursorID] !== undefined) {
                  let n = findPiece(p);                // DROP A COLOR ON PIECE TO CHANGE ITS COLOR
                  if (n !== undefined)                 //
                     sS[n].c = sS[cursorID].c;         //
               }                                       //
               delete sS[cursorID];                    //
            }

            cursorState.isPressed = cursor.isPressed;  // UPDATE "IS PRESSED" FOR THIS CURSOR
         }
         server.broadcastGlobal('sS');                 // MASTER CLIENT UPDATES STATE OF ALL CLIENTS
      }

      for (let hand in beams)                                       // UPDATE THE CONTROLLER BEAMS
         beams[hand].update();

      g2.clear();                                                   // CLEAR THE BOARD AND DRAW
      g2.lineWidth(.005);                                           // AN OUTLINE AROUND THE BOARD
      g2.setColor('#ffffff');                                       //
      g2.drawRect(-X,-X,2*X,2*X);                                   //

      for (let type = 0 ; type < 7 ; type++)                        // DRAW THE SHAPE ICONS
         drawShape(type, s([-X*1.12, n2y(type)]), colors[7] + 'd0');

      for (let n = 0 ; n < 7 ; n++) {                               // DRAW THE COLOR ICONS
         g2.setColor(colors[n] + 'd0');
         g2.fillCurve(32, t => superquadric(t, s([X*1.12,n2y(n)]), .058));
      }

      for (let id in sS)
         if (! isNaN(Number.parseInt(id)))                          // DRAW THE PIECES ON THE BOARD
            drawShape(sS[id].type, s(sS[id].p), colors[sS[id].c]);
         else if (id != 'length' && sS[id] !== undefined) {         // IF COLOR DRAGGING, DRAW COLOR
            g2.setColor(colors[sS[id].c] + 'd0');
            g2.fillCurve(32, t => superquadric(t, s(sS[id].p), .058));
         }

      for (let id in sC)                                            // SHOW THE CURSORS ON THE BOARD
         if (sC[id].p) {                                            //
            let x = sC[id].p[0], y = sC[id].p[1], r = .014;         //
            g2.lineWidth(sC[id].isPressed ? .01 : .005);            //
            g2.setColor('#000000').line(s([x-r,y-r]),s([x+r,y+r]))  //
                                  .line(s([x-r,y+r]),s([x+r,y-r])); //
         }
   });
}
