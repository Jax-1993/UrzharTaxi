
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

function clearSession(res) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`
  );
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
      `${cleanUrl}/rest/v1/drivers?id=eq.${encodeURIComponent(driverId)}&select=id,full_name,phone,car_brand,car_model,car_number,car_class,is_blocked,block_reason&limit=1`,
      {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          Accept: "application/json"
        }
      }
    );

    if (!response.ok) {
      console.error("Driver session DB error:", response.status);

      return res.status(502).json({
        success: false,
        message: "Дерекқормен байланыс қатесі"
      });
    }

    const drivers = await response.json();
    const driver = drivers[0];

    if (!driver) {
      clearSession(res);

      return res.status(401).json({
        success: false,
        message: "Жүргізуші табылмады"
      });
    }

    if (driver.is_blocked === true) {
      clearSession(res);

      return res.status(403).json({
        success: false,
        blocked: true,
        message: "Аккаунтыңыз уақытша бұғатталған",
        reason: driver.block_reason ||
          "Толық ақпарат алу үшін әкімшіге хабарласыңыз"
      });
    }

    return res.status(200).json({
      success: true,
      driver
    });

  } catch (error) {
    console.error("Driver session error:", error);

    return res.status(500).json({
      success: false,
      message: "Сервер қатесі"
    });
  }
}
