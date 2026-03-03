import * as cg from "../render/core/cg.js";

// Highlight the object that is nearest to the head gaze direction.

export const init = async model => {
   for (let u = -3 ; u <= 3 ; u++)
   for (let v = -3 ; v <= 3 ; v++)
   for (let w = -3 ; w <= 3 ; w++)
      if (u*u > 4 || v*v > 4 || w*w > 4)
         model.add().move(u/3,v/3+1.5,w/3+.5).scale(.1).add('sphere');

   model.animate(() => {
      let nMin = -1, dMin = 1000;
      let mm = cg.mMultiply(clay.root().viewMatrix(0), worldCoords);
      for (let n = 0 ; n < model.nChildren() ; n++) {
         let m = cg.mMultiply(mm, model.child(n).getMatrix());
         let d = m[12]*m[12] + m[13]*m[13];
	 if (m[14] < 0 && d < dMin) {
	    dMin = d;
	    nMin = n;
	 }
      }
      for (let n = 0 ; n < model.nChildren() ; n++)
         model.child(n).child(0).color(n == nMin ? [1,0,0] : [1,1,1])
	                        .identity().scale(n == nMin ? 1 : .7);
   });
}

