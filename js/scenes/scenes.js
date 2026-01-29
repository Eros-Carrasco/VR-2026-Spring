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
         { name: "shapes" , path: "./shapes.js" , public: true },
         { name: "joints" , path: "./joints.js" , public: true },
         { name: "procedural" , path: "./procedural.js" , public: true },
         { name: "water" , path: "./water.js" , public: true },
         { name: "controllers" , path: "./controllers.js" , public: true }

      ]
   };
}

