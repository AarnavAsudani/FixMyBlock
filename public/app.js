import { uploadError } from "/upload-formats.js";

const state = { hazards: [], missions: [], summary: {}, activeFilter: "Needs review", report: null };
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
const titles = { dashboard: "Good Evening, Aarnav", missions: "Mission control.", reviews: "Review with confidence.", reports: "Neighborhood intelligence." };
const upload = { busy: false, jobId: null, phase: "idle" };

async function api(path, options) {
  const response = await fetch(path, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}
function severityDot(severity) { return '<span class="severity ' + esc(severity) + '" title="' + esc(severity) + ' severity" aria-label="' + esc(severity) + ' severity"></span>'; }
function statusClass(status) { const word = status.split(" ")[0]; return word[0].toUpperCase() + word.slice(1).toLowerCase(); }
function statusBadge(status) { return '<span class="status ' + statusClass(status) + '">' + esc(status) + '</span>'; }
function toast(text) {
  $("#toast").textContent = text;
  $("#toast").classList.add("show");
  clearTimeout(toast.timeout);
  toast.timeout = setTimeout(() => $("#toast").classList.remove("show"), 5000);
}
function message(selector, text, isError = false) {
  $(selector).textContent = text;
  $(selector).classList.toggle("is-error", isError);
}
function renderStats() {
  const count = new Set(state.missions.map((mission) => mission.neighborhood)).size;
  const cards = [
    [state.summary.activeMissions, "Active missions", "Simulated flight plans"],
    [state.summary.awaitingReview, "Awaiting review", "Candidates need a decision"],
    [state.summary.confirmedToday, "Confirmed items", "Ready for maintenance planning"],
    [state.summary.coverageKm + " km²", "Planned coverage", "Across " + count + " neighborhoods"]
  ];
  $("#stats").innerHTML = cards.map(([value, label, note]) => '<article class="stat"><p class="stat-label">' + label + '</p><p class="stat-value">' + value + '</p><p class="stat-note">' + note + '</p></article>').join("");
  $("#syncTime").textContent = "Updated " + state.summary.lastSynced;
  const pending = state.hazards.filter((hazard) => hazard.status === "Needs review").length;
  $("#reviewBadge").textContent = pending;
  $("#reviewBadge").hidden = pending === 0;
  $("#queueCount").textContent = pending + (pending === 1 ? " item" : " items");
}
function renderMap() {
  const map = $("#map");
  map.querySelectorAll(".pin,.map-tooltip,.map-empty").forEach((element) => element.remove());
  const visible = state.hazards.filter((hazard) => hazard.status !== "Dismissed");
  // File uploads have no reliable GPS location without telemetry or confirmation.
  const mapped = visible.filter((hazard) => hazard.locationVerified === true && Number.isFinite(hazard.lat) && Number.isFinite(hazard.lng));
  mapped.forEach((hazard, index) => {
    const pin = document.createElement("button");
    pin.className = "pin " + hazard.severity.toLowerCase();
    pin.style.left = (20 + (index % 4) * 18) + "%";
    pin.style.top = (30 + Math.floor(index / 4) * 15) + "%";
    pin.setAttribute("aria-label", hazard.type + " at " + hazard.location);
    pin.addEventListener("click", () => showMapHazard(hazard));
    map.append(pin);
  });
  if (mapped.length) showMapHazard(mapped[0]);
  else {
    const empty = document.createElement("div");
    empty.className = "map-empty";
    empty.textContent = visible.length ? visible.length + (visible.length === 1 ? " candidate needs" : " candidates need") + " a verified location. View the review queue for details." : "No mapped hazards yet. Upload an inspection file to begin a review.";
    map.append(empty);
  }
}
function showMapHazard(hazard) {
  $("#map").querySelector(".map-tooltip")?.remove();
  const tip = document.createElement("div");
  tip.className = "map-tooltip";
  tip.innerHTML = "<strong>" + esc(hazard.type) + "</strong>" + statusBadge(hazard.severity) + "<span>" + esc(hazard.location) + " · " + hazard.confidence + "% detection confidence</span>";
  $("#map").append(tip);
}
function renderQueue() {
  const pending = state.hazards.filter((hazard) => hazard.status === "Needs review");
  $("#queuePreview").innerHTML = pending.length ? pending.slice(0, 3).map((h) => '<div class="queue-item">' + severityDot(h.severity) + "<div><strong>" + esc(h.type) + "</strong><small>" + esc(h.location) + " · " + esc(h.detected) + '</small></div><span class="confidence">' + h.confidence + "%</span></div>").join("") : '<p class="empty">No candidates waiting for review. Upload an image, PDF, or video to analyze it for potholes.</p>';
}
function renderMissions() {
  const active = state.missions.filter((mission) => mission.status.toLowerCase() !== "complete");
  $("#missionPreview").innerHTML = active.length ? active.slice(0, 3).map((m) => '<article class="mission-card"><strong>' + esc(m.id) + " · " + esc(m.neighborhood) + "</strong><p>" + m.coverage + " km² · " + m.altitude + "m · " + m.waypoints + " waypoints</p>" + statusBadge(m.status) + (m.status === "In flight" ? '<small class="mission-eta">' + esc(m.eta) + "</small>" : "") + "</article>").join("") : '<p class="empty">No active mission plans. Create one when you are ready.</p>';
  $("#missionsTablePanel").hidden = state.missions.length === 0;
  $("#missionsEmptyPanel").hidden = state.missions.length !== 0;
  $("#missionsTable").innerHTML = state.missions.map((m) => "<tr><td>" + esc(m.id) + "</td><td>" + esc(m.neighborhood) + "</td><td>" + m.coverage + " km²</td><td>" + m.altitude + " m</td><td>" + m.waypoints + "</td><td>" + statusBadge(m.status) + "</td></tr>").join("");
}
function renderReviews() {
  const filtered = state.activeFilter === "all" ? state.hazards : state.hazards.filter((h) => h.status === "Needs review");
  const emptyTitle = state.hazards.length ? "No candidates waiting for review." : "No review candidates yet.";
  const emptyCopy = state.hazards.length ? "Switch to All hazards to see completed decisions." : "Upload an image, PDF, or video to analyze it for potholes. New candidates will appear here for your review.";
  $("#reviewList").innerHTML = filtered.length ? filtered.map((h) => '<article class="review-card"><div class="review-icon" aria-hidden="true">' + (h.severity === "High" ? "!" : "◇") + "</div><div><h3>" + esc(h.type) + " " + severityDot(h.severity) + '</h3><p class="review-meta">' + esc(h.id) + " · " + esc(h.location) + " · " + h.confidence + "% detection confidence · " + esc(h.detected) + '</p><p class="review-description">' + esc(h.description) + '</p></div><div class="review-actions">' + (h.status === "Needs review" ? '<button class="small-button confirm" data-review="confirm" data-id="' + esc(h.id) + '">Confirm</button><button class="small-button" data-review="dismiss" data-id="' + esc(h.id) + '">Dismiss</button>' : statusBadge(h.status)) + "</div></article>").join("") : '<div class="panel empty-panel"><strong>' + emptyTitle + "</strong><p>" + emptyCopy + "</p></div>";
}
function renderReport() {
  if (!state.report) return;
  const r = state.report;
  $("#reportContent").innerHTML = '<article class="report-card"><h3>DEMO SURVEY COVERAGE</h3><strong>' + r.scannedKm + ' km²</strong></article><article class="report-card"><h3>DEMO FLIGHT PASSES</h3><strong>' + r.totalScans + '</strong></article><article class="report-card"><h3>CONFIRMED ITEMS</h3><strong>' + r.confirmed + '</strong></article><article class="report-card"><h3>URGENT ITEMS</h3><strong>' + r.urgent + '</strong></article><article class="report-card wide"><h3>OPERATIONAL HIGHLIGHTS</h3><ul>' + r.highlights.map((item) => "<li>" + esc(item) + "</li>").join("") + '</ul></article><article class="report-card wide"><h3>DEMO SURVEY PERIOD</h3><strong class="report-period">' + esc(r.period) + '</strong><p class="report-caption">Flight totals are demonstration data. Hazard counts reflect your current review session.</p></article>';
  $("#generateReport").disabled = false;
  $("#generateReport").textContent = "↗ Generate report";
}
async function refresh() {
  try {
    const [summary, missions, hazards, report] = await Promise.all([api("/api/summary"), api("/api/missions"), api("/api/hazards"), api("/api/reports/weekly")]);
    Object.assign(state, { summary, missions, hazards, report });
    $(".sync-dot").classList.remove("is-error");
    renderStats(); renderMap(); renderQueue(); renderMissions(); renderReviews(); renderReport();
    return true;
  } catch (error) {
    $("#syncTime").textContent = "Connection unavailable";
    $(".sync-dot").classList.add("is-error");
    if (!state.report) {
      $("#stats").innerHTML = '<div class="panel empty-panel"><strong>Could not load dashboard data.</strong><p>Check that the local server is running.</p><button class="small-button" data-refresh>Retry</button></div>';
      $("#generateReport").textContent = "Report unavailable";
    }
    toast("Could not refresh dashboard: " + error.message);
    return false;
  }
}
function renderRoute() {
  const requested = location.hash.slice(1) || "dashboard";
  const view = Object.hasOwn(titles, requested) ? requested : "dashboard";
  if (requested !== view || !location.hash) history.replaceState(null, "", "#" + view);
  document.querySelectorAll(".view").forEach((element) => element.classList.toggle("active", element.id === view));
  document.querySelectorAll(".nav-link").forEach((element) => {
    const current = element.dataset.view === view;
    element.classList.toggle("active", current);
    if (current) element.setAttribute("aria-current", "page"); else element.removeAttribute("aria-current");
  });
  $("#pageTitle").textContent = titles[view];
  document.title = "FixMyBlock | " + (view === "dashboard" ? "Overview" : view[0].toUpperCase() + view.slice(1));
  // Native fragment scrolling otherwise hides the header above the section.
  requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
}
document.querySelectorAll("[data-view]").forEach((element) => element.addEventListener("click", (event) => {
  event.preventDefault();
  const view = element.dataset.view;
  if (location.hash === "#" + view) renderRoute(); else location.hash = view;
}));
window.addEventListener("hashchange", renderRoute);
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => $("#" + button.dataset.close).close()));
document.addEventListener("click", (event) => { if (event.target.closest("[data-refresh]")) refresh(); });
function openMission() { message("#missionMessage", ""); $("#missionDialog").showModal(); }
$("#openPlan").onclick = openMission;
$("#openPlanSecondary").onclick = openMission;
$("#missionForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("[type=submit]");
  if (button.disabled) return;
  const data = Object.fromEntries(new FormData(form));
  if (!data.neighborhood.trim()) { message("#missionMessage", "Enter a neighborhood name.", true); return; }
  button.disabled = true;
  button.textContent = "Creating plan…";
  try {
    const mission = await api("/api/missions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...data, neighborhood: data.neighborhood.trim(), altitude: Number(data.altitude), coverage: Number(data.coverage) }) });
    form.reset();
    $("#missionDialog").close();
    toast(mission.id + " planned: " + mission.waypoints + " waypoints, about " + mission.estimatedMinutes + " minutes.");
    await refresh();
  } catch (error) { message("#missionMessage", error.message, true); }
  finally { button.disabled = false; button.textContent = "Create mission plan"; }
});
const fileSize = (bytes) => bytes < 1024 * 1024 ? Math.ceil(bytes / 1024) + " KB" : (bytes / (1024 * 1024)).toFixed(1) + " MB";
function uploadPhase(phase, stage) {
  upload.phase = phase;
  $("#uploadProgress").dataset.phase = phase;
  $("#uploadStage").textContent = stage;
  const label = { processing: "Analyzing…", completed: "Complete", failed: "Failed", interrupted: "Check status" }[phase];
  if (label) $("#uploadPercent").textContent = label;
}
function uploadProgress(percent, stage, filename) {
  $("#uploadProgress").hidden = false;
  $("#uploadFileName").textContent = filename;
  $("#uploadFileName").title = filename;
  $("#uploadPercent").textContent = percent + "%";
  $("#uploadProgressBar").style.width = percent + "%";
  $(".progress-track").setAttribute("aria-valuenow", percent);
  $("#uploadStage").textContent = stage;
}
function setUploadBusy(busy) {
  upload.busy = busy;
  $("#uploadForm").setAttribute("aria-busy", busy);
  $("#footage").disabled = busy || Boolean(upload.jobId);
  $("#uploadForm [type=submit]").disabled = busy;
  $("#uploadForm [type=submit]").textContent = busy ? (upload.jobId ? "Analyzing…" : "Uploading…") : upload.jobId ? "Check analysis status" : "Upload & analyze";
  $("#openUpload").textContent = busy || upload.jobId ? "◌ View analysis" : "↑ Upload inspection";
}
$("#openUpload").onclick = () => $("#uploadDialog").showModal();
$("#footage").addEventListener("change", () => {
  if (upload.busy || upload.jobId) return;
  const file = $("#footage").files[0];
  $("#selectedFile").textContent = file ? file.name + " · " + fileSize(file.size) : "No file selected.";
  $("#uploadProgress").hidden = true;
  const error = file ? uploadError(file) : "";
  $("#footage").setCustomValidity(error);
  message("#uploadMessage", error, Boolean(error));
});
function sendFile(data, file) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/uploads");
    request.timeout = 10 * 60 * 1000;
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) uploadProgress(Math.round(event.loaded / event.total * 100), "Uploading " + fileSize(event.loaded) + " of " + fileSize(event.total), file.name);
    });
    request.upload.addEventListener("load", () => uploadProgress(100, "Transfer sent — waiting for the server to accept it…", file.name));
    request.addEventListener("load", () => {
      try {
        const payload = JSON.parse(request.responseText);
        if (request.status < 200 || request.status >= 300) throw new Error(payload.error || "Upload failed");
        uploadProgress(100, "File uploaded. Starting analysis…", file.name);
        resolve(payload);
      } catch (error) { reject(error); }
    });
    request.addEventListener("error", () => reject(new Error("Could not reach the local server. Check the connection and try again.")));
    request.addEventListener("timeout", () => reject(new Error("The upload timed out. Try a smaller file.")));
    request.addEventListener("abort", () => reject(new Error("Upload was interrupted. Try again.")));
    request.send(data);
  });
}
async function monitorAnalysis() {
  while (upload.jobId) {
    const current = await api("/api/jobs/" + upload.jobId);
    if (current.status === "failed") {
      upload.jobId = null;
      uploadPhase("failed", "File uploaded, but analysis failed.");
      message("#uploadMessage", current.error || "Analysis failed. Try uploading again.", true);
      return;
    }
    if (current.status === "completed") {
      upload.jobId = null;
      uploadPhase("completed", current.progress || "Analysis complete.");
      message("#uploadMessage", "Open Hazard review to inspect the results. You can upload another file below.");
      toast(current.progress || "Analysis complete.");
      await refresh();
      return;
    }
    uploadPhase("processing", current.progress || "Analyzing file…");
    await new Promise((resolve) => setTimeout(resolve, 1800));
  }
}
$("#uploadForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (upload.busy) return;
  const file = $("#footage").files[0];
  if (!upload.jobId) {
    const error = uploadError(file);
    if (error) { message("#uploadMessage", error, true); return; }
  }
  // Disabled form fields are omitted, so capture the file before disabling it.
  const data = new FormData(event.currentTarget);
  message("#uploadMessage", "");
  setUploadBusy(true);
  try {
    if (!upload.jobId) {
      uploadProgress(0, "Preparing " + fileSize(file.size) + " for upload", file.name);
      uploadPhase("uploading", "Uploading file…");
      const job = await sendFile(data, file);
      upload.jobId = job.jobId;
      setUploadBusy(true);
    }
    uploadPhase("processing", "File uploaded. Starting analysis…");
    await monitorAnalysis();
  } catch (error) {
    uploadPhase(upload.jobId ? "interrupted" : "failed", upload.jobId ? "File uploaded. The analysis status is temporarily unavailable." : "Upload failed. Try again.");
    message("#uploadMessage", upload.jobId ? error.message + " Use Check analysis status to reconnect without uploading again." : error.message, true);
  } finally { setUploadBusy(false); }
});
$("#reviewList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-review]");
  if (!button) return;
  const actions = button.closest(".review-actions");
  if (actions.dataset.busy) return;
  actions.dataset.busy = "true";
  actions.querySelectorAll("button").forEach((action) => action.disabled = true);
  try {
    const hazard = await api("/api/hazards/" + button.dataset.id + "/review", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: button.dataset.review }) });
    state.hazards = state.hazards.map((item) => item.id === hazard.id ? hazard : item);
    renderReviews(); renderQueue(); renderMap();
    toast(hazard.type + " marked " + hazard.status.toLowerCase());
    await refresh();
  } catch (error) { toast(error.message); }
  finally { delete actions.dataset.busy; actions.querySelectorAll("button").forEach((action) => action.disabled = false); }
});
document.querySelectorAll(".chip").forEach((chip) => chip.addEventListener("click", () => {
  state.activeFilter = chip.dataset.filter;
  document.querySelectorAll(".chip").forEach((element) => { element.classList.toggle("active", element === chip); element.setAttribute("aria-pressed", element === chip); });
  renderReviews();
}));
$("#generateReport").onclick = async () => {
  const button = $("#generateReport");
  button.disabled = true;
  button.textContent = "Generating…";
  try {
    const report = await api("/api/reports/weekly");
    state.report = report;
    renderReport();
    $("#reportTitle").textContent = report.title;
    $("#reportModalBody").innerHTML = '<p class="dialog-copy">Demo survey period: ' + esc(report.period) + "<br>Generated " + esc(new Date(report.generatedAt).toLocaleString()) + '</p><div class="report-summary"><div><strong>' + report.scannedKm + '</strong><span>demo km² surveyed</span></div><div><strong>' + report.confirmed + '</strong><span>confirmed items</span></div><div><strong>' + report.urgent + '</strong><span>urgent items</span></div></div><ul>' + report.highlights.map((item) => "<li>" + esc(item) + "</li>").join("") + '</ul><p class="report-caption">Flight totals are demonstration data. Hazard counts reflect your saved review decisions.</p>';
    $("#reportDialog").showModal();
  } catch (error) { toast("Could not generate report: " + error.message); }
  finally { button.disabled = !state.report; button.textContent = "↗ Generate report"; }
};
window.addEventListener("beforeprint", () => document.body.classList.toggle("print-report", $("#reportDialog").open));
window.addEventListener("afterprint", () => document.body.classList.remove("print-report"));
$("#printReport").onclick = () => window.print();
renderRoute();
refresh();
