'use strict';

require('dotenv').config();

const express  = require('express');
const path     = require('path');
const session  = require('express-session');
const bcrypt   = require('bcryptjs');
const { uid, initDb, query, queryOne, run } = require('./src/db.js');

const app = express();
app.use(express.json());

// ── Environment Validation ────────────────────────────────────
const DEFAULT_SESSION_SECRET = 'fd-portfolio-dev-secret-change-in-prod';
const SESSION_SECRET = process.env.SESSION_SECRET || DEFAULT_SESSION_SECRET;

// Only warn/error in production if on Railway or if explicitly set to production
const isCloudProduction = process.env.RAILWAY_ENVIRONMENT_NAME || process.env.HEROKU_APP_NAME;
if (isCloudProduction && SESSION_SECRET === DEFAULT_SESSION_SECRET) {
  console.error('❌ ERROR: SESSION_SECRET must be set in production!');
  console.error('   Set the SESSION_SECRET environment variable to a strong random string.');
  process.exit(1);
}

// ── HTTPS Redirect Middleware (Production) ─────────────────
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.protocol !== 'https' && req.get('x-forwarded-proto') !== 'https') {
      return res.redirect(301, 'https://' + req.get('host') + req.url);
    }
    next();
  });
}

// ── Session Middleware ────────────────────────────────────────
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7  // 7 days
  }
}));

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// ── Row converters ────────────────────────────────────────────
function rowToMember(r) {
  return { id: r.id, name: r.name, relation: r.relation, pan: r.pan,
           phone: r.phone, email: r.email, notes: r.notes, createdAt: r.created_at };
}
function rowToAccount(r) {
  return { id: r.id, memberId: r.member_id, bank: r.bank,
           acctNumber: r.acct_number, acctType: r.acct_type,
           ifsc: r.ifsc, branch: r.branch, acctHolderName: r.acct_holder_name,
           openDate: r.open_date, isPrimary: r.is_primary === 1,
           notes: r.notes, createdAt: r.created_at };
}
function rowToDeposit(r) {
  return { id: r.id, memberId: r.member_id, linkedAccountId: r.linked_account_id,
           bank: r.bank, accountNo: r.account_no, principal: r.principal,
           rate: r.rate, compounding: r.compounding, startDate: r.start_date,
           tenureYears: r.tenure_years, tenureMonths: r.tenure_months,
           tenureDays: r.tenure_days, maturityDate: r.maturity_date,
           payout: r.payout, nomineeId: r.nominee_id,
           notes: r.notes, createdAt: r.created_at };
}

function rowToPF(r) {
  return { id: r.id, memberId: r.member_id, uan: r.uan,
           employerName: r.employer_name, empContribution: r.emp_contribution,
           erContribution: r.er_contribution, currentBalance: r.current_balance,
           interestRate: r.interest_rate, joinDate: r.join_date,
           notes: r.notes, createdAt: r.created_at };
}
function rowToNPS(r) {
  return { id: r.id, memberId: r.member_id, pran: r.pran, tier: r.tier,
           fundManager: r.fund_manager, subCategory: r.sub_category,
           totalInvested: r.total_invested, currentValue: r.current_value,
           unitsHeld: r.units_held, nav: r.nav, startDate: r.start_date,
           notes: r.notes, createdAt: r.created_at };
}
function rowToSIP(r) {
  return { id: r.id, memberId: r.member_id, fundName: r.fund_name,
           folioNumber: r.folio_number, fundType: r.fund_type, amcName: r.amc_name,
           monthlyAmount: r.monthly_amount, startDate: r.start_date,
           totalInvested: r.total_invested, currentValue: r.current_value,
           unitsHeld: r.units_held, nav: r.nav,
           isActive: r.is_active === 1, notes: r.notes, createdAt: r.created_at };
}
function rowToOtherRecord(r) {
  return { id: r.id, memberId: r.member_id, category: r.category,
           title: r.title, amount: r.amount, receivedDate: r.received_date,
           notes: r.notes, createdAt: r.created_at };
}
function rowToGoal(r) {
  return { id: r.id, title: r.title, category: r.category,
           targetAmount: r.target_amount, currentAmount: r.current_amount,
           targetDate: r.target_date, notes: r.notes, createdAt: r.created_at };
}

