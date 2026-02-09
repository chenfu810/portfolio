/**
 * Deploy this as a Google Apps Script Web App to store shared history.
 *
 * Steps:
 * 1) Create a new Apps Script project.
 * 2) Paste this file.
 * 3) Set SHEET_ID and TOKEN below.
 * 4) Deploy -> New deployment -> Web app:
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 5) Copy the Web App URL to HISTORY_SYNC_URL in app.js.
 * 6) Copy TOKEN to HISTORY_SYNC_TOKEN in app.js.
 */

const SHEET_ID = "REPLACE_WITH_YOUR_GOOGLE_SHEET_ID";
const TOKEN = "REPLACE_WITH_A_LONG_RANDOM_TOKEN";
const PORTFOLIO_SHEET = "portfolio_history_sync";
const DAILY_SHEET = "daily_pl_history_sync";

function doGet(e) {
  if (!isAuthorized(e && e.parameter)) {
    return json({ ok: false, error: "unauthorized" });
  }
  const mode = (e.parameter.mode || "read").toLowerCase();
  if (mode !== "read") {
    return json({ ok: false, error: "unsupported_mode" });
  }

  const portfolioHistory = readPortfolioHistory();
  const dailyHistory = readDailyHistory();
  return json({
    ok: true,
    portfolioHistory,
    dailyHistory,
  });
}

function doPost(e) {
  let payload = {};
  try {
    payload = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    return json({ ok: false, error: "invalid_json" });
  }

  if (!isAuthorized(payload)) {
    return json({ ok: false, error: "unauthorized" });
  }

  const mode = ((payload.mode || "write") + "").toLowerCase();
  if (mode !== "write") {
    return json({ ok: false, error: "unsupported_mode" });
  }

  const portfolioHistory = Array.isArray(payload.portfolioHistory) ? payload.portfolioHistory : [];
  const dailyHistory = Array.isArray(payload.dailyHistory) ? payload.dailyHistory : [];

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    writePortfolioHistory(portfolioHistory);
    writeDailyHistory(dailyHistory);
  } finally {
    lock.releaseLock();
  }

  return json({ ok: true });
}

function isAuthorized(input) {
  const token = ((input && input.token) || "").toString();
  if (!TOKEN) return true;
  return token === TOKEN;
}

function getSheet(name) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function readPortfolioHistory() {
  const sheet = getSheet(PORTFOLIO_SHEET);
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];
  return values.slice(1).map((row) => {
    const date = (row[0] || "").toString();
    const totalValue = Number(row[1] || 0);
    const positionsRaw = (row[2] || "{}").toString();
    let positions = {};
    try {
      positions = JSON.parse(positionsRaw);
    } catch (err) {
      positions = {};
    }
    return { date, totalValue, positions };
  });
}

function readDailyHistory() {
  const sheet = getSheet(DAILY_SHEET);
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];
  return values.slice(1).map((row) => ({
    date: (row[0] || "").toString(),
    pl: Number(row[1] || 0),
    pct: Number(row[2] || 0),
  }));
}

function writePortfolioHistory(entries) {
  const sheet = getSheet(PORTFOLIO_SHEET);
  const normalized = entries
    .map((item) => ({
      date: (item && item.date ? item.date : "").toString(),
      totalValue: Number(item && item.totalValue),
      positions: item && item.positions && typeof item.positions === "object" ? item.positions : {},
    }))
    .filter((item) => item.date && Number.isFinite(item.totalValue))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-520);

  sheet.clearContents();
  const rows = [["date", "totalValue", "positionsJson"]].concat(
    normalized.map((item) => [item.date, item.totalValue, JSON.stringify(item.positions)])
  );
  sheet.getRange(1, 1, rows.length, 3).setValues(rows);
}

function writeDailyHistory(entries) {
  const sheet = getSheet(DAILY_SHEET);
  const normalized = entries
    .map((item) => ({
      date: (item && item.date ? item.date : "").toString(),
      pl: Number(item && item.pl),
      pct: Number(item && item.pct),
    }))
    .filter((item) => item.date && Number.isFinite(item.pl))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-400);

  sheet.clearContents();
  const rows = [["date", "pl", "pct"]].concat(
    normalized.map((item) => [item.date, item.pl, item.pct])
  );
  sheet.getRange(1, 1, rows.length, 3).setValues(rows);
}

function json(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(
    ContentService.MimeType.JSON
  );
}
