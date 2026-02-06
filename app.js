const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1YYl_8P_HehmfZzRGa7q-zWvNEiI22JrduPkTFXJ-1D4/export?format=csv&gid=0";

const HISTORY_CSV_URL = "";

const FMP_API_KEY = "";
const FMP_QUOTE_BASE = "https://financialmodelingprep.com/stable/batch-quote";
const LIVE_PRICE_REFRESH_MS = 60_000;
const LIVE_PRICE_MAX_BACKOFF_MS = 5 * 60_000;
const PROFILE_REQUEST_DELAY_MS = 1100;

const SECTOR_MAP = {
  AAPL: "Consumer Tech",
  MSFT: "Enterprise Tech",
  NVDA: "Semiconductors",
  AMZN: "Consumer Tech",
  TSLA: "Automotive",
};

const SAMPLE_CSV = `ticket,shares
NVDA,100
AAPL,50
MSFT,20
AMZN,12
TSLA,8`;

const fmtCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const fmtPercent = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 2,
});

let tickerChart;
let historyChart;
let liveRows = [];
let liveUpdateScheduled = false;

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines.shift().split(",").map((h) => h.trim());
  return lines.map((line) => {
    const values = line.split(",").map((v) => v.trim());
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
  const dailyPct = Number(dailyPctRaw.toString().replace("%", "")) / 100;
  const value =
    Number(normalized["value"] || 0) || (shares && price ? shares * price : 0);
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

async function fetchProfileForTicker(ticker) {
  if (!FMP_API_KEY) {
    return { sector: SECTOR_MAP[ticker] || "Unknown", industry: "Unknown" };
  }

  const cacheKey = `profile_${ticker}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  const url = `https://financialmodelingprep.com/api/v3/profile/${ticker}?apikey=${FMP_API_KEY}`;
  const response = await fetch(url);
  if (!response.ok) {
    return { sector: SECTOR_MAP[ticker] || "Unknown", industry: "Unknown" };
  }
  const data = await response.json();
  const profile = {
    sector: data?.[0]?.sector || SECTOR_MAP[ticker] || "Unknown",
    industry: data?.[0]?.industry || "Unknown",
  };
  localStorage.setItem(cacheKey, JSON.stringify(profile));
  return profile;
}

async function buildProfileMap(rows) {
  const map = {};
  const tickers = rows
    .map((row) => row.ticker)
    .filter((ticker) => {
      if (!ticker) {
        return false;
      }
      return ticker.toUpperCase() !== "CASH";
    });
  for (const ticker of tickers) {
    map[ticker] = await fetchProfileForTicker(ticker);
    await new Promise((resolve) => setTimeout(resolve, PROFILE_REQUEST_DELAY_MS));
  }
  return map;
}

function buildCharts(rows) {
  const labels = rows.map((row) => row.ticker);
  const values = rows.map((row) => row.value);
  const dailyPct = rows.map((row) => row.dailyPct);

  const palette = [
    "#f8c15c",
    "#8df0d2",
    "#6aa2ff",
    "#f45b69",
    "#c6a5ff",
    "#58c4e5",
    "#f0a6ca",
  ];

  if (tickerChart) {
    tickerChart.destroy();
  }

  tickerChart = new Chart(document.getElementById("tickerChart"), {
    type: "doughnut",
    data: {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: labels.map((_, idx) => palette[idx % palette.length]),
          borderWidth: 0,
        },
      ],
    },
    options: {
      cutout: "62%",
      plugins: {
        legend: {
          labels: { color: "#e0e6f3" },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const pct = fmtPercent.format(dailyPct[ctx.dataIndex] || 0);
              const val = fmtCurrency.format(values[ctx.dataIndex] || 0);
              return `${ctx.label}: ${val} (${pct} daily)`;
            },
          },
        },
      },
    },
  });

}

