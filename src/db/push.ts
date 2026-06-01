import { db } from "./client";

export interface PushSubscriptionRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: string;
}

export function addPushSubscription(endpoint: string, p256dh: string, auth: string, userAgent: string | null) {
  db.run(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent) VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
    [endpoint, p256dh, auth, userAgent]
  );
}

export function getPushSubscriptions(): PushSubscriptionRow[] {
  return db.query<PushSubscriptionRow, []>(`SELECT * FROM push_subscriptions ORDER BY created_at DESC`).all();
}

export function deletePushSubscription(endpoint: string) {
  db.run(`DELETE FROM push_subscriptions WHERE endpoint = ?`, [endpoint]);
}

export function countPushSubscriptions(): number {
  return db.query<{ c: number }, []>(`SELECT COUNT(*) c FROM push_subscriptions`).get()?.c || 0;
}
