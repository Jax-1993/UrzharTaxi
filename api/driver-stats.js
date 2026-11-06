import crypto from "crypto";

function getAlmatyWeek(date) {
  const shifted = new Date(date.getTime() + 5 * 60 * 60 * 1000);
  const day = shifted.getUTCDay();
  const daysFromMonday = (day + 6) % 7;

  const monday = new Date(Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() - daysFromMonday
  ));

  const start = new Date(monday.getTime() - 5 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);

  return { start, end };
}

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

    const cookies = (req.headers.cookie || "")
      .split(";")
      .map(x => x.trim());

    const cookie = cookies.find(x =>
      x.startsWith("urzhar_driver_session=")
    );

    if (!cookie) {
      return res.status(401).json({
        success: false,
        message: "Алдымен жүйеге кіріңіз"
      });
    }

    const token = decodeURIComponent(
      cookie.split("=").slice(1).join("=")
    );

    const parts = token.split(".");

    if (parts.length !== 3) {
      return res.status(401).json({
        success: false,
        message: "Сессия дұрыс емес"
      });
    }

    const [driverId, expires, signature] = parts;

    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (
      !uuid.test(driverId) ||
      !/^\d+$/.test(expires) ||
      Number(expires) < Date.now()
    ) {
      return res.status(401).json({
        success: false,
        message: "Сессия мерзімі аяқталған"
      });
    }

    const expected = crypto
      .createHmac("sha256", KEY)
      .update(`urzhar-driver:${driverId}:${expires}`)
      .digest("hex");

    const a = Buffer.from(signature, "hex");
    const b = Buffer.from(expected, "hex");

    if (
      a.length !== b.length ||
      !crypto.timingSafeEqual(a, b)
    ) {
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
        `${URL}/rest/v1/driver_commissions?driver_id=eq.${driverId}&select=commission_amount,status,created_at,paid_at&order=created_at.desc`,
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
      (sum, item) =>
        sum + Number(item.commission_amount || 0),
      0
    );

    const currentWeek = getAlmatyWeek(new Date());

    const weekly = commissions.filter(item => {
      const created = new Date(item.created_at);
      return (
        created >= currentWeek.start &&
        created < currentWeek.end
      );
    });

    const unpaid = weekly
      .filter(item => item.status === "unpaid")
      .reduce(
        (sum, item) =>
          sum + Number(item.commission_amount || 0),
        0
      );

    const paid = weekly
      .filter(item => item.status === "paid")
      .reduce(
        (sum, item) =>
          sum + Number(item.commission_amount || 0),
        0
      );

    // Төленген комиссияларды төлем күні мен аптасы бойынша топтау
    const historyMap = new Map();

    commissions
      .filter(item => item.status === "paid" && item.paid_at)
      .forEach(item => {
        const paidAt = item.paid_at;
        const createdAt = new Date(item.created_at);

        if (Number.isNaN(createdAt.getTime())) return;

        const week = getAlmatyWeek(createdAt);
        const key = `${week.start.toISOString()}|${paidAt}`;

        if (!historyMap.has(key)) {
          historyMap.set(key, {
            weekStart: week.start.toISOString(),
            weekEnd: week.end.toISOString(),
            paidAt,
            amount: 0,
            ridesCount: 0
          });
        }

        const record = historyMap.get(key);
        record.amount += Number(item.commission_amount || 0);
        record.ridesCount += 1;
      });

    const paymentHistory = Array.from(historyMap.values())
      .map(item => ({
        ...item,
        amount: Number(item.amount.toFixed(2))
      }))
      .sort(
        (a, b) =>
          new Date(b.paidAt).getTime() -
          new Date(a.paidAt).getTime()
      );

    return res.status(200).json({
      success: true,
      ridesCount: orders.length,
      grossTotal: Number(gross.toFixed(2)),
      commissionTotal: Number(commissionTotal.toFixed(2)),
      driverEarning: Number(
        (gross - commissionTotal).toFixed(2)
      ),
      weekly: {
        start: currentWeek.start.toISOString(),
        end: currentWeek.end.toISOString(),
        unpaid: Number(unpaid.toFixed(2)),
        paid: Number(paid.toFixed(2))
      },
      paymentHistory
    });

  } catch (error) {
    console.error("Driver stats error:", error);

    return res.status(500).json({
      success: false,
      message: "Статистиканы алу мүмкін болмады"
    });
  }
}
