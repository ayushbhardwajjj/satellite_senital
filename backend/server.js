require("dotenv").config();

const express = require("express");
const cors = require("cors");

const tleRoutes = require("./routes/tle");
const positionsRoutes = require("./routes/positions");
const riskRoutes = require("./routes/risk");
const snapshotRoutes = require("./routes/snapshot");

const app = express();

app.use(express.json());

app.use(
  cors({
    origin: /^http:\/\/(localhost|127\.0\.0\.1):\d+$/,
  }),
);

app.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

/*
 * Basic health check.
 * Keep this independent from tle.js because the current
 * tle.js does not export getTleStatus().
 */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.use("/api/tle", tleRoutes);
app.use("/api/positions", positionsRoutes);
app.use("/api/risk", riskRoutes);
app.use("/api/snapshot", snapshotRoutes);

app.use("/api", (req, res) => {
  res.status(404).json({
    error: "Not found",
    message: `${req.originalUrl} does not exist`,
  });
});

app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);

  res.status(500).json({
    error: "Internal server error",
    message: error instanceof Error ? error.message : "Unknown error",
  });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
