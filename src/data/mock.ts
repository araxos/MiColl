import type { Artist, Month, Reward } from "@/types";

let idc = 0;
const uid = (p: string) => `${p}-${++idc}`;

const pad = (n: number) => n.toString().padStart(2, "0");

/**
 * Make a month with total rewards, owned of them present, skipped marked as
 * skipped, the rest "missing".
 */
function makeMonth(
  year: number,
  month: number,
  total: number,
  owned: number,
  skipped = 0,
): Month {
  const label = `${pad(month)}.${year.toString().slice(2)}`;
  const rewards: Reward[] = [];
  for (let i = 0; i < total; i++) {
    let status: Reward["status"] = "missing";
    if (i < owned) status = "owned";
    else if (i < owned + skipped) status = "skipped";
    rewards.push({
      id: uid("r"),
      title: `${label} — Reward ${i + 1}`,
      category: null,
      cover: "",
      imageCount: 1,
      images: [{ id: uid("img"), src: "", path: "", name: `${label} #${i + 1}`, kind: "image" as const }],
      status,
    });
  }
  return {
    id: uid("m"),
    month,
    year,
    label,
    span: 1,
    skipped: false,
    verified: false,
    previewPath: "",
    coverImage: null,
    officialTotal: total,
    rewards,
  };
}

function miscMonth(count: number): Month {
  const rewards: Reward[] = Array.from({ length: count }, (_, i) => ({
    id: uid("r"),
    title: `Unsorted ${i + 1}`,
    category: null,
    cover: "",
    imageCount: 1,
    images: [{ id: uid("img"), src: "", path: "", name: `Unsorted ${i + 1}`, kind: "image" as const }],
    status: "owned" as const,
  }));
  return {
    id: uid("m"),
    month: null,
    year: null,
    label: "Misc",
    span: 1,
    skipped: false,
    verified: false,
    previewPath: "",
    coverImage: null,
    officialTotal: count,
    rewards,
  };
}

export const artists: Artist[] = [
  {
    id: uid("a"),
    name: "Aurora Vale",
    previewPath: "",
    platforms: [
      {
        id: uid("p"),
        name: "Patreon",
        months: [
          makeMonth(2025, 5, 8, 8),
          makeMonth(2025, 4, 6, 5, 1),
          makeMonth(2025, 3, 7, 4, 1),
          makeMonth(2025, 2, 5, 5),
          makeMonth(2025, 1, 6, 2),
          makeMonth(2024, 12, 9, 9),
          makeMonth(2024, 11, 6, 0, 6),
          makeMonth(2024, 10, 5, 5),
        ],
      },
      {
        id: uid("p"),
        name: "Ko-Fi",
        months: [makeMonth(2025, 4, 3, 3), makeMonth(2025, 2, 4, 2), miscMonth(5)],
      },
    ],
  },
  {
    id: uid("a"),
    name: "Neon Koi",
    previewPath: "",
    platforms: [
      {
        id: uid("p"),
        name: "Patreon",
        months: [
          makeMonth(2025, 5, 10, 7),
          makeMonth(2025, 4, 10, 10),
          makeMonth(2025, 3, 8, 8),
          makeMonth(2025, 2, 8, 3, 2),
        ],
      },
      {
        id: uid("p"),
        name: "Gumroad",
        months: [makeMonth(2025, 3, 2, 2), makeMonth(2025, 1, 2, 0, 2)],
      },
    ],
  },
  {
    id: uid("a"),
    name: "Studio Lumen",
    previewPath: "",
    platforms: [
      {
        id: uid("p"),
        name: "Patreon",
        months: [
          makeMonth(2025, 5, 4, 1),
          makeMonth(2025, 4, 4, 4),
          makeMonth(2024, 12, 6, 6),
        ],
      },
    ],
  },
  {
    id: uid("a"),
    name: "pixelwitch",
    previewPath: "",
    platforms: [
      {
        id: uid("p"),
        name: "Patreon",
        months: [makeMonth(2025, 5, 5, 5), makeMonth(2025, 4, 5, 4), makeMonth(2025, 3, 5, 5)],
      },
      { id: uid("p"), name: "Ko-Fi", months: [makeMonth(2025, 5, 3, 1)] },
    ],
  },
  {
    id: uid("a"),
    name: "Vermillion",
    previewPath: "",
    platforms: [
      {
        id: uid("p"),
        name: "Patreon",
        months: [makeMonth(2025, 4, 7, 7), makeMonth(2025, 3, 7, 6, 1)],
      },
    ],
  },
  {
    id: uid("a"),
    name: "Coffee & Ink",
    previewPath: "",
    platforms: [
      {
        id: uid("p"),
        name: "Patreon",
        months: [makeMonth(2025, 5, 3, 0), makeMonth(2025, 4, 3, 3)],
      },
    ],
  },
];

export function findArtist(id: string): Artist | undefined {
  return artists.find((a) => a.id === id);
}
