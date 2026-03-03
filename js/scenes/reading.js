import * as cg from "../render/core/cg.js";
import { readFile, writeFile } from "../file.js";

// MAKE IT EASY TO READ A BOOK WHILE EXERCISING.

const inch = .0254;
let book, line = 0, scale = 1;

// INITIALLY, READ IN THE ENTIRE BOOK, AND SAVE IT AS AN ARRAY OF LINES OF TEXT

readFile('../media/text/prideandprejudice.txt', text => { book = text.split('\n'); });

export const init = async model => {

   // CREATE A TRANSPARENT WHITE PAGE TO PRINT THE BOOK'S TEXT ONTO

   let page = model.add().move(0,0,-20.01).scale(8.5,11,1).opacity(.7);
   page.add('square');

   model.animate(() => {

      // REBUILD THE PAGE EVERY ANIMATION FRAME WITH CURRENT SIZE AND SCROLL POSITION

      if (book) {
         model.remove(1);
         let text = '';
	 for (let n = 0 ; n < 50 ; n++)
	    text += book[(line>>0) + n] + '\n';
         model.add(clay.text(text)).move(0,0,-20).scale(scale)
	                           .move(-6.5,8.8,0).scale(13.5)
	                           .move(0,(line%1)*inch,0).color(0,0,0);
      }

      // GET THE HEAD MATRIX SO WE CAN EXAMINE THE USER'S HEAD GAZE DIRECTION

      let m = cg.mMultiply(clay.root().viewMatrix(0), worldCoords);

      // THE USER LOOKS LEFT OR RIGHT TO CHANGE THE SIZE OF THE PAGE

      if (m[8] * m[8] > .09) {
         scale = Math.max(.5, Math.min(2, scale * (1 + .1 * m[8] * Math.abs(m[8]))));
         page.child(0).identity().scale(scale);
      }

      // THE USER LOOKS UP OR DOWN TO SCROLL THROUGH THE BOOK

      if (m[9] * m[9] > .01)
         line = Math.max(0, line - 10 * m[9] * Math.abs(m[9]));
   });
}


