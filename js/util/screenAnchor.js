/**
 * screenAnchor.js — utility for anchoring scene content to a physical PC
 * screen via 4 ArUco markers, using the headset's passthrough cast as the
 * detection camera.
 *
 * HOW IT WORKS
 * ────────────
 * Setup:  user screen-mirrors the headset (Meta Quest Developer Hub, web
 *         cast, etc.) onto the PC. Both the calibration popup and the cast
 *         preview live on the PC; the headset is the "camera".
 *
 * 1. The PC (master client) opens a separate full-screen Calibration Popup
 *    window with 4 ArUco markers anchored at its physical window corners.
 *    A control panel on the main page lets the user tune the calibration
 *    parameters (focal length, real-world width/height of the popup) and
 *    start the cast capture.
 *
 * 2. The PC captures the headset cast via getDisplayMedia() and sends one
 *    frame per ~500 ms to the Python backend (screen_anchor_server.py),
 *    which detects the 4 ArUco markers and returns their normalized image-
 *    space corner positions.
 *
 * 3. The PC broadcasts the corners + frame size via server.synchronize so
 *    every client (including the headset) sees them.
 *
 * 4. The headset, using ITS OWN inverseViewMatrix(0), solves for the 3D
 *    pose of the screen rectangle via solvePlanarPose, and locks in a
 *    world-space anchor matrix. Once locked, the matrix stays fixed in
 *    world space — moving your head no longer moves the anchor.
 *
 * 5. The PC closes the Calibration Popup and persists the calibration
 *    parameters to the backend for next session.
 *
 * 6. The scene can now call getAnchorMatrix() each frame to retrieve the
 *    pose, and getHalfExtents() to get the real-world half-width and
 *    half-height for sizing nodes anchored to the screen.
 *
 * USAGE IN A SCENE
 * ────────────────
 *   import { initScreenAnchor, getAnchorMatrix, getHalfExtents }
 *      from "../util/screenAnchor.js";
 *
 *   export const init = async model => {
 *      const anchor = initScreenAnchor(model);
 *      // … build your scene nodes (a pane, etc.) and keep them hidden
 *      //   until calibration completes …
 *      model.animate(() => {
 *         anchor.tick();                    // sync state with server
 *         const M = getAnchorMatrix();
 *         if (M) {
 *            const { halfX, halfY } = getHalfExtents();
 *            // Pose pane = anchor matrix × non-uniform XY scale.
 *            // Z is left unscaled so the pane's local +Z still points
 *            // away from the screen.
 *            pane.setMatrix([
 *               M[0]*halfX, M[1]*halfX, M[2]*halfX, 0,
 *               M[4]*halfY, M[5]*halfY, M[6]*halfY, 0,
 *               M[8],       M[9],       M[10],      0,
 *               M[12],      M[13],      M[14],      1,
 *            ]);
 *         }
 *      });
 *   };
 *
 * Calibration controls (visible on the PC main page):
 *   - Sliders for WIDTH and HEIGHT in meters (with inches shown alongside)
 *   - Slider for FOCAL LENGTH in image-width-relative units (with H-FOV°
 *     shown alongside, since that's what the photo/video industry uses)
 *   - Preset buttons for common cast types (Meta Quest Dev Hub, Web Cast)
 *   - R key — recalibrate (clears the lock and reopens the popup)
 */

import { solvePlanarPose } from './solvePlanarPose.js';
import { mxm }             from './transformMatrix.js';

// ── Public shared state, synchronized across all clients ─────────────────────
// The shape is intentionally compact — only what other clients (the headset)
// need to recompute the pose. Everything else (slider values, UI flags, etc.)
// lives in PC-local closures.
window.anchorState = window.anchorState || {
   corners:         null,    // [[x, y], ...] normalized 0-1, order [TL, TR, BR, BL], or null
   frameW:          0,       // capture frame width in pixels
   frameH:          0,       // capture frame height in pixels
   fl:              0.340,   // focal length used for the solve
   width:           0.520,   // real-world width  of the popup window (m) — full edge-to-edge
   height:          0.290,   // real-world height of the popup window (m) — full edge-to-edge
   effectiveWidth:  null,    // marker-center-to-marker-center width  (m) — what the solver actually sees
   effectiveHeight: null,    // marker-center-to-marker-center height (m) — what the solver actually sees
   calibrated:      false,   // set true once the headset locks a matrix
   recalibCounter:  0,       // bumped by R-key to force re-solve on all clients
   lockCounter:     0,       // bumped by the PC's "Lock" button to trigger the solve
};

