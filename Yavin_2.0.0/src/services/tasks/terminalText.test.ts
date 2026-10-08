import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { TerminalText } from "./terminalText.ts";

const lines = (...chunks: string[]) => {
  const text = new TerminalText();
  return [...chunks.flatMap((chunk) => text.push(chunk)), ...text.end()];
};
const E = "\u001b";

test("a move to another row ends the line, as a line break would (ConPTY places lines so)", () => {
  assert.deepEqual(lines(`first${E}[4;1Hsecond${E}[2Bthird${E}[Efourth${E}[7dfifth`), [
    "first",
    "second",
    "third",
    "fourth",
    "fifth",
  ]);
  // The column a move goes to is kept.
  assert.deepEqual(lines(`a${E}[2;5Hb`), ["a", "    b"]);
});

test("cursor-forward is spaces, erased characters are blanks, colours draw nothing", () => {
  assert.deepEqual(lines(`${E}[96msrc/a.ts${E}[m:${E}[93m2${E}[m${E}[3X${E}[3Cx`), [
    "src/a.ts:2   x",
  ]);
});

test("a lone carriage return redraws the line: what is written next replaces what was there", () => {
  // cargo's progress bar, erased and overwritten by the diagnostic.
  assert.deepEqual(
    lines(`    Building [   ] 0/1\r${E}[79X${E}[79C\rerror[E0425]: x\r\n --> a.rs:1:1\r\n`),
    ["error[E0425]: x", " --> a.rs:1:1"],
  );
  // Without erasing, what is not overwritten stays, as on screen.
  assert.deepEqual(lines("12345\rab\n"), ["ab345"]);
  // Erase to the end of the line.
  assert.deepEqual(lines(`12345\rab${E}[K\n`), ["ab"]);
});

test("clearing the screen ends the line; titles and progress (OSC) and modes draw nothing", () => {
  assert.deepEqual(
    lines(`${E}]0;C:\\cmd.exe\u0007${E}[?25lold${E}[2J${E}[3J${E}[Hnew${E}]9;4;1;0${E}\\!`),
    ["old", "new!"],
  );
});

test("a line is one line however wide: wrapping is the terminal's, not the stream's", () => {
  const long = "x".repeat(300);
  assert.deepEqual(lines(long + "\r\n"), [long]);
});

test("a sequence split across chunks reads the same as whole", () => {
  assert.deepEqual(lines("a", E, "[", "4;1", "Hb", `${E}]0;ti`, `tle${E}`, "\\c"), ["a", "bc"]);
});

test("every captured terminal output gives the same lines however it is chunked", () => {
  const dir = new URL("./fixtures/pty/", import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith(".pty"));
  assert.ok(files.length >= 8);
  for (const name of files) {
    const text = readFileSync(new URL(name, dir), "utf8");
    const whole = lines(text);
    assert.deepEqual(lines(...[...text]), whole, `${name}, one character at a time`);
    assert.deepEqual(lines(...(text.match(/[\s\S]{1,7}/g) ?? [])), whole, `${name}, 7 at a time`);
    for (const line of whole) assert.doesNotMatch(line, /\u001b/, `${name}: an escape was left`);
  }
});
