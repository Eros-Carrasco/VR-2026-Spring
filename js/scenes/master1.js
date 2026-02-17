
// THE MASTER CLIENT GIVES CONTROL OF THE BALL TO THE CONTROLLER THAT LAST PRESSED ITS TRIGGER.

window.sharedState = {  // STATE OBJECT THAT IS SHARED BETWEEN ALL CLIENTS:

   time: 0,                // THE CURRENT TIME ON THE MASTER CLIENT'S LOCAL CLOCK.
   pos: [0,1.5,0],         // THE CURRENT BALL POSITION.
   controller: { },        // A LIST OF WHICH CLIENT TRIGGERS ARE CURRENTLY PRESSED.
}

export const init = async model => {

   let ball = model.add('sphere');

   // WHEN A CLIENT PRESSES A TRIGGER, THAT CLIENT SENDS A MESSAGE TO THE MASTER CLIENT TO TELL IT TO
   // ADD THAT CLIENT'S TRIGGER TO THE LIST OF TRIGGERS BEING DRAGGED, TOGETHER WITH A TIMESTAMP.

   inputEvents.onPress = hand => {
      sharedState.controller[hand + clientID] = { pos: inputEvents.pos(hand), time: sharedState.time };
      server.broadcastGlobal('sharedState');
   }

   // DRAG EVENTS ARE SENT TO THE MASTER CLIENT FOR PROCESSING. THEY DO NOT DIRECTLY MOVE THE BALL.

   inputEvents.onDrag = hand => {
      sharedState.controller[hand + clientID].pos = inputEvents.pos(hand);
      server.broadcastGlobal('sharedState');
   }

   // AN UP EVENT REMOVES THIS CLIENT FROM THE MASTER CLIENT'S LIST OF CLIENTS WHO ARE DRAGGING.

   inputEvents.onRelease = hand => {
      delete sharedState.controller[hand + clientID];
      server.broadcastGlobal('sharedState');
   }

   model.animate(() => {
      sharedState = server.synchronize('sharedState')
      if (clientID == clients[0]) {                // ONLY THE MASTER CLIENT MODIFIES THE SHARED STATE:
         sharedState.time = model.time;
	 let time = 0;                                                 // THE MASTER CLIENT DETERMINES
         for (let id in sharedState.controller)                        // WHICH CLIENT PRESSED THEIR
	    if (sharedState.controller[id].time > time) {              // TRIGGER LAST. IT THEN USES
	       time = sharedState.controller[id].time;                 // THE POSITION FROM THAT CLIENT
	       sharedState.pos = sharedState.controller[id].pos;       // AS THE POSITION TO BROADCAST
            }                                                          // TO EVERY CLIENT.
         server.broadcastGlobal('sharedState');
      }

      ball.identity().move(sharedState.pos).scale(.07).color(1,1,0);  // EVERY CLIENT PLACES THE BALL.
   });
}
