import { split } from "../render/core/cg.js";

export const init = async model => {
   model.animate(() => {
      // 1. Limpiamos los hijos en cada frame para poder actualizar el texto dinámicamente
      while (model.nChildren()) {
         model.remove(0);
      }

      // 2. Generamos datos dinámicos. 
      // (Reemplaza estos valores con la posición real de tu controller si la tienes disponible)
      let time = (Date.now() * 0.001).toFixed(2);
      let simulatedX = Math.sin(time).toFixed(3);
      let simulatedY = Math.cos(time).toFixed(3);

      let dynamicString = `TELEMETRY DATA\nTime: ${time}s\nCtrl X: ${simulatedX}\nCtrl Y: ${simulatedY}`;
      
      // 3. Creamos el objeto de texto
      let myText = clay.text(dynamicString, true);

      // 4. Renderizamos un fondo (pantalla) y el texto dinámico encima
      model.add('square').move(0, 1.5, -0.01).scale(.5, .4, 1).color(0, 0.1, 0.2).opacity(0.8);
      model.add(myText).move(-.4, 1.7, 0).color(0, 1, 0.5).scale(.6); // Color verde neón
   });
}