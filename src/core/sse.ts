export interface SSEEvent {
  event: string;
  data: string;
}

function parseBlock(raw: string): SSEEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return data.length ? { event, data: data.join("\n") } : null;
}

/** Розбір Server-Sent Events із потоку байтів; коректно склеює події, розірвані між чанками. */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let m: RegExpMatchArray | null;
      while ((m = buf.match(/\r?\n\r?\n/))) {
        const raw = buf.slice(0, m.index);
        buf = buf.slice((m.index ?? 0) + m[0].length);
        const ev = parseBlock(raw);
        if (ev) yield ev;
      }
    }
    buf += dec.decode();
    if (buf.trim()) {
      const ev = parseBlock(buf);
      if (ev) yield ev;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
