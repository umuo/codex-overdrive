// Each effect owns a loop; cleanup invalidates even checks already awaiting IPC.
export function startMonitor(
  check: (isActive: () => boolean) => Promise<number>,
  enabled: () => boolean,
) {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const isActive = () => !cancelled && enabled();
  const run = async () => {
    if (!isActive()) return;
    const delay = await check(isActive);
    if (isActive()) timer = setTimeout(() => { void run(); }, delay);
  };
  void run();
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}

export interface TurnInfo {
  turn_id: string;
  status: string;
  is_usage_limited: boolean;
}

export interface SessionMonitorState {
  phase: "awaiting_result" | "waiting_quota" | "stopped";
  lastSentTurn: string | null;
  lastReportedErrorTurn?: string;
}

export async function checkMonitoredSessions(options: {
  sessionIds: string[];
  quotaAllowed: boolean;
  isActive: () => boolean;
  states: Record<string, SessionMonitorState>;
  pending: Set<string>;
  getStatus: (id: string) => Promise<TurnInfo | null>;
  trigger: (id: string) => Promise<void>;
  onStop: (id: string, reason: string) => void;
  onError: (error: unknown) => void;
}) {
  const { isActive, pending, states } = options;
  for (const id of options.sessionIds) {
    if (!isActive()) return;
    const state = states[id];
    if (state?.phase === "stopped" || pending.has(id)) continue;
    // Initial sends wait for available quota. Later checks inspect the session
    // even when quota is unavailable, so successful sessions can stop promptly.
    if (!state && !options.quotaAllowed) continue;
    pending.add(id);
    try {
      const turn = await options.getStatus(id);
      if (!isActive()) return;
      if (state) {
        const stop = (reason: string) => {
          state.phase = "stopped";
          options.onStop(id, reason);
        };
        if (!turn) continue;
        if (turn.status === "inProgress") {
          state.phase = "awaiting_result";
          continue;
        }
        // CLI acceptance does not mean a new turn is already in the database.
        if (turn.turn_id === state.lastSentTurn) continue;
        if (turn.status === "completed") {
          stop("会话已正常完成");
          continue;
        }
        if (turn.status !== "failed" && turn.status !== "interrupted") continue;
        if (!turn.is_usage_limited) {
          state.phase = "awaiting_result";
          if (state.lastReportedErrorTurn !== turn.turn_id) {
            state.lastReportedErrorTurn = turn.turn_id;
            options.onError(`会话 ${id} 因非额度原因中断，请手动检查；继续监控，不自动发送`);
          }
          continue;
        }
        state.phase = "waiting_quota";
        if (!options.quotaAllowed) continue;
      }
      await options.trigger(id);
      // Capture success even if stopped during IPC; each monitoring run owns
      // its own state object, so a late response cannot affect a new run.
      states[id] = { phase: "awaiting_result", lastSentTurn: turn?.turn_id ?? null };
    } catch (error) {
      if (isActive()) options.onError(error);
    } finally {
      pending.delete(id);
    }
  }
}
