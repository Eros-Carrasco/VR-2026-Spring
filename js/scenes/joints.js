/*
   Create and animate hierarchical joints.
*/

export const init = async model => {

   // CREATE NODES WITH NO SHAPES AS JOINTS FOR ANIMATION.

   let shoulder = model.add();
   let elbow    = shoulder.add();

   // CREATE AND PLACE SHAPES THAT WILL MOVE WITH EACH JOINT.

   shoulder.add('tubeZ').scale(.2,.2,.13).color(0,0,1);
   shoulder.add('tubeX').move(.5,0,0).scale(.5,.1,.1);

   elbow.add('tubeZ').scale(.18,.18,.12).color(0,0,1);
   elbow.add('tubeX').move(.5,0,0).scale(.5,.08,.08);
   elbow.add('sphere').move(1,0,0).scale(.16).color(1,0,0);

   // ANIMATE THE JOINTS OVER TIME.

   model.move(0,1.5,0).scale(.4).animate(() => {

      shoulder.identity()
              .move(-1,0,0)
	      .turnY(Math.cos(model.time)/2)
	      .turnZ(Math.cos(2*model.time)/2);

      elbow.identity()
           .move(1,0,0)
	   .turnZ(Math.sin(2*model.time)*.7+.7);
   });
}
