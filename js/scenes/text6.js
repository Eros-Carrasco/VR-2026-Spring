import { split } from "../render/core/cg.js";
import { texts } from "../util/texts.js";
import { fetchWikipediaArticle } from "../fetchWikipediaArticle.js";

export const init = async model => {
   fetchWikipediaArticle('Virtual_reality', text => {
      let myText = clay.text(split(text, 60));
      model.add(myText).move(-.36,1.8 ,0).color(1,1,1);
   });
   model.animate(() => {});
}

