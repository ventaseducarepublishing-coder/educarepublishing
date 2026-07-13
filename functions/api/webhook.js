const productos = {
  recien_nacido: {
    title: "Guía Completa del Primer Año del Bebé",
    price: 39990,
  },

  sopas_caseras: {
    title: "Las Mejores Sopas del Mundo",
    price: 29990,
  },

  lactancia_materna: {
    title: "Lactancia Materna",
    price: 8990,
  },
};

export async function onRequestPost({ request, env }) {
  try {
    /*
     * Mercado Pago espera una respuesta rápida.
     * Primero leemos la notificación.
     */
    const url = new URL(request.url);

    let notification = {};

    try {
      notification = await request.json();
    } catch {
      notification = {};
    }

    const paymentId =
      notification?.data?.id ||
      url.searchParams.get("data.id") ||
      url.searchParams.get("id");

    const notificationType =
      notification?.type ||
      url.searchParams.get("type") ||
      url.searchParams.get("topic");

    /*
     * Ignoramos eventos que no sean de pagos.
     */
    if (
      notificationType &&
      notificationType !== "payment"
    ) {
      return Response.json({
        received: true,
        ignored: true,
      });
    }

    if (!paymentId) {
      return Response.json(
        {
          received: true,
          message: "Notificación sin payment ID",
        },
        {
          status: 200,
        }
      );
    }

    if (
      !env.MERCADOPAGO_ACCESS_TOKEN ||
      !env.PUBLIC_SUPABASE_URL ||
      !env.SUPABASE_SERVICE_ROLE_KEY
    ) {
      console.error(
        "Faltan variables necesarias para el webhook"
      );

      return Response.json(
        {
          error: "Configuración incompleta",
        },
        {
          status: 500,
        }
      );
    }

    /*
     * Consultamos el pago real en Mercado Pago.
     * Nunca aprobamos una compra usando solamente
     * el contenido recibido en el webhook.
     */
    const paymentResponse = await fetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        headers: {
          Authorization:
            `Bearer ${env.MERCADOPAGO_ACCESS_TOKEN}`,
        },
      }
    );

    const payment = await paymentResponse.json();

    if (!paymentResponse.ok) {
      console.error(
        "No fue posible consultar el pago:",
        payment
      );

      return Response.json(
        {
          error: "No fue posible validar el pago",
        },
        {
          status: 500,
        }
      );
    }

    const reference =
      String(payment.external_reference || "");

    const [userId, productId] =
      reference.split("|");

    const producto = productos[productId];

    if (!userId || !producto) {
      console.error(
        "Referencia de pago inválida:",
        reference
      );

      return Response.json(
        {
          error: "Referencia de pago inválida",
        },
        {
          status: 400,
        }
      );
    }

    /*
     * Verificamos que el valor pagado corresponda
     * al precio definido en el servidor.
     */
    const amount = Number(
      payment.transaction_amount
    );

    if (amount !== producto.price) {
      console.error(
        "El monto no coincide:",
        amount,
        producto.price
      );

      return Response.json(
        {
          error: "El monto pagado no coincide",
        },
        {
          status: 400,
        }
      );
    }

    const purchase = {
      user_id: userId,
      product_id: productId,
      product_title: producto.title,
      amount,
      currency: payment.currency_id || "CLP",
      payment_id: String(payment.id),
      status: String(payment.status || "unknown"),
      buyer_email:
        payment.payer?.email || null,

      approved_at:
        payment.status === "approved"
          ? payment.date_approved
          : null,
    };

    /*
     * Upsert para evitar compras duplicadas si
     * Mercado Pago vuelve a enviar el mismo webhook.
     */
    const supabaseResponse = await fetch(
      `${env.PUBLIC_SUPABASE_URL}/rest/v1/purchases?on_conflict=payment_id`,
      {
        method: "POST",

        headers: {
          apikey:
            env.SUPABASE_SERVICE_ROLE_KEY,

          Authorization:
            `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

          "Content-Type": "application/json",

          Prefer:
            "resolution=merge-duplicates,return=minimal",
        },

        body: JSON.stringify(purchase),
      }
    );

    if (!supabaseResponse.ok) {
      const details =
        await supabaseResponse.text();

      console.error(
        "Supabase rechazó la compra:",
        details
      );

      return Response.json(
        {
          error:
            "No fue posible registrar la compra",

          details,
        },
        {
          status: 500,
        }
      );
    }

    return Response.json({
      received: true,
      payment_id: payment.id,
      status: payment.status,
    });
  } catch (error) {
    console.error("Error en webhook:", error);

    return Response.json(
      {
        error: "Error procesando el webhook",

        details:
          error instanceof Error
            ? error.message
            : String(error),
      },
      {
        status: 500,
      }
    );
  }
}

export function onRequestGet() {
  return Response.json({
    ok: true,
    mensaje:
      "Webhook de Mercado Pago operativo",
  });
}