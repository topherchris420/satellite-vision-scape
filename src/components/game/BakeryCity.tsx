import { CityPlay } from "./CityPlay";
import { CityMissionHUD } from "./CityMissionHUD";
import { CityStoryLayer } from "@/game/campaign/CityStoryLayer";
import { BAKERY_KEY } from "@/game/campaign/bakery";

export function BakeryCity() {
  return (
    <CityPlay
      label="Bakery delivery mission"
      makeMission={(game, storage) =>
        new CityStoryLayer(game, storage, storage ? navigator.locks : undefined)
      }
      modal={(mission) =>
        ["briefing", "receipt", "report", "filed", "failed"].includes(mission.phase)
      }
      onStorage={(mission, key) => {
        if (key === BAKERY_KEY) mission.syncSavedProgress();
      }}
      bakery={(mission) => mission.arrived}
      renderHUD={(props) => <CityMissionHUD {...props} />}
    />
  );
}
