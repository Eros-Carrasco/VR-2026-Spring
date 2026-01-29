// ===== GLOBAL PARAMS =====

let mapSize = 15;
let spacing = 1;
let seed = 10;
let frequency = 0.1;
let heightScale = 7;

let movingSpeed = 0.03;

// ===== noise function =====
function noise(x, z) {
  return Math.sin(x * 2.1 + z * 3.7) * Math.cos(z * 1.9) * 0.5 + 0.5;
}

// ===== MAIN =====

export const init = async model => {

  model.txtrSrc(1, '../media/eros/textures/water.png');
  model.txtrSrc(2, '../media/eros/textures/sand.png');
  model.txtrSrc(3, '../media/eros/textures/grass.png');
  model.txtrSrc(4, '../media/eros/textures/rock.png');

  let cubes = [];

  // CREATE MAP ONCE
  for (let x = -mapSize; x < mapSize; x++) {
    for (let z = -mapSize; z < mapSize; z++) {

      model.add("cube");
      let i = cubes.length;

      cubes.push({ x, z, i });
    }
  }

  // ANIMATE HEIGHT
  model.animate(() => {

    seed += movingSpeed; // terrain moves

    for (let c of cubes) {

      let nx = (c.x + seed) * frequency;
      let nz = (c.z + seed) * frequency;

      let h = noise(nx, nz) * heightScale;

      let tex = 3;
      if (h < 1) tex = 1;
      else if (h < 2) tex = 2;
      else if (h > 4) tex = 4;

      model.child(c.i)
        .identity()
        .move(c.x * spacing, h, c.z * spacing)
        .scale(1)
        .txtr(tex);
    }
  });
};