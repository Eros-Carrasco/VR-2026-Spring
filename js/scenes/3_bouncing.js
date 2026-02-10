/*
   This scene shows how to animate a ball with simple physics.
   The ball is affected by gravity, and whenever it hits a
   wall it bounces off the wall.
*/

export const init = async model => {

   model.txtrSrc(1, '../media/textures/water_vase.jpg');
   model.txtrSrc(2, '../media/textures/brick.png');
   model.txtrSrc(3, '../media/textures/moon_diffuse.jpg');
   model.txtrSrc(4, '../media/eros/textures/grass.png');


   // MAKE A RED BALL.

   let ball = model.add('sphere');
   ball.txtr(3); 

   let floor = model.add('cube');
   floor.move(0, -0.55, 0).scale(1, 0.05, 1);
   floor.txtr(4);

   let leftWall = model.add('cube');
   leftWall.txtr(1);
   leftWall.move(-0.57, 0, 0).scale(0.1, 1, 1);

   let rightWall = model.add('cube');
   rightWall.txtr(2);
   rightWall.move(0.57, 0, 0).scale(0.1, 1, 1);

   let sky = model.add('square');
   sky.color(0.53, 0.81, 0.92)
   sky.move(0, 0, -5).scale(10);


   // INITIALIZE POSITION, VELOCITY AND GRAVITY.

   let x = 0;
   let y = 0;

   let dx = .1;
   let dy = .1;

   let gravity = -.003;

   model.move(0,1.7,0).animate(() => {

      // PLACE THE BALL.

      ball.identity().move(.1*x,.1*y,0).scale(.1);

      // MOVE THE BALL TO ITS NEXT POSITION.

      x += dx;
      y += dy;

      // APPLY GRAVITY.

      dy += gravity;


      // IF THE BALL HITS A WALL, REVERSE VELOCITY.

      if (x > 4 || x < -4)
        dx = -dx;
      if (y < -4)
        dy = -dy * .999;
   });
}

