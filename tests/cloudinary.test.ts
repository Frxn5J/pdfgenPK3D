import { describe, test, expect } from "bun:test";
import { isCloudinaryEnabled, isCloudinaryUrl, cloudinaryTransformed, migrateLocalImagesToCloudinary } from "../src/lib/cloudinary";

describe("Cloudinary", () => {
  test("sin variables de entorno queda deshabilitado (fallback local)", () => {
    expect(isCloudinaryEnabled()).toBe(false);
  });

  test("isCloudinaryUrl distingue URLs de Cloudinary", () => {
    expect(isCloudinaryUrl("https://res.cloudinary.com/demo/image/upload/v1/catalogo/x.png")).toBe(true);
    expect(isCloudinaryUrl("/uploads/x.png")).toBe(false);
    expect(isCloudinaryUrl("https://makerworld.bblmw.com/x.png")).toBe(false);
  });

  test("cloudinaryTransformed inserta f_auto,q_auto y ancho", () => {
    expect(cloudinaryTransformed("https://res.cloudinary.com/demo/image/upload/v1/catalogo/x.png", 800))
      .toBe("https://res.cloudinary.com/demo/image/upload/f_auto,q_auto,w_800/v1/catalogo/x.png");
  });

  test("migración es no-op cuando Cloudinary no está configurado", async () => {
    await migrateLocalImagesToCloudinary(); // no debe lanzar ni tocar la DB
  });
});
