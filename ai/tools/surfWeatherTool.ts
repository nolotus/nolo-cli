export interface SurfWeatherToolArgs {
  latitude: number;
  longitude: number;
  location_name?: string;
  forecast_days?: number;
}

export const surfWeatherFunctionSchema = {
  name: "surfWeather",
  description: [
    "获取指定海岸位置的冲浪天气预报，包括浪高、涌浪高度、浪周期、涌浪周期、浪向等关键指标。",
    "数据来源：Open-Meteo Marine API（免费，无需 API Key）。",
    "适用场景：查询某个冲浪点未来几天的海浪状况，判断是否适合冲浪。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      latitude: {
        type: "number",
        description: "纬度，例如海南万宁为 18.8",
      },
      longitude: {
        type: "number",
        description: "经度，例如海南万宁为 110.4",
      },
      location_name: {
        type: "string",
        description: "地点名称（可选），仅用于展示，例如「海南万宁日月湾」",
      },
      forecast_days: {
        type: "number",
        description: "预报天数，1~7，默认 3",
      },
    },
    required: ["latitude", "longitude"],
  },
} as const;

interface HourlyData {
  time: string[];
  wave_height: number[];
  wave_period: number[];
  wave_direction: number[];
  wind_wave_height: number[];
  swell_wave_height: number[];
  swell_wave_period: number[];
  swell_wave_direction: number[];
}

function getSurfRating(waveHeight: number, wavePeriod: number): string {
  if (waveHeight < 0.3) return "⚫ 无浪";
  if (waveHeight < 0.6 && wavePeriod < 6) return "🟤 极差";
  if (waveHeight < 0.8) return "🔴 差";
  if (waveHeight < 1.2 && wavePeriod >= 6) return "🟡 一般";
  if (waveHeight < 2.0 && wavePeriod >= 8) return "🟢 较好";
  if (waveHeight >= 2.0 && wavePeriod >= 10) return "🔵 优秀";
  return "🟡 一般";
}

function getWindDirection(deg: number): string {
  const dirs = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];
  return dirs[Math.round(deg / 45) % 8];
}

export async function surfWeatherFunc(
  args: SurfWeatherToolArgs
): Promise<{ rawData: unknown; displayData: string }> {
  const { latitude, longitude, location_name, forecast_days = 3 } = args;

  const days = Math.min(Math.max(Math.round(forecast_days), 1), 7);
  const params = [
    "wave_height",
    "wave_period",
    "wave_direction",
    "wind_wave_height",
    "swell_wave_height",
    "swell_wave_period",
    "swell_wave_direction",
  ].join(",");

  const url =
    `https://marine-api.open-meteo.com/v1/marine` +
    `?latitude=${latitude}&longitude=${longitude}` +
    `&hourly=${params}` +
    `&timezone=Asia/Shanghai` +
    `&forecast_days=${days}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Open-Meteo API 请求失败: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as {
    latitude: number;
    longitude: number;
    hourly: HourlyData;
  };

  const h = data.hourly;
  const locationLabel = location_name || `${data.latitude}°N, ${data.longitude}°E`;

  // 每天取最大浪高时段作为日摘要（取 08:00 - 20:00 峰值）
  const dailySummaries: {
    date: string;
    maxWaveHeight: number;
    wavePeriod: number;
    swellHeight: number;
    swellPeriod: number;
    waveDirection: number;
    rating: string;
  }[] = [];

  const totalHours = h.time.length;
  for (let d = 0; d < days; d++) {
    const start = d * 24;
    const end = Math.min(start + 24, totalHours);
    // 找当天最大浪高的小时
    let bestIdx = start;
    for (let i = start; i < end; i++) {
      const hour = parseInt(h.time[i].slice(11, 13), 10);
      if (hour < 8 || hour > 20) continue;
      if (h.wave_height[i] > h.wave_height[bestIdx]) bestIdx = i;
    }
    const date = h.time[bestIdx].slice(0, 10);
    const wh = h.wave_height[bestIdx];
    const wp = h.wave_period[bestIdx];
    const sh = h.swell_wave_height[bestIdx];
    const sp = h.swell_wave_period[bestIdx];
    const wd = h.wave_direction[bestIdx];
    dailySummaries.push({
      date,
      maxWaveHeight: wh,
      wavePeriod: wp,
      swellHeight: sh,
      swellPeriod: sp,
      waveDirection: wd,
      rating: getSurfRating(wh, wp),
    });
  }

  // 构建展示文本
  const lines: string[] = [];
  lines.push(`🏄 冲浪天气预报 — ${locationLabel}`);
  lines.push(`数据来源：Open-Meteo Marine API\n`);
  lines.push(`日期          评级      浪高    涌浪    周期  涌浪周期  浪向`);
  lines.push("─".repeat(58));

  for (const s of dailySummaries) {
    lines.push(
      `${s.date}  ${s.rating}  ${s.maxWaveHeight.toFixed(2)}m  ${s.swellHeight.toFixed(2)}m  ${s.wavePeriod.toFixed(1)}s  ${s.swellPeriod.toFixed(1)}s  ${getWindDirection(s.waveDirection)}`
    );
  }

  lines.push("\n评级说明：🔵优秀 🟢较好 🟡一般 🔴差 🟤极差 ⚫无浪");

  const displayData = lines.join("\n");

  return {
    rawData: {
      location: locationLabel,
      latitude: data.latitude,
      longitude: data.longitude,
      forecast_days: days,
      daily: dailySummaries,
      hourly: h,
    },
    displayData,
  };
}
