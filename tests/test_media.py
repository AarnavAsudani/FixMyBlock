import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
from PIL import Image
import pypdfium2 as pdfium

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services.analyze_media import image_frame, media_frames, source_kind, hazard_name, inference_size


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_formats_and_hazard_allowlist(self):
        for ext in ('PNG', 'jpg', 'jpeg'):
            self.assertEqual(source_kind(Path('test.' + ext)), 'image')
        self.assertEqual(source_kind(Path('test.pdf')), 'pdf')
        for label in ('person', 'car', 'motorcycle', 'bicycle'):
            self.assertIsNone(hazard_name(label))
        self.assertEqual(hazard_name('pothole'), 'Pothole candidate')

    def test_higher_detail_for_stills_without_changing_video(self):
        with patch.dict('os.environ', {}, clear=True):
            self.assertEqual(inference_size('image'), 1280)
            self.assertEqual(inference_size('pdf'), 1280)
            self.assertEqual(inference_size('video'), 640)
        with patch.dict('os.environ', {'FIXMYBLOCK_IMAGE_SIZE': '1536'}):
            self.assertEqual(inference_size('image'), 1536)
            self.assertEqual(inference_size('video'), 640)
        with patch.dict('os.environ', {'FIXMYBLOCK_IMAGE_SIZE': '1290'}):
            with self.assertRaisesRegex(ValueError, 'multiple of 32'):
                inference_size('image')

    def test_transparent_png_and_photo_orientation(self):
        path = self.root / 'transparent.png'
        Image.new('RGBA', (20, 10), (0, 0, 0, 0)).save(path)
        self.assertTrue((image_frame(path) == 255).all())
        path = self.root / 'rotated.jpeg'
        image = Image.new('RGB', (20, 10), 'white')
        exif = image.getexif()
        exif[274] = 6
        image.save(path, exif=exif)
        self.assertEqual(image_frame(path).shape[:2], (20, 10))

    def test_pdf_pages_and_render_bounds(self):
        path = self.root / 'pages.pdf'
        document = pdfium.PdfDocument.new()
        document.new_page(3000, 1000).close()
        document.new_page(400, 600).close()
        document.save(str(path))
        document.close()
        metadata = {}
        frames = list(media_frames(path, 'pdf', 1, metadata))
        self.assertEqual(metadata['pages'], 2)
        self.assertEqual([unit['pageNumber'] for _, unit in frames], [1, 2])
        self.assertLessEqual(max(frames[0][0].shape[:2]), 2000)

    def test_pdf_page_limit_and_invalid_documents(self):
        path = self.root / 'too-many.pdf'
        document = pdfium.PdfDocument.new()
        for _ in range(51):
            document.new_page(10, 10).close()
        document.save(str(path))
        document.close()
        with self.assertRaisesRegex(ValueError, '50 pages'):
            list(media_frames(path, 'pdf', 1, {}))
        path = self.root / 'bad.pdf'
        path.write_bytes(b'%PDF-invalid')
        with self.assertRaisesRegex(ValueError, 'unencrypted, valid PDF'):
            list(media_frames(path, 'pdf', 1, {}))
        path = self.root / 'bad.png'
        path.write_bytes(b'invalid')
        with self.assertRaises(Exception):
            image_frame(path)


if __name__ == '__main__':
    unittest.main()
