import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { initDb, db, getConfig, addPushSubscription, countPushSubscriptions } from "../src/db/schema";
import { getVapidPublicKey, ensureVapidKeys, sendPushToAll } from "../src/pwa";

const g = globalThis as any;

beforeAll(() => {
  initDb();
});

beforeEach(() => {
  db.run("DELETE FROM push_subscriptions");
  g.__webpushSent = [];
  g.__webpushNextError = null;
});

describe("VAPID", () => {
  test("genera y persiste las claves en config (mockeadas)", () => {
    const pub = getVapidPublicKey();
    expect(pub).toBe(g.__webpushVapidPublic);
    expect(getConfig().vapid_public_key).toBe(pub);
    expect(getConfig().vapid_private_key).toBeTruthy();
  });

  test("ensureVapidKeys es idempotente (no regenera)", () => {
    const a = ensureVapidKeys();
    const b = ensureVapidKeys();
    expect(a.publicKey).toBe(b.publicKey);
    expect(a.privateKey).toBe(b.privateKey);
  });
});

describe("sendPushToAll", () => {
  test("sin suscripciones devuelve sent/total en 0 y no envía nada", async () => {
    const res = await sendPushToAll({ title: "Hola", body: "Mundo" });
    expect(res).toEqual({ sent: 0, total: 0 });
    expect(g.__webpushSent).toHaveLength(0);
  });

  test("envía a todas las suscripciones y reporta sent=total", async () => {
    addPushSubscription("https://push.example/a", "pa", "aa", null);
    addPushSubscription("https://push.example/b", "pb", "ab", null);
    const res = await sendPushToAll({ title: "Nueva cotización #5", body: "Cliente · 10 pzas" });
    expect(res).toEqual({ sent: 2, total: 2 });
    expect(g.__webpushSent).toHaveLength(2);
    // El payload serializado incluye el título y un icono por defecto.
    const payload = JSON.parse(g.__webpushSent[0].payload);
    expect(payload.title).toBe("Nueva cotización #5");
    expect(payload.icon).toBeTruthy();
  });

  test("limpia suscripciones muertas (410) y reporta sent=0", async () => {
    addPushSubscription("https://push.example/dead", "p", "a", null);
    expect(countPushSubscriptions()).toBe(1);
    g.__webpushNextError = { statusCode: 410 };
    const res = await sendPushToAll({ title: "x", body: "y" });
    expect(res.sent).toBe(0);
    expect(res.total).toBe(1);
    expect(countPushSubscriptions()).toBe(0); // se borró la caducada
  });

  test("un error que NO es 404/410 no borra la suscripción", async () => {
    addPushSubscription("https://push.example/keep", "p", "a", null);
    g.__webpushNextError = { statusCode: 500 };
    const res = await sendPushToAll({ title: "x", body: "y" });
    expect(res.sent).toBe(0);
    expect(countPushSubscriptions()).toBe(1); // sigue ahí
  });
});
