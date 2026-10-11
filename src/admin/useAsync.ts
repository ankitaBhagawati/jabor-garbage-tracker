import { useCallback, useEffect, useState } from "react";

// Runs an async load when the inputs change, ignores answers that arrive late, and can be run again.
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState(previous => ({ data: previous.data, loading: true }));
    load().then(
      data => { if (live) setState({ data, loading: false }); },
      (error: unknown) => { if (live) setState({ error: error instanceof Error ? error.message : "Something went wrong. Please try again.", loading: false }); },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick(t => t + 1), []);
  return { ...state, reload };
}
