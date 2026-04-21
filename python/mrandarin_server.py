import base64
import io
import logging
from datetime import datetime

import cv2
import numpy as np
from flask import Flask, request, jsonify
from flask_cors import CORS
from pypinyin import pinyin, Style
from hanzipy.dictionary import HanziDictionary

import Vision
import Quartz

app = Flask(__name__)
CORS(app)

# Suppress Flask's per-request access log — only show errors
logging.getLogger('werkzeug').setLevel(logging.ERROR)
dictionary = HanziDictionary()

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

def detect_markers(bgr_image):
    """Detect red marker centroids using HSV color filtering.

    Returns a list of (x, y) tuples, one per detected marker blob.
    """
    hsv = cv2.cvtColor(bgr_image, cv2.COLOR_BGR2HSV)

    # Red wraps around the hue wheel — cover both ends
    mask_low  = cv2.inRange(hsv, np.array([  0, 100,  50]), np.array([ 10, 255, 255]))
    mask_high = cv2.inRange(hsv, np.array([170, 100,  50]), np.array([180, 255, 255]))
    mask = cv2.bitwise_or(mask_low, mask_high)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    centroids = []
    for cnt in contours:
        if cv2.contourArea(cnt) < 500:
            continue
        M = cv2.moments(cnt)
        if M['m00'] == 0:
            continue
        cx = int(M['m10'] / M['m00'])
        cy = int(M['m01'] / M['m00'])
        centroids.append((cx, cy))

    return centroids


def order_corners(pts):
    """Sort 4 (x, y) points into [top-left, top-right, bottom-right, bottom-left]."""
    cx = sum(p[0] for p in pts) / 4
    cy = sum(p[1] for p in pts) / 4
    tl = next(p for p in pts if p[0] < cx and p[1] < cy)
    tr = next(p for p in pts if p[0] > cx and p[1] < cy)
    br = next(p for p in pts if p[0] > cx and p[1] > cy)
    bl = next(p for p in pts if p[0] < cx and p[1] > cy)
    return [tl, tr, br, bl]


def normalize_image(bgr_image, centroids):
    """Perspective-correct the marker region into a fixed 800x800 square centered in the output image."""
    h, w = bgr_image.shape[:2]
    ordered = order_corners(centroids)   # [TL, TR, BR, BL]

    cx, cy = w // 2, h // 2
    half = 400

    src = np.array(ordered, dtype=np.float32)
    dst = np.array([
        [cx - half, cy - half],  # top-left
        [cx + half, cy - half],  # top-right
        [cx + half, cy + half],  # bottom-right
        [cx - half, cy + half],  # bottom-left
    ], dtype=np.float32)

    H = cv2.getPerspectiveTransform(src, dst)

    warped_full = cv2.warpPerspective(bgr_image, H, (w, h),
                                      borderMode=cv2.BORDER_CONSTANT,
                                      borderValue=(255, 255, 255))

    # Mask for the fixed 800x800 destination region
    rect_poly = np.array([
        [cx - half, cy - half],
        [cx + half, cy - half],
        [cx + half, cy + half],
        [cx - half, cy + half],
    ], dtype=np.int32)
    region_mask = np.zeros((h, w), dtype=np.uint8)
    cv2.fillPoly(region_mask, [rect_poly], 255)

    canvas = np.full_like(bgr_image, 255)
    canvas[region_mask == 255] = warped_full[region_mask == 255]

    # Erase marker dots at their transformed positions in the output space
    src_pts = np.array([ordered], dtype=np.float32)
    dst_pts = cv2.perspectiveTransform(src_pts, H)[0]
    for (x, y) in dst_pts:
        cv2.circle(canvas, (int(x), int(y)), 40, (255, 255, 255), -1)

    return canvas


def is_valid_quad(centroids):
    """Return True if 4 centroids form a reasonable quadrilateral."""
    pts = np.array(order_corners(centroids), dtype=np.float32)
    if cv2.contourArea(pts) < 10000:
        return False
    for i in range(4):
        for j in range(i + 1, 4):
            if np.linalg.norm(pts[i] - pts[j]) < 100:
                return False
    return True


