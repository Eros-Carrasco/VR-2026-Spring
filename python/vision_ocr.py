import Vision
import Quartz
from pypinyin import pinyin, Style
from hanzipy.dictionary import HanziDictionary

# Module-level singleton — instantiated once on import.
_dictionary = HanziDictionary()


def is_chinese(text):
    """Check if text contains at least one Chinese character."""
    return any('\u4e00' <= char <= '\u9fff' for char in text)


# Number of OCR candidates to request from Vision per detected text region.
# Vision returns these ranked by its own confidence; the first one is its
# best guess, but for handwritten hanzi the first guess is sometimes wrong
# while the 2nd or 3rd is right. Pulling 3 lets the caller pick the best
# Chinese-shaped candidate instead of being stuck with whatever Vision
# returned first (which sometimes is a digit, English letter, or whitespace).
_OCR_TOP_K = 3


def run_vision_ocr(image_bytes):
    """Run Apple Vision text recognition on raw PNG bytes.

    Returns a list of observation dicts:
        [{'candidates': [(text, confidence), ...], 'bb': CGRect}, ...]

    Each observation has up to _OCR_TOP_K candidates, ranked by Vision's
    confidence (highest first). The bb is shared across candidates within
    the same observation.
    """
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
                top_candidates = obs.topCandidates_(_OCR_TOP_K)
                # Build a list of (text, confidence) tuples for all candidates
                candidates = []
                for cand in top_candidates:
                    candidates.append((cand.string(), cand.confidence()))
                bb = obs.boundingBox()  # CGRect normalized, origin bottom-left
                results.append({'candidates': candidates, 'bb': bb})

    req = Vision.VNRecognizeTextRequest.alloc().initWithCompletionHandler_(handler)
    req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    req.setRecognitionLanguages_(['zh-Hans'])
    # zh-Hans = simplified, zh-Hant = traditional. Focusing on simplified only.
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

    Wrapped in try/except because hanzipy and pypinyin can raise on rare /
    obscure characters (we observed a bare StopIteration during testing —
    PEP-479-prone code somewhere in their internals). Returning a soft default
    (`'?'`, `'unknown'`) lets the caller decide whether to accept or reject
    the candidate without taking down the whole /predict request.
    """
    try:
        py = pinyin(char, style=Style.TONE)[0][0]
    except Exception as e:
        print(f'[lookup] pinyin lookup failed for {char!r}: {e}')
        py = '?'
    try:
        definition = _dictionary.definition_lookup(char)
        # skip surname entries to get the actual meaning
        meaning = next(
            (d['definition'] for d in definition if not d['definition'].startswith('surname')),
            definition[0]['definition'] if definition else 'unknown'
        )
        meaning = meaning.split('/CL:')[0]
        meaning = '/'.join(meaning.split('/')[:3])
    except Exception as e:
        print(f'[lookup] dictionary lookup failed for {char!r}: {e}')
        meaning = 'unknown'
    return py, meaning