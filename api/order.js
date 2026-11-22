import crypto from "crypto";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const URL = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!URL || !KEY) return res.status(500).json({ error: "Сервер баптауы жоқ" });

  const headers = {
    "Content-Type": "application/json",
    apikey: KEY,
    Authorization: `Bearer ${KEY}`
  };

  // ==========================================
  // 1. ЖАҢА ТАПСЫРЫС ЖАСАУ (POST)
  // ==========================================
  if (req.method === "POST") {
    try {
      const { from, to, car, distance, price, payment, phone, name, pickup_latitude, pickup_longitude, destination_latitude, destination_longitude } = req.body || {};
      if (!from || !to || !phone || !name || price === undefined) return res.status(400).json({ error: "Мәліметтер толық емес" });

      const trackingToken = crypto.randomBytes(32).toString("hex");
      const trackingTokenHash = crypto.createHash("sha256").update(trackingToken).digest("hex");
      
      const carClassMap = { "Эконом": "economy", "Бизнес": "comfort", "Комфорт+": "comfort_plus", "Бизнес+": "comfort_plus" };
      const carClass = carClassMap[car] || "economy";

      const orderData = {
        passenger_name: String(name).trim(), passenger_phone: String(phone).trim(),
        pickup_address: String(from).trim(), destination_address: String(to).trim(),
        car_class: carClass, distance_km: Number(distance) || null, price: Number(price),
        payment_method: payment || "cash", status: "searching",
        passenger_tracking_token_hash: trackingTokenHash
      };

      if (pickup_latitude) orderData.pickup_latitude = Number(pickup_latitude);
      if (pickup_longitude) orderData.pickup_longitude = Number(pickup_longitude);
      if (destination_latitude) orderData.destination_latitude = Number(destination_latitude);
      if (destination_longitude) orderData.destination_longitude = Number(destination_longitude);

      // Дерекқорға сақтау
      const r = await fetch(`${URL}/rest/v1/orders`, {
        method: "POST", headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify(orderData)
      });
      const dbResult = await r.json();
      if (!r.ok || !dbResult[0]?.id) return res.status(502).json({ error: "Сақтау мүмкін болмады" });

      // Telegram-ға хабарлама жіберу
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;

      if (token && chatId) {
        try {
          const message = "🚕 ҮРЖАР TAXI — ЖАҢА ТАПСЫРЫС\n\n" +
            "👤 Жолаушы: " + name + "\n" +
            "📞 Телефон: " + phone + "\n" +
            "🟢 Қайдан: " + from + "\n" +
            "🔴 Қайда: " + to + "\n" +
            "🚘 Көлік: " + car + "\n" +
            "📏 Қашықтық: " + distance + " км\n" +
            "💰 Бағасы: " + price + " ₸\n" +
            "💵 Төлем: " + (payment || "Қолма-қол");

          await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: message })
          });
        } catch (e) { 
          console.error("Telegram қатесі:", e.message); 
        }
      }

      return res.status(200).json({ success: true, orderId: dbResult[0].id, trackingToken });
    } catch (e) { 
      console.error("Сервер қатесі:", e);
      return res.status(500).json({ error: "Сервер қатесі" }); 
    }
  }

  // ==========================================
  // 2. ЖҮРГІЗУШІНІ БАҒАЛАУ (PATCH)
  // ==========================================
  else if (req.method === "PATCH") {
    try {
      const { orderId, rating, review, trackingToken } = req.body || {};
      
      if (!orderId || !rating || !trackingToken) {
        return res.status(400).json({ error: "Бағалау үшін мәліметтер жеткіліксіз" });
      }

      const tokenHash = crypto.createHash("sha256").update(trackingToken).digest("hex");

      // 1. Тапсырысты тексеру (токен дұрыспа, бағаланбаған ба?)
      const getOrderRes = await fetch(`${URL}/rest/v1/orders?id=eq.${orderId}&select=id,driver_id,rating,passenger_tracking_token_hash`, { headers });
      const orders = await getOrderRes.json();

      if (!orders || orders.length === 0) {
        return res.status(404).json({ error: "Тапсырыс табылмады" });
      }

      const order = orders[0];

      // Токенді тексеру (тек осы тапсырыстың иесі бағалай алады)
      if (order.passenger_tracking_token_hash !== tokenHash) {
        return res.status(403).json({ error: "Рұқсат жоқ" });
      }

      // Бұрын бағаланған ба?
      if (order.rating) {
        return res.status(400).json({ error: "Бұл тапсырыс бұрын бағаланған" });
      }

      // 2. Тапсырыс кестесін жаңарту (баға мен статусты сақтау)
      const updateOrderRes = await fetch(`${URL}/rest/v1/orders?id=eq.${orderId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          rating: Number(rating),
          review: review || null,
          status: "completed" // Егер сапар аяқталмаған болса, осы жерде аяқталды деп белгілейміз
        })
      });

      if (!updateOrderRes.ok) throw new Error("Тапсырысты жаңарту мүмкін болмады");

      // 3. Жүргізушінің орташа рейтингін есептеу және жаңарту
      if (order.driver_id) {
        const getDriverRes = await fetch(`${URL}/rest/v1/drivers?id=eq.${order.driver_id}&select=average_rating,total_ratings`, { headers });
        const drivers = await getDriverRes.json();

        if (drivers && drivers.length > 0) {
          const driver = drivers[0];
          const currentAvg = driver.average_rating || 0;
          const currentTotal = driver.total_ratings || 0;

          const newTotal = currentTotal + 1;
          // Жаңа орташа бағаны есептеу: (Ескі орташа * Ескі саны + Жаңа баға) / Жаңа жалпы саны
          const newAvg = ((currentAvg * currentTotal) + Number(rating)) / newTotal;

          await fetch(`${URL}/rest/v1/drivers?id=eq.${order.driver_id}`, {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              average_rating: parseFloat(newAvg.toFixed(2)), // Мысалы 4.85
              total_ratings: newTotal
            })
          });
        }
      }

      return res.status(200).json({ success: true, message: "Баға сәтті сақталды" });
    } catch (e) {
      console.error("Бағалау қатесі:", e);
      return res.status(500).json({ error: "Сервер қатесі" });
    }
  }

  // Басқа әдістерге рұқсат жоқ
  else {
    res.setHeader("Allow", ["POST", "PATCH"]);
    return res.status(405).json({ error: "Тек POST немесе PATCH әдістері рұқсат етілген" });
  }
}
