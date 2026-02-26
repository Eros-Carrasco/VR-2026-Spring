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
         { name: "text4"        , path: "./text4.js"        , public: true },
         { name: "text5"        , path: "./text5.js"        , public: true },
         { name: "text6"        , path: "./text6.js"        , public: true },
         { name: "text7"        , path: "./text7.js"        , public: true },
         { name: "text8"        , path: "./text8.js"        , public: true },
         { name: "dissolve"     , path: "./dissolve.js"     , public: true },
         { name: "master1"      , path: "./master1.js"      , public: true },
         { name: "bouncing"     , path: "./bouncing.js"     , public: true },
         { name: "parse1"       , path: "./parse1.js"       , public: true },
      ]
   };
}

