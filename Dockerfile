FROM oven/bun:1 as builder

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

# Tailwind CSS compile step if needed, skipping for now since we use CDN in prototype to keep it simple

FROM oven/bun:1-slim

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built assets
COPY --from=builder /app .

# Create volume mount point for sqlite and uploads, propiedad del usuario bun
RUN mkdir -p /app/data/uploads && chown -R bun:bun /app/data

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# No correr como root: la imagen oven/bun trae el usuario sin privilegios "bun".
USER bun

CMD ["bun", "run", "index.ts"]