
import { randomUUID } from "crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Тек POST сұранысы қабылданады"
    });
  }

  const {
    full_name,
    phone,
    car_brand,
    car_model,
    car_year,
    car_number,
    car_class,
    car_photo_base64,
    car_photo_type
  } = req.body || {};

  if (
    !full_name?.trim() ||
    !phone?.trim() ||
    !car_brand?.trim() ||
    !car_model?.trim() ||
    !car_number?.trim() ||
    !["economy", "comfort", "comfort_plus"].includes(car_class)
  ) {
    return res.status(400).json({
      success: false,
      error: "Барлық қажетті мәліметтерді толтырыңыз"
    });
  }

  if (
    typeof car_photo_base64 !== "string" ||
    !["image/jpeg", "image/png", "image/webp"].includes(car_photo_type)
  ) {
    return res.status(400).json({
      success: false,
      error: "Көліктің JPG, PNG немесе WEBP фотосын таңдаңыз"
    });
  }

  const base64 = car_photo_base64.replace(/^data:image\/\w+;base64,/, "");

  if (
    !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) ||
    base64.length > 4200000 ||
    base64.length === 0
  ) {
    return res.status(400).json({
      success: false,
      error: "Фото көлемі тым үлкен немесе қате"
    });
  }

  const photoBuffer = Buffer.from(base64, "base64");

  if (photoBuffer.length > 3 * 1024 * 1024) {
    return res.status(400).json({
      success: false,
      error: "Фото көлемі 3 МБ-тан аспауы керек"
    });
  }

  // Файлдың нақты форматын тексеру
  const isJpeg =
    photoBuffer[0] === 0xff &&
    photoBuffer[1] === 0xd8 &&
    photoBuffer[2] === 0xff;

  const isPng =
    photoBuffer.subarray(0, 8).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    );

  const isWebp =
    photoBuffer.toString("ascii", 0, 4) === "RIFF" &&
    photoBuffer.toString("ascii", 8, 12) === "WEBP";

  if (
    (car_photo_type === "image/jpeg" && !isJpeg) ||
    (car_photo_type === "image/png" && !isPng) ||
    (car_photo_type === "image/webp" && !isWebp)
  ) {
    return res.status(400).json({
      success: false,
      error: "Фото форматы сәйкес келмейді"
    });
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return res.status(500).json({
      success: false,
      error: "Сервер баптауы толық емес"
    });
  }

  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`
  };

  let photoPath = null;

  try {
    const extension = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp"
    }[car_photo_type];

    photoPath = `${randomUUID()}.${extension}`;

    // Көлік фотосын жеке қоймаға жүктеу
    const uploadResponse = await fetch(
      `${url}/storage/v1/object/driver-cars/${photoPath}`,
      {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": car_photo_type,
          "x-upsert": "false"
        },
        body: photoBuffer
      }
    );

    if (!uploadResponse.ok) {
      return res.status(400).json({
        success: false,
        error: "Көлік фотосын сақтау мүмкін болмады"
      });
    }

    // Өтінімді дерекқорға сақтау
    const dbResponse = await fetch(
      `${url}/rest/v1/driver_applications`,
      {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          full_name: full_name.trim(),
          phone: phone.trim(),
          car_brand: car_brand.trim(),
          car_model: car_model.trim(),
          car_year: car_year ? Number(car_year) : null,
          car_number: car_number.trim().toUpperCase(),
          car_class,
          car_photo_path: photoPath,
          status: "pending"
        })
      }
    );

    if (!dbResponse.ok) {
      const errorText = await dbResponse.text();

      // Өтінім сақталмаса, жүктелген фотоны өшіру
      await fetch(
        `${url}/storage/v1/object/driver-cars/${photoPath}`,
        {
          method: "DELETE",
          headers
        }
      );

      if (dbResponse.status === 409 || errorText.includes("23505")) {
        return res.status(409).json({
          success: false,
          error: "Бұл телефон нөмірімен өтінім бұрын жіберілген"
        });
      }

      return res.status(400).json({
        success: false,
        error: "Өтінімді сақтау мүмкін болмады"
      });
    }

    return res.status(201).json({
      success: true,
      message: "Өтінім қабылданды. Әкімші тексеруін күтіңіз."
    });

  } catch (error) {
    if (photoPath) {
      await fetch(
        `${url}/storage/v1/object/driver-cars/${photoPath}`,
        {
          method: "DELETE",
          headers
        }
      ).catch(() => {});
    }

    return res.status(500).json({
      success: false,
      error: "Сервер қатесі"
    });
  }
}
