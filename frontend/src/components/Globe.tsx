import { Line, OrbitControls, Stars } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { SRGBColorSpace, TextureLoader, type Texture } from "three";
import { useEffect, useMemo, useState } from "react";

import type {
  Conjunction,
  SatellitePosition,
  SatelliteRisk,
  Snapshot,
} from "../lib/api";

const EARTH_TEXTURE_URLS = [
  "https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg",
  "/earth-night.jpg",
];

function riskColor(level: string) {
  switch (level) {
    case "high":
      return "#ff3030";

    case "medium":
      return "#ff9500";

    case "low":
      return "#ffd52e";

    default:
      return "#f4f7ff";
  }
}

function riskSize(level: string) {
  switch (level) {
    case "high":
      return 0.048;

    case "medium":
      return 0.04;

    case "low":
      return 0.034;

    default:
      return 0.023;
  }
}

function riskLabel(level: string) {
  switch (level) {
    case "high":
      return "HIGH";

    case "medium":
      return "MEDIUM";

    case "low":
      return "LOW";

    default:
      return "VERY LOW";
  }
}

function useEarthTexture(): Texture | null {
  const [texture, setTexture] = useState<Texture | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loader = new TextureLoader();

    function tryLoad(index: number) {
      const url = EARTH_TEXTURE_URLS[index];

      if (!url) {
        console.warn("Earth map unavailable; drawing a plain globe instead.");
        return;
      }

      loader.load(
        url,
        (loaded) => {
          if (cancelled) {
            loaded.dispose();
            return;
          }

          loaded.colorSpace = SRGBColorSpace;
          setTexture(loaded);
        },
        undefined,
        () => {
          if (!cancelled) {
            console.warn(`Earth map failed to load from ${url}`);
            tryLoad(index + 1);
          }
        },
      );
    }

    tryLoad(0);

    return () => {
      cancelled = true;
    };
  }, []);

  return texture;
}

function Earth() {
  const texture = useEarthTexture();

  return (
    <>
      <mesh scale={1.045}>
        <sphereGeometry args={[1, 64, 64]} />

        <meshBasicMaterial color="#258cff" transparent opacity={0.08} />
      </mesh>

      <mesh key={texture ? "mapped" : "plain"}>
        <sphereGeometry args={[1, 96, 96]} />

        <meshStandardMaterial
          map={texture}
          color={texture ? "#ffffff" : "#1b4f8a"}
          roughness={0.85}
          metalness={0.05}
        />
      </mesh>

      <mesh scale={1.025}>
        <sphereGeometry args={[1, 64, 64]} />

        <meshBasicMaterial
          color="#3aa8ff"
          transparent
          opacity={0.035}
          side={2}
        />
      </mesh>
    </>
  );
}

function ObjectPoint({
  position,
  level,
  selected,
  onSelect,
}: {
  position: SatellitePosition;
  level: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <mesh
      position={[position.x, position.y, position.z]}
      scale={selected ? 1.7 : 1}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      onPointerOver={(event) => {
        event.stopPropagation();
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        document.body.style.cursor = "auto";
      }}
    >
      <sphereGeometry args={[riskSize(level), 12, 12]} />

      <meshBasicMaterial color={riskColor(level)} />
    </mesh>
  );
}

