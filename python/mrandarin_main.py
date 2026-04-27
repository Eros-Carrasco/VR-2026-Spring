import base64
import logging
from datetime import datetime

import cv2
import numpy as np
from flask import Flask, request, jsonify
from flask_cors import CORS

from vision_tracker import (
    detect_markers,
    detect_aruco,
    order_corners,
    normalize_image,
    is_valid_quad,
    check_if_erased,
    bgr_to_png_bytes,
)

from vision_ocr import (
    is_chinese,
    run_vision_ocr,
    lookup_pinyin_and_meaning,
)

app = Flask(__name__)
CORS(app)

# Suppress Flask's per-request access log — only show errors
logging.getLogger('werkzeug').setLevel(logging.ERROR)

# State machine: 'SEARCHING_RED' uses HSV red-dot detection (default at
# startup and after /reset); 'TRACKING_ARUCO' uses ArUco IDs 0-3 (entered
# only when the frontend POSTs /lock — i.e. the user manually anchors via
# the controller button). Hand occlusion of the physical dots stops breaking
# the quad once locked, because the headset's holograms render on top of the
# hand in the cast.
_state = 'SEARCHING_RED'

# Debug state shared between /predict and /debug
_debug_state = {
    'image': None,       # numpy BGR image (annotated copy)
    'markers': [],       # list of (x, y) centroids
    'markers_found': False,
    'character': None,
    'confidence': None,
    'timestamp': None,
    'locked': False,
    'locked_bbox': None,  # (x, y, w, h) pixel coords of locked character
}

def _src_corners_payload(centroids, img_w, img_h):
    """Format 4 ordered centroids as the API's src_corners payload."""
    ordered = order_corners(centroids)
    return [[round(x / img_w, 4), round(y / img_h, 4)] for (x, y) in ordered]

