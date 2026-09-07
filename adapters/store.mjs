// The recorder. Every run, every event, every goal and claim lands in one
// SQLite file, so a finished run can be replayed and measured. This is what
// eventually replaces the agent's own estimates with your real history.
//
// node:sqlite is built into Node, so this stays dependency-free.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { compareQueueOrder } from '../core/board.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  mission     TEXT,
  repo        TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id   INTEGER NOT NULL REFERENCES runs(id),
  agent_id TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  kind     TEXT NOT NULL,
  payload  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_run_agent ON events(run_id, agent_id, ts);

CREATE TABLE IF NOT EXISTS goals (
  run_id       INTEGER NOT NULL REFERENCES runs(id),
  agent_id     TEXT NOT NULL,
  objective    TEXT,
  token_budget INTEGER,
  status       TEXT,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (run_id, agent_id)
);

CREATE TABLE IF NOT EXISTS claims (
  run_id   INTEGER NOT NULL REFERENCES runs(id),
  agent_id TEXT NOT NULL,
  pattern  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  run_id      INTEGER NOT NULL REFERENCES runs(id),
  id          TEXT NOT NULL,
  payload     TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (run_id, id)
);

CREATE TABLE IF NOT EXISTS settings (
  name       TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS middleware (
  name       TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  run_id     INTEGER NOT NULL REFERENCES runs(id),
  agent_id   TEXT NOT NULL,
  session_id TEXT NOT NULL,
  engine     TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, agent_id)
);

