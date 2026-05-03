import atexit
import base64
import json
import logging
import os
from datetime import datetime
from pathlib import Path

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

# Confidence threshold below which Apple Vision OCR results are discarded.
# Lowered from 0.5 to 0.3 because handwritten hanzi on a whiteboard rarely
# gets confidence above 0.5, even when the recognition is correct. The user
# manually confirmed during testing that legible characters were being
# silently rejected at the old threshold.
OCR_CONFIDENCE_THRESHOLD = 0.30

# ── Session logging ─────────────────────────────────────────────────────────
# Every /predict call appends one JSON-line to a session file. On /reset, the
# current file is closed and a new one is opened — so each session (between
# resets) gets its own log. Also records lock/reset events.
#
# File location: <cwd>/mrandarin_sessions/session_<YYYYmmdd_HHMMSS>.jsonl
# Flushed on every write so we don't lose data on crash. The user can open
# the file in any text editor or `jq`/`head`/`grep` it from a terminal.
_SESSION_DIR = Path(os.environ.get('MRANDARIN_SESSION_DIR', 'mrandarin_sessions'))
_session_file = None
_session_path = None

def _open_new_session_file():
    global _session_file, _session_path
    if _session_file is not None:
        try:
            _session_file.close()
        except Exception:
            pass
    _SESSION_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    _session_path = _SESSION_DIR / f'session_{ts}.jsonl'
    # Line-buffered so each write hits disk immediately.
    _session_file = open(_session_path, 'a', buffering=1, encoding='utf-8')
    print(f'[session] logging to {_session_path}')

def _log_event(event):
    """Append one event dict to the session log as a JSON line."""
    if _session_file is None:
        _open_new_session_file()
    event = dict(event)  # don't mutate caller's dict
    event['t'] = datetime.now().isoformat(timespec='milliseconds')
    try:
        _session_file.write(json.dumps(event, ensure_ascii=False) + '\n')
    except Exception as e:
        # Logging must NEVER kill the request. Print and move on.
        print(f'[session] write failed: {e}')

