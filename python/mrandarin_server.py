import base64
from flask import Flask, request, jsonify
import io
from flask_cors import CORS

# Apple Vision Framework
import Vision
import Quartz

app = Flask(__name__)
CORS(app)

def is_chinese(text):
    """Check if text contains at least one Chinese character."""
    return any('\u4e00' <= char <= '\u9fff' for char in text)

def run_vision_ocr(image_bytes):
    """Run Apple Vision text recognition directly on raw PNG bytes."""

    # Create CGImage from PNG bytes
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

    # Create Vision request
    req = Vision.VNRecognizeTextRequest.alloc().initWithCompletionHandler_(handler)
    req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
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
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({ 'character': None, 'error': 'no image' })

        image_bytes = base64.b64decode(data['image'])

        # Send raw image directly to Vision — no preprocessing
        ocr_results = run_vision_ocr(image_bytes)

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
    print('MRandarin Vision Server starting on port 1111...')
    app.run(host='0.0.0.0', port=1111, debug=False)