import { createFileRoute } from "@tanstack/react-router";
import { ImeiScanner } from "@/components/ImeiScanner";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "IMEI Scanner — OCR & Barcode" },
      { name: "description", content: "Scan dual-SIM IMEI numbers with OCR or barcode, look up device brand/model, export CSV, and check CEIR status." },
      { property: "og:title", content: "IMEI Scanner" },
      { property: "og:description", content: "Dual-engine IMEI scanner with TAC lookup and CEIR status check." },
    ],
  }),
  component: () => <ImeiScanner />,
});
