export class ToolResultError extends Error {
  code?: string;
  rawData?: unknown;
  displayData?: string;
  retryable?: boolean;

  constructor(
    message: string,
    options?: {
      code?: string;
      rawData?: unknown;
      displayData?: string;
      retryable?: boolean;
    }
  ) {
    super(message);
    this.name = "ToolResultError";
    this.code = options?.code;
    this.rawData = options?.rawData;
    this.displayData = options?.displayData;
    this.retryable = options?.retryable;
  }
}

export const getToolResultErrorData = (error: unknown) => {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    rawData?: unknown;
    displayData?: string;
    code?: string;
    retryable?: boolean;
    message?: string;
  };
  return {
    rawData: candidate.rawData,
    displayData: candidate.displayData,
    code: candidate.code,
    retryable: candidate.retryable,
    message: candidate.message,
  };
};

