// Production evals: run the LLM judge over recent real conversations and store
// the verdict on each session, so the staff dashboard can surface bad chats.
// Those chats become new simulated scenarios (the feedback loop).
//
//   npm run evals:prod              # judge sessions not judged yet (last 50)
//   npm run evals:prod -- --all     # re-judge the last 50

import "dotenv/config";
import { closeDb, db } from "../src/lib/db";
import { judgeAvailable, judgeProvider, judgeSession } from "../src/lib/judge";
import { PRACTICES, withPractice } from "../src/lib/practice";

async function main() {
  if (!judgeAvailable()) {
    console.error(`No API key for judge provider "${judgeProvider().provider}". Set ${judgeProvider().provider.toUpperCase()}_API_KEY in .env.`);
    process.exitCode = 1;
    return;
  }
  const all = process.argv.includes("--all");
  const sessions = await db.all<{ id: string; practice_id: number }>(
    `SELECT s.id, s.practice_id FROM sessions s
     WHERE (SELECT count(*) FROM messages m WHERE m.session_id = s.id AND m.role = 'user') >= 2 ${all ? "" : "AND s.judge IS NULL"}
     ORDER BY s.last_active_at DESC LIMIT 50`,
  );
  console.log(`Judging ${sessions.length} conversations with ${judgeProvider().provider}:${judgeProvider().model}…`);
  let flagged = 0;
  for (const s of sessions) {
    const practice = PRACTICES.find((p) => p.id === s.practice_id) ?? PRACTICES[0];
    const v = await withPractice(practice, () => judgeSession(s.id));
    await db.run("UPDATE sessions SET judge = $1 WHERE id = $2", [JSON.stringify(v), s.id]);
    if (!v.pass) flagged++;
    console.log(`${v.pass ? "ok  " : "FLAG"} ${s.id.slice(0, 8)} tone=${v.tone} clarity=${v.clarity} redundancy=${v.redundancy}${v.hallucination ? " HALLUCINATION" : ""}${v.policy_violations.length ? ` violations=${v.policy_violations.join("; ")}` : ""}`);
  }
  console.log(`\n${flagged}/${sessions.length} flagged. Review them on /staff and turn real failures into eval scenarios.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