@app.route('/predict', methods=['POST'])
def predict():
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({'character': None, 'error': 'no image'})

        global _state

        image_bytes = base64.b64decode(data['image'])

        np_arr = np.frombuffer(image_bytes, dtype=np.uint8)
        bgr = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        img_h, img_w = bgr.shape[:2]

        # --- Detect zone using the active detector (red dots OR ArUco) ───────
        # Same downstream logic regardless of which detector ran: order_corners
        # will spatially sort the 4 centroids into [TL, TR, BR, BL].
        # NOTE: The state transition SEARCHING_RED → TRACKING_ARUCO is no
        # longer automatic. It only happens via POST /lock (frontend triggers
        # this when the user presses the controller button). This guarantees
        # the user gets to choose the anchoring moment / camera angle.
        if _state == 'SEARCHING_RED':
            centroids = detect_markers(bgr)
        else:  # TRACKING_ARUCO
            centroids = detect_aruco(bgr)
        valid_quad = len(centroids) == 4 and is_valid_quad(centroids)

        # --- Lock-on: skip OCR while a character is locked, check for erase instead ---
        if _debug_state['locked']:
            if not valid_quad:
                # Can't reliably check erase without all 4 markers; pause without dropping lock.
                _debug_state['markers_found'] = False
                _debug_state['markers'] = centroids
                _debug_state['image'] = bgr.copy()
                return jsonify({'character': None})
            # Valid quad — normalize and run the erase check
            check_src = normalize_image(bgr, centroids)
            _debug_state['markers_found'] = True
            _debug_state['markers'] = centroids
            _debug_state['image'] = check_src.copy()
            src_corners = _src_corners_payload(centroids, img_w, img_h)
            if check_if_erased(check_src, _debug_state['locked_bbox']):
                _debug_state['locked'] = False
                _debug_state['locked_bbox'] = None
                _debug_state['character'] = None
                _debug_state['confidence'] = None
                _debug_state['timestamp'] = datetime.now().isoformat(timespec='seconds')
                return jsonify({'character': None, 'erased': True, 'src_corners': src_corners})
            return jsonify({'character': None, 'src_corners': src_corners})

        # --- Marker detection & image normalization ---
        if not valid_quad:
            # Strict mode: no recognition without a valid quad of 4 markers.
            if centroids:
                logging.warning('Markers not found (%d detected), skipping OCR (strict mode)', len(centroids))
            else:
                logging.warning('Markers not found (0 detected), skipping OCR (strict mode)')
            _debug_state['markers_found'] = False
            _debug_state['markers'] = centroids
            _debug_state['image'] = bgr.copy()
            return jsonify({'character': None})

        # Valid quad path
        normalized_bgr = normalize_image(bgr, centroids)
        _debug_state['markers_found'] = True
        _debug_state['markers'] = centroids
        _debug_state['image'] = normalized_bgr.copy()
        ocr_src = normalized_bgr
        ordered = order_corners(centroids)
        src_corners_norm = [[x / img_w, y / img_h] for (x, y) in ordered]

        # Contrast enhancement — boosts stroke visibility for OCR
        enhanced = cv2.convertScaleAbs(ocr_src, alpha=1.5, beta=0)
        ocr_bytes = bgr_to_png_bytes(enhanced)

        _debug_state['character'] = None
        _debug_state['confidence'] = None
        _debug_state['timestamp'] = datetime.now().isoformat(timespec='seconds')

        ocr_results = run_vision_ocr(ocr_bytes)

        for text, confidence, bb in ocr_results:
            if is_chinese(text):
                # extract only the first Chinese character from the recognized text
                char = next((c for c in text if '\u4e00' <= c <= '\u9fff'), None)
                if not char:
                    continue
                if confidence < 0.5:
                    print(f'Low confidence result: {char} ({confidence:.2f}), skipping')
                    continue
                py, meaning = lookup_pinyin_and_meaning(char)

                # Convert Vision's normalized bottom-left bbox to pixel coords
                bx = int(bb.origin.x * img_w)
                by = int((1 - bb.origin.y - bb.size.height) * img_h)
                bw = int(bb.size.width * img_w)
                bh = int(bb.size.height * img_h)
                bbox_pixels = (bx, by, bw, bh)

                # Normalized position within the 800×800 detection zone
                # Zone is centered in the full image; top-left corner at (img_w/2-400, img_h/2-400)
                zone_left = img_w / 2 - 400
                zone_top  = img_h / 2 - 400
                char_cx   = bx + bw / 2
                char_cy   = by + bh / 2
                char_x_pct = max(0.0, min(1.0, (char_cx - zone_left) / 800))
                char_y_pct = max(0.0, min(1.0, (char_cy - zone_top)  / 800))
                bbox_w_pct = max(0.0, min(1.0, bw / 800))
                bbox_h_pct = max(0.0, min(1.0, bh / 800))

                print(f'recognized: {char} {py} - {meaning} (confidence: {confidence:.2f})')
                _debug_state['character'] = char
                _debug_state['confidence'] = round(float(confidence), 2)
                _debug_state['locked'] = True
                _debug_state['locked_bbox'] = bbox_pixels
                return jsonify({
                    'character':   char,
                    'pinyin':      py,
                    'meaning':     meaning,
                    'confidence':  round(float(confidence), 2),
                    'bbox':        bbox_pixels,
                    'char_x_pct':  round(char_x_pct, 4),
                    'char_y_pct':  round(char_y_pct, 4),
                    'bbox_w_pct':  round(bbox_w_pct, 4),
                    'bbox_h_pct':  round(bbox_h_pct, 4),
                    # Marker corners [TL, TR, BR, BL] in original image space, normalized 0-1
                    'src_corners': [[round(x, 4), round(y, 4)] for (x, y) in src_corners_norm] if src_corners_norm else None,
                })

        return jsonify({'character': None, 'src_corners': _src_corners_payload(centroids, img_w, img_h)})

    except Exception as e:
        print(f'error: {e}')
        return jsonify({'character': None, 'error': str(e)})


