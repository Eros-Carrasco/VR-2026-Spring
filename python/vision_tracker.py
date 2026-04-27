import cv2
import numpy as np


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


# ── ArUco detector setup (DICT_4X4_50, IDs 0-3 mapped to TL, TR, BR, BL) ────
# Uses the OpenCV 4.7+ ArucoDetector class with a graceful fallback to the
# legacy procedural API for older OpenCV builds. Requires opencv-contrib-python
# (the cv2.aruco module is NOT in plain opencv-python).
try:
    _aruco_dict     = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    _aruco_params   = cv2.aruco.DetectorParameters()
    _aruco_detector = cv2.aruco.ArucoDetector(_aruco_dict, _aruco_params)
    _USE_NEW_ARUCO  = True
except AttributeError:
    # OpenCV ≤ 4.6
    _aruco_dict     = cv2.aruco.Dictionary_get(cv2.aruco.DICT_4X4_50)
    _aruco_params   = cv2.aruco.DetectorParameters_create()
    _aruco_detector = None
    _USE_NEW_ARUCO  = False


def detect_aruco(bgr_image):
    """Detect ArUco marker centroids (IDs 0-3 only).

    Drop-in replacement for detect_markers — returns a list of (x, y) tuples,
    one per detected marker, in arbitrary order. order_corners() will sort
    them spatially into [TL, TR, BR, BL] downstream, same as for red dots.
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
        # marker_corners shape: (1, 4, 2) — average the 4 corners for the center
        pts = marker_corners[0]
        cx = int(pts[:, 0].mean())
        cy = int(pts[:, 1].mean())
        centroids.append((cx, cy))
    return centroids