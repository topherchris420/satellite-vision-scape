import type { CityStoryLayer } from "@/game/campaign/CityStoryLayer";
import { CITY_BLOCKS, CITY_BOUNDS, LAB, SHELTER } from "@/game/world/buildCityWorld";

/** North-up radar. The engine looks along +Z with -X to the player's right. */
export function StreetMap({ mission: m }: { mission: CityStoryLayer }) {
  const van = m.van.physics;
  const dest =
    m.phase === "tail"
      ? van
      : m.phase === "board"
        ? m.wagon.physics
        : m.phase === "interview"
          ? SHELTER
          : LAB;
  return (
    <CityRadar
      game={m.game}
      dest={dest}
      wagon={m.wagon.physics}
      traffic={van}
      trafficLabel="Delivery van"
    />
  );
}

export function CityRadar({
  game,
  dest,
  wagon,
  traffic,
  trafficLabel = "Target vehicle",
}: {
  game: CityStoryLayer["game"];
  dest: { x: number; z: number };
  wagon: { x: number; z: number };
  traffic?: { x: number; z: number } | null;
  trafficLabel?: string;
}) {
  const rig = game.interaction.driven?.physics;
  const p = rig ?? game.player.position;
  const yaw = rig?.yaw ?? game.player.yaw;
  const dx = p.x - dest.x,
    dy = p.z - dest.z;
  const scale = Math.min(1, 44 / Math.max(1, Math.hypot(dx, dy)));
  return (
    <svg className="city-map" viewBox="-55 -55 110 110" role="img" aria-label="Harbor Avenue radar">
      <defs>
        <clipPath id="harbor-rim">
          <circle r="49" />
        </clipPath>
      </defs>
      <circle r="52" fill="#151511" stroke="#e4d1ad" strokeWidth="1.6" />
      <g clipPath="url(#harbor-rim)">
        <circle r="50" fill="#78885f" />
        <g transform={`translate(${p.x} ${p.z}) scale(-1 1)`}>
          <rect
            x="-45"
            y={-CITY_BOUNDS.maxZ}
            width="90"
            height={CITY_BOUNDS.maxZ - CITY_BOUNDS.minZ}
            fill="#b4aa8a"
          />
          <path d="M-41 29V-254 M41 29V-254" stroke="#8e8b75" strokeWidth="10" />
          <path d="M0 29V-254" stroke="#e1cba5" strokeWidth="20" />
          <path d="M0 29V-254" stroke="#48483f" strokeWidth="15" />
          {CITY_BLOCKS.map((b) => (
            <rect
              key={b.x + "-" + b.z}
              x={b.x - b.width / 2}
              y={-b.z - b.depth / 2}
              width={b.width}
              height={b.depth}
              fill="#ede3c7"
              stroke="#8b8a75"
              strokeWidth="1"
            />
          ))}
          {traffic && (
            <rect
              aria-label={trafficLabel}
              x={traffic.x - 2.5}
              y={-traffic.z - 3.5}
              width="5"
              height="7"
              rx="1"
              fill="#f7bd58"
              stroke="#291c0c"
            />
          )}
          <g transform={`translate(${wagon.x} ${-wagon.z})`}>
            <rect x="-2" y="-3" width="4" height="6" fill="#50bfb3" stroke="#143c38" />
          </g>
        </g>
        <path
          aria-label="Destination"
          transform={`translate(${dx * scale} ${dy * scale})`}
          d="M0 -5 4 0 0 5 -4 0Z"
          fill="#ffca56"
          stroke="#34210b"
          strokeWidth="1.8"
        />
        <path
          aria-label="Christopher"
          data-world-z={p.z}
          transform={`rotate(${(-yaw * 180) / Math.PI})`}
          d="M0 -7 4.7 5 0 3 -4.7 5Z"
          fill="white"
          stroke="#161713"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </g>
      <text
        y="-42"
        x="0"
        textAnchor="middle"
        fill="#fff8e7"
        stroke="#151511"
        strokeWidth="3"
        paintOrder="stroke"
        fontWeight="900"
        fontSize="12"
      >
        N
      </text>
    </svg>
  );
}

function EquipmentIcon({ armed }: { armed: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 60 54"
      fill="#f9f4e3"
      stroke="#181914"
      strokeWidth="2.3"
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      {armed ? (
        <>
          <path d="M6 16 L51 15 54 18 51 24 31 24 28 30 21 31 18 43 9 40 14 24 6 23Z" />
          <path d="M23 24H29L26 28H22Z" fill="#43443d" />
          <path d="M9 19H49 M14 32l4 1 M13 36l4 1" fill="none" />
        </>
      ) : (
        <>
          <path d="m10 30 1-9 6-4 5 1 1-6 6-4 6 2 5-1 5 5 5 1 3 6-1 8-10 11-5 8-16-3-2-6Z" />
          <path
            d="m16 24 6 4 2-10m0 9 7 4 3-7-5-8m4 11 6 3 4-7-6-8m4 12 5 1 3-7m-29 11 6 5 8-3"
            fill="none"
          />
        </>
      )}
    </svg>
  );
}

export function CityInstruments({
  mission: m,
  active,
  refresh,
}: {
  mission: CityStoryLayer;
  active: boolean;
  refresh: () => void;
}) {
  const armed = m.game.storySidearmDrawn;
  const equipped = armed ? "Field sidearm" : "Unarmed";
  return (
    <aside className="city-instruments" aria-label="Christopher's status">
      <button
        className="city-slot"
        aria-label={equipped + " — switch equipment"}
        title={equipped + " · Switch equipment"}
        disabled={!active || !m.canEquip}
        onClick={() => {
          m.toggleEquipment();
          refresh();
        }}
      >
        <EquipmentIcon armed={armed} />
        {armed && (
          <span aria-label="Ammunition">
            {m.sidearm.reserve}–{m.sidearm.ammo}
          </span>
        )}
      </button>
      <time aria-label="District time">{m.clock}</time>
      <meter
        className="city-condition"
        aria-label="Research wagon condition"
        min="0"
        max="100"
        value={m.wagon.health}
        title="Research wagon condition"
      />
      <meter
        className="city-health"
        aria-label="Christopher's health"
        min="0"
        max="100"
        value={m.health}
        title="Christopher's health"
      />
      <strong className="city-cash" aria-label={`Field funds: $${m.cash}`}>
        ${String(m.cash).padStart(7, "0")}
      </strong>
      <div className="city-stars" role="img" aria-label={`Wanted level ${m.wanted} of 6`}>
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className={i < m.wanted ? "lit" : ""}>
            ★
          </span>
        ))}
      </div>
    </aside>
  );
}
