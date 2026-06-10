# Refactor: sistem-refactor

## Estado actual

Rama: `sistem-refactor` (pusheada a GitHub)
Tests: 33 pass / 6 fail (los 6 fallos son pre-existentes, no causados por el refactor)

---

## Lo que ya está hecho

### ✅ Fase 1 — Split de `src/db/schema.ts`
`schema.ts` (1,138 líneas) dividido en módulos de dominio. `schema.ts` ahora es un barrel de 7 líneas que re-exporta todo para mantener compatibilidad con imports existentes.

```
src/db/
├── client.ts   — instancia db + initDb()
├── config.ts   — getConfig, updateConfig
├── push.ts     — push subscriptions CRUD
├── catalog.ts  — categories, subcategories, products, price tiers
├── quotes.ts   — quotes, items, printers, filaments
├── finance.ts  — expenses, payments, financial summary
├── users.ts    — multi-user roles
└── schema.ts   — barrel (re-exporta todo, NO tocar)
```

### ✅ Fase 2 — Extracción de utilidades a `src/lib/`
`admin.ts` pasó de 6,664 a ~5,393 líneas. Las utilidades puras están en:

```
src/lib/
├── session.ts      — SessionData, signSession, verifySession, requireAuth, requireRole
├── html.ts         — formString, formFile, escapeHtml, saveUpload, configValue
├── formatting.ts   — money, plainMoney, volumeText, renderStatusBadge, quoteFolio, formatDate
├── text.ts         — stripTags, cleanText, metaContent, tagText, uniqueImages
├── llm.ts          — settingValue, llmConfig, parseLlmContent, parseLlmError, buildModelChain
├── makerworld.ts   — scrapeMakerWorld, scrapeMakerWorldCollection, fetchViaFlareSolverr
├── image-enhance.ts — enhanceImageForCatalog, callImageEditProvider, imageEnhanceConfig
├── design.ts       — adaptDescriptionForCatalog, generateDesign, refineDesign, parseAdaptedJson
└── pricing.ts      — bodyValues, parsePriceTiers, renderPriceTierRows
```

---

## Lo que falta

### 🔲 Fase 3 — Extraer vistas de `admin.ts` a `src/views/admin/`

Las funciones que generan HTML del panel admin todavía viven en `admin.ts`:

| Módulo a crear | Qué mover desde admin.ts |
|---|---|
| `views/admin/layout.ts` | `AdminLayout()`, `buildAdminThemeCss()`, `adminCssValue()`, `adminFontFace()`, `adminFontStack()` |
| `views/admin/product-form.ts` | `renderDescriptionField()`, `renderCategoryFields()`, `renderPricingEditor()` + el script JS de IA cliente |
| `views/admin/quote-form.ts` | Formulario de cotización manual + design modal + JS embebido |

### 🔲 Fase 4 — Separar rutas de `admin.ts` en `src/routes/admin/`

El archivo `admin.ts` aún tiene ~5,393 líneas mezclando todas las rutas.
Separar por feature en archivos individuales:

```
src/routes/admin/
├── index.ts      — monta todos los sub-routers, aplica requireAuth global
├── auth.ts       — GET/POST /login, POST /logout
├── products.ts   — CRUD /products
├── categories.ts — CRUD /categorias + /subcategorias
├── quotes.ts     — /quotes list + /quotes/new (cotización manual)
├── config.ts     — GET/POST /config (7 tabs)
├── users.ts      — CRUD /usuarios
├── makerworld.ts — GET/POST /makerworld + /makerworld/save
├── ai.ts         — /description/adapt, /design/*, /image/enhance
├── push.ts       — /push/* y /notificaciones
└── finances.ts   — rutas financieras
```

Actualizar `src/app.ts` para importar desde `routes/admin/index.ts`.

### 🔲 Fase 5 — Extraer vistas de `public.ts` a `src/views/catalog/`

`public.ts` (~1,087 líneas) mezcla theme engine, templates y rutas:

```
src/views/catalog/
├── layout.ts   — Layout(), buildThemeCss(), renderShapes()
├── sections.ts — renderCoverSection(), renderWelcomeSection(), renderProductsSection(), etc.
└── cart.ts     — renderCartSection(), renderShopScript(), buildQuoteMessage()
```

`public.ts` quedará solo con handlers de ruta (~100 líneas).

---

## Reglas importantes

- `db/schema.ts` es el barrel — **no agregar código ahí**, solo exports
- Los 6 tests que fallan son **pre-existentes** (auth de push) — no son regressions
- Cada fase termina con `bun test` en verde antes de commit
- Todo en rama `sistem-refactor`, merge a `main` cuando esté completo
- Sin cambios funcionales — solo reorganización de código

## Comandos útiles

```bash
# Correr tests
bun test

# Ver tamaño actual de admin.ts
wc -l src/routes/admin.ts

# Ver estructura actual
ls src/lib/ src/db/ src/routes/
```
