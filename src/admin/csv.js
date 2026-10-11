// CSV for the exports, used by the browser (monthly report, hotspots) and by api/admin/export.js (reports).
// Plain JavaScript so the server can import it.

// A cell that starts with one of these is a formula to a spreadsheet. A single quote in front makes it text.
// Tab and carriage return are on the list too: some spreadsheets treat them as the start of a formula.
const FORMULA_START = /^[=+\-@\t\r]/;

/** One cell as text, safe to open in a spreadsheet. Numbers are written as they are. */
export function csvCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Excel needs the byte order mark to read Assamese and Hindi text as UTF-8.
const BOM = String.fromCharCode(0xfeff);

/** @param {string[]} header @param {unknown[][]} rows */
export const toCsv = (header, rows) => `${BOM}${[header, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n")}\r\n`;

// Free text a member of the public typed can hold their own phone number or email. The export keeps the
// description but blanks anything that looks like one, and puts the text on one line.
export function plainDescription(text) {
  return String(text ?? "")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email removed]")
    .replace(/(?<![\w])\+?\d[\d\s().-]{7,}\d(?![\w])/g, "[phone removed]")
    .replace(/\s+/g, " ")
    .trim();
}
