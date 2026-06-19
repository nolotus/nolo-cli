export async function getWorldBankIndicator(countryCode: string, indicatorCode: string) {
  try {
    // API response format: JSON
    const url = `http://api.worldbank.org/v2/country/${countryCode}/indicator/${indicatorCode}?format=json&per_page=50`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    
    if (Array.isArray(data) && data.length > 1 && Array.isArray(data[1])) {
      return data[1]
        .filter((item: any) => item.value !== null)
        .map((item: any) => ({
          date: item.date,
          value: item.value,
          country: item.country?.value,
          indicator: item.indicator?.value
        }));
    }
    
    return data;
  } catch (error: any) {
    throw new Error(`Failed to fetch World Bank Data: ${error.message}`);
  }
}

export const WORLD_BANK_TOOLS_SCHEMA = [
  {
    type: "function",
    function: {
      name: "getWorldBankIndicator",
      description: "Get macro economic indicators for a specific country from the World Bank Open Data.",
      parameters: {
        type: "object",
        properties: {
          countryCode: {
            type: "string",
            description: "The 2-letter or 3-letter ISO country code (e.g., 'US', 'CN', 'WLD' for world).",
          },
          indicatorCode: {
            type: "string",
            description: "The World Bank indicator code (e.g., 'NY.GDP.MKTP.CD' for GDP, 'SP.POP.TOTL' for Total Population).",
          },
        },
        required: ["countryCode", "indicatorCode"],
      },
    },
  },
];
