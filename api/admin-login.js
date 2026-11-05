import crypto from "crypto";

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Тек POST сұранысы қабылданады"
    });
  }

  try {
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminPassword) {
      return res.status(500).json({
        success: false,
        message: "ADMIN_PASSWORD бапталмаған"
      });
    }

    const { password } = req.body || {};

    if (typeof password !== "string" || !password) {
      return res.status(400).json({
        success: false,
        message: "Құпиясөзді енгізіңіз"
      });
    }

    const submitted = Buffer.from(password);
    const correct = Buffer.from(adminPassword);

    if (
      submitted.length !== correct.length ||
      !crypto.timingSafeEqual(submitted, correct)
    ) {
      return res.status(401).json({
        success: false,
        message: "Құпиясөз қате"
      });
    }

    const expires = Date.now() + 8 * 60 * 60 * 1000;

    const signature = crypto
      .createHmac("sha256", adminPassword)
      .update("urzhar-admin:" + expires)
      .digest("hex");

    const token = expires + "." + signature;

    res.setHeader(
      "Set-Cookie",
      `urzhar_admin_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`
    );

    return res.status(200).json({
      success: true,
      message: "Әкімші жүйесіне кіру сәтті орындалды"
    });

  } catch (error) {
    console.error("Admin login error:", error);

    return res.status(500).json({
      success: false,
      message: "Сервер қатесі"
    });
  }
}
