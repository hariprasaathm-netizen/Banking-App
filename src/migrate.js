#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { Pool } = require('pg');

const DB_PATH = path.join(__dirname, '..', 'portfolio.db');
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const EXPORT_FILE = path.join(MIGRATIONS_DIR, `export-${Date.now()}.json`);

// Ensure migrations directory exists
if (!fs.existsSync(MIGRATIONS_DIR)) {
  fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
}

// ── Step 1: Export from SQLite to JSON ───────────────────────
async function exportSqliteToJson() {
  console.log('📤 Exporting SQLite data to JSON...');

  const SQL = await initSqlJs();
  const fileBuffer = fs.readFileSync(DB_PATH);
  const sqliteDb = new SQL.Database(fileBuffer);

  const tables = [
    'members',
    'accounts',
    'deposits',
    'pf_accounts',
    'nps_accounts',
    'sip_investments',
    'other_records',
    'goals',
    'audit_log',
  ];

  const exportData = {};

  for (const table of tables) {
    const stmt = sqliteDb.prepare(`SELECT * FROM ${table}`);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    exportData[table] = rows;
    console.log(`  ✓ ${table}: ${rows.length} rows`);
  }

  sqliteDb.close();

  fs.writeFileSync(EXPORT_FILE, JSON.stringify(exportData, null, 2));
  console.log(`✅ Exported to ${path.relative(process.cwd(), EXPORT_FILE)}`);

  return exportData;
}

// ── Step 2: Load from JSON to PostgreSQL ─────────────────────
async function loadJsonToPostgres(exportData) {
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL environment variable not set. Cannot load to PostgreSQL.');
    process.exit(1);
  }

  console.log('📥 Loading JSON data to PostgreSQL...');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const client = await pool.connect();

    // Insert data for each table
    const tables = Object.keys(exportData);

    for (const table of tables) {
      const rows = exportData[table];
      if (rows.length === 0) {
        console.log(`  ℹ️  ${table}: no rows to insert`);
        continue;
      }

      // Get columns from first row
      const columns = Object.keys(rows[0]);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(',');
      const columnList = columns.join(',');
      const insertSql = `INSERT INTO ${table} (${columnList}) VALUES (${placeholders})`;

      for (const row of rows) {
        const values = columns.map(col => row[col]);
        try {
          await client.query(insertSql, values);
        } catch (err) {
          // Skip if row already exists (e.g., primary key conflict)
          if (err.code === '23505') { // unique_violation
            console.log(`    ⚠️  ${table}/${row.id}: exists, skipped`);
          } else {
            throw err;
          }
        }
      }

      console.log(`  ✓ ${table}: ${rows.length} rows inserted`);
    }

    client.release();
    console.log('✅ Data loaded to PostgreSQL');
  } catch (err) {
    console.error('❌ Error loading data:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  try {
    // Check if SQLite database exists
    if (!fs.existsSync(DB_PATH)) {
      console.warn('⚠️  SQLite database not found at', DB_PATH);
      console.log('ℹ️  Create some data in the app first, then run migrate again.');
      process.exit(1);
    }

    // Export from SQLite
    const exportData = await exportSqliteToJson();

    // If DATABASE_URL is set, load to PostgreSQL
    if (process.env.DATABASE_URL) {
      await loadJsonToPostgres(exportData);
      console.log('🎉 Migration complete!');
    } else {
      console.log('ℹ️  DATABASE_URL not set. Data exported to JSON only.');
      console.log('   Set DATABASE_URL and run again to load to PostgreSQL.');
    }
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  }
}

main();
