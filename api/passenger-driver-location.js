import crypto from "crypto";

function safeEqual(a, b) {
  const first = Buffer.from(a);
  const second = Buffer.from(b);

  return first.length === second.length &&
    crypto.timingSafeEqual(first, second);
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Тек POST сұранысы қабылданады"
    });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceKey) {
      return res.status(500).json({
        success: false,
        message: "Сервер баптаулары толық емес"
      });
    }

    const { orderId, trackingToken } = req.body || {};

    if (
      typeof orderId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(orderId) ||
      typeof trackingToken !== "string" ||
      trackingToken.length < 32 ||
      trackingToken.length > 200
    ) {
      return res.status(400).json({
        success: false,
        message: "Тапсырыс немесе бақылау коды дұрыс емес"
      });
    }

    const tokenHash = crypto
      .createHash("sha256")
      .update(trackingToken)
      .digest("hex");

    const baseUrl = supabaseUrl.replace(/\/$/, "");
    const url = new URL(`${baseUrl}/rest/v1/orders`);

    url.searchParams.set("id", `eq.${orderId}`);
    url.searchParams.set(
      "status",
      "in.(accepted,in_progress)"
    );
    url.searchParams.set(
      "select",
      "driver_current_latitude,driver_current_longitude,driver_location_updated_at,passenger_tracking_token_hash"
    );
    url.searchParams.set("limit", "1");

    const response = await fetch(url.toString(), {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Accept: "application/json"
      }
    });

    const rows = await response.json().catch(() => null);

    if (!response.ok) {
      console.error("Passenger GPS database error:", response.status);
      return res.status(500).json({
        success: false,
        message: "GPS дерегін алу қатесі"
      });
    }

    const order = Array.isArray(rows) ? rows[0] : null;

    if (
      !order ||
      typeof order.passenger_tracking_token_hash !== "string" ||
      !safeEqual(tokenHash, order.passenger_tracking_token_hash)
    ) {
      return res.status(403).json({
        success: false,
        message: "Бақылау рұқсаты расталмады"
      });
    }

    return res.status(200).json({
      success: true,
      location: {
        latitude: order.driver_current_latitude,
        longitude: order.driver_current_longitude,
        updated_at: order.driver_location_updated_at
      }
    });

  } catch (error) {
    console.error("Passenger driver GPS error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Сервер қатесі"
    });
  }
}