function Scene({
  positions,
  positionById,
  riskById,
  conjunctions,
  selectedId,
  onSelect,
}: {
  positions: SatellitePosition[];
  positionById: Map<number, SatellitePosition>;
  riskById: Map<number, SatelliteRisk>;
  conjunctions: Conjunction[];
  selectedId: number | null;
  onSelect: (noradId: number) => void;
}) {
  return (
    <>
      <color attach="background" args={["#010108"]} />

      <ambientLight intensity={0.35} />

      <directionalLight position={[4, 3, 5]} intensity={2.2} />

      <directionalLight position={[-4, -2, -3]} intensity={0.15} />

      <Stars
        radius={90}
        depth={50}
        count={3500}
        factor={3}
        saturation={0}
        fade
        speed={0.15}
      />

      <Earth />

      {positions.map((point) => (
        <ObjectPoint
          key={point.noradId}
          position={point}
          level={riskById.get(point.noradId)?.riskLevel ?? "very-low"}
          selected={point.noradId === selectedId}
          onSelect={() => onSelect(point.noradId)}
        />
      ))}

      {conjunctions.map((pair) => {
        const objectA = positionById.get(pair.noradIdA);
        const objectB = positionById.get(pair.noradIdB);

        if (!objectA || !objectB) {
          return null;
        }

        return (
          <Line
            key={`${pair.noradIdA}-${pair.noradIdB}`}
            points={[
              [objectA.x, objectA.y, objectA.z],
              [objectB.x, objectB.y, objectB.z],
            ]}
            color="#ff3030"
            lineWidth={2.5}
          />
        );
      })}

      <OrbitControls
        enablePan={false}
        enableRotate
        enableZoom
        minDistance={1.65}
        maxDistance={7}
        rotateSpeed={0.55}
        zoomSpeed={0.7}
      />
    </>
  );
}

