export const init = async model => {
    let obj1 = model.add('cube');
    let s = 1; // Default scale

    //inputEvents.onPress = hand => color = [0,0,1];

    inputEvents.onMove = hand => {
        if (hand == 'left')
            color[0] = inputEvents.pos(hand)[0] * .5 + .5;
            s = xPos * .5 + .5;
        if (hand == 'right')
            color[2] = inputEvents.pos(hand)[0] * .5 + .5;
          s = xPos * .5 + 1.5;
    }

    //inputEvents.onRelease = hand => color = [1,0,0];

    let color = [.5,.5,.5];
    model.move(0,1.5,0).scale(.1).animate(() => {
        obj1.identity().turnY(model.time).color(color).scale(s, s, s);
    });
}
// export const init = async model => {
  
//   let obj1 = model.add('cube')

//   // InputEvents.onPress = hand => console.log('onPress', hand);
//   inputEvents.onPress = hand =>
//   {if (hand=='left') 
//       isScaledUp = true;}

//   inputEvents.onRelease = hand =>
//   {if (hand=='left') 
//       isScaledUp = true;}
  
//   let isScaledUp = false;

//   model.animate(() => {
//     if (isScaledUp == true) {
//        obj1.scale(1, 1, 1);
//     }
//     else { 
//       obj1.scale(0, 0, 0);
//     }

   

    
//   });

// };
//window.inputEvents = new InputEvents();
// InputEvents.onMove
// InputEvents.onPress
// InputEvents.onRelease
// InputEvents.onKeyPress
// InputEvents.onKeyRelease
// InputEvents.onResize