@atexit.register
def _close_session_file():
    if _session_file is not None:
        try:
            _session_file.close()
        except Exception:
            pass

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
                _log_event({
                    'event': 'predict',
                    'phase': 'locked_no_quad',
                    'state': _state,
                    'n_centroids': len(centroids),
                })
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
                _log_event({
                    'event': 'erase_detected',
                    'state': _state,
                })
                return jsonify({'character': None, 'erased': True, 'src_corners': src_corners})
            _log_event({
                'event': 'predict',
                'phase': 'locked_holding',
                'state': _state,
            })
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
            _log_event({
                'event': 'predict',
                'phase': 'no_quad',
                'state': _state,
                'n_centroids': len(centroids),
            })
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

        # Build a JSON-friendly snapshot of all OCR observations for the session
        # log. Keep this BEFORE we start filtering / accepting, so the log
        # captures EVERYTHING Vision returned, even results we eventually skip.
        log_observations = []
        for obs in ocr_results:
            log_observations.append({
                'candidates': [
                    {'text': t, 'confidence': round(float(c), 3)}
                    for (t, c) in obs['candidates']
                ],
            })

        # ── Pick the best candidate ──────────────────────────────────────────
        # vision_ocr now returns up to 3 candidates per observation, ranked by
        # Vision's own confidence. Iterate through ALL candidates in ALL
        # observations and pick the first one that:
        #   1. contains at least one Chinese character (\u4e00..\u9fff)
        #   2. has confidence ≥ OCR_CONFIDENCE_THRESHOLD
        # This is more permissive than the old "only check candidate #1" loop
        # — Vision's #1 pick on handwritten hanzi is sometimes a digit or a
        # Latin letter while #2 / #3 is the correct character.
        accepted = None  # (char, confidence, bb)
        rejection_reasons = []  # for the session log
        for obs in ocr_results:
            bb = obs['bb']
            for (text, confidence) in obs['candidates']:
                if not is_chinese(text):
                    rejection_reasons.append({
                        'text': text,
                        'confidence': round(float(confidence), 3),
                        'reason': 'not_chinese',
                    })
                    continue
                # Extract only the first Chinese character from the recognized text
                char = next((c for c in text if '\u4e00' <= c <= '\u9fff'), None)
                if not char:
                    rejection_reasons.append({
                        'text': text,
                        'confidence': round(float(confidence), 3),
                        'reason': 'no_hanzi_in_text',
                    })
                    continue
                if confidence < OCR_CONFIDENCE_THRESHOLD:
                    print(f'Low confidence result: {char} ({confidence:.2f}), skipping')
                    rejection_reasons.append({
                        'text': text,
                        'char': char,
                        'confidence': round(float(confidence), 3),
                        'reason': f'below_threshold_{OCR_CONFIDENCE_THRESHOLD}',
                    })
                    continue
                accepted = (char, float(confidence), bb)
                break
            if accepted is not None:
                break

        if accepted is None:
            # Nothing usable in this frame
            _log_event({
                'event': 'predict',
                'phase': 'ocr_no_match',
                'state': _state,
                'observations': log_observations,
                'rejections': rejection_reasons,
                'threshold': OCR_CONFIDENCE_THRESHOLD,
            })
            return jsonify({'character': None, 'src_corners': _src_corners_payload(centroids, img_w, img_h)})

        char, confidence, bb = accepted
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

        _log_event({
            'event': 'predict',
            'phase': 'character_recognized',
            'state': _state,
            'observations': log_observations,
            'accepted': {
                'char': char,
                'pinyin': py,
                'meaning': meaning,
                'confidence': round(float(confidence), 3),
            },
            'threshold': OCR_CONFIDENCE_THRESHOLD,
        })

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

    except Exception as e:
        print(f'error: {e}')
        # Log the exception to the session file too — otherwise silent failures
        # in this handler would not show up anywhere.
        try:
            _log_event({
                'event': 'predict',
                'phase': 'exception',
                'error': str(e),
                'error_type': type(e).__name__,
            })
        except Exception:
            pass
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
    _log_event({'event': 'lock', 'state': _state})
    return jsonify({'status': 'locked', 'state': _state})

@app.route('/reset', methods=['POST'])
def reset():
    """Revert the server to SEARCHING_RED and clear all per-session state.

    Called by the frontend's R key. After this returns, the next /predict
    will run detect_markers (red dots) again. The next /lock POST will then
    re-anchor with the new corners. Also rotates the session log file — the
    current session's log is closed and a fresh file is opened for the next
    session, so each session has its own self-contained .jsonl.
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
    _log_event({'event': 'reset', 'state': _state})
    # Rotate the log file so the next session goes into a new .jsonl.
    _open_new_session_file()
    return jsonify({'status': 'reset', 'state': _state})

@app.route('/session_log', methods=['GET'])
def session_log():
    """Return metadata about the current session log file plus its contents.

    Useful for grabbing the log mid-session from a browser tab without
    needing terminal access. The file is being written line-by-line so this
    is safe to call any time.
    """
    if _session_path is None or not _session_path.exists():
        return jsonify({'path': None, 'lines': 0, 'events': []})
    try:
        with open(_session_path, 'r', encoding='utf-8') as f:
            raw = f.readlines()
        events = []
        for line in raw:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except Exception:
                events.append({'_parse_error': line})
        return jsonify({
            'path': str(_session_path),
            'lines': len(events),
            'events': events,
        })
    except Exception as e:
        return jsonify({'path': str(_session_path), 'error': str(e)})

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok'})


if __name__ == '__main__':
    # Open the first session log file before the server starts accepting
    # requests, so we have a valid handle on the very first /predict.
    _open_new_session_file()
    print('MRandarin Vision Server starting on port 1111...')
    print(f'  • OCR confidence threshold: {OCR_CONFIDENCE_THRESHOLD}')
    print(f'  • Session log:              {_session_path}')
    print(f'  • View log live:            http://localhost:1111/session_log')
    app.run(host='0.0.0.0', port=1111, debug=False)