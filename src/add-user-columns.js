#!/usr/bin/env node
'use strict';

const { Pool } = require('pg');

async function addColumns() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  
  try {
    console.log('Adding user_id columns to PostgreSQL...');
    
    await client.query('ALTER TABLE IF EXISTS members ADD COLUMN IF NOT EXISTS user_id TEXT DEFAULT \'\'');
    console.log('✅ Added user_id to members table');
    
    await client.query('ALTER TABLE IF EXISTS goals ADD COLUMN IF NOT EXISTS user_id TEXT DEFAULT \'\'');
    console.log('✅ Added user_id to goals table');
    
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

addColumns();
