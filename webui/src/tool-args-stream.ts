// Arguments of a tool call whose JSON text is still arriving: the card names the
// target file as soon as the path appears, and the write card shows the content
// while the model is still emitting it. Wire input: the deltas are arbitrary
// fragments of the argument JSON, so every value may be an unterminated prefix.
// pi sends delta-only `message_update` records (json.md "Reconstruct streaming
// messages"), so the card cannot borrow the provider's partial arguments.

/** Argument keys pi's file tools use for their target path. */
const PATH_KEYS = new Set(["path", "file_path", "filePath"]);

export type StreamedPath = {
  key: string;
  value: string;
  /** The value's closing quote has arrived: later deltas cannot change it. */
  complete: boolean;
};

/** Values readable from a partially streamed argument object. */
export type StreamedArgs = {
  path: StreamedPath | null;
  /** Decoded prefix of a `content` argument (write); null until it starts. */
  content: string | null;
};

/**
 * Read the arguments of the top-level object in `raw`, which is the argument
 * JSON received so far. Only top-level keys are read and strings are skipped as
 * strings, so a written file that itself contains `"path":` is never mistaken
 * for the argument.
 */
export function readStreamedArgs(raw: string): StreamedArgs {
  const args: StreamedArgs = { path: null, content: null };
  /** Key whose value is being read, at the top level of the object. */
  let key: string | null = null;
  /** Whether the top level is at a key or at its value. */
  let position: "key" | "value" = "key";
  let depth = 0;
  let at = 0;
  while (at < raw.length) {
    const char = raw[at]!;
    if (char === '"') {
      const text = readString(raw, at + 1);
      if (depth === 1) {
        if (position === "key") key = text.value;
        else assign(args, key, text.value, text.complete);
      }
      // Nothing after a string that is still streaming is readable yet.
      if (!text.complete) break;
      at = text.end + 1;
      continue;
    }
    if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
    else if (depth === 1 && char === ":") position = "value";
    else if (depth === 1 && char === ",") position = "key";
    at++;
  }
  return args;
}

function assign(args: StreamedArgs, key: string | null, value: string, complete: boolean): void {
  if (key === "content") {
    if (args.content === null) args.content = value;
    return;
  }
  if (key !== null && PATH_KEYS.has(key) && args.path === null) args.path = { key, value, complete };
}

/**
 * Decode the JSON string literal that starts at `start` (just past the opening
 * quote). An unterminated literal yields the prefix decoded so far instead of
 * failing. `end` is the index of the closing quote when the literal is complete.
 */
function readString(raw: string, start: number): { value: string; complete: boolean; end: number } {
  let end = start;
  while (end < raw.length && raw[end] !== '"') {
    if (raw[end] === "\\") end++; // the escaped char is never the terminator
    end++;
  }
  const complete = end < raw.length;
  return { value: decodeBody(raw.slice(start, end)), complete, end };
}

/** The tail that an escape split across two deltas leaves behind. */
const PARTIAL_ESCAPE = /\\u[0-9a-fA-F]{0,3}$|\\$/;

/**
 * Unescape the body of a JSON string. A body cut inside an escape (`\` or a
 * `\uXXXX` the delta boundary split) drops that escape and decodes the rest;
 * a body that still does not parse is shown as it arrived.
 */
function decodeBody(body: string): string {
  try {
    return JSON.parse(`"${body}"`) as string;
  } catch {
    try {
      return JSON.parse(`"${body.replace(PARTIAL_ESCAPE, "")}"`) as string;
    } catch {
      return body;
    }
  }
}