function Globe({
  snapshot,
  error,
}: {
  snapshot: Snapshot | null;
  error: string | null;
}) {
  const [selectedId, setSelectedId] = useState<number | null>(null);

  useEffect(() => {
    return () => {
      document.body.style.cursor = "auto";
    };
  }, []);

  const positions = useMemo(() => snapshot?.positions ?? [], [snapshot]);

  const positionById = useMemo(
    () => new Map(positions.map((point) => [point.noradId, point])),
    [positions],
  );

  const riskById = useMemo(
    () =>
      new Map((snapshot?.satellites ?? []).map((risk) => [risk.noradId, risk])),
    [snapshot],
  );

  const conjunctions = useMemo(() => snapshot?.conjunctions ?? [], [snapshot]);

  const selectedPosition =
    selectedId !== null ? (positionById.get(selectedId) ?? null) : null;

  const selectedRisk =
    selectedId !== null ? (riskById.get(selectedId) ?? null) : null;

  const selectedConjunctions =
    selectedId !== null
      ? conjunctions.filter(
          (pair) =>
            pair.noradIdA === selectedId || pair.noradIdB === selectedId,
        )
      : [];

  return (
    <div
      className="relative h-full min-h-[70vh] w-full overflow-hidden bg-[#010108]"
      role="application"
      aria-label="Earth globe with satellite risk"
    >
      {snapshot && (
        <Canvas
          camera={{
            position: [0, 0, 3.25],
            fov: 48,
          }}
          gl={{
            antialias: true,
          }}
        >
          <Scene
            positions={positions}
            positionById={positionById}
            riskById={riskById}
            conjunctions={conjunctions}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </Canvas>
      )}

      {!snapshot && !error && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="rounded-lg border border-slate-800 bg-slate-950/80 px-5 py-3 font-mono text-xs text-cyan-300">
            INITIALIZING ORBITAL SENSOR NETWORK...
          </div>
        </div>
      )}

      {!snapshot && error && (
        <p className="absolute inset-0 flex items-center justify-center px-6 text-center font-mono text-sm text-red-300">
          {error}
        </p>
      )}

      {snapshot && positions.length === 0 && (
        <p className="absolute inset-x-0 top-1/2 px-6 text-center font-mono text-sm text-amber-300">
          No objects could be propagated from the current TLE data.
        </p>
      )}

      {snapshot && (
        <div className="absolute bottom-4 left-4 rounded-lg border border-slate-700/70 bg-slate-950/90 px-4 py-3 text-xs text-slate-200 backdrop-blur-md">
          <div className="mb-3 font-semibold tracking-wide text-slate-300">
            SATELLITE RISK
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-slate-100" />
              Very Low
            </div>

            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-yellow-300" />
              Low
            </div>

            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-orange-400" />
              Medium
            </div>

            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
              High
            </div>
          </div>
        </div>
      )}

      {selectedPosition && (
        <aside className="absolute right-4 top-4 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-slate-700/70 bg-slate-950/95 p-4 text-slate-100 shadow-2xl backdrop-blur-md">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <p className="mb-1 font-mono text-[9px] uppercase tracking-[0.2em] text-cyan-400">
                TRACKED OBJECT
              </p>

              <h2 className="text-sm font-semibold text-white">
                {selectedPosition.name}
              </h2>

              <p className="mt-1 font-mono text-[10px] text-slate-500">
                NORAD {selectedPosition.noradId} / ALT{" "}
                {selectedPosition.altitudeKm.toFixed(0)} km / TLE{" "}
                {selectedPosition.tleAgeDays.toFixed(1)} d old
              </p>
            </div>

            <button
              type="button"
              className="text-xs text-slate-500 transition hover:text-white"
              onClick={() => setSelectedId(null)}
            >
              CLOSE
            </button>
          </div>

          {selectedRisk ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-md border border-slate-800 bg-slate-900/70 p-3">
                <span className="text-xs text-slate-400">Risk Level</span>

                <span
                  className="text-sm font-bold"
                  style={{
                    color: riskColor(selectedRisk.riskLevel),
                  }}
                >
                  {riskLabel(selectedRisk.riskLevel)}
                </span>
              </div>

              <div className="rounded-md border border-slate-800 bg-slate-900/70 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-400">
                    Proximity Score
                  </span>

                  <span className="text-sm font-bold text-white">
                    {selectedRisk.riskScore}/100
                  </span>
                </div>

                <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${selectedRisk.riskScore}%`,
                      backgroundColor: riskColor(selectedRisk.riskLevel),
                    }}
                  />
                </div>
              </div>

              <div className="rounded-md border border-slate-800 bg-slate-900/70 p-3">
                <p className="text-xs text-slate-500">Nearest Object</p>

                <p className="mt-1 text-sm text-slate-200">
                  {selectedRisk.nearestObject ?? "No nearby object"}

                  {selectedRisk.nearestNoradId !== null && (
                    <span className="ml-2 font-mono text-[10px] text-slate-500">
                      NORAD {selectedRisk.nearestNoradId}
                    </span>
                  )}
                </p>
              </div>

              <div className="rounded-md border border-slate-800 bg-slate-900/70 p-3">
                <p className="text-xs text-slate-500">Nearest Distance</p>

                <p className="mt-1 text-sm text-slate-200">
                  {selectedRisk.nearestDistanceKm !== null
                    ? `${selectedRisk.nearestDistanceKm.toFixed(2)} km`
                    : "N/A"}
                </p>
              </div>

              {selectedConjunctions.length > 0 ? (
                <div className="border-t border-slate-800 pt-3">
                  <p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-red-300">
                    CONJUNCTION ALERT
                  </p>

                  <div className="space-y-2 text-xs leading-relaxed text-slate-300">
                    {selectedConjunctions.map((pair) => (
                      <p key={`${pair.noradIdA}-${pair.noradIdB}`}>
                        {pair.objectA} and {pair.objectB} are{" "}
                        {pair.distanceKm.toFixed(2)} km apart.
                      </p>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="border-t border-slate-800 pt-3 text-xs leading-relaxed text-slate-500">
                  No close conjunction detected in the current snapshot.
                </p>
              )}

              <p className="border-t border-slate-800 pt-3 font-mono text-[9px] leading-relaxed text-slate-600">
                PROXIMITY SCORE IS A RELATIVE SCREENING RANK, NOT A COLLISION
                PROBABILITY.
              </p>
            </div>
          ) : (
            <p className="text-xs text-slate-400">Risk data unavailable.</p>
          )}
        </aside>
      )}
    </div>
  );
}

export default Globe;
