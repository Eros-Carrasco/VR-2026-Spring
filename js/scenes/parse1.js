import * as cg from "../render/core/cg.js";
import { fetchWikipediaFullArticle, parseArticle } from "../fetchWikipediaArticle.js";

export const init = async model => {
   let colors = [[1,.8,.8],[.8,.9,1]], colorIndex = 0;
   const cw = .01271;
   let article = 'Virtual reality';
   let y = 1.6;
   let addNode = (node, x) => {
      let color = colors[colorIndex = 1 - colorIndex];
      model.add(clay.text(node.name)).move(x,y-=.045,0).scale(1).color(color);
      let xt = x + cw * node.name.length;
      model.add(clay.text(cg.split(node.text, 105), 17)).move(xt,y,0).scale(.1).color(color);
      if (node.sections)
         for (let n = 0 ; n < node.sections.length ; n++)
            addNode(node.sections[n], x + 3 * cw);
   }
   fetchWikipediaFullArticle(article, text => {
      if (text) {
         let node = parseArticle(text, article);
         addNode(node, -.5);
      }
   });
   model.animate(() => {});
}

