/* ============================================================
   Family Portfolio Manager — app.js
   ============================================================ */
'use strict';

// ── Storage helpers ──────────────────────────────────────────
const DB = {
  get: (k, def = []) => { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};

// ── State ────────────────────────────────────────────────────
let members  = DB.get('fdp_members', []);
let accounts = DB.get('fdp_accounts', []);
let deposits = DB.get('fdp_deposits', []);
let sortState = { col: 'maturityDate', dir: 'asc' };
let currentAlertDays = 30;
let confirmCallback = null;

// ── Utilities ────────────────────────────────────────────────
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function fmt(n) {
  if (n === undefined || n === null || isNaN(n)) return '—';
  return '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}
function fmtDate(d) { if (!d) return '—'; const dt = new Date(d); return dt.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }); }
function today() { return new Date().toISOString().slice(0, 10); }
function addMonths(dateStr, months) {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}
function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function diffDays(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}
function initials(name) {
  return name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
}
function save() {
  DB.set('fdp_members', members);
  DB.set('fdp_accounts', accounts);
  DB.set('fdp_deposits', deposits);
}

// ── FD Calculations ──────────────────────────────────────────
function calcMaturityDate(startDate, tenureYears, tenureMonths, tenureDays) {
  let d = new Date(startDate);
  d.setFullYear(d.getFullYear() + (tenureYears || 0));
  d.setMonth(d.getMonth() + (tenureMonths || 0));
  d.setDate(d.getDate() + (tenureDays || 0));
  return d.toISOString().slice(0, 10);
}

function calcMaturityAmount(principal, rate, compounding, startDate, maturityDate) {
  const p = Number(principal);
  const r = Number(rate) / 100;
  const days = diffDays(startDate, maturityDate);
  if (days <= 0 || !p || !r) return p;

  if (compounding === 'simple') {
    return p + p * r * (days / 365);
  }
  const n = compounding === 'monthly' ? 12 : compounding === 'quarterly' ? 4 : 1;
  const t = days / 365;
  return p * Math.pow(1 + r / n, n * t);
}

function tenureLabel(startDate, maturityDate) {
  const s = new Date(startDate), m = new Date(maturityDate);
  let yrs = m.getFullYear() - s.getFullYear();
  let mos = m.getMonth() - s.getMonth();
  let dys = m.getDate() - s.getDate();
  if (dys < 0) { mos--; dys += 30; }
  if (mos < 0) { yrs--; mos += 12; }
  const parts = [];
  if (yrs > 0) parts.push(yrs + 'yr');
  if (mos > 0) parts.push(mos + 'mo');
  if (dys > 0) parts.push(dys + 'd');
  return parts.join(' ') || '0d';
}

function fdStatus(maturityDate) {
  const days = diffDays(today(), maturityDate);
  if (days < 0) return 'matured';
  if (days <= 90) return 'soon';
  return 'active';
}

function enrichFD(fd) {
  const matDate = fd.maturityDate || calcMaturityDate(fd.startDate, fd.tenureYears, fd.tenureMonths, fd.tenureDays);
  const matAmt  = calcMaturityAmount(fd.principal, fd.rate, fd.compounding, fd.startDate, matDate);
  const daysLeft = diffDays(today(), matDate);
  const member = members.find(m => m.id === fd.memberId) || { name: 'Unknown' };
  const linkedAcct = fd.linkedAccountId ? accounts.find(a => a.id === fd.linkedAccountId) : null;
  return {
    ...fd,
    maturityDate: matDate,
    maturityAmount: matAmt,
    interest: matAmt - Number(fd.principal),
    daysLeft,
    status: fdStatus(matDate),
    memberName: member.name,
    tenure: tenureLabel(fd.startDate, matDate),
    linkedAcct,
    linkedAcctLabel: linkedAcct ? accountLabel(linkedAcct) : '—',
  };
}

function allEnriched() { return deposits.map(enrichFD); }

// ── Account helpers ──────────────────────────────────────────
function accountLabel(acct) {
  if (!acct) return '—';
  return `${acct.bank} · ${acct.acctType} · ****${String(acct.acctNumber).slice(-4)}`;
}
function memberAccounts(memberId) {
  return accounts.filter(a => a.memberId === memberId);
}

// ── Navigation ───────────────────────────────────────────────
function navTo(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  document.querySelector(`[data-page="${page}"]`).classList.add('active');
  if (page === 'dashboard') renderDashboard();
  if (page === 'family')    renderMemberList();
  if (page === 'accounts')  { populateAcctMemberDropdown(); renderAcctList(); }
  if (page === 'deposits')  { populateMemberDropdowns(); renderFDList(); }
  if (page === 'alerts')    renderAlerts(currentAlertDays);
}
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => navTo(btn.dataset.page));
});

