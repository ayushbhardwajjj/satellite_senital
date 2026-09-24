const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();

/*
 * Satellite TLE acquisition
 *
 * Strategy:
 * 1. Try CelesTrak directly.
 * 2. If CelesTrak is unavailable or returns too few objects,
 *    use the public TLE mirror.
 * 3. Fetch multiple mirror pages sequentially.
 * 4. Deduplicate by NORAD ID.
 * 5. Reject stale / malformed TLEs.
 * 6. Never create fake satellite data.
 */

const CELESTRAK_BASE_URL = "https://celestrak.org/NORAD/elements/gp.php";

const CELESTRAK_GROUPS = [
  "stations",
  "visual",
  "weather",
  "gps-ops",
  "galileo",
];

const MIRROR_BASE_URL = "https://tle.ivanstanojevic.me/api/tle/";

const MIRROR_PAGE_SIZE = 100;
const MIRROR_MAX_PAGES = 6;

const MIN_OBJECTS = 150;

/*
 * Keep TLE data reasonably fresh.
 * TLEs older than this are not used for the live tracking set.
 */
const MAX_TLE_AGE_DAYS = 30;

const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

const CACHE_DIR = path.join(__dirname, "..", "data");
const CACHE_FILE = path.join(CACHE_DIR, "tle-cache.v3.json");

let tleCache = null;
let refreshPromise = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();

  const timeoutId = setTimeout(() => {
    controller.abort();
  }, FETCH_TIMEOUT_MS);

  return fetch(url, {
    ...options,
    signal: controller.signal,
  }).finally(() => {
    clearTimeout(timeoutId);
  });
}

/* ---------------------------------------------------------
 * TLE validation
 * --------------------------------------------------------- */

function checksumValid(line) {
  if (!line || line.length < 69) return false;

  let sum = 0;

  for (let i = 0; i < 68; i += 1) {
    const char = line[i];

    if (char >= "0" && char <= "9") {
      sum += Number(char);
    } else if (char === "-") {
      sum += 1;
    }
  }

  const checksum = Number(line[68]);

  return Number.isInteger(checksum) && sum % 10 === checksum;
}

function extractNoradId(line1) {
  if (!line1 || !line1.startsWith("1 ")) return null;

  const match = line1.match(/^1\s+(\d{1,6})[A-Z]?/);

  if (!match) return null;

  const noradId = Number(match[1]);

  return Number.isInteger(noradId) ? noradId : null;
}

function parseTleEpoch(line1) {
  if (!line1 || line1.length < 32) return null;

  const yearText = line1.slice(18, 20);
  const dayText = line1.slice(20, 32);

  const year = Number(yearText);
  const day = Number(dayText);

  if (!Number.isInteger(year) || !Number.isFinite(day)) {
    return null;
  }

  /*
   * TLE convention:
   * 00-56 => 2000-2056
   * 57-99 => 1957-1999
   */
  const fullYear = year < 57 ? 2000 + year : 1900 + year;

  const start = Date.UTC(fullYear, 0, 1);

  return new Date(start + (day - 1) * 24 * 60 * 60 * 1000);
}

function isFreshTle(line1, maxAgeDays = MAX_TLE_AGE_DAYS) {
  const epoch = parseTleEpoch(line1);

  if (!epoch || Number.isNaN(epoch.getTime())) {
    return false;
  }

  const ageMs = Date.now() - epoch.getTime();

  /*
   * Also reject future epochs that are clearly invalid.
   */
  if (ageMs < -24 * 60 * 60 * 1000) {
    return false;
  }

  return ageMs <= maxAgeDays * 24 * 60 * 60 * 1000;
}

function normalizeObject(object) {
  if (!object) return null;

  const name = String(object.name || "").trim();
  const line1 = String(object.line1 || "").trim();
  const line2 = String(object.line2 || "").trim();

  if (!name || !line1 || !line2) {
    return null;
  }

  if (!line1.startsWith("1 ") || !line2.startsWith("2 ")) {
    return null;
  }

  const noradId = Number.isInteger(object.noradId)
    ? object.noradId
    : extractNoradId(line1);

  if (!noradId) {
    return null;
  }

  /*
   * TLE legacy format has a practical catalog-number limit.
   */
  if (noradId > 999999) {
    return null;
  }

  if (!checksumValid(line1) || !checksumValid(line2)) {
    return null;
  }

  const epoch = parseTleEpoch(line1);

  if (!epoch) {
    return null;
  }

  return {
    name,
    noradId,
    line1,
    line2,
    tleDate: epoch.toISOString(),
  };
}

/* ---------------------------------------------------------
 * CelesTrak parser
 * --------------------------------------------------------- */

