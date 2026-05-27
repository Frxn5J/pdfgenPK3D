import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import {
  initDb,
  db,
  addPushSubscription,
  getPushSubscriptions,
  deletePushSubscription,
  countPushSubscriptions,
} from "../src/db/schema";

beforeAll(() => {
  initDb();
});

beforeEach(() => {
  db.run("DELETE FROM push_subscriptions");
});

describe("push_subscriptions CRUD", () => {
  test("agrega y cuenta suscripciones", () => {
    expect(countPushSubscriptions()).toBe(0);
    addPushSubscription("https://push.example/a", "p256dh-a", "auth-a", "UA/1.0");
    addPushSubscription("https://push.example/b", "p256dh-b", "auth-b", null);
    expect(countPushSubscriptions()).toBe(2);
    const all = getPushSubscriptions();
    expect(all.map((s) => s.endpoint).sort()).toEqual(["https://push.example/a", "https://push.example/b"]);
  });

  test("ON CONFLICT por endpoint: refresca llaves en vez de duplicar", () => {
    addPushSubscription("https://push.example/a", "old-p", "old-auth", "UA/1.0");
    addPushSubscription("https://push.example/a", "new-p", "new-auth", "UA/2.0");
    expect(countPushSubscriptions()).toBe(1);
    const sub = getPushSubscriptions()[0]!;
    expect(sub.p256dh).toBe("new-p");
    expect(sub.auth).toBe("new-auth");
    expect(sub.user_agent).toBe("UA/2.0");
  });

  test("elimina por endpoint", () => {
    addPushSubscription("https://push.example/a", "p", "auth", null);
    addPushSubscription("https://push.example/b", "p", "auth", null);
    deletePushSubscription("https://push.example/a");
    expect(countPushSubscriptions()).toBe(1);
    expect(getPushSubscriptions()[0]!.endpoint).toBe("https://push.example/b");
  });

  test("eliminar un endpoint inexistente no rompe", () => {
    addPushSubscription("https://push.example/a", "p", "auth", null);
    deletePushSubscription("https://push.example/nope");
    expect(countPushSubscriptions()).toBe(1);
  });
});
