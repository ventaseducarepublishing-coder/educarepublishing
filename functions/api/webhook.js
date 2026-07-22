function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function parseSignatureHeader(value = "") {
  let ts = null;
  let v1 = null;

  for (const segment of value.split(",")) {
    const [rawKey, rawValue] = segment.split("=", 2);
    const key = rawKey?.trim();
    const parsedValue = rawValue?.trim();

    if (key === "ts") ts = parsedValue || null;
    if (key === "v1") v1 = parsedValue || null;
  }

  return { ts, v1 };
}

function bytesToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function safeEqual(first, second) {
  if (first.length !== second.length) return false;

  let difference = 0;

  for (let index = 0; index < first.length; index += 1) {
    difference |= first.charCodeAt(index) ^ second.charCodeAt(index);
  }

  return difference === 0;
}

async function validateSignature({
  dataId,
  requestId,
  signatureHeader,
  secret,
}) {
  const { ts, v1 } = parseSignatureHeader(signatureHeader);

  if (!ts || !v1 || !dataId || !requestId || !secret) {
    return false;
  }

  const normalizedDataId = /[a-z]/i.test(dataId)
    ? dataId.toLowerCase()
    : dataId;

  const manifest =
    `id:${normalizedDataId};` +
    `request-id:${requestId};` +
    `ts:${ts};`;

  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(manifest)
  );

  return safeEqual(bytesToHex(signature), v1);
}

async function readJsonSafely(response) {
  const text = await response.text();

  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return {
      raw_response: text.slice(0, 1000),
    };
  }
}

function getServerSupabaseKey(env) {
  return (
    env.SUPABASE_SECRET_KEY ||
    env.SUPABASE_SERVICE_ROLE_KEY ||
    ""
  );
}

function getPaymentIdentity(payment) {
  const metadataUserId = payment?.metadata?.user_id;
  const metadataProductId = payment?.metadata?.product_id;

  if (metadataUserId && metadataProductId) {
    return {
      userId: String(metadataUserId),
      productId: String(metadataProductId),
    };
  }

  const externalReference = String(
    payment?.external_reference || ""
  );

  const separatorIndex = externalReference.indexOf("|");

  if (separatorIndex === -1) {
    return {
      userId: null,
      productId: null,
    };
  }

  return {
    userId: externalReference.slice(0, separatorIndex) || null,
    productId:
      externalReference.slice(separatorIndex + 1) || null,
  };
}

async function findEbookByProductId({
  env,
  serverKey,
  productId,
}) {
  const select =
    "id,legacy_product_id,slug,title,price,currency,published";

  const headers = {
    apikey: serverKey,
    Authorization: `Bearer ${serverKey}`,
    Accept: "application/json",
  };

  const attempts = [
    `legacy_product_id=eq.${encodeURIComponent(productId)}`,
    `slug=eq.${encodeURIComponent(productId)}`,
  ];

  for (const filter of attempts) {
    const response = await fetch(
      `${env.PUBLIC_SUPABASE_URL}/rest/v1/ebooks` +
        `?select=${encodeURIComponent(select)}` +
        `&${filter}` +
        `&published=eq.true` +
        `&limit=1`,
      { headers }
    );

    const data = await readJsonSafely(response);

    if (!response.ok) {
      console.error(
        "Error consultando ebooks en Supabase:",
        data
      );

      return {
        ebook: null,
        error:
          data?.message ||
          "No se pudo consultar el ebook.",
      };
    }

    if (Array.isArray(data) && data.length > 0) {
      return {
        ebook: data[0],
        error: null,
      };
    }
  }

  return {
    ebook: null,
    error: null,
  };
}