// ── Alert Banner ─────────────────────────────────────────────
function updateAlertBanner() {
  const soon = allEnriched().filter(f => f.status === 'soon' || f.status === 'matured');
  const banner = document.getElementById('alertBanner');
  if (soon.length) {
    const matured = soon.filter(f => f.status === 'matured').length;
    const nearMat = soon.filter(f => f.status === 'soon').length;
    let msg = '';
    if (matured) msg += `${matured} FD(s) have already matured. `;
    if (nearMat) msg += `${nearMat} FD(s) maturing within 90 days.`;
    banner.textContent = '⚠ ' + msg + ' → Check Alerts tab.';
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

// ── Dashboard ────────────────────────────────────────────────
function renderDashboard() {
  const fds = allEnriched();

  // Summary cards
  const totalInvested = fds.reduce((s, f) => s + Number(f.principal), 0);
  const totalMaturity = fds.reduce((s, f) => s + f.maturityAmount, 0);
  const totalInterest = totalMaturity - totalInvested;
  const maturingSoon  = fds.filter(f => f.status === 'soon' || f.status === 'matured').length;

  document.getElementById('totalInvested').textContent = fmt(totalInvested);
  document.getElementById('totalMaturity').textContent = fmt(totalMaturity);
  document.getElementById('totalFDs').textContent      = fds.length + ' FDs';
  document.getElementById('totalInterest').textContent = 'Interest: ' + fmt(totalInterest);
  document.getElementById('maturingSoon').textContent  = maturingSoon;
  document.getElementById('totalMembers').textContent  = members.length;
  document.getElementById('activeMembersLabel').textContent = 'Active accounts';

  // Quick stats
  const activeFDs = fds.filter(f => f.status === 'active').length;
  const upcomingMaturities = fds.filter(f => f.status === 'soon').length;
  const statActiveFds = document.getElementById('stat-active-fds');
  const statUpcoming = document.getElementById('stat-upcoming');
  if (statActiveFds) statActiveFds.textContent = activeFDs;
  if (statUpcoming) statUpcoming.textContent = upcomingMaturities;

  // Navigation counts
  const navCountFd = document.getElementById('nav-count-fd');
  if (navCountFd) navCountFd.textContent = fds.length;
}

function populateFilterDropdowns() {
  const mSel = document.getElementById('dashMemberFilter');
  const bSel = document.getElementById('dashBankFilter');
  const curM = mSel.value, curB = bSel.value;

  mSel.innerHTML = '<option value="">All Members</option>';
  members.forEach(m => {
    const o = document.createElement('option');
    o.value = m.id; o.textContent = m.name;
    mSel.appendChild(o);
  });

  const banks = [...new Set(deposits.map(d => d.bank))].sort();
  bSel.innerHTML = '<option value="">All Banks</option>';
  banks.forEach(b => {
    const o = document.createElement('option');
    o.value = b; o.textContent = b;
    bSel.appendChild(o);
  });

  mSel.value = curM; bSel.value = curB;
}

function getFilteredFDs() {
  const memberVal = document.getElementById('dashMemberFilter').value;
  const bankVal   = document.getElementById('dashBankFilter').value;
  const statusVal = document.getElementById('dashStatusFilter').value;
  let fds = allEnriched();
  if (memberVal) fds = fds.filter(f => f.memberId === memberVal);
  if (bankVal)   fds = fds.filter(f => f.bank === bankVal);
  if (statusVal) fds = fds.filter(f => f.status === statusVal);
  return fds;
}

function renderDashTable(fds) {
  // Sort
  fds = [...fds].sort((a, b) => {
    let va = a[sortState.col], vb = b[sortState.col];
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return sortState.dir === 'asc' ? -1 : 1;
    if (va > vb) return sortState.dir === 'asc' ? 1 : -1;
    return 0;
  });

  // Update header classes
  document.querySelectorAll('#dashTable th[data-sort]').forEach(th => {
    th.classList.remove('asc', 'desc');
    if (th.dataset.sort === sortState.col) th.classList.add(sortState.dir);
  });

  const tbody = document.getElementById('dashTableBody');
  if (!fds.length) {
    tbody.innerHTML = '<tr><td colspan="12" class="empty-row">No FDs match the current filter.</td></tr>';
    return;
  }

  tbody.innerHTML = fds.map(f => `
    <tr>
      <td>${f.memberName}</td>
      <td>${f.bank}</td>
      <td style="font-size:.78rem;color:var(--gray-500)">${f.linkedAcct ? `<span title="${f.linkedAcctLabel}">****${String(f.linkedAcct.acctNumber).slice(-4)} (${f.linkedAcct.acctType})</span>` : '—'}</td>
      <td style="font-weight:600">${fmt(f.principal)}</td>
      <td>${Number(f.rate).toFixed(2)}%</td>
      <td>${fmtDate(f.startDate)}</td>
      <td>${fmtDate(f.maturityDate)}</td>
      <td>${f.daysLeft < 0 ? '<span style="color:var(--red)">' + Math.abs(f.daysLeft) + ' ago</span>' : f.daysLeft + ' days'}</td>
      <td style="font-weight:700;color:var(--green)">${fmt(f.maturityAmount)}</td>
      <td style="color:var(--blue)">${fmt(f.interest)}</td>
      <td><span class="badge badge-${f.status}">${f.status === 'soon' ? 'Soon' : f.status === 'matured' ? 'Matured' : 'Active'}</span></td>
      <td>
        <button class="btn-icon view" onclick="showFDDetail('${f.id}')">👁</button>
        <button class="btn-icon edit" onclick="editFD('${f.id}')">✏</button>
        <button class="btn-icon del"  onclick="deleteFDConfirm('${f.id}')">🗑</button>
      </td>
    </tr>`).join('');
}

// Sort on header click
document.querySelectorAll('#dashTable th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.sort;
    if (sortState.col === col) sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
    else { sortState.col = col; sortState.dir = 'asc'; }
    renderDashTable(getFilteredFDs());
  });
});

// Filter changes
['dashMemberFilter','dashBankFilter','dashStatusFilter'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => renderDashTable(getFilteredFDs()));
});

