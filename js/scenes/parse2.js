import * as cg from "../render/core/cg.js";
import { ControllerBeam } from "../render/core/controllerInput.js";
import { fetchWikipediaFullArticle, parseArticle } from "../fetchWikipediaArticle.js";

// INTERACTIVELY EXPLORE WIKIPEDIA ARTICLES WITH CONTROLLERS OR WITH HANDS

/*
   To do:
      DONE Left swipe-left with beam to lock/unlock.
      DONE Left swipe-left on titleBar to toggle open/close.
      DONE Drag on titleBar to move article.
      DONE Right swipe-right on titleBar to delete article.

      Get auto-yaw working when worldCoords is rotated.

      Implement good auto-positioning for new articleNodes.

      There should be no multi-column text blocks:

         Text block should only show first text that fits, and
         the amount of text to see should change with distance.

	 To try: dynamically create the selected text block.

      Problem with this: What about highlighted text?
*/

function ArticleNode (model, articleName) {
   const inch = .0254, cw = .01271;
   const linesPerPage = 68;
   const x0 = -.2, y0 = 2.0;

   let article, titleBar, highlightBar;
   let pos = [0,0,0], scale = .8, y = y0;
   let selectedText = '', isStartingTextSelection, isDraggingText;
   let textSelectionStart = -1, textSelectionEnd = -1;
   let isInTitleBar = null, isOpen = true, isLocked = false, nSelect = -1;
   let handPos = {};

   // POSITION OF USER POINTER RELATIVE TO A FOCUS BAR

   let relToBar = (hand, n) => {
      let obj = n < 0 ? titleBar : article.child(n);
      let focusBar = obj.child(0);
      let m = cg.mMultiply(cg.mInverse(worldCoords), focusBar.getGlobalMatrix());
      let p = inputEvents.pos(hand);
      return p ? cg.mTransform(cg.mInverse(m), [p[0],p[1]+inch/2*scale,p[2]]) : null;
   }

   // IS USER POINTER INSIDE A FOCUS BAR?

   let isInBar = (hand, n) => {
      if (window.handtracking) {
         let p = relToBar(hand, n);
         return p && Math.max(p[0]*p[0], p[1]*p[1], p[2]*p[2]) < 1;
      }
      else {
         let obj = n < 0 ? titleBar : article.child(n);
         let focusBar = obj.child(0);
         return model.beam[hand].hitRect(focusBar.getGlobalMatrix()) != null;
      }
   }

   // IS USER POINTER BESIDE A FOCUS BAR?

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

   this.hasFocus = () => {
      for (let n = 0 ; n < article.nChildren() ; n++) {
         let obj = article.child(n);
	 let focusBar = obj.child(0);
         if (! focusBar || obj == highlightBar)
            continue;

         if (window.handtracking)
            if (isInBar('left', n) || n == nSelect && isBesideBar('left', n, -1))
               return true;

         if (! window.handtracking)
	    if (model.beam.left.hitRect(focusBar.getGlobalMatrix()))
               return true;

	 if (positionInSelectedText())
	    return true;
      }
      return false;
   }

   this.onPress = hand => {

      // PINCH AND HOLD WITH LEFT HAND OR RIGHT CONTROLLER TO SELECT LONGER TEXT

      if (nSelect >= 0 && (hand == 'left'  &&   window.handtracking ||
                           hand == 'right' && ! window.handtracking))
         isStartingTextSelection = true;
   }

   this.onDrag = hand => {

      // TO MOVE AN ARTICLE NODE, DRAG ON ITS TITLE BAR.

      for (let hand in {left:0, right:0}) {
         let p = inputEvents.pos(hand);
         if (handPos[hand] && isInBar(hand, -1))
            pos = cg.add(pos, cg.subtract(p, handPos[hand]));
         handPos[hand] = p;
      }
   }

   this.onRelease = hand => {
      delete handPos[hand];

      if (hand == 'left' && ! window.handtracking)
         isLocked = ! isLocked;

      if (hand == 'right' && ! window.handtracking || hand == 'left' && window.handtracking) {
         if (selectedText.length > 0) {
            let articleNode = new ArticleNode(model, selectedText);
	    articleNodes.push(articleNode);
	    articleNode.setPos([x0 + .2 * articleNodes.length, 0, 0]);
         }
      }

      if (hand == 'left'  &&   window.handtracking ||
          hand == 'right' && ! window.handtracking) {
         isDraggingText = false;
         textSelectionStart = textSelectionEnd = -1;
      }
   }

   // ADD A SECTION TO THE VISUALIZATION OF THE WIKIPEDIA ARTICLE

   let addNode = (node, x, level) => {

      let obj = article.add();
      let focusBar  = obj.add();
      let nameBar   = obj.add();
      let textBlock = obj.add();

      // ADD THE FOCUS BAR TO THE LEFT OF THE NAME BAR

      focusBar.move(x0 + (x-x0)/2, y -= inch, 0).scale((x-x0)/2,inch/2,2*inch)
              .add('square').scale(1,1/1.1,1).dull().opacity(.75);

      // ADD THE NAME BAR

      nameBar.move(x, y+inch/2, 0);
      if (node.name) {
         let nc = node.name.length;
         nameBar.add('square').move(nc*cw/2, -inch/2, 0).scale(nc*cw/2, inch/2.2, 1).opacity(.6);
         nameBar.add(clay.text(node.name)).move(0,0,.0001).color(0,0,0);
      }

      // ADD THE TEXT BLOCK, IF ANY

      let text = cg.split(node.text, 75);
      if (text.length) {
         textBlock.move(x0+9*cw,y-inch*2/3,.0002).scale(.4);
         let textForm = clay.text(text, linesPerPage);
         let { lo, hi } = clay.meshBounds(textForm);
         textBlock.add('square').move ((lo[0]+hi[0])/2-.008,
                                       (lo[1]+hi[1])/2-.000, 0)
                                .scale((hi[0]-lo[0])/2+.016,
                                       (hi[1]-lo[1])/2+.016, 1).opacity(.001);
         textBlock.add(textForm).color(0,0,0).move(0,0,.0001).opacity(.001);
      }

      // DO THIS RECURSIVELY THROUGH SUBSECTIONS

      if (node.sections)
         for (let n = 0 ; n < node.sections.length ; n++)
            addNode(node.sections[n], x + 3*cw, level+1);
   }

   // FETCH AND PARSE THE WIKIPEDIA ARTICLE, AND DECLARE THE TITLE AND CURSOR HIGHLIGHT OBJECTS

   article = model.add();

   this.article = article;

   fetchWikipediaFullArticle(articleName, text => {
      if (text) {
         let node = parseArticle(text);
         addNode(node, x0, 0);

         titleBar = article.add().move(x0,y0+1.5*inch,0).scale(3);
         let nc = articleName.length;
         titleBar.add('square').move(nc*cw/2,-inch/2,.001).scale(nc*cw/2,inch/2,1).opacity(.8);
         titleBar.add(clay.text(articleName)).move(0,0,.002).color(0,0,0);

         highlightBar = article.add('square').opacity(.7).scale(0);
      }
   });

   let positionInSelectedText = () => {

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

      let col = Math.max(0,  p[0]) / cw   >> 0;
      let row = Math.max(0, -p[1]) / inch >> 0;
      row = Math.min(row, -lo[1] / inch >> 0);

      return { col: col, row: row };
   }

   this.setPos = p => pos = p;

   this.update = () => {

      // NEED TO FIX: DOES NOT WORK WHEN worldCoords HAS ROTATION

      let wc = worldCoords;
      let m = cg.mInverse(clay.root().viewMatrix(0));
      let p = cg.mTransform(wc, pos);
      let theta = Math.atan2(m[12]-p[0], m[14]-p[2]) - Math.atan2(wc[8], wc[10]);

      article.identity().move(pos).turnY(theta).scale(scale);

      let isAnyHit = false;

      // LEFT HAND INTERACTION AND DISPLAY LOGIC WHEN SOME SELECTION IS LOCKED

      if (isLocked) {
         for (let n = 0 ; n < article.nChildren() ; n++) {

            if (isInBar('left', n))
               isLocked = false;

            let obj = article.child(n);
	    let focusBar  = obj.child(0);
	    let nameBar   = obj.child(1);
	    let textBlock = obj.child(2);

            if (! focusBar || obj == titleBar || obj == highlightBar)
               continue;

            focusBar.color(n == nSelect ? [0,0,0] : [1,1,1]);
            if (nameBar)
               nameBar.opacity(! isOpen ? .001 : n > nSelect ? .25 : 1);
            if (textBlock && textBlock.child(0)) {
               textBlock.child(0).opacity(! isOpen ? .001 : n == nSelect ? 0.8 : .001);
               textBlock.child(1).opacity(! isOpen ? .001 : n == nSelect ? 1.0 : .001);
            }
         }
      }

      // LEFT HAND INTERACTION AND DISPLAY LOGIC WHEN NO SELECTION IS LOCKED

      else {
         let isHitNoText = false;
         for (let n = 0 ; n < article.nChildren() ; n++) {

            let obj = article.child(n);
	    let focusBar  = obj.child(0);
	    let nameBar   = obj.child(1);
	    let textBlock = obj.child(2);

            if (! focusBar || obj == titleBar || obj == highlightBar)
               continue;

            let isText = obj.child(2);
            let isHit = false;

            let m = focusBar.getGlobalMatrix();

            if (isInBar('left', n))
               isHit = true;
            if (n == nSelect && isBesideBar('left', n, -1))
               isLocked = isHit = true;

            if (isHit && textBlock)
               nSelect = n;
            if (isHit && ! textBlock)
               isHitNoText = true;

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

         for (let n = 0 ; n < article.nChildren() ; n++)
            if (article.child(n).child(1))
               article.child(n).child(1).opacity(! isOpen ? .001 : isAnyHit && n > nSelect ? .25 : 1);
      }

      // WHEN A SECTION IS SELECTED, AND IF THERE IS ANY TEXT IN THAT SECTION,
      // HIGHLIGHT WHERE THE RIGHT CONTROLLER BEAM FOR FINGER IS POINTING IN THE TEXT.

      selectedText = '';
      if (nSelect >= 0) {
         let obj = article.child(nSelect);

         let textBlock = obj.child(2);
         if (textBlock) {

            let position = positionInSelectedText();
            textBlock.color(position ? [1,.5,.5] : [1,1,1]);

	    if (position) {

               let { col, row } = position;

               // IF THERE IS A LINE OF TEXT HERE, THEN

               let text = textBlock.child(1);
               let line = clay.textLine(text, row);
               if (line.length <= col)
                  highlightBar.scale(0);
               else {

                  if (isStartingTextSelection) {
                     textSelectionStart = col;
                     isStartingTextSelection = false;
                     isDraggingText = true;
                  }

                  if (isDraggingText)
                     textSelectionEnd = col;

                  let c0 = col, c1 = col;

                  // DRAG SELECTION

                  if (textSelectionStart >= 0 && textSelectionEnd >= 0) {
                     c0 = Math.min(textSelectionStart, textSelectionEnd);
                     c1 = Math.max(textSelectionStart, textSelectionEnd) + 1;
                  }

                  // FIND THE BEGINNING AND END OF THE WORD(S) THE USER IS POINTING AT

                  let inWord = c => /^[-a-z0-9]$/i.test(line.charAt(c));
                     while (c0 > 0           && inWord(c0-1)) c0--;
                  while (c1 < line.length && inWord(c1  )) c1++;

                  // REMEMBER THE SELECTED WORD

                  selectedText = line.substring(c0, c1);

                  // VISUALLY HIGHLIGHT THAT WORD

                  let m = titleBar.getMatrix();
                  highlightBar.setMatrix(m)
                           .scale(cw/12,inch/12,1)
                           .move((c0*.4 + 9) * 4, -(row*.4 + nSelect + 3.1) * 4, .0001)
                           .scale(.8 * (c1-c0), 1, 1)
                           .move(1,-1,0);
               }
            }
         }
      }

      if (article && titleBar) {
         titleBar.child(1).opacity(1);
	 if (isInTitleBar == 'left' && isBesideBar('left', -1, -1)) {
	    isOpen = ! isOpen;
	    if (! isOpen) {
	       nSelect = -1;
	       isLocked = false;
            }
         }
         titleBar.child(0).color(isInTitleBar == 'left' ? [0,.5,1] :
	                         isInTitleBar == 'right' ? [1,0,0] : isOpen ? [1,1,1] : [1,.5,.5]);

         // TO DELETE THE ARTICLE, SWIPE RIGHT ON ITS TITLE BAR WITH THE RIGHT HAND/CONTROLLER

         if (isInTitleBar == 'right' && isBesideBar('right', -1, 1))
            for (let n = 0 ; n < articleNodes.length ; n++)
	       if (articleNodes[n] == this) {
	          articleNodes.splice(n, 1);
		  model.remove(article);
	          return;
	       }

	 isInTitleBar = isInBar('left' , -1) ? 'left'  :
	                isInBar('right', -1) ? 'right' : null;
      }
   }
}

let articleNodes = [];

export const init = async model => {

   // DECLARE THE LEFT AND RIGHT CONTROLLER BEAM INTERFACES

   model.beam = {
      left:  new ControllerBeam(model, 'left'),
      right: new ControllerBeam(model, 'right')
   };

   //model.add('square').move(0,1.5,0).scale(.1);

   articleNodes.push(new ArticleNode(model, 'Virtual reality'));
   //articleNodes.push(new ArticleNode(model, 'Ken Perlin'));
   //articleNodes[1].setPos([.4,0,0]);

   inputEvents.onPress = hand => {
      for (let n = 0 ; n < articleNodes.length ; n++)
	 if (articleNodes[n].hasFocus()) {
            articleNodes[n].onPress(hand);
            inputEvents.onDrag = articleNodes[n].onDrag;
            inputEvents.onRelease = articleNodes[n].onRelease;
	    break;
         }
   }
       
   model.animate(() => {
      model.beam.left.update();
      model.beam.right.update();
      for (let n = 0 ; n < articleNodes.length ; n++)
         articleNodes[n].update();
   });
}

