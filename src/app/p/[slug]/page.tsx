import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Chat from "@/components/Chat";
import { practiceBySlug } from "@/lib/practice";
import { greeting } from "@/lib/prompt";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const p = practiceBySlug((await params).slug);
  return { title: p ? `${p.name} — Chat with ${p.assistantName}` : "Not found" };
}

export default async function PracticeChat({ params }: { params: Promise<{ slug: string }> }) {
  const practice = practiceBySlug((await params).slug);
  if (!practice) notFound();
  return <Chat greeting={greeting(practice)} practice={practice} />;
}
