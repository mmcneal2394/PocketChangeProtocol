import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

let _prisma: any = null;
function getDb() {
  if (!_prisma) {
    const { PrismaClient } = require("@prisma/client");
    _prisma = new PrismaClient();
  }
  return _prisma;
}

export async function GET() {
  try {
    const prisma = getDb();
    const tokens = await prisma.watchedToken.findMany({
      where: { isActive: true },
      orderBy: { symbol: "asc" },
    });
    return NextResponse.json(tokens);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const prisma = getDb();
    const body = await req.json();
    const { symbol, mint, decimals, strategies } = body;
    const token = await prisma.watchedToken.upsert({
      where: { symbol },
      update: { mint: mint || undefined, decimals: decimals || undefined, strategies: strategies || undefined, isActive: true },
      create: { symbol, mint, decimals: decimals || 6, strategies: strategies || "all", isActive: true },
    });
    return NextResponse.json(token, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

export async function PATCH(req: Request) {
  try {
    const prisma = getDb();
    const body = await req.json();
    const { symbol, isActive, strategies } = body;
    const token = await prisma.watchedToken.update({
      where: { symbol },
      data: { isActive: isActive ?? undefined, strategies: strategies ?? undefined },
    });
    return NextResponse.json(token);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
}
