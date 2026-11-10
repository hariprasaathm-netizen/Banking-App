#!/usr/bin/env node
'use strict';

const { Pool } = require('pg');

async function setupMFA() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  
  try {
    console.log('Setting up MFA/2FA tables...');
    
    // Add 2FA columns to users table
    await client.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS mfa_secret TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS mfa_backup_codes TEXT DEFAULT '';
    `);
    console.log('✅ Added MFA columns to users table');
    
    // Create 2FA tokens table for session management
    await client.query(`
      CREATE TABLE IF NOT EXISTS mfa_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        verified BOOLEAN DEFAULT FALSE,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT NOT NULL
      );
    `);
    console.log('✅ Created MFA sessions table');
    
    // Create index for faster lookups
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_mfa_sessions_token ON mfa_sessions(token);
      CREATE INDEX IF NOT EXISTS idx_mfa_sessions_user ON mfa_sessions(user_id);
    `);
    console.log('✅ Created MFA session indexes');
    
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

setupMFA();
