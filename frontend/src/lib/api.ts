const API_BASE_URL: string =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:5000";

const REQUEST_TIMEOUT_MS = 45_000;

export type TleStatus = {
  loaded: boolean;
  count: number;
  fetchedAt: string | null;
  stale: boolean;
  refreshing: boolean;
  lastError: string | null;
};

export type HealthResponse = {
  status: "ok" | "degraded" | "starting" | "unavailable" | string;

  uptimeSeconds?: number;
  tle?: TleStatus;
};

export type TleGroupReport = {
  provider: string;
  group: string;

  status: "ok" | "error" | "skipped";

  received?: number;
  accepted?: number;
  duplicates?: number;
  rejected?: number;
  error?: string;
};

export type TleMeta = {
  source: string;
  count: number;
  fetchedAt: string;
  ageMinutes: number;
  ttlMinutes: number;
  stale: boolean;
  refreshing: boolean;
  lastAttemptAt: string | null;
  lastError: string | null;

  target?: { minObjects: number; met: boolean };

  groups: TleGroupReport[];

  rejected: Record<string, number>;

  epochRange: {
    oldest: string;
    newest: string;
  };

  note: string;
};

export type SatellitePosition = {
  noradId: number;
  name: string;

  x: number;
  y: number;
  z: number;

  altitudeKm: number;

  tleEpoch: string;
  tleAgeDays: number;
};

export type Conjunction = {
  noradIdA: number;
  noradIdB: number;

  objectA: string;
  objectB: string;

  distanceKm: number;

  riskLevel: string;
};

export type SatelliteRisk = {
  noradId: number;
  name: string;

  riskLevel: string;
  riskScore: number;

  rank: number;

  nearestNoradId: number | null;

  nearestObject: string | null;

  nearestDistanceKm: number | null;
};

export type RiskSummary = {
  total: number;

  high: number;
  medium: number;
  low: number;
  veryLow: number;

  conjunctionCount: number;

  closest: {
    noradId: number;
    name: string;

    nearestNoradId: number | null;

    nearestObject: string | null;

    distanceKm: number | null;
  } | null;

  highestRisk: {
    noradId: number;
    name: string;
    riskScore: number;
  } | null;
};

export type RiskModel = {
  type: string;

  isCollisionProbability: boolean;

  description: string;

  levels: string;

  conjunctionThresholdKm: number;
};

export type PropagationReport = {
  attempted: number;
  succeeded: number;
  failed: number;

  byReason: Record<string, number>;

  failures: {
    noradId: number;
    name: string;
    reason: string;
  }[];
};

export type Snapshot = {
  snapshotId: string;

  calculatedAt: string;

  tle: TleMeta;

  propagation: PropagationReport;

  positions: SatellitePosition[];

  satellites: SatelliteRisk[];

  conjunctions: Conjunction[];

  summary: RiskSummary;

  riskModel: RiskModel;
};

export type PositionsResponse = {
  snapshotId: string;
  calculatedAt: string;

  count: number;

  positions: SatellitePosition[];

  propagation: PropagationReport;

  tle: TleMeta;
};

export type RiskResponse = {
  snapshotId: string;
  calculatedAt: string;

  count: number;

  satellites: SatelliteRisk[];

  conjunctions: Conjunction[];

  summary: RiskSummary;

  riskModel: RiskModel;
};

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();

  let timedOut = false;

  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  const forwardAbort = () => controller.abort();

  signal?.addEventListener("abort", forwardAbort, { once: true });

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      signal: controller.signal,

      cache: "no-store",
    });

    if (!response.ok) {
      let detail = "";

      try {
        const body = (await response.json()) as {
          message?: string;
          error?: string;
        };

        detail = body.message ?? body.error ?? "";
      } catch {
        // No JSON response.
      }

      throw new Error(
        `${path} failed (HTTP ${response.status})` +
          (detail ? `: ${detail}` : ""),
      );
    }

    return (await response.json()) as T;
  } catch (error) {
    if (timedOut) {
      throw new Error(`${path} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }

    if (error instanceof TypeError) {
      throw new Error(
        `Cannot reach the backend at ${API_BASE_URL}. Is it running?`,
      );
    }

    throw error;
  } finally {
    window.clearTimeout(timeoutId);

    signal?.removeEventListener("abort", forwardAbort);
  }
}

export function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return request<HealthResponse>("/health", signal);
}

export function getTles(signal?: AbortSignal): Promise<unknown> {
  return request("/api/tle", signal);
}

export function getPositions(signal?: AbortSignal): Promise<PositionsResponse> {
  return request<PositionsResponse>("/api/positions", signal);
}

export function getRisk(signal?: AbortSignal): Promise<RiskResponse> {
  return request<RiskResponse>("/api/risk", signal);
}

/*
  IMPORTANT:
  Dashboard + Globe both use this single snapshot.
*/
export function getSnapshot(signal?: AbortSignal): Promise<Snapshot> {
  return request<Snapshot>("/api/snapshot", signal);
}
