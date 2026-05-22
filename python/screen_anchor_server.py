"""
screen_anchor_server.py — ArUco-based screen-anchor backend.

Detects 4 ArUco markers (IDs 0-3) in a camera frame sent by the JS frontend
and returns their normalized image-space corners so the JS can solve for the
3D pose of the screen using solvePlanarPose.js.

Also persists calibration parameters (focal length, physical width/height)
to a JSON config file so the user does not need to re-tune from scratch on
every session.

ZERO PYTHON DEPENDENCIES (beyond what MRandarin already requires for the
ArUco detection itself). Uses only the standard library for HTTP — no Flask,
no flask-cors. Run with whatever Python interpreter has opencv-contrib and
numpy available (same one MRandarin uses):

    python screen_anchor_server.py          # default port 5050
    python screen_anchor_server.py 6060     # custom port

Endpoints:
    GET  /anchor/ping           — health check → { ok: true }

    POST /anchor/detect         — { image: "<base64 PNG>" }
                                → { detected: true,  corners: [[x,y], ...] }
                                  (4 points, TL TR BR BL, normalized 0-1)
                                → { detected: false, n: <int> }
                                  (fewer than 4 markers found)

    GET  /anchor/load_config    → { exists: true, fl, width, height, flPreset }
                                → { exists: false }

    POST /anchor/save_config    — { fl, width, height, flPreset }
                                → { ok: true }
"""

from __future__ import annotations

import base64
import json
import sys
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from aruco_detector import detect_aruco, order_corners, is_valid_quad

# Config file lives at the project root, next to other state JSONs
# (clientDataMessages.json, ballInfo.json, etc.). The path is computed
# relative to this file so it works regardless of where the server is
# launched from.
CONFIG_PATH = os.path.normpath(
    os.path.join(os.path.dirname(__file__), '..', 'screenAnchorConfig.json')
)


# ─── Endpoint handlers ──────────────────────────────────────────────────────
# Each handler takes the parsed request body (dict for POST, None for GET)
# and returns a dict that will be JSON-encoded as the response body. Errors
# can be signalled by returning a dict with the appropriate shape — the
# transport layer doesn't try to interpret it.

def handle_ping(_body):
    return {'ok': True}


def handle_detect(body):
    if not body or 'image' not in body:
        return {'detected': False, 'error': 'no image field in request'}

    try:
        image_bytes = base64.b64decode(body['image'])
    except Exception as e:
        return {'detected': False, 'error': f'base64 decode failed: {e}'}

    np_arr = np.frombuffer(image_bytes, dtype=np.uint8)
    bgr = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
    if bgr is None:
        return {'detected': False, 'error': 'cv2.imdecode returned None'}

    img_h, img_w = bgr.shape[:2]
    centroids = detect_aruco(bgr)
    n = len(centroids)

    if n != 4 or not is_valid_quad(centroids):
        return {'detected': False, 'n': n}

    ordered = order_corners(centroids)
    corners = [[round(x / img_w, 4), round(y / img_h, 4)] for (x, y) in ordered]

    print(f'[screen_anchor] detected — corners: {corners}')
    return {'detected': True, 'corners': corners}


def handle_load_config(_body):
    """Return the persisted calibration parameters if any.

    Response on success:
        { exists: True, fl, width, height, flPreset }
    On first-time use or corrupt file:
        { exists: False }
    """
    if not os.path.isfile(CONFIG_PATH):
        return {'exists': False}
    try:
        with open(CONFIG_PATH, 'r') as f:
            cfg = json.load(f)
        # Validate the shape — anything missing or non-numeric means we
        # treat the file as not present (the user will retune from scratch
        # rather than getting silently bad values).
        for key in ('fl', 'width', 'height'):
            if not isinstance(cfg.get(key), (int, float)):
                return {'exists': False}
        return {
            'exists':   True,
            'fl':       float(cfg['fl']),
            'width':    float(cfg['width']),
            'height':   float(cfg['height']),
            'flPreset': cfg.get('flPreset', 'Custom'),
        }
    except Exception as e:
        print(f'[screen_anchor] load_config error: {e}')
        return {'exists': False}


