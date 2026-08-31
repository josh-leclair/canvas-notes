import { defaultSchema } from "rehype-sanitize";
import type { Root, Element } from "hast";
import { visit } from "unist-util-visit";

/** Markdown has no syntax for a text colour or a highlight, so the document
 *  editor writes those two as inline HTML inside an otherwise ordinary
 *  markdown file. Rendering them means letting raw HTML through, and letting
 *  raw HTML through means sanitising it: card bodies are written by people,
 *  and a shared board renders other people's.
 *
 *  The allowance is deliberately tiny — the three tags the editor can emit,
 *  and `style` only on those. */
export const richSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "mark", "u", "span"],
  attributes: {
    ...defaultSchema.attributes,
    mark: ["style", "dataColor"],
    span: ["style"],
    u: [],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "card"],
  },
};

/** A `style` attribute the sanitiser has allowed is still an arbitrary string,
 *  and it can carry more than colour — positioning, backgrounds that load a
 *  url, transforms that cover the page. Everything except the two colour
 *  declarations is dropped, and the values have to look like colours. */
const SAFE_VALUE = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/]+\)|[a-z]+)$/i;
const SAFE_PROPERTY = new Set(["color", "background-color"]);

export function rehypeSafeStyle() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      const style = node.properties?.style;
      if (typeof style !== "string") return;
      const kept = style
        .split(";")
        .map((rule) => rule.trim())
        .filter(Boolean)
        .map((rule) => {
          const at = rule.indexOf(":");
          if (at < 0) return null;
          const property = rule.slice(0, at).trim().toLowerCase();
          const value = rule.slice(at + 1).trim();
          if (!SAFE_PROPERTY.has(property)) return null;
          if (!SAFE_VALUE.test(value)) return null;
          return `${property}: ${value}`;
        })
        .filter(Boolean);
      if (kept.length) node.properties.style = kept.join("; ");
      else delete node.properties.style;
    });
  };
}
