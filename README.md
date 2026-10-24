# FixMyBlock — Local Prototype

A runnable local dashboard and image/PDF/video-analysis prototype for neighborhood infrastructure inspections. It converts the architecture concept into an interactive workflow:

1. Plan a survey mission.
2. Upload a PNG/JPEG image, PDF, or video for local YOLO analysis.
3. Review detection candidates; the map is illustrative, not verified GPS output.
4. Confirm or dismiss items.
5. Generate a weekly condition report.

## Run locally

Prerequisites: Node.js 18 or later and Python 3.11 or later.

```powershell
git clone https://github.com/AarnavAsudani/FixMyBlock.git
cd FixMyBlock
python -m pip install -r requirements.txt
Invoke-WebRequest -Uri "https://huggingface.co/peterhdd/pothole-detection-yolov8/resolve/main/best.pt" -OutFile "models/pothole-yolov8s.pt"
node server.js
```

Then open [http://localhost:3000](http://localhost:3000).

Model weights are downloaded separately and are not committed to this repository. The checkpoint used during development has this SHA-256 checksum:

```powershell
Get-FileHash models/pothole-yolov8s.pt -Algorithm SHA256
# AF2AC6CE7BFEC72E71643659AC946CAF80CED84869E526A60135C457ABFBB200
```

There are no API keys required. The default model is a pothole-specific YOLOv8s checkpoint stored at `models/pothole-yolov8s.pt`. Its source and license are recorded in `models/THIRD_PARTY_NOTICES.md`. For development with automatic server restarts, use `node --watch server.js`.

On macOS/Linux, download the same checkpoint URL to `models/pothole-yolov8s.pt` using your browser or `curl -L`. The remaining Python and Node commands are the same. Uploads, analysis records, environment files, caches, and model binaries are excluded from Git; keep personal footage local.

## What is included

- Interactive operations dashboard with summary metrics and an illustrative map; file detections remain in the review queue without invented GPS locations
- Mock mission planner with coverage, altitude, ETA, and waypoint estimates
- Upload flow for PNG, JPG/JPEG, PDF, MP4, and MOV, with local YOLO analysis
- AI review queue where hazards can be confirmed or dismissed
- Weekly report view and print/save-as-PDF action
- Small JSON API; missions and review decisions persist locally in `jobs/dashboard-state.json`

The upload dialog shows the selected filename, file size, actual transfer progress, and analysis state. You can close and reopen the dialog while analysis runs, then upload another file when it completes. Browser Back/Forward and the home link navigate between screens. Reports clearly label demonstration flight totals and use a dedicated print layout.

## Supported uploads

| Format | Limits | Analysis |
| --- | --- | --- |
| PNG, JPG, JPEG | 25 MB; 40 megapixels | One image, with phone orientation corrected and transparent PNGs composited on white |
| PDF | 50 MB; 1–50 pages; unencrypted | Each page rendered locally, up to 2000 pixels on its longest edge; candidates retain the page number |
| MP4, MOV | 250 MB | Frames sampled once per second by default; H.264 MP4 recommended |

Select **Upload inspection → Choose file → Upload & analyze**. Results appear under **Hazard review**, labeled with the filename and image/page/timestamp. A file with no detections still completes successfully. Invalid or password-protected files show an error rather than generating mock detections. PDF documents should contain visible inspection imagery; this is visual analysis, not text extraction or OCR. Large reports with tiny photos may need individual images uploaded instead.

Images and PDF pages use a 1280-pixel model input for better visibility of small defects; video keeps its original 640-pixel model input. This can help with aerial imagery but cannot recover detail absent from a low-resolution source, and it does not guarantee detection. `FIXMYBLOCK_IMAGE_SIZE` can override still-image/PDF processing size (256–2048, in multiples of 32). Analysis results record the input size and confidence threshold for troubleshooting.

**Format support does not add model classes.** The included model detects potholes only, not cracks in sidewalks or roads. A crack image/PDF can be uploaded, but crack detection requires compatible, trained crack-model weights. All candidates require human review; confidence is not a calibrated measure of damage severity. Up to 100 candidates per file are added to the queue (truncation is reported).

Files stay in `uploads/`, raw analysis results in `jobs/`. Job polling is session-only, so avoid restarting the server during analysis. Your missions and completed review decisions survive restarts. Do not delete these folders if you want to retain your data. `FIXMYBLOCK_DATA_DIR` optionally moves runtime data to a separate folder; `FIXMYBLOCK_PYTHON` selects a Python executable.

The mission list starts empty. Upgrades automatically remove only the three exact original starter missions and keep a recoverable copy in `jobs/removed-demo-missions.json`; your own mission plans and hazard decisions remain intact. Flight planning is still a simulation, not connected drone telemetry.

## API surface

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/summary` | Dashboard summary metrics |
| `GET` / `POST` | `/api/missions` | List or create a flight plan |
| `GET` | `/api/hazards` | List hazards for map and review queue |
| `PATCH` | `/api/hazards/:id/review` | Confirm or dismiss a hazard |
| `POST` | `/api/uploads` | Store one multipart image/PDF/video (`footage` or `file` field) and start analysis |
| `GET` | `/api/jobs/:id` | Read background analysis status and results |
| `GET` | `/api/reports/weekly` | Build weekly report data |

## Adding real integrations

The UI calls a deliberately small HTTP contract in `server.js`. Provider-specific seams are in `services/integrations.js`:

- `planFlight()` → replace with DJI, DroneDeploy, or a custom flight-planning provider.
- `analyzeUpload()` → creates the job; `services/analyze_media.py` decodes images with Pillow, renders PDF pages with PDFium, samples video with OpenCV, and calls YOLO. `analyze_video.py` remains a compatible command-line wrapper. Set `FIXMYBLOCK_MODEL` to trusted fine-tuned road-defect weights with meaningful class labels.
- `enrichHazard()` → call Gemini (or another review model) with crop/frame context and structured-output validation.

The pipeline deliberately ignores people, vehicles, bicycles, signs, and other ordinary street context; they must never become hazards merely because they are visible. The bundled model has a single `pothole` class. For additional categories such as cracks, blocked drains, fallen branches, and road debris, provide a multi-class road-defect model through `FIXMYBLOCK_MODEL`. `FIXMYBLOCK_CONFIDENCE` defaults to `0.55`; `FIXMYBLOCK_SAMPLE_SECONDS` defaults to `1` for videos. Detection boxes use decoded-image or rendered-page pixel coordinates.

For production, replace local JSON state with a database, use object storage and a bounded task queue, add authentication/authorization, sandbox document decoding, add GPS/telemetry ingestion, and validate provider callbacks. This is a trusted, local single-user prototype, not a public upload service.

## Tests

```powershell
node --test tests/upload.test.js tests/demo-missions.test.js
python -m unittest discover -s tests -p "test_*.py"
# Optional: real model + HTTP smoke test, isolated from your dashboard data
$env:FIXMYBLOCK_RUN_ANALYSIS_TESTS = "1"
node --test tests/media-api.test.js
```

The optional test generates blank PNG/JPG/JPEG, a two-page PDF, and a short MP4 in a temporary directory. To also check real positive detections, set `FIXMYBLOCK_TEST_POTHOLE_VIDEO` to a local video known to contain a pothole at frame 150; the test extracts that frame into its temporary fixtures. No footage is downloaded by tests.
