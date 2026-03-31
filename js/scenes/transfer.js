import { ControllerBeam } from "../render/core/controllerInput.js";

window.P = { left : { x:1, y:-1 }, right: { x:1, y:-1 } };
window.S = [];

export const init = async model => {

   let isHeadset = navigator.userAgent.indexOf('OculusBrowser') >= 0;
   let w = screen.width, h = screen.height - 80;
   let beams, pane, shapes, inputs, states, selectedRegion = null;
   let colors = '#ff0000,#ff8000,#ffff00,#30d030,#0080ff,#a000ff,#e800a0,#c0c0c0'.split(',');
   let rgb = [[1,0,0],[1,.3,0],[1,1,0],[.2,.8,.1],[0,.4,1],[.3,0,1],[.9,0,.8],[.7,.7,.7]];

   if (isHeadset) {

      // VR CLIENT SETS UP THE CONTROLLER BEAMS AND THE TARGET WINDOW PANE

      beams = { left : new ControllerBeam(model, 'left' ),
                right: new ControllerBeam(model, 'right') };

      pane = model.add().move(0,1,0).turnX(-.3).scale(.15,.092,1).move(0,-1,0);
      pane.add('square').move( 0, 1,0).scale(1,.005,1);
      pane.add('square').move( 0,-1,0).scale(1,.005,1);
      pane.add('square').move(-1, 0,0).scale(.003,1,1);
      pane.add('square').move( 1, 0,0).scale(.003,1,1);

      shapes = model.add();
   }
   else {

      // 2D CLIENT DEFINES THE SHAPES AND COLOR PALETTE

      if (S.length == 0)
         S.push({ type:0, x:w/8, y:h/3  , c: 7 },
                { type:1, x:w/8, y:2*h/3, c: 7 });

      // 2D CLIENT DECLARES THE INPUT STATE VARIABLES

      inputs = { left: {}, right: {}, mouse: {} };
      states = { left: {}, right: {}, mouse: {} };

      // 2D CLIENT DEFINES THE POPUP WINDOW, 2D CANVAS, AND MOUSE EVENTS CALLBACKS

      if (! window.popup) {
         window.popup = window.open('', 'CanvasWindow', 'width=' + w + ',height=' + h);

         let canvas = popup.document.createElement('canvas');
         canvas.width = w;
         canvas.height = h;

         canvas.addEventListener('mousedown', event => inputs.mouse = { pressed: true , x: event.x, y: event.y });
         canvas.addEventListener('mouseup'  , event => inputs.mouse = { pressed: false, x: event.x, y: event.y });
         canvas.addEventListener('mousemove', event => { inputs.mouse.x = event.x ; inputs.mouse.y = event.y ; });

         popup.document.body.appendChild(canvas);
	 popup.canvas = canvas;
	 popup.ctx = canvas.getContext('2d');
      }
   }

   model.animate(() => {
      let cr = h / 32;
      let cx = n => w - h/9;
      let cy = n => (n+.75) * h/9;

      P = server.synchronize('P');
      S = server.synchronize('S');

      if (isHeadset) {

         // VR CLIENT SENDS CONTROLLER STATE DATA TO THE 2D CLIENT

         for (let hand in beams) {
            beams[hand].update();
            let h = beams[hand].hitRect(pane.getGlobalMatrix(), true);
            if (h)
	       P[hand] = { x:h[0], y:h[1], pressed:inputEvents.isPressed(hand) };
         }
         server.broadcastGlobal('P');

	 // CREATE 3D VIEW OF ANY SHAPES THAT ARE ABOVE THE SCREEN.

	 while (shapes.nChildren() > 0)
	    shapes.remove(0);

         for (let n = 0 ; n < S.length ; n++) {
	    let s = S[n];
	    let x =  (s.x - w/2 - 130) / (w/2);
	    let y = -(s.y - h/2 + 150) / (w/2);
	    if (y > .4)
	       shapes.add(s.type == 0 ? 'cube' : 'sphere')
	             .move(0,.95,0)
	             .scale(.13)
	             .turnX(-.3)
	             .move(x,y,0)
	             .turnX(.3)
		     .scale(.085)
	             .color(rgb[s.c]);
         }
      }
      else {

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
	    
	 // 2D CLIENT DRAWS THE CURSORS FOR THE TWO HANDS

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
   });
}
