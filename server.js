import http from "node:http";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { analyzeUpload, enrichHazard, planFlight } from "./services/integrations.js";
import { receiveUpload } from "./services/uploads.js";
import { isDemoMission } from "./services/demo-missions.js";

const PORT = Number(process.env.PORT || 3000);
const publicDir = join(process.cwd(), "public");
const dataDir = process.env.FIXMYBLOCK_DATA_DIR || process.cwd();
const uploadDir = join(dataDir, "uploads");
const jobDir = join(dataDir, "jobs");
await Promise.all([mkdir(uploadDir, { recursive: true }), mkdir(jobDir, { recursive: true })]);

let missions = [];

let hazards = [];
const jobs = new Map();
const statePath = join(jobDir, "dashboard-state.json");
try {
  const saved = JSON.parse(await readFile(statePath, "utf8"));
  if (!Array.isArray(saved.missions) || !Array.isArray(saved.hazards)) throw new Error("Invalid saved dashboard state");
  missions = saved.missions;
  hazards = saved.hazards;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
let stateWrite = Promise.resolve();
function persistDashboard() {
  const snapshot = JSON.stringify({ missions, hazards });
  stateWrite = stateWrite.catch(() => {}).then(async () => {
    await writeFile(statePath + ".tmp", snapshot);
    await rename(statePath + ".tmp", statePath);
  });
  return stateWrite;
}

const demoMissions = missions.filter(isDemoMission);
if (demoMissions.length) {
  // Keep the removed starter records recoverable, without copying private hazards.
  try {
    await writeFile(join(jobDir, "removed-demo-missions.json"), JSON.stringify({ removedAt: new Date().toISOString(), missions: demoMissions }), { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  missions = missions.filter((mission) => !isDemoMission(mission));
  await persistDashboard();
}

function json(res, statusCode, value) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString();
  return raw ? JSON.parse(raw) : {};
}

function hazardFromCandidate(candidate, job) {
  const confidence = Math.round(candidate.confidence * 100);
  const highRisk = confidence >= 85 && /obstruction|vehicle|debris/i.test(candidate.type);
  return {
    id: `HZ-${randomUUID().slice(0, 8)}`,
    type: candidate.type,
    severity: highRisk ? "High" : confidence >= 70 ? "Medium" : "Low",
    confidence,
    location: `${job.filename} · ${candidate.sourceUnit || candidate.timestamp || "Image"}`,
    lat: null,
    lng: null,
    locationVerified: false,
    status: "Needs review",
    detected: "Just now",
    description: `${candidate.label} detected in ${candidate.sourceUnit || "the uploaded file"}. Location requires GPS telemetry or operator confirmation.`,
    pageNumber: candidate.pageNumber,
    sourceUnit: candidate.sourceUnit,
    timestamp: candidate.timestamp,
    frame: candidate.frame,
    bbox: candidate.bbox,
    mediaType: job.mediaType,
    jobId: job.id,
    source: `YOLO ${job.mediaType === "pdf" ? "PDF" : job.mediaType} analysis`
  };
}

function runAnalysis(job) {
  job.status = "processing";
  job.progress = "Loading the detection model…";
  job.startedAt = new Date().toISOString();
  const child = spawn(process.env.FIXMYBLOCK_PYTHON || "python", ["services/analyze_media.py", job.filePath, job.resultPath], { cwd: process.cwd(), windowsHide: true });
  let stderr = "";
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("FIXMYBLOCK_PROGRESS ")) continue;
      try { job.progress = JSON.parse(line.slice("FIXMYBLOCK_PROGRESS ".length)).message; } catch { /* Ignore unrelated worker logging. */ }
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.on("error", (error) => { job.status = "failed"; job.error = `Could not start the analysis worker: ${error.message}`; job.finishedAt = new Date().toISOString(); });
  child.on("close", async (code) => {
    if (job.status === "failed") return;
    try {
      const result = JSON.parse(await readFile(job.resultPath, "utf8"));
      if (code !== 0 || result.status !== "completed") throw new Error(result.error || stderr || `Worker exited with code ${code}`);
      const added = result.candidates.map((candidate) => hazardFromCandidate(candidate, job));
      hazards = [...added, ...hazards];
      await persistDashboard();
      job.status = "completed";
      const ignoredCount = Object.values(result.ignoredObjects || {}).reduce((total, count) => total + count, 0);
      const ignoredNote = ignoredCount ? ` ${ignoredCount} normal scene object${ignoredCount === 1 ? " was" : "s were"} ignored.` : "";
      const modelWarning = added.length === 0 && (result.roadDefectLabels || []).length === 0
        ? " The active model has no road-defect classes, so it cannot identify potholes; configure FIXMYBLOCK_MODEL with trained road-defect weights."
        : "";
      const sourceNote = result.mediaType === "pdf" ? `${result.pages} PDF page${result.pages === 1 ? "" : "s"} analyzed; ` : result.mediaType === "image" ? "image analyzed; " : `${result.sampledFrames} video frames analyzed; `;
      const truncatedNote = result.truncated ? ` Showing the first 100 of ${result.totalCandidates} candidates.` : "";
      job.progress = `Analysis complete — ${sourceNote}${added.length} review candidate${added.length === 1 ? "" : "s"} created.${ignoredNote}${modelWarning}${truncatedNote}`;
      job.result = { ...result, candidates: added };
    } catch (error) {
      job.status = "failed";
      job.error = error.message || "The file could not be analyzed.";
      job.progress = "Analysis did not finish.";
    }
    job.finishedAt = new Date().toISOString();
  });
}

function summary() {
  return {
    activeMissions: missions.filter((mission) => mission.status !== "Complete").length,
    awaitingReview: hazards.filter((hazard) => hazard.status === "Needs review").length,
    confirmedToday: hazards.filter((hazard) => hazard.status === "Confirmed").length,
    coverageKm: Number(missions.reduce((total, mission) => total + mission.coverage, 0).toFixed(1)),
    lastSynced: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  };
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/summary") return json(res, 200, summary());
  if (req.method === "GET" && url.pathname === "/api/missions") return json(res, 200, missions);
  if (req.method === "GET" && url.pathname === "/api/hazards") return json(res, 200, hazards);

  if (req.method === "POST" && url.pathname === "/api/missions") {
    const input = await body(req);
    if (!input.neighborhood || !input.altitude || !input.coverage) return json(res, 400, { error: "neighborhood, altitude, and coverage are required" });
    const planned = await planFlight(input);
    const mission = { ...planned, id: `M-${1043 + missions.length}`, eta: "Scheduled", createdAt: "Just now" };
    missions = [mission, ...missions];
    await persistDashboard();
    return json(res, 201, mission);
  }

  if (req.method === "POST" && url.pathname === "/api/uploads") {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) return json(res, 415, { error: "Upload a PNG, JPG/JPEG, PDF, MP4, or MOV file using multipart/form-data." });
    const file = await receiveUpload(req, uploadDir);
    const analysis = await analyzeUpload(file);
    const job = { ...analysis, id: analysis.jobId, mediaType: file.kind, filePath: file.path, storedName: file.storedName, resultPath: join(jobDir, `${analysis.jobId}.json`), progress: "Queued for analysis", createdAt: new Date().toISOString() };
    jobs.set(job.id, job);
    runAnalysis(job);
    return json(res, 202, { jobId: job.id, filename: job.filename, size: job.size, mediaType: job.mediaType, status: job.status, progress: job.progress });
  }

  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (req.method === "GET" && jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) return json(res, 404, { error: "Analysis job not found" });
    const { filePath, resultPath, ...publicJob } = job;
    return json(res, 200, publicJob);
  }

  const reviewMatch = url.pathname.match(/^\/api\/hazards\/([^/]+)\/review$/);
  if (req.method === "PATCH" && reviewMatch) {
    const input = await body(req);
    const index = hazards.findIndex((hazard) => hazard.id === reviewMatch[1]);
    if (index === -1) return json(res, 404, { error: "Hazard not found" });
    const nextStatus = input.decision === "confirm" ? "Confirmed" : "Dismissed";
    const enriched = input.decision === "confirm" ? await enrichHazard({ ...hazards[index], status: nextStatus }) : { ...hazards[index], status: nextStatus };
    hazards[index] = enriched;
    await persistDashboard();
    return json(res, 200, enriched);
  }

  if (req.method === "GET" && url.pathname === "/api/reports/weekly") {
    const confirmed = hazards.filter((hazard) => hazard.status === "Confirmed");
    return json(res, 200, {
      title: "Weekly neighborhood condition report",
      period: "Oct 12–18, 2026",
      totalScans: 14,
      scannedKm: 24.7,
      confirmed: confirmed.length,
      urgent: hazards.filter((hazard) => hazard.severity === "High" && hazard.status !== "Dismissed").length,
      highlights: confirmed.length ? ["Confirmed hazards are ready for maintenance routing."] : ["No confirmed hazards have been reported yet."],
      generatedAt: new Date().toISOString()
    });
  }

  return json(res, 404, { error: "API route not found" });
}

const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
async function staticFile(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = normalize(join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) return json(res, 403, { error: "Forbidden" });
  try {
    await stat(filePath);
    res.writeHead(200, { "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream" });
    res.end(await readFile(filePath));
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) await api(req, res, url);
    else await staticFile(req, res, url);
  } catch (error) {
    console.error(error);
    json(res, error.statusCode || 500, { error: error.message || "Unexpected server error" });
  }
}).listen(PORT, () => console.log(`FixMyBlock is running at http://localhost:${PORT}`));
