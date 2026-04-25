import { getHealthResponse } from "@/lib/backend-proxy";

export async function GET() {
  return getHealthResponse();
}
