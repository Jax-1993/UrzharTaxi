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

    // 1. Мәліметтерді тексеру
    if (!from || !to || !phone || !name || price === undefined) {
      return res.status(400).json({
        error: "Аты-жөні, телефон, мекенжайлар және баға қажет."
      });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({
        error: "Supabase сервер баптаулары толық емес."
      });
    }

    const numericPrice = Number(price);
    const numericDistance = Number(distance);

    if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
      return res.status(400).json({
        error: "Баға дұрыс көрсетілмеген."
      });
    }

    // 2. Көлік класын анықтау
    const carClassMap = {
      "Эконом": "economy",
      "Комфорт": "comfort",
      "Бизнес": "comfort",
      "Комфорт+": "comfort_plus",
      "Comfort+": "comfort_plus"
    };

    const carClass = carClassMap[car] || "economy";

    // 3. Supabase-ке сақталатын мәлімет
    const orderData = {
      passenger_name: String(name).trim(),
      passenger_phone: String(phone).trim(),
      pickup_address: String(from).trim(),
      destination_address: String(to).trim(),
      car_class: carClass,
      distance_km: Number.isFinite(numericDistance)
        ? numericDistance
        : null,
      price: numericPrice,
      payment_method: payment || "cash",
      status: "searching"
    };

    const coordinates = {
      pickup_latitude,
      pickup_longitude,
      destination_latitude,
      destination_longitude
    };

    for (const [key, value] of Object.entries(coordinates)) {
      if (
        value !== undefined &&
        value !== null &&
        value !== "" &&
        Number.isFinite(Number(value))
      ) {
        orderData[key] = Number(value);
      }
    }

    // 4. Supabase-ке тапсырысты сақтау
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
      console.error("Supabase сақтау қатесі:", {
        status: dbResponse.status,
        code: dbResult?.code,
        message: dbResult?.message
      });

      return res.status(502).json({
        error: "Supabase қатесі: " +
          (dbResult?.message || "Тапсырысты сақтау мүмкін болмады."),
        code: dbResult?.code || null
      });
    }

    // 5. Сақталған тапсырыстың ID нөмірі
    const orderId = dbResult[0].id;

    // 6. Telegram хабарламасы
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    let telegramSent = false;

    if (token && chatId) {
      try {
        const message =
          "🚕 ҮРЖАР TAXI — ЖАҢА ТАПСЫРЫС\n\n" +
          "🆔 Тапсырыс: " + orderId + "\n" +
          "👤 Жолаушы: " + name + "\n" +
          "📞 Телефон: " + phone + "\n" +
          "🟢 Қайдан: " + from + "\n" +
          "🔴 Қайда: " + to + "\n" +
          "🚘 Көлік: " + car + "\n" +
          "📏 Қашықтық: " + distance + " км\n" +
          "💰 Бағасы: " + numericPrice + " ₸\n" +
          "💵 Төлем: " + (payment || "Қолма-қол") + "\n" +
          "🔎 Мәртебе: Жүргізуші ізделуде";

        const telegramResponse = await fetch(
          `https://api.telegram.org/bot${token}/sendMessage`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              chat_id: chatId,
              text: message
            })
          }
        );

        const telegramResult = await telegramResponse.json();

        telegramSent = telegramResponse.ok && telegramResult.ok;

      } catch (telegramError) {
        console.error("Telegram хабарламасы жіберілмеді.");
      }
    }

    // 7. Сәтті жауап
    return res.status(200).json({
      success: true,
      orderId,
      status: "searching",
      telegramSent,
      message: "Тапсырыс базаға сәтті сақталды."
    });

  } catch (error) {
    console.error("Сервер қатесі:", error.message);

    return res.status(500).json({
      error: "Серверде қате пайда болды."
    });
  }
}
