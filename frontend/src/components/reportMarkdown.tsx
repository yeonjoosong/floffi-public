import type { ReactNode } from "react";

type Token =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "strong"; value: string };

function parseInlineTokens(raw: string): Token[] {
  const tokens: Token[] = [];
  let rest = raw;
  while (rest.length > 0) {
    const code = rest.match(/`([^`]+)`/);
    const strong = rest.match(/\*\*([^*]+)\*\*/);
    let next: RegExpMatchArray | null = null;
    let type: Token["type"] = "text";
    if (code && (!strong || code.index! < strong.index!)) {
      next = code;
      type = "code";
    } else if (strong) {
      next = strong;
      type = "strong";
    }
    if (!next) {
      tokens.push({ type: "text", value: rest });
      break;
    }
    if ((next.index ?? 0) > 0) {
      tokens.push({ type: "text", value: rest.slice(0, next.index) });
    }
    tokens.push({ type, value: next[1] });
    rest = rest.slice((next.index ?? 0) + next[0].length);
  }
  return tokens;
}

function renderTokens(tokens: Token[]): ReactNode {
  return tokens.map((token, idx) => {
    if (token.type === "code") {
      return <code key={idx} className="rounded bg-s2 px-1 py-0.5 font-mono text-[0.95em] text-t1">{token.value}</code>;
    }
    if (token.type === "strong") {
      return <strong key={idx} className="font-black text-t1">{token.value}</strong>;
    }
    return <span key={idx}>{token.value}</span>;
  });
}

export function parseInline(text: string): ReactNode {
  return renderTokens(parseInlineTokens(text));
}

export function renderMarkdown(text: string): ReactNode {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const elements: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const h1 = line.match(/^#\s+(.+)$/);
    if (h1) {
      elements.push(<h1 key={key++} className="mb-1 mt-7 text-xl font-black tracking-tight text-t1 first:mt-0">{parseInline(h1[1])}</h1>);
      i++;
      continue;
    }
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      elements.push(<h2 key={key++} className="mb-1 mt-6 text-base font-black tracking-tight text-t1 first:mt-0">{parseInline(h2[1])}</h2>);
      i++;
      continue;
    }
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      elements.push(<h3 key={key++} className="mb-1 mt-4 text-sm font-bold text-t1 first:mt-0">{parseInline(h3[1])}</h3>);
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      elements.push(
        <blockquote key={key++} className="my-3 rounded-r-xl border-l-4 border-ac/40 bg-s2/60 px-4 py-3 text-sm text-t2">
          {quoteLines.map((ql, qi) => <p key={qi} className="leading-relaxed">{parseInline(ql)}</p>)}
        </blockquote>,
      );
      continue;
    }

    if (/^\|.*\|$/.test(line) && i + 1 < lines.length && /^\|(?:\s*[-:]+\s*\|)+\s*$/.test(lines[i + 1])) {
      const header = line.split("|").slice(1, -1).map((cell) => cell.trim());
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i])) {
        rows.push(lines[i].split("|").slice(1, -1).map((cell) => cell.trim()));
        i++;
      }
      elements.push(
        <div key={key++} className="my-4 overflow-x-auto rounded-xl border border-bd/10">
          <table className="min-w-full border-collapse text-sm">
            <thead className="bg-s2/70">
              <tr>
                {header.map((cell, ci) => (
                  <th key={ci} className="px-3 py-2.5 text-left font-bold text-t1">{parseInline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri} className="border-t border-bd/10">
                  {row.map((cell, ci) => (
                    <td key={ci} className="px-3 py-2 leading-snug text-t2">{parseInline(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ""));
        i++;
      }
      elements.push(
        <ul key={key++} className="my-2 ml-5 space-y-1">
          {items.map((item, idx) => (
            <li key={idx} className="list-disc text-sm leading-relaxed text-t2">{parseInline(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ""));
        i++;
      }
      elements.push(
        <ol key={key++} className="my-2 ml-5 space-y-1">
          {items.map((item, idx) => (
            <li key={idx} className="list-decimal text-sm leading-relaxed text-t2">{parseInline(item)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    elements.push(
      <p key={key++} className="my-1.5 text-sm leading-relaxed text-t2">{parseInline(line)}</p>,
    );
    i++;
  }

  return <>{elements}</>;
}
