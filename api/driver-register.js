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
    car_class
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

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return res.status(500).json({
      success: false,
      error: "Сервер баптауы толық емес"
    });
  }

  try {
    const response = await fetch(
      `${url}/rest/v1/driver_applications`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: key,
          Authorization: `Bearer ${key}`,
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
          status: "pending"
        })
      }
    );

    if (!response.ok) {
      const error = await response.json();

      if (error.code === "23505") {
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
    return res.status(500).json({
      success: false,
      error: "Сервер қатесі"
    });
  }
}
