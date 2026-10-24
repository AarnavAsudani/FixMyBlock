"""Generate temporary, local test inputs; never download or bundle footage."""
import os
import sys
from pathlib import Path
import cv2
import numpy as np
from PIL import Image

root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
blank = Image.new('RGB', (640, 480), 'white')
image = blank
positive_video = os.getenv('FIXMYBLOCK_TEST_POTHOLE_VIDEO')
if positive_video:
    capture = cv2.VideoCapture(positive_video)
    capture.set(cv2.CAP_PROP_POS_FRAMES, 150)
    ok, frame = capture.read()
    capture.release()
    if not ok:
        raise RuntimeError('The positive fixture video must have a readable frame 150.')
    image = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
for extension in ('png', 'jpg', 'jpeg'):
    image.save(root / f'inspection.{extension}')
blank.save(root / 'inspection.pdf', save_all=True, append_images=[image], resolution=96)
writer = cv2.VideoWriter(str(root / 'inspection.mp4'), cv2.VideoWriter_fourcc(*'mp4v'), 5, (320, 240))
if not writer.isOpened():
    raise RuntimeError('Cannot create the test MP4 with the installed OpenCV codecs.')
for _ in range(5):
    writer.write(np.full((240, 320, 3), 255, dtype=np.uint8))
writer.release()
(root / 'corrupt.pdf').write_bytes(b'%PDF-1.7\nNot actually a PDF')
