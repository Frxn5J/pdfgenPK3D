#!/bin/sh
# Garantiza que /app/data sea escribible antes de arrancar la app.
# En Docker, un volumen nombrado puede heredar ownership de root si fue
# creado por una imagen anterior sin chown. Este script detecta el caso
# y lo corrige sin necesidad de reconstruir ni reiniciar manualmente.
set -e

DATA_DIR=/app/data

if [ ! -w "$DATA_DIR" ]; then
  echo "[entrypoint] $DATA_DIR no es escribible — intenta fijar permisos..."
  # Solo funciona si el contenedor arrancó temporalmente como root
  chown -R bun:bun "$DATA_DIR" 2>/dev/null || {
    echo "[entrypoint] ERROR: $DATA_DIR no es escribible y no se pudo corregir."
    echo "[entrypoint] Ejecuta en el host: docker-compose run --rm --user root catalog chown -R bun:bun /app/data"
    exit 1
  }
fi

mkdir -p "$DATA_DIR/uploads"

exec "$@"
