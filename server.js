require('dotenv').config();
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

// Check if a file exists in Dropbox and get its metadata
async function dropboxGetMetadata(filePath) {
  const token = await getDropboxToken();
  try {
    const resp = await fetch("https://api.dropboxapi.com/2/files/get_metadata", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: filePath }),
    });
    if (resp.status === 409) return null; // not found
    if (!resp.ok) return null;
    return await resp.json();
  } catch { return null; }
}

// List files in a Dropbox folder, optionally filtering by prefix
async function dropboxListFolder(folderPath, prefix) {
  const token = await getDropboxToken();
  try {
    const resp = await fetch("https://api.dropboxapi.com/2/files/list_folder", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: folderPath, recursive: false, limit: 500 }),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    let entries = data.entries || [];
    if (prefix) {
      const lowerPrefix = prefix.toLowerCase();
      entries = entries.filter(e => e.name.toLowerCase().startsWith(lowerPrefix));
    }
    return entries;
  } catch { return []; }
}

// Search for files matching a query in a specific folder
async function dropboxSearch(folderPath, query) {
  const token = await getDropboxToken();
  try {
    const resp = await fetch("https://api.dropboxapi.com/2/files/search_v2", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        options: {
          path: folderPath,
          max_results: 10,
          file_extensions: ["pdf"],
        },
      }),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.matches || []).map(m => m.metadata?.metadata || m.metadata).filter(Boolean);
  } catch { return []; }
}

// Delete a file from Dropbox
async function dropboxDelete(filePath) {
  const token = await getDropboxToken();
  try {
    const resp = await fetch("https://api.dropboxapi.com/2/files/delete_v2", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: filePath }),
    });
    return resp.ok;
  } catch { return false; }
}

// Get or create a shared link for a Dropbox file
async function dropboxGetSharedLink(filePath) {
  const token = await getDropboxToken();
  try {
    // Try to create a new shared link
    const resp = await fetch("https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: filePath, settings: { requested_visibility: "public" } }),
    });
    if (resp.ok) {
      const data = await resp.json();
      return data.url;
    }
    // If link already exists (409 conflict), fetch existing links
    if (resp.status === 409) {
      const listResp = await fetch("https://api.dropboxapi.com/2/sharing/list_shared_links", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: filePath, direct_only: true }),
      });
      if (listResp.ok) {
        const listData = await listResp.json();
        if (listData.links?.length) return listData.links[0].url;
      }
    }
    return null;
  } catch { return null; }
}

// Download a file from Dropbox (returns Buffer)
async function dropboxDownload(filePath) {
  const token = await getDropboxToken();
  try {
    const resp = await fetch("https://content.dropboxapi.com/2/files/download", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Dropbox-API-Arg": JSON.stringify({ path: filePath }),
      },
    });
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  } catch { return null; }
}

const folders = { property: "/Properties Reports/Property Reports (Auto)", suburb: "/Properties Reports/Suburb Reports (Auto)", other: "/Other Reports" };

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

// ─── STAMP DUTY CALCULATOR (all Australian states/territories) ───
function calcStampDuty(price, state) {
  const s = (state || "NSW").toUpperCase().trim();
  const p = price;

  if (s === "NSW") {
    // NSW: standard rates (non-first-home, non-premium)
    if (p <= 17000) return p * 0.0125;
    if (p <= 36000) return 212.50 + (p - 17000) * 0.015;
    if (p <= 97000) return 497.50 + (p - 36000) * 0.0175;
    if (p <= 364000) return 1565 + (p - 97000) * 0.035;
    if (p <= 1214000) return 10912.50 + (p - 364000) * 0.045;
    if (p <= 3636000) return 49237.50 + (p - 1214000) * 0.055;
    return 182447.50 + (p - 3636000) * 0.07;
  }

  if (s === "VIC") {
    if (p <= 25000) return p * 0.014;
    if (p <= 130000) return 350 + (p - 25000) * 0.024;
    if (p <= 960000) return 2870 + (p - 130000) * 0.06;
    if (p <= 2000000) return p * 0.055;
    return 110000 + (p - 2000000) * 0.065;
  }

  if (s === "QLD") {
    if (p <= 5000) return 0;
    if (p <= 75000) return 1.50 * ((p - 5000) / 100);
    if (p <= 540000) return 1050 + 3.50 * ((p - 75000) / 100);
    if (p <= 1000000) return 17325 + 4.50 * ((p - 540000) / 100);
    return 38025 + 5.75 * ((p - 1000000) / 100);
  }

  if (s === "WA") {
    if (p <= 120000) return p * 0.019;
    if (p <= 150000) return 2280 + (p - 120000) * 0.0285;
    if (p <= 360000) return 3135 + (p - 150000) * 0.038;
    if (p <= 725000) return 11115 + (p - 360000) * 0.0475;
    return 28453 + (p - 725000) * 0.0515;
  }

  if (s === "SA") {
    if (p <= 12000) return p * 0.01;
    if (p <= 30000) return 120 + (p - 12000) * 0.02;
    if (p <= 50000) return 480 + (p - 30000) * 0.03;
    if (p <= 100000) return 1080 + (p - 50000) * 0.035;
    if (p <= 200000) return 2830 + (p - 100000) * 0.04;
    if (p <= 250000) return 6830 + (p - 200000) * 0.045;
    if (p <= 300000) return 9080 + (p - 250000) * 0.05;
    if (p <= 500000) return 11330 + (p - 300000) * 0.05;
    return 21330 + (p - 500000) * 0.055;
  }

  if (s === "TAS") {
    if (p <= 3000) return 50;
    if (p <= 25000) return 50 + (p - 3000) * 0.0175;
    if (p <= 75000) return 435 + (p - 25000) * 0.025;
    if (p <= 200000) return 1685 + (p - 75000) * 0.035;
    if (p <= 375000) return 6060 + (p - 200000) * 0.04;
    if (p <= 725000) return 13060 + (p - 375000) * 0.0425;
    return 27935 + (p - 725000) * 0.045;
  }

  if (s === "ACT") {
    // ACT uses a unit-based system — simplified approximation
    if (p <= 260000) return p * 0.006 * (p / 100);
    if (p <= 300000) return p * 0.02273;
    if (p <= 500000) return p * 0.0344;
    if (p <= 750000) return p * 0.0419;
    if (p <= 1000000) return p * 0.0458;
    if (p <= 1455000) return p * 0.0494;
    return p * 0.055;
  }

  if (s === "NT") {
    // NT uses a formula-based approach — simplified
    const v = p / 1000;
    if (p <= 525000) return (0.06571441 * v * v + 15 * v) * 1;
    return p * 0.0495;
  }

  // Fallback: rough 4% estimate
  return p * 0.04;
}

