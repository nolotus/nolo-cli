import { ulid } from "ulid";
export const createAgent = () => ({ id: ulid() });