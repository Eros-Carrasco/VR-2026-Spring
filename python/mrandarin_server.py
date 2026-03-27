import base64
import json
from flask import Flask, request, jsonify
import numpy as np
import cv2
from PIL import Image
import io

# Apple Vision Framework
import Vision
import Quartz

app = Flask(__name__)

def is_chinese(text):
    """Check if text contains at least one Chinese character."""
    return any('\u4e00' <= char <= '\u9fff' for char in text)

def preprocess_image(image_bytes):
    """
    Convert raw image bytes to a clean black-on-white image for Vision.
    - Convert to grayscale
    - Find bounding box of dark pixels (the stroke)
    - Crop tightly to the stroke
    - Add padding
    - Resize to 128x128
    """
    # Load image
    img = Image.open(io.BytesIO(image_bytes)).convert('RGB')
    img_np = np.array(img)

    # Convert to grayscale
    gray = cv2.cvtColor(img_np, cv2.COLOR_RGB2GRAY)

    # Threshold — pixels darker than 80 are stroke
    _, binary = cv2.threshold(gray, 80, 255, cv2.THRESH_BINARY_INV)

    # Find bounding box of all dark pixels
    coords = cv2.findNonZero(binary)
    if coords is None:
        return None  # nothing drawn

    x, y, w, h = cv2.boundingRect(coords)

    # Add padding (20% of the larger dimension)
    pad = int(max(w, h) * 0.2)
    x = max(0, x - pad)
    y = max(0, y - pad)
    w = min(gray.shape[1] - x, w + 2 * pad)
    h = min(gray.shape[0] - y, h + 2 * pad)

    # Crop to the stroke
    cropped = gray[y:y+h, x:x+w]

    # Resize to 128x128
    resized = cv2.resize(cropped, (128, 128), interpolation=cv2.INTER_AREA)

    # Threshold again to clean up compression artifacts
    _, clean = cv2.threshold(resized, 128, 255, cv2.THRESH_BINARY)

    return clean

def run_vision_ocr(image_np):
    """Run Apple Vision text recognition on a numpy grayscale image."""

    # Convert numpy array to PNG bytes
    pil_img = Image.fromarray(image_np)
    buf = io.BytesIO()
    pil_img.save(buf, format='PNG')
    png_bytes = buf.getvalue()

    # Create CGImage from PNG bytes
    data = Quartz.CFDataCreate(None, png_bytes, len(png_bytes))
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

    # Create Vision request
    req = Vision.VNRecognizeTextRequest.alloc().initWithCompletionHandler_(handler)
    req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    # Enable Chinese recognition
    req.setRecognitionLanguages_(['zh-Hans', 'zh-Hant'])
    req.setUsesLanguageCorrection_(False)

    # Run request
    handler_obj = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(
        cg_image, {}
    )
    handler_obj.performRequests_error_([req], None)

    return results


@app.route('/predict', methods=['POST'])
def predict():
    try:
        # Get image from request — sent as base64 PNG from the scene
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({ 'character': None, 'error': 'no image' })

        image_bytes = base64.b64decode(data['image'])

        # Preprocess
        clean_image = preprocess_image(image_bytes)
        if clean_image is None:
            return jsonify({ 'character': None, 'reason': 'nothing drawn' })

        # Run OCR
        ocr_results = run_vision_ocr(clean_image)

        # Find first Chinese character result
        for text, confidence in ocr_results:
            if is_chinese(text):
                print(f'recognized: {text} (confidence: {confidence:.2f})')
                return jsonify({
                    'character': text,
                    'confidence': round(float(confidence), 2)
                })

        print('no chinese character recognized')
        return jsonify({ 'character': None })

    except Exception as e:
        print(f'error: {e}')
        return jsonify({ 'character': None, 'error': str(e) })


@app.route('/health', methods=['GET'])
def health():
    return jsonify({ 'status': 'ok' })


if __name__ == '__main__':
    print('MRandarin Vision Server starting on port 5050...')
    app.run(host='0.0.0.0', port=5050, debug=False)
