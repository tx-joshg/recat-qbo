-- CreateTable
CREATE TABLE "SplitLine" (
    "id" TEXT NOT NULL,
    "txnId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "category" TEXT NOT NULL,
    "categoryQboId" TEXT,
    "memo" TEXT,

    CONSTRAINT "SplitLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SplitLineTag" (
    "splitLineId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "SplitLineTag_pkey" PRIMARY KEY ("splitLineId","tagId")
);

CREATE UNIQUE INDEX "SplitLine_txnId_idx_key" ON "SplitLine"("txnId", "idx");
CREATE INDEX "SplitLine_category_idx" ON "SplitLine"("category");

ALTER TABLE "SplitLine" ADD CONSTRAINT "SplitLine_txnId_fkey" FOREIGN KEY ("txnId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SplitLineTag" ADD CONSTRAINT "SplitLineTag_splitLineId_fkey" FOREIGN KEY ("splitLineId") REFERENCES "SplitLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SplitLineTag" ADD CONSTRAINT "SplitLineTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Data migration: unpack the JSON splits column into rows.
INSERT INTO "SplitLine" ("id", "txnId", "idx", "amount", "category", "categoryQboId", "memo")
SELECT gen_random_uuid(), t.id, (s.ord - 1)::int,
       (s.line->>'amount')::decimal(14,2),
       s.line->>'category',
       s.line->>'categoryQboId',
       s.line->>'memo'
FROM "Transaction" t,
     LATERAL jsonb_array_elements(t.splits::jsonb) WITH ORDINALITY AS s(line, ord)
WHERE t.splits IS NOT NULL;

INSERT INTO "SplitLineTag" ("splitLineId", "tagId")
SELECT sl.id, tag_id.value
FROM "Transaction" t
JOIN LATERAL jsonb_array_elements(t.splits::jsonb) WITH ORDINALITY AS s(line, ord) ON true
JOIN "SplitLine" sl ON sl."txnId" = t.id AND sl.idx = (s.ord - 1)::int
JOIN LATERAL jsonb_array_elements_text(coalesce(s.line->'tagIds', '[]'::jsonb)) AS tag_id(value) ON true
WHERE t.splits IS NOT NULL
  AND EXISTS (SELECT 1 FROM "Tag" g WHERE g.id = tag_id.value)
ON CONFLICT DO NOTHING;

-- Drop the JSON column.
ALTER TABLE "Transaction" DROP COLUMN "splits";
