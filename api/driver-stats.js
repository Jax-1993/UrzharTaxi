
import crypto from "crypto";

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      message: "Тек GET сұранысы қабылданады"
    });
  }

  try {
    const URL = process.env.SUPABASE_URL;
    const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!URL || !KEY) {
      return res.status(500).json({
        success: false,
        message: "Сервер баптауы толық емес"
      });
    }

    const cookies = (req.headers.cookie || "").split(";").map(x => x.trim());
    const cookie = cookies.find(x => x.startsWith("urzhar_driver_session="));

    if (!cookie) {
      return res.status(401).json({
        success: false,
        message: "Алдымен жүйеге кіріңіз"
      });
    }

    const token = decodeURIComponent(cookie.split("=").slice(1).join("="));
    const parts = token.split(".");

    if (parts.length !== 3) {
      return res.status(401).json({
        success: false,
        message: "Сессия дұрыс емес"
      });
    }

    const [driverId, expires, signature] = parts;

    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (!uuid.test(driverId) || !/^\d+$/.test(expires) || Number(expires) < Date.now()) {
      return res.status(401).json({
        success: false,
        message: "Сессия мерзімі аяқталған"
      });
    }

    // driver-login.js кодымен бірдей қолтаңба
    const expected = crypto
      .createHmac("sha256", KEY)
      .update(`urzhar-driver:${driverId}:${expires}`)
      .digest("hex");

    const a = Buffer.from(signature, "hex");
    const b = Buffer.from(expected, "hex");

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({
        success: false,
        message: "Сессия расталмады"
      });
    }

    const headers = {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      Range: "0-9999"
    };

    const driverResponse = await fetch(
      `${URL}/rest/v1/drivers?id=eq.${driverId}&select=id`,
      { headers }
    );

    if (!driverResponse.ok) {
      throw new Error("Жүргізушіні тексеру қатесі");
    }

    const drivers = await driverResponse.json();

    if (!drivers.length) {
      return res.status(403).json({
        success: false,
        message: "Жүргізуші табылмады"
      });
    }

    const [ordersResponse, commissionsResponse] = await Promise.all([
      fetch(
        `${URL}/rest/v1/orders?driver_id=eq.${driverId}&status=eq.completed&select=price,created_at`,
        { headers }
      ),
      fetch(
        `${URL}/rest/v1/driver_commissions?driver_id=eq.${driverId}&select=commission_amount,status,created_at`,
        { headers }
      )
    ]);

    if (!ordersResponse.ok || !commissionsResponse.ok) {
      throw new Error("Статистика деректерін алу қатесі");
    }

    const orders = await ordersResponse.json();
    const commissions = await commissionsResponse.json();

    const gross = orders.reduce(
      (sum, order) => sum + Number(order.price || 0),
      0
    );

    const commissionTotal = commissions.reduce(
      (sum, item) => sum + Number(item.commission_amount || 0),
      0
    );

    const now = new Date();
    const localNow = new Date(now.getTime() + 5 * 60 * 60 * 1000);
    const day = localNow.getUTCDay();
    const daysFromMonday = (day + 6) % 7;

    const monday = new Date(Date.UTC(
      localNow.getUTCFullYear(),
      localNow.getUTCMonth(),
      localNow.getUTCDate() - daysFromMonday
    ));

    const weekStart = new Date(monday.getTime() - 5 * 60 * 60 * 1000);
    const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);

    const weekly = commissions.filter(item => {
      const created = new Date(item.created_at);
      return created >= weekStart && created < weekEnd;
    });

    const unpaid = weekly
      .filter(item => item.status === "unpaid")
      .reduce((sum, item) => sum + Number(item.commission_amount || 0), 0);

    const paid = weekly
      .filter(item => item.status === "paid")
      .reduce((sum, item) => sum + Number(item.commission_amount || 0), 0);

    return res.status(200).json({
      success: true,
      ridesCount: orders.length,
      grossTotal: Number(gross.toFixed(2)),
      commissionTotal: Number(commissionTotal.toFixed(2)),
      driverEarning: Number((gross - commissionTotal).toFixed(2)),
      weekly: {
        start: weekStart.toISOString(),
        end: weekEnd.toISOString(),
        unpaid: Number(unpaid.toFixed(2)),
        paid: Number(paid.toFixed(2))
      }
    });

  } catch (error) {
    console.error("Driver stats error:", error);

    return res.status(500).json({
      success: false,
      message: "Статистиканы алу мүмкін болмады"
    });
  }
}
