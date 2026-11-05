import crypto from "crypto";

function verifyAdmin(req, password) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)urzhar_admin_session=([^;]+)/);

  if (!match) return false;

  const parts = match[1].split(".");
  if (parts.length !== 2) return false;

  const expires = Number(parts[0]);
  const receivedSignature = parts[1];

  if (!Number.isFinite(expires) || expires <= Date.now()) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac("sha256", password)
    .update("urzhar-admin:" + expires)
    .digest("hex");

  const received = Buffer.from(receivedSignature, "hex");
  const expected = Buffer.from(expectedSignature, "hex");

  if (received.length !== expected.length) return false;

  return crypto.timingSafeEqual(received, expected);
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
    const password = process.env.ADMIN_PASSWORD;
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!password || !supabaseUrl || !serviceKey) {
      return res.status(500).json({
        success: false,
        message: "Сервер баптаулары толық емес"
      });
    }

    if (!verifyAdmin(req, password)) {
      return res.status(401).json({
        success: false,
        message: "Әкімшіге кіруге рұқсат жоқ"
      });
    }

    const cleanUrl = supabaseUrl.replace(/\/$/, "");

    const response = await fetch(
      `${cleanUrl}/rest/v1/driver_applications?select=id,full_name,phone,car_brand,car_model,car_year,car_number,car_class,status,created_at,car_photo_path&order=created_at.desc`,
      {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`
        }
      }
    );

    if (!response.ok) {
      console.error("Supabase error:", await response.text());

      return res.status(502).json({
        success: false,
        message: "Өтінімдерді алу мүмкін болмады"
      });
    }

    const applications = await response.json();

    const result = await Promise.all(
      applications.map(async (application) => {
        let photoUrl = null;

        if (application.car_photo_path) {
          try {
            const photoResponse = await fetch(
              `${cleanUrl}/storage/v1/object/sign/driver-cars/${application.car_photo_path}`,
              {
                method: "POST",
                headers: {
                  apikey: serviceKey,
                  Authorization: `Bearer ${serviceKey}`,
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({
                  expiresIn: 300
                })
              }
            );

            if (photoResponse.ok) {
              const photoData = await photoResponse.json();

              if (photoData.signedURL) {
                photoUrl = photoData.signedURL.startsWith("http")
                  ? photoData.signedURL
                  : `${cleanUrl}${photoData.signedURL}`;
              }
            }
          } catch (photoError) {
            console.error("Photo link error:", photoError);
          }
        }

        return {
          ...application,
          photo_url: photoUrl
        };
      })
    );

    return res.status(200).json({
      success: true,
      count: result.length,
      applications: result
    });

  } catch (error) {
    console.error("Admin applications error:", error);

    return res.status(500).json({
      success: false,
      message: "Сервер қатесі"
    });
  }
}
