import { serve } from "bun";
import { app } from "./src/app";

const port = process.env.PORT || 3000;

console.log(`Server starting on port ${port}...`);
serve({
  fetch: app.fetch,
  port,
  idleTimeout: 30, // segundos para requests largos (generación PDF con Playwright)
});