// ── Bank Chart ───────────────────────────────────────────────
function renderBankChart(fds) {
  const container = document.getElementById('bankChart');
  if (!fds.length) { container.innerHTML = '<p class="empty-text">No data yet.</p>'; return; }

  const bankMap = {};
  fds.forEach(f => {
    bankMap[f.bank] = (bankMap[f.bank] || 0) + Number(f.principal);
  });
  const sorted = Object.entries(bankMap).sort((a, b) => b[1] - a[1]);
  const max = sorted[0][1];
  const colors = ['#2563eb','#16a34a','#ea580c','#7c3aed','#d97706','#0891b2','#be185d'];

  container.innerHTML = sorted.map(([bank, amt], i) => `
    <div class="bank-bar-row">
      <div class="bank-bar-label" title="${bank}">${bank}</div>
      <div class="bank-bar-track">
        <div class="bank-bar-fill" style="width:${(amt/max*100).toFixed(1)}%;background:${colors[i % colors.length]}"></div>
      </div>
      <div class="bank-bar-val">${fmt(amt)}</div>
    </div>`).join('');
}

// ── Family Page ───────────────────────────────────────────────
function renderMemberList() {
  const list = document.getElementById('memberList');
  document.getElementById('memberCount').textContent = members.length;
  if (!members.length) {
    list.innerHTML = '<p class="empty-text">No members added yet.</p>';
    return;
  }
  list.innerHTML = members.map(m => {
    const fdCount   = deposits.filter(d => d.memberId === m.id).length;
    const acctCount = accounts.filter(a => a.memberId === m.id).length;
    return `
    <div class="member-card">
      <div class="member-avatar" style="background:${memberColor(m.id)}">${initials(m.name)}</div>
      <div class="member-info">
        <strong>${m.name}</strong>
        <span>${m.relation}${m.pan ? ' · ' + m.pan : ''}</span>
        <div class="member-fds">${fdCount} FD${fdCount !== 1 ? 's' : ''} · ${acctCount} account${acctCount !== 1 ? 's' : ''}</div>
      </div>
      <div class="member-actions">
        <button class="btn-icon" style="font-size:.75rem;padding:.25rem .45rem" onclick="navTo('accounts')" title="Manage accounts">🏛</button>
        <button class="btn-icon edit" onclick="editMember('${m.id}')">✏</button>
        <button class="btn-icon del"  onclick="deleteMemberConfirm('${m.id}')">🗑</button>
      </div>
    </div>`;
  }).join('');
}

const COLORS = ['#2563eb','#16a34a','#ea580c','#7c3aed','#d97706','#0891b2','#be185d','#0f766e'];
function memberColor(id) { const idx = members.findIndex(m => m.id === id); return COLORS[idx % COLORS.length]; }

// Family form submit
document.getElementById('familyForm').addEventListener('submit', e => {
  e.preventDefault();
  const id   = document.getElementById('memberId').value;
  const data = {
    name:     document.getElementById('memberName').value.trim(),
    relation: document.getElementById('memberRelation').value,
    pan:      document.getElementById('memberPan').value.trim().toUpperCase(),
    phone:    document.getElementById('memberPhone').value.trim(),
    email:    document.getElementById('memberEmail').value.trim(),
    notes:    document.getElementById('memberNotes').value.trim(),
  };
  if (id) {
    const idx = members.findIndex(m => m.id === id);
    members[idx] = { ...members[idx], ...data };
  } else {
    members.push({ id: uid(), ...data });
  }
  save();
  clearFamilyForm();
  renderMemberList();
  populateMemberDropdowns();
  updateAlertBanner();
});

document.getElementById('clearFamilyForm').addEventListener('click', clearFamilyForm);
function clearFamilyForm() {
  document.getElementById('familyForm').reset();
  document.getElementById('memberId').value = '';
  document.getElementById('familyFormTitle').textContent = 'Add Member';
}

function editMember(id) {
  const m = members.find(x => x.id === id);
  if (!m) return;
  document.getElementById('memberId').value    = m.id;
  document.getElementById('memberName').value  = m.name;
  document.getElementById('memberRelation').value = m.relation;
  document.getElementById('memberPan').value   = m.pan || '';
  document.getElementById('memberPhone').value = m.phone || '';
  document.getElementById('memberEmail').value = m.email || '';
  document.getElementById('memberNotes').value = m.notes || '';
  document.getElementById('familyFormTitle').textContent = 'Edit Member';
}

function deleteMemberConfirm(id) {
  const m = members.find(x => x.id === id);
  const fdCount   = deposits.filter(d => d.memberId === id).length;
  const acctCount = accounts.filter(a => a.memberId === id).length;
  showConfirm(
    `Delete "${m.name}"? This will also remove ${acctCount} account(s) and ${fdCount} FD(s). This cannot be undone.`,
    () => {
      members  = members.filter(x => x.id !== id);
      accounts = accounts.filter(a => a.memberId !== id);
      deposits = deposits.filter(d => d.memberId !== id);
      save(); renderMemberList(); populateMemberDropdowns(); updateAlertBanner();
    }
  );
}

// ── Accounts Page ─────────────────────────────────────────────
function populateAcctMemberDropdown() {
  // form dropdown
  const sel = document.getElementById('acctMember');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Select member...</option>';
  members.forEach(m => {
    const o = document.createElement('option');
    o.value = m.id; o.textContent = m.name;
    sel.appendChild(o);
  });
  sel.value = cur;

  // filter dropdown
  const fsel = document.getElementById('acctMemberFilter');
  const fcur = fsel.value;
  fsel.innerHTML = '<option value="">All Members</option>';
  members.forEach(m => {
    const o = document.createElement('option');
    o.value = m.id; o.textContent = m.name;
    fsel.appendChild(o);
  });
  fsel.value = fcur;
}

