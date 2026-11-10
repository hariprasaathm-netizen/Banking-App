#!/usr/bin/env node
'use strict';

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

async function linkAccount() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  
  try {
    // Get existing members (your real family data)
    const members = await client.query('SELECT id, name, relation FROM members WHERE name IN ($1, $2, $3)', ['Prasath Murugesan', 'AbinayaPradha R', 'KeshavShree']);
    
    if (members.rows.length === 0) {
      console.log('❌ Could not find members: Prasath Murugesan, AbinayaPradha R, KeshavShree');
      client.release();
      await pool.end();
      return;
    }
    
    console.log('Found members:');
    members.rows.forEach(m => console.log(`  - ${m.name} (${m.relation})`));
    
    // Create user account
    const email = 'Hariprasaath.m@gmail.com';
    const password = process.argv[2] || 'DefaultPassword123456';
    
    // Check if user already exists
    const existingUser = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    
    let userId;
    if (existingUser.rows.length > 0) {
      userId = existingUser.rows[0].id;
      console.log(`\n✅ User already exists: ${email} (ID: ${userId})`);
    } else {
      // Create new user
      const passwordHash = await bcrypt.hash(password, 12);
      const uid = require('../src/db.js').uid();
      
      await client.query(
        'INSERT INTO users (id, email, password_hash, display_name, is_admin) VALUES ($1, $2, $3, $4, $5)',
        [uid, email, passwordHash, 'Prasath', 1]
      );
      userId = uid;
      console.log(`\n✅ Created user: ${email}`);
      console.log(`   Password: ${password}`);
    }
    
    // Link members to user
    const memberIds = members.rows.map(m => m.id);
    await client.query(
      'UPDATE members SET user_id = $1 WHERE id = ANY($2)',
      [userId, memberIds]
    );
    
    console.log(`\n✅ Linked ${memberIds.length} members to ${email}`);
    
    // Link their deposits, goals, etc.
    const deposits = await client.query(
      'SELECT DISTINCT member_id FROM deposits WHERE member_id = ANY($1)',
      [memberIds]
    );
    console.log(`✅ User has ${deposits.rows.length} deposits`);
    
    const goals = await client.query(
      'SELECT id FROM goals WHERE user_id IS NULL OR user_id = \'\''
    );
    if (goals.rows.length > 0) {
      await client.query(
        'UPDATE goals SET user_id = $1 WHERE user_id IS NULL OR user_id = \'\'',
        [userId]
      );
      console.log(`✅ Linked ${goals.rows.length} goals to user`);
    }
    
    // Show summary
    const userMembers = await client.query(
      'SELECT id, name, relation FROM members WHERE user_id = $1',
      [userId]
    );
    
    console.log(`\n📊 Account Summary:`);
    console.log(`   Email: ${email}`);
    console.log(`   Members: ${userMembers.rows.length}`);
    userMembers.rows.forEach(m => {
      console.log(`     - ${m.name} (${m.relation})`);
    });
    
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

linkAccount();
