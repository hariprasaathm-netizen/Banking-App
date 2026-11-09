/* ============================================================
   Family Portfolio Manager — app.js  (SQLite / REST API version)
   ============================================================ */
'use strict';

// ── In-memory state (loaded from server on boot) ─────────────
let members  = [];
let accounts = [];
let deposits = [];
let pfAccounts   = [];
let npsAccounts  = [];
let sipFunds     = [];
let otherRecords = [];
let goals = [];
let sortState        = { col: 'maturityDate', dir: 'asc' };
let currentAlertDays = 30;
let confirmCallback  = null;

// ── API helpers ───────────────────────────────────────────────
const API = {
  async get(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async post(url, body) {
    const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async put(url, body) {
    const r = await fetch(url, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async del(url) {
    const r = await fetch(url, { method:'DELETE' });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
};

// ── Loading overlay ───────────────────────────────────────────
function showLoading(msg = 'Saving…') {
  document.getElementById('loadingOverlay').classList.remove('hidden');
  document.getElementById('loadingMsg').textContent = msg;
}
function hideLoading() {
  document.getElementById('loadingOverlay').classList.add('hidden');
}
function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast toast-' + type;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 3000);
}

// ── Pure utilities (no I/O) ───────────────────────────────────
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

function fmt(n) {
  if (n === undefined || n === null || isNaN(n)) return '—';
  return '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
}
function today() { return new Date().toISOString().slice(0, 10); }
function diffDays(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }
function initials(name) { return name.split(' ').slice(0,2).map(w => w[0]).join('').toUpperCase(); }

function calcMaturityDate(startDate, yrs, mos, dys) {
  const d = new Date(startDate);
  d.setFullYear(d.getFullYear() + (yrs||0));
  d.setMonth(d.getMonth() + (mos||0));
  d.setDate(d.getDate() + (dys||0));
  return d.toISOString().slice(0,10);
}
function calcMaturityAmount(principal, rate, compounding, startDate, maturityDate) {
  const p = Number(principal), r = Number(rate)/100;
  const days = diffDays(startDate, maturityDate);
  if (days <= 0 || !p || !r) return p;
  if (compounding === 'simple') return p + p * r * (days/365);
  const n = compounding === 'monthly' ? 12 : compounding === 'quarterly' ? 4 : 1;
  return p * Math.pow(1 + r/n, n * days/365);
}
function tenureLabel(startDate, maturityDate) {
  const s = new Date(startDate), m = new Date(maturityDate);
  let yrs = m.getFullYear()-s.getFullYear(), mos = m.getMonth()-s.getMonth(), dys = m.getDate()-s.getDate();
  if (dys < 0) { mos--; dys += 30; }
  if (mos < 0) { yrs--; mos += 12; }
  const p = [];
  if (yrs>0) p.push(yrs+'yr'); if (mos>0) p.push(mos+'mo'); if (dys>0) p.push(dys+'d');
  return p.join(' ') || '0d';
}
function fdStatus(maturityDate) {
  const d = diffDays(today(), maturityDate);
  return d < 0 ? 'matured' : d <= 90 ? 'soon' : 'active';
}
function enrichFD(fd) {
  const matDate  = fd.maturityDate;
  const matAmt   = calcMaturityAmount(fd.principal, fd.rate, fd.compounding, fd.startDate, matDate);
  const daysLeft = diffDays(today(), matDate);
  const member   = members.find(m => m.id === fd.memberId) || { name:'Unknown' };
  const linkedAcct = fd.linkedAccountId ? accounts.find(a => a.id === fd.linkedAccountId) : null;
  return {
    ...fd, maturityAmount: matAmt, interest: matAmt - Number(fd.principal),
    daysLeft, status: fdStatus(matDate), memberName: member.name,
    tenure: tenureLabel(fd.startDate, matDate),
    linkedAcct, linkedAcctLabel: linkedAcct ? accountLabel(linkedAcct) : '—',
  };
}
function allEnriched() { return deposits.map(enrichFD); }

function accountLabel(a) {
  if (!a) return '—';
  return `${a.bank} · ${a.acctType} · ****${String(a.acctNumber).slice(-4)}`;
}
function memberAccounts(memberId) { return accounts.filter(a => a.memberId === memberId); }

const COLORS = ['#2563eb','#16a34a','#ea580c','#7c3aed','#d97706','#0891b2','#be185d','#0f766e'];
function memberColor(id) { const i = members.findIndex(m => m.id===id); return COLORS[i % COLORS.length]; }

// ── Navigation ────────────────────────────────────────────────
function navTo(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  document.querySelector(`[data-page="${page}"]`).classList.add('active');
  if (page === 'dashboard') renderDashboard();
  if (page === 'family')    renderMemberList();
  if (page === 'accounts')  { populateAcctMemberDropdown(); renderAcctList(); }
  if (page === 'deposits')  { populateMemberDropdowns(); renderFDList(); }
  if (page === 'pf')        { populateInvMemberDropdowns(); renderPFList(); }
  if (page === 'nps')       { populateInvMemberDropdowns(); renderNPSList(); }
  if (page === 'sip')       { populateInvMemberDropdowns(); renderSIPList(); }
  if (page === 'others')    { populateOtherMemberDropdown(); renderOthersList(); }
  if (page === 'goals')     updateGoalViews();
  if (page === 'alerts')    renderAlerts(currentAlertDays);
  if (page === 'history')   renderHistory();
}
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => navTo(btn.dataset.page));
});

// ── Dashboard split cards toggle ────────────────────────────
function initSplitToggles() {
  document.querySelectorAll('.split-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const body = document.getElementById(btn.dataset.target);
      if (!body) return;
      const collapsed = body.classList.toggle('collapsed');
      btn.textContent = collapsed ? '+' : '−';
      btn.setAttribute('aria-expanded', String(!collapsed));
    });
  });
}

