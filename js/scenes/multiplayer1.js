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

export const init = async model => {

   // ADD A BALL TO THE SCENE.

   let ball = model.add('sphere');

   // EVERY INPUT EVENT SENDS THE BALL'S STATE INFO TO THE SHARED SERVER.

   inputEvents.onPress = hand => {
      ballInfo.rgb = hand == 'left' ? 'green'    // Set ball color: left=green, right=blue
                                    : 'blue';
      ballInfo.xyz = inputEvents.pos(hand);      // AFTER AN INPUT EVENT MODIFIES STATE
      server.broadcastGlobal('ballInfo');        // BROADCAST THE NEW STATE VALUE.
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

      // PLACE AND COLOR THE BALL ACCORDING TO ITS STATE INFO.

      ball.identity().move(ballInfo.xyz).scale(.1).color(ballInfo.rgb);
   });
}

