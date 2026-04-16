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
dictionary = HanziDictionary()

# Debug state shared between /predict and /debug
_debug_state = {
    'image': None,       # numpy BGR image (annotated copy)
    'markers': [],       # list of (x, y) centroids
    'markers_found': False,
    'character': None,
    'confidence': None,
    'timestamp': None,
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
    """Perspective-correct the region inside 4 marker centroids in-place.

    Output dimensions are always identical to the input.  Everything outside
    the marker polygon is white; the interior is perspective-corrected and
    placed back at the same screen position.
    """
    h, w = bgr_image.shape[:2]
    ordered = order_corners(centroids)   # [TL, TR, BR, BL]
    tl, tr, br, bl = ordered

    # Bounding box of the marker quad in the original image
    x_min = min(p[0] for p in ordered)
    y_min = min(p[1] for p in ordered)
    x_max = max(p[0] for p in ordered)
    y_max = max(p[1] for p in ordered)
    bbox_w = x_max - x_min
    bbox_h = y_max - y_min

    # Map the 4 marker corners → corners of the bounding-box rectangle
    src = np.array(ordered, dtype=np.float32)
    dst = np.array([
        [x_min, y_min],
        [x_max, y_min],
        [x_max, y_max],
        [x_min, y_max],
    ], dtype=np.float32)

    H = cv2.getPerspectiveTransform(src, dst)

    # Warp the whole image with the same homography — keeps all coordinates in
    # the original image space so we can composite without any offset arithmetic
    warped_full = cv2.warpPerspective(bgr_image, H, (w, h),
                                      borderMode=cv2.BORDER_CONSTANT,
                                      borderValue=(255, 255, 255))

    # Build a polygon mask for the bounding-box rectangle
    rect_poly = np.array([[x_min, y_min], [x_max, y_min],
                           [x_max, y_max], [x_min, y_max]], dtype=np.int32)
    region_mask = np.zeros((h, w), dtype=np.uint8)
    cv2.fillPoly(region_mask, [rect_poly], 255)

    # White canvas — same size as input
    canvas = np.full_like(bgr_image, 255)

    # Paste the warped region into the canvas, leave everything else white
    canvas[region_mask == 255] = warped_full[region_mask == 255]

    # Erase the marker dots so the red circles don't confuse OCR
    for (x, y) in [tl, tr, br, bl]:
        cv2.circle(canvas, (x, y), 40, (255, 255, 255), -1)

    return canvas


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
                results.append((text, confidence))

    req = Vision.VNRecognizeTextRequest.alloc().initWithCompletionHandler_(handler)
    req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    req.setRecognitionLanguages_(['zh-Hans', 'zh-Hant'])
    req.setUsesLanguageCorrection_(False)

    handler_obj = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(
        cg_image, {}
    )
    handler_obj.performRequests_error_([req], None)

    return results


@app.route('/predict', methods=['POST'])
def predict():
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({ 'character': None, 'error': 'no image' })

        image_bytes = base64.b64decode(data['image'])

        # --- Marker detection & image normalization ---
        np_arr = np.frombuffer(image_bytes, dtype=np.uint8)
        bgr = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

        centroids = detect_markers(bgr)

        if len(centroids) == 4:
            normalized_bgr = normalize_image(bgr, centroids)
            _debug_state['markers_found'] = True
            _debug_state['markers'] = centroids
            _debug_state['image'] = normalized_bgr.copy()
            ocr_src = normalized_bgr
        else:
            if centroids:
                logging.warning('Markers not found, using raw image (detected %d, need 4)', len(centroids))
            else:
                logging.warning('Markers not found, using raw image')
            _debug_state['markers_found'] = False
            _debug_state['markers'] = centroids
            _debug_state['image'] = bgr.copy()
            ocr_src = bgr

        # Contrast enhancement — boosts stroke visibility for OCR
        enhanced = cv2.convertScaleAbs(ocr_src, alpha=1.5, beta=0)
        ocr_bytes = bgr_to_png_bytes(enhanced)

        _debug_state['character'] = None
        _debug_state['confidence'] = None
        _debug_state['timestamp'] = datetime.now().isoformat(timespec='seconds')

        ocr_results = run_vision_ocr(ocr_bytes)

        for text, confidence in ocr_results:
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
                print(f'recognized: {char} {py} - {meaning} (confidence: {confidence:.2f})')
                _debug_state['character'] = char
                _debug_state['confidence'] = round(float(confidence), 2)
                return jsonify({
                    'character': char,
                    'pinyin':    py,
                    'meaning':   meaning,
                    'confidence': round(float(confidence), 2)
                })

        print('no chinese character recognized')
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