import { split } from "../render/core/cg.js";

export const init = async model => {

   console.log("Clay Object:", clay);
   console.log("Model Object:", model)

   let weatherStr = "Fetching weather...";

   // NYC (Lat: 40.71, Lon: -74.00) - Open-Meteo API
   fetch('https://api.open-meteo.com/v1/forecast?latitude=40.7128&longitude=-74.0060&current_weather=true')
      .then(res => res.json())
      .then(data => {
         let tempC = data.current_weather.temperature;
         let windKmh = data.current_weather.windspeed;

         let tempF = (tempC * 9 / 5 + 32).toFixed(0);
         let windMph = (windKmh / 1.60934).toFixed(0);

         weatherStr = `${tempC}C (${tempF}F) | Wind: ${windKmh} km/h (${windMph} mph)`;
      })
      .catch(err => { weatherStr = "Weather offline"; });

   model.animate(() => {
      while (model.nChildren()) model.remove(0);

      // NYC Time
      let options = { timeZone: 'America/New_York', timeStyle: 'medium', dateStyle: 'short' };
      let nycTime = new Date().toLocaleString('en-US', options);

      // Controls coordinates
      let rightText = "Right Controller: (N/A, N/A, N/A)";
      let leftText = "Left Controller:  (N/A, N/A, N/A)";


      if (clay && clay.controllerWidgets) {
         // Right
         if (clay.controllerWidgets.right) {
            let rPos = clay.controllerWidgets.right.getO();
            if (rPos && rPos.length >= 3) {
               let rx = rPos[0].toFixed(2);
               let ry = rPos[1].toFixed(2);
               let rz = rPos[2].toFixed(2);
               rightText = `Right Controller: (${rx}, ${ry}, ${rz})`;
            }
         }

         // Left
         if (clay.controllerWidgets.left) {
            let lPos = clay.controllerWidgets.left.getO();
            if (lPos && lPos.length >= 3) {
               let lx = lPos[0].toFixed(2);
               let ly = lPos[1].toFixed(2);
               let lz = lPos[2].toFixed(2);
               leftText = `Left Controller:  (${lx}, ${ly}, ${lz})`;
            }
         }
      }


      let dynamicString = `NYC Time: ${nycTime}\nWeather: ${weatherStr}\n${rightText}\n${leftText}`;

      let myText = clay.text(dynamicString, true);

      let smartwatch = model.add();

      // Fondo azul
      smartwatch.add('square').move(0, 0, -0.01).scale(.85, .4, 1).color(0, 0.1, 0.2).opacity(0.8);
      // Texto verde
      smartwatch.add(myText).move(-.80, 0.3, 0).color(0, 1, 0.5).scale(2.8);

      if (clay && clay.controllerWidgets && clay.controllerWidgets.left) {

         smartwatch.setMatrix(clay.controllerWidgets.left.getMatrix());

         smartwatch.move(0, 4, -2).turnX(-0.8).scale(5);

      } else {
         smartwatch.move(0, 1.5, 0).scale(0.8);
      }

   });
}