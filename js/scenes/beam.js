import * as cg from "../render/core/cg.js";
import { ControllerBeam } from "../render/core/controllerInput.js";

// INTERSECT CONTROLLER BEAMS WITH A RECTANGLE.

export const init = async model => {
   const inch = .0254, y = 1;
   let round = t => ((t+'').charAt(0) == '-' ? '' : ' ') + cg.round(t);
   let rect = model.add('square').move(0,y,0).scale(.2,.1,1);
   let beamL = new ControllerBeam(model, 'left');
   let beamR = new ControllerBeam(model, 'right');

   model.animate(() => {
      rect.color(.25,.35,.5);
      while (model.nChildren() > 1)
         model.remove(1);

      // LEFT CONTROLLER BEAM SHOWS TEXT OF U,V,D AND MAKES A STEADY VIBRATION

      beamL.update();
      let uvdL = beamL.hitRect(rect.getGlobalMatrix());
      if (uvdL) {
         rect.color(1,1,1);
         let u = uvdL[0], v = uvdL[1], d = uvdL[2];
         let text = 'u:' + round(u) + '\nv:' + round(v) + '\nd:' + round(d);
         model.add(clay.text(text)).move(-.036,y+.03,.001)
	                           .scale(.02/inch).color(0,0,0);
	 vibrate('left', u*u < .033 && v*v < .09 ? 1 : .4);
      }

      // RIGHT CONTROLLER BEAM MOVES A TARGET OBJECT AND MAKES A PULSED VIBRATION

      beamR.update();
      let uvdR = beamR.hitRect(rect.getGlobalMatrix());
      if (uvdR) {
         rect.color(1,.5,.5);
         let u = uvdR[0], v = uvdR[1];
         model.add('diskZ').move(.2*u,y+.1*v,.001).scale(.01).color(0,0,0).dull();
	 if (model.time % .04 < .02)
	    vibrate('right', 1, 20);
      }
   });
}
