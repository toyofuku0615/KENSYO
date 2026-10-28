import { notFound } from "next/navigation";
import { mode } from "@/lib/auth";
import TestForm from "./test-form";
export const dynamic = "force-dynamic";
export default function Page() {
  if (mode() !== "demo") notFound();
  return <TestForm />;
}
