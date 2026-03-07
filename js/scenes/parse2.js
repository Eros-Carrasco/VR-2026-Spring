import * as cg from "../render/core/cg.js";
import { ControllerBeam } from "../render/core/controllerInput.js";
import { fetchWikipediaFullArticle, parseArticle } from "../fetchWikipediaArticle.js";

// INTERACTIVELY EXPLORE WIKIPEDIA ARTICLES WITH CONTROLLERS OR WITH HANDS

export const init = async model => {
   const inch = .0254, cw = .01271;
   const linesPerPage = 68;
   const x0 = -.2, y0 = 1.5;

   let selectedText = null, isStartingTextSelection, isDraggingText;
   let textSelectionStart = -1, textSelectionEnd = -1;

   let modelPos = [0,0,0], modelScale = .8;

   let articleName = 'Virtual reality', title, highlight;
   let y = y0;

   // DECLARE THE LEFT AND RIGHT CONTROLLER BEAM INTERFACES

   let beam = {
      left:  new ControllerBeam(model, 'left'),
      right: new ControllerBeam(model, 'right')
   };

   // HANDLE INPUT EVENTS

   let isPressed = { left: false, right: false }, isLocked = false, nSelect = -1;

   let handPos = {left:[0,0,0], right:[0,0,0]};

   inputEvents.onPress = hand => {
      isPressed[hand] = true;
      handPos[hand] = inputEvents.pos(hand);

      // PINCH AND HOLD WITH LEFT HAND OR RIGHT CONTROLLER TO SELECT LONGER TEXT

      if (nSelect >= 0 && (hand == 'left'  &&   window.handtracking ||
                           hand == 'right' && ! window.handtracking))
         isStartingTextSelection = true;
   }

   inputEvents.onDrag = hand => {
      if (hand == 'right' && window.handtracking)
         modelPos = cg.add(modelPos, cg.subtract(inputEvents.pos(hand), handPos[hand]));
      handPos[hand] = inputEvents.pos(hand);
   }

   inputEvents.onRelease = hand => {
      isPressed[hand] = false;
      if (hand == 'left' && ! window.handtracking)
         isLocked = ! isLocked;
      if (hand == 'right' && ! window.handtracking || hand == 'left' && window.handtracking)
         console.log(selectedText);

      if (hand == 'left'  &&   window.handtracking ||
          hand == 'right' && ! window.handtracking) {
         isDraggingText = false;
	 textSelectionStart = textSelectionEnd = -1;
      }
   }

   // ADD A SECTION TO THE VISUALIZATION OF THE WIKIPEDIA ARTICLE

   let addNode = (node, x, level) => {

      let obj = model.add();

      // ADD THE INTERACTION HANDLE TO THE LEFT OF THE SECTION NAME LABEL

      obj.add().move(x0 + (x-x0)/2, y -= inch, 0).scale((x-x0)/2,inch/2,2*inch)
               .add('square').scale(1,1/1.1,1).dull().opacity(.75);

      // ADD THE SECTION NAME LABEL

      let label = obj.add().move(x, y+inch/2, 0);
      if (node.name) {
         let nc = node.name.length;
         label.add('square').move(nc*cw/2, -inch/2, 0).scale(nc*cw/2, inch/2.2, 1).opacity(.6);
         label.add(clay.text(node.name)).move(0,0,.0001).color(0,0,0);
      }

      // ADD THE SECTION TEXT, IF ANY

      let text = cg.split(node.text, 75);
      if (text.length) {
         let section = obj.add().move(x0+9*cw,y-inch*2/3,.0002).scale(.4);
	 let textForm = clay.text(text, linesPerPage);
         let { lo, hi } = clay.meshBounds(textForm);
	 section.add('square').move ((lo[0]+hi[0])/2-.008,
	                             (lo[1]+hi[1])/2-.000, 0)
			      .scale((hi[0]-lo[0])/2+.016,
			             (hi[1]-lo[1])/2+.016, 1).opacity(.001);
	 section.add(textForm).color(0,0,0).move(0,0,.0001).opacity(.001);
      }

      // DO THIS RECURSIVELY THROUGH SUBSECTIONS

      if (node.sections)
         for (let n = 0 ; n < node.sections.length ; n++)
            addNode(node.sections[n], x + 3*cw, level+1);
   }

   // FETCH AND PARSE THE WIKIPEDIA ARTICLE, AND DECLARE THE TITLE AND CURSOR HIGHLIGHT OBJECTS

   fetchWikipediaFullArticle(articleName, text => {
      if (text) {
         let node = parseArticle(text);
         addNode(node, x0, 0);

         title = model.add().move(x0,y0+1.5*inch,0).scale(3);
	 let nc = articleName.length;
	 title.add('square').move(nc*cw/2,-inch/2,.001).scale(nc*cw/2,inch/2,1).opacity(.8);
	 title.add(clay.text(articleName)).move(0,0,.002).color(0,0,0);

	 highlight = model.add('square').opacity(.7).scale(0);
      }
   });

   model.animate(() => {

      model.identity().move(modelPos).scale(modelScale);

      beam.left.update();
      beam.right.update();

      // POSITION OF MY FINGER RELATIVE TO AN INTERACTION BAR

      let fingerRelToBar = (hand, n) => {
         let obj = model.child(n);
	 let m = obj.child(0).getGlobalMatrix();
         m = cg.mMultiply(cg.mInverse(worldCoords), m);
         let p = inputEvents.pos(hand);
	 return p ? cg.mTransform(cg.mInverse(m), [p[0],p[1]+inch/2*modelScale,p[2]]) : null;
      }

      // IS MY FINGER IN AN INTERACTION BAR?

      let isFingerInBar = (hand, n) => {
	 let p = fingerRelToBar(hand, n);
	 return p && Math.max(p[0]*p[0], p[1]*p[1], p[2]*p[2]) < 1;
      }

      // IS MY FINGER TO THE LEFT OF AN INTERACTION BAR?

      let isFingerLeftOfBar = (hand, n) => {
	 let p = fingerRelToBar(hand, n);
	 return p[0] < -1 && p[1]*p[1] < 1 && p[2]*p[2] < 1;
      }

      let isAnyHit = false;

      // LEFT HAND INTERACTION AND DISPLAY LOGIC WHEN SOME SELECTION IS LOCKED

      if (isLocked) {
         for (let n = 0 ; n < model.nChildren() ; n++) {

            if (window.handtracking && n == nSelect)
	       for (let hand in {left:0,right:0})
	          if (isFingerInBar(hand, n))
	             isLocked = false;

            let obj = model.child(n);
	    if (! obj.child(0) || obj == title || obj == highlight)
	       continue;

	    obj.child(0).color(n == nSelect ? [0,0,0] : [1,1,1]);
	    if (obj.child(1))
	       obj.child(1).opacity(n > nSelect ? .25 : 1);
	    if (obj.child(2)) {
	       obj.child(2).child(0).opacity(n == nSelect ? 0.8 : .001);
	       obj.child(2).child(1).opacity(n == nSelect ? 1.0 : .001);
            }
         }
      }

      // LEFT HAND INTERACTION AND DISPLAY LOGIC WHEN NO SELECTION IS LOCKED

      else {
         let isHitNoText = false;
         for (let n = 0 ; n < model.nChildren() ; n++) {
            let obj = model.child(n);
	    if (! obj.child(0) || obj == title || obj == highlight)
	       continue;

	    let isText = obj.child(2);
	    let isHit = false;

	    let m = obj.child(0).getGlobalMatrix();

	    for (let hand in {left:0,right:0})
	       if (window.handtracking) {
	          if (isFingerInBar(hand, n))
		     isHit = true;
	          if (n == nSelect && isFingerLeftOfBar(hand, n))
	             isLocked = isHit = true;
	       }
	       else if (beam[hand].hitRect(m))
		  isHit = true;

	    if (isHit && isText)
	       nSelect = n;
	    if (isHit && ! isText)
	       isHitNoText = true;
	    obj.child(0).color(isHit ? isText ? [0,.5,1] : [1,.25,.25] : [1,1,1]);
	    if (isText) {
               obj.child(2).child(0).opacity(isHit ? 0.8 : .001);
               obj.child(2).child(1).opacity(isHit ? 1.0 : .001);
            }
            isAnyHit |= isHit;
         }
	 if (isHitNoText)
	    isAnyHit = false;

         for (let n = 0 ; n < model.nChildren() ; n++)
	    if (model.child(n).child(1))
	       model.child(n).child(1).opacity(isAnyHit && n > nSelect ? .25 : 1);
      }

      // WHEN A SECTION IS SELECTED, AND IF THERE IS ANY TEXT IN THAT SECTION,
      // HIGHLIGHT WHERE THE RIGHT CONTROLLER BEAM FOR FINGER IS POINTING IN THE TEXT.

      selectedText = null;
      if (nSelect >= 0) {
         let obj = model.child(nSelect);
	 if (obj.child(2)) {
	    let section = obj.child(2);

	    let isHit = false;

	    // RETRIEVE THE VISIBLE BOUNDS OF THE TEXT BLOCK

	    let text = section.child(1);
	    let m = text.getGlobalMatrix();
	    let { lo, hi } = clay.meshBounds(text.getForm());
	    lo[0] -= .008;
	    lo[1] -= .016;
	    hi[0] += .008;
	    hi[1] += .008;

	    // FIND WHETHER / WHERE THE USER IS POINTING WITHIN THE TEXT BLOCk

            let p;
            if (window.handtracking) {
	       let im = cg.mMultiply(cg.mInverse(m), worldCoords);
	       p = cg.mTransform(im, inputEvents.pos('right'));
	       isHit = p[0] > lo[0] && p[0] < hi[0] &&
	               p[1] > lo[1] && p[1] < hi[1] &&
		       p[2] > 0 && p[2] < 8*inch;
	    }
	    else {
               p = beam.right.hitRect(m);
	       isHit = p && p[0] > lo[0] && p[0] < hi[0] &&
	                    p[1] > lo[1] && p[1] < hi[1] ;
	    }

	    section.color(isHit ? [1,.5,.5] : [1,1,1]);

	    highlight.scale(0);
            if (isHit) {

	       // FIND THE COLUMN AND ROW WITHIN THE TEXT WHERE THE USER IS POINTING

	       let col = Math.max(0,  p[0]) / cw   >> 0;
	       let row = Math.max(0, -p[1]) / inch >> 0;
	       row = Math.min(row, -lo[1] / inch >> 0);

	       // IF THERE IS A LINE OF TEXT HERE, THEN

               let line = clay.textLine(text, row);
	       if (line.length <= col)
	          highlight.scale(0);
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

		  // SAVE THE SELECTED WORD

		  selectedText = line.substring(c0, c1);

		  // VISUALLY HIGHLIGHT THAT WORD

	          let m = title.getMatrix();
	          highlight.setMatrix(m)
                           .scale(cw/12,inch/12,1)
	                   .move((c0*.4 + 8.95) * 4, -(row*.4 + nSelect + 1.1) * 4, .0001)
			   .scale(.8,1,1)
			   .scale(c1-c0,1,1)
	                   .move(1,-1,0);
	       }
	    }
	 }
      }

      if (title)
         title.child(1).opacity(1);
   });
}
