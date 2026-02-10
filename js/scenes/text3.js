import { texts } from "../util/texts.js";

export const init = async model => {
   model.animate(() => {
      let myText = clay.text(texts[5], true);
      while (model.nChildren())
         model.remove(0);
      for (let t = 0 ; t < 2 ; t++) {
         let z = 3 * t - 3;
         let x = -.5 * t;
         model.add('square').move(x,1.5,z-.001).scale(.38,.44,1).opacity(.8);
         model.add(myText).move(x-.305,1.89,z).color(0,0,0).scale(.8);
         for (let n = 0 ; n < 8 ; n++)
            model.add(myText).move(x+.29,1.9-.1*n,z).color(0,0,0).scale(.1);
      }
   });
}

