const express = require("express");

const { getCurrentPositions, EARTH_RADIUS_KM } = require("./positions");

const router = express.Router();

const CONJUNCTION_THRESHOLD_KM =
  Number(process.env.CONJUNCTION_THRESHOLD_KM) > 0
    ? Number(process.env.CONJUNCTION_THRESHOLD_KM)
    : 5;

/*
  Known close-formation pair:
  TerraSAR-X (NORAD 31698) and TanDEM-X (NORAD 36605).

  These two spacecraft are a controlled formation pair, so their
  very small separation must not be treated as a generic collision
  conjunction.
*/
const KNOWN_FORMATION_PAIRS = new Set(["31698:36605"]);

function pairKey(a, b) {
  const first = Math.min(Number(a), Number(b));
  const second = Math.max(Number(a), Number(b));

  return `${first}:${second}`;
}

function isKnownFormationPair(a, b) {
  return KNOWN_FORMATION_PAIRS.has(pairKey(a.noradId, b.noradId));
}

function isCoLocated(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;

  const squared = dx * dx + dy * dy + dz * dz;

  // 0.01 Earth radii ≈ 64 m.
  // Prevent exact/near-identical propagated states from
  // creating artificial collision alerts.
  return squared < (0.01 / EARTH_RADIUS_KM) ** 2;
}

function isExcludedPair(a, b) {
  return isKnownFormationPair(a, b) || isCoLocated(a, b);
}

function riskLevelFromRank(rank, total) {
  if (total <= 1) {
    return "very-low";
  }

  const percentile = rank / (total - 1);

  if (percentile <= 0.05) return "high";
  if (percentile <= 0.15) return "medium";
  if (percentile <= 0.4) return "low";

  return "very-low";
}

function scoreFromRank(rank, total) {
  if (total <= 1) {
    return 1;
  }

  const percentile = rank / (total - 1);
  const score = Math.round(100 - percentile * 99);

  return Math.max(1, Math.min(100, score));
}

