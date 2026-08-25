import type { LogLine } from "../utils/log";
import type { ChainInfoView, FeeTiers, TxView } from "../api/types";

export interface CoreEventMap {
  "chain:update": ChainInfoView;
  "balance:update": string;

  "connection:change": number;
  "fees:update": FeeTiers;
  "tx:update": TxView[];

  "block:push": unknown;
  log: LogLine;
  shutdown: void;

  "auth:change": boolean;
}

export type CoreEventName = keyof CoreEventMap;

type Handler<K extends CoreEventName> = (payload: CoreEventMap[K]) => void;

export class EventBus {
  private handlers = new Map<CoreEventName, Set<Handler<CoreEventName>>>();

  on<K extends CoreEventName>(event: K, cb: Handler<K>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(cb as Handler<CoreEventName>);
    return () => this.off(event, cb as Handler<CoreEventName>);
  }

  off<K extends CoreEventName>(event: K, cb: Handler<K>): void {
    this.handlers.get(event)?.delete(cb as Handler<CoreEventName>);
  }

  emit<K extends CoreEventName>(event: K, payload: CoreEventMap[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        (cb as Handler<K>)(payload);
      } catch (e) {
        console.error(`event handler error (${String(event)}):`, e);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
