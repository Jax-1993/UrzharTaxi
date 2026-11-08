import crypto from "crypto";

function getDriverId(req, secret) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)urzhar_driver_session=([^;]+)/);

  if (!match) return null;

  let parts;
  try {
    parts = decodeURIComponent(match[1]).split(".");
  } catch {
    return null;
  }

  if (parts.length !== 3) return null;

  const [driverId, expiresText, signature] = parts;
  const expires = Number(expiresText);

  if (
    !/^[0-9a-f-]{36}$/i.test(driverId) ||
    !Number.isFinite(expires) ||
    expires <= Date.now() ||
    !/^[a-f0-9]{64}$/i.test(signature)
  ) return null;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`urzhar-driver:${driverId}:${expires}`)
    .digest("hex");

  const received = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  if (
    received.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(received, expectedBuffer)
  ) return null;

  return driverId;
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

    const driverId = getDriverId(req, serviceKey);

    if (!driverId) {
      return res.status(401).json({
        success: false,
        message: "Жүргізуші сессиясы расталмады"
      });
    }

    const { orderId, latitude, longitude } = req.body || {};

    const validId =
      typeof orderId === "string" &&
      /^[0-9a-f-]{36}$/i.test(orderId);

    const lat = Number(latitude);
    const lon = Number(longitude);

    if (
      !validId ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < -90 || lat > 90 ||
      lon < -180 || lon > 180
    ) {
      return res.status(400).json({
        success: false,
        message: "GPS деректері дұрыс емес"
      });
    }

    const baseUrl = supabaseUrl.replace(/\/$/, "");
    const url = new URL(`${baseUrl}/rest/v1/orders`);

    url.searchParams.set("id", `eq.${orderId}`);
    url.searchParams.set("driver_id", `eq.${driverId}`);
    url.searchParams.set("status", "in.(accepted,in_progress)");
    url.searchParams.set("select", "id");

    const response = await fetch(url.toString(), {
      method: "PATCH",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        driver_current_latitude: lat,
        driver_current_longitude: lon,
        driver_location_updated_at: new Date().toISOString()
      })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      console.error("Driver GPS database error:", response.status, data);
      return res.status(500).json({
        success: false,
        message: "GPS дерегін сақтау қатесі"
      });
    }

    if (!Array.isArray(data) || data.length === 0) {
      return res.status(403).json({
        success: false,
        message: "Белсенді тапсырыс табылмады"
      });
    }

    return res.status(200).json({
      success: true,
      message: "GPS координаталары сақталды"
    });

  } catch (error) {
    console.error("Driver GPS error:", error.message);

    return res.status(500).json({
      success: false,
      message: "GPS сервер қатесі"
    });
  }
}
