const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 5173;
const API_KEY = process.env.ALPACA_API_KEY;
const API_SECRET = process.env.ALPACA_API_SECRET;
const FEED = process.env.ALPACA_FEED || "iex";

if (!API_KEY || !API_SECRET) {
  console.warn(
    "Missing ALPACA_API_KEY or ALPACA_API_SECRET. Live prices will not work."
  );
}

const app = express();
app.use(express.static(__dirname));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/stream" });

function createAlpacaSocket() {
  const url = `wss://stream.data.alpaca.markets/v2/${FEED}`;
  return new WebSocket(url);
}

wss.on("connection", (client) => {
  let alpaca;
  let isAlive = true;

  client.on("message", (data) => {
    try {
      const payload = JSON.parse(data.toString());
      if (payload.type === "subscribe" && Array.isArray(payload.tickers)) {
        if (!API_KEY || !API_SECRET) {
          client.send(
            JSON.stringify({
              type: "error",
              message: "Server missing Alpaca API credentials.",
            })
          );
          return;
        }

        if (!alpaca || alpaca.readyState !== WebSocket.OPEN) {
          alpaca = createAlpacaSocket();

          alpaca.on("open", () => {
            alpaca.send(
              JSON.stringify({
                action: "auth",
                key: API_KEY,
                secret: API_SECRET,
              })
            );
          });

          alpaca.on("message", (raw) => {
            if (!isAlive) {
              return;
            }
            client.send(raw.toString());
          });

          alpaca.on("close", () => {
            if (isAlive) {
              client.send(
                JSON.stringify({
                  type: "error",
                  message: "Alpaca stream closed.",
                })
              );
            }
          });

          alpaca.on("error", (err) => {
            if (isAlive) {
              client.send(
                JSON.stringify({
                  type: "error",
                  message: err.message,
                })
              );
            }
          });
        }

        const tickers = payload.tickers.filter(Boolean);
        if (alpaca && alpaca.readyState === WebSocket.OPEN) {
          alpaca.send(
            JSON.stringify({
              action: "subscribe",
              quotes: tickers,
              trades: tickers,
            })
          );
        } else if (alpaca) {
          alpaca.once("open", () => {
            alpaca.send(
              JSON.stringify({
                action: "subscribe",
                quotes: tickers,
                trades: tickers,
              })
            );
          });
        }
      }
    } catch (err) {
      client.send(
        JSON.stringify({
          type: "error",
          message: "Invalid message from client.",
        })
      );
    }
  });

  client.on("close", () => {
    isAlive = false;
    if (alpaca) {
      alpaca.close();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Portfolio Pulse running on http://localhost:${PORT}`);
});
