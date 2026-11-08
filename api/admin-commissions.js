
import crypto from "crypto";

function verifyAdmin(req, password) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(
    /(?:^|;\s*)urzhar_admin_session=([^;]+)/
  );

  if (!match) return false;

  const parts = match[1].split(".");
  if (parts.length !== 2) return false;

  const expires = Number(parts[0]);
  const receivedSignature = parts[1];

  if (!Number.isFinite(expires) || expires <= Date.now()) {
    return false;
  }

  if (!/^[a-f0-9]{64}$/i.test(receivedSignature)) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac("sha256", password)
    .update("urzhar-admin:" + expires)
    .digest("hex");

  const received = Buffer.from(receivedSignature, "hex");
  const expected = Buffer.from(expectedSignature, "hex");

  return received.length === expected.length &&
    crypto.timingSafeEqual(received, expected);
}

async function supabase(path, options = {}) {
  const url = process.env.SUPABASE_URL.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const body = await response.text();
  let data = null;

  try {
    data = body ? JSON.parse(body) : null;
  } catch {
    data = body;
  }

  if (!response.ok) {
    console.error("Supabase error:", data);
    throw new Error("Дерекқор қатесі");
  }

  return data;
}

function getWeek(dateValue) {
  const date = new Date(
    new Date(dateValue).getTime() + 5 * 60 * 60 * 1000
  );

  const day = date.getUTCDay();
  const offset = (day + 6) % 7;

  const monday = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() - offset
  );

  const start = new Date(monday - 5 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 7 * 86400000);

  return {
    week_start: start.toISOString(),
    week_end: end.toISOString()
  };
}

