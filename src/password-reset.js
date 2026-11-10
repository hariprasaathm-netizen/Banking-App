#!/usr/bin/env node
'use strict';

/**
 * Password Reset Implementation
 * 
 * This module handles password reset via email tokens
 * For beta, we'll generate reset tokens and display them in the UI
 */

const crypto = require('crypto');
const { query, queryOne, run, uid } = require('./db.js');

// Generate reset token
function generateResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Create password reset request
async function createPasswordResetToken(email) {
  try {
    // Find user by email
    const user = await queryOne('SELECT id, email FROM users WHERE email = $1', [email]);
    if (!user) {
      return { success: false, message: 'User not found' };
    }

    // Generate token
    const token = generateResetToken();
    const expiresAt = new Date(Date.now() + 1 * 60 * 60 * 1000); // 1 hour

    // Store reset token
    const tokenId = uid();
    await run(
      'INSERT INTO password_reset_tokens (id, user_id, token, expires_at) VALUES ($1, $2, $3, $4)',
      [tokenId, user.id, token, expiresAt.toISOString()]
    );

    // Return reset link (for local/beta, show token in response)
    const resetLink = `http://localhost:3000/reset-password?token=${token}`;
    
    return {
      success: true,
      message: 'Reset token generated',
      token: token,
      resetLink: resetLink,
      email: user.email,
      expiresAt: expiresAt
    };
  } catch (err) {
    console.error('Error creating reset token:', err);
    return { success: false, message: 'Error: ' + err.message };
  }
}

// Verify and use reset token
async function resetPasswordWithToken(token, newPassword) {
  try {
    if (newPassword.length < 12) {
      return { success: false, message: 'Password must be at least 12 characters' };
    }

    // Find valid token
    const resetRecord = await queryOne(
      'SELECT user_id, expires_at FROM password_reset_tokens WHERE token = $1',
      [token]
    );

    if (!resetRecord) {
      return { success: false, message: 'Invalid or expired token' };
    }

    // Check expiration
    if (new Date(resetRecord.expires_at) < new Date()) {
      return { success: false, message: 'Token has expired' };
    }

    // Hash new password
    const bcrypt = require('bcryptjs');
    const passwordHash = await bcrypt.hash(newPassword, 12);

    // Update password
    await run(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [passwordHash, resetRecord.user_id]
    );

    // Delete used token
    await run('DELETE FROM password_reset_tokens WHERE token = $1', [token]);

    return { success: true, message: 'Password reset successfully' };
  } catch (err) {
    console.error('Error resetting password:', err);
    return { success: false, message: 'Error: ' + err.message };
  }
}

module.exports = {
  generateResetToken,
  createPasswordResetToken,
  resetPasswordWithToken
};
