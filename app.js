const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1YYl_8P_HehmfZzRGa7q-zWvNEiI22JrduPkTFXJ-1D4/export?format=csv&gid=0";

const HISTORY_CSV_URL = "";

const FMP_API_KEY = "";
const FMP_QUOTE_BASE = "https://financialmodelingprep.com/stable/batch-quote";
const LIVE_PRICE_REFRESH_MS = 60_000;
const LIVE_PRICE_MAX_BACKOFF_MS = 5 * 60_000;

const SAMPLE_CSV = `ticket,shares,price,daily change %
NVDA,100,765.42,1.1%
AAPL,50,183.27,-0.4%
MSFT,20,421.88,0.8%
AMZN,12,162.55,0.5%
TSLA,8,192.13,-1.6%`;

const fmtCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const fmtPercent = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 2,
});

let historyChart;
let benchmarkCurveChart;
let liveRows = [];
let liveUpdateScheduled = false;
let livePriceRunId = 0;
let holdingsSortState = { key: "dailyValue", direction: "desc" };
let currentRows = [];
let currentNewsItems = [];
let newsIsLoading = false;
let dailyHistoryExpanded = false;
let pricesLastUpdatedAt = null;
let newsLastUpdatedAt = null;
let priceMode = "regular";
let lastRecordedSignature = "";

const DAILY_PL_STORAGE_KEY = "portfolio_pulse_daily_pl_v1";
const DAILY_PL_HISTORY_LIMIT = 400;
const DAILY_CALENDAR_START_ISO = "2026-02-01";
const THEME_STORAGE_KEY = "portfolio_pulse_theme_v1";
const THEME_OPTIONS = ["nocturne", "ocean", "ember"];
const PRICE_MODE_STORAGE_KEY = "portfolio_pulse_price_mode_v1";
const PORTFOLIO_HISTORY_STORAGE_KEY = "portfolio_pulse_portfolio_history_v1";
const PORTFOLIO_HISTORY_LIMIT = 520;
const BENCHMARK_SYMBOLS = ["SPY", "QQQ"];

let latestPortfolioReturns = {
  d1: null,
  w1: null,
  m1: null,
  ytd: null,
};
let latestBenchmarkReturns = {};
let latestBenchmarkSeries = {};
let benchmarkLastUpdatedAt = null;

const NEWS_RSS_SOURCES = {
  cnbc: {
    label: "CNBC",
    rssUrl: "https://www.cnbc.com/id/100003114/device/rss/rss.html",
  },
  yahoo: {
    label: "Yahoo Finance",
    rssUrl: "https://finance.yahoo.com/news/rssindex",
  },
  reuters: {
    label: "Reuters",
    rssUrl: "http://feeds.reuters.com/reuters/businessNews",
  },
};

const ADVICE_EXTERNAL_LINKS = {
  chatgpt: "https://chat.openai.com/",
  claude: "https://claude.ai/",
  gemini: "https://gemini.google.com/",
  perplexity: "https://www.perplexity.ai/",
};

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const sample = lines[0] || "";
  const delimiter = sample.includes(",") ? "," : sample.includes("\t") ? "\t" : ",";
  const headers = lines.shift().split(delimiter).map((h) => h.trim());
  return lines.map((line) => {
    const values = line.split(delimiter).map((v) => v.trim());
    return headers.reduce((acc, header, idx) => {
      acc[header] = values[idx] ?? "";
      return acc;
    }, {});
  });
}

function parseBooleanFlag(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  const normalized = (value || "").toString().trim().toLowerCase();
  return (
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "y" ||
    normalized === "1" ||
    normalized === "t"
  );
}

function normalizeTheme(theme) {
  const candidate = (theme || "").toString().trim().toLowerCase();
  if (THEME_OPTIONS.includes(candidate)) {
    return candidate;
  }
  return "nocturne";
}

