-- NULL means use the first eligible Facebook post; an empty string is an
-- intentional administrator choice to show no description.
ALTER TABLE facebook_projects ADD COLUMN description_override TEXT;

-- NULL is legacy/unknown provenance. New imports distinguish a deliberate
-- photo caption from the old post-text fallback without rewriting photo rows.
ALTER TABLE facebook_photos ADD COLUMN caption_from_post INTEGER CHECK (caption_from_post IN (0, 1));