// ── Alert Banner ──────────────────────────────────────────────
function updateAlertBanner() {
  const soon   = allEnriched().filter(f => f.status==='soon' || f.status==='matured');
  const banner = document.getElementById('alertBanner');
  if (soon.length) {
    const matured = soon.filter(f=>f.status==='matured').length;
    const near    = soon.filter(f=>f.status==='soon').length;
    let msg = '';
    if (matured) msg += `${matured} FD(s) already matured. `;
    if (near)    msg += `${near} FD(s) maturing within 90 days.`;
    banner.textContent = '⚠ ' + msg + ' → Check Alerts tab.';
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

// ── Dashboard ─────────────────────────────────────────────────
function getPortfolioCategoryValues() {
  const fds = allEnriched();
  const fdInvested = fds.reduce((s, f) => s + Number(f.principal), 0);
  const fdCurrent = fds.reduce((s, f) => s + f.maturityAmount, 0);
  const pfCurrent = pfAccounts.reduce((s, p) => s + Number(p.currentBalance), 0);
  const npsInvested = npsAccounts.reduce((s, n) => s + Number(n.totalInvested), 0);
  const npsCurrent = npsAccounts.reduce((s, n) => s + Number(n.currentValue), 0);
  const sipInvested = sipFunds.reduce((s, f) => s + Number(f.totalInvested), 0);
  const sipCurrent = sipFunds.reduce((s, f) => s + Number(f.currentValue), 0);
  const otherCurrent = otherRecords.reduce((s, o) => s + Number(o.amount), 0);
  return {
    fdInvested,
    fdCurrent,
    pfCurrent,
    npsInvested,
    npsCurrent,
    sipInvested,
    sipCurrent,
    otherCurrent,
    otherInvested: otherCurrent,
  };
}

function renderOverallCategoryBreakdown(values) {
  const el = document.getElementById('overallCategoryBreakdown');
  if (!el) return;
  const total = values.fdCurrent + values.pfCurrent + values.npsCurrent + values.sipCurrent + values.otherCurrent;
  el.innerHTML = `
    <div class="ocb-heading">Portfolio split by category</div>
    <div class="ocb-grid">
      <div class="ocb-chip"><span>FD</span><strong>${fmt(values.fdCurrent)}</strong></div>
      <div class="ocb-chip"><span>PF</span><strong>${fmt(values.pfCurrent)}</strong></div>
      <div class="ocb-chip"><span>NPS</span><strong>${fmt(values.npsCurrent)}</strong></div>
      <div class="ocb-chip"><span>SIP</span><strong>${fmt(values.sipCurrent)}</strong></div>
      <div class="ocb-chip"><span>Others</span><strong>${fmt(values.otherCurrent)}</strong></div>
      <div class="ocb-chip total"><span>Total</span><strong>${fmt(total)}</strong></div>
    </div>`;
}

function renderDashboardBreakdowns() {
  const fds = allEnriched();

  const fdBreakdown = document.getElementById('fdBreakdown');
  if (fdBreakdown) {
    const fdTotal = fds.reduce((s, f) => s + Number(f.principal), 0);
    const byMember = {};
    const byBank = {};
    fds.forEach(f => {
      const memberKey = f.memberName || 'Unknown';
      const bankKey = f.bank || 'Unknown';
      byMember[memberKey] = (byMember[memberKey] || 0) + Number(f.principal);
      byBank[bankKey] = (byBank[bankKey] || 0) + Number(f.principal);
    });
    fdBreakdown.innerHTML = !fds.length ? '<p class="empty-text">No FD records yet.</p>' : `
      <div class="breakdown-columns">
        <div class="breakdown-group">
          <div class="breakdown-title">By member</div>
          ${Object.entries(byMember).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([label, value]) => `
            <div class="breakdown-row"><span>${label}</span><strong>${fmt(value)}</strong><small>${fdTotal > 0 ? ((value / fdTotal) * 100).toFixed(0) : 0}%</small></div>
          `).join('')}
        </div>
        <div class="breakdown-group">
          <div class="breakdown-title">By bank</div>
          ${Object.entries(byBank).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([label, value]) => `
            <div class="breakdown-row"><span>${label}</span><strong>${fmt(value)}</strong><small>${fdTotal > 0 ? ((value / fdTotal) * 100).toFixed(0) : 0}%</small></div>
          `).join('')}
        </div>
      </div>`;
  }

  const pfBreakdown = document.getElementById('pfBreakdown');
  if (pfBreakdown) {
    const pfTotal = pfAccounts.reduce((s, p) => s + Number(p.currentBalance), 0);
    const byMember = {};
    pfAccounts.forEach(p => {
      const memberKey = members.find(m => m.id === p.memberId)?.name || 'Unknown';
      byMember[memberKey] = (byMember[memberKey] || 0) + Number(p.currentBalance);
    });
    pfBreakdown.innerHTML = !pfAccounts.length ? '<p class="empty-text">No PF records yet.</p>' : `
      <div class="breakdown-group single">
        <div class="breakdown-title">By member</div>
        ${Object.entries(byMember).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([label, value]) => `
          <div class="breakdown-row"><span>${label}</span><strong>${fmt(value)}</strong><small>${pfTotal > 0 ? ((value / pfTotal) * 100).toFixed(0) : 0}%</small></div>
        `).join('')}
      </div>`;
  }

  const npsBreakdown = document.getElementById('npsBreakdown');
  if (npsBreakdown) {
    const npsTotal = npsAccounts.reduce((s, n) => s + Number(n.currentValue), 0);
    const byTier = {};
    npsAccounts.forEach(n => {
      const key = `${n.tier || 'Tier I'}${n.subCategory ? ' · ' + n.subCategory : ''}`;
      byTier[key] = (byTier[key] || 0) + Number(n.currentValue);
    });
    npsBreakdown.innerHTML = !npsAccounts.length ? '<p class="empty-text">No NPS records yet.</p>' : `
      <div class="breakdown-group single">
        <div class="breakdown-title">By NPS bucket</div>
        ${Object.entries(byTier).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([label, value]) => `
          <div class="breakdown-row"><span>${label}</span><strong>${fmt(value)}</strong><small>${npsTotal > 0 ? ((value / npsTotal) * 100).toFixed(0) : 0}%</small></div>
        `).join('')}
      </div>`;
  }

  const sipBreakdown = document.getElementById('sipBreakdown');
  if (sipBreakdown) {
    const sipTotal = sipFunds.reduce((s, f) => s + Number(f.currentValue), 0);
    const byType = {};
    sipFunds.forEach(f => {
      const key = f.fundType || 'Other';
      byType[key] = (byType[key] || 0) + Number(f.currentValue);
    });
    sipBreakdown.innerHTML = !sipFunds.length ? '<p class="empty-text">No SIP records yet.</p>' : `
      <div class="breakdown-group single">
        <div class="breakdown-title">By fund type</div>
        ${Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([label, value]) => `
          <div class="breakdown-row"><span>${label}</span><strong>${fmt(value)}</strong><small>${sipTotal > 0 ? ((value / sipTotal) * 100).toFixed(0) : 0}%</small></div>
        `).join('')}
      </div>`;
  }
}

function renderDashboard() {
  const fds = allEnriched();
  const values = getPortfolioCategoryValues();

  // FD summary cards
  const totalInvested = fds.reduce((s,f)=>s+Number(f.principal),0);
  const totalMaturity = fds.reduce((s,f)=>s+f.maturityAmount,0);
  document.getElementById('totalInvested').textContent  = fmt(totalInvested);
  document.getElementById('totalMaturity').textContent  = fmt(totalMaturity);
  document.getElementById('totalFDs').textContent       = fds.length + ' FDs';
  document.getElementById('totalInterest').textContent  = 'Interest: ' + fmt(totalMaturity - totalInvested);
  document.getElementById('maturingSoon').textContent   = fds.filter(f=>f.status==='soon'||f.status==='matured').length;
  document.getElementById('totalMembers').textContent   = members.length;

  // PF summary
  const pfTotalBal    = pfAccounts.reduce((s,p)=>s+Number(p.currentBalance),0);
  const pfTotalContr  = pfAccounts.reduce((s,p)=>s+(Number(p.empContribution)+Number(p.erContribution)),0);
  const pfAvgRate     = pfAccounts.length ? (pfAccounts.reduce((s,p)=>s+Number(p.interestRate),0)/pfAccounts.length).toFixed(2) : 0;
  document.getElementById('pfTotalBalance').textContent  = fmt(pfTotalBal);
  document.getElementById('pfTotalAccounts').textContent = pfAccounts.length + ' account' + (pfAccounts.length!==1?'s':'');
  document.getElementById('pfTotalContrib').textContent  = fmt(pfTotalContr) + '/mo';
  document.getElementById('pfInterestEarned').textContent= fmt(Math.max(0, pfTotalBal - pfTotalContr));
  document.getElementById('pfAvgRate').textContent       = 'Avg rate: ' + pfAvgRate + '%';
  renderPFDashCards();

  // NPS summary
  const npsTotalInv  = npsAccounts.reduce((s,n)=>s+Number(n.totalInvested),0);
  const npsTotal     = npsAccounts.reduce((s,n)=>s+Number(n.currentValue),0);
  const npsGainAmt   = npsTotal - npsTotalInv;
  const npsRet       = npsTotalInv>0 ? ((npsGainAmt/npsTotalInv)*100).toFixed(1) : 0;
  document.getElementById('npsTotalInvested').textContent = fmt(npsTotalInv);
  document.getElementById('npsTotalAccounts').textContent = npsAccounts.length + ' account'+(npsAccounts.length!==1?'s':'');
  document.getElementById('npsCurrentValue').textContent  = fmt(npsTotal);
  document.getElementById('npsGain').textContent          = 'Gain: ' + fmt(npsGainAmt);
  document.getElementById('npsReturn').textContent        = npsRet + '%';
  renderNPSDashCards();

  // SIP summary
  const sipTotalInv  = sipFunds.reduce((s,f)=>s+Number(f.totalInvested),0);
  const sipTotalVal  = sipFunds.reduce((s,f)=>s+Number(f.currentValue),0);
  const sipGainAmt   = sipTotalVal - sipTotalInv;
  const sipRet       = sipTotalInv>0 ? ((sipGainAmt/sipTotalInv)*100).toFixed(1) : 0;
  const sipMonthlyTotal = sipFunds.filter(f=>f.isActive).reduce((s,f)=>s+Number(f.monthlyAmount),0);
  document.getElementById('sipTotalInvested').textContent = fmt(sipTotalInv);
  document.getElementById('sipTotalFunds').textContent    = sipFunds.length + ' fund'+(sipFunds.length!==1?'s':'');
  document.getElementById('sipCurrentValue').textContent  = fmt(sipTotalVal);
  document.getElementById('sipGain').textContent          = 'Gain: ' + fmt(sipGainAmt);
  document.getElementById('sipReturn').textContent        = sipRet + '%';
  document.getElementById('sipMonthly').textContent       = 'Monthly: ' + fmt(sipMonthlyTotal);
  renderSIPDashCards();

  // Grand total strip
  const grandInvested = values.fdInvested + values.pfCurrent + values.npsInvested + values.sipInvested + values.otherInvested;
  const grandCurrent  = values.fdCurrent + values.pfCurrent + values.npsCurrent + values.sipCurrent + values.otherCurrent;
  const grandGain     = grandCurrent - grandInvested;
  const grandReturn   = grandInvested>0 ? ((grandGain/grandInvested)*100).toFixed(1) : 0;
  document.getElementById('gtTotalInvested').textContent = fmt(grandInvested);
  document.getElementById('gtCurrentValue').textContent  = fmt(grandCurrent);
  const gainEl = document.getElementById('gtGain');
  gainEl.textContent = (grandGain>=0?'+':'') + fmt(grandGain);
  gainEl.className   = 'gt-value ' + (grandGain>=0?'green':'red');
  document.getElementById('gtReturn').textContent = (grandReturn>=0?'+':'') + grandReturn + '%';
  document.getElementById('gtReturn').className   = 'gt-value ' + (grandReturn>=0?'green':'red');

  renderOverallCategoryBreakdown(values);
  renderDashboardBreakdowns();
  populateFilterDropdowns();
  renderDashTable(fds);
  renderBankChart(fds);
}

function populateFilterDropdowns() {
  const mSel = document.getElementById('dashMemberFilter');
  const bSel = document.getElementById('dashBankFilter');
  const curM = mSel.value, curB = bSel.value;
  mSel.innerHTML = '<option value="">All Members</option>';
  members.forEach(m => { const o=document.createElement('option'); o.value=m.id; o.textContent=m.name; mSel.appendChild(o); });
  const banks = [...new Set(deposits.map(d=>d.bank))].sort();
  bSel.innerHTML = '<option value="">All Banks</option>';
  banks.forEach(b => { const o=document.createElement('option'); o.value=b; o.textContent=b; bSel.appendChild(o); });
  mSel.value=curM; bSel.value=curB;
}

function getFilteredFDs() {
  const mv  = document.getElementById('dashMemberFilter').value;
  const bv  = document.getElementById('dashBankFilter').value;
  const sv  = document.getElementById('dashStatusFilter').value;
  const fdv = document.getElementById('dashFdNoSearch').value.trim().toLowerCase();
  let fds = allEnriched();
  if (mv)  fds = fds.filter(f => f.memberId === mv);
  if (bv)  fds = fds.filter(f => f.bank === bv);
  if (sv)  fds = fds.filter(f => f.status === sv);
  if (fdv) fds = fds.filter(f => (f.accountNo||'').toLowerCase().includes(fdv));
  return fds;
}

function renderDashTable(fds) {
  fds = [...fds].sort((a,b) => {
    let va=a[sortState.col], vb=b[sortState.col];
    if(typeof va==='string') va=va.toLowerCase();
    if(typeof vb==='string') vb=vb.toLowerCase();
    if(va<vb) return sortState.dir==='asc'?-1:1;
    if(va>vb) return sortState.dir==='asc'?1:-1;
    return 0;
  });
  document.querySelectorAll('#dashTable th[data-sort]').forEach(th => {
    th.classList.remove('asc','desc');
    if(th.dataset.sort===sortState.col) th.classList.add(sortState.dir);
  });
  const tbody = document.getElementById('dashTableBody');
  if(!fds.length) { tbody.innerHTML='<tr><td colspan="13" class="empty-row">No FDs match the current filter.</td></tr>'; return; }
  tbody.innerHTML = fds.map(f=>`
    <tr>
      <td>${f.memberName}</td>
      <td>${f.bank}</td>
      <td><span class="fd-no-badge">${f.accountNo||'—'}</span></td>
      <td style="font-size:.78rem;color:var(--gray-500)">${f.linkedAcct?`<span title="${f.linkedAcctLabel}">****${String(f.linkedAcct.acctNumber).slice(-4)} (${f.linkedAcct.acctType})</span>`:'—'}</td>
      <td style="font-weight:600">${fmt(f.principal)}</td>
      <td>${Number(f.rate).toFixed(2)}%</td>
      <td>${fmtDate(f.startDate)}</td>
      <td>${fmtDate(f.maturityDate)}</td>
      <td>${f.daysLeft<0?'<span style="color:var(--red)">'+Math.abs(f.daysLeft)+' ago</span>':f.daysLeft+' days'}</td>
      <td style="font-weight:700;color:var(--green)">${fmt(f.maturityAmount)}</td>
      <td style="color:var(--blue)">${fmt(f.interest)}</td>
      <td><span class="badge badge-${f.status}">${f.status==='soon'?'Soon':f.status==='matured'?'Matured':'Active'}</span></td>
      <td>
        <button class="btn-icon view" onclick="showFDDetail('${f.id}')">👁</button>
        <button class="btn-icon edit" onclick="editFD('${f.id}')">✏</button>
        <button class="btn-icon del"  onclick="deleteFDConfirm('${f.id}')">🗑</button>
      </td>
    </tr>`).join('');
}

document.querySelectorAll('#dashTable th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const col=th.dataset.sort;
    if(sortState.col===col) sortState.dir=sortState.dir==='asc'?'desc':'asc';
    else { sortState.col=col; sortState.dir='asc'; }
    renderDashTable(getFilteredFDs());
  });
});
['dashMemberFilter','dashBankFilter','dashStatusFilter'].forEach(id => {
  document.getElementById(id).addEventListener('change', ()=>renderDashTable(getFilteredFDs()));
});
document.getElementById('dashFdNoSearch').addEventListener('input', ()=>renderDashTable(getFilteredFDs()));

function renderBankChart(fds) {
  const container=document.getElementById('bankChart');
  if(!fds.length){container.innerHTML='<p class="empty-text">No data yet.</p>';return;}
  const map={};
  fds.forEach(f=>{map[f.bank]=(map[f.bank]||0)+Number(f.principal);});
  const sorted=Object.entries(map).sort((a,b)=>b[1]-a[1]);
  const max=sorted[0][1];
  const colors=['#2563eb','#16a34a','#ea580c','#7c3aed','#d97706','#0891b2','#be185d'];
  container.innerHTML=sorted.map(([bank,amt],i)=>`
    <div class="bank-bar-row">
      <div class="bank-bar-label" title="${bank}">${bank}</div>
      <div class="bank-bar-track"><div class="bank-bar-fill" style="width:${(amt/max*100).toFixed(1)}%;background:${colors[i%colors.length]}"></div></div>
      <div class="bank-bar-val">${fmt(amt)}</div>
    </div>`).join('');
}

