import Chat from "@/components/Chat";
import { PRACTICE } from "@/lib/practice";
import { GREETING } from "@/lib/prompt";

export default function Home() {
  return <Chat greeting={GREETING} practice={PRACTICE} />;
}
