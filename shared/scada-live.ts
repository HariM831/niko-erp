/**
 * The mill SCADA's live values — which WinCC tag feeds which part of the
 * Live Mill screen.
 *
 * The tag names are the integrator's, from the WinCC project HMI_5TG9 (read off
 * the SCADA PC on 6 Oct 2026, scripts/scada/scada-tags.ps1). The helper on that
 * PC reads exactly the tags listed here over WinCC's OPC UA server, so this file
 * is both the screen's map and the helper's shopping list: change a tag here and
 * the helper picks it up on its next start.
 *
 * Several meanings are read from the names and the screen, not confirmed by the
 * integrator — those are marked "(?)" and are worth checking against the SCADA
 * the first time live values arrive.
 */

const bins = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const silos = [1, 2, 3, 4, 5] as const;

export const LIVE_TAGS = {
  // ── Scales ──
  wg1: "BATCHINGDATA1_LOADCELL",
  wg2: "BATCHINGDATA1_LOADCELL-2",

  // ── The batch ──
  recipeName: "COMMONDB_RECEIPE_NAME",
  setTotal: "BATCHINGDATA1_TOTALSET",
  actTotal: "BATCHINGDATA1_TOTALACT",
  batchesSet: "BATCHINGDATA1_SETBATCHCOUNT",
  batchRunning: "BATCHINGDATA1_CURRENTBATCH",
  batchesDone: "BATCHINGDATA1_COMPLETEBATCH",
  runningBin1: "BATCHINGDATA1_CURRENTBIN",
  runningBin2: "BATCHINGDATA1_CURRENTBIN-2",
  batchingStep: "BATCHINGDATA1_BATCHINGSTEP1",
  /** Mixing time set point (?) — the screen shows 180 s. */
  mixSet: "BATCHINGDATA1_SETMIXINGTMR{1}",
  /** MBG time set point (?) — the screen shows 35 s. */
  mbgSet: "BATCHINGDATA1_SETMIXINGTMR{2}",

  // ── Motors and amps ──
  grinderAmps: "grinderamps_realout",
  grinder2Amps: "grinderamps-2_realout",
  mixerAmps: "MIXERAMPS_realout",
  grinderAmpsSp: "COMMONDB_GINDER-1SP",
  rotaryHz: "ROTARYHZ_realout",

  // ── Mode and alarms ──
  auto: "COMMONDB_AUTOCMD",
  emergency: "COMMONDB_EMERGENCYSTOP",
  buzzer: "COMMONDB_BUZZER",
  batchHold: "BATCHINGDATA1_HOLD",
  mixerHold: "GRP_3DATA_HOLD",
  grinderHold: "GRP_2DATA_GRINDERHOLD",
  batchStart: "BATCHINGDATA1_BATCHSTART",
  /** Section run commands (?) — group 1 RM feeding, 2 grinding/mixing, 3 silo. */
  group1On: "GRP_1DATA_GP_1SCADAONCMD",
  group2On: "GRP_2DATA_GP_2SCADAONCMD",
  group3On: "GRP_3DATA_GP_3SCADAONCMD",

  // ── What is running (the screen animates these) ──
  rmElevator1: "RM_ELEVATOR_ANIMATION",
  rmElevator2: "RM_ELEVATOR-2_ANIMATION",
  topScrew: "FFD_SCREW_CONVYOR_ANIMATION",
  grinderElevator: "GRINDERELEVATOR_ANIMATION",
  grinder: "RM_MOTOR-1_ANIMATION",
  batchConveyor: "BBCON_ANIMATION",
  mixerElevator: "MIXELEVATOR_ANIMATION",
  mixerElevatorScrew: "MIXELEVATORSCCON_ANIMATION",
  mixer: "MIXER_ANIMATION",
  ffElevator: "FF_ELEVATOR-1_ANIMATION",
  ffTopConveyor: "FF_TOP_CONVYOR-1_ANIMATION",
  distChain1: "DISTRIBUSION_CHAIN_CONV_ANIMATION",
  distChain2: "DISTRIBUSION_CHAIN_CONV-2_ANIMATION",
  distChain3: "DISTRIBUSION_CHAIN_CONV-3_ANIMATION",
  flapGate: "GRP_1DATA_FLAPGATE",
  ffFlapGate: "GRP_3DATA_FFFLAPGATE",
  dumpLamp1: "GRP_1DATA_DUMPLAMP-1",
  dumpLamp2: "GRP_1DATA_DUMPLAMP-2",

  // ── Per bin ──
  ...Object.fromEntries(
    bins.flatMap((n) => [
      [`bin${n}Name`, `COMMONDB_BINNAME{${n}}`],
      // Bins 7 and 8 are named differently in the PLC; the meaning is the same.
      [`bin${n}Set`, n <= 6 ? `BATCHINGDATA1_RECEIPESETWG{${n}}` : `BATCHINGDATA1_RECEIPEC-SETWG{${n}}`],
      [`bin${n}Act`, `BATCHINGDATA1_ACTUALBINWG{${n}}`],
      [`bin${n}Inflight`, `BATCHINGDATA1_INFLIGHTVALUE{${n}}`],
      [`bin${n}Selected`, `GRP_1DATA_BINSCADAGATESEL{${n}}`],
      [`bin${n}High`, `GRP_1DATA_BINHIGHSENSOR{${n}}`],
      [`bin${n}Low`, `RWMATRLLLFB-${n}`],
      [`bin${n}Coarse`, `BATCHINGDATA1_BINC-GATEOUT{${n}}`],
      [`bin${n}Fine`, `BATCHINGDATA1_BINF-GATEOUT{${n}}`],
    ]),
  ),

  // ── Finished-feed silos ──
  ...Object.fromEntries(
    silos.flatMap((n) => [
      [`silo${n}Name`, `COMMONDB_SILONAME{${n}}`],
      [`silo${n}Gate`, `GRP_3DATA_GRP3GATES{${n}}`],
      [`silo${n}Full`, `GRP_3DATA_GRP3SENSORS{${n}}`],
    ]),
  ),
} as Record<string, string>;

/** Every tag the helper should read, once each. */
export const LIVE_TAG_NAMES = [...new Set(Object.values(LIVE_TAGS))].sort();

/** A snapshot as the helper posts it: tag name → value, and when it was read. */
export interface LiveSnapshot {
  at: string;
  values: Record<string, number | string | boolean | null>;
}

/** A snapshot this old means the helper or the OPC UA server has stopped. */
export const LIVE_STALE_MS = 15_000;

export const BIN_NUMBERS = bins;
export const SILO_NUMBERS = silos;
