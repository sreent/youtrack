/**
 * Writes the golden record's outputs (see golden.ts): every answer the engine gives each recorded input.
 * Run with tsx, after record.config.ts has written the inputs.
 */
import { answers, readEntries, render, writeOutput } from './golden';

let n = 0;
for (const { name, entry } of readEntries()) {
  writeOutput(name, render(answers(entry)));
  n++;
}
console.log(`Wrote ${n} golden outputs`);
