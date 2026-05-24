import type { BossReport, Task } from "./types";

export function isManualCloseStub(summary: string): boolean {
  if (!summary) return true;
  return summary.trimEnd().endsWith("completed the task and reported back to the boss.");
}

export function downloadReportAsMarkdown(report: BossReport, task?: Task) {
  const baseName = (task?.title ?? report.title).replace(/[/\\?%*:|"<>]/g, "-").trim() || "report";
  const datePart = (report.deliveredAt || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
  const filename = `${baseName}_${datePart}.md`;
  const body = [
    `# ${report.title}`,
    "",
    `Delivered: ${report.deliveredAt || "—"}`,
    "",
    "---",
    "",
    report.summary || "",
    "",
  ].join("\n");
  const blob = new Blob([body], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}