// ── Family Page ───────────────────────────────────────────────
function renderMemberList() {
  const list=document.getElementById('memberList');
  document.getElementById('memberCount').textContent=members.length;
  if(!members.length){list.innerHTML='<p class="empty-text">No members added yet.</p>';return;}
  list.innerHTML=members.map(m=>{
    const fdCount   =deposits.filter(d=>d.memberId===m.id).length;
    const acctCount =accounts.filter(a=>a.memberId===m.id).length;
    return `
    <div class="member-card">
      <div class="member-avatar" style="background:${memberColor(m.id)}">${initials(m.name)}</div>
      <div class="member-info">
        <strong>${m.name}</strong>
        <span>${m.relation}${m.pan?' · '+m.pan:''}</span>
        <div class="member-fds">${fdCount} FD${fdCount!==1?'s':''} · ${acctCount} account${acctCount!==1?'s':''}</div>
      </div>
      <div class="member-actions">
        <button class="btn-icon" style="font-size:.75rem;padding:.25rem .45rem" onclick="navTo('accounts')" title="Manage accounts">🏛</button>
        <button class="btn-icon edit" onclick="editMember('${m.id}')">✏</button>
        <button class="btn-icon del"  onclick="deleteMemberConfirm('${m.id}')">🗑</button>
      </div>
    </div>`; }).join('');
}

document.getElementById('familyForm').addEventListener('submit', async e => {
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
  try {
    showLoading(id ? 'Updating member…' : 'Saving member…');
    if (id) {
      const updated = await API.put(`/api/members/${id}`, data);
      const idx = members.findIndex(m=>m.id===id);
      members[idx] = updated;
    } else {
      const created = await API.post('/api/members', data);
      members.push(created);
    }
    clearFamilyForm();
    renderMemberList();
    populateMemberDropdowns();
    updateAlertBanner();
    showToast(id ? 'Member updated.' : 'Member added.');
  } catch(err) {
    showToast('Error: ' + err.message, 'error');
  } finally { hideLoading(); }
});

document.getElementById('clearFamilyForm').addEventListener('click', clearFamilyForm);
function clearFamilyForm() {
  document.getElementById('familyForm').reset();
  document.getElementById('memberId').value='';
  document.getElementById('familyFormTitle').textContent='Add Member';
}

function editMember(id) {
  const m=members.find(x=>x.id===id); if(!m) return;
  document.getElementById('memberId').value       =m.id;
  document.getElementById('memberName').value     =m.name;
  document.getElementById('memberRelation').value =m.relation;
  document.getElementById('memberPan').value      =m.pan||'';
  document.getElementById('memberPhone').value    =m.phone||'';
  document.getElementById('memberEmail').value    =m.email||'';
  document.getElementById('memberNotes').value    =m.notes||'';
  document.getElementById('familyFormTitle').textContent='Edit Member';
}

function deleteMemberConfirm(id) {
  const m=members.find(x=>x.id===id);
  const fdCount  =deposits.filter(d=>d.memberId===id).length;
  const acctCount=accounts.filter(a=>a.memberId===id).length;
  showConfirm(
    `Delete "${m.name}"? This will remove ${acctCount} account(s) and ${fdCount} FD(s). Cannot be undone.`,
    async () => {
      try {
        showLoading('Deleting…');
        await API.del(`/api/members/${id}`);
        members  = members.filter(x=>x.id!==id);
        accounts = accounts.filter(a=>a.memberId!==id);
        deposits = deposits.filter(d=>d.memberId!==id);
        renderMemberList(); populateMemberDropdowns(); updateAlertBanner();
        showToast('Member deleted.');
      } catch(err){ showToast('Error: '+err.message,'error'); }
      finally { hideLoading(); }
    }
  );
}

// ── Accounts Page ─────────────────────────────────────────────
function populateAcctMemberDropdown() {
  ['acctMember','acctMemberFilter'].forEach(selId => {
    const sel=document.getElementById(selId);
    const cur=sel.value;
    sel.innerHTML = selId==='acctMember'
      ? '<option value="">Select member...</option>'
      : '<option value="">All Members</option>';
    members.forEach(m=>{ const o=document.createElement('option'); o.value=m.id; o.textContent=m.name; sel.appendChild(o); });
    sel.value=cur;
  });
}

function renderAcctList(filterMemberId='') {
  const list=document.getElementById('acctList');
  document.getElementById('acctCount').textContent=accounts.length;
  let accts=filterMemberId?accounts.filter(a=>a.memberId===filterMemberId):accounts;
  if(!accts.length){list.innerHTML='<p class="empty-text">'+(accounts.length?'No accounts for this member.':'No accounts added yet.')+'</p>';return;}
  const grouped={};
  accts.forEach(a=>{if(!grouped[a.memberId])grouped[a.memberId]=[];grouped[a.memberId].push(a);});
  list.innerHTML=Object.entries(grouped).map(([memberId,acctList])=>{
    const member=members.find(m=>m.id===memberId)||{name:'Unknown'};
    const cards=acctList.map(a=>{
      const fdCount=deposits.filter(d=>d.linkedAccountId===a.id).length;
      return `
        <div class="acct-card${a.isPrimary?' primary':''}">
          <div class="acct-card-header">
            <div>
              <div class="acct-card-title">${a.isPrimary?'<span class="badge-primary-tag">★ Primary</span> ':''}${a.bank}</div>
              <div class="acct-card-sub">${a.acctType} A/C · ****${String(a.acctNumber).slice(-4)}</div>
            </div>
            <div style="display:flex;gap:.3rem">
              <button class="btn-icon edit" onclick="editAcct('${a.id}')">✏</button>
              <button class="btn-icon del"  onclick="deleteAcctConfirm('${a.id}')">🗑</button>
            </div>
          </div>
          <div class="acct-card-meta">
            ${a.acctHolderName?`<span>👤 ${a.acctHolderName}</span>`:''}
            ${a.branch?`<span>📍 ${a.branch}</span>`:''}
            ${a.ifsc?`<span>🔢 ${a.ifsc}</span>`:''}
            ${a.openDate?`<span>📅 Opened: ${fmtDate(a.openDate)}</span>`:''}
            <span>💰 ${fdCount} FD${fdCount!==1?'s':''} linked</span>
          </div>
          ${a.notes?`<div class="acct-notes">${a.notes}</div>`:''}
        </div>`;
    }).join('');
    return `
      <div class="acct-member-group">
        <div class="acct-member-header">
          <div class="member-avatar" style="background:${memberColor(memberId)};width:28px;height:28px;font-size:.75rem">${initials(member.name)}</div>
          <strong>${member.name}</strong>
          <span class="acct-member-count">${acctList.length} account${acctList.length!==1?'s':''}</span>
        </div>${cards}
      </div>`;
  }).join('');
}

document.getElementById('acctMemberFilter').addEventListener('change', function(){renderAcctList(this.value);});

document.getElementById('acctForm').addEventListener('submit', async e => {
  e.preventDefault();
  const id       = document.getElementById('acctId').value;
  const memberId = document.getElementById('acctMember').value;
  const data = {
    memberId,
    bank:           document.getElementById('acctBank').value.trim(),
    acctNumber:     document.getElementById('acctNumber').value.trim(),
    acctType:       document.getElementById('acctType').value,
    ifsc:           document.getElementById('acctIfsc').value.trim().toUpperCase(),
    branch:         document.getElementById('acctBranch').value.trim(),
    acctHolderName: document.getElementById('acctHolderName').value.trim(),
    openDate:       document.getElementById('acctOpenDate').value,
    isPrimary:      document.getElementById('acctPrimary').checked,
    notes:          document.getElementById('acctNotes').value.trim(),
  };
  try {
    showLoading(id ? 'Updating account…' : 'Saving account…');
    if (id) {
      const updated = await API.put(`/api/accounts/${id}`, data);
      const idx = accounts.findIndex(a=>a.id===id);
      accounts[idx] = updated;
      // Sync isPrimary: server already cleared others, refresh all
      if (data.isPrimary) {
        accounts.forEach(a=>{ if(a.memberId===memberId && a.id!==id) a.isPrimary=false; });
      }
    } else {
      const created = await API.post('/api/accounts', data);
      if (data.isPrimary) {
        accounts.forEach(a=>{ if(a.memberId===memberId) a.isPrimary=false; });
      }
      accounts.push(created);
    }
    clearAcctForm();
    renderAcctList(document.getElementById('acctMemberFilter').value);
    populateMemberDropdowns();
    showToast(id ? 'Account updated.' : 'Account added.');
  } catch(err){ showToast('Error: '+err.message,'error'); }
  finally { hideLoading(); }
});

document.getElementById('clearAcctForm').addEventListener('click', clearAcctForm);
function clearAcctForm() {
  document.getElementById('acctForm').reset();
  document.getElementById('acctId').value='';
  document.getElementById('acctFormTitle').textContent='Add Bank Account';
}

function editAcct(id) {
  const a=accounts.find(x=>x.id===id); if(!a) return;
  document.getElementById('acctId').value           =a.id;
  document.getElementById('acctMember').value       =a.memberId;
  document.getElementById('acctBank').value         =a.bank;
  document.getElementById('acctNumber').value       =a.acctNumber;
  document.getElementById('acctType').value         =a.acctType;
  document.getElementById('acctIfsc').value         =a.ifsc||'';
  document.getElementById('acctBranch').value       =a.branch||'';
  document.getElementById('acctHolderName').value   =a.acctHolderName||'';
  document.getElementById('acctOpenDate').value     =a.openDate||'';
  document.getElementById('acctPrimary').checked    =a.isPrimary||false;
  document.getElementById('acctNotes').value        =a.notes||'';
  document.getElementById('acctFormTitle').textContent='Edit Bank Account';
  document.querySelector('#page-accounts .form-card').scrollIntoView({behavior:'smooth'});
}

function deleteAcctConfirm(id) {
  const a=accounts.find(x=>x.id===id);
  const fdCount=deposits.filter(d=>d.linkedAccountId===id).length;
  showConfirm(
    `Delete "${a.bank}" ${a.acctType} (****${String(a.acctNumber).slice(-4)})? ${fdCount} FD(s) will lose their account link.`,
    async () => {
      try {
        showLoading('Deleting account…');
        await API.del(`/api/accounts/${id}`);
        accounts=accounts.filter(x=>x.id!==id);
        deposits.forEach(d=>{ if(d.linkedAccountId===id) d.linkedAccountId=''; });
        renderAcctList(document.getElementById('acctMemberFilter').value);
        showToast('Account deleted.');
      } catch(err){ showToast('Error: '+err.message,'error'); }
      finally { hideLoading(); }
    }
  );
}

// ── Deposits Page ─────────────────────────────────────────────
function populateMemberDropdowns() {
  ['fdMember','fdNominee'].forEach(selId => {
    const sel=document.getElementById(selId);
    const cur=sel.value;
    sel.innerHTML=selId==='fdMember'?'<option value="">Select member...</option>':'<option value="">None / Not set</option>';
    members.forEach(m=>{const o=document.createElement('option');o.value=m.id;o.textContent=m.name;sel.appendChild(o);});
    sel.value=cur;
  });
}

function populateLinkedAccountDropdown(memberId, selectedId='') {
  const sel=document.getElementById('fdLinkedAccount');
  const accts=memberId?memberAccounts(memberId):[];
  if(!accts.length){
    sel.innerHTML=memberId?'<option value="">No accounts — add in Accounts tab</option>':'<option value="">Select member first...</option>';
    return;
  }
  sel.innerHTML='<option value="">Not linked to an account</option>';
  accts.forEach(a=>{
    const o=document.createElement('option');
    o.value=a.id;
    o.textContent=`${a.isPrimary?'★ ':''}${a.bank} · ${a.acctType} · ****${String(a.acctNumber).slice(-4)}`;
    if(a.isPrimary && !selectedId) o.selected=true;
    sel.appendChild(o);
  });
  if(selectedId) sel.value=selectedId;
}

document.getElementById('fdMember').addEventListener('change', function(){populateLinkedAccountDropdown(this.value);});

