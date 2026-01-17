import * as global from "../global.js";
import { Gltf2Node } from "../render/nodes/gltf2.js";

// export let buddha;

export default () => {
   global.scene().addNode(new Gltf2Node({
      url: ""
   })).name = "backGround";

   return {
      enableSceneReloading: true,
      scenes: [ 
         { name: "example1" , path: "./example1.js" , public: true },
         { name: "shapes"   , path: "./shapes.js"   , public: true },
      ]
   };
}

