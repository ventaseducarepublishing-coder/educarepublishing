export async function onRequestPost(context) {
  try {
    const { request, env } = context;

    const body = await request.json();

    const response = await fetch(
      "https://api.mercadopago.com/checkout/preferences",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.MERCADOPAGO_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          items: [
            {
              title: body.title,
              quantity: 1,
              currency_id: "CLP",
              unit_price: Number(body.price),
            },
          ],
          back_urls: {
            success: "https://educarepublishing.cl/success",
            failure: "https://educarepublishing.cl/failure",
            pending: "https://educarepublishing.cl/pending",
          },
          auto_return: "approved",
        }),
      }
    );

    const data = await response.json();

    return new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json",
      },
    });

  } catch (error) {

    return new Response(
      JSON.stringify({
        error: error.message,
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

  }
}