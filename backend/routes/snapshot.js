const express = require("express");

const { getCurrentPositions } = require("./positions");
const { getRisk } = require("./risk");

const router = express.Router();

/*
  One snapshot contains:
  - one propagation instant
  - one TLE state
  - all positions
  - all risk results
  - all conjunctions

  Frontend uses this single response so the globe
  and telemetry never disagree.
*/

router.get("/", async (req, res) => {
  try {
    const snapshot = await getCurrentPositions();

    const risk = getRisk(snapshot);

    return res.json({
      snapshotId: snapshot.snapshotId,

      calculatedAt: snapshot.calculatedAt,

      tle: snapshot.tle,

      propagation: snapshot.propagation,

      positions: snapshot.positions,

      satellites: risk.satellites,

      conjunctions: risk.conjunctions,

      summary: risk.summary,

      riskModel: risk.riskModel,
    });
  } catch (error) {
    console.error(
      "[snapshot] Failed to build snapshot:",
      error instanceof Error ? error.message : error,
    );

    return res.status(503).json({
      error: "Unable to build satellite snapshot",

      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

module.exports = router;
