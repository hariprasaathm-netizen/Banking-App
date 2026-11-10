'use strict';

const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

// ── Environment detection ──────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL;
const isPostgreSQL = !!(DATABASE_URL && DATABASE_URL.includes('postgresql'));

let db;           // sql.js Database instance
let pgPool;       // PostgreSQL connection pool
let SQL;          // sql.js library instance

// ── Schemas ────────────────────────────────────────────────────
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

// ── Unique ID generator ────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── DB file persistence (sql.js only) ──────────────────────────
const DB_PATH = path.join(__dirname, '..', 'portfolio.db');

function saveDb() {
  if (!isPostgreSQL && db) {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }
  // PostgreSQL: no-op (auto-commits via connection pool)
}

// ── Initialize database ────────────────────────────────────────
async function initDb() {
  try {
    if (isPostgreSQL) {
      // Initialize PostgreSQL schema
      const { Pool } = require('pg');
      pgPool = new Pool({ connectionString: DATABASE_URL });

      // Create all tables using IF NOT EXISTS
      await pgPool.query(SCHEMA);
      await pgPool.query(SCHEMA2);
      await pgPool.query(SCHEMA3);

      console.log('✅ PostgreSQL database initialized.');
    } else {
      // Initialize sql.js
      if (!SQL) {
        SQL = await initSqlJs();
      }

      const dbPath = DB_PATH;
      if (fs.existsSync(dbPath)) {
        const fileBuffer = fs.readFileSync(dbPath);
        db = new SQL.Database(fileBuffer);
        const backupPath = dbPath.replace('.db', '_backup_' + Date.now() + '.db');
        fs.writeFileSync(backupPath, fileBuffer);
        console.log(`📂 Loaded existing database. Backup saved to ${path.basename(backupPath)}`);
      } else {
        db = new SQL.Database();
        console.log('🆕 Created new database.');
      }

      // Run schema initialization
      db.run(SCHEMA);
      db.run(SCHEMA2);
      db.run(SCHEMA3);
      saveDb();

      console.log('✅ sql.js database initialized.');
    }
  } catch (err) {
    console.error('❌ Database initialization failed:', err.message);
    process.exit(1);
  }
}

// ── Get current database instance ──────────────────────────────
function getDb() {
  if (isPostgreSQL) {
    return pgPool;
  }
  return db;
}

// ── Query interface (both drivers) ─────────────────────────────

/**
 * Execute SELECT and return all rows as objects
 * @param {string} sql - SQL query
 * @param {array} params - Query parameters
 * @returns {Promise<array>} Array of row objects
 */
async function query(sql, params = []) {
  if (isPostgreSQL) {
    try {
      const result = await pgPool.query(sql, params);
      return result.rows;
    } catch (err) {
      console.error('Query error:', err.message, { sql, params });
      throw err;
    }
  } else {
    // sql.js
    try {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      stmt.free();
      return rows;
    } catch (err) {
      console.error('Query error:', err.message, { sql, params });
      throw err;
    }
  }
}

/**
 * Execute SELECT and return first row or null
 * @param {string} sql - SQL query
 * @param {array} params - Query parameters
 * @returns {Promise<object|null>} First row or null
 */
async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

/**
 * Execute INSERT, UPDATE, or DELETE
 * @param {string} sql - SQL statement
 * @param {array} params - Query parameters
 */
async function run(sql, params = []) {
  if (isPostgreSQL) {
    try {
      await pgPool.query(sql, params);
    } catch (err) {
      console.error('Run error:', err.message, { sql, params });
      // Log but do not crash (matching sql.js behavior)
    }
  } else {
    // sql.js
    try {
      db.run(sql, params);
      saveDb();
    } catch (err) {
      console.error('Run error:', err.message, { sql, params });
      // Log but do not crash
    }
  }
}

// ── Exports ────────────────────────────────────────────────────
module.exports = {
  initDb,
  getDb,
  query,
  queryOne,
  run,
  uid,
  saveDb,
  SCHEMA,
  SCHEMA2,
  SCHEMA3,
  DATABASE_URL,
  isPostgreSQL,
};