function renderFDList(filter='') {
  const list=document.getElementById('fdList');
  const fds=allEnriched().filter(f=>
    !filter||f.bank.toLowerCase().includes(filter)||
    f.memberName.toLowerCase().includes(filter)||
    (f.accountNo||'').toLowerCase().includes(filter)||
    (f.notes||'').toLowerCase().includes(filter)
  );
  document.getElementById('fdCount').textContent=deposits.length;
  if(!fds.length){list.innerHTML='<p class="empty-text">'+(deposits.length?'No matches.':'No FDs added yet.')+'</p>';return;}
  list.innerHTML=fds.map(f=>`
    <div class="fd-card ${f.status}">
      <div class="fd-card-header">
        <div>
          <div class="fd-card-title">${f.bank}</div>
          ${f.accountNo?`<div class="fd-card-fdno">🔖 FD No: <strong>${f.accountNo}</strong></div>`:''}
          <div class="fd-card-sub">${f.memberName} · ${f.tenure} · ${Number(f.rate).toFixed(2)}% p.a.</div>
          ${f.linkedAcct?`<div class="fd-card-sub" style="color:var(--blue)">🏛 ****${String(f.linkedAcct.acctNumber).slice(-4)} · ${f.linkedAcct.acctType}</div>`:''}
        </div>
        <div style="display:flex;gap:.3rem;align-items:flex-start">
          <span class="badge badge-${f.status}">${f.status==='soon'?'Soon':f.status==='matured'?'Matured':'Active'}</span>
          <button class="btn-icon view" onclick="showFDDetail('${f.id}')">👁</button>
          <button class="btn-icon edit" onclick="editFD('${f.id}')">✏</button>
          <button class="btn-icon del"  onclick="deleteFDConfirm('${f.id}')">🗑</button>
        </div>
      </div>
      <div class="fd-card-meta">
        <span>💵 ${fmt(f.principal)}</span>
        <span>🏦 Matures: ${fmtDate(f.maturityDate)}</span>
        <span>📈 ${fmt(f.maturityAmount)}</span>
        <span>${f.daysLeft<0?'⚠ Matured '+Math.abs(f.daysLeft)+'d ago':'⏳ '+f.daysLeft+' days left'}</span>
      </div>
    </div>`).join('');
}

document.getElementById('fdSearch').addEventListener('input', function(){renderFDList(this.value.trim().toLowerCase());});

// FD live preview
function updateFDPreview() {
  const startDate=document.getElementById('fdStartDate').value;
  const principal=document.getElementById('fdPrincipal').value;
  const rate=document.getElementById('fdRate').value;
  const compounding=document.getElementById('fdCompounding').value;
  const manualMat=document.getElementById('fdMaturityDate').value;
  const yrs=parseInt(document.getElementById('fdTenureYears').value)||0;
  const mos=parseInt(document.getElementById('fdTenureMonths').value)||0;
  const dys=parseInt(document.getElementById('fdTenureDays').value)||0;
  if(!startDate||!principal||!rate) return;
  let matDate=manualMat||((yrs||mos||dys)?calcMaturityDate(startDate,yrs,mos,dys):'');
  if(!matDate) return;
  const matAmt=calcMaturityAmount(principal,rate,compounding,startDate,matDate);
  document.getElementById('previewMaturityDate').textContent=fmtDate(matDate);
  document.getElementById('previewTenure').textContent=tenureLabel(startDate,matDate);
  document.getElementById('previewMaturityAmt').textContent=fmt(matAmt);
  document.getElementById('previewInterest').textContent=fmt(matAmt-Number(principal));
}
['fdStartDate','fdPrincipal','fdRate','fdCompounding','fdMaturityDate',
 'fdTenureYears','fdTenureMonths','fdTenureDays'].forEach(id=>{
  document.getElementById(id).addEventListener('input',updateFDPreview);
  document.getElementById(id).addEventListener('change',updateFDPreview);
});

document.getElementById('fdForm').addEventListener('submit', async e => {
  e.preventDefault();
  const id        = document.getElementById('fdId').value;
  const startDate = document.getElementById('fdStartDate').value;
  const manualMat = document.getElementById('fdMaturityDate').value;
  const yrs=parseInt(document.getElementById('fdTenureYears').value)||0;
  const mos=parseInt(document.getElementById('fdTenureMonths').value)||0;
  const dys=parseInt(document.getElementById('fdTenureDays').value)||0;
  const maturityDate=manualMat||((yrs||mos||dys)?calcMaturityDate(startDate,yrs,mos,dys):'');
  if(!maturityDate){alert('Please enter tenure or maturity date.');return;}
  const data = {
    memberId:        document.getElementById('fdMember').value,
    linkedAccountId: document.getElementById('fdLinkedAccount').value,
    bank:            document.getElementById('fdBank').value.trim(),
    accountNo:       document.getElementById('fdAccountNo').value.trim(),
    principal:       parseFloat(document.getElementById('fdPrincipal').value),
    rate:            parseFloat(document.getElementById('fdRate').value),
    compounding:     document.getElementById('fdCompounding').value,
    startDate, tenureYears:yrs, tenureMonths:mos, tenureDays:dys, maturityDate,
    payout:          document.getElementById('fdPayout').value,
    nomineeId:       document.getElementById('fdNominee').value,
    notes:           document.getElementById('fdNotes').value.trim(),
  };
  try {
    showLoading(id?'Updating FD…':'Saving FD…');
    if(id){
      const updated=await API.put(`/api/deposits/${id}`,data);
      deposits[deposits.findIndex(d=>d.id===id)]=updated;
    } else {
      deposits.push(await API.post('/api/deposits',data));
    }
    clearFDForm(); renderFDList(); renderDashboard(); updateGoalViews(); updateAlertBanner();
    showToast(id?'FD updated.':'FD added.');
  } catch(err){showToast('Error: '+err.message,'error');}
  finally{hideLoading();}
});

document.getElementById('clearFdForm').addEventListener('click', clearFDForm);
function clearFDForm() {
  document.getElementById('fdForm').reset();
  document.getElementById('fdId').value='';
  document.getElementById('fdFormTitle').textContent='Add Fixed Deposit';
  document.getElementById('fdTenureYears').value=0;
  document.getElementById('fdTenureMonths').value=0;
  document.getElementById('fdTenureDays').value=0;
  ['previewMaturityDate','previewTenure','previewMaturityAmt','previewInterest'].forEach(id=>{
    document.getElementById(id).textContent='—';
  });
  populateLinkedAccountDropdown('');
}

function editFD(id) {
  navTo('deposits');
  const f=deposits.find(d=>d.id===id); if(!f) return;
  document.getElementById('fdId').value           =f.id;
  document.getElementById('fdMember').value       =f.memberId;
  populateLinkedAccountDropdown(f.memberId, f.linkedAccountId||'');
  document.getElementById('fdBank').value         =f.bank;
  document.getElementById('fdAccountNo').value    =f.accountNo||'';
  document.getElementById('fdPrincipal').value    =f.principal;
  document.getElementById('fdRate').value         =f.rate;
  document.getElementById('fdCompounding').value  =f.compounding;
  document.getElementById('fdStartDate').value    =f.startDate;
  document.getElementById('fdTenureYears').value  =f.tenureYears||0;
  document.getElementById('fdTenureMonths').value =f.tenureMonths||0;
  document.getElementById('fdTenureDays').value   =f.tenureDays||0;
  document.getElementById('fdMaturityDate').value =f.maturityDate||'';
  document.getElementById('fdPayout').value       =f.payout;
  document.getElementById('fdNominee').value      =f.nomineeId||'';
  document.getElementById('fdNotes').value        =f.notes||'';
  document.getElementById('fdFormTitle').textContent='Edit Fixed Deposit';
  updateFDPreview();
  document.querySelector('#page-deposits .form-card').scrollIntoView({behavior:'smooth'});
}

function deleteFDConfirm(id) {
  const f=enrichFD(deposits.find(d=>d.id===id));
  showConfirm(`Delete FD at "${f.bank}" (${fmt(f.principal)}) for ${f.memberName}? Cannot be undone.`,
    async () => {
      try {
        showLoading('Deleting FD…');
        await API.del(`/api/deposits/${id}`);
        deposits=deposits.filter(d=>d.id!==id);
        renderFDList(); renderDashboard(); updateGoalViews(); updateAlertBanner();
        showToast('FD deleted.');
      } catch(err){showToast('Error: '+err.message,'error');}
      finally{hideLoading();}
    }
  );
}

// ── Alerts Page ───────────────────────────────────────────────
document.querySelectorAll('.filter-chip').forEach(btn=>{
  btn.addEventListener('click',function(){
    document.querySelectorAll('.filter-chip').forEach(b=>b.classList.remove('active'));
    this.classList.add('active');
    currentAlertDays=parseInt(this.dataset.days);
    renderAlerts(currentAlertDays);
  });
});

function renderAlerts(days) {
  const list=document.getElementById('alertsList');
  let fds=allEnriched();
  if(days===0) fds=fds.filter(f=>f.status==='matured').sort((a,b)=>a.daysLeft-b.daysLeft);
  else         fds=fds.filter(f=>f.daysLeft>=0&&f.daysLeft<=days).sort((a,b)=>a.daysLeft-b.daysLeft);
  if(!fds.length){list.innerHTML=`<div class="section-card"><p class="empty-text">No FDs in this category. 🎉</p></div>`;return;}
  list.innerHTML=fds.map(f=>{
    const urgency=f.status==='matured'?'matured':f.daysLeft<=15?'urgent':f.daysLeft<=60?'warning':'info';
    const icon=f.status==='matured'?'🔴':f.daysLeft<=15?'🚨':f.daysLeft<=60?'⚠️':'🔵';
    const daysText=f.status==='matured'?`Matured ${Math.abs(f.daysLeft)} days ago on ${fmtDate(f.maturityDate)}`:`Matures in ${f.daysLeft} days on ${fmtDate(f.maturityDate)}`;
    const nominee=f.nomineeId?(members.find(m=>m.id===f.nomineeId)||{}).name:null;
    return `
      <div class="alert-card ${urgency}">
        <div class="alert-icon">${icon}</div>
        <div class="alert-content">
          <strong>${f.bank}${f.accountNo?' ('+f.accountNo+')':''} — ${f.memberName}</strong>
          <p>${daysText} · ₹${Number(f.principal).toLocaleString('en-IN')} principal · ${Number(f.rate).toFixed(2)}% p.a.</p>
          <p style="margin-top:.2rem">Payout: ${f.payout}${nominee?' · Nominee: '+nominee:''}${f.linkedAcct?' · A/C: ****'+String(f.linkedAcct.acctNumber).slice(-4):''}</p>
          ${f.notes?`<p style="color:var(--gray-400);font-style:italic;margin-top:.2rem">${f.notes}</p>`:''}
        </div>
        <div class="alert-amount">${fmt(f.maturityAmount)}<small>Maturity Value</small><small style="color:var(--blue)">+${fmt(f.interest)} interest</small></div>
      </div>`; }).join('');
}

