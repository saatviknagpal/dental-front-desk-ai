// npm run seed -- rebuilds the demo database from scratch.
import "dotenv/config";
import { closeDb } from "../src/lib/db";
import { seed } from "../src/lib/seed";

seed({ reset: true })
  .then(() => console.log(`Seeded ${process.env.DATABASE_URL ? "DATABASE_URL" : "local PGlite"}`))
  .finally(() => closeDb());
