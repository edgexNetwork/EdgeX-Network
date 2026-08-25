import { useEffect, useRef } from "react";
import { useStdin, useStdout } from "ink";

export interface MouseEventData {

  x: number;

  y: number;

  button: number;
  action: "press" | "release";
}






export const mouseByteState = { active: false };


export const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_DISABLE = "\x1b[?1000l\x1b[?1006l";

const SGR_START = "\x1b[<";

const MAX_BUFFER = 1024;

export interface SgrParser {

  push(chunk: string): MouseEventData[];

  readonly hasPending: boolean;

  readonly remainder: string;

  reset(): void;
}





export function createSgrParser(maxBuffer = MAX_BUFFER): SgrParser {
  let buffer = "";
  let remainder = "";
  return {
    push(chunk: string): MouseEventData[] {
      const events: MouseEventData[] = [];
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf(SGR_START)) !== -1) {
        const endPress = buffer.indexOf("M", idx + 3);
        const endRelease = buffer.indexOf("m", idx + 3);
        let stop = -1;
        let isPress = true;
        if (endPress === -1 && endRelease === -1) break;
        if (endPress !== -1 && (endRelease === -1 || endPress < endRelease)) {
          stop = endPress;
        } else {
          stop = endRelease;
          isPress = false;
        }
        const seq = buffer.slice(idx + 3, stop);
        const parts = seq.split(";").map((s) => Number.parseInt(s, 10));
        if (parts.length >= 3 && parts.every((n) => Number.isFinite(n))) {
          const [button, x, y] = parts;
          events.push({ x, y, button, action: isPress ? "press" : "release" });
        }
        buffer = buffer.slice(0, idx) + buffer.slice(stop + 1);
      }


      const pendingStart = buffer.indexOf(SGR_START);
      if (pendingStart === -1) {
        remainder = buffer;
        buffer = "";
      } else {
        remainder = buffer.slice(0, pendingStart);
        buffer = buffer.slice(pendingStart);

        if (buffer.length > maxBuffer) {
          const start = buffer.lastIndexOf(SGR_START);
          buffer = start === -1 ? buffer.slice(-maxBuffer) : buffer.slice(start);
        }
      }
      return events;
    },
    get hasPending(): boolean {
      return buffer.includes(SGR_START);
    },
    get remainder(): string {
      return remainder;
    },
    reset(): void {
      buffer = "";
      remainder = "";
    },
  };
}






export function useMouse(onEvent: (e: MouseEventData) => void): void {
  const { internal_eventEmitter } = useStdin();
  const { stdout } = useStdout();
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    const parser = createSgrParser();

    const handleInput = (chunk: unknown) => {
      const chunkStr = typeof chunk === "string" ? chunk : String(chunk);

      if (!chunkStr.includes("\x1b")) {
        parser.reset();
        mouseByteState.active = false;
        return;
      }
      const events = parser.push(chunkStr);


      mouseByteState.active = parser.remainder === "";
      for (const e of events) {
        handlerRef.current(e);
      }
    };


    internal_eventEmitter?.prependListener("input", handleInput);
    stdout.write(MOUSE_ENABLE);
    return () => {
      internal_eventEmitter?.removeListener("input", handleInput);
      stdout.write(MOUSE_DISABLE);
    };
  }, [internal_eventEmitter, stdout]);
}