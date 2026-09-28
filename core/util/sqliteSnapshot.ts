import sqlite3 from "sqlite3";

function closeDatabase(database: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    database.close((error) => (error ? reject(error) : resolve()));
  });
}

function openDatabase(
  filename: string,
  mode: number,
): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(filename, mode, (error) => {
      if (error) reject(error);
      else resolve(database);
    });
  });
}

/** Create a consistent SQLite snapshot, including committed WAL-only rows. */
export async function createConsistentSqliteSnapshot(
  source: string,
  destination: string,
): Promise<void> {
  const database = await openDatabase(source, sqlite3.OPEN_READONLY);
  try {
    await new Promise<void>((resolve, reject) => {
      database.run("VACUUM main INTO ?", [destination], (error) =>
        error ? reject(error) : resolve(),
      );
    });
  } finally {
    await closeDatabase(database);
  }

  const snapshot = await openDatabase(destination, sqlite3.OPEN_READONLY);
  try {
    const integrity = await new Promise<string>((resolve, reject) => {
      snapshot.get(
        "PRAGMA quick_check",
        (error: Error | null, row: { quick_check?: string } | undefined) => {
          if (error) reject(error);
          else resolve(row?.quick_check ?? "");
        },
      );
    });
    if (integrity !== "ok") {
      throw new Error(`SQLite snapshot failed quick_check: ${integrity}`);
    }
  } finally {
    await closeDatabase(snapshot);
  }
}
