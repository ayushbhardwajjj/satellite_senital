import { useEffect, useMemo, useState } from "react";
import Globe from "./components/Globe";
import { getSnapshot, type Snapshot } from "./lib/api";

/** How often the browser asks the backend for a freshly calculated snapshot. */
const POLL_INTERVAL_MS = 10_000;

function formatDistance(distance: number | null | undefined) {
  if (
    distance === null ||
    distance === undefined ||
    !Number.isFinite(distance)
  ) {
    return "N/A";
  }

  return `${distance.toFixed(3)} km`;
}

function formatClock(value: Date | string | null) {
  if (!value) return "--:--:--";

  const date = typeof value === "string" ? new Date(value) : value;

  if (Number.isNaN(date.getTime())) return "--:--:--";

  return date.toLocaleTimeString("en-IN", {
    hour12: false,
  });
}

function formatAge(minutes: number) {
  if (minutes < 1) return "under 1 min old";
  if (minutes < 90) return `${minutes} min old`;

  return `${(minutes / 60).toFixed(1)} h old`;
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [lastSuccess, setLastSuccess] = useState<Date | null>(null);
  const [updateCount, setUpdateCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const controller = new AbortController();

    async function load() {
      if (inFlight) return;
      inFlight = true;

      try {
        const data = await getSnapshot(controller.signal);

        if (cancelled) return;

        setSnapshot(data);
        setLastSuccess(new Date());
        setUpdateCount((current) => current + 1);
        setError(null);
      } catch (err) {
        if (cancelled) return;

        console.error("Snapshot request failed:", err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        inFlight = false;
      }
    }

    void load();

    const interval = window.setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(interval);
    };
  }, []);

  const systemStatus = !snapshot
    ? error
      ? "OFFLINE"
      : "CONNECTING"
    : error || snapshot.tle.stale
      ? "DEGRADED"
      : "ONLINE";

  const statusDot =
    systemStatus === "ONLINE"
      ? "bg-emerald-400"
      : systemStatus === "OFFLINE"
        ? "bg-red-400"
        : "bg-amber-400";

  const statistics = useMemo(() => {
    const summary = snapshot?.summary;

    return {
      total: summary?.total ?? 0,
      high: summary?.high ?? 0,
      medium: summary?.medium ?? 0,
      low: summary?.low ?? 0,
      veryLow: summary?.veryLow ?? 0,
      conjunctions: summary?.conjunctionCount ?? 0,
      closest: summary?.closest ?? null,
      highestRisk: summary?.highestRisk ?? null,
    };
  }, [snapshot]);

  const failureText = useMemo(() => {
    if (!snapshot || snapshot.propagation.failed === 0) return null;

    return Object.entries(snapshot.propagation.byReason)
      .map(([reason, count]) => `${reason} x${count}`)
      .join(", ");
  }, [snapshot]);

  const distribution = [
    {
      label: "HIGH",
      value: statistics.high,
      text: "text-red-300",
      bar: "bg-red-400",
    },
    {
      label: "MEDIUM",
      value: statistics.medium,
      text: "text-yellow-300",
      bar: "bg-yellow-300",
    },
    {
      label: "LOW",
      value: statistics.low,
      text: "text-cyan-300",
      bar: "bg-cyan-300",
    },
    {
      label: "VERY LOW",
      value: statistics.veryLow,
      text: "text-slate-300",
      bar: "bg-slate-300",
    },
  ];

  return (
    <main className="min-h-screen bg-[#050914] text-white">
      <header className="border-b border-cyan-400/20 bg-[#080f1d]/90 px-6 py-4">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <div>
            <p className="text-xs tracking-[0.35em] text-cyan-300">
              ORBITAL ENVIRONMENT
            </p>

            <h1 className="mt-1 text-2xl font-bold tracking-wide">
              ORBITAL SENTINEL
            </h1>

            <p className="mt-1 text-xs text-slate-400">
              Live satellite tracking and proximity monitoring
            </p>
          </div>

          <div className="text-right">
            <div className="flex items-center justify-end gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${statusDot}`} />

              <span className="text-sm font-semibold tracking-widest">
                SYSTEM {systemStatus}
              </span>
            </div>

            <p className="mt-1 text-xs text-slate-400">LIVE POSITION FEED</p>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-7xl px-6 py-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-xl border border-cyan-400/20 bg-[#0b1425] p-4">
            <p className="text-xs tracking-widest text-slate-400">
              TRACKED OBJECTS
            </p>

            <p className="mt-2 text-3xl font-bold text-cyan-300">
              {snapshot ? statistics.total : "--"}
            </p>

            <p className="mt-1 text-xs text-slate-500">
              {snapshot
                ? `Propagated of ${snapshot.propagation.attempted} TLEs`
                : "Waiting for data"}
            </p>
          </div>

          <div className="rounded-xl border border-red-400/20 bg-[#0b1425] p-4">
            <p className="text-xs tracking-widest text-slate-400">HIGH RISK</p>

            <p className="mt-2 text-3xl font-bold text-red-400">
              {snapshot ? statistics.high : "--"}
            </p>

            <p className="mt-1 text-xs text-slate-500">
              Relative screening rank
            </p>
          </div>

          <div className="rounded-xl border border-yellow-400/20 bg-[#0b1425] p-4">
            <p className="text-xs tracking-widest text-slate-400">
              CLOSEST DISTANCE
            </p>

            <p className="mt-2 text-2xl font-bold text-yellow-300">
              {formatDistance(statistics.closest?.distanceKm)}
            </p>

            <p className="mt-1 truncate text-xs text-slate-500">
              {statistics.closest
                ? `${statistics.closest.name} / ${
                    statistics.closest.nearestObject ?? "?"
                  }`
                : "No data"}
            </p>
          </div>

          <div className="rounded-xl border border-purple-400/20 bg-[#0b1425] p-4">
            <p className="text-xs tracking-widest text-slate-400">
              CONJUNCTIONS
            </p>

            <p className="mt-2 text-3xl font-bold text-purple-300">
              {snapshot ? statistics.conjunctions : "--"}
            </p>

            <p className="mt-1 text-xs text-slate-500">
              Under {snapshot ? snapshot.riskModel.conjunctionThresholdKm : 5}{" "}
              km right now
            </p>
          </div>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_320px]">
          <div className="relative min-h-[520px] overflow-hidden rounded-2xl border border-cyan-400/20 bg-[#070d19]">
            <div className="absolute left-4 top-4 z-10">
              <p className="text-xs tracking-[0.25em] text-cyan-300">
                LIVE ORBITAL MAP
              </p>

              <p className="mt-1 text-xs text-slate-500">
                SGP4 POSITION PROPAGATION
              </p>
            </div>

            <Globe snapshot={snapshot} error={error} />
          </div>

          <aside className="space-y-4">
            <div className="rounded-2xl border border-cyan-400/20 bg-[#0b1425] p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold tracking-widest text-cyan-300">
                  LIVE TELEMETRY
                </h2>

                <span className="rounded-full border border-emerald-400/30 px-2 py-1 text-[10px] text-emerald-300">
                  UPDATE #{updateCount}
                </span>
              </div>

              <div className="mt-5 space-y-4">
                <div>
                  <p className="text-xs text-slate-500">
                    LAST UPDATE (SUCCESSFUL POLL)
                  </p>

                  <p className="mt-1 font-mono text-xl text-white">
                    {formatClock(lastSuccess)}
                  </p>
                </div>

                <div>
                  <p className="text-xs text-slate-500">POSITIONS CALCULATED</p>

                  <p className="mt-1 font-mono text-sm text-white">
                    {formatClock(snapshot?.calculatedAt ?? null)}
                  </p>

                  <p className="mt-1 text-[11px] text-slate-500">
                    Recomputed from TLEs on every poll (
                    {POLL_INTERVAL_MS / 1000}s)
                  </p>
                </div>

                <div>
                  <p className="text-xs text-slate-500">TLE DATA FETCHED</p>

                  <p className="mt-1 font-mono text-sm text-white">
                    {formatClock(snapshot?.tle.fetchedAt ?? null)}

                    {snapshot && (
                      <span
                        className={`ml-2 text-[11px] ${
                          snapshot.tle.stale
                            ? "text-amber-300"
                            : "text-slate-500"
                        }`}
                      >
                        {formatAge(snapshot.tle.ageMinutes)}
                        {snapshot.tle.stale ? " - STALE" : ""}
                      </span>
                    )}
                  </p>

                  <p className="mt-1 text-[11px] text-slate-500">
                    Provider refreshes about every{" "}
                    {snapshot ? snapshot.tle.ttlMinutes : 120} min
                  </p>
                </div>

                <div>
                  <p className="text-xs text-slate-500">HIGHEST RISK SCORE</p>

                  <p className="mt-1 text-3xl font-bold text-red-300">
                    {statistics.highestRisk?.riskScore ?? "--"}
                    <span className="ml-1 text-sm text-slate-500">/ 100</span>
                  </p>

                  <p className="mt-1 truncate text-xs text-slate-400">
                    {statistics.highestRisk?.name ?? "No data"}
                  </p>
                </div>

                <div>
                  <p className="text-xs text-slate-500">CLOSEST OBJECT</p>

                  <p className="mt-1 text-sm text-white">
                    {statistics.closest?.name ?? "No data"}
                  </p>

                  <p className="mt-1 font-mono text-cyan-300">
                    {formatDistance(statistics.closest?.distanceKm)}
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-cyan-400/20 bg-[#0b1425] p-5">
              <h2 className="text-sm font-semibold tracking-widest text-cyan-300">
                RISK DISTRIBUTION
              </h2>

              <div className="mt-4 space-y-3">
                {distribution.map((row) => (
                  <div key={row.label}>
                    <div className="mb-1 flex justify-between text-xs">
                      <span className={row.text}>{row.label}</span>
                      <span>{row.value}</span>
                    </div>

                    <div className="h-2 rounded-full bg-slate-800">
                      <div
                        className={`h-2 rounded-full ${row.bar}`}
                        style={{
                          width: `${
                            statistics.total
                              ? (row.value / statistics.total) * 100
                              : 0
                          }%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>

              <p className="mt-4 text-[10px] leading-relaxed text-slate-500">
                Relative proximity rank within the tracked set. It is not a
                probability of collision.
              </p>
            </div>
          </aside>
        </div>

        {error && (
          <p className="mt-4 rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-300">
            Live telemetry error: {error}
            {snapshot && lastSuccess
              ? ` (showing last good data from ${formatClock(lastSuccess)})`
              : ""}
          </p>
        )}

        {snapshot && failureText && (
          <p className="mt-4 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-xs text-amber-200">
            {snapshot.propagation.failed} of {snapshot.propagation.attempted}{" "}
            TLE records were not propagated: {failureText}.
          </p>
        )}

        <footer className="mt-5 flex flex-wrap justify-between gap-2 border-t border-cyan-400/10 pt-4 text-xs text-slate-500">
          <span>
            DATA SOURCE: {snapshot ? snapshot.tle.source.toUpperCase() : "..."}
          </span>

          <span>BROWSER POLL: {POLL_INTERVAL_MS / 1000} SECONDS</span>

          <span>
            RISK MODEL: RELATIVE PROXIMITY RANK (NOT COLLISION PROBABILITY)
          </span>
        </footer>
      </section>
    </main>
  );
}

export default App;