// ─── MORTGAGE/TRANSFER REGISTRATION FEE (state-based) ───
// Formula: transfer_fee × 2 + mortgage_registration, rounded up to nearest $100
// Uses current FY 2025/26 flat registration fees for standard single-title transfers
// For states with price-dependent transfer fees (QLD, VIC, SA), uses typical amounts
// Users can override via cashflow inputs if needed
function calcMortgageFee(state, price) {
  const s = (state || "NSW").toUpperCase();

  //                    [transfer_fee, mortgage_reg]
  const fees = {
    NSW: [175.70, 175.70],   // $175.70 × 2 + $175.70 = $527.10 → $600
    VIC: [128.50, 128.50],   // $128.50 × 2 + $128.50 = $385.50 → $400
    QLD: [238.14, 238.14],   // $238.14 × 2 + $238.14 = $714.42 → $800 (base, excl price surcharge)
    WA:  [203.00, 203.00],   // $203.00 × 2 + $203.00 = $609.00 → $700
    SA:  [187.00, 187.00],   // $187.00 × 2 + $187.00 = $561.00 → $600
    TAS: [217.00, 152.19],   // $217.00 × 2 + $152.19 = $586.19 → $600
    ACT: [166.00, 166.00],   // $166.00 × 2 + $166.00 = $498.00 → $500
    NT:  [152.00, 165.00],   // $152.00 × 2 + $165.00 = $469.00 → $500
  };

  const [tf, mr] = fees[s] || [175, 175];
  const total = tf * 2 + mr;
  return Math.ceil(total / 100) * 100;
}

// ─── GOOGLE PLACES: NEARBY AMENITIES ───
const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY || "";

async function fetchNearbyAmenities(address) {
  if (!GOOGLE_API_KEY) {
    console.log("⚠️ No GOOGLE_PLACES_API_KEY set — skipping amenities fetch");
    return [];
  }

  try {
    // Step 1: Geocode the address to get lat/lng
    const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_API_KEY}`;
    const geoResp = await fetch(geoUrl);
    const geoData = await geoResp.json();

    if (!geoData.results?.length) {
      console.log("⚠️ Could not geocode address for amenities");
      return [];
    }

    const { lat, lng } = geoData.results[0].geometry.location;
    console.log(`   📍 Geocoded: ${lat}, ${lng}`);

    // Step 2: Search curated categories — 1 result each for a clean, professional list
    // Categories chosen to match the Cranbourne East reference report style
    const categories = [
      { type: "shopping_mall", label: "Shopping Centre", radius: 4000, max: 1 },
      { type: "supermarket", label: "Supermarket", radius: 2500, max: 1 },
      { type: "park", label: "Park", radius: 2000, max: 1 },
      { type: "hospital", label: "Hospital", radius: 5000, max: 1 },
      { type: "train_station", label: "Train Station", radius: 4000, max: 1 },
    ];

    const amenities = [];
    const seenNames = new Set();

    // Words that indicate low-quality or irrelevant results
    const excludePatterns = /childcare|daycare|child care|preschool|kindergarten|dentist|physio|chiro|vet|veterinary|pharmacy|chemist|real estate|solicitor|accountant|hairdress|beauty|nail|tattoo|gym|fitness|personal train|massage|spine|osteo/i;

    for (const cat of categories) {
      try {
        const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${cat.radius}&type=${cat.type}&key=${GOOGLE_API_KEY}`;
        const resp = await fetch(url);
        const data = await resp.json();

        if (data.results) {
          let count = 0;
          for (const place of data.results) {
            if (count >= cat.max) break;

            const name = place.name;
            const nameKey = name.toLowerCase();

            // Skip duplicates, excluded types, and results that are just person names
            if (seenNames.has(nameKey)) continue;
            if (excludePatterns.test(name)) continue;
            // Skip if name is too short (likely a person name) or has no spaces (single word business)
            if (name.split(/\s+/).length <= 1 && cat.type !== "park") continue;

            seenNames.add(nameKey);

            // Calculate distance
            const dist = haversine(lat, lng, place.geometry.location.lat, place.geometry.location.lng);
            const distStr = dist < 1 ? `${Math.round(dist * 1000)}m` : `${dist.toFixed(1)}km`;

            amenities.push({
              name,
              distance: distStr,
              category: cat.label,
              formatted: `${name} - ${distStr}`,
            });
            count++;
          }
        }
      } catch (e) {
        console.log(`   ⚠️ Places search failed for ${cat.type}:`, e.message);
      }
    }

    // Sort by distance
    amenities.sort((a, b) => {
      const distA = parseFloat(a.distance) || 0;
      const distB = parseFloat(b.distance) || 0;
      return distA - distB;
    });

    console.log(`   ✅ Found ${amenities.length} nearby amenities`);
    return amenities;
  } catch (err) {
    console.error("⚠️ Google Places error:", err.message);
    return [];
  }
}