function renderAcctList(filterMemberId = '') {
  const list = document.getElementById('acctList');
  document.getElementById('acctCount').textContent = accounts.length;

  let accts = filterMemberId
    ? accounts.filter(a => a.memberId === filterMemberId)
    : accounts;

  if (!accts.length) {
    list.innerHTML = '<p class="empty-text">' + (accounts.length ? 'No accounts for this member.' : 'No accounts added yet.') + '</p>';
    return;
  }

  // Group by member
  const grouped = {};
  accts.forEach(a => {
    if (!grouped[a.memberId]) grouped[a.memberId] = [];
    grouped[a.memberId].push(a);
  });

  list.innerHTML = Object.entries(grouped).map(([memberId, acctList]) => {
    const member = members.find(m => m.id === memberId) || { name: 'Unknown' };
    const cards = acctList.map(a => {
      const fdCount = deposits.filter(d => d.linkedAccountId === a.id).length;
      return `
        <div class="acct-card${a.isPrimary ? ' primary' : ''}">
          <div class="acct-card-header">
            <div>
              <div class="acct-card-title">
                ${a.isPrimary ? '<span class="badge-primary-tag">★ Primary</span> ' : ''}${a.bank}
              </div>
              <div class="acct-card-sub">${a.acctType} A/C · ****${String(a.acctNumber).slice(-4)}</div>
            </div>
            <div style="display:flex;gap:.3rem;align-items:flex-start">
              <button class="btn-icon edit" onclick="editAcct('${a.id}')">✏</button>
              <button class="btn-icon del"  onclick="deleteAcctConfirm('${a.id}')">🗑</button>
            </div>
          </div>
          <div class="acct-card-meta">
            ${a.acctHolderName ? `<span>👤 ${a.acctHolderName}</span>` : ''}
            ${a.branch ? `<span>📍 ${a.branch}</span>` : ''}
            ${a.ifsc ? `<span>🔢 ${a.ifsc}</span>` : ''}
            ${a.openDate ? `<span>📅 Opened: ${fmtDate(a.openDate)}</span>` : ''}
            <span>💰 ${fdCount} FD${fdCount !== 1 ? 's' : ''} linked</span>
          </div>
          ${a.notes ? `<div class="acct-notes">${a.notes}</div>` : ''}
        </div>`;
    }).join('');

    return `
      <div class="acct-member-group">
        <div class="acct-member-header">
          <div class="member-avatar" style="background:${memberColor(memberId)};width:28px;height:28px;font-size:.75rem">${initials(member.name)}</div>
          <strong>${member.name}</strong>
          <span class="acct-member-count">${acctList.length} account${acctList.length !== 1 ? 's' : ''}</span>
        </div>
        ${cards}
      </div>`;
  }).join('');
}

document.getElementById('acctMemberFilter').addEventListener('change', function () {
  renderAcctList(this.value);
});

// Account form submit
document.getElementById('acctForm').addEventListener('submit', e => {
  e.preventDefault();
  const id = document.getElementById('acctId').value;
  const memberId = document.getElementById('acctMember').value;
  const isPrimary = document.getElementById('acctPrimary').checked;

  // If marking primary, unmark existing primaries for same member
  if (isPrimary) {
    accounts.forEach(a => { if (a.memberId === memberId) a.isPrimary = false; });
  }

  const data = {
    memberId,
    bank:          document.getElementById('acctBank').value.trim(),
    acctNumber:    document.getElementById('acctNumber').value.trim(),
    acctType:      document.getElementById('acctType').value,
    ifsc:          document.getElementById('acctIfsc').value.trim().toUpperCase(),
    branch:        document.getElementById('acctBranch').value.trim(),
    acctHolderName:document.getElementById('acctHolderName').value.trim(),
    openDate:      document.getElementById('acctOpenDate').value,
    isPrimary,
    notes:         document.getElementById('acctNotes').value.trim(),
  };

  if (id) {
    const idx = accounts.findIndex(a => a.id === id);
    accounts[idx] = { ...accounts[idx], ...data };
  } else {
    accounts.push({ id: uid(), ...data });
  }
  save();
  clearAcctForm();
  renderAcctList(document.getElementById('acctMemberFilter').value);
  populateMemberDropdowns(); // refresh FD form linked account dropdown
});

document.getElementById('clearAcctForm').addEventListener('click', clearAcctForm);
function clearAcctForm() {
  document.getElementById('acctForm').reset();
  document.getElementById('acctId').value = '';
  document.getElementById('acctFormTitle').textContent = 'Add Bank Account';
}

function editAcct(id) {
  const a = accounts.find(x => x.id === id);
  if (!a) return;
  document.getElementById('acctId').value          = a.id;
  document.getElementById('acctMember').value      = a.memberId;
  document.getElementById('acctBank').value        = a.bank;
  document.getElementById('acctNumber').value      = a.acctNumber;
  document.getElementById('acctType').value        = a.acctType;
  document.getElementById('acctIfsc').value        = a.ifsc || '';
  document.getElementById('acctBranch').value      = a.branch || '';
  document.getElementById('acctHolderName').value  = a.acctHolderName || '';
  document.getElementById('acctOpenDate').value    = a.openDate || '';
  document.getElementById('acctPrimary').checked   = a.isPrimary || false;
  document.getElementById('acctNotes').value       = a.notes || '';
  document.getElementById('acctFormTitle').textContent = 'Edit Bank Account';
  document.querySelector('.form-card').scrollIntoView({ behavior: 'smooth' });
}