def handle_save_config(body):
    """Persist calibration parameters to the config JSON file.

    Body shape: { fl, width, height, flPreset? }
    """
    if not body:
        return {'ok': False, 'error': 'empty body'}
    try:
        cfg = {
            'fl':       float(body['fl']),
            'width':    float(body['width']),
            'height':   float(body['height']),
            'flPreset': str(body.get('flPreset', 'Custom')),
        }
    except (KeyError, TypeError, ValueError) as e:
        return {'ok': False, 'error': f'invalid body: {e}'}

    try:
        with open(CONFIG_PATH, 'w') as f:
            json.dump(cfg, f, indent=2)
        print(f'[screen_anchor] saved config to {CONFIG_PATH}: {cfg}')
        return {'ok': True}
    except Exception as e:
        return {'ok': False, 'error': str(e)}


# Route table. Keys are (method, path) tuples; values are handler functions.
ROUTES = {
    ('GET',  '/anchor/ping'):        handle_ping,
    ('POST', '/anchor/detect'):      handle_detect,
    ('GET',  '/anchor/load_config'): handle_load_config,
    ('POST', '/anchor/save_config'): handle_save_config,
}


# ─── HTTP transport ─────────────────────────────────────────────────────────

class AnchorHandler(BaseHTTPRequestHandler):
    """Minimal request handler: route by (method, path), send JSON back, and
    answer CORS preflight OPTIONS requests so the browser lets us in.

    CORS is handled by hand here because we're not using Flask. The browser
    sends an OPTIONS request before any cross-origin POST with a JSON body,
    and we have to respond with the right Access-Control-* headers or the
    actual POST never happens. This is the same behavior flask-cors gives
    you out of the box.
    """

    def _send_cors_headers(self):
        self.send_header('Access-Control-Allow-Origin',  '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type',   'application/json')
        self.send_header('Content-Length', str(len(body)))
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        # CORS preflight. Empty 204 with the headers is enough.
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        self._dispatch('GET', body=None)

    def do_POST(self):
        # Read the request body if there is one. Content-Length is required;
        # we don't try to handle chunked transfer encoding because no browser
        # uses it for fetch() POST.
        length = int(self.headers.get('Content-Length') or 0)
        raw    = self.rfile.read(length) if length > 0 else b''
        body   = None
        if raw:
            try:
                body = json.loads(raw.decode('utf-8'))
            except (ValueError, UnicodeDecodeError) as e:
                self._send_json({'ok': False, 'error': f'invalid JSON: {e}'}, status=400)
                return
        self._dispatch('POST', body=body)

    def _dispatch(self, method, body):
        handler = ROUTES.get((method, self.path))
        if handler is None:
            self._send_json({'ok': False, 'error': 'not found'}, status=404)
            return
        try:
            result = handler(body)
        except Exception as e:
            print(f'[screen_anchor] handler exception: {e}')
            self._send_json({'ok': False, 'error': str(e)}, status=500)
            return
        self._send_json(result)

    # Silence the default access-log spam (one line per request). We log the
    # interesting events ourselves from inside the handlers.
    def log_message(self, _format, *_args):
        pass


if __name__ == '__main__':
    port   = int(sys.argv[1]) if len(sys.argv) > 1 else 5050
    server = ThreadingHTTPServer(('0.0.0.0', port), AnchorHandler)
    print(f'[screen_anchor] listening on http://localhost:{port}')
    print(f'[screen_anchor] config file: {CONFIG_PATH}')
    print('[screen_anchor] endpoints:')
    print('  GET  /anchor/ping')
    print('  POST /anchor/detect       body: { image: "<base64 PNG>" }')
    print('  GET  /anchor/load_config')
    print('  POST /anchor/save_config  body: { fl, width, height, flPreset? }')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n[screen_anchor] shutting down')
        server.server_close()