import { Children, isValidElement, type ReactNode } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { isTaskChecked } from "../lib/tasks";
import { rehypeSafeStyle, richSchema } from "../lib/richMarkdown";
import { useOpenCard } from "../hooks/useOpenCard";

const CARD_REFERENCE_URL = /^card:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// react-markdown applies its URL transform before rehype plugins run. Its
// default intentionally removes unfamiliar protocols, so merely allowing
// `card:` in the sanitizer is not enough: the href has already become empty
// by then. Preserve only our tightly shaped internal reference URLs and leave
// every ordinary URL under the library's normal safety policy.
const transformCardUrl = (value: string) =>
  CARD_REFERENCE_URL.test(value) ? value : defaultUrlTransform(value);

/** Card body rendering.
 *
 * GFM gives tables, task lists and strikethrough. Checkboxes are made live:
 * remark-gfm renders them disabled, so they are replaced with real ones that
 * rewrite the source line they came from.
 *
 * Raw HTML is rendered rather than escaped, because the document editor has
 * nowhere else to put a text colour or a highlight — markdown has no syntax
 * for either. It is sanitised on the way through: without that, a body would
 * be showing arbitrary markup written by whoever last edited the card. */
export default function CardMarkdown({
  body,
  onToggleTask,
  onCardReference,
  externalLinksNewTab = false,
}: {
  body: string;
  onToggleTask?: (line: number) => void;
  onCardReference?: (cardId: string) => void;
  externalLinksNewTab?: boolean;
}) {
  const openCard = useOpenCard();
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, rehypeSafeStyle, [rehypeSanitize, richSchema]]}
      urlTransform={transformCardUrl}
      components={{
        a({ href, children, ...rest }) {
          const match = /^card:([0-9a-f-]{36})$/i.exec(href ?? "");
          if (!match) {
            return (
              <a
                href={href}
                {...rest}
                target={externalLinksNewTab ? "_blank" : undefined}
                rel={externalLinksNewTab ? "noopener noreferrer" : undefined}
              >
                {children}
              </a>
            );
          }
          return (
            <a
              href={href}
              {...rest}
              className="card-reference"
              title="Open referenced card"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (onCardReference) onCardReference(match[1]);
                else void openCard(match[1]);
              }}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              {children}
            </a>
          );
        },
        li({ node, className, children, ...rest }) {
          const isTask = (className ?? "").includes("task-list-item");
          if (!isTask || !onToggleTask) {
            return (
              <li className={className} {...rest}>
                {children}
              </li>
            );
          }
          // The line this item starts on is what gets rewritten, so a
          // re-render can never tick the wrong box.
          const line = node?.position?.start?.line ?? 0;
          const rest_children = Children.toArray(children).filter(
            (child: ReactNode) => !(isValidElement(child) && child.type === "input")
          );
          return (
            <li className={className} {...rest}>
              <input
                type="checkbox"
                className="task-box nodrag"
                checked={isTaskChecked(body, line)}
                onChange={(e) => {
                  e.stopPropagation();
                  onToggleTask(line);
                }}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
              />
              <span>{rest_children}</span>
            </li>
          );
        },
      }}
    >
      {body}
    </Markdown>
  );
}
