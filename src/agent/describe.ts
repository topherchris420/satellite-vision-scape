import type { AgentIntent } from "./contract";

/**
 * Plain-language phrases for intents, for people (the HUD) and for language
 * models (the server's option descriptions). `label` resolves a target id to
 * the name the player sees; unknown ids fall back to the id itself.
 */

const AMOUNT: Record<string, string> = {
  tap: "one click",
  short: "a short hold",
  long: "a long hold",
};

export function describeIntent(
  intent: AgentIntent,
  label: (id: string) => string = (id) => id.replaceAll("_", " "),
): string {
  switch (intent.intent) {
    case "wait":
      return "Wait and watch";
    case "request_human":
      return "Ask the person to take over";
    case "stop_vehicle":
      return "Brake to a stop";
    case "exit_vehicle":
      return "Step out of the vehicle";
    case "radio_power":
      return "Switch the radio on or off";
    case "radio_next_station":
      return "Change to the next radio station";
    case "radio_next_track":
      return "Skip to the next track";
    case "radio_previous_track":
      return "Go back a track";
    case "leave_terminal":
      return "Leave the terminal";
    case "start_concert":
      return "Begin the transmission";
    case "retry":
      return "Retry the failed delivery";
    case "navigate_to":
      return `Walk to ${label(intent.target)}`;
    case "drive_to":
      return `Drive to ${label(intent.target)}`;
    case "enter_vehicle":
      return `Get into ${label(intent.target)}`;
    case "interact":
      return `Use ${label(intent.target)}`;
    case "tune_receiver":
      return `Tune the receiver ${intent.direction} (${AMOUNT[intent.amount]})`;
    case "tune_terminal":
      return `Turn the terminal dial ${intent.direction} (${AMOUNT[intent.amount]})`;
  }
}

/** The button that hands a co-pilot suggestion over: "LET JEV DRIVE". */
export function delegationVerb(intent: AgentIntent): string {
  switch (intent.intent) {
    case "drive_to":
    case "stop_vehicle":
      return "DRIVE";
    case "navigate_to":
      return "WALK";
    case "tune_receiver":
    case "tune_terminal":
      return "TUNE";
    case "wait":
      return "WAIT";
    default:
      return "DO IT";
  }
}