def bgr_to_png_bytes(bgr_image):
    """Encode a numpy BGR image to PNG bytes."""
    success, buf = cv2.imencode('.png', bgr_image)
    if not success:
        raise RuntimeError('cv2.imencode failed')
    return buf.tobytes()


def is_chinese(text):
    """Check if text contains at least one Chinese character."""
    return any('\u4e00' <= char <= '\u9fff' for char in text)

def run_vision_ocr(image_bytes):
    """Run Apple Vision text recognition on raw PNG bytes."""
    data = Quartz.CFDataCreate(None, image_bytes, len(image_bytes))
    data_provider = Quartz.CGDataProviderCreateWithCFData(data)
    cg_image = Quartz.CGImageCreateWithPNGDataProvider(
        data_provider, None, False, Quartz.kCGRenderingIntentDefault
    )

    results = []

    def handler(request, error):
        if error:
            return
        observations = request.results()
        if observations:
            for obs in observations:
                text = obs.topCandidates_(1)[0].string()
                confidence = obs.topCandidates_(1)[0].confidence()
                bb = obs.boundingBox()  # CGRect normalized, origin bottom-left
                results.append((text, confidence, bb))

    req = Vision.VNRecognizeTextRequest.alloc().initWithCompletionHandler_(handler)
    req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    req.setRecognitionLanguages_(['zh-Hans', 'zh-Hant'])
    req.setUsesLanguageCorrection_(False)

    handler_obj = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(
        cg_image, {}
    )
    handler_obj.performRequests_error_([req], None)

    return results


def check_if_erased(bgr, bbox):
    """Return True if the bbox region contains fewer than 2% dark pixels (< 80 gray)."""
    x, y, w, h = bbox
    # Clamp to image bounds
    img_h, img_w = bgr.shape[:2]
    x1, y1 = max(x, 0), max(y, 0)
    x2, y2 = min(x + w, img_w), min(y + h, img_h)
    region = bgr[y1:y2, x1:x2]
    if region.size == 0:
        return True
    gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
    dark_count = int(np.sum(gray < 80))
    total = gray.size
    return dark_count < 0.02 * total


@app.route('/predict', methods=['POST'])
def predict():
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({ 'character': None, 'error': 'no image' })

        image_bytes = base64.b64decode(data['image'])

        np_arr = np.frombuffer(image_bytes, dtype=np.uint8)
        bgr = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

        # --- Lock-on: skip OCR while a character is locked, check for erase instead ---
        if _debug_state['locked']:
            centroids = detect_markers(bgr)
            valid_quad = len(centroids) == 4 and is_valid_quad(centroids)
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
            if check_if_erased(check_src, _debug_state['locked_bbox']):
                _debug_state['locked'] = False
                _debug_state['locked_bbox'] = None
                _debug_state['character'] = None
                _debug_state['confidence'] = None
                _debug_state['timestamp'] = datetime.now().isoformat(timespec='seconds')
                return jsonify({'character': None, 'erased': True})
            return jsonify({'character': None})

        img_h, img_w = bgr.shape[:2]

        # --- Marker detection & image normalization ---
        centroids = detect_markers(bgr)
        valid_quad = len(centroids) == 4 and is_valid_quad(centroids)

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
                py = pinyin(char, style=Style.TONE)[0][0]
                definition = dictionary.definition_lookup(char)
                # skip surname entries to get the actual meaning
                meaning = next(
                    (d['definition'] for d in definition if not d['definition'].startswith('surname')),
                    definition[0]['definition'] if definition else 'unknown'
                )
                meaning = meaning.split('/CL:')[0]
                meaning = '/'.join(meaning.split('/')[:3])

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

        return jsonify({ 'character': None })

    except Exception as e:
        print(f'error: {e}')
        return jsonify({ 'character': None, 'error': str(e) })


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


@app.route('/health', methods=['GET'])
def health():
    return jsonify({ 'status': 'ok' })


if __name__ == '__main__':
    print('MRandarin Vision Server starting on port 1111...')
    app.run(host='0.0.0.0', port=1111, debug=False)