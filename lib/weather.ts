// Open-Meteo: free, no API key. Default location is Irvine, CA.
const DEFAULT_LAT = 33.6846;
const DEFAULT_LON = -117.8265;
const DEFAULT_PLACE = "Irvine, CA";

// WMO weather interpretation codes
const WEATHER_CODES: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "depositing rime fog",
  51: "light drizzle",
  53: "drizzle",
  55: "dense drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "freezing rain",
  67: "heavy freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light rain showers",
  81: "rain showers",
  82: "violent rain showers",
  85: "snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with hail",
  99: "thunderstorm with heavy hail",
};

const describe = (code: number) => WEATHER_CODES[code] ?? `weather code ${code}`;

interface Location {
  lat: number;
  lon: number;
  place: string;
}

async function geocode(name: string): Promise<Location | null> {
  const res = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1`
  );
  if (!res.ok) return null;
  const hit = (await res.json())?.results?.[0];
  if (!hit) return null;
  return {
    lat: hit.latitude,
    lon: hit.longitude,
    place: [hit.name, hit.admin1, hit.country_code].filter(Boolean).join(", "),
  };
}

export async function getWeather(days = 1, locationName?: string) {
  let loc: Location = { lat: DEFAULT_LAT, lon: DEFAULT_LON, place: DEFAULT_PLACE };
  if (locationName) {
    const found = await geocode(locationName);
    if (!found) return { error: `Could not find location "${locationName}"` };
    loc = found;
  }

  const params = new URLSearchParams({
    latitude: String(loc.lat),
    longitude: String(loc.lon),
    current: "temperature_2m,apparent_temperature,weather_code",
    daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code",
    temperature_unit: "fahrenheit",
    timezone: "America/Los_Angeles",
    forecast_days: String(Math.min(Math.max(days, 1), 7)),
  });

  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}: ${await res.text()}`);
  const data = await res.json();

  return {
    place: loc.place,
    now: {
      temp_f: data.current.temperature_2m,
      feels_like_f: data.current.apparent_temperature,
      conditions: describe(data.current.weather_code),
    },
    daily: data.daily.time.map((date: string, i: number) => ({
      date,
      high_f: data.daily.temperature_2m_max[i],
      low_f: data.daily.temperature_2m_min[i],
      rain_chance_pct: data.daily.precipitation_probability_max[i],
      conditions: describe(data.daily.weather_code[i]),
    })),
  };
}
