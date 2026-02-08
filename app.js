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
let liveRows = [];
let liveUpdateScheduled = false;
let holdingsSortMode = "value";
let currentRows = [];
let currentNewsItems = [];
let newsIsLoading = false;
let dailyHistoryExpanded = false;

const DAILY_PL_STORAGE_KEY = "portfolio_pulse_daily_pl_v1";
const DAILY_PL_HISTORY_LIMIT = 400;
const DAILY_CALENDAR_START_ISO = "2026-02-01";

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

function normalizeRow(row) {
  const normalized = {};
  Object.entries(row).forEach(([key, value]) => {
    const cleanKey = key.toLowerCase().replace(/\s+/g, " ").trim();
    normalized[cleanKey] = value;
  });

  const ticker = normalized["ticker"] || normalized["ticket"] || "";
  const shares = Number(normalized["shares"] || 0);
  const price = Number(normalized["price (current)"] || normalized["price"] || 0);
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

  return {
    ticker,
    shares,
    price,
    dailyPct,
    value,
    monthPct,
    yearPct,
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
  renderNewsDigest(ranked, {
    fetchedAny,
    selectedSource,
    selectedFocus,
  });
  renderExpertAdvice(currentRows, currentNewsItems);
  newsIsLoading = false;
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
      ? "Try a different focus."
      : "Try Refresh News or switch source.";
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
    lines.push(`Today's dispersion is wide: strongest is ${best.ticker} (${fmtPercent.format(best.dailyPct)}), weakest is ${worst.ticker} (${fmtPercent.format(worst.dailyPct)}). Re-check thesis before reacting to one-day moves.`);
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
  const clamped = Math.max(-0.12, Math.min(0.12, pct || 0));
  const t = Math.min(1, Math.abs(clamped) / 0.12);
  const from = clamped >= 0 ? [33, 88, 56] : [98, 41, 48];
  const to = clamped >= 0 ? [86, 196, 132] : [229, 96, 107];
  const r = Math.round(from[0] + (to[0] - from[0]) * t);
  const g = Math.round(from[1] + (to[1] - from[1]) * t);
  const b = Math.round(from[2] + (to[2] - from[2]) * t);
  return {
    fill: `rgb(${r}, ${g}, ${b})`,
    border: `rgb(${Math.max(0, r - 20)}, ${Math.max(0, g - 20)}, ${Math.max(0, b - 20)})`,
  };
}

function getSizeClass(area) {
  if (area > 140000) return "size-xl";
  if (area > 90000) return "size-lg";
  if (area > 45000) return "size-md";
  if (area > 18000) return "size-sm";
  return "size-xs";
}

function getSortedRows(rows) {
  const sorted = rows.slice();
  if (holdingsSortMode === "daily") {
    sorted.sort((a, b) => {
      if (b.dailyPct !== a.dailyPct) {
        return b.dailyPct - a.dailyPct;
      }
      return b.value - a.value;
    });
    return sorted;
  }
  sorted.sort((a, b) => {
    if (b.value !== a.value) {
      return b.value - a.value;
    }
    return b.dailyPct - a.dailyPct;
  });
  return sorted;
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
    tr.innerHTML = `
      <td>${tickerCell}</td>
      <td>${row.shares.toLocaleString()}</td>
      <td>${priceDisplay}</td>
      <td class="${row.dailyPct >= 0 ? "pos" : "neg"}">
        ${fmtPercent.format(row.dailyPct)}
      </td>
      <td>${valueDisplay}</td>
    `;
    tbody.appendChild(tr);
  });
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
  const breadcrumb = document.getElementById("treemapBreadcrumb");
  const items = buildTreemapRows(rows);
  const totalValue = items.reduce((sum, item) => sum + (item.value || 0), 0);
  breadcrumb.textContent = `All Stocks (${items.length})`;

  if (!items.length) {
    return;
  }

  const width = Math.max(1, Math.round(treemap.clientWidth));
  const height = Math.max(1, Math.round(treemap.clientHeight));
  const rects = layoutTreemapRectangles(items, 0, 0, width, height);

  rects
    .filter((item) => item.rect.width > 0 && item.rect.height > 0)
    .forEach((item) => {
      const block = document.createElement("div");
      const area = item.rect.width * item.rect.height;
      block.className = `treemap-block ${getSizeClass(area)} leaf`;
      block.style.left = `${item.rect.x}px`;
      block.style.top = `${item.rect.y}px`;
      block.style.width = `${item.rect.width}px`;
      block.style.height = `${item.rect.height}px`;

      const heat = getHeatColor(item.dailyPct || 0);
      block.style.backgroundColor = heat.fill;
      block.style.borderColor = heat.border;

      const pct = formatSignedPercent(item.dailyPct || 0);
      const value = fmtCurrency.format(item.value || 0);
      const weight = totalValue > 0 ? (item.value || 0) / totalValue : 0;
      block.innerHTML = `
        <div>
          <div class="title">${item.name}</div>
          <div class="meta pct">${pct}</div>
          <div class="meta value">${value}</div>
          <div class="meta weight">${fmtPercent.format(weight)} of total</div>
        </div>
      `;

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
    renderSummary(liveRows);
    renderDailyGainLoss(liveRows);
    renderTable(liveRows);
    renderTreemap(liveRows);
    renderExpertAdvice(liveRows, currentNewsItems);
  });
}

