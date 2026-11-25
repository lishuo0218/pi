// JSONL framing for the pi RPC stream: split raw stdout chunks on LF only.
// Node readline is forbidden here: it also splits on U+2028/U+2029, which are
// valid inside JSON strings (protocol docs: rpc.md "Framing").
export type FrameHandler = (line: string) => void;

const CR = 13;

export class FrameDecoder {
  private buf = "";
  private handler: FrameHandler;

  constructor(handler: FrameHandler) {
    this.handler = handler;
  }

  /** Feed raw bytes (as they arrive from stdout); decodes incrementally. */
  push(chunk: Buffer): void {
    this.buf += chunk.toString("utf8");
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      let line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.length > 0 && line.charCodeAt(line.length - 1) === CR) {
        line = line.slice(0, -1);
      }
      if (line.length > 0) {
        this.handler(line);
      }
    }
  }

  /** Flush a trailing line without LF (should not happen with a well-behaved pi). */
  end(): void {
    if (this.buf.length > 0) {
      const line = this.buf;
      this.buf = "";
      this.handler(line);
    }
  }
}