function deleteAcctConfirm(id) {
  const a = accounts.find(x => x.id === id);
  const fdCount = deposits.filter(d => d.linkedAccountId === id).length;
  showConfirm(
    `Delete "${a.bank}" ${a.acctType} account (****${String(a.acctNumber).slice(-4)})? ${fdCount} FD(s) will lose their account link. Cannot be undone.`,
    () => {
      accounts = accounts.filter(x => x.id !== id);
      // Clear the linked account from FDs but don't delete the FDs
      deposits.forEach(d => { if (d.linkedAccountId === id) d.linkedAccountId = ''; });
      save();
      renderAcctList(document.getElementById('acctMemberFilter').value);
      document.getElementById('acctCount').textContent = accounts.length;
    }
  );
}

// ── Deposits Page ─────────────────────────────────────────────
function populateMemberDropdowns() {
  ['fdMember', 'fdNominee'].forEach(selId => {
    const sel = document.getElementById(selId);
    const cur = sel.value;
    sel.innerHTML = selId === 'fdMember'
      ? '<option value="">Select member...</option>'
      : '<option value="">None / Not set</option>';
    members.forEach(m => {
      const o = document.createElement('option');
      o.value = m.id; o.textContent = m.name;
      sel.appendChild(o);
    });
    sel.value = cur;
  });
}

function populateLinkedAccountDropdown(memberId, selectedId = '') {
  const sel = document.getElementById('fdLinkedAccount');
  const accts = memberId ? memberAccounts(memberId) : [];
  if (!accts.length) {
    sel.innerHTML = memberId
      ? '<option value="">No accounts — add in Accounts tab</option>'
      : '<option value="">Select member first...</option>';
    return;
  }
  sel.innerHTML = '<option value="">Not linked to an account</option>';
  accts.forEach(a => {
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = `${a.isPrimary ? '★ ' : ''}${a.bank} · ${a.acctType} · ****${String(a.acctNumber).slice(-4)}`;
    if (a.isPrimary && !selectedId) o.selected = true;
    sel.appendChild(o);
  });
  if (selectedId) sel.value = selectedId;
}

// When member changes on FD form, refresh linked account dropdown
document.getElementById('fdMember').addEventListener('change', function () {
  populateLinkedAccountDropdown(this.value);
});

function renderFDList(filter = '') {
  const list = document.getElementById('fdList');
  const fds  = allEnriched().filter(f =>
    !filter || f.bank.toLowerCase().includes(filter) ||
    f.memberName.toLowerCase().includes(filter) ||
    (f.accountNo || '').toLowerCase().includes(filter)
  );
  document.getElementById('fdCount').textContent = deposits.length;
  if (!fds.length) {
    list.innerHTML = '<p class="empty-text">' + (deposits.length ? 'No matches.' : 'No FDs added yet.') + '</p>';
    return;
  }
  list.innerHTML = fds.map(f => `
    <div class="fd-card ${f.status}">
      <div class="fd-card-header">
        <div>
          <div class="fd-card-title">${f.bank}${f.accountNo ? ' · ' + f.accountNo : ''}</div>
          <div class="fd-card-sub">${f.memberName} · ${f.tenure} · ${Number(f.rate).toFixed(2)}% p.a.</div>
        </div>
        <div style="display:flex;gap:.3rem;align-items:flex-start">
          <span class="badge badge-${f.status}">${f.status === 'soon' ? 'Soon' : f.status === 'matured' ? 'Matured' : 'Active'}</span>
          <button class="btn-icon view" onclick="showFDDetail('${f.id}')">👁</button>
          <button class="btn-icon edit" onclick="editFD('${f.id}')">✏</button>
          <button class="btn-icon del"  onclick="deleteFDConfirm('${f.id}')">🗑</button>
        </div>
      </div>
      <div class="fd-card-meta">
        <span>💵 ${fmt(f.principal)}</span>
        <span>🏦 Matures: ${fmtDate(f.maturityDate)}</span>
        <span>📈 ${fmt(f.maturityAmount)}</span>
        <span>${f.daysLeft < 0 ? '⚠ Matured ' + Math.abs(f.daysLeft) + 'd ago' : '⏳ ' + f.daysLeft + ' days left'}</span>
      </div>
    </div>`).join('');
}

document.getElementById('fdSearch').addEventListener('input', function() {
  renderFDList(this.value.trim().toLowerCase());
});

// FD Form — live preview
function updateFDPreview() {
  const startDate   = document.getElementById('fdStartDate').value;
  const principal   = document.getElementById('fdPrincipal').value;
  const rate        = document.getElementById('fdRate').value;
  const compounding = document.getElementById('fdCompounding').value;
  const manualMat   = document.getElementById('fdMaturityDate').value;
  const yrs = parseInt(document.getElementById('fdTenureYears').value) || 0;
  const mos = parseInt(document.getElementById('fdTenureMonths').value) || 0;
  const dys = parseInt(document.getElementById('fdTenureDays').value)  || 0;

  if (!startDate || !principal || !rate) return;

  let matDate = manualMat;
  if (!matDate && (yrs || mos || dys)) matDate = calcMaturityDate(startDate, yrs, mos, dys);
  if (!matDate) return;

  const matAmt  = calcMaturityAmount(principal, rate, compounding, startDate, matDate);
  const interest = matAmt - Number(principal);

  document.getElementById('previewMaturityDate').textContent = fmtDate(matDate);
  document.getElementById('previewTenure').textContent       = tenureLabel(startDate, matDate);
  document.getElementById('previewMaturityAmt').textContent  = fmt(matAmt);
  document.getElementById('previewInterest').textContent     = fmt(interest);
}

