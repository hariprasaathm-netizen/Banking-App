// Quick Node.js test to find which render function crashes
// Runs the pure calculation functions with real data from the server

const http = require('http');

function get(path) {
  return new Promise((resolve, reject) => {
    http.get('http://localhost:3000' + path, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

async function main() {
  const [members, accounts, deposits, pfAccounts, npsAccounts, sipFunds, otherRecords, goals] =
    await Promise.all([
      get('/api/members'), get('/api/accounts'), get('/api/deposits'),
      get('/api/pf'),      get('/api/nps'),      get('/api/sip'),
      get('/api/others'),  get('/api/goals'),
    ]);

  console.log('Data loaded:');
  console.log('  members:', members.length);
  console.log('  accounts:', accounts.length);
  console.log('  deposits:', deposits.length);
  console.log('  pf:', pfAccounts.length);
  console.log('  nps:', npsAccounts.length);
  console.log('  sip:', sipFunds.length);
  console.log('  others:', otherRecords.length);
  console.log('  goals:', goals.length);

  // Replicate key calculations from app.js
  function diffDays(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }
  function today() { return new Date().toISOString().slice(0, 10); }

  function calcMaturityAmount(principal, rate, compounding, startDate, maturityDate) {
    const p = Number(principal), r = Number(rate)/100;
    const days = diffDays(startDate, maturityDate);
    if (days <= 0 || !p || !r) return p;
    if (compounding === 'simple') return p + p * r * (days/365);
    const n = compounding === 'monthly' ? 12 : compounding === 'quarterly' ? 4 : 1;
    return p * Math.pow(1 + r/n, n * days/365);
  }

  function fdStatus(maturityDate) {
    const d = diffDays(today(), maturityDate);
    return d < 0 ? 'matured' : d <= 90 ? 'soon' : 'active';
  }

  function enrichFD(fd) {
    const matDate = fd.maturityDate;
    const matAmt = calcMaturityAmount(fd.principal, fd.rate, fd.compounding, fd.startDate, matDate);
    const member = members.find(m => m.id === fd.memberId) || { name: 'Unknown' };
    const linkedAcct = fd.linkedAccountId ? accounts.find(a => a.id === fd.linkedAccountId) : null;
    return {
      ...fd, maturityAmount: matAmt, interest: matAmt - Number(fd.principal),
      daysLeft: diffDays(today(), matDate), status: fdStatus(matDate),
      memberName: member.name,
      linkedAcct, linkedAcctLabel: linkedAcct ? `${linkedAcct.bank} · ${linkedAcct.acctType}` : '—',
    };
  }

  console.log('\nTesting enrichFD on all deposits...');
  try {
    const enriched = deposits.map(enrichFD);
    const totalInvested = enriched.reduce((s,f) => s + Number(f.principal), 0);
    const totalMaturity = enriched.reduce((s,f) => s + f.maturityAmount, 0);
    console.log('  ✅ enrichFD OK - totalInvested:', totalInvested, 'totalMaturity:', totalMaturity.toFixed(0));
  } catch(e) { console.error('  ❌ enrichFD FAILED:', e.message); }

  console.log('\nTesting portfolio category values...');
  try {
    const enriched = deposits.map(enrichFD);
    const fdCurrent = enriched.reduce((s,f) => s + f.maturityAmount, 0);
    const pfCurrent = pfAccounts.reduce((s,p) => s + Number(p.currentBalance), 0);
    const npsCurrent = npsAccounts.reduce((s,n) => s + Number(n.currentValue), 0);
    const sipCurrent = sipFunds.reduce((s,f) => s + Number(f.currentValue), 0);
    const otherCurrent = otherRecords.reduce((s,o) => s + Number(o.amount), 0);
    console.log('  ✅ category values OK - FD:', fdCurrent.toFixed(0), 'PF:', pfCurrent, 'NPS:', npsCurrent, 'SIP:', sipCurrent);
  } catch(e) { console.error('  ❌ category values FAILED:', e.message); }

  console.log('\nTesting goal calculations...');
  try {
    const enriched = deposits.map(enrichFD);
    const catValues = {
      FD: enriched.reduce((s,f) => s + f.maturityAmount, 0),
      PF: pfAccounts.reduce((s,p) => s + Number(p.currentBalance), 0),
      NPS: npsAccounts.reduce((s,n) => s + Number(n.currentValue), 0),
      SIP: sipFunds.reduce((s,f) => s + Number(f.currentValue), 0),
      Other: otherRecords.reduce((s,o) => s + Number(o.amount), 0),
    };
    catValues.General = catValues.FD + catValues.PF + catValues.NPS + catValues.SIP + catValues.Other;

    function isGoalCategoryLinked(category) {
      const cat = (category || '').trim().toUpperCase();
      return ['FD', 'PF', 'NPS', 'SIP', 'OTHER', 'OTHERS', 'GENERAL'].includes(cat);
    }

    function liveValueForGoal(goal) {
      const cat = (goal.category || '').trim().toUpperCase();
      switch (cat) {
        case 'FD':      return catValues.FD;
        case 'PF':      return catValues.PF;
        case 'NPS':     return catValues.NPS;
        case 'SIP':     return catValues.SIP;
        case 'OTHER':
        case 'OTHERS':  return catValues.Other;
        case 'GENERAL': return catValues.General;
        default:        return Number(goal.currentAmount) || 0;
      }
    }

    goals.forEach(goal => {
      const target = Number(goal.targetAmount) || 0;
      const isLinked = isGoalCategoryLinked(goal.category);
      const staticCurrent = Number(goal.currentAmount) || 0;
      const liveCurrent = isLinked ? liveValueForGoal(goal) : staticCurrent;
      const pct = target > 0 ? Math.min(100, Math.round((liveCurrent/target)*100)) : 0;
      const daysLeft = goal.targetDate ? diffDays(today(), goal.targetDate) : null;
      const status = pct >= 100 ? 'Achieved' : daysLeft !== null && daysLeft < 0 ? 'Overdue' : 'In progress';
      console.log(`  goal "${goal.title}" [${goal.category}]: static=₹${staticCurrent.toLocaleString('en-IN')}, live=₹${Math.round(liveCurrent).toLocaleString('en-IN')} -> ${pct}% (${status})`);
    });
    console.log('  ✅ goals live calculation OK');
  } catch(e) { console.error('  ❌ goals FAILED:', e.message); }

  console.log('\nChecking deposit data integrity...');
  deposits.forEach((d, i) => {
    if (!d.startDate) console.error(`  ❌ deposit[${i}] ${d.id} missing startDate`);
    if (!d.maturityDate) console.error(`  ❌ deposit[${i}] ${d.id} missing maturityDate`);
    if (!d.principal) console.error(`  ❌ deposit[${i}] ${d.id} missing principal`);
    if (!d.rate) console.error(`  ❌ deposit[${i}] ${d.id} missing rate`);
  });
  console.log('  ✅ data integrity check done');
}

main().catch(e => console.error('FATAL:', e));
