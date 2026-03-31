import base64
from flask import Flask, request, jsonify
from flask_cors import CORS
from pypinyin import pinyin, Style
from hanzipy.dictionary import HanziDictionary

import Vision
import Quartz

app = Flask(__name__)
CORS(app)
dictionary = HanziDictionary()

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
        ocr_results = run_vision_ocr(image_bytes)

        for text, confidence in ocr_results:
            if is_chinese(text):
                # extract only the first Chinese character from the recognized text
                char = next((c for c in text if '\u4e00' <= c <= '\u9fff'), None)
                if not char:
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


@app.route('/health', methods=['GET'])
def health():
    return jsonify({ 'status': 'ok' })


if __name__ == '__main__':
    print('MRandarin Vision Server starting on port 1111...')
    app.run(host='0.0.0.0', port=1111, debug=False)