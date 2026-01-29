// ===== GLOBAL PARAMS =====

let mapSize = 25;
let spacing = 1;
let seed = 10;
let frequency = 0.1;
let heightScale = 3;

let movingSpeed = 0.04;

// ===== SIMPLE WATER NOISE =====
function noise(x, z) {
  return Math.sin(x * 2.1 + z * 3.7) * Math.cos(z * 1.9) * 0.5 + 0.5;
}

// ===== MAIN =====

export const init = async model => {

  // TEXTURES
  model.txtrSrc(1, '../media/eros/textures/water.png');
  model.txtrSrc(5, '../media/eros/textures/wood.png');
  model.txtrSrc(10, '../media/eros/textures/pirateflag.png');

  let cubes = [];

  // ===== CREATE WATER GRID =====
  for (let x = -mapSize; x < mapSize; x++) {
    for (let z = -mapSize; z < mapSize; z++) {

      model.add("cube");
      let i = cubes.length;
      cubes.push({ x, z, i });

      model.child(i).txtr(1);
    }
  }

  // ===== CREATE BOAT RIG (HIERARCHY) =====

  // root node (like shoulder)
  let boatRoot = model.add();

  // hull is child of root
  let boatHull = boatRoot.add("tubeX");

  let boatMast = boatHull.add("tubeY");

  // sail is child of hull (or root, tu decides)
  let boatSail = boatHull.add("coneY");

  let boatSailFlag = boatSail.add("square");
  

  // hull
  boatHull
  .scale(3, 1, 0.7)
  .txtr(5);

  // mast
  boatMast
    .move(0, 1, 0)   // above hull
    .scale(.08, 2.5, .08)
    .color(.02, .02, .02);

  // sail (mast)
  boatSail
    .move(0, 4.25, 0)   // above hull
    .scale(.8, 3, .3)
    .txtr(10);
    

    boatSailFlag
    .move(0, -.2, .7) // position at top of sail
    .scale(.5, .5, .5)
    .txtr(10);

  // ===== ANIMATE =====
  model.animate(() => {

    seed += movingSpeed;

    // WATER WAVES
    for (let c of cubes) {

      let nx = (c.x + seed) * frequency;
      let nz = (c.z + seed) * frequency;
      let h = noise(nx, nz) * heightScale;

      model.child(c.i)
        .identity()
        .move(c.x * spacing, h, c.z * spacing)
        .scale(1);
    }

    // BOAT FLOATING
    let bx = 0;
    let bz = 0;

    let nx = (bx + seed) * frequency;
    let nz = (bz + seed) * frequency;
    let h = noise(nx, nz) * heightScale;

    boatRoot
      .identity()
      .move(bx, h + 1.6, bz)
      .turnZ(Math.sin(model.time) * 0.1)
      .turnX(Math.cos(model.time * 0.7) * 0.05);
  });
};