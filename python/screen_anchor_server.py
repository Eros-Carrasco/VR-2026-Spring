"""
screen_anchor_server.py — ArUco-based screen-anchor backend.

Detects 4 ArUco markers (IDs 0-3) in a camera frame sent by the JS frontend
and returns their normalized image-space corners so the JS can solve for the
3D pose of the screen using solvePlanarPose.js.

Also persists calibration parameters (focal length, physical width/height)
to a JSON config file so the user does not need to re-tune from scratch on
every session.

Run from the python/ directory:
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
import logging

import cv2
import numpy as np
from flask import Flask, request, jsonify
from flask_cors import CORS

sys.path.insert(0, os.path.dirname(__file__))
from vision_tracker import detect_aruco, order_corners, is_valid_quad

app = Flask(__name__)
CORS(app)

logging.getLogger('werkzeug').setLevel(logging.ERROR)

# Config file lives at the project root, next to other state JSONs
# (clientDataMessages.json, ballInfo.json, etc.). The path is computed
# relative to this file so it works regardless of where the server is
# launched from.
CONFIG_PATH = os.path.normpath(
    os.path.join(os.path.dirname(__file__), '..', 'screenAnchorConfig.json')
)


@app.route('/anchor/ping')
def ping():
    return jsonify({'ok': True})


@app.route('/anchor/detect', methods=['POST'])
def detect():
    data = request.get_json(silent=True)
    if not data or 'image' not in data:
        return jsonify({'detected': False, 'error': 'no image field in request'})

    try:
        image_bytes = base64.b64decode(data['image'])
    except Exception as e:
        return jsonify({'detected': False, 'error': f'base64 decode failed: {e}'})

    np_arr = np.frombuffer(image_bytes, dtype=np.uint8)
    bgr = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
    if bgr is None:
        return jsonify({'detected': False, 'error': 'cv2.imdecode returned None'})

    img_h, img_w = bgr.shape[:2]
    centroids = detect_aruco(bgr)
    n = len(centroids)

    if n != 4 or not is_valid_quad(centroids):
        return jsonify({'detected': False, 'n': n})

    ordered = order_corners(centroids)
    corners = [[round(x / img_w, 4), round(y / img_h, 4)] for (x, y) in ordered]

    print(f'[screen_anchor] detected — corners: {corners}')
    return jsonify({'detected': True, 'corners': corners})


@app.route('/anchor/load_config')
def load_config():
    """Return the persisted calibration parameters if any.

    Response shape on success:
        { exists: true, fl: float, width: float, height: float, flPreset: str }
    On first-time use or corrupt file:
        { exists: false }
    """
    if not os.path.isfile(CONFIG_PATH):
        return jsonify({'exists': False})
    try:
        with open(CONFIG_PATH, 'r') as f:
            cfg = json.load(f)
        # Validate the shape — anything missing or non-numeric means we
        # treat the file as not present (the user will retune from scratch
        # rather than getting silently bad values).
        for key in ('fl', 'width', 'height'):
            if not isinstance(cfg.get(key), (int, float)):
                return jsonify({'exists': False})
        return jsonify({
            'exists':   True,
            'fl':       float(cfg['fl']),
            'width':    float(cfg['width']),
            'height':   float(cfg['height']),
            'flPreset': cfg.get('flPreset', 'Custom'),
        })
    except Exception as e:
        print(f'[screen_anchor] load_config error: {e}')
        return jsonify({'exists': False})


@app.route('/anchor/save_config', methods=['POST'])
def save_config():
    """Persist calibration parameters to the config JSON file.

    Body shape:
        { fl: float, width: float, height: float, flPreset?: str }
    """
    data = request.get_json(silent=True) or {}
    try:
        cfg = {
            'fl':       float(data['fl']),
            'width':    float(data['width']),
            'height':   float(data['height']),
            'flPreset': str(data.get('flPreset', 'Custom')),
        }
    except (KeyError, TypeError, ValueError) as e:
        return jsonify({'ok': False, 'error': f'invalid body: {e}'}), 400

    try:
        with open(CONFIG_PATH, 'w') as f:
            json.dump(cfg, f, indent=2)
        print(f'[screen_anchor] saved config to {CONFIG_PATH}: {cfg}')
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5050
    print(f'[screen_anchor] listening on http://localhost:{port}')
    print(f'[screen_anchor] config file: {CONFIG_PATH}')
    print('[screen_anchor] endpoints:')
    print('  GET  /anchor/ping')
    print('  POST /anchor/detect       body: { image: "<base64 PNG>" }')
    print('  GET  /anchor/load_config')
    print('  POST /anchor/save_config  body: { fl, width, height, flPreset? }')
    app.run(host='0.0.0.0', port=port, debug=False)
