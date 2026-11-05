
import crypto from "crypto";

export default async function handler(req, res) {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

    if (!SUPABASE_URL || !SERVICE_KEY || !ADMIN_PASSWORD) {
      return res.status(500).json({
        success: false,
        message: "Сервер баптауы толық емес"
      });
    }

    // Әкімші сессиясын тексеру
    const cookies = (req.headers.cookie || "")
      .split(";")
      .map(item => item.trim());

    const sessionCookie = cookies.find(item =>
      item.startsWith("urzhar_admin_session=")
    );

    if (!sessionCookie) {
      return res.status(401).json({
        success: false,
        message: "Әкімші жүйесіне кіріңіз"
      });
    }

    const token = decodeURIComponent(
      sessionCookie.split("=").slice(1).join("=")
    );

    const parts = token.split(".");

    if (parts.length !== 2) {
      return res.status(401).json({
        success: false,
        message: "Әкімші сессиясы дұрыс емес"
      });
    }

    const [expires, signature] = parts;

    if (
      !/^\d+$/.test(expires) ||
      Number(expires) < Date.now()
    ) {
      return res.status(401).json({
        success: false,
        message: "Әкімші сессиясының мерзімі аяқталған"
      });
    }

    const expected = crypto
      .createHmac("sha256", ADMIN_PASSWORD)
      .update(`urzhar-admin:${expires}`)
      .digest("hex");

    const a = Buffer.from(signature, "hex");
    const b = Buffer.from(expected, "hex");

    if (
      a.length !== b.length ||
      !crypto.timingSafeEqual(a, b)
    ) {
      return res.status(401).json({
        success: false,
        message: "Әкімші рұқсаты расталмады"
      });
    }

    const headers = {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json"
    };

    // Әкімші апталық төлемді қабылдаған соң белгілейді
    if (req.method === "POST") {
      const { driverId } = req.body || {};

      const uuidPattern =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      if (
        typeof driverId !== "string" ||
        !uuidPattern.test(driverId)
      ) {
        return res.status(400).json({
          success: false,
          message: "Жүргізуші нөмірі дұрыс емес"
        });
      }

      const paymentResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/driver_commissions?driver_id=eq.${driverId}&status=eq.unpaid`,
        {
          method: "PATCH",
          headers: {
            ...headers,
            Prefer: "return=representation"
          },
          body: JSON.stringify({
            status: "paid",
            paid_at: new Date().toISOString()
          })
        }
      );

      if (!paymentResponse.ok) {
        throw new Error("Төлемді белгілеу қатесі");
      }

      const paidRows = await paymentResponse.json();

      const totalPaid = paidRows.reduce(
        (sum, row) => sum + Number(row.commission_amount || 0),
        0
      );

      return res.status(200).json({
        success: true,
        message: "Комиссия төленді деп белгіленді",
        driverId,
        rides: paidRows.length,
        totalPaid
      });
    }

    if (req.method !== "GET") {
      return res.status(405).json({
        success: false,
        message: "GET немесе POST қолданыңыз"
      });
    }

    // Төленбеген комиссияларды алу
    const commissionsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/driver_commissions?status=eq.unpaid&select=id,driver_id,order_id,ride_price,commission_amount,created_at&order=created_at.desc`,
      { headers }
    );

    if (!commissionsResponse.ok) {
      throw new Error("Комиссия есебін алу қатесі");
    }

    const commissions = await commissionsResponse.json();

    // Жүргізушілер тізімін алу
    const driversResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/drivers?select=id,full_name,phone`,
      { headers }
    );

    if (!driversResponse.ok) {
      throw new Error("Жүргізушілерді алу қатесі");
    }

    const drivers = await driversResponse.json();

    const report = {};

    for (const driver of drivers) {
      report[driver.id] = {
        driverId: driver.id,
        fullName: driver.full_name,
        phone: driver.phone,
        rides: 0,
        totalEarnings: 0,
        commissionDue: 0
      };
    }

    for (const row of commissions) {
      if (!report[row.driver_id]) continue;

      report[row.driver_id].rides += 1;
      report[row.driver_id].totalEarnings +=
        Number(row.ride_price || 0);
      report[row.driver_id].commissionDue +=
        Number(row.commission_amount || 0);
    }

    const driversReport = Object.values(report)
      .filter(driver => driver.rides > 0)
      .map(driver => ({
        ...driver,
        totalEarnings: Math.round(driver.totalEarnings * 100) / 100,
        commissionDue: Math.round(driver.commissionDue * 100) / 100
      }));

    const totalCommission = driversReport.reduce(
      (sum, driver) => sum + driver.commissionDue,
      0
    );

    return res.status(200).json({
      success: true,
      drivers: driversReport,
      totalDrivers: driversReport.length,
      totalUnpaidCommission:
        Math.round(totalCommission * 100) / 100
    });

  } catch (error) {
    console.error("Admin commissions error:", error);

    return res.status(500).json({
      success: false,
      message: "Сервер қатесі"
    });
  }
}