function parseTleText(rawText) {
  const lines = String(rawText)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const objects = [];

  for (let i = 0; i < lines.length; i += 1) {
    const name = lines[i];
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];

    if (line1 && line2 && line1.startsWith("1 ") && line2.startsWith("2 ")) {
      const object = normalizeObject({
        name,
        line1,
        line2,
      });

      if (object) {
        objects.push(object);
      }

      i += 2;
    }
  }

  return objects;
}

/* ---------------------------------------------------------
 * CelesTrak
 * --------------------------------------------------------- */

async function fetchCelestrakGroup(group) {
  const url =
    `${CELESTRAK_BASE_URL}` +
    `?GROUP=${encodeURIComponent(group)}` +
    `&FORMAT=tle`;

  const response = await fetchWithTimeout(url, {
    headers: {
      Accept: "text/plain",
      "User-Agent": "SatelliteTracker/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(
      `CelesTrak group "${group}" returned HTTP ${response.status}`,
    );
  }

  const text = await response.text();

  const objects = parseTleText(text);

  if (objects.length === 0) {
    throw new Error(`CelesTrak group "${group}" returned no valid TLEs`);
  }

  return objects;
}

async function fetchFromCelestrak() {
  const byNorad = new Map();
  const groups = [];
  const errors = [];

  for (const group of CELESTRAK_GROUPS) {
    try {
      const objects = await fetchCelestrakGroup(group);

      let accepted = 0;

      for (const object of objects) {
        if (!isFreshTle(object.line1)) {
          continue;
        }

        if (!byNorad.has(object.noradId)) {
          byNorad.set(object.noradId, object);
          accepted += 1;
        }
      }

      groups.push({
        group,
        fetched: objects.length,
        accepted,
      });

      /*
       * Once we have enough objects, there is no need to
       * hammer the provider with more requests.
       */
      if (byNorad.size >= MIN_OBJECTS) {
        break;
      }
    } catch (error) {
      errors.push({
        group,
        error: getErrorMessage(error),
      });
    }
  }

  return {
    objects: [...byNorad.values()],
    groups,
    errors,
  };
}

/* ---------------------------------------------------------
 * Mirror API
 * --------------------------------------------------------- */

async function fetchMirrorPage(page) {
  const url =
    `${MIRROR_BASE_URL}` + `?page=${page}` + `&page-size=${MIRROR_PAGE_SIZE}`;

  const response = await fetchWithTimeout(url, {
    headers: {
      Accept: "application/ld+json, application/json",
      "User-Agent": "SatelliteTracker/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`TLE mirror page ${page} returned HTTP ${response.status}`);
  }

  const data = await response.json();

  if (!Array.isArray(data.member)) {
    throw new Error(`TLE mirror page ${page} returned no member array`);
  }

  return data;
}

function normalizeMirrorObject(member) {
  if (!member) return null;

  return normalizeObject({
    name: member.name,
    noradId: Number(member.satelliteId),
    line1: member.line1,
    line2: member.line2,
  });
}

async function fetchFromMirror() {
  const byNorad = new Map();

  const pages = [];
  const errors = [];

  for (let page = 1; page <= MIRROR_MAX_PAGES; page += 1) {
    try {
      const data = await fetchMirrorPage(page);

      let accepted = 0;

      for (const member of data.member) {
        const object = normalizeMirrorObject(member);

        if (!object) {
          continue;
        }

        if (!isFreshTle(object.line1)) {
          continue;
        }

        if (!byNorad.has(object.noradId)) {
          byNorad.set(object.noradId, object);
          accepted += 1;
        }
      }

      pages.push({
        page,
        fetched: data.member.length,
        accepted,
      });

      /*
       * Stop as soon as we have enough fresh unique TLEs.
       */
      if (byNorad.size >= MIN_OBJECTS) {
        break;
      }

      /*
       * The API exposes totalItems. If we reached the last
       * available page, stop instead of making useless calls.
       */
      if (
        Number.isFinite(data.totalItems) &&
        page * MIRROR_PAGE_SIZE >= data.totalItems
      ) {
        break;
      }

      /*
       * Small delay prevents rapid sequential requests from
       * triggering provider resource limits.
       */
      await sleep(250);
    } catch (error) {
      errors.push({
        page,
        error: getErrorMessage(error),
      });

      /*
       * Do not immediately hammer the provider after a
       * resource-limit / transient failure.
       */
      await sleep(750);
    }
  }

  return {
    objects: [...byNorad.values()],
    pages,
    errors,
  };
}

/* ---------------------------------------------------------
 * Disk cache
 * --------------------------------------------------------- */

function loadDiskCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) {
      return null;
    }

    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    if (
      !parsed ||
      !Array.isArray(parsed.objects) ||
      parsed.objects.length === 0
    ) {
      return null;
    }

    return parsed;
  } catch (error) {
    console.warn("Unable to read TLE disk cache:", getErrorMessage(error));

    return null;
  }
}

