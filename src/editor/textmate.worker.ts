/**
 * Extensions' TextMate grammars, tokenizing in a worker of their own (EXT-25): a grammar's
 * patterns are third-party regular expressions, so they never run on the window's thread. The
 * window ends this worker when a document takes too long (`declarativeMonaco.ts`).
 *
 * In: `{type: "grammars", grammars}` (every enabled grammar), then `{type: "tokenize", id,
 * scopeName, text}`. Out: `{type: "tokens", id, lines, partial}` or `{type: "tokens", id, error}`,
 * and `{type: "problems", problems}` after grammars are given.
 */
import { createTokenizer, type GrammarSource } from "../services/extensions/textmate";

let tokenizer: ReturnType<typeof createTokenizer> | null = null;

self.onmessage = (event: MessageEvent) => {
  const message = event.data as
    | { type: "grammars"; grammars: GrammarSource[] }
    | { type: "tokenize"; id: number; scopeName: string; text: string };
  if (message.type === "grammars") {
    tokenizer = createTokenizer(message.grammars);
    self.postMessage({ type: "problems", problems: tokenizer.problems });
    return;
  }
  try {
    if (!tokenizer) throw new Error("No grammars were given.");
    const result = tokenizer.tokenize(message.scopeName, message.text);
    self.postMessage({ type: "tokens", id: message.id, ...result });
  } catch (error) {
    self.postMessage({
      type: "tokens",
      id: message.id,
      error: String((error as Error).message ?? error),
    });
  }
};