function renderTable(rows) {
  const tbody = document.getElementById("holdingsTable");
  tbody.innerHTML = "";
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    const priceDisplay = row.price ? fmtCurrency.format(row.price) : "—";
    const valueDisplay = row.value ? fmtCurrency.format(row.value) : "—";
    tr.innerHTML = `
      <td>${row.ticker}</td>
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

function squarify(items, x, y, width, height) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (!total) {
    return [];
  }
  const result = [];
  let remaining = items.slice().sort((a, b) => b.value - a.value);
  let row = [];
  let remainingWidth = width;
  let remainingHeight = height;
  let offsetX = x;
  let offsetY = y;

  function layoutRow(rowItems, rowSum, horizontal) {
    const rowSize = horizontal ? remainingHeight : remainingWidth;
    const rowLength = (rowSum / total) * ((width * height) / rowSize);
    let offset = 0;

    rowItems.forEach((item) => {
      const itemSize = (item.value / rowSum) * rowSize;
      const rect = horizontal
        ? { x: offsetX + offset, y: offsetY, width: itemSize, height: rowLength }
        : { x: offsetX, y: offsetY + offset, width: rowLength, height: itemSize };
      result.push({ ...item, rect });
      offset += itemSize;
    });

    if (horizontal) {
      offsetY += rowLength;
      remainingHeight -= rowLength;
    } else {
      offsetX += rowLength;
      remainingWidth -= rowLength;
    }
  }

  function worstAspect(rowItems, rowSum, rowSize) {
    const areas = rowItems.map((item) => item.value);
    const maxArea = Math.max(...areas);
    const minArea = Math.min(...areas);
    const rowLength = (rowSum / total) * ((width * height) / rowSize);
    if (!rowSum || !rowSize || !minArea) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.max(
      (rowSize * rowSize * maxArea) / (rowSum * rowSum),
      (rowSum * rowSum) / (rowSize * rowSize * minArea)
    );
  }

  while (remaining.length) {
    const item = remaining[0];
    const rowSum = row.reduce((sum, i) => sum + i.value, 0);
    const rowSize = remainingWidth < remainingHeight ? remainingWidth : remainingHeight;
    const newRow = [...row, item];
    const newSum = rowSum + item.value;

    if (!row.length || worstAspect(newRow, newSum, rowSize) <= worstAspect(row, rowSum, rowSize)) {
      row = newRow;
      remaining.shift();
    } else {
      const horizontal = remainingWidth >= remainingHeight;
      layoutRow(row, rowSum, horizontal);
      row = [];
    }
  }

  if (row.length) {
    const rowSum = row.reduce((sum, i) => sum + i.value, 0);
    const horizontal = remainingWidth >= remainingHeight;
    layoutRow(row, rowSum, horizontal);
  }

  return result;
}

function buildTreemapRows(rows, level, filterKey) {
  if (level === "sector") {
    const totals = rows.reduce((acc, row) => {
      const sector = row.sector || "Unknown";
      acc[sector] = acc[sector] || { name: sector, value: 0, dailyWeighted: 0 };
      acc[sector].value += row.value;
      acc[sector].dailyWeighted += row.value * row.dailyPct;
      return acc;
    }, {});
    return Object.values(totals).map((item) => ({
      ...item,
      dailyPct: item.value ? item.dailyWeighted / item.value : 0,
    }));
  }

  if (level === "industry") {
    const totals = rows.reduce((acc, row) => {
      if (row.sector !== filterKey) {
        return acc;
      }
      const industry = row.industry || "Unknown";
      acc[industry] = acc[industry] || { name: industry, value: 0, dailyWeighted: 0 };
      acc[industry].value += row.value;
      acc[industry].dailyWeighted += row.value * row.dailyPct;
      return acc;
    }, {});
    return Object.values(totals).map((item) => ({
      ...item,
      dailyPct: item.value ? item.dailyWeighted / item.value : 0,
    }));
  }

  if (level === "ticker") {
    return rows
      .filter((row) => row.industry === filterKey)
      .map((row) => ({
        name: row.ticker,
        value: row.value,
        dailyPct: row.dailyPct,
      }));
  }

  return [];
}

function renderTreemap(rows, level = "sector", filterKey = null) {
  const treemap = document.getElementById("treemap");
  treemap.innerHTML = "";
  const breadcrumb = document.getElementById("treemapBreadcrumb");

  if (level === "sector") {
    breadcrumb.textContent = "All Sectors";
  } else if (level === "industry") {
    breadcrumb.textContent = `Sector: ${filterKey}`;
  } else {
    breadcrumb.textContent = `Industry: ${filterKey}`;
  }

  const items = buildTreemapRows(rows, level, filterKey).filter((item) => item.value > 0);
  const rects = squarify(items, 0, 0, treemap.clientWidth, treemap.clientHeight);

  rects.forEach((item) => {
    const block = document.createElement("div");
    block.className = `treemap-block ${item.dailyPct >= 0 ? "green" : "red"}`;
    block.style.left = `${item.rect.x}px`;
    block.style.top = `${item.rect.y}px`;
    block.style.width = `${Math.max(0, item.rect.width)}px`;
    block.style.height = `${Math.max(0, item.rect.height)}px`;

    const pct = fmtPercent.format(item.dailyPct || 0);
    const value = fmtCurrency.format(item.value || 0);
    block.innerHTML = `
      <div>
        <div class="title">${item.name}</div>
        <div class="meta">${pct} today</div>
        <div class="meta">${value}</div>
      </div>
    `;

    if (level === "sector") {
      block.addEventListener("click", () => {
        treemapState.level = "industry";
        treemapState.filterKey = item.name;
        renderTreemap(rows, "industry", item.name);
      });
    } else if (level === "industry") {
      block.addEventListener("click", () => {
        treemapState.level = "ticker";
        treemapState.filterKey = item.name;
        renderTreemap(rows, "ticker", item.name);
      });
    } else {
      block.addEventListener("click", () => {
        treemapState.level = "sector";
        treemapState.filterKey = null;
        renderTreemap(rows, "sector");
      });
    }

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
    renderSummary(liveRows);
    renderTable(liveRows);
    buildCharts(liveRows);
    renderTreemap(liveRows, treemapState.level, treemapState.filterKey);
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

const treemapState = {
  level: "sector",
  filterKey: null,
};

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
    const response = await fetch(SHEET_CSV_URL);
    if (!response.ok) {
      throw new Error("Failed to fetch sheet data.");
    }
    csvText = await response.text();
    sourceLabel = "Google Sheets (read-only)";
  }

  const rows = parseCSV(csvText)
    .map(normalizeRow)
    .filter((row) => row.ticker);

  const profileMap = await buildProfileMap(rows);
  rows.forEach((row) => {
    row.sector = profileMap[row.ticker]?.sector || SECTOR_MAP[row.ticker] || "Unknown";
    row.industry = profileMap[row.ticker]?.industry || "Unknown";
  });

  rows.sort((a, b) => b.value - a.value);

  renderSummary(rows);
  renderTable(rows);
  buildCharts(rows);
  renderTreemap(rows, treemapState.level, treemapState.filterKey);
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
}

document.getElementById("refreshBtn").addEventListener("click", () => {
  loadData().catch((err) => {
    alert(err.message);
  });
});

loadData().catch((err) => {
  alert(err.message);
});
