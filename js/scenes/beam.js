import * as cg from "../render/core/cg.js";
import { ControllerBeam } from "../render/core/controllerInput.js";

// TRACK THE BEAM FROM THE LEFT CONTROLLER, AND USE IT TO INTERSECT WITH A RECTANGLE.
// SHOW THE LOCATION OF THE BEAM WITHIN THE RECTANGLE, AND BEAM LENGTH TO THE RECTANGLE.

export const init = async model => {
   let round = t => ((t+'').charAt(0) == '-' ? '' : ' ') + cg.round(t);
   const inch = .0254, cw = .01271;
   let rect = model.add('square').move(0,1.5,0).scale(.2,.1,1);
   let beam = new ControllerBeam(model, 'left');

   model.animate(() => {
      beam.update();
      let result = beam.hitRect(rect.getGlobalMatrix());
      model.remove(1);
      if (result) {
         rect.color(1,1,1);
         let text = 'u: ' + round(result[0]) + '\nv: ' + round(result[1]) + '\nd: ' + round(result[2]);
         model.add(clay.text(text)).move(-.05,1.52,.001).scale(.02/inch).color(0,0,0);
      }
      else
         rect.color(.25,.35,.5);
   });
}