CREATE TABLE IF NOT EXISTS engines (
  run_id   INTEGER NOT NULL REFERENCES runs(id),
  agent_id TEXT NOT NULL,
  engine   TEXT NOT NULL,
  PRIMARY KEY (run_id, agent_id)
);
`;

export function createStore({ file }) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);

  const insertRun = db.prepare('INSERT INTO runs (started_at, mission, repo) VALUES (?, ?, ?)');
  const endRun = db.prepare('UPDATE runs SET ended_at = ? WHERE id = ?');
  const setRunMission = db.prepare('UPDATE runs SET mission = ? WHERE id = ?');
  const insertEvent = db.prepare(
    'INSERT INTO events (run_id, agent_id, ts, kind, payload) VALUES (?, ?, ?, ?, ?)',
  );
  const upsertGoal = db.prepare(
    `INSERT INTO goals (run_id, agent_id, objective, token_budget, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, agent_id) DO UPDATE SET
       objective = excluded.objective,
       token_budget = excluded.token_budget,
       status = excluded.status,
       updated_at = excluded.updated_at`,
  );
  const deleteGoal = db.prepare('DELETE FROM goals WHERE run_id = ? AND agent_id = ?');
  const upsertEngine = db.prepare(
    `INSERT INTO engines (run_id, agent_id, engine) VALUES (?, ?, ?)
     ON CONFLICT(run_id, agent_id) DO UPDATE SET engine = excluded.engine`,
  );
  const upsertSession = db.prepare(
    `INSERT INTO sessions (run_id, agent_id, session_id, engine, started_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(run_id, agent_id) DO UPDATE SET
       session_id = excluded.session_id,
       engine = excluded.engine,
       started_at = excluded.started_at`,
  );
  const selectSessions = db.prepare('SELECT * FROM sessions WHERE run_id = ?');
  const selectEngines = db.prepare('SELECT agent_id, engine FROM engines WHERE run_id = ?');
  const upsertMiddleware = db.prepare(
    `INSERT INTO middleware (name, text, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
  );
  const deleteMiddleware = db.prepare('DELETE FROM middleware WHERE name = ?');
  const selectMiddleware = db.prepare('SELECT name, text FROM middleware');
  const clearClaims = db.prepare('DELETE FROM claims WHERE run_id = ? AND agent_id = ?');
  const insertClaim = db.prepare('INSERT INTO claims (run_id, agent_id, pattern) VALUES (?, ?, ?)');
  const selectEvents = db.prepare(
    'SELECT agent_id, ts, kind, payload FROM events WHERE run_id = ? AND agent_id = ? ORDER BY ts',
  );
  const selectRunEvents = db.prepare(
    'SELECT agent_id, ts, kind, payload FROM events WHERE run_id = ? ORDER BY ts',
  );
  const countEvents = db.prepare('SELECT COUNT(*) AS n FROM events WHERE run_id = ?');
  const countSessions = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE run_id = ?');
  const selectRuns = db.prepare(
    'SELECT id, started_at, ended_at, mission, repo FROM runs ORDER BY id DESC LIMIT ?',
  );
  const selectGoals = db.prepare('SELECT * FROM goals WHERE run_id = ?');
  const upsertSetting = db.prepare(
    `INSERT INTO settings (name, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const selectSetting = db.prepare('SELECT value FROM settings WHERE name = ?');
  const upsertItem = db.prepare(
    `INSERT INTO items (run_id, id, payload, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(run_id, id) DO UPDATE SET payload = excluded.payload,
       updated_at = excluded.updated_at`,
  );
  const selectItems = db.prepare('SELECT payload FROM items WHERE run_id = ? ORDER BY rowid');
  // The run this repo was last working on. A restart is not a new piece of
  // work, so the server rejoins it rather than opening an empty one beside it.
  const selectLiveRun = db.prepare(
    `SELECT id, started_at, ended_at, mission, repo FROM runs
     WHERE ended_at IS NULL AND repo = ? ORDER BY id DESC LIMIT 1`,
  );

  let runId = null;

  return {
    startRun(mission, repo) {
      const result = insertRun.run(Date.now(), mission ?? '', repo ?? '');
      runId = Number(result.lastInsertRowid);
      return runId;
    },

    // Rejoin the newest unfinished run for this repo, so a restart keeps the
    // mission, the goals and the run's identity instead of starting blind.
    adoptRun(repo) {
      const run = selectLiveRun.get(repo ?? '');
      if (!run) return null;
      runId = Number(run.id);
      return run;
    },

    finishRun() {
      if (runId === null) return;
      endRun.run(Date.now(), runId);
      runId = null;
    },

    // A run is titled by its mission. The mission is usually set after the run
    // has already started, so the title has to be able to catch up - otherwise
    // every run in the list reads "unnamed run".
    renameRun(mission) {
      if (runId !== null) setRunMission.run(mission ?? '', runId);
    },

    record(event) {
      if (runId === null) return;
      insertEvent.run(runId, event.agentId, event.ts, event.kind, JSON.stringify(event.payload));
    },

    saveGoal(agentId, goal) {
      if (runId === null) return;
      if (!goal) return void deleteGoal.run(runId, agentId);
      upsertGoal.run(
        runId,
        agentId,
        goal.objective ?? '',
        goal.tokenBudget ?? null,
        goal.status ?? 'active',
        goal.updatedAt ?? Date.now(),
      );
    },

    saveEngine(agentId, engine) {
      if (runId !== null) upsertEngine.run(runId, agentId, engine);
    },

    // A session id is what makes "continue" possible later: it is the handle
    // both engines resume a conversation by.
    saveSession(agentId, sessionId, engine) {
      if (runId !== null && sessionId) {
        upsertSession.run(runId, agentId, sessionId, engine, Date.now());
      }
    },

    // Middleware overrides outlive a run: they are how this fleet is told to
    // work, not part of any one mission.
    // How far the orchestrator is trusted with the room's decision cards.
    // A setting, not a run detail: it outlives runs and restarts.
    // Checkpoints belong to the run: reopening a run reopens its work, and a
    // restart mid-mission does not lose who owned what.
    saveItem(item) {
      if (runId === null || !item?.id) return;
      upsertItem.run(runId, item.id, JSON.stringify(item), Date.now());
    },

    itemsFor(targetRunId) {
      return selectItems.all(targetRunId ?? runId)
        .map((row) => { try { return JSON.parse(row.payload); } catch { return null; } })
        .filter(Boolean)
        .sort(compareQueueOrder);
    },

    saveMiddleware(name, text) {
      if (text === null || text === undefined) deleteMiddleware.run(name);
      else upsertMiddleware.run(name, text, Date.now());
    },

    middleware() {
      return Object.fromEntries(selectMiddleware.all().map((row) => [row.name, row.text]));
    },

    sessionsFor(targetRunId) {
      return selectSessions.all(targetRunId);
    },

    enginesFor(targetRunId) {
      return selectEngines.all(targetRunId ?? runId);
    },

    saveClaims(agentId, patterns) {
      if (runId === null) return;
      clearClaims.run(runId, agentId);
      for (const pattern of patterns) insertClaim.run(runId, agentId, pattern);
    },

    replay(targetRunId, agentId) {
      return selectEvents.all(targetRunId, agentId).map((row) => ({
        agentId: row.agent_id,
        ts: row.ts,
        kind: row.kind,
        payload: JSON.parse(row.payload),
      }));
    },

    getRun(targetRunId) {
      return selectRuns.all(1000).find((run) => run.id === targetRunId) ?? null;
    },

    listRuns(limit = 20) {
      return selectRuns.all(limit).map((run) => ({
        ...run,
        events: countEvents.get(run.id)?.n ?? 0,
        // Runs recorded before sessions existed cannot be resumed, and the UI
        // must say so rather than offering a button that always fails.
        sessions: countSessions.get(run.id)?.n ?? 0,
      }));
    },

    // A whole run, every agent, in order - what "open a previous conversation"
    // actually means here.
    replayRun(targetRunId) {
      return selectRunEvents.all(targetRunId).map((row) => ({
        agentId: row.agent_id,
        ts: row.ts,
        kind: row.kind,
        payload: JSON.parse(row.payload),
      }));
    },

    goalsFor(targetRunId) {
      return selectGoals.all(targetRunId);
    },

    get runId() {
      return runId;
    },
  };
}
