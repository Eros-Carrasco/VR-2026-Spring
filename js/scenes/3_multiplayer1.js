/*
   This is a very simple example of maintaining
   shared state between multiple players. Every
   time a player changes the state of the ball,
   they send the new state info to all of the
   other players.
*/

// CREATE THE SHARED STATE FOR ALL PLAYERS.

window.ballInfo = {                              // SHARED STATE IS A GLOBAL VARIABLE.
   rgb: 'red',                                   // IT MUST BE AN OBJECT OF THE FORM:
   xyz: [0,1.5,0]                                // { name: value, name: value ... }
};

window.backgroundInfo = {                              // SHARED STATE IS A GLOBAL VARIABLE.
   rgb: 'blue',                                   // IT MUST BE AN OBJECT OF THE FORM:
   xyz: [0,2,0]                                // { name: value, name: value ... }
};

export const init = async model => {

   // ADD A BALL TO THE SCENE.

   let ball = model.add('sphere');
   let background = model.add('cube');


   // EVERY INPUT EVENT SENDS THE BALL'S STATE INFO TO THE SHARED SERVER.

   inputEvents.onPress = hand => {
      ballInfo.rgb = hand == 'left' ? 'green'    // Set ball color: left=green, right=blue
                                    : 'blue';
      ballInfo.xyz = inputEvents.pos(hand);      // AFTER AN INPUT EVENT MODIFIES STATE

      backgroundInfo.rgb = hand == 'left' ? 'yellow'    // Set ball color: left=green, right=blue
                                    : 'cyan';

      server.broadcastGlobal('ballInfo');        // BROADCAST THE NEW STATE VALUE.
      server.broadcastGlobal('backgroundInfo');        // BROADCAST THE NEW STATE VALUE.

   }
   inputEvents.onDrag = hand => {
      ballInfo.xyz = inputEvents.pos(hand);      // AFTER AN INPUT EVENT MODIFIES STATE
      server.broadcastGlobal('ballInfo');        // BROADCAST THE NEW STATE VALUE.
   }
   inputEvents.onRelease = hand => {
      ballInfo.rgb = 'red';                      // AFTER AN INPUT EVENT MODIFIES STATE
      server.broadcastGlobal('ballInfo');        // BROADCAST THE NEW STATE VALUE.
   }

   model.animate(() => {

      // EACH ANIMATION FRAME STARTS BY GETTING THE LATEST STATE INFO FOR THE BALL.

      ballInfo = server.synchronize('ballInfo'); // BEGIN ANIMATE BY SYNCHRONIZING STATE.
      backgroundInfo = server.synchronize('backgroundInfo'); // BEGIN ANIMATE BY SYNCHRONIZING STATE.

      // PLACE AND COLOR THE BALL ACCORDING TO ITS STATE INFO.

      ball.identity().move(ballInfo.xyz).scale(.1).color(ballInfo.rgb);
      background.identity().move(backgroundInfo.xyz).scale(.1).color(backgroundInfo.rgb);
   });
}

