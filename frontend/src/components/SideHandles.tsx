import { Handle, Position } from "@xyflow/react";

const SIDES = [
  { position: Position.Top, name: "top" },
  { position: Position.Right, name: "right" },
  { position: Position.Bottom, name: "bottom" },
  { position: Position.Left, name: "left" },
] as const;

/** A link anchor on every side.
 *
 * Each side carries a source and a target handle at the same spot; with loose
 * connection mode either end of a drag can land on either, so a link can be
 * drawn whichever way the two cards happen to sit. Edges then pick the pair
 * that faces the other card, which is what keeps a line from looping back
 * underneath its own endpoints.
 *
 * `inColumn` hides them and stops them accepting a connection, but keeps them
 * in the DOM. A card in a stack sits inside a container that has anchors of
 * its own, and eight dots overlapping four made linking to the column itself
 * a guessing game. They cannot simply be dropped, though: an edge attaches to
 * a handle by id, so a revealed link to a card in a column would have nothing
 * to land on and would not draw at all. */
export default function SideHandles({
  connectable = true,
  className = "card-handle",
  inColumn = false,
}: {
  connectable?: boolean;
  className?: string;
  inColumn?: boolean;
}) {
  return (
    <>
      {SIDES.map(({ position, name }) => (
        <span key={name}>
          <Handle
            id={`${name}-target`}
            type="target"
            position={position}
            className={`${className} card-handle-target${
              inColumn ? " is-silent" : ""
            }`}
            isConnectable={connectable && !inColumn}
          />
          <Handle
            id={`${name}-source`}
            type="source"
            position={position}
            className={`${className}${inColumn ? " is-silent" : ""}`}
            isConnectable={connectable && !inColumn}
          />
        </span>
      ))}
    </>
  );
}
