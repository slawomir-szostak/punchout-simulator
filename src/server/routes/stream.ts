import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { bus } from "../bus.js";

// Live log to the SPA via Server-Sent Events. Log traffic is server->client
// only, so SSE (not WebSocket) is the right tool — spec sections 6 and 7.

export const streamRoute = new Hono();

streamRoute.get("/stream", (c) => {
  return streamSSE(c, async (stream) => {
    let open = true;
    let id = 0;

    const unsubscribe = bus.onEvent((event) => {
      if (!open) return;
      void stream.writeSSE({
        id: String(id++),
        event: event.type,
        data: JSON.stringify(event),
      });
    });

    stream.onAbort(() => {
      open = false;
      unsubscribe();
    });

    await stream.writeSSE({ event: "ready", data: JSON.stringify({ ts: Date.now() }) });

    // Keep the connection alive through proxies with a periodic comment ping.
    while (open) {
      await stream.sleep(15000);
      if (!open) break;
      await stream.writeSSE({ event: "ping", data: JSON.stringify({ ts: Date.now() }) });
    }
  });
});