// ── Headset-local state (per-client, not synced) ─────────────────────────────
// Once the headset has solved for the pose and locked it into world space,
// we cache the result here. Re-solving each frame would re-anchor the matrix
// to the *current* head pose, which would make the screen "follow" the user.
let _localMatrix         = null;
let _lastRecalibSeenByHS = -1;
let _lastLockSeenByHS    = 0;

// ── Focal-length presets ─────────────────────────────────────────────────────
// Empirically measured per cast source. Values not listed here default to
// "Custom" — the user tunes with the slider and the result is saved to JSON.
const FL_PRESETS = {
   'Meta Quest Developer Hub': 0.340,
   'Web Cast':                 0.340,
};

// ── Limits for the tuning sliders ────────────────────────────────────────────
// Sized for "a computer screen" — laptops and desktop monitors. Anyone wanting
// to anchor to a TV or phone screen will need to widen these bounds in code,
// but the tighter range gives much better slider resolution for the common case.
const FL_MIN     = 0.25;   // ≈ 127° H-FOV — very wide
const FL_MAX     = 0.60;   // ≈  79° H-FOV — moderately narrow
const SIZE_MIN_M = 0.10;   // 10 cm — small laptop screen (~11")
const SIZE_MAX_M = 0.60;   // 60 cm — large desktop monitor (~32")

// ── Backend communication ────────────────────────────────────────────────────
const DEFAULT_SERVER_URL = 'http://localhost:5050';
const POLL_INTERVAL_MS   = 500;

// Module-level handle to the underlying init so getAnchorMatrix / getHalfExtents
// can find state even when called from outside the initScreenAnchor return value.
// (The scene typically discards the return value and just calls the global
// getters each frame.)

/**
 * initScreenAnchor(model, opts) — call once from your scene's init().
 *
 * Returns an object with a single method:
 *   tick()  — call this at the top of your scene's model.animate callback.
 *             It synchronizes anchorState with the server, broadcasts (if
 *             master), and runs the pose solve on the first frame after
 *             corners arrive.
 *
 * Why a manual tick instead of an internal rAF loop: window.requestAnimationFrame
 * is paused during immersive WebXR sessions on Quest, but the framework's
 * model.animate is driven by xrSession.requestAnimationFrame and keeps
 * ticking. To make the same util work on the PC (no XR) and the headset
 * (in XR), we hook into model.animate via the scene, which guarantees the
 * sync runs on every visible frame on both clients. This matches the
 * pattern used by MRandarin.js (server.synchronize at the top of animate).
 *
 * @param {object} model  the scene root (accepted for API symmetry; future
 *                        versions might render the calibration popup as a
 *                        3D node).
 * @param {object} opts
 *   serverURL  {string}  Python backend base URL. Default: http://localhost:5050
 *
 * @returns {{tick: function}}
 */
export function initScreenAnchor(model, opts = {}) {

   const serverURL = opts.serverURL ?? DEFAULT_SERVER_URL;
   const isMaster  = (typeof clientID !== 'undefined') &&
                     (typeof clients  !== 'undefined') &&
                     clientID == clients[0];

   if (isMaster) {
      _setupMaster(serverURL);
   }

   return {
      tick: () => _tick(isMaster),
   };
}

/**
 * Returns the cached world-space anchor matrix, or null if no calibration
 * has been locked yet on this client.
 *
 * @returns {number[]|null}  16-float column-major matrix, or null
 */
export function getAnchorMatrix() {
   return _localMatrix;
}

/**
 * Returns the real-world half-width and half-height of the screen rectangle
 * in meters, for sizing scene nodes anchored to the screen.
 *
 * Reads directly from anchorState every call rather than caching at lock
 * time, so the user can fine-tune width/height with the sliders after
 * calibration and the change takes effect immediately. (The pose matrix
 * itself stays locked — see _tick — but the size is just a scale factor
 * applied to that matrix, so it's safe to vary in real time.)
 *
 * @returns {{halfX: number, halfY: number}|null}  or null before calibration
 */
