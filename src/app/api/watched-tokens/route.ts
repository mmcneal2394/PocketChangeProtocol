import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

async function getDb() {
  const { PrismaClient } = await import("@prisma/client");
  return new PrismaClient();
}

// GET: list active watched tokens
export async function GET() {
  try {
    const prisma = await getDb();
    const tokens = await prisma.watchedToken.findMany({
      where: { isActive: true },
      orderBy: { symbol: "asc" },
    });
    await prisma.$disconnect();
    return NextResponse.json(tokens);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST: add a token to watch
export async function POST(req: Request) {
  try {
    const prisma = await getDb();
    const body = await req.json();
    const { symbol, mint, decimals, strategies } = body;

    const token = await prisma.watchedToken.upsert({
      where: { symbol },
      update: {
        mint: mint || undefined,
        decimals: decimals || undefined,
        strategies: strategies || undefined,
        isActive: true,
      },
      create: {
        symbol,
        mint,
        decimals: decimals || 6,
        strategies: strategies || "all",
        isActive: true,
      },
    });
    await prisma.$disconnect();
    return NextResponse.json(token, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

// PATCH: update or deactivate a token
export async function PATCH(req: Request) {
  try {
    const prisma = await getDb();
    const body = await req.json();
    const { symbol, isActive, strategies } = body;

    const token = await prisma.watchedToken.update({
      where: { symbol },
      data: {
        isActive: isActive ?? undefined,
        strategies: strategies ?? undefined,
      },
    });
    await prisma.$disconnect();
    return NextResponse.json(token);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
}
