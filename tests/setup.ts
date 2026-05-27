// Preload de tests (ver bunfig.toml). Corre ANTES de que se cargue cualquier
// módulo bajo prueba, así que aquí fijamos el entorno aislado.
import { mock } from "bun:test";

// 1) Base de datos en memoria: schema.ts lee CATALOG_DB_PATH al importarse.
process.env.CATALOG_DB_PATH = ":memory:";

// 2) Mock global de web-push para no hacer peticiones de red reales. Los tests
//    leen/controlan el estado vía globalThis.
const g = globalThis as any;
g.__webpushSent = [];          // payloads efectivamente "enviados"
g.__webpushNextError = null;   // si se setea, sendNotification lanza ese error
g.__webpushVapidPublic = "TEST_VAPID_PUBLIC_KEY_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

mock.module("web-push", () => ({
  default: {
    generateVAPIDKeys: () => ({ publicKey: g.__webpushVapidPublic, privateKey: "TEST_VAPID_PRIVATE_KEY" }),
    setVapidDetails: () => {},
    sendNotification: async (subscription: any, payload: any) => {
      if (g.__webpushNextError) throw g.__webpushNextError;
      g.__webpushSent.push({ subscription, payload });
      return { statusCode: 201 };
    },
  },
}));
