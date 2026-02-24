import { texts } from "../util/texts.js";
import { fetchWikipediaFullArticle } from "../fetchWikipediaArticle.js";

export const init = async model => {
   for (let z = -10 ; z <= 0 ; z += .5) {
      let text = 'abcdefghijklmnopqrstuvwxyz\nABCDEFGHIJKLMNOPQRSTUVWXYZ\n0123456789~!@#$%^&*()_+[]|\n' + (.5-z);
      model.add(clay.text(text)).move(-.15,1-.04*z*z,z).color(0,0,0);
   }
   model.animate(() => {});
}

