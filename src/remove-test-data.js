#!/usr/bin/env node
'use strict';

const { Pool } = require('pg');

async function removeTestData() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  
  console.log('🧹 Removing test data from PostgreSQL...');
  
  // Remove test member
  const testMemberId = 'mwal8r9hejl3';
  
  // Delete related records first (foreign keys)
  await client.query('DELETE FROM deposits WHERE member_id = $1', [testMemberId]);
  await client.query('DELETE FROM accounts WHERE member_id = $1', [testMemberId]);
  await client.query('DELETE FROM pf_accounts WHERE member_id = $1', [testMemberId]);
  await client.query('DELETE FROM nps_accounts WHERE member_id = $1', [testMemberId]);
  await client.query('DELETE FROM sip_investments WHERE member_id = $1', [testMemberId]);
  await client.query('DELETE FROM other_records WHERE member_id = $1', [testMemberId]);
  
  // Delete the test member
  await client.query('DELETE FROM members WHERE id = $1', [testMemberId]);
  console.log(`  ✓ Removed test member: ${testMemberId}`);
  
  // Remove test user that was created during testing
  await client.query('DELETE FROM members WHERE id = $1', ['mwamalxzypa0']);
  console.log(`  ✓ Removed test user: mwamalxzypa0`);
  
  client.release();
  await pool.end();
  console.log('✅ Test data removed. Only real members remain.');
}

removeTestData().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