async function upsertPurchase({
  env,
  serverKey,
  purchase,
}) {
  const response = await fetch(
    `${env.PUBLIC_SUPABASE_URL}/rest/v1/purchases` +
      "?on_conflict=payment_id",
    {
      method: "POST",
      headers: {
        apikey: serverKey,
        Authorization: `Bearer ${serverKey}`,
        "Content-Type": "application/json",
        Prefer:
          "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify(purchase),
    }
  );

  const data = await readJsonSafely(response);

  if (!response.ok) {
    return {
      data: null,
      error:
        data?.message ||
        data?.details ||
        "No se pudo guardar la compra.",
    };
  }

  return {
    data,
    error: null,
  };
}

export function onRequestGet() {
  return json({
    ok: true,
    mensaje: "Webhook de Mercado Pago operativo",
  });
}

export async function onRequestPost({ request, env }) {
  try {
    const serverKey = getServerSupabaseKey(env);

    if (
      !env.MERCADOPAGO_ACCESS_TOKEN ||
      !env.PUBLIC_SUPABASE_URL ||
      !serverKey
    ) {
      return json(
        {
          error:
            "Faltan variables privadas del servidor.",
        },
        500
      );
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return json(
        {
          error:
            "La notificación no contiene JSON válido.",
        },
        400
      );
    }

    const url = new URL(request.url);

    const queryPaymentId =
      url.searchParams.get("data.id") ||
      url.searchParams.get("id");

    const paymentId = String(
      queryPaymentId || body?.data?.id || ""
    ).trim();

    const notificationType =
      url.searchParams.get("type") ||
      body?.type ||
      "";

    console.log("Webhook recibido:", {
      paymentId,
      notificationType,
      action: body?.action,
    });

    if (
      notificationType &&
      notificationType !== "payment"
    ) {
      return json({
        received: true,
        ignored: true,
        reason: "Evento distinto de payment.",
      });
    }

    if (!paymentId) {
      return json(
        {
          error:
            "La notificación no contiene el ID del pago.",
        },
        400
      );
    }

    if (env.MERCADOPAGO_WEBHOOK_SECRET) {
      const signatureHeader =
        request.headers.get("x-signature") || "";

      const requestId =
        request.headers.get("x-request-id") || "";

      const validSignature = await validateSignature({
        dataId: queryPaymentId || paymentId,
        requestId,
        signatureHeader,
        secret: env.MERCADOPAGO_WEBHOOK_SECRET,
      });

      if (!validSignature) {
        return json(
          {
            error: "Firma de webhook inválida.",
          },
          401
        );
      }
    }

    const paymentResponse = await fetch(
      `https://api.mercadopago.com/v1/payments/${encodeURIComponent(
        paymentId
      )}`,
      {
        headers: {
          Authorization:
            `Bearer ${env.MERCADOPAGO_ACCESS_TOKEN}`,
          Accept: "application/json",
        },
      }
    );

    const payment =
      await readJsonSafely(paymentResponse);

    if (!paymentResponse.ok) {
      console.error(
        "No se pudo verificar el pago:",
        payment
      );

      return json(
        {
          error:
            "No se pudo verificar el pago en Mercado Pago.",
        },
        502
      );
    }

    const { userId, productId } =
      getPaymentIdentity(payment);

    if (!userId || !productId) {
      return json(
        {
          error:
            "El pago no contiene los datos necesarios para registrar la compra.",
        },
        422
      );
    }

    const { ebook, error: ebookError } =
      await findEbookByProductId({
        env,
        serverKey,
        productId,
      });

    if (ebookError) {
      return json(
        {
          error: ebookError,
        },
        500
      );
    }

    if (!ebook) {
      return json(
        {
          error:
            "No se encontró el ebook asociado al pago.",
        },
        404
      );
    }

    const paidAmount = Number(
      payment?.transaction_amount || 0
    );

    const expectedAmount = Number(
      ebook.price || 0
    );

    const paidCurrency = String(
      payment?.currency_id || ""
    ).toUpperCase();

    const expectedCurrency = String(
      ebook.currency || "CLP"
    ).toUpperCase();

    if (
      !Number.isFinite(paidAmount) ||
      paidAmount <= 0 ||
      paidAmount !== expectedAmount ||
      paidCurrency !== expectedCurrency
    ) {
      return json(
        {
          error:
            "El monto o la moneda del pago no coincide con el ebook.",
        },
        422
      );
    }

    const purchase = {
      user_id: userId,
      ebook_id: ebook.id,
      payment_id: String(
        payment?.id || paymentId
      ),
      preference_id:
        payment?.preference_id || null,
      status:
        payment?.status || "unknown",
      status_detail:
        payment?.status_detail || null,
      amount: paidAmount,
      currency: paidCurrency,
      payer_email:
        payment?.payer?.email || null,
      updated_at: new Date().toISOString(),
      raw_payment: payment,
    };

    const { error: purchaseError } =
      await upsertPurchase({
        env,
        serverKey,
        purchase,
      });

    if (purchaseError) {
      return json(
        {
          error:
            "No se pudo registrar la compra en Supabase.",
          details: purchaseError,
        },
        500
      );
    }

    return json({
      received: true,
      payment_id: purchase.payment_id,
      status: purchase.status,
    });
  } catch (error) {
    console.error(
      "Error inesperado en webhook:",
      error
    );

    return json(
      {
        error:
          "Ocurrió un error inesperado procesando el webhook.",
        details:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500
    );
  }
}
