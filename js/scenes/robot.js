import { Matrix, noise } from '../render/core/cg.js';
import { Channel } from '../render/core/channel.js';

async function getFile(file, callback) {
    try {
        const response = await fetch(file);
        if (!response.ok)
            throw new Error(`HTTP error! status: ${response.status}`);
        callback(await response.text());
    } catch (error) { }
}

let replaceAtSigns = src => {
   let dst = '';
   for (let i = 0 ; i < src.length ; i++)
      if (src[i] == '@')
         dst += 'I[' + src[++i] + ']';
      else
         dst += src[i];
   return dst;
}

export const init = async model => {
   let robot, robot_data;

   window.I = [0,0,0,0,0, 0,0,0,0,0];
   window.cg = new Matrix();
   cg.draw = (shape, color, scale) => {
      model.add(shape).setMatrix(cg.getValue()).scale(scale ?? 1).scale(1,1,zsgn).color(color);
      return cg;
   }
   cg.move     = cg.translate;
   cg.pop      = cg.restore;
   cg.push     = cg.save;
   cg.turnX    = cg.rotateX;
   cg.turnY    = cg.rotateY;
   cg.turnZ    = cg.rotateZ;
   window.PI   = Math.PI;
   window.ball = 'sphere';
   window.cube = 'cube';
   window.tube = 'tubeZ';
   window.tubey = 'tubeY';
   window.zsgn = clientID == clients[0] ? 1 : -1;

   // USE WEBRTC TO GET REAL-TIME PARAMETER VALUES FROM BICI

   let channel = new Channel(), id;
   getFile('bici/projects/0423/src/webrtc_id.cg', id => channel.open(id));
   channel.onReceive(msg => {
      let data = msg.split(',');
      for (let i = 0 ; i < 3 ; i++)
         I[i] = 2 * parseInt(data[i]) / 100 - 1;
   });

   let I0 = [0,0,0,0,0, 0,0,0,0,0];
   let dI = [0,0,0,0,0, 0,0,0,0,0];

   let counter = 0, cI = 3;

   model.animate(() => {

      // GET THE ROBOT MODEL FROM bici

      getFile('bici/projects/0423/src/robot.cg', text => robot = text);

      if (robot) {
         let fn = new Function(replaceAtSigns(robot));
         while (model.nChildren() > 0)
            model.remove(0);
         cg.identity().move(0,1.5,0).scale(.3,.3,.3*window.zsgn);
         fn();
      }
   });
}
