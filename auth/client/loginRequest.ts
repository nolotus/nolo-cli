// auth/api.ts
import { authRoutes } from "../routes";

export const loginRequest = async (currentServer: string, data: any) => {
  const path = authRoutes.login.createPath();

  return fetch(`${currentServer}${path}`, {
    method: authRoutes.login.method,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
};
