import * as cg from "../render/core/cg.js";
import { ControllerBeam } from "../render/core/controllerInput.js";
import { fetchWikipediaFullArticle, parseArticle } from "../fetchWikipediaArticle.js";

// INTERACTIVELY EXPLORE WIKIPEDIA ARTICLES IN XR

function ArticleNode (model, articleName) {
   const inch = .0254, x0 = -.35;

   let article, titleBar, highlightBar, infoText;
   let position = [0,0,0], scale = .8, y = 0, textSize = null;
   let selectedText = '', textSelectionStart = -1, textSelectionEnd = -1, col_row = null;
   let isOpen = true, isLocked = false, nSelect = -1;
   let isMovingArticle = false, isRightDraggingInTitleBar = false;
   let handPos = {}, beamPos = {}, isPressed = {}, wasPressed = {};

   // THE COORDINATE SYSTEM OF THE USER'S EYES

   let eyeMatrix = () => cg.mMultiply(cg.mInverse(clay.root().viewMatrix(0)), worldCoords);

   // POSITION OF USER POINTER RELATIVE TO A FOCUS BAR

   let relToBar = (hand, n) => {
      let obj = n < 0 ? titleBar : article.child(n);
      let focusBar = obj.child(0);
      let m = cg.mMultiply(cg.mInverse(worldCoords), focusBar.getGlobalMatrix());
      let p = inputEvents.pos(hand);
      return p ? cg.mTransform(cg.mInverse(m), [p[0],p[1]+inch/2*scale,p[2]]) : null;
   }

   // IS THE USER POINTER INSIDE THE TITLE BAR?

   let isInTitleBar = hand => isInBar(hand, -1);

   // IS THE USER POINTER INSIDE A FOCUS BAR?

   let isInBar = (hand, n) => {
      if (window.handtracking) {
         let p = relToBar(hand, n);
         return p && Math.max(p[0]*p[0], p[1]*p[1], p[2]*p[2]) < 1;
      }
      else {
         let obj = n < 0 ? titleBar : article.child(n);
         if (! obj || ! obj.child(0))
            return false;
         let focusBar = obj.child(0);
         return model.beam[hand].hitRect(focusBar.getGlobalMatrix()) != null;
      }
   }

   // RETURN THE DISTANCE OF HAND OR CONTROLLER TO A BAR

   let distanceToBar = (hand, n) => {
      if (window.handtracking) {
         let p = relToBar(hand, n);
         return p ? cg.norm(p) : -1;
      }
      else {
         let obj = n < 0 ? titleBar : article.child(n);
         let focusBar = obj.child(0);
         let uvd = model.beam[hand].hitRect(focusBar.getGlobalMatrix());
         return uvd ? uvd[2] : -1;
      }
   }

   // POINT IN SPACE WHERE A BEAM INTERSECTS A BAR

   let pointInBar = (hand, n, flag) => {
      if (window.handtracking)
         return inputEvents.pos(hand);

      let obj = n < 0 ? titleBar : article.child(n);
      let focusBar = obj.child(0);
      let m = focusBar.getGlobalMatrix();
      return model.beam[hand].hitRect(m, flag) ? model.beam[hand].hitPoint(m, flag) : null;
   }

   // IS THE USER POINTER BESIDE A FOCUS BAR?

   let isBesideBar = (hand, n, side) => {
      let isBeside = u => side == -1 ? u < -1 : u > 1;
      if (window.handtracking) {
         let p = relToBar(hand, n);
         return isBeside(p[0]) && p[1]*p[1] < 1 && p[2]*p[2] < 1;
      }
      else {
         let obj = n < 0 ? titleBar : article.child(n);
         let focusBar = obj.child(0);
         let uvz = model.beam[hand].hitRect(focusBar.getGlobalMatrix(), true);
         return uvz && uvz[1] > -1 && uvz[1] < 1 && isBeside(uvz[0]);
      }
   }

   // SET THE ARTICLE TO OPEN OR CLOSED

   this.setOpen = state => isOpen = state;

   ///////////////////// PRESS / DRAG / RELEASE EVENT HANDLING ///////////////////

   this.onPress = hand => {
      isPressed[hand] = true;

      // PRESS WITH LEFT HAND ON TITLE BAR TO START DRAGGING ARTICLE POSITION

      if (hand == 'left' && isInTitleBar(hand))
         isMovingArticle = true;

      // PRESS WITH RIGHT HAND ON TITLE BAR TO START DELETE OR OPEN/CLOSE ACTION

      if (hand == 'right' && isInTitleBar(hand))
         isRightDraggingInTitleBar = true;
   }

   this.onDrag = hand => {
      if (hand == 'left' && isMovingArticle)
         moveArticle();
   }

   this.onRelease = hand => {
      isPressed[hand] = false;

      // LEFT CLICK WHEN THERE IS SELECTED TEXT TO CREATE A NEW ARTICLE NODE

      if (! isMovingArticle && hand == 'left' && selectedText.length > 0) {
         let articleNode = new ArticleNode(model, selectedText);
         articleNode.setOpen(false);
	 let p = inputEvents.pos('left');
	 if (! window.handtracking) {
            let z = eyeMatrix().slice(8,11);
	    p = cg.add(p, cg.scale(z, -.4));
         }
         articleNode.setPosition(p);
         articleNodes.push(articleNode);
      }

      // LEFT DRAG OVER TITLE BAR TO MOVE THIS ARTICLE NODE

      if (hand == 'left')
         isMovingArticle = false;

      // RIGHT DRAG OFF LEFT OF TITLE BAR TO TOGGLE OPEN / CLOSED

      if (isRightDraggingInTitleBar && isBesideBar('right', -1, -1)) {
         isOpen = ! isOpen;
         if (! isOpen) {
            nSelect = -1;
            textSize = null;
            isLocked = false;
         }
      }

      // RIGHT DRAG OFF RIGHT OF TITLE BAR TO DELETE THIS ARTICLE NODE

      if (articleNodes.length > 1)
         if (isRightDraggingInTitleBar && isBesideBar(hand, -1, 1)) {
            for (let n = 0 ; n < articleNodes.length ; n++)
               if (articleNodes[n] == this) {
                  articleNodes.splice(n, 1);
                  model.remove(article);
                  break;
               }
         }

      isRightDraggingInTitleBar = false;
      delete handPos[hand];
      delete beamPos[hand];
   }

   // TO MOVE AN ARTICLE NODE'S POSITION, LEFT DRAG ON ITS TITLE BAR.

   let moveArticle = () => {
      if (window.handtracking) {
         let hp = inputEvents.pos('left');
         if (handPos.left)
           position = cg.add(position, cg.subtract(hp, handPos.left));
         handPos.left = hp;
      }
      else {
         let hp = inputEvents.pos('left');
         let bp = pointInBar('left', -1, true);
         if (handPos.left && beamPos.left) {
            let d = cg.distance(handPos.left, beamPos.left);
            bp = cg.add(hp, cg.scale(cg.normalize(cg.subtract(bp, hp)), d));
            position = cg.add(position, cg.subtract(bp, beamPos.left));
         }
         handPos.left = hp;
         beamPos.left = bp;
      }
   }

   // ADD A SECTION TO THE VISUALIZATION OF THE WIKIPEDIA ARTICLE

   let addNode = (node, x, level) => {

      let obj = article.add();
      obj.isNode = true;
      let focusBar  = obj.add();
      let nameBar   = obj.add();
      let textBlock = obj.add();

      // ADD THE FOCUS BAR TO THE LEFT OF THE NAME BAR

      focusBar.move(x0 + (x-x0)/2, y -= inch, 0).scale((x-x0)/2,inch/2,2*inch)
              .add('square').scale(1,1/1.1,1).dull().opacity(.75);

      // ADD THE NAME BAR FOR THIS SECTION

      nameBar.move(x, y+inch/2, 0);
      if (node.name) {
         let nc = node.name.length;
         nameBar.add('square').move(nc*inch/4, -inch/2, 0).scale(nc*inch/4, inch/2.2, 1).opacity(.6);
         nameBar.add(clay.text(node.name)).move(0,0,.0001).color(0,0,0);
      }

      // ADD THE TEXT BLOCK FOR THIS SECTION

      textBlock.move(x0+4.5*inch,y-inch*2/3,.0002);
      textBlock.textData = node.text;

      // RECURSE THROUGH SUBSECTIONS

      if (node.sections)
         for (let n = 0 ; n < node.sections.length ; n++)
            addNode(node.sections[n], x + 1.5*inch, level+1);
   }

   article = model.add();

   // FETCH AND PARSE THE WIKIPEDIA ARTICLE CONTENTS, THEN CREATE AUXILIARY OBJECTS

   fetchWikipediaFullArticle(articleName, text => {
      if (text) {

         // CREATE ALL THE ARTICLE SECTIONS

         addNode(parseArticle(text), x0, 0);

         // CREATE THE TITLE BAR

         titleBar = article.add().move(x0,1.5*inch,0).scale(3,3,.5).dull();
         let nc = articleName.length;
         titleBar.add('square').move(nc*inch/4,-inch/2,.001).scale(nc*inch/4,inch/2,1).opacity(.8);
         titleBar.add(clay.text(articleName)).move(0,0,.002).color(0,0,0);

         // CREATE THE TEXT HIGHLIGHT BAR

         highlightBar = article.add('square').opacity(.7).scale(0);

         // CREATE AN INFO TEXT OBJECT TO USE FOR DEBUGGING

         infoText = article.add().move(x0,4*inch,0).scale(1.5);
      }
   });

   // SET THE CONTENTS OF THIS ARTICLE'S DEBUGGING INFO TEXT

   let setInfoText = text => {
      if (infoText) {
         while (infoText.nChildren() > 0)
            infoText.remove(0);
         infoText.add(clay.text(text)).color(1,1,1);
      }
   }

   // FIND THE COLUMN AND ROW WITHIN A TEXT BLOCK THAT THE USER IS POINTING AT

   let col_rowInSelectedText = () => {

      // IF NO SELECTION OR SELECTION HAS NO TEXT, RETURN FALSE

      if (nSelect < 0)
         return null;

      let obj = article.child(nSelect);
      let section = obj.child(2);
      if (! section)
         return null;

      // RETRIEVE THE VISIBLE BOUNDS OF THE TEXT BLOCK

      let text = section.child(1);
      let m = text.getGlobalMatrix();
      let { lo, hi } = clay.meshBounds(text.getForm());
      lo[0] -= .008;
      lo[1] -= .016;
      hi[0] += .008;
      hi[1] += .008;

      // FIND WHETHER / WHERE THE USER IS POINTING WITHIN THE TEXT BLOCK

      let p;
      if (window.handtracking) {
         let im = cg.mMultiply(cg.mInverse(m), worldCoords);
         p = cg.mTransform(im, inputEvents.pos('right'));
         if (! (p[0] > lo[0] && p[0] < hi[0] &&
                p[1] > lo[1] && p[1] < hi[1] &&
                p[2] > 0 && p[2] < 8*inch) )
            return null;
      }
      else {
         p = model.beam.right.hitRect(m, true);
         if (! (p && p[0] > lo[0] && p[0] < hi[0]
                  && p[1] > lo[1] && p[1] < hi[1]) )
            return null;
      }

      let col = Math.max(0,  p[0]) / (inch/2) >> 0;
      let row = Math.max(0, -p[1]) /  inch    >> 0;
      row = Math.min(row, -lo[1] / inch >> 0);

      return { col: col, row: row, d: p[2] };
   }

   this.setPosition = p => position = p;

   // UPDATE THE ARTICLE FOR THIS ANIMATION FRAME

   this.update = () => {

      // DO NOT DO ANYTHING UNTIL ARTICLE FETCH HAS COMPLETED

      if (! infoText)
         return;

      // TURN THE ARTICLE TO FACE THE USER, ROTATING ABOUT THE CENTER OF USER'S HEAD

      {
         let m = cg.mMultiply( cg.mInverse(clay.root().viewMatrix(0)),
                               [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,.1,1] );
         let wc = worldCoords;
         let p = cg.mTransform(wc, position);
         let theta = Math.atan2(m[12]-p[0], m[14]-p[2]) - Math.atan2(wc[8], wc[10]);
         article.identity().move(position).turnY(theta).scale(scale);
      }

      let isAnyHit = false;

      // LEFT HAND INTERACTION AND DISPLAY LOGIC WHEN SELECTION IS LOCKED

      if (isLocked) {
         for (let n = 0 ; n < article.nChildren() ; n++) {

            let obj = article.child(n);
            if (! obj.isNode)
               continue;

            let focusBar  = obj.child(0);
            let nameBar   = obj.child(1);
            let textBlock = obj.child(2);

            if (isInBar('left', n) && n == nSelect)
               isLocked = false;

            focusBar.color(n == nSelect ? [0,0,0] : [1,1,1]);
            if (nameBar)
               nameBar.opacity(! isOpen ? .001 : n > nSelect ? .25 : 1);
            if (textBlock && textBlock.child(0)) {
               textBlock.child(0).opacity(! isOpen ? .001 : n == nSelect ? 0.8 : .001);
               textBlock.child(1).opacity(! isOpen ? .001 : n == nSelect ? 1.0 : .001);
            }
         }
      }

      // LEFT HAND INTERACTION AND DISPLAY LOGIC WHEN SELECTION IS UNLOCKED

      else {
         let isHitNoText = false;
         for (let n = 0 ; n < article.nChildren() ; n++) {

            let obj = article.child(n);
            if (! obj.isNode)
               continue;

            let focusBar  = obj.child(0);
            let nameBar   = obj.child(1);
            let textBlock = obj.child(2);

            let isText = obj.child(2);
            let isHit = false;

            let m = focusBar.getGlobalMatrix();

            if (isInBar('left', n))
               isHit = true;
            if (n == nSelect && isBesideBar('left', n, -1))
               isLocked = isHit = true;

            if (isHit && textBlock) {
               nSelect = n;
               textSize = null;
            }
            if (isHit && ! textBlock)
               isHitNoText = true;

            // VARY OPACITY OF ALL THIS NODE'S ELEMENTS BASED ON ARTICLE STATE

            focusBar.child(0).opacity(! isOpen ? .001 : .75);
            focusBar.color(isHit ? textBlock ? [0,.5,1] : [1,.25,.25] : [1,1,1]);

            if (nameBar.child(0))
               nameBar.child(0).opacity(! isOpen ? .001 : .6);

            if (textBlock && textBlock.child(0)) {
               textBlock.child(0).opacity(! isOpen ? .001 : isHit ? 0.8 : .001);
               textBlock.child(1).opacity(! isOpen ? .001 : isHit ? 1.0 : .001);
            }
            isAnyHit |= isHit;
         }
         if (isHitNoText)
            isAnyHit = false;

         // FAD OUT ALL NODES AFTER THE CURRENT NODE

         for (let n = 0 ; n < article.nChildren() ; n++)
            if (article.child(n).child(1))
               article.child(n).child(1).opacity(! isOpen ? .001 : isAnyHit && n > nSelect ? .25 : 1);
      }

      // WHEN A SECTION IS SELECTED, AND THERE IS SOME TEXT WITHIN THAT SECTION, THEN
      // HIGHLIGHT WHERE THE RIGHT CONTROLLER BEAM FOR FINGER IS POINTING IN THE TEXT

      selectedText = '';
      highlightBar.scale(0);
      col_row = null;

      if (isOpen && nSelect >= 0) {
         let obj = article.child(nSelect);

         let textBlock = obj.child(2);
         if (textBlock && textBlock.textData.length) {

            // VARY TEXT SIZE BASED ON DISTANCE FROM THE USER'S EYE TO THE PLANE OF THE TEXT BLOCK

            let eye = eyeMatrix().slice(12,15);
            let m = textBlock.getGlobalMatrix();
            let z = cg.normalize(m.slice(8,11));
            let newTextSize = Math.max(.27, Math.min(1, cg.dot(z, eye)));

            let nCols = (3 / newTextSize >> 0) * 16;
            while (nCols > 48 && (nCols-1) * (nCols-1) / 3 > textBlock.textData.length)
               nCols--;
            newTextSize = 48 / nCols;

            // REBUILD THE TEXT BLOCK IF TEXT SIZE HAS CHANGED

            if (newTextSize != textSize) {
               textSize = newTextSize;
               let text = textBlock.textData.slice(0, nCols * nCols / 3);
               let textForm = clay.text(cg.split(text, nCols));
               let { lo, hi } = clay.meshBounds(textForm);
               while (textBlock.nChildren() > 0)
                  textBlock.remove(0);
               textBlock.add('square').scale(textSize)
                                      .move ((lo[0]+hi[0])/2-.008,
                                             (lo[1]+hi[1])/2-.012, 0)
                                      .scale((hi[0]-lo[0])/2+.016,
                                             (hi[1]-lo[1])/2+.016, 1).opacity(.8);
               textBlock.add(textForm).color(0,0,0).scale(textSize).move(0,-.012,.0001);
            }

            // TINT THE TEXT BLOCK IF THE RIGHT CONTROLLER IS POINTING AT IT

            col_row = col_rowInSelectedText();
            textBlock.color(col_row ? [1,.5,.5] : [1,1,1]);

            // FIND WHAT WORD OR PHRASE WITHIN THE TEXT BLOCK THE USER IS POINTING AT

            if (col_row) {

               let { col, row } = col_row;

               // IF THERE IS A LINE OF TEXT HERE, THEN SELECT TEXT AT POINTER

               let text = textBlock.child(1);
               let line = clay.textLine(text, row);

               if (line.length > col) {

	          // RIGHT DRAG OVER TEXT TO SELECT AN ENTIRE PHRASE

                  if (isPressed.right && ! wasPressed.right)
		     textSelectionStart = col;
                  if (isPressed.right)
		     textSelectionEnd = col;

                  let c0 = col, c1 = col;

                  // IF A DRAG SELECTION, EXPAND THE TEXT SELECTION REGION

                  if (textSelectionStart >= 0 && textSelectionEnd >= 0) {
                     c0 = Math.min(textSelectionStart, textSelectionEnd);
                     c1 = Math.max(textSelectionStart, textSelectionEnd) + 1;
                  }

                  // FIND THE BEGINNING AND END OF THE WORD OR PHRASE THE USER IS POINTING AT

                  let inWord = c => /^[-a-z0-9]$/i.test(line.charAt(c));
                  while (c0 > 0           && inWord(c0-1)) c0--;
                  while (c1 < line.length && inWord(c1  )) c1++;

                  // REMEMBER THE SELECTED WORD OR PHRASE

                  selectedText = line.substring(c0, c1);

                  // VISUALLY HIGHLIGHT THAT WORD OR PHRASE

                  let m = titleBar.getMatrix();
                  highlightBar.setMatrix(m)
                              .move(0, -.0008-.0037*textSize, .0004+.0001*textSize)
                              .scale(inch/24, inch/12, 6)
                              .move((c0*textSize + 9) * 4, -(row*textSize + nSelect + 3.1) * 4, 0)
                              .scale(2 * textSize * (c1-c0), 2 * textSize, 1)
                              .move(1, -1, 0);
               }
            }
         }
      }

      // SET THE ARTICLE'S TITLE BAR COLOR

      if (article && titleBar) {
         titleBar.child(1).opacity(1);
         titleBar.child(0).color(isMovingArticle
	                         ? isOpen
				   ? [0,.25,.5]
				   : [0,.5,.25]
				 : isInTitleBar('left')
	                           ? isOpen
				     ? [0,.5,1]
				     : [0,1,.5]
				   : isRightDraggingInTitleBar
				     ? isBesideBar('right', -1, 1)
				       ? [.5,0,0]
				       : isBesideBar('right', -1, -1)
				         ? isOpen
					   ? [1,1,0]
					   : [1,1,1]
				         : isOpen
					   ? [1,.15,.15]
					   : [1,.5,.5]
				     : isInTitleBar('right')
				       ? isOpen
				         ? [1,.5,.5]
				         : [1,1,.5]
				       : isOpen
				         ? [1,1,1]
				         : [1,1,0]);
      }

      // REMEMBER THE CURRENT PRESS STATE TO USE IN THE NEXT ANIMATION FRAME

      for (let hand in {left:0,right:0})
         wasPressed[hand] = isPressed[hand];
   }
}

