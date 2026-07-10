import { serve } from "bun";
import { app } from "./src/app";

const port = process.env.PORT || 3000;

console.log(`Server starting on port ${port}...`);
serve({
  fetch: app.fetch,
  port,
});
// Migración one-shot en background: sube a Cloudinary las imágenes locales
// existentes y actualiza sus referencias en DB. No bloquea el arranque y es
// idempotente (no-op si Cloudinary no está configurado o ya no hay /uploads).
import { migrateLocalImagesToCloudinary } from "./src/lib/cloudinary";
migrateLocalImagesToCloudinary().catch((error) => {
  console.error("[cloudinary] migración de imágenes falló:", error);
});