@app.route('/debug', methods=['GET'])
def debug():
    state = _debug_state
    img = state['image']

    if img is None:
        # Nothing processed yet — return a minimal placeholder page
        return (
            '<html><body style="background:#111;color:#ccc;font-family:monospace;padding:2rem">'
            '<h2>MRandarin Debug</h2><p>No image processed yet.</p>'
            '</body></html>'
        )

    # Draw annotations on a copy so the stored image stays clean
    annotated = img.copy()
    markers = state['markers']
    n = len(markers)

    if state['markers_found'] and n == 4:
        # Exactly 4 — green circles + connecting lines
        pts = order_corners(markers)
        for (cx, cy) in pts:
            cv2.circle(annotated, (cx, cy), 10, (0, 255, 0), -1)
        for i in range(4):
            cv2.line(annotated, pts[i], pts[(i + 1) % 4], (0, 255, 0), 2)
    else:
        # Any other count — yellow circles with index labels
        for i, (cx, cy) in enumerate(markers):
            cv2.circle(annotated, (cx, cy), 10, (0, 220, 255), -1)
            cv2.putText(annotated, str(i), (cx + 13, cy + 5),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 220, 255), 2, cv2.LINE_AA)

    if state['character'] is not None:
        label = f"{state['character']}  conf: {state['confidence']:.2f}"
        cv2.putText(annotated, label, (10, 40),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 220, 255), 2, cv2.LINE_AA)

    # Encode annotated image as base64 PNG
    _, buf = cv2.imencode('.png', annotated)
    img_b64 = base64.b64encode(buf).decode('ascii')

    if state['markers_found']:
        markers_status = f'yes ({n})'
    else:
        markers_status = f'no ({n} detected, need 4)' if n else 'no (0 detected)'
    char_status = 'yes' if state['character'] else 'no'
    timestamp   = state['timestamp'] or 'n/a'

    html = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0.5">
  <title>MRandarin Debug</title>
  <style>
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{
      background: #111;
      color: #ddd;
      font-family: 'Courier New', monospace;
      padding: 1.5rem;
    }}
    h2 {{ color: #7ef; margin-bottom: 1rem; font-size: 1.3rem; letter-spacing: 0.05em; }}
    .status {{
      display: flex;
      gap: 2rem;
      margin-bottom: 1rem;
      font-size: 0.9rem;
    }}
    .status span {{ color: #aaa; }}
    .status b {{ color: #7ef; }}
    .yes {{ color: #4f4 !important; }}
    .no  {{ color: #f44 !important; }}
    img {{
      max-width: 100%;
      border: 1px solid #333;
      display: block;
    }}
  </style>
</head>
<body>
  <h2>MRandarin Debug View</h2>
  <div class="status">
    <span>Markers detected: <b class="{'yes' if state['markers_found'] else 'no'}">{markers_status}</b></span>
    <span>Character detected: <b class="{'yes' if state['character'] else 'no'}">{char_status}</b></span>
    <span>Last update: <b>{timestamp}</b></span>
  </div>
  <img src="data:image/png;base64,{img_b64}" alt="processed frame">
</body>
</html>"""
    return html, 200, {'Content-Type': 'text/html; charset=utf-8'}

@app.route('/lock', methods=['POST'])
def lock():
    """Manually switch the server to TRACKING_ARUCO.

    Called by the frontend's PC Master when the user presses the controller
    button (onPress on the headset → broadcast → PC Master fetches this).
    After this returns, /predict will use detect_aruco instead of
    detect_markers — immune to physical hand occlusion of the red dots,
    because the headset's ArUco holograms render on top of the hand in the
    cast.
    """
    global _state
    _state = 'TRACKING_ARUCO'
    print('[state] LOCK → TRACKING_ARUCO (manual lock from controller)')
    return jsonify({'status': 'locked', 'state': _state})

@app.route('/reset', methods=['POST'])
def reset():
    """Revert the server to SEARCHING_RED and clear all per-session state.

    Called by the frontend's R key. After this returns, the next /predict
    will run detect_markers (red dots) again. The next /lock POST will then
    re-anchor with the new corners.
    """
    global _state
    _state = 'SEARCHING_RED'
    _debug_state['locked']        = False
    _debug_state['locked_bbox']   = None
    _debug_state['character']     = None
    _debug_state['confidence']    = None
    _debug_state['markers_found'] = False
    _debug_state['markers']       = []
    _debug_state['timestamp']     = datetime.now().isoformat(timespec='seconds')
    print('[state] RESET → SEARCHING_RED')
    return jsonify({'status': 'reset', 'state': _state})

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok'})


if __name__ == '__main__':
    print('MRandarin Vision Server starting on port 1111...')
    app.run(host='0.0.0.0', port=1111, debug=False)