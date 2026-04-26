export function computeCameraPose(C, fl, s=1) {

   let S = [-s/2,-s/2,s/2,-s/2,s/2,s/2,-s/2,s/2];

   let E = [], H = [];
   for (let i = 0 ; i < 4 ; i++) {
      let x = S[2*i], y = S[2*i+1], u = C[2*i], v = C[2*i+1];
      E.push([x, y, 1, 0, 0, 0, -x * u, -y * u],
             [0, 0, 0, x, y, 1, -x * v, -y * v]);
   }

   for (let i = 0 ; i < 8 ; i++) {
      let I = i;
      for (let k = i+1 ; k < 8 ; k++)
         if (Math.abs(E[k][i]) > Math.abs(E[I][i]))
            I = k;
      [ E[i], E[I] ] = [ E[I], E[i] ];
      [ C[i], C[I] ] = [ C[I], C[i] ];
      for (let k = i+1 ; k < 8 ; k++) {
         let c = -E[k][i] / E[i][i];
         for (let j = i ; j < 8 ; j++)
            E[k][j] = i == j ? 0 : E[k][j] + c * E[i][j];
         C[k] += c * C[i];
      }
   }
   for (let i = 7 ; i >= 0 ; i--) {
      H[i] = C[i] / E[i][i];
      for (let k = i - 1 ; k >= 0 ; k--)
         C[k] -= E[k][i] * H[i];
   }
   H[8] = 1;

   let r1 = [H[0] / fl, H[3] / fl, H[6]];
   let r2 = [H[1] / fl, H[4] / fl, H[7]];
   let tr = [H[2] / fl, H[5] / fl, H[8]];

   let norm = Math.sqrt(r1[0]*r1[0] + r1[1]*r1[1] + r1[2]*r1[2]);
   r1 = r1.map(v => v / norm);
   r2 = r2.map(v => v / norm);
   tr = tr.map(v => v / norm);

   let r3 = [ r1[1] * r2[2] - r1[2] * r2[1],
              r1[2] * r2[0] - r1[0] * r2[2],
              r1[0] * r2[1] - r1[1] * r2[0] ];

   return [ r1[0], r1[1], r1[2], 0,
            r2[0], r2[1], r2[2], 0,
            r3[0], r3[1], r3[2], 0,
            tr[0], tr[1], tr[2], 1 ];
}

