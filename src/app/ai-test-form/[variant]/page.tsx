import { notFound } from "next/navigation";
import { mode } from "@/lib/auth";
import AIForm from "./test-form";
export const dynamic = "force-dynamic";
const variants = [
  "easy",
  "survey",
  "free",
  "quiz",
  "multi",
  "reordered",
  "ambiguous",
  "missing",
  "captcha",
  "prohibited",
];
export default async function Page({
  params,
}: {
  params: Promise<{ variant: string }>;
}) {
  const { variant } = await params;
  if (mode() !== "demo" || !variants.includes(variant)) notFound();
  return <AIForm variant={variant} />;
}
