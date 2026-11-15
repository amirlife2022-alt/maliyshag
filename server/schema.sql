CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  first_name TEXT,
  username TEXT,
  lang TEXT,
  tz TEXT,
  lat REAL,
  lon REAL,
  city TEXT,
  asr_factor INTEGER DEFAULT 1,
  mode TEXT DEFAULT 'asr',
  rtime TEXT DEFAULT '18:00',
  address TEXT DEFAULT 'name',
  habits TEXT,
  blocked INTEGER DEFAULT 0,
  settings_set INTEGER DEFAULT 0,
  created_at INTEGER,
  last_seen INTEGER,
  last_seen_day TEXT,
  reminded_day TEXT,
  nudged_at INTEGER
);
CREATE TABLE IF NOT EXISTS days (
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  done INTEGER,
  total INTEGER,
  pending TEXT,
  updated_at INTEGER,
  PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
