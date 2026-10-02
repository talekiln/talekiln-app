-- 任务结果里的真实用量（视频计费秒数 / 配音计费字符数 / 图片张数）及按价目算出的实际费用依据，JSON。
ALTER TABLE spend_log ADD COLUMN usage TEXT