// ── Audit logging helper ──────────────────────────────────────
async function logAudit(action, entity, entityId, label, detail = '') {
  const id = uid();
  await run(
    `INSERT INTO audit_log (id, action, entity, entity_id, label, detail) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, action, entity, entityId, label, detail]
  );
}

// ── Auth Middleware & Helpers ─────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ── Auth Routes ───────────────────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, displayName = '' } = req.body;
    
    // Validate input
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    if (password.length < 12) {
      return res.status(400).json({ error: 'Password must be at least 12 characters' });
    }
    
    // Check if user already exists
    const existingUser = await queryOne('SELECT id FROM users WHERE email=$1', [email]);
    if (existingUser) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    
    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);
    
    // Create user
    const userId = uid();
    const userCountResult = await queryOne('SELECT COUNT(*) as n FROM users', []);
    const userCount = userCountResult?.n || 0;
    const isFirstUser = userCount === 0;
    
    await run(
      'INSERT INTO users (id, email, password_hash, display_name, is_admin) VALUES ($1,$2,$3,$4,$5)',
      [userId, email, passwordHash, displayName, isFirstUser ? 1 : 0]
    );
    
    // Check for unowned members on first signup
    let unownedMembers = [];
    if (isFirstUser) {
      const unowned = await query('SELECT id, name, relation FROM members WHERE user_id IS NULL OR user_id=\'\'', []);
      unownedMembers = unowned.map(m => ({ id: m.id, name: m.name, relation: m.relation }));
    }
    
    // Set session
    req.session.userId = userId;
    
    res.status(201).json({
      id: userId,
      email: email,
      displayName: displayName,
      unownedMembers: unownedMembers,
      isFirstUser: isFirstUser,
      message: unownedMembers.length > 0 ? `Found ${unownedMembers.length} existing family member(s). You can link them to your account.` : ''
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    
    // Find user by email
    const user = await queryOne('SELECT id, email, password_hash, display_name FROM users WHERE email=$1', [email]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    // Compare password
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    // Set session
    req.session.userId = user.id;
    
    res.json({
      id: user.id,
      email: user.email,
      displayName: user.display_name
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// ── Claim unowned family members (after signup) ─────────────────
app.post('/api/auth/claim-members', requireAuth, async (req, res) => {
  try {
    const { claimAll = false } = req.body;
    
    if (claimAll) {
      // Link all unowned members and goals to this user
      await run('UPDATE members SET user_id=$1 WHERE user_id IS NULL OR user_id=\'\'', [req.session.userId]);
      await run('UPDATE goals SET user_id=$1 WHERE user_id IS NULL OR user_id=\'\'', [req.session.userId]);
      
      const unowned = await query('SELECT id, name FROM members WHERE user_id=$1', [req.session.userId]);
      res.json({
        success: true,
        message: `Successfully linked ${unowned.length} family member(s) to your account`,
        count: unowned.length
      });
    } else {
      res.status(400).json({ error: 'Invalid request' });
    }
  } catch (err) {
    console.error('Claim members error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const user = await queryOne('SELECT id, email, display_name FROM users WHERE id=$1', [req.session.userId]);
    if (!user) {
      req.session.destroy();
      return res.status(401).json({ error: 'User not found' });
    }
    res.json({
      id: user.id,
      email: user.email,
      displayName: user.display_name
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Password Reset Endpoints ─────────────────────────────────
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Find user
    const user = await queryOne('SELECT id, email FROM users WHERE email=$1', [email]);
    if (!user) {
      // Don't reveal if email exists (security)
      return res.json({ 
        success: true, 
        message: 'If an account exists with this email, a reset link has been sent' 
      });
    }

    // Generate reset token
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 1 * 60 * 60 * 1000); // 1 hour

    // Store reset token
    const tokenId = uid();
    await run(
      'INSERT INTO password_reset_tokens (id, user_id, token, expires_at) VALUES ($1, $2, $3, $4)',
      [tokenId, user.id, token, expiresAt.toISOString()]
    );

    // For local/beta: return reset link in response
    const resetLink = `http://localhost:3000/reset-password?token=${token}`;
    
    console.log(`📧 Password reset requested for ${email}`);
    console.log(`   Reset link: ${resetLink}`);

    res.json({
      success: true,
      message: 'If an account exists with this email, a reset link has been sent',
      // For beta only - in production, this would be sent via email
      resetLink: resetLink,
      token: token
    });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    
    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token and new password are required' });
    }

    if (newPassword.length < 12) {
      return res.status(400).json({ error: 'Password must be at least 12 characters' });
    }

    // Find valid token
    const resetRecord = await queryOne(
      'SELECT user_id, expires_at FROM password_reset_tokens WHERE token = $1',
      [token]
    );

    if (!resetRecord) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    // Check expiration
    if (new Date(resetRecord.expires_at) < new Date()) {
      await run('DELETE FROM password_reset_tokens WHERE token = $1', [token]);
      return res.status(400).json({ error: 'Token has expired' });
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(newPassword, 12);

    // Update password
    await run(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [passwordHash, resetRecord.user_id]
    );

    // Delete used token
    await run('DELETE FROM password_reset_tokens WHERE token = $1', [token]);

    console.log('✅ Password reset successful');

    res.json({
      success: true,
      message: 'Password has been reset successfully. Please log in with your new password.'
    });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Ownership check helper ─────────────────────────────────────
async function checkMemberOwnership(memberId, userId) {
  const m = await queryOne('SELECT user_id FROM members WHERE id=$1', [memberId]);
  return m && m.user_id === userId;
}

// ── Members API ───────────────────────────────────────────────
app.get('/api/members', requireAuth, async (req, res) => {
  try {
    const rows = await query('SELECT * FROM members WHERE user_id=$1 ORDER BY created_at ASC', [req.session.userId]);
    res.json(rows.map(rowToMember));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/members', requireAuth, async (req, res) => {
  try {
    const { name, relation, pan='', phone='', email='', notes='' } = req.body;
    if (!name || !relation) return res.status(400).json({ error: 'name and relation are required' });
    const id = uid();
    await run(`INSERT INTO members (id,name,relation,pan,phone,email,notes,user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, name, relation, pan, phone, email, notes, req.session.userId]);
    await logAudit('CREATE', 'Member', id, name, `Relation: ${relation}`);
    const row = await queryOne('SELECT * FROM members WHERE id=$1', [id]);
    res.status(201).json(rowToMember(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/members/:id', requireAuth, async (req, res) => {
  try {
    const isOwner = await checkMemberOwnership(req.params.id, req.session.userId);
    if (!isOwner) return res.status(403).json({ error: 'Access denied' });
    
    const { name, relation, pan='', phone='', email='', notes='' } = req.body;
    await run(`UPDATE members SET name=$1,relation=$2,pan=$3,phone=$4,email=$5,notes=$6 WHERE id=$7`,
        [name, relation, pan, phone, email, notes, req.params.id]);
    const row = await queryOne('SELECT * FROM members WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Member not found' });
    await logAudit('UPDATE', 'Member', req.params.id, name, `Relation: ${relation}`);
    res.json(rowToMember(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/members/:id', requireAuth, async (req, res) => {
  try {
    const isOwner = await checkMemberOwnership(req.params.id, req.session.userId);
    if (!isOwner) return res.status(403).json({ error: 'Access denied' });
    
    const memberAccts = await query('SELECT id FROM accounts WHERE member_id=$1', [req.params.id]);
    for (const a of memberAccts) {
      await run("UPDATE deposits SET linked_account_id='' WHERE linked_account_id=$1", [a.id]);
    }
    await run('DELETE FROM accounts WHERE member_id=$1', [req.params.id]);
    await run('DELETE FROM deposits WHERE member_id=$1', [req.params.id]);
    await run('DELETE FROM pf_accounts WHERE member_id=$1', [req.params.id]);
    await run('DELETE FROM nps_accounts WHERE member_id=$1', [req.params.id]);
    await run('DELETE FROM sip_investments WHERE member_id=$1', [req.params.id]);
    await run('DELETE FROM other_records WHERE member_id=$1', [req.params.id]);
    const mRow = await queryOne('SELECT name FROM members WHERE id=$1', [req.params.id]);
    await logAudit('DELETE', 'Member', req.params.id, mRow ? mRow.name : req.params.id, 'Member and all linked data deleted');
    await run('DELETE FROM members WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Accounts API ──────────────────────────────────────────────
app.get('/api/accounts', requireAuth, async (req, res) => {
  try {
    const rows = await query('SELECT * FROM accounts WHERE member_id IN (SELECT id FROM members WHERE user_id=$1) ORDER BY is_primary DESC, created_at ASC', [req.session.userId]);
    res.json(rows.map(rowToAccount));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/accounts', requireAuth, async (req, res) => {
  try {
    const { memberId, bank, acctNumber, acctType, ifsc='', branch='',
            acctHolderName='', openDate='', isPrimary=false, notes='' } = req.body;
    if (!memberId || !bank || !acctNumber || !acctType)
      return res.status(400).json({ error: 'memberId, bank, acctNumber, acctType are required' });
    
    // Verify member belongs to user
    const isOwner = await checkMemberOwnership(memberId, req.session.userId);
    if (!isOwner) return res.status(403).json({ error: 'Access denied' });
    
    if (isPrimary) await run('UPDATE accounts SET is_primary=0 WHERE member_id=$1', [memberId]);
    const id = uid();
    await run(`INSERT INTO accounts (id,member_id,bank,acct_number,acct_type,ifsc,branch,acct_holder_name,open_date,is_primary,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, memberId, bank, acctNumber, acctType, ifsc, branch,
         acctHolderName, openDate, isPrimary ? 1 : 0, notes]);
    const row = await queryOne('SELECT * FROM accounts WHERE id=$1', [id]);
    res.status(201).json(rowToAccount(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/accounts/:id', requireAuth, async (req, res) => {
  try {
    const acc = await queryOne('SELECT member_id FROM accounts WHERE id=$1', [req.params.id]);
    if (!acc || !(await checkMemberOwnership(acc.member_id, req.session.userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const { memberId, bank, acctNumber, acctType, ifsc='', branch='',
            acctHolderName='', openDate='', isPrimary=false, notes='' } = req.body;
    if (isPrimary) await run('UPDATE accounts SET is_primary=0 WHERE member_id=$1 AND id!=$2', [memberId, req.params.id]);
    await run(`UPDATE accounts SET member_id=$1,bank=$2,acct_number=$3,acct_type=$4,ifsc=$5,branch=$6,
         acct_holder_name=$7,open_date=$8,is_primary=$9,notes=$10 WHERE id=$11`,
        [memberId, bank, acctNumber, acctType, ifsc, branch,
         acctHolderName, openDate, isPrimary ? 1 : 0, notes, req.params.id]);
    const row = await queryOne('SELECT * FROM accounts WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Account not found' });
    res.json(rowToAccount(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/accounts/:id', requireAuth, async (req, res) => {
  try {
    const acc = await queryOne('SELECT member_id FROM accounts WHERE id=$1', [req.params.id]);
    if (!acc || !(await checkMemberOwnership(acc.member_id, req.session.userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    await run("UPDATE deposits SET linked_account_id='' WHERE linked_account_id=$1", [req.params.id]);
    await run('DELETE FROM accounts WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Deposits API ──────────────────────────────────────────────
app.get('/api/deposits', requireAuth, async (req, res) => {
  try {
    const rows = await query('SELECT * FROM deposits WHERE member_id IN (SELECT id FROM members WHERE user_id=$1) ORDER BY start_date ASC', [req.session.userId]);
    res.json(rows.map(rowToDeposit));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/deposits', requireAuth, async (req, res) => {
  try {
    const { memberId, linkedAccountId='', bank, accountNo='', principal, rate,
            compounding='quarterly', startDate, tenureYears=0, tenureMonths=0,
            tenureDays=0, maturityDate, payout='cumulative', nomineeId='', notes='' } = req.body;
    if (!memberId || !bank || !principal || !rate || !startDate || !maturityDate)
      return res.status(400).json({ error: 'Required fields missing' });
    
    // Verify member belongs to user
    const isOwner = await checkMemberOwnership(memberId, req.session.userId);
    if (!isOwner) return res.status(403).json({ error: 'Access denied' });
    
    const id = uid();
    await run(`INSERT INTO deposits (id,member_id,linked_account_id,bank,account_no,principal,rate,
         compounding,start_date,tenure_years,tenure_months,tenure_days,maturity_date,payout,nominee_id,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [id, memberId, linkedAccountId, bank, accountNo, principal, rate,
         compounding, startDate, tenureYears, tenureMonths, tenureDays,
         maturityDate, payout, nomineeId, notes]);
    const mRow = await queryOne('SELECT name FROM members WHERE id=$1', [memberId]);
    await logAudit('CREATE', 'Deposit', id, `${bank} – ₹${Number(principal).toLocaleString('en-IN')}`, `Member: ${mRow?mRow.name:'—'} | Rate: ${rate}% | Matures: ${maturityDate}`);
    const row = await queryOne('SELECT * FROM deposits WHERE id=$1', [id]);
    res.status(201).json(rowToDeposit(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/deposits/:id', requireAuth, async (req, res) => {
  try {
    const dep = await queryOne('SELECT member_id FROM deposits WHERE id=$1', [req.params.id]);
    if (!dep || !(await checkMemberOwnership(dep.member_id, req.session.userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const { memberId, linkedAccountId='', bank, accountNo='', principal, rate,
            compounding='quarterly', startDate, tenureYears=0, tenureMonths=0,
            tenureDays=0, maturityDate, payout='cumulative', nomineeId='', notes='' } = req.body;
    await run(`UPDATE deposits SET member_id=$1,linked_account_id=$2,bank=$3,account_no=$4,principal=$5,
         rate=$6,compounding=$7,start_date=$8,tenure_years=$9,tenure_months=$10,tenure_days=$11,
         maturity_date=$12,payout=$13,nominee_id=$14,notes=$15 WHERE id=$16`,
        [memberId, linkedAccountId, bank, accountNo, principal, rate,
         compounding, startDate, tenureYears, tenureMonths, tenureDays,
         maturityDate, payout, nomineeId, notes, req.params.id]);
    const row = await queryOne('SELECT * FROM deposits WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Deposit not found' });
    await logAudit('UPDATE', 'Deposit', req.params.id, `${row.bank} – ₹${Number(row.principal).toLocaleString('en-IN')}`, `Rate: ${row.rate}% | Matures: ${row.maturity_date}`);
    res.json(rowToDeposit(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/deposits/:id', requireAuth, async (req, res) => {
  try {
    const dep = await queryOne('SELECT member_id, bank, principal, maturity_date FROM deposits WHERE id=$1', [req.params.id]);
    if (!dep || !(await checkMemberOwnership(dep.member_id, req.session.userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const dRow = dep;
    await logAudit('DELETE', 'Deposit', req.params.id, dRow ? `${dRow.bank} – ₹${Number(dRow.principal).toLocaleString('en-IN')}` : req.params.id, dRow ? `Matures: ${dRow.maturity_date}` : '');
    await run('DELETE FROM deposits WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PF API ────────────────────────────────────────────────────
app.get('/api/pf', requireAuth, async (req, res) => {
  try {
    const rows = await query('SELECT * FROM pf_accounts WHERE member_id IN (SELECT id FROM members WHERE user_id=$1) ORDER BY created_at ASC', [req.session.userId]);
    res.json(rows.map(rowToPF));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pf', requireAuth, async (req, res) => {
  try {
    const { memberId, uan='', employerName='', empContribution=0, erContribution=0,
            currentBalance=0, interestRate=8.25, joinDate='', notes='' } = req.body;
    if (!memberId) return res.status(400).json({ error: 'memberId required' });
    
    // Verify member belongs to user
    const isOwner = await checkMemberOwnership(memberId, req.session.userId);
    if (!isOwner) return res.status(403).json({ error: 'Access denied' });
    
    const id = uid();
    await run(`INSERT INTO pf_accounts (id,member_id,uan,employer_name,emp_contribution,er_contribution,current_balance,interest_rate,join_date,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, memberId, uan, employerName, empContribution, erContribution, currentBalance, interestRate, joinDate, notes]);
    const mRow = await queryOne('SELECT name FROM members WHERE id=$1', [memberId]);
    await logAudit('CREATE', 'PF', id, `${employerName||'PF'} – ${mRow?mRow.name:'—'}`, `Balance: ₹${Number(currentBalance).toLocaleString('en-IN')} | Rate: ${interestRate}%`);
    const row = await queryOne('SELECT * FROM pf_accounts WHERE id=$1', [id]);
    res.status(201).json(rowToPF(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/pf/:id', requireAuth, async (req, res) => {
  try {
    const pf = await queryOne('SELECT member_id FROM pf_accounts WHERE id=$1', [req.params.id]);
    if (!pf || !(await checkMemberOwnership(pf.member_id, req.session.userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const { memberId, uan='', employerName='', empContribution=0, erContribution=0,
            currentBalance=0, interestRate=8.25, joinDate='', notes='' } = req.body;
    await run(`UPDATE pf_accounts SET member_id=$1,uan=$2,employer_name=$3,emp_contribution=$4,er_contribution=$5,
         current_balance=$6,interest_rate=$7,join_date=$8,notes=$9 WHERE id=$10`,
        [memberId, uan, employerName, empContribution, erContribution, currentBalance, interestRate, joinDate, notes, req.params.id]);
    const row = await queryOne('SELECT * FROM pf_accounts WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'PF account not found' });
    await logAudit('UPDATE', 'PF', req.params.id, `${row.employer_name||'PF'}`, `Balance: ₹${Number(row.current_balance).toLocaleString('en-IN')} | Rate: ${row.interest_rate}%`);
    res.json(rowToPF(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/pf/:id', requireAuth, async (req, res) => {
  try {
    const pf = await queryOne('SELECT member_id, employer_name FROM pf_accounts WHERE id=$1', [req.params.id]);
    if (!pf || !(await checkMemberOwnership(pf.member_id, req.session.userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const pfRow = pf;
    await logAudit('DELETE', 'PF', req.params.id, pfRow ? pfRow.employer_name||'PF Account' : req.params.id, 'PF account deleted');
    await run('DELETE FROM pf_accounts WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── NPS API ───────────────────────────────────────────────────
app.get('/api/nps', requireAuth, async (req, res) => {
  try {
    const rows = await query('SELECT * FROM nps_accounts WHERE member_id IN (SELECT id FROM members WHERE user_id=$1) ORDER BY created_at ASC', [req.session.userId]);
    res.json(rows.map(rowToNPS));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/nps', requireAuth, async (req, res) => {
  try {
    const { memberId, pran='', tier='Tier I', fundManager='', subCategory='',
            totalInvested=0, currentValue=0, unitsHeld=0, nav=0, startDate='', notes='' } = req.body;
    if (!memberId) return res.status(400).json({ error: 'memberId required' });
    
    // Verify member belongs to user
    const isOwner = await checkMemberOwnership(memberId, req.session.userId);
    if (!isOwner) return res.status(403).json({ error: 'Access denied' });
    
    const id = uid();
    await run(`INSERT INTO nps_accounts (id,member_id,pran,tier,fund_manager,sub_category,total_invested,current_value,units_held,nav,start_date,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, memberId, pran, tier, fundManager, subCategory, totalInvested, currentValue, unitsHeld, nav, startDate, notes]);
    const mRowN = await queryOne('SELECT name FROM members WHERE id=$1', [memberId]);
    await logAudit('CREATE', 'NPS', id, `${tier} – ${mRowN?mRowN.name:'—'}`, `Invested: ₹${Number(totalInvested).toLocaleString('en-IN')} | Fund: ${fundManager}`);
    const row = await queryOne('SELECT * FROM nps_accounts WHERE id=$1', [id]);
    res.status(201).json(rowToNPS(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/nps/:id', requireAuth, async (req, res) => {
  try {
    const nps = await queryOne('SELECT member_id FROM nps_accounts WHERE id=$1', [req.params.id]);
    if (!nps || !(await checkMemberOwnership(nps.member_id, req.session.userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const { memberId, pran='', tier='Tier I', fundManager='', subCategory='',
            totalInvested=0, currentValue=0, unitsHeld=0, nav=0, startDate='', notes='' } = req.body;
    await run(`UPDATE nps_accounts SET member_id=$1,pran=$2,tier=$3,fund_manager=$4,sub_category=$5,
         total_invested=$6,current_value=$7,units_held=$8,nav=$9,start_date=$10,notes=$11 WHERE id=$12`,
        [memberId, pran, tier, fundManager, subCategory, totalInvested, currentValue, unitsHeld, nav, startDate, notes, req.params.id]);
    const row = await queryOne('SELECT * FROM nps_accounts WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'NPS account not found' });
    await logAudit('UPDATE', 'NPS', req.params.id, `${row.tier}`, `Value: ₹${Number(row.current_value).toLocaleString('en-IN')} | Fund: ${row.fund_manager}`);
    res.json(rowToNPS(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/nps/:id', requireAuth, async (req, res) => {
  try {
    const nps = await queryOne('SELECT member_id, tier, fund_manager FROM nps_accounts WHERE id=$1', [req.params.id]);
    if (!nps || !(await checkMemberOwnership(nps.member_id, req.session.userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const nRow = nps;
    await logAudit('DELETE', 'NPS', req.params.id, nRow ? `${nRow.tier} – ${nRow.fund_manager}` : req.params.id, 'NPS account deleted');
    await run('DELETE FROM nps_accounts WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SIP API ───────────────────────────────────────────────────
app.get('/api/sip', requireAuth, async (req, res) => {
  try {
    const rows = await query('SELECT * FROM sip_investments WHERE member_id IN (SELECT id FROM members WHERE user_id=$1) ORDER BY start_date ASC', [req.session.userId]);
    res.json(rows.map(rowToSIP));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sip', requireAuth, async (req, res) => {
  try {
    const { memberId, fundName, folioNumber='', fundType='Equity', amcName='',
            monthlyAmount=0, startDate, totalInvested=0, currentValue=0,
            unitsHeld=0, nav=0, isActive=true, notes='' } = req.body;
    if (!memberId || !fundName || !startDate) return res.status(400).json({ error: 'memberId, fundName, startDate required' });
    
    // Verify member belongs to user
    const isOwner = await checkMemberOwnership(memberId, req.session.userId);
    if (!isOwner) return res.status(403).json({ error: 'Access denied' });
    
    const id = uid();
    await run(`INSERT INTO sip_investments (id,member_id,fund_name,folio_number,fund_type,amc_name,monthly_amount,start_date,total_invested,current_value,units_held,nav,is_active,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [id, memberId, fundName, folioNumber, fundType, amcName, monthlyAmount, startDate,
         totalInvested, currentValue, unitsHeld, nav, isActive ? 1 : 0, notes]);
    const mRowS = await queryOne('SELECT name FROM members WHERE id=$1', [memberId]);
    await logAudit('CREATE', 'SIP', id, fundName, `Member: ${mRowS?mRowS.name:'—'} | Type: ${fundType} | Invested: ₹${Number(totalInvested).toLocaleString('en-IN')}`);
    const row = await queryOne('SELECT * FROM sip_investments WHERE id=$1', [id]);
    res.status(201).json(rowToSIP(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/sip/:id', requireAuth, async (req, res) => {
  try {
    const sip = await queryOne('SELECT member_id FROM sip_investments WHERE id=$1', [req.params.id]);
    if (!sip || !(await checkMemberOwnership(sip.member_id, req.session.userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const { memberId, fundName, folioNumber='', fundType='Equity', amcName='',
            monthlyAmount=0, startDate, totalInvested=0, currentValue=0,
            unitsHeld=0, nav=0, isActive=true, notes='' } = req.body;
    await run(`UPDATE sip_investments SET member_id=$1,fund_name=$2,folio_number=$3,fund_type=$4,amc_name=$5,
         monthly_amount=$6,start_date=$7,total_invested=$8,current_value=$9,units_held=$10,nav=$11,is_active=$12,notes=$13 WHERE id=$14`,
        [memberId, fundName, folioNumber, fundType, amcName, monthlyAmount, startDate,
         totalInvested, currentValue, unitsHeld, nav, isActive ? 1 : 0, notes, req.params.id]);
    const row = await queryOne('SELECT * FROM sip_investments WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'SIP not found' });
    await logAudit('UPDATE', 'SIP', req.params.id, row.fund_name, `Value: ₹${Number(row.current_value).toLocaleString('en-IN')} | NAV: ${row.nav}`);
    res.json(rowToSIP(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sip/:id', requireAuth, async (req, res) => {
  try {
    const sip = await queryOne('SELECT member_id, fund_name FROM sip_investments WHERE id=$1', [req.params.id]);
    if (!sip || !(await checkMemberOwnership(sip.member_id, req.session.userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const sRow = sip;
    await logAudit('DELETE', 'SIP', req.params.id, sRow ? sRow.fund_name : req.params.id, 'SIP fund deleted');
    await run('DELETE FROM sip_investments WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── History / Audit Log API ───────────────────────────────────
app.get('/api/history', requireAuth, async (req, res) => {
  try {
    const limit  = parseInt(req.query.limit)  || 200;
    const entity = req.query.entity || '';
    let sql = 'SELECT * FROM audit_log';
    const params = [];
    if (entity) { sql += ' WHERE entity=$1'; params.push(entity); }
    sql += ` ORDER BY created_at DESC LIMIT ${params.length + 1}`;
    params.push(limit);
    const rows = await query(sql, params);
    res.json(rows.map(r => ({
      id: r.id, action: r.action, entity: r.entity,
      entityId: r.entity_id, label: r.label, detail: r.detail,
      changedBy: r.changed_by, createdAt: r.created_at
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/history', requireAuth, async (req, res) => {
  try {
    await run('DELETE FROM audit_log');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CSV Import API ────────────────────────────────────────────
function parseCSV(csvText) {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) throw new Error('CSV must have header and at least one data row');

  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const records = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = [];
    let current = '';
    let inQuotes = false;

    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        fields.push(current.trim().replace(/^"|"$/g, ''));
        current = '';
      } else {
        current += char;
      }
    }
    fields.push(current.trim().replace(/^"|"$/g, ''));

    const record = {};
    headers.forEach((h, idx) => {
      record[h] = fields[idx] || '';
    });
    records.push(record);
  }

  return records;
}

app.post('/api/import/csv', requireAuth, express.text(), async (req, res) => {
  try {
    const csvText = req.body;
    const records = parseCSV(csvText);

    if (records.length === 0) {
      return res.status(400).json({ error: 'No records found in CSV' });
    }

    let imported = 0;
    let skipped = 0;
    const errors = [];

    for (const [idx, record] of records.entries()) {
      try {
        const memberName = record['Member']?.trim();
        const relation = record['Relation']?.trim() || 'Self';
        const bank = record['Bank']?.trim();
        const principal = parseFloat(record['Principal']);
        const rate = parseFloat(record['Rate %']);
        const compounding = record['Compounding']?.toLowerCase()?.trim() || 'quarterly';
        const startDate = record['Start Date']?.trim();
        const maturityDate = record['Maturity Date']?.trim();
        const payout = record['Payout']?.toLowerCase()?.trim() || 'cumulative';
        const notes = (record['Notes'] || '') + (record['FD Number'] ? ` [FD: ${record['FD Number']}]` : '');

        if (!memberName || !bank || isNaN(principal) || isNaN(rate) || !startDate || !maturityDate) {
          errors.push(`Row ${idx + 2}: Missing required fields`);
          skipped++;
          continue;
        }

        const existingMember = await queryOne('SELECT id FROM members WHERE name=$1 AND relation=$2 AND user_id=$3', [memberName, relation, req.session.userId]);
        let memberId;
        if (existingMember) {
          memberId = existingMember.id;
        } else {
          memberId = uid();
          await run('INSERT INTO members (id,name,relation,user_id) VALUES ($1,$2,$3,$4)', [memberId, memberName, relation, req.session.userId]);
        }

        const startD = new Date(startDate);
        const maturityD = new Date(maturityDate);
        const diffMs = maturityD - startD;
        const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
        const tenureYears = Math.floor(diffDays / 365);
        const tenureMonths = Math.floor((diffDays % 365) / 30);
        const tenureDays = diffDays % 30;

        const depositId = uid();
        await run(`INSERT INTO deposits (id,member_id,bank,principal,rate,compounding,start_date,tenure_years,tenure_months,tenure_days,maturity_date,payout,notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [depositId, memberId, bank, principal, rate, compounding, startDate, tenureYears, tenureMonths, tenureDays, maturityDate, payout, notes]);

        imported++;
      } catch (e) {
        errors.push(`Row ${idx + 2}: ${e.message}`);
        skipped++;
      }
    }

    res.json({
      success: true,
      imported,
      skipped,
      total: records.length,
      errors: errors.slice(0, 10)
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Goals API ────────────────────────────────────────────────
app.get('/api/goals', requireAuth, async (req, res) => {
  try {
    const rows = await query('SELECT * FROM goals WHERE user_id=$1 ORDER BY target_date ASC, created_at ASC', [req.session.userId]);
    res.json(rows.map(rowToGoal));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/goals', requireAuth, async (req, res) => {
  try {
    const { title, category='General', targetAmount=0, currentAmount=0, targetDate, notes='' } = req.body;
    if (!title || !targetDate) return res.status(400).json({ error: 'title and targetDate are required' });
    const id = uid();
    await run(`INSERT INTO goals (id,title,category,target_amount,current_amount,target_date,user_id,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, title, category, targetAmount, currentAmount, targetDate, req.session.userId, notes]);
    await logAudit('CREATE', 'Goal', id, title, `Target: ₹${targetAmount}`);
    const row = await queryOne('SELECT * FROM goals WHERE id=$1', [id]);
    res.status(201).json(rowToGoal(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/goals/:id', requireAuth, async (req, res) => {
  try {
    const goal = await queryOne('SELECT user_id FROM goals WHERE id=$1', [req.params.id]);
    if (!goal || goal.user_id !== req.session.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const { title, category='General', targetAmount=0, currentAmount=0, targetDate, notes='' } = req.body;
    await run(`UPDATE goals SET title=$1,category=$2,target_amount=$3,current_amount=$4,target_date=$5,notes=$6 WHERE id=$7`,
        [title, category, targetAmount, currentAmount, targetDate, notes, req.params.id]);
    const row = await queryOne('SELECT * FROM goals WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Goal not found' });
    await logAudit('UPDATE', 'Goal', req.params.id, title, `Target: ₹${targetAmount}`);
    res.json(rowToGoal(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/goals/:id', requireAuth, async (req, res) => {
  try {
    const row = await queryOne('SELECT user_id FROM goals WHERE id=$1', [req.params.id]);
    if (!row || row.user_id !== req.session.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const goalRow = await queryOne('SELECT * FROM goals WHERE id=$1', [req.params.id]);
    await run('DELETE FROM goals WHERE id=$1', [req.params.id]);
    if (goalRow) await logAudit('DELETE', 'Goal', req.params.id, goalRow.title);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Other Records API ───────────────────────────────────────
app.get('/api/others', requireAuth, async (req, res) => {
  try {
    const rows = await query('SELECT * FROM other_records WHERE member_id IN (SELECT id FROM members WHERE user_id=$1) ORDER BY received_date ASC', [req.session.userId]);
    res.json(rows.map(rowToOtherRecord));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/others', requireAuth, async (req, res) => {
  try {
    const { memberId, category, title, amount=0, receivedDate, notes='' } = req.body;
    if (!memberId || !category || !title || !receivedDate) return res.status(400).json({ error: 'memberId, category, title, and receivedDate are required' });
    
    // Verify member belongs to user
    const isOwner = await checkMemberOwnership(memberId, req.session.userId);
    if (!isOwner) return res.status(403).json({ error: 'Access denied' });
    
    const id = uid();
    await run(`INSERT INTO other_records (id,member_id,category,title,amount,received_date,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, memberId, category, title, amount, receivedDate, notes]);
    const row = await queryOne('SELECT * FROM other_records WHERE id=$1', [id]);
    res.status(201).json(rowToOtherRecord(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/others/:id', requireAuth, async (req, res) => {
  try {
    const other = await queryOne('SELECT member_id FROM other_records WHERE id=$1', [req.params.id]);
    if (!other || !(await checkMemberOwnership(other.member_id, req.session.userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const { memberId, category, title, amount=0, receivedDate, notes='' } = req.body;
    await run(`UPDATE other_records SET member_id=$1,category=$2,title=$3,amount=$4,received_date=$5,notes=$6 WHERE id=$7`,
        [memberId, category, title, amount, receivedDate, notes, req.params.id]);
    const row = await queryOne('SELECT * FROM other_records WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Other record not found' });
    res.json(rowToOtherRecord(row));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/others/:id', requireAuth, async (req, res) => {
  try {
    const other = await queryOne('SELECT member_id FROM other_records WHERE id=$1', [req.params.id]);
    if (!other || !(await checkMemberOwnership(other.member_id, req.session.userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    await run('DELETE FROM other_records WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Seed demo data ──────────────────────────────────────────
async function seedDemo() {
  try {
    const memberRow = await queryOne('SELECT COUNT(*) as n FROM members');
    const userRow = await queryOne('SELECT COUNT(*) as n FROM users');
    const memberCount = memberRow?.n || 0;
    const userCount = userRow?.n || 0;

    // Skip seed if there are already users (real data) or members
    if (memberCount > 0 || userCount > 0) {
      console.log(`ℹ️  Existing data found (${userCount} users, ${memberCount} members) — skipping seed.`);
      return;
    }

    const y = new Date().getFullYear();
    await run(`INSERT INTO members (id,name,relation,pan,phone,email,notes) VALUES
      ($1,$2,$3,$4,$5,$6,$7),
      ($8,$9,$10,$11,$12,$13,$14),
      ($15,$16,$17,$18,$19,$20,$21)`,
      ['m1','Rajesh Kumar','Self','ABCDE1234F','9876543210','rajesh@email.com','',
       'm2','Sunita Kumar','Spouse','PQRST5678G','9876543211','','',
       'm3','Ravi Kumar','Father','','','','Senior citizen rates']);

    await run(`INSERT INTO accounts (id,member_id,bank,acct_number,acct_type,ifsc,branch,acct_holder_name,open_date,is_primary,notes) VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11),
      ($12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22),
      ($23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33),
      ($34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44),
      ($45,$46,$47,$48,$49,$50,$51,$52,$53,$54,$55)`,
      ['a1','m1','SBI','10012345678','Savings','SBIN0001234','Anna Nagar, Chennai','Rajesh Kumar','2015-06-10',1,'Salary & primary account',
       'a2','m1','HDFC Bank','50100987654','Savings','HDFC0001122','T. Nagar, Chennai','Rajesh Kumar','2018-03-15',0,'FD and investments',
       'a3','m1','Axis Bank','91801234567','Savings','UTIB0001234','Velachery, Chennai','Rajesh Kumar','2020-09-01',0,'',
       'a4','m2','ICICI Bank','002601234567','Savings','ICIC0000260','Anna Nagar, Chennai','Sunita Kumar','2017-08-20',1,'Joint holder: Rajesh Kumar',
       'a5','m3','Post Office','PO9988776655','Savings','','Mylapore HO','Ravi Kumar','2010-04-05',1,'Senior citizen account']);

    await run(`INSERT INTO deposits (id,member_id,linked_account_id,bank,account_no,principal,rate,compounding,start_date,tenure_years,tenure_months,tenure_days,maturity_date,payout,nominee_id,notes) VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16),
      ($17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32),
      ($33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47,$48),
      ($49,$50,$51,$52,$53,$54,$55,$56,$57,$58,$59,$60,$61,$62,$63,$64),
      ($65,$66,$67,$68,$69,$70,$71,$72,$73,$74,$75,$76,$77,$78,$79,$80)`,
      ['d1','m1','a1','SBI','FD001234',200000,7.10,'quarterly',`${y-1}-04-01`,2,0,0,`${y+1}-04-01`,'cumulative','m2','Linked to savings a/c',
       'd2','m1','a2','HDFC Bank','HD009876',500000,7.40,'quarterly',`${y-1}-07-15`,1,6,0,`${y+1}-01-15`,'cumulative','m2','',
       'd3','m2','a4','ICICI Bank','IC005432',150000,7.25,'monthly',`${y}-01-01`,1,0,0,`${y+1}-01-01`,'cumulative','m1','Women special scheme',
       'd4','m3','a5','Post Office (TD)','PO112233',300000,7.50,'annually',`${y-2}-06-01`,5,0,0,`${y+3}-06-01`,'cumulative','m1','Senior citizen deposit',
       'd5','m1','a3','Axis Bank','AX334455',100000,6.75,'quarterly',`${y-1}-09-01`,0,11,0,`${y}-08-01`,'cumulative','','Short term']);

    console.log('✅ Demo data seeded.');
  } catch (err) {
    console.log('ℹ️  Could not seed demo data (may already exist):', err.message);
  }
}

// ── Boot ──────────────────────────────────────────────────────
async function start() {
  try {
    await initDb();
    
    // Only seed demo data if using SQLite (not PostgreSQL)
    const isPostgres = !!process.env.DATABASE_URL;
    if (!isPostgres) {
      await seedDemo();
    }
    
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`\n🏦 Family Portfolio Manager → http://localhost:${PORT}\n`);
    });
  } catch (err) {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  }
}

start();
