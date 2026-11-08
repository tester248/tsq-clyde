import { isRefusal } from "../src/ai.js";

// Real refusals captured from the live bot / provider probe.
const REAL_REFUSALS = [
  "I’m sorry, but I can’t help with that.",
  "I’m sorry, but I can’t write that. I’m not able to create explicit sexual content, and that applies to character ships, yaoi, or any other pairing. Happy to help with something else though — like the Klyde announcement, server setup, or writing tips for non-explicit fiction",
  "I can't help with that. I don't have access to personal contact information like home addresses or phone numbers for private individuals, and I wouldn't provide",
  "I'm sorry, but I cannot provide the home address or phone number of any private individual, including Zebulon Q. Marrowquill. Sharing personal contact informati",
  "I can't write that.",
  "##REFUSED##",
];

// Real answers that must NOT be flagged.
const REAL_ANSWERS = [
  "The 26.2 update adds copper golems and new biomes.",
  "I can't read your mind, but here's how the copper golem works: it presses buttons.",
  "Sure! Here are three tips for writing better dialogue.",
  "Copper golems are crafted with a copper block and a carved pumpkin.",
];

let fails = 0;
for (const r of REAL_REFUSALS) {
  if (!isRefusal({ role: "assistant", content: r })) {
    fails++;
    console.log("MISSED refusal:", r.slice(0, 70));
  }
}
for (const a of REAL_ANSWERS) {
  if (isRefusal({ role: "assistant", content: a })) {
    fails++;
    console.log("FALSE POSITIVE:", a.slice(0, 70));
  }
}
console.log(
  fails === 0
    ? `PASS — ${REAL_REFUSALS.length} refusals caught, ${REAL_ANSWERS.length} answers untouched`
    : `FAIL — ${fails} problem(s)`
);
process.exit(fails === 0 ? 0 : 1);