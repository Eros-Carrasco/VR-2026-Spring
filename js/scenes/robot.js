import { Matrix, noise } from '../render/core/cg.js';
import { Channel } from '../render/core/channel.js';

let useWebRTC = false;

let isGreenScreen = false;

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

   if (useWebRTC) {
      let channel = new Channel(), id;
      getFile('bici/projects/0423/src/webrtc_id.cg', id => channel.open(id));
      channel.onReceive(msg => {
         switch (msg.type) {
         case 'I':
            I_data = msg.data;
            break;
         }
      });
   }

   let robot, robot_data, counter = 0, I_data = null;

   inputEvents.onRelease = hand => {
      if (hand == 'left')
         isGreenScreen = ! isGreenScreen;
   }

   model.animate(() => {

      // GET THE ROBOT MODEL FROM bici

      getFile('bici/projects/0423/src/robot.cg', text => robot = text);

      if (robot) {

         if (useWebRTC) {
            if (I_data) {
               let data = I_data.split(',');

               for (let i = 0 ; i < 3 ; i++)
                  I[i] = 2 * parseInt(data[i]) / 100 - 1;
               I_data = null;
            }
         }
	 else {
            getFile('bici/projects/0423/src/robot_data.cg', text => robot_data = text);
            if (robot_data) {
               let data = robot_data.split(',');
               for (let i = 0 ; i < 3 ; i++)
                  I[i] = 2 * parseInt(data[i]) / 100 - 1;
            }     
	 }

         let fn = new Function(replaceAtSigns(robot));
         while (model.nChildren() > 0)
            model.remove(0);
         cg.identity().move(0,1.5,0).scale(.3,.3,.3*window.zsgn);

         if (isGreenScreen)
            model.add('square').move(0,1.5,-1).scale(10).color(0,1,0).dull();

         fn();
      }
   });
}
