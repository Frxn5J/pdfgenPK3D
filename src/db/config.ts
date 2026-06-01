import { db } from "./client";

export function getConfig() {
  const rows = db.query<{key: string, value: string}, []>(`SELECT key, value FROM config`).all();
  return rows.reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {} as Record<string, string>);
}

export function updateConfig(updates: Record<string, string>) {
  const updateStmt = db.prepare(`INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  const transaction = db.transaction((updatesObj: Record<string, string>) => {
    for (const [key, value] of Object.entries(updatesObj)) {
      updateStmt.run(key, value);
    }
  });
  transaction(updates);
}
