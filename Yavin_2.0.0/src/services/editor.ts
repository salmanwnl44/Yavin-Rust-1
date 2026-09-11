export interface TextSelection {
  text: string;
  start: number;
  end: number;
}
export interface TextHistory {
  past: TextSelection[];
  future: TextSelection[];
}

export function replaceSelection(value: TextSelection, replacement: string): TextSelection {
  const text = value.text.slice(0, value.start) + replacement + value.text.slice(value.end);
  const caret = value.start + replacement.length;
  return { text, start: caret, end: caret };
}

export function selectLine(value: TextSelection): TextSelection {
  const start = value.start === 0 ? 0 : value.text.lastIndexOf("\n", value.start - 1) + 1;
  const next = value.text.indexOf("\n", value.end > value.start ? value.end - 1 : value.end);
  return { ...value, start, end: next < 0 ? value.text.length : next + 1 };
}

export function duplicateSelection(value: TextSelection): TextSelection {
  if (value.start !== value.end) {
    const selected = value.text.slice(value.start, value.end);
    return {
      text: value.text.slice(0, value.end) + selected + value.text.slice(value.end),
      start: value.end,
      end: value.end + selected.length,
    };
  }
  const line = selectLine(value);
  const selected = line.text.slice(line.start, line.end);
  const copy = selected.endsWith("\n") ? selected : "\n" + selected;
  return {
    text: line.text.slice(0, line.end) + copy + line.text.slice(line.end),
    start: line.end,
    end: line.end + copy.length,
  };
}

export function recordEdit(history: TextHistory, before: TextSelection): void {
  history.past.push(before);
  history.future = [];
  // Bound snapshots by both count and text size for large documents.
  let size = history.past.reduce((sum, item) => sum + item.text.length, 0);
  while (history.past.length > 1 && (history.past.length > 100 || size > 4_000_000)) {
    size -= history.past.shift()!.text.length;
  }
}

export function stepHistory(
  history: TextHistory,
  current: TextSelection,
  direction: "undo" | "redo",
): TextSelection | undefined {
  const source = direction === "undo" ? history.past : history.future;
  const target = direction === "undo" ? history.future : history.past;
  const next = source.pop();
  if (next) target.push(current);
  return next;
}
