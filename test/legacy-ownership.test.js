'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test('public signup cannot claim surveys created before accounts', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'convosurvey-legacy-owner-'));
  const port = await unusedPort();
  const db = new DatabaseSync(path.join(dataDir, 'convosurvey.db'));
  db.exec(`
    CREATE TABLE surveys (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      config TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO surveys (id, slug, title, config, status, created_at, updated_at)
    VALUES ('legacy-survey', 'legacy', 'Legacy survey', '{"questions":[{"id":"q1","text":"Question"}]}', 'draft', 1, 1);
  `);
  db.close();

  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      ADMIN_EMAIL: 'founder@example.com',
      SESSION_SECRET: 'test-secret-for-isolated-regression',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  t.after(() => {
    if (child.exitCode === null) {
      child.kill();
      return once(child, 'exit').then(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, `server should start for the ownership regression test:\n${output}`);

  const signup = await fetch(`${base}/api/admin/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'attacker@example.com', password: 'correct horse battery' }),
  });
  assert.equal(signup.status, 201);
  const cookie = signup.headers.get('set-cookie').split(';')[0];

  const surveys = await fetch(`${base}/api/admin/surveys`, { headers: { cookie } });
  assert.equal(surveys.status, 200);
  assert.deepEqual(await surveys.json(), []);

  const survey = await fetch(`${base}/api/admin/surveys/legacy-survey`, { headers: { cookie } });
  assert.equal(survey.status, 404);
});
