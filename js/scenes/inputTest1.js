/*
   This is a very simple example of how to use the
   inputEvents object.

   When the scene is in XR mode, the x position of
   the left controller controls the red component
   of the cube's color, and the x position of the
   right controller controls the blue component of
   the cube's color.
*/

export const init = async model => {
   let obj1 = model.add('cube');

   // USING THE GLOBAL inputEvents OBJECT

   //inputEvents.onPress = hand => color = [0,0,1];
   //inputEvents.onRelease = hand => color = [1,0,0];

   inputEvents.onMove = hand => {
      if (isXR()) {
         if (hand == 'left')
            color[0] = inputEvents.pos(hand)[0] * .5 + .5;
         if (hand == 'right')
            color[2] = inputEvents.pos(hand)[0] * .5 + .5;
      }
   }

   let color = [.5,.5,.5];
   model.move(0,1.5,0).scale(.1).animate(() => {
      obj1.identity().turnY(model.time).color(color);
   });
}
