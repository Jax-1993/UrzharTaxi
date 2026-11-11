
import crypto from "crypto";

function getDriverId(req, secret) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(
    /(?:^|;\s*)urzhar_driver_session=([^;]+)/
  );

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
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(driverId) ||
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

async function dbGet(url, key) {
  const response = await fetch(url, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json"
    }
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    console.error("Database error:", response.status, data);
    throw new Error("Дерекқор қатесі");
  }

  return data;
}

// Қазақстан уақытына айналдыру
function addOrderDateTime(order) {
  if (!order.created_at) {
    return {
      ...order,
      order_date: null,
      order_time: null
    };
  }

  const date = new Date(order.created_at);

  if (Number.isNaN(date.getTime())) {
    return {
      ...order,
      order_date: null,
      order_time: null
    };
  }

  return {
    ...order,

    order_date: new Intl.DateTimeFormat("kk-KZ", {
      timeZone: "Asia/Almaty",
      day: "2-digit",
      month: "2-digit",
      year: "numeric"
    }).format(date),

    order_time: new Intl.DateTimeFormat("kk-KZ", {
      timeZone: "Asia/Almaty",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).format(date)
  };
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

    const driverId = getDriverId(req, serviceKey);

    if (!driverId) {
      return res.status(401).json({
        success: false,
        message: "Жүргізуші сессиясы расталмады. Қайта кіріңіз."
      });
    }

    const baseUrl = supabaseUrl.replace(/\/$/, "");

    const driverUrl = new URL(`${baseUrl}/rest/v1/drivers`);
    driverUrl.searchParams.set("id", `eq.${driverId}`);
    driverUrl.searchParams.set("select", "id,full_name");
    driverUrl.searchParams.set("limit", "1");

    const drivers = await dbGet(driverUrl.toString(), serviceKey);
    const driver = drivers?.[0];

    if (!driver) {
      return res.status(403).json({
        success: false,
        message: "Жүргізуші табылмады"
      });
    }

    const newUrl = new URL(`${baseUrl}/rest/v1/orders`);
    newUrl.searchParams.set("status", "eq.searching");
    newUrl.searchParams.set(
      "select",
      "id,pickup_address,destination_address,car_class,distance_km,price,payment_method,status,created_at,pickup_latitude,pickup_longitude,destination_latitude,destination_longitude"
    );
    newUrl.searchParams.set("order", "created_at.asc");
    newUrl.searchParams.set("limit", "100");

    const myUrl = new URL(`${baseUrl}/rest/v1/orders`);
    myUrl.searchParams.set("driver_id", `eq.${driverId}`);
    myUrl.searchParams.set(
      "status",
      "in.(accepted,in_progress,completed)"
    );
    myUrl.searchParams.set(
      "select",
      "id,passenger_name,passenger_phone,pickup_address,destination_address,car_class,distance_km,price,payment_method,status,created_at,accepted_at"
    );
    myUrl.searchParams.set("order", "created_at.desc");
    myUrl.searchParams.set("limit", "100");

    const [newOrders, myOrders] = await Promise.all([
      dbGet(newUrl.toString(), serviceKey),
      dbGet(myUrl.toString(), serviceKey)
    ]);

    // Әр тапсырысқа күн мен уақыт қосу
    const formattedNewOrders = newOrders.map(addOrderDateTime);
    const formattedMyOrders = myOrders.map(addOrderDateTime);

    return res.status(200).json({
      success: true,
      driver: {
        id: driver.id,
        full_name: driver.full_name
      },
      new_orders: formattedNewOrders,
      my_orders: formattedMyOrders
    });

  } catch (error) {
    console.error("Driver orders error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Тапсырыстарды жүктеу қатесі"
    });
  }
}
