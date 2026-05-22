# PIXKEY3D Catalog Generator

Un sistema completo para generar y administrar un catálogo de productos de impresión 3D, incluyendo configuración de precios por volumen y generación amigable para impresión/PDF.

## Requisitos

- [Bun](https://bun.sh) (v1.0+)

## Instalación y Ejecución Local

1. Instalar dependencias:
   ```bash
   bun install
   ```

2. Iniciar el servidor:
   ```bash
   bun run index.ts
   ```

El servidor iniciará en `http://localhost:3000`.

La base de datos SQLite y las imágenes subidas se guardarán automáticamente en la carpeta `data/` que se crea al iniciar.

## Administración

- **URL:** `http://localhost:3000/admin`
- **Usuario por defecto:** `Frxn5J`

La contraseña se configura con la variable de entorno `ADMIN_PASSWORD`. Por seguridad no se versiona una contraseña real en GitHub.

Para local, copia `.env.example` a `.env` y define tus valores:

```bash
ADMIN_USERNAME=Frxn5J
ADMIN_PASSWORD=tu_contraseña
SESSION_SECRET=un_string_largo_y_aleatorio
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=tu_api_key
LLM_MODEL=gpt-4o-mini
LLM_TEMPERATURE=0.7
LLM_DESCRIPTION_MAX_WORDS=45
```

## IA para Descripciones de Catálogo

En los formularios de producto y en el importador de MakerWorld hay un botón **Adaptar a catálogo con IA**. Este toma la descripción actual y la transforma en un texto comercial en español, más descriptivo y orientado a venta, antes de guardar el producto.

La integración usa una API compatible con OpenAI Chat Completions y se configura por entorno:

- `LLM_BASE_URL`: URL base compatible con OpenAI, por defecto `https://api.openai.com/v1`.
- `LLM_API_KEY`: API key del proveedor.
- `LLM_MODEL`: modelo a usar, por defecto `gpt-4o-mini`.
- `LLM_TEMPERATURE`: creatividad del texto, por defecto `0.7`.
- `LLM_DESCRIPTION_MAX_WORDS`: límite máximo de palabras para que la descripción quepa en la tarjeta de producto, por defecto `45`.

## Personalización Visual

Desde `Admin > Configuración` puedes modificar la identidad visual del catálogo sin tocar código:

- Nombre, logo, subtítulo de portada y título de productos.
- Colores de marca: primario, secundario y acento.
- Fondos y colores por sección: portada, bienvenida, productos, contacto, tarjetas y tablas.
- Tipografías para textos y encabezados.
- Carga de archivos de fuente para textos y encabezados (`.woff`, `.woff2`, `.ttf`, `.otf`).
- Redondeos, sombras, estilo de tarjetas, densidad del layout y ajuste de imágenes.
- Formas decorativas: activar/desactivar, tipo, color, opacidad y blur.
- Vista previa del documento dentro del admin, con modo desktop/móvil.
- CSS personalizado avanzado junto a la vista previa, aplicado en vivo antes de guardar.

Todas estas opciones se guardan en SQLite dentro de la tabla `config`.

## Despliegue con Docker / Coolify

El proyecto incluye un `Dockerfile` y un `docker-compose.yml` listos para usar, ideales para plataformas como Coolify.

**Variables de entorno recomendadas para producción:**
- `NODE_ENV=production`
- `ADMIN_USERNAME=tu_usuario`
- `ADMIN_PASSWORD=tu_contraseña_segura` *(obligatoria)*
- `SESSION_SECRET=un_string_largo_y_aleatorio`

**Persistencia de datos:**
El contenedor utiliza un volumen montado en `/app/data`. Asegúrate de que tu plataforma de despliegue (Coolify) mantenga este volumen para no perder los datos de SQLite (`catalog.sqlite`) ni las imágenes subidas (`/app/data/uploads`).

## Funciones de PDF
La vista pública del catálogo (`/`) cuenta con un botón en la esquina superior derecha que permite imprimir el catálogo. El sistema utiliza reglas CSS (`@media print`) para optimizar la vista de impresión, forzando saltos de página y ocultando elementos de interfaz innecesarios. Desde el diálogo de impresión de cualquier navegador moderno, puedes elegir "Guardar como PDF".
