// 4×4 column-major matrix utilities. All matrices follow the WebGL convention:
// stored as 16 floats, column first (m[0..3] = column 0, m[4..7] = column 1…).
// mxm and transform are exported; the rest are available if you import them.

let cos = Math.cos, sin = Math.sin;
let identity = () => [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
let move = (x,y,z) => { if (y===undefined) {z=x[2];y=x[1];x=x[0];}
                        return [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1]; }
let scale = (x,y,z) => [x,0,0,0, 0,y??x,0,0, 0,0,z??x,0, 0,0,0,1];
let turnX = t => [1,0,0,0, 0,cos(t),sin(t),0, 0,-sin(t),cos(t),0, 0,0,0,1];
let turnY = t => [cos(t),0,-sin(t),0, 0,1,0,0, sin(t),0,cos(t),0, 0,0,0,1];
let turnZ = t => [cos(t),sin(t),0,0, -sin(t),cos(t),0,0, 0,0,1,0, 0,0,0,1];
export let mxm = (a,b) => {
   let m = [];
   for (let c = 0 ; c < 16 ; c += 4)
   for (let r = 0 ; r < 4 ; r++)
      m.push( a[r]*b[c] + a[r+4]*b[c+1] + a[r+8]*b[c+2] + a[r+12]*b[c+3] );
   return m;
}
export let transform = (m,p) => [ m[0] * p[0] + m[4] * p[1] + m[ 8] * p[2] + m[12],
                           m[1] * p[0] + m[5] * p[1] + m[ 9] * p[2] + m[13],
                           m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
                           m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15] ];