function analyse(input) {
  const positions = Array.isArray(input)
    ? input
    : input && Array.isArray(input.positions)
      ? input.positions
      : null;

  if (!positions) {
    throw new TypeError(
      "Risk engine expected an array of propagated positions",
    );
  }

  const total = positions.length;

  const nearestIndex = new Int32Array(total).fill(-1);

  const nearestSquared = new Float64Array(total).fill(Infinity);

  const thresholdSquared = (CONJUNCTION_THRESHOLD_KM / EARTH_RADIUS_KM) ** 2;

  const closePairs = [];

  /*
    Compare every pair.

    This gives:
    - nearest neighbour
    - nearest distance
    - conjunction candidates
  */
  for (let i = 0; i < total; i += 1) {
    const a = positions[i];

    for (let j = i + 1; j < total; j += 1) {
      const b = positions[j];

      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dz = a.z - b.z;

      const squared = dx * dx + dy * dy + dz * dz;

      if (isExcludedPair(a, b)) {
        continue;
      }

      if (squared < nearestSquared[i]) {
        nearestSquared[i] = squared;
        nearestIndex[i] = j;
      }

      if (squared < nearestSquared[j]) {
        nearestSquared[j] = squared;
        nearestIndex[j] = i;
      }

      if (squared < thresholdSquared) {
        closePairs.push({
          i,
          j,
          squared,
        });
      }
    }
  }

  const order = positions
    .map((_, index) => index)
    .sort(
      (a, b) =>
        nearestSquared[a] - nearestSquared[b] ||
        positions[a].noradId - positions[b].noradId,
    );

  const rankByIndex = new Array(total);

  order.forEach((index, rank) => {
    rankByIndex[index] = rank;
  });

  const satellites = positions.map((position, index) => {
    const neighbour =
      nearestIndex[index] >= 0 ? positions[nearestIndex[index]] : null;

    const rank = rankByIndex[index];

    return {
      noradId: position.noradId,

      name: position.name,

      riskLevel: neighbour ? riskLevelFromRank(rank, total) : "very-low",

      riskScore: neighbour ? scoreFromRank(rank, total) : 1,

      rank: rank + 1,

      nearestNoradId: neighbour ? neighbour.noradId : null,

      nearestObject: neighbour ? neighbour.name : null,

      nearestDistanceKm: neighbour
        ? Number(
            (Math.sqrt(nearestSquared[index]) * EARTH_RADIUS_KM).toFixed(3),
          )
        : null,
    };
  });

  const conjunctions = closePairs
    .sort((left, right) => left.squared - right.squared)
    .map(({ i, j, squared }) => ({
      noradIdA: positions[i].noradId,
      noradIdB: positions[j].noradId,

      objectA: positions[i].name,
      objectB: positions[j].name,

      distanceKm: Number((Math.sqrt(squared) * EARTH_RADIUS_KM).toFixed(3)),

      riskLevel: "high",
    }));

  const count = (level) =>
    satellites.filter((satellite) => satellite.riskLevel === level).length;

  const byRank = [...satellites].sort((a, b) => a.rank - b.rank);

  const closestSatellite = byRank.find(
    (satellite) => satellite.nearestDistanceKm !== null,
  );

  return {
    satellites,

    conjunctions,

    summary: {
      total,

      high: count("high"),
      medium: count("medium"),
      low: count("low"),
      veryLow: count("very-low"),

      conjunctionCount: conjunctions.length,

      closest: closestSatellite
        ? {
            noradId: closestSatellite.noradId,

            name: closestSatellite.name,

            nearestNoradId: closestSatellite.nearestNoradId,

            nearestObject: closestSatellite.nearestObject,

            distanceKm: closestSatellite.nearestDistanceKm,
          }
        : null,

      highestRisk: closestSatellite
        ? {
            noradId: closestSatellite.noradId,

            name: closestSatellite.name,

            riskScore: closestSatellite.riskScore,
          }
        : null,
    },

    riskModel: {
      type: "relative-proximity-rank",

      isCollisionProbability: false,

      description:
        "Objects are ranked by nearest-neighbour distance within the tracked set. This is a screening rank, not a probability of collision.",

      levels: "closest 5% high, next 10% medium, next 25% low, rest very-low",

      conjunctionThresholdKm: CONJUNCTION_THRESHOLD_KM,

      excludedFormationPairs: [
        {
          noradIdA: 31698,
          noradIdB: 36605,
          reason: "controlled close formation",
        },
      ],

      excludedCoLocatedPairs: true,
    },
  };
}

const riskBySnapshot = new WeakMap();

function getRisk(snapshotOrPositions) {
  if (Array.isArray(snapshotOrPositions)) {
    return analyse(snapshotOrPositions);
  }

  if (!snapshotOrPositions || !Array.isArray(snapshotOrPositions.positions)) {
    throw new TypeError(
      "getRisk expected a propagated snapshot containing positions[]",
    );
  }

  const snapshot = snapshotOrPositions;

  let risk = riskBySnapshot.get(snapshot);

  if (!risk) {
    risk = analyse(snapshot.positions);

    riskBySnapshot.set(snapshot, risk);
  }

  return risk;
}

router.get("/", async (req, res) => {
  try {
    const snapshot = await getCurrentPositions();

    const risk = getRisk(snapshot);

    return res.json({
      snapshotId: snapshot.snapshotId,

      calculatedAt: snapshot.calculatedAt,

      count: risk.satellites.length,

      satellites: risk.satellites,

      conjunctions: risk.conjunctions,

      summary: risk.summary,

      riskModel: risk.riskModel,
    });
  } catch (error) {
    console.error(
      "[risk] Failed to compute satellite risk:",
      error instanceof Error ? error.message : error,
    );

    return res.status(503).json({
      error: "Unable to compute satellite risk",

      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

module.exports = router;

module.exports.getRisk = getRisk;

module.exports.CONJUNCTION_THRESHOLD_KM = CONJUNCTION_THRESHOLD_KM;
