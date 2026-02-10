const express = require("express");
const fetch = require("node-fetch");
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.urlencoded({ extended: true, limit: "15mb" }));
app.use(express.json({ limit: "15mb" }));

// ─── DROPBOX (direct API, no SDK) ───
let dropboxAccessToken = null;
let tokenExpiresAt = 0;

async function getDropboxToken() {
  if (dropboxAccessToken && Date.now() < tokenExpiresAt - 60000) {
    return dropboxAccessToken;
  }
  const resp = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: process.env.DROPBOX_REFRESH_TOKEN,
      client_id: process.env.DROPBOX_APP_KEY,
      client_secret: process.env.DROPBOX_APP_SECRET,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Dropbox token refresh failed (${resp.status}): ${text}`);
  }
  const data = await resp.json();
  dropboxAccessToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in * 1000);
  console.log("✅ Dropbox token refreshed");
  return dropboxAccessToken;
}

async function dropboxUpload(filePath, contents) {
  const token = await getDropboxToken();
  const resp = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({
        path: filePath,
        mode: "overwrite",
        autorename: false,
        mute: false,
      }),
    },
    body: contents,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Dropbox upload failed (${resp.status}): ${text}`);
  }
  return await resp.json();
}

const folders = { property: "/Properties Reports/Property Reports", suburb: "/Properties Reports/Suburb Property Report", other: "/Other Reports" };

// ─── LOGO ───
let LOGO_BASE64 = "";
try { const p = path.join(__dirname, "logo_base64.txt"); if (fs.existsSync(p)) LOGO_BASE64 = fs.readFileSync(p, "utf-8").trim(); } catch (e) {}
const LOGO_SRC = `data:image/jpeg;base64,${LOGO_BASE64}`;

