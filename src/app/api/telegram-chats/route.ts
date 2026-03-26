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
    const chats = await prisma.telegramChat.findMany({ where: { isActive: true } });
    return NextResponse.json(chats.map((c: any) => ({ ...c, chatId: c.chatId.toString() })));
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const prisma = getDb();
    const body = await req.json();
    const { chatId, chatType, title } = body;
    const chat = await prisma.telegramChat.upsert({
      where: { chatId: BigInt(chatId) },
      update: { isActive: true, title: title || undefined },
      create: { chatId: BigInt(chatId), chatType: chatType || "group", title: title || null, isActive: true },
    });
    return NextResponse.json({ ...chat, chatId: chat.chatId.toString() }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

export async function PATCH(req: Request) {
  try {
    const prisma = getDb();
    const body = await req.json();
    const { chatId, isActive } = body;
    const chat = await prisma.telegramChat.update({
      where: { chatId: BigInt(chatId) },
      data: { isActive: isActive ?? false },
    });
    return NextResponse.json({ ...chat, chatId: chat.chatId.toString() });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
}
