import type { Metadata } from "next";
import StaffDashboard from "@/components/StaffDashboard";

export const metadata: Metadata = { title: "Front desk dashboard — Bright Smile Dental" };

export default function StaffPage() {
  return <StaffDashboard />;
}
