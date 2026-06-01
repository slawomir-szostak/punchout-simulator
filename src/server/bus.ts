import { EventEmitter } from "node:events";
import type { Cart, LogRecord } from "./cxml/types.js";

// In-process event bus. The server is the sole writer of the log, so it emits
// the SSE event at the exact moment it appends the line — no file watching
// needed (spec section 7).

export interface CartEvent {
  type: "cart";
  connectionId: string;
  cart: Cart;
}

export interface LogEvent {
  type: "log";
  record: LogRecord;
}

export type BusEvent = LogEvent | CartEvent;

class Bus extends EventEmitter {
  emitLog(record: LogRecord) {
    this.emit("event", { type: "log", record } satisfies LogEvent);
  }
  emitCart(connectionId: string, cart: Cart) {
    this.emit("event", { type: "cart", connectionId, cart } satisfies CartEvent);
  }
  onEvent(fn: (e: BusEvent) => void) {
    this.on("event", fn);
    return () => this.off("event", fn);
  }
}

export const bus = new Bus();
// SSE fan-out can exceed the default 10 listeners when several tabs are open.
bus.setMaxListeners(0);
