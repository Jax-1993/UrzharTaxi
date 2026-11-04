export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Тек POST сұранысы қабылданады"
    });
  }

  try {
    const {
      from,
      to,
      car,
      distance,
      price,
      payment,
      phone,
      name,
      pickup_latitude,
      pickup_longitude,
      destination_latitude,
      destination_longitude
    } = req.body || {};

    if (!from || !to || !phone || !name || !price) {
      return res.status(400).json({
        error: "Аты-жөні, телефон, басталу және баратын мекенжай қажет."
      });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!supabaseUrl || !supabaseKey || !token || !chatId) {
      return res.status(500).json({
        error: "Сервер баптаулары толық емес."
      });
    }

    const carClassMap = {
      "Эконом": "economy",
      "Комфорт": "comfort",
      "Бизнес": "comfort",
      "Комфорт+": "comfort_plus",
      "Comfort+": "comfort_plus"
    };

    const carClass = carClassMap[car] || "economy";
    const numericPrice = Number(price);
    const numericDistance = Number(distance);

    if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
      return res.status(400).json({
        error: "Тапсырыс бағасы дұрыс емес."
      });
    }

    const orderData = {
      passenger_name: String(name).trim(),
      passenger_phone: String(phone).trim(),
      pickup_address: String(from).trim(),
      destination_address: String(to).trim(),
      car_class: carClass,
      distance_km: Number.isFinite(numericDistance) && numericDistance >= 0
        ? numericDistance
        : null,
      price: numericPrice,
      payment_method: payment || "cash",
      status: "searching"
    };

    if (Number.isFinite(Number(pickup_latitude))) {
      orderData.pickup_latitude = Number(pickup_latitude);
    }
    if (Number.isFinite(Number(pickup_longitude))) {
      orderData.pickup_longitude = Number(pickup_longitude);
    }
    if (Number.isFinite(Number(destination_latitude))) {
      orderData.destination_latitude = Number(destination_latitude);
    }
    if (Number.isFinite(Number(destination_longitude))) {
      orderData.destination_longitude = Number(destination_longitude);
    }

    const dbResponse = await fetch(
      `${supabaseUrl.replace(/\/$/, "")}/rest/v1/orders`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": supabaseKey,
          "Authorization": `Bearer ${supabaseKey}`,
          "Prefer": "return=representation"
        },
        body: JSON.stringify(orderData)
      }
    );

    const dbResult = await dbResponse.json().catch(() => null);

    if (!dbResponse.ok || !Array.isArray(dbResult) || !dbResult[0]?.id) {
      console.error("Supabase-ке тапсырыс сақтау сәтсіз аяқталды.");
      return res.status(502).json({
        error: "Тапсырысты базаға сақтау мүмкін болмады. Қайта тексеріңіз."
      });
    }

    const orderId = dbResult[0].id;

    const message =
      "🚕 ҮРЖАР TAXI — ЖАҢА ТАПСЫРЫС\n\n" +
      "🆔 Тапсырыс: " + orderId + "\n" +
      "👤 Жолаушы: " + name + "\n" +
      "📞 Телефон: " + phone + "\n" +
      "🟢 Қайдан: " + from + "\n" +
      "🔴 Қайда: " + to + "\n" +
      "🚘 Көлік: " + (car || "Эконом") + "\n" +
      "📏 Қашықтық: " +
        (Number.isFinite(numericDistance) ? numericDistance : "Белгісіз") +
        " км\n" +
      "💰 Бағасы: " + numericPrice + " ₸\n" +
      "💵 Төлем: " + (payment || "Қолма-қол");

    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message
        })
      }
    );

    const telegramResult = await telegramResponse.json();

    if (!telegramResponse.ok || !telegramResult.ok) {
      console.error("Telegram хабарламасын жіберу сәтсіз аяқталды.");
      return res.status(200).json({
        success: true,
        orderId,
        message: "Тапсырыс базаға сақталды, бірақ Telegram хабарламасын жіберу сәтсіз болды."
      });
    }

    return res.status(200).json({
      success: true,
      orderId,
      message: "Тапсырыс базаға сақталып, Telegram-ға жіберілді."
    });

  } catch (error) {
    console.error("Тапсырысты өңдеу қатесі.");
    return res.status(500).json({
      error: "Серверде қате пайда болды."
    });
  }
}
