export default async function handler(req, res) {
if (req.method !== "POST") {
return res.status(405).json({ error: "Тек POST сұранысы қабылданады" });
}

try {
const { from, to, car, distance, price, payment, phone, name } = req.body || {};

if (!from || !to || !phone || !name || !price) {
  return res.status(400).json({
    error: "Аты-жөні, телефон, басталу және баратын мекенжай қажет."
  });
}

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!token || !chatId) {
  return res.status(500).json({
    error: "Telegram сервер баптаулары толық емес."
  });
}

const message =
  "🚕 ҮРЖАР TAXI — ЖАҢА ТАПСЫРЫС\n\n" +
  "👤 Жолаушы: " + name + "\n" +
  "📞 Телефон: " + phone + "\n" +
  "🟢 Қайдан: " + from + "\n" +
  "🔴 Қайда: " + to + "\n" +
  "🚘 Көлік: " + car + "\n" +
  "📏 Қашықтық: " + distance + " км\n" +
  "💰 Бағасы: " + price + " ₸\n" +
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

const result = await telegramResponse.json();

if (!telegramResponse.ok || !result.ok) {
  console.error("Telegram хабарламасын жіберу сәтсіз аяқталды.");
  return res.status(502).json({
    error: "Telegram-ға хабарлама жіберілмеді."
  });
}

return res.status(200).json({
  success: true,
  message: "Тапсырыс Telegram-ға жіберілді."
});

} catch (error) {
console.error("Тапсырысты өңдеу қатесі.");
return res.status(500).json({
error: "Серверде қате пайда болды."
});
}
}
