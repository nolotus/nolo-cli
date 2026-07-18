// auth/api.ts
import { authRoutes } from "../routes";

export const loginRequest = async (currentServer: string, data: any) => {
  const path = authRoutes.login.createPath();
  const fullUrl = `${currentServer}${path}`;
  console.log(`[Auth] loginRequest → ${fullUrl}`, {
    userId: data?.userId,
    hasToken: Boolean(data?.token),
  });

  try {
    const response = await fetch(fullUrl, {
      method: authRoutes.login.method,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });
    console.log(`[Auth] loginRequest ← ${response.status} ${response.statusText} from ${fullUrl}`);
    return response;
  } catch (error: any) {
    console.error(`[Auth] loginRequest ✗ network error from ${fullUrl}:`, error?.message || error);
    throw error;
  }
};
