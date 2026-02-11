import { texts } from "../util/texts.js";
import { readFile, writeFile } from "../file.js";

export const init = async model => {
   let color = [.25,.375,.5];
   readFile('../media/text/sample1.txt', text => {
      let myText = clay.text(text, true);
      model.add(myText).move(-.40,2,0).color(color).scale(1/3);
      model.add(myText).move(-.50,0,.1).turnY( Math.PI/2).move(-.75,2,0).color(color).scale(1/3);
      model.add(myText).move( .50,0,.1).turnY(-Math.PI/2).move(-.05,2,0).color(color).scale(1/3);
   });
   //writeFile('myTestFile.txt', 'This will be written to a local file.');
   model.animate(() => {});
}

