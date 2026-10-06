const COVENANTS = `SAMPLE PLACEHOLDER — NOT THE RECORDED COVENANTS

Tango Mar
Miramar Beach, Walton County, Florida

This file is demo content so the portal can show document versions.
Replace it with the association's recorded covenants.

1. Lots
Lots in Tango Mar are for residential use.

2. Dunes and beach
Do not cut dune vegetation or place private structures on the beach.

3. Common walkway
Keep the beach walkway clear and latch the gate.

Residents always see the version the board marks current.
This text is not legal advice.
`;

const BUDGET = `SAMPLE PLACEHOLDER — NOT THE ADOPTED BUDGET

Tango Mar 2026 budget sketch
Miramar Beach, Walton County, Florida

Annual assessment (illustrative)    $1,200 per lot
Fall walkway maintenance            $150 per lot
Insurance (illustrative)            board review

This document is marked board-only in the sample seed.
Residents do not see board-only files.
This text is not legal advice.
`;

const SEED_FILES = [
  { key: "seed/tango-mar/covenants.txt", body: COVENANTS },
  { key: "seed/tango-mar/budget-2026.txt", body: BUDGET },
] as const;

export async function ensureSeedFiles(bucket: R2Bucket, db: D1Database): Promise<void> {
  for (const file of SEED_FILES) {
    const bytes = new TextEncoder().encode(file.body);
    const existing = await bucket.head(file.key);
    if (!existing) {
      await bucket.put(file.key, bytes, {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
      });
    }
    await db
      .prepare("UPDATE document_versions SET byte_size = ? WHERE r2_key = ?")
      .bind(bytes.byteLength, file.key)
      .run();
  }
}
