"""Local YOLO analysis for PNG/JPEG images, PDF pages, and sampled video frames."""
from __future__ import annotations

import json
import math
import os
import sys
import warnings
from pathlib import Path

MAX_PDF_PAGES = 50
MAX_IMAGE_PIXELS = 40_000_000
MAX_RENDER_EDGE = 2000


def save(path: str, payload: dict) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(payload, indent=2), encoding="utf-8")


def progress(message: str) -> None:
    print("FIXMYBLOCK_PROGRESS " + json.dumps({"message": message}), flush=True)


def hazard_name(label: str) -> str | None:
    normalized = label.lower().replace("_", " ").replace("-", " ").strip()
    return {
        "pothole": "Pothole candidate", "potholes": "Pothole candidate",
        "road crack": "Road-surface crack candidate", "crack": "Road-surface crack candidate",
        "cracked sidewalk": "Cracked sidewalk candidate", "sidewalk crack": "Cracked sidewalk candidate",
        "blocked drain": "Blocked storm drain candidate", "storm drain blockage": "Blocked storm drain candidate",
        "fallen branch": "Fallen branch candidate", "road debris": "Road debris candidate",
        "debris": "Road debris candidate", "road obstruction": "Road obstruction candidate",
    }.get(normalized)


def source_kind(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in {".png", ".jpg", ".jpeg"}:
        return "image"
    if suffix == ".pdf":
        return "pdf"
    if suffix in {".mp4", ".mov"}:
        return "video"
    raise ValueError("Supported formats: PNG, JPG/JPEG, PDF, MP4, and MOV.")


def inference_size(kind: str) -> int:
    # Small defects in aerial photos can disappear at the video-sized input.
    # Keep the existing video path unchanged and spend more detail on stills.
    if kind == "video":
        return 640
    size = int(os.getenv("FIXMYBLOCK_IMAGE_SIZE", "1280"))
    if not 256 <= size <= 2048 or size % 32:
        raise ValueError("FIXMYBLOCK_IMAGE_SIZE must be a multiple of 32 between 256 and 2048.")
    return size


def image_frame(path: Path):
    import cv2
    import numpy as np
    from PIL import Image, ImageOps

    with Image.open(path) as original:
        if original.width * original.height > MAX_IMAGE_PIXELS:
            raise ValueError("This image is too large to analyze. Resize it below 40 megapixels.")
        original.load()
        image = ImageOps.exif_transpose(original)
        # Transparent PNGs need a visible background rather than black pixels.
        if image.mode in {"RGBA", "LA"} or "transparency" in image.info:
            rgba = image.convert("RGBA")
            image = Image.new("RGB", rgba.size, "white")
            image.paste(rgba, mask=rgba.getchannel("A"))
        else:
            image = image.convert("RGB")
        return cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)