// ─── HELPERS ───
function num(v) { if (typeof v === "number") return v; if (!v) return 0; return parseFloat(String(v).replace(/[,$%]/g, "")) || 0; }
function fmt(n) { return n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function pct(v) { const n = num(v); return n > 1 ? n / 100 : n; }

// PMT function: monthly payment for a loan
// PMT(annual_rate, years, principal) → annual payment amount
function pmtAnnual(annualRate, years, principal) {
  const r = annualRate / 12;
  const n = years * 12;
  if (r === 0) return principal / n * 12;
  const monthlyPmt = principal * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
  return monthlyPmt * 12;
}

// ─── STATE-BASED DEFAULTS ───
const LANDLORD_INS = { WA: 1500, QLD: 2000, VIC: 2000, NSW: 1500, SA: 1500, TAS: 1500 };
const MGMT_FEE_PCT = { WA: 0.09, QLD: 0.07, VIC: 0.055, NSW: 0.055, SA: 0.07, TAS: 0.07 };

// ─── DEFAULTS (from cashflow prompt) ───
const DEFAULTS = {
  depositPercent: 0.20,
  legals: 1500,
  pestReport: 500,
  buyersAgencyFee: 15000,
  councilAnnually: 3000,
  buildingInsAnnually: 1500,
  otherAnnually: 2000,
  normalIORate: 0.0625,
  normalPIRate: 0.06,
  smsfIORate: 0.0725,
  smsfPIRate: 0.07,
  normalTaxBracket: 0.42,
  smsfTaxBracket: 0,
};

// ─── LMI CALCULATOR ───
function calcLMI(depositPct, loan) {
  if (depositPct >= 0.20) return 0;
  if (depositPct >= 0.15) return 0.01 * loan;
  if (depositPct >= 0.12) return 0.017 * loan;
  if (depositPct >= 0.10) return 0.025 * loan;
  return 0.035 * loan;
}

// ─── CASHFLOW CALCULATOR ───
// Minimal required inputs: purchasePrice, lowerRentWeekly, higherRentWeekly, stampDuty, mortgageFee
// Optional overrides: depositPercent, legals, pestReport, buyersAgencyFee, strataReport, renovation,
//                     councilAnnually, strataAnnually, buildingInsAnnually, landlordInsAnnually,
//                     otherAnnually, mgmtFeePercent, interestOnlyRate, principalInterestRate, taxBracket
function calculateCashflow(input, state, isSMSF) {
  const st = (state || "NSW").toUpperCase().trim();
  const D = DEFAULTS;

  const price = num(input.purchasePrice);
  const depositPct = input.depositPercent != null ? pct(input.depositPercent) : D.depositPercent;
  const deposit = price * depositPct;
  const loan = price * (1 - depositPct);
  const lvrPct = (1 - depositPct) * 100;

  const stampDuty = num(input.stampDuty);
  const mortgageFee = num(input.mortgageFee);
  const lmi = input.lmi != null ? num(input.lmi) : calcLMI(depositPct, loan);
  const legals = input.legals != null ? num(input.legals) : D.legals;
  const pestReport = input.pestReport != null ? num(input.pestReport) : D.pestReport;
  const strataReport = num(input.strataReport);
  const buyersAgencyFee = input.buyersAgencyFee != null ? num(input.buyersAgencyFee) : D.buyersAgencyFee;
  const renovation = num(input.renovation);
  const totalFunds = deposit + stampDuty + mortgageFee + lmi + legals + pestReport + strataReport + buyersAgencyFee + renovation;

  const lowerRentWk = num(input.lowerRentWeekly);
  const higherRentWk = num(input.higherRentWeekly) || lowerRentWk; // same if only one rent
  const lowerRentAnn = lowerRentWk * 52;
  const higherRentAnn = higherRentWk * 52;

  const yieldBase = price + renovation;
  const yieldLow = yieldBase > 0 ? (lowerRentAnn / yieldBase) * 100 : 0;
  const yieldHigh = yieldBase > 0 ? (higherRentAnn / yieldBase) * 100 : 0;

  // Expenses
  const councilAnn = input.councilAnnually != null ? num(input.councilAnnually) : D.councilAnnually;
  const strataAnn = num(input.strataAnnually);
  const buildingInsAnn = input.buildingInsAnnually != null ? num(input.buildingInsAnnually) : D.buildingInsAnnually;
  const landlordInsAnn = input.landlordInsAnnually != null ? num(input.landlordInsAnnually) : (LANDLORD_INS[st] || 1500);
  const otherAnn = input.otherAnnually != null ? num(input.otherAnnually) : D.otherAnnually;

  const mgmtPct = input.mgmtFeePercent != null ? pct(input.mgmtFeePercent) : (MGMT_FEE_PCT[st] || 0.055);
  const mgmtAnn = lowerRentAnn * mgmtPct;

  // Loan rates
  let ioRate, piRate;
  if (isSMSF) {
    ioRate = input.interestOnlyRate != null ? pct(input.interestOnlyRate) : D.smsfIORate;
    piRate = input.principalInterestRate != null ? pct(input.principalInterestRate) : D.smsfPIRate;
  } else {
    ioRate = input.interestOnlyRate != null ? pct(input.interestOnlyRate) : D.normalIORate;
    piRate = input.principalInterestRate != null ? pct(input.principalInterestRate) : D.normalPIRate;
  }

  const ioAnn = loan * ioRate;
  const piAnn = pmtAnnual(piRate, 30, loan);

  // Total expenses
  // Normal: uses IO loan; SMSF: uses P&I loan
  let totalExpAnn, totalExpLabel;
  if (isSMSF) {
    totalExpAnn = councilAnn + strataAnn + buildingInsAnn + landlordInsAnn + otherAnn + mgmtAnn + piAnn;
    totalExpLabel = input.totalExpenseLabel || "*Total Expense (with Principal & Interest loan)";
  } else {
    totalExpAnn = councilAnn + strataAnn + buildingInsAnn + landlordInsAnn + otherAnn + mgmtAnn + ioAnn;
    totalExpLabel = input.totalExpenseLabel || "*Total Expense (with Interest Only loan)";
  }

  // Cashflow before tax
  const cfBTLowAnn = lowerRentAnn - totalExpAnn;
  const cfBTHighAnn = higherRentAnn - totalExpAnn;

  // Tax
  let taxBracket;
  if (isSMSF) {
    taxBracket = input.taxBracket != null ? pct(input.taxBracket) : D.smsfTaxBracket;
  } else {
    taxBracket = input.taxBracket != null ? pct(input.taxBracket) : D.normalTaxBracket;
  }

  const cfATLowAnn = cfBTLowAnn * (1 - taxBracket);
  const cfATHighAnn = cfBTHighAnn * (1 - taxBracket);

  const w = (a) => a / 52;
  const m = (a) => a / 12;
  const disclaimerRate = isSMSF ? (D.smsfPIRate * 100).toFixed(0) + "%" : (ioRate * 100).toFixed(0) + "%";

  return {
    date: input.date || new Date().toLocaleDateString("en-AU"),
    purchasePrice: fmt(price), depositPercent: Math.round(depositPct * 100) + "%",
    lvrPercent: Math.round(lvrPct) + "%", loanAmount: fmt(loan),
    depositAmount: fmt(deposit), depositPercentLabel: Math.round(depositPct * 100) + "%",
    stampDuty: fmt(stampDuty), lmi: lmi ? fmt(lmi) : "",
    mortgageFee: fmt(mortgageFee), legals: fmt(legals),
    pestReport: fmt(pestReport), strataReport: strataReport ? fmt(strataReport) : "",
    buyersAgencyFee: fmt(buyersAgencyFee), renovation: renovation ? fmt(renovation) : "",
    totalFundsRequired: fmt(totalFunds),
    yieldLowRent: yieldLow.toFixed(2) + "%", yieldHighRent: yieldHigh.toFixed(2) + "%",
    lowerRentWeekly: fmt(lowerRentWk), lowerRentMonthly: fmt(m(lowerRentAnn)), lowerRentAnnually: fmt(lowerRentAnn),
    higherRentWeekly: fmt(higherRentWk), higherRentMonthly: fmt(m(higherRentAnn)), higherRentAnnually: fmt(higherRentAnn),
    councilWeekly: fmt(w(councilAnn)), councilMonthly: fmt(m(councilAnn)), councilAnnually: fmt(councilAnn),
    strataWeekly: strataAnn ? fmt(w(strataAnn)) : "", strataMonthly: strataAnn ? fmt(m(strataAnn)) : "", strataAnnually: strataAnn ? fmt(strataAnn) : "",
    buildingInsWeekly: buildingInsAnn ? fmt(w(buildingInsAnn)) : "", buildingInsMonthly: buildingInsAnn ? fmt(m(buildingInsAnn)) : "", buildingInsAnnually: buildingInsAnn ? fmt(buildingInsAnn) : "",
    landlordInsWeekly: fmt(w(landlordInsAnn)), landlordInsMonthly: fmt(m(landlordInsAnn)), landlordInsAnnually: fmt(landlordInsAnn),
    otherWeekly: otherAnn ? fmt(w(otherAnn)) : "", otherMonthly: otherAnn ? fmt(m(otherAnn)) : "", otherAnnually: otherAnn ? fmt(otherAnn) : "",
    mgmtFeePercent: (mgmtPct * 100).toFixed(2) + "%",
    mgmtFeeWeekly: fmt(w(mgmtAnn)), mgmtFeeMonthly: fmt(m(mgmtAnn)), mgmtFeeAnnually: fmt(mgmtAnn),
    interestOnlyRate: (ioRate * 100).toFixed(2) + "%",
    interestOnlyWeekly: fmt(w(ioAnn)), interestOnlyMonthly: fmt(m(ioAnn)), interestOnlyAnnually: fmt(ioAnn),
    principalInterestRate: (piRate * 100).toFixed(2) + "%",
    principalInterestWeekly: fmt(w(piAnn)), principalInterestMonthly: fmt(m(piAnn)), principalInterestAnnually: fmt(piAnn),
    totalExpenseLabel: totalExpLabel,
    totalExpenseWeekly: fmt(w(totalExpAnn)), totalExpenseMonthly: fmt(m(totalExpAnn)), totalExpenseAnnually: fmt(totalExpAnn),
    cfBeforeTaxLowerWeekly: fmt(Math.abs(w(cfBTLowAnn))), cfBeforeTaxLowerMonthly: fmt(Math.abs(m(cfBTLowAnn))), cfBeforeTaxLowerAnnually: fmt(Math.abs(cfBTLowAnn)),
    cfBeforeTaxHigherWeekly: fmt(Math.abs(w(cfBTHighAnn))), cfBeforeTaxHigherMonthly: fmt(Math.abs(m(cfBTHighAnn))), cfBeforeTaxHigherAnnually: fmt(Math.abs(cfBTHighAnn)),
    taxBracket: Math.round(taxBracket * 100) + "%", disclaimerRate: disclaimerRate,
    cfAfterTaxLowerWeekly: fmt(Math.abs(w(cfATLowAnn))), cfAfterTaxLowerMonthly: fmt(Math.abs(m(cfATLowAnn))), cfAfterTaxLowerAnnually: fmt(Math.abs(cfATLowAnn)),
    cfAfterTaxHigherWeekly: fmt(Math.abs(w(cfATHighAnn))), cfAfterTaxHigherMonthly: fmt(Math.abs(m(cfATHighAnn))), cfAfterTaxHigherAnnually: fmt(Math.abs(cfATHighAnn)),
  };
}

// ─── STYLES ───
const sharedStyles = `
  @page{margin:0}*{box-sizing:border-box}
  body{font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;margin:0;padding:0;color:#222;line-height:1.55;font-size:10.5pt}
  .page{width:210mm;min-height:297mm;padding:18mm 18mm 22mm 18mm;position:relative;page-break-after:always}
  .page:last-child{page-break-after:auto}
  .logo{height:60px;margin-bottom:8px}
  .footer{position:absolute;bottom:8mm;left:15mm;right:15mm;font-size:7.5pt;color:#777;text-align:center;border-top:1px solid #ddd;padding-top:4px}
  .footer span{margin:0 8px}
  h1{font-size:15pt;color:#1a1a1a;margin:0 0 3px 0;font-weight:bold}
  h2{font-size:13pt;color:#1a1a1a;margin:18px 0 6px 0;font-weight:bold}
  h3{font-size:11pt;color:#1a1a1a;margin:12px 0 4px 0;font-weight:bold}
  p{margin:6px 0;text-align:justify}ul{margin:6px 0;padding-left:22px}ul li{margin:3px 0}
  .prop-title{font-size:12pt;font-weight:bold;margin:10px 0 4px 0}
  .prop-subtitle{color:#444;margin:2px 0 6px 0}.prop-config{margin:4px 0 10px 0;font-weight:600}
  .features{margin:8px 0;padding-left:18px}.features li{margin:2px 0;font-size:10pt}
  .amenities{margin:8px 0;padding-left:18px}.amenities li{margin:2px 0;font-size:9.5pt;color:#333}
  .comp-sale{margin:6px 0;padding:4px 0}.comp-address{font-weight:bold;font-size:10pt}.comp-details{color:#555;font-size:9.5pt}
  .cf-title{font-size:14pt;font-weight:bold;margin:8px 0 10px 0}
  .cf-addr-row{width:100%;border-collapse:collapse;font-size:8.5pt;margin-bottom:6px}
  .cf-addr-cell{border:1px solid #999;padding:5px 8px;font-weight:bold;font-size:10pt;text-align:center}
  .cf-main{width:100%;border-collapse:collapse;font-size:8pt;table-layout:fixed;border:1px solid #999}
  .cf-main td{padding:3px 4px;vertical-align:middle;overflow:hidden;text-overflow:ellipsis;border:1px solid #ccc}
  .cf-lbl{text-align:right;color:#333;background:#fafafa}.cf-val{text-align:right;white-space:nowrap}.cf-val-b{text-align:right;font-weight:bold;white-space:nowrap}
  .cf-hdr{font-weight:bold;text-align:center;border-bottom:2px solid #888;padding-bottom:3px;font-size:8pt;background:#f0f0f0}
  .cf-pink{color:#d63384;font-weight:bold}
  .cf-total td{border-top:2px solid #333;font-weight:bold;padding-top:4px;background:#f5f5f5}
  .cf-summary{width:100%;border-collapse:collapse;font-size:8pt;margin-top:10px;table-layout:fixed;border:1px solid #999}
  .cf-summary td{padding:3px 4px;border:1px solid #ccc}
  .cf-section-hdr{font-weight:bold;font-size:9pt;color:#d63384;padding-top:6px;background:#fdf2f8}
  .cf-disclaimer{font-size:7pt;color:#d63384;margin-top:10px;font-style:italic;text-align:center;line-height:1.3}
  .cf-red-note{color:#d63384;font-size:7.5pt;margin-top:6px}
`;
const footerHtml = `<div class="footer"><span>✉ admin@propwealth.com.au</span><span>🌐 www.propwealth.com.au</span><span>📍 Suite 215/33 Lexington Dr, Bella Vista NSW 2153</span></div>`;

// ─── SUBURB REPORT ───
function buildSuburbReportHtml(d) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${sharedStyles}</style></head><body>
<div class="page"><img src="${LOGO_SRC}" class="logo" alt="PropWealth">
  <h1>${d.cityName},</h1><h1>${d.stateName}, Australia</h1>
  <h2>Highlights</h2><ul>${(d.cityHighlights||[]).map(h=>`<li>${h}</li>`).join("")}</ul>
  ${(d.cityParagraphs||[]).map(p=>`<p>${p}</p>`).join("")}${footerHtml}</div>
<div class="page"><img src="${LOGO_SRC}" class="logo" alt="PropWealth">
  <h2>Future Prospects –</h2>${(d.futureProspectsParagraphs||[]).map(p=>`<p>${p}</p>`).join("")}
  <h2 style="margin-top:30px">${d.suburbName} –</h2>${(d.suburbParagraphs||[]).map(p=>`<p>${p}</p>`).join("")}
  <p>Some insights of ${d.suburbName} are:</p>
  <ul><li>Percentage Renters: ${d.insights.percentageRenters}</li><li>Days on Market: ${d.insights.daysOnMarket}</li><li>Vacancy Rate: ${d.insights.vacancyRate}</li><li>Vendor Discounting: ${d.insights.vendorDiscounting}</li><li>Stock on Market: ${d.insights.stockOnMarket}</li></ul>
  ${footerHtml}</div></body></html>`;
}

// ─── CASHFLOW PAGE ───
function buildCashflowPage(title, cf, propertyAddress, state) {
  const R = (lbl, lv, rbl, rv1, rv2, rv3, cls) => {
    // Builds a 6-col row: left-label | left-value | right-label | right-val1 | right-val2 | right-val3
    const c = cls ? ` class="${cls}"` : '';
    return `<tr${c}><td class="cf-lbl">${lbl}</td><td class="cf-val">${lv}</td><td class="cf-lbl">${rbl}</td><td class="cf-val">${rv1}</td><td class="cf-val">${rv2}</td><td class="cf-val">${rv3}</td></tr>`;
  };

  return `
<div class="page"><img src="${LOGO_SRC}" class="logo" alt="PropWealth">
  <div class="cf-title">${title}</div>
  <table class="cf-addr-row"><tr><td style="width:15%"></td><td class="cf-addr-cell" style="width:48%">${propertyAddress}</td><td style="width:12%"></td><td style="text-align:right;font-size:8pt;width:8%">Date:</td><td style="text-align:right;font-size:8pt;width:17%">${cf.date||""}</td></tr></table>
  <table class="cf-main">
    <colgroup><col style="width:17%"><col style="width:14%"><col style="width:23%"><col style="width:14%"><col style="width:16%"><col style="width:16%"></colgroup>
    <tr><td></td><td></td><td class="cf-hdr">Yield on Purchase</td><td class="cf-pink" style="text-align:right">Low rent</td><td></td><td class="cf-val">${cf.yieldLowRent}</td></tr>
    <tr><td class="cf-lbl">State</td><td class="cf-val-b">${state||""}</td><td></td><td class="cf-pink" style="text-align:right">High rent</td><td></td><td class="cf-val">${cf.yieldHighRent}</td></tr>
    <tr><td class="cf-lbl">Expected Purchase Price</td><td class="cf-val">$ ${cf.purchasePrice}</td><td class="cf-hdr">Estimated Rental</td><td></td><td></td><td></td></tr>
    ${R("* Deposit %", cf.depositPercent, "Lower Rent", `<span class="cf-pink">$ ${cf.lowerRentWeekly}</span>`, `$ ${cf.lowerRentMonthly}`, `$ ${cf.lowerRentAnnually}`)}
    ${R("Loan based on "+cf.lvrPercent+" LVR", "$ "+cf.loanAmount, "Higher Rent", `<span class="cf-pink">$ ${cf.higherRentWeekly}</span>`, `$ ${cf.higherRentMonthly}`, `$ ${cf.higherRentAnnually}`)}
    <tr><td class="cf-lbl">Deposit based on ${cf.depositPercentLabel}</td><td class="cf-val">$ ${cf.depositAmount}</td><td class="cf-hdr">Expenses</td><td class="cf-hdr">Weekly</td><td class="cf-hdr">Monthly</td><td class="cf-hdr">Annually</td></tr>
    ${R("Estimated Stamp Duty", "$ "+cf.stampDuty, "Council", "$ "+cf.councilWeekly, "$ "+cf.councilMonthly, "$ "+cf.councilAnnually)}
    ${R(cf.lmi?"Estimated LMI":"", cf.lmi?"$ "+cf.lmi:"", "Strata Fees", cf.strataWeekly?"$ "+cf.strataWeekly:"$ -", cf.strataMonthly?"$ "+cf.strataMonthly:"$ -", cf.strataAnnually||"")}
    ${R("Mortgage/Transfer/Fee", "$ "+cf.mortgageFee, "Building Insurance", cf.buildingInsWeekly?"$ "+cf.buildingInsWeekly:"$ -", cf.buildingInsMonthly?"$ "+cf.buildingInsMonthly:"$ -", cf.buildingInsAnnually?"$ "+cf.buildingInsAnnually:"")}
    ${R("Estimated Legals", "$ "+cf.legals, "Landlord Insurance", "$ "+cf.landlordInsWeekly, "$ "+cf.landlordInsMonthly, "$ "+cf.landlordInsAnnually)}
    ${R("Pest &amp; Building Report", "$ "+cf.pestReport, "Other", cf.otherWeekly?"$ "+cf.otherWeekly:"$ -", cf.otherMonthly?"$ "+cf.otherMonthly:"$ -", cf.otherAnnually?"$ "+cf.otherAnnually:"")}
    ${R("Strata Report", cf.strataReport?"$ "+cf.strataReport:"", "* Mgmt fee "+cf.mgmtFeePercent, "$ "+cf.mgmtFeeWeekly, "$ "+cf.mgmtFeeMonthly, "$ "+cf.mgmtFeeAnnually)}
    ${R("Buyers Agency Fee", "$ "+cf.buyersAgencyFee, "* IO rate "+cf.interestOnlyRate, "$ "+cf.interestOnlyWeekly, "$ "+cf.interestOnlyMonthly, "$ "+cf.interestOnlyAnnually)}
    ${R("Estimated Renovation", cf.renovation?"$ "+cf.renovation:"", "* P&amp;I rate "+cf.principalInterestRate, "$ "+cf.principalInterestWeekly, "$ "+cf.principalInterestMonthly, "$ "+cf.principalInterestAnnually)}
    <tr class="cf-total"><td class="cf-lbl">Total Funds Required</td><td class="cf-val-b">$ ${cf.totalFundsRequired}</td><td class="cf-lbl">${cf.totalExpenseLabel}</td><td class="cf-val-b">$ ${cf.totalExpenseWeekly}</td><td class="cf-val-b">$ ${cf.totalExpenseMonthly}</td><td class="cf-val-b">$ ${cf.totalExpenseAnnually}</td></tr>
  </table>
  <table class="cf-summary">
    <colgroup><col style="width:45%"><col style="width:18%"><col style="width:18%"><col style="width:19%"></colgroup>
    <tr><td colspan="4" class="cf-section-hdr">Cashflow Before Tax</td></tr>
    <tr><td class="cf-lbl">Lower Rent</td><td class="cf-val">-$ ${cf.cfBeforeTaxLowerWeekly}</td><td class="cf-val">-$ ${cf.cfBeforeTaxLowerMonthly}</td><td class="cf-val">-$ ${cf.cfBeforeTaxLowerAnnually}</td></tr>
    <tr><td class="cf-lbl">Higher Rent</td><td class="cf-val">-$ ${cf.cfBeforeTaxHigherWeekly}</td><td class="cf-val">-$ ${cf.cfBeforeTaxHigherMonthly}</td><td class="cf-val">-$ ${cf.cfBeforeTaxHigherAnnually}</td></tr>
    <tr><td colspan="4" class="cf-section-hdr">Effective Cashflow*</td></tr>
    <tr><td class="cf-lbl">Your tax bracket</td><td class="cf-pink cf-val-b">${cf.taxBracket}</td><td></td><td></td></tr>
    <tr><td class="cf-lbl">Lower Rent</td><td class="cf-val">-$ ${cf.cfAfterTaxLowerWeekly}</td><td class="cf-val">-$ ${cf.cfAfterTaxLowerMonthly}</td><td class="cf-val">-$ ${cf.cfAfterTaxLowerAnnually}</td></tr>
    <tr><td class="cf-lbl">Higher Rent</td><td class="cf-val">-$ ${cf.cfAfterTaxHigherWeekly}</td><td class="cf-val">-$ ${cf.cfAfterTaxHigherMonthly}</td><td class="cf-val">-$ ${cf.cfAfterTaxHigherAnnually}</td></tr>
  </table>
  <p class="cf-red-note">* Change fields to personal requirements</p>
  <p class="cf-disclaimer">*****All information has been provided comes from third parties and ESTIMATES ONLY. No guarantee is given as to its accuracy or interpretation of the information. It is highly recommended that interested parties rely on their own research before making any investment decision. Repayments are calculated at rate of ${cf.disclaimerRate} on a ${cf.lvrPercent} LVR*****</p>
  ${footerHtml}</div>`;
}

// ─── PROPERTY REPORT ───
function buildPropertyReportHtml(d) {
  let html = buildSuburbReportHtml(d).replace("</body></html>", "");
  const featuresHtml = (d.propertyFeatures||[]).length ? `<ul class="features">${d.propertyFeatures.map(f=>`<li>${f}</li>`).join("")}</ul>` : "";
  const amenitiesHtml = (d.amenities||[]).length ? `<h3>Location and Amenities</h3><ul class="amenities">${d.amenities.map(a=>`<li>${a}</li>`).join("")}</ul>` : "";
  const compsHtml = (d.comparableSales||[]).map((cs,i)=>`<div class="comp-sale"><div class="comp-address">${i+1}. ${cs.address} –</div><div class="comp-details">${cs.beds}| ${cs.baths} | ${cs.garages} built on ${cs.landSize} Land sold ${cs.soldPrice} on ${cs.soldDate}.</div></div>`).join("");
  let descHtml = "";
  if (d.propertyDescription) {
    const paras = typeof d.propertyDescription === "string" ? d.propertyDescription.split(/\n\s*\n/).filter(p=>p.trim()) : (Array.isArray(d.propertyDescription) ? d.propertyDescription : []);
    descHtml = paras.map(p=>`<p>${p}</p>`).join("");
  }

  html += `<div class="page"><img src="${LOGO_SRC}" class="logo" alt="PropWealth">
  <div class="prop-title">${d.propertyAddress} – ${d.listingType||""}${d.price?", Price "+d.price:""}</div>
  ${d.occupancyStatus?`<div class="prop-subtitle">${d.occupancyStatus}${d.currentRent?", Rental potential "+d.currentRent+" per week.":""}</div>`:(d.currentRent?`<div class="prop-subtitle">Currently Rented for ${d.currentRent} per week</div>`:"")}
  <div class="prop-config">${d.bedrooms||""} Bedrooms | ${d.bathrooms||""} Bathrooms | ${d.garages||""} Car Spaces${d.buildingSize?" | "+d.buildingSize:""}${d.landSize?" on "+d.landSize+" land":""}${d.yearBuilt?" | Built "+d.yearBuilt:""}</div>
  ${descHtml}${featuresHtml}${d.locationDescription?`<p>${d.locationDescription}</p>`:""}${amenitiesHtml}
  ${compsHtml?`<h2>Comparable Sales –</h2>${compsHtml}`:""}
  ${footerHtml}</div>`;

  // Cashflow — auto-calculate from minimal inputs
  if (d.cashflowInputs) {
    const cf = calculateCashflow(d.cashflowInputs, d.state, false);
    html += buildCashflowPage("Cashflow -", cf, d.propertyAddress, d.state);
    // SMSF auto-generated from same inputs with SMSF rates
    const smsfOverrides = d.smsfCashflowInputs || {};
    const smsfCf = calculateCashflow({ ...d.cashflowInputs, ...smsfOverrides }, d.state, true);
    html += buildCashflowPage("SMSF Cashflow –", smsfCf, d.propertyAddress, d.state);
  }

  html += "</body></html>";
  return html;
}

// ─── PDF ───
async function generatePdfAndUpload(html, reportType, reportName) {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle", timeout: 15000 });
  const pdf = await page.pdf({ format: "A4", printBackground: true, margin: { top: "0mm", bottom: "0mm", left: "0mm", right: "0mm" }, displayHeaderFooter: false });
  await browser.close();
  const safeName = reportName.replace(/\s+/g, "_").replace(/[^\w\-]/g, "");
  const folderPath = folders[reportType.toLowerCase()] || folders["other"];
  const filename = `${folderPath}/${safeName}.pdf`;
  await dropboxUpload(filename, pdf);
  return filename;
}

// ─── ROUTES ───
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.post("/generate-suburb", async (req, res) => {
  try {
    const d = req.body;
    if (!d.cityName || !d.suburbName) return res.status(400).json({ error: "Missing: cityName, suburbName" });
    const html = buildSuburbReportHtml(d);
    const filename = await generatePdfAndUpload(html, "suburb", d.reportName || d.suburbName);
    res.json({ success: true, message: `✅ Suburb report uploaded: ${filename}`, path: filename });
  } catch (err) { console.error("❌", err); res.status(500).json({ error: err.message }); }
});

app.post("/generate-property", async (req, res) => {
  try {
    const d = req.body;
    if (!d.propertyAddress || !d.cityName || !d.suburbName) return res.status(400).json({ error: "Missing: propertyAddress, cityName, suburbName" });
    const html = buildPropertyReportHtml(d);
    const filename = await generatePdfAndUpload(html, "property", d.reportName || d.propertyAddress);
    res.json({ success: true, message: `✅ Property report uploaded: ${filename}`, path: filename });
  } catch (err) { console.error("❌", err); res.status(500).json({ error: err.message }); }
});

app.post("/convert", async (req, res) => {
  try {
    if (!req.body.html) return res.status(400).send("No HTML");
    const filename = await generatePdfAndUpload(req.body.html, req.body.reportType || "other", req.body.reportName || "report");
    res.send(`✅ PDF uploaded: ${filename}`);
  } catch (err) { console.error("❌", err); res.status(500).send("❌ Error"); }
});

app.listen(process.env.PORT || 3000, () => console.log("PropWealth Report Generator running on port " + (process.env.PORT || 3000)));