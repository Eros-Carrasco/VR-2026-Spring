import { split } from "../render/core/cg.js";
import { texts } from "../util/texts.js";
import { fetchWikipediaFullArticle } from "../fetchWikipediaArticle.js";

export const init = async model => {
   fetchWikipediaFullArticle('Virtual_reality', text => {
      let myText = clay.text(split(text, 100), 166);
      model.add(myText).move(-.6,1.75,0).scale(.25).color(0,0,0);
   });
   model.animate(() => {});
}

