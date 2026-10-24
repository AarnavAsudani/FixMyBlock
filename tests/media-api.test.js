import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

test('real image/PDF/video uploads and review persistence', { skip: process.env.FIXMYBLOCK_RUN_ANALYSIS_TESTS !== '1', timeout: 240000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'fixmyblock-media-test-'));
  const port = process.env.FIXMYBLOCK_TEST_PORT || '3108';
  const base = `http://localhost:${port}`;
  const python = process.env.FIXMYBLOCK_PYTHON || 'python';
  let server;
  let logs = '';
  async function start() {
    server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: port, FIXMYBLOCK_DATA_DIR: root }, windowsHide: true });
    server.stdout.on('data', chunk => { logs += chunk; });
    server.stderr.on('data', chunk => { logs += chunk; });
    server.on('error', error => { logs += error.message; });
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(logs);
      if (logs.includes(`running at http://localhost:${port}`)) return;
      await delay(100);
    }
    throw new Error('Test server did not start: ' + logs);
  }
  async function stop() {
    if (!server || server.exitCode !== null) return;
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill();
    await exited;
  }
  async function request(path, options) {
    const response = await fetch(base + path, { ...options, signal: AbortSignal.timeout(10000) });
    return { status: response.status, data: await response.json() };
  }
  async function upload(name) {
    const form = new FormData();
    form.append('footage', new Blob([await readFile(join(root, name))]), name);
    const queued = await request('/api/uploads', { method: 'POST', body: form });
    assert.equal(queued.status, 202, JSON.stringify(queued.data));
    for (let i = 0; i < 120; i++) {
      const { data: job } = await request('/api/jobs/' + queued.data.jobId);
      if (['completed', 'failed'].includes(job.status)) return job;
      await delay(500);
    }
    throw new Error('Analysis did not finish for ' + name);
  }
  try {
    const fixture = spawnSync(python, ['tests/make_media_fixtures.py', root], { encoding: 'utf8', windowsHide: true });
    assert.equal(fixture.status, 0, fixture.stderr);
    await start();
    assert.equal((await request('/api/hazards')).data.length, 0);
    const rejected = await request('/api/uploads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"filename":"test.png"}' });
    assert.equal(rejected.status, 415);
    const results = [];
    for (const name of ['inspection.png', 'inspection.jpg', 'inspection.jpeg', 'inspection.pdf', 'inspection.mp4']) {
      const job = await upload(name);
      assert.equal(job.status, 'completed', `${name}: ${job.error}`);
      assert.equal(job.result.inferenceSize, name.endsWith('.mp4') ? 640 : 1280);
      assert.ok(job.result.analyzedUnits >= 1);
      assert.equal('filePath' in job, false);
      if (name.endsWith('.pdf')) {
        assert.equal(job.result.pages, 2);
        assert.equal(job.result.analyzedUnits, 2);
        assert.ok(job.result.candidates.every(candidate => candidate.pageNumber === 2));
      }
      if (process.env.FIXMYBLOCK_TEST_POTHOLE_VIDEO && !name.endsWith('.mp4')) assert.ok(job.result.candidates.length > 0, name + ': expected pothole');
      assert.ok(job.result.candidates.every(candidate => candidate.lat === null && candidate.lng === null && !candidate.locationVerified));
      results.push({ name, mediaType: job.mediaType, units: job.result.analyzedUnits, candidates: job.result.candidates.length });
    }
    const corrupt = await upload('corrupt.pdf');
    assert.equal(corrupt.status, 'failed');
    assert.match(corrupt.error, /unencrypted, valid PDF/);
    const before = (await request('/api/hazards')).data;
    if (before.length) {
      const reviewed = await request(`/api/hazards/${before[0].id}/review`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"decision":"dismiss"}' });
      assert.equal(reviewed.data.status, 'Dismissed');
    }
    await stop();
    logs = '';
    await start();
    const after = (await request('/api/hazards')).data;
    assert.equal(after.length, before.length);
    if (after.length) assert.equal(after[0].status, 'Dismissed');
    console.log(JSON.stringify(results));
  } finally {
    await stop();
    // Only the explicitly generated test directory can be removed.
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    assert.ok(root.split(sep).at(-1).startsWith('fixmyblock-media-test-'));
    await rm(root, { recursive: true, force: true });
  }
});