// ── FD Detail Modal ───────────────────────────────────────────
function showFDDetail(id) {
  const f=enrichFD(deposits.find(d=>d.id===id));
  const nominee=f.nomineeId?(members.find(m=>m.id===f.nomineeId)||{}).name:'Not set';
  const totalDays=diffDays(f.startDate,f.maturityDate);
  const elapsed=Math.max(0,diffDays(f.startDate,today()));
  const pct=totalDays>0?Math.min(100,Math.round(elapsed/totalDays*100)):0;
  document.getElementById('modalTitle').textContent=`${f.bank} — FD Details`;
  document.getElementById('modalBody').innerHTML=`
    <div class="detail-grid">
      <div class="detail-highlight">
        <div><label>Maturity Amount</label><div class="big">${fmt(f.maturityAmount)}</div></div>
        <div style="text-align:right"><label>Interest Earned</label><div class="big" style="color:var(--blue)">${fmt(f.interest)}</div></div>
      </div>
      <div class="detail-item"><label>Account Holder</label><span>${f.memberName}</span></div>
      <div class="detail-item"><label>Bank</label><span>${f.bank}</span></div>
      <div class="detail-item"><label>Linked Account</label><span>${f.linkedAcctLabel}</span></div>
      <div class="detail-item"><label>FD Number</label><span>${f.accountNo||'—'}</span></div>
      <div class="detail-item"><label>Principal</label><span>${fmt(f.principal)}</span></div>
      <div class="detail-item"><label>Rate</label><span>${Number(f.rate).toFixed(2)}% p.a.</span></div>
      <div class="detail-item"><label>Compounding</label><span>${f.compounding}</span></div>
      <div class="detail-item"><label>Start Date</label><span>${fmtDate(f.startDate)}</span></div>
      <div class="detail-item"><label>Maturity Date</label><span>${fmtDate(f.maturityDate)}</span></div>
      <div class="detail-item"><label>Tenure</label><span>${f.tenure}</span></div>
      <div class="detail-item"><label>Days Left</label><span>${f.daysLeft<0?'Matured '+Math.abs(f.daysLeft)+'d ago':f.daysLeft+' days'}</span></div>
      <div class="detail-item"><label>Payout Type</label><span>${f.payout}</span></div>
      <div class="detail-item"><label>Nominee</label><span>${nominee}</span></div>
      ${f.notes?`<div class="detail-item" style="grid-column:1/-1"><label>Notes</label><span>${f.notes}</span></div>`:''}
    </div>
    <div class="progress-section">
      <label>Tenure Progress — ${pct}% elapsed (${elapsed} of ${totalDays} days)</label>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
    </div>`;
  openModal();
}

function openModal()  {document.getElementById('modal').classList.remove('hidden');}
function closeModal() {document.getElementById('modal').classList.add('hidden');}
document.getElementById('modalClose').addEventListener('click',closeModal);
document.getElementById('modal').addEventListener('click',e=>{if(e.target.id==='modal')closeModal();});

// ── Confirm Dialog ────────────────────────────────────────────
function showConfirm(msg, cb) {
  document.getElementById('confirmMsg').textContent=msg;
  confirmCallback=cb;
  document.getElementById('confirmDialog').classList.remove('hidden');
}
document.getElementById('confirmYes').addEventListener('click',()=>{
  if(confirmCallback) confirmCallback();
  confirmCallback=null;
  document.getElementById('confirmDialog').classList.add('hidden');
});
document.getElementById('confirmNo').addEventListener('click',()=>{
  confirmCallback=null;
  document.getElementById('confirmDialog').classList.add('hidden');
});
document.getElementById('confirmDialog').addEventListener('click',e=>{
  if(e.target.id==='confirmDialog'){confirmCallback=null;document.getElementById('confirmDialog').classList.add('hidden');}
});

// ── Export CSV ────────────────────────────────────────────────
document.getElementById('exportBtn').addEventListener('click', () => {
  const fds=allEnriched();
  if(!fds.length){alert('No FDs to export.');return;}
  const header=['Member','Relation','Bank','Linked Account','FD Number','Principal','Rate %',
    'Compounding','Start Date','Maturity Date','Tenure','Maturity Amount','Interest','Status','Payout','Nominee','Notes'];
  const rows=fds.map(f=>{
    const member=members.find(m=>m.id===f.memberId)||{};
    const nominee=f.nomineeId?(members.find(m=>m.id===f.nomineeId)||{}).name:'';
    return [f.memberName,member.relation||'',f.bank,f.linkedAcctLabel,f.accountNo||'',
      f.principal,f.rate,f.compounding,f.startDate,f.maturityDate,f.tenure,
      f.maturityAmount.toFixed(2),f.interest.toFixed(2),f.status,f.payout,nominee,f.notes||'']
      .map(v=>`"${String(v).replace(/"/g,'""')}"`);
  });
  const csv=[header.map(h=>`"${h}"`), ...rows].map(r=>r.join(',')).join('\n');
  const blob=new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download='FD_Portfolio_'+today()+'.csv'; a.click();
  URL.revokeObjectURL(url);
});

// ── Import CSV ────────────────────────────────────────────────
const importModal = document.getElementById('importModal');
const csvFile = document.getElementById('csvFile');
const importSubmit = document.getElementById('importSubmit');
const importCancel = document.getElementById('importCancel');
const importClose = document.getElementById('importClose');
const importForm = document.getElementById('importForm');
const importResult = document.getElementById('importResult');

document.getElementById('importBtn').addEventListener('click', () => {
  csvFile.value = '';
  importForm.classList.remove('hidden');
  importResult.classList.add('hidden');
  importModal.classList.remove('hidden');
});

importClose.addEventListener('click', () => importModal.classList.add('hidden'));
importCancel.addEventListener('click', () => importModal.classList.add('hidden'));

importModal.addEventListener('click', e => {
  if (e.target.id === 'importModal') importModal.classList.add('hidden');
});

importSubmit.addEventListener('click', async () => {
  if (!csvFile.files.length) {
    showToast('Please select a CSV file', 'error');
    return;
  }

  const file = csvFile.files[0];
  const text = await file.text();

  showLoading('Importing deposits…');
  try {
    const r = await fetch('/api/import/csv', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: text
    });
    const result = await r.json();

    if (!r.ok) {
      showToast('Import failed: ' + (result.error || 'Unknown error'), 'error');
      hideLoading();
      return;
    }

    hideLoading();

    const msg = `✅ Imported ${result.imported} deposits${result.skipped > 0 ? ` (${result.skipped} skipped)` : ''}`;
    showToast(msg, 'success');

    // Show result
    importForm.classList.add('hidden');
    const errorsHtml = result.errors && result.errors.length
      ? `<div style="color: var(--red); font-size: 0.85rem; margin-top: 1rem;">
          <strong>Issues:</strong>
          <ul style="margin: 0.5rem 0 0 1.2rem;">
            ${result.errors.map(e => `<li>${e}</li>`).join('')}
          </ul>
        </div>`
      : '';
    
    importResult.innerHTML = `
      <div style="background: var(--green-lt); border: 1px solid var(--green); border-radius: 6px; padding: 1rem; text-align: center;">
        <div style="font-size: 2rem; margin-bottom: 0.5rem;">✅</div>
        <div><strong>${result.imported} deposits imported</strong></div>
        <div style="font-size: 0.9rem; color: var(--gray-600); margin-top: 0.5rem;">
          Total: ${result.total} | Imported: ${result.imported} | Skipped: ${result.skipped}
        </div>
        ${errorsHtml}
        <div style="margin-top: 1.5rem;">
          <button class="btn-primary" onclick="location.reload()" style="width: auto; padding: 0.5rem 2rem;">Reload & View</button>
        </div>
      </div>
    `;
    importResult.classList.remove('hidden');

    // Auto-close after 3 seconds and reload
    setTimeout(() => {
      location.reload();
    }, 3000);
  } catch (err) {
    hideLoading();
    showToast('Import error: ' + err.message, 'error');
    console.error(err);
  }
});

// ── Bootstrap: load all data then render ──────────────────────
async function init() {
  showLoading('Loading portfolio…');
  try {
    [members, accounts, deposits, pfAccounts, npsAccounts, sipFunds, otherRecords, goals] = await Promise.all([
      API.get('/api/members'),
      API.get('/api/accounts'),
      API.get('/api/deposits'),
      API.get('/api/pf'),
      API.get('/api/nps'),
      API.get('/api/sip'),
      API.get('/api/others'),
      API.get('/api/goals'),
    ]);
  } catch(err) {
    document.getElementById('loadingMsg').textContent = '❌ Could not connect to server. Is it running?';
    console.error('Data load failed:', err);
    return;
  }

  // Hide loading first so the page is visible even if a render step throws
  hideLoading();

  try { navTo('dashboard'); } catch(e) { console.error('dashboard render error:', e); }
  try { initSplitToggles(); } catch(e) { console.error('initSplitToggles error:', e); }
  try { updateAlertBanner(); } catch(e) { console.error('alertBanner error:', e); }
  try { updateGoalViews(); } catch(e) { console.error('goalViews error:', e); }
}

init();

// ============================================================
//  PF / NPS / SIP — Shared helpers
// ============================================================
function populateInvMemberDropdowns() {
  ['pfMember','npsMember','sipMember'].forEach(selId => {
    const sel = document.getElementById(selId);
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">Select member...</option>';
    members.forEach(m => {
      const o = document.createElement('option');
      o.value = m.id; o.textContent = m.name;
      sel.appendChild(o);
    });
    sel.value = cur;
  });
}

function gainBadge(invested, current) {
  if (!invested || invested === 0) return '';
  const gain = current - invested;
  const pct  = ((gain / invested) * 100).toFixed(1);
  const cls  = gain >= 0 ? 'gain-pos' : 'gain-neg';
  const sign = gain >= 0 ? '+' : '';
  return `<span class="gain-badge ${cls}">${sign}${fmt(gain)} (${sign}${pct}%)</span>`;
}

// ============================================================
// ============================================================
//  Goals — CRUD page
// ============================================================
function updateGoalViews() {
  renderGoalFundValues();
  renderGoalList();
}

function renderGoalFundValues() {
  const values = getPortfolioCategoryValues();
  const totalCurrent = values.fdCurrent + values.pfCurrent + values.npsCurrent + values.sipCurrent + values.otherCurrent;
  const fdEl = document.getElementById('fvFDValue');
  const pfEl = document.getElementById('fvPFValue');
  const npsEl = document.getElementById('fvNPSValue');
  const sipEl = document.getElementById('fvSIPValue');
  const otherEl = document.getElementById('fvOtherValue');
  const totalEl = document.getElementById('fvTotalValue');
  if (fdEl) fdEl.textContent = fmt(values.fdCurrent);
  if (pfEl) pfEl.textContent = fmt(values.pfCurrent);
  if (npsEl) npsEl.textContent = fmt(values.npsCurrent);
  if (sipEl) sipEl.textContent = fmt(values.sipCurrent);
  if (otherEl) otherEl.textContent = fmt(values.otherCurrent);
  if (totalEl) totalEl.textContent = fmt(totalCurrent);
}

function isGoalCategoryLinked(category) {
  const cat = (category || '').trim().toUpperCase();
  return ['FD', 'PF', 'NPS', 'SIP', 'OTHER', 'OTHERS', 'GENERAL'].includes(cat);
}

// Returns live portfolio value for a goal's category
function liveValueForGoal(goal) {
  const values = getPortfolioCategoryValues();
  const cat = (goal.category || '').trim().toUpperCase();
  switch (cat) {
    case 'FD':      return values.fdCurrent;
    case 'PF':      return values.pfCurrent;
    case 'NPS':     return values.npsCurrent;
    case 'SIP':     return values.sipCurrent;
    case 'OTHER':
    case 'OTHERS':  return values.otherCurrent;
    case 'GENERAL': return values.fdCurrent + values.pfCurrent + values.npsCurrent + values.sipCurrent + values.otherCurrent;
    default:        return Number(goal.currentAmount) || 0;
  }
}