['fdStartDate','fdPrincipal','fdRate','fdCompounding','fdMaturityDate',
 'fdTenureYears','fdTenureMonths','fdTenureDays'].forEach(id => {
  document.getElementById(id).addEventListener('input', updateFDPreview);
  document.getElementById(id).addEventListener('change', updateFDPreview);
});

// FD Form submit
document.getElementById('fdForm').addEventListener('submit', e => {
  e.preventDefault();
  const id = document.getElementById('fdId').value;
  const startDate = document.getElementById('fdStartDate').value;
  const manualMat = document.getElementById('fdMaturityDate').value;
  const yrs = parseInt(document.getElementById('fdTenureYears').value) || 0;
  const mos = parseInt(document.getElementById('fdTenureMonths').value) || 0;
  const dys = parseInt(document.getElementById('fdTenureDays').value)  || 0;

  const data = {
    memberId:         document.getElementById('fdMember').value,
    linkedAccountId:  document.getElementById('fdLinkedAccount').value,
    bank:             document.getElementById('fdBank').value.trim(),
    accountNo:        document.getElementById('fdAccountNo').value.trim(),
    principal:   parseFloat(document.getElementById('fdPrincipal').value),
    rate:        parseFloat(document.getElementById('fdRate').value),
    compounding: document.getElementById('fdCompounding').value,
    startDate,
    tenureYears: yrs, tenureMonths: mos, tenureDays: dys,
    maturityDate: manualMat || (yrs || mos || dys ? calcMaturityDate(startDate, yrs, mos, dys) : ''),
    payout:      document.getElementById('fdPayout').value,
    nomineeId:   document.getElementById('fdNominee').value,
    notes:       document.getElementById('fdNotes').value.trim(),
  };
  if (!data.maturityDate) { alert('Please enter tenure or maturity date.'); return; }

  if (id) {
    const idx = deposits.findIndex(d => d.id === id);
    deposits[idx] = { ...deposits[idx], ...data };
  } else {
    deposits.push({ id: uid(), ...data });
  }
  save(); clearFDForm(); renderFDList(); updateAlertBanner();
});

document.getElementById('clearFdForm').addEventListener('click', clearFDForm);
function clearFDForm() {
  document.getElementById('fdForm').reset();
  document.getElementById('fdId').value = '';
  document.getElementById('fdFormTitle').textContent = 'Add Fixed Deposit';
  document.getElementById('fdTenureYears').value = 0;
  document.getElementById('fdTenureMonths').value = 0;
  document.getElementById('fdTenureDays').value = 0;
  document.getElementById('previewMaturityDate').textContent = '—';
  document.getElementById('previewTenure').textContent = '—';
  document.getElementById('previewMaturityAmt').textContent = '—';
  document.getElementById('previewInterest').textContent = '—';
  populateLinkedAccountDropdown('');
}

function editFD(id) {
  navTo('deposits');
  const f = deposits.find(d => d.id === id);
  if (!f) return;
  document.getElementById('fdId').value          = f.id;
  document.getElementById('fdMember').value      = f.memberId;
  populateLinkedAccountDropdown(f.memberId, f.linkedAccountId || '');
  document.getElementById('fdBank').value        = f.bank;
  document.getElementById('fdAccountNo').value   = f.accountNo || '';
  document.getElementById('fdPrincipal').value   = f.principal;
  document.getElementById('fdRate').value        = f.rate;
  document.getElementById('fdCompounding').value = f.compounding;
  document.getElementById('fdStartDate').value   = f.startDate;
  document.getElementById('fdTenureYears').value = f.tenureYears || 0;
  document.getElementById('fdTenureMonths').value = f.tenureMonths || 0;
  document.getElementById('fdTenureDays').value  = f.tenureDays || 0;
  document.getElementById('fdMaturityDate').value = f.maturityDate || '';
  document.getElementById('fdPayout').value      = f.payout;
  document.getElementById('fdNominee').value     = f.nomineeId || '';
  document.getElementById('fdNotes').value       = f.notes || '';
  document.getElementById('fdFormTitle').textContent = 'Edit Fixed Deposit';
  updateFDPreview();
  document.querySelector('.form-card').scrollIntoView({ behavior: 'smooth' });
}

function deleteFDConfirm(id) {
  const f = enrichFD(deposits.find(d => d.id === id));
  showConfirm(
    `Delete FD at "${f.bank}" (${fmt(f.principal)}) for ${f.memberName}? This cannot be undone.`,
    () => {
      deposits = deposits.filter(d => d.id !== id);
      save(); renderFDList(); renderDashboard(); updateAlertBanner();
    }
  );
}

// ── Alerts Page ───────────────────────────────────────────────
document.querySelectorAll('.filter-chip').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.filter-chip').forEach(b => b.classList.remove('active'));
    this.classList.add('active');
    currentAlertDays = parseInt(this.dataset.days);
    renderAlerts(currentAlertDays);
  });
});

