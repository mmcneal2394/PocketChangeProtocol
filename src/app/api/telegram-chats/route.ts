import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

async function getDb() {
  const { PrismaClient } = await import("@prisma/client");
  return new PrismaClient();
}

// GET: list active chats
export async function GET() {
  try {
    const prisma = await getDb();
    const chats = await prisma.telegramChat.findMany({
      where: { isActive: true },
    });
    await prisma.$disconnect();
    return NextResponse.json(chats.map((c: any) => ({
      ...c,
      chatId: c.chatId.toString(),
    })));
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST: upsert a chat (subscribe)
export async function POST(req: Request) {
  try {
    const prisma = await getDb();
    const body = await req.json();
    const { chatId, chatType, title } = body;

    const chat = await prisma.telegramChat.upsert({
      where: { chatId: BigInt(chatId) },
      update: {
        isActive: true,
        title: title || undefined,
      },
      create: {
        chatId: BigInt(chatId),
        chatType: chatType || "group",
        title: title || null,
        isActive: true,
      },
    });
    await prisma.$disconnect();

    return NextResponse.json({
      ...chat,
      chatId: chat.chatId.toString(),
    }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

// PATCH: deactivate a chat (unsubscribe)
export async function PATCH(req: Request) {
  try {
    const prisma = await getDb();
    const body = await req.json();
    const { chatId, isActive } = body;

    const chat = await prisma.telegramChat.update({
      where: { chatId: BigInt(chatId) },
      data: { isActive: isActive ?? false },
    });
    await prisma.$disconnect();

    return NextResponse.json({
      ...chat,
      chatId: chat.chatId.toString(),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
}
