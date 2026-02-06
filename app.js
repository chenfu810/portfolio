const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1YYl_8P_HehmfZzRGa7q-zWvNEiI22JrduPkTFXJ-1D4/export?format=csv&gid=0";

const HISTORY_CSV_URL = "";

const FMP_API_KEY = "9dS0j2jb35MZHfrSviWkA6WqOYRWOEWq";
const FMP_QUOTE_BASE = "https://financialmodelingprep.com/stable/batch-quote";
const LIVE_PRICE_REFRESH_MS = 20_000;

const SECTOR_MAP = {
  AAPL: "Consumer Tech",
  MSFT: "Enterprise Tech",
  NVDA: "Semiconductors",
  AMZN: "Consumer Tech",
  TSLA: "Automotive",
};

const SAMPLE_CSV = `ticket,shares,price (current),daily change %,value
NVDA,100,185,3%,18500
AAPL,50,190,1.2%,9500
MSFT,20,410,-0.8%,8200
AMZN,12,170,0.6%,2040
TSLA,8,245,-2.1%,1960`;

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
let sectorChart;
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

async function fetchSectorForTicker(ticker) {
  if (!FMP_API_KEY) {
    return SECTOR_MAP[ticker] || "Unknown";
  }

  const cacheKey = `sector_${ticker}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    return cached;
  }

  const url = `https://financialmodelingprep.com/api/v3/profile/${ticker}?apikey=${FMP_API_KEY}`;
  const response = await fetch(url);
  if (!response.ok) {
    return SECTOR_MAP[ticker] || "Unknown";
  }
  const data = await response.json();
  const sector = data?.[0]?.sector || SECTOR_MAP[ticker] || "Unknown";
  localStorage.setItem(cacheKey, sector);
  return sector;
}

async function buildSectorMap(rows) {
  const map = {};
  const tickers = rows.map((row) => row.ticker);
  const sectors = await Promise.all(tickers.map((ticker) => fetchSectorForTicker(ticker)));
  tickers.forEach((ticker, idx) => {
    map[ticker] = sectors[idx];
  });
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

  const sectorTotals = rows.reduce((acc, row) => {
    const sector = row.sector || SECTOR_MAP[row.ticker] || "Unknown";
    acc[sector] = (acc[sector] || 0) + row.value;
    return acc;
  }, {});

  if (sectorChart) {
    sectorChart.destroy();
  }

  sectorChart = new Chart(document.getElementById("sectorChart"), {
    type: "polarArea",
    data: {
      labels: Object.keys(sectorTotals),
      datasets: [
        {
          data: Object.values(sectorTotals),
          backgroundColor: Object.keys(sectorTotals).map(
            (_, idx) => palette[(idx + 2) % palette.length]
          ),
          borderWidth: 0,
        },
      ],
    },
    options: {
      plugins: {
        legend: { labels: { color: "#e0e6f3" } },
      },
      scales: {
        r: {
          ticks: { color: "#e0e6f3" },
          grid: { color: "rgba(255,255,255,0.08)" },
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
    tr.innerHTML = `
      <td>${row.ticker}</td>
      <td>${row.shares.toLocaleString()}</td>
      <td>${fmtCurrency.format(row.price)}</td>
      <td class="${row.dailyPct >= 0 ? "pos" : "neg"}">
        ${fmtPercent.format(row.dailyPct)}
      </td>
      <td>${fmtCurrency.format(row.value)}</td>
    `;
    tbody.appendChild(tr);
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
    return;
  }
  const symbols = rows.map((row) => row.ticker).join(",");
  if (!symbols) {
    return;
  }
  const url = `${FMP_QUOTE_BASE}?symbols=${encodeURIComponent(
    symbols
  )}&apikey=${encodeURIComponent(FMP_API_KEY)}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("Failed to fetch live prices.");
  }
  const data = await response.json();
  if (!Array.isArray(data)) {
    return;
  }
  data.forEach((item) => {
    if (item.symbol && item.price) {
      applyLivePrice(item.symbol, Number(item.price));
    }
  });
}

function startLivePrices(rows) {
  liveRows = rows;
  fetchLivePricesFmp(rows).catch((err) => {
    console.warn(err.message);
  });
  setInterval(() => {
    fetchLivePricesFmp(rows).catch((err) => {
      console.warn(err.message);
    });
  }, LIVE_PRICE_REFRESH_MS);
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

  rows.sort((a, b) => b.value - a.value);

  const sectorMap = await buildSectorMap(rows);
  rows.forEach((row) => {
    row.sector = sectorMap[row.ticker] || SECTOR_MAP[row.ticker] || "Unknown";
  });

  renderSummary(rows);
  renderTable(rows);
  buildCharts(rows);
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
}

document.getElementById("refreshBtn").addEventListener("click", () => {
  loadData().catch((err) => {
    alert(err.message);
  });
});

loadData().catch((err) => {
  alert(err.message);
});