function renderAlerts(days) {
  const list = document.getElementById('alertsList');
  let fds = allEnriched();

  if (days === 0) {
    fds = fds.filter(f => f.status === 'matured').sort((a, b) => a.daysLeft - b.daysLeft);
  } else {
    fds = fds.filter(f => f.daysLeft >= 0 && f.daysLeft <= days).sort((a, b) => a.daysLeft - b.daysLeft);
  }

  if (!fds.length) {
    list.innerHTML = `<div class="section-card"><p class="empty-text">No FDs in this category. 🎉</p></div>`;
    return;
  }

  list.innerHTML = fds.map(f => {
    const urgency = f.status === 'matured' ? 'matured'
                  : f.daysLeft <= 15 ? 'urgent'
                  : f.daysLeft <= 60 ? 'warning' : 'info';
    const icon = f.status === 'matured' ? '🔴' : f.daysLeft <= 15 ? '🚨' : f.daysLeft <= 60 ? '⚠️' : '🔵';
    const daysText = f.status === 'matured'
      ? `Matured ${Math.abs(f.daysLeft)} days ago on ${fmtDate(f.maturityDate)}`
      : `Matures in ${f.daysLeft} days on ${fmtDate(f.maturityDate)}`;
    const nominee = f.nomineeId ? (members.find(m => m.id === f.nomineeId) || {}).name : null;
    return `
      <div class="alert-card ${urgency}">
        <div class="alert-icon">${icon}</div>
        <div class="alert-content">
          <strong>${f.bank}${f.accountNo ? ' (' + f.accountNo + ')' : ''} — ${f.memberName}</strong>
          <p>${daysText} · ₹${Number(f.principal).toLocaleString('en-IN')} principal · ${Number(f.rate).toFixed(2)}% p.a. · ${f.compounding}</p>
          <p style="margin-top:.2rem">Payout: ${f.payout}${nominee ? ' · Nominee: ' + nominee : ''}</p>
          ${f.notes ? `<p style="color:var(--gray-400);margin-top:.2rem;font-style:italic">${f.notes}</p>` : ''}
        </div>
        <div class="alert-amount">
          ${fmt(f.maturityAmount)}
          <small>Maturity Value</small>
          <small style="color:var(--blue)">+${fmt(f.interest)} interest</small>
        </div>
      </div>`;
  }).join('');
}

// ── FD Detail Modal ───────────────────────────────────────────
function showFDDetail(id) {
  const f = enrichFD(deposits.find(d => d.id === id));
  const nominee = f.nomineeId ? (members.find(m => m.id === f.nomineeId) || {}).name : 'Not set';
  const totalDays = diffDays(f.startDate, f.maturityDate);
  const elapsedDays = Math.max(0, diffDays(f.startDate, today()));
  const pct = totalDays > 0 ? Math.min(100, Math.round(elapsedDays / totalDays * 100)) : 0;

  document.getElementById('modalTitle').textContent = `${f.bank} — FD Details`;
  document.getElementById('modalBody').innerHTML = `
    <div class="detail-grid">
      <div class="detail-highlight">
        <div><label>Maturity Amount</label><div class="big">${fmt(f.maturityAmount)}</div></div>
        <div style="text-align:right"><label>Interest Earned</label><div class="big" style="color:var(--blue)">${fmt(f.interest)}</div></div>
      </div>
      <div class="detail-item"><label>Account Holder</label><span>${f.memberName}</span></div>
      <div class="detail-item"><label>Bank</label><span>${f.bank}</span></div>
      <div class="detail-item"><label>Linked Account</label><span>${f.linkedAcctLabel}</span></div>
      <div class="detail-item"><label>FD Number</label><span>${f.accountNo || '—'}</span></div>
      <div class="detail-item"><label>Principal</label><span>${fmt(f.principal)}</span></div>
      <div class="detail-item"><label>Rate</label><span>${Number(f.rate).toFixed(2)}% p.a.</span></div>
      <div class="detail-item"><label>Compounding</label><span>${f.compounding}</span></div>
      <div class="detail-item"><label>Start Date</label><span>${fmtDate(f.startDate)}</span></div>
      <div class="detail-item"><label>Maturity Date</label><span>${fmtDate(f.maturityDate)}</span></div>
      <div class="detail-item"><label>Tenure</label><span>${f.tenure}</span></div>
      <div class="detail-item"><label>Days Left</label><span>${f.daysLeft < 0 ? 'Matured ' + Math.abs(f.daysLeft) + 'd ago' : f.daysLeft + ' days'}</span></div>
      <div class="detail-item"><label>Payout Type</label><span>${f.payout}</span></div>
      <div class="detail-item"><label>Nominee</label><span>${nominee}</span></div>
      ${f.notes ? `<div class="detail-item" style="grid-column:1/-1"><label>Notes</label><span>${f.notes}</span></div>` : ''}
    </div>
    <div class="progress-section">
      <label>Tenure Progress — ${pct}% elapsed (${elapsedDays} of ${totalDays} days)</label>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
    </div>`;
  openModal();
}

function openModal()  { document.getElementById('modal').classList.remove('hidden'); }
function closeModal() { document.getElementById('modal').classList.add('hidden'); }
document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

// ── Confirm Dialog ────────────────────────────────────────────
function showConfirm(msg, cb) {
  document.getElementById('confirmMsg').textContent = msg;
  confirmCallback = cb;
  document.getElementById('confirmDialog').classList.remove('hidden');
}
document.getElementById('confirmYes').addEventListener('click', () => {
  if (confirmCallback) confirmCallback();
  confirmCallback = null;
  document.getElementById('confirmDialog').classList.add('hidden');
});
document.getElementById('confirmNo').addEventListener('click', () => {
  confirmCallback = null;
  document.getElementById('confirmDialog').classList.add('hidden');
});
document.getElementById('confirmDialog').addEventListener('click', e => {
  if (e.target.id === 'confirmDialog') {
    confirmCallback = null;
    document.getElementById('confirmDialog').classList.add('hidden');
  }
});