function setTheme(theme) {
  const normalized = normalizeTheme(theme);
  document.body.classList.remove("theme-ocean", "theme-ember");
  if (normalized !== "nocturne") {
    document.body.classList.add(`theme-${normalized}`);
  }
  document.querySelectorAll("#themeToggle .theme-pill").forEach((button) => {
    const isActive = button.dataset.theme === normalized;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
  try {
    localStorage.setItem(THEME_STORAGE_KEY, normalized);
  } catch (err) {
    // Ignore storage failures (private mode / blocked storage).
  }
}

function initTheme() {
  let saved = "nocturne";
  try {
    saved = localStorage.getItem(THEME_STORAGE_KEY) || "nocturne";
  } catch (err) {
    saved = "nocturne";
  }
  setTheme(saved);
}

function normalizePriceMode(mode) {
  const candidate = (mode || "").toString().trim().toLowerCase();
  return candidate === "extended" ? "extended" : "regular";
}

function setPriceMode(mode, shouldRender = true) {
  priceMode = normalizePriceMode(mode);
  document.querySelectorAll("#priceModeToggle .mode-pill").forEach((button) => {
    const isActive = button.dataset.mode === priceMode;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
  try {
    localStorage.setItem(PRICE_MODE_STORAGE_KEY, priceMode);
  } catch (err) {
    // Ignore storage failures.
  }
  renderDataFreshness();
  if (shouldRender) {
    scheduleLiveRender();
  }
}

function initPriceMode() {
  let saved = "regular";
  try {
    saved = localStorage.getItem(PRICE_MODE_STORAGE_KEY) || "regular";
  } catch (err) {
    saved = "regular";
  }
  setPriceMode(saved, false);
}

function normalizeRow(row) {
  const normalized = {};
  Object.entries(row).forEach(([key, value]) => {
    const cleanKey = key.toLowerCase().replace(/\s+/g, " ").trim();
    normalized[cleanKey] = value;
  });

  const ticker = normalized["ticker"] || normalized["ticket"] || "";
  const tickerUpper = ticker.toString().trim().toUpperCase();
  const shares = Number(normalized["shares"] || 0);
  const price = Number(normalized["price (current)"] || normalized["price"] || 0);
  const afterHoursRaw =
    normalized["after hours price"] ||
    normalized["after-hour price"] ||
    normalized["afterhours price"] ||
    normalized["extended hours price"] ||
    normalized["post market price"] ||
    normalized["after market price"] ||
    "";
  const afterHoursNum = Number(afterHoursRaw);
  const afterHoursPrice =
    Number.isFinite(afterHoursNum) && afterHoursNum > 0 ? afterHoursNum : null;
  const dailyPctRaw = normalized["daily change %"] || normalized["daily %"] || "0";
  const dailyPctString = dailyPctRaw.toString().trim();
  const hasPercent = dailyPctString.includes("%");
  const dailyPctValue = Number(dailyPctString.replace("%", ""));
  const dailyPct =
    Number.isFinite(dailyPctValue) && dailyPctValue !== 0
      ? hasPercent || Math.abs(dailyPctValue) > 1
        ? dailyPctValue / 100
        : dailyPctValue
      : 0;
  const value = shares * price;
  const monthPctRaw = normalized["monthly change %"] || normalized["month change %"];
  const yearPctRaw = normalized["yearly change %"] || normalized["year change %"];

  const monthPct = monthPctRaw
    ? Number(monthPctRaw.toString().replace("%", "")) / 100
    : null;
  const yearPct = yearPctRaw ? Number(yearPctRaw.toString().replace("%", "")) / 100 : null;
  const isCash = parseBooleanFlag(normalized["is cash"]) || tickerUpper === "CASH";
  const isCrypto = !isCash && parseBooleanFlag(normalized["is crypto"]);
  const sectorRaw =
    normalized["sector"] ||
    normalized["gics sector"] ||
    normalized["industry"] ||
    normalized["category"] ||
    "";
  const sector = (sectorRaw || "").toString().trim() || "Unknown";

  return {
    ticker,
    shares,
    price,
    regularPrice: price,
    afterHoursPrice,
    extendedPct: null,
    dailyPct,
    value,
    monthPct,
    yearPct,
    isCrypto,
    isCash,
    sector,
  };
}

function parseHistoryCSV(text) {
  const rows = parseCSV(text);
  return rows
    .map((row) => {
      const date = row.date || row.Date || row.DATE || "";
      const valueRaw = row["total value"] || row["value"] || row["total"] || "";
      const value = Number(valueRaw);
      return { date, value };
    })
    .filter((row) => row.date && Number.isFinite(row.value));
}

function formatHistoryLabel(label) {
  const parsed = new Date(label);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  }
  return label;
}

function formatSignedPercent(value) {
  const num = Number(value);
  const safe = Number.isFinite(num) ? num : 0;
  if (safe > 0) {
    return `+${fmtPercent.format(safe)}`;
  }
  return fmtPercent.format(safe);
}

function formatSignedCurrency(value) {
  const num = Number(value);
  const safe = Number.isFinite(num) ? num : 0;
  if (safe > 0) {
    return `+${fmtCurrency.format(safe)}`;
  }
  return fmtCurrency.format(safe);
}

function getReturnFromBase(currentValue, baseValue) {
  if (!Number.isFinite(currentValue) || !Number.isFinite(baseValue) || baseValue <= 0) {
    return null;
  }
  return currentValue / baseValue - 1;
}

function buildSnapshotPositions(rows) {
  const positions = {};
  rows.forEach((row) => {
    const ticker = (row.ticker || "").toString().trim().toUpperCase();
    if (!ticker) {
      return;
    }
    const shares = Number(row.shares);
    const price = Number(row.price);
    const value = Number.isFinite(row.value) ? Number(row.value) : shares * price;
    positions[ticker] = {
      shares: Number.isFinite(shares) ? shares : 0,
      price: Number.isFinite(price) ? price : 0,
      value: Number.isFinite(value) ? value : 0,
      isCash: Boolean(row.isCash),
      isCrypto: Boolean(row.isCrypto),
      sector: (row.sector || "Unknown").toString().trim() || "Unknown",
    };
  });
  return positions;
}

function loadStoredPortfolioHistory() {
  try {
    const raw = localStorage.getItem(PORTFOLIO_HISTORY_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item) => {
        const positions = {};
        const sourcePositions =
          item?.positions && typeof item.positions === "object" ? item.positions : {};
        Object.entries(sourcePositions).forEach(([ticker, position]) => {
          const symbol = (ticker || "").toString().trim().toUpperCase();
          if (!symbol) {
            return;
          }
          positions[symbol] = {
            shares: Number(position?.shares),
            price: Number(position?.price),
            value: Number(position?.value),
            isCash: Boolean(position?.isCash),
            isCrypto: Boolean(position?.isCrypto),
            sector: (position?.sector || "Unknown").toString().trim() || "Unknown",
          };
        });
        return {
          date: typeof item?.date === "string" ? item.date : "",
          totalValue: Number(item?.totalValue),
          positions,
        };
      })
      .filter(
        (item) => parseIsoDate(item.date) && Number.isFinite(item.totalValue) && item.totalValue > 0
      )
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-PORTFOLIO_HISTORY_LIMIT);
  } catch (err) {
    return [];
  }
}

function saveStoredPortfolioHistory(history) {
  try {
    localStorage.setItem(
      PORTFOLIO_HISTORY_STORAGE_KEY,
      JSON.stringify(history.slice(-PORTFOLIO_HISTORY_LIMIT))
    );
  } catch (err) {
    // Ignore storage failures.
  }
}

function upsertTodayPortfolioSnapshot(rows, totalValue) {
  const today = toIsoLocal(new Date());
  const history = loadStoredPortfolioHistory();
  const entry = {
    date: today,
    totalValue: Number.isFinite(totalValue) && totalValue > 0 ? totalValue : 0,
    positions: buildSnapshotPositions(rows),
  };
  const idx = history.findIndex((item) => item.date === today);
  if (idx >= 0) {
    history[idx] = entry;
  } else {
    history.push(entry);
    history.sort((a, b) => a.date.localeCompare(b.date));
  }
  if (history.length > PORTFOLIO_HISTORY_LIMIT) {
    history.splice(0, history.length - PORTFOLIO_HISTORY_LIMIT);
  }
  saveStoredPortfolioHistory(history);
  return history;
}

function computeFlowBetweenSnapshots(previousSnapshot, currentSnapshot) {
  const prevPositions = previousSnapshot?.positions || {};
  const currPositions = currentSnapshot?.positions || {};
  const symbols = new Set([...Object.keys(prevPositions), ...Object.keys(currPositions)]);
  let flow = 0;

  symbols.forEach((symbol) => {
    const prevPos = prevPositions[symbol] || {};
    const currPos = currPositions[symbol] || {};
    const prevShares = Number.isFinite(prevPos.shares) ? prevPos.shares : 0;
    const currShares = Number.isFinite(currPos.shares) ? currPos.shares : 0;
    const shareDelta = currShares - prevShares;
    if (Math.abs(shareDelta) < 1e-9) {
      return;
    }
    const markPrice = Number.isFinite(currPos.price) && currPos.price > 0
      ? currPos.price
      : Number.isFinite(prevPos.price) && prevPos.price > 0
        ? prevPos.price
        : 0;
    if (markPrice > 0) {
      flow += shareDelta * markPrice;
    }
  });

  return flow;
}

function buildPortfolioPerformanceSeries(history) {
  if (!history.length) {
    return [];
  }
  const series = [];
  let cumulativeIndex = 100;
  let previous = history[0];
  const firstDate = parseIsoDate(previous.date);
  series.push({
    date: previous.date,
    ms: firstDate ? firstDate.getTime() : 0,
    totalValue: previous.totalValue,
    dailyReturn: null,
    externalFlow: 0,
    index: cumulativeIndex,
  });

  for (let idx = 1; idx < history.length; idx += 1) {
    const current = history[idx];
    const currentDate = parseIsoDate(current.date);
    if (!currentDate) {
      continue;
    }
    const prevValue = Number(previous.totalValue);
    const currValue = Number(current.totalValue);
    const externalFlow = computeFlowBetweenSnapshots(previous, current);
    let dailyReturn = null;
    if (Number.isFinite(prevValue) && prevValue > 0 && Number.isFinite(currValue)) {
      dailyReturn = (currValue - prevValue - externalFlow) / prevValue;
      if (!Number.isFinite(dailyReturn) || dailyReturn <= -1) {
        dailyReturn = null;
      }
    }
    if (Number.isFinite(dailyReturn)) {
      cumulativeIndex *= 1 + dailyReturn;
    }
    series.push({
      date: current.date,
      ms: currentDate.getTime(),
      totalValue: currValue,
      dailyReturn,
      externalFlow,
      index: cumulativeIndex,
    });
    previous = current;
  }

  return series;
}

function getSeriesEntryOnOrBefore(series, targetDate) {
  const targetIso = toIsoLocal(targetDate);
  for (let idx = series.length - 1; idx >= 0; idx -= 1) {
    if (series[idx].date <= targetIso) {
      return series[idx];
    }
  }
  return null;
}

function computePortfolioReturnsFromSeries(series, fallbackDailyPct) {
  if (!series.length) {
    return {
      d1: Number.isFinite(fallbackDailyPct) ? fallbackDailyPct : null,
      w1: null,
      m1: null,
      ytd: null,
    };
  }

  const latest = series[series.length - 1];
  const now = new Date();
  const oneWeek = new Date(now);
  oneWeek.setDate(oneWeek.getDate() - 7);
  const oneMonth = new Date(now);
  oneMonth.setDate(oneMonth.getDate() - 30);
  const ytdStart = new Date(now.getFullYear(), 0, 1);

  const weekBase = getSeriesEntryOnOrBefore(series, oneWeek);
  const monthBase = getSeriesEntryOnOrBefore(series, oneMonth);
  const ytdBase = series.find((point) => point.date >= toIsoLocal(ytdStart)) || null;
  const d1Value = Number.isFinite(latest.dailyReturn) ? latest.dailyReturn : fallbackDailyPct;

  return {
    d1: Number.isFinite(d1Value) ? d1Value : null,
    w1: weekBase ? getReturnFromBase(latest.index, weekBase.index) : null,
    m1: monthBase ? getReturnFromBase(latest.index, monthBase.index) : null,
    ytd: ytdBase ? getReturnFromBase(latest.index, ytdBase.index) : null,
  };
}

function getPortfolioExposure(rows) {
  const valued = rows.filter((row) => Number.isFinite(row.value) && row.value > 0);
  const totalValue = valued.reduce((sum, row) => sum + row.value, 0);
  const cryptoValue = valued
    .filter((row) => row.isCrypto)
    .reduce((sum, row) => sum + row.value, 0);
  const cashValue = valued
    .filter((row) => row.isCash)
    .reduce((sum, row) => sum + row.value, 0);
  const equityValue = Math.max(0, totalValue - cryptoValue - cashValue);
  const sectors = new Map();
  valued
    .filter((row) => !row.isCash)
    .forEach((row) => {
      const sectorName = (row.isCrypto ? "Digital Assets" : row.sector || "Unknown")
        .toString()
        .trim() || "Unknown";
      sectors.set(sectorName, (sectors.get(sectorName) || 0) + row.value);
    });
  const sectorBreakdown = Array.from(sectors.entries())
    .map(([name, value]) => ({
      name,
      value,
      pct: totalValue > 0 ? value / totalValue : 0,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  return {
    totalValue,
    cryptoValue,
    cashValue,
    equityValue,
    cryptoPct: totalValue > 0 ? cryptoValue / totalValue : 0,
    cashPct: totalValue > 0 ? cashValue / totalValue : 0,
    equityPct: totalValue > 0 ? equityValue / totalValue : 0,
    sectorBreakdown,
  };
}

function getRegularPrice(row) {
  if (Number.isFinite(row.regularPrice) && row.regularPrice > 0) {
    return row.regularPrice;
  }
  if (Number.isFinite(row.price) && row.price > 0) {
    return row.price;
  }
  return 0;
}

function getDisplayRows(rows) {
  return rows.map((row) => {
    const regularPrice = getRegularPrice(row);
    const hasExtended =
      Number.isFinite(row.afterHoursPrice) && Number(row.afterHoursPrice) > 0;
    const useExtended = priceMode === "extended" && hasExtended;
    const displayPrice = useExtended ? Number(row.afterHoursPrice) : regularPrice;
    let displayDailyPct = Number.isFinite(row.dailyPct) ? row.dailyPct : 0;
    if (useExtended) {
      if (Number.isFinite(row.extendedPct)) {
        displayDailyPct = row.extendedPct;
      } else if (regularPrice > 0) {
        displayDailyPct = displayPrice / regularPrice - 1;
      }
    }
    return {
      ...row,
      price: displayPrice,
      value: row.shares * displayPrice,
      dailyPct: displayDailyPct,
      regularPrice,
    };
  });
}

function getRegularRows(rows) {
  return rows.map((row) => {
    const regularPrice = getRegularPrice(row);
    return {
      ...row,
      price: regularPrice,
      value: row.shares * regularPrice,
      regularPrice,
    };
  });
}

function buildMarketRecordSignature(rows) {
  const normalized = rows
    .map((row) => ({
      ticker: (row.ticker || "").toString().trim().toUpperCase(),
      shares: Number(row.shares) || 0,
      price: getRegularPrice(row),
      dailyPct: Number.isFinite(row.dailyPct) ? row.dailyPct : 0,
    }))
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
  return normalized
    .map(
      (row) =>
        `${row.ticker}:${row.shares.toFixed(6)}:${row.price.toFixed(6)}:${row.dailyPct.toFixed(6)}`
    )
    .join("|");
}

function persistDailyRecords(rows) {
  const regularRows = getRegularRows(rows);
  const totalValue = regularRows.reduce((sum, row) => sum + row.value, 0);
  const dailyChangeValue = regularRows.reduce((sum, row) => sum + row.value * row.dailyPct, 0);
  const dailyChangePct = totalValue > 0 ? dailyChangeValue / totalValue : 0;
  const signature = `${toIsoLocal(new Date())}|${buildMarketRecordSignature(
    regularRows
  )}|${totalValue.toFixed(4)}|${dailyChangeValue.toFixed(4)}`;
  if (signature === lastRecordedSignature) {
    return false;
  }
  upsertTodayPortfolioSnapshot(regularRows, totalValue);
  upsertTodayDailyPL(dailyChangeValue, dailyChangePct);
  lastRecordedSignature = signature;
  return true;
}

function setDailyHistoryExpanded(expanded) {
  dailyHistoryExpanded = Boolean(expanded);
  const toggleBtn = document.getElementById("dailyHistoryToggle");
  const wrap = document.getElementById("dailyHistoryWrap");
  if (!toggleBtn || !wrap) {
    return;
  }
  wrap.hidden = !dailyHistoryExpanded;
  toggleBtn.setAttribute("aria-expanded", dailyHistoryExpanded ? "true" : "false");
  toggleBtn.textContent = dailyHistoryExpanded ? "Hide Daily History" : "View Daily History";
}

function toIsoLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  if (!match) {
    return null;
  }
  const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  parsed.setHours(0, 0, 0, 0);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatRelativeAge(updatedAt) {
  if (!updatedAt || Number.isNaN(updatedAt.getTime())) {
    return "never";
  }
  const minutes = Math.max(0, Math.round((Date.now() - updatedAt.getTime()) / 60000));
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getFreshnessClass(updatedAt, freshMinutes, delayedMinutes) {
  if (!updatedAt || Number.isNaN(updatedAt.getTime())) {
    return "stale";
  }
  const ageMinutes = Math.max(0, (Date.now() - updatedAt.getTime()) / 60000);
  if (ageMinutes <= freshMinutes) {
    return "fresh";
  }
  if (ageMinutes <= delayedMinutes) {
    return "delayed";
  }
  return "stale";
}

function setStatusPill(id, label, updatedAt, freshMinutes, delayedMinutes) {
  const pill = document.getElementById(id);
  if (!pill) {
    return;
  }
  pill.classList.remove("fresh", "delayed", "stale");
  const cls = getFreshnessClass(updatedAt, freshMinutes, delayedMinutes);
  pill.classList.add(cls);
  const state = cls === "fresh" ? "Fresh" : cls === "delayed" ? "Delayed" : "Stale";
  pill.textContent = `${label}: ${state} (${formatRelativeAge(updatedAt)})`;
}

function renderDataFreshness() {
  const priceLabel = priceMode === "extended" ? "Prices (extended)" : "Prices (regular)";
  setStatusPill("statusPrices", priceLabel, pricesLastUpdatedAt, 10, 60);
  setStatusPill("statusBenchmarks", "Benchmarks", benchmarkLastUpdatedAt, 120, 720);
  setStatusPill("statusNews", "News", newsLastUpdatedAt, 45, 240);
}

function loadStoredDailyPLHistory() {
  try {
    const raw = localStorage.getItem(DAILY_PL_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item) => ({
        date: typeof item?.date === "string" ? item.date : "",
        pl: Number(item?.pl),
        pct: Number(item?.pct),
      }))
      .filter((item) => parseIsoDate(item.date) && Number.isFinite(item.pl))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-DAILY_PL_HISTORY_LIMIT);
  } catch (err) {
    return [];
  }
}

function saveStoredDailyPLHistory(history) {
  try {
    localStorage.setItem(DAILY_PL_STORAGE_KEY, JSON.stringify(history.slice(-DAILY_PL_HISTORY_LIMIT)));
  } catch (err) {
    // Ignore storage failures (private mode, disabled storage, quota).
  }
}

function upsertTodayDailyPL(pl, pct) {
  const today = toIsoLocal(new Date());
  const history = loadStoredDailyPLHistory();
  const nextEntry = {
    date: today,
    pl: Number.isFinite(pl) ? pl : 0,
    pct: Number.isFinite(pct) ? pct : 0,
  };
  const idx = history.findIndex((item) => item.date === today);
  if (idx >= 0) {
    history[idx] = nextEntry;
  } else {
    history.push(nextEntry);
    history.sort((a, b) => a.date.localeCompare(b.date));
  }
  if (history.length > DAILY_PL_HISTORY_LIMIT) {
    history.splice(0, history.length - DAILY_PL_HISTORY_LIMIT);
  }
  saveStoredDailyPLHistory(history);
  return history;
}

function getCalendarCellColor(plValue, maxAbs) {
  if (!Number.isFinite(plValue)) {
    return "#121a2a";
  }
  const ratio = maxAbs ? Math.min(1, Math.abs(plValue) / maxAbs) : 0;
  const from = plValue >= 0 ? [36, 81, 58] : [88, 44, 53];
  const to = plValue >= 0 ? [97, 220, 150] : [236, 111, 124];
  const r = Math.round(from[0] + (to[0] - from[0]) * ratio);
  const g = Math.round(from[1] + (to[1] - from[1]) * ratio);
  const b = Math.round(from[2] + (to[2] - from[2]) * ratio);
  return `rgb(${r}, ${g}, ${b})`;
}

function formatDailyCellAmount(value) {
  const abs = Math.abs(value);
  let scaled = abs;
  let suffix = "";
  if (abs >= 1_000_000) {
    scaled = abs / 1_000_000;
    suffix = "M";
  } else if (abs >= 1_000) {
    scaled = abs / 1_000;
    suffix = "K";
  }
  const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  const compact = scaled
    .toFixed(decimals)
    .replace(/\.0+$/, "")
    .replace(/(\.\d*[1-9])0+$/, "$1");
  return `${value >= 0 ? "+" : "-"}$${compact}${suffix}`;
}

function stripHtml(value) {
  return (value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function summarizeText(value, maxLength = 180) {
  const text = stripHtml(value);
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}...`;
}

function classifyNewsFocus(item) {
  const haystack = `${item.title} ${item.summary}`.toLowerCase();
  if (/(fed|inflation|interest rate|rates|treasury|yield|jobs|payroll|cpi|pce)/.test(haystack)) {
    return "macro";
  }
  if (/(earnings|guidance|quarter|q1|q2|q3|q4|revenue|eps)/.test(haystack)) {
    return "earnings";
  }
  if (/(ai|chip|semiconductor|software|cloud|apple|microsoft|nvidia|google|amazon|meta|tesla)/.test(haystack)) {
    return "tech";
  }
  return "all";
}

function buildRssProxyUrl(feedUrl) {
  return `https://api.allorigins.win/raw?url=${encodeURIComponent(feedUrl)}`;
}

async function fetchJsonWithProxyFallback(url) {
  try {
    const direct = await fetch(url);
    if (direct.ok) {
      return await direct.json();
    }
  } catch (err) {
    // Fall back to proxy below.
  }
  try {
    const proxied = await fetch(buildRssProxyUrl(url));
    if (!proxied.ok) {
      return null;
    }
    const text = await proxied.text();
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

function chunkSymbols(symbols, chunkSize = 40) {
  const chunks = [];
  for (let i = 0; i < symbols.length; i += chunkSize) {
    chunks.push(symbols.slice(i, i + chunkSize));
  }
  return chunks;
}

async function fetchExtendedHoursQuotes(rows) {
  const symbols = rows
    .map((row) => (row.ticker || "").toString().trim().toUpperCase())
    .filter((symbol) => symbol && symbol !== "CASH");
  if (!symbols.length) {
    return false;
  }

  let updatedAny = false;
  const chunks = chunkSymbols(symbols, 40);
  for (const chunk of chunks) {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(
      chunk.join(",")
    )}`;
    const data = await fetchJsonWithProxyFallback(url);
    const results = data?.quoteResponse?.result;
    if (!Array.isArray(results)) {
      continue;
    }
    results.forEach((quote) => {
      const symbol = (quote?.symbol || "").toString().trim().toUpperCase();
      if (!symbol) {
        return;
      }
      const row = rows.find((item) => (item.ticker || "").toString().trim().toUpperCase() === symbol);
      if (!row) {
        return;
      }

      const regularPrice = Number(quote.regularMarketPrice);
      if (Number.isFinite(regularPrice) && regularPrice > 0) {
        row.regularPrice = regularPrice;
        row.price = regularPrice;
        updatedAny = true;
      }

      const postPrice = Number(quote.postMarketPrice);
      const prePrice = Number(quote.preMarketPrice);
      const extendedPrice =
        Number.isFinite(postPrice) && postPrice > 0
          ? postPrice
          : Number.isFinite(prePrice) && prePrice > 0
            ? prePrice
            : null;
      if (Number.isFinite(extendedPrice) && extendedPrice > 0) {
        row.afterHoursPrice = extendedPrice;
        updatedAny = true;
      }

      const regularPct = Number(quote.regularMarketChangePercent);
      if (Number.isFinite(regularPct)) {
        row.dailyPct = regularPct / 100;
      }

      const postPct = Number(quote.postMarketChangePercent);
      const prePct = Number(quote.preMarketChangePercent);
      const extendedPct =
        Number.isFinite(postPct) ? postPct : Number.isFinite(prePct) ? prePct : null;
      row.extendedPct = Number.isFinite(extendedPct) ? extendedPct / 100 : null;
    });
  }

  if (updatedAny) {
    pricesLastUpdatedAt = new Date();
    scheduleLiveRender();
  }
  return updatedAny;
}

async function fetchBenchmarkSeries(symbol) {
  const stooqSymbol = symbol.toLowerCase();
  const feedUrl = `https://stooq.com/q/d/l/?s=${stooqSymbol}.us&i=d`;
  try {
    const response = await fetch(buildRssProxyUrl(feedUrl));
    if (!response.ok) {
      return [];
    }
    const csv = await response.text();
    const lines = csv.trim().split(/\r?\n/).slice(1);
    return lines
      .map((line) => {
        const cols = line.split(",");
        const date = (cols[0] || "").trim();
        const close = Number(cols[4]);
        const parsedDate = parseIsoDate(date);
        if (!parsedDate || !Number.isFinite(close) || close <= 0) {
          return null;
        }
        return { date, ms: parsedDate.getTime(), close };
      })
      .filter(Boolean)
      .sort((a, b) => a.ms - b.ms);
  } catch (err) {
    return [];
  }
}

function getSeriesPointOnOrBefore(series, targetMs) {
  for (let idx = series.length - 1; idx >= 0; idx -= 1) {
    if (series[idx].ms <= targetMs) {
      return series[idx];
    }
  }
  return null;
}

function computeBenchmarkReturns(series) {
  if (!series.length) {
    return { d1: null, w1: null, m1: null, ytd: null };
  }
  const last = series[series.length - 1];
  const prev = series.length >= 2 ? series[series.length - 2] : null;
  const weekTarget = last.ms - 7 * 24 * 60 * 60 * 1000;
  const monthTarget = last.ms - 30 * 24 * 60 * 60 * 1000;
  const ytdStart = new Date(new Date(last.ms).getFullYear(), 0, 1).getTime();
  const weekBase = getSeriesPointOnOrBefore(series, weekTarget);
  const monthBase = getSeriesPointOnOrBefore(series, monthTarget);
  const ytdBase = series.find((item) => item.ms >= ytdStart) || null;

  return {
    d1: prev ? getReturnFromBase(last.close, prev.close) : null,
    w1: weekBase ? getReturnFromBase(last.close, weekBase.close) : null,
    m1: monthBase ? getReturnFromBase(last.close, monthBase.close) : null,
    ytd: ytdBase ? getReturnFromBase(last.close, ytdBase.close) : null,
  };
}

function setReturnCellValue(cellId, value) {
  const cell = document.getElementById(cellId);
  if (!cell) {
    return;
  }
  cell.classList.remove("pos", "neg");
  if (!Number.isFinite(value)) {
    cell.textContent = "—";
    return;
  }
  cell.textContent = formatSignedPercent(value);
  if (value > 0) {
    cell.classList.add("pos");
  } else if (value < 0) {
    cell.classList.add("neg");
  }
}

function renderBenchmarkContext() {
  setReturnCellValue("benchmarkPortfolio1D", latestPortfolioReturns.d1);
  setReturnCellValue("benchmarkPortfolio1W", latestPortfolioReturns.w1);
  setReturnCellValue("benchmarkPortfolio1M", latestPortfolioReturns.m1);
  setReturnCellValue("benchmarkPortfolioYTD", latestPortfolioReturns.ytd);

  const spy = latestBenchmarkReturns.SPY || {};
  const qqq = latestBenchmarkReturns.QQQ || {};
  setReturnCellValue("benchmarkSPY1D", spy.d1);
  setReturnCellValue("benchmarkSPY1W", spy.w1);
  setReturnCellValue("benchmarkSPY1M", spy.m1);
  setReturnCellValue("benchmarkSPYYTD", spy.ytd);
  setReturnCellValue("benchmarkQQQ1D", qqq.d1);
  setReturnCellValue("benchmarkQQQ1W", qqq.w1);
  setReturnCellValue("benchmarkQQQ1M", qqq.m1);
  setReturnCellValue("benchmarkQQQYTD", qqq.ytd);

  const meta = document.getElementById("benchmarkMeta");
  if (!meta) {
    return;
  }
  if (!benchmarkLastUpdatedAt) {
    meta.textContent = "Loading SPY and QQQ context...";
    renderBenchmarkCurve();
    renderDataFreshness();
    return;
  }
  const updated = benchmarkLastUpdatedAt.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  meta.textContent = `SPY/QQQ via Stooq (EOD close). Updated ${updated}.`;
  renderBenchmarkCurve();
  renderDataFreshness();
}

async function refreshBenchmarkContext() {
  const meta = document.getElementById("benchmarkMeta");
  if (meta) {
    meta.textContent = "Loading SPY and QQQ context...";
  }
  const results = await Promise.all(
    BENCHMARK_SYMBOLS.map(async (symbol) => {
      const series = await fetchBenchmarkSeries(symbol);
      return [symbol, computeBenchmarkReturns(series), series.length > 0, series];
    })
  );
  latestBenchmarkReturns = Object.fromEntries(results.map(([symbol, returns]) => [symbol, returns]));
  latestBenchmarkSeries = Object.fromEntries(results.map(([symbol, , , series]) => [symbol, series]));
  const hasAnyData = results.some(([, , hasData]) => hasData);
  benchmarkLastUpdatedAt = hasAnyData ? new Date() : null;
  renderBenchmarkContext();
  if (!hasAnyData && meta) {
    meta.textContent = "Benchmark feed unavailable. Click Refresh to retry.";
  }
  renderDataFreshness();
}

function buildBenchmarkCurveData() {
  const snapshots = loadStoredPortfolioHistory();
  const portfolioSeries = buildPortfolioPerformanceSeries(snapshots);
  const spySeries = latestBenchmarkSeries.SPY || [];
  const qqqSeries = latestBenchmarkSeries.QQQ || [];
  if (!portfolioSeries.length || !spySeries.length || !qqqSeries.length) {
    return null;
  }

  const now = Date.now();
  const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000;
  const startMs = Math.max(portfolioSeries[0].ms, spySeries[0].ms, qqqSeries[0].ms, ninetyDaysAgo);

  const dateSet = new Set();
  portfolioSeries.forEach((point) => {
    if (point.ms >= startMs) {
      dateSet.add(point.ms);
    }
  });
  spySeries.forEach((point) => {
    if (point.ms >= startMs) {
      dateSet.add(point.ms);
    }
  });
  qqqSeries.forEach((point) => {
    if (point.ms >= startMs) {
      dateSet.add(point.ms);
    }
  });
  const dates = Array.from(dateSet).sort((a, b) => a - b);
  const points = dates
    .map((ms) => {
      const pVal = getSeriesPointOnOrBefore(portfolioSeries, ms)?.index ?? null;
      const spyVal = getSeriesPointOnOrBefore(spySeries, ms)?.close ?? null;
      const qqqVal = getSeriesPointOnOrBefore(qqqSeries, ms)?.close ?? null;
      if (!Number.isFinite(pVal) || !Number.isFinite(spyVal) || !Number.isFinite(qqqVal)) {
        return null;
      }
      return { ms, pVal, spyVal, qqqVal };
    })
    .filter(Boolean);
  if (points.length < 8) {
    return null;
  }

  const sliced = points.slice(-90);
  const base = sliced[0];
  return {
    labels: sliced.map((point) =>
      new Date(point.ms).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    ),
    portfolio: sliced.map((point) => (point.pVal / base.pVal) * 100),
    spy: sliced.map((point) => (point.spyVal / base.spyVal) * 100),
    qqq: sliced.map((point) => (point.qqqVal / base.qqqVal) * 100),
  };
}

function renderBenchmarkCurve() {
  const canvas = document.getElementById("benchmarkCurve");
  const empty = document.getElementById("benchmarkCurveEmpty");
  if (!canvas || !empty) {
    return;
  }

  const curve = buildBenchmarkCurveData();
  if (!curve) {
    if (benchmarkCurveChart) {
      benchmarkCurveChart.destroy();
      benchmarkCurveChart = null;
    }
    canvas.style.display = "none";
    empty.style.display = "block";
    return;
  }

  canvas.style.display = "block";
  empty.style.display = "none";
  if (benchmarkCurveChart) {
    benchmarkCurveChart.destroy();
  }
  benchmarkCurveChart = new Chart(canvas, {
    type: "line",
    data: {
      labels: curve.labels,
      datasets: [
        {
          label: "Portfolio",
          data: curve.portfolio,
          borderColor: "#8df0d2",
          backgroundColor: "rgba(141, 240, 210, 0.14)",
          borderWidth: 2.4,
          pointRadius: 0,
          tension: 0.28,
        },
        {
          label: "SPY",
          data: curve.spy,
          borderColor: "#7fb8ff",
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.25,
        },
        {
          label: "QQQ",
          data: curve.qqq,
          borderColor: "#ffc06e",
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.25,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { color: "#d9e5fc" },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(2)}`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: "#a7b6d5", maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
          grid: { color: "rgba(255,255,255,0.05)" },
        },
        y: {
          ticks: { color: "#a7b6d5", callback: (val) => `${Number(val).toFixed(0)}` },
          grid: { color: "rgba(255,255,255,0.05)" },
        },
      },
    },
  });
}

async function fetchNewsFromSource(sourceKey) {
  const source = NEWS_RSS_SOURCES[sourceKey];
  if (!source) {
    return [];
  }
  try {
    const response = await fetch(buildRssProxyUrl(source.rssUrl));
    if (!response.ok) {
      return [];
    }
    const xmlText = await response.text();
    const xml = new DOMParser().parseFromString(xmlText, "application/xml");
    const items = Array.from(xml.querySelectorAll("item")).slice(0, 20);
    return items.map((itemNode) => {
      const title = stripHtml(itemNode.querySelector("title")?.textContent || "");
      const description = itemNode.querySelector("description")?.textContent || "";
      const link = (itemNode.querySelector("link")?.textContent || "").trim();
      const pubDate = itemNode.querySelector("pubDate")?.textContent || "";
      const publishedAt = pubDate ? new Date(pubDate) : null;
      return {
        source: source.label,
        title,
        summary: summarizeText(description),
        link,
        publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null,
      };
    }).filter((item) => item.title);
  } catch (err) {
    return [];
  }
}

function filterNewsByFocus(items, focus) {
  if (focus === "all") {
    return items;
  }
  return items.filter((item) => classifyNewsFocus(item) === focus);
}

function dedupeNewsItems(items) {
  const seen = new Set();
  const deduped = [];
  items.forEach((item) => {
    const key = `${item.title.toLowerCase()}|${item.source}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    deduped.push(item);
  });
  return deduped;
}

function normalizeNewsKey(title) {
  return (title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function getFreshnessScore(publishedAt) {
  if (!publishedAt || Number.isNaN(publishedAt.getTime())) {
    return 2;
  }
  const ageHours = Math.max(0, (Date.now() - publishedAt.getTime()) / 3_600_000);
  if (ageHours <= 1) return 35;
  if (ageHours <= 3) return 30;
  if (ageHours <= 8) return 24;
  if (ageHours <= 24) return 16;
  if (ageHours <= 48) return 9;
  if (ageHours <= 96) return 4;
  return 1;
}

function getPopularitySignalScore(item, duplicateCount) {
  const title = (item.title || "").toLowerCase();
  const summary = (item.summary || "").toLowerCase();
  const text = `${title} ${summary}`;
  let score = 0;

  if (/(breaking|just in|developing|live|exclusive|alert)/.test(text)) {
    score += 16;
  }
  if (/(fed|federal reserve|rate cut|rate hike|cpi|inflation|payroll|jobs report|treasury|yield|earnings|guidance|dow|s&p|nasdaq)/.test(text)) {
    score += 12;
  }
  if (/(%|plunge|surge|rally|selloff|record high|record low)/.test(text)) {
    score += 6;
  }
  if (duplicateCount > 1) {
    score += Math.min(3, duplicateCount - 1) * 10;
  }
  return score;
}

function rankNewsItems(items) {
  const deduped = dedupeNewsItems(items);
  const keyCounts = new Map();
  deduped.forEach((item) => {
    const key = normalizeNewsKey(item.title);
    keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
  });

  return deduped
    .map((item) => {
      const key = normalizeNewsKey(item.title);
      const duplicateCount = keyCounts.get(key) || 1;
      const score = getFreshnessScore(item.publishedAt) + getPopularitySignalScore(item, duplicateCount);
      return { ...item, score };
    })
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return (b.publishedAt?.getTime?.() || 0) - (a.publishedAt?.getTime?.() || 0);
    });
}

function getSafeHttpUrl(value) {
  try {
    const url = new URL(value || "");
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.toString();
    }
  } catch (err) {
    return "";
  }
  return "";
}

async function loadNewsDigest() {
  const sourceSelect = document.getElementById("newsSource");
  const focusSelect = document.getElementById("newsFocus");
  const meta = document.getElementById("newsMeta");
  const selectedSource = sourceSelect?.value || "all";
  const selectedFocus = focusSelect?.value || "all";

  newsIsLoading = true;
  meta.textContent = "Loading latest headlines...";

  const sourceKeys =
    selectedSource === "all" ? Object.keys(NEWS_RSS_SOURCES) : [selectedSource];
  const groups = await Promise.all(sourceKeys.map((key) => fetchNewsFromSource(key)));
  const fetchedAny = groups.some((group) => group.length > 0);
  const merged = groups.flat().filter((item) => item.title);
  const focused = filterNewsByFocus(merged, selectedFocus);
  const ranked = rankNewsItems(focused).slice(0, 5);

  currentNewsItems = ranked;
  if (fetchedAny) {
    newsLastUpdatedAt = new Date();
  }
  renderNewsDigest(ranked, {
    fetchedAny,
    selectedSource,
    selectedFocus,
  });
  renderExpertAdvice(getDisplayRows(currentRows), currentNewsItems);
  newsIsLoading = false;
  renderDataFreshness();
}

function renderNewsDigest(items, context = {}) {
  const list = document.getElementById("newsList");
  const meta = document.getElementById("newsMeta");
  list.innerHTML = "";

  if (!items.length) {
    const sourceLabel =
      context.selectedSource && context.selectedSource !== "all"
        ? NEWS_RSS_SOURCES[context.selectedSource]?.label || "Selected source"
        : "selected sources";
    if (context.fetchedAny) {
      meta.textContent = "Headlines loaded, but none matched this focus filter.";
    } else {
      meta.textContent = `Could not load live headlines from ${sourceLabel} right now.`;
    }
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = context.fetchedAny
      ? "Try switching focus to 'All Market' or choosing a broader source."
      : "No feed response right now. Click Refresh News, then try a different source.";
    list.appendChild(empty);
    return;
  }

  meta.textContent = `Showing top ${items.length} headlines ranked by popularity and freshness`;

  items.forEach((item) => {
    const card = document.createElement("article");
    card.className = "news-card";

    const metaLine = document.createElement("div");
    metaLine.className = "news-meta";
    const publishedLabel = item.publishedAt
      ? item.publishedAt.toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "Recent";
    metaLine.textContent = `${item.source} • ${publishedLabel}`;

    const titleEl = document.createElement("h4");
    titleEl.className = "news-title";
    const safeUrl = getSafeHttpUrl(item.link);
    if (safeUrl) {
      const anchor = document.createElement("a");
      anchor.href = safeUrl;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.textContent = item.title;
      titleEl.appendChild(anchor);
    } else {
      titleEl.textContent = item.title;
    }

    const summaryEl = document.createElement("p");
    summaryEl.className = "news-summary";
    summaryEl.textContent = item.summary || "No summary available.";

    card.appendChild(metaLine);
    card.appendChild(titleEl);
    card.appendChild(summaryEl);
    list.appendChild(card);
  });
}

function buildAdvicePrompt(rows, newsItems, mode) {
  const top = getSortedRows(rows).slice(0, 8);
  const holdingsLine = top
    .map((row) => `${row.ticker}: shares=${row.shares}, price=${row.price}, value=${row.value.toFixed(2)}, dailyPct=${(row.dailyPct * 100).toFixed(2)}%`)
    .join("\n");
  const newsLine = newsItems
    .slice(0, 8)
    .map((item) => `- [${item.source}] ${item.title}`)
    .join("\n");
  return [
    "You are a professional equity portfolio advisor.",
    `Investor mode: ${mode}.`,
    "Analyze this portfolio and recent market headlines.",
    "Give concise, actionable advice with: 1) risks, 2) opportunities, 3) concrete next actions.",
    "",
    "Holdings:",
    holdingsLine || "No holdings loaded.",
    "",
    "Recent headlines:",
    newsLine || "No headlines loaded.",
  ].join("\n");
}

function tickerMentionsFromNews(newsItems, tickers) {
  const mentions = [];
  newsItems.forEach((item) => {
    const upper = item.title.toUpperCase();
    tickers.forEach((ticker) => {
      const clean = ticker.toUpperCase();
      const safe = clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (clean && new RegExp(`\\b${safe}\\b`).test(upper)) {
        mentions.push({ ticker: clean, title: item.title, source: item.source });
      }
    });
  });
  return mentions.slice(0, 3);
}

function generateBuiltInAdvice(rows, newsItems, mode) {
  const sorted = getSortedRows(rows);
  if (!sorted.length) {
    return ["Load your holdings to generate portfolio-specific advice."];
  }
  const total = sorted.reduce((sum, row) => sum + row.value, 0);
  const top = sorted.slice(0, 3);
  const topWeight = total ? top.reduce((sum, row) => sum + row.value, 0) / total : 0;
  const top1Weight = total && sorted[0] ? sorted[0].value / total : 0;
  const tickers = sorted.map((row) => row.ticker);
  const mentions = tickerMentionsFromNews(newsItems, tickers);
  const lines = [];

  if (top1Weight > 0.35) {
    lines.push(`Concentration risk is high: ${sorted[0].ticker} is ${fmtPercent.format(top1Weight)} of your portfolio. Consider trimming or hedging to reduce single-name shock risk.`);
  } else if (topWeight > 0.65) {
    lines.push(`Top-3 concentration is ${fmtPercent.format(topWeight)}. Add 1-2 lower-correlation positions or increase cash to improve downside resilience.`);
  } else {
    lines.push("Position sizing looks reasonably balanced. Keep reviewing weights weekly so winners do not silently over-concentrate.");
  }

  const worst = sorted.reduce((acc, row) => (row.dailyPct < acc.dailyPct ? row : acc), sorted[0] || null);
  const best = sorted.reduce((acc, row) => (row.dailyPct > acc.dailyPct ? row : acc), sorted[0] || null);
  if (best && worst) {
    lines.push(`Today's dispersion is wide: strongest is ${best.ticker} (${formatSignedPercent(best.dailyPct)}), weakest is ${worst.ticker} (${formatSignedPercent(worst.dailyPct)}). Re-check thesis before reacting to one-day moves.`);
  }

  if (mentions.length) {
    const mentionText = mentions.map((m) => `${m.ticker} (${m.source})`).join(", ");
    lines.push(`Recent headlines directly touching your holdings: ${mentionText}. Read those first before making allocation changes.`);
  } else {
    lines.push("Recent headlines are mostly macro-level; prioritize position sizing and risk controls over aggressive turnover.");
  }

  if (mode === "defensive") {
    lines.push("Defensive mode: keep some dry powder, reduce leverage, and focus on balance-sheet quality and stable earnings visibility.");
  } else if (mode === "growth") {
    lines.push("Growth mode: add only on quality pullbacks, and set max position limits to avoid concentration creep.");
  } else if (mode === "active") {
    lines.push("Active mode: predefine invalidation levels and take-profit rules before entering trades to avoid emotional execution.");
  } else {
    lines.push("Balanced mode: maintain core positions, rebalance on outsized moves, and let news confirm or challenge your thesis.");
  }

  return lines.slice(0, 5);
}

function renderExpertAdvice(rows, newsItems) {
  const source = document.getElementById("adviceSource").value;
  const mode = document.getElementById("adviceMode").value;
  const meta = document.getElementById("adviceMeta");
  const list = document.getElementById("adviceList");
  const promptWrap = document.getElementById("advicePromptWrap");
  const promptArea = document.getElementById("advicePrompt");
  const externalLink = document.getElementById("adviceExternalLink");

  const lines = generateBuiltInAdvice(rows, newsItems, mode);
  list.innerHTML = "";
  lines.forEach((line) => {
    const li = document.createElement("li");
    li.textContent = line;
    list.appendChild(li);
  });

  if (source === "built_in") {
    promptWrap.style.display = "none";
    meta.textContent = newsIsLoading
      ? "Advice based on holdings. News is still loading..."
      : "Advice based on your holdings and loaded market news.";
    return;
  }

  const prompt = buildAdvicePrompt(rows, newsItems, mode);
  const external = ADVICE_EXTERNAL_LINKS[source] || "#";
  externalLink.href = external;
  externalLink.textContent = `Open ${source === "chatgpt" ? "ChatGPT" : source[0].toUpperCase() + source.slice(1)}`;
  promptArea.value = prompt;
  promptWrap.style.display = "block";
  meta.textContent = "Built-in advice plus exportable prompt for your selected AI tool.";
}

function getHeatColor(pct) {
  const clamped = Math.max(-0.1, Math.min(0.1, pct || 0));
  const t = Math.pow(Math.min(1, Math.abs(clamped) / 0.1), 0.85);
  const from = clamped >= 0 ? [36, 62, 52] : [66, 42, 46];
  const to = clamped >= 0 ? [63, 164, 117] : [186, 79, 92];
  const r = Math.round(from[0] + (to[0] - from[0]) * t);
  const g = Math.round(from[1] + (to[1] - from[1]) * t);
  const b = Math.round(from[2] + (to[2] - from[2]) * t);
  return {
    fill: `rgb(${r}, ${g}, ${b})`,
    border: `rgb(${Math.max(0, r - 12)}, ${Math.max(0, g - 12)}, ${Math.max(0, b - 12)})`,
  };
}

function getSizeClass(area) {
  if (area > 140000) return "size-xl";
  if (area > 90000) return "size-lg";
  if (area > 45000) return "size-md";
  if (area > 18000) return "size-sm";
  return "size-xs";
}

function getTreemapTitleFontSize(area) {
  if (area > 140000) return 22;
  if (area > 90000) return 18;
  if (area > 45000) return 15;
  if (area > 18000) return 12;
  return 11;
}

function getTreemapTextMode(item, rect) {
  const width = rect.width;
  const height = rect.height;
  const area = width * height;
  const ticker = (item.name || "").toString();
  const titleChars = Math.max(1, ticker.length);
  const pct = formatSignedPercent(item.dailyPct || 0);
  const pctChars = Math.max(1, pct.length);

  const compactPad = 6;
  const compactFont = 11;
  const compactInnerW = width - compactPad * 2;
  const compactInnerH = height - compactPad * 2;
  const compactNeedW = Math.ceil(titleChars * compactFont * 0.62);
  const compactNeedH = Math.ceil(compactFont * 1.25);
  const tickerFits = compactInnerW >= compactNeedW && compactInnerH >= compactNeedH;
  if (!tickerFits) {
    return "hide";
  }

  const fullPad = area > 140000 ? 18 : 12;
  const titleFont = getTreemapTitleFontSize(area);
  const metaFont = area > 90000 ? 12 : 11;
  const fullInnerW = width - fullPad * 2;
  const fullInnerH = height - fullPad * 2;
  const fullNeedW = Math.max(Math.ceil(titleChars * titleFont * 0.62), 72);
  const fullNeedH =
    Math.ceil(titleFont * 1.25) + 6 + Math.ceil(metaFont * 1.35) + 6 + Math.ceil(metaFont * 1.35);

  if (fullInnerW >= fullNeedW && fullInnerH >= fullNeedH) {
    return "full";
  }

  const pctPad = 8;
  const pctTitleFont = 11;
  const pctMetaFont = 10;
  const pctInnerW = width - pctPad * 2;
  const pctInnerH = height - pctPad * 2;
  const pctNeedW = Math.max(
    Math.ceil(titleChars * pctTitleFont * 0.62),
    Math.ceil(pctChars * pctMetaFont * 0.56)
  );
  const pctNeedH =
    Math.ceil(pctTitleFont * 1.25) + 4 + Math.ceil(pctMetaFont * 1.3);
  if (pctInnerW >= pctNeedW && pctInnerH >= pctNeedH) {
    return "tickerPct";
  }
  return "ticker";
}

function layoutTreemapVisibleItems(items, width, height) {
  const seed = items.map((item) => ({
    name: item.name,
    value: item.value,
    dailyPct: item.dailyPct,
  }));
  let current = seed;
  let rects = [];

  for (let pass = 0; pass < 4 && current.length; pass += 1) {
    rects = layoutTreemapRectangles(current, 0, 0, width, height).filter(
      (item) => item.rect.width > 0 && item.rect.height > 0
    );
    const visible = rects
      .map((item) => ({ item, mode: getTreemapTextMode(item, item.rect) }))
      .filter((entry) => entry.mode !== "hide")
      .map((entry) => entry.item);

    if (!visible.length) {
      return { rects: [], hiddenCount: items.length };
    }
    if (visible.length === rects.length) {
      return { rects: visible, hiddenCount: Math.max(0, items.length - visible.length) };
    }
    current = visible.map((item) => ({
      name: item.name,
      value: item.value,
      dailyPct: item.dailyPct,
    }));
  }

  return { rects, hiddenCount: Math.max(0, items.length - rects.length) };
}

function getSortedRows(rows) {
  const sorted = rows.slice();
  const direction = holdingsSortState.direction === "asc" ? 1 : -1;
  const key = holdingsSortState.key;
  sorted.sort((a, b) => {
    const aMetric =
      key === "dailyPct" ? a.dailyPct : key === "value" ? a.value : a.value * a.dailyPct;
    const bMetric =
      key === "dailyPct" ? b.dailyPct : key === "value" ? b.value : b.value * b.dailyPct;
    if (aMetric !== bMetric) {
      return (aMetric - bMetric) * direction;
    }
    if (b.value !== a.value) {
      return b.value - a.value;
    }
    return b.dailyPct - a.dailyPct;
  });
  return sorted;
}

function updateHoldingsSortIndicators() {
  const sortButtons = document.querySelectorAll("#holdingsHead .table-sort-btn");
  sortButtons.forEach((button) => {
    const key = button.dataset.sortKey;
    const arrow = button.querySelector(".sort-arrow");
    const isActive = key === holdingsSortState.key;
    button.classList.toggle("active", isActive);
    if (!arrow) {
      return;
    }
    if (!isActive) {
      arrow.textContent = "↕";
      return;
    }
    arrow.textContent = holdingsSortState.direction === "asc" ? "↑" : "↓";
  });
}

function getRobinhoodStockUrl(ticker) {
  const symbol = (ticker || "").toString().trim().toUpperCase();
  if (!symbol) {
    return "";
  }
  return `https://robinhood.com/us/en/stocks/${encodeURIComponent(symbol)}/`;
}

function renderTable(rows) {
  const tbody = document.getElementById("holdingsTable");
  tbody.innerHTML = "";
  const sortedRows = getSortedRows(rows);
  sortedRows.forEach((row) => {
    const tr = document.createElement("tr");
    const ticker = (row.ticker || "").toString().trim().toUpperCase();
    const tickerUrl = getRobinhoodStockUrl(ticker);
    const tickerCell = tickerUrl
      ? `<a class="ticker-link" href="${tickerUrl}" target="_blank" rel="noopener noreferrer">${ticker}</a>`
      : ticker;
    const priceDisplay = row.price ? fmtCurrency.format(row.price) : "—";
    const valueDisplay = row.value ? fmtCurrency.format(row.value) : "—";
    const dailyValueChange = row.value * row.dailyPct;
    const dailyValueChangeDisplay = formatSignedCurrency(dailyValueChange);
    tr.innerHTML = `
      <td>${tickerCell}</td>
      <td>${row.shares.toLocaleString()}</td>
      <td>${priceDisplay}</td>
      <td class="${row.dailyPct >= 0 ? "pos" : "neg"}">
        ${formatSignedPercent(row.dailyPct)}
      </td>
      <td class="${dailyValueChange > 0 ? "pos" : dailyValueChange < 0 ? "neg" : ""}">${dailyValueChangeDisplay}</td>
      <td>${valueDisplay}</td>
    `;
    tbody.appendChild(tr);
  });
  updateHoldingsSortIndicators();
}

function buildTreemapRows(rows) {
  return rows
    .filter((row) => row.ticker && row.value > 0)
    .map((row) => ({
      name: row.ticker.toUpperCase(),
      value: row.value,
      dailyPct: row.dailyPct,
    }))
    .sort((a, b) => b.value - a.value);
}

function setSnapshotMetric(id, value, type = "neutral") {
  const el = document.getElementById(id);
  if (!el) {
    return;
  }
  el.textContent = value;
  el.classList.remove("pos", "neg");
  if (type === "pos") {
    el.classList.add("pos");
  } else if (type === "neg") {
    el.classList.add("neg");
  }
}

function renderAllocationExposure(rows) {
  const cryptoLine = document.getElementById("allocationCryptoLine");
  const cashLine = document.getElementById("allocationCashLine");
  if (!cryptoLine || !cashLine) {
    return;
  }

  const exposure = getPortfolioExposure(rows);

  cryptoLine.textContent = `Digital asset exposure: ${fmtPercent.format(
    exposure.cryptoPct
  )} of total portfolio value.`;
  cashLine.textContent = `Cash allocation: ${fmtPercent.format(
    exposure.cashPct
  )} of total portfolio value.`;
}

function renderExposureList(containerId, rows) {
  const container = document.getElementById(containerId);
  if (!container) {
    return;
  }
  container.innerHTML = "";
  rows.forEach((row) => {
    const item = document.createElement("div");
    item.className = "exposure-row";
    item.innerHTML = `
      <div class="exposure-row-head">
        <span class="exposure-name">${row.name}</span>
        <span class="exposure-pct">${fmtPercent.format(row.pct)}</span>
      </div>
      <div class="exposure-track"><div class="exposure-fill" style="width:${Math.max(
        0,
        Math.min(100, row.pct * 100)
      ).toFixed(2)}%"></div></div>
    `;
    container.appendChild(item);
  });
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No exposure data yet.";
    container.appendChild(empty);
  }
}

function renderExposureBreakdown(rows) {
  const exposure = getPortfolioExposure(rows);
  const assetRows = [
    { name: "Equities", pct: exposure.equityPct, value: exposure.equityValue },
    { name: "Digital Assets", pct: exposure.cryptoPct, value: exposure.cryptoValue },
    { name: "Cash", pct: exposure.cashPct, value: exposure.cashValue },
  ]
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value);
  renderExposureList("assetExposureList", assetRows);
  renderExposureList("sectorExposureList", exposure.sectorBreakdown);
}

function layoutTreemapRectangles(items, x, y, width, height) {
  if (!items.length || width <= 0 || height <= 0) {
    return [];
  }
  const ix = Math.round(x);
  const iy = Math.round(y);
  const iw = Math.round(width);
  const ih = Math.round(height);
  if (iw <= 0 || ih <= 0) {
    return [];
  }
  if (items.length === 1) {
    return [{ ...items[0], rect: { x: ix, y: iy, width: iw, height: ih } }];
  }

  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (!total) {
    return [];
  }

  function layoutLinear(list, lx, ly, lw, lh, splitByWidth) {
    const out = [];
    const subtotal = list.reduce((sum, item) => sum + item.value, 0);
    if (!subtotal || lw <= 0 || lh <= 0) {
      return out;
    }
    let prev = 0;
    const span = splitByWidth ? lw : lh;
    list.forEach((item, idx) => {
      const next =
        idx === list.length - 1
          ? span
          : Math.round(((prev + item.value) / subtotal) * span);
      const size = Math.max(0, next - prev);
      const rect = splitByWidth
        ? { x: lx + prev, y: ly, width: size, height: lh }
        : { x: lx, y: ly + prev, width: lw, height: size };
      out.push({ ...item, rect });
      prev = next;
    });
    return out;
  }

  if (iw <= 1 || ih <= 1) {
    return layoutLinear(items, ix, iy, iw, ih, iw >= ih);
  }

  let running = 0;
  let splitIdx = 0;
  const target = total / 2;
  while (splitIdx < items.length - 1 && running < target) {
    running += items[splitIdx].value;
    splitIdx += 1;
  }
  splitIdx = Math.max(1, Math.min(items.length - 1, splitIdx));

  const first = items.slice(0, splitIdx);
  const second = items.slice(splitIdx);
  const firstTotal = first.reduce((sum, item) => sum + item.value, 0);
  const ratio = firstTotal / total;

  if (iw >= ih) {
    const raw = Math.round(iw * ratio);
    const w1 = Math.max(1, Math.min(iw - 1, raw));
    if (w1 <= 0 || iw - w1 <= 0) {
      return layoutLinear(items, ix, iy, iw, ih, true);
    }
    return [
      ...layoutTreemapRectangles(first, ix, iy, w1, ih),
      ...layoutTreemapRectangles(second, ix + w1, iy, iw - w1, ih),
    ];
  }

  const raw = Math.round(ih * ratio);
  const h1 = Math.max(1, Math.min(ih - 1, raw));
  if (h1 <= 0 || ih - h1 <= 0) {
    return layoutLinear(items, ix, iy, iw, ih, false);
  }
  return [
    ...layoutTreemapRectangles(first, ix, iy, iw, h1),
    ...layoutTreemapRectangles(second, ix, iy + h1, iw, ih - h1),
  ];
}

function renderTreemap(rows) {
  const treemap = document.getElementById("treemap");
  treemap.innerHTML = "";
  renderAllocationExposure(rows);
  const breadcrumb = document.getElementById("treemapBreadcrumb");
  const items = buildTreemapRows(rows);
  const totalValue = items.reduce((sum, item) => sum + (item.value || 0), 0);
  breadcrumb.textContent = `All Stocks (${items.length})`;

  if (!items.length) {
    return;
  }

  const width = Math.max(1, Math.round(treemap.clientWidth));
  const height = Math.max(1, Math.round(treemap.clientHeight));
  const { rects, hiddenCount } = layoutTreemapVisibleItems(items, width, height);
  if (!rects.length) {
    breadcrumb.textContent = "No tiles fit this viewport";
    return;
  }
  if (hiddenCount > 0) {
    breadcrumb.textContent = `Visible Stocks (${rects.length} of ${items.length})`;
  }

  rects
    .forEach((item) => {
      const textMode = getTreemapTextMode(item, item.rect);
      if (textMode === "hide") {
        return;
      }
      const block = document.createElement("div");
      const area = item.rect.width * item.rect.height;
      block.className = `treemap-block ${getSizeClass(area)} leaf`;
      if (textMode === "ticker") {
        block.classList.add("ticker-only");
      } else if (textMode === "tickerPct") {
        block.classList.add("ticker-pct");
      }
      block.style.left = `${item.rect.x}px`;
      block.style.top = `${item.rect.y}px`;
      block.style.width = `${item.rect.width}px`;
      block.style.height = `${item.rect.height}px`;

      const heat = getHeatColor(item.dailyPct || 0);
      block.style.backgroundColor = heat.fill;
      block.style.borderColor = heat.border;

      const pct = formatSignedPercent(item.dailyPct || 0);
      const weight = totalValue > 0 ? (item.value || 0) / totalValue : 0;
      if (textMode === "full") {
        block.innerHTML = `
          <div>
            <div class="title">${item.name}</div>
            <div class="meta pct">${pct}</div>
            <div class="meta weight">${fmtPercent.format(weight)} of total</div>
          </div>
        `;
      } else if (textMode === "tickerPct") {
        block.innerHTML = `
          <div>
            <div class="title">${item.name}</div>
            <div class="meta pct">${pct}</div>
          </div>
        `;
      } else {
        block.innerHTML = `
          <div>
            <div class="title">${item.name}</div>
          </div>
        `;
      }
      block.title = `${item.name}: ${pct}, ${fmtPercent.format(weight)} of total`;

      treemap.appendChild(block);
    });
}

function scheduleLiveRender() {
  if (liveUpdateScheduled) {
    return;
  }
  liveUpdateScheduled = true;
  requestAnimationFrame(() => {
    liveUpdateScheduled = false;
    currentRows = liveRows;
    const displayRows = getDisplayRows(liveRows);
    const regularRows = getRegularRows(liveRows);
    persistDailyRecords(regularRows);
    renderSummary(displayRows, regularRows);
    renderDailyGainLoss(displayRows);
    renderTable(displayRows);
    renderTreemap(displayRows);
    renderExposureBreakdown(displayRows);
    renderBenchmarkContext();
    renderExpertAdvice(displayRows, currentNewsItems);
    renderDataFreshness();
  });
}

async function fetchLivePricesFmp(rows) {
  if (!FMP_API_KEY) {
    return { ok: false, rateLimited: false };
  }
  const symbols = rows
    .map((row) => row.ticker)
    .filter((symbol) => {
      if (!symbol) {
        return false;
      }
      const upper = symbol.toUpperCase();
      if (upper === "CASH") {
        return false;
      }
      return true;
    });
  if (!symbols.length) {
    return { ok: false, rateLimited: false };
  }
  const url = `${FMP_QUOTE_BASE}?symbols=${encodeURIComponent(
    symbols.join(",")
  )}&apikey=${encodeURIComponent(FMP_API_KEY)}`;
  try {
    const response = await fetch(url);
    if (response.status === 429) {
      return { ok: false, rateLimited: true };
    }
    if (!response.ok) {
      return { ok: false, rateLimited: false };
    }
    const data = await response.json();
    if (!Array.isArray(data)) {
      return { ok: false, rateLimited: false };
    }
    let updated = false;
    data.forEach((item) => {
      if (item && item.symbol && item.price) {
        const pct = item.changesPercentage ? Number(item.changesPercentage) / 100 : 0;
        const row = rows.find((r) => r.ticker === item.symbol);
        if (row) {
          row.dailyPct = Number.isFinite(pct) ? pct : row.dailyPct;
          updated = true;
          row.regularPrice = Number(item.price);
          row.price = Number(item.price);
          row.value = row.shares * row.price;
        }
      }
    });
    if (updated) {
      pricesLastUpdatedAt = new Date();
      scheduleLiveRender();
    }
    return { ok: true, rateLimited: false };
  } catch (err) {
    return { ok: false, rateLimited: false };
  }
}

async function refreshLivePrices(rows) {
  const gotExtended = await fetchExtendedHoursQuotes(rows);
  if (gotExtended) {
    return { ok: true, rateLimited: false };
  }
  return fetchLivePricesFmp(rows);
}

function startLivePrices(rows) {
  liveRows = rows;
  livePriceRunId += 1;
  const runId = livePriceRunId;
  let backoff = LIVE_PRICE_REFRESH_MS;

  const tick = async () => {
    if (runId !== livePriceRunId) {
      return;
    }
    const result = await refreshLivePrices(rows);
    if (runId !== livePriceRunId) {
      return;
    }
    if (result.rateLimited) {
      backoff = Math.min(backoff * 2, LIVE_PRICE_MAX_BACKOFF_MS);
    } else {
      backoff = LIVE_PRICE_REFRESH_MS;
    }
    setTimeout(tick, backoff);
  };

  tick();
}

function renderHistory(history) {
  const empty = document.getElementById("historyEmpty");
  const canvas = document.getElementById("historyChart");

  if (!history.length) {
    empty.style.display = "block";
    canvas.style.display = "none";
    return;
  }

  empty.style.display = "none";
  canvas.style.display = "block";

  if (historyChart) {
    historyChart.destroy();
  }

  historyChart = new Chart(canvas, {
    type: "line",
    data: {
      labels: history.map((row) => formatHistoryLabel(row.date)),
      datasets: [
        {
          data: history.map((row) => row.value),
          borderColor: "#8df0d2",
          backgroundColor: "rgba(141, 240, 210, 0.2)",
          tension: 0.35,
          fill: true,
          pointRadius: 3,
        },
      ],
    },
    options: {
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => fmtCurrency.format(ctx.parsed.y),
          },
        },
      },
      scales: {
        x: { ticks: { color: "#e0e6f3" }, grid: { color: "rgba(255,255,255,0.06)" } },
        y: { ticks: { color: "#e0e6f3" }, grid: { color: "rgba(255,255,255,0.06)" } },
      },
    },
  });
}

function renderDailyGainLoss(rows) {
  const totalValue = rows.reduce((sum, row) => sum + row.value, 0);
  const dailyChangeValue = rows.reduce((sum, row) => sum + row.value * row.dailyPct, 0);
  const dailyChangePct = totalValue ? dailyChangeValue / totalValue : 0;

  const totalEl = document.getElementById("dailyTotalPL");
  const metaEl = document.getElementById("dailyTotalPLMeta");
  const monthsEl = document.getElementById("dailyCalendarMonths");
  const emptyEl = document.getElementById("dailyCalendarEmpty");

  totalEl.textContent = fmtCurrency.format(dailyChangeValue);
  totalEl.style.color = dailyChangeValue >= 0 ? "#62d99c" : "#f45b69";
  metaEl.textContent = `Today: ${formatSignedPercent(dailyChangePct)} (since Feb 2026)`;
  metaEl.style.color = dailyChangeValue >= 0 ? "#62d99c" : "#f45b69";

  const history = loadStoredDailyPLHistory().filter(
    (item) => item.date >= DAILY_CALENDAR_START_ISO
  );
  const plMap = new Map(history.map((item) => [item.date, item.pl]));
  const lastDate = history.length ? parseIsoDate(history[history.length - 1].date) : null;
  monthsEl.innerHTML = "";

  if (!plMap.size) {
    emptyEl.style.display = "block";
    monthsEl.style.display = "none";
    return;
  }

  emptyEl.style.display = "none";
  monthsEl.style.display = "grid";

  const maxAbs = Array.from(plMap.values()).reduce((best, value) => {
    return Math.max(best, Math.abs(value));
  }, 0);
  const calendarStart = parseIsoDate(DAILY_CALENDAR_START_ISO);
  const anchorDate = lastDate || new Date();
  const anchorMonth = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1);
  const monthCursor = new Date(calendarStart.getFullYear(), calendarStart.getMonth(), 1);
  const monthStarts = [];
  while (monthCursor <= anchorMonth) {
    monthStarts.push(new Date(monthCursor));
    monthCursor.setMonth(monthCursor.getMonth() + 1);
  }
  const weekdayLabels = ["S", "M", "T", "W", "T", "F", "S"];

  monthStarts.forEach((monthDate) => {
    const monthCard = document.createElement("div");
    monthCard.className = "daily-month-card";

    const title = document.createElement("div");
    title.className = "daily-month-title";
    title.textContent = monthDate.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    });
    monthCard.appendChild(title);

    const weekdaysRow = document.createElement("div");
    weekdaysRow.className = "daily-weekdays";
    weekdayLabels.forEach((label) => {
      const day = document.createElement("span");
      day.textContent = label;
      weekdaysRow.appendChild(day);
    });
    monthCard.appendChild(weekdaysRow);

    const grid = document.createElement("div");
    grid.className = "daily-month-grid";

    const firstDay = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1).getDay();
    const daysInMonth = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0).getDate();

    for (let i = 0; i < firstDay; i += 1) {
      const blank = document.createElement("div");
      blank.className = "daily-cell blank";
      grid.appendChild(blank);
    }

    for (let dayNum = 1; dayNum <= daysInMonth; dayNum += 1) {
      const dayDate = new Date(monthDate.getFullYear(), monthDate.getMonth(), dayNum);
      const key = toIsoLocal(dayDate);
      const pl = plMap.get(key);
      const cell = document.createElement("div");
      cell.className = `daily-cell${Number.isFinite(pl) ? " data" : " nodata"}`;
      cell.innerHTML = `<span class="daily-cell-day">${dayNum}</span>`;
      if (Number.isFinite(pl)) {
        cell.style.backgroundColor = getCalendarCellColor(pl, maxAbs);
        const amount = document.createElement("span");
        amount.className = "daily-cell-amount";
        amount.textContent = formatDailyCellAmount(pl);
        cell.appendChild(amount);
        const signed = pl >= 0 ? `+${fmtCurrency.format(pl)}` : fmtCurrency.format(pl);
        cell.title = `${dayDate.toLocaleDateString("en-US")}: ${signed}`;
      } else {
        cell.title = `${dayDate.toLocaleDateString("en-US")}: No data`;
      }
      grid.appendChild(cell);
    }

    while (grid.children.length % 7 !== 0) {
      const blank = document.createElement("div");
      blank.className = "daily-cell blank";
      grid.appendChild(blank);
    }

    monthCard.appendChild(grid);
    monthsEl.appendChild(monthCard);
  });
}

