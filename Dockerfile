FROM oven/bun:1 as builder

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

# Tailwind CSS compile step if needed, skipping for now since we use CDN in prototype to keep it simple

FROM oven/bun:1-slim

# gosu: escalación segura root→bun en el entrypoint (patrón canónico Docker)
RUN apt-get update && apt-get install -y ca-certificates gosu && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built assets
COPY --from=builder /app .

# Create volume mount point for sqlite and uploads, propiedad del usuario bun
RUN mkdir -p /app/data/uploads && chown -R bun:bun /app/data

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# El contenedor arranca como root para que el entrypoint pueda corregir
# permisos del volumen montado, luego baja a "bun" antes de ejecutar la app.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bun", "run", "index.ts"]