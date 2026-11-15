import { openDb, upsertItem } from "./db.js";
import { sparqlSample } from "./wikipedia.js";

const limit = Number(process.argv[2] ?? 40);

async function main(): Promise<void> {
  console.log(`Fetching up to ${limit} war events from Wikidata SPARQL…`);
  const rows = await sparqlSample(limit);
  const database = openDb();

  database.exec("BEGIN");
  try {
    for (const row of rows) {
      upsertItem(database, {
        id: row.id,
        title: row.title,
        titleNl: null,
        category: "war",
        startYear: row.startYear,
        endYear: row.endYear,
        description: null,
        descriptionNl: null,
        wikipediaUrl: row.wikipediaUrl,
        wikipediaUrlNl: null,
        wikidataId: row.wikidataId,
      });
    }
    database.exec("COMMIT");
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }

  console.log(`Ingested ${rows.length} items. Prefer dumps for large backfills.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