function renderSummary(displayRows, snapshotRows = displayRows) {
  const totalValue = displayRows.reduce((sum, row) => sum + row.value, 0);
  const dailyChangeValue = displayRows.reduce(
    (sum, row) => sum + row.value * row.dailyPct,
    0
  );
  const dailyChangePct = totalValue ? dailyChangeValue / totalValue : 0;
  let snapshots = loadStoredPortfolioHistory();
  const todayIso = toIsoLocal(new Date());
  if (!snapshots.some((entry) => entry.date === todayIso)) {
    const snapshotTotal = snapshotRows.reduce((sum, row) => sum + row.value, 0);
    snapshots = snapshots.concat({
      date: todayIso,
      totalValue: snapshotTotal,
      positions: buildSnapshotPositions(snapshotRows),
    });
    snapshots.sort((a, b) => a.date.localeCompare(b.date));
  }
  const performanceSeries = buildPortfolioPerformanceSeries(snapshots);
  latestPortfolioReturns = computePortfolioReturnsFromSeries(performanceSeries, dailyChangePct);
  const exposure = getPortfolioExposure(displayRows);

  document.getElementById("totalValue").textContent = fmtCurrency.format(totalValue);
  document.getElementById("dailyChange").textContent = `${formatSignedPercent(
    dailyChangePct
  )} today (${fmtCurrency.format(dailyChangeValue)})`;
  document.getElementById("dailyChange").style.color =
    dailyChangeValue >= 0 ? "#62d99c" : "#f45b69";

  setSnapshotMetric(
    "perf1W",
    Number.isFinite(latestPortfolioReturns.w1) ? formatSignedPercent(latestPortfolioReturns.w1) : "—",
    latestPortfolioReturns.w1 > 0 ? "pos" : latestPortfolioReturns.w1 < 0 ? "neg" : "neutral"
  );
  setSnapshotMetric(
    "perf1M",
    Number.isFinite(latestPortfolioReturns.m1) ? formatSignedPercent(latestPortfolioReturns.m1) : "—",
    latestPortfolioReturns.m1 > 0 ? "pos" : latestPortfolioReturns.m1 < 0 ? "neg" : "neutral"
  );
  setSnapshotMetric(
    "perfYTD",
    Number.isFinite(latestPortfolioReturns.ytd) ? formatSignedPercent(latestPortfolioReturns.ytd) : "—",
    latestPortfolioReturns.ytd > 0 ? "pos" : latestPortfolioReturns.ytd < 0 ? "neg" : "neutral"
  );
  setSnapshotMetric("perfCashPct", fmtPercent.format(exposure.cashPct));
  setSnapshotMetric("perfCryptoPct", fmtPercent.format(exposure.cryptoPct));
}

