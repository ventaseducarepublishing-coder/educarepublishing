
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import sitemap from "@astrojs/sitemap";

const paginasExcluidas = new Set([
  "/login",
  "/registro",
  "/mi-biblioteca",
  "/nueva-contrasena",
  "/recuperar-contrasena",
  "/ebook/detalle",
  "/ebook/sopas-del-mundo",
]);

export default defineConfig({
  site: "https://educarepublishing.cl",

  adapter: cloudflare(),

  integrations: [
    sitemap({
      filter: (page) => {
        const ruta =
          new URL(page).pathname.replace(/\/+$/, "") || "/";

        // Excluir todo el panel de administración
        if (ruta === "/admin" || ruta.startsWith("/admin/")) {
          return false;
        }

        // Excluir páginas de cuenta y rutas genéricas
        return !paginasExcluidas.has(ruta);
      },
    }),
  ],
});