function validDriverId(id) {
  return typeof id === "string" &&
    /^[0-9a-f-]{36}$/i.test(id);
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  const password = process.env.ADMIN_PASSWORD;

  if (
    !password ||
    !process.env.SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    return res.status(500).json({
      success: false,
      message: "Сервер баптаулары толық емес"
    });
  }

  if (!verifyAdmin(req, password)) {
    return res.status(401).json({
      success: false,
      message: "Әкімші жүйесіне қайта кіріңіз"
    });
  }

  try {
    // GET: комиссиялар, жүргізушілер немесе жеке хаттар
    if (req.method === "GET") {
      const action = req.query?.action;
      const driverId = req.query?.driver_id;

      // Әкімші мен жүргізуші арасындағы хаттарды оқу
      if (action === "messages") {
        if (!validDriverId(driverId)) {
          return res.status(400).json({
            success: false,
            message: "Жүргізуші ID қате"
          });
        }

        const messages = await supabase(
          `driver_messages?select=id,driver_id,sender_role,message_type,message,created_at,read_at&driver_id=eq.${encodeURIComponent(driverId)}&order=created_at.asc&limit=200`
        );

        return res.status(200).json({
          success: true,
          messages: messages || []
        });
      }

      const [commissions, drivers] = await Promise.all([
        supabase(
          "driver_commissions?select=id,driver_id,order_id,ride_price,commission_amount,status,created_at,paid_at&order=created_at.desc&limit=5000"
        ),
        supabase("drivers?select=id,full_name,phone")
      ]);

      const driverMap = new Map(
        drivers.map(d => [d.id, d])
      );

      const groups = new Map();
      const history = new Map();

      for (const row of commissions) {
        const week = getWeek(row.created_at);
        const driver = driverMap.get(row.driver_id) || {};
        const price = Number(row.ride_price || 0);
        const commission = Number(row.commission_amount || 0);

        const key = row.driver_id + "_" + week.week_start;

        if (!groups.has(key)) {
          groups.set(key, {
            driver_id: row.driver_id,
            driver_name: driver.full_name || "Белгісіз жүргізуші",
            driver_phone: driver.phone || "",
            ...week,
            rides_count: 0,
            gross_total: 0,
            commission_total: 0,
            unpaid_total: 0,
            paid_total: 0
          });
        }

        const group = groups.get(key);

        group.rides_count++;
        group.gross_total += price;
        group.commission_total += commission;

        if (row.status === "paid") {
          group.paid_total += commission;

          const paidAt = row.paid_at || null;
          const historyKey =
            row.driver_id + "_" +
            week.week_start + "_" +
            (paidAt || "unknown");

          if (!history.has(historyKey)) {
            history.set(historyKey, {
              driver_id: row.driver_id,
              driver_name: driver.full_name || "Белгісіз жүргізуші",
              driver_phone: driver.phone || "",
              week_start: week.week_start,
              week_end: week.week_end,
              paid_at: paidAt,
              rides_count: 0,
              paid_total: 0
            });
          }

          const payment = history.get(historyKey);
          payment.rides_count++;
          payment.paid_total += commission;
        } else {
          group.unpaid_total += commission;
        }
      }

      const result = Array.from(groups.values())
        .map(g => ({
          ...g,
          gross_total: Number(g.gross_total.toFixed(2)),
          commission_total: Number(g.commission_total.toFixed(2)),
          unpaid_total: Number(g.unpaid_total.toFixed(2)),
          paid_total: Number(g.paid_total.toFixed(2))
        }))
        .sort((a, b) =>
          b.week_start.localeCompare(a.week_start)
        );

      const paymentHistory = Array.from(history.values())
        .map(p => ({
          ...p,
          paid_total: Number(p.paid_total.toFixed(2))
        }))
        .sort((a, b) =>
          (b.paid_at || "").localeCompare(a.paid_at || "")
        );

      return res.status(200).json({
        success: true,
        commissions: result,
        payment_history: paymentHistory,
        drivers: drivers || []
      });
    }

    // POST: хабарлама жіберу немесе комиссияны төленді деп белгілеу
    if (req.method === "POST") {
      const body = req.body || {};

      // Әкімшіден жүргізушіге жеке хабарлама
      if (body.action === "send_message") {
        const driver_id = body.driver_id;
        const message = String(body.message || "").trim();
        const message_type = body.message_type || "text";

        if (!validDriverId(driver_id)) {
          return res.status(400).json({
            success: false,
            message: "Жүргізуші ID қате"
          });
        }

        if (!message || message.length > 2000) {
          return res.status(400).json({
            success: false,
            message: "Хабарлама 1–2000 таңба болуы керек"
          });
        }

        if (!["text", "admin_notice"].includes(message_type)) {
          return res.status(400).json({
            success: false,
            message: "Хабарлама түрі қате"
          });
        }

        const driver = await supabase(
          `drivers?select=id&id=eq.${encodeURIComponent(driver_id)}&limit=1`
        );

        if (!driver || driver.length === 0) {
          return res.status(404).json({
            success: false,
            message: "Жүргізуші табылмады"
          });
        }

        const saved = await supabase("driver_messages", {
          method: "POST",
          headers: {
            Prefer: "return=representation"
          },
          body: JSON.stringify({
            driver_id,
            sender_role: "admin",
            message_type,
            message
          })
        });

        return res.status(200).json({
          success: true,
          message: "Хабарлама жіберілді",
          data: saved?.[0] || null
        });
      }

      // Бұрынғы комиссия төлемін растау қызметі
      const {
        driver_id,
        week_start,
        week_end
      } = body;

      const start = Date.parse(week_start);
      const end = Date.parse(week_end);

      if (
        !validDriverId(driver_id) ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start ||
        end - start > 7 * 86400000 + 1000
      ) {
        return res.status(400).json({
          success: false,
          message: "Апта деректері қате"
        });
      }

      const query =
        `driver_id=eq.${encodeURIComponent(driver_id)}` +
        `&status=eq.unpaid` +
        `&created_at=gte.${encodeURIComponent(week_start)}` +
        `&created_at=lt.${encodeURIComponent(week_end)}`;

      const updated = await supabase(
        `driver_commissions?${query}`,
        {
          method: "PATCH",
          headers: {
            Prefer: "return=representation"
          },
          body: JSON.stringify({
            status: "paid",
            paid_at: new Date().toISOString()
          })
        }
      );

      if (!updated || updated.length === 0) {
        return res.status(409).json({
          success: false,
          message: "Төленбеген комиссия табылмады"
        });
      }

      const total = updated.reduce(
        (sum, row) =>
          sum + Number(row.commission_amount || 0),
        0
      );

      return res.status(200).json({
        success: true,
        message: "Комиссия төленді деп белгіленді",
        rides_count: updated.length,
        commission_paid: Number(total.toFixed(2))
      });
    }

    return res.status(405).json({
      success: false,
      message: "GET немесе POST қолданыңыз"
    });

  } catch (error) {
    console.error("Admin commissions error:", error);

    return res.status(500).json({
      success: false,
      message: "Комиссия немесе хабарлама бөлімінде сервер қатесі"
    });
  }
}
