"""Compatibility entry point. New code uses analyze_media.py for all formats."""
import sys

try:
    from .analyze_media import hazard_name, main, save
except ImportError:
    from analyze_media import hazard_name, main, save

if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: analyze_video.py <media-path> <result-json-path>")
    raise SystemExit(main(sys.argv[1], sys.argv[2]))