async function loadData() {
  let csvText = SAMPLE_CSV;
  let sourceLabel = "Sample data";

  if (SHEET_CSV_URL) {
    try {
      const response = await fetch(SHEET_CSV_URL);
      if (!response.ok) {
        throw new Error("Failed to fetch sheet data.");
      }
      csvText = await response.text();
      sourceLabel = "Google Sheets (read-only)";
    } catch (err) {
      csvText = SAMPLE_CSV;
      sourceLabel = "Sample data (sheet unavailable)";
    }
  }

  let rows = parseCSV(csvText)
    .map(normalizeRow)
    .filter((row) => row.ticker);

  if (!rows.length && csvText !== SAMPLE_CSV) {
    rows = parseCSV(SAMPLE_CSV)
      .map(normalizeRow)
      .filter((row) => row.ticker);
    sourceLabel = "Sample data (sheet empty)";
  }

  rows.sort((a, b) => b.value - a.value);

  currentRows = rows;
  const hasSheetPrices = rows.some((row) => row.price > 0);
  pricesLastUpdatedAt = hasSheetPrices ? new Date() : null;
  const displayRows = getDisplayRows(rows);
  const regularRows = getRegularRows(rows);
  persistDailyRecords(regularRows);
  renderSummary(displayRows, regularRows);
  renderDailyGainLoss(displayRows);
  renderTable(displayRows);
  renderTreemap(displayRows);
  renderExposureBreakdown(displayRows);
  renderBenchmarkContext();
  renderExpertAdvice(displayRows, currentNewsItems);
  renderDataFreshness();
  startLivePrices(rows);

  document.getElementById("sourceLabel").textContent = sourceLabel;

  let historyData = [];
  if (HISTORY_CSV_URL) {
    try {
      const response = await fetch(HISTORY_CSV_URL);
      if (response.ok) {
        const historyText = await response.text();
        historyData = parseHistoryCSV(historyText);
      }
    } catch (err) {
      historyData = [];
    }
  }
  renderHistory(historyData);
  loadNewsDigest();
  refreshBenchmarkContext().catch(() => {
    const meta = document.getElementById("benchmarkMeta");
    if (meta) {
      meta.textContent = "Benchmark fetch failed. Click Refresh to retry.";
    }
  });
}