// ALL THE ARTICLE NODES WILL GO INTO THIS ARRAY

let articleNodes = [];

export const init = async model => {

   // CREATE THE CONTROLLER BEAMS

   model.beam = {
      left:  new ControllerBeam(model, 'left'),
      right: new ControllerBeam(model, 'right')
   };

   // SEND ALL TRIGGER/PINCH EVENTS TO ALL ARTICLE NODES

   inputEvents.onPress = hand => {
      for (let n = 0 ; n < articleNodes.length ; n++)
         articleNodes[n].onPress(hand);
   }
       
   inputEvents.onDrag = hand => {
      for (let n = 0 ; n < articleNodes.length ; n++)
         articleNodes[n].onDrag(hand);
   }
       
   inputEvents.onRelease = hand => {
      for (let n = 0 ; n < articleNodes.length ; n++)
         articleNodes[n].onRelease(hand);
   }

   // CREATE THE FIRST ARTICLE NODE
       
   let articleNode = new ArticleNode(model, 'Virtual reality');
   articleNode.setPosition([0,1,0]);
   articleNodes.push(articleNode);

   // AT EACH ANIMATION FRAME, UPDATE ALL OBJECTS

   model.animate(() => {
      model.beam.left.update();
      model.beam.right.update();
      for (let n = 0 ; n < articleNodes.length ; n++)
         articleNodes[n].update();
   });
}

