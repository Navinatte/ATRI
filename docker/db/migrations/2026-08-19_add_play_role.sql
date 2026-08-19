ALTER TABLE chat_context
    ADD COLUMN IF NOT EXISTS play_role VARCHAR(64);

COMMENT ON COLUMN chat_context.play_role IS '当前使用的角色设定名（对应 character_setting 下的文件名），NULL 表示默认角色';