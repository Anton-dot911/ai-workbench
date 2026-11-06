import type { Usage } from "../../shared/pricing.js";

/**
 * Читає SSE-потік Anthropic «на льоту» і збирає usage, не змінюючи байти.
 * message_start дає вхідні токени, message_delta — накопичені вихідні.
 * Якщо клієнт обірвав потік раніше, вихід оцінюємо за кількістю символів (з запасом).
 */
export class UsageTracker {
  private buf = "";
  private dec = new TextDecoder();
  private usage: Usage = { input_tokens: 0, output_tokens: 0 };
  private outChars = 0;

  push(chunk: Uint8Array): void {
    this.buf += this.dec.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = this.buf.search(/\r?\n\r?\n/)) !== -1) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx).replace(/^\r?\n\r?\n/, "");
      this.event(raw);
    }
  }

  private event(raw: string): void {
    const data = raw
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    let ev: any;
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    if (ev.type === "message_start" && ev.message?.usage) this.merge(ev.message.usage);
    else if (ev.type === "message_delta" && ev.usage) this.merge(ev.usage);
    else if (ev.type === "content_block_delta") {
      const d = ev.delta;
      if (d?.type === "text_delta") this.outChars += d.text?.length ?? 0;
      else if (d?.type === "input_json_delta") this.outChars += d.partial_json?.length ?? 0;
      else if (d?.type === "thinking_delta") this.outChars += d.thinking?.length ?? 0;
    }
  }

  private merge(u: Partial<Usage>): void {
    const cur = this.usage;
    for (const k of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] as const) {
      const v = u[k];
      if (typeof v === "number") cur[k] = Math.max(cur[k] ?? 0, v);
    }
    if (u.server_tool_use) cur.server_tool_use = u.server_tool_use;
  }

  /** Підсумковий usage; вихід не менший за оцінку з символів (≈1 токен на 3 символи). */
  result(): Usage {
    const estimated = Math.ceil(this.outChars / 3);
    return { ...this.usage, output_tokens: Math.max(this.usage.output_tokens, estimated) };
  }
}
