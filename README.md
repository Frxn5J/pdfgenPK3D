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
QWEN_IMAGE_ENDPOINT=https://tu-endpoint-imagen.example.com/generate
QWEN_IMAGE_BASE_URL=https://aiapibun.duckdns.org
QWEN_IMAGE_ROUTE=/v1/images/edits
QWEN_IMAGE_API_KEY=opcional_si_tu_endpoint_lo_requiere
QWEN_IMAGE_MODEL=qwen-image-edit
QWEN_IMAGE_TIMEOUT_MS=120000
```

## IA para Descripciones de Catálogo

En los formularios de producto y en el importador de MakerWorld hay un botón **Adaptar a catálogo con IA**. Este toma la descripción actual y la transforma en un texto comercial en español, más descriptivo y orientado a venta, antes de guardar el producto.

La integración usa una API compatible con OpenAI Chat Completions y se configura por entorno:

- `LLM_BASE_URL`: URL base compatible con OpenAI, por defecto `https://api.openai.com/v1`.
- `LLM_API_KEY`: API key del proveedor.
- `LLM_MODEL`: modelo a usar, por defecto `gpt-4o-mini`.
- `LLM_TEMPERATURE`: creatividad del texto, por defecto `0.7`.
- `LLM_DESCRIPTION_MAX_WORDS`: límite máximo de palabras para que la descripción quepa en la tarjeta de producto, por defecto `45`.

## IA para Imágenes de Catálogo

En el importador de MakerWorld hay un botón **Mejorar imagen** debajo de la sección de imágenes. Toma la imagen seleccionada, pegada o subida y la manda al endpoint configurado para generar una foto de catálogo con fondo blanco.

La petición se envía como JSON al endpoint resuelto con `prompt`, `image`, `imageUrl`, `image_url`, `response_format`, `source`, `intent` y `options`. Si `QWEN_IMAGE_API_KEY` existe, se manda como `Authorization: Bearer ...`.

Si tu servicio usa una base compatible con OpenAI, usa:

```env
QWEN_IMAGE_BASE_URL=https://aiapibun.duckdns.org
QWEN_IMAGE_ROUTE=/v1/images/edits
QWEN_IMAGE_MODEL=qwen-image-edit
```

También puedes usar `QWEN_IMAGE_ENDPOINT` como endpoint final completo. Si termina en `/v1`, el sistema lo resuelve automáticamente a `/v1/images/edits`.

Variables disponibles:

- `QWEN_IMAGE_BASE_URL`: base URL del gateway, por ejemplo `https://aiapibun.duckdns.org`.
- `QWEN_IMAGE_ROUTE`: ruta de edición/generación de imagen, por defecto `/v1/images/edits`.
- `QWEN_IMAGE_ENDPOINT`: endpoint final completo. Si se usa base URL, no es necesario.
- `QWEN_IMAGE_API_KEY`: opcional, token bearer para tu endpoint.
- `QWEN_IMAGE_MODEL`: modelo de imagen que debe recibir tu endpoint. Si se deja vacío, no se manda y el endpoint usa su default.
- `QWEN_IMAGE_PROMPT`: opcional. Si no se define, usa un prompt optimizado para producto centrado, fondo blanco, estilo estudio, sin texto ni marcas de agua.
- `QWEN_IMAGE_TIMEOUT_MS`: timeout de la petición, por defecto `120000`.

El sistema intenta guardar localmente la imagen generada en `data/uploads/products` si el endpoint responde con una imagen binaria, data URL, base64 o URL descargable. Si solo devuelve una URL remota no descargable, se usa esa URL en el producto.

## Personalización Visual

Desde `Admin > Configuración` puedes modificar la identidad visual del catálogo sin tocar código:

- Nombre, logo, subtítulo de portada y título de productos.
- WhatsApp de cotizaciones para el carrito público.
- Paquetería, costo de envío estimado y mínimo de piezas para envío gratis.
- Texto de bienvenida y texto de contacto con soporte para HTML administrado.
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
- `QWEN_IMAGE_ENDPOINT=tu_endpoint_de_mejora_de_imagen`

**Persistencia de datos:**
El contenedor utiliza un volumen montado en `/app/data`. Asegúrate de que tu plataforma de despliegue (Coolify) mantenga este volumen para no perder los datos de SQLite (`catalog.sqlite`) ni las imágenes subidas (`/app/data/uploads`).

## Funciones de PDF
La ruta `/imprimir` cuenta con un botón en la esquina superior derecha que permite imprimir el catálogo. El sistema utiliza reglas CSS (`@media print`) para optimizar la vista de impresión, forzando saltos de página y ocultando elementos de interfaz innecesarios. Desde el diálogo de impresión de cualquier navegador moderno, puedes elegir "Guardar como PDF".

## Catálogo con Cotización

La ruta `/catalogo` muestra el catálogo sin botones de admin ni impresión. Cada producto permite agregar cantidades a un carrito. El total se calcula según el volumen total de piezas y las tablas de precios configuradas.

El carrito incluye envío estimado configurable desde admin. Por defecto usa `Estafeta`, `$150 MXN` y envío gratis desde `501` piezas. Al presionar **Cotizar por WhatsApp**, el sistema exige nombre y código postal, guarda la cotización en SQLite y luego abre WhatsApp con el detalle del pedido y folio interno.

Las cotizaciones guardadas se consultan en `Admin > Cotizaciones` (`/admin/quotes`). Incluyen cliente, código postal, piezas, productos, subtotal, envío, total y mensaje enviado a WhatsApp.
