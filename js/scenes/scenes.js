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
         { name: "shapes"     , path: "./shapes.js"     , public: true },
         { name: "joints"     , path: "./joints.js"     , public: true },
         { name: "wire"       , path: "./wire.js"       , public: true },
         { name: "inputTest1" , path: "./inputTest1.js" , public: true },
      ]
   };
}

