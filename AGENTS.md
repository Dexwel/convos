# Repository Guide

## Product and stack

ConvoSurvey is a Node.js >=22.13 Express application with vanilla browser JavaScript, SQLite (`node:sqlite`), local audio storage, and optional Groq APIs. The current `main` branch is a single-owner pilot. It is not safe to expose as a multi-tenant SaaS until Phase A authorization and data isolation gates pass.

## Commands

- `node --test test/match.test.js` - fast deterministic matcher suite.
- `npm run test:e2e` - API end-to-end suite; requires the mock Groq service and environment described in `README.md`.
- `npm start` - local app on port 3000; requires persistent writable `DATA_DIR`.

## Required workflow

1. Write acceptance criteria and a focused test before implementation.
2. For database/auth/billing/audio changes, obtain an independent review and run tenant-isolation/security tests before calling the change complete.
3. Make additive, reversible migrations. Never alter or delete production data during local development.
4. Preserve the legacy Render service and response URLs until backup, migration, reconciliation, and rollback are verified.
5. Use staging-only credentials. Never request or print secrets in chat, commit `.env`, or add production credentials to fixtures/logs.
6. Keep `data/`, audio, database files, `node_modules/`, and local environment files ignored.
7. Do not claim a deployment/provider integration works until a staging smoke test demonstrates it. Record unavailable checks.
8. Do not use the default `changeme` password for a public deployment.

## Current boundaries

- SQLite, process-local locks/rate limits, and local audio storage assume one process and persistent disk.
- There is no user/workspace model or classic-form mode yet.
- `/admin` is the founder's current shared-password dashboard, not the future customer app or founder operations console.
- Any migration must retain the existing survey/session IDs and reconcile historical responses against their original configuration snapshots.
