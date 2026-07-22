import type { APIRoute } from "astro";

export const prerender = false;

type RuntimeEnv = {
  PUBLIC_SUPABASE_URL?: string;
  PUBLIC_SUPABASE_ANON_KEY?: string;
  SUPABASE_SECRET_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
};

type SupabaseUser = {
  id?: string;
  email?: string;
};

type EbookRecord = {
  id: string;
  legacy_product_id: string | null;
  slug: string;
  title: string;
  pdf_path: string | null;
  published: boolean;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function getRuntimeEnv(locals: App.Locals): RuntimeEnv {
  return (
    (
      locals as App.Locals & {
        runtime?: {
          env?: RuntimeEnv;
        };
      }
    ).runtime?.env ?? {}
  );
}

async function validateUser(
  supabaseUrl: string,
  supabaseAnonKey: string,
  accessToken: string
): Promise<SupabaseUser | null> {
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    return null;
  }

  const user = (await response.json()) as SupabaseUser;

  return user.id ? user : null;
}

async function searchEbook(
  supabaseUrl: string,
  serviceRoleKey: string,
  column: "legacy_product_id" | "slug",
  value: string
): Promise<EbookRecord | null> {
  const params = new URLSearchParams({
    select:
      "id,legacy_product_id,slug,title,pdf_path,published",
    [column]: `eq.${value}`,
    published: "eq.true",
    limit: "1",
  });

  const response = await fetch(
    `${supabaseUrl}/rest/v1/ebooks?${params.toString()}`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Accept: "application/json",
      },
    }
  );

  if (!response.ok) {
    const details = await response.text();

    console.error(
      `Error buscando ebook por ${column}:`,
      details
    );

    throw new Error("No se pudo consultar el ebook");
  }

  const ebooks = (await response.json()) as EbookRecord[];

  return ebooks[0] ?? null;
}

async function getEbook(
  supabaseUrl: string,
  serviceRoleKey: string,
  productId: string
): Promise<EbookRecord | null> {
  const byLegacyProductId = await searchEbook(
    supabaseUrl,
    serviceRoleKey,
    "legacy_product_id",
    productId
  );

  if (byLegacyProductId) {
    return byLegacyProductId;
  }

  return searchEbook(
    supabaseUrl,
    serviceRoleKey,
    "slug",
    productId
  );
}

async function hasApprovedPurchase(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
  ebookId: string
): Promise<boolean> {
  const params = new URLSearchParams({
    select: "id",
    user_id: `eq.${userId}`,
    ebook_id: `eq.${ebookId}`,
    status: "eq.approved",
    limit: "1",
  });

  const response = await fetch(
    `${supabaseUrl}/rest/v1/purchases?${params.toString()}`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Accept: "application/json",
      },
    }
  );

  if (!response.ok) {
    const details = await response.text();

    console.error(
      "Error validando la compra aprobada:",
      details
    );

    throw new Error("No se pudo validar la compra");
  }

  const purchases = (await response.json()) as Array<{
    id: string;
  }>;

  return purchases.length > 0;
}

async function createSignedDownloadUrl(
  supabaseUrl: string,
  serviceRoleKey: string,
  pdfPath: string
): Promise<string> {
  /*
   * pdf_path almacena la ruta interna del bucket "ebooks".
   * Ejemplo:
   * guia-de-primeros-auxilios/archivo.pdf
   */
  const encodedPath = pdfPath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

  const response = await fetch(
    `${supabaseUrl}/storage/v1/object/sign/ebooks/${encodedPath}`,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        expiresIn: 300,
      }),
    }
  );

  const data = (await response.json()) as {
    signedURL?: string;
    signedUrl?: string;
    message?: string;
    [key: string]: unknown;
  };

  if (!response.ok) {
    console.error(
      "Error generando URL firmada:",
      data
    );

    throw new Error(
      data.message ||
        "No fue posible preparar la descarga"
    );
  }

  const signedUrl = data.signedURL || data.signedUrl;

  if (!signedUrl) {
    console.error(
      "Supabase no devolvió signedURL:",
      data
    );

    throw new Error(
      "Supabase no devolvió el enlace de descarga"
    );
  }

  return signedUrl.startsWith("http")
    ? signedUrl
    : `${supabaseUrl}/storage/v1${signedUrl}`;
}

export const GET: APIRoute = async () => {
  return json({
    ok: true,
    mensaje: "API de descarga protegida operativa",
  });
};

export const POST: APIRoute = async ({
  request,
  locals,
}) => {
  try {
    const runtimeEnv = getRuntimeEnv(locals);

    const supabaseUrl =
      runtimeEnv.PUBLIC_SUPABASE_URL;

    const supabaseAnonKey =
      runtimeEnv.PUBLIC_SUPABASE_ANON_KEY;

    /*
     * Aceptamos ambos nombres para no romper la
     * configuración que ya tienes en Cloudflare.
     */
    const serviceRoleKey =
      runtimeEnv.SUPABASE_SECRET_KEY ||
      runtimeEnv.SUPABASE_SERVICE_ROLE_KEY;

    if (
      !supabaseUrl ||
      !supabaseAnonKey ||
      !serviceRoleKey
    ) {
      return json(
        {
          error: "Faltan variables del servidor",
        },
        500
      );
    }

    const authorization =
      request.headers.get("Authorization") || "";

    const accessToken =
      authorization.startsWith("Bearer ")
        ? authorization.slice(7).trim()
        : "";

    if (!accessToken) {
      return json(
        {
          error: "Debes iniciar sesión",
        },
        401
      );
    }

    let body: {
      productId?: unknown;
    };

    try {
      body = (await request.json()) as {
        productId?: unknown;
      };
    } catch {
      return json(
        {
          error: "Solicitud inválida",
        },
        400
      );
    }

    const productId = String(
      body.productId || ""
    ).trim();

    if (!productId) {
      return json(
        {
          error: "No se indicó el ebook",
        },
        400
      );
    }

    const user = await validateUser(
      supabaseUrl,
      supabaseAnonKey,
      accessToken
    );

    if (!user?.id) {
      return json(
        {
          error: "La sesión no es válida o expiró",
        },
        401
      );
    }

    /*
     * Localiza automáticamente el libro usando:
     * 1. legacy_product_id para los libros antiguos.
     * 2. slug para los libros creados desde el panel.
     */
    const ebook = await getEbook(
      supabaseUrl,
      serviceRoleKey,
      productId
    );

    if (!ebook) {
      return json(
        {
          error:
            "El ebook no existe o no está publicado",
        },
        404
      );
    }

    if (!ebook.pdf_path?.trim()) {
      return json(
        {
          error:
            "Este ebook todavía no tiene un PDF asociado",
        },
        404
      );
    }

    /*
     * La validación se realiza mediante ebook_id,
     * que identifica de forma única el libro comprado.
     */
    const approved = await hasApprovedPurchase(
      supabaseUrl,
      serviceRoleKey,
      user.id,
      ebook.id
    );

    if (!approved) {
      return json(
        {
          error:
            "No encontramos una compra aprobada para este ebook",
        },
        403
      );
    }

    const downloadUrl =
      await createSignedDownloadUrl(
        supabaseUrl,
        serviceRoleKey,
        ebook.pdf_path.trim()
      );

    return json({
      ok: true,
      url: downloadUrl,
      expiresIn: 300,
      ebook: {
        id: ebook.id,
        slug: ebook.slug,
        title: ebook.title,
      },
    });
  } catch (error) {
    console.error(
      "Error preparando la descarga:",
      error
    );

    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Error preparando la descarga",
      },
      500
    );
  }
};