def media_frames(path: Path, kind: str, sample_seconds: float, metadata: dict):
    import cv2

    if kind == "image":
        frame = image_frame(path)
        metadata.update({"images": 1, "resolution": [frame.shape[1], frame.shape[0]]})
        yield frame, {"sourceUnit": "Image", "imageNumber": 1}
        return

    if kind == "pdf":
        try:
            import pypdfium2 as pdfium
        except ImportError as error:
            raise RuntimeError("PDF support needs pypdfium2. Run: python -m pip install -r requirements.txt") from error
        try:
            document = pdfium.PdfDocument(str(path))
        except Exception as error:
            raise ValueError("Could not open this PDF. Export an unencrypted, valid PDF and upload it again.") from error
        try:
            metadata["pages"] = len(document)
            if not 1 <= len(document) <= MAX_PDF_PAGES:
                raise ValueError(f"PDFs must contain between 1 and {MAX_PDF_PAGES} pages. Split this PDF into smaller files.")
            for index in range(len(document)):
                page = document[index]
                bitmap = None
                try:
                    width, height = page.get_size()
                    if width <= 0 or height <= 0:
                        raise ValueError(f"Page {index + 1} has invalid dimensions.")
                    scale = min(2.0, MAX_RENDER_EDGE / max(width, height))
                    bitmap = page.render(scale=scale)
                    import numpy as np
                    frame = cv2.cvtColor(np.asarray(bitmap.to_pil().convert("RGB")), cv2.COLOR_RGB2BGR)
                    yield frame, {"sourceUnit": f"Page {index + 1}", "pageNumber": index + 1}
                finally:
                    if bitmap is not None:
                        bitmap.close()
                    page.close()
        finally:
            document.close()
        return

    capture = cv2.VideoCapture(str(path))
    try:
        if not capture.isOpened():
            raise ValueError("Could not open this video. Try exporting it as an MP4 with H.264 encoding.")
        fps = capture.get(cv2.CAP_PROP_FPS)
        if not math.isfinite(fps) or fps <= 0:
            fps = 30.0
        metadata.update({"frames": int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0), "resolution": [int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)), int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))]})
        every = max(1, int(fps * sample_seconds))
        number = 0
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            if number % every == 0:
                seconds = number / fps
                timestamp = f"{int(seconds // 60):02d}:{int(seconds % 60):02d}"
                yield frame, {"sourceUnit": timestamp, "frame": number, "timestamp": timestamp, "timeBucket": int(seconds // 5)}
            number += 1
        if number == 0:
            raise ValueError("The video contains no readable frames. Try exporting it as an H.264 MP4.")
    finally:
        capture.release()


def main(input_path: str, output_path: str) -> int:
    frames = None
    try:
        from ultralytics import YOLO
        from PIL import Image
        Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
        warnings.simplefilter("error", Image.DecompressionBombWarning)

        path = Path(input_path)
        kind = source_kind(path)
        size = inference_size(kind)
        bundled = Path(__file__).resolve().parents[1] / "models" / "pothole-yolov8s.pt"
        model_path = os.getenv("FIXMYBLOCK_MODEL", str(bundled if bundled.exists() else "yolo11n.pt"))
        confidence = float(os.getenv("FIXMYBLOCK_CONFIDENCE", "0.55"))
        sample_seconds = float(os.getenv("FIXMYBLOCK_SAMPLE_SECONDS", "1"))
        if not 0 < confidence <= 1 or not math.isfinite(sample_seconds) or sample_seconds <= 0:
            raise ValueError("Detection confidence must be between 0 and 1, and video sample interval must be positive.")
        progress("Loading detection model…")
        model = YOLO(model_path)
        labels = list(model.names.values())
        # This published single-class checkpoint stores its pothole label as "0".
        numeric_pothole = Path(model_path).name == "pothole-yolov8s.pt" and labels == ["0"]
        road_labels = ["pothole"] if numeric_pothole else [label for label in labels if hazard_name(label)]
        metadata: dict = {"mediaType": kind, "inferenceSize": size, "confidenceThreshold": confidence}
        candidates: list[dict] = []
        ignored: dict[str, int] = {}
        seen: set[tuple[str, int]] = set()
        analyzed = 0
        frames = media_frames(path, kind, sample_seconds, metadata)
        for frame, unit in frames:
            analyzed += 1
            if kind == "pdf":
                progress(f"Analyzing page {unit['pageNumber']} of {metadata['pages']}…")
            else:
                progress(f"Analyzing {'image' if kind == 'image' else 'video frame at ' + unit['timestamp']}…")
            result = model(frame, conf=confidence, imgsz=size, verbose=False)[0]
            for box in result.boxes:
                raw_label = result.names[int(box.cls[0])]
                label = "pothole" if numeric_pothole and raw_label == "0" else raw_label
                hazard_type = hazard_name(label)
                if not hazard_type:
                    ignored[label] = ignored.get(label, 0) + 1
                    continue
                if kind == "video":
                    key = (label, unit["timeBucket"])
                    if key in seen:
                        continue
                    seen.add(key)
                candidates.append({"type": hazard_type, "label": label, "confidence": round(float(box.conf[0]), 4), "bbox": [round(float(value), 1) for value in box.xyxy[0]], **{key: value for key, value in unit.items() if key != "timeBucket"}})
        save(output_path, {"status": "completed", "model": model_path, **metadata, "analyzedUnits": analyzed, "sampledFrames": analyzed if kind == "video" else 0, "candidates": candidates[:100], "totalCandidates": len(candidates), "truncated": len(candidates) > 100, "ignoredObjects": ignored, "roadDefectLabels": road_labels})
        return 0
    except ImportError as error:
        save(output_path, {"status": "failed", "error": f"Missing analysis dependency: {error}. Run: python -m pip install -r requirements.txt"})
        return 1
    except Exception as error:
        save(output_path, {"status": "failed", "error": str(error)})
        return 1
    finally:
        if frames is not None:
            frames.close()


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: analyze_media.py <image-pdf-or-video-path> <result-json-path>")
    raise SystemExit(main(sys.argv[1], sys.argv[2]))