// ── Export CSV ────────────────────────────────────────────────
document.getElementById('exportBtn').addEventListener('click', () => {
  const fds = allEnriched();
  if (!fds.length) { alert('No FDs to export.'); return; }

  const header = ['Member','Relation','Bank','FD Number','Principal','Rate %',
    'Compounding','Start Date','Maturity Date','Tenure','Maturity Amount','Interest','Status','Payout','Nominee','Notes'];

  const rows = fds.map(f => {
    const member  = members.find(m => m.id === f.memberId) || {};
    const nominee = f.nomineeId ? (members.find(m => m.id === f.nomineeId) || {}).name : '';
    return [
      f.memberName, member.relation || '', f.bank, f.accountNo || '',
      f.principal, f.rate, f.compounding, f.startDate, f.maturityDate,
      f.tenure, f.maturityAmount.toFixed(2), f.interest.toFixed(2),
      f.status, f.payout, nominee, f.notes || '',
    ].map(v => `"${String(v).replace(/"/g, '""')}"`);
  });

  const csv = [header.map(h => `"${h}"`), ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = 'FD_Portfolio_' + today() + '.csv';
  a.click();
  URL.revokeObjectURL(url);
});

// ── Seed Demo Data ────────────────────────────────────────────
function seedDemo() {
  if (members.length || deposits.length || accounts.length) return;

  members = [
    { id: 'm1', name: 'Rajesh Kumar',  relation: 'Self',   pan: 'ABCDE1234F', phone: '9876543210', email: 'rajesh@email.com', notes: '' },
    { id: 'm2', name: 'Sunita Kumar',  relation: 'Spouse', pan: 'PQRST5678G', phone: '9876543211', email: '',                  notes: '' },
    { id: 'm3', name: 'Ravi Kumar',    relation: 'Father', pan: '',            phone: '',           email: '',                  notes: 'Senior citizen rates' },
  ];

  accounts = [
    { id: 'a1', memberId:'m1', bank:'SBI',        acctNumber:'10012345678',  acctType:'Savings', ifsc:'SBIN0001234', branch:'Anna Nagar, Chennai', acctHolderName:'Rajesh Kumar', openDate:'2015-06-10', isPrimary:true,  notes:'Salary & primary account' },
    { id: 'a2', memberId:'m1', bank:'HDFC Bank',  acctNumber:'50100987654',  acctType:'Savings', ifsc:'HDFC0001122', branch:'T. Nagar, Chennai',   acctHolderName:'Rajesh Kumar', openDate:'2018-03-15', isPrimary:false, notes:'FD and investments' },
    { id: 'a3', memberId:'m1', bank:'Axis Bank',  acctNumber:'91801234567',  acctType:'Savings', ifsc:'UTIB0001234', branch:'Velachery, Chennai',  acctHolderName:'Rajesh Kumar', openDate:'2020-09-01', isPrimary:false, notes:'' },
    { id: 'a4', memberId:'m2', bank:'ICICI Bank', acctNumber:'002601234567', acctType:'Savings', ifsc:'ICIC0000260', branch:'Anna Nagar, Chennai', acctHolderName:'Sunita Kumar', openDate:'2017-08-20', isPrimary:true,  notes:'Joint holder: Rajesh Kumar' },
    { id: 'a5', memberId:'m3', bank:'Post Office',acctNumber:'PO9988776655', acctType:'Savings', ifsc:'',           branch:'Mylapore HO',         acctHolderName:'Ravi Kumar',   openDate:'2010-04-05', isPrimary:true,  notes:'Senior citizen account' },
  ];

  const y = new Date().getFullYear();
  deposits = [
    { id: 'd1', memberId:'m1', linkedAccountId:'a1', bank:'SBI',        accountNo:'FD001234', principal:200000, rate:7.10, compounding:'quarterly', startDate:`${y-1}-04-01`, tenureYears:2, tenureMonths:0, tenureDays:0, maturityDate:`${y+1}-04-01`, payout:'cumulative', nomineeId:'m2', notes:'Linked to savings a/c' },
    { id: 'd2', memberId:'m1', linkedAccountId:'a2', bank:'HDFC Bank',  accountNo:'HD009876', principal:500000, rate:7.40, compounding:'quarterly', startDate:`${y-1}-07-15`, tenureYears:1, tenureMonths:6, tenureDays:0, maturityDate:`${y+1}-01-15`, payout:'cumulative', nomineeId:'m2', notes:'' },
    { id: 'd3', memberId:'m2', linkedAccountId:'a4', bank:'ICICI Bank', accountNo:'IC005432', principal:150000, rate:7.25, compounding:'monthly',   startDate:`${y}-01-01`,   tenureYears:1, tenureMonths:0, tenureDays:0, maturityDate:`${y+1}-01-01`, payout:'cumulative', nomineeId:'m1', notes:'Women special scheme' },
    { id: 'd4', memberId:'m3', linkedAccountId:'a5', bank:'Post Office (TD)', accountNo:'PO112233', principal:300000, rate:7.50, compounding:'annually', startDate:`${y-2}-06-01`, tenureYears:5, tenureMonths:0, tenureDays:0, maturityDate:`${y+3}-06-01`, payout:'cumulative', nomineeId:'m1', notes:'Senior citizen deposit' },
    { id: 'd5', memberId:'m1', linkedAccountId:'a3', bank:'Axis Bank',  accountNo:'AX334455', principal:100000, rate:6.75, compounding:'quarterly', startDate:`${y-1}-09-01`, tenureYears:0, tenureMonths:11, tenureDays:0, maturityDate:`${y}-08-01`, payout:'cumulative', nomineeId:'', notes:'Short term' },
  ];
  save();
}

// ── Init ──────────────────────────────────────────────────────
seedDemo();
navTo('dashboard');
updateAlertBanner();
