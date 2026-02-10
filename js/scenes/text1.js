import { texts } from "../util/texts.js";

export const init = async model => {
   model.animate(() => {
      let myText = clay.text(texts[4]);
      while (model.nChildren())
         model.remove(0);
      model.add('square').move(0,1.5,-.001).scale(.35).color(0,0,0).opacity(.8);
      model.add(myText).move(-.3,1.8 ,0).color(1,1,1).scale(1);
      model.add(myText).move(-.1,1.45,0).color(1,1,1).scale(.1);
   });
}

