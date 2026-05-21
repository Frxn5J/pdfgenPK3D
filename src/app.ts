import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { logger } from "hono/logger";
import { initDb } from "./db/schema";
import { publicRoutes } from "./routes/public";
import { adminRoutes } from "./routes/admin";
import { getCookie, setCookie } from "hono/cookie";
import { join } from "path";
import * as fs from "fs";

// Initialize database
initDb();

const app = new Hono();

app.use("*", logger());

// Ensure upload directory exists
const uploadDir = join(process.cwd(), "data", "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Serve static files
app.use("/public/*", serveStatic({ root: "./src/" }));
app.use("/uploads/*", serveStatic({ root: "./data/" }));
// For Tailwind output
app.use("/styles.css", serveStatic({ path: "./src/public/styles.css" }));

app.route("/", publicRoutes);
app.route("/admin", adminRoutes);

export { app };