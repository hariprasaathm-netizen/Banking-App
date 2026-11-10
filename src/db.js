'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Determine environment: PostgreSQL if DATABASE_URL set, otherwise use sql.js (local)
const DATABASE_URL = process.env.DATABASE_URL;
const DB_PATH = path.join(__dirname, '..', 'portfolio.db');

let db = null;  // Will hold either sql.js Database or pg connection
let SQL = null; // sql.js module (only loaded if not using PostgreSQL)
let isPostgres = !!DATABASE_URL;
let pgClient = null; // Pool or client for PostgreSQL

// ── Helper: Generate unique ID ───────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── Schema definitions ──────────────────────────────────────
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS members (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    relation  TEXT NOT NULL,
    pan       TEXT DEFAULT '',
    phone     TEXT DEFAULT '',
    email     TEXT DEFAULT '',
    notes     TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id               TEXT PRIMARY KEY,
    member_id        TEXT NOT NULL,
    bank             TEXT NOT NULL,
    acct_number      TEXT NOT NULL,
    acct_type        TEXT NOT NULL,
    ifsc             TEXT DEFAULT '',
    branch           TEXT DEFAULT '',
    acct_holder_name TEXT DEFAULT '',
    open_date        TEXT DEFAULT '',
    is_primary       INTEGER DEFAULT 0,
    notes            TEXT DEFAULT '',
    created_at       TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS deposits (
    id                TEXT PRIMARY KEY,
    member_id         TEXT NOT NULL,
    linked_account_id TEXT DEFAULT '',
    bank              TEXT NOT NULL,
    account_no        TEXT DEFAULT '',
    principal         REAL NOT NULL,
    rate              REAL NOT NULL,
    compounding       TEXT NOT NULL DEFAULT 'quarterly',
    start_date        TEXT NOT NULL,
    tenure_years      INTEGER DEFAULT 0,
    tenure_months     INTEGER DEFAULT 0,
    tenure_days       INTEGER DEFAULT 0,
    maturity_date     TEXT NOT NULL,
    payout            TEXT DEFAULT 'cumulative',
    nominee_id        TEXT DEFAULT '',
    notes             TEXT DEFAULT '',
    created_at        TEXT DEFAULT (datetime('now'))
  );
`;

const SCHEMA2 = `
  CREATE TABLE IF NOT EXISTS pf_accounts (
    id               TEXT PRIMARY KEY,
    member_id        TEXT NOT NULL,
    uan              TEXT DEFAULT '',
    employer_name    TEXT DEFAULT '',
    emp_contribution REAL DEFAULT 0,
    er_contribution  REAL DEFAULT 0,
    current_balance  REAL DEFAULT 0,
    interest_rate    REAL DEFAULT 8.25,
    join_date        TEXT DEFAULT '',
    notes            TEXT DEFAULT '',
    created_at       TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS nps_accounts (
    id               TEXT PRIMARY KEY,
    member_id        TEXT NOT NULL,
    pran             TEXT DEFAULT '',
    tier             TEXT DEFAULT 'Tier I',
    fund_manager     TEXT DEFAULT '',
    sub_category     TEXT DEFAULT '',
    total_invested   REAL DEFAULT 0,
    current_value    REAL DEFAULT 0,
    units_held       REAL DEFAULT 0,
    nav              REAL DEFAULT 0,
    start_date       TEXT DEFAULT '',
    notes            TEXT DEFAULT '',
    created_at       TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sip_investments (
    id               TEXT PRIMARY KEY,
    member_id        TEXT NOT NULL,
    fund_name        TEXT NOT NULL,
    folio_number     TEXT DEFAULT '',
    fund_type        TEXT DEFAULT 'Equity',
    amc_name         TEXT DEFAULT '',
    monthly_amount   REAL DEFAULT 0,
    start_date       TEXT NOT NULL,
    total_invested   REAL DEFAULT 0,
    current_value    REAL DEFAULT 0,
    units_held       REAL DEFAULT 0,
    nav              REAL DEFAULT 0,
    is_active        INTEGER DEFAULT 1,
    notes            TEXT DEFAULT '',
    created_at       TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS other_records (
    id               TEXT PRIMARY KEY,
    member_id        TEXT NOT NULL,
    category         TEXT NOT NULL DEFAULT 'Other Income',
    title            TEXT NOT NULL DEFAULT '',
    amount           REAL NOT NULL DEFAULT 0,
    received_date    TEXT NOT NULL,
    notes            TEXT DEFAULT '',
    created_at       TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS goals (
    id               TEXT PRIMARY KEY,
    title            TEXT NOT NULL,
    category         TEXT NOT NULL DEFAULT 'General',
    target_amount    REAL NOT NULL DEFAULT 0,
    current_amount   REAL NOT NULL DEFAULT 0,
    target_date      TEXT NOT NULL,
    notes            TEXT DEFAULT '',
    created_at       TEXT DEFAULT (datetime('now'))
  );
`;

const SCHEMA3 = `
  CREATE TABLE IF NOT EXISTS audit_log (
    id         TEXT PRIMARY KEY,
    action     TEXT NOT NULL,
    entity     TEXT NOT NULL,
    entity_id  TEXT NOT NULL,
    label      TEXT NOT NULL DEFAULT '',
    detail     TEXT NOT NULL DEFAULT '',
    changed_by TEXT NOT NULL DEFAULT 'You',
    created_at TEXT DEFAULT (datetime('now'))
  );
`;

// ── SQL.js implementation ───────────────────────────────────
async function initSqlJs() {
  const initSqlJs = require('sql.js');
  SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    const backupPath = DB_PATH.replace('.db', '_backup_' + Date.now() + '.db');
    fs.writeFileSync(backupPath, fileBuffer);
    console.log(`📂 Loaded existing database. Backup saved to ${path.basename(backupPath)}`);
  } else {
    db = new SQL.Database();
    console.log('🆕 Created new database.');
  }

  runSqlJs(SCHEMA);
  runSqlJs(SCHEMA2);
  runSqlJs(SCHEMA3);
  saveSqlJs();
}

function saveSqlJs() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function querySqlJs(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryOneSqlJs(sql, params = []) {
  return querySqlJs(sql, params)[0] || null;
}

function runSqlJs(sql, params = []) {
  db.run(sql, params);
  saveSqlJs();
}

// ── PostgreSQL implementation ───────────────────────────────
async function initPostgres() {
  const { Pool } = require('pg');
  pgClient = new Pool({ connectionString: DATABASE_URL });

  // Test connection
  const testClient = await pgClient.connect();
  await testClient.query('SELECT 1');
  testClient.release();
  console.log('✅ Connected to PostgreSQL');

  // Create tables
  await pgClient.query(SCHEMA);
  await pgClient.query(SCHEMA2);
  await pgClient.query(SCHEMA3);
}

async function queryPostgres(sql, params = []) {
  const result = await pgClient.query(sql, params);
  return result.rows;
}

async function queryOnePostgres(sql, params = []) {
  const rows = await queryPostgres(sql, params);
  return rows[0] || null;
}

async function runPostgres(sql, params = []) {
  await pgClient.query(sql, params);
}

// ── Unified public API ──────────────────────────────────────
async function initDb() {
  if (isPostgres) {
    await initPostgres();
  } else {
    await initSqlJs();
  }
}

function getDb() {
  return isPostgres ? pgClient : db;
}

// query(): returns array of rows
async function query(sql, params = []) {
  if (isPostgres) {
    return await queryPostgres(sql, params);
  } else {
    return querySqlJs(sql, params);
  }
}

// queryOne(): returns single row or null
async function queryOne(sql, params = []) {
  if (isPostgres) {
    return await queryOnePostgres(sql, params);
  } else {
    return queryOneSqlJs(sql, params);
  }
}

// run(): execute INSERT/UPDATE/DELETE
async function run(sql, params = []) {
  if (isPostgres) {
    await runPostgres(sql, params);
  } else {
    runSqlJs(sql, params);
  }
}

// ── Exports ─────────────────────────────────────────────────
module.exports = {
  uid,
  SCHEMA,
  SCHEMA2,
  SCHEMA3,
  initDb,
  getDb,
  query,
  queryOne,
  run,
};
