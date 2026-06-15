import { db } from "./client";

export function getConfig() {
  const rows = db.query<{key: string, value: string}, []>(`SELECT key, value FROM config`).all();
  // Mutación en sitio en vez de spread por fila (evita la copia O(n²) del acc).
  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
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
