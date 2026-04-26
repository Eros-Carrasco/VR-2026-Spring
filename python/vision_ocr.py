import Vision
import Quartz
from pypinyin import pinyin, Style
from hanzipy.dictionary import HanziDictionary

# Module-level singleton — instantiated once on import.
_dictionary = HanziDictionary()


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
    req.setRecognitionLanguages_(['zh-Hans'])
    # req.setRecognitionLanguages_(['zh-Hans', 'zh-Hant']) Hans is simplified, Hant is traditional. For now I'll focus on simplified.
    req.setUsesLanguageCorrection_(False)

    handler_obj = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(
        cg_image, {}
    )
    handler_obj.performRequests_error_([req], None)

    return results


def lookup_pinyin_and_meaning(char):
    """Return (pinyin_with_tone, meaning) for a single Chinese character.

    Skips surname-only definitions when other meanings exist; trims classifier
    info (/CL:...) and caps the meaning to its first 3 slash-separated glosses.
    """
    py = pinyin(char, style=Style.TONE)[0][0]
    definition = _dictionary.definition_lookup(char)
    # skip surname entries to get the actual meaning
    meaning = next(
        (d['definition'] for d in definition if not d['definition'].startswith('surname')),
        definition[0]['definition'] if definition else 'unknown'
    )
    meaning = meaning.split('/CL:')[0]
    meaning = '/'.join(meaning.split('/')[:3])
    return py, meaning