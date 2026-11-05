
import crypto from "crypto";

const COOKIE_NAME = "urzhar_driver_session";

function getDriverSession(req, secret) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(
    new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`)
  );

  if (!match) return null;

  const parts = match[1].split(".");
  if (parts.length !== 3) return null;

  const [driverId, expiresText, receivedSignature] = parts;
  const expires = Number(expiresText);

  if (
    !/^[0-9a-f-]{36}$/i.test(driverId) ||
    !Number.isFinite(expires) ||
    expires <= Date.now() ||
    !/^[a-f0-9]{64}$/i.test(receivedSignature)
  ) {
    return null;
  }

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(`urzhar-driver:${driverId}:${expires}`)
    .digest("hex");

  const received = Buffer.from(receivedSignature, "hex");
  const expected = Buffer.from(expectedSignature, "hex");

  if (
    received.length !== expected.length ||
    !crypto.timingSafeEqual(received, expected)
  ) {
    return null;
  }

  return driverId;
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      message: "Тек GET сұранысы қабылданады"
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

    const driverId = getDriverSession(req, serviceKey);

    if (!driverId) {
      return res.status(401).json({
        success: false,
        message: "Жүргізуші жүйеге кірмеген"
      });
    }

    const cleanUrl = supabaseUrl.replace(/\/$/, "");

    const response = await fetch(
      `${cleanUrl}/rest/v1/drivers?id=eq.${encodeURIComponent(driverId)}&select=id,full_name,phone,car_brand,car_model,car_number,car_class,is_active&limit=1`,
      {
        method: "GET",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          Accept: "application/json"
        }
      }
    );

    if (!response.ok) {
      return res.status(502).json({
        success: false,
        message: "Дерекқормен байланыс қатесі"
      });
    }

    const drivers = await response.json();
    const driver = drivers[0];

    if (!driver || !driver.is_active) {
      return res.status(401).json({
        success: false,
        message: "Жүргізуші аккаунты белсенді емес"
      });
    }

    return res.status(200).json({
      success: true,
      driver: {
        id: driver.id,
        full_name: driver.full_name,
        phone: driver.phone,
        car_brand: driver.car_brand,
        car_model: driver.car_model,
        car_number: driver.car_number,
        car_class: driver.car_class
      }
    });

  } catch (error) {
    console.error("Driver session error:", error);

    return res.status(500).json({
      success: false,
      message: "Сервер қатесі"
    });
  }
}
