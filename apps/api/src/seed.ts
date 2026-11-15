import { openDb, upsertItem } from "./db.js";
import { SEED_ITEMS } from "./seed-data.js";

const database = openDb();

database.exec("BEGIN");
try {
  for (const item of SEED_ITEMS) {
    upsertItem(database, {
      id: item.id,
      title: item.title,
      titleNl: item.titleNl ?? null,
      category: item.category,
      startYear: item.startYear,
      endYear: item.endYear === undefined ? item.startYear : item.endYear,
      description: item.description ?? null,
      descriptionNl: null,
      wikipediaUrl: item.wikipediaUrl ?? null,
      wikipediaUrlNl: null,
      wikidataId: item.wikidataId ?? null,
    });
  }
  database.exec("COMMIT");
} catch (err) {
  database.exec("ROLLBACK");
  throw err;
}

console.log(`Seeded ${SEED_ITEMS.length} items into ${process.env.SQLITE_PATH ?? "./data/historizon.sqlite"}`);
