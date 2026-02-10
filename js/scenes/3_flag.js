/*
   This scene is an example of how to use procedural texture
   to animate the shape of an object. In this case the object
   is a waving flag. The noise function is used to animate
   the position of each vertex of the flag geometry.
*/

import * as cg from "../render/core/cg.js";

export const init = async model => {

   // DEFINE A NEW TERRAIN OBJECT TYPE AS A 30x20 GRID.

   clay.defineMesh('myTerrain', clay.createGrid(30, 30));

   clay.defineMesh('myPlane', clay.createGrid(60, 60));

   // LOAD A CHECKERBOARD TEXTURE FOR IT.

   model.txtrSrc(1, '../media/textures/water_vase.jpg');
   model.txtrSrc(2, '../../media/eros/textures/water.png');
   model.txtrSrc(3, '../media/textures/chessboard.png');



   // INSTANTIATE THE NEW TERRAIN OBJECT.

   let terrain = model.add('myTerrain').txtr(1);
   // let plane = model.add('myPlane').txtr(2);
   let sphere = model.add('sphere').txtr(2);
   

   // MOVE THE OBJECT INTO PLACE.

   terrain.identity().move(-.2, 2, 0).scale(.15);
   // plane.identity().move(-.4, 1.5, 0).scale(.15);
   sphere.identity().move(0, 1.5, 0).scale(.15);


   model.flagImpactForce = 0.1;
   model.sphereImpactForce = 0.1;

   inputEvents.onPress = hand => {
      if (isXR) {
         // Activamos el impacto en los tres objetos
         model.flagImpactForce = 1.0;
         model.sphereImpactForce = 1.0;
      }
   }

   model.animate(() => {

      let damping = (force) => force > 0.1 ? force * 0.9 : 0.1;
      
      model.sphereImpactForce = damping(model.sphereImpactForce);
      model.flagImpactForce = damping(model.flagImpactForce);

      terrain.setVertices((u, v) => {
         return [3 * u,
         3 * v - 1,
         model.flagImpactForce * u * cg.noise(3 * u - model.time, 3 * v, model.time)
         ];
      });

      sphere.setVertices((u, v) => {
         let theta = 2 * Math.PI * u;
         let phi = Math.PI * v;

         let x = Math.cos(theta) * Math.sin(phi);
         let y = Math.sin(theta) * Math.sin(phi);
         let z = Math.cos(phi);

         let noise = model.sphereImpactForce * cg.noise(x, y, z + model.time);
         let r = 1 + noise;

         return [r * x, r * y, r * z];
      });

      // cube.setVertices((u, v, f) => {
      //    let p = cg.cubeFace(u, v, f); 
      //    if (!p) return [u, v, 0]; 

      //    let x = p[0], y = p[1], z = p[2];

      //    let noise = model.cubeImpactForce * cg.noise(x * 4, y * 4, z * 4 + model.time);
         
      //    let scale = 1 + noise;

      //    return [x * scale, y * scale, z * scale];
      // });

   });
}