document.getElementById("refreshBtn").addEventListener("click", () => {
  loadData().catch((err) => {
    alert(err.message);
  });
});

document.getElementById("themeToggle").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-theme]");
  if (!button) {
    return;
  }
  setTheme(button.dataset.theme);
});

document.getElementById("priceModeToggle").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-mode]");
  if (!button) {
    return;
  }
  setPriceMode(button.dataset.mode);
});

document.getElementById("holdingsHead").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-sort-key]");
  if (!button) {
    return;
  }
  const nextKey = button.dataset.sortKey;
  if (holdingsSortState.key === nextKey) {
    holdingsSortState.direction = holdingsSortState.direction === "asc" ? "desc" : "asc";
  } else {
    holdingsSortState = { key: nextKey, direction: "desc" };
  }
  renderTable(getDisplayRows(currentRows));
});

document.getElementById("newsRefresh").addEventListener("click", () => {
  loadNewsDigest();
});

document.getElementById("newsSource").addEventListener("change", () => {
  loadNewsDigest();
});

document.getElementById("newsFocus").addEventListener("change", () => {
  loadNewsDigest();
});

document.getElementById("adviceRefresh").addEventListener("click", () => {
  renderExpertAdvice(getDisplayRows(currentRows), currentNewsItems);
});

document.getElementById("adviceSource").addEventListener("change", () => {
  renderExpertAdvice(getDisplayRows(currentRows), currentNewsItems);
});

document.getElementById("adviceMode").addEventListener("change", () => {
  renderExpertAdvice(getDisplayRows(currentRows), currentNewsItems);
});

document.getElementById("copyAdvicePrompt").addEventListener("click", async () => {
  const prompt = document.getElementById("advicePrompt").value;
  if (!prompt) {
    return;
  }
  try {
    await navigator.clipboard.writeText(prompt);
    document.getElementById("adviceMeta").textContent = "Prompt copied to clipboard.";
  } catch (err) {
    document.getElementById("adviceMeta").textContent = "Could not copy prompt. Please copy manually.";
  }
});

document.getElementById("dailyHistoryToggle").addEventListener("click", () => {
  setDailyHistoryExpanded(!dailyHistoryExpanded);
});

setDailyHistoryExpanded(false);
initTheme();
initPriceMode();
renderDataFreshness();
setInterval(renderDataFreshness, 60_000);

loadData().catch((err) => {
  alert(err.message);
});