export function getHalfExtents() {
   if (!_localMatrix) return null;
   return {
      halfX: anchorState.width  / 2,
      halfY: anchorState.height / 2,
   };
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL — per-frame sync (called by the scene's model.animate)
// ─────────────────────────────────────────────────────────────────────────────

function _tick(isMaster) {
   try {
      // Pull shared state from the server, then (if master) push it back.
      // The master writes; other clients read. Same pattern transfer.js
      // uses for P and S, and MRandarin.js uses for mandarinState.
      if (typeof server !== 'undefined') {
         const synced = server.synchronize('anchorState');
         if (synced) {
            window.anchorState = synced;
            // Master hasn't completed calibration this session yet — don't let
            // stale server state (calibrated:true from last session) skip the
            // calibration popup. Once the headset locks (_localMatrix set),
            // we allow calibrated:true to propagate normally.
            if (isMaster && !_localMatrix) {
               anchorState.calibrated = false;
            }
         }
         if (isMaster) {
            server.broadcastGlobal('anchorState');
         }
      }

      // Re-solve when recalibCounter advances (master pressed R)
      if (anchorState.recalibCounter !== _lastRecalibSeenByHS) {
         _lastRecalibSeenByHS = anchorState.recalibCounter;
         _localMatrix         = null;
      }

      // Solve ONLY when the master clicks "Lock" — not automatically on
      // every frame that corners are visible. Locking-on-corner-detection
      // produces a pose anchored to whatever head pose the user happened
      // to have at that random moment; explicit locking lets the user
      // hold still, frame the screen well in their view, and then commit.
      //
      // Two distinct sizes are at play here, and the distinction matters:
      //   - `width` / `height` are the FULL WINDOW dimensions (what the
      //     user typed into the sliders, what they'd measure with a ruler
      //     against the popup's outer edges).
      //   - `effectiveWidth` / `effectiveHeight` are the rectangle between
      //     ArUco CENTERS — smaller than the window by one marker side on
      //     each axis. This is what the solver actually sees in the image,
      //     because cv2.aruco reports each marker's center as the average
      //     of its 4 corners.
      //
      // The solver receives the effective dimensions (geometric truth).
      // The pane's half-extents are derived from the full window
      // dimensions so the scene's content covers the actual screen rather
      // than the slightly smaller marker-center rectangle.
      const lock = anchorState.lockCounter || 0;
      if (lock !== _lastLockSeenByHS && !_localMatrix &&
          anchorState.corners && anchorState.frameW && anchorState.frameH) {
         _lastLockSeenByHS = lock;
         const effW = anchorState.effectiveWidth  ?? anchorState.width;
         const effH = anchorState.effectiveHeight ?? anchorState.height;
         const result = _solveAnchorPose(
            anchorState.corners,
            anchorState.frameW, anchorState.frameH,
            anchorState.fl,
            effW, effH,
         );
         if (result) {
            _localMatrix = result.matrix;

            // Tell the master that this client (presumably the headset)
            // has locked. The master uses this to close the popup.
            if (!anchorState.calibrated) {
               anchorState.calibrated = true;
               if (isMaster && typeof server !== 'undefined') {
                  server.broadcastGlobal('anchorState');
               }
            }
         }
      }
   } catch (e) {
      console.warn('[screenAnchor] tick error:', e);
   }
}

/**
 * Convert the 4 image-space corners into a world-space anchor matrix using
 * THIS client's current inverseViewMatrix(0). Run on the headset only
 * (running it on the PC would anchor the matrix to the PC's identity view,
 * which is meaningless).
 *
 * The math mirrors MRandarin.js's computeLocalPanelMatrix: PnP solve in
 * camera space, flip Z for OpenGL convention, then transform through the
 * captureView and inverseRootMatrix to land in scene (model) space.
 */
function _solveAnchorPose(corners, frameW, frameH, fl, width, height) {
   // Server provides corners in [TL, TR, BR, BL] order. solvePlanarPose
   // expects [BL, BR, TR, TL] (math convention, y up). Reorder accordingly.
   const reordered = [corners[3], corners[2], corners[1], corners[0]];

   // Normalize corners: server gives them as 0..1 fractions of frame size.
   // We need image-width-relative coordinates centered at the image middle,
   // with y flipped (image y is down; math y is up) and aspect-corrected so
   // the focal-length math is consistent.
   const aspect = frameH / frameW;
   const C = [];
   for (const [u, v] of reordered) {
      C.push(  u - 0.5         );
      C.push(-(v - 0.5) * aspect);
   }

   // solvePlanarPose mutates its first argument — pass a fresh copy.
   const poseInCameraCV = solvePlanarPose([...C], fl, width, height);

   // OpenCV convention has the camera looking down +Z. OpenGL/WebXR has it
   // looking down -Z. Flip Z so downstream multiplies make sense.
   const flipZ          = [1,0,0,0, 0,1,0,0, 0,0,-1,0, 0,0,0,1];
   const poseInCameraGL = mxm(flipZ, poseInCameraCV);

   // Sanity check the recovered depth. If the solve degenerated (e.g. the
   // 4 corners were collinear or duplicate), tz will be NaN/0/inf.
   const tz = poseInCameraGL[14];
   if (!isFinite(tz) || tz === 0) return null;

   // Compose with the camera→world transform of this client. On the headset
   // this is the actual head pose at the moment of solve — meaning the
   // resulting matrix is anchored to the real world, not the user's view.
   if (typeof clay === 'undefined') return null;
   const captureView = clay.root().inverseViewMatrix(0);
   const poseInWorld = mxm(captureView, poseInCameraGL);

   // If the user has reframed the world (pinch-translate, pinch-rotate),
   // the scene's model frame may differ from the world frame. Compose with
   // the inverse-root-matrix to bring the anchor into model space.
   const inverseWC = clay.inverseRootMatrix
      ? clay.inverseRootMatrix
      : [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
   const M = mxm(inverseWC, poseInWorld);

   if (M.some(n => !isFinite(n))) return null;
   return { matrix: M };
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL — master (PC) setup: popup, control panel, polling, persistence
// ─────────────────────────────────────────────────────────────────────────────

function _setupMaster(serverURL) {

   // Idempotency guard: if this scene was double-initialized (hot reload,
   // duplicate import, framework calling init twice, etc), we don't want
   // to build two control panels, open two popups, or attach two keyboard
   // listeners. The flag lives on window so it survives module re-imports.
   if (window.__screenAnchorMasterSetup) return;
   window.__screenAnchorMasterSetup = true;

   // Reset calibration state every session. The framework persists anchorState
   // across reloads via server.synchronize, so without this reset the scene
   // would think it's already calibrated and skip the popup entirely.
   // Slider values (fl, width, height) are loaded from screenAnchorConfig.json
   // below, so we don't need to preserve them here.
   anchorState.calibrated   = false;
   anchorState.corners      = null;
   anchorState.lockCounter  = 0;
   _localMatrix             = null;
   _lastLockSeenByHS        = 0;

   // Persistent state for the master: control panel DOM refs, popup window,
   // cast video element, etc. Tucked into a closure object so we can pass
   // it around the helpers below without leaking globals.
   const M = {
      serverURL,
      popup:           null,   // calibration popup window
      castVideo:       null,   // <video> element holding the cast stream
      castCanvas:      null,   // <canvas> used to snapshot frames
      castCtx:         null,
      panel:           null,   // the control panel DOM root
      statusEl:        null,   // status text element
      flSlider:        null,
      flValue:         null,
      widthSlider:     null,
      widthValue:      null,
      heightSlider:    null,
      heightValue:     null,
      saveBtn:         null,
      pollTimer:       null,
      currentPreset:   'Custom',
   };

   // Load persisted config so the panel boots with the user's last-used
   // values rather than defaults. Calibration itself always runs fresh.
   _loadConfig(serverURL).then(cfg => {
      if (cfg && cfg.exists) {
         anchorState.fl       = cfg.fl;
         anchorState.width    = cfg.width;
         anchorState.height   = cfg.height;
         M.currentPreset      = cfg.flPreset || 'Custom';
      }
      _buildControlPanel(M);
      _openCalibrationPopup(M);
   });

   // Keyboard: R recalibrates (clears the lock and reopens the popup).
   window.addEventListener('keydown', e => {
      if (e.key === 'r' || e.key === 'R') {
         _recalibrate(M);
      }
   });
}

// ── Backend: load and save config ────────────────────────────────────────────

async function _loadConfig(serverURL) {
   try {
      const res = await fetch(`${serverURL}/anchor/load_config`);
      if (!res.ok) return null;
      return await res.json();
   } catch (e) {
      console.warn('[screenAnchor] load_config failed:', e);
      return null;
   }
}

async function _saveConfig(serverURL, payload) {
   try {
      const res = await fetch(`${serverURL}/anchor/save_config`, {
         method:  'POST',
         headers: { 'Content-Type': 'application/json' },
         body:    JSON.stringify(payload),
      });
      return res.ok;
   } catch (e) {
      console.warn('[screenAnchor] save_config failed:', e);
      return false;
   }
}

// Debounced auto-save: called every time a slider moves or a preset is
// clicked. The save itself is deferred ~500ms after the last change so we
// don't pummel the server with one POST per slider tick. Whenever a new
// change comes in, the pending save is cancelled and re-scheduled — only
// the latest values get written.
//
// This is the mechanism that lets the user's tuning survive between
// sessions WITHOUT requiring a full headset-lock to trigger persistence.
// (The headset-lock save also still runs, but it's now a redundant
// safety net rather than the only path.)
const _AUTO_SAVE_DEBOUNCE_MS = 500;

function _scheduleAutoSave(M) {
   if (M.autoSaveTimer) clearTimeout(M.autoSaveTimer);
   _setStatus(M, 'saving…', '#888');
   M.autoSaveTimer = setTimeout(async () => {
      M.autoSaveTimer = null;
      const ok = await _saveConfig(M.serverURL, {
         fl:       anchorState.fl,
         width:    anchorState.width,
         height:   anchorState.height,
         flPreset: M.currentPreset,
      });
      if (ok) _setStatus(M, '✓ saved', '#0fa');
      else    _setStatus(M, '⚠ save failed — is the Python server running?', '#f55');
   }, _AUTO_SAVE_DEBOUNCE_MS);
}

// ── Calibration popup ────────────────────────────────────────────────────────
//
// The popup is a separate browser window opened in full-screen so the ArUco
// markers can sit at the actual physical window corners (matching what the
// "width" and "height" sliders are measuring). Once calibration completes,
// the popup is closed — the scene's own popup (if any) is created later by
// the scene itself.

function _openCalibrationPopup(M) {
   if (M.popup && !M.popup.closed) return;

   // Open the popup at screen origin and fill the available screen area.
   // `screen.availWidth/Height` excludes the OS dock and menu bar so the
   // popup ends up covering only the usable display surface — which is
   // exactly the rectangle the user should measure with a ruler.
   const w = screen.availWidth;
   const h = screen.availHeight;
   M.popup = window.open('', 'screenAnchorCalibration',
      `width=${w},height=${h},top=0,left=0`);
   if (!M.popup) {
      _setStatus(M, 'Popup blocked — allow popups and reload.', '#f55');
      return;
   }

   const d = M.popup.document;
   d.body.style.cssText = 'margin:0;padding:0;overflow:hidden;background:#fff;';
   d.title             = 'Screen Anchor Calibration';

   // Compute the ArUco placement. The user-facing convention is simple:
   // WIDTH and HEIGHT in the sliders are the full window dimensions (what
   // they'd measure with a ruler against the popup's edges). The markers
   // sit fully inside the popup with a small white "quiet zone" between
   // each marker and the window corner — the ArUco spec requires this
   // white margin for reliable detection. Without it, a dark monitor
   // bezel touching the marker's black squares would fuse visually with
   // the marker's pattern and degrade detection. The quiet zone gives
   // the detector a clean white boundary regardless of what's around the
   // window.
   //
   // The solver doesn't see the window or the quiet zone — it sees the
   // rectangle defined by marker CENTERS. Inside _pollOnce we compute
   // that rectangle's size in meters by subtracting the appropriate
   // offset from the user's window-size sliders.
   const popupW   = M.popup.innerWidth;
   const popupH   = M.popup.innerHeight;

   // Each marker is 10% of the popup's shorter side, and we place each
   // one inset by a "quiet zone" of 20% of the marker side — meaning the
   // marker's outer edge sits quietPx pixels in from the window corner.
   const markerPx = Math.round(Math.min(popupW, popupH) * 0.10);
   const quietPx  = Math.round(markerPx * 0.20);

   // Store popup geometry for _pollOnce. The "centerOffsetPx" tells the
   // poller where the marker centers sit relative to the window corners
   // (= quietPx + markerPx/2), so it can correctly project that offset
   // from pixels to meters when computing effectiveWidth/Height.
   M.popupW         = popupW;
   M.popupH         = popupH;
   M.centerOffsetPx = quietPx + markerPx / 2;

   // Marker outer-edge positions (where the white container starts).
   // Inset by quietPx on each side so the quiet zone lives INSIDE the
   // window — visible to the cast camera as a guaranteed white border
   // around the black marker square.
   const corners = [
      { id: 0, left: quietPx,                       top: quietPx                       },  // TL
      { id: 1, left: popupW - quietPx - markerPx,   top: quietPx                       },  // TR
      { id: 2, left: popupW - quietPx - markerPx,   top: popupH - quietPx - markerPx   },  // BR
      { id: 3, left: quietPx,                       top: popupH - quietPx - markerPx   },  // BL
   ];

   for (const { id, left, top } of corners) {
      const img = d.createElement('img');
      img.src = `../media/aruco_markers/aruco_${id}.png`;
      img.style.cssText = [
         'position:fixed',
         `left:${left}px`,
         `top:${top}px`,
         `width:${markerPx}px`,
         `height:${markerPx}px`,
         'image-rendering:pixelated',
         'pointer-events:none',
      ].join(';');
      d.body.appendChild(img);
   }

   // Centered hint text so the user knows what they're looking at.
   const hint = d.createElement('div');
   hint.style.cssText = [
      'position:fixed',
      'left:50%', 'top:50%', 'transform:translate(-50%, -50%)',
      'font:600 24px sans-serif', 'color:#333',
      'text-align:center',
      'pointer-events:none',
   ].join(';');
   hint.innerHTML =
      'Point the headset at this window to calibrate.<br>' +
      '<span style="font-weight:400;font-size:16px;color:#888">' +
      'Adjust width / height / focal length on the main page if needed.' +
      '</span>';
   d.body.appendChild(hint);

   _setStatus(M, 'Popup open. Click "Start Capture" to begin.', '#aaa');
}

function _closeCalibrationPopup(M) {
   if (M.popup && !M.popup.closed) {
      M.popup.close();
   }
   M.popup = null;
}

// ── Control panel on the main page ──────────────────────────────────────────

function _buildControlPanel(M) {
   const panel = document.createElement('div');
   panel.style.cssText = [
      'position:fixed', 'top:10px', 'right:10px',
      'width:380px', 'box-sizing:border-box',
      'padding:14px 16px',
      'background:rgba(15,15,15,0.94)', 'color:#ddd',
      'font:13px/1.45 "Courier New", monospace',
      'border:1px solid #0af', 'border-radius:6px',
      'z-index:99999',
   ].join(';');
   document.body.appendChild(panel);
   M.panel = panel;

   panel.innerHTML = `
      <div style="font-weight:bold;font-size:14px;color:#0af;margin-bottom:8px;">
         screenAnchor — calibration
      </div>
      <div data-role="status" style="margin-bottom:12px;color:#aaa;font-size:12px;">
         booting…
      </div>

      <div style="margin-bottom:10px;">
         <div style="display:flex;justify-content:space-between;">
            <span>WIDTH</span>
            <span data-role="widthValue">—</span>
         </div>
         <input type="range" data-role="widthSlider"
                min="${SIZE_MIN_M}" max="${SIZE_MAX_M}" step="0.005"
                style="width:100%;">
      </div>

      <div style="margin-bottom:14px;">
         <div style="display:flex;justify-content:space-between;">
            <span>HEIGHT</span>
            <span data-role="heightValue">—</span>
         </div>
         <input type="range" data-role="heightSlider"
                min="${SIZE_MIN_M}" max="${SIZE_MAX_M}" step="0.005"
                style="width:100%;">
      </div>

      <div style="margin-bottom:6px;">
         <div style="display:flex;justify-content:space-between;">
            <span>FOCAL LENGTH</span>
            <span data-role="flValue">—</span>
         </div>
         <input type="range" data-role="flSlider"
                min="${FL_MIN}" max="${FL_MAX}" step="0.005"
                style="width:100%;">
         <div data-role="flPresets" style="margin-top:6px;font-size:11px;"></div>
      </div>

      <div style="margin-top:14px;">
         <button data-role="lock" disabled
                 style="width:100%;padding:10px;font:13px monospace;
                        background:#444;color:#888;border:0;border-radius:4px;
                        cursor:not-allowed;font-weight:bold;">
            🔒 Lock Calibration
         </button>
      </div>

      <div style="margin-top:8px;display:flex;gap:8px;">
         <button data-role="capture"
                 style="flex:1;padding:8px;font:13px monospace;
                        background:#0af;color:#000;border:0;border-radius:4px;
                        cursor:pointer;font-weight:bold;">
            📷 Start Capture
         </button>
         <button data-role="recalib"
                 style="flex:1;padding:8px;font:13px monospace;
                        background:#333;color:#ddd;border:1px solid #555;
                        border-radius:4px;cursor:pointer;">
            ↻ Recalibrate (R)
         </button>
      </div>
   `;

   // Wire up DOM refs
   M.statusEl     = panel.querySelector('[data-role="status"]');
   M.widthSlider  = panel.querySelector('[data-role="widthSlider"]');
   M.widthValue   = panel.querySelector('[data-role="widthValue"]');
   M.heightSlider = panel.querySelector('[data-role="heightSlider"]');
   M.heightValue  = panel.querySelector('[data-role="heightValue"]');
   M.flSlider     = panel.querySelector('[data-role="flSlider"]');
   M.flValue      = panel.querySelector('[data-role="flValue"]');
   M.lockBtn      = panel.querySelector('[data-role="lock"]');

   // Initialize slider values from anchorState (which was just hydrated
   // from the saved JSON in _loadConfig, if any).
   M.widthSlider .value = anchorState.width;
   M.heightSlider.value = anchorState.height;
   M.flSlider    .value = anchorState.fl;
   _refreshSliderLabels(M);

   // FL preset buttons. Clicking a preset jumps the slider to its value.
   // Any subsequent manual slider change marks the preset as "Custom".
   const presetContainer = panel.querySelector('[data-role="flPresets"]');
   const presetNames     = [...Object.keys(FL_PRESETS), 'Custom'];
   for (const name of presetNames) {
      const btn = document.createElement('button');
      btn.textContent  = name === 'Custom' ? 'Custom' : `${name} (${_flAsHfovString(FL_PRESETS[name])})`;
      btn.dataset.name = name;
      btn.style.cssText = [
         'margin-right:4px', 'margin-top:4px',
         'padding:3px 8px', 'font:11px monospace',
         'background:#222', 'color:#ccc', 'border:1px solid #444',
         'border-radius:3px', 'cursor:pointer',
      ].join(';');
      btn.addEventListener('click', () => {
         if (name !== 'Custom') {
            anchorState.fl = FL_PRESETS[name];
            M.flSlider.value = anchorState.fl;
         }
         M.currentPreset = name;
         _refreshSliderLabels(M);
         _highlightActivePreset(M);
         _scheduleAutoSave(M);
      });
      presetContainer.appendChild(btn);
   }

   // Slider event handlers. Any movement transitions the FL preset to
   // "Custom" since the user has manually overridden the preset value.
   // Every change also schedules an auto-save (debounced) so the user's
   // tuned values survive the next session — without forcing them to
   // complete a full headset lock to get persistence.
   M.widthSlider.addEventListener('input', () => {
      anchorState.width = parseFloat(M.widthSlider.value);
      _refreshSliderLabels(M);
      _scheduleAutoSave(M);
   });
   M.heightSlider.addEventListener('input', () => {
      anchorState.height = parseFloat(M.heightSlider.value);
      _refreshSliderLabels(M);
      _scheduleAutoSave(M);
   });
   M.flSlider.addEventListener('input', () => {
      anchorState.fl  = parseFloat(M.flSlider.value);
      M.currentPreset = 'Custom';
      _refreshSliderLabels(M);
      _highlightActivePreset(M);
      _scheduleAutoSave(M);
   });

   // Buttons
   panel.querySelector('[data-role="capture"]').addEventListener('click', () => {
      _startCapture(M);
   });
   panel.querySelector('[data-role="recalib"]').addEventListener('click', () => {
      _recalibrate(M);
   });
   M.lockBtn.addEventListener('click', () => {
      // Bump the lock counter — the headset's tick() picks this up next
      // frame and runs the pose solve using its current inverseViewMatrix(0)
      // + the most recent broadcasted corners. The button is disabled
      // until corners actually arrive, so by the time it's clickable we
      // know there's something valid to solve from.
      anchorState.lockCounter = (anchorState.lockCounter || 0) + 1;
      if (typeof server !== 'undefined') {
         server.broadcastGlobal('anchorState');
      }
      _setStatus(M, '🔒 Lock requested. Waiting for headset to solve…', '#0af');
   });

   _highlightActivePreset(M);
}

// Update the value labels on the three sliders. Each label shows the
// canonical value plus a human-friendly equivalent (inches for size,
// horizontal FOV degrees for focal length).
function _refreshSliderLabels(M) {
   M.widthValue .textContent =
      `${anchorState.width .toFixed(3)} m  /  ${_metersToInches(anchorState.width ).toFixed(1)} in`;
   M.heightValue.textContent =
      `${anchorState.height.toFixed(3)} m  /  ${_metersToInches(anchorState.height).toFixed(1)} in`;
   M.flValue    .textContent =
      `${anchorState.fl    .toFixed(3)}      ${_flAsHfovString(anchorState.fl)}`;
}

function _highlightActivePreset(M) {
   if (!M.panel) return;
   const buttons = M.panel.querySelectorAll('[data-role="flPresets"] button');
   for (const btn of buttons) {
      const isActive = btn.dataset.name === M.currentPreset;
      btn.style.background = isActive ? '#0af' : '#222';
      btn.style.color      = isActive ? '#000' : '#ccc';
      btn.style.fontWeight = isActive ? 'bold' : 'normal';
   }
}

function _setStatus(M, text, color = '#aaa') {
   if (M.statusEl) {
      M.statusEl.textContent = text;
      M.statusEl.style.color = color;
   }
}

// ── Cast capture and polling ─────────────────────────────────────────────────

async function _startCapture(M) {
   try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const video  = document.createElement('video');
      video.srcObject = stream;
      video.play();
      video.onloadedmetadata = () => {
         M.castVideo  = video;
         M.castCanvas = document.createElement('canvas');
         M.castCanvas.width  = video.videoWidth;
         M.castCanvas.height = video.videoHeight;
         M.castCtx    = M.castCanvas.getContext('2d', { willReadFrequently: true });

         anchorState.frameW = video.videoWidth;
         anchorState.frameH = video.videoHeight;

         _setStatus(M, `Capturing ${video.videoWidth}×${video.videoHeight}. Polling…`, '#0fa');

         // Begin the polling loop
         if (M.pollTimer) clearInterval(M.pollTimer);
         M.pollTimer = setInterval(() => _pollOnce(M), POLL_INTERVAL_MS);
      };
   } catch (err) {
      console.error('[screenAnchor] getDisplayMedia failed:', err);
      _setStatus(M, `Capture failed: ${err.message}`, '#f55');
   }
}

async function _pollOnce(M) {
   // Skip if already calibrated. The headset has locked, the matrix is in
   // the scene, and re-detecting now would just cost CPU.
   if (anchorState.calibrated) return;
   if (!M.castVideo || !M.castCanvas) return;
   if (M.castVideo.readyState < 2) return;

   // Snapshot the current cast frame and ship it to the backend.
   M.castCtx.drawImage(M.castVideo, 0, 0, M.castCanvas.width, M.castCanvas.height);
   const base64 = M.castCanvas.toDataURL('image/png').split(',')[1];

   let data;
   try {
      const res = await fetch(`${M.serverURL}/anchor/detect`, {
         method:  'POST',
         headers: { 'Content-Type': 'application/json' },
         body:    JSON.stringify({ image: base64 }),
      });
      data = await res.json();
   } catch (e) {
      _setStatus(M, `Server unreachable: ${e.message}`, '#f55');
      return;
   }

   if (data.detected) {
      // Push the detected corners into shared state. The headset's sync
      // loop will pick this up on its next frame and solve the pose.
      anchorState.corners = data.corners;
      anchorState.frameW  = M.castCanvas.width;
      anchorState.frameH  = M.castCanvas.height;

      // Compute the rectangle BETWEEN MARKER CENTERS in meters. The user's
      // sliders give the full window dimensions; the marker centers sit
      // centerOffsetPx pixels in from each window edge (centerOffsetPx =
      // quietPx + markerPx/2 — the quiet zone plus half the marker side).
      // The center-to-center rectangle is therefore smaller than the
      // window by 2 × centerOffsetPx on each axis. We project that pixel
      // difference into meters using the window's pixel-to-meter ratio.
      if (M.popupW && M.popupH && M.centerOffsetPx) {
         const offsetMetersX = anchorState.width  * (2 * M.centerOffsetPx / M.popupW);
         const offsetMetersY = anchorState.height * (2 * M.centerOffsetPx / M.popupH);
         anchorState.effectiveWidth  = anchorState.width  - offsetMetersX;
         anchorState.effectiveHeight = anchorState.height - offsetMetersY;
      }

      if (typeof server !== 'undefined') {
         server.broadcastGlobal('anchorState');
      }
      _setStatus(M, '✅ Markers detected. Click "Lock Calibration" when headset is aimed.', '#0fa');
      _setLockButtonEnabled(M, true);

      // Did the headset confirm lock? (The headset sets calibrated=true
      // after its own successful solve.) If yes, persist config and close
      // the popup so the scene can take over.
      if (anchorState.calibrated) {
         await _saveConfig(M.serverURL, {
            fl:       anchorState.fl,
            width:    anchorState.width,
            height:   anchorState.height,
            flPreset: M.currentPreset,
         });
         _closeCalibrationPopup(M);
         clearInterval(M.pollTimer);
         M.pollTimer = null;
         _setLockButtonEnabled(M, false);
         _setStatus(M, '✅ Calibrated and saved. Press R to recalibrate.', '#0fa');
      }
   } else {
      _setStatus(M,
         `Searching… markers seen: ${data.n ?? '?'} / 4`,
         '#fa0');
      _setLockButtonEnabled(M, false);
   }
}

function _setLockButtonEnabled(M, enabled) {
   if (!M.lockBtn) return;
   M.lockBtn.disabled = !enabled;
   if (enabled) {
      M.lockBtn.style.background = '#0f8';
      M.lockBtn.style.color      = '#000';
      M.lockBtn.style.cursor     = 'pointer';
   } else {
      M.lockBtn.style.background = '#444';
      M.lockBtn.style.color      = '#888';
      M.lockBtn.style.cursor     = 'not-allowed';
   }
}

// ── Recalibration ────────────────────────────────────────────────────────────

function _recalibrate(M) {
   anchorState.calibrated      = false;
   anchorState.corners         = null;
   anchorState.recalibCounter += 1;
   _localMatrix = null;
   if (typeof server !== 'undefined') {
      server.broadcastGlobal('anchorState');
   }
   _setLockButtonEnabled(M, false);
   _openCalibrationPopup(M);

   // Restart polling if we have a capture stream already.
   if (M.castVideo && !M.pollTimer) {
      M.pollTimer = setInterval(() => _pollOnce(M), POLL_INTERVAL_MS);
   }
   _setStatus(M, 'Recalibrating…', '#fa0');
}

// ── Unit helpers ─────────────────────────────────────────────────────────────

function _metersToInches(m) {
   return m / 0.0254;
}

// Convert image-width-relative focal length to horizontal FOV string.
// Relation: hfov = 2 · atan(0.5 / fl). The result is in degrees.
function _flAsHfovString(fl) {
   const hfovDeg = 2 * Math.atan(0.5 / fl) * 180 / Math.PI;
   return `(≈ ${hfovDeg.toFixed(1)}° H-FOV)`;
}