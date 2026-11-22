-- Facebook photos on the homepage Highlights (#highlight caption tag, or an
-- admin choice on /admin/manage). Additive: older code ignores both columns.
--   highlight         1 = shown in Highlights (still also in its gallery)
--   highlight_locked  1 = an admin chose; caption tags never change it again
ALTER TABLE facebook_photos ADD COLUMN highlight INTEGER NOT NULL DEFAULT 0 CHECK (highlight IN (0, 1));
ALTER TABLE facebook_photos ADD COLUMN highlight_locked INTEGER NOT NULL DEFAULT 0 CHECK (highlight_locked IN (0, 1));
