import * as cg from '../render/core/cg.js';
import { Channel } from '../render/core/channel.js';

let isGreenScreen = false;

export const init = async model => {

   let offset = [0,1.3,0], scale = .3;

   let W = [0,0,0], isDragging = false;

   inputEvents.onPress = hand => {
      if (hand == 'right')
         isDragging = true;
   }

   inputEvents.onRelease = hand => {
      if (hand == 'right')
         isDragging = false;
   }

   inputEvents.onDrag = hand => {
      //if (hand == 'right')
         W = cg.scale(cg.subtract(inputEvents.pos(hand), offset), 1/scale);
   }

   inputEvents.onRelease = hand => {
/*
      if (hand == 'left')
         isGreenScreen = ! isGreenScreen;
*/
   }

   //model.add('cube').move(0,1.5,-3).color(.2,.3,.5).scale(.5,1.5,1);

   let greenScreen = model.add('square').color(0,1,0).dull();

   let shoulder = model.add();
   shoulder.add('tubeZ').scale(.14).color(0,.5,1);

   let elbow = model.add();
   elbow.add('tubeZ').scale(.13).color(.5,.4,0);

   let wrist = model.add();
   wrist.add('sphere').scale(.12).color(1,0,0);

   model.add('tubeY').move(0,-.24,0).scale(.2,.1,.2);

   let upperArm = model.add('cube').color(.5,.5,.5);;
   let lowerArm = model.add('cube').color(.5,.5,.5);


   let L1 = .65, L2 = .8;

   model.animate(() => {

      if (! isDragging)
         W = [-.5 + .2 * Math.cos(model.time),
              1.1 + .2 * Math.sin(model.time), .2 * Math.sin(3*model.time)];

      let sgn = Math.sign(W[0]);

      let yaw = W[0] == 0 ? 0 : Math.atan2(W[2], sgn * W[0]);

      model.opacity(.8).identity().move(offset).turnY(yaw).scale(scale);

      W = [sgn * Math.sqrt(W[0]*W[0] + W[2]*W[2]), W[1], 0];

      let E = cg.ik(L1,L2,W,[1,1,0]);

      wrist.identity().move(W);

      elbow.identity().move(E);

      upperArm.identity().move(cg.scale(E,.5)).aimZ(E).scale(.04,.04,L1/2);

      lowerArm.identity().move(cg.mix(E,W,.5)).aimZ(cg.subtract(W,E)).scale(.04,.04,L2/2);

      greenScreen.identity().move(0,1.2,-1).scale(isGreenScreen ? 10 : 0);
   });
}
