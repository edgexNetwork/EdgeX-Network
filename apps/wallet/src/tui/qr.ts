import QRCode from "qrcode";





export async function qrLines(text: string): Promise<string[]> {
  const out = await QRCode.toString(text, {
    type: "utf8",
    margin: 2,
    errorCorrectionLevel: "M",
    color: { dark: "#000000", light: "#ffffff" },
  });
  return out.split("\n").filter((line) => line !== "");
}
