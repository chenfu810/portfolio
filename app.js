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
let currentHistoryData = [];

const TREEMAP_GAP_PX = 6;
const TREEMAP_MIN_MAIN_SIDE_PX = 48;
const TREEMAP_MICRO_THRESHOLD_PX = 44;

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

function toIsoLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateLoose(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  parsed.setHours(0, 0, 0, 0);
  return parsed;
}

function buildDailyPLMap(history) {
  const sorted = history
    .map((row) => ({
      date: parseDateLoose(row.date),
      value: Number(row.value),
    }))
    .filter((row) => row.date && Number.isFinite(row.value))
    .sort((a, b) => a.date - b.date);

  const map = new Map();
  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    const previous = sorted[i - 1];
    map.set(toIsoLocal(current.date), current.value - previous.value);
  }
  return {
    map,
    lastDate: sorted.length ? sorted[sorted.length - 1].date : null,
  };
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

function renderTable(rows) {
  const tbody = document.getElementById("holdingsTable");
  tbody.innerHTML = "";
  const sortedRows = getSortedRows(rows);
  sortedRows.forEach((row) => {
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

function getTargetSquares(items, width, height) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (!total || width <= 0 || height <= 0) {
    return [];
  }
  const area = width * height;
  return items.map((item) => ({
    ...item,
    targetSide: Math.sqrt((item.value / total) * area),
  }));
}

function packSquares(items, width, height, minSide) {
  const placed = [];
  const overflow = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;

  items.forEach((item) => {
    const side = Math.max(minSide, Math.min(width, item.targetSide));
    if (x > 0 && x + side > width) {
      x = 0;
      y += rowHeight + TREEMAP_GAP_PX;
      rowHeight = 0;
    }
    if (y + side > height) {
      overflow.push(item);
      return;
    }
    placed.push({
      ...item,
      rect: {
        x,
        y,
        width: side,
        height: side,
      },
    });
    x += side + TREEMAP_GAP_PX;
    rowHeight = Math.max(rowHeight, side);
  });

  return { placed, overflow };
}

function renderTreemap(rows) {
  const treemap = document.getElementById("treemap");
  treemap.innerHTML = "";
  const breadcrumb = document.getElementById("treemapBreadcrumb");
  breadcrumb.textContent = "All Stocks";

  const items = buildTreemapRows(rows);
  if (!items.length) {
    return;
  }

  let mainWidth = treemap.clientWidth;
  const mainHeight = treemap.clientHeight;
  let microPaneWidth = 0;
  let microItems = [];
  let mainItems = items;

  const initialTargets = getTargetSquares(items, mainWidth, mainHeight);
  microItems = initialTargets
    .filter((item) => item.targetSide < TREEMAP_MICRO_THRESHOLD_PX)
    .map((item) => ({ name: item.name, value: item.value, dailyPct: item.dailyPct }));

  if (microItems.length > 0) {
    const paneGap = 8;
    const desiredPaneWidth =
      treemap.clientWidth < 560
        ? 120
        : Math.min(240, Math.max(160, Math.round(treemap.clientWidth * 0.24)));
    microPaneWidth = Math.min(
      desiredPaneWidth,
      Math.max(100, treemap.clientWidth - 220 - paneGap)
    );
    mainWidth = treemap.clientWidth - microPaneWidth - paneGap;
    if (mainWidth < 180) {
      microPaneWidth = 0;
      mainWidth = treemap.clientWidth;
      microItems = [];
    } else {
      const microSet = new Set(microItems.map((item) => item.name));
      mainItems = items.filter((item) => !microSet.has(item.name));
      if (!mainItems.length) {
        mainItems = items.slice(0, 1);
        microItems = items.slice(1);
      }
    }
  }

  const mainTargets = getTargetSquares(mainItems, mainWidth, mainHeight);
  let packed = packSquares(mainTargets, mainWidth, mainHeight, TREEMAP_MIN_MAIN_SIDE_PX);
  if (!microPaneWidth && packed.overflow.length) {
    [28, 20, 14, 10].some((side) => {
      packed = packSquares(mainTargets, mainWidth, mainHeight, side);
      return packed.overflow.length === 0;
    });
  }
  microItems = microItems.concat(
    packed.overflow.map((item) => ({
      name: item.name,
      value: item.value,
      dailyPct: item.dailyPct,
    }))
  );

  packed.placed.forEach((item) => {
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

    const pct = fmtPercent.format(item.dailyPct || 0);
    const value = fmtCurrency.format(item.value || 0);
    block.innerHTML = `
      <div>
        <div class="title">${item.name}</div>
        <div class="meta pct">${pct}</div>
        <div class="meta value">${value}</div>
      </div>
    `;

    treemap.appendChild(block);
  });

  if (microPaneWidth > 0 && microItems.length > 0) {
    const pane = document.createElement("div");
    pane.className = "treemap-micro-pane";
    pane.style.left = `${mainWidth + 8}px`;
    pane.style.width = `${microPaneWidth}px`;

    const title = document.createElement("div");
    title.className = "treemap-micro-title";
    title.textContent = "Small Positions";
    pane.appendChild(title);

    const list = document.createElement("div");
    list.className = "treemap-micro-list";
    microItems
      .sort((a, b) => b.value - a.value)
      .forEach((item) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "treemap-micro-chip leaf";
        const heat = getHeatColor(item.dailyPct || 0);
        chip.style.backgroundColor = heat.fill;
        chip.style.borderColor = heat.border;
        chip.innerHTML = `
          <span>${item.name}</span>
          <span>${fmtPercent.format(item.dailyPct || 0)}</span>
        `;
        list.appendChild(chip);
      });
    pane.appendChild(list);
    treemap.appendChild(pane);
  }
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
    renderDailyGainLoss(liveRows, currentHistoryData);
    renderTable(liveRows);
    renderTreemap(liveRows);
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

function renderDailyGainLoss(rows, historyData) {
  const totalValue = rows.reduce((sum, row) => sum + row.value, 0);
  const dailyChangeValue = rows.reduce((sum, row) => sum + row.value * row.dailyPct, 0);
  const dailyChangePct = totalValue ? dailyChangeValue / totalValue : 0;

  const totalEl = document.getElementById("dailyTotalPL");
  const metaEl = document.getElementById("dailyTotalPLMeta");
  const monthsEl = document.getElementById("dailyCalendarMonths");
  const emptyEl = document.getElementById("dailyCalendarEmpty");

  totalEl.textContent = fmtCurrency.format(dailyChangeValue);
  totalEl.style.color = dailyChangeValue >= 0 ? "#62d99c" : "#f45b69";
  metaEl.textContent = `Today: ${fmtPercent.format(dailyChangePct)}`;
  metaEl.style.color = dailyChangeValue >= 0 ? "#62d99c" : "#f45b69";

  const { map: plMap, lastDate } = buildDailyPLMap(historyData);
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
  const anchorDate = lastDate || new Date();
  const monthsToShow = 3;
  const weekdayLabels = ["S", "M", "T", "W", "T", "F", "S"];

  for (let offset = monthsToShow - 1; offset >= 0; offset -= 1) {
    const monthDate = new Date(anchorDate.getFullYear(), anchorDate.getMonth() - offset, 1);
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
      cell.textContent = String(dayNum);
      if (Number.isFinite(pl)) {
        cell.style.backgroundColor = getCalendarCellColor(pl, maxAbs);
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
  }
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

  currentHistoryData = [];
  currentRows = rows;
  renderSummary(rows);
  renderDailyGainLoss(rows, currentHistoryData);
  renderTable(rows);
  renderTreemap(rows);
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
  currentHistoryData = historyData;
  renderHistory(historyData);
  renderDailyGainLoss(rows, historyData);
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

loadData().catch((err) => {
  alert(err.message);
});
