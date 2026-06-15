#!/bin/sh
# Patrón canónico Docker para contenedores que necesitan:
#   1. Arrancar como root para corregir ownership de volúmenes montados.
#   2. Ejecutar la app como usuario sin privilegios.
#
# El volumen catalog_data puede tener ownership de root si fue creado por
# una imagen anterior que no incluía el chown. gosu hace el switch de forma
# segura (equivalente a sudo -u bun --preserve-env exec "$@").
set -e

DATA_DIR=/app/data

# Corregir ownership si el volumen fue montado con permisos de root
chown -R bun:bun "$DATA_DIR"
mkdir -p "$DATA_DIR/uploads"

# Bajar al usuario bun y ejecutar el comando (bun run index.ts)
exec gosu bun "$@"
