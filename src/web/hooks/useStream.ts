import { useEffect, useRef } from "react";
import type { Cart, LogRecord } from "../types";

interface Handlers {
  onLog?: (record: LogRecord) => void;
  onCart?: (connectionId: string, cart: Cart) => void;
}

// Subscribe to the server's SSE live log. Reconnects automatically via the
// browser's native EventSource retry.
export function useStream(handlers: Handlers) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.addEventListener("log", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        ref.current.onLog?.(data.record as LogRecord);
      } catch {
        /* ignore malformed frame */
      }
    });
    es.addEventListener("cart", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        ref.current.onCart?.(data.connectionId as string, data.cart as Cart);
      } catch {
        /* ignore */
      }
    });
    return () => es.close();
  }, []);
}