// Haversine distance in km
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

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

  const stampDuty = input.stampDuty != null ? num(input.stampDuty) : calcStampDuty(price, st);
  const mortgageFee = input.mortgageFee != null ? num(input.mortgageFee) : calcMortgageFee(st, price);
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
  .comp-sale{margin:6px 0;padding:4px 0}.comp-address{font-weight:bold;font-size:10pt}.comp-details{color:#555;font-size:9.5pt}.comps-section{}
  .cf-title{font-size:14pt;font-weight:bold;margin:8px 0 10px 0}
  .cf-addr-row{width:100%;border-collapse:collapse;font-size:8.5pt;margin-bottom:6px}
  .cf-addr-cell{border:1px solid #999;padding:5px 8px;font-weight:bold;font-size:10pt;text-align:center}
  .cf-header-tbl{width:100%;border-collapse:collapse;font-size:8pt;table-layout:fixed;border:1px solid #999;margin-bottom:10px;background:#fafafa}
  .cf-header-tbl td{padding:4px 6px;border:1px solid #ddd;vertical-align:middle}
  .cf-h-lbl{text-align:right;color:#555;font-size:7.5pt;white-space:nowrap}
  .cf-h-val{text-align:right;font-weight:bold;font-size:8pt;white-space:nowrap}
  .cf-h-total{font-weight:bold;font-size:8.5pt;border-top:2px solid #333;background:#f0f0f0}
  .cf-exp-tbl{width:100%;border-collapse:collapse;font-size:8pt;table-layout:fixed;border:1px solid #999;margin-bottom:10px}
  .cf-exp-tbl td{padding:3px 5px;border:1px solid #ccc;text-align:right;white-space:nowrap}
  .cf-exp-hdr td{font-weight:bold;text-align:center;background:#f0f0f0;border-bottom:2px solid #888;font-size:8pt;padding:4px 5px}
  .cf-exp-hdr-lbl{text-align:left !important}
  .cf-exp-lbl{text-align:left !important;color:#333}
  .cf-exp-total td{border-top:2px solid #333;font-weight:bold;background:#f5f5f5}
  .cf-lbl{text-align:right;color:#333;background:#fafafa}.cf-val{text-align:right;white-space:nowrap}.cf-val-b{text-align:right;font-weight:bold;white-space:nowrap}
  .cf-hdr{font-weight:bold;text-align:center;border-bottom:2px solid #888;padding-bottom:3px;font-size:8pt;background:#f0f0f0}
  .cf-pink{color:#d63384;font-weight:bold}
  .cf-total td{border-top:2px solid #333;font-weight:bold;padding-top:4px;background:#f5f5f5}
  .cf-summary{width:100%;border-collapse:collapse;font-size:8pt;margin-top:0;table-layout:fixed;border:1px solid #999}
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
  return `
<div class="page"><img src="${LOGO_SRC}" class="logo" alt="PropWealth">
  <div class="cf-title">${title}</div>
  <table class="cf-addr-row"><tr><td style="width:15%"></td><td class="cf-addr-cell" style="width:48%">${propertyAddress}</td><td style="width:12%"></td><td style="text-align:right;font-size:8pt;width:8%">Date:</td><td style="text-align:right;font-size:8pt;width:17%">${cf.date||""}</td></tr></table>

  <!-- ═══ SECTION 1: Property & Loan Summary ═══ -->
  <table class="cf-header-tbl">
    <colgroup><col style="width:25%"><col style="width:25%"><col style="width:25%"><col style="width:25%"></colgroup>
    <tr>
      <td class="cf-h-lbl">State</td><td class="cf-h-val">${state||""}</td>
      <td class="cf-h-lbl">Yield on Purchase (Low)</td><td class="cf-h-val">${cf.yieldLowRent}</td>
    </tr>
    <tr>
      <td class="cf-h-lbl">Expected Purchase Price</td><td class="cf-h-val">$ ${cf.purchasePrice}</td>
      <td class="cf-h-lbl">Yield on Purchase (High)</td><td class="cf-h-val">${cf.yieldHighRent}</td>
    </tr>
    <tr>
      <td class="cf-h-lbl">* Deposit %</td><td class="cf-h-val">${cf.depositPercent}</td>
      <td class="cf-h-lbl">Estimated Rental (Lower)</td><td class="cf-h-val cf-pink">$ ${cf.lowerRentWeekly} <span style="font-weight:normal;color:#555">/ $ ${cf.lowerRentAnnually} pa</span></td>
    </tr>
    <tr>
      <td class="cf-h-lbl">Loan based on ${cf.lvrPercent} LVR</td><td class="cf-h-val">$ ${cf.loanAmount}</td>
      <td class="cf-h-lbl">Estimated Rental (Higher)</td><td class="cf-h-val cf-pink">$ ${cf.higherRentWeekly} <span style="font-weight:normal;color:#555">/ $ ${cf.higherRentAnnually} pa</span></td>
    </tr>
    <tr>
      <td class="cf-h-lbl">Deposit based on ${cf.depositPercentLabel}</td><td class="cf-h-val">$ ${cf.depositAmount}</td>
      <td class="cf-h-lbl">Estimated Stamp Duty</td><td class="cf-h-val">$ ${cf.stampDuty}</td>
    </tr>
    <tr>
      <td class="cf-h-lbl">Est Mortgage/Transfer Fee</td><td class="cf-h-val">$ ${cf.mortgageFee}</td>
      <td class="cf-h-lbl">Total Funds Required</td><td class="cf-h-val cf-h-total">$ ${cf.totalFundsRequired}</td>
    </tr>${cf.lmi?`
    <tr>
      <td class="cf-h-lbl">Estimated LMI</td><td class="cf-h-val">$ ${cf.lmi}</td>
      <td></td><td></td>
    </tr>`:""}
    <tr>
      <td class="cf-h-lbl">Estimated Legals</td><td class="cf-h-val">$ ${cf.legals}</td>
      <td class="cf-h-lbl">Pest &amp; Building Report</td><td class="cf-h-val">$ ${cf.pestReport}</td>
    </tr>
    <tr>
      <td class="cf-h-lbl">Strata Report</td><td class="cf-h-val">${cf.strataReport?"$ "+cf.strataReport:""}</td>
      <td class="cf-h-lbl">Buyers Agency Fee</td><td class="cf-h-val">$ ${cf.buyersAgencyFee}</td>
    </tr>
    <tr>
      <td class="cf-h-lbl">Estimated Renovation</td><td class="cf-h-val">${cf.renovation?"$ "+cf.renovation:""}</td>
      <td></td><td></td>
    </tr>
  </table>

  <!-- ═══ SECTION 2: Expenses Table ═══ -->
  <table class="cf-exp-tbl">
    <colgroup><col style="width:40%"><col style="width:20%"><col style="width:20%"><col style="width:20%"></colgroup>
    <tr class="cf-exp-hdr"><td class="cf-exp-hdr-lbl">Expenses</td><td>Weekly</td><td>Monthly</td><td>Annually</td></tr>
    <tr><td class="cf-exp-lbl">Council</td><td>$ ${cf.councilWeekly}</td><td>$ ${cf.councilMonthly}</td><td>$ ${cf.councilAnnually}</td></tr>
    <tr><td class="cf-exp-lbl">Strata Fees</td><td>${cf.strataWeekly?"$ "+cf.strataWeekly:"$ -"}</td><td>${cf.strataMonthly?"$ "+cf.strataMonthly:"$ -"}</td><td>${cf.strataAnnually||""}</td></tr>
    <tr><td class="cf-exp-lbl">Building Insurance</td><td>${cf.buildingInsWeekly?"$ "+cf.buildingInsWeekly:"$ -"}</td><td>${cf.buildingInsMonthly?"$ "+cf.buildingInsMonthly:"$ -"}</td><td>${cf.buildingInsAnnually?"$ "+cf.buildingInsAnnually:""}</td></tr>
    <tr><td class="cf-exp-lbl">Landlord Insurance</td><td>$ ${cf.landlordInsWeekly}</td><td>$ ${cf.landlordInsMonthly}</td><td>$ ${cf.landlordInsAnnually}</td></tr>
    <tr><td class="cf-exp-lbl">Other</td><td>${cf.otherWeekly?"$ "+cf.otherWeekly:"$ -"}</td><td>${cf.otherMonthly?"$ "+cf.otherMonthly:"$ -"}</td><td>${cf.otherAnnually?"$ "+cf.otherAnnually:""}</td></tr>
    <tr><td class="cf-exp-lbl">* Mgmt fee ${cf.mgmtFeePercent}</td><td>$ ${cf.mgmtFeeWeekly}</td><td>$ ${cf.mgmtFeeMonthly}</td><td>$ ${cf.mgmtFeeAnnually}</td></tr>
    <tr><td class="cf-exp-lbl">* IO rate ${cf.interestOnlyRate}</td><td>$ ${cf.interestOnlyWeekly}</td><td>$ ${cf.interestOnlyMonthly}</td><td>$ ${cf.interestOnlyAnnually}</td></tr>
    <tr><td class="cf-exp-lbl">* P&amp;I rate ${cf.principalInterestRate}</td><td>$ ${cf.principalInterestWeekly}</td><td>$ ${cf.principalInterestMonthly}</td><td>$ ${cf.principalInterestAnnually}</td></tr>
    <tr class="cf-exp-total"><td class="cf-exp-lbl">${cf.totalExpenseLabel}</td><td>$ ${cf.totalExpenseWeekly}</td><td>$ ${cf.totalExpenseMonthly}</td><td>$ ${cf.totalExpenseAnnually}</td></tr>
  </table>

  <!-- ═══ SECTION 3: Cashflow Summary ═══ -->
  <table class="cf-summary">
    <colgroup><col style="width:40%"><col style="width:20%"><col style="width:20%"><col style="width:20%"></colgroup>
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
  const compsHtml = (d.comparableSales||[]).map((cs,i)=>{
    // Build config line — only show parts that have data
    const configParts = [];
    if (cs.beds) configParts.push(cs.beds + " Bed");
    if (cs.baths) configParts.push(cs.baths + " Bath");
    if (cs.garages) configParts.push(cs.garages + " Car");
    const configStr = configParts.length ? configParts.join(" | ") : "";
    const landStr = cs.landSize ? (configStr ? " on " : "") + cs.landSize + " Land" : "";
    const soldStr = cs.soldPrice ? " sold " + cs.soldPrice : "";
    const dateStr = cs.soldDate ? " on " + cs.soldDate : "";
    const detailLine = [configStr, landStr, soldStr, dateStr].filter(s=>s).join("").trim();
    return `<div class="comp-sale"><div class="comp-address">${i+1}. ${cs.address} –</div>${detailLine ? `<div class="comp-details">${detailLine}.</div>` : ""}</div>`;
  }).join("");
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
  ${footerHtml}</div>${compsHtml?`<div class="page"><img src="${LOGO_SRC}" class="logo" alt="PropWealth"><div class="comps-section"><h2>Comparable Sales –</h2>${compsHtml}</div>${footerHtml}</div>`:""}`;

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
function makeSafeName(name) {
  return name.replace(/\s+/g, "_").replace(/[^\w\-]/g, "");
}

function makeTimestamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}_${String(d.getHours()).padStart(2,"0")}${String(d.getMinutes()).padStart(2,"0")}`;
}

function makePropertyPath(address, state, postcode) {
  const ts = makeTimestamp();
  const parts = [makeSafeName(address), state, postcode, ts].filter(Boolean);
  return `${folders.property}/${parts.join("_")}.pdf`;
}

function makeSuburbPath(suburb, state, postcode) {
  const ts = makeTimestamp();
  const parts = [makeSafeName(suburb), state, postcode, ts].filter(Boolean);
  return `${folders.suburb}/${parts.join("_")}_Suburb_Report.pdf`;
}

// No timestamp — this is a cache file that needs to be found on subsequent runs
function makeSuburbDataPath(suburb, state, postcode) {
  const parts = [makeSafeName(suburb), state, postcode].filter(Boolean);
  return `${folders.suburb}/${parts.join("_")}_Suburb_Data.json`;
}

async function generatePdfBuffer(html) {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle", timeout: 15000 });
  const pdf = await page.pdf({ format: "A4", printBackground: true, margin: { top: "0mm", bottom: "0mm", left: "0mm", right: "0mm" }, displayHeaderFooter: false });
  await browser.close();
  return pdf;
}

async function generatePdfAndUpload(html, reportType, reportName) {
  const pdf = await generatePdfBuffer(html);
  const safeName = makeSafeName(reportName);
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

// ══════════════════════════════════════════════════════════════
// AUTO-REPORT: address in → scrape → generate → Dropbox
// ══════════════════════════════════════════════════════════════

const SCRAPER_BASE = process.env.SCRAPER_URL || "http://localhost:3000";
const SCRAPER_KEY = process.env.SCRAPER_API_KEY || "";

// Australian state → full name mapping
const STATE_NAMES = {
  NSW: "New South Wales", VIC: "Victoria", QLD: "Queensland",
  WA: "Western Australia", SA: "South Australia", TAS: "Tasmania",
  ACT: "Australian Capital Territory", NT: "Northern Territory",
};

// Parse "22 Baron Way, Gosnells, WA 6110" → { street, suburb, state, postcode }
function parseAddress(address) {
  const parts = address.split(",").map(s => s.trim());
  if (parts.length < 2) return { street: address, suburb: "", state: "", postcode: "" };

  const street = parts[0];
  const suburb = parts.length >= 3 ? parts[1] : "";
  const lastPart = parts[parts.length - 1]; // "WA 6110" or "NSW 2153"
  const statePostMatch = lastPart.match(/^([A-Z]{2,3})\s+(\d{4})$/);

  return {
    street,
    suburb: suburb || (parts.length === 2 ? "" : ""),
    state: statePostMatch ? statePostMatch[1] : "",
    postcode: statePostMatch ? statePostMatch[2] : "",
  };
}

// Call scraper API with error handling
async function callScraper(endpoint, body) {
  try {
    const headers = { "Content-Type": "application/json" };
    if (SCRAPER_KEY) headers["x-api-key"] = SCRAPER_KEY;

    const resp = await fetch(`${SCRAPER_BASE}${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      timeout: 300000,
    });

    // Handle non-JSON error responses (e.g. Render's "Too Many Requests" plain text)
    const contentType = resp.headers.get('content-type') || '';
    if (!resp.ok) {
      const text = await resp.text();
      console.error(`⚠️ Scraper ${endpoint} returned ${resp.status}: ${text.substring(0, 100)}`);
      return { success: false, error: `${resp.status}: ${text.substring(0, 100)}` };
    }
    if (!contentType.includes('application/json')) {
      const text = await resp.text();
      console.error(`⚠️ Scraper ${endpoint} returned non-JSON: ${text.substring(0, 100)}`);
      return { success: false, error: `Non-JSON response: ${text.substring(0, 100)}` };
    }

    const data = await resp.json();
    return data;
  } catch (err) {
    console.error(`⚠️ Scraper ${endpoint} failed:`, err.message);
    return { success: false, error: err.message };
  }
}

// Map scraper outputs → PDF generator inputs
function mapScraperToReport(input, suburbData, propertyData, comparablesData, placesAmenities) {
  const parsed = parseAddress(input.address);
  const state = input.state || parsed.state;
  const suburb = input.suburb || parsed.suburb;
  const stateName = input.stateName || STATE_NAMES[state] || state;

  // ── Suburb text (from Claude AI via scraper, or from input overrides) ──
  const sub = suburbData?.data || {};

  // Determine city — use Claude's LGA name, or fallback to suburb
  const cityName = input.cityName || sub.city_name || suburb;

  // Parse highlights — Claude now returns an array, but handle string fallback
  let highlights = input.cityHighlights || [];
  if (!highlights.length && sub.highlights) {
    if (typeof sub.highlights === "string") {
      highlights = sub.highlights.split(/\n|•|–/).map(s => s.trim()).filter(s => s);
    } else if (Array.isArray(sub.highlights)) {
      highlights = sub.highlights;
    }
  }

  // Parse paragraphs from Claude text
  function textToParagraphs(text) {
    if (!text) return [];
    if (Array.isArray(text)) return text;
    return text.split(/\n\s*\n/).map(s => s.trim()).filter(s => s);
  }

  const cityParagraphs = input.cityParagraphs || textToParagraphs(sub.city_overview) || textToParagraphs(sub.suburb_overview);
  const futureProspectsParagraphs = input.futureProspectsParagraphs || textToParagraphs(sub.future_prospects);

  // Suburb demographics paragraph — just the census-style stats paragraph for page 2
  let suburbParagraphs = input.suburbParagraphs || [];
  if (!suburbParagraphs.length && sub.suburb_demographics) {
    suburbParagraphs = textToParagraphs(sub.suburb_demographics);
  }

  // ── Property data (from CoreLogic, or from input overrides) ──
  const prop = propertyData?.data || {};

  // Build property description from listing description — clean up agent dump
  let propertyDescription = input.propertyDescription || "";
  let propertyFeatures = input.propertyFeatures || [];

  if (!propertyDescription && prop.listing_description) {
    const raw = prop.listing_description;

    // Patterns to strip from descriptions — CTAs, agent marketing, contact info, estate marketing
    const stripPatterns = [
      /(?:call|contact|phone|ring|reach out to)\s+(?:us|me|the agent|our team)\b[^.]*[.!?]?\s*/gi,
      /(?:don'?t miss|act fast|be quick|won'?t last|hurry|register your interest|enquire now|inspect today)[^.]*[.!?]?\s*/gi,
      /(?:for (?:more |further )?(?:information|details|enquiries|inspection times?))[^.]*[.!?]?\s*/gi,
      /(?:Built|Sold|Presented|Offered|Listed|Marketed)\s+by\s+[^.]+\.\s*/gi,
      /Disclaimer:[\s\S]*/i,
      /(?:all information|we have)[^.]*(?:accuracy|responsibility|liable|warranty)[^.]*\.\s*/gi,
      /(?:every care|reasonable effort)[^.]*(?:accuracy|correct)[^.]*\.\s*/gi,
      // Estate/development marketing language
      /(?:is bursting to life|perfectly positioned to take advantage)[^.]*\.\s*/gi,
      /(?:you'll be delighted|you will be delighted|you won't be disappointed)[^.]*\.\s*/gi,
      /(?:create a new balance|a sense of freedom|promises a relaxed)[^.]*\.\s*/gi,
      /(?:set within an exclusive|exclusive enclave|highly.?sought after pocket)[^.]*\.\s*/gi,
      /(?:find out more about|find out how)[^.]*\.\s*/gi,
    ];

    // Detect if the entire description is estate/development marketing (not property-specific)
    // Signs: references estate names without specific property features like rooms, kitchen, etc.
    const estateMarketingScore = [
      /\b(?:estate|rise|village|gardens|grove|heights|terrace|meadows|quarter)\b.*(?:is perfectly|take advantage|bursting to life|promises)/i,
      /(?:work,?\s*life\s*and\s*play|family.?friendly\s*lifestyle\s*for\s*its\s*residents)/i,
      /(?:create a new|borne out of|sense of freedom)/i,
    ].reduce((score, re) => score + (re.test(raw) ? 1 : 0), 0);

    // If 2+ estate marketing signals, the description is about the estate, not this property — discard
    const isEstateMarketing = estateMarketingScore >= 2;

    function cleanAgentText(text) {
      let cleaned = text;
      for (const pattern of stripPatterns) {
        cleaned = cleaned.replace(pattern, "");
      }
      return cleaned.trim();
    }

    // Split on common feature delimiters: *, •, –, or numbered lists
    const featurePattern = /(?:\*|•|–|\d+\.\s)/;

    if (isEstateMarketing) {
      // Description is about the estate/development, not this property — skip it
      console.log(`   ⚠️ Listing description appears to be estate marketing — skipping`);
      propertyDescription = "";
    } else if (featurePattern.test(raw)) {
      // Split into intro text and features
      const firstDelimiter = raw.search(featurePattern);
      const introText = raw.substring(0, firstDelimiter).trim();
      const featuresText = raw.substring(firstDelimiter);

      // Extract intro paragraphs (trim to reasonable length — ~2 paragraphs)
      if (introText) {
        const cleanIntro = cleanAgentText(introText);
        // Split into sentences, take first ~3 sentences for a concise description
        const sentences = cleanIntro.match(/[^.!?]+[.!?]+/g) || [cleanIntro];
        propertyDescription = sentences.slice(0, 4).join(" ").trim();
      }

      // Extract features as bullet points
      if (!propertyFeatures.length) {
        propertyFeatures = featuresText
          .split(/\*|•|–/)
          .map(f => f.trim())
          .filter(f => f.length > 5 && f.length < 200)
          // Remove disclaimer text from features
          .filter(f => !/disclaimer|accuracy|responsibility|interested parties/i.test(f))
          .slice(0, 15); // Cap at 15 features
      }
    } else {
      // No features delimiter found — just use first ~4 sentences as description
      const cleanText = cleanAgentText(raw);
      const sentences = cleanText.match(/[^.!?]+[.!?]+/g) || [cleanText];
      propertyDescription = sentences.slice(0, 4).join(" ").trim();
    }
  }

  // Map schools + Google Places to amenities format
  let amenities = input.amenities || [];
  if (!amenities.length) {
    const seenNames = new Set();

    // CoreLogic schools first
    if (prop.schools?.length) {
      for (const s of prop.schools) {
        const entry = `${s.name}${s.distance ? " - " + s.distance : ""}${s.type ? " (" + s.type + ")" : ""}`;
        seenNames.add(s.name.toLowerCase());
        amenities.push(entry);
      }
    }

    // Google Places amenities (deduplicated against schools)
    if (placesAmenities?.length) {
      for (const a of placesAmenities) {
        if (seenNames.has(a.name.toLowerCase())) continue;
        seenNames.add(a.name.toLowerCase());
        amenities.push(a.formatted);
      }
    }
  }

  // ── Comparable sales ──
  let comparableSales = input.comparableSales || [];
  if (!comparableSales.length && comparablesData?.success && comparablesData.data) {
    comparableSales = comparablesData.data
      .filter(c => c.success)
      .map(c => ({
        address: c.address,
        beds: c.bedrooms || "",
        baths: c.bathrooms || "",
        garages: c.car_spaces || "",
        landSize: c.land_size || "",
        soldPrice: c.sold_price || "",
        soldDate: c.sold_date || "",
      }));
  }

  // ── Insights from DSR (with source labels) ──
  function fmtInsight(value, recommendation, source) {
    if (!value) return "";
    // If value already has a label in parentheses, use as-is
    if (String(value).includes("(")) return value;
    const labels = [];
    if (recommendation) labels.push(recommendation);
    if (source) labels.push(source);
    if (labels.length) return value + " (" + labels.join(" | ") + ")";
    return value;
  }

  const vacancySource = sub.vacancy_source || "DSR Data";
  const insights = input.insights || {
    percentageRenters: fmtInsight(sub.renters_percentage, "Ideally under 40%", "DSR Data"),
    daysOnMarket: fmtInsight(sub.days_on_market ? sub.days_on_market + " days" : "", "Recommended under 60 days", "DSR Data"),
    vacancyRate: fmtInsight(sub.vacancy_rate, "Ideal under 1.5%", vacancySource),
    vendorDiscounting: fmtInsight(sub.vendor_discounting && sub.vendor_discounting !== "0.00%" && sub.vendor_discounting !== "0%" ? sub.vendor_discounting : "", "Ideal under 5% plus", "DSR Data"),
    stockOnMarket: fmtInsight(sub.stock_on_market, "Ideal under 2%", "DSR Data"),
  };

  // ── Rental estimates for cashflow ──
  // CoreLogic rental values come in various formats:
  //   "$1,100/W", "$1.1k/W", "$1,100", "$650/W", "$650"
  function parseRental(val) {
    if (!val) return 0;
    const s = String(val).trim();

    // Handle "k" suffix: "$1.1k" → 1100
    const kMatch = s.match(/\$?\s*([\d,.]+)\s*k/i);
    if (kMatch) {
      return parseFloat(kMatch[1].replace(/,/g, "")) * 1000;
    }

    // Handle standard: "$1,100/W" or "$650" — strip non-numeric except dots
    const cleaned = s.replace(/,/g, "").match(/\$?\s*([\d.]+)/);
    if (cleaned) {
      const num = parseFloat(cleaned[1]);
      // Sanity check: if value is unrealistically low for weekly rent (< $50),
      // it's probably in thousands (e.g., "1.1" meaning $1,100)
      if (num > 0 && num < 50) return num * 1000;
      return num;
    }
    return 0;
  }

  const rentalLow = parseRental(input.lowerRentWeekly || prop.rental_low || input.currentRent);
  const rentalHigh = parseRental(input.higherRentWeekly || prop.rental_high || input.currentRent) || rentalLow;

  // ── Purchase price — from input, CoreLogic valuation, or CoreLogic sold price ──
  function parsePrice(val) {
    if (!val) return 0;
    if (typeof val === "number") return val;
    const str = String(val).trim();
    // Handle suffixes like $3.92M, $3.92m, $975K, $975k
    const suffixMatch = str.match(/\$?\s*([\d,.]+)\s*(m|k)/i);
    if (suffixMatch) {
      const num = parseFloat(suffixMatch[1].replace(/,/g, ""));
      const suffix = suffixMatch[2].toLowerCase();
      if (suffix === "m") return num * 1000000;
      if (suffix === "k") return num * 1000;
    }
    return parseFloat(str.replace(/[^0-9.]/g, "")) || 0;
  }

  const purchasePrice = parsePrice(input.purchasePrice || input.price) ||
                        parsePrice(prop.valuation_estimate) ||
                        parsePrice(prop.sold_price) || 0;

  // ── Cashflow inputs (auto from scraped data, overridable) ──
  let cashflowInputs = input.cashflowInputs || null;
  if (!cashflowInputs && purchasePrice > 0 && rentalLow > 0) {
    cashflowInputs = {
      purchasePrice,
      lowerRentWeekly: rentalLow,
      higherRentWeekly: rentalHigh,
      // Auto-calculate stamp duty and mortgage fee if not provided
      stampDuty: input.stampDuty != null ? input.stampDuty : undefined, // let calculateCashflow auto-calc
      mortgageFee: input.mortgageFee != null ? input.mortgageFee : undefined,
    };
  }

  // Allow individual cashflow field overrides
  if (cashflowInputs && input.cashflowOverrides) {
    cashflowInputs = { ...cashflowInputs, ...input.cashflowOverrides };
  }

  // ── Build final report data ──
  return {
    // City/Suburb pages
    cityName,
    stateName,
    cityHighlights: highlights,
    cityParagraphs,
    futureProspectsParagraphs,
    suburbName: suburb,
    suburbParagraphs,
    insights,

    // Property page
    propertyAddress: input.address,
    state,
    listingType: input.listingType || (prop.market_status === "OFF Market" ? "OFF MARKET" : (prop.market_status || "")),
    price: input.price || (purchasePrice ? "$" + Number(purchasePrice).toLocaleString() : ""),
    currentRent: input.currentRent || (prop.current_rental ? "$" + parseRental(prop.current_rental).toLocaleString() : ""),
    occupancyStatus: input.occupancyStatus || prop.occupancy_status || "",
    bedrooms: input.bedrooms || prop.bedrooms || "",
    bathrooms: input.bathrooms || prop.bathrooms || "",
    garages: input.garages || prop.car_spaces || "",
    landSize: input.landSize || (prop.land_size ? prop.land_size + " sqm" : ""),
    buildingSize: input.buildingSize || (prop.floor_area ? prop.floor_area + " sqm" : ""),
    yearBuilt: input.yearBuilt || prop.year_built || "",
    propertyType: input.propertyType || prop.property_type || "",
    propertyDescription,
    propertyFeatures,
    locationDescription: input.locationDescription || "",
    amenities,
    comparableSales,

    // Cashflow
    cashflowInputs,
    smsfCashflowInputs: input.smsfCashflowInputs || null,

    // Report settings
    reportName: input.reportName || input.address.split(",")[0].trim().replace(/\s+/g, "_"),
  };
}

// Serve Google API key to frontend for address autocomplete
app.get("/api/config", (req, res) => {
  res.json({ googleApiKey: GOOGLE_API_KEY || "" });
});

// ── AUTO-REPORT ENDPOINT ──
app.post("/auto-report", async (req, res) => {
  const input = req.body;

  if (!input.address) {
    return res.status(400).json({ error: "Missing required field: address" });
  }

  console.log(`\n🚀 Auto-report for: ${input.address}`);
  const startTime = Date.now();
  const errors = [];

  try {
    const parsed = parseAddress(input.address);
    const suburb = input.suburb || parsed.suburb;
    const state = input.state || parsed.state;
    const postcode = input.postcode || parsed.postcode;

    if (!suburb || !state || !postcode) {
      return res.status(400).json({
        error: "Could not parse suburb/state/postcode from address. Please provide them explicitly.",
        parsed,
      });
    }

    // ════════════════════════════════════════════
    // STEP 1: Check if property report already exists
    // ════════════════════════════════════════════
    const propertyNameBase = makeSafeName(input.reportName || parsed.street + "_" + suburb);
    const propertyPrefix = [propertyNameBase, state, postcode].filter(Boolean).join("_");
    const propertyPath = makePropertyPath(input.reportName || parsed.street + "_" + suburb, state, postcode);

    if (!input.forceRegenerate) {
      const existing = await dropboxListFolder(folders.property, propertyPrefix);
      if (existing.length > 0) {
        // Return the most recent match
        const latest = existing.sort((a, b) => (b.name || "").localeCompare(a.name || ""))[0];
        const link = await dropboxGetSharedLink(latest.path_display || latest.path_lower);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`   ⏩ Property report already exists: ${latest.name}`);
        return res.json({
          success: true,
          exists: true,
          message: `Property report already exists: ${latest.name}`,
          path: latest.path_display || latest.path_lower,
          dropboxLink: link || undefined,
          lastModified: latest.server_modified || latest.client_modified,
          elapsed: elapsed + "s",
        });
      }
    }

    // ════════════════════════════════════════════
    // STEP 2: Check suburb report cache
    // ════════════════════════════════════════════
    const suburbPath = makeSuburbPath(suburb, state, postcode);
    const suburbDataPath = makeSuburbDataPath(suburb, state, postcode);
    const existingSuburbData = await dropboxGetMetadata(suburbDataPath);
    let suburbResult = null;
    let suburbIsFresh = false;
    let cachedSuburbData = null;

    if (input.forceSuburbRefresh) {
      console.log(`   🔄 Force suburb refresh requested — ignoring cache`);
      if (existingSuburbData) await dropboxDelete(suburbDataPath);
    } else if (existingSuburbData) {
      const modDate = new Date(existingSuburbData.server_modified || existingSuburbData.client_modified);
      const ageMs = Date.now() - modDate.getTime();
      const threeMonthsMs = 90 * 24 * 60 * 60 * 1000;

      if (ageMs < threeMonthsMs) {
        // Suburb data is fresh — load cached JSON
        console.log(`   📋 Suburb data cache is fresh (${Math.round(ageMs / 86400000)} days old) — loading`);
        const cachedJson = await dropboxDownload(suburbDataPath);
        if (cachedJson) {
          try {
            cachedSuburbData = JSON.parse(cachedJson.toString());
            suburbIsFresh = true;
            console.log(`   ✅ Loaded cached suburb data from ${suburbDataPath}`);
          } catch (e) {
            console.log(`   ⚠️ Cached suburb JSON is corrupt — will regenerate`);
          }
        } else {
          console.log(`   ⚠️ Could not download suburb data JSON — will regenerate`);
        }
      } else {
        // Suburb data is stale — delete and regenerate
        console.log(`   🗑️  Suburb data is stale (${Math.round(ageMs / 86400000)} days old) — deleting`);
        await dropboxDelete(suburbDataPath);
      }
    } else {
      console.log(`   📄 No cached suburb data for ${suburb} — will generate`);
    }

    // ════════════════════════════════════════════
    // STEP 3: Sequential scraping
    // ════════════════════════════════════════════
    // Calls are sequential because the scraper runs Playwright which is
    // memory-heavy — parallel requests can cause timeouts on hobby tier.
    console.log(`   Scraping: suburb=${suburb}, state=${state}, postcode=${postcode}`);

    // 1. Suburb data — skip entirely if we have cached data
    let suburbScrapeResult;
    if (!suburbIsFresh) {
      const needSuburbText = !input.cityParagraphs || !input.futureProspectsParagraphs;
      if (needSuburbText) {
        suburbScrapeResult = await callScraper("/api/suburb", { suburb, state, postcode });
        console.log(`   ✅ Suburb data: ${suburbScrapeResult.success ? "OK" : "FAILED"}`);
      } else {
        suburbScrapeResult = { success: true, data: {} };
      }
    } else {
      console.log(`   ⏩ Skipping suburb scrape entirely (using cached data)`);
      suburbScrapeResult = { success: true, data: cachedSuburbData };
    }

    // 2. Property data (CoreLogic) — skip if key fields provided
    let propertyResult;
    const needProperty = !input.bedrooms || !input.bathrooms;
    if (needProperty) {
      propertyResult = await callScraper("/api/property", { address: input.address });
      console.log(`   ✅ Property data: ${propertyResult.success ? "OK" : "FAILED"}`);
    } else {
      propertyResult = { success: true, data: {} };
    }

    // 3. Comparables (Domain.com.au) — only if addresses provided
    let comparablesResult = null;
    if (input.comparableAddresses?.length) {
      comparablesResult = await callScraper("/api/domain-comparables", { addresses: input.comparableAddresses });
      console.log(`   ✅ Comparables (Domain): ${comparablesResult.success ? "OK" : "FAILED"}`);
    }

    if (suburbScrapeResult && !suburbScrapeResult.success) errors.push({ source: "suburb", error: suburbScrapeResult.error });
    if (propertyResult && !propertyResult.success) errors.push({ source: "property", error: propertyResult.error });
    if (comparablesResult && !comparablesResult.success) errors.push({ source: "comparables", error: comparablesResult.error });

    // 3b. Backfill missing comparable details from CoreLogic
    if (comparablesResult?.success && comparablesResult.data?.length) {
      const incomplete = comparablesResult.data.filter(c => c.success && (!c.bedrooms || !c.bathrooms));
      if (incomplete.length) {
        console.log(`   🔍 Backfilling ${incomplete.length} comparable(s) from CoreLogic...`);
        const backfillAddresses = incomplete.map(c => c.address);
        try {
          const clResult = await callScraper("/api/comparables", { addresses: backfillAddresses });
          if (clResult?.success && clResult.data?.length) {
            for (const clComp of clResult.data) {
              if (!clComp.success) continue;
              // Find matching Domain comp and fill gaps
              const domComp = comparablesResult.data.find(d =>
                d.success && d.address && clComp.address &&
                d.address.replace(/\s+/g, " ").toLowerCase().includes(clComp.address.replace(/\s+/g, " ").toLowerCase().split(",")[0])
              );
              if (domComp) {
                if (!domComp.bedrooms && clComp.bedrooms) domComp.bedrooms = clComp.bedrooms;
                if (!domComp.bathrooms && clComp.bathrooms) domComp.bathrooms = clComp.bathrooms;
                if (!domComp.car_spaces && clComp.car_spaces) domComp.car_spaces = clComp.car_spaces;
                if (!domComp.land_size && clComp.land_size) domComp.land_size = clComp.land_size;
                if (!domComp.sold_price && clComp.sold_price) domComp.sold_price = clComp.sold_price;
                if (!domComp.sold_date && clComp.sold_date) domComp.sold_date = clComp.sold_date;
                console.log(`   ✅ Backfilled: ${domComp.address} — ${domComp.bedrooms || "?"}bed/${domComp.bathrooms || "?"}bath`);
              }
            }
          }
        } catch (e) {
          console.log(`   ⚠️ CoreLogic backfill failed: ${e.message}`);
        }
      }
    }

    // 4. Google Places amenities
    let placesAmenities = [];
    if (!input.amenities?.length && GOOGLE_API_KEY) {
      console.log(`   🗺️  Fetching nearby amenities via Google Places...`);
      placesAmenities = await fetchNearbyAmenities(input.address).catch(err => {
        errors.push({ source: "google_places", error: err.message });
        return [];
      });
    }

    // ════════════════════════════════════════════
    // STEP 4: Map data and build reports
    // ════════════════════════════════════════════
    const reportData = mapScraperToReport(input, suburbScrapeResult, propertyResult, comparablesResult, placesAmenities);

    // ════════════════════════════════════════════
    // STEP 4b: Validate critical data before generating reports
    // ════════════════════════════════════════════

    // Suburb report requires at least some suburb text content
    const hasSuburbContent = reportData.cityParagraphs?.length > 0 ||
      reportData.suburbParagraphs?.length > 0 ||
      reportData.futureProspectsParagraphs?.length > 0;

    // Property report requires at minimum bedrooms or a price
    const hasPropertyContent = reportData.bedrooms || reportData.bathrooms ||
      reportData.price || reportData.cashflowInputs;

    if (!hasSuburbContent && !suburbIsFresh) {
      console.log(`   ❌ Suburb scrape returned no content — skipping suburb report upload`);
      errors.push({ source: "validation", error: "Suburb data is empty — suburb report not generated" });
    }

    if (!hasPropertyContent) {
      console.log(`   ❌ Property scrape returned no content — skipping property report upload`);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      return res.status(422).json({
        success: false,
        error: "Property data is empty — cannot generate a meaningful report. Check that the scraper is working and the address is valid.",
        elapsed: elapsed + "s",
        errors,
      });
    }

    // ════════════════════════════════════════════
    // STEP 5: Suburb report — generate/update if needed, save data cache
    // ════════════════════════════════════════════
    if (!suburbIsFresh && hasSuburbContent) {
      console.log(`   📄 Generating suburb report for ${suburb}...`);
      const suburbHtml = buildSuburbReportHtml(reportData);
      const suburbPdf = await generatePdfBuffer(suburbHtml);
      await dropboxUpload(suburbPath, suburbPdf);

      // Save the suburb data as JSON for future reuse (skips both DSR + Claude next time)
      const suburbCacheData = suburbScrapeResult?.data || {};
      const suburbDataPath = makeSuburbDataPath(suburb, state, postcode);
      await dropboxUpload(suburbDataPath, Buffer.from(JSON.stringify(suburbCacheData, null, 2)));
      console.log(`   ✅ Suburb report + data cache uploaded: ${suburbPath}`);
    } else if (!suburbIsFresh) {
      console.log(`   ⏩ Skipping suburb report — no content to generate`);
    }

    // ════════════════════════════════════════════
    // STEP 6: Generate property report (full = suburb + property + cashflow)
    // ════════════════════════════════════════════
    console.log(`   📄 Building property report PDF...`);
    const html = buildPropertyReportHtml(reportData);
    const propertyPdf = await generatePdfBuffer(html);
    await dropboxUpload(propertyPath, propertyPdf);

    const propertyLink = await dropboxGetSharedLink(propertyPath);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ Auto-report complete in ${elapsed}s: ${propertyPath}`);

    res.json({
      success: true,
      message: `✅ Property report uploaded: ${propertyPath}`,
      path: propertyPath,
      dropboxLink: propertyLink || undefined,
      suburbReportPath: suburbPath,
      suburbReportReused: !!suburbIsFresh,
      elapsed: elapsed + "s",
      errors: errors.length ? errors : undefined,
      debug: process.env.DEBUG === "true" ? reportData : undefined,
    });
  } catch (err) {
    console.error("❌ Auto-report error:", err);
    res.status(500).json({ error: err.message, errors });
  }
});

// ── AUTO-SUBURB ENDPOINT ──
app.post("/auto-suburb", async (req, res) => {
  const input = req.body;

  if (!input.suburb && !input.address) {
    return res.status(400).json({ error: "Missing required field: suburb or address" });
  }

  const parsed = input.address ? parseAddress(input.address) : {};
  const suburb = input.suburb || parsed.suburb;
  const state = input.state || parsed.state;
  const postcode = input.postcode || parsed.postcode;

  if (!suburb || !state || !postcode) {
    return res.status(400).json({ error: "Could not determine suburb/state/postcode. Please provide them explicitly." });
  }

  console.log(`\n📍 Auto-suburb for: ${suburb} ${state} ${postcode}`);

  try {
    // Check if suburb report already exists and is fresh
    const suburbPath = makeSuburbPath(suburb, state, postcode);
    const existing = await dropboxGetMetadata(suburbPath);

    if (existing && !input.forceRegenerate) {
      const modDate = new Date(existing.server_modified || existing.client_modified);
      const ageMs = Date.now() - modDate.getTime();
      const threeMonthsMs = 90 * 24 * 60 * 60 * 1000;

      if (ageMs < threeMonthsMs) {
        const link = await dropboxGetSharedLink(suburbPath);
        console.log(`   ⏩ Suburb report already exists and is fresh (${Math.round(ageMs / 86400000)} days old)`);
        return res.json({
          success: true,
          exists: true,
          message: `Suburb report already exists: ${existing.name} (${Math.round(ageMs / 86400000)} days old)`,
          path: suburbPath,
          dropboxLink: link || undefined,
          lastModified: existing.server_modified || existing.client_modified,
        });
      } else {
        console.log(`   🗑️  Suburb report is stale (${Math.round(ageMs / 86400000)} days old) — regenerating`);
        await dropboxDelete(suburbPath);
      }
    }

    const suburbResult = await callScraper("/api/suburb", { suburb, state, postcode });
    const sub = suburbResult?.data || {};

    function textToParagraphs(text) {
      if (!text) return [];
      if (Array.isArray(text)) return text;
      return text.split(/\n\s*\n/).map(s => s.trim()).filter(s => s);
    }

    let highlights = input.cityHighlights || [];
    if (!highlights.length && sub.highlights) {
      if (typeof sub.highlights === "string") {
        highlights = sub.highlights.split(/\n|•|–/).map(s => s.trim()).filter(s => s);
      } else if (Array.isArray(sub.highlights)) {
        highlights = sub.highlights;
      }
    }

    const reportData = {
      cityName: input.cityName || sub.city_name || suburb,
      stateName: input.stateName || STATE_NAMES[state] || state,
      cityHighlights: highlights,
      cityParagraphs: input.cityParagraphs || textToParagraphs(sub.city_overview) || textToParagraphs(sub.suburb_overview),
      futureProspectsParagraphs: input.futureProspectsParagraphs || textToParagraphs(sub.future_prospects),
      suburbName: suburb,
      suburbParagraphs: input.suburbParagraphs || textToParagraphs(sub.suburb_demographics),
      insights: input.insights || {
        percentageRenters: sub.renters_percentage ? sub.renters_percentage + " (Ideally under 40% | DSR Data)" : "",
        daysOnMarket: sub.days_on_market ? sub.days_on_market + " days (Recommended under 60 days | DSR Data)" : "",
        vacancyRate: sub.vacancy_rate ? sub.vacancy_rate + " (Ideal under 1.5% | " + (sub.vacancy_source || "DSR Data") + ")" : "",
        vendorDiscounting: sub.vendor_discounting && sub.vendor_discounting !== "0.00%" && sub.vendor_discounting !== "0%" ? sub.vendor_discounting + " (Ideal under 5% plus | DSR Data)" : "",
        stockOnMarket: sub.stock_on_market ? sub.stock_on_market + " (Ideal under 2% | DSR Data)" : "",
      },
      reportName: input.reportName || suburb + "_Suburb_Report",
    };

    // Validate — don't upload empty suburb reports
    const hasContent = reportData.cityParagraphs?.length > 0 ||
      reportData.suburbParagraphs?.length > 0 ||
      reportData.futureProspectsParagraphs?.length > 0;

    if (!hasContent && !suburbResult?.success) {
      console.log(`   ❌ Suburb scrape failed and no content available`);
      return res.status(422).json({
        success: false,
        error: "Suburb data is empty — scraper may have failed. Report not generated to avoid uploading blank data.",
        scraperError: suburbResult?.error || "Unknown",
      });
    }

    const html = buildSuburbReportHtml(reportData);
    const suburbPdf = await generatePdfBuffer(html);
    await dropboxUpload(suburbPath, suburbPdf);

    // Save suburb data as JSON cache for reuse by property reports
    const suburbDataPath = makeSuburbDataPath(suburb, state, postcode);
    await dropboxUpload(suburbDataPath, Buffer.from(JSON.stringify(sub, null, 2)));
    console.log(`   💾 Suburb data cache saved: ${suburbDataPath}`);

    const link = await dropboxGetSharedLink(suburbPath);
    console.log(`✅ Auto-suburb report uploaded: ${suburbPath}`);
    res.json({
      success: true,
      message: `✅ Suburb report uploaded: ${suburbPath}`,
      path: suburbPath,
      dropboxLink: link || undefined,
    });
  } catch (err) {
    console.error("❌ Auto-suburb error:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`PropWealth Report Generator running on port ${PORT}`);
  console.log(`   Scraper API: ${SCRAPER_BASE}`);
  console.log(`   Auto-report: POST /auto-report { address: "..." }`);
  console.log(`   Auto-suburb: POST /auto-suburb { suburb, state, postcode }`);
});

// Graceful shutdown
async function shutdown(signal) {
  console.log(`\n${signal} received — shutting down...`);
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));