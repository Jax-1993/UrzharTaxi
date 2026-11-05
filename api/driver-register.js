export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Тек POST сұранысы қабылданады"
    });
  }

  const {
    email,
    password,
    full_name,
    phone,
    car_brand,
    car_model,
    car_year,
    car_number,
    car_class
  } = req.body || {};

  if (
    !email || !password || password.length < 8 ||
    !full_name || !phone ||
    !car_brand || !car_model ||
    !car_number ||
    !["economy", "comfort", "comfort_plus"].includes(car_class)
  ) {
    return res.status(400).json({
      error: "Мәліметтер толық емес немесе қате"
    });
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return res.status(500).json({
      error: "Сервер баптауы толық емес"
    });
  }

  try {
    const signup = await fetch(`${url}/auth/v1/signup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        email,
        password
      })
    });

    const authData = await signup.json();

    if (!signup.ok || !authData.user?.id) {
      return res.status(400).json({
        error: authData.msg || authData.message || "Тіркелу сәтсіз аяқталды"
      });
    }

    const profile = await fetch(`${url}/rest/v1/drivers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        id: authData.user.id,
        full_name,
        phone,
        car_brand,
        car_model,
        car_year: car_year ? Number(car_year) : null,
        car_number,
        car_class,
        status: "pending"
      })
    });

    if (!profile.ok) {
      return res.status(400).json({
        error: "Аккаунт ашылды, бірақ жүргізуші профилі сақталмады"
      });
    }

    return res.status(201).json({
      success: true,
      message: "Тіркелу қабылданды. Әкімші мақұлдауын күтіңіз."
    });

  } catch (error) {
    return res.status(500).json({
      error: "Сервер қатесі"
    });
  }
}
