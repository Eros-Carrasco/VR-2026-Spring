/**
 * solvePlanarPose.js — recover the 3D pose of a planar rectangle from its
 * four corners in normalized image space.
 *
 * Given:
 *   - 4 corner points of a rectangle as seen in a camera image
 *   - the camera's focal length (image-width-relative units)
 *   - the rectangle's real-world width and height (in any consistent unit,
 *     typically meters)
 *
 * Returns a 4×4 column-major matrix (16 floats) that maps the rectangle's
 * local frame (unit square centered at origin, lying on its XY plane) into
 * the camera's coordinate system. Translation components are in the same
 * units as `width` and `height`.
 *
 * Math: this is a planar-PnP solve via a homography decomposition. Given 4
 * correspondences between world points (the 4 corners of the rectangle at
 * known dimensions) and their image projections, we solve for the 3×3
 * homography H by Gaussian elimination on the 8×8 system (1 equation per
 * x-coord + 1 per y-coord, 4 points = 8 equations, 8 unknowns since H is
 * defined up to scale and we fix H[8]=1). From H we extract the two basis
 * vectors r1, r2 of the rectangle's plane and the translation, normalize
 * so |r1|=1, and recover r3 = r1 × r2 to complete the rotation.
 *
 * Conventions:
 *   - Image coords use OpenGL convention: origin at image center,
 *     x right, y up, normalized so the image width spans [-0.5, +0.5].
 *     (The caller is responsible for aspect-correcting y by frame aspect.)
 *   - World coords: rectangle lies on z=0, x along width, y along height,
 *     centered at origin. Corners are ordered [BL, BR, TR, TL].
 *   - Output uses OpenCV camera convention: camera at origin looking +Z.
 *     The caller flips Z for OpenGL/WebXR usage (camera looks -Z).
 *
 * @param {number[]} corners  8 floats: [x_BL, y_BL, x_BR, y_BR, x_TR, y_TR, x_TL, y_TL]
 *                            in image space, normalized as described above.
 *                            NOTE: this array is mutated by the solver — pass a copy
 *                            if you need the original preserved.
 * @param {number}   fl       Focal length in image-width-relative units.
 *                            Relation to horizontal FOV: fl = 0.5 / tan(hfov/2)
 *                            Examples: 0.5 → 90° hfov, 0.34 → 111° hfov.
 * @param {number}   width    Real-world width of the rectangle (defaults 1).
 * @param {number}   height   Real-world height of the rectangle (defaults to width,
 *                            in which case the solve is for a square).
 * @returns {number[]}        16 floats, column-major 4×4 matrix.
 */
export function solvePlanarPose(corners, fl, width = 1, height) {

   if (height === undefined) height = width;

   // World-space corners of the rectangle, in [BL, BR, TR, TL] order on z=0.
   // We use half-extents so the rectangle is centered at origin.
   let halfW = width  / 2;
   let halfH = height / 2;
   let modelPts = [-halfW, -halfH,
                    halfW, -halfH,
                    halfW,  halfH,
                   -halfW,  halfH];

   // Build the 8×8 linear system E·h = corners, where h is the flattened
   // 3×3 homography (with h[8] = 1 implicitly). Each correspondence
   // (x, y) ↔ (u, v) contributes two rows:
   //   [x y 1 0 0 0 -xu -yu] · h = u
   //   [0 0 0 x y 1 -xv -yv] · h = v
   let E = [];
   for (let i = 0 ; i < 4 ; i++) {
      let x = modelPts[2*i], y = modelPts[2*i+1];
      let u = corners[2*i],  v = corners[2*i+1];
      E.push([x, y, 1, 0, 0, 0, -x * u, -y * u],
             [0, 0, 0, x, y, 1, -x * v, -y * v]);
   }

   // Gaussian elimination with partial pivoting. Mutates `corners` in place
   // alongside E (treating corners as the RHS of the linear system).
   for (let i = 0 ; i < 8 ; i++) {
      let I = i;
      for (let k = i+1 ; k < 8 ; k++)
         if (Math.abs(E[k][i]) > Math.abs(E[I][i]))
            I = k;
      [ E[i], E[I] ] = [ E[I], E[i] ];
      [ corners[i], corners[I] ] = [ corners[I], corners[i] ];
      for (let k = i+1 ; k < 8 ; k++) {
         let c = -E[k][i] / E[i][i];
         for (let j = i ; j < 8 ; j++)
            E[k][j] = i == j ? 0 : E[k][j] + c * E[i][j];
         corners[k] += c * corners[i];
      }
   }

   // Back-substitution.
   let H = [];
   for (let i = 7 ; i >= 0 ; i--) {
      H[i] = corners[i] / E[i][i];
      for (let k = i - 1 ; k >= 0 ; k--)
         corners[k] -= E[k][i] * H[i];
   }
   H[8] = 1;

   // Recover the two basis vectors of the rectangle's plane and the
   // translation from the homography columns. The focal-length scaling
   // turns image-space directions into camera-space directions.
   let r1 = [H[0] / fl, H[3] / fl, H[6]];
   let r2 = [H[1] / fl, H[4] / fl, H[7]];
   let tr = [H[2] / fl, H[5] / fl, H[8]];

   // The homography is defined up to scale. Normalizing by |r1| restores
   // metric scale, since in the world space we set |r1| = 1 by construction
   // (the X basis vector of the rectangle's local frame is unit length).
   let norm = Math.sqrt(r1[0]*r1[0] + r1[1]*r1[1] + r1[2]*r1[2]);
   r1 = r1.map(v => v / norm);
   r2 = r2.map(v => v / norm);
   tr = tr.map(v => v / norm);

   // Complete the rotation matrix with r3 = r1 × r2 (right-handed frame).
   let r3 = [ r1[1] * r2[2] - r1[2] * r2[1],
              r1[2] * r2[0] - r1[0] * r2[2],
              r1[0] * r2[1] - r1[1] * r2[0] ];

   // Assemble 4×4 column-major matrix: columns are [r1, r2, r3, t].
   return [ r1[0], r1[1], r1[2], 0,
            r2[0], r2[1], r2[2], 0,
            r3[0], r3[1], r3[2], 0,
            tr[0], tr[1], tr[2], 1 ];
}
