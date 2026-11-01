'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('production refuses to start without an admin password', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'convosurvey-auth-startup-'));
  const dataDir = path.join(tempRoot, 'data');
  try {
    const result = spawnSync(process.execPath, ['-e', "require('./server.js')"], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        ADMIN_PASSWORD: '',
        DATA_DIR: dataDir,
      },
    });

    assert.notEqual(result.status, 0, 'server should exit instead of accepting the fallback credential');
    assert.match(result.stderr, /ADMIN_PASSWORD must be set in production/);
    assert.equal(fs.existsSync(dataDir), false, 'startup should fail before creating persistent app data');

    const configuredDataDir = path.join(tempRoot, 'configured-data');
    const configured = spawnSync(process.execPath, ['-e', "require('./server.js')"], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        ADMIN_PASSWORD: 'test-only-password',
        DATA_DIR: configuredDataDir,
      },
    });
    assert.equal(configured.status, 0, configured.stderr);
    assert.equal(fs.existsSync(configuredDataDir), true, 'configured production startup should continue');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
