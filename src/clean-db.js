#!/usr/bin/env node
'use strict';

const { Pool } = require('pg');

async function cleanDb() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  
  const tables = [
    'audit_log', 'goals', 'other_records', 'sip_investments', 
    'nps_accounts', 'pf_accounts', 'deposits', 'accounts', 'members'
  ];
  
  console.log('🗑️  Clearing PostgreSQL tables...');
  for (const table of tables) {
    await client.query(`DELETE FROM ${table}`);
    console.log(`  ✓ Cleared ${table}`);
  }
  
  client.release();
  await pool.end();
  console.log('✅ Database cleaned');
}

cleanDb().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
