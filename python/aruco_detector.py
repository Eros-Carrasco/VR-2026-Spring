"""
aruco_detector.py — minimal ArUco marker detection for screen-anchor calibration.

Exposes three functions used by screen_anchor_server.py:
  - detect_aruco(bgr_image) → list of (x, y) centroids for markers IDs 0-3
  - order_corners(pts)      → sort 4 points into [TL, TR, BR, BL]
  - is_valid_quad(centroids) → sanity-check that 4 points form a reasonable rectangle

Requires opencv-contrib-python (the cv2.aruco module is NOT in plain
opencv-python). The detector uses the DICT_4X4_50 marker dictionary and
only accepts markers with IDs 0, 1, 2, 3 — these map to the four corners
of the calibration popup (top-left, top-right, bottom-right, bottom-left).
"""

import cv2
import numpy as np


# ── ArUco detector setup ────────────────────────────────────────────────────
# OpenCV 4.7+ exposes the ArucoDetector class; older versions use the
# procedural API. We try the new one first and fall back gracefully so the
# code runs on both. The dictionary and parameters are module-level
# singletons so we don't reconstruct them on every call to detect_aruco.

try:
    _aruco_dict     = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    _aruco_params   = cv2.aruco.DetectorParameters()
    _aruco_detector = cv2.aruco.ArucoDetector(_aruco_dict, _aruco_params)
    _USE_NEW_ARUCO  = True
except AttributeError:
    # OpenCV ≤ 4.6 path
    _aruco_dict     = cv2.aruco.Dictionary_get(cv2.aruco.DICT_4X4_50)
    _aruco_params   = cv2.aruco.DetectorParameters_create()
    _aruco_detector = None
    _USE_NEW_ARUCO  = False


def detect_aruco(bgr_image):
    """Detect ArUco marker centroids in the image.

    Only markers with IDs 0-3 are accepted; any others are ignored. Returns
    a list of (x, y) integer tuples in detection order — call order_corners
    afterwards to sort them spatially.
    """
    if _USE_NEW_ARUCO:
        corners, ids, _ = _aruco_detector.detectMarkers(bgr_image)
    else:
        corners, ids, _ = cv2.aruco.detectMarkers(
            bgr_image, _aruco_dict, parameters=_aruco_params
        )
    if ids is None:
        return []

    centroids = []
    for marker_corners, marker_id in zip(corners, ids.flatten()):
        if int(marker_id) not in (0, 1, 2, 3):
            continue
        # marker_corners has shape (1, 4, 2) — the four corners of the
        # detected square. Averaging them gives the marker center.
        pts = marker_corners[0]
        cx = int(pts[:, 0].mean())
        cy = int(pts[:, 1].mean())
        centroids.append((cx, cy))
    return centroids


def order_corners(pts):
    """Sort 4 (x, y) points into [top-left, top-right, bottom-right, bottom-left].

    Uses the centroid of the four points as a reference: a point is TL if it
    is left-and-above the centroid, TR if right-and-above, etc. Assumes the
    quad is roughly axis-aligned (which is true for our screen calibration
    popup — the four ArUcos sit at the four window corners).
    """
    cx = sum(p[0] for p in pts) / 4
    cy = sum(p[1] for p in pts) / 4
    tl = next(p for p in pts if p[0] < cx and p[1] < cy)
    tr = next(p for p in pts if p[0] > cx and p[1] < cy)
    br = next(p for p in pts if p[0] > cx and p[1] > cy)
    bl = next(p for p in pts if p[0] < cx and p[1] > cy)
    return [tl, tr, br, bl]


def is_valid_quad(centroids):
    """Return True if 4 centroids form a reasonable quadrilateral.

    Rejects degenerate cases: collinear points, points too close together,
    or a quad whose area is suspiciously small (likely a misdetection in a
    crowded part of the image). The thresholds are tuned for typical cast
    resolutions (a few hundred pixels per side); they reject obvious noise
    without being so strict that valid distant captures fail.
    """
    pts = np.array(order_corners(centroids), dtype=np.float32)
    if cv2.contourArea(pts) < 10000:
        return False
    for i in range(4):
        for j in range(i + 1, 4):
            if np.linalg.norm(pts[i] - pts[j]) < 100:
                return False
    return True
