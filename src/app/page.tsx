import { redirect } from "next/navigation";
import { PRACTICES } from "@/lib/practice";

export default function Home() {
  redirect(`/p/${PRACTICES[0].slug}`);
}
