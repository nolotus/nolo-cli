type OutputLike = {
  write(chunk: string): unknown;
};

export function splitStreamingText(content: string): string[] {
  const Segmenter = Intl.Segmenter;
  if (typeof Segmenter === "function") {
    const segmenter = new Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(content), (part) => part.segment);
  }
  return Array.from(content);
}

export function createStreamingTextWriter({
  write,
  batchSize = 3,
}: {
  write: OutputLike["write"];
  batchSize?: number;
}) {
  const queue: string[] = [];
  const safeBatchSize = Math.max(1, batchSize);

  const flushNext = () => {
    if (!queue.length) return;
    write(queue.splice(0, safeBatchSize).join(""));
  };

  return {
    push(content: string) {
      queue.push(...splitStreamingText(content));
      flushNext();
    },
    flushAll() {
      while (queue.length) flushNext();
    },
  };
}