function applyLivePrice(ticker, price) {
  const row = liveRows.find((item) => item.ticker === ticker);
  if (!row) {
    return;
  }
  row.price = price;
  row.value = row.shares * price;
  scheduleLiveRender();
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
    data.forEach((item) => {
      if (item && item.symbol && item.price) {
        const pct = item.changesPercentage ? Number(item.changesPercentage) / 100 : 0;
        const row = rows.find((r) => r.ticker === item.symbol);
        if (row) {
          row.dailyPct = Number.isFinite(pct) ? pct : row.dailyPct;
        }
        applyLivePrice(item.symbol, Number(item.price));
      }
    });
    return { ok: true, rateLimited: false };
  } catch (err) {
    return { ok: false, rateLimited: false };
  }
}

function startLivePrices(rows) {
  liveRows = rows;
  let backoff = LIVE_PRICE_REFRESH_MS;

  const tick = async () => {
    const result = await fetchLivePricesFmp(rows);
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
  metaEl.textContent = `Today: ${fmtPercent.format(dailyChangePct)} (since Feb 2026)`;
  metaEl.style.color = dailyChangeValue >= 0 ? "#62d99c" : "#f45b69";

  const history = upsertTodayDailyPL(dailyChangeValue, dailyChangePct).filter(
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

function renderSummary(rows) {
  const totalValue = rows.reduce((sum, row) => sum + row.value, 0);
  const dailyChangeValue = rows.reduce(
    (sum, row) => sum + row.value * row.dailyPct,
    0
  );
  const dailyChangePct = totalValue ? dailyChangeValue / totalValue : 0;

  const topMover = rows.reduce(
    (best, row) =>
      Math.abs(row.dailyPct) > Math.abs(best.dailyPct) ? row : best,
    rows[0]
  );

  const monthRows = rows.filter((row) => row.monthPct !== null);
  const yearRows = rows.filter((row) => row.yearPct !== null);

  const monthPL = monthRows.length
    ? monthRows.reduce((sum, row) => sum + row.value * row.monthPct, 0)
    : null;
  const yearPL = yearRows.length
    ? yearRows.reduce((sum, row) => sum + row.value * row.yearPct, 0)
    : null;

  document.getElementById("totalValue").textContent = fmtCurrency.format(totalValue);
  document.getElementById("dailyChange").textContent = `${fmtPercent.format(
    dailyChangePct
  )} today (${fmtCurrency.format(dailyChangeValue)})`;
  document.getElementById("dailyChange").style.color =
    dailyChangeValue >= 0 ? "#62d99c" : "#f45b69";

  document.getElementById("topMover").textContent = topMover.ticker;
  document.getElementById("topMoverDelta").textContent = fmtPercent.format(
    topMover.dailyPct
  );
  document.getElementById("topMoverDelta").style.color =
    topMover.dailyPct >= 0 ? "#62d99c" : "#f45b69";

  document.getElementById("dailyPL").textContent = fmtCurrency.format(dailyChangeValue);
  document.getElementById("dailyPL").style.color =
    dailyChangeValue >= 0 ? "#62d99c" : "#f45b69";

  document.getElementById("monthlyPL").textContent = monthPL
    ? fmtCurrency.format(monthPL)
    : "Add column";
  document.getElementById("monthlyPL").style.color =
    monthPL === null ? "#a6b0c3" : monthPL >= 0 ? "#62d99c" : "#f45b69";

  document.getElementById("yearlyPL").textContent = yearPL
    ? fmtCurrency.format(yearPL)
    : "Add column";
  document.getElementById("yearlyPL").style.color =
    yearPL === null ? "#a6b0c3" : yearPL >= 0 ? "#62d99c" : "#f45b69";
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
  renderSummary(rows);
  renderDailyGainLoss(rows);
  renderTable(rows);
  renderTreemap(rows);
  renderExpertAdvice(rows, currentNewsItems);
  const hasSheetPrices = rows.some((row) => row.price > 0);
  if (!hasSheetPrices) {
    startLivePrices(rows);
  }

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
}

document.getElementById("refreshBtn").addEventListener("click", () => {
  loadData().catch((err) => {
    alert(err.message);
  });
});

document.getElementById("holdingsSortToggle").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-sort]");
  if (!button) {
    return;
  }
  holdingsSortMode = button.dataset.sort === "daily" ? "daily" : "value";
  document.querySelectorAll("#holdingsSortToggle .sort-pill").forEach((pill) => {
    pill.classList.toggle("active", pill === button);
  });
  renderTable(currentRows);
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
  renderExpertAdvice(currentRows, currentNewsItems);
});

document.getElementById("adviceSource").addEventListener("change", () => {
  renderExpertAdvice(currentRows, currentNewsItems);
});

document.getElementById("adviceMode").addEventListener("change", () => {
  renderExpertAdvice(currentRows, currentNewsItems);
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

loadData().catch((err) => {
  alert(err.message);
});
