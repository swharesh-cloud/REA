import type { LectureSession } from "./types";

export function createSampleSession(): LectureSession {
  const createdAt = new Date().toISOString();
  return {
    id: "sample-lecture",
    createdAt,
    updatedAt: createdAt,
    durationMs: 95_000,
    title: "Sample: how leaves store sunlight",
    titleEdited: false,
    status: "ready",
    sample: true,
    segments: [
      {
        id: "sample-1",
        startMs: 4_200,
        endMs: 18_000,
        text: "Today we follow a photon from the leaf surface into chemical storage.",
      },
      {
        id: "sample-2",
        startMs: 22_000,
        endMs: 48_000,
        text: "Chlorophyll in the thylakoid membrane absorbs red and blue light and reflects green.",
      },
      {
        id: "sample-3",
        startMs: 51_000,
        endMs: 78_000,
        text: "The light reactions make ATP and NADPH. The Calvin cycle then fixes carbon dioxide into sugar.",
      },
      {
        id: "sample-4",
        startMs: 81_000,
        endMs: 95_000,
        text: "Before Friday, sketch both stages and label where oxygen is released.",
      },
    ],
    notes: {
      title: "How leaves store sunlight",
      summary:
        "The lecture traces light from a leaf into stored sugar. Chlorophyll captures red and blue light, the light reactions produce ATP and NADPH, and the Calvin cycle uses that energy to fix carbon dioxide.",
      keyPoints: [
        {
          text: "Chlorophyll absorbs red and blue light and reflects green.",
          timestampMs: 22_000,
        },
        {
          text: "Light reactions produce ATP and NADPH; the Calvin cycle fixes carbon dioxide.",
          timestampMs: 51_000,
        },
      ],
      sections: [
        {
          heading: "Capturing light",
          timestampMs: 4_200,
          bullets: [
            {
              text: "A photon enters the leaf and reaches chlorophyll in the thylakoid membrane.",
              timestampMs: 4_200,
            },
            {
              text: "Green light is mostly reflected, which is why leaves look green.",
              timestampMs: 22_000,
            },
          ],
        },
        {
          heading: "Storing the energy",
          timestampMs: 51_000,
          bullets: [
            {
              text: "Light reactions build ATP and NADPH.",
              timestampMs: 51_000,
            },
            {
              text: "The Calvin cycle uses those molecules to fix carbon dioxide into sugar.",
              timestampMs: 51_000,
            },
          ],
        },
      ],
      terms: [
        {
          term: "Thylakoid",
          definition:
            "The membrane inside the chloroplast where chlorophyll captures light.",
          timestampMs: 22_000,
        },
        {
          term: "Calvin cycle",
          definition:
            "The set of reactions that fixes carbon dioxide into sugar.",
          timestampMs: 51_000,
        },
      ],
      actionItems: [
        {
          text: "Sketch the light reactions and the Calvin cycle, and mark where oxygen is released.",
          timestampMs: 81_000,
        },
      ],
      questions: [
        {
          text: "Which colors of light does chlorophyll absorb?",
          timestampMs: 22_000,
        },
        {
          text: "What do the light reactions hand off to the Calvin cycle?",
          timestampMs: 51_000,
        },
      ],
    },
  };
}
