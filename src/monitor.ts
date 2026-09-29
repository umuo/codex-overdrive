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

interface TurnInfo { turn_id: string; status: string }

export async function triggerIdleSessions(options: {
  sessionIds: string[];
  isActive: () => boolean;
  lastTriggered: Record<string, string>;
  pending: Set<string>;
  getStatus: (id: string) => Promise<TurnInfo | null>;
  trigger: (id: string) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const { isActive, pending, lastTriggered } = options;
  for (const id of options.sessionIds) {
    if (!isActive()) return;
    if (pending.has(id)) continue;
    // Shared across effect generations, including while a CLI request is pending.
    pending.add(id);
    try {
      const turn = await options.getStatus(id);
      if (!isActive()) return;
      if (!turn || turn.status === "inProgress" || lastTriggered[id] === turn.turn_id) continue;
      await options.trigger(id);
      // Remember successful requests even if monitoring stopped during the call.
      lastTriggered[id] = turn.turn_id;
    } catch (error) {
      if (isActive()) options.onError(error);
    } finally {
      pending.delete(id);
    }
  }
}
