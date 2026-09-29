import { Cover } from "@/components/Cover";

/** Month preview: a collage of the first reward covers. Works with 1-2 rewards too. */
export function MonthMosaic({ covers, seed }: { covers: string[]; seed: string }) {
  const tiles = covers.slice(0, 4);

  if (tiles.length <= 1) {
    return <Cover path={tiles[0]} seed={seed} rounded="rounded-none" />;
  }

  return (
    <div
      className={`grid h-full w-full gap-0.5 bg-zinc-800 ${
        tiles.length === 2 ? "grid-cols-2" : "grid-cols-2 grid-rows-2"
      }`}
    >
      {tiles.map((c, i) => (
        <div
          key={i}
          className={`overflow-hidden ${tiles.length === 3 && i === 0 ? "row-span-2" : ""}`}
        >
          <Cover path={c} seed={`${seed}-${i}`} size={300} rounded="rounded-none" />
        </div>
      ))}
    </div>
  );
}
