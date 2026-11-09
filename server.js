'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, 'portfolio.db');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// ── sql.js: load or create DB from file ───────────────────────
let db;   // sql.js Database instance

function saveDb() {
  // Persist in-memory DB back to disk after every write
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── Schema ────────────────────────────────────────────────────
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

// ── PF / NPS / SIP schema extension ──────────────────────────
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

// ── Audit log schema ──────────────────────────────────────────
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

// sql.js helper: run SELECT and return plain objects
function query(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
function queryOne(sql, params = []) {
  return query(sql, params)[0] || null;
}
function run(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

// ── Audit logging helper ──────────────────────────────────────
function logAudit(action, entity, entityId, label, detail = '') {
  const id = uid();
  db.run(
    `INSERT INTO audit_log (id, action, entity, entity_id, label, detail) VALUES (?,?,?,?,?,?)`,
    [id, action, entity, entityId, label, detail]
  );
  saveDb();
}

// ── Members API ───────────────────────────────────────────────
app.get('/api/members', (req, res) => {
  res.json(query('SELECT * FROM members ORDER BY created_at ASC').map(rowToMember));
});

app.post('/api/members', (req, res) => {
  const { name, relation, pan='', phone='', email='', notes='' } = req.body;
  if (!name || !relation) return res.status(400).json({ error: 'name and relation are required' });
  const id = uid();
  run(`INSERT INTO members (id,name,relation,pan,phone,email,notes) VALUES (?,?,?,?,?,?,?)`,
      [id, name, relation, pan, phone, email, notes]);
  logAudit('CREATE', 'Member', id, name, `Relation: ${relation}`);
  res.status(201).json(rowToMember(queryOne('SELECT * FROM members WHERE id=?', [id])));
});

app.put('/api/members/:id', (req, res) => {
  const { name, relation, pan='', phone='', email='', notes='' } = req.body;
  run(`UPDATE members SET name=?,relation=?,pan=?,phone=?,email=?,notes=? WHERE id=?`,
      [name, relation, pan, phone, email, notes, req.params.id]);
  const row = queryOne('SELECT * FROM members WHERE id=?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Member not found' });
  logAudit('UPDATE', 'Member', req.params.id, name, `Relation: ${relation}`);
  res.json(rowToMember(row));
});

app.delete('/api/members/:id', (req, res) => {
  // Cascade manually (sql.js doesn't enforce FK)
  const memberAccts = query('SELECT id FROM accounts WHERE member_id=?', [req.params.id]);
  memberAccts.forEach(a => {
    run("UPDATE deposits SET linked_account_id='' WHERE linked_account_id=?", [a.id]);
  });
  run('DELETE FROM accounts WHERE member_id=?', [req.params.id]);
  run('DELETE FROM deposits WHERE member_id=?', [req.params.id]);
  run('DELETE FROM pf_accounts WHERE member_id=?', [req.params.id]);
  run('DELETE FROM nps_accounts WHERE member_id=?', [req.params.id]);
  run('DELETE FROM sip_investments WHERE member_id=?', [req.params.id]);
  run('DELETE FROM other_records WHERE member_id=?', [req.params.id]);
  const mRow = queryOne('SELECT name FROM members WHERE id=?', [req.params.id]);
  logAudit('DELETE', 'Member', req.params.id, mRow ? mRow.name : req.params.id, 'Member and all linked data deleted');
  run('DELETE FROM members WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// ── Accounts API ──────────────────────────────────────────────
app.get('/api/accounts', (req, res) => {
  res.json(query('SELECT * FROM accounts ORDER BY is_primary DESC, created_at ASC').map(rowToAccount));
});

app.post('/api/accounts', (req, res) => {
  const { memberId, bank, acctNumber, acctType, ifsc='', branch='',
          acctHolderName='', openDate='', isPrimary=false, notes='' } = req.body;
  if (!memberId || !bank || !acctNumber || !acctType)
    return res.status(400).json({ error: 'memberId, bank, acctNumber, acctType are required' });
  if (isPrimary) run('UPDATE accounts SET is_primary=0 WHERE member_id=?', [memberId]);
  const id = uid();
  run(`INSERT INTO accounts (id,member_id,bank,acct_number,acct_type,ifsc,branch,acct_holder_name,open_date,is_primary,notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, memberId, bank, acctNumber, acctType, ifsc, branch,
       acctHolderName, openDate, isPrimary ? 1 : 0, notes]);
  res.status(201).json(rowToAccount(queryOne('SELECT * FROM accounts WHERE id=?', [id])));
});

app.put('/api/accounts/:id', (req, res) => {
  const { memberId, bank, acctNumber, acctType, ifsc='', branch='',
          acctHolderName='', openDate='', isPrimary=false, notes='' } = req.body;
  if (isPrimary) run('UPDATE accounts SET is_primary=0 WHERE member_id=? AND id!=?', [memberId, req.params.id]);
  run(`UPDATE accounts SET member_id=?,bank=?,acct_number=?,acct_type=?,ifsc=?,branch=?,
       acct_holder_name=?,open_date=?,is_primary=?,notes=? WHERE id=?`,
      [memberId, bank, acctNumber, acctType, ifsc, branch,
       acctHolderName, openDate, isPrimary ? 1 : 0, notes, req.params.id]);
  const row = queryOne('SELECT * FROM accounts WHERE id=?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Account not found' });
  res.json(rowToAccount(row));
});

app.delete('/api/accounts/:id', (req, res) => {
  run("UPDATE deposits SET linked_account_id='' WHERE linked_account_id=?", [req.params.id]);
  run('DELETE FROM accounts WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// ── Deposits API ──────────────────────────────────────────────
app.get('/api/deposits', (req, res) => {
  res.json(query('SELECT * FROM deposits ORDER BY start_date ASC').map(rowToDeposit));
});

app.post('/api/deposits', (req, res) => {
  const { memberId, linkedAccountId='', bank, accountNo='', principal, rate,
          compounding='quarterly', startDate, tenureYears=0, tenureMonths=0,
          tenureDays=0, maturityDate, payout='cumulative', nomineeId='', notes='' } = req.body;
  if (!memberId || !bank || !principal || !rate || !startDate || !maturityDate)
    return res.status(400).json({ error: 'Required fields missing' });
  const id = uid();
  run(`INSERT INTO deposits (id,member_id,linked_account_id,bank,account_no,principal,rate,
       compounding,start_date,tenure_years,tenure_months,tenure_days,maturity_date,payout,nominee_id,notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, memberId, linkedAccountId, bank, accountNo, principal, rate,
       compounding, startDate, tenureYears, tenureMonths, tenureDays,
       maturityDate, payout, nomineeId, notes]);
  const mRow = queryOne('SELECT name FROM members WHERE id=?', [memberId]);
  logAudit('CREATE', 'Deposit', id, `${bank} – ₹${Number(principal).toLocaleString('en-IN')}`, `Member: ${mRow?mRow.name:'—'} | Rate: ${rate}% | Matures: ${maturityDate}`);
  res.status(201).json(rowToDeposit(queryOne('SELECT * FROM deposits WHERE id=?', [id])));
});

app.put('/api/deposits/:id', (req, res) => {
  const { memberId, linkedAccountId='', bank, accountNo='', principal, rate,
          compounding='quarterly', startDate, tenureYears=0, tenureMonths=0,
          tenureDays=0, maturityDate, payout='cumulative', nomineeId='', notes='' } = req.body;
  run(`UPDATE deposits SET member_id=?,linked_account_id=?,bank=?,account_no=?,principal=?,
       rate=?,compounding=?,start_date=?,tenure_years=?,tenure_months=?,tenure_days=?,
       maturity_date=?,payout=?,nominee_id=?,notes=? WHERE id=?`,
      [memberId, linkedAccountId, bank, accountNo, principal, rate,
       compounding, startDate, tenureYears, tenureMonths, tenureDays,
       maturityDate, payout, nomineeId, notes, req.params.id]);
  const row = queryOne('SELECT * FROM deposits WHERE id=?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Deposit not found' });
  logAudit('UPDATE', 'Deposit', req.params.id, `${row.bank} – ₹${Number(row.principal).toLocaleString('en-IN')}`, `Rate: ${row.rate}% | Matures: ${row.maturity_date}`);
  res.json(rowToDeposit(row));
});

app.delete('/api/deposits/:id', (req, res) => {
  const dRow = queryOne('SELECT bank, principal, maturity_date FROM deposits WHERE id=?', [req.params.id]);
  logAudit('DELETE', 'Deposit', req.params.id, dRow ? `${dRow.bank} – ₹${Number(dRow.principal).toLocaleString('en-IN')}` : req.params.id, dRow ? `Matures: ${dRow.maturity_date}` : '');
  run('DELETE FROM deposits WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// ── PF API ────────────────────────────────────────────────────
app.get('/api/pf', (req, res) => {
  res.json(query('SELECT * FROM pf_accounts ORDER BY created_at ASC').map(rowToPF));
});
app.post('/api/pf', (req, res) => {
  const { memberId, uan='', employerName='', empContribution=0, erContribution=0,
          currentBalance=0, interestRate=8.25, joinDate='', notes='' } = req.body;
  if (!memberId) return res.status(400).json({ error: 'memberId required' });
  const id = uid();
  run(`INSERT INTO pf_accounts (id,member_id,uan,employer_name,emp_contribution,er_contribution,current_balance,interest_rate,join_date,notes)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, memberId, uan, employerName, empContribution, erContribution, currentBalance, interestRate, joinDate, notes]);
  const mRow = queryOne('SELECT name FROM members WHERE id=?', [memberId]);
  logAudit('CREATE', 'PF', id, `${employerName||'PF'} – ${mRow?mRow.name:'—'}`, `Balance: ₹${Number(currentBalance).toLocaleString('en-IN')} | Rate: ${interestRate}%`);
  res.status(201).json(rowToPF(queryOne('SELECT * FROM pf_accounts WHERE id=?', [id])));
});
app.put('/api/pf/:id', (req, res) => {
  const { memberId, uan='', employerName='', empContribution=0, erContribution=0,
          currentBalance=0, interestRate=8.25, joinDate='', notes='' } = req.body;
  run(`UPDATE pf_accounts SET member_id=?,uan=?,employer_name=?,emp_contribution=?,er_contribution=?,
       current_balance=?,interest_rate=?,join_date=?,notes=? WHERE id=?`,
      [memberId, uan, employerName, empContribution, erContribution, currentBalance, interestRate, joinDate, notes, req.params.id]);
  const row = queryOne('SELECT * FROM pf_accounts WHERE id=?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'PF account not found' });
  logAudit('UPDATE', 'PF', req.params.id, `${row.employer_name||'PF'}`, `Balance: ₹${Number(row.current_balance).toLocaleString('en-IN')} | Rate: ${row.interest_rate}%`);
  res.json(rowToPF(row));
});
app.delete('/api/pf/:id', (req, res) => {
  const pfRow = queryOne('SELECT employer_name FROM pf_accounts WHERE id=?', [req.params.id]);
  logAudit('DELETE', 'PF', req.params.id, pfRow ? pfRow.employer_name||'PF Account' : req.params.id, 'PF account deleted');
  run('DELETE FROM pf_accounts WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// ── NPS API ───────────────────────────────────────────────────
app.get('/api/nps', (req, res) => {
  res.json(query('SELECT * FROM nps_accounts ORDER BY created_at ASC').map(rowToNPS));
});
app.post('/api/nps', (req, res) => {
  const { memberId, pran='', tier='Tier I', fundManager='', subCategory='',
          totalInvested=0, currentValue=0, unitsHeld=0, nav=0, startDate='', notes='' } = req.body;
  if (!memberId) return res.status(400).json({ error: 'memberId required' });
  const id = uid();
  run(`INSERT INTO nps_accounts (id,member_id,pran,tier,fund_manager,sub_category,total_invested,current_value,units_held,nav,start_date,notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, memberId, pran, tier, fundManager, subCategory, totalInvested, currentValue, unitsHeld, nav, startDate, notes]);
  const mRowN = queryOne('SELECT name FROM members WHERE id=?', [memberId]);
  logAudit('CREATE', 'NPS', id, `${tier} – ${mRowN?mRowN.name:'—'}`, `Invested: ₹${Number(totalInvested).toLocaleString('en-IN')} | Fund: ${fundManager}`);
  res.status(201).json(rowToNPS(queryOne('SELECT * FROM nps_accounts WHERE id=?', [id])));
});
app.put('/api/nps/:id', (req, res) => {
  const { memberId, pran='', tier='Tier I', fundManager='', subCategory='',
          totalInvested=0, currentValue=0, unitsHeld=0, nav=0, startDate='', notes='' } = req.body;
  run(`UPDATE nps_accounts SET member_id=?,pran=?,tier=?,fund_manager=?,sub_category=?,
       total_invested=?,current_value=?,units_held=?,nav=?,start_date=?,notes=? WHERE id=?`,
      [memberId, pran, tier, fundManager, subCategory, totalInvested, currentValue, unitsHeld, nav, startDate, notes, req.params.id]);
  const row = queryOne('SELECT * FROM nps_accounts WHERE id=?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'NPS account not found' });
  logAudit('UPDATE', 'NPS', req.params.id, `${row.tier}`, `Value: ₹${Number(row.current_value).toLocaleString('en-IN')} | Fund: ${row.fund_manager}`);
  res.json(rowToNPS(row));
});
app.delete('/api/nps/:id', (req, res) => {
  const nRow = queryOne('SELECT tier, fund_manager FROM nps_accounts WHERE id=?', [req.params.id]);
  logAudit('DELETE', 'NPS', req.params.id, nRow ? `${nRow.tier} – ${nRow.fund_manager}` : req.params.id, 'NPS account deleted');
  run('DELETE FROM nps_accounts WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// ── SIP API ───────────────────────────────────────────────────
app.get('/api/sip', (req, res) => {
  res.json(query('SELECT * FROM sip_investments ORDER BY start_date ASC').map(rowToSIP));
});
app.post('/api/sip', (req, res) => {
  const { memberId, fundName, folioNumber='', fundType='Equity', amcName='',
          monthlyAmount=0, startDate, totalInvested=0, currentValue=0,
          unitsHeld=0, nav=0, isActive=true, notes='' } = req.body;
  if (!memberId || !fundName || !startDate) return res.status(400).json({ error: 'memberId, fundName, startDate required' });
  const id = uid();
  run(`INSERT INTO sip_investments (id,member_id,fund_name,folio_number,fund_type,amc_name,monthly_amount,start_date,total_invested,current_value,units_held,nav,is_active,notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, memberId, fundName, folioNumber, fundType, amcName, monthlyAmount, startDate,
       totalInvested, currentValue, unitsHeld, nav, isActive ? 1 : 0, notes]);
  const mRowS = queryOne('SELECT name FROM members WHERE id=?', [memberId]);
  logAudit('CREATE', 'SIP', id, fundName, `Member: ${mRowS?mRowS.name:'—'} | Type: ${fundType} | Invested: ₹${Number(totalInvested).toLocaleString('en-IN')}`);
  res.status(201).json(rowToSIP(queryOne('SELECT * FROM sip_investments WHERE id=?', [id])));
});
app.put('/api/sip/:id', (req, res) => {
  const { memberId, fundName, folioNumber='', fundType='Equity', amcName='',
          monthlyAmount=0, startDate, totalInvested=0, currentValue=0,
          unitsHeld=0, nav=0, isActive=true, notes='' } = req.body;
  run(`UPDATE sip_investments SET member_id=?,fund_name=?,folio_number=?,fund_type=?,amc_name=?,
       monthly_amount=?,start_date=?,total_invested=?,current_value=?,units_held=?,nav=?,is_active=?,notes=? WHERE id=?`,
      [memberId, fundName, folioNumber, fundType, amcName, monthlyAmount, startDate,
       totalInvested, currentValue, unitsHeld, nav, isActive ? 1 : 0, notes, req.params.id]);
  const row = queryOne('SELECT * FROM sip_investments WHERE id=?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'SIP not found' });
  logAudit('UPDATE', 'SIP', req.params.id, row.fund_name, `Value: ₹${Number(row.current_value).toLocaleString('en-IN')} | NAV: ${row.nav}`);
  res.json(rowToSIP(row));
});
app.delete('/api/sip/:id', (req, res) => {
  const sRow = queryOne('SELECT fund_name FROM sip_investments WHERE id=?', [req.params.id]);
  logAudit('DELETE', 'SIP', req.params.id, sRow ? sRow.fund_name : req.params.id, 'SIP fund deleted');
  run('DELETE FROM sip_investments WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// ── History / Audit Log API ───────────────────────────────────
app.get('/api/history', (req, res) => {
  const limit  = parseInt(req.query.limit)  || 200;
  const entity = req.query.entity || '';
  let sql = 'SELECT * FROM audit_log';
  const params = [];
  if (entity) { sql += ' WHERE entity=?'; params.push(entity); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  const rows = query(sql, params).map(r => ({
    id: r.id, action: r.action, entity: r.entity,
    entityId: r.entity_id, label: r.label, detail: r.detail,
    changedBy: r.changed_by, createdAt: r.created_at
  }));
  res.json(rows);
});

app.delete('/api/history', (req, res) => {
  run('DELETE FROM audit_log');
  res.json({ ok: true });
});

// ── CSV Import API ────────────────────────────────────────────
// Simple CSV parser for deposits
function parseCSV(csvText) {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) throw new Error('CSV must have header and at least one data row');

  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const records = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Simple CSV parsing (handles quoted fields)
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

app.post('/api/import/csv', express.text(), (req, res) => {
  try {
    const csvText = req.body;
    const records = parseCSV(csvText);

    if (records.length === 0) {
      return res.status(400).json({ error: 'No records found in CSV' });
    }

    let imported = 0;
    let skipped = 0;
    const errors = [];

    records.forEach((record, idx) => {
      try {
        // Extract data from CSV
        const memberName = record['Member']?.trim();
        const relation = record['Relation']?.trim() || 'Self';
        const bank = record['Bank']?.trim();
        const principal = parseFloat(record['Principal']);
        const rate = parseFloat(record['Rate %']);
        const compounding = record['Compounding']?.toLowerCase()?.trim() || 'quarterly';
        const startDate = record['Start Date']?.trim();
        const maturityDate = record['Maturity Date']?.trim();
        const payout = record['Payout']?.toLowerCase()?.trim() || 'cumulative';
        const status = record['Status']?.trim() || 'active';
        const notes = (record['Notes'] || '') + (record['FD Number'] ? ` [FD: ${record['FD Number']}]` : '');

        // Validate required fields
        if (!memberName || !bank || isNaN(principal) || isNaN(rate) || !startDate || !maturityDate) {
          errors.push(`Row ${idx + 2}: Missing required fields (Member, Bank, Principal, Rate, Start Date, Maturity Date)`);
          skipped++;
          return;
        }

        // Find or create member
        const existingMember = queryOne('SELECT id FROM members WHERE name=? AND relation=?', [memberName, relation]);
        let memberId;
        if (existingMember) {
          memberId = existingMember.id;
        } else {
          memberId = uid();
          run('INSERT INTO members (id,name,relation) VALUES (?,?,?)', [memberId, memberName, relation]);
        }

        // Calculate tenure
        const startD = new Date(startDate);
        const maturityD = new Date(maturityDate);
        const diffMs = maturityD - startD;
        const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
        const tenureYears = Math.floor(diffDays / 365);
        const tenureMonths = Math.floor((diffDays % 365) / 30);
        const tenureDays = diffDays % 30;

        // Insert deposit
        const depositId = uid();
        run(`INSERT INTO deposits (id,member_id,bank,principal,rate,compounding,start_date,tenure_years,tenure_months,tenure_days,maturity_date,payout,notes)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [depositId, memberId, bank, principal, rate, compounding, startDate, tenureYears, tenureMonths, tenureDays, maturityDate, payout, notes]);

        imported++;
      } catch (e) {
        errors.push(`Row ${idx + 2}: ${e.message}`);
        skipped++;
      }
    });

    saveDb();
    res.json({
      success: true,
      imported,
      skipped,
      total: records.length,
      errors: errors.slice(0, 10) // Limit to first 10 errors
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Goals API ────────────────────────────────────────────────
app.get('/api/goals', (req, res) => {
  res.json(query('SELECT * FROM goals ORDER BY target_date ASC, created_at ASC').map(rowToGoal));
});
app.post('/api/goals', (req, res) => {
  const { title, category='General', targetAmount=0, currentAmount=0, targetDate, notes='' } = req.body;
  if (!title || !targetDate) return res.status(400).json({ error: 'title and targetDate are required' });
  const id = uid();
  run(`INSERT INTO goals (id,title,category,target_amount,current_amount,target_date,notes)
       VALUES (?,?,?,?,?,?,?)`, [id, title, category, targetAmount, currentAmount, targetDate, notes]);
  logAudit('CREATE', 'Goal', id, title, `Target: ₹${targetAmount}`);
  res.status(201).json(rowToGoal(queryOne('SELECT * FROM goals WHERE id=?', [id])));
});
app.put('/api/goals/:id', (req, res) => {
  const { title, category='General', targetAmount=0, currentAmount=0, targetDate, notes='' } = req.body;
  run(`UPDATE goals SET title=?,category=?,target_amount=?,current_amount=?,target_date=?,notes=? WHERE id=?`,
      [title, category, targetAmount, currentAmount, targetDate, notes, req.params.id]);
  const row = queryOne('SELECT * FROM goals WHERE id=?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Goal not found' });
  logAudit('UPDATE', 'Goal', req.params.id, title, `Target: ₹${targetAmount}`);
  res.json(rowToGoal(row));
});
app.delete('/api/goals/:id', (req, res) => {
  const row = queryOne('SELECT * FROM goals WHERE id=?', [req.params.id]);
  run('DELETE FROM goals WHERE id=?', [req.params.id]);
  if (row) logAudit('DELETE', 'Goal', req.params.id, row.title);
  res.json({ ok: true });
});

// ── Other Records API ───────────────────────────────────────
app.get('/api/others', (req, res) => {
  res.json(query('SELECT * FROM other_records ORDER BY received_date ASC').map(rowToOtherRecord));
});
app.post('/api/others', (req, res) => {
  const { memberId, category, title, amount=0, receivedDate, notes='' } = req.body;
  if (!memberId || !category || !title || !receivedDate) return res.status(400).json({ error: 'memberId, category, title, and receivedDate are required' });
  const id = uid();
  run(`INSERT INTO other_records (id,member_id,category,title,amount,received_date,notes)
       VALUES (?,?,?,?,?,?,?)`, [id, memberId, category, title, amount, receivedDate, notes]);
  res.status(201).json(rowToOtherRecord(queryOne('SELECT * FROM other_records WHERE id=?', [id])));
});
app.put('/api/others/:id', (req, res) => {
  const { memberId, category, title, amount=0, receivedDate, notes='' } = req.body;
  run(`UPDATE other_records SET member_id=?,category=?,title=?,amount=?,received_date=?,notes=? WHERE id=?`,
      [memberId, category, title, amount, receivedDate, notes, req.params.id]);
  const row = queryOne('SELECT * FROM other_records WHERE id=?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Other record not found' });
  res.json(rowToOtherRecord(row));
});
app.delete('/api/others/:id', (req, res) => {
  run('DELETE FROM other_records WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// ── Seed demo data (only if DB is completely empty) ───────────
function seedDemo() {
  const memberCount  = queryOne('SELECT COUNT(*) as n FROM members').n;
  const depositCount = queryOne('SELECT COUNT(*) as n FROM deposits').n;
  // Only seed if truly empty — never overwrite real user data
  if (memberCount > 0 || depositCount > 0) {
    console.log(`ℹ️  Existing data found (${memberCount} members, ${depositCount} deposits) — skipping seed.`);
    return;
  }
  const y = new Date().getFullYear();
  run(`INSERT INTO members (id,name,relation,pan,phone,email,notes) VALUES
    ('m1','Rajesh Kumar','Self','ABCDE1234F','9876543210','rajesh@email.com',''),
    ('m2','Sunita Kumar','Spouse','PQRST5678G','9876543211','',''),
    ('m3','Ravi Kumar','Father','','','','Senior citizen rates')`);
  run(`INSERT INTO accounts (id,member_id,bank,acct_number,acct_type,ifsc,branch,acct_holder_name,open_date,is_primary,notes) VALUES
    ('a1','m1','SBI','10012345678','Savings','SBIN0001234','Anna Nagar, Chennai','Rajesh Kumar','2015-06-10',1,'Salary & primary account'),
    ('a2','m1','HDFC Bank','50100987654','Savings','HDFC0001122','T. Nagar, Chennai','Rajesh Kumar','2018-03-15',0,'FD and investments'),
    ('a3','m1','Axis Bank','91801234567','Savings','UTIB0001234','Velachery, Chennai','Rajesh Kumar','2020-09-01',0,''),
    ('a4','m2','ICICI Bank','002601234567','Savings','ICIC0000260','Anna Nagar, Chennai','Sunita Kumar','2017-08-20',1,'Joint holder: Rajesh Kumar'),
    ('a5','m3','Post Office','PO9988776655','Savings','','Mylapore HO','Ravi Kumar','2010-04-05',1,'Senior citizen account')`);
  run(`INSERT INTO deposits (id,member_id,linked_account_id,bank,account_no,principal,rate,compounding,start_date,tenure_years,tenure_months,tenure_days,maturity_date,payout,nominee_id,notes) VALUES
    ('d1','m1','a1','SBI','FD001234',200000,7.10,'quarterly','${y-1}-04-01',2,0,0,'${y+1}-04-01','cumulative','m2','Linked to savings a/c'),
    ('d2','m1','a2','HDFC Bank','HD009876',500000,7.40,'quarterly','${y-1}-07-15',1,6,0,'${y+1}-01-15','cumulative','m2',''),
    ('d3','m2','a4','ICICI Bank','IC005432',150000,7.25,'monthly','${y}-01-01',1,0,0,'${y+1}-01-01','cumulative','m1','Women special scheme'),
    ('d4','m3','a5','Post Office (TD)','PO112233',300000,7.50,'annually','${y-2}-06-01',5,0,0,'${y+3}-06-01','cumulative','m1','Senior citizen deposit'),
    ('d5','m1','a3','Axis Bank','AX334455',100000,6.75,'quarterly','${y-1}-09-01',0,11,0,'${y}-08-01','cumulative','','Short term')`);

  // PF seed
  run(`INSERT INTO pf_accounts (id,member_id,uan,employer_name,emp_contribution,er_contribution,current_balance,interest_rate,join_date,notes) VALUES
    ('pf1','m1','100234567890','ABC Technologies Pvt Ltd',1800,1800,485000,8.25,'${y-6}-06-01','Monthly contribution via salary'),
    ('pf2','m2','100234567891','ABC Technologies Pvt Ltd',1500,1500,220000,8.25,'${y-4}-03-01','Spouse PF account')`);

  // NPS seed
  run(`INSERT INTO nps_accounts (id,member_id,pran,tier,fund_manager,sub_category,total_invested,current_value,units_held,nav,start_date,notes) VALUES
    ('nps1','m1','110234567890','Tier I','SBI Pension Funds','Auto Choice - LC50',180000,224500,6820.5,32.91,'${y-4}-04-15','Govt sector NPS - auto deducted'),
    ('nps2','m1','110234567890','Tier II','SBI Pension Funds','Equity',60000,71200,1950.3,36.51,'${y-3}-04-15','Voluntary Tier II')`);

  // SIP seed
  run(`INSERT INTO sip_investments (id,member_id,fund_name,folio_number,fund_type,amc_name,monthly_amount,start_date,total_invested,current_value,units_held,nav,is_active,notes) VALUES
    ('sip1','m1','Mirae Asset Large Cap Fund - Direct Growth','12345678','Equity','Mirae Asset',5000,'${y-3}-01-10',180000,241600,2345.67,103.00,1,'Long term wealth creation'),
    ('sip2','m1','HDFC Nifty 50 Index Fund - Direct Plan','23456789','Index','HDFC AMC',3000,'${y-2}-04-01',84000,97300,4102.11,23.72,1,'Index fund for diversification'),
    ('sip3','m2','SBI Bluechip Fund - Regular Growth','34567890','Equity','SBI Funds',2000,'${y-2}-06-01',72000,83400,1876.44,44.45,1,''),
    ('sip4','m1','Axis Liquid Fund','45678901','Debt','Axis AMC',0,'${y-4}-01-01',50000,58900,422.18,139.52,0,'One-time investment, SIP stopped')`);

  console.log('✅ Demo data seeded.');
}

// ── Boot ──────────────────────────────────────────────────────
initSqlJs().then(SQL => {
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    // Make a backup before any schema changes
    const backupPath = DB_PATH.replace('.db', '_backup_' + Date.now() + '.db');
    fs.writeFileSync(backupPath, fileBuffer);
    console.log(`📂 Loaded existing database. Backup saved to ${path.basename(backupPath)}`);
  } else {
    db = new SQL.Database();
    console.log('🆕 Created new database.');
  }

  // Run base schema (CREATE TABLE IF NOT EXISTS — safe on existing DB)
  db.run(SCHEMA);
  // Run investment schema (also IF NOT EXISTS — only adds tables if missing)
  db.run(SCHEMA2);
  // Run audit log schema
  db.run(SCHEMA3);
  saveDb();
  seedDemo();

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n🏦 Family Portfolio Manager → http://localhost:${PORT}\n`);
  });
}).catch(err => {
  console.error('Failed to init SQLite:', err);
  process.exit(1);
});
