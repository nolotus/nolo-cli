export const CHROME_CONNECTOR_TOOL_NAMES = [
  "chrome_list_tabs",
  "chrome_open_tab",
  "chrome_read_page",
  "chrome_click",
  "chrome_type",
  "chrome_press",
  "chrome_scroll",
  "chrome_screenshot",
  "chrome_read_console",
  "chrome_read_network",
] as const;

export type ChromeConnectorToolName = typeof CHROME_CONNECTOR_TOOL_NAMES[number];

export const CHROME_CONNECTOR_READ_TOOL_NAMES = [
  "chrome_list_tabs",
  "chrome_read_page",
  "chrome_screenshot",
  "chrome_read_console",
  "chrome_read_network",
] as const satisfies readonly ChromeConnectorToolName[];

export const getChromeConnectorToolBehavior = (
  name: ChromeConnectorToolName,
): "data" | "action" =>
  CHROME_CONNECTOR_READ_TOOL_NAMES.includes(name as any) ? "data" : "action";

export const getChromeConnectorToolDefaultConsent = (
  name: ChromeConnectorToolName,
): "auto" | "ask" =>
  CHROME_CONNECTOR_READ_TOOL_NAMES.includes(name as any) ? "auto" : "ask";

function baseSchema(
  name: ChromeConnectorToolName,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
) {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties,
      required,
    },
  };
}

const tabId = {
  type: "string",
  description: "Chrome tab id returned by chrome_list_tabs or chrome_open_tab.",
};

const selector = {
  type: "string",
  description: "CSS selector for the visible page element to operate on.",
};

export const chromeListTabsFunctionSchema = baseSchema(
  "chrome_list_tabs",
  "List controllable Chrome tabs from the user's Chrome profile through the Nolo desktop Chrome connector.",
  {},
);

export const chromeOpenTabFunctionSchema = baseSchema(
  "chrome_open_tab",
  "Open a URL in the user's Chrome browser through the Nolo desktop Chrome connector.",
  {
    url: {
      type: "string",
      description: "HTTP or HTTPS URL to open in Chrome.",
    },
    active: {
      type: "boolean",
      description: "Whether to focus the new Chrome tab. Defaults to true.",
    },
  },
  ["url"],
);

export const chromeReadPageFunctionSchema = baseSchema(
  "chrome_read_page",
  "Read visible text and lightweight DOM state from a Chrome tab without reading cookies or profile databases.",
  {
    tabId,
    selector: {
      ...selector,
      description: "Optional CSS selector to limit the read to part of the page.",
    },
  },
  ["tabId"],
);

export const chromeClickFunctionSchema = baseSchema(
  "chrome_click",
  "Click a visible element in a Chrome tab. Do not use this for final submit/delete/payment/permission actions without action-time user confirmation.",
  {
    tabId,
    selector,
  },
  ["tabId", "selector"],
);

export const chromeTypeFunctionSchema = baseSchema(
  "chrome_type",
  "Type text into a Chrome page element. Typing sensitive data into a third-party site counts as data transmission.",
  {
    tabId,
    selector,
    text: {
      type: "string",
      description: "Text to type into the selected element.",
    },
    clearFirst: {
      type: "boolean",
      description: "Whether to clear the field before typing. Defaults to true.",
    },
  },
  ["tabId", "selector", "text"],
);

export const chromePressFunctionSchema = baseSchema(
  "chrome_press",
  "Send a keyboard key or shortcut to a Chrome tab.",
  {
    tabId,
    key: {
      type: "string",
      description: "Key or shortcut, for example Enter, Escape, ArrowDown, or Meta+L.",
    },
  },
  ["tabId", "key"],
);

export const chromeScrollFunctionSchema = baseSchema(
  "chrome_scroll",
  "Scroll a Chrome tab by pixel deltas.",
  {
    tabId,
    deltaX: {
      type: "number",
      description: "Horizontal scroll delta in pixels.",
    },
    deltaY: {
      type: "number",
      description: "Vertical scroll delta in pixels.",
    },
  },
  ["tabId"],
);

export const chromeScreenshotFunctionSchema = baseSchema(
  "chrome_screenshot",
  "Capture a screenshot from a Chrome tab through the Nolo desktop Chrome connector.",
  {
    tabId,
    fullPage: {
      type: "boolean",
      description: "Whether to capture the full page. Defaults to false.",
    },
  },
  ["tabId"],
);

export const chromeReadConsoleFunctionSchema = baseSchema(
  "chrome_read_console",
  "Read recent console messages from a Chrome tab using debugger-backed connector state.",
  {
    tabId,
    limit: {
      type: "number",
      description: "Maximum number of recent console messages to return.",
    },
  },
  ["tabId"],
);

export const chromeReadNetworkFunctionSchema = baseSchema(
  "chrome_read_network",
  "Read a recent network summary from a Chrome tab using debugger-backed connector state.",
  {
    tabId,
    limit: {
      type: "number",
      description: "Maximum number of recent network entries to return.",
    },
  },
  ["tabId"],
);

export const chromeConnectorToolSchemas = [
  chromeListTabsFunctionSchema,
  chromeOpenTabFunctionSchema,
  chromeReadPageFunctionSchema,
  chromeClickFunctionSchema,
  chromeTypeFunctionSchema,
  chromePressFunctionSchema,
  chromeScrollFunctionSchema,
  chromeScreenshotFunctionSchema,
  chromeReadConsoleFunctionSchema,
  chromeReadNetworkFunctionSchema,
];

export async function chromeConnectorUnavailableFunc(): Promise<never> {
  throw new Error("Chrome connector tools are only executable in the Nolo desktop local runtime.");
}