function saveDiskCache(payload) {
  try {
    fs.mkdirSync(CACHE_DIR, {
      recursive: true,
    });

    fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2), "utf8");
  } catch (error) {
    console.warn("Unable to save TLE disk cache:", getErrorMessage(error));
  }
}

/* ---------------------------------------------------------
 * Main acquisition
 * --------------------------------------------------------- */

async function refreshTles() {
  const startedAt = Date.now();

  let primary = null;
  let mirror = null;

  try {
    primary = await fetchFromCelestrak();
  } catch (error) {
    primary = {
      objects: [],
      groups: [],
      errors: [
        {
          error: getErrorMessage(error),
        },
      ],
    };
  }

  let objects = primary.objects;

  /*
   * If CelesTrak produced fewer than the target, supplement
   * from the mirror.
   */
  if (objects.length < MIN_OBJECTS) {
    try {
      mirror = await fetchFromMirror();

      const byNorad = new Map(
        objects.map((object) => [object.noradId, object]),
      );

      for (const object of mirror.objects) {
        if (!byNorad.has(object.noradId)) {
          byNorad.set(object.noradId, object);
        }

        if (byNorad.size >= MIN_OBJECTS) {
          break;
        }
      }

      objects = [...byNorad.values()];
    } catch (error) {
      mirror = {
        objects: [],
        pages: [],
        errors: [
          {
            error: getErrorMessage(error),
          },
        ],
      };
    }
  }

  /*
   * Final safety validation.
   */
  objects = objects
    .map(normalizeObject)
    .filter(Boolean)
    .filter((object) => isFreshTle(object.line1));

  /*
   * Deduplicate one final time.
   */
  const unique = new Map();

  for (const object of objects) {
    if (!unique.has(object.noradId)) {
      unique.set(object.noradId, object);
    }
  }

  objects = [...unique.values()];

  if (objects.length === 0) {
    throw new Error("No usable fresh TLEs were obtained from any provider");
  }

  const now = new Date().toISOString();

  const payload = {
    objects,
    count: objects.length,
    source:
      primary.objects.length >= MIN_OBJECTS
        ? "CelesTrak"
        : mirror && mirror.objects.length > 0
          ? "CelesTrak + TLE mirror"
          : "CelesTrak",
    fetchedAt: now,
    meta: {
      target: MIN_OBJECTS,
      maxTleAgeDays: MAX_TLE_AGE_DAYS,
      groups: primary.groups,
      primaryErrors: primary.errors,
      mirrorPages: mirror?.pages || [],
      mirrorErrors: mirror?.errors || [],
      refreshedInMs: Date.now() - startedAt,
    },
  };

  /*
   * Only replace the in-memory cache after a successful
   * non-empty refresh.
   */
  tleCache = {
    ...payload,
    fetchedAtMs: Date.now(),
  };

  saveDiskCache(payload);

  return tleCache;
}

function isMemoryCacheFresh() {
  return (
    tleCache &&
    Array.isArray(tleCache.objects) &&
    tleCache.objects.length > 0 &&
    Date.now() - tleCache.fetchedAtMs < CACHE_TTL_MS
  );
}

async function getTleObjects() {
  if (isMemoryCacheFresh()) {
    return tleCache.objects;
  }

  /*
   * Prevent /api/tle, /api/positions, /api/risk and
   * /api/snapshot from starting several provider fetches
   * simultaneously.
   */
  if (!refreshPromise) {
    refreshPromise = refreshTles().finally(() => {
      refreshPromise = null;
    });
  }

  try {
    const result = await refreshPromise;
    return result.objects;
  } catch (error) {
    /*
     * If the live provider fails, use a previously saved
     * disk cache rather than inventing data.
     */
    const diskCache = loadDiskCache();

    if (diskCache?.objects?.length) {
      console.warn(
        "Live TLE refresh failed; serving disk cache:",
        getErrorMessage(error),
      );

      tleCache = {
        ...diskCache,
        fetchedAtMs: Date.now(),
      };

      return diskCache.objects;
    }

    throw error;
  }
}

/* ---------------------------------------------------------
 * API
 * --------------------------------------------------------- */

router.get("/", async (req, res) => {
  try {
    const objects = await getTleObjects();

    return res.json({
      objects,
      count: objects.length,
      source: tleCache?.source || "unknown",
      fetchedAt: tleCache?.fetchedAt || null,
      meta: tleCache?.meta || {
        target: MIN_OBJECTS,
        maxTleAgeDays: MAX_TLE_AGE_DAYS,
      },
    });
  } catch (error) {
    console.error("Failed to obtain TLE data:", getErrorMessage(error));

    return res.status(503).json({
      error: "Unable to obtain usable TLE data",
      message: getErrorMessage(error),
    });
  }
});

module.exports = router;
module.exports.getTleObjects = getTleObjects;
