import { texts } from "../util/texts.js";
import { readFile, writeFile } from "../file.js";

export const init = async model => {
   let color = [2,2,2];
   readFile('../media/text/sample1.txt', text => {
      let myText = clay.text(text, true);
      for (let n = 0 ; n < 10 ; n++) {
         let theta = 2 * Math.PI * n / 10;
         model.add(myText).turnY(theta).move(0,2,-1.6).color(color).scale(.6).move(-.8,0,0);
      }
   });
   model.animate(() => {});
}

