
import crypto from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function verifyAdmin(req) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return false;

  const cookie = req.headers.cookie || "";
  const item = cookie
    .split(";")
    .map(v => v.trim())
    .find(v => v.startsWith("urzhar_admin_session="));

  if (!item) return false;

  const token = item.substring("urzhar_admin_session=".length);
  const parts = token.split(".");
  if (parts.length !== 2) return false;

  const [expiresText, signature] = parts;
  const expires = Number(expiresText);

  if (!Number.isSafeInteger(expires) || expires <= Date.now()) {
    return false;
  }

  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;

  const expected = crypto
    .createHmac("sha256", password)
    .update("urzhar-admin:" + expires)
    .digest("hex");

  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function supabase(path, options = {}) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    }
  );

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    console.error("Supabase error:", data);
    throw new Error("Дерекқор қатесі");
  }

  return data;
}

function getWeek(createdAt) {
  // Қазақстан уақыты: UTC+5
  const shifted = new Date(
    new Date(createdAt).getTime() + 5 * 60 * 60 * 1000
  );

  const day = shifted.getUTCDay();
  const mondayOffset = (day + 6) % 7;

  const mondayUtc = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() - mondayOffset
  );

  const start = new Date(mondayUtc - 5 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);

  return {
    week_start: start.toISOString(),
    week_end: end.toISOString()
  };
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (!verifyAdmin(req)) {
    return res.status(401).json({
      success: false,
      message: "Әкімші жүйесіне қайта кіріңіз"
    });
  }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({
      success: false,
      message: "Supabase баптаулары табылмады"
    });
  }

  try {
    // Апталық комиссияны төленді деп белгілеу
    if (req.method === "POST") {
      const {
        driver_id,
        week_start,
        week_end
      } = req.body || {};

      const start = Date.parse(week_start);
      const end = Date.parse(week_end);

      if (
        typeof driver_id !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(driver_id) ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start ||
        end - start > 7 * 24 * 60 * 60 * 1000 + 1000
      ) {
        return res.status(400).json({
          success: false,
          message: "Жүргізуші немесе апта деректері қате"
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
          message: "Бұл аптада төленбеген комиссия жоқ"
        });
      }

      const total = updated.reduce(
        (sum, row) => sum + Number(row.commission_amount || 0),
        0
      );

      return res.status(200).json({
        success: true,
        message: "Комиссия төленді деп белгіленді",
        rides_count: updated.length,
        commission_paid: Number(total.toFixed(2))
      });
    }

    // Комиссия есебін алу
    if (req.method === "GET") {
      const commissions = await supabase(
        "driver_commissions?select=id,driver_id,order_id,ride_price,commission_amount,status,created_at,paid_at&order=created_at.desc&limit=5000"
      );

      const drivers = await supabase(
        "drivers?select=id,full_name,phone"
      );

      const driverMap = new Map(
        drivers.map(driver => [driver.id, driver])
      );

      const groups = new Map();

      for (const row of commissions) {
        const week = getWeek(row.created_at);
        const key = `${row.driver_id}_${week.week_start}`;

        if (!groups.has(key)) {
          const driver = driverMap.get(row.driver_id) || {};

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
        const price = Number(row.ride_price || 0);
        const commission = Number(row.commission_amount || 0);

        group.rides_count += 1;
        group.gross_total += price;
        group.commission_total += commission;

        if (row.status === "paid") {
          group.paid_total += commission;
        } else {
          group.unpaid_total += commission;
        }
      }

      const result = Array.from(groups.values())
        .map(group => ({
          ...group,
          gross_total: Number(group.gross_total.toFixed(2)),
          commission_total: Number(group.commission_total.toFixed(2)),
          unpaid_total: Number(group.unpaid_total.toFixed(2)),
          paid_total: Number(group.paid_total.toFixed(2))
        }))
        .sort((a, b) =>
          b.week_start.localeCompare(a.week_start)
        );

      return res.status(200).json({
        success: true,
        commissions: result
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
      message: "Комиссия есебін алу кезінде сервер қатесі"
    });
  }
}
