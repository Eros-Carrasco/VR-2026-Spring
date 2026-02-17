import { split } from "../render/core/cg.js";
import { readFile, writeFile } from "../file.js";
import { fetchWikipediaArticle } from "../fetchWikipediaArticle.js";

export const init = async model => {
   let visitCount = 1;
   let titleText = null;

   // 1. Leemos el archivo local para ver cuántas veces hemos iniciado sesión
   readFile('visit_state.txt', text => {
      if (text) visitCount = parseInt(text) + 1;
      // Guardamos el nuevo contador
      writeFile('visit_state.txt', visitCount.toString());
      // Creamos el texto del título basado en el archivo local
      titleText = clay.text(`Session ID: ${visitCount}\nWelcome back!`, true);
   });

   // 2. Obtenemos un artículo interesante de Wikipedia
   fetchWikipediaArticle('Cybernetics', text => {
      let articleText = clay.text(split(text, 50));
      let color = [0.8, 0.9, 1];

      model.animate(() => {
         while (model.nChildren()) {
            model.remove(0);
         }

         // Mostramos el texto del estado de la sesión si ya cargó
         if (titleText) {
            model.add(titleText).move(-.3, 2.2, 0).color(1, 0.8, 0).scale(.8);
         }

         // Hacemos un carrusel cilíndrico de texto que gira lentamente
         let rotationOffset = Date.now() * 0.0002;
         for (let n = 0; n < 8; n++) {
            let theta = (2 * Math.PI * n / 8) + rotationOffset;
            model.add(articleText)
               .turnY(theta)
               .move(0, 1.5, -2) // Radio del cilindro
               .color(color)
               .scale(.5)
               .move(-.8, 0, 0); // Centrado de la columna
         }
      });
   });
}