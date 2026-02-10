import * as global from "../global.js";
import { Gltf2Node } from "../render/nodes/gltf2.js";

export default () => {
   global.scene().addNode(new Gltf2Node({
      url: ""
   })).name = "backGround";

   return {
      enableSceneReloading: true,
      scenes: [ 
         { name: "shapes"       , path: "./shapes.js"       , public: true },
         { name: "joints"       , path: "./joints.js"       , public: true },
         { name: "inputTest1"   , path: "./inputTest1.js"   , public: true },
         { name: "flag"         , path: "./flag.js"         , public: true },
         { name: "bouncing"     , path: "./bouncing.js"     , public: true },
         { name: "multiplayer1" , path: "./multiplayer1.js" , public: true },
         { name: "text1"        , path: "./text1.js"        , public: true },
         { name: "text2"        , path: "./text2.js"        , public: true },
         { name: "text3"        , path: "./text3.js"        , public: true },
      ]
   };
}