function renderGoalList() {
  const list = document.getElementById('goalList');
  if (!list) return;
  const countEl = document.getElementById('goalCount');
  if (countEl) countEl.textContent = goals.length;
  if (!goals.length) { list.innerHTML = '<p class="empty-text">No goals set yet.</p>'; return; }

  list.innerHTML = goals.map(goal => {
    const target  = Number(goal.targetAmount) || 0;
    // Use live portfolio value for category-linked goals; fall back to stored value otherwise
    const isLinked = isGoalCategoryLinked(goal.category);
    const current  = isLinked ? liveValueForGoal(goal) : (Number(goal.currentAmount) || 0);
    const pct      = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
    const remaining = Math.max(0, target - current);
    const daysLeft  = goal.targetDate ? diffDays(today(), goal.targetDate) : null;
    const status    = pct >= 100 ? 'Achieved' : daysLeft !== null && daysLeft < 0 ? 'Overdue' : 'In progress';
    const liveTag   = isLinked ? `<span class="goal-live-tag">● Live</span>` : '';
    return `
      <div class="goal-card">
        <div class="goal-card-header">
          <div>
            <div class="goal-card-title">${goal.title} ${liveTag}</div>
            <div class="goal-card-sub">${goal.category} · Target date: ${fmtDate(goal.targetDate)}</div>
          </div>
          <div class="goal-badge ${status === 'Achieved' ? 'goal-achieved' : status === 'Overdue' ? 'goal-overdue' : 'goal-active'}">${status}</div>
        </div>
        <div class="goal-progress">
          <div class="goal-progress-bar"><div style="width:${pct}%"></div></div>
          <span>${pct}%</span>
        </div>
        <div class="goal-metrics">
          <span>Current: <strong>${fmt(current)}</strong></span>
          <span>Target: <strong>${fmt(target)}</strong></span>
          <span>Remaining: <strong>${fmt(remaining)}</strong></span>
          <span>${daysLeft !== null ? (daysLeft >= 0 ? `${daysLeft} days left` : `${Math.abs(daysLeft)} days overdue`) : '—'}</span>
        </div>
        ${goal.notes ? `<div class="goal-notes">${goal.notes}</div>` : ''}
        <div class="goal-actions">
          <button class="btn-icon edit" onclick="editGoal('${goal.id}')">✏</button>
          <button class="btn-icon del" onclick="deleteGoalConfirm('${goal.id}')">🗑</button>
        </div>
      </div>`;
  }).join('');
}

document.getElementById('goalForm').addEventListener('submit', async e => {
  e.preventDefault();
  const id = document.getElementById('goalId').value;
  const category = document.getElementById('goalCategory').value;
  const isLinked = isGoalCategoryLinked(category);
  const data = {
    title: document.getElementById('goalTitle').value.trim(),
    category: category,
    targetAmount: parseFloat(document.getElementById('goalTarget').value) || 0,
    currentAmount: isLinked
      ? Math.round(liveValueForGoal({ category }))
      : (parseFloat(document.getElementById('goalCurrent').value) || 0),
    targetDate: document.getElementById('goalDate').value,
    notes: document.getElementById('goalNotes').value.trim(),
  };
  if (!data.title || !data.targetDate) {
    showToast('Please enter a title and target date.', 'error');
    return;
  }
  try {
    showLoading(id ? 'Updating goal…' : 'Saving goal…');
    if (id) {
      const updated = await API.put(`/api/goals/${id}`, data);
      goals[goals.findIndex(g => g.id === id)] = updated;
    } else {
      goals.push(await API.post('/api/goals', data));
    }
    clearGoalForm(); updateGoalViews(); showToast(id ? 'Goal updated.' : 'Goal saved.');
  } catch (err) { showToast('Error: ' + err.message, 'error'); }
  finally { hideLoading(); }
});

document.getElementById('clearGoalForm').addEventListener('click', clearGoalForm);
function clearGoalForm() {
  document.getElementById('goalForm').reset();
  document.getElementById('goalId').value = '';
  document.getElementById('goalFormTitle').textContent = 'Add Goal';
  const val = liveValueForGoal({ category: document.getElementById('goalCategory').value });
  if (val > 0) {
    document.getElementById('goalCurrent').value = Math.round(val);
    document.getElementById('goalCurrent').title = 'Auto-filled from live ' + document.getElementById('goalCategory').value + ' portfolio value';
  }
}

// Auto-fill current amount when category is picked
document.getElementById('goalCategory').addEventListener('change', function () {
  const dummy = { category: this.value, currentAmount: 0 };
  const val   = liveValueForGoal(dummy);
  if (val > 0) {
    document.getElementById('goalCurrent').value = Math.round(val);
    document.getElementById('goalCurrent').title = 'Auto-filled from live ' + this.value + ' portfolio value';
  }
});

function editGoal(id) {
  const g = goals.find(x => x.id === id); if (!g) return;
  document.getElementById('goalId').value    = g.id;
  document.getElementById('goalTitle').value = g.title || '';
  document.getElementById('goalCategory').value = g.category || 'General';
  document.getElementById('goalTarget').value  = g.targetAmount || 0;
  // For category-linked goals show live value; for manual goals show stored value
  const isLinked = isGoalCategoryLinked(g.category);
  document.getElementById('goalCurrent').value = isLinked
    ? Math.round(liveValueForGoal(g))
    : (g.currentAmount || 0);
  document.getElementById('goalDate').value  = g.targetDate || '';
  document.getElementById('goalNotes').value = g.notes || '';
  document.getElementById('goalFormTitle').textContent = 'Edit Goal';
  document.querySelector('#page-goals .form-card').scrollIntoView({ behavior: 'smooth' });
}
function deleteGoalConfirm(id) {
  const g = goals.find(x => x.id === id);
  showConfirm(`Delete goal "${g.title}"? Cannot be undone.`, async () => {
    try {
      showLoading('Deleting goal…');
      await API.del(`/api/goals/${id}`);
      goals = goals.filter(x => x.id !== id);
      updateGoalViews(); showToast('Goal deleted.');
    } catch (err) { showToast('Error: ' + err.message, 'error'); }
    finally { hideLoading(); }
  });
}

// ============================================================
//  Others — CRUD page
// ============================================================
function populateOtherMemberDropdown() {
  const sel = document.getElementById('otherMember');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">Select member...</option>';
  members.forEach(m => {
    const o = document.createElement('option');
    o.value = m.id; o.textContent = m.name;
    sel.appendChild(o);
  });
  sel.value = cur;
}

function renderOthersList() {
  const list = document.getElementById('othersList');
  document.getElementById('othersCount').textContent = otherRecords.length;
  if (!otherRecords.length) { list.innerHTML = '<p class="empty-text">No other records yet.</p>'; return; }
  list.innerHTML = otherRecords.map(r => {
    const member = members.find(m => m.id === r.memberId) || { name: 'Unknown' };
    return `
      <div class="inv-card">
        <div class="inv-card-header">
          <div>
            <div class="inv-card-title">${member.name} — ${r.title}</div>
            <div class="inv-card-sub">${r.category} · ${fmtDate(r.receivedDate)}</div>
          </div>
          <div style="display:flex;gap:.3rem">
            <button class="btn-icon edit" onclick="editOtherRecord('${r.id}')">✏</button>
            <button class="btn-icon del" onclick="deleteOtherRecordConfirm('${r.id}')">🗑</button>
          </div>
        </div>
        <div class="inv-card-meta">
          <span>💰 Amount: <strong>${fmt(r.amount)}</strong></span>
          <span>📅 Received: ${fmtDate(r.receivedDate)}</span>
        </div>
        ${r.notes ? `<div class="inv-card-notes">${r.notes}</div>` : ''}
      </div>`;
  }).join('');
}

document.getElementById('othersForm').addEventListener('submit', async e => {
  e.preventDefault();
  const id = document.getElementById('otherId').value;
  const data = {
    memberId: document.getElementById('otherMember').value,
    category: document.getElementById('otherCategory').value,
    title: document.getElementById('otherTitle').value.trim(),
    amount: parseFloat(document.getElementById('otherAmount').value) || 0,
    receivedDate: document.getElementById('otherDate').value,
    notes: document.getElementById('otherNotes').value.trim(),
  };
  try {
    showLoading(id ? 'Updating record…' : 'Saving record…');
    if (id) {
      const updated = await API.put(`/api/others/${id}`, data);
      otherRecords[otherRecords.findIndex(x => x.id === id)] = updated;
    } else {
      otherRecords.push(await API.post('/api/others', data));
    }
    clearOtherForm(); renderOthersList(); renderDashboard(); updateGoalViews(); updateAlertBanner(); showToast(id ? 'Record updated.' : 'Record saved.');
  } catch (err) { showToast('Error: ' + err.message, 'error'); }
  finally { hideLoading(); }
});

document.getElementById('clearOthersForm').addEventListener('click', clearOtherForm);
function clearOtherForm() {
  document.getElementById('othersForm').reset();
  document.getElementById('otherId').value = '';
  document.getElementById('othersFormTitle').textContent = 'Add Other Record';
}
function editOtherRecord(id) {
  const r = otherRecords.find(x => x.id === id); if (!r) return;
  document.getElementById('otherId').value = r.id;
  document.getElementById('otherMember').value = r.memberId;
  document.getElementById('otherCategory').value = r.category;
  document.getElementById('otherTitle').value = r.title || '';
  document.getElementById('otherAmount').value = r.amount;
  document.getElementById('otherDate').value = r.receivedDate || '';
  document.getElementById('otherNotes').value = r.notes || '';
  document.getElementById('othersFormTitle').textContent = 'Edit Other Record';
  document.querySelector('#page-others .form-card').scrollIntoView({ behavior: 'smooth' });
}
function deleteOtherRecordConfirm(id) {
  const r = otherRecords.find(x => x.id === id);
  const m = members.find(x => x.id === r.memberId) || { name: 'Unknown' };
  showConfirm(`Delete this record for "${m.name}"? Cannot be undone.`, async () => {
    try {
      showLoading('Deleting…');
      await API.del(`/api/others/${id}`);
      otherRecords = otherRecords.filter(x => x.id !== id);
      renderOthersList(); renderDashboard(); updateGoalViews(); updateAlertBanner(); showToast('Record deleted.');
    } catch (err) { showToast('Error: ' + err.message, 'error'); }
    finally { hideLoading(); }
  });
}

// ============================================================
//  PF — Dashboard mini-cards
// ============================================================
function renderPFDashCards() {
  const el = document.getElementById('pfMemberCards');
  if (!pfAccounts.length) { el.innerHTML = '<p class="empty-text">No PF accounts added yet.</p>'; return; }
  el.innerHTML = '<div class="inv-dash-grid">' +
    pfAccounts.map(p => {
      const member = members.find(m => m.id === p.memberId) || { name: 'Unknown' };
      const monthly = (Number(p.empContribution) + Number(p.erContribution));
      return `
        <div class="inv-dash-card pf-card">
          <div class="inv-dash-header">
            <div class="member-avatar" style="background:${memberColor(p.memberId)};width:28px;height:28px;font-size:.75rem">${initials(member.name)}</div>
            <div>
              <div class="inv-dash-name">${member.name}</div>
              <div class="inv-dash-sub">${p.employerName || 'EPF'} · UAN: ${p.uan || '—'}</div>
            </div>
          </div>
          <div class="inv-dash-values">
            <div><span>Balance</span><strong>${fmt(p.currentBalance)}</strong></div>
            <div><span>Monthly</span><strong>${fmt(monthly)}</strong></div>
            <div><span>Rate</span><strong>${p.interestRate}% p.a.</strong></div>
          </div>
        </div>`;
    }).join('') + '</div>';
}

