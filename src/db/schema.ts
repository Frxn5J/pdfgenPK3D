// Barrel: re-exporta todos los módulos de DB para mantener compatibilidad
// con los imports existentes en admin.ts, public.ts y pwa.ts.
export { db, initDb } from "./client";
export * from "./config";
export * from "./push";
export * from "./catalog";
export * from "./quotes";
export * from "./finance";
export * from "./users";
export * from "./portal";
