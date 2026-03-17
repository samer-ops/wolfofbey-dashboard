#!/usr/bin/env node
/**
 * KPI Dashboard Generator v3
 *
 * Pulls live data from all 6 Close CRM orgs + Teachable. Tabbed per org.
 * Closer leaderboard, setter leaderboard, funnel with drop-off, speed metrics,
 * payment analytics (type + method + avg deal), post-sale/student metrics,
 * lead source, lead status, leads by phone country.
 * Usage: node tools/kpi_dashboard.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const COUNTRIES = [
  { name: 'Lebanon', envKey: 'Lebanon_CLOSE_API_KEY' },
  { name: 'UAE', envKey: 'UAE_Close_API_KEY' },
  { name: 'Iraq', envKey: 'Iraq_Close_API_KEY' },
  { name: 'Jordan', envKey: 'Jordan_Close_API_KEY' },
  { name: 'Saudi Arabia', envKey: 'Saudi_Close_API_KEY' },
  { name: 'Qatar', envKey: 'Qatar_Close_API_KEY' },
];

const PHONE_COUNTRY_MAP = {
  '+961':'Lebanon','+971':'UAE','+964':'Iraq','+962':'Jordan','+966':'Saudi Arabia','+974':'Qatar',
  '+973':'Bahrain','+965':'Kuwait','+968':'Oman','+20':'Egypt','+90':'Turkey','+44':'UK','+1':'USA',
  '+33':'France','+49':'Germany','+91':'India','+92':'Pakistan','+234':'Nigeria','+254':'Kenya',
  '+212':'Morocco','+216':'Tunisia','+213':'Algeria','+249':'Sudan','+963':'Syria','+970':'Palestine',
  '+967':'Yemen','+218':'Libya','+374':'Armenia','+381':'Serbia','+61':'Australia','+7':'Russia',
};
function phoneToCountry(phone) {
  if (!phone) return 'Unknown';
  const p = phone.replace(/\s/g, '');
  for (const len of [4,3,2]) { const pfx = p.substring(0,len); if (PHONE_COUNTRY_MAP[pfx]) return PHONE_COUNTRY_MAP[pfx]; }
  return 'Other';
}

const now = new Date();
// CLI args: --from YYYY-MM-DD --to YYYY-MM-DD
const args = process.argv.slice(2);
const fromIdx = args.indexOf('--from');
const toIdx = args.indexOf('--to');
const monthStart = fromIdx >= 0 && args[fromIdx+1] ? args[fromIdx+1] : new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
const monthEnd = toIdx >= 0 && args[toIdx+1] ? args[toIdx+1] : now.toISOString().split('T')[0];
const monthName = fromIdx >= 0 ? `${monthStart} to ${monthEnd}` : now.toLocaleString('en-US', { month: 'long', year: 'numeric' });

function authH(k) { return 'Basic ' + Buffer.from(k + ':').toString('base64'); }
async function cGet(k, ep) {
  const r = await fetch('https://api.close.com/api/v1' + ep, { headers: { Authorization: authH(k) } });
  return r.ok ? r.json() : null;
}
async function cGetAll(k, ep, lim = 200) {
  let all = [], skip = 0;
  while (true) {
    const sep = ep.includes('?') ? '&' : '?';
    const d = await cGet(k, `${ep}${sep}_limit=${lim}&_skip=${skip}`);
    if (!d?.data?.length) break;
    all = all.concat(d.data);
    if (!d.has_more && (d.total_results == null || all.length >= d.total_results)) break;
    skip += d.data.length;
    if (d.data.length < lim) break;
  }
  return all;
}

async function fetchCountryData(country) {
  const apiKey = process.env[country.envKey];
  if (!apiKey) { console.error(`  No API key for ${country.name}`); return null; }
  console.log(`  Fetching ${country.name}...`);

  const users = (await cGet(apiKey, '/user/'))?.data || [];
  const leadStatuses = (await cGet(apiKey, '/status/lead/'))?.data || [];
  const customFields = (await cGet(apiKey, '/custom_field/lead/'))?.data || [];
  const revenueField = customFields.find(f => f.name === 'Revenue');
  const cashField = customFields.find(f => f.name === 'Cash Collected');
  const utmSourceField = customFields.find(f => f.name === 'UTM Source') || customFields.find(f => f.name === 'Lead Source');
  const offerField = customFields.find(f => f.name === 'Offer made');

  // Activity types
  const actTypes = (await cGet(apiKey, '/custom_activity/'))?.data || [];
  const acrType = actTypes.find(t => t.name.toLowerCase().includes('after call'));
  const setterType = actTypes.find(t => t.name === 'Setter');
  const fullPayType = actTypes.find(t => t.name === 'Full Pay');
  const installmentsType = actTypes.find(t => t.name.includes('Installment'));
  // Get Close Date and Course field IDs from Full Pay or Installments activity type
  let closeDateFieldId = null, courseFieldId = null;
  if (fullPayType) {
    const d = await cGet(apiKey, `/custom_activity/${fullPayType.id}`);
    closeDateFieldId = d?.fields?.find(f => f.name === 'Close Date')?.id;
    courseFieldId = d?.fields?.find(f => f.name === 'Course')?.id;
  } else if (installmentsType) {
    const d = await cGet(apiKey, `/custom_activity/${installmentsType.id}`);
    closeDateFieldId = d?.fields?.find(f => f.name === 'Close Date')?.id;
    courseFieldId = d?.fields?.find(f => f.name === 'Course')?.id;
  }
  let acrOfferFieldId = null;
  if (acrType) {
    const d = await cGet(apiKey, `/custom_activity/${acrType.id}`);
    acrOfferFieldId = d?.fields?.find(f => f.name === 'Made an Offer')?.id;
  }
  let setterNameFieldId = null, setterSourceFieldId = null;
  if (setterType) {
    const d = await cGet(apiKey, `/custom_activity/${setterType.id}`);
    setterNameFieldId = d?.fields?.find(f => f.name === 'Setter')?.id;
    setterSourceFieldId = d?.fields?.find(f => f.name === 'Source')?.id;
  }

  // Lead counts by status
  const leadCountsByStatus = {};
  let totalLeads = 0;
  for (const s of leadStatuses) {
    const r = await cGet(apiKey, `/lead/?query=lead_status:"${s.label}"&_limit=0&_fields=id`);
    leadCountsByStatus[s.label] = r?.total_results || 0;
    totalLeads += leadCountsByStatus[s.label];
  }

  const monthLeads = (await cGet(apiKey, `/lead/?query=created >= "${monthStart}" AND created <= "${monthEnd}"&_limit=0&_fields=id`))?.total_results || 0;

  // Won opps in date range
  const wonOpps = await cGetAll(apiKey, `/opportunity/?status_type=won&date_won__gte=${monthStart}&date_won__lte=${monthEnd}&_fields=id,user_name,user_id,status_label,date_won,date_created,lead_id`);

  // Won opp breakdown by status (Full Pay vs Split Pay etc)
  const wonByStatus = {};
  wonOpps.forEach(o => { wonByStatus[o.status_label] = (wonByStatus[o.status_label] || 0) + 1; });

  // Per-closer data
  const closerData = {};
  const ensureCloser = (c) => { if (!closerData[c]) closerData[c] = { units:0, revenue:0, cash:0, callsBooked:0, callsTaken:0, offersMade:0 }; };

  // Calls booked (Demo Scheduled)
  const demoSched = await cGetAll(apiKey, `/opportunity/?status_label=Demo+Scheduled&date_updated__gte=${monthStart}&date_updated__lte=${monthEnd}T23:59:59&_fields=user_name`);
  demoSched.forEach(o => { const c = o.user_name||'Unassigned'; ensureCloser(c); closerData[c].callsBooked++; });

  // Calls taken (DC/NC + won)
  const dcncOpps = await cGetAll(apiKey, `/opportunity/?status_label=Demo+Completed+%2F+Not+Closed&date_updated__gte=${monthStart}&date_updated__lte=${monthEnd}T23:59:59&_fields=user_name,lead_id`);
  dcncOpps.forEach(o => { const c = o.user_name||'Unassigned'; ensureCloser(c); closerData[c].callsTaken++; });
  wonOpps.forEach(o => { const c = o.user_name||'Unassigned'; ensureCloser(c); closerData[c].callsTaken++; });

  // Units sold = leads with Full Pay OR Installments Plan custom activity where Close Date is in range
  let unitsSold = 0;
  const wonLeadIdsForUnits = [...new Set(wonOpps.map(o=>o.lead_id).filter(Boolean))];
  console.log(`    Checking ${wonLeadIdsForUnits.length} won leads for Full Pay / Installments activities...`);
  for (const lid of wonLeadIdsForUnits) {
    let hasPaymentActivity = false;
    const closeDateKey = closeDateFieldId ? `custom.${closeDateFieldId}` : null;
    const courseKey = courseFieldId ? `custom.${courseFieldId}` : null;
    if (fullPayType) {
      const fp = await cGet(apiKey, `/activity/?lead_id=${lid}&_type=${fullPayType.id}&_limit=1`);
      if (fp?.data?.length > 0) {
        const closeDate = closeDateKey ? fp.data[0][closeDateKey] : null;
        const course = courseKey ? fp.data[0][courseKey] : null;
        if (closeDate && closeDate >= monthStart && closeDate <= monthEnd && course !== 'Dropservicing') hasPaymentActivity = true;
      }
    }
    if (!hasPaymentActivity && installmentsType) {
      const inst = await cGet(apiKey, `/activity/?lead_id=${lid}&_type=${installmentsType.id}&_limit=1`);
      if (inst?.data?.length > 0) {
        const closeDate = closeDateKey ? inst.data[0][closeDateKey] : null;
        const course = courseKey ? inst.data[0][courseKey] : null;
        if (closeDate && closeDate >= monthStart && closeDate <= monthEnd && course !== 'Dropservicing') hasPaymentActivity = true;
      }
    }
    if (hasPaymentActivity) {
      const opp = wonOpps.find(o=>o.lead_id===lid);
      const c = opp?.user_name||'Unassigned';
      ensureCloser(c); closerData[c].units++;
      unitsSold++;
    }
  }

  // Offers made from ACR
  const allCallLeadIds = [...new Set([...dcncOpps.map(o=>o.lead_id),...wonOpps.map(o=>o.lead_id)].filter(Boolean))];
  if (acrType && acrOfferFieldId) {
    for (const lid of allCallLeadIds) {
      const acts = await cGet(apiKey, `/activity/?lead_id=${lid}&_type=${acrType.id}&_limit=10`);
      if (!acts?.data) continue;
      for (const a of acts.data) {
        if (a.date_created >= monthStart && a[`custom.${acrOfferFieldId}`] === 'Yes') {
          const c = a.user_name||'Unassigned'; ensureCloser(c); closerData[c].offersMade++;
        }
      }
    }
  }

  // Revenue + cash per closer + source breakdown + payment methods + speed metrics
  let totalRevenue = 0, totalCash = 0;
  const sourceBreakdown = {};
  const paymentMethodBreakdown = {};
  const speedData = []; // { leadCreated, oppCreated, oppWon }
  const wonLeadIds = [...new Set(wonOpps.map(o=>o.lead_id).filter(Boolean))];
  for (const lid of wonLeadIds) {
    const lead = await cGet(apiKey, `/lead/${lid}/?_fields=custom,display_name,date_created`);
    if (!lead) continue;
    const rev = (revenueField && lead.custom?.[revenueField.name]) || 0;
    const cash = (cashField && lead.custom?.[cashField.name]) || 0;
    const src = (utmSourceField && lead.custom?.[utmSourceField.name]) || 'Unknown';
    const opp = wonOpps.find(o=>o.lead_id===lid);
    const c = opp?.user_name||'Unassigned';
    ensureCloser(c); closerData[c].revenue += rev; closerData[c].cash += cash;
    totalRevenue += rev; totalCash += cash;
    const srcKey = typeof src === 'string' ? src : (Array.isArray(src) ? src[0] : 'Unknown');
    if (!sourceBreakdown[srcKey]) sourceBreakdown[srcKey] = { leads:0, revenue:0 };
    sourceBreakdown[srcKey].leads++; sourceBreakdown[srcKey].revenue += rev;
    // Payment method
    const pm = lead.custom?.['Payment Method'] || 'Unknown';
    const pmKey = typeof pm === 'string' ? pm : (Array.isArray(pm) ? pm[0] : 'Unknown');
    paymentMethodBreakdown[pmKey] = (paymentMethodBreakdown[pmKey] || 0) + 1;
    // Speed metrics
    if (lead.date_created && opp) {
      const leadCreated = new Date(lead.date_created);
      const oppCreated = new Date(opp.date_created || opp.date_won);
      const oppWon = new Date(opp.date_won + 'T23:59:59Z');
      speedData.push({ leadCreated, oppCreated, oppWon });
    }
  }
  // Calculate speed averages
  const DAY_MS = 86400000;
  const speed = { avgLeadToOpp: 0, avgOppToWon: 0, avgLeadToWon: 0, count: speedData.length };
  if (speedData.length > 0) {
    speed.avgLeadToOpp = speedData.reduce((s,d) => s + (d.oppCreated - d.leadCreated) / DAY_MS, 0) / speedData.length;
    speed.avgOppToWon = speedData.reduce((s,d) => s + (d.oppWon - d.oppCreated) / DAY_MS, 0) / speedData.length;
    speed.avgLeadToWon = speedData.reduce((s,d) => s + (d.oppWon - d.leadCreated) / DAY_MS, 0) / speedData.length;
  }
  // Average deal size (based on actual units sold, not won opps)
  const avgDealSize = unitsSold > 0 ? totalRevenue / unitsSold : 0;

  // Setter data - iterate through leads with setter activities this month
  const setterData = {}; // { setterName: { leadsSet, source: { src: count } } }
  if (setterType && setterNameFieldId) {
    // Get leads that had sales call booked or later (proxy for leads setters worked on)
    // Actually, iterate through recent leads to find setter activities
    const recentLeads = await cGetAll(apiKey, `/lead/?query=updated >= "${monthStart}" AND updated <= "${monthEnd}"&_fields=id`);
    // Limit to 300 leads to avoid rate limits
    const leadsToCheck = recentLeads.slice(0, 300);
    for (const lead of leadsToCheck) {
      const acts = await cGet(apiKey, `/activity/?lead_id=${lead.id}&_type=${setterType.id}&_limit=5`);
      if (!acts?.data?.length) continue;
      for (const a of acts.data) {
        if (a.date_created >= monthStart) {
          const sName = a[`custom.${setterNameFieldId}`] || 'Unknown';
          const sSrc = a[`custom.${setterSourceFieldId}`] || 'Unknown';
          if (!setterData[sName]) setterData[sName] = { leadsSet: 0, sources: {} };
          setterData[sName].leadsSet++;
          setterData[sName].sources[sSrc] = (setterData[sName].sources[sSrc] || 0) + 1;
        }
      }
    }
  }

  // Leads by phone country
  const monthLeadsList = await cGetAll(apiKey, `/lead/?query=created >= "${monthStart}" AND created <= "${monthEnd}"&_fields=id,contacts`);
  const leadsByPhoneCountry = {};
  for (const lead of monthLeadsList) {
    const phone = lead.contacts?.[0]?.phones?.[0]?.phone || '';
    const pc = phoneToCountry(phone);
    leadsByPhoneCountry[pc] = (leadsByPhoneCountry[pc] || 0) + 1;
  }

  // Funnel
  const callsBooked = (await cGet(apiKey, `/lead/?query=lead_status:"Sales Call Booked" AND updated >= "${monthStart}" AND updated <= "${monthEnd}"&_limit=0&_fields=id`))?.total_results || 0;
  const dcncCount = (await cGet(apiKey, `/lead/?query=lead_status:"DC/NC" AND updated >= "${monthStart}" AND updated <= "${monthEnd}"&_limit=0&_fields=id`))?.total_results || 0;
  const noShowCount = (await cGet(apiKey, `/lead/?query=lead_status:"No show" AND updated >= "${monthStart}" AND updated <= "${monthEnd}"&_limit=0&_fields=id`))?.total_results || 0;
  let offersCount = 0;
  if (offerField) offersCount = (await cGet(apiKey, `/lead/?query=custom.${offerField.id}:"Yes" AND updated >= "${monthStart}" AND updated <= "${monthEnd}"&_limit=0&_fields=id`))?.total_results || 0;
  // App submitted in date range
  const appSubmitted = (await cGet(apiKey, `/lead/?query=lead_status:"Application Submitted" AND updated >= "${monthStart}" AND updated <= "${monthEnd}"&_limit=0&_fields=id`))?.total_results || 0;

  return {
    name: country.name, totalLeads, monthLeads, leadCountsByStatus,
    wonThisMonth: unitsSold, wonOpps: wonOpps.length, wonByStatus, totalRevenue, totalCash,
    sourceBreakdown, callsBooked, dcnc: dcncCount, noShow: noShowCount, offers: offersCount,
    appSubmitted, closerData, setterData, leadsByPhoneCountry,
    paymentMethodBreakdown, speed, avgDealSize,
  };
}

// ── HTML Helpers ─────────────────────────────────────────────────────

const fmt = (n) => n >= 1000000 ? '$' + (n/1000000).toFixed(2) + 'M' : n >= 1000 ? '$' + (n/1000).toFixed(1) + 'k' : '$' + Math.round(n);
const fN = (n) => n.toLocaleString();

function closerTableHTML(cd) {
  const list = Object.entries(cd).map(([n,d])=>({name:n,...d})).filter(c=>c.callsTaken>0||c.units>0||c.callsBooked>0).sort((a,b)=>b.units-a.units||b.revenue-a.revenue);
  if (!list.length) return '<div class="muted">No closer data</div>';
  const t = list.reduce((s,c)=>({u:s.u+c.units,r:s.r+c.revenue,ca:s.ca+c.cash,b:s.b+c.callsBooked,t:s.t+c.callsTaken,o:s.o+c.offersMade}),{u:0,r:0,ca:0,b:0,t:0,o:0});
  const tCR = t.t>0?Math.round(t.u/t.t*100):0;
  return `<table><thead><tr><th>#</th><th>Employee</th><th class="tc">Sales Call Booked</th><th class="tc">Calls Taken</th><th class="tc">Offers Made</th><th class="tc">Units Sold</th><th class="tc">Closing Rate</th><th class="tr">Revenue</th><th class="tr">Cash</th></tr></thead><tbody>${
    list.map((c,i)=>{const cr=c.callsTaken>0?Math.round(c.units/c.callsTaken*100):0;return `<tr><td class="rank">${i+1}</td><td class="cn">${c.name}</td><td class="tc">${c.callsBooked}</td><td class="tc">${c.callsTaken}</td><td class="tc">${c.offersMade}</td><td class="tc gn">${c.units}</td><td class="tc">${cr}%</td><td class="tr gn">${fmt(c.revenue)}</td><td class="tr bl">${fmt(c.cash)}</td></tr>`;}).join('')
  }</tbody><tfoot><tr class="totrow"><td></td><td class="gl">TOTAL</td><td class="tc b">${t.b}</td><td class="tc b">${t.t}</td><td class="tc b">${t.o}</td><td class="tc b gn">${t.u}</td><td class="tc b">${tCR}%</td><td class="tr b gn">${fmt(t.r)}</td><td class="tr b bl">${fmt(t.ca)}</td></tr></tfoot></table>`;
}

function cashByCloserHTML(cd) {
  const list = Object.entries(cd).map(([n,d])=>({name:n,cash:d.cash||0})).filter(c=>c.cash>0).sort((a,b)=>b.cash-a.cash);
  if (!list.length) return '<div class="muted">No cash data</div>';
  return list.map((c,i)=>`<div class="cash-row"><span class="cash-rank">${i+1}</span><span class="cash-name">${c.name}</span><span class="cash-val">${fmt(c.cash)}</span></div>`).join('');
}

function donutHTML(cd, totalRev) {
  const list = Object.entries(cd).map(([n,d])=>({name:n,revenue:d.revenue||0})).filter(c=>c.revenue>0).sort((a,b)=>b.revenue-a.revenue).slice(0,7);
  const colors = ['#1372D3','#27AE60','#F5A623','#CA2029','#9B59B6','#E67E22','#1ABC9C'];
  let parts=[],cum=0;
  list.forEach((c,i)=>{const p=totalRev>0?c.revenue/totalRev*100:0;parts.push(`${colors[i%7]} ${cum}% ${cum+p}%`);cum+=p;});
  if(cum<100) parts.push(`#1E2A35 ${cum}% 100%`);
  const leg = list.map((c,i)=>{const p=totalRev>0?Math.round(c.revenue/totalRev*100):0;return `<div class="lg-i"><span class="lg-d" style="background:${colors[i%7]}"></span><span class="lg-n">${c.name}</span><span class="lg-v">${fmt(c.revenue)} (${p}%)</span></div>`;}).join('');
  return `<div class="don-w"><div class="don" style="background:conic-gradient(${parts.join(',')})"><div class="don-c"><div class="don-t">${fmt(totalRev)}</div><div class="don-l">Total</div></div></div><div class="lg">${leg}</div></div>`;
}

function phoneCountryHTML(lbpc) {
  const sorted = Object.entries(lbpc).sort((a,b)=>b[1]-a[1]);
  if (!sorted.length) return '<div class="muted">No phone data</div>';
  const total = sorted.reduce((s,[,c])=>s+c,0);
  return sorted.slice(0,12).map(([c,n])=>{const p=total>0?Math.round(n/total*100):0;return `<div class="pb-r"><span class="pb-n">${c}</span><div class="pb-bg"><div class="pb-b" style="width:${Math.max(p,1)}%"></div></div><span class="pb-c">${n}</span><span class="pb-p">${p}%</span></div>`;}).join('');
}

function setterTableHTML(sd) {
  const list = Object.entries(sd).map(([n,d])=>({name:n,...d})).filter(s=>s.name!=='No Setter'&&s.leadsSet>0).sort((a,b)=>b.leadsSet-a.leadsSet);
  if (!list.length) return '<div class="muted">No setter data</div>';
  const total = list.reduce((s,c)=>s+c.leadsSet,0);
  return `<table><thead><tr><th>#</th><th>Setter</th><th class="tc">Leads Set</th><th class="tc">Share</th><th>Top Source</th></tr></thead><tbody>${
    list.map((s,i)=>{const topSrc=Object.entries(s.sources).sort((a,b)=>b[1]-a[1])[0];return `<tr><td class="rank">${i+1}</td><td class="cn">${s.name}</td><td class="tc">${s.leadsSet}</td><td class="tc">${total>0?Math.round(s.leadsSet/total*100):0}%</td><td>${topSrc?topSrc[0]+' ('+topSrc[1]+')':'-'}</td></tr>`;}).join('')
  }</tbody><tfoot><tr class="totrow"><td></td><td class="gl">TOTAL</td><td class="tc b">${total}</td><td class="tc b">100%</td><td></td></tr></tfoot></table>`;
}

function funnelHTML(data) {
  const stages = [
    { l:'New Leads', v:data.monthLeads, c:'#1372D3' },
    { l:'App Submitted', v:data.appSubmitted, c:'#9B59B6' },
    { l:'Calls Booked', v:data.callsBooked, c:'#F5A623' },
    { l:'Offers Made', v:data.offers, c:'#E67E22' },
    { l:'Units Sold', v:data.wonThisMonth, c:'#27AE60' },
  ];
  const mx = Math.max(...stages.map(s=>s.v),1);
  return stages.map((s,i)=>{
    const w=Math.max(s.v/mx*100,2);
    const prev = i > 0 ? stages[i-1].v : 0;
    const dropoff = prev > 0 ? Math.round((1 - s.v/prev) * 100) : 0;
    const dropLabel = i > 0 && prev > 0 ? `<span class="fn-drop">${dropoff > 0 ? '-' + dropoff + '%' : '0%'}</span>` : '';
    return `<div class="fn-r"><span class="fn-l">${s.l}</span><div class="fn-bg"><div class="fn-b" style="width:${w}%;background:${s.c}">${fN(s.v)}</div></div>${dropLabel}</div>`;
  }).join('');
}

function statusDistHTML(lcs, totalLeads) {
  const sorted = Object.entries(lcs).sort((a,b)=>b[1]-a[1]).slice(0,10);
  const colorMap = {'Closed':'#27AE60','Engine student':'#27AE60','Sales Call Booked':'#1372D3','Application Submitted':'#9B59B6','DC/NC':'#CA2029','Canceled':'#CA2029','Bad Fit':'#CA2029','No show':'#F5A623','Rescheduled':'#F5A623','Opt In':'#8899AA','Deposit':'#1ABC9C'};
  return sorted.map(([l,c])=>{const p=totalLeads>0?(c/totalLeads*100).toFixed(1):0;return `<div class="st-r"><span class="st-l">${l}</span><div class="st-bg"><div class="st-b" style="width:${Math.min(p*2,100)}%;background:${colorMap[l]||'#8899AA'}"></div></div><span class="st-c">${fN(c)}</span></div>`;}).join('');
}

function paymentMixHTML(wonByStatus) {
  const entries = Object.entries(wonByStatus).sort((a,b)=>b[1]-a[1]);
  if (!entries.length) return '<div class="muted">No payment data</div>';
  const total = entries.reduce((s,[,c])=>s+c,0);
  const colors = {'Full Pay':'#27AE60','Split Pay':'#1372D3','Follow Up Won':'#F5A623','Won':'#9B59B6'};
  return entries.map(([label,count])=>{const p=total>0?Math.round(count/total*100):0;return `<div class="pm-r"><span class="pm-l">${label}</span><div class="pm-bg"><div class="pm-b" style="width:${p}%;background:${colors[label]||'#8899AA'}"></div></div><span class="pm-c">${count} (${p}%)</span></div>`;}).join('');
}

function speedMetricsHTML(speed) {
  if (!speed || speed.count === 0) return '<div class="muted">No speed data (need won opps this month)</div>';
  const fmtD = d => d < 1 ? '<1 day' : d.toFixed(1) + ' days';
  return `<div class="speed-grid">
    <div class="speed-card"><div class="speed-val blue">${fmtD(speed.avgLeadToOpp)}</div><div class="speed-lbl">Lead Created to Opp Created</div></div>
    <div class="speed-card"><div class="speed-val gold">${fmtD(speed.avgOppToWon)}</div><div class="speed-lbl">Opp Created to Won</div></div>
    <div class="speed-card"><div class="speed-val green">${fmtD(speed.avgLeadToWon)}</div><div class="speed-lbl">Lead to Close (Total Cycle)</div></div>
    <div class="speed-card"><div class="speed-val white">${speed.count}</div><div class="speed-lbl">Won Opps Measured</div></div>
  </div>`;
}

function paymentMethodHTML(pmb) {
  const entries = Object.entries(pmb || {}).filter(([k]) => k && k !== 'Unknown').sort((a,b) => b[1] - a[1]);
  if (!entries.length) return '<div class="muted">No payment method data</div>';
  const total = entries.reduce((s,[,c]) => s + c, 0);
  const colors = {'Stripe':'#6772E5','Cash':'#27AE60','Bank Transfer':'#1372D3','Whish':'#F5A623','MontyPay':'#9B59B6','Areeba Lebanon':'#E67E22','Areeba Dubai':'#E67E22','BOB':'#1ABC9C','Tabby - KSA':'#CA2029','Tabby - UAE':'#CA2029','Crypto':'#F7931A','Splitit':'#00C1D4','OMT':'#FF6B00'};
  return entries.map(([label,count]) => {
    const p = total > 0 ? Math.round(count/total*100) : 0;
    return `<div class="pm-r"><span class="pm-l">${label}</span><div class="pm-bg"><div class="pm-b" style="width:${Math.max(p,3)}%;background:${colors[label]||'#8899AA'}"></div></div><span class="pm-c">${count} (${p}%)</span></div>`;
  }).join('');
}

function teachableHTML(td) {
  if (!td) return '<div class="muted">No Teachable data</div>';
  return `<div class="teach-summary"><div class="speed-card"><div class="speed-val blue">${fN(td.totalUsers)}</div><div class="speed-lbl">Total Students</div></div></div>
  <table><thead><tr><th>Course</th><th class="tc">Enrolled</th><th class="tc">Avg Progress</th><th class="tc">Completion Rate</th><th class="tc">Active (&gt;0%)</th></tr></thead><tbody>${
    td.courses.map(c => `<tr><td class="cn">${c.name}</td><td class="tc">${fN(c.totalEnrolled)}</td><td class="tc">${c.avgProgress.toFixed(1)}%</td><td class="tc ${c.completionRate > 5 ? 'gn' : 'red'}">${c.completionRate.toFixed(1)}%</td><td class="tc">${c.activeRate.toFixed(0)}%</td></tr>`).join('')
  }</tbody></table><div class="muted" style="margin-top:8px">Completion/progress sampled from ${td.courses[0]?.sampled || 0} students per course</div>`;
}

function avgDealHTML(avgDeal, totalRev, wonCount) {
  return `<div class="speed-grid">
    <div class="speed-card"><div class="speed-val green">${fmt(avgDeal)}</div><div class="speed-lbl">Avg Deal Size</div></div>
    <div class="speed-card"><div class="speed-val blue">${fmt(totalRev)}</div><div class="speed-lbl">Total Revenue</div></div>
    <div class="speed-card"><div class="speed-val gold">${wonCount}</div><div class="speed-lbl">Units Sold</div></div>
  </div>`;
}

function sourceHTML(sb) {
  const list = Object.entries(sb).filter(([k])=>k&&k!=='Unknown'&&k!=='').sort((a,b)=>b[1].revenue-a[1].revenue);
  if (!list.length) return '<div class="muted">No source data</div>';
  return list.map(([n,d])=>`<div class="sr-r"><span class="sr-n">${n}</span><span class="sr-c">${d.leads} sold</span><span class="sr-v">${fmt(d.revenue)}</span></div>`).join('');
}

function buildOrgTab(d) {
  if (!d) return '<div class="muted">No data</div>';
  const cr = d.callsBooked>0?Math.round(d.wonThisMonth/d.callsBooked*100):0;
  return `
  <div class="sum-row">
    <div class="sc"><div class="sc-n green">${fmt(d.totalRevenue)}</div><div class="sc-l">Revenue</div></div>
    <div class="sc"><div class="sc-n blue">${fmt(d.totalCash)}</div><div class="sc-l">Cash</div></div>
    <div class="sc"><div class="sc-n gold">${d.wonThisMonth}</div><div class="sc-l">Units Sold</div></div>
    <div class="sc"><div class="sc-n white">${fN(d.monthLeads)}</div><div class="sc-l">New Leads</div></div>
    <div class="sc"><div class="sc-n green">${cr}%</div><div class="sc-l">Close Rate</div></div>
    <div class="sc"><div class="sc-n red">${d.noShow}</div><div class="sc-l">No Shows</div></div>
  </div>
  <div class="crd"><h3>Closer Leaderboard</h3>${closerTableHTML(d.closerData)}</div>
  <div class="two-col">
    <div class="crd"><h3>Revenue by Closer</h3>${donutHTML(d.closerData, d.totalRevenue)}<h3 style="margin-top:20px">Cash Collected by Closer</h3>${cashByCloserHTML(d.closerData)}</div>
    <div class="crd"><h3>Setter Leaderboard</h3>${setterTableHTML(d.setterData)}</div>
  </div>
  <div class="two-col">
    <div class="crd"><h3>Sales Funnel</h3>${funnelHTML(d)}</div>
    <div class="crd"><h3>Leads by Country (Phone)</h3>${phoneCountryHTML(d.leadsByPhoneCountry)}</div>
  </div>
  <div class="two-col">
    <div class="crd"><h3>Speed Metrics <span class="sub">Avg Sales Cycle</span></h3>${speedMetricsHTML(d.speed)}</div>
    <div class="crd"><h3>Deal Analytics <span class="sub">${monthName}</span></h3>${avgDealHTML(d.avgDealSize, d.totalRevenue, d.wonThisMonth)}</div>
  </div>
  <div class="three-col">
    <div class="crd"><h3>Lead Source (Won)</h3>${sourceHTML(d.sourceBreakdown)}</div>
    <div class="crd"><h3>Payment Type Mix</h3>${paymentMixHTML(d.wonByStatus)}</div>
    <div class="crd"><h3>Payment Method</h3>${paymentMethodHTML(d.paymentMethodBreakdown)}</div>
  </div>
  <div class="crd"><h3>Lead Status Distribution</h3>${statusDistHTML(d.leadCountsByStatus, d.totalLeads)}</div>`;
}

function generateHTML(data, teachable) {
  // Aggregate
  const T = {leads:0,mLeads:0,won:0,rev:0,cash:0,booked:0,dcnc:0,noShow:0,offers:0,appSub:0};
  const allClosers={}, allSetters={}, allPhoneC={}, allStatuses={}, allSources={}, allWonByStatus={}, allPayMethods={};
  const allSpeedData = [];
  for (const c of data) {
    if (!c) continue;
    T.leads+=c.totalLeads; T.mLeads+=c.monthLeads; T.won+=c.wonThisMonth; T.rev+=c.totalRevenue; T.cash+=c.totalCash;
    T.booked+=c.callsBooked; T.dcnc+=c.dcnc; T.noShow+=c.noShow; T.offers+=c.offers; T.appSub+=c.appSubmitted;
    for (const [k,d] of Object.entries(c.closerData||{})) {
      if (!allClosers[k]) allClosers[k]={units:0,revenue:0,cash:0,callsBooked:0,callsTaken:0,offersMade:0};
      allClosers[k].units+=d.units; allClosers[k].revenue+=d.revenue; allClosers[k].cash+=d.cash;
      allClosers[k].callsBooked+=d.callsBooked; allClosers[k].callsTaken+=d.callsTaken; allClosers[k].offersMade+=d.offersMade;
    }
    for (const [k,d] of Object.entries(c.setterData||{})) {
      if (!allSetters[k]) allSetters[k]={leadsSet:0,sources:{}};
      allSetters[k].leadsSet+=d.leadsSet;
      for (const [s,n] of Object.entries(d.sources||{})) allSetters[k].sources[s]=(allSetters[k].sources[s]||0)+n;
    }
    for (const [k,n] of Object.entries(c.leadsByPhoneCountry||{})) allPhoneC[k]=(allPhoneC[k]||0)+n;
    for (const [k,n] of Object.entries(c.leadCountsByStatus||{})) allStatuses[k]=(allStatuses[k]||0)+n;
    for (const [k,d] of Object.entries(c.sourceBreakdown||{})) {
      if (!allSources[k]) allSources[k]={leads:0,revenue:0};
      allSources[k].leads+=d.leads; allSources[k].revenue+=d.revenue;
    }
    for (const [k,n] of Object.entries(c.wonByStatus||{})) allWonByStatus[k]=(allWonByStatus[k]||0)+n;
    for (const [k,n] of Object.entries(c.paymentMethodBreakdown||{})) allPayMethods[k]=(allPayMethods[k]||0)+n;
    if (c.speed?.count > 0) allSpeedData.push(c.speed);
  }
  const tCR = T.booked>0?Math.round(T.won/T.booked*100):0;
  const avgDealAll = T.won > 0 ? T.rev / T.won : 0;
  // Aggregate speed: weighted average across orgs
  const totalSpeedCount = allSpeedData.reduce((s,d) => s + d.count, 0);
  const aggSpeed = { count: totalSpeedCount, avgLeadToOpp: 0, avgOppToWon: 0, avgLeadToWon: 0 };
  if (totalSpeedCount > 0) {
    aggSpeed.avgLeadToOpp = allSpeedData.reduce((s,d) => s + d.avgLeadToOpp * d.count, 0) / totalSpeedCount;
    aggSpeed.avgOppToWon = allSpeedData.reduce((s,d) => s + d.avgOppToWon * d.count, 0) / totalSpeedCount;
    aggSpeed.avgLeadToWon = allSpeedData.reduce((s,d) => s + d.avgLeadToWon * d.count, 0) / totalSpeedCount;
  }

  // Country perf table
  const cpRows = data.filter(Boolean).map(c=>{const cr=c.callsBooked>0?Math.round(c.wonThisMonth/c.callsBooked*100):0;return `<tr><td class="cn">${c.name}</td><td class="tc">${fN(c.monthLeads)}</td><td class="tc">${c.callsBooked}</td><td class="tc">${c.offers}</td><td class="tc gn">${c.wonThisMonth}</td><td class="tr b">${fmt(c.totalRevenue)}</td><td class="tr bl">${fmt(c.totalCash)}</td><td class="tc">${cr}%</td><td class="tc red">${c.noShow}</td><td class="tc gold">${c.dcnc}</td></tr>`;}).join('');

  // Tabs
  const tabs = [{id:'overview',label:'Overview'}];
  data.filter(Boolean).forEach(c=>tabs.push({id:c.name.replace(/\s/g,'-').toLowerCase(),label:c.name}));
  const tabBtns = tabs.map((t,i)=>`<button class="tab-btn${i===0?' active':''}" onclick="showTab('${t.id}',this)">${t.label}</button>`).join('');

  const overviewHTML = `
  <div class="sum-row">
    <div class="sc"><div class="sc-n green">${fmt(T.rev)}</div><div class="sc-l">Total Revenue</div></div>
    <div class="sc"><div class="sc-n blue">${fmt(T.cash)}</div><div class="sc-l">Cash Collected</div></div>
    <div class="sc"><div class="sc-n gold">${T.won}</div><div class="sc-l">Units Sold</div></div>
    <div class="sc"><div class="sc-n white">${fN(T.mLeads)}</div><div class="sc-l">New Leads</div></div>
    <div class="sc"><div class="sc-n green">${tCR}%</div><div class="sc-l">Close Rate</div></div>
    <div class="sc"><div class="sc-n red">${T.noShow}</div><div class="sc-l">No Shows</div></div>
  </div>
  <div class="crd"><h3>Closer Leaderboard <span class="sub">${monthName}</span></h3>${closerTableHTML(allClosers)}</div>
  <div class="two-col">
    <div class="crd"><h3>Revenue by Closer</h3>${donutHTML(allClosers,T.rev)}<h3 style="margin-top:20px">Cash Collected by Closer</h3>${cashByCloserHTML(allClosers)}</div>
    <div class="crd"><h3>Setter Leaderboard <span class="sub">${monthName}</span></h3>${setterTableHTML(allSetters)}</div>
  </div>
  <div class="two-col">
    <div class="crd"><h3>Sales Funnel <span class="sub">${monthName}</span></h3>${funnelHTML({monthLeads:T.mLeads,appSubmitted:T.appSub,callsBooked:T.booked,offers:T.offers,wonThisMonth:T.won})}<div class="fn-note">Drop-off: Leads to Booked ${T.mLeads>0?Math.round(T.booked/T.mLeads*100):0}% | Booked to Won ${T.booked>0?Math.round(T.won/T.booked*100):0}%</div></div>
    <div class="crd"><h3>Leads by Country (Phone) <span class="sub">This Month</span></h3>${phoneCountryHTML(allPhoneC)}</div>
  </div>
  <div class="crd"><h3>Country Performance <span class="sub">${monthName}</span></h3>
    <table><thead><tr><th>Country</th><th class="tc">New Leads</th><th class="tc">Calls Booked</th><th class="tc">Offers</th><th class="tc">Won</th><th class="tr">Revenue</th><th class="tr">Cash</th><th class="tc">Close Rate</th><th class="tc">No Show</th><th class="tc">DC/NC</th></tr></thead>
    <tbody>${cpRows}</tbody>
    <tfoot><tr class="totrow"><td class="gl">TOTAL</td><td class="tc b">${fN(T.mLeads)}</td><td class="tc b">${T.booked}</td><td class="tc b">${T.offers}</td><td class="tc b gn">${T.won}</td><td class="tr b">${fmt(T.rev)}</td><td class="tr b bl">${fmt(T.cash)}</td><td class="tc b">${tCR}%</td><td class="tc b red">${T.noShow}</td><td class="tc b gold">${T.dcnc}</td></tr></tfoot></table>
  </div>
  <div class="two-col">
    <div class="crd"><h3>Speed Metrics <span class="sub">Avg Sales Cycle</span></h3>${speedMetricsHTML(aggSpeed)}</div>
    <div class="crd"><h3>Deal Analytics <span class="sub">${monthName}</span></h3>${avgDealHTML(avgDealAll, T.rev, T.won)}</div>
  </div>
  <div class="three-col">
    <div class="crd"><h3>Lead Source (Won)</h3>${sourceHTML(allSources)}</div>
    <div class="crd"><h3>Payment Type Mix</h3>${paymentMixHTML(allWonByStatus)}</div>
    <div class="crd"><h3>Payment Method</h3>${paymentMethodHTML(allPayMethods)}</div>
  </div>
  ${teachable ? '<div class="crd"><h3>Post-Sale: Student Metrics <span class="sub">Teachable</span></h3>' + teachableHTML(teachable) + '</div>' : ''}
  <div class="crd"><h3>Lead Status Distribution</h3>${statusDistHTML(allStatuses, T.leads)}</div>`;

  const orgTabs = data.filter(Boolean).map(c=>`<div id="tab-${c.name.replace(/\s/g,'-').toLowerCase()}" class="tab-content" style="display:none">${buildOrgTab(c)}</div>`).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Wolfofbey Sales KPIs</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0C1115;color:#E8E8E8;min-height:100vh;padding:24px}
.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding-bottom:14px;border-bottom:1px solid #1E2A35}
.header h1{font-size:24px;font-weight:700;color:#fff}.header h1 span{color:#1372D3}
.header-meta{text-align:right;font-size:12px;color:#8899AA}.header-meta strong{color:#F5A623}
.green,.gn{color:#27AE60}.blue,.bl{color:#1372D3}.gold{color:#F5A623}.red{color:#CA2029}.white{color:#fff}
.b{font-weight:700}
.tab-bar{display:flex;gap:2px;margin-bottom:20px;border-bottom:2px solid #1E2A35}
.tab-btn{background:none;border:none;color:#8899AA;font-size:13px;font-weight:600;padding:9px 16px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px;transition:.2s}
.tab-btn:hover{color:#E8E8E8}.tab-btn.active{color:#1372D3;border-bottom-color:#1372D3}
.sum-row{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:16px}
.sc{background:#141C24;border:1px solid #1E2A35;border-radius:10px;padding:14px;text-align:center}
.sc-n{font-size:26px;font-weight:700;margin-bottom:2px}.sc-l{font-size:10px;color:#8899AA;text-transform:uppercase;letter-spacing:.8px}
.crd{background:#141C24;border:1px solid #1E2A35;border-radius:10px;padding:18px;margin-bottom:14px}
.crd h3{font-size:14px;font-weight:600;color:#fff;margin-bottom:12px}.crd h3 .sub{font-size:11px;color:#8899AA;font-weight:400;margin-left:6px}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
.three-col{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:14px}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:7px 8px;font-size:10px;text-transform:uppercase;letter-spacing:.7px;color:#8899AA;border-bottom:1px solid #1E2A35}
td{padding:7px 8px;font-size:12px;border-bottom:1px solid #131A22}
tr:hover{background:#182028}.cn{font-weight:600;color:#fff}.tc{text-align:center}.tr{text-align:right}
.rank{color:#F5A623;font-weight:700;width:24px}.totrow{border-top:2px solid #1E2A35}.gl{font-weight:700;color:#F5A623}
.muted{color:#8899AA;font-size:12px;padding:10px 0}
.don-w{display:flex;align-items:center;gap:14px}
.don{width:110px;height:110px;border-radius:50%;position:relative;flex-shrink:0}
.don::after{content:'';position:absolute;top:26px;left:26px;width:58px;height:58px;border-radius:50%;background:#141C24}
.don-c{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:1;text-align:center}
.don-t{font-size:14px;font-weight:700;color:#fff}.don-l{font-size:9px;color:#8899AA}
.lg{flex:1}.lg-i{display:flex;align-items:center;gap:5px;padding:2px 0;font-size:11px}
.lg-d{width:8px;height:8px;border-radius:50%;flex-shrink:0}.lg-n{flex:1;color:#C0C8D0}.lg-v{color:#8899AA;font-size:10px}
.cash-row{display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #131A22}
.cash-row:last-child{border-bottom:none}
.cash-rank{color:#F5A623;font-weight:700;width:20px;font-size:11px;text-align:center}
.cash-name{flex:1;font-size:12px;color:#C0C8D0}.cash-val{font-size:13px;font-weight:600;color:#1372D3}
.pb-r{display:flex;align-items:center;gap:5px;margin-bottom:4px}
.pb-n{width:90px;font-size:11px;color:#C0C8D0;text-align:right;flex-shrink:0}
.pb-bg{flex:1;height:13px;background:#1E2A35;border-radius:3px;overflow:hidden}
.pb-b{height:100%;background:#1372D3;border-radius:3px}
.pb-c{width:30px;font-size:10px;color:#8899AA;text-align:right}.pb-p{width:28px;font-size:10px;color:#556677;text-align:right}
.fn-r{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.fn-l{width:110px;font-size:11px;color:#C0C8D0;text-align:right;flex-shrink:0}
.fn-bg{flex:1;height:26px;background:#1E2A35;border-radius:5px;overflow:hidden}
.fn-b{height:100%;border-radius:5px;display:flex;align-items:center;padding-left:8px;font-size:11px;font-weight:700;color:#fff;min-width:35px}
.fn-note{margin-top:12px;padding-top:10px;border-top:1px solid #1E2A35;font-size:10px;color:#8899AA}
.st-r{display:flex;align-items:center;gap:6px;margin-bottom:5px}
.st-l{width:130px;font-size:11px;color:#C0C8D0;text-align:right;flex-shrink:0}
.st-bg{flex:1;height:14px;background:#1E2A35;border-radius:3px;overflow:hidden}
.st-b{height:100%;border-radius:3px}.st-c{width:50px;font-size:10px;color:#8899AA;text-align:right}
.pm-r{display:flex;align-items:center;gap:6px;margin-bottom:8px}
.pm-l{width:110px;font-size:11px;color:#C0C8D0;text-align:right;flex-shrink:0}
.pm-bg{flex:1;height:18px;background:#1E2A35;border-radius:4px;overflow:hidden}
.pm-b{height:100%;border-radius:4px}.pm-c{width:70px;font-size:11px;color:#8899AA;text-align:right}
.sr-r{display:flex;align-items:center;padding:7px 0;border-bottom:1px solid #131A22}
.sr-r:last-child{border-bottom:none}
.sr-n{flex:1;font-size:12px;font-weight:500;color:#fff}.sr-c{font-size:11px;color:#8899AA;margin-right:12px}
.sr-v{font-size:12px;font-weight:600;color:#27AE60;min-width:55px;text-align:right}
.speed-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
.speed-card{background:#0C1115;border:1px solid #1E2A35;border-radius:8px;padding:12px;text-align:center}
.speed-val{font-size:20px;font-weight:700;margin-bottom:3px}
.speed-lbl{font-size:9px;color:#8899AA;text-transform:uppercase;letter-spacing:.6px}
.fn-drop{font-size:10px;color:#CA2029;font-weight:600;width:42px;text-align:right;flex-shrink:0}
.teach-summary{margin-bottom:12px}
.filter-bar{display:flex;align-items:center;gap:8px;margin-bottom:18px;padding:10px 14px;background:#141C24;border:1px solid #1E2A35;border-radius:8px;flex-wrap:wrap}
.filter-label{font-size:11px;color:#8899AA;font-weight:600}
.filter-btn{background:#1E2A35;border:1px solid #2A3A4A;color:#C0C8D0;font-size:11px;padding:5px 12px;border-radius:5px;cursor:pointer;transition:.2s}
.filter-btn:hover{background:#2A3A4A;color:#fff}.filter-btn.active{background:#1372D3;border-color:#1372D3;color:#fff}
.filter-sep{color:#2A3A4A;font-size:14px}
.filter-date{background:#0C1115;border:1px solid #2A3A4A;color:#E8E8E8;font-size:11px;padding:4px 8px;border-radius:4px}
.filter-go{background:#27AE60;border-color:#27AE60;color:#fff}.filter-go:hover{background:#2ecc71}
.filter-cmd{margin-top:6px;width:100%;font-size:11px;color:#F5A623;background:#0C1115;padding:8px 12px;border-radius:4px;font-family:monospace;user-select:all}
.footer{text-align:center;padding:16px;font-size:10px;color:#556677}
@media(max-width:1100px){.sum-row{grid-template-columns:repeat(3,1fr)}.two-col,.three-col{grid-template-columns:1fr}}
</style></head><body>
<div class="header"><h1><span>Wolfofbey</span> Sales KPI Dashboard</h1><div class="header-meta"><div>Period: <strong>${monthName}</strong></div><div>Generated: <strong>${now.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</strong></div></div></div>
<div class="filter-bar">
  <span class="filter-label">Period:</span>
  <button class="filter-btn${fromIdx<0?' active':''}" onclick="runFilter('this-month')">This Month</button>
  <button class="filter-btn" onclick="runFilter('last-month')">Last Month</button>
  <button class="filter-btn" onclick="runFilter('last-3')">Last 3 Months</button>
  <button class="filter-btn" onclick="runFilter('ytd')">Year to Date</button>
  <button class="filter-btn" onclick="runFilter('all')">All Time</button>
  <span class="filter-sep">|</span>
  <label class="filter-label">From</label><input type="date" id="date-from" class="filter-date" value="${monthStart}">
  <label class="filter-label">To</label><input type="date" id="date-to" class="filter-date" value="${monthEnd}">
  <button class="filter-btn filter-go" onclick="runFilter('custom')">Apply</button>
  <div id="filter-cmd" class="filter-cmd" style="display:none"></div>
</div>
<div class="tab-bar">${tabBtns}</div>
<div id="tab-overview" class="tab-content">${overviewHTML}</div>
${orgTabs}
<div class="footer">Wolfofbey Sales KPI Dashboard - Live Close CRM (6 orgs) - ${now.toISOString().split('T')[0]} - Powered by Claude Code</div>
<script>
function showTab(id,btn){document.querySelectorAll('.tab-content').forEach(e=>e.style.display='none');document.querySelectorAll('.tab-btn').forEach(e=>e.classList.remove('active'));document.getElementById('tab-'+id).style.display='block';btn.classList.add('active');}
function runFilter(preset){
  const now=new Date(),y=now.getFullYear(),m=now.getMonth();
  let from,to=now.toISOString().split('T')[0];
  if(preset==='this-month') from=new Date(y,m,1).toISOString().split('T')[0];
  else if(preset==='last-month'){from=new Date(y,m-1,1).toISOString().split('T')[0];to=new Date(y,m,0).toISOString().split('T')[0];}
  else if(preset==='last-3') from=new Date(y,m-2,1).toISOString().split('T')[0];
  else if(preset==='ytd') from=y+'-01-01';
  else if(preset==='all') from='2020-01-01';
  else{from=document.getElementById('date-from').value;to=document.getElementById('date-to').value;}
  document.getElementById('date-from').value=from;
  document.getElementById('date-to').value=to;
  document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
  if(preset!=='custom')event.target.classList.add('active');
  const cmd='node tools/kpi_dashboard.js --from '+from+' --to '+to;
  const el=document.getElementById('filter-cmd');
  el.style.display='block';
  el.textContent='Run: '+cmd;
  navigator.clipboard.writeText(cmd).catch(()=>{});
}
</script>
</body></html>`;
}

async function fetchTeachableData() {
  const apiKey = process.env.TEACHABLE_API_KEY;
  if (!apiKey) { console.log('  No Teachable API key'); return null; }
  console.log('  Fetching Teachable data...');
  const headers = { apiKey };
  const courses = [
    { id: 2550705, name: 'Engine 2.5' },
    { id: 1970075, name: 'Digital Empire 2.0' },
    { id: 2886758, name: 'School of Selling' },
    { id: 2939871, name: 'Engine Arabia' },
  ];
  const courseData = [];
  for (const course of courses) {
    const meta = await (await fetch(`https://developers.teachable.com/v1/courses/${course.id}/enrollments?per=1`, { headers })).json();
    const totalEnrolled = meta.meta?.total || 0;
    // Sample 3 pages to estimate completion
    let sampled = 0, sumPct = 0, completed = 0, active = 0;
    for (const pg of [1, Math.max(1, Math.floor(totalEnrolled/40)), Math.max(1, Math.floor(totalEnrolled/20))]) {
      const enr = await (await fetch(`https://developers.teachable.com/v1/courses/${course.id}/enrollments?per=20&page=${pg}`, { headers })).json();
      if (!enr.enrollments?.length) break;
      for (const e of enr.enrollments) {
        sampled++;
        sumPct += e.percent_complete || 0;
        if (e.completed_at) completed++;
        if (e.percent_complete > 0) active++;
      }
    }
    courseData.push({
      name: course.name,
      totalEnrolled,
      avgProgress: sampled > 0 ? sumPct / sampled : 0,
      completionRate: sampled > 0 ? completed / sampled * 100 : 0,
      activeRate: sampled > 0 ? active / sampled * 100 : 0,
      sampled,
    });
  }
  // Total students
  const totalUsers = (await (await fetch('https://developers.teachable.com/v1/users?per=1', { headers })).json()).meta?.total || 0;
  return { courses: courseData, totalUsers };
}

async function main() {
  console.log(`\n=== Wolfofbey KPI Dashboard v3 ===\nPeriod: ${monthName}\n`);
  const results = [];
  for (const c of COUNTRIES) {
    try { results.push(await fetchCountryData(c)); }
    catch (e) { console.error(`  Error: ${c.name}:`, e.message); results.push(null); }
  }
  let teachable = null;
  try { teachable = await fetchTeachableData(); }
  catch (e) { console.error('  Teachable error:', e.message); }
  console.log('\nGenerating dashboard...');
  fs.writeFileSync(path.join(__dirname,'kpi_dashboard.html'), generateHTML(results, teachable));
  console.log('Done!\n');
}
main().catch(e=>{console.error(e);process.exit(1);});