// ============================================================
//  PF — CRUD page
// ============================================================
function renderPFList() {
  const list = document.getElementById('pfList');
  document.getElementById('pfCount').textContent = pfAccounts.length;
  if (!pfAccounts.length) { list.innerHTML = '<p class="empty-text">No PF accounts yet.</p>'; return; }
  list.innerHTML = pfAccounts.map(p => {
    const member  = members.find(m => m.id === p.memberId) || { name: 'Unknown' };
    const monthly = Number(p.empContribution) + Number(p.erContribution);
    return `
      <div class="inv-card pf-accent">
        <div class="inv-card-header">
          <div>
            <div class="inv-card-title">${member.name} — ${p.employerName || 'EPF Account'}</div>
            <div class="inv-card-sub">UAN: ${p.uan || '—'} · ${p.interestRate}% p.a. · Joined: ${fmtDate(p.joinDate)}</div>
          </div>
          <div style="display:flex;gap:.3rem">
            <button class="btn-icon edit" onclick="editPF('${p.id}')">✏</button>
            <button class="btn-icon del"  onclick="deletePFConfirm('${p.id}')">🗑</button>
          </div>
        </div>
        <div class="inv-card-meta">
          <span>💰 Balance: <strong>${fmt(p.currentBalance)}</strong></span>
          <span>👷 Employee: ${fmt(p.empContribution)}/mo</span>
          <span>🏢 Employer: ${fmt(p.erContribution)}/mo</span>
          <span>📅 Total monthly: ${fmt(monthly)}</span>
        </div>
        ${p.notes ? `<div class="inv-card-notes">${p.notes}</div>` : ''}
      </div>`;
  }).join('');
}

document.getElementById('pfForm').addEventListener('submit', async e => {
  e.preventDefault();
  const id = document.getElementById('pfId').value;
  const data = {
    memberId:       document.getElementById('pfMember').value,
    uan:            document.getElementById('pfUan').value.trim(),
    employerName:   document.getElementById('pfEmployer').value.trim(),
    empContribution:parseFloat(document.getElementById('pfEmpContrib').value) || 0,
    erContribution: parseFloat(document.getElementById('pfErContrib').value)  || 0,
    currentBalance: parseFloat(document.getElementById('pfBalance').value)    || 0,
    interestRate:   parseFloat(document.getElementById('pfRate').value)       || 8.25,
    joinDate:       document.getElementById('pfJoinDate').value,
    notes:          document.getElementById('pfNotes').value.trim(),
  };
  try {
    showLoading(id ? 'Updating PF…' : 'Saving PF…');
    if (id) {
      const updated = await API.put(`/api/pf/${id}`, data);
      pfAccounts[pfAccounts.findIndex(p => p.id === id)] = updated;
    } else {
      pfAccounts.push(await API.post('/api/pf', data));
    }
    clearPFForm(); renderPFList(); renderDashboard(); updateGoalViews(); showToast(id ? 'PF updated.' : 'PF saved.');
  } catch(err) { showToast('Error: ' + err.message, 'error'); }
  finally { hideLoading(); }
});

document.getElementById('clearPfForm').addEventListener('click', clearPFForm);
function clearPFForm() {
  document.getElementById('pfForm').reset();
  document.getElementById('pfId').value = '';
  document.getElementById('pfRate').value = '8.25';
  document.getElementById('pfFormTitle').textContent = 'Add PF Account';
}
function editPF(id) {
  const p = pfAccounts.find(x => x.id === id); if (!p) return;
  document.getElementById('pfId').value           = p.id;
  document.getElementById('pfMember').value       = p.memberId;
  document.getElementById('pfUan').value          = p.uan || '';
  document.getElementById('pfEmployer').value     = p.employerName || '';
  document.getElementById('pfEmpContrib').value   = p.empContribution;
  document.getElementById('pfErContrib').value    = p.erContribution;
  document.getElementById('pfBalance').value      = p.currentBalance;
  document.getElementById('pfRate').value         = p.interestRate;
  document.getElementById('pfJoinDate').value     = p.joinDate || '';
  document.getElementById('pfNotes').value        = p.notes || '';
  document.getElementById('pfFormTitle').textContent = 'Edit PF Account';
  document.querySelector('#page-pf .form-card').scrollIntoView({ behavior: 'smooth' });
}
function deletePFConfirm(id) {
  const p = pfAccounts.find(x => x.id === id);
  const m = members.find(x => x.id === p.memberId) || { name: 'Unknown' };
  showConfirm(`Delete PF account for "${m.name}"? Cannot be undone.`, async () => {
    try {
      showLoading('Deleting…');
      await API.del(`/api/pf/${id}`);
      pfAccounts = pfAccounts.filter(x => x.id !== id);
      renderPFList(); renderDashboard(); updateGoalViews(); showToast('PF account deleted.');
    } catch(err) { showToast('Error: ' + err.message, 'error'); }
    finally { hideLoading(); }
  });
}

// ============================================================
//  NPS — Dashboard mini-cards
// ============================================================
function renderNPSDashCards() {
  const el = document.getElementById('npsMemberCards');
  if (!npsAccounts.length) { el.innerHTML = '<p class="empty-text">No NPS accounts added yet.</p>'; return; }
  el.innerHTML = '<div class="inv-dash-grid">' +
    npsAccounts.map(n => {
      const member = members.find(m => m.id === n.memberId) || { name: 'Unknown' };
      const gain   = Number(n.currentValue) - Number(n.totalInvested);
      const pct    = n.totalInvested > 0 ? ((gain / n.totalInvested) * 100).toFixed(1) : 0;
      return `
        <div class="inv-dash-card nps-card">
          <div class="inv-dash-header">
            <div class="member-avatar" style="background:${memberColor(n.memberId)};width:28px;height:28px;font-size:.75rem">${initials(member.name)}</div>
            <div>
              <div class="inv-dash-name">${member.name} · <span class="tier-tag">${n.tier}</span></div>
              <div class="inv-dash-sub">${n.fundManager || '—'} · ${n.subCategory || '—'}</div>
            </div>
          </div>
          <div class="inv-dash-values">
            <div><span>Invested</span><strong>${fmt(n.totalInvested)}</strong></div>
            <div><span>Current</span><strong>${fmt(n.currentValue)}</strong></div>
            <div><span>Return</span><strong class="${gain>=0?'pos':'neg'}">${gain>=0?'+':''}${pct}%</strong></div>
          </div>
        </div>`;
    }).join('') + '</div>';
}

// ============================================================
//  NPS — CRUD page
// ============================================================
function renderNPSList() {
  const list = document.getElementById('npsList');
  document.getElementById('npsCount').textContent = npsAccounts.length;
  if (!npsAccounts.length) { list.innerHTML = '<p class="empty-text">No NPS accounts yet.</p>'; return; }
  list.innerHTML = npsAccounts.map(n => {
    const member = members.find(m => m.id === n.memberId) || { name: 'Unknown' };
    const gain   = Number(n.currentValue) - Number(n.totalInvested);
    return `
      <div class="inv-card nps-accent">
        <div class="inv-card-header">
          <div>
            <div class="inv-card-title">${member.name} — ${n.tier} <span class="tier-tag">${n.subCategory || ''}</span></div>
            <div class="inv-card-sub">PRAN: ${n.pran || '—'} · ${n.fundManager || '—'} · Since: ${fmtDate(n.startDate)}</div>
          </div>
          <div style="display:flex;gap:.3rem;align-items:flex-start">
            ${gainBadge(n.totalInvested, n.currentValue)}
            <button class="btn-icon edit" onclick="editNPS('${n.id}')">✏</button>
            <button class="btn-icon del"  onclick="deleteNPSConfirm('${n.id}')">🗑</button>
          </div>
        </div>
        <div class="inv-card-meta">
          <span>💵 Invested: <strong>${fmt(n.totalInvested)}</strong></span>
          <span>📈 Current: <strong style="color:var(--green)">${fmt(n.currentValue)}</strong></span>
          <span>🔢 Units: ${Number(n.unitsHeld).toLocaleString('en-IN', {maximumFractionDigits:3})}</span>
          <span>💹 NAV: ₹${Number(n.nav).toFixed(2)}</span>
        </div>
        ${n.notes ? `<div class="inv-card-notes">${n.notes}</div>` : ''}
      </div>`;
  }).join('');
}

document.getElementById('npsForm').addEventListener('submit', async e => {
  e.preventDefault();
  const id = document.getElementById('npsId').value;
  const data = {
    memberId:     document.getElementById('npsMember').value,
    pran:         document.getElementById('npsPran').value.trim(),
    tier:         document.getElementById('npsTier').value,
    subCategory:  document.getElementById('npsSubCat').value,
    fundManager:  document.getElementById('npsFundMgr').value,
    startDate:    document.getElementById('npsStartDate').value,
    totalInvested:parseFloat(document.getElementById('npsTotalInvested').value) || 0,
    nav:          parseFloat(document.getElementById('npsNav').value)            || 0,
    unitsHeld:    parseFloat(document.getElementById('npsUnits').value)          || 0,
    currentValue: parseFloat(document.getElementById('npsCurrentVal').value)     || 0,
    notes:        document.getElementById('npsNotes').value.trim(),
  };
  try {
    showLoading(id ? 'Updating NPS…' : 'Saving NPS…');
    if (id) {
      const updated = await API.put(`/api/nps/${id}`, data);
      npsAccounts[npsAccounts.findIndex(n => n.id === id)] = updated;
    } else {
      npsAccounts.push(await API.post('/api/nps', data));
    }
    clearNPSForm(); renderNPSList(); renderDashboard(); updateGoalViews(); showToast(id ? 'NPS updated.' : 'NPS saved.');
  } catch(err) { showToast('Error: ' + err.message, 'error'); }
  finally { hideLoading(); }
});

document.getElementById('clearNpsForm').addEventListener('click', clearNPSForm);
function clearNPSForm() {
  document.getElementById('npsForm').reset();
  document.getElementById('npsId').value = '';
  document.getElementById('npsFormTitle').textContent = 'Add NPS Account';
}
function editNPS(id) {
  const n = npsAccounts.find(x => x.id === id); if (!n) return;
  document.getElementById('npsId').value           = n.id;
  document.getElementById('npsMember').value       = n.memberId;
  document.getElementById('npsPran').value         = n.pran || '';
  document.getElementById('npsTier').value         = n.tier;
  document.getElementById('npsSubCat').value       = n.subCategory || '';
  document.getElementById('npsFundMgr').value      = n.fundManager || '';
  document.getElementById('npsStartDate').value    = n.startDate || '';
  document.getElementById('npsTotalInvested').value= n.totalInvested;
  document.getElementById('npsNav').value          = n.nav;
  document.getElementById('npsUnits').value        = n.unitsHeld;
  document.getElementById('npsCurrentVal').value   = n.currentValue;
  document.getElementById('npsNotes').value        = n.notes || '';
  document.getElementById('npsFormTitle').textContent = 'Edit NPS Account';
  document.querySelector('#page-nps .form-card').scrollIntoView({ behavior: 'smooth' });
}
function deleteNPSConfirm(id) {
  const n = npsAccounts.find(x => x.id === id);
  const m = members.find(x => x.id === n.memberId) || { name: 'Unknown' };
  showConfirm(`Delete NPS ${n.tier} for "${m.name}"? Cannot be undone.`, async () => {
    try {
      showLoading('Deleting…');
      await API.del(`/api/nps/${id}`);
      npsAccounts = npsAccounts.filter(x => x.id !== id);
      renderNPSList(); renderDashboard(); updateGoalViews(); showToast('NPS account deleted.');
    } catch(err) { showToast('Error: ' + err.message, 'error'); }
    finally { hideLoading(); }
  });
}

// ============================================================
//  SIP — Dashboard mini-cards
// ============================================================
const FUND_TYPE_COLORS = {
  Equity:'#2563eb', Index:'#0891b2', Debt:'#16a34a',
  Hybrid:'#7c3aed', ELSS:'#ea580c', Liquid:'#64748b',
  Sectoral:'#be185d', International:'#d97706', Overnight:'#0f766e',
};

