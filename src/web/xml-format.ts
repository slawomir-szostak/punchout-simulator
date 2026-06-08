// Pretty-print well-formed XML for readability.
//
// It only reflows whitespace that sits *between* tags — it never touches text
// inside an element (a line like `<Description>foo</Description>` is left
// intact). cXML has no significant mixed content, so the result is byte-safe to
// send on the wire as well as to display.
//
// Deliberately dependency-free and regex-based: good enough for the well-formed
// cXML this tool produces/receives. If the input isn't parseable as tags it is
// returned unchanged rather than mangled.
export function formatXml(xml: string, indent = "  "): string {
  if (!xml || !xml.trim()) return xml;
  let s = xml.replace(/\r\n/g, "\n").trim();
  // Collapse whitespace that is purely between two tags, then break every
  // tag-to-tag boundary onto its own line. `>foo<` (text content) has no `><`
  // boundary, so text-bearing lines are preserved.
  s = s.replace(/>\s+</g, "><").replace(/></g, ">\n<");

  const lines = s.split("\n");
  let depth = 0;
  const out: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const isClosing = /^<\//.test(line);
    const isMeta = /^<[?!]/.test(line); // <?xml?>, <!DOCTYPE ...>, <!-- ... -->
    const isSelfClose = /\/>\s*$/.test(line);
    const hasInlineClose = /^<[^/!?][^>]*>.*<\/[^>]+>\s*$/.test(line); // <a>text</a>
    const isOpening = /^<[^/!?]/.test(line) && !isSelfClose && !hasInlineClose && !isMeta;

    if (isClosing) depth = Math.max(0, depth - 1);
    out.push(indent.repeat(depth) + line);
    if (isOpening) depth++;
  }
  return out.join("\n");
}

/** True when the text looks like an XML/cXML document (worth offering Prettify). */
export function looksLikeXml(text: string): boolean {
  return /^\s*<(\?xml|!DOCTYPE|cXML|[A-Za-z])/.test(text);
}
