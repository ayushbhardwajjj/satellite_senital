const express = require("express");
const satellite = require("satellite.js");

const { getTleObjects } = require("./tle");

const router = express.Router();

const EARTH_RADIUS_KM = satellite.constants.earthRadius;
const MS_PER_DAY = 86_400_000;

const MAX_TLE_AGE_DAYS =
  Number(process.env.MAX_TLE_AGE_DAYS) > 0
    ? Number(process.env.MAX_TLE_AGE_DAYS)
    : 30;

const SNAPSHOT_MAX_AGE_MS = 1000;
const MAX_REPORTED_FAILURES = 50;

const SGP4_ERRORS = {
  1: "mean-eccentricity-out-of-range",
  2: "mean-motion-below-zero",
  3: "perturbed-eccentricity-out-of-range",
  4: "semi-latus-rectum-below-zero",
  6: "decayed",
};

const satrecCache = new Map();

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function getSatrec(object) {
  const key = `${object.line1}\n${object.line2}`;

  const cached = satrecCache.get(object.noradId);

  if (cached && cached.key === key) {
    return cached.satrec;
  }

  const satrec = satellite.twoline2satrec(object.line1, object.line2);

  satrecCache.set(object.noradId, {
    key,
    satrec,
  });

  return satrec;
}

function getTleEpoch(object) {
  if (object.tleDate) {
    const date = new Date(object.tleDate);

    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  const line1 = object.line1;

  if (!line1 || line1.length < 32) {
    return null;
  }

  const year = Number(line1.slice(18, 20));
  const day = Number(line1.slice(20, 32));

  if (!Number.isInteger(year) || !Number.isFinite(day)) {
    return null;
  }

  const fullYear = year < 57 ? 2000 + year : 1900 + year;

  return new Date(Date.UTC(fullYear, 0, 1) + (day - 1) * MS_PER_DAY);
}

function propagateOne(object, when, gmst) {
  const epoch = getTleEpoch(object);

  if (!epoch) {
    return {
      failure: "invalid-tle-epoch",
    };
  }

  const tleAgeDays = (when.getTime() - epoch.getTime()) / MS_PER_DAY;

  if (tleAgeDays > MAX_TLE_AGE_DAYS) {
    return {
      failure: "tle-too-old",
    };
  }

  let satrec;

  try {
    satrec = getSatrec(object);
  } catch {
    return {
      failure: "tle-parse-error",
    };
  }

  if (!satrec) {
    return {
      failure: "tle-parse-error",
    };
  }

  let result;

  try {
    result = satellite.propagate(satrec, when, {
      communityDecayCheckEnabled: true,
    });
  } catch (error) {
    return {
      failure:
        error instanceof Error
          ? `propagation-exception: ${error.message}`
          : "propagation-exception",
    };
  }

  if (!result || !result.position) {
    return {
      failure: SGP4_ERRORS[satrec.error] || "propagation-failed",
    };
  }

  const position = result.position;

  if (
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    !Number.isFinite(position.z)
  ) {
    return {
      failure: "non-finite-position",
    };
  }

  const distanceFromEarthCenter = Math.hypot(
    position.x,
    position.y,
    position.z,
  );

  if (distanceFromEarthCenter < EARTH_RADIUS_KM) {
    return {
      failure: "position-below-earth-surface",
    };
  }

  const ecef = satellite.eciToEcf(position, gmst);

  const geodetic = satellite.eciToGeodetic(position, gmst);

  if (!ecef || !geodetic) {
    return {
      failure: "coordinate-conversion-failed",
    };
  }

  if (
    !Number.isFinite(ecef.x) ||
    !Number.isFinite(ecef.y) ||
    !Number.isFinite(ecef.z)
  ) {
    return {
      failure: "non-finite-ecef",
    };
  }

  return {
    point: {
      noradId: object.noradId,
      name: object.name,

      /*
       * Earth-fixed coordinates normalized by Earth radius.
       * These are the coordinates consumed by Three.js.
       */
      x: round(ecef.x / EARTH_RADIUS_KM, 6),

      y: round(ecef.z / EARTH_RADIUS_KM, 6),

      z: round(-ecef.y / EARTH_RADIUS_KM, 6),

      altitudeKm: Number.isFinite(geodetic.height)
        ? round(geodetic.height, 1)
        : null,

      tleEpoch: epoch.toISOString(),
      tleAgeDays: round(tleAgeDays, 2),
    },
  };
}

function buildTleMeta(objects) {
  if (!objects.length) {
    return {
      count: 0,
    };
  }

  const ages = objects
    .map(getTleEpoch)
    .filter(Boolean)
    .map((epoch) => (Date.now() - epoch.getTime()) / MS_PER_DAY)
    .filter(Number.isFinite);

  return {
    count: objects.length,
    maxAgeDays: MAX_TLE_AGE_DAYS,
    newestEpoch:
      ages.length > 0
        ? new Date(Date.now() - Math.min(...ages) * MS_PER_DAY).toISOString()
        : null,
    oldestEpoch:
      ages.length > 0
        ? new Date(Date.now() - Math.max(...ages) * MS_PER_DAY).toISOString()
        : null,
    fetchedAt: null,
    source: "live TLE provider",
  };
}

async function computePositions() {
  const objects = await getTleObjects();

  const when = new Date();
  const gmst = satellite.gstime(when);

  const positions = [];
  const failures = [];
  const byReason = {};
  const seen = new Set();

  for (const object of objects) {
    if (!object?.noradId) {
      continue;
    }

    seen.add(object.noradId);

    let result;

    try {
      result = propagateOne(object, when, gmst);
    } catch (error) {
      result = {
        failure:
          error instanceof Error ? `exception: ${error.message}` : "exception",
      };
    }

    if (result.point) {
      positions.push(result.point);
    } else {
      byReason[result.failure] = (byReason[result.failure] || 0) + 1;

      failures.push({
        noradId: object.noradId,
        name: object.name,
        reason: result.failure,
      });
    }
  }

  /*
   * Remove cached satrecs for satellites that no longer
   * exist in the current TLE dataset.
   */
  for (const noradId of satrecCache.keys()) {
    if (!seen.has(noradId)) {
      satrecCache.delete(noradId);
    }
  }

  console.log(
    `[positions] ${positions.length}/${objects.length} TLEs propagated`,
    failures.length ? byReason : "",
  );

  return {
    snapshotId: when.toISOString(),
    calculatedAt: when.toISOString(),

    tle: {
      ...buildTleMeta(objects),
    },

    positions,

    propagation: {
      attempted: objects.length,
      succeeded: positions.length,
      failed: failures.length,
      byReason,
      failures: failures.slice(0, MAX_REPORTED_FAILURES),
    },
  };
}

let snapshotCache = null;
let inFlight = null;

function getCurrentPositions() {
  if (snapshotCache && Date.now() - snapshotCache.at < SNAPSHOT_MAX_AGE_MS) {
    return Promise.resolve(snapshotCache.snapshot);
  }

  /*
   * Prevent multiple simultaneous requests from
   * calculating different datasets.
   */
  if (inFlight) {
    return inFlight;
  }

  inFlight = computePositions()
    .then((snapshot) => {
      snapshotCache = {
        at: Date.now(),
        snapshot,
      };

      return snapshot;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

router.get("/", async (req, res) => {
  try {
    const snapshot = await getCurrentPositions();

    return res.json({
      snapshotId: snapshot.snapshotId,
      calculatedAt: snapshot.calculatedAt,
      count: snapshot.positions.length,
      positions: snapshot.positions,
      propagation: snapshot.propagation,
      tle: snapshot.tle,
    });
  } catch (error) {
    console.error(
      "[positions] Failed to compute positions:",
      error instanceof Error ? error.message : error,
    );

    return res.status(503).json({
      error: "Unable to compute satellite positions",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

module.exports = router;
module.exports.getCurrentPositions = getCurrentPositions;
module.exports.EARTH_RADIUS_KM = EARTH_RADIUS_KM;