function renderSIPDashCards() {
  const el = document.getElementById('sipMemberCards');
  if (!sipFunds.length) { el.innerHTML = '<p class="empty-text">No SIP funds added yet.</p>'; return; }

  // Group by member
  const grouped = {};
  sipFunds.forEach(f => { if (!grouped[f.memberId]) grouped[f.memberId]=[]; grouped[f.memberId].push(f); });

  el.innerHTML = Object.entries(grouped).map(([memberId, funds]) => {
    const member = members.find(m => m.id === memberId) || { name: 'Unknown' };
    const cards  = funds.map(f => {
      const gain = Number(f.currentValue) - Number(f.totalInvested);
      const pct  = f.totalInvested > 0 ? ((gain / f.totalInvested) * 100).toFixed(1) : 0;
      const col  = FUND_TYPE_COLORS[f.fundType] || '#2563eb';
      return `
        <div class="inv-dash-card sip-card" style="border-left-color:${col}">
          <div class="inv-dash-name" style="font-size:.85rem">${f.fundName}</div>
          <div class="inv-dash-sub">${f.fundType} · ${f.amcName || '—'} ${f.isActive ? '· <span class="active-dot">● Active</span>' : '· <span style="color:var(--gray-400)">Stopped</span>'}</div>
          <div class="inv-dash-values" style="margin-top:.4rem">
            <div><span>Invested</span><strong>${fmt(f.totalInvested)}</strong></div>
            <div><span>Current</span><strong>${fmt(f.currentValue)}</strong></div>
            <div><span>Gain</span><strong class="${gain>=0?'pos':'neg'}">${gain>=0?'+':''}${pct}%</strong></div>
          </div>
        </div>`;
    }).join('');
    return `
      <div style="margin-bottom:1rem">
        <div class="inv-dash-member-label">
          <div class="member-avatar" style="background:${memberColor(memberId)};width:24px;height:24px;font-size:.7rem">${initials(member.name)}</div>
          <strong>${member.name}</strong>
        </div>
        <div class="inv-dash-grid">${cards}</div>
      </div>`;
  }).join('');
}

// ============================================================
//  SIP — CRUD page
// ============================================================
function renderSIPList(typeFilter = '') {
  const list = document.getElementById('sipList');
  document.getElementById('sipCount').textContent = sipFunds.length;
  let funds = typeFilter ? sipFunds.filter(f => f.fundType === typeFilter) : sipFunds;
  if (!funds.length) { list.innerHTML = '<p class="empty-text">' + (sipFunds.length ? 'No matches.' : 'No SIP funds yet.') + '</p>'; return; }

  list.innerHTML = funds.map(f => {
    const member = members.find(m => m.id === f.memberId) || { name: 'Unknown' };
    const gain   = Number(f.currentValue) - Number(f.totalInvested);
    const col    = FUND_TYPE_COLORS[f.fundType] || '#2563eb';
    return `
      <div class="inv-card" style="border-left-color:${col}">
        <div class="inv-card-header">
          <div style="flex:1;min-width:0">
            <div class="inv-card-title">${f.fundName}</div>
            <div class="inv-card-sub">${member.name} · ${f.fundType} · ${f.amcName || '—'} · Folio: ${f.folioNumber || '—'}</div>
          </div>
          <div style="display:flex;gap:.3rem;align-items:flex-start;flex-shrink:0">
            <span class="badge ${f.isActive ? 'badge-active' : 'badge-matured'}">${f.isActive ? 'Active' : 'Stopped'}</span>
            ${gainBadge(f.totalInvested, f.currentValue)}
            <button class="btn-icon edit" onclick="editSIP('${f.id}')">✏</button>
            <button class="btn-icon del"  onclick="deleteSIPConfirm('${f.id}')">🗑</button>
          </div>
        </div>
        <div class="inv-card-meta">
          <span>💵 Invested: <strong>${fmt(f.totalInvested)}</strong></span>
          <span>📈 Value: <strong style="color:var(--green)">${fmt(f.currentValue)}</strong></span>
          ${f.monthlyAmount ? `<span>🔁 SIP: ${fmt(f.monthlyAmount)}/mo</span>` : ''}
          <span>🔢 Units: ${Number(f.unitsHeld).toLocaleString('en-IN', {maximumFractionDigits:3})}</span>
          <span>💹 NAV: ₹${Number(f.nav).toFixed(2)}</span>
          <span>📅 Since: ${fmtDate(f.startDate)}</span>
        </div>
        ${f.notes ? `<div class="inv-card-notes">${f.notes}</div>` : ''}
      </div>`;
  }).join('');
}

document.getElementById('sipTypeFilter').addEventListener('change', function () {
  renderSIPList(this.value);
});

document.getElementById('sipForm').addEventListener('submit', async e => {
  e.preventDefault();
  const id = document.getElementById('sipId').value;
  const data = {
    memberId:     document.getElementById('sipMember').value,
    fundName:     document.getElementById('sipFundName').value.trim(),
    fundType:     document.getElementById('sipFundType').value,
    amcName:      document.getElementById('sipAmc').value.trim(),
    folioNumber:  document.getElementById('sipFolio').value.trim(),
    startDate:    document.getElementById('sipStartDate').value,
    monthlyAmount:parseFloat(document.getElementById('sipMonthly').value)  || 0,
    totalInvested:parseFloat(document.getElementById('sipTotalInv').value) || 0,
    nav:          parseFloat(document.getElementById('sipNav').value)       || 0,
    unitsHeld:    parseFloat(document.getElementById('sipUnits').value)     || 0,
    currentValue: parseFloat(document.getElementById('sipCurrentVal').value)|| 0,
    isActive:     document.getElementById('sipIsActive').checked,
    notes:        document.getElementById('sipNotes').value.trim(),
  };
  try {
    showLoading(id ? 'Updating SIP…' : 'Saving SIP…');
    if (id) {
      const updated = await API.put(`/api/sip/${id}`, data);
      sipFunds[sipFunds.findIndex(f => f.id === id)] = updated;
    } else {
      sipFunds.push(await API.post('/api/sip', data));
    }
    clearSIPForm(); renderSIPList(); renderDashboard(); updateGoalViews(); showToast(id ? 'SIP updated.' : 'SIP saved.');
  } catch(err) { showToast('Error: ' + err.message, 'error'); }
  finally { hideLoading(); }
});

document.getElementById('clearSipForm').addEventListener('click', clearSIPForm);
function clearSIPForm() {
  document.getElementById('sipForm').reset();
  document.getElementById('sipId').value = '';
  document.getElementById('sipIsActive').checked = true;
  document.getElementById('sipFormTitle').textContent = 'Add SIP / Fund';
}
function editSIP(id) {
  const f = sipFunds.find(x => x.id === id); if (!f) return;
  document.getElementById('sipId').value          = f.id;
  document.getElementById('sipMember').value      = f.memberId;
  document.getElementById('sipFundName').value    = f.fundName;
  document.getElementById('sipFundType').value    = f.fundType;
  document.getElementById('sipAmc').value         = f.amcName || '';
  document.getElementById('sipFolio').value       = f.folioNumber || '';
  document.getElementById('sipStartDate').value   = f.startDate;
  document.getElementById('sipMonthly').value     = f.monthlyAmount;
  document.getElementById('sipTotalInv').value    = f.totalInvested;
  document.getElementById('sipNav').value         = f.nav;
  document.getElementById('sipUnits').value       = f.unitsHeld;
  document.getElementById('sipCurrentVal').value  = f.currentValue;
  document.getElementById('sipIsActive').checked  = f.isActive;
  document.getElementById('sipNotes').value       = f.notes || '';
  document.getElementById('sipFormTitle').textContent = 'Edit SIP / Fund';
  document.querySelector('#page-sip .form-card').scrollIntoView({ behavior: 'smooth' });
}
function deleteSIPConfirm(id) {
  const f = sipFunds.find(x => x.id === id);
  showConfirm(`Delete "${f.fundName}"? Cannot be undone.`, async () => {
    try {
      showLoading('Deleting…');
      await API.del(`/api/sip/${id}`);
      sipFunds = sipFunds.filter(x => x.id !== id);
      renderSIPList(); renderDashboard(); updateGoalViews(); showToast('SIP deleted.');
    } catch(err) { showToast('Error: ' + err.message, 'error'); }
    finally { hideLoading(); }
  });
}

// ============================================================
//  History / Audit Log
// ============================================================
const ACTION_ICON  = { CREATE:'✅', UPDATE:'✏️', DELETE:'🗑️' };
const ACTION_COLOR = { CREATE:'var(--green)', UPDATE:'var(--blue)', DELETE:'var(--red)' };
const ENTITY_ICON  = { Deposit:'💰', Member:'👤', Account:'🏛', PF:'🏗', NPS:'🎯', SIP:'📈', Goal:'🎯', Other:'📋' };

async function renderHistory() {
  const entity = document.getElementById('historyEntityFilter').value;
  const action = document.getElementById('historyActionFilter').value;
  const el     = document.getElementById('historyTimeline');
  el.innerHTML = '<p class="empty-text">Loading…</p>';
  try {
    let url = '/api/history?limit=500';
    if (entity) url += `&entity=${entity}`;
    let logs = await API.get(url);
    if (action) logs = logs.filter(l => l.action === action);
    document.getElementById('historyCount').textContent = logs.length + ' entries';
    if (!logs.length) {
      el.innerHTML = '<p class="empty-text">No activity recorded yet. Start adding data and it will appear here.</p>';
      return;
    }

    // Group by date
    const groups = {};
    logs.forEach(l => {
      const date = l.createdAt ? l.createdAt.slice(0, 10) : 'Unknown';
      if (!groups[date]) groups[date] = [];
      groups[date].push(l);
    });

    el.innerHTML = Object.entries(groups).map(([date, entries]) => {
      const dateLabel = formatHistoryDate(date);
      const items = entries.map(l => {
        const icon    = ACTION_ICON[l.action]  || '•';
        const color   = ACTION_COLOR[l.action] || 'var(--gray-500)';
        const eIcon   = ENTITY_ICON[l.entity]  || '📋';
        const timeStr = l.createdAt ? l.createdAt.slice(11, 16) : '';
        const actionLabel = l.action === 'CREATE' ? 'Added' : l.action === 'UPDATE' ? 'Edited' : 'Deleted';
        return `
          <div class="history-item">
            <div class="history-dot" style="background:${color}">${icon}</div>
            <div class="history-body">
              <div class="history-title">
                <span class="history-action" style="color:${color}">${actionLabel}</span>
                <span class="history-entity">${eIcon} ${l.entity}</span>
                <strong class="history-label">${l.label || '—'}</strong>
              </div>
              ${l.detail ? `<div class="history-detail">${l.detail}</div>` : ''}
            </div>
            <div class="history-time">${timeStr}</div>
          </div>`;
      }).join('');

      return `
        <div class="history-group">
          <div class="history-date-header">${dateLabel}</div>
          ${items}
        </div>`;
    }).join('');
  } catch(err) {
    el.innerHTML = `<p class="empty-text" style="color:var(--red)">Error loading history: ${err.message}</p>`;
  }
}

function formatHistoryDate(dateStr) {
  if (!dateStr || dateStr === 'Unknown') return 'Unknown Date';
  const d    = new Date(dateStr);
  const now  = new Date();
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate()-1);
  if (d.toDateString() === now.toDateString())       return '📅 Today — ' + d.toLocaleDateString('en-IN', {day:'2-digit',month:'long',year:'numeric'});
  if (d.toDateString() === yesterday.toDateString()) return '📅 Yesterday — ' + d.toLocaleDateString('en-IN', {day:'2-digit',month:'long',year:'numeric'});
  return '📅 ' + d.toLocaleDateString('en-IN', {weekday:'long', day:'2-digit', month:'long', year:'numeric'});
}

document.getElementById('historyEntityFilter').addEventListener('change', renderHistory);
document.getElementById('historyActionFilter').addEventListener('change', renderHistory);
document.getElementById('historyRefreshBtn').addEventListener('click', renderHistory);
document.getElementById('historyClearBtn').addEventListener('click', () => {
  showConfirm('Clear all activity history? This cannot be undone.', async () => {
    try {
      await API.del('/api/history');
      renderHistory();
      showToast('History cleared.');
    } catch(err) { showToast('Error: ' + err.message, 'error'); }
  });
});
