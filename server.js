const express = require("express");
const sharp = require("sharp");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: "10mb" }));
app.use(express.static(__dirname));

const API_KEY = process.env.GOOGLE_SOLAR_API_KEY;

function error(res, message, status = 500) {
  return res.status(status).json({ error: message });
}

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "CEO Fotovoltaicos" });
});

app.get("/api/solar", async (req, res) => {
  try {
    if (!API_KEY) {
      return error(res, "Falta GOOGLE_SOLAR_API_KEY en Cloud Run", 500);
    }

    const address = String(req.query.address || "").trim();
    if (!address) return error(res, "Falta la dirección", 400);

    // 1. Geocodificar dirección
    const geoUrl =
      "https://maps.googleapis.com/maps/api/geocode/json?address=" +
      encodeURIComponent(address) +
      "&key=" +
      encodeURIComponent(API_KEY);

    const geoResponse = await fetch(geoUrl);
    const geo = await geoResponse.json();

    if (geo.status !== "OK" || !geo.results?.length) {
      return error(res, "No se pudo localizar la dirección", 400);
    }

    const location = geo.results[0].geometry.location;
    const formattedAddress = geo.results[0].formatted_address;

    // 2. Building Insights
    const insightsUrl =
      "https://solar.googleapis.com/v1/buildingInsights:findClosest" +
      "?location.latitude=" + location.lat +
      "&location.longitude=" + location.lng +
      "&requiredQuality=BASE" +
      "&key=" + encodeURIComponent(API_KEY);

    const insightsResponse = await fetch(insightsUrl);
    const buildingInsights = await insightsResponse.json();

    if (!insightsResponse.ok) {
      return error(
        res,
        buildingInsights.error?.message ||
          "Google Solar no pudo analizar el edificio",
        insightsResponse.status
      );
    }

    // 3. Capas de datos para obtener imagen RGB
    const layersUrl =
      "https://solar.googleapis.com/v1/dataLayers:get" +
      "?location.latitude=" + location.lat +
      "&location.longitude=" + location.lng +
      "&radius_meters=50" +
      "&required_quality=BASE" +
      "&key=" + encodeURIComponent(API_KEY);

    const layersResponse = await fetch(layersUrl);
    const layers = await layersResponse.json();

    if (!layersResponse.ok) {
      return error(
        res,
        layers.error?.message || "No se pudieron obtener las imágenes solares",
        layersResponse.status
      );
    }

    let satelliteImage = null;

    if (layers.rgbUrl) {
      const rgbUrl =
        layers.rgbUrl +
        (layers.rgbUrl.includes("?") ? "&" : "?") +
        "key=" +
        encodeURIComponent(API_KEY);

      const imageResponse = await fetch(rgbUrl);

      if (imageResponse.ok) {
        const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

        const pngBuffer = await sharp(imageBuffer)
          .png()
          .toBuffer();

        satelliteImage =
          "data:image/png;base64," +
          pngBuffer.toString("base64");
      }
    }

    res.json({
      geocode: {
        address: formattedAddress,
        latitude: location.lat,
        longitude: location.lng
      },
      buildingInsights,
      satelliteImage,
      imageryDate: layers.imageryDate || null,
      imageryQuality: layers.imageryQuality || null,
      imageCenter: {
        latitude: location.lat,
        longitude: location.lng
      },
      imageRadiusMeters: 50
    });

  } catch (e) {
    console.error(e);
    return error(res, e.message || "Error interno del servidor", 500);
  }
});

// Rutas para desplazamientos
app.post("/api/routes", async (req, res) => {
  try {
    if (!API_KEY) {
      return error(res, "Falta GOOGLE_SOLAR_API_KEY en Cloud Run", 500);
    }

    const { origin, destination } = req.body || {};

    if (!origin || !destination) {
      return error(res, "Faltan origen o destino", 400);
    }

    const url =
      "https://routes.googleapis.com/directions/v2:computeRoutes";

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": API_KEY,
        "X-Goog-FieldMask":
          "routes.distanceMeters,routes.duration,routes.travelAdvisory"
      },
      body: JSON.stringify({
        origin: {
          address: origin
        },
        destination: {
          address: destination
        },
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE"
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return error(
        res,
        data.error?.message || "Error calculando la ruta",
        response.status
      );
    }

    res.json(data);

  } catch (e) {
    console.error(e);
    return error(res, e.message || "Error interno del servidor", 500);
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`CEO Fotovoltaicos escuchando en ${PORT}`);
});
